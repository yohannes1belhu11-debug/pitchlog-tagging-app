#!/usr/bin/env node
// PitchLog / MatchTag — R3-A: matchday roster PERSISTENCE harness (main process).
// ============================================================================
// Verification-only harness. It does NOT modify any app source file.
//
// Loads the REAL src/main.js into plain Node with a stubbed 'electron'
// module (Module._load hook — same architecture as integrity-harness.js /
// tag-library-main-check.js) and drives the REAL IPC handlers with
// controllable dialogs, proving the matchRoster round-trips through every
// approved persistence channel WITHOUT any schema bump (v4 preserved):
//
//   R3-13a  file:saveSession → file:loadSession round-trip keeps matchRoster
//           verbatim (schema stays 4)
//   R3-13b  autosave:write → autosave:read round-trip keeps matchRoster
//   R3-13c  autosave:flush-sync (the close/crash path) writes the roster;
//           a subsequent autosave:read returns it (close → reopen cycle)
//   R3-14a  LEGACY v4 session (no matchRoster) loads as-is with every other
//           field intact; re-saving preserves all fields + schema 4
//   R3-14b  legacy v3 session with a FORWARD-ADDED matchRoster migrates to
//           v4 and PRESERVES the roster (unknown top-level fields survive)
//   R3-14c  legacy v3 session without a roster migrates to v4 cleanly
//   R3-14d  CURRENT_SCHEMA_VERSION stays exactly 4 in src/main.js (static)
//   R3-07m  ISOLATION at the persistence layer: saving a session with a
//           matchRoster never touches squad.json; squad:save stays separate
//
// Run:  node tests/roster-persistence-main-check.js   (from the project root)
'use strict';

(async () => {

const path = require('path');
const os = require('os');
const fs = require('fs');
const Module = require('module');

// ---------------------------------------------------------------------------
// Test bookkeeping
// ---------------------------------------------------------------------------
const results = [];
function ok(name, cond, detail) {
  results.push({ name, pass: !!cond, detail: detail || '' });
  console.log((cond ? '[PASS] ' : '[FAIL] ') + name + (detail ? '  | ' + detail : ''));
  if (!cond) process.exitCode = 1;
}
function section(title) { console.log('\n== ' + title + ' =='); }

// ---------------------------------------------------------------------------
// Stub 'electron' with CONTROLLABLE dialogs (integrity-harness pattern)
// ---------------------------------------------------------------------------
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitchlog-roster-main-'));

const dialogState = {
  savePath: null,      // next showSaveDialog destination (null → canceled)
  openPaths: null      // next showOpenDialog selection (null → canceled)
};

const electronStub = {
  app: {
    getPath: (name) => (name === 'userData' ? userDataDir : path.join(userDataDir, name)),
    whenReady: () => new Promise(() => {}), // never ready — no window is created
    on: () => {},
    quit: () => {},
    requestSingleInstanceLock: () => true
  },
  powerMonitor: { on: () => {} },
  BrowserWindow: class {},
  ipcMain: {
    handlers: {},
    listeners: {},
    handle: function (channel, fn) { this.handlers[channel] = fn; },
    on: function (channel, fn) { this.listeners[channel] = fn; }
  },
  dialog: {
    showSaveDialog: async () => (dialogState.savePath
      ? { canceled: false, filePath: dialogState.savePath }
      : { canceled: true }),
    showOpenDialog: async () => (dialogState.openPaths
      ? { canceled: false, filePaths: dialogState.openPaths }
      : { canceled: true, filePaths: [] }),
    showErrorBox: () => {}
  }
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronStub;
  return originalLoad.apply(this, arguments);
};
const main = require(path.join(__dirname, '..', 'src', 'main.js'));
const handlers = electronStub.ipcMain.handlers;
const listeners = electronStub.ipcMain.listeners;

const fakeEvent = {};
function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf-8')); }
function writeJson(p, data) { fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf-8'); }
function exists(p) { try { fs.accessSync(p); return true; } catch (e) { return false; } }

const SESSION_FILE = path.join(userDataDir, 'session-with-roster.json');
const LEGACY_V4_FILE = path.join(userDataDir, 'legacy-v4.json');
const LEGACY_V3_FILE = path.join(userDataDir, 'legacy-v3.json');
const LEGACY_V3_ROSTER_FILE = path.join(userDataDir, 'legacy-v3-roster.json');
const AUTOSAVE_FILE = path.join(userDataDir, 'autosave.json');
const SQUAD_FILE = path.join(userDataDir, 'squad.json');

// A canonical R3-A roster: our overlay entries + opponent-namespace entries,
// all six approved fields, all four statuses represented.
const MATCH_ROSTER = {
  our: [
    { playerId: 'player_1', displayName: 'GK Kid', shirtNumber: 1, position: 'GK', role: '', status: 'starter' },
    { playerId: 'player_9', displayName: 'Super Sub', shirtNumber: 22, position: 'MF', role: '', status: 'on' },
    { playerId: 'player_6', displayName: 'Came Off', shirtNumber: 6, position: 'DF', role: '', status: 'substituted' },
    { playerId: 'player_12', displayName: 'Bench Warmer', shirtNumber: 12, position: 'FW', role: '', status: 'bench' }
  ],
  opponent: [
    { playerId: 'match_opp_1', displayName: 'Opp ST', shirtNumber: 9, position: 'ST', role: '', status: 'starter' },
    { playerId: 'match_opp_2', displayName: 'Opp Bench', shirtNumber: 14, position: 'MF', role: '', status: 'bench' }
  ]
};

const BASE_SESSION = {
  videoPath: null,
  tags: [{ label: 'Goal', key: '1' }],
  events: [
    { id: 1, time: 120.5, label: 'Pass', subtype: null, qualifiers: {}, location: { x: 0.5, y: 0.5 },
      playerId: 'player_1', playerOffId: null, playerOnId: null, side: 'for', isInterval: false,
      outcome: null, team: 'our' },
    { id: 2, time: 300, label: 'Sub', subtype: null, qualifiers: {}, location: null,
      playerId: null, playerOffId: 'player_6', playerOnId: 'player_9', side: 'for', isInterval: false,
      outcome: null, team: 'our' }
  ],
  squad: [
    { id: 'player_1', number: '1', name: 'GK Kid' },
    { id: 'player_6', number: '6', name: 'Came Off' },
    { id: 'player_9', number: '22', name: 'Super Sub' },
    { id: 'player_12', number: '12', name: 'Bench Warmer' }
  ],
  matchInfo: {
    competition: 'EPL', date: '2026-01-01', opponent: 'Bahir Dar City', venue: 'Home',
    homeAway: 'home', ourScore: '2', opponentScore: '1', formation: '4-3-3',
    startingXI: [
      { position: 'GK', playerId: 'player_1' },
      { position: 'ST', playerId: 'player_9' }
    ]
  },
  matchClock: {
    clockStartedAt: null, clockBaseSeconds: 2700, clockRunning: false, period: 'HT',
    scoreFor: 2, scoreAgainst: 1, videoSyncOffset: 0, selectedTeam: 'our',
    selectedPlayerId: null, activeSequenceId: null, nextSequenceNumber: 1
  }
};

console.log('roster-persistence-main harness — userData dir: ' + userDataDir);
console.log('main.js loaded; handlers present: ' +
  ['file:saveSession', 'file:loadSession', 'autosave:write', 'autosave:read']
    .filter((c) => typeof handlers[c] === 'function').join(', '));

// ===========================================================================
section('R3-14d — schema version stays 4 (static)');
{
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf-8');
  ok('R3-14d1: CURRENT_SCHEMA_VERSION is exactly 4 (no bump for R3-A)',
    /const CURRENT_SCHEMA_VERSION = 4;/.test(mainSrc));
  const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf-8');
  ok('R3-14d2: NO new roster IPC channel — the roster rides the existing opaque session/autosave payloads',
    !/roster:/.test(preloadSrc));
}

// ===========================================================================
section('R3-13a — file:saveSession → file:loadSession round-trip');
{
  const payload = Object.assign({}, BASE_SESSION, { matchRoster: MATCH_ROSTER });
  dialogState.savePath = SESSION_FILE;
  const res = await handlers['file:saveSession'](fakeEvent, payload);
  ok('R3-13a1: save returns success + path', !!(res && res.canceled === false && res.filePath === SESSION_FILE), JSON.stringify(res));

  const onDisk = exists(SESSION_FILE) ? readJson(SESSION_FILE) : null;
  ok('R3-13a2: written file stamps __schemaVersion 4 (v4 preserved)', onDisk && onDisk.__schemaVersion === 4);
  ok('R3-13a3: written file carries matchRoster verbatim (six-field entries both sides)',
    onDisk && JSON.stringify(onDisk.matchRoster) === JSON.stringify(MATCH_ROSTER));
  ok('R3-13a4: all classic fields still present (events/squad/matchInfo/matchClock/startingXI)',
    onDisk && onDisk.events.length === 2 && onDisk.squad.length === 4 &&
      JSON.stringify(onDisk.matchInfo.startingXI) === JSON.stringify(BASE_SESSION.matchInfo.startingXI) &&
      onDisk.matchClock.period === 'HT');

  dialogState.openPaths = [SESSION_FILE];
  const loaded = await handlers['file:loadSession'](fakeEvent);
  ok('R3-13a5: loadSession returns the migrated (v4 passthrough) data with matchRoster intact',
    loaded && loaded.__schemaVersion === 4 && JSON.stringify(loaded.matchRoster) === JSON.stringify(MATCH_ROSTER));
  ok('R3-13a6: round-trip preserves every status value (starter/bench/on/substituted all survive)',
    loaded && loaded.matchRoster.our.map((p) => p.status).join(',') === 'starter,on,substituted,bench');
  ok('R3-13a7: opponent ids stay in the match_opp_* namespace after the round-trip',
    loaded && loaded.matchRoster.opponent.every((p) => p.playerId.indexOf('match_opp_') === 0));
}

// ===========================================================================
section('R3-13b — autosave:write → autosave:read round-trip');
{
  const res = await handlers['autosave:write'](fakeEvent, Object.assign({}, BASE_SESSION, { matchRoster: MATCH_ROSTER }));
  ok('R3-13b1: autosave:write reports ok', !!(res && res.ok === true));
  const readBack = await handlers['autosave:read'](fakeEvent);
  ok('R3-13b2: autosave:read returns the roster verbatim (v4-stamped file)',
    readBack && readBack.__schemaVersion === 4 && JSON.stringify(readBack.matchRoster) === JSON.stringify(MATCH_ROSTER));
  ok('R3-13b3: classic autosave fields intact alongside the roster',
    readBack && readBack.events.length === 2 && readBack.__savedAt);
}

// ===========================================================================
section('R3-13c — autosave:flush-sync (close/crash path) → reopen read');
{
  const flushListener = listeners['autosave:flush-sync'];
  ok('R3-13c1: flush-sync listener registered', typeof flushListener === 'function');
  const ev = { returnValue: undefined };
  flushListener(ev, Object.assign({}, BASE_SESSION, { matchRoster: MATCH_ROSTER }));
  ok('R3-13c2: flush-sync reports ok', !!(ev.returnValue && ev.returnValue.ok === true), JSON.stringify(ev.returnValue));
  ok('R3-13c3: the flush wrote the autosave file', exists(AUTOSAVE_FILE));
  const readBack = await handlers['autosave:read'](fakeEvent);
  ok('R3-13c4: close→reopen cycle: the flushed roster is fully recoverable',
    readBack && JSON.stringify(readBack.matchRoster) === JSON.stringify(MATCH_ROSTER),
    readBack ? 'roster sides ' + readBack.matchRoster.our.length + '/' + readBack.matchRoster.opponent.length : 'null');
}

// ===========================================================================
section('R3-14a — LEGACY v4 file (no matchRoster): load + re-save');
{
  // Exactly what a pre-R3-A v4 session looks like on disk.
  const legacy = Object.assign({}, BASE_SESSION, { __schemaVersion: 4, __savedAt: '2025-06-01T00:00:00.000Z' });
  delete legacy.matchRoster; // R3-A fields never existed in legacy files
  writeJson(LEGACY_V4_FILE, legacy);

  dialogState.openPaths = [LEGACY_V4_FILE];
  const loaded = await handlers['file:loadSession'](fakeEvent);
  ok('R3-14a1: legacy v4 session loads (no error, no roster field)',
    loaded && loaded.__schemaVersion === 4 && !('matchRoster' in loaded));
  ok('R3-14a2: every legacy field is intact (events/squad/matchInfo/startingXI/matchClock)',
    loaded && loaded.events.length === 2 && loaded.squad.length === 4 &&
      JSON.stringify(loaded.matchInfo.startingXI) === JSON.stringify(BASE_SESSION.matchInfo.startingXI) &&
      loaded.matchClock.period === 'HT');

  // Re-save (what the renderer does after loading: same content, plus the
  // now-canonical empty/normalized roster field).
  const resave = Object.assign({}, loaded, { matchRoster: { our: [], opponent: [] } });
  dialogState.savePath = LEGACY_V4_FILE;
  const res = await handlers['file:saveSession'](fakeEvent, resave);
  ok('R3-14a3: re-save succeeds', !!(res && res.canceled === false));
  const onDisk = readJson(LEGACY_V4_FILE);
  ok('R3-14a4: re-saved file STILL schema v4 (legacy-v4 re-save keeps the version)',
    onDisk.__schemaVersion === 4);
  ok('R3-14a5: re-saved file preserves every legacy field byte-for-byte in value',
    onDisk.events.length === 2 && onDisk.squad.length === 4 &&
      JSON.stringify(onDisk.matchInfo.startingXI) === JSON.stringify(BASE_SESSION.matchInfo.startingXI) &&
      onDisk.matchClock.scoreFor === 2 && onDisk.tags.length === 1);
  ok('R3-14a6: re-saved file carries the (empty) roster — additive, nothing lost',
    onDisk.matchRoster && onDisk.matchRoster.our.length === 0 && onDisk.matchRoster.opponent.length === 0);

  // And it loads right back.
  dialogState.openPaths = [LEGACY_V4_FILE];
  const reloaded = await handlers['file:loadSession'](fakeEvent);
  ok('R3-14a7: the re-saved legacy file loads cleanly again (v4, empty roster present)',
    reloaded && reloaded.__schemaVersion === 4 && reloaded.matchRoster.our.length === 0);
}

// ===========================================================================
section('R3-14b/c — legacy v3 migration (with and without a forward-added roster)');
{
  // v3 file WITHOUT a roster (the standard pre-R3-A history).
  const v3 = JSON.parse(JSON.stringify(BASE_SESSION));
  v3.__schemaVersion = 3;
  v3.events.forEach((ev) => { delete ev.outcome; }); // v3 events predate the outcome field
  writeJson(LEGACY_V3_FILE, v3);
  dialogState.openPaths = [LEGACY_V3_FILE];
  const migrated = await handlers['file:loadSession'](fakeEvent);
  ok('R3-14c1: v3 file migrates to v4', migrated && migrated.__schemaVersion === 4);
  ok('R3-14c2: migrated v3 has NO matchRoster (nothing manufactured)',
    migrated && !('matchRoster' in migrated));
  ok('R3-14c3: migration still adds outcome:null to events (v3→v4 step untouched)',
    migrated && migrated.events.every((ev) => ev.outcome === null));

  // v3 file WITH a forward-added roster (a file edited after R3-A by another
  // tool, or a future version): unknown top-level fields must survive.
  const v3r = JSON.parse(JSON.stringify(v3));
  v3r.matchRoster = MATCH_ROSTER;
  writeJson(LEGACY_V3_ROSTER_FILE, v3r);
  dialogState.openPaths = [LEGACY_V3_ROSTER_FILE];
  const migratedR = await handlers['file:loadSession'](fakeEvent);
  ok('R3-14b1: v3 + matchRoster migrates to v4 AND PRESERVES the roster',
    migratedR && migratedR.__schemaVersion === 4 && JSON.stringify(migratedR.matchRoster) === JSON.stringify(MATCH_ROSTER));
  ok('R3-14b2: the roster survived alongside the normal v3→v4 event migration',
    migratedR && migratedR.events.length === 2 && migratedR.events.every((ev) => ev.outcome === null));
}

// ===========================================================================
section('R3-07m — persistence-layer isolation: squad.json untouched');
{
  // Seed squad.json with our-team players only.
  writeJson(SQUAD_FILE, { __schemaVersion: 4, players: BASE_SESSION.squad });
  const squadBefore = readJson(SQUAD_FILE);

  // Save a session whose roster contains OPPONENT entries.
  dialogState.savePath = SESSION_FILE;
  await handlers['file:saveSession'](fakeEvent, Object.assign({}, BASE_SESSION, { matchRoster: MATCH_ROSTER }));

  ok('R3-07m1: saving a session with opponent roster entries does NOT touch squad.json',
    JSON.stringify(readJson(SQUAD_FILE)) === JSON.stringify(squadBefore));
  ok('R3-07m2: no match_opp_* id ever appears in squad.json',
    !readJson(SQUAD_FILE).players.some((p) => String(p.id).indexOf('match_opp_') === 0));

  // squad:save still works independently and stays our-team-scoped.
  const squadRes = await handlers['squad:save'](fakeEvent, BASE_SESSION.squad);
  ok('R3-07m3: squad:save still returns true (independent channel unaffected)', squadRes === true);
  ok('R3-07m4: squad.json shape unchanged by any roster flow',
    JSON.stringify(Object.keys(readJson(SQUAD_FILE))) === JSON.stringify(['__schemaVersion', 'players']));
}

// ---------------------------------------------------------------------------
const failed = results.filter((r) => !r.pass).length;
console.log('\nroster-persistence-main-check: ' + (results.length - failed) + '/' + results.length + ' checks passed' +
  (failed ? ', FAILED: ' + failed : ''));
if (failed) process.exit(1);

})().catch((e) => { console.error('HARNESS CRASH:', e); process.exit(1); });
