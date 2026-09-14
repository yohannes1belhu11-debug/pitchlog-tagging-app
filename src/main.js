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

// --- R2-C-1: Single-instance protection (architect ruling F2) ---
// PitchLog is a single-instance application (save-flow specification,
// Part F ruling F2 / Part G.1). The first process to launch acquires the
// OS-level single-instance lock and owns the app — including the userData
// persistence files (autosave.json, squad.json). Any further launch fails
// to acquire the lock and exits below, before a window is ever created,
// so two processes can never write those files concurrently.
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  // Second instance: quit immediately. No window, no UI initialization,
  // no interference with the first instance (which holds the lock and
  // retains all persistence and renderer behavior).
  app.quit();
} else {
  // First instance: a second launch was attempted while we are running.
  // Electron delivers it here as 'second-instance' — restore our existing
  // window (un-minimizing it if needed) and focus it instead of ever
  // creating a second main window. The detached-video window belongs to
  // this instance's window lifecycle and is deliberately untouched.
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(createWindow);

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

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
// Current schema version: 4
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
//   - v3 → v4 (R1): add the first-class `outcome` field to every event
//     (null default). Stored values are only 'SUCCESS' | 'FAILURE' | null
//     — never free-form strings, never in qualifiers{}. Migration NEVER
//     infers SUCCESS/FAILURE from historical data (a v3 Pass qualifier
//     'Outcome: Successful' stays a qualifier — untouched) and never
//     alters any other event field: it only adds outcome: null to events
//     that lack the field.
//
// Migration runs in the main process (the file-reading layer) so the
// renderer always receives data at the current schema version and never
// has to worry about legacy formats.

const CURRENT_SCHEMA_VERSION = 4;

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
      // Team ownership is only assigned when the legacy `side` evidence
      // supports it: 'for' → 'our', 'against' → 'opponent'. A neutral,
      // unknown, or missing side yields team = null — the schema's explicit
      // "unknown" value (new events already carry team:null via the
      // defensive branch in buildEventBase, and every consumer — full-
      // analysis CSV `ev.team||''`, touchline `ev.team==='opponent'` —
      // treats null as unknown). The original legacy `side` value is
      // always preserved; migration never invents team ownership.
      if (!('team' in v3)) v3.team = ev.side === 'for' ? 'our' : (ev.side === 'against' ? 'opponent' : null);
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

  // --- v3 → v4 migration: add the first-class outcome field (R1) ---
  //
  // Every event gains `outcome` with an explicit null default. The rule is
  // strictly additive: only events that lack the field get outcome: null;
  // nothing else on any event is read, derived, or rewritten. In particular
  // NO outcome is ever inferred from history — not from qualifiers (a v3
  // Pass's 'Outcome: Successful' qualifier remains exactly that qualifier),
  // not from labels, not from subtypes. A pre-existing outcome value on a
  // forward-edited file is carried through verbatim (same preserve-unknown-
  // fields philosophy as the v2/v3 steps); semantic validation of the
  // stored value ('SUCCESS' | 'FAILURE' | null) is the analytics layer's
  // data-quality job, not the migration's.
  if (migrated.__schemaVersion < 4) {
    migrated.events = migrated.events.map((ev) => {
      const v4 = Object.assign({}, ev);
      if (!('outcome' in v4)) v4.outcome = null;
      return v4;
    });
    migrated.__schemaVersion = 4;
  }

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

// --- R2-C-2: save-over .bak backup (architect ruling F3) ---
// Before a manual session save overwrites an existing destination, the
// existing file is preserved as <destination>.bak — exactly one backup
// generation holding the immediately previous successful saved version
// (save-flow specification, Part F ruling F3 / Part G.1 R2-C-2; closes
// risk B6). A brand-new destination gets NO .bak. The backup is
// fail-closed: if the copy cannot be completed, the error propagates and
// the save aborts BEFORE the atomic overwrite, so a destination is never
// replaced by a save whose backup failed. The .bak is plain session JSON
// at the same schema version — recoverable via "Load session" with zero
// new read-path code (C.3/INC-3). copyFile's default mode overwrites an
// existing .bak, which is exactly the single-generation ruling (no
// rotation, no .bak.bak chains).
async function backupExistingSessionFile(dstPath) {
  try {
    await fs.promises.access(dstPath);
  } catch (err) {
    // ENOENT = the destination does not exist yet: a brand-new session
    // file gets no backup (F3). Any other error means existence could not
    // be determined — fail closed rather than overwrite unbacked-up data.
    if (err && err.code === 'ENOENT') return;
    throw err;
  }
  await fs.promises.copyFile(dstPath, dstPath + '.bak');
}

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
  // Atomic write (same strategy as the autosave/squad writers): write the
  // new content to a temp file in the same directory, then rename it over
  // the destination. If the write or rename fails, the existing session
  // file is left untouched and the temp file is cleaned up.
  try {
    // R2-C-2 (F3): back up the existing destination to <name>.bak BEFORE
    // the overwrite. Runs first and fail-closed — if the backup copy
    // fails, the catch below surfaces the native error and the atomic
    // overwrite never runs (the destination stays intact).
    await backupExistingSessionFile(result.filePath);
    await writeFileAtomic(result.filePath + '.tmp', result.filePath, JSON.stringify(stamped, null, 2));
    return { canceled: false, filePath: result.filePath };
  } catch (err) {
    dialog.showErrorBox('Save failed', err && err.message ? err.message : 'Could not write the session file.');
    // The renderer treats this exactly like the pre-fix failure result
    // (canceled => session stays dirty, autosave stays intact). The extra
    // `error` field makes an actual write failure distinguishable from a
    // user cancel without changing any renderer behavior.
    return { canceled: true, error: err && err.message ? err.message : 'Could not write the session file.' };
  }
});

// R2-A: sanitize a renderer-suggested default file name for the save dialog.
// Defense in depth only — the renderer already sanitizes. Keeps just the
// base name (any smuggled path is dropped), strips Windows-invalid
// characters, and falls back to the legacy default.
function sanitizeCsvDefaultName(name) {
  if (typeof name !== 'string') return 'match-events.csv';
  const base = name.split(/[\\/]/).pop() || '';
  const cleaned = base
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^[\s._]+/, '')
    .replace(/[\s._]+$/, '')
    .slice(0, 80);
  return cleaned || 'match-events.csv';
}

// Export the event log as CSV for use elsewhere (spreadsheets, other tools).
// Uses fs.promises (async) so the main process doesn't block during I/O.
// R2-A export hygiene:
//   - The renderer passes a suggested default file NAME (export kind + match
//     metadata) so every export type gets a deterministic, distinguishable
//     suggestion; it is sanitized again here (never trust the renderer with
//     a path — only the base name survives) and falls back to the legacy
//     'match-events.csv'.
//   - The file is written UTF-8 WITH BOM — an encoding marker only. The CSV
//     string, its escaping, and every column/row semantic are untouched
//     (the BOM never enters any CSV string the engines/renderer produce).
//   - A write failure now also returns { canceled: true, error } (the same
//     pattern file:saveSession already uses) so the renderer can toast the
//     failure with the original message; the native error box is unchanged.
ipcMain.handle('file:exportCsv', async (_event, csvString, defaultName) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export events as CSV',
    defaultPath: sanitizeCsvDefaultName(defaultName),
    filters: [{ name: 'CSV', extensions: ['csv'] }]
  });
  if (result.canceled || !result.filePath) return { canceled: true };

  try {
    // BOM only for real string payloads — anything else keeps failing
    // inside writeFile exactly like before (no silent 'undefined' file).
    const payload = (typeof csvString === 'string') ? '\ufeff' + csvString : csvString;
    await fs.promises.writeFile(result.filePath, payload, 'utf-8');
    return { canceled: false, filePath: result.filePath };
  } catch (err) {
    dialog.showErrorBox('Export failed', err && err.message ? err.message : 'Could not write the CSV file.');
    return { canceled: true, error: err && err.message ? err.message : 'Could not write the CSV file.' };
  }
});

// Export a clip playlist: writes a CSV reference and an ffmpeg .bat script
// into a folder the user picks, so they don't have to save two files separately.
// Uses fs.promises (async) so the main process doesn't block during I/O.
// R2-B export-hygiene follow-up: clip_playlist.csv now gets the same UTF-8
// BOM treatment as the other CSV exports (an encoding marker only — the CSV
// string, its escaping, and every cell stay byte-identical), so Excel reads
// Amharic labels correctly. The companion cut_clips.bat stays STRICTLY
// BOM-free: cmd.exe fails on a BOM in front of '@echo off'.
ipcMain.handle('file:exportClipPlaylist', async (_event, { csv, script }) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a folder to save the clip playlist',
    properties: ['openDirectory', 'createDirectory']
  });
  if (result.canceled || result.filePaths.length === 0) return { canceled: true };

  const dir = result.filePaths[0];
  try {
    // BOM only for a real string payload — same guard as file:exportCsv.
    const csvPayload = (typeof csv === 'string') ? '\ufeff' + csv : csv;
    await fs.promises.writeFile(path.join(dir, 'clip_playlist.csv'), csvPayload, 'utf-8');
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

// writeFileAtomic(tmpPath, dstPath, content): the single shared atomic-write
// helper (write temp file, then rename over the destination). Used by the
// manual session save, squad persistence, and the async autosave writer —
// previously each of those carried its own inline copy of this pattern.
// If the temp write fails, the destination is untouched (nothing was
// renamed). If the rename fails, the destination is untouched and the temp
// file is removed (best effort) so no stale .tmp files accumulate.
// Note: exactly like the original writers, it awaits writeFile (data handed
// to the OS) but does not fsync — same durability guarantees as before;
// the existing autosave/squad behavior is neither weakened nor strengthened.
async function writeFileAtomic(tmpPath, dstPath, content) {
  await fs.promises.writeFile(tmpPath, content, 'utf-8');
  try {
    await fs.promises.rename(tmpPath, dstPath);
  } catch (renameErr) {
    try { await fs.promises.unlink(tmpPath); } catch (e) { /* best effort */ }
    throw renameErr;
  }
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
  await writeFileAtomic(squadTempPath(), squadFilePath(), JSON.stringify(wrapped, null, 2));
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

// F1.3: the synchronous flush uses its OWN temp file so a flush can never
// collide on the same temp path with an async autosave write that is still
// in flight in the process (both rename onto the same destination — the
// later rename, i.e. the flush with the freshest state, wins).
function autosaveFlushTempPath() {
  return path.join(app.getPath('userData'), 'autosave.json.flush.tmp');
}

// F1.3: serialize the ASYNC autosave file operations (write, delete) in
// arrival order. ipcMain.handle starts handlers in IPC arrival order, but
// async handlers interleave at their await points — a delete handler could
// run its unlink between an older write's writeFile and rename, letting the
// write's rename "resurrect" the autosave file after the delete removed it
// (stale data offered for recovery on next startup). Routing every async op
// through this queue guarantees each op's fs work completes before the next
// begins. The sync flush handler cannot use the queue (sendSync must set
// event.returnValue synchronously); it is safe instead because the renderer
// drains in-flight async writes before clearing (renderer F1.3 epoch/drain
// guards) and uses its own temp file, so it can only interleave with an
// async write of the SAME still-dirty session (benign staleness ≤ the
// debounce window, never a different session's data).
let autosaveAsyncOpQueue = Promise.resolve();
function enqueueAutosaveOp(op) {
  const run = autosaveAsyncOpQueue.then(op, op);
  // Keep the queue alive regardless of the op's outcome so a failure can
  // never wedge later autosaves.
  autosaveAsyncOpQueue = run.then(() => {}, () => {});
  return run;
}

// Atomic write: write to temp, then rename. If the write or rename fails,
// the previous autosave.json (if any) is left untouched. Stamps the current
// schema version so the autosave is always self-describing.
// Two variants: sync (for flush-sync handler) and async (for autosave:write)
function writeAutosaveSync(data) {
  const tmp = autosaveFlushTempPath();
  const dst = autosaveFilePath();
  const stamped = Object.assign({}, data, {
    __schemaVersion: CURRENT_SCHEMA_VERSION,
    __savedAt: new Date().toISOString()
  });
  fs.writeFileSync(tmp, JSON.stringify(stamped, null, 2), 'utf-8');
  fs.renameSync(tmp, dst);
}

async function writeAutosaveAsync(data) {
  const stamped = Object.assign({}, data, {
    __schemaVersion: CURRENT_SCHEMA_VERSION,
    __savedAt: new Date().toISOString()
  });
  await writeFileAtomic(autosaveTempPath(), autosaveFilePath(), JSON.stringify(stamped, null, 2));
}

function deleteAutosaveSync() {
  const dst = autosaveFilePath();
  const tmp = autosaveTempPath();
  const flushTmp = autosaveFlushTempPath();
  try { if (fs.existsSync(dst)) fs.unlinkSync(dst); } catch (e) { /* best effort */ }
  try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e) { /* best effort */ }
  try { if (fs.existsSync(flushTmp)) fs.unlinkSync(flushTmp); } catch (e) { /* best effort */ }
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
// F1.3: the fs work runs through enqueueAutosaveOp so it is strictly
// serialized with autosave:delete (arrival order) — no interleave window.
ipcMain.handle('autosave:write', async (_event, data) => {
  try {
    await enqueueAutosaveOp(async () => {
      await writeAutosaveAsync(data);
    });
    return { ok: true, path: autosaveFilePath() };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
});

// Async delete (used after manual save/load to clear the autosave so it
// never clobbers a deliberately-saved session).
// F1.3: serialized with autosave:write through the same queue.
ipcMain.handle('autosave:delete', async () => {
  try {
    await enqueueAutosaveOp(async () => {
      const dst = autosaveFilePath();
      const tmp = autosaveTempPath();
      const flushTmp = autosaveFlushTempPath();
      try { await fs.promises.unlink(dst); } catch (e) { /* best effort */ }
      try { await fs.promises.unlink(tmp); } catch (e) { /* best effort */ }
      try { await fs.promises.unlink(flushTmp); } catch (e) { /* best effort */ }
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
});

// Synchronous flush used by the renderer's beforeunload handler. The
// renderer process is about to be torn down, so the write must complete
// before this call returns. If data is null, the autosave is deleted.
//
// F1.3: a flush failure is no longer silent. The renderer is mid-teardown
// and cannot reliably show UI, so THIS process shows a native modal error
// dialog (dialog.showErrorBox) before returning {ok:false} — the analyst
// is told that unsaved tagging work may be lost (write case) or that a
// stale autosave may resurface as a recovery prompt (delete case). The
// dialog is shown before event.returnValue is set so the window stays on
// screen behind it while it is acknowledged.
ipcMain.on('autosave:flush-sync', (event, data) => {
  try {
    if (data === null) {
      deleteAutosaveSync();
    } else {
      writeAutosaveSync(data);
    }
    event.returnValue = { ok: true };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    try {
      if (data === null) {
        dialog.showErrorBox(
          'MatchTag — autosave cleanup failed on close',
          'The stale autosave file could not be removed on close.\n' +
          'You may be offered a recovery prompt the next time the app starts.\n\n' +
          'Error: ' + message
        );
      } else {
        dialog.showErrorBox(
          'MatchTag — autosave failed on close',
          'Unsaved tagging work could not be written to the autosave file on close.\n' +
          'Recent tags made since the last autosave may be LOST.\n\n' +
          'Error: ' + message + '\n\n' +
          'If the video and match files are still available, the last successful\n' +
          'autosave (if any) can be recovered the next time the app starts.'
        );
      }
    } catch (dialogErr) { /* never let a dialog failure mask the return value */ }
    event.returnValue = { ok: false, error: message };
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

// Exposed for the focused integrity test harness (tests/integrity-harness.js).
// Electron ignores module.exports when main.js is loaded as the app entry
// point; this block only enables plain-Node testing of the migration and
// atomic-write logic without launching Electron.
if (typeof module === 'object' && module.exports) {
  module.exports = { CURRENT_SCHEMA_VERSION, migrateSessionData, migrateSquadData };
}
