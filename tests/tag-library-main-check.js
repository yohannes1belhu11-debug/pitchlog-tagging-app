#!/usr/bin/env node
// PitchLog / MatchTag — R2-E Phase 3: persistent tag library, MAIN-PROCESS
// harness (tags.json store).
// ============================================================================
// Verification-only harness. It does NOT modify any app source file.
//
// Loads the REAL src/main.js into plain Node with a stubbed 'electron'
// module (Module._load hook — same architecture as integrity-harness.js),
// so no Electron GUI is launched, and drives the captured IPC handlers:
//
//   STORE     tags:save writes { __schemaVersion: 1, __savedAt, tags } to
//             userData/tags.json ATOMICALLY (temp + rename, no tmp left
//             behind) and returns { ok: true, path }.
//   LOAD      tags:load round-trips the saved library (tag objects keep
//             color/size/mods/active/substitution/interval shapes); a
//             MISSING file returns null and creates nothing.
//   MIGRATE   migrateTagLibraryData: v1 passthrough, bare-array wrap,
//             versionless wrapper tolerance; newer version / non-array
//             tags / non-object → throw (reported as corrupt by the
//             handler).
//   CORRUPT   a truncated/invalid tags.json returns { corrupt: true, path },
//             the unreadable bytes are PRESERVED as tags.json.corrupt
//             (single generation), and a subsequent tags:save writes a
//             fresh library successfully.
//   FAILURE   tags:save write failure returns { ok: false, error } with
//             the previous file UNCHANGED; rename failure cleans the temp
//             file. (writeFileAtomic contract — same as session saves.)
//   QUEUE     two rapid tags:save calls serialize: both return ok, the
//             final file holds the LAST payload, no tmp residue.
//   GUARD     session schema stays v4; the tag library version is a
//             SEPARATE constant (1); module.exports exposes the new
//             migration for this harness.
//
// Run:  node tests/tag-library-main-check.js   (from the project root)
'use strict';

(async () => {

const path = require('path');
const os = require('os');
const Module = require('module');
const realFs = require('fs'); // real fs — captured BEFORE the hook is installed

// ---------------------------------------------------------------------------
// Test bookkeeping
// ---------------------------------------------------------------------------
const results = [];
function ok(name, cond, detail) {
  results.push({ name, pass: !!cond, detail: detail || '' });
  console.log((cond ? '[PASS] ' : '[FAIL] ') + name + (detail ? '  | ' + detail : ''));
  if (!cond) process.exitCode = 1;
}
function section(title) {
  console.log('\n== ' + title + ' ==');
}

// ---------------------------------------------------------------------------
// Stub 'electron' + failure-injectable 'fs' (integrity-harness pattern)
// ---------------------------------------------------------------------------
const userDataDir = realFs.mkdtempSync(path.join(os.tmpdir(), 'pitchlog-taglib-'));

const controls = {
  failWritePaths: new Set(),   // absolute paths where writeFile must fail
  failRenamePaths: new Set()   // absolute destinations where rename must fail
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
    showSaveDialog: async () => ({ canceled: true }),
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showErrorBox: () => {}
  }
};

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

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronStub;
  if (request === 'fs') return fsProxy;
  return originalLoad.apply(this, arguments);
};
const main = require(path.join(__dirname, '..', 'src', 'main.js'));
const handlers = electronStub.ipcMain.handlers;

const fakeEvent = {};
function readJson(p) { return JSON.parse(realFs.readFileSync(p, 'utf-8')); }
function exists(p) { try { realFs.accessSync(p); return true; } catch (e) { return false; } }

const TAGS_JSON = path.join(userDataDir, 'tags.json');
const TAGS_TMP = path.join(userDataDir, 'tags.json.tmp');
const TAGS_CORRUPT = path.join(userDataDir, 'tags.json.corrupt');

const LIBRARY = [
  { label: 'Goal', key: '1', qualifierGroups: [{ name: 'Body part', options: ['Left foot', 'Right foot', 'Head', 'Other'] }] },
  { label: 'Sub', key: '7', substitution: true },
  { label: 'Possession', key: '8', interval: true, qualifierGroups: [{ name: 'Ended by', options: ['Shot', 'Turnover'] }] },
  { label: 'Corner', key: '6', color: '#ff8800', size: 'l' },
  { label: 'Tackle', key: 'q', mods: ['ctrl'], color: '#00aa55', size: 's' },
  { label: 'Card', key: '5', subtypes: ['Yellow', 'Red'], active: false }
];

console.log('tag-library main harness — userData dir: ' + userDataDir);
console.log('main.js loaded; tags handlers: ' +
  ['tags:load', 'tags:save'].filter((c) => typeof handlers[c] === 'function').join(', '));

// ===========================================================================
section('TL-M1 — missing library: tags:load returns null, creates nothing');
{
  const res = await handlers['tags:load'](fakeEvent);
  ok('TL-M1a: returns null when tags.json does not exist', res === null, JSON.stringify(res));
  ok('TL-M1b: no tags.json created by the read', !exists(TAGS_JSON));
  ok('TL-M1c: no temp/corrupt files created by the read', !exists(TAGS_TMP) && !exists(TAGS_CORRUPT));
}

// ===========================================================================
section('TL-M2 — tags:save writes the v1 wrapper atomically');
{
  const res = await handlers['tags:save'](fakeEvent, LIBRARY);
  ok('TL-M2a: returns { ok: true, path }', !!(res && res.ok === true && res.path === TAGS_JSON), JSON.stringify(res));
  const data = exists(TAGS_JSON) ? readJson(TAGS_JSON) : null;
  ok('TL-M2b: file written and parseable', !!data);
  ok('TL-M2c: wrapper carries __schemaVersion 1 (SEPARATE from session v4)',
    data && data.__schemaVersion === 1);
  ok('TL-M2d: __savedAt ISO timestamp present', data && typeof data.__savedAt === 'string' && !isNaN(Date.parse(data.__savedAt)));
  ok('TL-M2e: tags array intact (6 entries, byte-shape preserved)',
    data && Array.isArray(data.tags) && data.tags.length === 6 &&
    JSON.stringify(data.tags) === JSON.stringify(LIBRARY));
  ok('TL-M2f: no temp file left behind', !exists(TAGS_TMP));
}

// ===========================================================================
section('TL-M3 — tags:load round-trips the saved library');
{
  const res = await handlers['tags:load'](fakeEvent);
  ok('TL-M3a: returns { tags } shape', !!(res && Array.isArray(res.tags)));
  ok('TL-M3b: every tag round-trips exactly (color/size/mods/active/substitution/interval)',
    res && JSON.stringify(res.tags) === JSON.stringify(LIBRARY));
  ok('TL-M3c: substitution flag survives (built-in-only behavior carrier)',
    res && res.tags.some((t) => t.label === 'Sub' && t.substitution === true));
  ok('TL-M3d: soft-delete flag survives (active:false)',
    res && res.tags.some((t) => t.label === 'Card' && t.active === false));
  ok('TL-M3e: shortcut mods survive untouched (no silent mutation)',
    res && res.tags.some((t) => t.label === 'Tackle' && JSON.stringify(t.mods) === JSON.stringify(['ctrl'])));
}

// ===========================================================================
section('TL-M4 — corrupt library: corrupt marker, bytes preserved as .corrupt, next save works');
{
  // Truncated JSON — exactly what a mid-write kill would leave behind
  // (defensively: the atomic write should prevent it, but the read path
  // must still cope — same defense posture as autosave:read R2-C-3).
  const corruptBytes = '{"__schemaVersion":1,"__savedAt":"2025-01-01T00:00:00.000Z","tags":[{"label":"Go';
  realFs.writeFileSync(TAGS_JSON, corruptBytes, 'utf-8');
  const res = await handlers['tags:load'](fakeEvent);
  ok('TL-M4a: returns { corrupt: true, path }', !!(res && res.corrupt === true && res.path === TAGS_JSON), JSON.stringify(res));
  ok('TL-M4b: unreadable bytes PRESERVED as tags.json.corrupt (not deleted)',
    exists(TAGS_CORRUPT) && realFs.readFileSync(TAGS_CORRUPT, 'utf-8') === corruptBytes);
  ok('TL-M4c: tags.json itself is gone (unblocked for a fresh write)', !exists(TAGS_JSON));
  // The next save writes a fresh library over the cleared path.
  const saveRes = await handlers['tags:save'](fakeEvent, [{ label: 'Goal', key: '1' }]);
  ok('TL-M4d: a subsequent tags:save succeeds after corruption', !!(saveRes && saveRes.ok === true));
  ok('TL-M4e: the .corrupt copy is still there (single generation, not clobbered by the save)',
    exists(TAGS_CORRUPT) && realFs.readFileSync(TAGS_CORRUPT, 'utf-8') === corruptBytes);
  // Single generation: a SECOND corruption event replaces the old .corrupt.
  realFs.unlinkSync(TAGS_JSON);
  realFs.writeFileSync(TAGS_JSON, 'also-corrupt{{{', 'utf-8');
  const res2 = await handlers['tags:load'](fakeEvent);
  ok('TL-M4f: second corrupt read also reports corrupt', !!(res2 && res2.corrupt === true));
  ok('TL-M4g: .corrupt is SINGLE GENERATION (replaced by the newest bad bytes)',
    exists(TAGS_CORRUPT) && realFs.readFileSync(TAGS_CORRUPT, 'utf-8') === 'also-corrupt{{{');
}

// ===========================================================================
section('TL-M5 — migrateTagLibraryData: shapes, tolerance, and rejection');
{
  const m = main;
  ok('TL-M5a: module.exports exposes migrateTagLibraryData + TAG_LIBRARY_SCHEMA_VERSION',
    typeof m.migrateTagLibraryData === 'function' && m.TAG_LIBRARY_SCHEMA_VERSION === 1);
  ok('TL-M5b: v1 wrapper passes through unchanged',
    JSON.stringify(m.migrateTagLibraryData({ __schemaVersion: 1, tags: [{ label: 'X' }] })) ===
    JSON.stringify({ __schemaVersion: 1, tags: [{ label: 'X' }] }));
  ok('TL-M5c: bare array (hand-edited file) wraps to v1',
    JSON.stringify(m.migrateTagLibraryData([{ label: 'Y' }])) ===
    JSON.stringify({ __schemaVersion: 1, tags: [{ label: 'Y' }] }));
  ok('TL-M5d: versionless wrapper { tags } tolerated',
    m.migrateTagLibraryData({ tags: [] }).__schemaVersion === 1);
  let threw = 0;
  try { m.migrateTagLibraryData({ __schemaVersion: 99, tags: [] }); } catch (e) { threw++; }
  try { m.migrateTagLibraryData({ __schemaVersion: 1, tags: 'nope' }); } catch (e) { threw++; }
  try { m.migrateTagLibraryData('garbage'); } catch (e) { threw++; }
  try { m.migrateTagLibraryData(null); } catch (e) { threw++; }
  ok('TL-M5e: newer version / non-array tags / non-object / null all throw (→ corrupt)', threw === 4);
  ok('TL-M5f: session schema version is STILL 4 (v4 preserved)', m.CURRENT_SCHEMA_VERSION === 4);
}

// ===========================================================================
section('TL-M6 — tags:load with hand-edited bare-array file (migration on read)');
{
  realFs.writeFileSync(TAGS_JSON, JSON.stringify([{ label: 'Goal', key: '1' }, { label: 'Custom', key: '' }]), 'utf-8');
  const res = await handlers['tags:load'](fakeEvent);
  ok('TL-M6a: bare-array file loads as { tags } (v0 tolerance)', !!(res && Array.isArray(res.tags) && res.tags.length === 2));
  ok('TL-M6b: entries pass through untouched', res && res.tags[1].label === 'Custom' && res.tags[1].key === '');
}

// ===========================================================================
section('TL-M7 — tags:save failure modes leave the previous library intact');
{
  // 7a. temp write failure
  const before = realFs.readFileSync(TAGS_JSON, 'utf-8');
  controls.failWritePaths.add(path.resolve(TAGS_TMP));
  const resW = await handlers['tags:save'](fakeEvent, [{ label: 'New' }]);
  controls.failWritePaths.clear();
  ok('TL-M7a1: write failure returns { ok: false, error }', !!(resW && resW.ok === false && typeof resW.error === 'string'), JSON.stringify(resW));
  ok('TL-M7a2: previous library UNCHANGED', realFs.readFileSync(TAGS_JSON, 'utf-8') === before);
  ok('TL-M7a3: no temp file residue', !exists(TAGS_TMP));

  // 7b. rename failure (writeFileAtomic contract: destination untouched, temp cleaned)
  controls.failRenamePaths.add(path.resolve(TAGS_JSON));
  const resR = await handlers['tags:save'](fakeEvent, [{ label: 'New' }]);
  controls.failRenamePaths.clear();
  ok('TL-M7b1: rename failure returns { ok: false, error }', !!(resR && resR.ok === false && typeof resR.error === 'string'));
  ok('TL-M7b2: previous library UNCHANGED', realFs.readFileSync(TAGS_JSON, 'utf-8') === before);
  ok('TL-M7b3: temp file CLEANED UP', !exists(TAGS_TMP));

  // 7c. non-array payload coerces to [] rather than crashing (defensive)
  const resN = await handlers['tags:save'](fakeEvent, 'not-an-array');
  ok('TL-M7c: non-array payload coerces to an empty tags array (no crash)',
    !!(resN && resN.ok === true) && readJson(TAGS_JSON).tags.length === 0);
}

// ===========================================================================
section('TL-M8 — write queue: rapid successive saves serialize cleanly');
{
  const payloadA = [{ label: 'A', key: '1' }];
  const payloadB = [{ label: 'B', key: '2' }, { label: 'C', key: '3' }];
  const [resA, resB] = await Promise.all([
    handlers['tags:save'](fakeEvent, payloadA),
    handlers['tags:save'](fakeEvent, payloadB)
  ]);
  ok('TL-M8a: both queued saves report ok', !!(resA && resA.ok && resB && resB.ok),
    JSON.stringify([resA && resA.ok, resB && resB.ok]));
  const data = readJson(TAGS_JSON);
  ok('TL-M8b: final file holds the LAST save\'s payload (arrival order)',
    data.tags.length === 2 && data.tags[0].label === 'B' && data.tags[1].label === 'C');
  ok('TL-M8c: no temp file residue after the queue drains', !exists(TAGS_TMP));
}

// ---------------------------------------------------------------------------
const pass = results.filter((r) => r.pass).length;
const fail = results.length - pass;
console.log('\n---- tag-library main check: ' + pass + ' passed, ' + fail + ' failed ----');
process.exit(fail ? 1 : 0);

})().catch((err) => {
  console.error('tag-library main check: harness crashed:', err);
  process.exit(1);
});
