#!/usr/bin/env node
// PitchLog / MatchTag — F1.1 Touchline Mode detail-panel access
// regression harness (TD series).
// =====================================================================
// Verification-only harness. It does NOT modify any app source file.
//
// Verifies the F1.1 fix for the F6 defect found in the Phase F0 audit:
// in Touchline Mode, a quick-tag event opens the existing detail panel
// (display: block), but the touchline overlay (z-index 200) painted
// over the detail panel's normal layer (z-index 20), so the detail UI
// was unreachable. The fix layers the SAME #detailPanel element above
// the overlay while Touchline Mode is active (class .touchline-detail,
// position: fixed, z-index: 300) and removes the class on close/exit,
// leaving every desktop behavior untouched.
//
// Covered:
//   STATIC   the CSS rule exists with the right layering values
//            (200 < 300 < 1000), the base .detail-panel rule is
//            unchanged, the class is applied ONLY inside
//            openDetailPanel() under touchlineMode, and removed in
//            closeDetailPanel() + exitTouchlineMode().
//   FLOW     quick tag -> event logged BEFORE detail entry (logEvent
//            pushes and sorts before openDetailPanel).
//   NO DUP   the detail panel is NOT duplicated inside the touchline
//            overlay markup (the same element is reused).
//   jsdom    three boots with the REAL index.html + integrity.js +
//            analytics.js + player-season.js + renderer.js (same load
//            order as the app) and a stubbed window.matchtag:
//     BOOT A  touchline flow: quick tag logs the event, opens the
//             panel WITH the class, chips are interactive, Done closes
//             without corrupting the event, Escape dismisses while
//             staying in Touchline Mode, exit restores desktop
//             layering while the panel stays open, and merely
//             opening/closing the panel writes no autosave and changes
//             no event data.
//     BOOT B  desktop flow: tag button opens the panel WITHOUT the
//             class, chips still work, Done still closes.
//
// HONEST SCOPE: jsdom does not run a layout/compositing engine. This
// harness verifies the DOM/class wiring, the event flow and the static
// CSS rules — NOT the actual on-screen paint order. Visual stacking in
// the real Electron window must be confirmed manually (see report).
//
// Run:  node tests/touchline-detail-access-check.js   (from the project root)
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
const cssSrc = fs.readFileSync(path.join(srcDir, 'styles.css'), 'utf-8');
const integritySrc = fs.readFileSync(path.join(srcDir, 'integrity.js'), 'utf-8');
const analyticsSrc = fs.readFileSync(path.join(srcDir, 'analytics.js'), 'utf-8');
const playerSeasonSrc = fs.readFileSync(path.join(srcDir, 'player-season.js'), 'utf-8');
const rendererSrc = fs.readFileSync(path.join(srcDir, 'renderer.js'), 'utf-8');

const results = [];
let SECTION = '(pre)';
function section(name) { SECTION = name; console.log('\n===== ' + name + ' ====='); }
function ok(name, cond, detail) {
  results.push({ section: SECTION, name, pass: !!cond, detail: detail === undefined ? '' : String(detail) });
  if (!cond) console.log('  FAIL: ' + name + (detail === undefined ? '' : '  | ' + detail));
}

const jsdomErrors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function clone(x) { return x == null ? x : JSON.parse(JSON.stringify(x)); }

// Extract a full CSS rule block (selector {...}) from the stylesheet text.
function cssRule(selector) {
  const re = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}');
  const m = cssSrc.match(re);
  return m ? m[1] : '';
}
function cssNumber(block, prop) {
  if (!block) return null;
  const m = block.match(new RegExp(prop + '\\s*:\\s*(-?\\d+(?:\\.\\d+)?)'));
  return m ? parseFloat(m[1]) : null;
}

// ---------------------------------------------------------------------------
// Static source-level checks
// ---------------------------------------------------------------------------
section('STATIC — F1.1 wiring (source-level checks)');
{
  const tdRule = cssRule('.detail-panel.touchline-detail');
  ok('TD-S1: styles.css defines .detail-panel.touchline-detail { position: fixed; z-index: 300 }',
    /position\s*:\s*fixed/.test(tdRule) && cssNumber(tdRule, 'z-index') === 300,
    tdRule ? 'rule found' : 'rule missing');

  const overlayRule = cssRule('.touchline-overlay');
  const overlayZ = cssNumber(overlayRule, 'z-index');
  const toastRule = cssRule('.autosave-toast');
  const toastZ = cssNumber(toastRule, 'z-index');
  ok('TD-S2: layer order overlay < touchline detail < toast',
    overlayZ !== null && overlayZ < 300 && toastZ !== null && 300 < toastZ,
    'overlay=' + overlayZ + ' detail=300 toast=' + toastZ);

  const baseRule = cssRule('.detail-panel');
  ok('TD-S3: base .detail-panel rule unchanged (absolute, z-index 20 — desktop layer preserved)',
    /position\s*:\s*absolute/.test(baseRule) && cssNumber(baseRule, 'z-index') === 20,
    baseRule ? 'base rule found' : 'base rule missing');

  ok('TD-S4: openDetailPanel adds the class only under touchlineMode',
    /if \(touchlineMode\) detailPanel\.classList\.add\('touchline-detail'\)/.test(rendererSrc));

  const closeFn = rendererSrc.slice(
    rendererSrc.indexOf('function closeDetailPanel()'),
    rendererSrc.indexOf('function closeDetailPanel()') + 400
  );
  ok('TD-S5: closeDetailPanel removes the class',
    /detailPanel\.classList\.remove\('touchline-detail'\)/.test(closeFn),
    closeFn ? 'close body found' : 'close body missing');

  const exitFn = rendererSrc.slice(
    rendererSrc.indexOf('function exitTouchlineMode()'),
    rendererSrc.indexOf('function exitTouchlineMode()') + 700
  );
  ok('TD-S6: exitTouchlineMode removes the class',
    /detailPanel\.classList\.remove\('touchline-detail'\)/.test(exitFn),
    exitFn ? 'exit body found' : 'exit body missing');

  // Quick tag is logged BEFORE detail entry: inside logEvent the event is
  // pushed and the list re-rendered before openDetailPanel is called.
  const logFnStart = rendererSrc.indexOf('function logEvent(tag)');
  const logFnEnd = rendererSrc.indexOf('let lastLoggedEventId', logFnStart);
  const logFn = logFnStart > -1 && logFnEnd > logFnStart ? rendererSrc.slice(logFnStart, logFnEnd) : '';
  ok('TD-S7: logEvent pushes/sorts the event before openDetailPanel',
    logFn.indexOf('events.push(event)') > -1 &&
    logFn.indexOf('openDetailPanel(tag, event)') > -1 &&
    logFn.indexOf('events.push(event)') < logFn.indexOf('openDetailPanel(tag, event)'),
    logFn ? 'logEvent body found' : 'logEvent body missing');

  // The touchline overlay must NOT contain its own detail panel: the same
  // #detailPanel element is reused.
  const overlayStart = html.indexOf('id="touchlineOverlay"');
  const overlayEnd = html.indexOf('<main', overlayStart);
  const overlayBlock = overlayStart > -1 && overlayEnd > overlayStart ? html.slice(overlayStart, overlayEnd) : '';
  const detailPanelCount = (html.match(/id="detailPanel"/g) || []).length;
  ok('TD-S8: exactly one detail panel in the document and none inside the touchline overlay',
    detailPanelCount === 1 && overlayBlock.length > 0 && !overlayBlock.includes('detailPanel'),
    'count=' + detailPanelCount);

  ok('TD-S9: the detail panel Done button is still wired to closeDetailPanel',
    /detailPanelDone'\)\.addEventListener\('click', closeDetailPanel\)/.test(rendererSrc));

  // Entering touchline must not change panel state (existing behavior).
  // enterTouchlineMode is a one-line function; bound the slice to that line
  // (sanity-gated on renderTouchlineQuickTags so a re-format fails loudly
  // instead of silently testing the wrong text).
  const enterStart = rendererSrc.indexOf('function enterTouchlineMode()');
  const enterLineEnd = rendererSrc.indexOf('\n', enterStart);
  const enterFn = enterStart > -1 && enterLineEnd > enterStart ? rendererSrc.slice(enterStart, enterLineEnd) : '';
  ok('TD-S10: enterTouchlineMode does not touch the detail panel',
    enterFn.includes('renderTouchlineQuickTags') && !/detailPanel|closeDetailPanel|touchline-detail/.test(enterFn),
    enterFn ? 'enter body found' : 'enter body missing');

  // Closing the panel must stay a pure visibility change (no data impact).
  ok('TD-S11: closeDetailPanel performs no data mutation (no markAutosaveDirty, no events access)',
    closeFn.length > 0 && !/markAutosaveDirty|events/.test(closeFn));

  // Exactly one place adds the class (openDetailPanel) — no duplicated
  // toggling elsewhere.
  const addCount = (rendererSrc.match(/classList\.add\('touchline-detail'\)/g) || []).length;
  const removeCount = (rendererSrc.match(/classList\.remove\('touchline-detail'\)/g) || []).length;
  ok('TD-S12: class is added in exactly one place and removed in exactly two (close + exit)',
    addCount === 1 && removeCount === 2, 'add=' + addCount + ' remove=' + removeCount);
}

// ---------------------------------------------------------------------------
// jsdom boots
// ---------------------------------------------------------------------------
function makeStub(initial) {
  const calls = { saveSession: [], autosaveWrite: [], saveSquad: [] };
  const stub = {
    openVideo: async () => null,
    saveSession: async (d) => { calls.saveSession.push(clone(d)); return { canceled: false, filePath: '/tmp/td-session.json' }; },
    exportCsv: async () => ({ canceled: true }),
    exportClipPlaylist: async () => ({ canceled: true }),
    loadSession: async () => null,
    loadMultipleSessions: async () => [],
    loadSquad: async () => clone(initial.squad || []),
    saveSquad: async (s) => { calls.saveSquad.push(clone(s)); return true; },
    detachVideo: async () => true,
    reattachVideo: async () => true,
    sendVideoCommand: () => {},
    onVideoState: () => {},
    onVideoClosed: () => {},
    autosaveRead: async () => null,
    autosaveWrite: async (d) => { calls.autosaveWrite.push(clone(d)); return { ok: true, path: '/tmp/autosave.json' }; },
    autosaveDelete: async () => ({ ok: true }),
    autosaveFlushSync: () => {},
    onCloseRequested: () => {},
    closeProceed: () => {},
    _calls: calls
  };
  return stub;
}

function boot(initial) {
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => { jsdomErrors.push(String(e.message || e)); });
  vc.on('error', (msg) => { jsdomErrors.push('console.error: ' + String(msg)); });
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'file://' + path.join(srcDir, 'index.html'), virtualConsole: vc });
  const win = dom.window;
  const stub = makeStub(initial);
  win.matchtag = stub;
  win.eval(integritySrc);
  win.eval(analyticsSrc);
  win.eval(playerSeasonSrc);
  win.eval(rendererSrc);
  return { dom, win, doc: win.document, stub };
}

function click(el) { el.dispatchEvent(new (el.ownerDocument.defaultView.MouseEvent || window.Event)('click', { bubbles: true, cancelable: true })); }
function quickTagBtn(doc, label) {
  return Array.from(doc.querySelectorAll('#touchlineQuickTags .touchline-tag-btn')).find((b) => b.textContent === label) || null;
}
function desktopTagBtn(doc, label) {
  return Array.from(doc.querySelectorAll('#tagButtons .tag-btn')).find((b) => b.textContent.replace(/⏱/g, '').trim().indexOf(label) === 0) || null;
}

(async () => {
  // =====================================================================
  section('BOOT A — touchline flow: quick tag -> reachable, dismissible, data-safe detail panel');
  // =====================================================================
  {
    const A = boot({ squad: [
      { id: 'player_1', number: '1', name: 'Ana One' },
      { id: 'player_2', number: '2', name: 'Ben Two' }
    ] });
    const doc = A.doc;
    const panel = doc.getElementById('detailPanel');
    const overlay = doc.getElementById('touchlineOverlay');
    await sleep(300);

    click(doc.getElementById('btnTouchlineToggle'));
    await sleep(50);
    ok('TD1: entering Touchline Mode shows the overlay',
      overlay.style.display === 'flex' && doc.getElementById('btnTouchlineToggle').textContent === 'Desktop Mode',
      'display=' + overlay.style.display);

    // --- quick tag on a DEFAULT tag with full detail options (Shot) ---
    click(quickTagBtn(doc, 'Shot'));
    await sleep(50);
    const recent = doc.getElementById('touchlineRecentEvents');
    ok('TD2: quick tag creates the event (touchline recent list shows it)',
      recent.textContent.indexOf('Shot') > -1, recent.textContent.slice(0, 80));
    ok('TD3: the existing detail panel is opened (display: block)',
      panel.style.display === 'block', 'display=' + panel.style.display);
    ok('TD4: the detail panel carries .touchline-detail (layered above the overlay)',
      panel.classList.contains('touchline-detail'), 'class=' + panel.className);
    ok('TD5: the panel shows the tagged event (title contains the label)',
      /Shot/.test(panel.textContent), panel.textContent.slice(0, 60));
    ok('TD6: the panel reuses the full detail markup (subtype chips present)',
      !!panel.querySelector('.chip[data-kind="subtype"][data-value="On target"]'));

    // --- the panel is interactive, not just visible ---
    click(panel.querySelector('.chip[data-kind="subtype"][data-value="On target"]'));
    await sleep(50);
    ok('TD7: subtype chip selection works through the panel (event mutated)',
      !!panel.querySelector('.chip[data-kind="subtype"][data-value="On target"].selected'));

    // --- dismiss via Done: stays in touchline, event survives ---
    click(doc.getElementById('detailPanelDone'));
    await sleep(50);
    ok('TD8: Done closes the panel and removes the touchline layering class',
      panel.style.display === 'none' && !panel.classList.contains('touchline-detail'),
      'display=' + panel.style.display + ' class=' + panel.className);
    ok('TD9: dismissing the panel does NOT exit Touchline Mode',
      overlay.style.display === 'flex');
    ok('TD10: the event is still there after dismissing the panel (no corruption)',
      doc.getElementById('touchlineRecentEvents').textContent.indexOf('Shot') > -1);

    await sleep(1900); // autosave debounce (1500ms) + margin
    const writes = A.stub._calls.autosaveWrite;
    ok('TD11: the quick tag + detail edit were autosaved (1 event, subtype recorded)',
      writes.length >= 1 &&
      writes[writes.length - 1].events.length === 1 &&
      writes[writes.length - 1].events[0].label === 'Shot' &&
      writes[writes.length - 1].events[0].subtype === 'On target',
      'writes=' + writes.length);

    // --- auto-created flat quick tag (Chance is not a default tag) ---
    click(quickTagBtn(doc, 'Chance'));
    await sleep(50);
    ok('TD12: flat auto-created quick tag also opens the reachable panel',
      panel.style.display === 'block' && panel.classList.contains('touchline-detail') && /Chance/.test(panel.textContent));
    ok('TD13: second event logged (2 events in the touchline recent list)',
      doc.querySelectorAll('#touchlineRecentEvents .touchline-recent-item').length === 2 &&
      doc.getElementById('touchlineRecentEvents').textContent.indexOf('Chance') > -1,
      'items=' + doc.querySelectorAll('#touchlineRecentEvents .touchline-recent-item').length);

    // --- Escape dismisses the panel while staying in touchline ---
    A.win.dispatchEvent(new A.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(50);
    ok('TD14: Escape dismisses the detail panel without leaving Touchline Mode',
      panel.style.display === 'none' && !panel.classList.contains('touchline-detail') && overlay.style.display === 'flex');

    // --- exit touchline while the panel is open: desktop layering restored ---
    click(quickTagBtn(doc, 'Cross'));
    await sleep(50);
    ok('TD14a: third quick tag reopens the panel above the overlay',
      panel.style.display === 'block' && panel.classList.contains('touchline-detail'));
    click(doc.getElementById('btnExitTouchline'));
    await sleep(50);
    ok('TD15: Exit Touchline hides the overlay',
      overlay.style.display === 'none' && doc.getElementById('btnTouchlineToggle').textContent === 'Touchline Mode');
    ok('TD16: panel stays open on exit (existing behavior) AND desktop layering is restored (class removed)',
      panel.style.display === 'block' && !panel.classList.contains('touchline-detail'),
      'display=' + panel.style.display + ' class=' + panel.className);

    // --- open/close must be data-neutral ---
    click(doc.getElementById('detailPanelDone'));
    await sleep(50);
    await sleep(1900); // let every pending debounced write settle
    const beforeCount = A.stub._calls.autosaveWrite.length;
    const beforeEvents = beforeCount ? clone(A.stub._calls.autosaveWrite[beforeCount - 1].events) : null;

    // Reopen WITHOUT creating a new event: desktop event-row edit path.
    const editBtn = doc.querySelector('.event-row .event-edit');
    ok('TD17: desktop event-row edit reopens the panel with NO touchline class',
      !!editBtn &&
      (click(editBtn), true) &&
      panel.style.display === 'block' && !panel.classList.contains('touchline-detail') && /Shot/.test(panel.textContent),
      editBtn ? 'edit button found' : 'no event rows');
    click(doc.getElementById('detailPanelDone'));
    await sleep(50);
    await sleep(1900); // enough for any write that open/close might have scheduled
    const afterCount = A.stub._calls.autosaveWrite.length;
    const afterEvents = afterCount ? clone(A.stub._calls.autosaveWrite[afterCount - 1].events) : null;
    ok('TD18: merely opening/closing the panel schedules NO autosave write',
      afterCount === beforeCount, 'before=' + beforeCount + ' after=' + afterCount);
    ok('TD19: event data is byte-identical before/after open+close',
      JSON.stringify(beforeEvents) === JSON.stringify(afterEvents));

    A.dom.window.close();
  }

  // =====================================================================
  section('BOOT B — desktop flow unchanged');
  // =====================================================================
  {
    const B = boot({ squad: [
      { id: 'player_1', number: '1', name: 'Ana One' },
      { id: 'player_2', number: '2', name: 'Ben Two' }
    ] });
    const doc = B.doc;
    const panel = doc.getElementById('detailPanel');
    await sleep(300);

    click(desktopTagBtn(doc, 'Shot'));
    await sleep(50);
    const rowCount = doc.querySelectorAll('.event-row').length;
    ok('TD20: desktop tag button still creates the event',
      rowCount === 1, 'rows=' + rowCount);
    ok('TD21: desktop tag still opens the detail panel',
      panel.style.display === 'block', 'display=' + panel.style.display);
    ok('TD22: desktop open does NOT apply the touchline layering class',
      !panel.classList.contains('touchline-detail'), 'class=' + panel.className);

    click(panel.querySelector('.chip[data-kind="subtype"][data-value="Blocked"]'));
    await sleep(50);
    click(doc.getElementById('detailPanelDone'));
    await sleep(50);
    ok('TD23: desktop panel interaction + Done close still work',
      panel.style.display === 'none' && !panel.classList.contains('touchline-detail'));

    await sleep(1900);
    const writes = B.stub._calls.autosaveWrite;
    ok('TD24: desktop detail edit still autosaved correctly (Shot / Blocked)',
      writes.length >= 1 &&
      writes[writes.length - 1].events.length === 1 &&
      writes[writes.length - 1].events[0].subtype === 'Blocked',
      'writes=' + writes.length);

    B.dom.window.close();
  }

  // ---------------------------------------------------------------------
  // Report
  // ---------------------------------------------------------------------
  section('RESULTS');
  let pass = 0, fail = 0;
  results.forEach((r) => { if (r.pass) pass++; else fail++; });
  results.forEach((r) => {
    if (!r.pass) console.log('  FAIL [' + r.section + '] ' + r.name + (r.detail ? '  (' + r.detail + ')' : ''));
  });
  if (jsdomErrors.length) {
    console.log('  jsdom errors captured: ' + jsdomErrors.length);
    jsdomErrors.slice(0, 10).forEach((e) => console.log('    ' + e));
    fail += jsdomErrors.length;
  }
  console.log('---- touchline detail access check: ' + pass + ' passed, ' + fail + ' failed ----');
  console.log('NOTE: jsdom does not compute CSS layout/paint — the real on-screen');
  console.log('stacking (overlay under panel) still requires manual Electron');
  console.log('verification. This harness verifies wiring + static CSS only.');
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('HARNESS CRASH:', err && err.stack ? err.stack : err);
  process.exit(1);
});
