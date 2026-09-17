#!/usr/bin/env node
// PitchLog / MatchTag — F2.3 Touchline Cancel Active Interval regression
// harness (CX series).
// =====================================================================
// Verification-only harness. It does NOT modify any app source file.
//
// Verifies F2.3: an active (recording) interval quick-tag button in
// Touchline Mode is wrapped in a cell with a small ✕ cancel button at its
// corner. Tapping the ✕ aborts the in-progress interval WITHOUT logging an
// event: it deletes the activeIntervals entry (in-memory only — never part
// of the autosave payload), performs NO autosave write, leaves the undo
// stack untouched, and re-renders both tag grids so the recording state
// clears instantly and the system is immediately ready to tag again.
//
// Checks:
//   STATIC  CX-S1..S11 — F2.3 wiring + preservation pins for every shared
//           path (handleTagPress / startInterval / finishInterval /
//           undoLastTag / buildAutosaveData payload / grid re-render
//           gating / existing load+recovery interval resets / CSS).
//   BOOT C1 core cancel: ✕ visible while recording [A], state cleared [B],
//           NO event [C], NO autosave write (debounce-settled, byte-stable
//           file), undo disabled [E], rapid double-✕ no-op, clock alive.
//   BOOT C2 edge 1 — cancel IMMEDIATELY after start (0s elapsed), then
//           immediately start again.
//   BOOT C3 edge 2 + [D] — cancel, then immediately start a NEW interval
//           and finish it: exactly one well-formed event (≈15s bounds),
//           quick tag logging continues, analytics count the new interval.
//   BOOT C4 edge 3 — undo interplay: undo after a cancel removes the last
//           LOGGED event (Shot), never "the cancel"; second undo no-op.
//   BOOT C5 edge 4 — F2.2 recent-events feed interplay: the feed only
//           shows completed events — cancel changes nothing.
//   BOOT C6 — cancel while the F2.2 player picker is open: picker survives,
//           feed stays frozen, Done unfreezes to the truth.
//   BOOT C7 — desktop mirror: desktop-started interval shows the ✕ on
//           touchline entry; cancel clears BOTH UIs (desktop grid at rest).
//   BOOT C8 — save→load after a cancel: the session payload carries no
//           junk from the canceled interval; a loaded session can start
//           and finish fresh intervals.
//
// HONEST SCOPE: jsdom does not compute CSS layout/paint (the ✕ corner
// position/size and its hit-target ergonomics must be confirmed manually
// in Electron). jsdom does not decode media; the no-video match-clock
// domain is used (the cancel code is video-independent).
//
// Run:  node tests/touchline-cancel-check.js   (from the project root)
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
  console.error('Boot the jsdom sandbox first (see tests/f2-f3-fix-check.js header).');
  process.exit(2);
}

const srcDir = path.join(__dirname, '..', 'src');
const html = fs.readFileSync(path.join(srcDir, 'index.html'), 'utf8');
const integritySrc = fs.readFileSync(path.join(srcDir, 'integrity.js'), 'utf8');
const analyticsSrc = fs.readFileSync(path.join(srcDir, 'analytics.js'), 'utf8');
const playerSeasonSrc = fs.readFileSync(path.join(srcDir, 'player-season.js'), 'utf8');
const rendererSrc = fs.readFileSync(path.join(srcDir, 'renderer.js'), 'utf8');
const stylesSrc = fs.readFileSync(path.join(srcDir, 'styles.css'), 'utf8');

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

function fnBody(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) return '';
  const next = src.indexOf('\n  function ', start + 10);
  return start > -1 && next > start ? src.slice(start, next) : src.slice(start, start + 3000);
}

// ---------------------------------------------------------------------------
// Static source-level checks
// ---------------------------------------------------------------------------
section('STATIC — F2.3 wiring (source-level checks)');
{
  const gridFn = fnBody(rendererSrc, 'renderTouchlineQuickTags');
  const cancelFn = fnBody(rendererSrc, 'cancelTouchlineInterval');
  const rtaStart = rendererSrc.indexOf('function renderTouchlineAll(');
  const rtaFn = rtaStart === -1 ? '' : rendererSrc.slice(rtaStart, rtaStart + 6000);
  const autosaveFn = fnBody(rendererSrc, 'buildAutosaveData');

  ok('CX-S1: recording quick tags are wrapped in a cell with a ✕ cancel button (stopPropagation → cancelTouchlineInterval)',
    /className = 'tl-tag-cell'/.test(gridFn) &&
    /className = 'tl-tag-cancel'/.test(gridFn) &&
    /cell\.appendChild\(btn\);/.test(gridFn) &&
    /e\.stopPropagation\(\); cancelTouchlineInterval\(label\);/.test(gridFn) &&
    /aria-label', 'Cancel ' \+ label \+ ' interval'/.test(gridFn));
  ok('CX-S2: cancelTouchlineInterval guards, deletes the key, re-renders both grids — and pushes NO event, NO autosave, NO undo touch',
    /if \(!Object\.prototype\.hasOwnProperty\.call\(activeIntervals, label\)\) return;/.test(cancelFn) &&
    /delete activeIntervals\[label\];/.test(cancelFn) &&
    /renderTouchlineQuickTags\(\);/.test(cancelFn) &&
    /renderTagButtons\(\);/.test(cancelFn) &&
    !/events\.push/.test(cancelFn) &&
    !/markAutosaveDirty/.test(cancelFn) &&
    !/lastLoggedEventId/.test(cancelFn) &&
    !/renderEventList/.test(cancelFn) &&
    !/openDetailPanel/.test(cancelFn));
  ok('CX-S3: preservation — handleTagPress interval toggle untouched (finish-if-recording, else start)',
    /if \(tag\.interval\) \{[\s\S]*?finishInterval\(tag\)[\s\S]*?startInterval\(tag\)/.test(fnBody(rendererSrc, 'handleTagPress')));
  ok('CX-S4: preservation — startInterval still captures BOTH clocks + period (and no team snapshot)',
    /activeIntervals\[tag\.label\] = \{/.test(fnBody(rendererSrc, 'startInterval')) &&
    /startTime: getCurrentTime\(\)/.test(fnBody(rendererSrc, 'startInterval')) &&
    /startMatchSeconds: getCurrentMatchSeconds\(\)/.test(fnBody(rendererSrc, 'startInterval')) &&
    /startPeriod: matchClock\.period/.test(fnBody(rendererSrc, 'startInterval')) &&
    !/team/.test(fnBody(rendererSrc, 'startInterval')));
  ok('CX-S5: preservation — finishInterval unchanged (guard, delete, isInterval event, undo id, autosave dirty)',
    /const active = activeIntervals\[tag\.label\];/.test(fnBody(rendererSrc, 'finishInterval')) &&
    /delete activeIntervals\[tag\.label\];/.test(fnBody(rendererSrc, 'finishInterval')) &&
    /isInterval: true/.test(fnBody(rendererSrc, 'finishInterval')) &&
    /events\.push\(event\);/.test(fnBody(rendererSrc, 'finishInterval')) &&
    /markAutosaveDirty\(\);/.test(fnBody(rendererSrc, 'finishInterval')));
  ok('CX-S6: preservation — undoLastTag untouched (still removes only the last LOGGED event)',
    /if \(lastLoggedEventId == null\) return;/.test(fnBody(rendererSrc, 'undoLastTag')) &&
    /applyGoalRemovalScoreCorrection\(undoneEvent\);/.test(fnBody(rendererSrc, 'undoLastTag')));
  ok('CX-S7: architecture — the autosave payload has NO activeIntervals (a cancel never needs a write)',
    /events,/.test(autosaveFn) && /matchClock/.test(autosaveFn) && !/activeIntervals/.test(autosaveFn));
  ok('CX-S8: CSS present — relative cell, filled button, corner ✕ (secondary, inside the button box so the scrollable grid never clips it)',
    /\.tl-tag-cell\s*\{[^}]*position: relative;[^}]*display: flex;/.test(stylesSrc) &&
    /\.tl-tag-cell \.touchline-tag-btn\s*\{[^}]*flex: 1 1 auto;/.test(stylesSrc) &&
    /\.tl-tag-cancel\s*\{[^}]*position: absolute;[^}]*top: 2px; right: 2px;[^}]*width: 26px;/.test(stylesSrc) &&
    /\.tl-tag-cancel:active\s*\{/.test(stylesSrc));
  ok('CX-S9: grid gating unchanged — quick-tag taps re-render the grid only for interval tags; the 250ms renderTouchlineAll never rebuilds it',
    /if \(tag\.interval\) renderTouchlineQuickTags\(\);/.test(gridFn) &&
    rtaFn.indexOf('touchlineQuickTags') === -1);
  ok('CX-S10: QUICK_TAGS unchanged (16 entries, Possession first — F2.1 pinned)',
    /const QUICK_TAGS = \['Possession','Shot','Chance','Cross','Key Pass','Press','Press Win','Turnover','Recovery','Interception','Duel','Positive Transition','Negative Transition','Goal','Card','Sub'\];/.test(rendererSrc));
  ok('CX-S11: existing interval-reset paths preserved (load-session + autosave recovery still clear activeIntervals)',
    // 3 occurrences = the initial `let activeIntervals = {}` declaration (846)
    // + the load-session reset (3838) + the autosave-recovery reset (4588).
    (rendererSrc.match(/activeIntervals = \{\};/g) || []).length === 3);
}

// ---------------------------------------------------------------------------
// jsdom boots
// ---------------------------------------------------------------------------
function makeStub(initial) {
  const calls = { saveSession: [], autosaveWrite: [], flushSync: [], loadSessionCalls: 0 };
  const file = { current: null };
  let loadSessionData = null;
  const stub = {
    openVideo: async () => null,
    saveSession: async (d) => { calls.saveSession.push(clone(d)); return { canceled: false, filePath: '/tmp/cx-session.json' }; },
    exportCsv: async () => ({ canceled: true }),
    exportClipPlaylist: async () => ({ canceled: true }),
    loadSession: async () => { calls.loadSessionCalls++; return clone(loadSessionData); },
    loadMultipleSessions: async () => [],
    loadSquad: async () => clone(initial.squad || []),
    saveSquad: async (s) => true,
    detachVideo: async () => true,
    reattachVideo: async () => true,
    sendVideoCommand: () => {},
    onVideoState: () => {},
    onVideoClosed: () => {},
    autosaveRead: async () => null,
    autosaveWrite: async (d) => { calls.autosaveWrite.push(clone(d)); file.current = clone(d); return { ok: true, path: '/tmp/autosave.json' }; },
    autosaveDelete: async () => { file.current = null; return { ok: true }; },
    autosaveFlushSync: (d) => { calls.flushSync.push(clone(d)); file.current = d === null ? null : clone(d); return { ok: true }; },
    onCloseRequested: () => {},
    onAutosaveFlushRequested: () => {}, // R2-C-4: power-flush bridge (not exercised here)
    closeProceed: () => {},
    _setLoadSession: (d) => { loadSessionData = d; },
    _calls: calls, _file: file
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

function click(el) { el.dispatchEvent(new el.ownerDocument.defaultView.MouseEvent('click', { bubbles: true, cancelable: true })); }
function quickBtn(doc, label, recording) {
  const exact = recording ? label + ' ⏱' : label;
  return Array.from(doc.querySelectorAll('#touchlineQuickTags .touchline-tag-btn')).find((b) => b.textContent === exact) || null;
}
function cancelBtn(doc) { return doc.querySelector('#touchlineQuickTags .tl-tag-cancel'); }
function desktopTagBtn(doc, label) {
  return Array.from(doc.querySelectorAll('#tagButtons .tag-btn')).find((b) => b.textContent.replace(/⏱/g, '').replace(/Recording…/g, '').trim().indexOf(label) === 0) || null;
}
function feedItems(doc) { return Array.from(doc.querySelectorAll('#touchlineRecentEvents .touchline-recent-item')); }
function eventRows(doc) { return Array.from(doc.querySelectorAll('#eventList .event-row')); }
function pickerEl(doc) { return doc.getElementById('touchlinePlayerPicker'); }

// Advance the jsdom window's clock by `ms` (the renderer's match clock reads
// Date.now() inside the window context). Each call advances by exactly `ms`
// from the current simulated time. Saved/restored per boot.
function patchDate(win, ms) {
  win.eval('window.__cxOrigNow = Date.now; window.__cxT0 = Date.now(); Date.now = () => window.__cxT0 + ' + ms + ';');
}
function restoreDate(win) {
  win.eval('Date.now = window.__cxOrigNow; delete window.__cxOrigNow; delete window.__cxT0;');
}

const SQUAD = [
  { id: 'player_1', number: '1', name: 'Ana One' },
  { id: 'player_2', number: '2', name: 'Ben Two' }
];

(async () => {
  // =====================================================================
  section('BOOT C1 — core cancel: ✕ visible [A], state cleared [B], no event [C], no autosave, undo untouched [E], rapid taps, clock alive');
  // =====================================================================
  {
    const B = boot({ squad: SQUAD });
    const doc = B.doc;
    await sleep(300);

    click(doc.getElementById('btnTouchlineToggle'));
    click(doc.getElementById('tlBtnStart'));
    // Let the clock-start autosave (matchClock IS in the payload) settle so
    // the "cancel caused no write" proof compares a settled baseline.
    await sleep(1700);
    const writesBefore = B.stub._calls.autosaveWrite.length;
    const fileBefore = clone(B.stub._file.current);

    click(quickBtn(doc, 'Possession')); // start the interval
    ok('C1a: the recording quick tag shows the ⏱ state and a ✕ cancel button [req A]',
      !!quickBtn(doc, 'Possession', true) && !!cancelBtn(doc),
      'recBtn=' + !!quickBtn(doc, 'Possession', true) + ' cancel=' + !!cancelBtn(doc));
    ok('C1b: the grid still renders exactly 16 quick-tag buttons (the ✕ carries its own class — no layout/selectors broken)',
      doc.querySelectorAll('#touchlineQuickTags .touchline-tag-btn').length === 16);
    ok('C1c: the ✕ sits INSIDE the recording button\'s cell (sibling of the tag button)',
      (() => { const x = cancelBtn(doc); return !!x && !!x.parentElement.classList.contains('tl-tag-cell') && x.parentElement.querySelector('.touchline-tag-btn.recording') !== null; })());

    patchDate(B.win, 25000); // 25s of match time — a junk event would carry 25s bounds

    const x = cancelBtn(doc);
    click(x); // CANCEL
    click(x); // rapid second tap on the detached ✕ — guard must no-op
    ok('C1d: cancel clears the active-interval UI (button at rest, ✕ gone) [req B]',
      !!quickBtn(doc, 'Possession') && !quickBtn(doc, 'Possession').classList.contains('recording') && !cancelBtn(doc) && !quickBtn(doc, 'Possession', true));
    ok('C1e: NO event was added to the events array (0 desktop rows) [req C]',
      eventRows(doc).length === 0, 'rows=' + eventRows(doc).length);
    ok('C1f: the touchline undo button stays disabled — nothing was logged, the undo stack is untouched [req E]',
      doc.getElementById('tlBtnUndo').disabled === true);
    ok('C1g: the recent-events feed is empty (it only ever shows completed events)',
      feedItems(doc).length === 0);

    await sleep(1700); // past the 1500ms autosave debounce
    ok('C1h: cancel triggered NO autosave write (write count and file byte-stable)',
      B.stub._calls.autosaveWrite.length === writesBefore && JSON.stringify(B.stub._file.current) === JSON.stringify(fileBefore),
      'writes ' + writesBefore + '→' + B.stub._calls.autosaveWrite.length);
    ok('C1i: the match clock is still running after the cancel (pause enabled, start disabled)',
      doc.getElementById('tlBtnPause').disabled === false && doc.getElementById('tlBtnStart').disabled === true);

    restoreDate(B.win);
    B.dom.window.close();
  }

  // =====================================================================
  section('BOOT C2 — edge 1: cancel IMMEDIATELY after start; system instantly re-startable');
  // =====================================================================
  {
    const B = boot({ squad: SQUAD });
    const doc = B.doc;
    await sleep(300);

    click(doc.getElementById('btnTouchlineToggle'));
    click(doc.getElementById('tlBtnStart'));

    click(quickBtn(doc, 'Possession')); // start…
    click(cancelBtn(doc));              // …and cancel IMMEDIATELY (0s elapsed)
    ok('C2a: an immediate cancel (0s elapsed) leaves no event and the button at rest',
      eventRows(doc).length === 0 && !!quickBtn(doc, 'Possession') && !cancelBtn(doc));
    ok('C2b: the feed stays empty',
      feedItems(doc).length === 0);

    click(quickBtn(doc, 'Possession')); // immediately start AGAIN
    ok('C2c: a new interval can be started immediately after a cancel (fresh recording state + ✕)',
      !!quickBtn(doc, 'Possession', true) && !!cancelBtn(doc));
    click(cancelBtn(doc));
    ok('C2d: and canceled again just as cleanly',
      eventRows(doc).length === 0 && !cancelBtn(doc) && !!quickBtn(doc, 'Possession'));

    B.dom.window.close();
  }

  // =====================================================================
  section('BOOT C3 — edge 2 + [D]: cancel → immediately start a NEW interval → finish; quick tags + analytics all work');
  // =====================================================================
  {
    const B = boot({ squad: SQUAD });
    const doc = B.doc;
    await sleep(300);

    click(doc.getElementById('btnTouchlineToggle'));
    click(doc.getElementById('tlBtnStart'));

    click(quickBtn(doc, 'Possession'));
    patchDate(B.win, 25000);          // 25s of "accidental" interval
    click(cancelBtn(doc));            // abort it
    click(quickBtn(doc, 'Possession')); // immediately start the REAL one
    patchDate(B.win, 15000);          // 15s of real possession
    click(quickBtn(doc, 'Possession', true)); // finish (tap the big button = primary stop action)
    click(doc.getElementById('detailPanelDone'));
    ok('C3a: exactly ONE interval event exists after cancel → new interval → finish [req D]',
      eventRows(doc).length === 1, 'rows=' + eventRows(doc).length);

    click(quickBtn(doc, 'Shot')); // quick tags still log immediately
    click(doc.getElementById('detailPanelDone'));
    ok('C3b: a quick tag logs immediately after the whole cancel cycle [req D]',
      eventRows(doc).length === 2);

    await sleep(1700);
    const saved = B.stub._file.current;
    const events = saved && saved.events || [];
    const poss = events.find((e) => e.label === 'Possession');
    ok('C3c: the new interval event is well-formed and bounded by the NEW start (≈15s, not 40s)',
      !!poss && poss.isInterval === true && Math.abs((poss.endTime - poss.startTime) - 15) <= 2,
      'bounds=' + (poss && (poss.startTime + '→' + poss.endTime)));
    ok('C3d: no junk event from the canceled interval (exactly 2 events: Possession + Shot)',
      events.length === 2 && events.filter((e) => e.label === 'Possession').length === 1);

    const R = B.win.AnalyticsEngine.computeMatchAnalytics(saved);
    const P = R && R.level1 && R.level1.possession && R.level1.possession.our;
    const T = R && R.level1 && R.level1.team && R.level1.team.our;
    ok('C3e: analytics count the new possession interval (1 interval, ≈15s) — the cancel left no residue',
      !!P && P.intervals.value === 1 && Math.abs(P.totalSecondsExact - 15) <= 2,
      'intervals=' + (P && P.intervals.value) + ' secs=' + (P && P.totalSecondsExact));
    ok('C3f: analytics count the quick tag taken after the cancel (1 our shot)',
      !!T && T.shots.value === 1);

    restoreDate(B.win);
    B.dom.window.close();
  }

  // =====================================================================
  section('BOOT C4 — edge 3: undo interplay (the cancel never enters the undo chain)');
  // =====================================================================
  {
    const B = boot({ squad: SQUAD });
    const doc = B.doc;
    await sleep(300);

    click(doc.getElementById('btnTouchlineToggle'));
    click(doc.getElementById('tlBtnStart'));

    click(quickBtn(doc, 'Shot'));
    click(doc.getElementById('detailPanelDone'));
    ok('C4a: baseline — one logged Shot, undo enabled',
      eventRows(doc).length === 1 && doc.getElementById('tlBtnUndo').disabled === false);

    click(quickBtn(doc, 'Possession'));
    patchDate(B.win, 10000);
    click(cancelBtn(doc));
    ok('C4b: after the cancel, the undo button still points at the last LOGGED event (enabled, 1 row)',
      doc.getElementById('tlBtnUndo').disabled === false && eventRows(doc).length === 1);

    click(doc.getElementById('tlBtnUndo')); // undo AFTER a cancel
    ok('C4c: undo removes the Shot (the last logged event) — NOT the canceled interval [req E]',
      eventRows(doc).length === 0);
    ok('C4d: undo is disabled once the logged event is gone',
      doc.getElementById('tlBtnUndo').disabled === true);
    click(doc.getElementById('tlBtnUndo')); // second undo — no-op
    ok('C4e: a second undo is a no-op (no crash, no phantom removal)',
      eventRows(doc).length === 0);

    restoreDate(B.win);
    B.dom.window.close();
  }

  // =====================================================================
  section('BOOT C5 — edge 4: F2.2 recent-events feed is unaffected by a cancel');
  // =====================================================================
  {
    const B = boot({ squad: SQUAD });
    const doc = B.doc;
    await sleep(300);

    click(doc.getElementById('btnTouchlineToggle'));
    click(doc.getElementById('tlBtnStart'));

    click(quickBtn(doc, 'Shot'));
    click(doc.getElementById('detailPanelDone'));
    ok('C5a: baseline — the feed shows the one completed event',
      feedItems(doc).length === 1);

    click(quickBtn(doc, 'Possession'));
    patchDate(B.win, 5000);
    click(cancelBtn(doc));
    ok('C5b: the feed is byte-identical after a cancel (still exactly the Shot card — the feed only shows completed events)',
      feedItems(doc).length === 1 && feedItems(doc)[0].textContent.indexOf('Shot') > -1);

    click(quickBtn(doc, 'Possession'));
    patchDate(B.win, 20000);
    click(quickBtn(doc, 'Possession', true));
    click(doc.getElementById('detailPanelDone'));
    ok('C5c: a subsequently COMPLETED interval does appear (newest first)',
      feedItems(doc).length === 2 && feedItems(doc)[0].textContent.indexOf('Possession') > -1);

    restoreDate(B.win);
    B.dom.window.close();
  }

  // =====================================================================
  section('BOOT C6 — cancel while the F2.2 player picker is open (coexistence)');
  // =====================================================================
  {
    const B = boot({ squad: SQUAD });
    const doc = B.doc;
    await sleep(300);

    click(doc.getElementById('btnTouchlineToggle'));
    click(doc.getElementById('tlBtnStart'));
    click(quickBtn(doc, 'Shot'));
    click(doc.getElementById('detailPanelDone'));

    const playerButton = feedItems(doc)[0].querySelector('[data-corr="player"]');
    click(playerButton); // open the picker → feed frozen
    ok('C6a: picker open, feed frozen at 1 card',
      !!pickerEl(doc) && feedItems(doc).length === 1);

    click(quickBtn(doc, 'Possession')); // start an interval while editing
    click(cancelBtn(doc));              // cancel it while the picker is still open
    ok('C6b: the picker survives the cancel and the feed stays frozen (1 card, 1 desktop row)',
      !!pickerEl(doc) && feedItems(doc).length === 1 && eventRows(doc).length === 1);
    ok('C6c: no event leaked from the cancel while the picker was open',
      eventRows(doc).length === 1 && eventRows(doc)[0].textContent.indexOf('Shot') > -1);

    click(pickerEl(doc).querySelector('.tl-player-picker-done'));
    ok('C6d: Done unfreezes the feed to the truth (still exactly the Shot card)',
      !pickerEl(doc) && feedItems(doc).length === 1);

    B.dom.window.close();
  }

  // =====================================================================
  section('BOOT C7 — desktop mirror: desktop-started interval shows the ✕; cancel clears BOTH UIs');
  // =====================================================================
  {
    const B = boot({ squad: SQUAD });
    const doc = B.doc;
    await sleep(300);

    click(doc.getElementById('btnClockStart'));
    const dBtn = desktopTagBtn(doc, 'Possession');
    click(dBtn); // start the interval from the DESKTOP grid
    ok('C7a: the desktop button shows its recording state (F2.1 mirror baseline)',
      !!desktopTagBtn(doc, 'Possession') && desktopTagBtn(doc, 'Possession').classList.contains('tag-btn-recording'));

    click(doc.getElementById('btnTouchlineToggle')); // enter Touchline Mode mid-recording
    ok('C7b: the touchline grid mirrors the desktop-started interval (recording + ✕ visible at entry)',
      !!quickBtn(doc, 'Possession', true) && !!cancelBtn(doc));

    click(cancelBtn(doc)); // cancel from TOUCHLINE
    click(doc.getElementById('btnTouchlineToggle')); // back to desktop
    ok('C7c: the desktop grid is at rest after the touchline cancel (renderTagButtons sync in the cancel path)',
      !!desktopTagBtn(doc, 'Possession') && !desktopTagBtn(doc, 'Possession').classList.contains('tag-btn-recording'));
    ok('C7d: still no event anywhere (single shared state, cleared once)',
      eventRows(doc).length === 0);

    B.dom.window.close();
  }

  // =====================================================================
  section('BOOT C8 — save→load after a cancel: no junk in the session, fresh intervals on the loaded session');
  // =====================================================================
  {
    const B = boot({ squad: SQUAD });
    const doc = B.doc;
    await sleep(300);

    click(doc.getElementById('btnTouchlineToggle'));
    click(doc.getElementById('tlBtnStart'));
    click(quickBtn(doc, 'Shot'));
    click(doc.getElementById('detailPanelDone'));
    click(quickBtn(doc, 'Possession'));
    patchDate(B.win, 8000);
    click(cancelBtn(doc));

    click(doc.getElementById('btnSaveSession'));
    await sleep(400);
    const saved = B.stub._calls.saveSession[0];
    ok('C8a: the saved session carries exactly the completed event (no junk from the canceled interval)',
      !!saved && Array.isArray(saved.events) && saved.events.length === 1 && saved.events[0].label === 'Shot',
      'events=' + (saved && saved.events && saved.events.length));
    restoreDate(B.win);
    B.dom.window.close();

    const B2 = boot({ squad: SQUAD });
    const doc2 = B2.doc;
    await sleep(300);
    B2.stub._setLoadSession(saved);
    click(doc2.getElementById('btnLoadSession'));
    await sleep(400);

    ok('C8b: the loaded session renders its one event (desktop list)',
      eventRows(doc2).length === 1);
    click(doc2.getElementById('btnTouchlineToggle')); // enter Touchline Mode on the loaded session
    ok('C8b2: the quick tag is at rest on touchline entry (no recording, no ✕ — the loader reset the intervals)',
      !!quickBtn(doc2, 'Possession') && !quickBtn(doc2, 'Possession', true) && !cancelBtn(doc2));

    click(doc2.getElementById('tlBtnStart'));
    click(quickBtn(doc2, 'Possession'));
    patchDate(B2.win, 12000);
    click(quickBtn(doc2, 'Possession', true));
    click(doc2.getElementById('detailPanelDone'));
    ok('C8c: a fresh interval can be started and finished on the loaded session (2 rows, distinct events)',
      eventRows(doc2).length === 2 && eventRows(doc2).some((r) => r.textContent.indexOf('Possession') > -1));

    restoreDate(B2.win);
    B2.dom.window.close();
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
  console.log('---- touchline cancel check: ' + pass + ' passed, ' + fail + ' failed ----');
  console.log('NOTE: jsdom does not compute CSS layout/paint. The ✕ corner');
  console.log('position/size, its hit-target ergonomics, and the pulse/active visuals');
  console.log('must be confirmed manually in Electron. No video/media decoding is');
  console.log('exercised (the cancel code is video-independent).');
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('HARNESS CRASH:', err && err.stack ? err.stack : err);
  process.exit(1);
});
