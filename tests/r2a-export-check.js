#!/usr/bin/env node
// PitchLog / MatchTag — R2-A Export Hygiene regression harness (R2A series).
// =====================================================================
// Verification-only harness. It does NOT modify any app source file.
//
// Verifies the R2-A export hygiene delivery:
//   - DISTINCT DETERMINISTIC FILE NAMES for the four CSV exports
//     (match-events / match-events-full-analysis / season-events /
//     season-player), including match-metadata reuse (date + opponent),
//     Windows-invalid character sanitization, and no-metadata fallbacks
//   - UTF-8 BOM added at the MAIN-PROCESS file-write layer only
//     (byte-level: EF BB BF; payload byte-identical after it; Amharic and
//     CSV-escaped content survive unchanged; the renderer/engine strings
//     stay BOM-free)
//   - EXPORT FEEDBACK through the existing toast: success (file name +
//     row count), write failure (original error message preserved), user
//     cancel (silent, as before)
//   - EMPTY EXPORTS: explicit "nothing to export" feedback, no file, no
//     silent header-only dumps
//   - SEASON_SUMMARY: the 63-column contract stays intact, summary rows
//     keep their sentinel labeling, and the help text documents it
//
// Two parts, both behavioral:
//   PART M  main process — the REAL main.js loaded under a stubbed
//           'electron' (Module._load hook, same technique as
//           integrity-harness.js / r1-outcome-check.js) with REAL fs and
//           real scratch directories: IPC handlers invoked directly, file
//           bytes inspected, dialog options captured, failures injected
//           (write to a directory path = EISDIR; non-string payload =
//           ERR_INVALID_ARG_TYPE).
//   PART F  renderer — jsdom boots with the REAL index.html + integrity +
//           analytics + player-season + recent-form + season-csv +
//           renderer sources and a stubbed window.matchtag that captures
//           (csv, suggestedName) pairs and returns a controllable result
//           (same architecture as the other UI harnesses): export buttons
//           clicked through the real listeners, toast state asserted.
//
// HONEST SCOPE: jsdom does not render native save dialogs and the harness
// does not launch Electron — the real dialog UX (defaultPath pre-fill,
// overwrite confirmation, native error box visuals) requires manual
// Electron verification. Everything below the dialog (names, bytes, IPC
// results, toasts, guards) is verified behaviorally.
//
// Run:  node tests/r2a-export-check.js   (from the project root)
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');

const srcDir = path.join(__dirname, '..', 'src');

// ---------------------------------------------------------------------------
// Results bookkeeping
// ---------------------------------------------------------------------------
const results = [];
function ok(name, cond, detail) {
  results.push({ name, pass: !!cond, detail: detail == null ? '' : String(detail) });
  if (!cond) process.exitCode = 1;
}
function section(title) { console.log('\n===== ' + title + ' ====='); }

// ---------------------------------------------------------------------------
(async () => { // same async-IIFE pattern as the other harnesses
// ---------------------------------------------------------------------------

// ===========================================================================
// PART M — main process: file:exportCsv under a stubbed electron, real fs
// ===========================================================================
section('PART M — main process (real main.js, stubbed electron, real fs)');

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2a-userdata-'));
const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2a-scratch-'));

const controls = {
  saveDialog: { canceled: true },
  openDialog: { canceled: true, filePaths: [] },
  lastErrorBox: null,
  lastSaveDialogOptions: null
};

const electronStub = {
  app: {
    getPath: (name) => (name === 'userData' ? userDataDir : path.join(userDataDir, name)),
    whenReady: () => new Promise(() => {}), // never resolve -> no BrowserWindow
    on: () => {},
    quit: () => {},
    requestSingleInstanceLock: () => true // R2-C-1: this stub always plays the first (only) instance
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
    showSaveDialog: async (_win, options) => { controls.lastSaveDialogOptions = options; return controls.saveDialog; },
    showOpenDialog: async () => controls.openDialog,
    showErrorBox: (title, message) => { controls.lastErrorBox = { title, message }; }
  }
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronStub;
  return originalLoad.apply(this, arguments);
};
let main = null;
try {
  main = require(path.join(srcDir, 'main.js'));
} catch (e) {
  main = null;
  console.log('  main.js failed to load: ' + (e && e.message));
}
Module._load = originalLoad;

const fakeEvent = {};
const handlers = electronStub.ipcMain.handlers;
const exists = (p) => { try { fs.accessSync(p); return true; } catch (e) { return false; } };

if (!handlers['file:exportCsv']) {
  ok('M0: file:exportCsv handler registered', false, 'handler missing');
} else {
  ok('M0: file:exportCsv handler registered', true);

  // M1 — the renderer-suggested name reaches the dialog as defaultPath.
  const dest1 = path.join(scratchDir, 'm1.csv');
  controls.saveDialog = { canceled: false, filePath: dest1 };
  const CSV1 = 'timecode,seconds\n00:00:10.0,10.0\n';
  const res1 = await handlers['file:exportCsv'](fakeEvent, CSV1, 'match-events_2025-03-14_vs_Adama_Ketu.csv');
  ok('M1: suggested name becomes the dialog defaultPath',
    controls.lastSaveDialogOptions && controls.lastSaveDialogOptions.defaultPath === 'match-events_2025-03-14_vs_Adama_Ketu.csv',
    controls.lastSaveDialogOptions && controls.lastSaveDialogOptions.defaultPath);
  ok('M1b: write succeeds and reports the path',
    res1 && res1.canceled === false && res1.filePath === dest1, JSON.stringify(res1));

  // M2 — UTF-8 BOM at the byte level, payload byte-identical after it.
  const bytes1 = fs.readFileSync(dest1);
  const expected1 = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(CSV1, 'utf-8')]);
  ok('M2: file starts with the UTF-8 BOM bytes EF BB BF',
    bytes1[0] === 0xEF && bytes1[1] === 0xBB && bytes1[2] === 0xBF,
    bytes1[0] + ',' + bytes1[1] + ',' + bytes1[2]);
  ok('M2b: whole file is exactly BOM + payload (byte-identical content)',
    expected1.equals(bytes1), 'len=' + bytes1.length + ' expected=' + expected1.length);

  // M3 — legacy fallback: no name -> 'match-events.csv'.
  controls.saveDialog = { canceled: true };
  await handlers['file:exportCsv'](fakeEvent, 'x\n', undefined);
  ok('M3: no suggested name falls back to match-events.csv',
    controls.lastSaveDialogOptions && controls.lastSaveDialogOptions.defaultPath === 'match-events.csv',
    controls.lastSaveDialogOptions && controls.lastSaveDialogOptions.defaultPath);
  await handlers['file:exportCsv'](fakeEvent, 'x\n', null);
  ok('M3b: null name falls back to match-events.csv',
    controls.lastSaveDialogOptions && controls.lastSaveDialogOptions.defaultPath === 'match-events.csv',
    controls.lastSaveDialogOptions && controls.lastSaveDialogOptions.defaultPath);

  // M4 — main-side sanitization (defense in depth): path smuggle dropped,
  // Windows-invalid characters replaced.
  await handlers['file:exportCsv'](fakeEvent, 'x\n', '../../etc/evil<>:name.csv');
  ok('M4: smuggled path + invalid chars sanitized to evil_name.csv',
    controls.lastSaveDialogOptions && controls.lastSaveDialogOptions.defaultPath === 'evil_name.csv',
    controls.lastSaveDialogOptions && controls.lastSaveDialogOptions.defaultPath);

  // M5 — Amharic/non-ASCII content survives unchanged after the BOM.
  const dest5 = path.join(scratchDir, 'm5.csv');
  controls.saveDialog = { canceled: false, filePath: dest5 };
  const CSV5 = 'ቡጁ,አድማ\nጎብ,ተከታታይ\n';
  await handlers['file:exportCsv'](fakeEvent, CSV5, 'match-events.csv');
  const bytes5 = fs.readFileSync(dest5);
  const expected5 = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(CSV5, 'utf-8')]);
  ok('M5: Amharic content byte-identical after the BOM', expected5.equals(bytes5),
    'len=' + bytes5.length + ' expected=' + expected5.length);
  ok('M5b: utf-8 read-back is BOM + exact original string',
    fs.readFileSync(dest5, 'utf-8') === '\uFEFF' + CSV5);

  // M6 — CSV escaping is untouched: quoted cells with commas/quotes/newlines
  // round-trip byte-identically after the BOM.
  const dest6 = path.join(scratchDir, 'm6.csv');
  controls.saveDialog = { canceled: false, filePath: dest6 };
  const CSV6 = 'name,note\n"Doe, John","line1\nline2 ""quoted"""\n';
  await handlers['file:exportCsv'](fakeEvent, CSV6, 'match-events.csv');
  const expected6 = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(CSV6, 'utf-8')]);
  ok('M6: escaped CSV (commas/quotes/newlines in cells) byte-identical after the BOM',
    expected6.equals(fs.readFileSync(dest6)));

  // M7 — write failure: original error message preserved, error box shown,
  // error field returned (same pattern as file:saveSession).
  controls.lastErrorBox = null;
  controls.saveDialog = { canceled: false, filePath: scratchDir }; // dir path -> EISDIR
  const res7 = await handlers['file:exportCsv'](fakeEvent, 'x,y\n', 'match-events.csv');
  ok('M7: write failure returns { canceled, error } with the original message',
    res7 && res7.canceled === true && typeof res7.error === 'string' && res7.error.length > 0,
    JSON.stringify(res7).slice(0, 120));
  ok('M7b: native error box still shown (Export failed)',
    controls.lastErrorBox && controls.lastErrorBox.title === 'Export failed' &&
      String(controls.lastErrorBox.message).length > 0,
    JSON.stringify(controls.lastErrorBox || {}).slice(0, 120));

  // M8 — dialog cancel: silent { canceled: true }, no error, no file.
  controls.lastErrorBox = null;
  controls.saveDialog = { canceled: true };
  const dest8 = path.join(scratchDir, 'm8-never.csv');
  const res8 = await handlers['file:exportCsv'](fakeEvent, 'x\n', 'match-events.csv');
  ok('M8: dialog cancel returns canceled with NO error field',
    res8 && res8.canceled === true && !('error' in res8), JSON.stringify(res8));
  ok('M8b: canceled export writes no file and shows no error box',
    !exists(dest8) && controls.lastErrorBox === null);

  // M9 — non-string payload still fails like before (no silent
  // 'undefined'-content file — the BOM is only prepended to real strings).
  const dest9 = path.join(scratchDir, 'm9-never.csv');
  controls.lastErrorBox = null;
  controls.saveDialog = { canceled: false, filePath: dest9 };
  const res9 = await handlers['file:exportCsv'](fakeEvent, undefined, 'match-events.csv');
  ok('M9: non-string payload fails through the error path (no garbage file)',
    res9 && res9.canceled === true && typeof res9.error === 'string' && !exists(dest9),
    JSON.stringify(res9).slice(0, 120));

  // M10 — clip playlist (boundary moved by R2-B): the clip CSV is now
  // BOM-marked exactly like the analysis exports; the .bat stays BOM-free.
  const clipDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2a-clips-'));
  controls.openDialog = { canceled: false, filePaths: [clipDir] };
  const CLIP_CSV = 'clip,label\n1,Goal\n';
  const res10 = await handlers['file:exportClipPlaylist'](fakeEvent, { csv: CLIP_CSV, script: '@echo off\n' });
  const clipCsv = path.join(clipDir, 'clip_playlist.csv');
  const clipBat = path.join(clipDir, 'cut_clips.bat');
  ok('M10: clip playlist export still succeeds',
    res10 && res10.canceled === false && exists(clipCsv) && exists(clipBat));
  if (exists(clipCsv)) {
    const b = fs.readFileSync(clipCsv);
    const expectedClip = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(CLIP_CSV, 'utf-8')]);
    ok('M10b: clip_playlist.csv is BOM-marked with a byte-identical payload (R2-B moved the R2-A boundary)',
      b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF && expectedClip.equals(b));
    ok('M10c: cut_clips.bat stays BOM-free (cmd.exe requirement)',
      fs.readFileSync(clipBat).equals(Buffer.from('@echo off\n', 'utf-8')));
  }
}

// ===========================================================================
// PART F — renderer (jsdom): names, toasts, guards, content integrity
// ===========================================================================
section('PART F — renderer (jsdom boots with the real sources)');

const jsdomDir = process.env.JSDOM_PATH
  ? process.env.JSDOM_PATH
  : path.join(__dirname, '.jsdom-scratch', 'node_modules');
let JSDOM, VirtualConsole;
try {
  const j = require(path.join(jsdomDir, 'jsdom'));
  JSDOM = j.JSDOM;
  VirtualConsole = j.VirtualConsole;
} catch (e) {
  console.error('jsdom not found in ' + jsdomDir);
  process.exit(2);
}

const html = fs.readFileSync(path.join(srcDir, 'index.html'), 'utf-8');
const integritySrc = fs.readFileSync(path.join(srcDir, 'integrity.js'), 'utf-8');
const analyticsSrc = fs.readFileSync(path.join(srcDir, 'analytics.js'), 'utf-8');
const playerSeasonSrc = fs.readFileSync(path.join(srcDir, 'player-season.js'), 'utf-8');
const recentFormSrc = fs.readFileSync(path.join(srcDir, 'recent-form.js'), 'utf-8');
const seasonCsvSrc = fs.readFileSync(path.join(srcDir, 'season-csv.js'), 'utf-8');
const rendererSrc = fs.readFileSync(path.join(srcDir, 'renderer.js'), 'utf-8');

const fcontrols = {
  exportResult: { canceled: true },
  loadMultiple: [],
  autosave: null,
  squad: null
};

function makeStub(calls) {
  return {
    openVideo: async () => null,
    saveSession: async (d) => { calls.saveSession.push(d); return { canceled: true }; },
    exportCsv: async (csv, name) => { calls.exportCsv.push({ csv: String(csv), name: name === undefined ? null : name }); return fcontrols.exportResult; },
    exportClipPlaylist: async () => ({ canceled: true }),
    loadSession: async () => null,
    loadMultipleSessions: async () => { calls.loadMultiple += 1; return fcontrols.loadMultiple; },
    loadSquad: async () => fcontrols.squad,
    saveSquad: async () => ({ ok: true }),
    detachVideo: async () => ({}),
    reattachVideo: async () => ({}),
    sendVideoCommand: () => {},
    onVideoState: () => {},
    onVideoClosed: () => {},
    autosaveRead: async () => fcontrols.autosave,
    autosaveWrite: async () => ({ ok: true }),
    autosaveDelete: async () => ({ ok: true }),
    autosaveFlushSync: () => ({ ok: true }),
    onCloseRequested: () => {},
    closeProceed: () => {}
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function boot() {
  const calls = { exportCsv: [], saveSession: [], loadMultiple: 0 };
  const vc = new VirtualConsole(); // silence jsdom's console noise
  vc.on('jsdomError', () => {});
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'file://' + path.join(srcDir, 'index.html'), virtualConsole: vc });
  const win = dom.window;
  win.matchtag = makeStub(calls);
  win.eval(integritySrc);
  win.eval(analyticsSrc);
  win.eval(playerSeasonSrc);
  win.eval(recentFormSrc);
  win.eval(seasonCsvSrc);
  win.eval(rendererSrc);
  await sleep(300); // boot: loadSquad().finally -> checkForRecoverableAutosave()
  return { dom, win, doc: win.document, calls };
}

function click(win, el, opts) {
  if (!el) return;
  el.dispatchEvent(new win.MouseEvent('click', Object.assign({ bubbles: true, cancelable: true }, opts || {})));
}
function tagBtn(doc, label) {
  return Array.from(doc.querySelectorAll('#tagButtons .tag-btn')).find((b) => b.textContent.replace('⏱', '').trim().startsWith(label));
}
function toastState(doc) {
  const t = doc.getElementById('autosaveToast');
  const tx = doc.getElementById('autosaveToastText');
  return { shown: !!t && t.style.display === 'flex', text: tx ? tx.textContent : '' };
}
function dismissToast(win, doc) {
  click(win, doc.getElementById('autosaveToastClose'));
}

// Season fixture: 2 matches, 2 shared players, 5 events total.
function feEvent(id, time, label, team, playerId, period) {
  return {
    id, time, videoTime: null, matchTime: time, matchSeconds: time,
    officialMinute: null, second: null, period: period || '1H', label,
    subtype: null, qualifiers: {}, location: null,
    playerId: playerId || null, playerOffId: null, playerOnId: null,
    side: team === 'our' ? 'for' : 'against', team,
    sequenceId: null, scoreForBefore: 0, scoreAgainstBefore: 0,
    scoreForAfter: null, scoreAgainstAfter: null,
    isInterval: false, startTime: null, endTime: null, outcome: null
  };
}
function feSquad() {
  return [
    { id: 'p1', number: '10', name: 'Abebe Bikila' },
    { id: 'p2', number: '9', name: 'አዲስ ተጋዳዳይ' }
  ];
}
function feSession(n, date, events) {
  const squad = feSquad();
  return {
    sourceFile: '/r2a-f' + n + '.json',
    __savedAt: '2026-09-' + String(n).padStart(2, '0') + 'T20:00:00Z',
    __schemaVersion: 4,
    videoPath: null, videoUrl: null,
    tags: [],
    events,
    squad,
    matchInfo: {
      competition: 'League', date, opponent: 'Opponent ' + n, venue: 'V',
      homeAway: 'home', ourScore: '1', opponentScore: '0', formation: '4-3-3',
      startingXI: squad.map((p, i) => ({ position: 'P' + i, playerId: p.id }))
    },
    matchClock: {
      clockStartedAt: null, clockBaseSeconds: 5400, clockRunning: false,
      period: 'FT', scoreFor: 1, scoreAgainst: 0, videoSyncOffset: 0,
      selectedTeam: 'our', selectedPlayerId: null, activeSequenceId: null, nextSequenceNumber: 1
    }
  };
}

// Quote-aware single-line CSV parser (same technique as season-csv-check).
function parseCsvLine(line) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += ch;
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out;
}

const STD_HEADER = 'timecode,seconds,end_timecode,end_seconds,duration_seconds,label,side,player_number,player_name,player_off_number,player_off_name,player_on_number,player_on_name,subtype,qualifiers,location_zone,location_x,location_y,outcome';

// ---------------------------------------------------------------------------
console.log('\n== Boot V1 — empty guards, match metadata names, toasts ==');
{
  const B = await boot();
  const { win, doc, calls } = B;
  const btnExport = doc.getElementById('btnExportCsv');

  // F1/F2 — empty exports get explicit feedback, never a header-only file.
  dismissToast(win, doc);
  click(win, btnExport);
  await sleep(120);
  let st = toastState(doc);
  ok('F1: standard export with 0 events -> NO exportCsv call + "nothing to export" toast',
    calls.exportCsv.length === 0 && st.shown && /nothing to export/i.test(st.text) && /no tagged events/i.test(st.text),
    'calls=' + calls.exportCsv.length + ' toast="' + st.text + '"');

  dismissToast(win, doc);
  click(win, btnExport, { shiftKey: true });
  await sleep(120);
  st = toastState(doc);
  ok('F2: full-analysis export with 0 events -> NO exportCsv call + "nothing to export" toast',
    calls.exportCsv.length === 0 && st.shown && /nothing to export/i.test(st.text),
    'calls=' + calls.exportCsv.length + ' toast="' + st.text + '"');

  // F3 — match metadata (date + opponent) builds the deterministic name.
  doc.getElementById('matchDate').value = '2025-03-14';
  doc.getElementById('matchOpponent').value = 'Adama Ketu';
  click(win, doc.getElementById('btnSaveMatchSetup'));
  await sleep(60);

  click(win, tagBtn(doc, 'Shot'));
  await sleep(60);
  click(win, doc.getElementById('detailPanelDone'));
  await sleep(60);
  click(win, tagBtn(doc, 'Pass'));
  await sleep(60);
  click(win, doc.getElementById('detailPanelDone'));
  await sleep(60);

  fcontrols.exportResult = { canceled: true }; // user cancel: silent
  dismissToast(win, doc);
  click(win, btnExport);
  await sleep(150);
  ok('F3: standard export suggests match-events_<date>_vs_<opponent>.csv',
    calls.exportCsv.length === 1 && calls.exportCsv[0].name === 'match-events_2025-03-14_vs_Adama Ketu.csv',
    'name=' + (calls.exportCsv[0] && JSON.stringify(calls.exportCsv[0].name)));
  ok('F3b: CSV string is the untouched standard 19-column export (BOM never enters the string)',
    calls.exportCsv[0] && calls.exportCsv[0].csv.startsWith(STD_HEADER) &&
      calls.exportCsv[0].csv.charCodeAt(0) !== 0xFEFF,
    'first=' + (calls.exportCsv[0] ? calls.exportCsv[0].csv.slice(0, 40) : 'n/a'));
  ok('F3c: user cancel stays silent (no toast)',
    !toastState(doc).shown, 'toast shown unexpectedly');

  // F4 — full-analysis differs from standard.
  click(win, btnExport, { shiftKey: true });
  await sleep(150);
  ok('F4: full-analysis export suggests a DIFFERENT name than standard',
    calls.exportCsv.length === 2 &&
      calls.exportCsv[1].name === 'match-events-full-analysis_2025-03-14_vs_Adama Ketu.csv' &&
      calls.exportCsv[1].name !== calls.exportCsv[0].name,
    'name=' + (calls.exportCsv[1] && JSON.stringify(calls.exportCsv[1].name)));
  ok('F4b: full-analysis CSV header/order unchanged (36 columns)',
    calls.exportCsv[1] && calls.exportCsv[1].csv.split('\n')[0].split(',').length === 36 &&
      calls.exportCsv[1].csv.startsWith('Match ID,Date,Competition,Home Team,Away Team,Opponent,'),
    'cols=' + (calls.exportCsv[1] ? calls.exportCsv[1].csv.split('\n')[0].split(',').length : 'n/a'));

  // F5 — success toast: file name + row count, through the EXISTING toast.
  fcontrols.exportResult = { canceled: false, filePath: '/tmp/exports/match-events_2025-03-14_vs_Adama Ketu.csv' };
  click(win, btnExport);
  await sleep(150);
  st = toastState(doc);
  ok('F5: success toast (existing mechanism) carries the saved file name and the row count',
    st.shown && /Exported match-events_2025-03-14_vs_Adama Ketu\.csv/.test(st.text) && /2 rows/.test(st.text),
    'toast="' + st.text + '"');

  // F7 — write failure toast preserves the original error message.
  fcontrols.exportResult = { canceled: true, error: "EACCES: permission denied, open '/data/x.csv'" };
  dismissToast(win, doc);
  click(win, btnExport);
  await sleep(150);
  st = toastState(doc);
  ok('F7: failure toast reports the export failure with the original error',
    st.shown && /Export failed/i.test(st.text) && /EACCES/.test(st.text),
    'toast="' + st.text + '"');

  // F11 — Windows-invalid characters in metadata are sanitized.
  doc.getElementById('matchOpponent').value = 'Bad<>:"/\\|?*Name';
  click(win, doc.getElementById('btnSaveMatchSetup'));
  await sleep(60);
  click(win, btnExport);
  await sleep(150);
  ok('F11: invalid Windows filename characters sanitized (Bad<>:"/\\|?*Name -> Bad_Name)',
    calls.exportCsv.length === 5 && calls.exportCsv[4].name === 'match-events_2025-03-14_vs_Bad_Name.csv',
    'name=' + (calls.exportCsv[4] && JSON.stringify(calls.exportCsv[4].name)));

  // F12 — Amharic (non-ASCII) opponent survives in the file name.
  doc.getElementById('matchOpponent').value = 'አድማ ከተማ';
  click(win, doc.getElementById('btnSaveMatchSetup'));
  await sleep(60);
  click(win, btnExport);
  await sleep(150);
  ok('F12: Amharic opponent preserved in the suggested file name',
    calls.exportCsv.length === 6 && calls.exportCsv[5].name === 'match-events_2025-03-14_vs_አድማ ከተማ.csv',
    'name=' + (calls.exportCsv[5] && JSON.stringify(calls.exportCsv[5].name)));

  // F8 — season exports: distinct plain names + row counts + content pins.
  fcontrols.loadMultiple = [
    feSession(1, '2026-08-01', [feEvent(1, 60, 'Recovery', 'our', 'p1'), feEvent(2, 120, 'Pass', 'our', 'p2')]),
    feSession(2, '2026-08-08', [feEvent(3, 600, 'Shot', 'our', 'p2'), feEvent(4, 900, 'Pass', 'our', 'p1'), feEvent(5, 1800, 'Goal', 'our', 'p1', '2H')])
  ];
  click(win, doc.getElementById('btnAddSeasonMatches'));
  await sleep(300);
  fcontrols.exportResult = { canceled: false, filePath: '/tmp/exports/season-events.csv' };
  click(win, doc.getElementById('btnExportSeasonCsv'));
  await sleep(200);
  ok('F8: season event export suggests season-events.csv and keeps the legacy dump content',
    calls.exportCsv.length === 7 && calls.exportCsv[6].name === 'season-events.csv' &&
      calls.exportCsv[6].csv.startsWith('match,timecode,seconds,'),
    'name=' + (calls.exportCsv[6] && JSON.stringify(calls.exportCsv[6].name)));
  st = toastState(doc);
  ok('F8b: season event success toast carries the 5-row count',
    st.shown && /Exported season-events\.csv/.test(st.text) && /5 rows/.test(st.text),
    'toast="' + st.text + '"');

  // F9 — season player export: name, 63-column contract, SEASON_SUMMARY.
  fcontrols.exportResult = { canceled: false, filePath: '/tmp/exports/season-player.csv' };
  click(win, doc.getElementById('btnExportSeasonPlayerCsv'));
  await sleep(300);
  ok('F9: season player export suggests season-player.csv',
    calls.exportCsv.length === 8 && calls.exportCsv[7].name === 'season-player.csv',
    'name=' + (calls.exportCsv[7] && JSON.stringify(calls.exportCsv[7].name)));
  const sp = calls.exportCsv[7] ? calls.exportCsv[7].csv : '';
  const spLines = sp ? sp.split('\n') : [];
  const spHeaderCells = spLines[0] ? parseCsvLine(spLines[0]) : [];
  const SC = win.SeasonCsvEngine;
  ok('F9b: header is the exact PSD-V2 63-column list (contract intact)',
    spHeaderCells.length === 63 && SC && spLines[0] === SC.COLUMNS.join(','),
    'cols=' + spHeaderCells.length);
  const spData = spLines.slice(1);
  ok('F9c: 6 data rows (4 player×match + 2 SEASON_SUMMARY), every row 63 cells',
    spData.length === 6 && spData.every((l) => parseCsvLine(l).length === 63),
    'rows=' + spData.length);
  const summaryRows = spData.filter((l) => parseCsvLine(l)[0] === 'SEASON_SUMMARY');
  ok('F9d: SEASON_SUMMARY rows still carry both sentinels (match_key + participation_status)',
    summaryRows.length === 2 && summaryRows.every((l) => {
      const c = parseCsvLine(l);
      return c[0] === 'SEASON_SUMMARY' && c[10] === 'SEASON_SUMMARY';
    }));
  ok('F9e: the engine string itself stays BOM-free (BOM lives only at file-write)',
    sp.charCodeAt(0) !== 0xFEFF);
  st = toastState(doc);
  ok('F9f: season player success toast carries the 6-row count (records + summaries)',
    st.shown && /Exported season-player\.csv/.test(st.text) && /6 rows/.test(st.text),
    'toast="' + st.text + '"');

  // F10 — all four suggested names pairwise distinct.
  const names = [
    calls.exportCsv[0].name, calls.exportCsv[1].name,
    calls.exportCsv[6].name, calls.exportCsv[7].name
  ];
  ok('F10: all four export kinds suggest pairwise-distinct file names',
    new Set(names).size === 4, JSON.stringify(names));
}

// ---------------------------------------------------------------------------
console.log('\n== Boot V2 — fallback names, 1-row toast, empty season guards ==');
{
  const B = await boot();
  const { win, doc, calls } = B;
  const btnExport = doc.getElementById('btnExportCsv');

  // F13 — no match metadata -> legacy fallback names.
  click(win, tagBtn(doc, 'Shot'));
  await sleep(60);
  click(win, doc.getElementById('detailPanelDone'));
  await sleep(60);

  fcontrols.exportResult = { canceled: true };
  click(win, btnExport);
  await sleep(150);
  ok('F13: no metadata -> standard name falls back to match-events.csv',
    calls.exportCsv.length === 1 && calls.exportCsv[0].name === 'match-events.csv',
    'name=' + (calls.exportCsv[0] && JSON.stringify(calls.exportCsv[0].name)));
  click(win, btnExport, { shiftKey: true });
  await sleep(150);
  ok('F13b: no metadata -> full-analysis falls back to match-events-full-analysis.csv',
    calls.exportCsv.length === 2 && calls.exportCsv[1].name === 'match-events-full-analysis.csv' &&
      calls.exportCsv[1].name !== calls.exportCsv[0].name,
    'name=' + (calls.exportCsv[1] && JSON.stringify(calls.exportCsv[1].name)));

  // F6 — singular row count wording.
  fcontrols.exportResult = { canceled: false, filePath: '/tmp/exports/match-events.csv' };
  click(win, btnExport);
  await sleep(150);
  const st = toastState(doc);
  ok('F6: 1 event -> toast says "1 row" (singular)',
    st.shown && /Exported match-events\.csv/.test(st.text) && /1 row\b/.test(st.text) && !/1 rows/.test(st.text),
    'toast="' + st.text + '"');

  // F14 — season exports with nothing loaded: explicit feedback, no file.
  dismissToast(win, doc);
  click(win, doc.getElementById('btnExportSeasonCsv'));
  await sleep(150);
  let st2 = toastState(doc);
  ok('F14: season event export with no season matches -> no call + explicit toast',
    calls.exportCsv.length === 3 && st2.shown && /nothing to export/i.test(st2.text) && /no season matches/i.test(st2.text),
    'calls=' + calls.exportCsv.length + ' toast="' + st2.text + '"');

  dismissToast(win, doc);
  click(win, doc.getElementById('btnExportSeasonPlayerCsv'));
  await sleep(150);
  st2 = toastState(doc);
  ok('F14b: season player export with no season matches -> no call + explicit toast',
    calls.exportCsv.length === 3 && st2.shown && /nothing to export/i.test(st2.text) && /no season matches/i.test(st2.text),
    'calls=' + calls.exportCsv.length + ' toast="' + st2.text + '"');
}

// ---------------------------------------------------------------------------
console.log('\n== STATIC — help text + boundary pins ==');
{
  const htmlSrc = fs.readFileSync(path.join(srcDir, 'index.html'), 'utf-8');
  ok('S1: season player button help text documents the SEASON_SUMMARY labeling',
    /btnExportSeasonPlayerCsv[\s\S]{0,700}?title="[^"]*SEASON_SUMMARY[^"]*"/.test(htmlSrc) &&
      /match_key and participation_status/.test(htmlSrc),
    'title attribute with SEASON_SUMMARY documentation');
  ok('S2: both season export buttons document their suggested file names',
    /season-events\.csv/.test(htmlSrc) && /season-player\.csv/.test(htmlSrc));
  const mainSrc = fs.readFileSync(path.join(srcDir, 'main.js'), 'utf-8');
  // R2-B moved the boundary: the clip-CSV write is the second sanctioned
  // BOM site; the .bat write must never get one.
  ok('S3: BOM prepends exist at exactly the two sanctioned write sites (exportCsv + clip CSV; never the .bat)',
    /'\\ufeff'\s*\+\s*csvString/.test(mainSrc) &&
      /'\\ufeff'\s*\+\s*csv\b/.test(mainSrc) &&
      (mainSrc.match(/'\\ufeff'/g) || []).length === 2 &&
      !/'\\ufeff'\s*\+\s*script/.test(mainSrc),
    'two BOM prepends: file:exportCsv + clip_playlist.csv');
}

// ---------------------------------------------------------------------------
console.log('\n===== RESULTS =====');
let pass = 0, fail = 0;
results.forEach((r) => {
  if (r.pass) pass++;
  else { fail++; console.log('  ✗ ' + r.name + (r.detail ? '  (' + r.detail + ')' : '')); }
});
console.log('---- r2a export check: ' + pass + ' passed, ' + fail + ' failed ----');
console.log('NOTE: the native save-dialog UX (defaultPath pre-fill, overwrite prompt,');
console.log('error-box visuals) and real BOM handling in a packaged app require manual');
console.log('Electron verification; everything below the dialog is verified here.');
process.exit(fail === 0 ? 0 : 1);
})().catch((err) => { console.error('R2A HARNESS CRASHED:', err); process.exit(1); });
