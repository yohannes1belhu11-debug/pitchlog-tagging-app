#!/usr/bin/env node
// PitchLog / MatchTag — F2.4 Touchline Autosave Telemetry harness (TS/TE series).
// =====================================================================
// Focused regression suite for F2.4: the Touchline header save-status
// indicator (#touchlineSaveStatus) bound to the real autosave lifecycle.
//
// F2.4 contract under test:
//   * The indicator element lives in the Touchline header (static markup,
//     untouched — F2.4 adds zero HTML/CSS).
//   * Logging an event (setDirty) → "SAVING..." (pending) — and stays
//     pending across debounce EXTENSIONS during rapid tagging, never
//     flickering to saved before the write executes.
//   * The debounced autosave write completing OK → "✓ SAVED" instantly.
//   * A failed write → "⚠ SAVE ERROR" without crashing the UI.
//   * Manual save / load / discard (setClean) → "✓ SAVED" immediately.
//   * Stale (epoch-invalidated) write completions paint NOTHING.
//   * The telemetry is a READ-ONLY observer: debounce timing (1500ms),
//     write IPC, epoch guards, failure toast, and all 4
//     setClean+clearAutosave call sites are preserved — verified both
//     statically and behaviorally.
//   * The quick-tag grid is INSULATED: node identity + a MutationObserver
//     prove telemetry never rebuilds it (no DOM work beyond the single
//     span, and none at all once the state is already correct).
//
// jsdom boots use a stub whose autosaveWrite can be gated (resolves only
// when released) and can fail on demand — the proven F1.3 technique.
//
// HONEST SCOPE: jsdom does not compute CSS layout/paint — the visual
// rendering (colors, 11px sizing, header flex placement) and real Electron
// IPC/disk I/O require manual verification in the packaged app.
//
// Run:  node tests/touchline-autosave-telemetry-check.js   (project root)
'use strict';

const path = require('path');
const fs = require('fs');

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

const srcDir = path.join(__dirname, '..', 'src');
const html = fs.readFileSync(path.join(srcDir, 'index.html'), 'utf-8');
const integritySrc = fs.readFileSync(path.join(srcDir, 'integrity.js'), 'utf-8');
const analyticsSrc = fs.readFileSync(path.join(srcDir, 'analytics.js'), 'utf-8');
const playerSeasonSrc = fs.readFileSync(path.join(srcDir, 'player-season.js'), 'utf-8');
const rendererSrc = fs.readFileSync(path.join(srcDir, 'renderer.js'), 'utf-8');
const stylesSrc = fs.readFileSync(path.join(srcDir, 'styles.css'), 'utf-8');
const mainSrc = fs.readFileSync(path.join(srcDir, 'main.js'), 'utf-8');

const results = [];
let SECTION = '(pre)';
function section(name) { SECTION = name; console.log('\n===== ' + name + ' ====='); }
function ok(name, cond, detail) {
  results.push({ section: SECTION, name: name, pass: !!cond, detail: detail === undefined ? '' : String(detail) });
  if (!cond) console.log('  FAIL: ' + name + (detail === undefined ? '' : '  | ' + detail));
}

const jsdomErrors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function clone(x) { return x == null ? x : JSON.parse(JSON.stringify(x)); }

// Extract a function's body (between its declaration and the next
// top-level 'function ' keyword) for static checks.
function fnBody(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) return '';
  const next = src.indexOf('\n  function ', start + 10);
  return start > -1 && next > start ? src.slice(start, next) : src.slice(start, start + 3000);
}

function saveEl(doc) { return doc.getElementById('touchlineSaveStatus'); }
function saveText(doc) { const el = saveEl(doc); return el ? el.textContent : null; }
function saveClass(doc) { const el = saveEl(doc); return el ? el.className : null; }

// ---------------------------------------------------------------------------
// Static source-level checks
// ---------------------------------------------------------------------------
section('STATIC — F2.4 wiring + preservation (source-level checks)');
{
  // --- F2.4 wiring ---
  ok('TS-S1: telemetry state + guarded setter exist and the painter is invoked',
    /let touchlineSaveStatusState = 'saved';/.test(rendererSrc) &&
    /function updateTouchlineSaveStatus\(status\)/.test(rendererSrc) &&
    (rendererSrc.match(/updateTouchlineSaveStatus\('(saved|saving|error)'\);/g) || []).length === 7 && // 7 live call sites
    /function renderTouchlineSaveStatus\(status\)/.test(rendererSrc) &&
    (rendererSrc.match(/renderTouchlineSaveStatus\(status\);/g) || []).length === 1); // exactly one live caller

  const updFn = fnBody(rendererSrc, 'updateTouchlineSaveStatus');
  ok('TS-S2: equality guard — no DOM work unless the status actually changed',
    /if \(touchlineSaveStatusState === status\) return;/.test(updFn) &&
    updFn.indexOf('renderTouchlineSaveStatus(status)') > updFn.indexOf('touchlineSaveStatusState = status;'));

  const dirtyFn = fnBody(rendererSrc, 'setDirty');
  ok('TS-S3: setDirty paints saving AFTER the modal guards and alongside the desktop indicator',
    dirtyFn.indexOf('if (recoveryModalVisible) return;') < dirtyFn.indexOf("updateTouchlineSaveStatus('saving')") &&
    dirtyFn.indexOf('if (unsavedConfirmVisible) return;') < dirtyFn.indexOf("updateTouchlineSaveStatus('saving')") &&
    dirtyFn.indexOf("updateTouchlineSaveStatus('saving')") < dirtyFn.indexOf('scheduleAutosave();'));

  const cleanFn = fnBody(rendererSrc, 'setClean');
  ok('TS-S4: setClean paints saved (manual save / load / discard paths all funnel here)',
    /updateTouchlineSaveStatus\('saved'\);/.test(cleanFn) &&
    cleanFn.indexOf('clearAutosaveTimer();') < cleanFn.indexOf("updateTouchlineSaveStatus('saved')"));

  const schedFn = fnBody(rendererSrc, 'scheduleAutosave');
  ok('TS-S5: dirty-but-no-work branch paints saved (never stuck on SAVING with nothing at risk)',
    /updateTouchlineSaveStatus\('saved'\);/.test(schedFn) &&
    schedFn.indexOf("updateTouchlineSaveStatus('saved')") < schedFn.indexOf('clearStaleAutosaveFile();'));

  const perfFn = fnBody(rendererSrc, 'performAutosave');
  const staleGuard = perfFn.lastIndexOf('if (epochAtStart !== autosaveEpoch) return;');
  ok('TS-S6: stale write completions paint NOTHING (telemetry strictly after the epoch guard)',
    staleGuard > -1 &&
    staleGuard < perfFn.indexOf("updateTouchlineSaveStatus('saved')") &&
    staleGuard < perfFn.indexOf("updateTouchlineSaveStatus('error')"));

  ok('TS-S7: performAutosave success paints saved, failure paints error, both inside the result handling',
    /if \(result && result\.ok\) \{\s*\n\s*updateTouchlineSaveStatus\('saved'\);/.test(perfFn) &&
    /\} else \{\s*\n\s*updateTouchlineSaveStatus\('error'\);/.test(perfFn) &&
    /showAutosaveToast\('Autosave failed: ' \+ err \+ '\. Please save your work manually\.'\)/.test(perfFn));

  const flushFn = fnBody(rendererSrc, 'flushAutosaveSync');
  ok('TS-S8: the sync close-flush outcome is also mirrored (survived-close belt)',
    /if \(result && result\.ok\) updateTouchlineSaveStatus\('saved'\);/.test(flushFn) &&
    flushFn.indexOf("updateTouchlineSaveStatus('error')") > -1 &&
    /Autosave on close failed/.test(flushFn));

  // --- read-only guarantee: the lifecycle machinery is untouched ---
  ok('TS-S9: debounce constant + timer arming unchanged (1500ms, 2 arming sites)',
    /const AUTOSAVE_DEBOUNCE_MS = 1500;/.test(rendererSrc) &&
    (rendererSrc.match(/autosaveTimer = setTimeout\(performAutosave, AUTOSAVE_DEBOUNCE_MS\);/g) || []).length === 2);

  ok('TS-S10: single write IPC call site, promise bookkeeping preserved',
    (rendererSrc.match(/window\.matchtag\.autosaveWrite\(data\)/g) || []).length === 1 &&
    /autosaveWritePromise = writePromise/.test(perfFn) &&
    perfFn.lastIndexOf('autosaveWritePromise = null;') > perfFn.indexOf('const result = await writePromise'));

  ok('TS-S11: all 4 session-replacement sites still setClean + clearAutosave (no 5th path added)',
    (rendererSrc.match(/await clearAutosave\(\);/g) || []).length === 4 &&
    (rendererSrc.match(/setClean\(\);\s*\n\s*await clearAutosave\(\);/g) || []).length === 4);

  const clearFn = fnBody(rendererSrc, 'clearAutosave');
  ok('TS-S12: clearAutosave still bumps the epoch before draining (F1.3 race guards intact)',
    clearFn.indexOf('autosaveEpoch++') < clearFn.indexOf('await autosaveWritePromise'));

  // --- the painter touches ONLY the indicator element ---
  const paintFn = fnBody(rendererSrc, 'renderTouchlineSaveStatus');
  ok('TS-S13: the painter queries only #touchlineSaveStatus and never the quick-tag grid',
    /getElementById\('touchlineSaveStatus'\)/.test(paintFn) &&
    paintFn.indexOf('touchlineQuickTags') === -1 &&
    paintFn.indexOf('renderTouchlineQuickTags') === -1 &&
    paintFn.indexOf('renderTouchlineAll') === -1 &&
    paintFn.indexOf('querySelectorAll') === -1 &&
    paintFn.indexOf('innerHTML') === -1);

  // --- DOM/CSS contract: the indicator ships in the Touchline header ---
  ok('TS-S14: static markup places the span inside the Touchline header save-status slot',
    html.indexOf('<div class="touchline-save-status"><span id="touchlineSaveStatus" class="save-status-saved">✓ SAVED</span></div>') > -1 &&
    html.indexOf('touchline-save-status') > html.indexOf('touchline-header') &&
    html.indexOf('touchline-save-status') < html.indexOf('btnExitTouchline'));

  ok('TS-S15: the three status classes + header slot styles exist (reused, unmodified)',
    /\.save-status-saved \{ color: #2ecc71; \}/.test(stylesSrc) &&
    /\.save-status-saving \{ color: #f39c12; \}/.test(stylesSrc) &&
    /\.save-status-error \{ color: #e74c3c; \}/.test(stylesSrc) &&
    /\.touchline-save-status \{ font-size: 11px; font-weight: 600;/.test(stylesSrc));

  // --- F2.1/F2.2/F2.3 preservation pins ---
  const cancelFn = fnBody(rendererSrc, 'cancelTouchlineInterval');
  ok('TS-S16: F2.3 cancel stays telemetry-clean (no dirty, no paint — pure state deletion)',
    /markAutosaveDirty/.test(cancelFn) === false &&
    /updateTouchlineSaveStatus/.test(cancelFn) === false &&
    /delete activeIntervals\[label\]/.test(cancelFn));

  ok('TS-S17: F2.1 interval machinery untouched (start capture + finish push still intact)',
    (function () {
      const s = fnBody(rendererSrc, 'startInterval');
      const f = fnBody(rendererSrc, 'finishInterval');
      return !!(s.indexOf('startTime') > -1 && s.indexOf('startMatchSeconds') > -1 && s.indexOf('startPeriod') > -1 &&
        f.indexOf('events.push') > -1 && f.indexOf('markAutosaveDirty()') > -1);
    })());

  ok('TS-S18: F2.2 recent-feed layering + F1.4 quick-tag grid contract intact',
    /function touchlineRecentItemHtml/.test(rendererSrc) &&
    /function wireTouchlineRecentItem/.test(rendererSrc) &&
    (rendererSrc.match(/renderTouchlineQuickTags\(\);/g) || []).length >= 2 &&
    /'Possession','Shot','Chance','Cross','Key Pass','Press','Press Win','Turnover','Recovery','Interception','Duel','Positive Transition','Negative Transition','Goal','Card','Sub'/.test(rendererSrc));

  ok('TS-S19: schema version pinned at v4 (R1 outcome field) + core autosave IPC names unchanged',
    /CURRENT_SCHEMA_VERSION = 4/.test(mainSrc) &&
    /ipcMain\.handle\('autosave:write'/.test(mainSrc) &&
    /ipcMain\.handle\('autosave:delete'/.test(mainSrc) &&
    /ipcMain\.on\('autosave:flush-sync'/.test(mainSrc));
}

// ---------------------------------------------------------------------------
// jsdom boots
// ---------------------------------------------------------------------------
function makeStub(initial, opts) {
  const o = opts || {};
  const calls = {
    saveSession: [], autosaveDelete: 0, loadSessionCalls: 0,
    writeStart: 0, openVideoCalls: 0, flushSync: []
  };
  const file = { current: null };
  let gates = [];
  let failNextWrite = false;
  let flushResult = null;
  let loadSessionData = null;
  let openVideoResult = o.video || null;

  const stub = {
    openVideo: async () => { calls.openVideoCalls++; return clone(openVideoResult); },
    saveSession: async (d) => { calls.saveSession.push(clone(d)); return { canceled: false, filePath: '/tmp/ts-session.json' }; },
    exportCsv: async () => ({ canceled: true }),
    exportClipPlaylist: async () => ({ canceled: true }),
    loadSession: async () => { calls.loadSessionCalls++; return clone(loadSessionData); },
    loadMultipleSessions: async () => [],
    loadSquad: async () => clone(initial.squad || []),
    saveSquad: async () => true,
    detachVideo: async () => true,
    reattachVideo: async () => true,
    sendVideoCommand: () => {},
    onVideoState: () => {},
    onVideoClosed: () => {},
    autosaveRead: async () => null,
    autosaveWrite: (data) => new Promise((resolve) => {
      calls.writeStart++;
      const land = () => {
        const fail = failNextWrite;
        failNextWrite = false;
        if (fail) resolve({ ok: false, error: 'ENOSPC: telemetry test disk full' });
        else { file.current = clone(data); resolve({ ok: true, path: '/tmp/autosave.json' }); }
      };
      if (o.gateWrites) gates.push(land); else land();
    }),
    autosaveDelete: async () => { calls.autosaveDelete++; file.current = null; return { ok: true }; },
    autosaveFlushSync: (data) => {
      calls.flushSync.push(clone(data));
      const r = flushResult != null ? clone(flushResult) : { ok: true };
      if (r.ok) file.current = clone(data);
      return r;
    },
    onCloseRequested: () => {},
    onAutosaveFlushRequested: () => {}, // R2-C-4: power-flush bridge (not exercised here)
    closeProceed: () => {},
    // test controls
    _releaseGates: () => { const g = gates; gates = []; g.forEach((fn) => fn()); },
    _setFailNextWrite: () => { failNextWrite = true; },
    _setFlushResult: (r) => { flushResult = r; },
    _setLoadSession: (d) => { loadSessionData = d; },
    _calls: calls, _file: file
  };
  return stub;
}

function boot(initial, opts) {
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => { jsdomErrors.push(String(e.message || e)); });
  vc.on('error', (msg) => { jsdomErrors.push('console.error: ' + String(msg)); });
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'file://' + path.join(srcDir, 'index.html'), virtualConsole: vc });
  const win = dom.window;
  const stub = makeStub(initial, opts);
  win.matchtag = stub;
  win.eval(integritySrc);
  win.eval(analyticsSrc);
  win.eval(playerSeasonSrc);
  win.eval(rendererSrc);
  return { dom, win, doc: win.document, stub };
}

function click(el, opts) { el.dispatchEvent(new el.ownerDocument.defaultView.MouseEvent('click', Object.assign({ bubbles: true, cancelable: true }, opts || {}))); }
function enterTouchline(doc) { click(doc.getElementById('btnTouchlineToggle')); }
function quickBtn(doc, label) {
  return Array.from(doc.querySelectorAll('#touchlineQuickTags .touchline-tag-btn')).find((b) => b.textContent.replace(/⏱/g, '').trim() === label) || null;
}
function toastShown(doc) { const t = doc.getElementById('autosaveToast'); return !!t && t.style.display === 'flex'; }

const SQUAD = [{ id: 'player_1', number: '1', name: 'Ana One' }];

// Every observed textContent of the span, in order (flicker detector).
function spanRecorder(doc) {
  const el = saveEl(doc);
  const seen = [el.textContent];
  const mo = new doc.defaultView.MutationObserver(() => { seen.push(el.textContent); });
  mo.observe(el, { childList: true, characterData: true, subtree: true, attributes: true });
  return { seen: seen, disconnect: () => mo.disconnect() };
}

(async () => {
  // =====================================================================
  section('TE1 — INIT: element exists, clean session reads SAVED at mode entry');
  // =====================================================================
  {
    const B = boot({ squad: SQUAD });
    const doc = B.doc;
    await sleep(300);
    const rec = spanRecorder(doc);
    enterTouchline(doc);
    ok('TE1a [req A] indicator element exists inside the Touchline overlay header',
      !!saveEl(doc) && !!doc.querySelector('#touchlineOverlay .touchline-header #touchlineSaveStatus'));
    ok('TE1b [edge: initialization] unmodified session shows ✓ SAVED on entry',
      saveText(doc) === '✓ SAVED' && saveClass(doc) === 'save-status-saved',
      saveText(doc) + '/' + saveClass(doc));
    ok('TE1c nothing was written and nothing was repainted by mode entry',
      B.stub._calls.writeStart === 0 && rec.seen.length === 1);
    rec.disconnect();
  }

  // =====================================================================
  section('TE2-4 — CORE CYCLE: pending on dirty, saved on write, rapid-fire holds');
  // =====================================================================
  {
    const B = boot({ squad: SQUAD });
    const doc = B.doc;
    await sleep(300);
    enterTouchline(doc);
    const rec = spanRecorder(doc);

    // [req B] an event logs → pending.
    click(quickBtn(doc, 'Shot'));
    click(doc.getElementById('detailPanelDone'));
    ok('TE2a [req B] logging an event transitions to SAVING... (pending)',
      saveText(doc) === 'SAVING...' && saveClass(doc) === 'save-status-saving',
      saveText(doc) + '/' + saveClass(doc));
    ok('TE2b the debounced write has NOT executed yet (1500ms window)',
      B.stub._calls.writeStart === 0);

    // [req C] write executes → saved.
    await sleep(1700);
    ok('TE3a [req C] the debounced write executed exactly once',
      B.stub._calls.writeStart === 1 && B.stub._file.current && B.stub._file.current.events.length === 1,
      'writeStart=' + B.stub._calls.writeStart);
    ok('TE3b [req C] indicator flipped to ✓ SAVED the moment the write landed',
      saveText(doc) === '✓ SAVED' && saveClass(doc) === 'save-status-saved',
      saveText(doc) + '/' + saveClass(doc));

    // [req D] rapid-fire tagging: debounce EXTENDS, pending holds, no flicker.
    for (let i = 0; i < 3; i++) {
      click(quickBtn(doc, 'Card'));
      click(doc.getElementById('detailPanelDone'));
      await sleep(600);
      ok('TE4a-' + (i + 1) + ' [req D] rapid tag #' + (i + 1) + ': still SAVING... and still zero writes (debounce extended)',
        saveText(doc) === 'SAVING...' && B.stub._calls.writeStart === 1,
        saveText(doc) + '/writeStart=' + B.stub._calls.writeStart);
    }
    ok('TE4b [req D] no premature SAVED flicker during the rapid burst (text sequence exact)',
      JSON.stringify(rec.seen) === JSON.stringify(['✓ SAVED', 'SAVING...', '✓ SAVED', 'SAVING...']),
      JSON.stringify(rec.seen));

    // The burst ends; the (single, coalesced) write fires → saved.
    await sleep(1900);
    ok('TE4c [req D] burst coalesced into ONE write, indicator now ✓ SAVED',
      B.stub._calls.writeStart === 2 && saveText(doc) === '✓ SAVED',
      'writeStart=' + B.stub._calls.writeStart + '/' + saveText(doc));
    rec.disconnect();
  }

  // =====================================================================
  section('TE5 — [req E] GRID INSULATION: telemetry never touches the quick-tag grid');
  // =====================================================================
  {
    const B = boot({ squad: SQUAD });
    const doc = B.doc;
    await sleep(300);
    enterTouchline(doc);
    const grid = doc.getElementById('touchlineQuickTags');
    const gridBtns = Array.from(doc.querySelectorAll('#touchlineQuickTags .touchline-tag-btn'));
    const header = doc.querySelector('#touchlineOverlay .touchline-header');
    ok('TE5a grid captured: 16 quick-tag buttons + persistent header node',
      gridBtns.length === 16 && !!header);
    let gridMutations = 0;
    const gridMOCount = new doc.defaultView.MutationObserver(() => { gridMutations++; });
    gridMOCount.observe(grid, { childList: true, subtree: true, attributes: true, attributeOldValue: true });
    const spanRec = spanRecorder(doc);

    // Full cycle with an INSTANT tag (grid is not rebuilt by instant tags —
    // F1.4 gating), spanning several 250ms renderTouchlineAll ticks.
    click(quickBtn(doc, 'Shot'));
    click(doc.getElementById('detailPanelDone'));
    await sleep(50);
    ok('TE5b mid-cycle: SAVING... while the grid stays untouched',
      saveText(doc) === 'SAVING...' && gridMutations === 0);
    await sleep(1900);
    ok('TE5c cycle complete: ✓ SAVED',
      saveText(doc) === '✓ SAVED' && B.stub._calls.writeStart === 1);

    ok('TE5d [req E] quick-tag grid saw ZERO DOM mutations across the whole save cycle (incl. 250ms ticks)',
      gridMutations === 0, 'gridMutations=' + gridMutations);
    ok('TE5e [req E] the 16 grid buttons are the SAME node objects (no rebuild)',
      Array.from(doc.querySelectorAll('#touchlineQuickTags .touchline-tag-btn')).every((b, i) => b === gridBtns[i]) &&
      doc.getElementById('touchlineQuickTags') === grid);
    ok('TE5f [req E] only the indicator element changed (2 text transitions, header structure intact)',
      spanRec.seen.length === 3 && doc.querySelector('#touchlineOverlay .touchline-header') === header);
    spanRec.disconnect(); gridMOCount.disconnect();
  }

  // =====================================================================
  section('TE6 — MANUAL SAVE: clean state reflected immediately upon success');
  // =====================================================================
  {
    const B = boot({ squad: SQUAD });
    const doc = B.doc;
    await sleep(300);
    enterTouchline(doc);
    click(quickBtn(doc, 'Shot'));
    click(doc.getElementById('detailPanelDone'));
    ok('TE6a pending before the manual save', saveText(doc) === 'SAVING...');
    click(doc.getElementById('btnSaveSession'));
    await sleep(250);
    ok('TE6b [edge: manual save] indicator shows ✓ SAVED immediately upon save success',
      saveText(doc) === '✓ SAVED' && saveClass(doc) === 'save-status-saved',
      saveText(doc));
    ok('TE6c the debounced autosave never fired (canceled by the manual save) and the autosave file was cleared',
      B.stub._calls.writeStart === 0 && B.stub._calls.autosaveDelete >= 1 && B.stub._file.current === null);
    ok('TE6d the manual save itself carried the event',
      B.stub._calls.saveSession.length === 1 && B.stub._calls.saveSession[0].events.length === 1);
  }

  // =====================================================================
  section('TE7 — ERROR STATE: failed write paints ⚠ SAVE ERROR, UI survives, recovers');
  // =====================================================================
  {
    const B = boot({ squad: SQUAD });
    const doc = B.doc;
    await sleep(300);
    enterTouchline(doc);
    B.stub._setFailNextWrite();
    click(quickBtn(doc, 'Shot'));
    click(doc.getElementById('detailPanelDone'));
    await sleep(1700);
    ok('TE7a [edge: error] failed write → ⚠ SAVE ERROR',
      saveText(doc) === '⚠ SAVE ERROR' && saveClass(doc) === 'save-status-error',
      saveText(doc) + '/' + saveClass(doc));
    ok('TE7b the failure toast is up (existing channel, untouched)', toastShown(doc));
    ok('TE7c [edge: error] the UI did NOT crash — tagging still works and re-arms pending',
      (click(quickBtn(doc, 'Card')), click(doc.getElementById('detailPanelDone')), saveText(doc) === 'SAVING...'));
    await sleep(1900);
    ok('TE7d a subsequent successful write clears the error → ✓ SAVED (and hides the toast)',
      saveText(doc) === '✓ SAVED' && !toastShown(doc) && B.stub._calls.writeStart === 2);
    ok('TE7e no jsdom errors were raised by the error path', jsdomErrors.length === 0);
  }

  // =====================================================================
  section('TE8 — VIDEO LOADED: load path dirties, cycle runs, payload carries the video');
  // =====================================================================
  {
    const B = boot({ squad: SQUAD }, { video: { path: '/tmp/match.mp4', url: 'file:///tmp/match.mp4' } });
    const doc = B.doc;
    await sleep(300);
    enterTouchline(doc);
    click(doc.getElementById('btnOpenVideo'));
    await sleep(100);
    ok('TE8a [edge: video loaded] loading a video transitions to SAVING...',
      B.stub._calls.openVideoCalls === 1 && saveText(doc) === 'SAVING...',
      saveText(doc));
    await sleep(1700);
    ok('TE8b the write landed with the video path in the payload → ✓ SAVED',
      saveText(doc) === '✓ SAVED' && B.stub._file.current && B.stub._file.current.videoPath === '/tmp/match.mp4');
  }

  // =====================================================================
  section('TE9 — SESSION REPLACEMENT + STALE COMPLETION: immediate clean, stale paints nothing');
  // =====================================================================
  {
    const B = boot({ squad: SQUAD }, { gateWrites: true });
    const doc = B.doc;
    await sleep(300);
    enterTouchline(doc);
    click(quickBtn(doc, 'Shot'));
    click(doc.getElementById('detailPanelDone'));
    await sleep(1700);
    ok('TE9a W1 is in flight (gated) — indicator still SAVING...',
      B.stub._calls.writeStart === 1 && saveText(doc) === 'SAVING...');

    click(doc.getElementById('btnSaveSession'));
    await sleep(250);
    ok('TE9b manual save during an in-flight write → ✓ SAVED immediately (epoch bump)',
      saveText(doc) === '✓ SAVED');

    B.stub._releaseGates();
    await sleep(250);
    ok('TE9c the stale W1 completion painted NOTHING (still ✓ SAVED, no error, no toast)',
      saveText(doc) === '✓ SAVED' && saveClass(doc) === 'save-status-saved' && !toastShown(doc),
      saveText(doc) + '/' + saveClass(doc));

    // Load a saved session (clean tree → no unsaved-guard modal) — the
    // "video unloaded / replaced" case: setClean + clearAutosave.
    B.stub._setLoadSession({ videoPath: null, videoUrl: null, tags: [], events: [], squad: SQUAD, matchInfo: {}, matchClock: { clockRunning: false, period: 'PRE_MATCH' } });
    click(doc.getElementById('btnLoadSession'));
    await sleep(400);
    ok('TE9d [edge: video unloaded/replaced] load lands on ✓ SAVED (new source of truth)',
      saveText(doc) === '✓ SAVED' && B.stub._calls.loadSessionCalls === 1,
      saveText(doc));

    // The session still cycles normally afterwards (video-less).
    click(quickBtn(doc, 'Press'));
    click(doc.getElementById('detailPanelDone'));
    await sleep(50);
    ok('TE9e post-load tagging re-arms SAVING... (no-video session cycles identically)',
      saveText(doc) === 'SAVING...');
    await sleep(1700);
    ok('TE9e2 the post-load write STARTED (this boot gates writes)',
      B.stub._calls.writeStart === 2, 'writeStart=' + B.stub._calls.writeStart);
    B.stub._releaseGates();
    await sleep(200);
    ok('TE9f post-load write lands → ✓ SAVED',
      saveText(doc) === '✓ SAVED' &&
      B.stub._file.current && B.stub._file.current.events.length === 1,
      saveText(doc));
  }

  // =====================================================================
  section('TE10 — DIRTY-BUT-NO-WORK: never stuck on SAVING with nothing at risk');
  // =====================================================================
  {
    const B = boot({ squad: SQUAD });
    const doc = B.doc;
    await sleep(300);
    enterTouchline(doc);
    // Team selection dirties the session but (on an otherwise untouched
    // session) leaves nothing autosavable — no write is ever armed.
    click(doc.getElementById('tlBtnTeamOur'));
    await sleep(300);
    ok('TE10a dirty-but-no-work reads ✓ SAVED, not a stuck SAVING...',
      saveText(doc) === '✓ SAVED' && B.stub._calls.writeStart === 0,
      saveText(doc));
    ok('TE10b the stale-autosave cleanup delete ran (scheduleAutosave branch intact)',
      B.stub._calls.autosaveDelete >= 1);
  }

  // =====================================================================
  section('TE11 — CLOSE-FLUSH OUTCOME: survived-close belt mirrors the flush result');
  // =====================================================================
  {
    const B = boot({ squad: SQUAD });
    const doc = B.doc;
    await sleep(300);
    enterTouchline(doc);
    click(quickBtn(doc, 'Shot'));
    click(doc.getElementById('detailPanelDone'));
    await sleep(1700);
    ok('TE11a baseline: write landed, ✓ SAVED', saveText(doc) === '✓ SAVED');
    click(quickBtn(doc, 'Card'));
    click(doc.getElementById('detailPanelDone'));
    B.stub._setFlushResult({ ok: false, error: 'EDQUOT: quota' });
    B.win.dispatchEvent(new B.win.Event('beforeunload', { cancelable: true }));
    ok('TE11b [edge: flush failure] a failed sync close-flush paints ⚠ SAVE ERROR (window survives in jsdom)',
      saveText(doc) === '⚠ SAVE ERROR' && toastShown(doc) && B.stub._calls.flushSync.length === 1,
      saveText(doc));
    ok('TE11c the flush captured the latest events synchronously',
      B.stub._calls.flushSync[0].events.length === 2);
    // The sync flush CANCELED the pending debounced write (clearAutosaveTimer
    // inside flushAutosaveSync) — the honest state is that the error PERSISTS
    // until new work is logged and a fresh write lands.
    await sleep(1900);
    ok('TE11c2 error persists after the failed flush (no write is armed — the flush replaced it)',
      saveText(doc) === '⚠ SAVE ERROR' && B.stub._calls.writeStart === 1);
    // Recovery: new work → pending → successful write → saved.
    click(quickBtn(doc, 'Shot'));
    click(doc.getElementById('detailPanelDone')); 
    await sleep(50);
    ok('TE11c3 new work after the flush error re-arms SAVING...',
      saveText(doc) === 'SAVING...');
    await sleep(1900);
    ok('TE11d recovery: the next successful write returns to ✓ SAVED (and hides the toast)',
      saveText(doc) === '✓ SAVED' && !toastShown(doc) && B.stub._calls.writeStart === 2);
  }

  // =====================================================================
  section('RESULT');
  // =====================================================================
  const pass = results.filter((r) => r.pass).length;
  const fail = results.filter((r) => !r.pass).length;
  results.forEach((r) => { if (!r.pass) console.log('  FAIL [' + r.section + '] ' + r.name + '  | ' + r.detail); });
  console.log('\n---- touchline autosave telemetry check: ' + pass + ' passed, ' + fail + ' failed ----');
  if (jsdomErrors.length) { console.log('jsdom errors captured: ' + jsdomErrors.length); jsdomErrors.slice(0, 5).forEach((e) => console.log('  ' + e)); }
  else console.log('NOTE: jsdom does not compute CSS layout/paint. The indicator colors/sizing/header placement and real Electron IPC + disk I/O must be confirmed manually in Electron. No video/media decoding is exercised (video loading is stubbed).');
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error('TELEMETRY CHECK CRASHED:', err);
  process.exit(1);
});
