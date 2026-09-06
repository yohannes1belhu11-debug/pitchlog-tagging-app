#!/usr/bin/env node
// PitchLog / MatchTag — F2.2 Touchline Inline Event Correction regression
// harness (TC series).
// =====================================================================
// Verification-only harness. It does NOT modify any app source file.
//
// Verifies F2.2: the Touchline Mode "Recent Events" feed now supports
// inline correction of an event's Team (badge tap = our ↔ opponent) and
// Player (button tap = quick picker popover), mutating the same events
// array through the same dispatcher pattern as the detail-panel chips
// (field mutation → renderEventList → markAutosaveDirty). While the
// player picker is open, renderTouchlineAll() freezes the feed rebuild so
// the popover and the analyst's scroll place survive the 250ms clock tick.
//
// Checks:
//   STATIC  TC-S1..S10 — source wiring + preservation of every shared
//           path (handleTagPress / startInterval / finishInterval /
//           buildEventBase / detail-panel chip dispatcher / undoLastTag /
//           item seek / newest-first feed order / CSS rules).
//   BOOT T1 team correction: badge UI (A), event.team + side flip (B),
//           rapid taps, field preservation (D), autosave payload,
//           analytics re-partition (engine proof), desktop row tint.
//   BOOT T2 player correction: picker UI (A), freeze while open (new
//           tags hidden until close — no lost place), selection (C),
//           toggle-to-clear + None button (panel semantics), unfreeze (E).
//   BOOT T3 Goal lock: team badge disabled + guarded — score-state
//           integrity (F3 domain) preserved; live score untouched.
//   BOOT T4 undo interplay: undo after an edit removes the whole last
//           LOGGED event (never "the edit"); the corrected event keeps
//           its correction.
//   BOOT T5 possession interplay: an ACTIVE interval is not an event
//           (not in the feed — nothing to corrupt); a COMPLETED
//           possession interval is correctable with bounds intact (D);
//           analytics possession partition follows the correction.
//   BOOT T6 picker + undo: undoing a DIFFERENT event keeps the picker
//           open; undoing the event UNDER correction auto-closes the
//           session and rebuilds the feed.
//   BOOT T7 team toggle while the picker is open: mutation applies, the
//           badge updates in place (frozen feed), Done rebuilds to match.
//
// HONEST SCOPE: jsdom does not compute CSS layout/paint (the popover's
// real on-screen position/size and the badge color rendering must be
// confirmed manually in Electron). jsdom does not decode media; no video
// is used here (the no-video match-clock domain — the correction code is
// video-independent).
//
// Run:  node tests/touchline-correction-check.js   (from the project root)
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
section('STATIC — F2.2 wiring (source-level checks)');
{
  const itemFn = fnBody(rendererSrc, 'touchlineRecentItemHtml');
  // renderTouchlineAll is ~4.5k chars (the feed block sits at its end), so
  // extract it with a larger cap than fnBody's default.
  const rtaStart = rendererSrc.indexOf('function renderTouchlineAll(');
  const rtaFn = rtaStart === -1 ? '' : rendererSrc.slice(rtaStart, rtaStart + 6000);
  const corrFn = fnBody(rendererSrc, 'applyTouchlineTeamCorrection');
  const pcorrFn = fnBody(rendererSrc, 'applyTouchlinePlayerCorrection');

  ok('TC-S1: recent item emits team badge + player button + time + label + event id',
    /data-corr="team"/.test(itemFn) && /data-corr="player"/.test(itemFn) &&
    /class="tl-time"/.test(itemFn) && /class="tl-main"/.test(itemFn) &&
    /data-event-id="\$\{ev\.id\}"/.test(itemFn));
  ok('TC-S2: renderTouchlineAll freezes the feed rebuild while a picker session is open',
    /touchlineRecentEditEventId!=null/.test(rtaFn) && /editActive/.test(rtaFn) &&
    /if\(!editActive\)\{/.test(rtaFn) && /touchlineRecentItemHtml/.test(rtaFn) && /wireTouchlineRecentItem/.test(rtaFn) &&
    rtaFn.indexOf('tlR.innerHTML=recent.map(touchlineRecentItemHtml).join(\'\');') > -1);
  ok('TC-S2b: a vanished event under correction auto-closes the session and rebuilds',
    /if\(touchlineRecentEditEventId!=null\)\{[\s\S]*?closeTouchlinePlayerPicker\(\);[\s\S]*?\}/.test(rtaFn));
  ok('TC-S3: team correction mutates team, re-derives side, and runs the shared dispatcher pattern',
    /ev\.team = next;/.test(corrFn) &&
    /ev\.side = next === 'our' \? 'for' : 'against';/.test(corrFn) &&
    /markAutosaveDirty\(\);/.test(corrFn) && /renderEventList\(\);/.test(corrFn));
  ok('TC-S4: Goal events are locked out of inline team correction (both UI and dispatcher)',
    /isGoal \? ' locked' : ''/.test(itemFn) && /disabled/.test(itemFn) &&
    /if \(ev\.label === 'Goal' \|\| ev\.label === 'GOAL'\) return;/.test(corrFn));
  ok('TC-S5: player correction uses the panel chip toggle-to-clear semantics + dispatcher pattern',
    /ev\.playerId = \(playerId && ev\.playerId !== playerId\) \? playerId : null;/.test(pcorrFn) &&
    /markAutosaveDirty\(\);/.test(pcorrFn) && /renderEventList\(\);/.test(pcorrFn));
  ok('TC-S6: exiting Touchline Mode closes the picker session',
    /closeTouchlinePlayerPicker\(\); \}/.test(fnBody(rendererSrc, 'exitTouchlineMode')));
  ok('TC-S7: preservation — shared interval/creation paths untouched',
    /if \(tag\.interval\) \{[\s\S]*?finishInterval\(tag\)[\s\S]*?startInterval\(tag\)/.test(fnBody(rendererSrc, 'handleTagPress')) &&
    /startMatchSeconds: getCurrentMatchSeconds\(\)/.test(fnBody(rendererSrc, 'startInterval')) &&
    /isInterval: true/.test(fnBody(rendererSrc, 'finishInterval')) &&
    /team: matchClock\.selectedTeam,/.test(fnBody(rendererSrc, 'buildEventBase')));
  ok('TC-S7b: preservation — detail-panel chip dispatcher untouched (player/side/subtype/qualifier)',
    /ev\[fieldName\] = alreadySelected \? null : playerId;/.test(fnBody(rendererSrc, 'renderDetailPanel')) &&
    /ev\.side = \(ev\.side === value\) \? null : value;/.test(fnBody(rendererSrc, 'renderDetailPanel')));
  ok('TC-S7c: preservation — undoLastTag untouched; item tap still seeks (F1.2 domain)',
    /applyGoalRemovalScoreCorrection\(undoneEvent\);/.test(fnBody(rendererSrc, 'undoLastTag')) &&
    /if \(currentVideoPath && ev\.videoTime !== null\) seekTo\(ev\.videoTime\);/.test(fnBody(rendererSrc, 'wireTouchlineRecentItem')));
  ok('TC-S8: CSS rules present (badge states, locked, picker grid with bounded scroll, selected)',
    /\.tl-corr-team-our\s*\{/.test(stylesSrc) && /\.tl-corr-team-opp\s*\{/.test(stylesSrc) &&
    /\.tl-corr-team\.locked\s*\{/.test(stylesSrc) &&
    /\.tl-player-picker-grid\s*\{[^}]*max-height: 34vh;[^}]*overflow-y: auto;/.test(stylesSrc) &&
    /\.tl-player-picker-grid \.touchline-tag-btn\.selected\s*\{/.test(stylesSrc));
  ok('TC-S9: feed order still newest-first (live-feed behavior preserved)',
    /events\.slice\(-10\)\.reverse\(\)/.test(rtaFn));
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
    saveSession: async (d) => { calls.saveSession.push(clone(d)); return { canceled: false, filePath: '/tmp/tc-session.json' }; },
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
function feedItems(doc) { return Array.from(doc.querySelectorAll('#touchlineRecentEvents .touchline-recent-item')); }
function feedItemByLabel(doc, label) { return feedItems(doc).find((r) => r.textContent.indexOf(label) > -1) || null; }
function teamBadge(doc, label) {
  const item = feedItemByLabel(doc, label);
  return item ? item.querySelector('[data-corr="team"]') : null;
}
function playerBtn(doc, label) {
  const item = feedItemByLabel(doc, label);
  return item ? item.querySelector('[data-corr="player"]') : null;
}
function pickerEl(doc) { return doc.getElementById('touchlinePlayerPicker'); }
function pickerGridBtns(doc) { return pickerEl(doc) ? Array.from(pickerEl(doc).querySelectorAll('.tl-player-picker-grid button')) : []; }
function eventRows(doc) { return Array.from(doc.querySelectorAll('#eventList .event-row')); }

function patchDate(win, ms) {
  win.eval('window.__tcOrigNow = Date.now; window.__tcT0 = Date.now(); Date.now = () => window.__tcT0 + ' + ms + ';');
}
function restoreDate(win) {
  win.eval('Date.now = window.__tcOrigNow; delete window.__tcOrigNow; delete window.__tcT0;');
}

const SQUAD = [
  { id: 'player_1', number: '1', name: 'Ana One' },
  { id: 'player_2', number: '2', name: 'Ben Two' },
  { id: 'player_3', number: '3', name: 'Cal Three' }
];

(async () => {
  // =====================================================================
  section('BOOT T1 — team correction: badge UI, state flip, rapid taps, field preservation, analytics');
  // =====================================================================
  {
    const B = boot({ squad: SQUAD });
    const doc = B.doc;
    await sleep(300);

    click(doc.getElementById('btnTouchlineToggle'));
    click(doc.getElementById('tlBtnStart'));
    click(quickBtn(doc, 'Shot'));
    click(doc.getElementById('detailPanelDone'));

    ok('T1a: correction UI present on the recent card (team badge + player button) [req A]',
      !!teamBadge(doc, 'Shot') && !!playerBtn(doc, 'Shot'),
      'badge=' + !!teamBadge(doc, 'Shot') + ' player=' + !!playerBtn(doc, 'Shot'));
    ok('T1b: badge renders the OUR state (class + text)',
      teamBadge(doc, 'Shot').textContent === 'US' && teamBadge(doc, 'Shot').classList.contains('tl-corr-team-our'));

    // Field preservation snapshot (everything except team/side), captured
    // from the first autosave after tagging.
    await sleep(1700);
    const snap = B.stub._file.current && B.stub._file.current.events[0];
    ok('T1c: pre-correction event captured from the autosaved session',
      !!snap && snap.label === 'Shot' && snap.team === 'our' && snap.side === 'for',
      'label=' + (snap && snap.label) + ' team=' + (snap && snap.team));
    const beforeFields = JSON.parse(JSON.stringify(snap));

    click(teamBadge(doc, 'Shot')); // FIRST correction
    ok('T1d: badge immediately reflects OPP (class + text) after the tap [req B]',
      teamBadge(doc, 'Shot').textContent === 'OPP' && teamBadge(doc, 'Shot').classList.contains('tl-corr-team-opp'));
    ok('T1e: desktop event row tint follows the correction (event-row-against rendered)',
      eventRows(doc).some((r) => r.classList.contains('event-row-against')));

    // Rapid taps: two more flips pass back through our and to opponent
    // (3 total — an odd number of flips from the original).
    click(teamBadge(doc, 'Shot'));
    click(teamBadge(doc, 'Shot'));
    ok('T1f: rapid taps stay consistent (3 taps total from our → opponent)',
      teamBadge(doc, 'Shot').textContent === 'OPP');

    await sleep(1700);
    const saved = B.stub._file.current;
    const ev1 = saved && saved.events[0];
    ok('T1g: autosave payload carries the corrected team/side [persistence]',
      !!ev1 && ev1.team === 'opponent' && ev1.side === 'against',
      'team=' + (ev1 && ev1.team) + ' side=' + (ev1 && ev1.side));
    ok('T1h: every OTHER field is unchanged by the corrections [req D]',
      !!ev1 && ['id','time','videoTime','matchTime','matchSeconds','officialMinute','second','period','label','subtype','qualifiers','location','playerId','sequenceId','scoreForBefore','scoreAgainstBefore'].every((k) =>
        JSON.stringify(ev1[k]) === JSON.stringify(beforeFields[k])),
      'id=' + (ev1 && ev1.id) + ' vs ' + (beforeFields && beforeFields.id) + ' time=' + (ev1 && ev1.time));

    const R = B.win.AnalyticsEngine.computeMatchAnalytics(saved);
    const L1T = R && R.level1 && R.level1.team;
    ok('T1i: analytics re-partition the corrected shot to the OPPONENT bucket (instant propagation)',
      !!L1T && L1T.opponent.shots.value === 1 && L1T.our.shots.value === 0,
      'opp=' + (L1T && L1T.opponent.shots.value) + ' our=' + (L1T && L1T.our.shots.value));

    B.dom.window.close();
  }

  // =====================================================================
  section('BOOT T2 — player correction: picker, freeze, selection, toggle-to-clear [reqs A,C,E]');
  // =====================================================================
  {
    const B = boot({ squad: SQUAD });
    const doc = B.doc;
    await sleep(300);

    click(doc.getElementById('btnTouchlineToggle'));
    click(doc.getElementById('tlBtnStart'));
    click(quickBtn(doc, 'Shot'));
    click(doc.getElementById('detailPanelDone'));

    ok('T2a: player button starts at "— no player" and is tappable',
      playerBtn(doc, 'Shot') && playerBtn(doc, 'Shot').textContent === '— no player');

    click(playerBtn(doc, 'Shot'));
    ok('T2b: tapping the player button opens the quick picker inside the overlay [req A]',
      !!pickerEl(doc) && pickerEl(doc).closest('#touchlineOverlay') !== null);
    ok('T2c: picker lists None + the full squad as quick-tap buttons',
      pickerGridBtns(doc).length === 4 &&
      pickerGridBtns(doc).some((b) => b.textContent === '— None —') &&
      pickerGridBtns(doc).some((b) => b.textContent === '#2 Ben Two'));
    ok('T2d: None button is marked selected while no player is set',
      pickerGridBtns(doc).find((b) => b.textContent === '— None —').classList.contains('selected'));

    // Freeze proof: tag another event while the picker is open.
    click(quickBtn(doc, 'Press'));
    click(doc.getElementById('detailPanelDone'));
    ok('T2e: feed is FROZEN while the picker is open (new Press event logged but not yet shown)',
      eventRows(doc).length === 2 && feedItems(doc).length === 1,
      'desktopRows=' + eventRows(doc).length + ' feed=' + feedItems(doc).length);
    ok('T2f: the picker itself survives (no lost place during the edit)',
      !!pickerEl(doc));

    // Select Ben.
    click(pickerGridBtns(doc).find((b) => b.textContent === '#2 Ben Two'));
    ok('T2g: selecting a player sets event.playerId, closes the picker, unfreezes the feed [req C+E]',
      !pickerEl(doc) && feedItems(doc).length === 2 && playerBtn(doc, 'Shot').textContent === '#2 Ben Two',
      'picker=' + !pickerEl(doc) + ' feed=' + feedItems(doc).length +
      ' btn=' + (playerBtn(doc, 'Shot') && playerBtn(doc, 'Shot').textContent));
    ok('T2h: live tagging continues immediately after the edit (Press card present, newest first) [req E]',
      feedItems(doc)[0].textContent.indexOf('Press') > -1 && feedItems(doc)[1].textContent.indexOf('Shot') > -1);

    // Re-open: Ben selected; tapping Ben again CLEARS (panel chip semantics).
    click(playerBtn(doc, 'Shot'));
    const benBtn = pickerGridBtns(doc).find((b) => b.textContent === '#2 Ben Two');
    ok('T2i: re-opened picker marks the current player selected',
      benBtn && benBtn.classList.contains('selected'));
    click(benBtn);
    ok('T2j: tapping the already-selected player CLEARS the attribution (panel chip semantics)',
      playerBtn(doc, 'Shot').textContent === '— no player' && !pickerEl(doc));

    // None button clears too.
    click(playerBtn(doc, 'Shot'));
    click(pickerGridBtns(doc).find((b) => b.textContent === '#3 Cal Three'));
    ok('T2k: a different player can be set',
      playerBtn(doc, 'Shot').textContent === '#3 Cal Three');
    click(playerBtn(doc, 'Shot'));
    click(pickerGridBtns(doc).find((b) => b.textContent === '— None —'));
    ok('T2l: the None button clears the attribution',
      playerBtn(doc, 'Shot').textContent === '— no player');

    await sleep(1700);
    const ev = B.stub._file.current && B.stub._file.current.events.find((e) => e.label === 'Shot');
    ok('T2m: autosave payload carries the corrected player state',
      !!ev && ev.playerId === null);

    B.dom.window.close();
  }

  // =====================================================================
  section('BOOT T3 — Goal lock: team badge disabled + guarded (score integrity)');
  // =====================================================================
  {
    const B = boot({ squad: SQUAD });
    const doc = B.doc;
    await sleep(300);

    click(doc.getElementById('btnTouchlineToggle'));
    click(doc.getElementById('tlBtnStart'));
    click(quickBtn(doc, 'Goal'));
    click(doc.getElementById('detailPanelDone'));

    const badge = teamBadge(doc, 'Goal');
    ok('T3a: Goal team badge is rendered LOCKED + disabled',
      !!badge && badge.classList.contains('locked') && badge.disabled === true);

    click(badge); // even if the click dispatches, the dispatcher guard must hold
    await sleep(1700);
    const ev = B.stub._file.current && B.stub._file.current.events[0];
    ok('T3b: goal team/side/score fields are untouched by the tap attempt',
      !!ev && ev.label === 'Goal' && ev.team === 'our' && ev.side === 'for' &&
      ev.scoreForBefore === 0 && ev.scoreForAfter === 1 && ev.scoreAgainstBefore === 0 && ev.scoreAgainstAfter === 0,
      'team=' + (ev && ev.team) + ' forAfter=' + (ev && ev.scoreForAfter));
    ok('T3c: live scoreboard still shows 1 — 0 (score-state integrity preserved)',
      doc.getElementById('touchlineScore').textContent.trim() === '1 — 0',
      doc.getElementById('touchlineScore').textContent.trim());

    // Player correction remains available on Goal (only team is locked).
    click(playerBtn(doc, 'Goal'));
    click(pickerGridBtns(doc).find((b) => b.textContent === '#1 Ana One'));
    ok('T3d: player correction still works on a Goal event',
      playerBtn(doc, 'Goal').textContent === '#1 Ana One');

    B.dom.window.close();
  }

  // =====================================================================
  section('BOOT T4 — undo interplay: undo removes the whole last-logged event, never "the edit"');
  // =====================================================================
  {
    const B = boot({ squad: SQUAD });
    const doc = B.doc;
    await sleep(300);

    click(doc.getElementById('btnTouchlineToggle'));
    click(doc.getElementById('tlBtnStart'));
    click(quickBtn(doc, 'Shot'));
    click(doc.getElementById('detailPanelDone'));
    click(quickBtn(doc, 'Chance'));
    click(doc.getElementById('detailPanelDone'));

    click(teamBadge(doc, 'Shot')); // correct the OLDER event to opponent
    ok('T4a: correction applied to the Shot (not the last-logged Chance)',
      teamBadge(doc, 'Shot').textContent === 'OPP');

    click(doc.getElementById('tlBtnUndo'));
    ok('T4b: undo removes the last LOGGED event (Chance), not the corrected Shot',
      feedItems(doc).length === 1 && !!feedItemByLabel(doc, 'Shot') && !feedItemByLabel(doc, 'Chance'));
    await sleep(1700);
    const evs = (B.stub._file.current && B.stub._file.current.events) || [];
    ok('T4c: the corrected event survives undo WITH its correction (team=opponent)',
      evs.length === 1 && evs[0].label === 'Shot' && evs[0].team === 'opponent' && evs[0].side === 'against');

    B.dom.window.close();
  }

  // =====================================================================
  section('BOOT T5 — possession interplay: active interval absent from feed; completed interval correctable');
  // =====================================================================
  {
    const B = boot({ squad: SQUAD });
    const doc = B.doc;
    await sleep(300);

    click(doc.getElementById('btnTouchlineToggle'));
    click(doc.getElementById('tlBtnStart'));

    click(quickBtn(doc, 'Possession', false)); // START the interval (F2.1)
    ok('T5a: an ACTIVE possession interval is not an event — nothing in the feed to edit',
      feedItems(doc).length === 0);
    ok('T5b: the recording state is visible while the interval runs (F2.1 intact)',
      !!quickBtn(doc, 'Possession', true));

    patchDate(B.win, 12000);
    click(quickBtn(doc, 'Possession', true)); // finish
    restoreDate(B.win);
    click(doc.getElementById('detailPanelDone'));

    ok('T5c: the COMPLETED possession appears in the feed with an unlocked badge',
      feedItems(doc).length === 1 && teamBadge(doc, 'Possession') && !teamBadge(doc, 'Possession').disabled);

    click(teamBadge(doc, 'Possession')); // correct to opponent
    await sleep(1700);
    const ev = B.stub._file.current && B.stub._file.current.events[0];
    ok('T5d: team correction applies to the interval event; bounds/flags unchanged [req D]',
      !!ev && ev.team === 'opponent' && ev.isInterval === true && ev.videoTime === null &&
      ev.startTime === ev.time && ev.matchTime === ev.time && (ev.endTime - ev.startTime) >= 10 && (ev.endTime - ev.startTime) <= 14,
      'dur=' + (ev && (ev.endTime - ev.startTime)));

    const R = B.win.AnalyticsEngine.computeMatchAnalytics(B.stub._file.current);
    const P = R && R.level1 && R.level1.possession;
    ok('T5e: possession analytics follow the correction (opponent bucket = 1, our = 0)',
      !!P && P.opponent.intervals.value === 1 && P.our.intervals.value === 0);

    click(teamBadge(doc, 'Possession')); // rapid second flip back to our
    await sleep(1700); // let the debounced autosave capture the flip
    const R2 = B.win.AnalyticsEngine.computeMatchAnalytics(B.stub._file.current);
    const P2 = R2 && R2.level1 && R2.level1.possession;
    ok('T5f: rapid re-correction flips the partition back (our = 1)',
      !!P2 && P2.our.intervals.value === 1 && P2.opponent.intervals.value === 0,
      'our=' + (P2 && P2.our.intervals.value) + ' opp=' + (P2 && P2.opponent.intervals.value));

    B.dom.window.close();
  }

  // =====================================================================
  section('BOOT T6 — picker vs undo: other-event undo keeps the picker; own-event undo auto-closes');
  // =====================================================================
  {
    // (a) Undo a DIFFERENT event while correcting Shot.
    const B = boot({ squad: SQUAD });
    const doc = B.doc;
    await sleep(300);
    click(doc.getElementById('btnTouchlineToggle'));
    click(doc.getElementById('tlBtnStart'));
    click(quickBtn(doc, 'Shot'));
    click(doc.getElementById('detailPanelDone'));
    click(quickBtn(doc, 'Chance'));
    click(doc.getElementById('detailPanelDone'));

    click(playerBtn(doc, 'Shot')); // picker on the OLDER event
    click(doc.getElementById('tlBtnUndo')); // removes Chance
    // NOTE: the feed is frozen during the session, so the stale Chance card
    // may still be displayed BY DESIGN (it disappears on session close); the
    // desktop event list is the live truth source here.
    ok('T6a: undoing a different event keeps the picker open (correction continues)',
      !!pickerEl(doc) && !!feedItemByLabel(doc, 'Shot') && eventRows(doc).length === 1,
      'picker=' + !!pickerEl(doc) + ' desktopRows=' + eventRows(doc).length);
    click(pickerGridBtns(doc).find((b) => b.textContent === '#1 Ana One'));
    ok('T6b: the pending player correction still applies after the undo (feed catches up on close)',
      playerBtn(doc, 'Shot').textContent === '#1 Ana One' && feedItems(doc).length === 1);
    B.dom.window.close();
  }
  {
    // (b) Undo the event UNDER correction.
    const B = boot({ squad: SQUAD });
    const doc = B.doc;
    await sleep(300);
    click(doc.getElementById('btnTouchlineToggle'));
    click(doc.getElementById('tlBtnStart'));
    click(quickBtn(doc, 'Shot'));
    click(doc.getElementById('detailPanelDone'));
    click(quickBtn(doc, 'Chance'));
    click(doc.getElementById('detailPanelDone'));

    click(playerBtn(doc, 'Chance')); // picker on the LAST-LOGGED event
    ok('T6c: picker open on the last-logged event',
      !!pickerEl(doc));
    click(doc.getElementById('tlBtnUndo')); // removes Chance → session must auto-close
    ok('T6d: undoing the event under correction AUTO-CLOSES the session and rebuilds the feed',
      !pickerEl(doc) && feedItems(doc).length === 1 && !!feedItemByLabel(doc, 'Shot'));
    B.dom.window.close();
  }

  // =====================================================================
  section('BOOT T7 — team toggle while the picker is open (frozen feed, in-place badge update)');
  // =====================================================================
  {
    const B = boot({ squad: SQUAD });
    const doc = B.doc;
    await sleep(300);
    click(doc.getElementById('btnTouchlineToggle'));
    click(doc.getElementById('tlBtnStart'));
    click(quickBtn(doc, 'Shot'));
    click(doc.getElementById('detailPanelDone'));

    click(playerBtn(doc, 'Shot')); // open the picker (feed freezes)
    const frozenBadge = teamBadge(doc, 'Shot');
    click(frozenBadge); // team toggle on the frozen DOM
    ok('T7a: the mutation applies and the frozen badge updates IN PLACE',
      frozenBadge.textContent === 'OPP' && frozenBadge.classList.contains('tl-corr-team-opp'));
    ok('T7b: the picker stays open across the team toggle',
      !!pickerEl(doc));

    click(pickerEl(doc).querySelector('.tl-player-picker-done')); // Done
    ok('T7c: Done closes the session and the rebuilt feed matches the state (badge OPP)',
      !pickerEl(doc) && teamBadge(doc, 'Shot').textContent === 'OPP');
    await sleep(1700);
    const ev = B.stub._file.current && B.stub._file.current.events[0];
    ok('T7d: the corrected state persists (team=opponent)',
      !!ev && ev.team === 'opponent');

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
  console.log('---- touchline correction check: ' + pass + ' passed, ' + fail + ' failed ----');
  console.log('NOTE: jsdom does not compute CSS layout/paint. The picker popover position,');
  console.log('badge color rendering, and touch ergonomics must be confirmed manually in');
  console.log('Electron. No video/media decoding is exercised (correction is video-independent).');
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('HARNESS CRASH:', err && err.stack ? err.stack : err);
  process.exit(1);
});
