#!/usr/bin/env node
// PitchLog / MatchTag — R2-B Data Quality & Analysis Readiness harness.
// =====================================================================
// Verification-only harness. It does NOT modify any app source file.
//
// Verifies the R2-B delivery:
//   - SEASON-EVENTS PLAYER ATTRIBUTION FIX: player references in the
//     multi-match event dump resolve against EACH match's own squad
//     (m.squad), not the live session squad — same-id-different-squad
//     matches get their own names/numbers, the live squad never leaks in,
//     unresolved ids stay empty cells, and the standard (single-match)
//     export keeps live-squad resolution.
//   - CLIP PLAYLIST BOM (R2-A deferred item closed): clip_playlist.csv is
//     written UTF-8 with BOM at the main-process write layer only, payload
//     byte-identical; the companion cut_clips.bat stays STRICTLY BOM-free.
//   - CLIP EXPORT EMPTY GUARDS (R2-A deferred item closed): explicit
//     "nothing to export" toasts for no-video and no-events, modal stays
//     closed, no IPC call.
//   - DATA DICTIONARY CONTRACT: docs/export-data-dictionary.md's five
//     machine-readable schema blocks match the REAL export headers
//     captured through the real UI flows (the dictionary cannot drift).
//   - CELL-LEVEL QUALITY: no NaN/undefined/null-string cells, no ragged
//     rows, ISO dates, deterministic match labels, Amharic round-trips.
//
// Three parts, all behavioral:
//   PART M  main process — the REAL main.js under a stubbed 'electron'
//           (Module._load hook, same technique as r2a-export-check.js)
//           with REAL fs and real scratch dirs: the clip-playlist IPC
//           handler invoked directly, file bytes inspected, failures
//           injected (parent path is a file = ENOTDIR; non-string csv =
//           ERR_INVALID_ARG_TYPE).
//   PART F  renderer — jsdom boots with the REAL sources and a stubbed
//           window.matchtag that captures exportCsv / exportClipPlaylist
//           calls; export buttons clicked through the real listeners.
//   STATIC  source-level pins: the season block uses the scoped resolver,
//           the standard block keeps the live resolver, exactly two BOM
//           prepend sites in main.js, docs updated truthfully.
//
// HONEST SCOPE: jsdom does not render native save/open dialogs and this
// harness does not launch Electron — the real dialog UX still requires
// manual Electron verification. Everything below the dialog (bytes, IPC
// results, toasts, guards, CSV content) is verified behaviorally.
//
// Run:  node tests/r2b-data-quality-check.js   (from the project root)
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');

const srcDir = path.join(__dirname, '..', 'src');
const docsDir = path.join(__dirname, '..', 'docs');

// ---------------------------------------------------------------------------
// Results bookkeeping
// ---------------------------------------------------------------------------
const results = [];
function ok(name, cond, detail) {
  results.push({ name, pass: !!cond, detail: detail == null ? '' : String(detail) });
  if (!cond) process.exitCode = 1;
}
function section(title) { console.log('\n===== ' + title + ' ====='); }

// Quote-aware single-line CSV parser (same technique as the other harnesses).
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

// ---------------------------------------------------------------------------
(async () => { // same async-IIFE pattern as the other harnesses
// ---------------------------------------------------------------------------

// ===========================================================================
// PART M — main process: file:exportClipPlaylist under stubbed electron
// ===========================================================================
section('PART M — main process (real main.js, stubbed electron, real fs)');

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2b-userdata-'));
const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2b-scratch-'));

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

if (!handlers['file:exportClipPlaylist']) {
  ok('M0: file:exportClipPlaylist handler registered', false, 'handler missing');
} else {
  ok('M0: file:exportClipPlaylist handler registered', true);
  ok('M0b: file:exportCsv handler still registered (untouched by R2-B)', !!handlers['file:exportCsv']);

  // M1 — success: both files written, result carries the dir.
  const clipDir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'r2b-clips1-'));
  controls.openDialog = { canceled: false, filePaths: [clipDir1] };
  const CSV1 = 'clip,label,details,start_timecode,end_timecode,duration_seconds,filename\n1,Goal,,00:00:55.0,00:01:08.0,13.0,clip_001_Goal.mp4\n';
  const BAT1 = '@echo off\r\nchcp 65001 >nul\r\n';
  const res1 = await handlers['file:exportClipPlaylist'](fakeEvent, { csv: CSV1, script: BAT1 });
  const csvPath1 = path.join(clipDir1, 'clip_playlist.csv');
  const batPath1 = path.join(clipDir1, 'cut_clips.bat');
  ok('M1: success writes both files and returns { canceled: false, dir }',
    res1 && res1.canceled === false && res1.dir === clipDir1 && exists(csvPath1) && exists(batPath1),
    JSON.stringify(res1));

  // M2 — clip_playlist.csv: BOM at the byte level + payload byte-identical.
  const bytes1 = fs.readFileSync(csvPath1);
  const expected1 = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(CSV1, 'utf-8')]);
  ok('M2: clip_playlist.csv starts with the UTF-8 BOM bytes EF BB BF',
    bytes1[0] === 0xEF && bytes1[1] === 0xBB && bytes1[2] === 0xBF,
    bytes1[0] + ',' + bytes1[1] + ',' + bytes1[2]);
  ok('M2b: whole file is exactly BOM + payload (byte-identical content)',
    expected1.equals(bytes1), 'len=' + bytes1.length + ' expected=' + expected1.length);

  // M3 — cut_clips.bat: byte-exact script, NO BOM (cmd.exe requirement).
  const batBytes1 = fs.readFileSync(batPath1);
  ok('M3: cut_clips.bat is the byte-exact script with NO BOM (first byte \'@\')',
    batBytes1[0] === 0x40 && Buffer.from(BAT1, 'utf-8').equals(batBytes1),
    'first=' + batBytes1[0]);

  // M4 — Amharic content survives unchanged after the BOM.
  const clipDir4 = fs.mkdtempSync(path.join(os.tmpdir(), 'r2b-clips4-'));
  controls.openDialog = { canceled: false, filePaths: [clipDir4] };
  const CSV4 = 'clip,label\n1,አዲስ ጎብ\n';
  await handlers['file:exportClipPlaylist'](fakeEvent, { csv: CSV4, script: BAT1 });
  const expected4 = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(CSV4, 'utf-8')]);
  ok('M4: Amharic clip CSV byte-identical after the BOM',
    expected4.equals(fs.readFileSync(path.join(clipDir4, 'clip_playlist.csv'))));

  // M5 — CSV escaping is untouched: quoted cells round-trip byte-identically.
  const clipDir5 = fs.mkdtempSync(path.join(os.tmpdir(), 'r2b-clips5-'));
  controls.openDialog = { canceled: false, filePaths: [clipDir5] };
  const CSV5 = 'clip,label,details\n1,"Doe, John","line1\nline2 ""quoted"""\n';
  await handlers['file:exportClipPlaylist'](fakeEvent, { csv: CSV5, script: BAT1 });
  const expected5 = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(CSV5, 'utf-8')]);
  ok('M5: escaped clip CSV (commas/quotes/newlines in cells) byte-identical after the BOM',
    expected5.equals(fs.readFileSync(path.join(clipDir5, 'clip_playlist.csv'))));

  // M6 — dialog cancel: silent { canceled: true }, no files, no error box.
  controls.lastErrorBox = null;
  controls.openDialog = { canceled: true, filePaths: [] };
  const clipDir6 = fs.mkdtempSync(path.join(os.tmpdir(), 'r2b-clips6-'));
  const res6 = await handlers['file:exportClipPlaylist'](fakeEvent, { csv: CSV1, script: BAT1 });
  ok('M6: dialog cancel returns canceled, writes nothing, shows no error box',
    res6 && res6.canceled === true && !exists(path.join(clipDir6, 'clip_playlist.csv')) &&
      controls.lastErrorBox === null,
    JSON.stringify(res6));

  // M7 — write failure: original error surfaced via the native error box,
  // { canceled: true } preserved (parent "directory" is a regular file).
  controls.lastErrorBox = null;
  const notADir = path.join(scratchDir, 'not-a-dir.txt');
  fs.writeFileSync(notADir, 'x');
  controls.openDialog = { canceled: false, filePaths: [notADir] };
  const res7 = await handlers['file:exportClipPlaylist'](fakeEvent, { csv: CSV1, script: BAT1 });
  ok('M7: write failure (ENOTDIR) -> error box shown + canceled result, no crash',
    res7 && res7.canceled === true && controls.lastErrorBox &&
      controls.lastErrorBox.title === 'Export failed' &&
      String(controls.lastErrorBox.message).length > 0,
    JSON.stringify(res7).slice(0, 80));

  // M8 — non-string csv still fails through the error path (no garbage file).
  controls.lastErrorBox = null;
  const clipDir8 = fs.mkdtempSync(path.join(os.tmpdir(), 'r2b-clips8-'));
  controls.openDialog = { canceled: false, filePaths: [clipDir8] };
  const res8 = await handlers['file:exportClipPlaylist'](fakeEvent, { csv: undefined, script: BAT1 });
  ok('M8: non-string csv payload fails through the error path (BOM guard, no garbage files)',
    res8 && res8.canceled === true && controls.lastErrorBox !== null &&
      !exists(path.join(clipDir8, 'clip_playlist.csv')) && !exists(path.join(clipDir8, 'cut_clips.bat')),
    JSON.stringify(res8).slice(0, 80));
}

// ===========================================================================
// PART F — renderer (jsdom): squad scoping, clip guards, dictionary contract
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
  clipResult: { canceled: false, dir: '/tmp/clips' },
  loadMultiple: [],
  loadSessionData: null,
  squad: null,
  openVideoResult: null
};

function makeStub(calls) {
  return {
    openVideo: async () => fcontrols.openVideoResult,
    saveSession: async (d) => { calls.saveSession.push(d); return { canceled: true }; },
    exportCsv: async (csv, name) => { calls.exportCsv.push({ csv: String(csv), name: name === undefined ? null : name }); return fcontrols.exportResult; },
    exportClipPlaylist: async (data) => {
      calls.clip.push({ csv: String(data && data.csv), script: String(data && data.script) });
      return fcontrols.clipResult;
    },
    loadSession: async () => fcontrols.loadSessionData,
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
  const calls = { exportCsv: [], saveSession: [], loadMultiple: 0, clip: [] };
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
  win.alert = () => {}; // jsdom's alert is "not implemented" noise
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

// --- Fixtures ---------------------------------------------------------------

function fev(id, time, label, opts) {
  const o = opts || {};
  return {
    id, time, videoTime: null, matchTime: time, matchSeconds: time,
    officialMinute: null, second: null, period: o.period || '1H', label,
    subtype: o.subtype || null, qualifiers: {}, location: null,
    playerId: o.playerId !== undefined ? o.playerId : null,
    playerOffId: o.playerOffId !== undefined ? o.playerOffId : null,
    playerOnId: o.playerOnId !== undefined ? o.playerOnId : null,
    side: o.team === 'our' ? 'for' : 'against', team: o.team || 'our',
    sequenceId: null, scoreForBefore: 0, scoreAgainstBefore: 0,
    scoreForAfter: null, scoreAgainstAfter: null,
    isInterval: false, startTime: null, endTime: null, outcome: null
  };
}

function feSession(n, date, opponent, homeAway, ourScore, oppScore, squad, events) {
  return {
    sourceFile: '/r2b-' + n + '.json',
    __savedAt: '2026-09-' + String(n).padStart(2, '0') + 'T20:00:00Z',
    __schemaVersion: 4,
    videoPath: null, videoUrl: null,
    tags: [],
    events,
    squad,
    matchInfo: {
      competition: 'League', date, opponent, venue: 'V',
      homeAway, ourScore, opponentScore: oppScore, formation: '4-3-3',
      startingXI: squad.map((p, i) => ({ position: 'P' + i, playerId: p.id }))
    },
    matchClock: {
      clockStartedAt: null, clockBaseSeconds: 5400, clockRunning: false,
      period: 'FT', scoreFor: 1, scoreAgainst: 0, videoSyncOffset: 0,
      selectedTeam: 'our', selectedPlayerId: null, activeSequenceId: null, nextSequenceNumber: 1
    }
  };
}

// Boot V1 fixtures — the squad-scoping core case:
//   match A squad: p1 = Abebe Bikila #10, p9 = Chala #3
//   match B squad: p1 = Different Person #7 (SAME id, different person!),
//                  p2 = አዲስ ተጋዳዳይ #9
//   live squad:    p1 = Live Squad Impostor #99 (must never leak into the
//                  season export; the standard export must still use it)
const sessA = feSession(1, '2026-08-01', 'Opponent A', 'home', '2', '1',
  [{ id: 'p1', number: '10', name: 'Abebe Bikila' }, { id: 'p9', number: '3', name: 'Chala' }],
  [
    fev(1, 60, 'Recovery', { playerId: 'p1' }),
    fev(2, 120, 'Sub', { playerId: null, playerOffId: 'p9', playerOnId: 'p2' }),
    fev(3, 600, 'Shot', { playerId: 'player_zzz' })
  ]);
const sessB = feSession(2, '2026-08-08', 'Opponent B', 'away', '0', '0',
  [{ id: 'p1', number: '7', name: 'Different Person' }, { id: 'p2', number: '9', name: 'አዲስ ተጋዳዳይ' }],
  [
    fev(4, 300, 'Goal', { playerId: 'p1' }),
    fev(5, 900, 'Shot', { playerId: 'p2' })
  ]);

const LABEL_A = 'vs Opponent A · Home · 2–1 · 2026-08-01';
const LABEL_B = 'vs Opponent B · Away · 0–0 · 2026-08-08';

const STD20 = 'match,timecode,seconds,end_timecode,end_seconds,duration_seconds,label,side,player_number,player_name,player_off_number,player_off_name,player_on_number,player_on_name,subtype,qualifiers,location_zone,location_x,location_y,outcome';

// ---------------------------------------------------------------------------
console.log('\n== Boot V1 — squad scoping, clip guards, clip capture, headers ==');
let seasonCsv = '', seasonPlayerCsv = '', stdCsv = '', fullCsv = '', clipCsv = '', clipScript = '';
{
  fcontrols.squad = [{ id: 'p1', number: '99', name: 'Live Squad Impostor' }];
  fcontrols.loadMultiple = [sessA, sessB];
  const B = await boot();
  const { win, doc, calls } = B;

  // --- Clip guards (R2-A deferred item, closed by R2-B) ---
  dismissToast(win, doc);
  click(win, doc.getElementById('btnExportClips'));
  await sleep(150);
  let st = toastState(doc);
  ok('F1: clip export with no video + no events -> "no video" toast, modal closed, no IPC call',
    st.shown && /nothing to export/i.test(st.text) && /no video/i.test(st.text) &&
      doc.getElementById('clipExportModal').style.display !== 'flex' && calls.clip.length === 0,
    'toast="' + st.text + '" clipCalls=' + calls.clip.length);

  fcontrols.openVideoResult = { path: 'C:\\match.mp4', url: 'file:///C:/match.mp4' };
  click(win, doc.getElementById('btnOpenVideo'));
  await sleep(120);

  dismissToast(win, doc);
  click(win, doc.getElementById('btnExportClips'));
  await sleep(150);
  st = toastState(doc);
  ok('F2: clip export with a video but 0 events -> "no tagged events" toast, modal closed, no IPC call',
    st.shown && /nothing to export/i.test(st.text) && /no tagged events/i.test(st.text) &&
      doc.getElementById('clipExportModal').style.display !== 'flex' && calls.clip.length === 0,
    'toast="' + st.text + '" clipCalls=' + calls.clip.length);

  // --- Season events export (the squad-scoping fix) ---
  click(win, doc.getElementById('btnAddSeasonMatches'));
  await sleep(300);
  fcontrols.exportResult = { canceled: false, filePath: '/tmp/exports/season-events.csv' };
  click(win, doc.getElementById('btnExportSeasonCsv'));
  await sleep(200);
  seasonCsv = calls.exportCsv[0] ? calls.exportCsv[0].csv : '';
  const seLines = seasonCsv ? seasonCsv.split('\n') : [];
  const seRows = seLines.slice(1).map(parseCsvLine);

  ok('F3: season event export happens and carries the exact 20-column header',
    seLines[0] === STD20, 'header=' + seLines[0]);
  ok('F4: 5 data rows, every row exactly 20 cells (no ragged rows)',
    seRows.length === 5 && seRows.every((r) => r.length === 20),
    'rows=' + seRows.length);

  const rowA = (label) => seRows.find((r) => r[0] === LABEL_A && r[6] === label);
  const rowB = (label) => seRows.find((r) => r[0] === LABEL_B && r[6] === label);

  ok('F5: match A p1 row resolves from A\'s OWN squad (10 / Abebe Bikila)',
    (() => { const r = rowA('Recovery'); return !!r && r[8] === '10' && r[9] === 'Abebe Bikila'; })(),
    JSON.stringify(rowA('Recovery') && rowA('Recovery').slice(8, 10)));
  ok('F6: match B p1 row resolves from B\'s OWN squad (7 / Different Person) — same id, different squad',
    (() => { const r = rowB('Goal'); return !!r && r[8] === '7' && r[9] === 'Different Person'; })(),
    JSON.stringify(rowB('Goal') && rowB('Goal').slice(8, 10)));
  ok('F7: the LIVE squad never leaks into the season export (no "Live Squad Impostor" anywhere)',
    seasonCsv.indexOf('Live Squad Impostor') === -1);
  ok('F8: Sub row off-cells from A\'s squad (3 / Chala), on-cells empty (p2 not in A\'s squad)',
    (() => { const r = rowA('Sub'); return !!r && r[10] === '3' && r[11] === 'Chala' && r[12] === '' && r[13] === ''; })(),
    JSON.stringify(rowA('Sub') && rowA('Sub').slice(10, 14)));
  ok('F9: unresolved player id (player_zzz) -> EMPTY cells, never invented',
    (() => { const r = rowA('Shot'); return !!r && r[8] === '' && r[9] === ''; })(),
    JSON.stringify(rowA('Shot') && rowA('Shot').slice(8, 10)));
  ok('F10: Amharic player name round-trips in the season CSV (አዲስ ተጋዳዳይ)',
    (() => { const r = rowB('Shot'); return !!r && r[9] === 'አዲስ ተጋዳዳይ'; })(),
    JSON.stringify(rowB('Shot') && rowB('Shot').slice(8, 10)));
  ok('F11: match labels are the documented join-key strings (en dash, ISO date)',
    seRows[0][0] === LABEL_A && seRows[3][0] === LABEL_B,
    JSON.stringify([seRows[0] && seRows[0][0], seRows[3] && seRows[3][0]]));
  ok('F12: cell-level quality — no NaN/undefined/null/[object artifacts in the CSV',
    !/NaN|undefined|\bnull\b|\[object/.test(seasonCsv),
    'first match at ' + (seasonCsv.search(/NaN|undefined|\bnull\b|\[object/) || 'none'));
  ok('F13: ISO date inside the match label (yyyy-mm-dd)',
    /^\d{4}-\d{2}-\d{2}$/.test((LABEL_A.split(' · ').pop() || '')) &&
      seRows.every((r) => /\d{4}-\d{2}-\d{2}/.test(r[0])));

  // --- Season player export (63-column contract still intact) ---
  fcontrols.exportResult = { canceled: false, filePath: '/tmp/exports/season-player.csv' };
  click(win, doc.getElementById('btnExportSeasonPlayerCsv'));
  await sleep(300);
  seasonPlayerCsv = calls.exportCsv[1] ? calls.exportCsv[1].csv : '';
  const spLines = seasonPlayerCsv ? seasonPlayerCsv.split('\n') : [];
  const SC = win.SeasonCsvEngine;
  ok('F14: season player export: exact PSD-V2 63-column header (contract intact) + well-formed rows',
    spLines[0] === (SC ? SC.COLUMNS.join(',') : '') &&
      spLines.slice(1).every((l) => parseCsvLine(l).length === 63),
    'header ok=' + (spLines[0] === (SC ? SC.COLUMNS.join(',') : '')) + ' rows=' + (spLines.length - 1));

  // --- Standard export keeps LIVE-squad resolution (behavior unchanged) ---
  click(win, tagBtn(doc, 'Shot'));
  await sleep(80);
  const chip = doc.querySelector('.chip[data-player-id="p1"]');
  click(win, chip);
  await sleep(60);
  click(win, doc.getElementById('detailPanelDone'));
  await sleep(80);
  fcontrols.exportResult = { canceled: false, filePath: '/tmp/exports/match-events.csv' };
  click(win, doc.getElementById('btnExportCsv'));
  await sleep(150);
  stdCsv = calls.exportCsv[2] ? calls.exportCsv[2].csv : '';
  const stdLines = stdCsv ? stdCsv.split('\n') : [];
  const stdRow = stdLines[1] ? parseCsvLine(stdLines[1]) : [];
  ok('F15: standard export still resolves against the LIVE squad (99 / Live Squad Impostor)',
    stdRow[7] === '99' && stdRow[8] === 'Live Squad Impostor',
    JSON.stringify(stdRow.slice(7, 9)));

  // --- Full-analysis export (36-column header capture) ---
  click(win, doc.getElementById('btnExportCsv'), { shiftKey: true });
  await sleep(150);
  fullCsv = calls.exportCsv[3] ? calls.exportCsv[3].csv : '';
  ok('F16: full-analysis export: 36 columns, legacy layout unchanged',
    fullCsv.split('\n')[0].split(',').length === 36 &&
      fullCsv.startsWith('Match ID,Date,Competition,Home Team,Away Team,Opponent,'),
    'cols=' + fullCsv.split('\n')[0].split(',').length);

  // --- Clip export positive path (video + event present now) ---
  click(win, doc.getElementById('btnExportClips'));
  await sleep(120);
  ok('F17: clip export with video + events opens the modal',
    doc.getElementById('clipExportModal').style.display === 'flex');
  click(win, doc.getElementById('btnConfirmClipExport'));
  await sleep(150);
  clipCsv = calls.clip[0] ? calls.clip[0].csv : '';
  clipScript = calls.clip[0] ? calls.clip[0].script : '';
  const clLines = clipCsv ? clipCsv.split('\n') : [];
  const clRow = clLines[1] ? parseCsvLine(clLines[1]) : [];
  ok('F18: clip CSV: 7-column header, renderer string BOM-free (BOM is main-side)',
    clLines[0] === 'clip,label,details,start_timecode,end_timecode,duration_seconds,filename' &&
      clipCsv.charCodeAt(0) !== 0xFEFF,
    'header=' + clLines[0]);
  ok('F19: bat script: CRLF line endings, starts with @echo off, no BOM',
    clipScript.indexOf('@echo off') === 0 && clipScript.includes('\r\n') &&
      clipScript.charCodeAt(0) !== 0xFEFF,
    'first=' + clipScript.slice(0, 10));
  ok('F20: clip row: 1-based clip number, label preserved, ASCII filename pattern',
    clRow[0] === '1' && clRow[1] === 'Shot' && /^clip_001_Shot\.mp4$/.test(clRow[6]),
    JSON.stringify(clRow && [clRow[0], clRow[1], clRow[6]]));
}

// ---------------------------------------------------------------------------
console.log('\n== Boot V2 — Amharic clip label: Unicode data column, ASCII filename ==');
{
  fcontrols.squad = null;
  fcontrols.openVideoResult = null;
  fcontrols.loadSessionData = {
    sourceFile: '/r2b-clip.json',
    __savedAt: '2026-09-05T20:00:00Z',
    __schemaVersion: 4,
    videoPath: 'C:\\m.mp4', videoUrl: 'file:///C:/m.mp4',
    tags: [],
    events: [fev(1, 120, 'አዲስ ጎብ', { playerId: null })],
    squad: [],
    matchInfo: { competition: '', date: '', opponent: '', venue: '', homeAway: 'home', ourScore: '', opponentScore: '', formation: '', startingXI: [] },
    matchClock: {
      clockStartedAt: null, clockBaseSeconds: 0, clockRunning: false,
      period: '1H', scoreFor: 0, scoreAgainst: 0, videoSyncOffset: 0,
      selectedTeam: 'our', selectedPlayerId: null, activeSequenceId: null, nextSequenceNumber: 1
    }
  };
  const B = await boot();
  const { win, doc, calls } = B;

  click(win, doc.getElementById('btnLoadSession'));
  await sleep(300);
  click(win, doc.getElementById('btnExportClips'));
  await sleep(120);
  ok('F21: loaded session (video + Amharic event) opens the clip modal',
    doc.getElementById('clipExportModal').style.display === 'flex');
  click(win, doc.getElementById('btnConfirmClipExport'));
  await sleep(150);
  const cl = calls.clip[0] ? parseCsvLine(calls.clip[0].csv.split('\n')[1] || '') : [];
  ok('F22: Amharic label preserved in the DATA column, filename ASCII-sanitized to the event fallback',
    cl[1] === 'አዲስ ጎብ' && cl[6] === 'clip_001_event.mp4',
    JSON.stringify([cl[1], cl[6]]));
}

// ---------------------------------------------------------------------------
// Dictionary contract — the machine-readable schema blocks cannot drift.
// ---------------------------------------------------------------------------
console.log('\n== Dictionary contract — docs/export-data-dictionary.md ==');
{
  const dictPath = path.join(docsDir, 'export-data-dictionary.md');
  ok('D1: docs/export-data-dictionary.md exists', fs.existsSync(dictPath));
  const dictSrc = fs.readFileSync(dictPath, 'utf-8');
  const blocks = [];
  const re = /```json\s*\r?\n([\s\S]*?)```/g;
  let m;
  let parseOk = true;
  while ((m = re.exec(dictSrc)) !== null) {
    try { blocks.push(JSON.parse(m[1])); } catch (e) { parseOk = false; }
  }
  const byExport = {};
  blocks.forEach((b) => { if (b && b.export) byExport[b.export] = b; });
  ok('D2: five schema blocks, all valid JSON, unique export ids, no duplicate column names',
    parseOk && blocks.length === 5 && Object.keys(byExport).length === 5 &&
      blocks.every((b) => b.columns.length === new Set(b.columns.map((c) => c.name)).size),
    'blocks=' + blocks.length);

  const headerOf = (csv) => (csv ? csv.split('\n')[0] : '');
  const namesOf = (b) => (b ? b.columns.map((c) => c.name).join(',') : '');

  ok('D3: dictionary match-events columns == real standard export header',
    namesOf(byExport['match-events']) === headerOf(stdCsv), headerOf(stdCsv).slice(0, 60));
  ok('D4: dictionary match-events-full-analysis columns == real full-analysis header',
    namesOf(byExport['match-events-full-analysis']) === headerOf(fullCsv));
  ok('D5: dictionary season-events columns == real season-events header',
    namesOf(byExport['season-events']) === headerOf(seasonCsv));
  ok('D6: dictionary season-player columns == real 63-column export header',
    namesOf(byExport['season-player']) === headerOf(seasonPlayerCsv),
    'dictCols=' + (byExport['season-player'] ? byExport['season-player'].columns.length : 0));
  ok('D7: dictionary clip_playlist columns == real clip CSV header',
    namesOf(byExport['clip_playlist']) === headerOf(clipCsv));
  ok('D8: dictionary documents the shared conventions (UTF-8, BOM, LF, Excel text-import advice)',
    /UTF-8/.test(dictSrc) && /BOM/.test(dictSrc) && /LF only/.test(dictSrc) &&
      /[Tt]ext/.test(dictSrc));
  ok('D9: dictionary documents the known quirks (legacy Outcome=qualifiers, always-empty columns, ASCII clip filenames, 0–1 vs 0–100 scale)',
    /serialized qualifiers/.test(dictSrc) && /always empty/.test(dictSrc) &&
      /ASCII-ONLY/.test(dictSrc) && /0–100 scale/.test(dictSrc) && /0–1 scale/.test(dictSrc));
}

// ===========================================================================
// STATIC — source-level pins
// ===========================================================================
section('STATIC — source pins (scoped resolver, BOM sites, docs truth)');

{
  // S1 — the season-events block resolves players per-match.
  const i = rendererSrc.indexOf('btnExportSeasonCsv.addEventListener');
  const j = rendererSrc.indexOf('btnExportSeasonPlayerCsv.addEventListener');
  const seasonBlock = rendererSrc.slice(i, j);
  ok('S1: season-events block uses the per-match resolver (>=6 uses) and never the live resolver',
    seasonBlock.includes('resolveMatchPlayer') &&
      (seasonBlock.match(/resolveMatchPlayer\(/g) || []).length >= 6 &&
      !seasonBlock.includes('resolvePlayer('),
    'uses=' + (seasonBlock.match(/resolveMatchPlayer\(/g) || []).length);

  // S2 — the standard export block keeps live-squad resolution.
  const a = rendererSrc.indexOf("btnExportCsv.addEventListener('click', async (e)");
  const b = rendererSrc.indexOf('function csvEscape');
  const stdBlock = rendererSrc.slice(a, b);
  ok('S2: standard export block still uses the live-squad resolver (6 uses)',
    (stdBlock.match(/resolvePlayer\(/g) || []).length === 6,
    'uses=' + (stdBlock.match(/resolvePlayer\(/g) || []).length);

  // S3 — exactly two BOM prepend sites in main.js; the .bat write has none.
  const mainSrc = fs.readFileSync(path.join(srcDir, 'main.js'), 'utf-8');
  const bomSites = (mainSrc.match(/'\\ufeff'/g) || []).length;
  ok('S3: main.js has exactly two BOM prepend sites (exportCsv + clip csv); cut_clips.bat write stays BOM-free',
    bomSites === 2 &&
      /'\\ufeff'\s*\+\s*csvString/.test(mainSrc) &&
      /'\\ufeff'\s*\+\s*csv\b/.test(mainSrc) &&
      /cut_clips\.bat'\),\s*script/.test(mainSrc) &&
      !/'\\ufeff'\s*\+\s*script/.test(mainSrc),
    'sites=' + bomSites);

  // S4 — the clip guards exist inside openClipExportModal.
  const c = rendererSrc.indexOf('function openClipExportModal');
  const clipBlock = rendererSrc.slice(c, c + 700);
  ok('S4: openClipExportModal carries both empty-guard toasts (no video / no events)',
    clipBlock.includes('no video is loaded') && clipBlock.includes('no tagged events') &&
      /btnExportClips\.title\s*=/.test(rendererSrc));

  // S5 — docs are truthful post-R2-B.
  const metricSrc = fs.readFileSync(path.join(docsDir, 'metric-specification.md'), 'utf-8');
  const readmeSrc = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf-8');
  ok('S5: metric-spec BOM line covers clip_playlist.csv (R2-B) and the F7 line names the real outcome column',
    /clip_playlist\.csv` since R2-B/.test(metricSrc) && /Event Outcome` column/.test(metricSrc));
  ok('S6: README has no stale suite count and points at the data dictionary',
    !/22 scripts/.test(readmeSrc) && !/22\/22/.test(readmeSrc) &&
      /export-data-dictionary\.md/.test(readmeSrc));
}

// ---------------------------------------------------------------------------
console.log('\n===== RESULTS =====');
let pass = 0, fail = 0;
results.forEach((r) => {
  if (r.pass) pass++;
  else { fail++; console.log('  ✗ ' + r.name + (r.detail ? '  (' + r.detail + ')' : '')); }
});
console.log('---- r2b data-quality check: ' + pass + ' passed, ' + fail + ' failed ----');
console.log('NOTE: the native dialog UX and packaged-app BOM handling still require');
console.log('manual Electron verification; everything below the dialogs is verified here.');
process.exit(fail === 0 ? 0 : 1);
})().catch((err) => { console.error('R2B HARNESS CRASHED:', err); process.exit(1); });
