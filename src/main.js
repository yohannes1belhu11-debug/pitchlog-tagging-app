const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

let mainWindow;
let detachedVideoWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 860,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#0d0e10',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // --- Safe-close protection ---
  // Intercept the OS close (X button, Alt+F4, taskbar close). Instead of
  // closing immediately, ask the renderer whether the session is dirty. The
  // renderer's 'close:requested' handler decides:
  //   - if the session is clean, close immediately
  //   - if the session is dirty, show the unsaved-changes modal; the user's
  //     choice (Save / Don't save / Cancel) is communicated back via
  //     'close:proceed' (force close) or no response (Cancel = stay open)
  //
  // A `forceClose` flag breaks the loop when the renderer explicitly tells
  // us to proceed (so we don't re-intercept the resulting close event).
  mainWindow.forceClose = false;

  mainWindow.on('close', (e) => {
    if (mainWindow.forceClose) return; // renderer already approved the close
    e.preventDefault();
    // Defer the IPC send out of the close event handler. Sending synchronously
    // during the event can cause issues in some Electron versions.
    setImmediate(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('close:requested');
      }
    });
  });

  mainWindow.on('closed', () => {
    if (detachedVideoWindow) {
      detachedVideoWindow.close();
    }
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// --- Schema versioning & migration ---
//
// Every persisted file (session JSON, squad JSON, autosave JSON) carries a
// `__schemaVersion` field. Files saved by the original (pre-Phase-1C) app
// have no version field — those are treated as version 0 and migrated to
// the current version on load. This establishes the framework for all
// future schema changes: instead of silently breaking old files, the
// migration function transforms them into the current shape before the
// renderer ever sees them.
//
// Current schema version: 3
//   - v0 → v1: add __schemaVersion; ensure events/tags/squad are arrays;
//     normalize each event's optional fields with null defaults; ensure
//     matchInfo is an object. No structural changes to user-facing data.
//   - v1 → v2: convert event.player/playerOff/playerOn (snapshot objects
//     {id, number, name}) to event.playerId/playerOffId/playerOnId
//     (plain string references). This fixes the audit's R4 risk.
//   - v2 → v3: add match-time fields to every event (videoTime, matchTime,
//     matchSeconds, officialMinute, second, period) and add matchClock
//     object to the session. Also adds team, sequenceId, and score-before
//     fields to events. The legacy `time` field is preserved for backward
//     compatibility.
//
// Migration runs in the main process (the file-reading layer) so the
// renderer always receives data at the current schema version and never
// has to worry about legacy formats.

const CURRENT_SCHEMA_VERSION = 3;

// Migrate a session object (from file:loadSession, file:loadMultipleSessions,
// or autosave:read) to CURRENT_SCHEMA_VERSION. Returns the migrated object
// or throws if the file is from a newer schema version than this app supports.
function migrateSessionData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Invalid session data: expected a JSON object.');
  }

  const fileVersion = (typeof data.__schemaVersion === 'number') ? data.__schemaVersion : 0;

  if (fileVersion > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      'This session was saved by a newer version of MatchTag ' +
      '(schema v' + fileVersion + '). This app supports up to v' +
      CURRENT_SCHEMA_VERSION + '. Please update MatchTag to load it.'
    );
  }

  if (fileVersion === CURRENT_SCHEMA_VERSION) {
    return data; // already current
  }

  // --- v0 → v1 migration ---
  let migrated = Object.assign({}, data);
  migrated.__schemaVersion = 1;

  // Ensure top-level arrays exist
  if (!Array.isArray(migrated.events)) migrated.events = [];
  if (!Array.isArray(migrated.tags)) migrated.tags = [];
  if (!Array.isArray(migrated.squad)) migrated.squad = [];

  // Ensure matchInfo is an object (the renderer merges it onto blankMatchInfo)
  if (!migrated.matchInfo || typeof migrated.matchInfo !== 'object' || Array.isArray(migrated.matchInfo)) {
    migrated.matchInfo = {};
  }

  // Normalize each event: ensure required fields and null-default optional fields.
  // This centralizes the defensive coalescing that the renderer previously did
  // inline, so loaded data is always well-formed regardless of file origin.
  migrated.events = migrated.events.map((ev) => {
    if (!ev || typeof ev !== 'object' || Array.isArray(ev)) {
      // Skip non-object entries (corrupt file); they'll be filtered below
      return null;
    }
    const normalized = {
      id: (typeof ev.id === 'number' && isFinite(ev.id)) ? ev.id : 0,
      time: (typeof ev.time === 'number' && isFinite(ev.time)) ? ev.time : 0,
      label: (typeof ev.label === 'string') ? ev.label : 'Unknown',
      subtype: ev.subtype ?? null,
      qualifiers: (ev.qualifiers && typeof ev.qualifiers === 'object' && !Array.isArray(ev.qualifiers)) ? ev.qualifiers : {},
      location: (ev.location && typeof ev.location === 'object' && !Array.isArray(ev.location) && typeof ev.location.x === 'number' && typeof ev.location.y === 'number') ? { x: ev.location.x, y: ev.location.y } : null,
      player: ev.player ?? null,
      playerOff: ev.playerOff ?? null,
      playerOn: ev.playerOn ?? null,
      side: ev.side ?? null,
      isInterval: ev.isInterval === true
    };
    if (normalized.isInterval) {
      normalized.startTime = (typeof ev.startTime === 'number' && isFinite(ev.startTime)) ? ev.startTime : normalized.time;
      normalized.endTime = (typeof ev.endTime === 'number' && isFinite(ev.endTime)) ? ev.endTime : normalized.time;
    }
    // Preserve any other fields the migration doesn't know about (forward-compat)
    Object.keys(ev).forEach((k) => {
      if (!(k in normalized)) normalized[k] = ev[k];
    });
    return normalized;
  }).filter(Boolean);

  // Normalize squad entries
  migrated.squad = migrated.squad.map((p) => {
    if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
    return {
      id: (typeof p.id === 'string') ? p.id : ('player_' + Math.random().toString(36).slice(2, 10)),
      number: (typeof p.number === 'string') ? p.number : String(p.number ?? ''),
      name: (typeof p.name === 'string') ? p.name : 'Unknown'
    };
  }).filter(Boolean);

  // --- v1 → v2 migration: convert player snapshots to playerId references ---
  //
  // v1 events stored player/playerOff/playerOn as snapshot objects:
  //   { id: 'player_3', number: '10', name: 'Abebe Bikila' }
  //
  // v2 events store playerId/playerOffId/playerOnId as plain strings:
  //   'player_3'
  //
  // The renderer resolves the ID to the current squad entry at display time,
  // so renaming a player in the squad now updates all past events. If the
  // player no longer exists in the squad, the renderer shows "Unknown player".
  //
  // This migration extracts the ID from the snapshot and drops the snapshot.
  // It handles: valid snapshots, null, missing fields, and corrupt entries.
  if (migrated.__schemaVersion < 2) {
    migrated.events = migrated.events.map((ev) => {
      const v2 = Object.assign({}, ev);

      // Convert player snapshot → playerId
      if ('playerId' in v2) {
        // Already has playerId (forward-compatible) — ensure it's a string or null
        v2.playerId = (typeof v2.playerId === 'string') ? v2.playerId : null;
      } else if (ev.player && typeof ev.player === 'object' && !Array.isArray(ev.player) && typeof ev.player.id === 'string') {
        v2.playerId = ev.player.id;
      } else {
        v2.playerId = null;
      }
      delete v2.player;

      // Convert playerOff snapshot → playerOffId
      if ('playerOffId' in v2) {
        v2.playerOffId = (typeof v2.playerOffId === 'string') ? v2.playerOffId : null;
      } else if (ev.playerOff && typeof ev.playerOff === 'object' && !Array.isArray(ev.playerOff) && typeof ev.playerOff.id === 'string') {
        v2.playerOffId = ev.playerOff.id;
      } else {
        v2.playerOffId = null;
      }
      delete v2.playerOff;

      // Convert playerOn snapshot → playerOnId
      if ('playerOnId' in v2) {
        v2.playerOnId = (typeof v2.playerOnId === 'string') ? v2.playerOnId : null;
      } else if (ev.playerOn && typeof ev.playerOn === 'object' && !Array.isArray(ev.playerOn) && typeof ev.playerOn.id === 'string') {
        v2.playerOnId = ev.playerOn.id;
      } else {
        v2.playerOnId = null;
      }
      delete v2.playerOn;

      return v2;
    });
    migrated.__schemaVersion = 2;
  }

  // --- v2 → v3 migration: add match-time fields to events + matchClock ---
  if (migrated.__schemaVersion < 3) {
    migrated.events = migrated.events.map((ev) => {
      const v3 = Object.assign({}, ev);
      const time = (typeof ev.time === 'number' && isFinite(ev.time)) ? ev.time : 0;
      if (!('videoTime' in v3)) v3.videoTime = null;
      if (!('matchTime' in v3)) v3.matchTime = time;
      if (!('matchSeconds' in v3)) v3.matchSeconds = Math.floor(time);
      if (!('officialMinute' in v3)) v3.officialMinute = Math.ceil(time / 60);
      if (!('second' in v3)) v3.second = Math.floor(time) % 60;
      if (!('period' in v3)) v3.period = '2H';
      if (!('team' in v3)) v3.team = ev.side === 'for' ? 'our' : ev.side === 'against' ? 'opponent' : 'our';
      if (!('sequenceId' in v3)) v3.sequenceId = null;
      if (!('scoreForBefore' in v3)) v3.scoreForBefore = 0;
      if (!('scoreAgainstBefore' in v3)) v3.scoreAgainstBefore = 0;
      return v3;
    });
    if (!migrated.matchClock || typeof migrated.matchClock !== 'object') {
      migrated.matchClock = {
        clockStartedAt: null, clockBaseSeconds: 0, clockRunning: false,
        period: 'PRE_MATCH', scoreFor: 0, scoreAgainst: 0,
        videoSyncOffset: 0, selectedTeam: 'our', selectedPlayerId: null,
        activeSequenceId: null, nextSequenceNumber: 1
      };
    }
    migrated.__schemaVersion = 3;
  }

  // Future migrations (v3 → v4, etc.) would go here as a chain:
  // if (migrated.__schemaVersion < 4) { ... migrate v3 → v4 ...; migrated.__schemaVersion = 4; }

  return migrated;
}

// Migrate squad data. The original squad.json was a bare JSON array of
// player objects. The new format is a wrapper object:
//   { __schemaVersion: 1, players: [ ... ] }
// The loader accepts both formats transparently and always returns the
// current-version wrapper shape. The renderer's squad:load handler
// receives the players array (backward-compatible with the original
// expectation that squad:load returns an array).
function migrateSquadData(data) {
  // v0: bare array
  if (Array.isArray(data)) {
    const players = data.map((p) => {
      if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
      return {
        id: (typeof p.id === 'string') ? p.id : ('player_' + Math.random().toString(36).slice(2, 10)),
        number: (typeof p.number === 'string') ? p.number : String(p.number ?? ''),
        name: (typeof p.name === 'string') ? p.name : 'Unknown'
      };
    }).filter(Boolean);
    return { __schemaVersion: 1, players };
  }

  // v1+: wrapped object
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const fileVersion = (typeof data.__schemaVersion === 'number') ? data.__schemaVersion : 0;
    if (fileVersion > CURRENT_SCHEMA_VERSION) {
      throw new Error(
        'The squad file was saved by a newer version of MatchTag ' +
        '(schema v' + fileVersion + '). Please update MatchTag.'
      );
    }
    if (fileVersion === CURRENT_SCHEMA_VERSION) {
      return data;
    }
    // v0 wrapped object (shouldn't happen, but handle defensively)
    const players = Array.isArray(data.players) ? data.players : [];
    return { __schemaVersion: 1, players };
  }

  // Neither array nor object — empty squad
  return { __schemaVersion: 1, players: [] };
}

// --- File operations, invoked from the renderer via preload.js ---

// Let the user pick a video file from disk. Returns the local file path
// (renderer loads it directly via a file:// URL).
ipcMain.handle('dialog:openVideo', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open match video',
    properties: ['openFile'],
    filters: [
      { name: 'Video files', extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm'] }
    ]
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const filePath = result.filePaths[0];
  return { path: filePath, url: pathToFileURL(filePath).toString() };
});

// Save the current tag session (event log) to a JSON file chosen by the user.
// Stamps __schemaVersion and __savedAt so the file is self-describing and
// can be migrated by future versions of MatchTag.
// Uses fs.promises (async) so the main process doesn't block during I/O.
ipcMain.handle('file:saveSession', async (_event, sessionData) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save tagging session',
    defaultPath: 'match-session.json',
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (result.canceled || !result.filePath) return { canceled: true };

  const stamped = Object.assign({}, sessionData, {
    __schemaVersion: CURRENT_SCHEMA_VERSION,
    __savedAt: new Date().toISOString()
  });
  try {
    await fs.promises.writeFile(result.filePath, JSON.stringify(stamped, null, 2), 'utf-8');
    return { canceled: false, filePath: result.filePath };
  } catch (err) {
    dialog.showErrorBox('Save failed', err && err.message ? err.message : 'Could not write the session file.');
    return { canceled: true };
  }
});

// Export the event log as CSV for use elsewhere (spreadsheets, other tools).
// Uses fs.promises (async) so the main process doesn't block during I/O.
ipcMain.handle('file:exportCsv', async (_event, csvString) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export events as CSV',
    defaultPath: 'match-events.csv',
    filters: [{ name: 'CSV', extensions: ['csv'] }]
  });
  if (result.canceled || !result.filePath) return { canceled: true };

  try {
    await fs.promises.writeFile(result.filePath, csvString, 'utf-8');
    return { canceled: false, filePath: result.filePath };
  } catch (err) {
    dialog.showErrorBox('Export failed', err && err.message ? err.message : 'Could not write the CSV file.');
    return { canceled: true };
  }
});

// Export a clip playlist: writes a CSV reference and an ffmpeg .bat script
// into a folder the user picks, so they don't have to save two files separately.
// Uses fs.promises (async) so the main process doesn't block during I/O.
ipcMain.handle('file:exportClipPlaylist', async (_event, { csv, script }) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a folder to save the clip playlist',
    properties: ['openDirectory', 'createDirectory']
  });
  if (result.canceled || result.filePaths.length === 0) return { canceled: true };

  const dir = result.filePaths[0];
  try {
    await fs.promises.writeFile(path.join(dir, 'clip_playlist.csv'), csv, 'utf-8');
    await fs.promises.writeFile(path.join(dir, 'cut_clips.bat'), script, 'utf-8');
    return { canceled: false, dir };
  } catch (err) {
    dialog.showErrorBox('Export failed', err && err.message ? err.message : 'Could not write the clip playlist files.');
    return { canceled: true };
  }
});

// Load a previously saved session back in. Runs migrateSessionData() so the
// renderer always receives data at the current schema version, regardless
// of which version of MatchTag (or the original unversioned app) saved the file.
ipcMain.handle('file:loadSession', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Load tagging session',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (result.canceled || result.filePaths.length === 0) return null;

  try {
    const raw = await fs.promises.readFile(result.filePaths[0], 'utf-8');
    const parsed = JSON.parse(raw);
    const migrated = migrateSessionData(parsed);
    if (migrated.videoPath) {
      try {
        migrated.videoUrl = pathToFileURL(migrated.videoPath).toString();
      } catch (e) {
        migrated.videoUrl = null;
      }
      try {
        await fs.promises.access(migrated.videoPath);
        migrated.__videoExists = true;
      } catch (e) {
        migrated.__videoExists = false;
      }
    } else {
      migrated.__videoExists = false;
    }
    return migrated;
  } catch (err) {
    dialog.showErrorBox('Load failed', err && err.message ? err.message : 'That file is not a valid MatchTag session.');
    return null;
  }
});

// Load several sessions at once for the season view - only the tagged data
// (events/tags/matchInfo) is needed here, not the video itself.
ipcMain.handle('file:loadMultipleSessions', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Load match sessions for season view',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (result.canceled || result.filePaths.length === 0) return [];

  const sessions = [];
  for (const filePath of result.filePaths) {
    try {
      const raw = await fs.promises.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      const migrated = migrateSessionData(parsed);
      migrated.sourceFile = filePath;
      sessions.push(migrated);
    } catch (err) {
      // Skip files that aren't valid MatchTag sessions rather than failing the whole batch.
    }
  }
  return sessions;
});

// --- Squad roster: persisted separately from any one match session, so the
// same player list carries over automatically next time the app opens. ---
//
// File format: { __schemaVersion: 1, players: [ ... ] }
// The original (pre-Phase-1C) format was a bare JSON array; migrateSquadData()
// handles both transparently. squad:load returns the players array directly
// (backward-compatible with the renderer's existing expectation).

function squadFilePath() {
  return path.join(app.getPath('userData'), 'squad.json');
}

// squadTempPath and writeSquadAsync provide atomic writes for squad.json
// (temp + rename, same pattern as autosave). Prevents corruption if the
// process is killed mid-write.
function squadTempPath() {
  return path.join(app.getPath('userData'), 'squad.json.tmp');
}

ipcMain.handle('squad:load', async () => {
  try {
    const raw = await fs.promises.readFile(squadFilePath(), 'utf-8');
    const parsed = JSON.parse(raw);
    const migrated = migrateSquadData(parsed);
    return migrated.players;
  } catch (err) {
    return [];
  }
});

async function writeSquadAsync(squad) {
  const wrapped = {
    __schemaVersion: CURRENT_SCHEMA_VERSION,
    players: Array.isArray(squad) ? squad : []
  };
  const tmp = squadTempPath();
  const dst = squadFilePath();
  await fs.promises.writeFile(tmp, JSON.stringify(wrapped, null, 2), 'utf-8');
  await fs.promises.rename(tmp, dst);
}

ipcMain.handle('squad:save', async (_event, squad) => {
  try {
    await writeSquadAsync(squad);
    return true;
  } catch (err) {
    return false;
  }
});

// --- Autosave: a safety-net copy of the current working session, kept at
// userData/autosave.json. Written atomically (temp file + rename) so a
// crash mid-write never corrupts the previous valid autosave. Read on
// startup to offer recovery; cleared after a successful manual save or
// load so it never clobbers a deliberately-saved session.
//
// The autosave file uses the SAME shape as a normal session JSON
// ({ videoPath, tags, events, squad, matchInfo }) plus a single extra
// __savedAt ISO timestamp field so the recovery modal can show when the
// work was last preserved. The manual "Save session" format is unchanged.
//
// Two write paths:
//   - 'autosave:write' (async invoke) — used by the debounced autosave
//     in the renderer. Returns { ok, path?, error? }.
//   - 'autosave:flush-sync' (sync sendSync) — used by the renderer's
//     beforeunload handler so the write completes before the window is
//     torn down. If data is null, the autosave is deleted.

function autosaveFilePath() {
  return path.join(app.getPath('userData'), 'autosave.json');
}

function autosaveTempPath() {
  return path.join(app.getPath('userData'), 'autosave.json.tmp');
}

// Atomic write: write to temp, then rename. If the write or rename fails,
// the previous autosave.json (if any) is left untouched. Stamps the current
// schema version so the autosave is always self-describing.
// Two variants: sync (for flush-sync handler) and async (for autosave:write)
function writeAutosaveSync(data) {
  const tmp = autosaveTempPath();
  const dst = autosaveFilePath();
  const stamped = Object.assign({}, data, {
    __schemaVersion: CURRENT_SCHEMA_VERSION,
    __savedAt: new Date().toISOString()
  });
  fs.writeFileSync(tmp, JSON.stringify(stamped, null, 2), 'utf-8');
  fs.renameSync(tmp, dst);
}

async function writeAutosaveAsync(data) {
  const tmp = autosaveTempPath();
  const dst = autosaveFilePath();
  const stamped = Object.assign({}, data, {
    __schemaVersion: CURRENT_SCHEMA_VERSION,
    __savedAt: new Date().toISOString()
  });
  await fs.promises.writeFile(tmp, JSON.stringify(stamped, null, 2), 'utf-8');
  await fs.promises.rename(tmp, dst);
}

function deleteAutosaveSync() {
  const dst = autosaveFilePath();
  const tmp = autosaveTempPath();
  try { if (fs.existsSync(dst)) fs.unlinkSync(dst); } catch (e) { /* best effort */ }
  try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e) { /* best effort */ }
}

// Read the autosave file. Returns null if the file doesn't exist or is
// corrupt (in which case the file is left on disk for manual inspection).
// Runs migrateSessionData() so the renderer always receives current-version
// data, regardless of which app version wrote the autosave. If the
// autosave has a videoPath, the videoUrl is recomputed and __videoExists is
// set based on whether the file is still present on disk, so the recovery
// modal can warn the analyst.
ipcMain.handle('autosave:read', async () => {
  try {
    const dst = autosaveFilePath();
    try {
      await fs.promises.access(dst);
    } catch (e) {
      return null;
    }
    const raw = await fs.promises.readFile(dst, 'utf-8');
    const parsed = JSON.parse(raw);
    const migrated = migrateSessionData(parsed);
    if (migrated.videoPath) {
      try {
        migrated.videoUrl = pathToFileURL(migrated.videoPath).toString();
      } catch (e) {
        migrated.videoUrl = null;
      }
      try {
        await fs.promises.access(migrated.videoPath);
        migrated.__videoExists = true;
      } catch (e) {
        migrated.__videoExists = false;
      }
    } else {
      migrated.__videoExists = false;
    }
    return migrated;
  } catch (err) {
    // Corrupt or unreadable autosave — treat as no autosave. The file is
    // left on disk so the analyst can manually inspect or delete it.
    return null;
  }
});

// Async write (used by the debounced autosave in the renderer).
ipcMain.handle('autosave:write', async (_event, data) => {
  try {
    await writeAutosaveAsync(data);
    return { ok: true, path: autosaveFilePath() };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
});

// Async delete (used after manual save/load to clear the autosave so it
// never clobbers a deliberately-saved session).
ipcMain.handle('autosave:delete', async () => {
  try {
    const dst = autosaveFilePath();
    const tmp = autosaveTempPath();
    try { await fs.promises.unlink(dst); } catch (e) { /* best effort */ }
    try { await fs.promises.unlink(tmp); } catch (e) { /* best effort */ }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
});

// Synchronous flush used by the renderer's beforeunload handler. The
// renderer process is about to be torn down, so the write must complete
// before this call returns. If data is null, the autosave is deleted.
ipcMain.on('autosave:flush-sync', (event, data) => {
  try {
    if (data === null) {
      deleteAutosaveSync();
    } else {
      writeAutosaveSync(data);
    }
    event.returnValue = { ok: true };
  } catch (err) {
    event.returnValue = { ok: false, error: err && err.message ? err.message : String(err) };
  }
});

// --- Safe-close: renderer tells main to proceed with the close after the
// user approved it (either the session was clean, or they clicked "Save"
// or "Don't save" in the unsaved-changes modal). Sets forceClose so the
// 'close' handler doesn't re-intercept, then calls close() again. ---
ipcMain.on('close:proceed', () => {
  if (mainWindow) {
    mainWindow.forceClose = true;
    mainWindow.close();
  }
});

// --- Detachable video window: a genuine separate OS window (not just a
// resizable panel) so it can be dragged to a second monitor. The actual
// <video> element only ever decodes in ONE place at a time - main.js relays
// play/pause/seek/rate commands one way and live position/duration state
// the other way, so the main window's tagging logic always has an accurate
// current time to stamp events with, even while the video itself lives in
// the other window. ---

ipcMain.handle('video:detach', async (_event, state) => {
  if (detachedVideoWindow) {
    detachedVideoWindow.focus();
    return true;
  }

  detachedVideoWindow = new BrowserWindow({
    width: 960,
    height: 540,
    minWidth: 320,
    minHeight: 200,
    title: 'MatchTag — Video',
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'detached-preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  detachedVideoWindow.loadFile(path.join(__dirname, 'detached-video.html'));
  detachedVideoWindow.webContents.once('did-finish-load', () => {
    if (detachedVideoWindow) detachedVideoWindow.webContents.send('detach-video:load', state);
  });

  detachedVideoWindow.on('closed', () => {
    detachedVideoWindow = null;
    if (mainWindow) mainWindow.webContents.send('detach-video:closed');
  });

  return true;
});

ipcMain.handle('video:reattach', async () => {
  if (detachedVideoWindow) {
    detachedVideoWindow.close(); // triggers the 'closed' handler above, which notifies the main window
  }
  return true;
});

// One-way relay: main window's transport controls -> detached window's video.
ipcMain.on('video:command', (_event, cmd) => {
  if (detachedVideoWindow) {
    detachedVideoWindow.webContents.send('detach-video:command', cmd);
  }
});

// One-way relay: detached window's live video state -> main window (for the
// remote transport bar display and, critically, for tagging timestamps).
ipcMain.on('detach-video:state', (_event, state) => {
  if (mainWindow) {
    mainWindow.webContents.send('detach-video:state', state);
  }
});
