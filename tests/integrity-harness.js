#!/usr/bin/env node
// PitchLog / MatchTag — focused integrity test harness
// =====================================================
// SMALL, targeted verification for the pre-matchday data-integrity fixes
// ONLY. This is NOT a general test framework.
//
// What it exercises (real code, real filesystem, no Electron GUI):
//   FIX 1  atomic manual session save (file:saveSession IPC handler)
//   FIX 3  v3 legacy team migration (migrateSessionData)
//   FIX 4  recovery missing-player detection (src/integrity.js)
//   FIX 5  collision-safe player id generation (src/integrity.js)
//   REG    main-process regression: squad save/load, autosave
//          write/read/delete/flush-sync, CSV export, session load
//   STATIC source-level wiring checks for renderer.js / index.html
//          (Fix 2 double-fire guard, integrity.js load order,
//          generatePlayerId usage, recovery warning wiring)
//
// How it works: src/main.js is required into plain Node with a stubbed
// 'electron' module (Module._load hook) and a failure-injectable 'fs'
// proxy. IPC handlers registered via ipcMain.handle/on are captured and
// invoked directly. app.whenReady() never resolves in the stub, so no
// BrowserWindow is ever created.
//
// Run:  node tests/integrity-harness.js   (from the pitchlog project root)

'use strict';

// Everything runs inside one async IIFE so top-level await works while the
// file stays CommonJS (Node >= 20 would otherwise reparse it as ESM).
(async () => {

const path = require('path');
const os = require('os');
const Module = require('module');
const realFs = require('fs'); // real fs — captured BEFORE the hook is installed

// ---------------------------------------------------------------------------
// Test bookkeeping
// ---------------------------------------------------------------------------
const results = [];
function ok(group, name, cond, detail) {
  results.push({ group, name, pass: !!cond, detail: detail || '' });
  if (!cond) process.exitCode = 1;
}
function section(title) {
  console.log('\n== ' + title + ' ==');
}

// ---------------------------------------------------------------------------
// Stub 'electron' + failure-injectable 'fs'
// ---------------------------------------------------------------------------
const userDataDir = realFs.mkdtempSync(path.join(os.tmpdir(), 'pitchlog-harness-'));
const scratchDir = realFs.mkdtempSync(path.join(os.tmpdir(), 'pitchlog-scratch-'));

const controls = {
  saveDialog: { canceled: true },        // result returned by dialog.showSaveDialog
  openDialog: { canceled: true, filePaths: [] },
  lastErrorBox: null,
  failWritePaths: new Set(),             // absolute paths where writeFile must fail
  failRenamePaths: new Set()             // absolute destinations where rename must fail
};

const electronStub = {
  app: {
    // 'userData' IS the app-data directory itself; other named paths
    // (e.g. 'desktop') would be siblings inside it for this stub.
    getPath: (name) => (name === 'userData' ? userDataDir : path.join(userDataDir, name)),
    whenReady: () => new Promise(() => {}), // never resolve -> createWindow never runs
    on: () => {},
    quit: () => {}
  },
  BrowserWindow: class StubBrowserWindow {
    constructor() { this.webContents = { send: () => {}, once: () => {} }; }
    on() {} loadFile() {} close() {} isDestroyed() { return false; } focus() {}
  },
  ipcMain: {
    handlers: {},
    listeners: {},
    handle: function (channel, fn) { this.handlers[channel] = fn; },
    on: function (channel, fn) { this.listeners[channel] = fn; }
  },
  dialog: {
    showSaveDialog: async () => controls.saveDialog,
    showOpenDialog: async () => controls.openDialog,
    showErrorBox: (title, msg) => { controls.lastErrorBox = { title, msg }; }
  }
};

// fs proxy: everything delegates to the real fs, except promises.writeFile /
// promises.rename, which can be made to fail for specific absolute paths.
const fsProxy = new Proxy(realFs, {
  get(target, prop) {
    if (prop === 'promises') {
      return new Proxy(target.promises, {
        get(t2, p2) {
          if (p2 === 'writeFile') {
            return async (p, ...rest) => {
              if (controls.failWritePaths.has(path.resolve(String(p)))) {
                throw new Error('EACCES: permission denied (simulated write failure)');
              }
              return t2.writeFile(p, ...rest);
            };
          }
          if (p2 === 'rename') {
            return async (from, to, ...rest) => {
              if (controls.failRenamePaths.has(path.resolve(String(to)))) {
                throw new Error('EPERM: operation not permitted (simulated rename failure)');
              }
              return t2.rename(from, to, ...rest);
            };
          }
          return t2[p2];
        }
      });
    }
    return target[prop];
  }
});

// Install the require hook, then load the real main process code.
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronStub;
  if (request === 'fs') return fsProxy;
  return originalLoad.apply(this, arguments);
};
const main = require(path.join(__dirname, '..', 'src', 'main.js'));
const integrity = require(path.join(__dirname, '..', 'src', 'integrity.js'));
const handlers = electronStub.ipcMain.handlers;
const listeners = electronStub.ipcMain.listeners;

const fakeEvent = {}; // ipc event objects are unused by the handlers under test
function readJson(p) { return JSON.parse(realFs.readFileSync(p, 'utf-8')); }
function exists(p) { try { realFs.accessSync(p); return true; } catch (e) { return false; } }

// ---------------------------------------------------------------------------
console.log('PitchLog integrity harness — userData dir: ' + userDataDir);
console.log('main.js loaded; IPC handlers registered: ' + Object.keys(handlers).length);

// ===========================================================================
section('FIX 1 — atomic manual session save (file:saveSession)');

const sessionData = {
  videoPath: null, tags: [], squad: [{ id: 'player_1', number: '9', name: 'A' }],
  matchInfo: { opponent: 'Test FC' }, matchClock: { scoreFor: 1 },
  events: [{ id: 1, time: 10, label: 'Shot', side: 'for', team: 'our', playerId: 'player_1' }]
};

// 1a. save a NEW session
{
  const dest = path.join(scratchDir, 'session-new.json');
  controls.saveDialog = { canceled: false, filePath: dest };
  const res = await handlers['file:saveSession'](fakeEvent, sessionData);
  const data = exists(dest) ? readJson(dest) : null;
  ok('FIX 1', 'new session: returns success', res && res.canceled === false && res.filePath === dest, JSON.stringify(res));
  ok('FIX 1', 'new session: file is valid JSON', !!data);
  ok('FIX 1', 'new session: stamped schema v3', data && data.__schemaVersion === 3);
  ok('FIX 1', 'new session: __savedAt present', data && typeof data.__savedAt === 'string');
  ok('FIX 1', 'new session: payload intact', data && data.events.length === 1 && data.matchClock.scoreFor === 1);
  ok('FIX 1', 'new session: no temp file left behind', !exists(dest + '.tmp'));
}

// 1b. OVERWRITE an existing session
{
  const dest = path.join(scratchDir, 'session-ow.json');
  realFs.writeFileSync(dest, JSON.stringify({ __schemaVersion: 3, marker: 'OLD-CONTENT', events: [] }), 'utf-8');
  controls.saveDialog = { canceled: false, filePath: dest };
  const res = await handlers['file:saveSession'](fakeEvent, sessionData);
  const data = readJson(dest);
  ok('FIX 1', 'overwrite: returns success', res && res.canceled === false);
  ok('FIX 1', 'overwrite: new content in place', data.marker === undefined && data.events.length === 1);
  ok('FIX 1', 'overwrite: still valid JSON, v3', data.__schemaVersion === 3);
  ok('FIX 1', 'overwrite: no temp file left behind', !exists(dest + '.tmp'));
}

// 1c. WRITE FAILURE preserves the previous file
{
  const dest = path.join(scratchDir, 'session-wf.json');
  const old = JSON.stringify({ __schemaVersion: 3, marker: 'PREVIOUS-VALID-FILE', events: [{ id: 9 }] });
  realFs.writeFileSync(dest, old, 'utf-8');
  controls.saveDialog = { canceled: false, filePath: dest };
  controls.failWritePaths.add(path.resolve(dest + '.tmp')); // temp write fails
  controls.lastErrorBox = null;
  const res = await handlers['file:saveSession'](fakeEvent, sessionData);
  const data = readJson(dest);
  controls.failWritePaths.clear();
  ok('FIX 1', 'write failure: returns canceled + error', res && res.canceled === true && typeof res.error === 'string', JSON.stringify(res));
  ok('FIX 1', 'write failure: error box shown', !!controls.lastErrorBox);
  ok('FIX 1', 'write failure: previous file UNCHANGED', data.marker === 'PREVIOUS-VALID-FILE' && data.events.length === 1);
  ok('FIX 1', 'write failure: no temp file left behind', !exists(dest + '.tmp'));
}

// 1d. RENAME FAILURE preserves the previous file and cleans the temp file
{
  const dest = path.join(scratchDir, 'session-rf.json');
  const old = JSON.stringify({ __schemaVersion: 3, marker: 'PREVIOUS-VALID-FILE-2', events: [{ id: 8 }] });
  realFs.writeFileSync(dest, old, 'utf-8');
  controls.saveDialog = { canceled: false, filePath: dest };
  controls.failRenamePaths.add(path.resolve(dest)); // rename onto destination fails
  controls.lastErrorBox = null;
  const res = await handlers['file:saveSession'](fakeEvent, sessionData);
  const data = readJson(dest);
  controls.failRenamePaths.clear();
  ok('FIX 1', 'rename failure: returns canceled + error', res && res.canceled === true && typeof res.error === 'string', JSON.stringify(res));
  ok('FIX 1', 'rename failure: previous file UNCHANGED', data.marker === 'PREVIOUS-VALID-FILE-2' && data.events.length === 1);
  ok('FIX 1', 'rename failure: temp file CLEANED UP', !exists(dest + '.tmp'));
}

// ===========================================================================
section('FIX 3 — safe legacy team migration (migrateSessionData)');

{
  // v0 legacy file: for / against / neutral / missing / unknown-string sides
  const v0 = {
    videoPath: null, tags: [], squad: [],
    matchInfo: {},
    events: [
      { id: 1, time: 10, label: 'Shot', side: 'for' },
      { id: 2, time: 20, label: 'Tackle', side: 'against' },
      { id: 3, time: 30, label: 'Foul', side: 'neutral' },
      { id: 4, time: 40, label: 'Corner' },                       // side missing
      { id: 5, time: 50, label: 'Odd', side: 'xyz' }              // unknown value
    ]
  };
  const m = main.migrateSessionData(JSON.parse(JSON.stringify(v0)));
  const ev = (id) => m.events.find((e) => e.id === id);
  ok('FIX 3', 'side for -> team our', ev(1).team === 'our', 'team=' + ev(1).team);
  ok('FIX 3', 'side against -> team opponent', ev(2).team === 'opponent', 'team=' + ev(2).team);
  ok('FIX 3', 'side neutral -> team null (NOT our)', ev(3).team === null, 'team=' + ev(3).team);
  ok('FIX 3', 'side missing -> team null (NOT our)', ev(4).team === null, 'team=' + ev(4).team);
  ok('FIX 3', 'side unknown -> team null (NOT our)', ev(5).team === null, 'team=' + ev(5).team);
  ok('FIX 3', 'legacy side values preserved', ev(1).side === 'for' && ev(2).side === 'against' && ev(3).side === 'neutral' && ev(4).side === null && ev(5).side === 'xyz');
  ok('FIX 3', 'migrated to schema v3', m.__schemaVersion === 3);
  ok('FIX 3', 'v3 defaults added (period, sequenceId, score)', ev(1).period === '2H' && ev(1).sequenceId === null && ev(1).scoreForBefore === 0);

  // v2 file with explicit team: preserved, not overwritten
  const v2 = {
    __schemaVersion: 2, videoPath: null, tags: [], squad: [], matchInfo: {},
    events: [{ id: 1, time: 5, label: 'X', side: 'neutral', playerId: null, playerOffId: null, playerOnId: null, team: 'opponent' }]
  };
  const m2 = main.migrateSessionData(JSON.parse(JSON.stringify(v2)));
  ok('FIX 3', 'v2 explicit team preserved', m2.events[0].team === 'opponent', 'team=' + m2.events[0].team);

  // v3 passthrough: null team stays null, our stays our
  const v3 = {
    __schemaVersion: 3, videoPath: null, tags: [], squad: [], matchInfo: {}, matchClock: {},
    events: [
      { id: 1, time: 5, label: 'A', team: null },
      { id: 2, time: 6, label: 'B', team: 'our' }
    ]
  };
  const m3 = main.migrateSessionData(JSON.parse(JSON.stringify(v3)));
  ok('FIX 3', 'v3 passthrough: null team stays null', m3.events[0].team === null);
  ok('FIX 3', 'v3 passthrough: our stays our', m3.events[1].team === 'our');
  ok('FIX 3', 'v3 passthrough: no re-migration', m3.events[0].label === 'A' && m3.events.length === 2);
}

// ===========================================================================
section('FIX 5 — collision-safe player id generation (integrity.nextFreePlayerId)');

{
  const gen = integrity.nextFreePlayerId;
  ok('FIX 5', 'numeric ids: skips to first free', gen(['player_1', 'player_2'], 1).id === 'player_3');
  ok('FIX 5', 'numeric ids: respects counter', gen(['player_1', 'player_2'], 3).id === 'player_3');
  ok('FIX 5', 'non-numeric ids ignored for collision', gen(['player_abc'], 1).id === 'player_1');
  ok('FIX 5', 'mixed ids: first free numeric slot', gen(['player_1', 'player_2', 'player_abc', 'player_x9'], 1).id === 'player_3');
  ok('FIX 5', 'fills numeric gaps', gen(['player_1', 'player_3'], 1).id === 'player_2');
  ok('FIX 5', 'stale counter + externally added player_3 -> skips to 4', gen(['player_1', 'player_2', 'player_3', 'player_abc'], 3).id === 'player_4');
  ok('FIX 5', 'empty squad -> player_1', gen([], 1).id === 'player_1');

  // repeated imports: simulate adding 50 players, feeding each new id back in
  const existing = ['player_1', 'player_2', 'player_abc', 'imported_7'];
  let counter = 3, allUnique = true;
  const seen = new Set(existing);
  for (let i = 0; i < 50; i++) {
    const r = gen(Array.from(seen), counter);
    if (seen.has(r.id) || !/^player_\d+$/.test(r.id)) allUnique = false;
    seen.add(r.id);
    counter = r.next;
  }
  ok('FIX 5', 'repeated imports: 50 generated ids all unique', allUnique);
}

// ===========================================================================
section('FIX 4 — recovery missing-player detection (integrity.findMissingPlayerRefs)');

{
  const f = integrity.findMissingPlayerRefs;
  const squadIds = ['player_1', 'player_2', 'player_5'];
  const events = [
    { id: 1, playerId: 'player_1', playerOffId: null, playerOnId: null },
    { id: 2, playerId: 'player_9', playerOffId: null, playerOnId: null },        // missing
    { id: 3, playerId: null, playerOffId: 'player_10', playerOnId: 'player_2' }, // off missing
    { id: 4, playerId: 'player_2', playerOffId: null, playerOnId: null },
    { id: 5, playerId: 'player_9', playerOffId: 'player_10', playerOnId: null }  // both missing (dup ids)
  ];
  const r = f(events, squadIds);
  ok('FIX 4', 'affected events counted once each', r.affectedEvents === 3, 'affected=' + r.affectedEvents);
  ok('FIX 4', 'missing ids unique + sorted', JSON.stringify(r.missingIds) === JSON.stringify(['player_10', 'player_9']), JSON.stringify(r.missingIds));
  ok('FIX 4', 'all-known refs -> zero affected', f(events.slice(0, 1).concat(events.slice(3, 4)), squadIds).affectedEvents === 0);
  ok('FIX 4', 'null / non-string refs ignored', f([{ id: 9, playerId: null, playerOffId: undefined, playerOnId: 42 }], squadIds).affectedEvents === 0);
  ok('FIX 4', 'empty squad -> every ref missing', f([{ playerId: 'player_1' }], []).affectedEvents === 1);
  ok('FIX 4', 'non-array events tolerated', f(null, squadIds).affectedEvents === 0 && f(null, squadIds).missingIds.length === 0);
  ok('FIX 4', 'accepts a Set of squad ids', f([{ playerId: 'player_1' }], new Set(squadIds)).affectedEvents === 0);
}

// ===========================================================================
section('REG — main-process regression (squad, autosave, CSV export, session load)');

// squad save + load (atomic, unchanged behavior)
{
  const res = await handlers['squad:save'](fakeEvent, [{ id: 'player_1', number: '9', name: 'Reg Test' }, { id: 'player_abc', number: '10', name: 'Imported' }]);
  const squadPath = path.join(userDataDir, 'squad.json');
  const loaded = await handlers['squad:load'](fakeEvent);
  const data = readJson(squadPath);
  ok('REG', 'squad:save returns true', res === true);
  ok('REG', 'squad.json valid + wrapped', data.__schemaVersion >= 1 && Array.isArray(data.players) && data.players.length === 2);
  ok('REG', 'squad:load returns players array', Array.isArray(loaded) && loaded.length === 2 && loaded[1].id === 'player_abc');
  ok('REG', 'squad: no temp file left behind', !exists(squadPath + '.tmp'));
}

// autosave write + read + delete (atomic, unchanged behavior)
{
  const payload = { videoPath: null, tags: [], events: [{ id: 1, time: 5, label: 'A', playerId: 'player_1' }], squad: [], matchInfo: {}, matchClock: { scoreFor: 2 } };
  const w = await handlers['autosave:write'](fakeEvent, payload);
  const autosavePath = path.join(userDataDir, 'autosave.json');
  const read1 = await handlers['autosave:read'](fakeEvent);
  ok('REG', 'autosave:write ok', w && w.ok === true, JSON.stringify(w));
  ok('REG', 'autosave.json valid + v3', readJson(autosavePath).__schemaVersion === 3);
  ok('REG', 'autosave:read returns migrated data', read1 && read1.events.length === 1 && read1.__schemaVersion === 3);
  ok('REG', 'autosave: no temp file left behind', !exists(autosavePath + '.tmp'));
  const d = await handlers['autosave:delete'](fakeEvent);
  ok('REG', 'autosave:delete ok', d && d.ok === true);
  ok('REG', 'autosave file removed', !exists(autosavePath));
}

// autosave flush-sync (beforeunload path — sync writer untouched)
{
  const ev = { returnValue: undefined };
  listeners['autosave:flush-sync'](ev, { videoPath: null, tags: [], events: [{ id: 2, time: 7, label: 'B' }], squad: [], matchInfo: {}, matchClock: {} });
  const autosavePath = path.join(userDataDir, 'autosave.json');
  ok('REG', 'autosave:flush-sync returns ok', ev.returnValue && ev.returnValue.ok === true, JSON.stringify(ev.returnValue));
  ok('REG', 'flush-sync wrote valid JSON', readJson(autosavePath).events[0].label === 'B');
  ok('REG', 'flush-sync left no temp file', !exists(autosavePath + '.tmp'));
  // flush-null deletes
  const ev2 = { returnValue: undefined };
  listeners['autosave:flush-sync'](ev2, null);
  ok('REG', 'autosave:flush-sync(null) deletes + ok', ev2.returnValue && ev2.returnValue.ok === true && !exists(autosavePath));
}

// CSV export (unchanged behavior; still the non-atomic LOW-priority path)
{
  const dest = path.join(scratchDir, 'export.csv');
  controls.saveDialog = { canceled: false, filePath: dest };
  const res = await handlers['file:exportCsv'](fakeEvent, 'timecode,seconds\n00:00:10.0,10.0\n');
  ok('REG', 'file:exportCsv writes exact content', res.canceled === false && realFs.readFileSync(dest, 'utf-8') === 'timecode,seconds\n00:00:10.0,10.0\n');
}

// session load end-to-end (legacy v0 file -> migrated v3 + Fix 3 applied)
{
  const legacyPath = path.join(scratchDir, 'legacy-v0.json');
  const legacy = {
    videoPath: null, tags: [], matchInfo: { opponent: 'Legacy United' },
    squad: [{ id: 'player_1', number: '1', name: 'Old Keeper' }],
    events: [
      { id: 1, time: 10, label: 'Shot', side: 'for', player: { id: 'player_1', number: '1', name: 'Old Keeper' } },
      { id: 2, time: 20, label: 'Tackle', side: 'neutral' }
    ]
  };
  realFs.writeFileSync(legacyPath, JSON.stringify(legacy), 'utf-8');
  controls.openDialog = { canceled: false, filePaths: [legacyPath] };
  const data = await handlers['file:loadSession'](fakeEvent);
  ok('REG', 'loadSession: legacy file loads', !!data);
  ok('REG', 'loadSession: migrated to v3', data.__schemaVersion === 3);
  ok('REG', 'loadSession: v1->v2 player snapshot -> playerId', data.events[0].playerId === 'player_1' && !('player' in data.events[0]));
  ok('REG', 'loadSession: Fix 3 applied on load (neutral -> null)', data.events[1].team === null);
  ok('REG', 'loadSession: for -> our on load', data.events[0].team === 'our');
  ok('REG', 'loadSession: no video -> __videoExists false', data.__videoExists === false);
}

// module-level startup smoke: requiring main.js registered all handlers without throwing
{
  const expected = ['dialog:openVideo', 'file:saveSession', 'file:exportCsv', 'file:exportClipPlaylist',
    'file:loadSession', 'file:loadMultipleSessions', 'squad:load', 'squad:save',
    'autosave:read', 'autosave:write', 'autosave:delete', 'video:detach', 'video:reattach'];
  const missing = expected.filter((c) => !handlers[c]);
  ok('REG', 'startup smoke: all IPC handlers registered', missing.length === 0, 'missing: ' + missing.join(','));
}

// ===========================================================================
section('STATIC — renderer wiring (source-level checks)');

{
  const rendererSrc = realFs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf-8');
  const htmlSrc = realFs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf-8');

  // FIX 2: exactly two click listeners; standard handler bails on shiftKey;
  // shift handler only fires on shiftKey.
  const count = (rendererSrc.match(/btnExportCsv\.addEventListener\('click'/g) || []).length;
  ok('STATIC', 'FIX 2: exactly 2 click listeners on btnExportCsv', count === 2, 'count=' + count);
  ok('STATIC', 'FIX 2: standard handler takes event + early-returns on shiftKey',
    /btnExportCsv\.addEventListener\('click',\s*async\s*\(e\)\s*=>\s*\{[\s\S]{0,600}?if\s*\(e\.shiftKey\)\s*return;/.test(rendererSrc));
  ok('STATIC', 'FIX 2: full-analysis handler fires only on shiftKey',
    /btnExportCsv\.addEventListener\('click',\s*\(e\)\s*=>\s*\{\s*if\s*\(e\.shiftKey\)\s*\{\s*window\.matchtag\.exportCsv\(buildFullAnalysisCsv\(\)\);/.test(rendererSrc));
  ok('STATIC', 'FIX 2: both export modes still present', rendererSrc.includes('buildFullAnalysisCsv') && rendererSrc.includes("const header = 'timecode,seconds,end_timecode"));

  // FIX 5 wiring
  ok('STATIC', 'FIX 5: bulk add uses generatePlayerId()', rendererSrc.includes('squad.push({ id: generatePlayerId(), number, name });'));
  ok('STATIC', 'FIX 5: generatePlayerId defined via integrity module', rendererSrc.includes('window.Integrity.nextFreePlayerId'));

  // FIX 4 wiring
  const modalIdx = rendererSrc.indexOf('function showRecoveryModal');
  const recoverIdx = rendererSrc.indexOf('async function recoverFromAutosave');
  const warnIdx = rendererSrc.indexOf('not currently in your squad');
  ok('STATIC', 'FIX 4: warning string present', warnIdx > -1);
  ok('STATIC', 'FIX 4: pre-recovery check in showRecoveryModal', modalIdx > -1 && rendererSrc.indexOf('findMissingPlayerRefs', modalIdx) > -1 && rendererSrc.indexOf('findMissingPlayerRefs', modalIdx) < recoverIdx);
  ok('STATIC', 'FIX 4: post-recovery warning in recoverFromAutosave', recoverIdx > -1 && rendererSrc.indexOf('findMissingPlayerRefs', recoverIdx) > -1);
  ok('STATIC', 'FIX 4: recovery still prefers local squad (no squad overwrite)', /We use the local squad/.test(rendererSrc) && !/squad\s*=\s*autosave\.squad/.test(rendererSrc));

  // integrity.js load order
  const posIntegrity = htmlSrc.indexOf('src="integrity.js"');
  const posRenderer = htmlSrc.indexOf('src="renderer.js"');
  ok('STATIC', 'integrity.js loaded before renderer.js', posIntegrity > -1 && posRenderer > -1 && posIntegrity < posRenderer);
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
section('RESULTS');
let pass = 0, fail = 0;
const byGroup = {};
results.forEach((r) => {
  if (r.pass) pass++; else fail++;
  byGroup[r.group] = byGroup[r.group] || { pass: 0, fail: 0 };
  byGroup[r.group][r.pass ? 'pass' : 'fail']++;
});
results.forEach((r) => {
  if (!r.pass) console.log('  FAIL [' + r.group + '] ' + r.name + (r.detail ? '  (' + r.detail + ')' : ''));
});
console.log('  ' + pass + ' passed, ' + fail + ' failed');
Object.keys(byGroup).forEach((g) => {
  console.log('    ' + g + ': ' + byGroup[g].pass + ' passed / ' + byGroup[g].fail + ' failed');
});
console.log(fail === 0 ? '\nALL CHECKS PASSED' : '\nFAILURES PRESENT');
process.exit(fail === 0 ? 0 : 1);

})().catch((err) => {
  console.error('HARNESS CRASHED:', err);
  process.exit(1);
});
