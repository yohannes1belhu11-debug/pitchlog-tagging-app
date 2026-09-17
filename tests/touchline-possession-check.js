#!/usr/bin/env node
// PitchLog / MatchTag — Touchline Possession Tagging regression harness
// (TP series). Delivered as F1.4; re-issued and re-verified as F2.1 — the
// same feature under the backlog's new numbering. P1–P4 verify the F1.4
// delivery; P5–P7 were added for the F2.1 task's explicit edge cases
// (consecutive possessions, duplicate-attempt semantics, team selection,
// save→load roundtrip). No production source is modified by this harness.
// =====================================================================
// Verification-only harness. It does NOT modify any app source file.
//
// Verifies the F1.4 fix for the Phase F0 audit finding:
// the Touchline Mode quick-tag grid (QUICK_TAGS) excluded 'Possession',
// so no possession intervals could be created from Touchline Mode —
// silently zeroing every possession metric (Tagged Possession Share,
// zone durations) for touchline-only matches, even though the shared
// handleTagPress() path already implemented the interval toggle.
//
// Checks:
//   STATIC  TP-S1..S15 — source wiring + preservation of every shared
//           path (handleTagPress / startInterval / finishInterval /
//           renderTagButtons / autosave F1.3 guards / default tag def).
//   BOOT P1 no-video touchline lifecycle: quick tag starts the interval
//           (recording state visible), match clock advances, second tap
//           finishes it (match-domain bounds), detail panel reachable
//           above the overlay (F1.1), 'Ended by' qualifier chip,
//           autosave payload carries the interval event, touchline
//           undo, instant quick tag unaffected.
//   BOOT P2 video session: interval bounds come from the VIDEO clock
//           (startTime/endTime/videoTime), preserving finishInterval's
//           existing video-branch semantics.
//   BOOT P3 cross-mode: interval started in touchline survives exit /
//           re-entry with the recording state shown in BOTH UIs; one
//           finish click logs exactly one event; state clears after.
//   BOOT P4 hand-edited session whose tag array lacks Possession: the
//           auto-created quick tag stays an INTERVAL tag (guard), so a
//           flat instant Possession event can never corrupt possession
//           metrics.
//   BOOT P5 (F2.1) consecutive possessions: two start→finish cycles log
//           two well-formed intervals; the tap while active FINISHES
//           (toggle) — never starts a duplicate interval; both count in
//           the possession analytics (engine called on the saved session).
//   BOOT P6 (F2.1) team selection: (a) possession with Opponent selected
//           → team='opponent'/side='against', analytics opponent bucket;
//           (b) mid-interval team flip → the open interval's bounds are
//           never touched and exactly one event is logged, whose team is
//           captured at FINISH (existing buildEventBase semantics);
//           (c) the identical desktop sequence produces the identical
//           semantics — the touchline entry point adds no divergence.
//   BOOT P7 (F2.1) save→load roundtrip: a completed possession survives
//           an explicit save + load into a fresh window intact (id,
//           bounds, interval flag, team), the quick tag loads at REST,
//           and a NEW possession can be tagged on the loaded session.
//
// HONEST SCOPE: jsdom does not compute CSS layout or paint. The
// accent/pulse recording visual (.touchline-tag-btn.recording) is
// verified statically (rule present, pulse animation, accent vars) and
// behaviorally (class + label glyph); real on-screen appearance must be
// confirmed manually in Electron. jsdom does not decode media either —
// video state is simulated with settable readyState/currentTime
// properties (same technique as f2-f3-fix-check.js).
//
// Run:  node tests/touchline-possession-check.js   (from the project root)
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

// Extract a function's body (between its declaration and the next
// top-level 'function ' keyword) for static checks.
function fnBody(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) return '';
  const next = src.indexOf('\n  function ', start + 10);
  return start > -1 && next > start ? src.slice(start, next) : src.slice(start, start + 3000);
}

// ---------------------------------------------------------------------------
// Static source-level checks
// ---------------------------------------------------------------------------
section('STATIC — F1.4 wiring (source-level checks)');
{
  const rtqFn = fnBody(rendererSrc, 'renderTouchlineQuickTags');
  ok('TP-S1: QUICK_TAGS includes Possession',
    /const QUICK_TAGS = \['Possession',/.test(rendererSrc));
  ok('TP-S2: Possession leads the quick tags (prime touch position)',
    /const QUICK_TAGS = \['Possession','Shot'/.test(rendererSrc));

  ok('TP-S3: quick-tag grid computes the recording state from the LIVE tag definition',
    /const tagDef = tags\.find\(\(t\) => t\.label === label\);/.test(rtqFn) &&
    /isRecordingInterval\(tagDef\)/.test(rtqFn));
  ok('TP-S4: recording class + ⏱ glyph wired into the quick-tag button',
    /\(recording \? ' recording' : ''\)/.test(rtqFn) &&
    /label \+ \(recording \? ' ⏱' : ''\)/.test(rtqFn));
  ok('TP-S5: grid re-render is gated on interval tags ONLY (never on the 250ms timer path)',
    /if \(tag\.interval\) renderTouchlineQuickTags\(\);/.test(rtqFn) &&
    fnBody(rendererSrc, 'renderTouchlineAll').indexOf('renderTouchlineQuickTags') === -1);
  ok('TP-S6: auto-created Possession quick tag is forced to stay an interval tag',
    /if \(label === 'Possession'\) tag\.interval = true;/.test(rtqFn));

  ok('TP-S7: handleTagPress interval toggle untouched (shared path)',
    /if \(tag\.interval\) \{[\s\S]*?finishInterval\(tag\)[\s\S]*?startInterval\(tag\)/.test(fnBody(rendererSrc, 'handleTagPress')));
  ok('TP-S8: startInterval still captures both clocks + period',
    /startMatchSeconds: getCurrentMatchSeconds\(\)/.test(fnBody(rendererSrc, 'startInterval')) &&
    /startPeriod: matchClock\.period/.test(fnBody(rendererSrc, 'startInterval')));
  const finFn = fnBody(rendererSrc, 'finishInterval');
  ok('TP-S9: finishInterval untouched (video + no-video branches, isInterval event, panel, autosave)',
    /video\.readyState >= 2/.test(finFn) && /isInterval: true/.test(finFn) &&
    finFn.indexOf('openDetailPanel(tag, event)') > -1 && finFn.indexOf('markAutosaveDirty()') > -1);
  ok('TP-S10: enterTouchlineMode still re-renders the quick-tag grid (state visible on entry)',
    /enterTouchlineMode\(\)[\s\S]{0,220}renderTouchlineQuickTags\(\);/.test(rendererSrc));

  ok('TP-S11: CSS recording rule present (accent vars + pulse animation)',
    /\.touchline-tag-btn\.recording\s*\{[^}]*background: var\(--accent\)[^}]*animation: pulse/.test(stylesSrc));
  const rtbFn = fnBody(rendererSrc, 'renderTagButtons');
  ok('TP-S12: desktop renderTagButtons recording pattern unchanged',
    /tag-btn-recording/.test(rtbFn) && /tag-recording-label/.test(rtbFn) && /Recording…/.test(rtbFn));
  ok('TP-S13: default Possession tag definition unchanged (interval + Ended by)',
    /label: 'Possession', key: '8', interval: true,/.test(rendererSrc) &&
    /\{ name: 'Ended by', options: \['Shot', 'Turnover', 'Foul won', 'Out of play'\] \}/.test(rendererSrc));
  ok('TP-S14: F1.3 autosave epoch guard intact (no accidental damage from F1.4)',
    /if \(epochAtStart !== autosaveEpoch\) return;/.test(fnBody(rendererSrc, 'performAutosave')));
  ok('TP-S15: F1.1 touchline detail layering intact (no accidental damage from F1.4)',
    /if \(touchlineMode\) detailPanel\.classList\.add\('touchline-detail'\);/.test(fnBody(rendererSrc, 'openDetailPanel')));

  // F2.1 team-semantics pins: the touchline team buttons must drive the
  // SHARED selectTeam() state (no separate touchline team semantics), and
  // buildEventBase must keep capturing team at EVENT-CREATION time (for
  // interval events that is the FINISH tap — the pre-existing desktop
  // rule the touchline path inherits unchanged).
  ok('TP-S16: touchline team buttons drive the shared selectTeam state (our + opponent)',
    /tlBtnTeamOur\.addEventListener\('click',\(\)=>\{selectTeam\('our'\);renderTouchlineAll\(\);\}\)/.test(rendererSrc) &&
    /tlBtnTeamOpp\.addEventListener\('click',\(\)=>\{selectTeam\('opponent'\);renderTouchlineAll\(\);\}\)/.test(rendererSrc));
  ok('TP-S17: buildEventBase team capture unchanged (team/side from matchClock.selectedTeam at event creation)',
    /team: matchClock\.selectedTeam,/.test(fnBody(rendererSrc, 'buildEventBase')) &&
    /side: matchClock\.selectedTeam === 'our' \? 'for' : matchClock\.selectedTeam === 'opponent' \? 'against' : null/.test(fnBody(rendererSrc, 'buildEventBase')));
}

// ---------------------------------------------------------------------------
// jsdom boots
// ---------------------------------------------------------------------------
function makeStub(initial) {
  const calls = { saveSession: [], autosaveWrite: [], flushSync: [], loadSessionCalls: 0 };
  const file = { current: null }; // simulated userData/autosave.json
  let loadSessionData = null;
  const stub = {
    openVideo: async () => null,
    saveSession: async (d) => { calls.saveSession.push(clone(d)); return { canceled: false, filePath: '/tmp/tp-session.json' }; },
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
function desktopTagBtn(doc, label) {
  return Array.from(doc.querySelectorAll('#tagButtons .tag-btn')).find((b) => b.textContent.replace(/⏱/g, '').trim().indexOf(label) === 0) || null;
}
function quickBtn(doc, label, recording) {
  const exact = recording ? label + ' ⏱' : label;
  return Array.from(doc.querySelectorAll('#touchlineQuickTags .touchline-tag-btn')).find((b) => b.textContent === exact) || null;
}
function eventRows(doc) { return Array.from(doc.querySelectorAll('#eventList .event-row')); }
function rowByLabel(doc, label) { return eventRows(doc).find((r) => r.textContent.indexOf(label) > -1) || null; }
function detailPanel(doc) { return doc.getElementById('detailPanel'); }

// Advance the jsdom window's clock by `ms` (the renderer's match clock
// reads Date.now() inside the window context). Saved/restored per boot.
function patchDate(win, ms) {
  win.eval('window.__tpOrigNow = Date.now; window.__tpT0 = Date.now(); Date.now = () => window.__tpT0 + ' + ms + ';');
}
function restoreDate(win) {
  win.eval('Date.now = window.__tpOrigNow; delete window.__tpOrigNow; delete window.__tpT0;');
}

// Simulate a loaded, playable video (f2-f3 technique).
function simulateLoadedVideo(doc, currentTime, duration) {
  const video = doc.getElementById('video');
  Object.defineProperty(video, 'readyState', { value: 4, configurable: true });
  Object.defineProperty(video, 'currentTime', { value: currentTime, configurable: true, writable: true });
  Object.defineProperty(video, 'duration', { value: duration, configurable: true, writable: true });
  return video;
}

const SQUAD = [
  { id: 'player_1', number: '1', name: 'Ana One' },
  { id: 'player_2', number: '2', name: 'Ben Two' }
];

function stoppedClock(base) {
  return { clockStartedAt: null, clockBaseSeconds: base, clockRunning: false, period: '1H',
    scoreFor: 0, scoreAgainst: 0, videoSyncOffset: 0, selectedTeam: 'our', selectedPlayerId: null,
    activeSequenceId: null, nextSequenceNumber: 1 };
}

(async () => {
  // =====================================================================
  section('BOOT P1 — no-video touchline possession lifecycle (match clock domain)');
  // =====================================================================
  {
    const B = boot({ squad: SQUAD });
    const doc = B.doc;
    await sleep(300);

    click(doc.getElementById('btnTouchlineToggle'));
    ok('P1a: Possession quick tag present at rest (exact label, no glyph)',
      !!quickBtn(doc, 'Possession', false), 'found=' + !!quickBtn(doc, 'Possession', false));

    click(doc.getElementById('tlBtnStart')); // start the match clock
    click(quickBtn(doc, 'Possession', false)); // start the interval

    ok('P1b: after the tap the button shows the RECORDING state (class + ⏱ glyph)',
      !!quickBtn(doc, 'Possession', true) && quickBtn(doc, 'Possession', true).classList.contains('recording'));
    ok('P1c: no event row yet — the interval is still open',
      eventRows(doc).length === 0, 'rows=' + eventRows(doc).length);
    ok('P1d: the desktop Possession button mirrors the recording state (shared activeIntervals)',
      !!desktopTagBtn(doc, 'Possession') && desktopTagBtn(doc, 'Possession').classList.contains('tag-btn-recording'));

    patchDate(B.win, 30000); // +30s of match time
    click(quickBtn(doc, 'Possession', true)); // finish the interval
    restoreDate(B.win);

    const rows = eventRows(doc);
    ok('P1e: finishing created exactly ONE event row',
      rows.length === 1 && rows[0].textContent.indexOf('Possession') > -1, 'rows=' + rows.length + ' text=' + (rows[0] && rows[0].textContent.slice(0, 60)));

    const panel = detailPanel(doc);
    ok('P1f: detail panel opened above the touchline overlay (F1.1 layering intact)',
      panel && panel.style.display === 'block' && panel.classList.contains('touchline-detail'));
    ok('P1g: panel offers the Ended-by qualifier group with its chips',
      !!panel && panel.textContent.indexOf('Ended by') > -1 &&
      !!panel.querySelector('.chip[data-kind="qualifier"][data-group="Ended by"][data-value="Turnover"]'));

    click(panel.querySelector('.chip[data-kind="qualifier"][data-group="Ended by"][data-value="Turnover"]'));
    click(doc.getElementById('detailPanelDone'));
    ok('P1h: Done closes the panel (event kept)',
      panel.style.display === 'none' && eventRows(doc).length === 1);

    await sleep(1700); // autosave debounce
    const saved = B.stub._file.current;
    const ev = saved && saved.events && saved.events[0];
    ok('P1i: autosave payload carries the interval event',
      !!ev && ev.label === 'Possession' && ev.isInterval === true,
      'label=' + (ev && ev.label) + ' isInterval=' + (ev && ev.isInterval));
    ok('P1j: interval bounds are MATCH-domain (videoTime null, duration ≈ 30s)',
      ev && ev.videoTime === null && (ev.endTime - ev.startTime) >= 28 && (ev.endTime - ev.startTime) <= 32,
      'start=' + (ev && ev.startTime) + ' end=' + (ev && ev.endTime));
    ok('P1k: anchor consistency preserved (time == matchTime == startTime, matchSeconds floored)',
      ev && ev.time === ev.startTime && ev.matchTime === ev.startTime && ev.matchSeconds === Math.floor(ev.startTime));
    ok('P1l: Ended-by qualifier stored on the event',
      ev && ev.qualifiers && ev.qualifiers['Ended by'] === 'Turnover');

    ok('P1m: touchline recent list shows the possession event',
      doc.querySelectorAll('#touchlineRecentEvents .touchline-recent-item').length === 1);

    click(doc.getElementById('tlBtnUndo'));
    ok('P1n: touchline undo removes the interval event',
      eventRows(doc).length === 0, 'rows=' + eventRows(doc).length);

    // Instant quick tag regression guard: Shot must behave exactly as before.
    click(quickBtn(doc, 'Shot', false));
    ok('P1o: instant quick tag still logs (Shot) with no grid side effects',
      eventRows(doc).length === 1 && !!rowByLabel(doc, 'Shot') && !!quickBtn(doc, 'Shot', false),
      'rows=' + eventRows(doc).length);
    click(doc.getElementById('detailPanelDone'));

    B.dom.window.close();
  }

  // =====================================================================
  section('BOOT P2 — video session: interval bounds from the VIDEO clock');
  // =====================================================================
  {
    const B = boot({ squad: SQUAD });
    const doc = B.doc;
    await sleep(300);

    B.stub._setLoadSession({
      __schemaVersion: 3, videoPath: '/tmp/v.mp4', videoUrl: 'file:///tmp/v.mp4',
      tags: [], events: [], squad: SQUAD, matchInfo: { opponent: 'Video FC' },
      matchClock: stoppedClock(0)
    });
    click(doc.getElementById('btnLoadSession'));
    await sleep(350);

    simulateLoadedVideo(doc, 100.5, 5000);
    click(doc.getElementById('btnTouchlineToggle'));
    click(quickBtn(doc, 'Possession', false));
    ok('P2a: recording state visible in the video session too',
      !!quickBtn(doc, 'Possession', true));

    doc.getElementById('video').currentTime = 205.75; // playback advances
    click(quickBtn(doc, 'Possession', true)); // finish

    ok('P2b: one event row created',
      eventRows(doc).length === 1);
    click(doc.getElementById('detailPanelDone'));

    await sleep(1700);
    const ev = B.stub._file.current && B.stub._file.current.events[0];
    ok('P2c: event is an interval (video branch of finishInterval)',
      !!ev && ev.isInterval === true);
    ok('P2d: bounds are VIDEO-domain (startTime 100.5, endTime 205.75)',
      ev && Math.abs(ev.startTime - 100.5) < 0.001 && Math.abs(ev.endTime - 205.75) < 0.001,
      'start=' + (ev && ev.startTime) + ' end=' + (ev && ev.endTime));
    ok('P2e: videoTime is the finish moment (existing video-branch semantics)',
      ev && Math.abs(ev.videoTime - 205.75) < 0.001);
    ok('P2f: time == matchTime == startTime (existing video-branch semantics preserved)',
      ev && ev.time === ev.startTime && ev.matchTime === ev.startTime);

    B.dom.window.close();
  }

  // =====================================================================
  section('BOOT P3 — cross-mode: recording survives exit/re-entry, one event total');
  // =====================================================================
  {
    const B = boot({ squad: SQUAD });
    const doc = B.doc;
    await sleep(300);

    click(doc.getElementById('btnTouchlineToggle'));
    click(doc.getElementById('tlBtnStart'));
    click(quickBtn(doc, 'Possession', false)); // start in touchline
    ok('P3a: recording state in touchline',
      !!quickBtn(doc, 'Possession', true));

    click(doc.getElementById('btnExitTouchline'));
    ok('P3b: after exiting, the DESKTOP Possession button shows the recording state',
      !!desktopTagBtn(doc, 'Possession') && desktopTagBtn(doc, 'Possession').classList.contains('tag-btn-recording'));

    click(doc.getElementById('btnTouchlineToggle')); // re-enter
    ok('P3c: re-entering touchline re-shows the recording state (live tag lookup)',
      !!quickBtn(doc, 'Possession', true) && quickBtn(doc, 'Possession', true).classList.contains('recording'));

    patchDate(B.win, 15000); // +15s
    click(quickBtn(doc, 'Possession', true)); // finish from touchline
    restoreDate(B.win);

    ok('P3d: exactly ONE event logged across the mode switches',
      eventRows(doc).length === 1, 'rows=' + eventRows(doc).length);
    click(doc.getElementById('detailPanelDone'));
    ok('P3e: quick tag back to rest state (no stuck recording)',
      !!quickBtn(doc, 'Possession', false) && !quickBtn(doc, 'Possession', false).classList.contains('recording'));
    ok('P3f: desktop button back to rest state',
      !!desktopTagBtn(doc, 'Possession') && !desktopTagBtn(doc, 'Possession').classList.contains('tag-btn-recording'));

    await sleep(1700);
    const ev = B.stub._file.current && B.stub._file.current.events[0];
    ok('P3g: the logged event is an interval with ≈15s match-domain bounds',
      !!ev && ev.isInterval === true && ev.videoTime === null && (ev.endTime - ev.startTime) >= 13 && (ev.endTime - ev.startTime) <= 17,
      'dur=' + (ev && (ev.endTime - ev.startTime)));

    B.dom.window.close();
  }

  // =====================================================================
  section('BOOT P4 — session tag array lacks Possession: auto-create stays an interval');
  // =====================================================================
  {
    const B = boot({ squad: SQUAD });
    const doc = B.doc;
    await sleep(300);

    B.stub._setLoadSession({
      __schemaVersion: 3, videoPath: null, videoUrl: null,
      tags: [{ label: 'Shot', key: '1' }], // hand-edited session: Possession missing
      events: [], squad: SQUAD, matchInfo: { opponent: 'Edge FC' },
      matchClock: stoppedClock(0)
    });
    click(doc.getElementById('btnLoadSession'));
    await sleep(350);

    click(doc.getElementById('btnTouchlineToggle'));
    click(doc.getElementById('tlBtnStart'));
    ok('P4a: quick tag button present even though the loaded tags lack Possession',
      !!quickBtn(doc, 'Possession', false));

    click(quickBtn(doc, 'Possession', false)); // auto-create + start
    ok('P4b: auto-created tag is treated as INTERVAL (recording state on)',
      !!quickBtn(doc, 'Possession', true) && quickBtn(doc, 'Possession', true).classList.contains('recording'));
    ok('P4c: the auto-created desktop button carries the interval marker (⏱)',
      !!desktopTagBtn(doc, 'Possession') && desktopTagBtn(doc, 'Possession').textContent.indexOf('⏱') > -1);

    click(quickBtn(doc, 'Possession', true)); // finish
    ok('P4d: one event row created',
      eventRows(doc).length === 1);
    click(doc.getElementById('detailPanelDone'));

    await sleep(1700);
    const ev = B.stub._file.current && B.stub._file.current.events[0];
    ok('P4e: the event is a real INTERVAL (not a flat instant event — possession metrics stay valid)',
      !!ev && ev.isInterval === true && typeof ev.startTime === 'number' && typeof ev.endTime === 'number',
      'isInterval=' + (ev && ev.isInterval) + ' start=' + (ev && ev.startTime) + ' end=' + (ev && ev.endTime));

    B.dom.window.close();
  }

  // =====================================================================
  section('BOOT P5 — consecutive possessions; tap while active FINISHES (no duplicate interval) [F2.1 edges 2+3]');
  // =====================================================================
  {
    const B = boot({ squad: SQUAD });
    const doc = B.doc;
    await sleep(300);

    click(doc.getElementById('btnTouchlineToggle'));
    click(doc.getElementById('tlBtnStart'));

    // Possession #1: start → finish.
    click(quickBtn(doc, 'Possession', false));
    ok('P5a: possession #1 started (recording on, no event logged yet)',
      !!quickBtn(doc, 'Possession', true) && eventRows(doc).length === 0,
      'rows=' + eventRows(doc).length);

    patchDate(B.win, 25000);
    click(quickBtn(doc, 'Possession', true)); // while active, the tap FINISHES (handleTagPress toggle)
    restoreDate(B.win);
    click(doc.getElementById('detailPanelDone'));

    ok('P5b: the tap while active finished the interval — exactly ONE event, button back at rest',
      eventRows(doc).length === 1 && !!quickBtn(doc, 'Possession', false) &&
      !quickBtn(doc, 'Possession', false).classList.contains('recording'),
      'rows=' + eventRows(doc).length);
    ok('P5c: the finish tap did NOT start a second interval (no duplicate active interval, ever)',
      !quickBtn(doc, 'Possession', true) && eventRows(doc).length === 1);

    // Possession #2: the NEXT tap starts a fresh interval.
    click(quickBtn(doc, 'Possession', false));
    ok('P5d: possession #2 started (recording on; still exactly one logged event)',
      !!quickBtn(doc, 'Possession', true) && eventRows(doc).length === 1);

    patchDate(B.win, 15000);
    click(quickBtn(doc, 'Possession', true));
    restoreDate(B.win);
    click(doc.getElementById('detailPanelDone'));

    ok('P5e: two possession events after the second cycle',
      eventRows(doc).length === 2, 'rows=' + eventRows(doc).length);

    await sleep(1700);
    const session = B.stub._file.current;
    const poss = (session && session.events ? session.events : []).filter((e) => e.label === 'Possession');
    ok('P5f: both events are well-formed possession intervals with distinct ids',
      poss.length === 2 && poss.every((e) => e.isInterval === true) && poss[0].id !== poss[1].id,
      'n=' + poss.length);
    ok('P5g: durations ≈25s and ≈15s (bounds captured at each START, clocks never touched between)',
      Math.abs((poss[0].endTime - poss[0].startTime) - 25) <= 3 &&
      Math.abs((poss[1].endTime - poss[1].startTime) - 15) <= 3,
      'd1=' + (poss[0] && (poss[0].endTime - poss[0].startTime)) +
      ' d2=' + (poss[1] && (poss[1].endTime - poss[1].startTime)));

    // Engine proof: the real analytics layer counts both touchline-tagged
    // intervals in the possession metrics (compatibility requirement).
    const R = B.win.AnalyticsEngine.computeMatchAnalytics(session);
    const P = R && R.level1 && R.level1.possession && R.level1.possession.our;
    ok('P5h: possession analytics count both intervals in the OUR bucket (default team)',
      !!P && P.intervals.value === 2 && P.totalSecondsExact >= 37 && P.totalSecondsExact <= 43,
      'intervals=' + (P && P.intervals.value) + ' seconds=' + (P && P.totalSecondsExact));

    B.dom.window.close();
  }

  // =====================================================================
  section('BOOT P6 — team selection semantics [F2.1 edge 4]');
  // =====================================================================
  {
    // (a) Possession tagged with the OPPONENT team selected.
    const B = boot({ squad: SQUAD });
    const doc = B.doc;
    await sleep(300);

    click(doc.getElementById('btnTouchlineToggle'));
    click(doc.getElementById('tlBtnStart'));
    click(doc.getElementById('tlBtnTeamOpp'));
    ok('P6a: touchline Opponent button is the active team (shared selector)',
      doc.getElementById('tlBtnTeamOpp').classList.contains('active') &&
      !doc.getElementById('tlBtnTeamOur').classList.contains('active'));

    click(quickBtn(doc, 'Possession', false));
    patchDate(B.win, 20000);
    click(quickBtn(doc, 'Possession', true));
    restoreDate(B.win);
    click(doc.getElementById('detailPanelDone'));

    await sleep(1700);
    const session = B.stub._file.current;
    const ev = session && session.events && session.events[0];
    ok('P6b: opponent possession event carries team=opponent / side=against (existing buildEventBase fields)',
      !!ev && ev.team === 'opponent' && ev.side === 'against',
      'team=' + (ev && ev.team) + ' side=' + (ev && ev.side));

    const R = B.win.AnalyticsEngine.computeMatchAnalytics(session);
    const PL1 = R && R.level1 && R.level1.possession;
    ok('P6c: analytics partition the interval to the OPPONENT bucket (our = 0)',
      !!PL1 && PL1.opponent.intervals.value === 1 &&
      PL1.our.intervals.value === 0,
      'opp=' + (PL1 && PL1.opponent.intervals.value) +
      ' our=' + (PL1 && PL1.our.intervals.value));

    B.dom.window.close();
  }
  {
    // (b) Mid-interval team flip. DISCOVERED ARCHITECTURE (pinned, not
    // changed): startInterval captures only clocks + period — never team;
    // the event is built in finishInterval via buildEventBase, which reads
    // matchClock.selectedTeam at THAT moment. So a mid-interval flip never
    // touches the open interval's captured bounds, never logs anything,
    // and the completed event records the team selected at the FINISH tap.
    // Identical rule to desktop (proven by (c) below) — inherited by the
    // shared touchline path, unchanged by this feature.
    const B = boot({ squad: SQUAD });
    const doc = B.doc;
    await sleep(300);

    click(doc.getElementById('btnTouchlineToggle'));
    click(doc.getElementById('tlBtnStart'));
    click(quickBtn(doc, 'Possession', false)); // start with 'our' (default)

    click(doc.getElementById('tlBtnTeamOpp')); // analyst flips team mid-interval
    ok('P6d: the flip does not log, finish, or disturb the open interval',
      eventRows(doc).length === 0 && !!quickBtn(doc, 'Possession', true),
      'rows=' + eventRows(doc).length);

    patchDate(B.win, 20000);
    click(quickBtn(doc, 'Possession', true));
    restoreDate(B.win);
    click(doc.getElementById('detailPanelDone'));

    await sleep(1700);
    const session = B.stub._file.current;
    const ev = session && session.events && session.events[0];
    ok('P6e: exactly one interval; bounds intact (≈20s) and anchor-consistent — the flip never corrupted the interval',
      !!ev && ev.isInterval === true && Math.abs((ev.endTime - ev.startTime) - 20) <= 3 &&
      ev.time === ev.startTime && ev.matchTime === ev.startTime && ev.videoTime === null,
      'dur=' + (ev && (ev.endTime - ev.startTime)));
    ok('P6f: completed event records the team at FINISH (opponent) — the pre-existing desktop rule',
      !!ev && ev.team === 'opponent' && ev.side === 'against',
      'team=' + (ev && ev.team));

    B.dom.window.close();
  }
  {
    // (c) Desktop equivalence: the SAME mid-interval flip performed purely
    // on the desktop UI must yield the identical semantics — proof the
    // touchline entry point introduces no divergence (F2.1 req F).
    const B = boot({ squad: SQUAD });
    const doc = B.doc;
    await sleep(300);

    click(doc.getElementById('btnClockStart')); // desktop clock
    const deskBtn = desktopTagBtn(doc, 'Possession');
    ok('P6g-pre: desktop Possession button found at rest', !!deskBtn);
    click(deskBtn); // start via the DESKTOP button
    ok('P6g: desktop Possession button shows the recording state (shared activeIntervals)',
      !!desktopTagBtn(doc, 'Possession') &&
      desktopTagBtn(doc, 'Possession').classList.contains('tag-btn-recording'));

    click(doc.getElementById('btnTeamOpponent')); // desktop team flip mid-interval
    patchDate(B.win, 20000);
    click(desktopTagBtn(doc, 'Possession')); // finish via the DESKTOP button
    restoreDate(B.win);
    click(doc.getElementById('detailPanelDone'));

    await sleep(1700);
    const session = B.stub._file.current;
    const ev = session && session.events && session.events[0];
    ok('P6h: desktop path yields the SAME team-at-finish semantic (team=opponent, side=against, bounds ≈20s intact)',
      !!ev && ev.team === 'opponent' && ev.side === 'against' && ev.isInterval === true &&
      Math.abs((ev.endTime - ev.startTime) - 20) <= 3,
      'team=' + (ev && ev.team) + ' dur=' + (ev && (ev.endTime - ev.startTime)));

    B.dom.window.close();
  }

  // =====================================================================
  section('BOOT P7 — completed possession survives save → load [F2.1 req G]');
  // =====================================================================
  {
    // Boot 1: tag a possession, pause the clock (deterministic state), save.
    const B1 = boot({ squad: SQUAD });
    const doc1 = B1.doc;
    await sleep(300);

    click(doc1.getElementById('btnTouchlineToggle'));
    click(doc1.getElementById('tlBtnStart'));
    click(quickBtn(doc1, 'Possession', false));
    patchDate(B1.win, 30000);
    click(quickBtn(doc1, 'Possession', true));
    restoreDate(B1.win);
    click(doc1.getElementById('detailPanelDone'));

    click(doc1.getElementById('tlBtnPause')); // fold elapsed into base; clock stopped
    click(doc1.getElementById('btnSaveSession')); // explicit save (stub records the payload)
    await sleep(250);
    const saved = B1.stub._calls.saveSession[0];
    ok('P7a: explicit save serialized the session with the possession interval event',
      !!saved && Array.isArray(saved.events) && saved.events.length === 1 &&
      saved.events[0].label === 'Possession' && saved.events[0].isInterval === true,
      'events=' + (saved && saved.events && saved.events.length));
    B1.dom.window.close();

    // Boot 2: load the saved session — the interval must come back intact.
    const B2 = boot({ squad: SQUAD });
    const doc2 = B2.doc;
    await sleep(300);
    B2.stub._setLoadSession(saved);
    click(doc2.getElementById('btnLoadSession'));
    await sleep(350);

    ok('P7b: the loaded session renders the possession event row',
      eventRows(doc2).length === 1 && !!rowByLabel(doc2, 'Possession'),
      'rows=' + eventRows(doc2).length);

    click(doc2.getElementById('btnTouchlineToggle'));
    ok('P7c: after load the quick tag is at REST (no stuck recording state)',
      !!quickBtn(doc2, 'Possession', false) && !quickBtn(doc2, 'Possession', true));

    // Tag a SECOND possession on the loaded session: proves the loaded
    // state is fully live and the loaded interval is preserved intact
    // through the subsequent autosave (loader rebases nextEventId, so the
    // new event cannot collide with the loaded event's id).
    click(doc2.getElementById('tlBtnStart')); // resume the stopped clock (loads stopped)
    click(quickBtn(doc2, 'Possession', false));
    ok('P7d: a new possession can be started on the loaded session',
      !!quickBtn(doc2, 'Possession', true));
    patchDate(B2.win, 12000);
    click(quickBtn(doc2, 'Possession', true));
    restoreDate(B2.win);
    click(doc2.getElementById('detailPanelDone'));

    await sleep(1700);
    const evs = (B2.stub._file.current && B2.stub._file.current.events) || [];
    const loaded = evs.find((e) => e.id === saved.events[0].id);
    ok('P7e: the loaded interval is preserved intact (id, bounds, interval flag, team)',
      !!loaded && loaded.isInterval === true && loaded.label === 'Possession' &&
      loaded.startTime === saved.events[0].startTime &&
      loaded.endTime === saved.events[0].endTime && loaded.team === saved.events[0].team,
      'id=' + (loaded && loaded.id));
    ok('P7f: the new possession coexists with the loaded one (two intervals, distinct ids)',
      evs.filter((e) => e.label === 'Possession').length === 2 &&
      evs.filter((e) => e.label === 'Possession')[1].id !== saved.events[0].id);

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
  console.log('---- touchline possession check: ' + pass + ' passed, ' + fail + ' failed ----');
  console.log('NOTE: jsdom does not compute CSS layout/paint or decode media. The');
  console.log('recording visual (accent + pulse) is verified statically + via class/glyph;');
  console.log('video state is simulated (f2-f3 technique). Real on-screen appearance and');
  console.log('decoder timing must be confirmed manually in Electron.');
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('HARNESS CRASH:', err && err.stack ? err.stack : err);
  process.exit(1);
});
