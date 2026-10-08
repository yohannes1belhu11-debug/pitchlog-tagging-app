#!/usr/bin/env node
// PitchLog / MatchTag — Stage 4A Milestone 3: MATCH ANALYSIS DASHBOARD UI
// harness (behavioral, full real-path).
// ============================================================================
// Verification-only harness. It does NOT modify any app source file.
//
// Boots the REAL index.html + integrity.js + roster.js + analytics.js +
// player-season.js + match-analysis.js + renderer.js into jsdom with a
// stubbed window.matchtag bridge (same architecture as
// matchday-squad-ui-check.js), loads the spec §10 fixtures through the app's
// OWN btnLoadSession pathway, and drives the dashboard end-to-end through
// the REAL commit-A wiring: btnMatchAnalysis → openMatchAnalysisModal →
// window.MatchAnalysisDashboard.renderAnalysis(matchAnalysisContent,
// matchAnalysisSnapshot(), matchAnalysisHost()) — with the renderer's REAL
// host API (seekTo → video.currentTime, resolveMatchdayPlayer → the R3-A
// resolver chain, pitchMarkingsSvg, ZONE_LINES_SVG, DENSITY_FILLS,
// densityStep). The model suite (match-analysis-model-check.js) verifies the
// module's projection against the engine; THIS suite verifies the WIRING:
// modal mechanism, §13 section inventory through the real boot, the real
// seek pathway, host provenance, snapshot purity, §12.1 Space propagation,
// the preserved Analytics tab, empty/base-session rendering, and the §9
// static wiring/CSS law.
//
// Every pinned value below was verified against the real app path (scratch
// boot runs of this exact harness shape) BEFORE this suite was finalized —
// same discipline as the model suite.
//
//   MA-U1  modal chrome & open mechanism (topbar button, overlay
//          conventions, module live through the real script chain)
//   MA-U2  close paths: Done, Escape-elsewhere, Escape-in-form (both
//          Escape branches of the wiring); per-open recompute
//   MA-U3  §13 section inventory: 9 sections, exact keys, exact order,
//          titles; players/sequences/protocol spot presence
//   MA-U4  header (§13.1): metadata, score, facts
//   MA-U5  cards (§4): 10 cards, keys/labels/values, 'our · opponent'
//   MA-U6  chronological key events (§5): 17 rows, order + id tiebreak,
//          data-videotime/data-time, display labels, REAL-resolver player
//          texts, team labels
//   MA-U7  end-to-end seek through the REAL pathway: row clicks set
//          video.currentTime (videoTime-first, ?? time fallback)
//   MA-U8  spatial (§3): grid inventory, REAL host provenance
//          (pitch-outline markings, 4 an-zoneline lines, crimson
//          DENSITY_FILLS), minimum-sample gate both sides, 3×3 zcells
//   MA-U9  zone activation: shared function on the pointer path AND the
//          keyboard path (Enter), trace open/close
//   MA-U10 Space propagation (§12.1 — accepted behavior, asserted not
//          fixed): reaches window, preventDefault, global play/pause acts,
//          zone toggles — both effects from ONE keydown
//   MA-U11 snapshot purity (§8): double-save byte comparison across the
//          whole dashboard-use scenario; zero autosave writes
//   MA-U12 Analytics tab preserved; per-open recompute across a session
//          switch (oracle → base): zero cards, empty-state enumeration,
//          below-gate grid
//   MA-U13 empty session (no session loaded) renders gracefully; §9 static
//          law: index.html wiring, styles.css ma-* rules + the three
//          responsive breakpoints, base-stylesheet sentinels intact
//   MA-U14 Stage 4B filter controls + interactions (§14.1/§14.2/§14.3 — both
//          bars at a real boot, only-the-affected-section re-renders, Reset
//          affordances, fresh-open defaults, bar state persistence; + the
//          §9-style filter-bar CSS law)
//   MA-U15 Stage 4B suppression + context stating (§14.5/§14.6 — engine path
//          with a valid chain: doctored X1 MISMATCH via matchInfo ourScore 2
//          vs the intact 1–1 chain; disabled control + explanation, the
//          summary/banner/unattributed-note exact strings, the (filtered
//          view) suffixes)
//   MA-U16 Stage 4B purity under filtering + renderer retention (§8/§14.8 —
//          save payload byte-identical across filter changes, zero autosave
//          writes; RED-FIRST source pin: renderer.js retains the
//          renderAnalysis return on open and nulls it in
//          closeMatchAnalysisModal — both close paths funnel there)
//
// Run:  node tests/match-analysis-ui-check.js   (from the project root)
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
  console.error('Run npm run setup-tests first (see scripts/setup-tests.js).');
  process.exit(2);
}

const srcDir = path.join(__dirname, '..', 'src');
const html = fs.readFileSync(path.join(srcDir, 'index.html'), 'utf8');
const stylesCss = fs.readFileSync(path.join(srcDir, 'styles.css'), 'utf8');
const integritySrc = fs.readFileSync(path.join(srcDir, 'integrity.js'), 'utf8');
const rosterSrc = fs.readFileSync(path.join(srcDir, 'roster.js'), 'utf8');
const analyticsSrc = fs.readFileSync(path.join(srcDir, 'analytics.js'), 'utf8');
const playerSeasonSrc = fs.readFileSync(path.join(srcDir, 'player-season.js'), 'utf8');
const matchAnalysisSrc = fs.readFileSync(path.join(srcDir, 'match-analysis.js'), 'utf8');
const rendererSrc = fs.readFileSync(path.join(srcDir, 'renderer.js'), 'utf8');

const results = [];
let SECTION = '(pre)';
function section(name) { SECTION = name; console.log('\n===== ' + name + ' ====='); }
function ok(id, cond, detail) {
  results.push({ section: SECTION, id, pass: !!cond, detail: detail === undefined ? '' : String(detail) });
  console.log((cond ? '[PASS] ' : '[FAIL] ') + id + (detail === undefined ? '' : '  | ' + detail));
  if (!cond) process.exitCode = 1;
}
const jsdomErrors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function clone(x) { return x == null ? x : JSON.parse(JSON.stringify(x)); }

// Robust class query in jsdom (SVG elements: use the class attribute).
function qsaClass(scope, cls) {
  return Array.from(scope.querySelectorAll('*')).filter((el) => {
    const c = el.getAttribute && el.getAttribute('class');
    return c && c.split(/\s+/).indexOf(cls) !== -1;
  });
}
function attrAll(els, name) { return els.map((el) => el.getAttribute(name)); }
function textAll(els, sel) {
  return els.map((el) => (sel ? el.querySelector(sel).textContent : el.textContent));
}

// ---------------------------------------------------------------------------
// matchtag stub with call capture (same shape as matchday-squad-ui-check.js
// — the dashboard must ride the app's exact bridge).
// ---------------------------------------------------------------------------
function makeStub(initial) {
  const calls = {
    saveSession: [], autosaveWrite: [], flushSync: [], saveSquad: [],
    autosaveDelete: 0, loadSessionCalls: 0
  };
  const state = {
    loadSessionData: null,
    saveSessionResult: { canceled: true },
    autosaveData: initial.autosave !== undefined ? initial.autosave : null
  };
  const stub = {
    openVideo: async () => null,
    saveSession: async (d) => { calls.saveSession.push(clone(d)); return clone(state.saveSessionResult); },
    exportCsv: async () => ({ canceled: true }),
    exportClipPlaylist: async () => ({ canceled: true }),
    loadSession: async () => { calls.loadSessionCalls++; return clone(state.loadSessionData); },
    loadMultipleSessions: async () => [],
    loadSquad: async () => clone(initial.squad || []),
    saveSquad: async (s) => { calls.saveSquad.push(clone(s)); return true; },
    loadTagLibrary: async () => null,
    saveTagLibrary: async () => ({ ok: true, path: '/tmp/tags.json' }),
    detachVideo: async () => true,
    reattachVideo: async () => true,
    sendVideoCommand: () => {},
    onVideoState: () => {},
    onVideoClosed: () => {},
    autosaveRead: async () => clone(state.autosaveData),
    autosaveWrite: async (d) => { calls.autosaveWrite.push(clone(d)); return { ok: true, path: '/tmp/autosave.json' }; },
    autosaveDelete: async () => { calls.autosaveDelete++; return { ok: true }; },
    autosaveFlushSync: (d) => { calls.flushSync.push(clone(d)); return { ok: true }; },
    onCloseRequested: () => {},
    onAutosaveFlushRequested: () => {},
    closeProceed: () => {},
    _setLoadSession: (d) => { state.loadSessionData = d; },
    _setSaveResult: (r) => { state.saveSessionResult = r; },
    _setAutosave: (d) => { state.autosaveData = d; },
    _calls: calls
  };
  return stub;
}

// The real script chain, in the real order (spec §9): match-analysis.js is
// evaluated BETWEEN the engine family and renderer.js, exactly as the
// index.html script order mandates (MS-W1 guards the static order; this
// boot proves the chain actually executes in it).
function boot(initial) {
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => { jsdomErrors.push(String(e.message || e)); });
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'file://' + path.join(srcDir, 'index.html'), virtualConsole: vc });
  const win = dom.window;
  const stub = makeStub(initial || {});
  win.matchtag = stub;
  win.eval(integritySrc);
  win.eval(rosterSrc);
  win.eval(analyticsSrc);
  win.eval(playerSeasonSrc);
  win.eval(matchAnalysisSrc);
  win.eval(rendererSrc);
  return { dom, win, doc: win.document, stub };
}

function clickIn(B, el) { el.dispatchEvent(new B.win.MouseEvent('click', { bubbles: true, cancelable: true })); }
function keydownIn(B, el, opts) {
  el.dispatchEvent(new B.win.KeyboardEvent('keydown', Object.assign({ bubbles: true, cancelable: true }, opts)));
}
function lastSave(stub) { const a = stub._calls.saveSession; return a.length ? a[a.length - 1] : null; }

// ---------------------------------------------------------------------------
// Fixtures — the SAME oracle/base shapes as tests/match-analysis-model-check.js
// (spec §10: oracle = 19 recovered events / 17 key rows / seeks 240,
// null→1350 fallback, 140; base = 12 events, zero qualifying key labels).
// ---------------------------------------------------------------------------
function E(id, fields) {
  return Object.assign({
    id: id, time: null, matchTime: null, label: null, team: null, subtype: null,
    playerId: null, playerOffId: null, playerOnId: null, qualifiers: {},
    location: null, period: '1H', matchSeconds: 0, officialMinute: 0, second: 0,
    scoreForBefore: 0, scoreAgainstBefore: 0, scoreForAfter: null,
    scoreAgainstAfter: null, sequenceId: null, videoTime: undefined,
    isInterval: false, startTime: null, endTime: null, outcome: null
  }, fields);
}

function oracleSession() {
  const squad = [
    { id: 'player_1', name: 'Abebe Bekele', number: '9' },
    { id: 'player_2', name: 'Kebede Tadesse', number: '10' },
    { id: 'player_3', name: 'Mulugeta Ayalew', number: '7' },
    { id: 'player_4', name: 'Dawit Haile', number: '4' },
    { id: 'player_5', name: 'Yonas Girma', number: '14' },
    { id: 'player_6', name: 'Solomon Mamo', number: '6' },
    { id: 'player_7', name: 'Tesfaye Alemu', number: '18' },
    { id: 'player_8', name: 'Getachew Worku', number: '21' }
  ];
  // Events 13/14 sit in scrambled array order at equal times (the id
  // tiebreak must come from the module's sort-a-copy, never the source).
  const events = [
    E(1, { time: 40, period: '1H', matchSeconds: 40, label: 'Goal', team: 'our', playerId: 'player_1', location: { x: 0.9, y: 0.5 }, videoTime: 40, scoreForAfter: 1, scoreAgainstAfter: 0, sequenceId: 'SEQ-001' }),
    E(2, { time: 245, period: '1H', matchSeconds: 245, label: 'Shot', team: 'our', playerId: 'player_2', subtype: 'On target', location: { x: 0.85, y: 0.3 }, videoTime: 240 }),
    E(3, { time: 480, period: '1H', matchSeconds: 480, label: 'Chance', team: 'our', playerId: 'player_1', location: { x: 0.8, y: 0.7 } }),
    E(4, { time: 950, period: '1H', matchSeconds: 950, label: 'Cross', team: 'our', playerId: 'player_8', location: { x: 0.75, y: 0.25 } }),
    E(5, { time: 1000, period: '1H', matchSeconds: 1000, label: 'Corner', team: null }),
    E(6, { time: 1350, period: '1H', matchSeconds: 1350, label: 'Shot', team: 'our', playerId: 'player_2', subtype: 'Off target', location: { x: 0.7, y: 0.6 }, videoTime: null }),
    E(7, { time: 1700, period: '1H', matchSeconds: 1700, label: 'Foul', team: 'opponent', location: { x: 0.3, y: 0.8 } }),
    E(8, { time: 2760, period: '1H', matchSeconds: 2760, label: 'Card', team: 'opponent', subtype: 'Yellow' }),
    E(9, { time: 2800, period: '2H', matchSeconds: 2800, label: 'Sub', team: 'our', playerOffId: 'player_4', playerOnId: 'player_5', location: { x: 0.2, y: 0.5 } }),
    E(10, { time: 3100, period: '2H', matchSeconds: 3100, label: 'Sub', team: 'our', playerOffId: 'player_6', playerOnId: 'player_7' }),
    E(11, { time: 3400, period: '2H', matchSeconds: 3400, label: 'Sub', team: 'opponent', playerOffId: 'match_opp_9', playerOnId: 'match_opp_10', location: { x: 0.6, y: 0.2 } }),
    E(12, { time: 3700, period: '2H', matchSeconds: 3700, label: 'Positive Transition', team: 'our', location: { x: 0.5, y: 0.5 }, videoTime: 140 }),
    E(14, { time: 4000, period: '2H', matchSeconds: 4000, label: 'Positive Transition', team: 'our' }),
    E(13, { time: 4000, period: '2H', matchSeconds: 4000, label: 'Positive Transition', team: 'our' }),
    E(15, { time: 4300, period: '2H', matchSeconds: 4300, label: 'Positive Transition', team: 'opponent', location: { x: 0.55, y: 0.75 } }),
    E(16, { time: 4600, period: '2H', matchSeconds: 4600, label: 'Card', team: 'our', playerId: 'player_2', subtype: 'Red' }),
    E(17, { time: 4900, period: '2H', matchSeconds: 4900, label: 'Pass', team: 'our', playerId: 'player_1', subtype: 'Progressive', qualifiers: { Outcome: 'Successful', Pressure: 'Free' }, location: { x: 0.4, y: 0.4 }, sequenceId: 'SEQ-001' }),
    E(18, { time: 5200, period: '2H', matchSeconds: 5200, label: 'Press', team: 'our', playerId: 'player_2', outcome: 'SUCCESS' }),
    E(19, { time: 5300, period: '2H', matchSeconds: 5300, label: 'Goal', team: 'opponent', scoreForBefore: 1, scoreAgainstBefore: 0, scoreForAfter: 1, scoreAgainstAfter: 1, sequenceId: 'SEQ-002' })
  ];
  return {
    __schemaVersion: 3, __savedAt: '2026-10-03T18:00:00.000Z',
    videoPath: null, videoUrl: null,
    matchInfo: {
      competition: 'Bahir Dar Premier League', homeAway: 'home',
      opponent: 'Dashen Beer FC', date: '2026-10-03', formation: '4-3-3',
      venue: 'Bahir Dar Stadium', ourScore: 1, opponentScore: 1,
      startingXI: [{ playerId: 'player_1' }, { playerId: 'player_2' }, { playerId: 'player_3' },
        { playerId: 'player_4' }, { playerId: 'player_6' }]
    },
    matchClock: { period: 'FT', scoreFor: 1, scoreAgainst: 1 },
    squad: squad,
    events: events
  };
}

function baseSession() {
  const events = [
    E(1, { time: 60, period: '1H', matchSeconds: 60, label: 'Pass', team: 'our', playerId: 'player_1', subtype: 'Progressive', qualifiers: { Outcome: 'Successful', Pressure: 'Free' }, location: { x: 0.5, y: 0.5 } }),
    E(2, { time: 120, period: '1H', matchSeconds: 120, label: 'Pass', team: 'our', playerId: 'player_1', subtype: 'Lateral', qualifiers: { Outcome: 'Successful', Pressure: 'Under pressure' }, location: { x: 0.45, y: 0.55 } }),
    E(3, { time: 180, period: '1H', matchSeconds: 180, label: 'Pass', team: 'our', playerId: 'player_2', subtype: 'Long', qualifiers: { Outcome: 'Unsuccessful', Pressure: 'Free' }, location: { x: 0.4, y: 0.6 } }),
    E(4, { time: 240, period: '1H', matchSeconds: 240, label: 'Press', team: 'our', playerId: 'player_1', outcome: 'SUCCESS', location: { x: 0.3, y: 0.3 } }),
    E(5, { time: 300, period: '1H', matchSeconds: 300, label: 'Press', team: 'our', playerId: 'player_2', outcome: 'FAILURE' }),
    E(6, { time: 360, period: '1H', matchSeconds: 360, label: 'Press Win', team: 'our', playerId: 'player_1', location: { x: 0.35, y: 0.35 } }),
    E(7, { time: 420, period: '1H', matchSeconds: 420, label: 'Key Pass', team: 'our', playerId: 'player_2' }),
    E(8, { time: 500, period: '1H', matchSeconds: 500, label: 'Possession', team: 'our', isInterval: true, startTime: 500, endTime: 560, qualifiers: { 'Ended by': 'Shot' } }),
    E(9, { time: 600, period: '1H', matchSeconds: 600, label: 'Recovery', team: 'opponent', location: { x: 0.6, y: 0.4 } }),
    E(10, { time: 660, period: '1H', matchSeconds: 660, label: 'Interception', team: 'our', playerId: 'player_3' }),
    E(11, { time: 720, period: '1H', matchSeconds: 720, label: 'Turnover', team: 'our', playerId: 'player_1', outcome: 'FAILURE' }),
    E(12, { time: 800, period: '1H', matchSeconds: 800, label: 'Duel', team: 'our', playerId: 'player_2', outcome: 'SUCCESS' })
  ];
  return {
    __schemaVersion: 3, __savedAt: '2026-10-04T18:00:00.000Z',
    videoPath: null, videoUrl: null,
    matchInfo: { competition: 'Base Fixture Cup', homeAway: 'away', opponent: 'Zero FC', date: '2026-10-04', formation: '4-4-2' },
    matchClock: null,
    squad: [
      { id: 'player_1', name: 'Chala Tesfaye', number: '5' },
      { id: 'player_2', name: 'Biniyam Alemu', number: '8' },
      { id: 'player_3', name: 'Fikru Girma', number: '11' }
    ],
    events: events
  };
}

// ---------------------------------------------------------------------------
// Scenario A — oracle session: the full wired path
// ---------------------------------------------------------------------------
(async () => {
  const A = boot({});
  const doc = A.doc;
  await sleep(400);

  // =======================================================================
  section('MA-U1 — modal chrome & open mechanism');
  {
    const btn = doc.getElementById('btnMatchAnalysis');
    const modal = doc.getElementById('matchAnalysisModal');
    ok('MA-U1a: topbar button btnMatchAnalysis exists with the btn-class convention',
      !!btn && (btn.getAttribute('class') || '').split(/\s+/).indexOf('btn') !== -1);
    ok('MA-U1b: modal shell matchAnalysisModal reuses modal-overlay + display:none (seasonModal convention)',
      !!modal && (modal.getAttribute('class') || '').split(/\s+/).indexOf('modal-overlay') !== -1 &&
      modal.style.display === 'none');
    ok('MA-U1c: modal header carries h3 "Match analysis" + a Done button (btnCloseMatchAnalysis)',
      modal.querySelector('.pitchmap-header h3').textContent === 'Match analysis' &&
      doc.getElementById('btnCloseMatchAnalysis').textContent.trim() === 'Done');
    ok('MA-U1d: content container matchAnalysisContent exists and is EMPTY before first open',
      doc.getElementById('matchAnalysisContent').children.length === 0);
    ok('MA-U1e: the dashboard module is live through the real script chain (window.MatchAnalysisDashboard.renderAnalysis, v1.0.0)',
      !!(A.win.MatchAnalysisDashboard && typeof A.win.MatchAnalysisDashboard.renderAnalysis === 'function') &&
      A.win.MatchAnalysisDashboard.VERSION === '1.0.0');

    // Load the oracle session through the app's own pathway, then capture
    // the purity BASELINE save BEFORE the first dashboard open (MA-U11).
    A.stub._setLoadSession(oracleSession());
    clickIn(A, doc.getElementById('btnLoadSession'));
    await sleep(500);
    A.stub._setSaveResult({ canceled: false, filePath: '/tmp/ui-purity-1.json' });
    clickIn(A, doc.getElementById('btnSaveSession'));
    await sleep(300);
    A.save1 = lastSave(A.stub);
    ok('MA-U1f: clicking btnMatchAnalysis opens the modal (display flex) and renders ma-root inside the content container',
      (clickIn(A, btn), modal.style.display === 'flex') &&
      qsaClass(doc.getElementById('matchAnalysisContent'), 'ma-root').length === 1);
  }

  // =======================================================================
  section('MA-U2 — close paths (Done / Escape-elsewhere / Escape-in-form) + recompute');
  {
    const modal = doc.getElementById('matchAnalysisModal');
    const content = doc.getElementById('matchAnalysisContent');
    clickIn(A, doc.getElementById('btnCloseMatchAnalysis'));
    ok('MA-U2a: Done closes the modal (display none)',
      modal.style.display === 'none');
    clickIn(A, doc.getElementById('btnMatchAnalysis'));
    ok('MA-U2b: reopening re-renders — 9 sections again (per-open recompute, no cross-open cache)',
      modal.style.display === 'flex' && content.querySelectorAll('[data-ma-section]').length === 9);
    keydownIn(A, doc.body, { key: 'Escape', code: 'Escape' });
    ok('MA-U2c: Escape with focus outside inputs closes the modal (elsewhere branch)',
      modal.style.display === 'none');
    clickIn(A, doc.getElementById('btnMatchAnalysis'));
    ok('MA-U2d: reopening again works (display flex)',
      modal.style.display === 'flex');
    keydownIn(A, doc.getElementById('videoOffsetInput'), { key: 'Escape', code: 'Escape' });
    ok('MA-U2e: Escape while focus is in an input closes the modal (in-form branch)',
      modal.style.display === 'none');
    // Reopen for the content sections that follow.
    clickIn(A, doc.getElementById('btnMatchAnalysis'));
  }

  const content = doc.getElementById('matchAnalysisContent');

  // =======================================================================
  section('MA-U3 — §13 section inventory (presence + order)');
  {
    const keys = attrAll(Array.from(content.querySelectorAll('[data-ma-section]')), 'data-ma-section');
    ok('MA-U3a: exactly 9 sections in the exact §13 order (header, cards, key-events, team, periods, spatial, players, sequences, protocol)',
      JSON.stringify(keys) === JSON.stringify(['header', 'cards', 'key-events', 'team', 'periods', 'spatial', 'players', 'sequences', 'protocol']),
      'got ' + JSON.stringify(keys));
    const titles = textAll(Array.from(content.querySelectorAll('.ma-section-title')));
    ok('MA-U3b: the 8 section titles render exactly (the header uses its own ma-title)',
      JSON.stringify(titles) === JSON.stringify([
        'Key event summary',
        'Key events — chronological',
        'Team summary & performance',
        'Period analysis',
        'Spatial analysis — tagged event density (3×3)',
        'Player analysis — counts & ratios (no per-90)',
        'Sequences',
        'Protocol notes (read-only)'
      ]), 'got ' + JSON.stringify(titles));
    ok('MA-U3c: the header section carries its own .ma-title "Match analysis"',
      content.querySelector('[data-ma-section="header"] .ma-title').textContent === 'Match analysis');
    const playerRows = Array.from(content.querySelectorAll('[data-ma-table="players"] tbody tr'));
    ok('MA-U3d: the players table renders 9 rows, first label resolved through the REAL chain ("10 Kebede Tadesse")',
      playerRows.length === 9 && playerRows[0].querySelector('td').textContent === '10 Kebede Tadesse',
      'rows=' + playerRows.length + ' first=' + (playerRows[0] ? playerRows[0].querySelector('td').textContent : null));
    const seqText = content.querySelector('[data-ma-section="sequences"]').textContent;
    ok('MA-U3e: the sequences section renders the engine sequences SEQ-001 and SEQ-002',
      seqText.indexOf('SEQ-001') !== -1 && seqText.indexOf('SEQ-002') !== -1);
    ok('MA-U3f: the protocol section carries the engine provenance line',
      content.querySelector('.ma-engine').textContent === 'PitchLog-METRIC-SPEC-v1.0 · engine v1.2.0 · deterministic',
      'got ' + (content.querySelector('.ma-engine') || {}).textContent);
  }

  // =======================================================================
  section('MA-U4 — header (§13.1)');
  {
    const h = content.querySelector('[data-ma-section="header"]');
    ok('MA-U4a: metadata line renders the session matchInfo context',
      h.querySelector('.ma-meta').textContent === 'Bahir Dar Premier League · Home · vs Dashen Beer FC · 2026-10-03 · 4-3-3 · Bahir Dar Stadium',
      'got ' + h.querySelector('.ma-meta').textContent);
    ok('MA-U4b: final score renders "1–1"',
      h.querySelector('.ma-score-value').textContent === '1–1',
      'got ' + h.querySelector('.ma-score-value').textContent);
    ok('MA-U4c: the score note carries the goal-chain attribution + match state',
      h.querySelector('.ma-score-note').textContent === '(goal chain, 2 attributed · manual 1–1 · X1 MATCH)',
      'got ' + h.querySelector('.ma-score-note').textContent);
    ok('MA-U4d: the facts line renders events/located/periods/duration',
      h.querySelector('.ma-facts').textContent === '19 events used · 11 located · periods 1H, 2H · nominal 90′',
      'got ' + h.querySelector('.ma-facts').textContent);
  }

  // =======================================================================
  section('MA-U5 — key-event summary cards (§4)');
  {
    const cards = Array.from(content.querySelectorAll('.ma-card'));
    ok('MA-U5a: exactly 10 cards render',
      cards.length === 10, 'got ' + cards.length);
    ok('MA-U5b: card keys render in the exact §4 order',
      JSON.stringify(attrAll(cards, 'data-card')) === JSON.stringify([
        'goals', 'shots', 'chances', 'crosses', 'corners', 'fouls',
        'yellowCards', 'redCards', 'substitutions', 'positiveTransitions'
      ]), 'got ' + JSON.stringify(attrAll(cards, 'data-card')));
    ok('MA-U5c: card labels are the sentence-case precedents (Substitutions / Positive transitions as cards 9/10)',
      JSON.stringify(textAll(cards, '.ma-card-label')) === JSON.stringify([
        'Goals', 'Shots', 'Chances', 'Crosses', 'Corners', 'Fouls',
        'Yellow cards', 'Red cards', 'Substitutions', 'Positive transitions'
      ]), 'got ' + JSON.stringify(textAll(cards, '.ma-card-label')));
    ok('MA-U5d: card values render the envelope counts exactly (our | opponent per card)',
      JSON.stringify(textAll(cards, '.ma-card-our')) === JSON.stringify(['1', '2', '1', '1', '0', '0', '0', '1', '2', '3']) &&
      JSON.stringify(textAll(cards, '.ma-card-opp')) === JSON.stringify(['1', '0', '0', '0', '0', '1', '1', '0', '1', '1']),
      'our=' + JSON.stringify(textAll(cards, '.ma-card-our')) + ' opp=' + JSON.stringify(textAll(cards, '.ma-card-opp')));
    ok('MA-U5e: the card value format is "our · opponent" (goals cell reads "1 · 1")',
      content.querySelector('.ma-card[data-card="goals"] .ma-card-value').textContent === '1 · 1',
      'got ' + JSON.stringify(content.querySelector('.ma-card[data-card="goals"] .ma-card-value').textContent));
  }

  // =======================================================================
  section('MA-U6 — chronological key events (§5)');
  {
    const rows = Array.from(content.querySelectorAll('.ma-key-row'));
    ok('MA-U6a: exactly 17 qualifying rows render, every row a BUTTON element (keyboard-activable)',
      rows.length === 17 && rows.every((r) => r.tagName === 'BUTTON'),
      'count=' + rows.length + ' allButtons=' + rows.every((r) => r.tagName === 'BUTTON'));
    ok('MA-U6b: rows are in match order with the id tiebreak at equal times (13 before 14 at t=4000)',
      JSON.stringify(attrAll(rows, 'data-event-id')) === JSON.stringify([
        '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15', '16', '19'
      ]), 'got ' + JSON.stringify(attrAll(rows, 'data-event-id')));
    const first = rows[0];
    ok('MA-U6c: the first row preserves its seek inputs as rendered data (Goal, data-videotime 40, data-time 40)',
      first.getAttribute('data-label') === 'Goal' && first.getAttribute('data-videotime') === '40' &&
      first.getAttribute('data-time') === '40' && first.querySelector('.ma-key-time').textContent === '40s');
    const e2 = content.querySelector('.ma-key-row[data-event-id="2"]');
    const e6 = content.querySelector('.ma-key-row[data-event-id="6"]');
    const e12 = content.querySelector('.ma-key-row[data-event-id="12"]');
    ok('MA-U6d: seek-input attributes: E2 vt=240, E12 vt=140, E6 vt empty (videoTime null) with data-time 1350',
      e2.getAttribute('data-videotime') === '240' && e12.getAttribute('data-videotime') === '140' &&
      e6.getAttribute('data-videotime') === '' && e6.getAttribute('data-time') === '1350');
    ok('MA-U6e: display labels — "Sub" expands to "Substitution", "Positive Transition" renders verbatim',
      content.querySelector('.ma-key-row[data-event-id="9"] .ma-key-label').textContent === 'Substitution' &&
      e12.querySelector('.ma-key-label').textContent === 'Positive Transition');
    ok('MA-U6f: player texts resolve through the REAL resolver chain (loaded squad, no second resolver)',
      content.querySelector('.ma-key-row[data-event-id="1"] .ma-key-player').textContent === '9 Abebe Bekele' &&
      content.querySelector('.ma-key-row[data-event-id="9"] .ma-key-player').textContent === '4 Dawit Haile → 14 Yonas Girma',
      'got ' + content.querySelector('.ma-key-row[data-event-id="9"] .ma-key-player').textContent);
    ok('MA-U6g: unresolvable opponent-sub ids render "Unknown player" per the resolver chain (never guessed); unattributed rows render "—"',
      content.querySelector('.ma-key-row[data-event-id="11"] .ma-key-player').textContent === 'Unknown player → Unknown player' &&
      content.querySelector('.ma-key-row[data-event-id="5"] .ma-key-player').textContent === '—');
    ok('MA-U6h: team labels Us / Opponent / — (team-null)',
      content.querySelector('.ma-key-row[data-event-id="1"] .ma-key-team').textContent === 'Us' &&
      content.querySelector('.ma-key-row[data-event-id="7"] .ma-key-team').textContent === 'Opponent' &&
      content.querySelector('.ma-key-row[data-event-id="5"] .ma-key-team').textContent === '—');
  }

  // =======================================================================
  section('MA-U7 — end-to-end seek through the REAL pathway (§5)');
  {
    const video = doc.getElementById('video');
    ok('MA-U7a: video.currentTime starts at 0 before any row activation',
      video.currentTime === 0, 'got ' + video.currentTime);
    clickIn(A, content.querySelector('.ma-key-row[data-event-id="2"]'));
    ok('MA-U7b: clicking the E2 row seeks the real video element to its videoTime 240',
      video.currentTime === 240, 'got ' + video.currentTime);
    clickIn(A, content.querySelector('.ma-key-row[data-event-id="6"]'));
    ok('MA-U7c: the E6 row (videoTime null) falls back to time 1350 through the real host seekTo',
      video.currentTime === 1350, 'got ' + video.currentTime);
    clickIn(A, content.querySelector('.ma-key-row[data-event-id="12"]'));
    ok('MA-U7d: the E12 row seeks to its videoTime 140',
      video.currentTime === 140, 'got ' + video.currentTime);
    clickIn(A, content.querySelector('.ma-key-row[data-event-id="1"]'));
    ok('MA-U7e: the E1 row seeks to its videoTime 40',
      video.currentTime === 40, 'got ' + video.currentTime);
  }

  // =======================================================================
  section('MA-U8 — spatial: grid inventory + REAL host provenance (§3)');
  {
    const wraps = Array.from(content.querySelectorAll('.ma-grid-wrap'));
    ok('MA-U8a: the two default grids render with engine ids',
      JSON.stringify(attrAll(wraps, 'data-grid-wrap')) === JSON.stringify([
        'grid:scope=all:partition=our', 'grid:scope=all:partition=opponent'
      ]), 'got ' + JSON.stringify(attrAll(wraps, 'data-grid-wrap')));
    const our = wraps[0];
    const opp = wraps[1];
    ok('MA-U8b: the our-grid head renders the located share line',
      our.querySelector('.ma-grid-head').textContent === 'All events — Us · 8/13 located events (61.5%)',
      'got ' + our.querySelector('.ma-grid-head').textContent);
    const ourSvg = our.querySelector('.ma-grid-svg').innerHTML;
    ok('MA-U8c: the our-grid SVG carries the REAL renderer pitch markings (pitch-outline via host.pitchMarkingsSvg — no second copy)',
      ourSvg.indexOf('pitch-outline') !== -1);
    ok('MA-U8d: exactly 4 an-zoneline lines render (the REAL ZONE_LINES_SVG through the host)',
      (ourSvg.match(/an-zoneline/g) || []).length === 4,
      'got ' + (ourSvg.match(/an-zoneline/g) || []).length);
    ok('MA-U8e: the our-grid fills use the REAL crimson DENSITY_FILLS ramp (rgba(216, 30, 46 …) via the host)',
      ourSvg.indexOf('rgba(216, 30, 46') !== -1);
    ok('MA-U8f: the our-grid passes the minimum-sample gate — no insufficient note, the relative-max note renders, 5 printed zone counts',
      !our.querySelector('.ma-grid-insufficient') &&
      our.querySelector('.ma-grid-max').textContent === 'max = 2 (busiest cell) — colour scale is relative to this grid' &&
      qsaClass(our, 'ma-zcount').length === 5);
    ok('MA-U8g: the opponent grid (3/5 located) is below the gate — insufficient note present, NO fill rendered',
      !!opp.querySelector('.ma-grid-insufficient') &&
      opp.querySelector('.ma-grid-svg').innerHTML.indexOf('rgba(216, 30, 46') === -1);
    const ourCells = qsaClass(our, 'ma-zcell');
    const zc = ourCells[4]; // Middle third · Central channel (row-major ti*3+ci)
    ok('MA-U8h: 9 zone cells per grid (3×3) with tabindex 0, role img, zone + count aria labels',
      ourCells.length === 9 && qsaClass(opp, 'ma-zcell').length === 9 &&
      zc.getAttribute('tabindex') === '0' && zc.getAttribute('role') === 'img' &&
      zc.getAttribute('aria-label') === 'Middle third · Central channel: 2 tagged events',
      'aria=' + zc.getAttribute('aria-label'));
    ok('MA-U8i: unlocated events are reported, never plotted (our-grid strip "Unlocated: 5 — not shown on the pitch.")',
      our.querySelector('.ma-unloc-strip').textContent === 'Unlocated: 5 — not shown on the pitch.');
  }

  // =======================================================================
  section('MA-U9 — zone activation: shared function, pointer + keyboard (§8)');
  {
    const our = Array.from(content.querySelectorAll('.ma-grid-wrap'))[0];
    const zc = qsaClass(our, 'ma-zcell')[4];
    const trace = our.querySelector('.ma-trace');
    clickIn(A, zc);
    ok('MA-U9a: pointer click opens the zone trace (title + the zone\'s located-event rows)',
      trace.getAttribute('data-open-zone') === 'Middle third · Central channel' &&
      trace.querySelector('.ma-trace-title').textContent === 'Middle third · Central channel — 2 located events' &&
      qsaClass(trace, 'ma-trace-row').length === 2);
    clickIn(A, zc);
    ok('MA-U9b: a second click closes the trace (hint restored, data-open-zone removed)',
      trace.getAttribute('data-open-zone') === null &&
      trace.querySelector('.ma-trace-hint').textContent === 'Select a zone cell to list its located events.');
    keydownIn(A, zc, { key: 'Enter', code: 'Enter' });
    ok('MA-U9c: Enter on the zone cell reopens the trace (keyboard path, same shared activation)',
      trace.getAttribute('data-open-zone') === 'Middle third · Central channel');
  }

  // =======================================================================
  section('MA-U10 — Space propagation (§12.1 accepted behavior — asserted, not fixed)');
  {
    const our = Array.from(content.querySelectorAll('.ma-grid-wrap'))[0];
    const zc = qsaClass(our, 'ma-zcell')[4];
    const trace = our.querySelector('.ma-trace');
    let reachedWindow = false;
    let defaultPreventedAtWindow = false;
    let playPauseClicks = 0;
    const probe = (e) => { reachedWindow = true; defaultPreventedAtWindow = e.defaultPrevented; };
    A.win.addEventListener('keydown', probe);
    // The transport button starts disabled with no video attached; enabling
    // it lets the probe observe the app handler's own click dispatch.
    const btnPlayPause = doc.getElementById('btnPlayPause');
    btnPlayPause.disabled = false;
    btnPlayPause.addEventListener('click', () => { playPauseClicks++; });
    keydownIn(A, zc, { key: ' ', code: 'Space' });
    A.win.removeEventListener('keydown', probe);
    ok('MA-U10a: the Space keydown on a zone cell REACHES window (no stopPropagation — §12.1)',
      reachedWindow === true);
    ok('MA-U10b: preventDefault was called by the module (defaultPrevented true at window level)',
      defaultPreventedAtWindow === true);
    ok('MA-U10c: the app\'s global play/pause handler ACTED on the same keydown (btnPlayPause clicked)',
      playPauseClicks === 1, 'clicks=' + playPauseClicks);
    ok('MA-U10d: the same keydown ALSO toggled the zone trace closed — both effects from ONE Space (zone activation + global handler)',
      trace.getAttribute('data-open-zone') === null);
  }

  // =======================================================================
  section('MA-U11 — snapshot purity (§8: the live session is never mutated)');
  {
    // Baseline save #1 was captured in MA-U1 BEFORE the first open; save #2
    // is captured now, after the full dashboard-use sequence (4 seeks, 4
    // zone activations, 4 close/reopen cycles).
    A.stub._setSaveResult({ canceled: false, filePath: '/tmp/ui-purity-2.json' });
    clickIn(A, doc.getElementById('btnSaveSession'));
    await sleep(300);
    const s1 = A.save1;
    const s2 = lastSave(A.stub);
    ok('MA-U11a: baseline save #1 captured (payload carries events/matchInfo/squad/matchClock)',
      !!s1 && Array.isArray(s1.events) && !!s1.matchInfo && Array.isArray(s1.squad) && s1.events.length === 19);
    let diffKeys = [];
    if (s1 && s2) {
      const keys = Array.from(new Set(Object.keys(s1).concat(Object.keys(s2)))).sort();
      diffKeys = keys.filter((k) => JSON.stringify(s1[k]) !== JSON.stringify(s2[k]));
    }
    ok('MA-U11b: save #2 (after all dashboard use) is JSON byte-identical to save #1 — whole payload',
      !!s2 && JSON.stringify(s1) === JSON.stringify(s2),
      'differing keys: ' + JSON.stringify(diffKeys));
    ok('MA-U11c: ZERO autosave writes across the whole dashboard-use scenario (the dashboard never dirties the session)',
      A.stub._calls.autosaveWrite.length === 0, 'writes=' + A.stub._calls.autosaveWrite.length);
  }

  // =======================================================================
  section('MA-U12 — Analytics tab preserved + per-open recompute across a session switch');
  {
    clickIn(A, doc.getElementById('tabAnalytics'));
    await sleep(200);
    const an = doc.getElementById('analyticsContent');
    ok('MA-U12a: the app\'s Analytics tab still renders (label precedent "Substitutions")',
      an.innerHTML.indexOf('Substitutions') !== -1);
    ok('MA-U12b: ...and "Positive transitions" (both §4 label precedents live in the tab)',
      an.innerHTML.indexOf('Positive transitions') !== -1);
    clickIn(A, doc.getElementById('btnMatchAnalysis'));
    keydownIn(A, doc.body, { key: 'Escape', code: 'Escape' });
    clickIn(A, doc.getElementById('tabAnalytics'));
    await sleep(200);
    ok('MA-U12c: the Analytics tab still renders AFTER dashboard use (no interference either way)',
      an.innerHTML.indexOf('Substitutions') !== -1);

    // Session switch through the app's own load pathway (clean session →
    // direct load): the NEXT open must recompute from the NEW snapshot.
    A.stub._setLoadSession(baseSession());
    clickIn(A, doc.getElementById('btnLoadSession'));
    await sleep(500);
    ok('MA-U12d: the base session actually loaded through the bridge (loadSessionCalls now 2)',
      A.stub._calls.loadSessionCalls === 2, 'calls=' + A.stub._calls.loadSessionCalls);
    clickIn(A, doc.getElementById('btnMatchAnalysis'));
    ok('MA-U12e: reopening after the switch renders the base session — 9 sections, all 10 cards "0 · 0" (genuine zero, plain 0)',
      content.querySelectorAll('[data-ma-section]').length === 9 &&
      Array.from(content.querySelectorAll('.ma-card')).every((c) =>
        c.querySelector('.ma-card-our').textContent === '0' && c.querySelector('.ma-card-opp').textContent === '0'));
    const emptyEl = content.querySelector('.ma-key-empty');
    ok('MA-U12f: the key-events empty state enumerates the qualifying classes in display form',
      emptyEl && emptyEl.textContent === 'No qualifying key events. The list shows: Goal, Shot, Chance, Cross, Corner, Foul, Card, Substitution, Positive Transition.',
      'got ' + (emptyEl ? emptyEl.textContent : null));
    ok('MA-U12g: zero key rows; the header facts recompute for the base session',
      content.querySelectorAll('.ma-key-row').length === 0 &&
      content.querySelector('[data-ma-section="header"] .ma-facts').textContent === '12 events used · 6 located · periods 1H · nominal 90′');
    const baseOur = Array.from(content.querySelectorAll('.ma-grid-wrap'))[0];
    ok('MA-U12h: the base our-grid (5/11 located) is below the gate — insufficient note, no crimson fill',
      baseOur.querySelector('.ma-grid-head').textContent === 'All events — Us · 5/11 located events (45.5%)' &&
      !!baseOur.querySelector('.ma-grid-insufficient') &&
      baseOur.querySelector('.ma-grid-svg').innerHTML.indexOf('rgba(216, 30, 46') === -1);
  }
  A.dom.window.close();

  // ---------------------------------------------------------------------------
  // Scenario B — EMPTY session (no session loaded at all)
  // ---------------------------------------------------------------------------
  const B = boot({});
  const bdoc = B.doc;
  await sleep(400);
  clickIn(B, bdoc.getElementById('btnMatchAnalysis'));
  const bmodal = bdoc.getElementById('matchAnalysisModal');
  const bcontent = bdoc.getElementById('matchAnalysisContent');

  // =======================================================================
  section('MA-U13 — empty session + §9 static wiring/CSS law');
  {
    ok('MA-U13a: with NO session loaded the dashboard still opens (flex) and renders all 9 sections',
      bmodal.style.display === 'flex' &&
      JSON.stringify(attrAll(Array.from(bcontent.querySelectorAll('[data-ma-section]')), 'data-ma-section')) === JSON.stringify([
        'header', 'cards', 'key-events', 'team', 'periods', 'spatial', 'players', 'sequences', 'protocol'
      ]));
    ok('MA-U13b: every card renders a genuine zero ("0 · 0" × 10)',
      Array.from(bcontent.querySelectorAll('.ma-card')).length === 10 &&
      Array.from(bcontent.querySelectorAll('.ma-card')).every((c) =>
        c.querySelector('.ma-card-our').textContent === '0' && c.querySelector('.ma-card-opp').textContent === '0'));
    ok('MA-U13c: the key list renders its empty-state enumeration',
      bcontent.querySelector('.ma-key-empty').textContent === 'No qualifying key events. The list shows: Goal, Shot, Chance, Cross, Corner, Foul, Card, Substitution, Positive Transition.');
    ok('MA-U13d: players and sequences render their empty notes',
      bcontent.querySelector('[data-ma-section="players"] .ma-note').textContent === 'No player-attributed events.' &&
      bcontent.querySelector('[data-ma-section="sequences"] .ma-note').textContent === 'No sequences tagged.');
    const bh = bcontent.querySelector('[data-ma-section="header"]');
    ok('MA-U13e: the empty header renders the default meta, a 0–0 score and the MANUAL-EMPTY note',
      bh.querySelector('.ma-meta').textContent === 'Home' &&
      bh.querySelector('.ma-score-value').textContent === '0–0' &&
      bh.querySelector('.ma-score-note').textContent === '(goal chain, 0 attributed · X1 MANUAL-EMPTY)');
    const bgrids = Array.from(bcontent.querySelectorAll('.ma-grid-wrap'));
    ok('MA-U13f: both spatial grids render the below-gate null state ("0/0 located events (n/a)", insufficient, no fills)',
      bgrids.length === 2 &&
      bgrids.every((g) => g.querySelector('.ma-grid-head').textContent.indexOf('0/0 located events (n/a)') !== -1 &&
        !!g.querySelector('.ma-grid-insufficient') &&
        g.querySelector('.ma-grid-svg').innerHTML.indexOf('rgba(216, 30, 46') === -1));
    keydownIn(B, bdoc.body, { key: 'Escape', code: 'Escape' });
    ok('MA-U13g: Escape closes the empty-session dashboard',
      bmodal.style.display === 'none');
    B.dom.window.close();

    // ---- §9 static law: styles.css + index.html ------------------------
    function mediaBlockHasMa(query) {
      const idx = stylesCss.indexOf(query);
      if (idx === -1) return false;
      const next = stylesCss.indexOf('@media', idx + 1);
      const block = stylesCss.slice(idx, next === -1 ? undefined : next);
      return block.indexOf('.ma-') !== -1;
    }
    ok('MA-U13h: styles.css carries the three §9 responsive breakpoints, each with ma- rules (1500 / 1180 / 820)',
      mediaBlockHasMa('@media (min-width: 1500px)') &&
      mediaBlockHasMa('@media (max-width: 1180px)') &&
      mediaBlockHasMa('@media (max-width: 820px)'));
    const coreSelectors = ['.ma-modal {', '.ma-modal-content {', '.ma-root {', '.ma-section {',
      '.ma-cards {', '.ma-card {', '.ma-keylist {', '.ma-key-row {', '.ma-table {',
      '.ma-grid-wrap {', '.ma-zcell {', '.ma-trace {'];
    const missingSelectors = coreSelectors.filter((s) => stylesCss.indexOf(s) === -1);
    ok('MA-U13i: the core ma-* class vocabulary is styled (12 selectors present)',
      missingSelectors.length === 0, 'missing ' + JSON.stringify(missingSelectors));
    ok('MA-U13j: base-stylesheet sentinels intact (pre-existing .modal-overlay rule and the old 1200px app breakpoint untouched — pure-append discipline)',
      stylesCss.indexOf('.modal-overlay') !== -1 && stylesCss.indexOf('@media (max-width: 1200px)') !== -1);
    const scriptSrcs = [];
    const scriptRe = /<script src="([^"]+)"><\/script>/g;
    let m;
    while ((m = scriptRe.exec(html)) !== null) scriptSrcs.push(m[1]);
    const iSeason = scriptSrcs.indexOf('season-csv.js');
    const iMa = scriptSrcs.indexOf('match-analysis.js');
    const iRenderer = scriptSrcs.indexOf('renderer.js');
    ok('MA-U13k: index.html wiring — the four dashboard ids present and match-analysis.js loads between season-csv.js and renderer.js',
      html.indexOf('id="btnMatchAnalysis"') !== -1 &&
      html.indexOf('id="matchAnalysisModal"') !== -1 &&
      html.indexOf('id="btnCloseMatchAnalysis"') !== -1 &&
      html.indexOf('id="matchAnalysisContent"') !== -1 &&
      iSeason !== -1 && iMa !== -1 && iRenderer !== -1 && iSeason < iMa && iMa < iRenderer,
      'chain=' + JSON.stringify(scriptSrcs));
  }

  // ---------------------------------------------------------------------------
  // Stage 4B (V2.0) — filter controls through the REAL wiring. RED-first
  // discipline: the U16 retention source pin + the U14 CSS law were run
  // against the pre-wiring renderer/styles BEFORE commit B landed (their
  // failures captured then); they must be GREEN now.
  // ---------------------------------------------------------------------------
  function uiSelect(content, bar, key) {
    return content.querySelector('.ma-filter-select[data-bar="' + bar + '"][data-filter="' + key + '"]');
  }
  function uiArrEq(a, b) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length &&
      a.every((v, i) => v === b[i]);
  }
  function uiSetSelect(B, el, value) {
    el.value = value;
    el.dispatchEvent(new B.win.Event('change', { bubbles: true }));
  }
  function uiSections(content) {
    const out = {};
    Array.from(content.querySelectorAll('section[data-ma-section]')).forEach((s) => {
      out[s.getAttribute('data-ma-section')] = s.outerHTML;
    });
    return out;
  }
  function uiChanged(a, b) {
    return Object.keys(a).filter((k) => a[k] !== b[k]);
  }
  function doctoredOracleSession() {
    const s = oracleSession();
    s.matchInfo = Object.assign({}, s.matchInfo, { ourScore: 2 });
    return s;
  }

  // ---- Scenario C: oracle session + interactive filtering -------------------
  const C = boot({});
  const cdoc = C.doc;
  await sleep(400);
  C.stub._setLoadSession(oracleSession());
  clickIn(C, cdoc.getElementById('btnLoadSession'));
  await sleep(500);
  // Purity baseline for MA-U16, captured BEFORE any filtering.
  C.stub._setSaveResult({ canceled: false, filePath: '/tmp/ui-4b-purity-1.json' });
  clickIn(C, cdoc.getElementById('btnSaveSession'));
  await sleep(300);
  C.save1 = lastSave(C.stub);
  clickIn(C, cdoc.getElementById('btnMatchAnalysis'));
  const cmodal = cdoc.getElementById('matchAnalysisModal');
  const ccontent = cdoc.getElementById('matchAnalysisContent');

  // =======================================================================
  section('MA-U14 — filter controls + interactions (§14.1/§14.2/§14.3)');
  {
    const sel = (bar, key) => uiSelect(ccontent, bar, key);
    const selectValues = (bar) => Array.from(ccontent.querySelectorAll('.ma-filter-select[data-bar="' + bar + '"]')).map((s) => s.value);
    ok('MA-U14a: both bars render at a real boot — spatial 6 selects + Reset, key-events 3 selects + Reset, all at __all__ (fresh-open defaults), no status/summary/suppressed',
      cmodal.style.display === 'flex' &&
      Array.from(ccontent.querySelectorAll('.ma-filter-select[data-bar="spatial"]')).length === 6 &&
      uiArrEq(Array.from(ccontent.querySelectorAll('.ma-filter-select[data-bar="spatial"]')).map((s) => s.getAttribute('data-filter')),
        ['scope', 'team', 'period', 'state', 'sequence', 'player']) &&
      Array.from(ccontent.querySelectorAll('.ma-filter-select[data-bar="key-events"]')).length === 3 &&
      uiArrEq(Array.from(ccontent.querySelectorAll('.ma-filter-select[data-bar="key-events"]')).map((s) => s.getAttribute('data-filter')),
        ['label', 'team', 'period']) &&
      !!ccontent.querySelector('.ma-filter-reset[data-bar="spatial"]') &&
      !!ccontent.querySelector('.ma-filter-reset[data-bar="key-events"]') &&
      selectValues('spatial').every((v) => v === '__all__') &&
      selectValues('key-events').every((v) => v === '__all__') &&
      !ccontent.querySelector('.ma-filter-status') &&
      !ccontent.querySelector('.ma-filter-summary') &&
      !ccontent.querySelector('.ma-filter-suppressed'),
      'spatial=' + JSON.stringify(selectValues('spatial')));

    const before = uiSections(ccontent);
    uiSetSelect(C, sel('spatial', 'team'), 'our');
    const afterTeam = uiSections(ccontent);
    const changedTeam = uiChanged(before, afterTeam);
    const wraps = Array.from(ccontent.querySelectorAll('.ma-grid-wrap'));
    ok('MA-U14b: a spatial change re-renders ONLY the spatial section (team our → 1 grid) and the bar KEEPS the chosen value',
      changedTeam.length === 1 && changedTeam[0] === 'spatial' &&
      wraps.length === 1 && wraps[0].getAttribute('data-grid-wrap') === 'grid:scope=all:partition=our' &&
      sel('spatial', 'team').value === 'our' &&
      sel('spatial', 'team').querySelector('option[value="our"]').hasAttribute('selected') &&
      sel('spatial', 'state').disabled === false,
      'changed=' + JSON.stringify(changedTeam));

    const beforeList = uiSections(ccontent);
    uiSetSelect(C, sel('key-events', 'period'), '2H');
    const afterList = uiSections(ccontent);
    const changedList = uiChanged(beforeList, afterList);
    const rowsNow = Array.from(ccontent.querySelectorAll('.ma-key-row'));
    const statusEl = ccontent.querySelector('.ma-filter-status');
    ok('MA-U14c: a list change re-renders ONLY the key-events section; status "Showing 9 of 17"; cards byte-identical (D2-extension)',
      changedList.length === 1 && changedList[0] === 'key-events' &&
      rowsNow.length === 9 &&
      !!statusEl && statusEl.textContent === 'Showing 9 of 17' &&
      uiArrEq(rowsNow.map((r) => r.getAttribute('data-event-id')),
        ['9', '10', '11', '12', '13', '14', '15', '16', '19']) &&
      afterList.cards === beforeList.cards,
      'changed=' + JSON.stringify(changedList) + ' status=' + (statusEl ? statusEl.textContent : null));

    clickIn(C, ccontent.querySelector('.ma-filter-reset[data-bar="spatial"]'));
    clickIn(C, ccontent.querySelector('.ma-filter-reset[data-bar="key-events"]'));
    const wrapsReset = Array.from(ccontent.querySelectorAll('.ma-grid-wrap'));
    ok('MA-U14d: Reset restores each bar to defaults and re-renders only that section',
      wrapsReset.length === 2 &&
      Array.from(ccontent.querySelectorAll('.ma-filter-select')).every((s) => s.value === '__all__') &&
      Array.from(ccontent.querySelectorAll('.ma-key-row')).length === 17 &&
      !ccontent.querySelector('.ma-filter-status') &&
      !ccontent.querySelector('.ma-filter-summary'),
      'grids=' + wrapsReset.length);

    clickIn(C, cdoc.getElementById('btnCloseMatchAnalysis'));
    clickIn(C, cdoc.getElementById('btnMatchAnalysis'));
    const reopened = Array.from(ccontent.querySelectorAll('.ma-filter-select'));
    ok('MA-U14e: every fresh open starts at defaults (per-open filter state; close/reopen)',
      cmodal.style.display === 'flex' &&
      reopened.length === 9 && reopened.every((s) => s.value === '__all__') &&
      Array.from(ccontent.querySelectorAll('.ma-key-row')).length === 17 &&
      Array.from(ccontent.querySelectorAll('.ma-grid-wrap')).length === 2 &&
      !ccontent.querySelector('.ma-filter-status'),
      'values=' + JSON.stringify(reopened.map((s) => s.value)));

    uiSetSelect(C, sel('spatial', 'team'), 'our');
    uiSetSelect(C, sel('spatial', 'period'), '1H');
    const persistenceGrids = Array.from(ccontent.querySelectorAll('.ma-grid-wrap'));
    const ourHead = persistenceGrids[0] ? persistenceGrids[0].querySelector('.ma-grid-head') : null;
    const zoneCell = persistenceGrids[0] ? Array.from(persistenceGrids[0].querySelectorAll('.ma-zcell'))[4] : null;
    if (zoneCell) clickIn(C, zoneCell);
    const trace = persistenceGrids[0] ? persistenceGrids[0].querySelector('.ma-trace') : null;
    ok('MA-U14f: bar state persists across re-renders (two changes) and across a zone activation (trace toggle leaves the bar alone)',
      sel('spatial', 'team').value === 'our' && sel('spatial', 'period').value === '1H' &&
      persistenceGrids.length === 1 &&
      ourHead && ourHead.textContent === 'All events — Us · 5/5 located events (100%)' &&
      !!trace && trace.getAttribute('data-open-zone') !== null &&
      sel('spatial', 'team').value === 'our' && sel('spatial', 'period').value === '1H',
      'head=' + (ourHead ? ourHead.textContent : null));

    const filterSelectors = ['.ma-filter-bar {', '.ma-filter-select {', '.ma-filter-reset {',
      '.ma-filter-status {', '.ma-filter-summary {', '.ma-filter-banner {',
      '.ma-filter-note {', '.ma-filter-suppressed {'];
    const missingFilterSelectors = filterSelectors.filter((s) => stylesCss.indexOf(s) === -1);
    ok('MA-U14g: the §9-style CSS law — the filter-bar class vocabulary is styled (8 selectors present in styles.css)',
      missingFilterSelectors.length === 0, 'missing ' + JSON.stringify(missingFilterSelectors));
  }

  // ---- Scenario D: doctored oracle (X1 MISMATCH) — §14.5/§14.6 --------------
  // CHOICE STATED: engine path with a valid chain — the oracle's complete
  // 1–1 goal chain is kept intact and only the manual matchInfo score is
  // made to disagree (ourScore 2), a genuine engine MISMATCH (probed in the
  // model suite M13.9); NOT a doctored envelope.
  const D = boot({});
  const ddoc = D.doc;
  await sleep(400);
  D.stub._setLoadSession(doctoredOracleSession());
  clickIn(D, ddoc.getElementById('btnLoadSession'));
  await sleep(500);
  clickIn(D, ddoc.getElementById('btnMatchAnalysis'));
  const dcontent = ddoc.getElementById('matchAnalysisContent');

  // =======================================================================
  section('MA-U15 — suppression + context stating (§14.5/§14.6)');
  {
    const dsel = (key) => uiSelect(dcontent, 'spatial', key);
    const stateSel = dsel('state');
    const suppressedNote = dcontent.querySelector('.ma-filter-suppressed');
    ok('MA-U15a: under X1 MISMATCH the state control renders DISABLED with the exact explanation; effective __all__; other controls enabled',
      !!stateSel && stateSel.disabled === true && stateSel.value === '__all__' &&
      dsel('team').disabled === false && dsel('scope').disabled === false &&
      !!suppressedNote &&
      suppressedNote.textContent === 'Score state filtering unavailable (X1 reconciliation gate): the manual matchInfo score disagrees with the attributed goal chain. The effective score-state filter is All.',
      'note=' + (suppressedNote ? suppressedNote.textContent : null));

    uiSetSelect(D, dsel('team'), 'our');
    const sum = dcontent.querySelector('.ma-filter-summary');
    const ban = dcontent.querySelector('.ma-filter-banner');
    const unattr = dcontent.querySelector('.ma-filter-note');
    const dgrids = Array.from(dcontent.querySelectorAll('.ma-grid-wrap'));
    const maxLine = dgrids[0] ? dgrids[0].querySelector('.ma-grid-max') : null;
    ok('MA-U15b: context stating under a real filter — summary, banner, unattributed note (exact strings) and the max-line suffix',
      dgrids.length === 1 &&
      !!sum && sum.textContent === 'Active filters: Team Us' &&
      !!ban && ban.textContent === 'Spatial filters active — all other sections remain whole-match.' &&
      !!unattr && unattr.textContent === 'Unattributed events (no Us/Opponent attribution) are excluded from all spatial grids; there is no option to view them spatially.' &&
      !!maxLine && maxLine.textContent === 'max = 2 (busiest cell) — colour scale is relative to this grid (filtered view)' &&
      !!dcontent.querySelector('.ma-filter-suppressed'),
      'summary=' + (sum ? sum.textContent : null));

    uiSetSelect(D, dsel('period'), '1H');
    const dgrids2 = Array.from(dcontent.querySelectorAll('.ma-grid-wrap'));
    const insuf = dgrids2[0] ? dgrids2[0].querySelector('.ma-grid-insufficient') : null;
    const sum2 = dcontent.querySelector('.ma-filter-summary');
    ok('MA-U15c: below-gate under filters — the insufficient message carries the exact (filtered view) suffix; the summary updates',
      dgrids2.length === 1 &&
      !!insuf && insuf.textContent === 'Insufficient located events for spatial visualization. (5 located events in this view — see the table below) (filtered view)' &&
      !!sum2 && sum2.textContent === 'Active filters: Team Us · Period 1H' &&
      !!dcontent.querySelector('.ma-filter-suppressed'),
      'insufficient=' + (insuf ? insuf.textContent : null));
    D.dom.window.close();
  }

  // =======================================================================
  section('MA-U16 — purity under filtering + renderer retention (§8/§14.8)');
  {
    C.stub._setSaveResult({ canceled: false, filePath: '/tmp/ui-4b-purity-2.json' });
    clickIn(C, cdoc.getElementById('btnSaveSession'));
    await sleep(300);
    const s1 = C.save1;
    const s2 = lastSave(C.stub);
    let diffKeys = [];
    if (s1 && s2) {
      const keys = Array.from(new Set(Object.keys(s1).concat(Object.keys(s2)))).sort();
      diffKeys = keys.filter((k) => JSON.stringify(s1[k]) !== JSON.stringify(s2[k]));
    }
    ok('MA-U16a: save #2 (after the whole filtering battery: 2 spatial changes + 2 list changes + 3 resets + reopen + zone activation) is JSON byte-identical to save #1',
      !!s1 && Array.isArray(s1.events) && s1.events.length === 19 &&
      !!s2 && JSON.stringify(s1) === JSON.stringify(s2),
      'differing keys: ' + JSON.stringify(diffKeys));
    ok('MA-U16b: ZERO autosave writes across both filtering scenarios (C oracle + D doctored)',
      C.stub._calls.autosaveWrite.length === 0 && D.stub._calls.autosaveWrite.length === 0,
      'C=' + C.stub._calls.autosaveWrite.length + ' D=' + D.stub._calls.autosaveWrite.length);

    // RED-FIRST source pin (run against the pre-wiring renderer at commit-B
    // authoring time): renderer.js RETAINS the renderAnalysis return for the
    // open's lifetime and DISCARDS it in closeMatchAnalysisModal — both
    // close paths (Done listener + both Escape branches) funnel there.
    const openMatch = /(\w+)\s*=\s*window\.MatchAnalysisDashboard\.renderAnalysis\(/.exec(rendererSrc);
    const retainedId = openMatch ? openMatch[1] : null;
    const closeIdx = rendererSrc.indexOf('function closeMatchAnalysisModal()');
    const closeBody = closeIdx === -1 ? '' : rendererSrc.slice(closeIdx, closeIdx + 400);
    ok('MA-U16c: renderer.js retains the renderAnalysis return on open (assignment in openMatchAnalysisModal)',
      !!openMatch && !!retainedId,
      openMatch ? 'retained as: ' + retainedId : 'no assignment of the renderAnalysis return found');
    ok('MA-U16d: closeMatchAnalysisModal nulls the SAME retained identifier (the discard — both close paths funnel here)',
      !!retainedId && closeBody.indexOf(retainedId + ' = null') !== -1,
      'id=' + retainedId + ' closeBody has nulling: ' + (retainedId ? closeBody.indexOf(retainedId + ' = null') !== -1 : false));
    C.dom.window.close();
  }

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass);
  console.log('');
  failed.forEach((r) => {
    console.log('FAIL ' + r.id + (r.detail ? '  [' + r.detail + ']' : ''));
  });
  console.log('MATCH-ANALYSIS UI SUITE: ' + passed + '/' + results.length + ' checks passed' +
    (failed.length ? ' — ' + failed.length + ' FAILED' : ''));
  if (failed.length) process.exitCode = 1;
})().catch((e) => {
  console.error('UI SUITE CRASHED:', e);
  process.exit(1);
});
