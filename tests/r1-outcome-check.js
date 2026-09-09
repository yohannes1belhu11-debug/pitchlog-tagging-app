#!/usr/bin/env node
// PitchLog / MatchTag — R1 "Universal Outcome Field" regression harness.
// =====================================================================
// Verification-only harness: does NOT modify any app source file.
//
// R1 adds a FIRST-CLASS event field `outcome` ('SUCCESS' | 'FAILURE' | null),
// applicable only to Duel / Press / Turnover / Cross, with schema v3 → v4
// migration, detail-panel controls (desktop + Touchline, same panel),
// deterministic analytics summaries, data-quality flags, and CSV export.
// The existing Pass qualifier-based outcome mechanism is untouched.
//
// Coverage (behavior-oriented, not string-count-only):
//   MIGRATION  v3→v4 succeeds; events receive outcome:null; historical
//              outcomes are NEVER inferred (Pass qualifier stays a
//              qualifier); forward-version refusal still throws; all other
//              v3 data preserved verbatim; v0 chain still works; v4 is
//              idempotent.
//   EVENTS     Duel/Press/Turnover/Cross with null/SUCCESS/FAILURE through
//              the real renderer (buildEventBase + detail-panel chips).
//   ANALYTICS  success/failure/outcome/unknown counts, success_rate,
//              null-outcome exclusion from the denominator, rate=null with
//              no qualified outcomes, existing counts unchanged, existing
//              Pass outcome behavior unchanged, data-quality flags
//              (INVALID_OUTCOME, OUTCOME_NON_APPLICABLE), determinism.
//   UI         desktop detail exposes outcome ONLY for applicable events;
//              touchline detail exposes it (same F1.1 panel); outcome can
//              be added, changed, cleared; non-applicable events have no
//              outcome control; event list shows the outcome word.
//   PERSIST    autosave payload preserves outcome; loading a v4 session
//              preserves outcome (incl. selected chip state); standard CSV
//              and full-analysis CSV carry the outcome column.
//
// Architecture: Part A requires src/main.js into plain Node with a stubbed
// 'electron' (same Module._load technique as tests/integrity-harness.js);
// Part B requires src/analytics.js directly (UMD); Part C boots jsdom with
// the REAL index.html + integrity.js + analytics.js + player-season.js +
// renderer.js and a stubbed window.matchtag (same as
// tests/load-session-guard-check.js).
//
// Run:  node tests/r1-outcome-check.js   (from the project root)
'use strict';

const path = require('path');
const fs = require('fs');
const Module = require('module');

const results = [];
let SECTION = '(pre)';
function section(name) { SECTION = name; console.log('\n===== ' + name + ' ====='); }
function ok(name, cond, detail) {
  results.push({ section: SECTION, name, pass: !!cond, detail: detail === undefined ? '' : String(detail) });
  if (!cond) console.log('  FAIL: ' + name + (detail === undefined ? '' : '  | ' + detail));
}

// ===========================================================================
// PART A — schema v3 → v4 migration (real main.js, stubbed electron)
// ===========================================================================
section('A — MIGRATION (src/main.js migrateSessionData)');

const electronStub = {
  app: {
    getPath: () => '/tmp/r1-harness-userdata',
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
    showSaveDialog: async () => ({ canceled: true }),
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showErrorBox: () => {}
  }
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronStub;
  return originalLoad.apply(this, arguments);
};
let main;
try {
  main = require(path.join(__dirname, '..', 'src', 'main.js'));
} catch (e) {
  main = null;
  console.log('  main.js failed to load: ' + (e && e.message));
}
Module._load = originalLoad;

function clone(x) { return x == null ? x : JSON.parse(JSON.stringify(x)); }

if (main) {
  ok('A1: schema version is now 4 (v3→v4 introduced by R1)', main.CURRENT_SCHEMA_VERSION === 4, 'version=' + main.CURRENT_SCHEMA_VERSION);

  // A v3 session exactly like one the previous app would save: mixed labels,
  // a Pass with the QUALIFIER-based outcome (which must stay a qualifier),
  // subtype/qualifiers/timestamps/locations/player refs/sequences/scores.
  const v3Session = {
    __schemaVersion: 3, videoPath: null, videoUrl: null,
    tags: [{ label: 'Duel', key: '0' }],
    squad: [{ id: 'player_1', number: '9', name: 'Legacy Nine' }],
    matchInfo: { opponent: 'Legacy FC', date: '2025-05-01', formation: '4-3-3' },
    matchClock: { period: '2H', clockBaseSeconds: 3000, clockRunning: false, clockStartedAt: null, scoreFor: 1, scoreAgainst: 0, videoSyncOffset: 2, selectedTeam: 'our', selectedPlayerId: 'player_1', activeSequenceId: 'SEQ-001', nextSequenceNumber: 4 },
    events: [
      { id: 1, time: 10, videoTime: 8, matchTime: 10, matchSeconds: 10, officialMinute: 1, second: 10, period: '2H', label: 'Duel', subtype: null, qualifiers: {}, location: { x: 0.5, y: 0.5 }, playerId: 'player_1', playerOffId: null, playerOnId: null, side: 'for', team: 'our', sequenceId: 'SEQ-001', scoreForBefore: 1, scoreAgainstBefore: 0 },
      { id: 2, time: 20, videoTime: 18, matchTime: 20, matchSeconds: 20, officialMinute: 1, second: 20, period: '2H', label: 'Pass', subtype: 'Progressive', qualifiers: { 'Outcome': 'Successful', 'Pressure': 'Under pressure' }, location: null, playerId: 'player_1', side: 'for', team: 'our', sequenceId: 'SEQ-001', scoreForBefore: 1, scoreAgainstBefore: 0 },
      { id: 3, time: 30, videoTime: 28, matchTime: 30, matchSeconds: 30, officialMinute: 1, second: 30, period: '2H', label: 'Shot', subtype: 'On target', qualifiers: {}, location: { x: 0.9, y: 0.4 }, playerId: null, side: 'against', team: 'opponent', sequenceId: null, scoreForBefore: 1, scoreAgainstBefore: 0 },
      { id: 4, time: 40, videoTime: 38, matchTime: 40, matchSeconds: 40, officialMinute: 1, second: 40, period: '2H', label: 'Possession', isInterval: true, startTime: 35, endTime: 40, qualifiers: { 'Ended by': 'Turnover' }, location: null, playerId: null, playerOffId: null, playerOnId: null, side: 'for', team: 'our', sequenceId: null, scoreForBefore: 1, scoreAgainstBefore: 0 }
    ]
  };

  let m = null, threw = false;
  try { m = main.migrateSessionData(clone(v3Session)); } catch (e) { threw = true; console.log('  threw: ' + e.message); }
  ok('A2 (test 1): v3 → v4 migration succeeds without throwing', !threw && !!m);
  ok('A3 (test 1): migrated file is stamped schema v4', m && m.__schemaVersion === 4, 'version=' + (m && m.__schemaVersion));
  ok('A4 (test 2): every existing event receives outcome=null',
    m && m.events.length === 4 && m.events.every((e) => e.outcome === null),
    m && m.events.map((e) => String(e.outcome)).join(','));
  ok('A5 (test 3): historical outcomes are NEVER inferred — the Successful Pass qualifier does NOT become outcome=SUCCESS',
    m && m.events[1].outcome === null && m.events[1].qualifiers['Outcome'] === 'Successful',
    'outcome=' + (m && m.events[1].outcome) + ' qualifier=' + (m && m.events[1].qualifiers['Outcome']));
  ok('A6 (test 3): no outcome inferred for the tagged Duel either (null, not SUCCESS)',
    m && m.events[0].outcome === null);
  ok('A7 (test 3): outcome is NOT stored in qualifiers{} (Pass qualifier set unchanged)',
    m && Object.keys(m.events[0].qualifiers).length === 0 && Object.keys(m.events[1].qualifiers).length === 2);

  // Test 28: full v3-data preservation — every pre-existing VALUE survives.
  // (Absent optional fields are null-defaulted by the pre-existing v0→v1
  // normalizer — absent ≡ null is the schema's own convention — so the
  // comparison coalesces those; every value that was present must match.)
  ok('A8 (test 28): all existing event data preserved verbatim (ids, times, labels, subtypes, qualifiers, locations, players, teams, sequences, scores, interval bounds)',
    m && m.events.every((e, i) => {
      const b = v3Session.events[i];
      const eqJson = (a, c) => JSON.stringify(a) === JSON.stringify(c);
      return e.id === b.id && e.time === b.time && e.videoTime === b.videoTime &&
        e.matchTime === b.matchTime && e.matchSeconds === b.matchSeconds &&
        e.officialMinute === b.officialMinute && e.second === b.second && e.period === b.period &&
        e.label === b.label && (e.subtype ?? null) === (b.subtype ?? null) &&
        eqJson(e.qualifiers, b.qualifiers) &&
        eqJson(e.location ?? null, b.location ?? null) &&
        (e.playerId ?? null) === (b.playerId ?? null) &&
        (e.playerOffId ?? null) === (b.playerOffId ?? null) &&
        (e.playerOnId ?? null) === (b.playerOnId ?? null) &&
        e.side === b.side && e.team === b.team &&
        (e.sequenceId ?? null) === (b.sequenceId ?? null) &&
        e.scoreForBefore === b.scoreForBefore && e.scoreAgainstBefore === b.scoreAgainstBefore;
    }) && m.events[3].isInterval === true && m.events[3].startTime === 35 && m.events[3].endTime === 40);
  ok('A9 (test 28): session-level data preserved (tags, squad, matchInfo, matchClock)',
    m && JSON.stringify(m.tags) === JSON.stringify(v3Session.tags) &&
      JSON.stringify(m.squad) === JSON.stringify(v3Session.squad) &&
      JSON.stringify(m.matchInfo) === JSON.stringify(v3Session.matchInfo) &&
      m.matchClock.period === '2H' && m.matchClock.scoreFor === 1 && m.matchClock.activeSequenceId === 'SEQ-001');

  // Forward-version refusal must still work.
  let refused = false;
  try { main.migrateSessionData({ __schemaVersion: 5, events: [] }); } catch (e) { refused = /newer version/.test(String(e.message)); }
  ok('A10 (test 4): forward-version refusal still throws for schema v5', refused);

  // The whole chain still works from v0 (pre-versioning) files.
  let m0 = null;
  try { m0 = main.migrateSessionData({ events: [{ id: 1, time: 5, label: 'Duel', side: 'for' }], tags: [], squad: [], matchInfo: {} }); } catch (e) { m0 = null; }
  ok('A11: v0 legacy file migrates through the full chain to v4 with outcome=null',
    m0 && m0.__schemaVersion === 4 && m0.events.length === 1 && m0.events[0].outcome === null);

  // v4 is idempotent: current files come back unchanged (no re-migration).
  const v4Session = clone(m);
  let m4 = null;
  try { m4 = main.migrateSessionData(v4Session); } catch (e) { m4 = null; }
  ok('A12: v4 file loads idempotently (no re-migration, values preserved)',
    m4 && m4.__schemaVersion === 4 && m4.events.every((e) => e.outcome === null));

  // v4 files with real outcome values round-trip through the loader as-is.
  const v4WithOutcomes = {
    __schemaVersion: 4, videoPath: null, videoUrl: null, tags: [], squad: [],
    matchInfo: {}, matchClock: {},
    events: [
      { id: 1, time: 5, label: 'Duel', team: 'our', outcome: 'SUCCESS' },
      { id: 2, time: 6, label: 'Press', team: 'our', outcome: 'FAILURE' },
      { id: 3, time: 7, label: 'Cross', team: 'our', outcome: null }
    ]
  };
  const m5 = main.migrateSessionData(clone(v4WithOutcomes));
  ok('A13: v4 outcome values preserved exactly (SUCCESS / FAILURE / null)',
    m5 && m5.events[0].outcome === 'SUCCESS' && m5.events[1].outcome === 'FAILURE' && m5.events[2].outcome === null);
} else {
  ok('A0: main.js loadable under stubbed electron', false, 'see log above');
}

// ===========================================================================
// PART B — analytics engine (real src/analytics.js, plain Node)
// ===========================================================================
section('B — ANALYTICS (src/analytics.js level1.outcomes)');

const AE = require(path.join(__dirname, '..', 'src', 'analytics.js'));

function evO(id, label, outcome, extra) {
  const e = Object.assign({
    id, time: id * 60, matchTime: id * 60, matchSeconds: id * 60, officialMinute: id,
    second: 0, period: '2H', label, subtype: null, qualifiers: {}, location: null,
    playerId: 'player_' + id, playerOffId: null, playerOnId: null, side: 'for',
    team: 'our', sequenceId: null, scoreForBefore: 0, scoreAgainstBefore: 0
  }, extra || {});
  if (outcome !== undefined) e.outcome = outcome;
  return e;
}

{
  const events = [
    // Duel: 1 success, 1 failure, 1 unknown (null)
    evO(1, 'Duel', 'SUCCESS'),
    evO(2, 'Duel', 'FAILURE'),
    evO(3, 'Duel', null),
    // Press: 1 success, 1 unknown
    evO(4, 'Press', 'SUCCESS'),
    evO(5, 'Press', null),
    // Turnover: 1 failure, 1 success
    evO(6, 'Turnover', 'FAILURE'),
    evO(7, 'Turnover', 'SUCCESS'),
    // Cross: 1 unknown only -> rate must be null
    evO(8, 'Cross', null),
    // Pass: the PRE-EXISTING qualifier mechanism — untouched by R1
    evO(9, 'Pass', undefined, { qualifiers: { 'Outcome': 'Successful' } }),
    evO(10, 'Pass', undefined, { qualifiers: { 'Outcome': 'Unsuccessful' } }),
    // Data quality: non-canonical value + outcome on a non-applicable label
    evO(11, 'Foul', 'won'),
    evO(12, 'Shot', 'SUCCESS', { team: 'opponent', side: 'against', playerId: null }),
    // Unattributed partition: a Duel with no team
    evO(13, 'Duel', 'SUCCESS', { team: null, side: null })
  ];

  const A = AE.computeMatchAnalytics({ events, matchInfo: {}, matchClock: {} });
  const OC = A.level1.outcomes;

  ok('B1: level1.outcomes block exists with the three team partitions',
    OC && OC.our && OC.opponent && OC.unattributed, 'keys=' + (OC ? Object.keys(OC).join(',') : 'missing'));

  const D = OC.our.Duel, P = OC.our.Press, T = OC.our.Turnover, C = OC.our.Cross;

  ok('B2 (test 11): success count — Duel 1, Press 1, Turnover 1',
    D.successCount.value === 1 && P.successCount.value === 1 && T.successCount.value === 1,
    [D.successCount.value, P.successCount.value, T.successCount.value].join(','));
  ok('B3 (test 12): failure count — Duel 1, Turnover 1, Press 0',
    D.failureCount.value === 1 && T.failureCount.value === 1 && P.failureCount.value === 0,
    [D.failureCount.value, T.failureCount.value, P.failureCount.value].join(','));
  ok('B4 (test 13): outcome count (qualified only) — Duel 2, Press 1, Turnover 2, Cross 0',
    D.outcomeCount.value === 2 && P.outcomeCount.value === 1 && T.outcomeCount.value === 2 && C.outcomeCount.value === 0,
    [D.outcomeCount.value, P.outcomeCount.value, T.outcomeCount.value, C.outcomeCount.value].join(','));
  ok('B5 (test 14): unknown count — Duel 1, Press 1, Cross 1',
    D.unknownOutcomeCount.value === 1 && P.unknownOutcomeCount.value === 1 && C.unknownOutcomeCount.value === 1,
    [D.unknownOutcomeCount.value, P.unknownOutcomeCount.value, C.unknownOutcomeCount.value].join(','));
  ok('B6 (test 15): success rate — Duel 50%, Press 100%, Turnover 50%',
    D.successRate.value === 50 && P.successRate.value === 100 && T.successRate.value === 50,
    [D.successRate.value, P.successRate.value, T.successRate.value].join(','));
  ok('B7 (test 16): null outcomes EXCLUDED from the denominator (Duel rate 50 = 1/2, not 1/3)',
    D.successRate.num === 1 && D.successRate.den === 2, 'num=' + D.successRate.num + ' den=' + D.successRate.den);
  ok('B8 (test 17): no qualified outcomes => success_rate = null (Cross), never 0',
    C.successRate.value === null, 'value=' + C.successRate.value);
  ok('B9: success/failure counts never include unknowns as failures (missing outcome is not failure)',
    D.failureCount.value === 1 && P.failureCount.value === 0 && C.failureCount.value === 0);
  ok('B10: rate envelopes carry the unknown exclusion explicitly',
    D.successRate.excluded.unknownOutcome === 1 && C.successRate.excluded.unknownOutcome === 1);

  const T1 = A.level1.team;
  ok('B11 (test 18): existing event counts unchanged (duels 3, presses 2, turnovers 2, crosses 1, passes 2, events 11 our)',
    T1.our.duels.value === 3 && T1.our.presses.value === 2 && T1.our.turnovers.value === 2 &&
      T1.our.crosses.value === 1 && T1.our.passes.value === 2 && T1.our.events.value === 11,
    [T1.our.duels.value, T1.our.presses.value, T1.our.turnovers.value, T1.our.crosses.value, T1.our.passes.value, T1.our.events.value].join(','));

  ok('B12 (test 19): existing Pass outcome behavior unchanged (1 successful + 1 unsuccessful qualifier, 0 unknown, rate 50%)',
    T1.our.successfulPasses.value === 1 && T1.our.unsuccessfulPasses.value === 1 && T1.our.passesUnknownOutcome.value === 0 &&
      A.level2.team.our.passSuccess.value === 50,
    [T1.our.successfulPasses.value, T1.our.unsuccessfulPasses.value, T1.our.passesUnknownOutcome.value, A.level2.team.our.passSuccess.value].join(','));

  ok('B13: Pass is NOT in the outcome summaries (no accidental outcome semantics for non-applicable labels)',
    !('Pass' in OC.our) && !('Foul' in OC.our) && !('Shot' in OC.our));

  ok('B14: data quality — INVALID_OUTCOME flagged for a non-canonical value (\'won\'), not normalized',
    A.validation.issues.some((i) => i.code === 'INVALID_OUTCOME' && i.count === 1),
    JSON.stringify(A.validation.issues));
  ok('B15: data quality — OUTCOME_NON_APPLICABLE flagged for a non-applicable label carrying an outcome',
    A.validation.issues.some((i) => i.code === 'OUTCOME_NON_APPLICABLE' && i.count === 1));
  ok('B16: no outcome flags for clean data (null/absent outcomes never flagged)',
    (A.validation.issues.filter((i) => i.code === 'INVALID_OUTCOME' || i.code === 'OUTCOME_NON_APPLICABLE').length === 2));

  const dirtyOurs = AE.computeMatchAnalytics({ events: [evO(1, 'Duel', 'SUCCESS'), evO(2, 'Foul', 'won'), evO(3, 'Shot', 'SUCCESS')], matchInfo: {}, matchClock: {} });
  ok('B17: invalid outcome values are dropped from summaries (flag + excluded), never counted',
    dirtyOurs.level1.outcomes.our.Duel.successCount.value === 1 &&
      !('Foul' in dirtyOurs.level1.outcomes.our) && !('Shot' in dirtyOurs.level1.outcomes.our));

  ok('B18: unattributed partition counts its own outcomes (Duel success 1)',
    OC.unattributed.Duel.successCount.value === 1 && OC.unattributed.Duel.unknownOutcomeCount.value === 0);
  ok('B19: opponent partition present and zeroed for this fixture',
    OC.opponent.Duel.successCount.value === 0 && OC.opponent.Duel.successRate.value === null);

  const A2 = AE.computeMatchAnalytics({ events: clone(events), matchInfo: {}, matchClock: {} });
  ok('B20: deterministic — identical input produces identical outcome summaries',
    JSON.stringify(A.level1.outcomes) === JSON.stringify(A2.level1.outcomes));

  // Tests 5-10 at the engine level: all four labels accept null/SUCCESS/FAILURE.
  const threeState = AE.computeMatchAnalytics({
    events: [
      evO(1, 'Duel', null), evO(2, 'Duel', 'SUCCESS'), evO(3, 'Duel', 'FAILURE'),
      evO(4, 'Press', null), evO(5, 'Press', 'SUCCESS'), evO(6, 'Press', 'FAILURE'),
      evO(7, 'Turnover', null), evO(8, 'Turnover', 'SUCCESS'), evO(9, 'Turnover', 'FAILURE'),
      evO(10, 'Cross', null), evO(11, 'Cross', 'SUCCESS'), evO(12, 'Cross', 'FAILURE')
    ], matchInfo: {}, matchClock: {}
  }).level1.outcomes.our;
  ok('B21 (tests 5-10 engine): all four labels accept null/SUCCESS/FAILURE — each ends 1/1/1 with rate 50%',
    ['Duel', 'Press', 'Turnover', 'Cross'].every((l) =>
      threeState[l].successCount.value === 1 && threeState[l].failureCount.value === 1 &&
      threeState[l].unknownOutcomeCount.value === 1 && threeState[l].outcomeCount.value === 2 &&
      threeState[l].successRate.value === 50),
    JSON.stringify(threeState));
}

// ===========================================================================
// PART C — UI + persistence + export (jsdom with the real renderer)
// ===========================================================================
section('C — UI / PERSISTENCE / EXPORT (jsdom, real index.html + renderer.js)');

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

const jsdomErrors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeStub(initial) {
  const calls = { saveSession: [], autosaveWrite: [], exportCsv: [], loadSession: 0 };
  let loadSessionData = null;
  const stub = {
    openVideo: async () => null,
    saveSession: async (d) => { calls.saveSession.push(clone(d)); return { canceled: false, filePath: '/tmp/r1-session.json' }; },
    exportCsv: async (csv) => { calls.exportCsv.push(String(csv)); return { canceled: false, filePath: '/tmp/r1-export.csv' }; },
    exportClipPlaylist: async () => ({ canceled: true }),
    loadSession: async () => { calls.loadSession++; return clone(loadSessionData); },
    loadMultipleSessions: async () => [],
    loadSquad: async () => clone(initial.squad || []),
    saveSquad: async () => true,
    detachVideo: async () => true,
    reattachVideo: async () => true,
    sendVideoCommand: () => {},
    onVideoState: () => {},
    onVideoClosed: () => {},
    autosaveRead: async () => null,
    autosaveWrite: async (d) => { calls.autosaveWrite.push(clone(d)); return { ok: true, path: '/tmp/autosave.json' }; },
    autosaveDelete: async () => ({ ok: true }),
    autosaveFlushSync: () => ({ ok: true }),
    onCloseRequested: () => {},
    closeProceed: () => {},
    _setLoadSession: (d) => { loadSessionData = d; },
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

(async () => {
  let B = null;
  function click(el, opts) { el.dispatchEvent(new B.win.MouseEvent('click', Object.assign({ bubbles: true, cancelable: true }, opts || {}))); }
  function id(x) { return B.doc.getElementById(x); }
  function tagBtn(label) {
    return Array.from(B.doc.querySelectorAll('#tagButtons .tag-btn')).find((b) => b.textContent.replace('⏱', '').trim().startsWith(label));
  }
  function detailDone() { const b = id('detailPanelDone'); if (b) click(b); }
  function outcomeChips() {
    return Array.from(B.doc.querySelectorAll('#detailPanel .chip[data-kind="outcome"]'));
  }
  function outcomeChip(value) { return outcomeChips().find((c) => c.dataset.value === value) || null; }
  function currentEvents() {
    // The renderer keeps events in a closure; read the live list through the
    // event-log DOM (authoritative user-visible state) plus autosave payloads
    // for field-level assertions. For direct field access we use the last
    // autosave write (debounced 1500ms).
    return null;
  }
  function rowCount() { return B.doc.querySelectorAll('#eventList .event-row').length; }
  function selectTeam(team) { click(team === 'our' ? id('btnTeamOur') : id('btnTeamOpponent')); }

  // ---- Static source wiring checks ----------------------------------------
  {
    ok('C-S1: renderer defines the R1 outcome vocabulary (4 applicable labels, display words)',
      /const OUTCOME_APPLICABLE = \['Duel', 'Press', 'Turnover', 'Cross'\]/.test(rendererSrc) &&
      /Duel: \{ SUCCESS: 'Won', FAILURE: 'Lost' \}/.test(rendererSrc) &&
      /Press: \{ SUCCESS: 'Success', FAILURE: 'Failure' \}/.test(rendererSrc) &&
      /Turnover: \{ SUCCESS: 'Successful', FAILURE: 'Unsuccessful' \}/.test(rendererSrc) &&
      /Cross: \{ SUCCESS: 'Successful', FAILURE: 'Unsuccessful' \}/.test(rendererSrc));
    ok('C-S2: buildEventBase initializes the first-class field (outcome: null)',
      /subtype: null,\s*\n\s*\/\/ R1[\s\S]{0,220}?outcome: null,/.test(rendererSrc));
    ok('C-S3: outcome chip handler writes ev.outcome (never qualifiers{})',
      /kind === 'outcome'[\s\S]{0,400}?ev\.outcome = \(ev\.outcome === value\) \? null : value;/.test(rendererSrc) &&
      !/ev\.qualifiers\[['"]outcome['"]\]/.test(rendererSrc));
    ok('C-S4: analytics.js exposes level1.outcomes with the three partitions',
      /outcomes: \{\s*our: outcomeMetrics\(/.test(analyticsSrc));
    ok('C-S5: all three event-level CSV exports carry the outcome column (standard, season, full-analysis)',
      /location_x,location_y,outcome'/.test(rendererSrc) && /'Event Outcome'/.test(rendererSrc) &&
      (rendererSrc.match(/location_x,location_y,outcome'/g) || []).length === 2);
  }

  // ---- BOOT 1: desktop detail panel — add / change / clear + applicability
  {
    B = boot({ squad: [{ id: 'player_1', number: '9', name: 'R One' }, { id: 'player_2', number: '4', name: 'R Two' }] });
    await sleep(300);
    selectTeam('our');

    // Duel — applicable: null -> SUCCESS -> FAILURE -> null
    click(tagBtn('Duel'));
    await sleep(50);
    ok('C1 (test 20): desktop detail exposes outcome chips for Duel (Won / Lost, none selected initially)',
      outcomeChips().length === 2 && outcomeChip('SUCCESS') && outcomeChip('SUCCESS').textContent === 'Won' &&
      outcomeChip('FAILURE').textContent === 'Lost' && !outcomeChips().some((c) => c.classList.contains('selected')));
    ok('C2 (test 5): newly tagged Duel starts with outcome null (creation never blocked)',
      outcomeChips().length === 2 && id('detailPanel').style.display === 'block' && rowCount() === 1);

    click(outcomeChip('SUCCESS'));
    await sleep(50);
    ok('C3 (test 6 / 22): outcome can be ADDED — Won chip becomes selected',
      outcomeChip('SUCCESS').classList.contains('selected') && !outcomeChip('FAILURE').classList.contains('selected'));
    ok('C4: event list shows the outcome word (Won) for the duel',
      /Won/.test(id('eventList').textContent));

    click(outcomeChip('FAILURE'));
    await sleep(50);
    ok('C5 (test 7 / 23): outcome can be CHANGED — Lost now selected, Won cleared',
      outcomeChip('FAILURE').classList.contains('selected') && !outcomeChip('SUCCESS').classList.contains('selected'));
    ok('C6: event list outcome word follows the change (Lost)',
      /Lost/.test(id('eventList').textContent) && !/Won/.test(id('eventList').textContent));

    click(outcomeChip('FAILURE'));
    await sleep(50);
    ok('C7 (test 24): outcome can be CLEARED back to null (tap selected chip — none selected now)',
      !outcomeChips().some((c) => c.classList.contains('selected')));
    ok('C8: event list no longer shows an outcome word',
      !/Won|Lost/.test(id('eventList').textContent));
    detailDone();

    // Press / Turnover / Cross — applicable with their display words
    click(tagBtn('Press'));
    await sleep(50);
    ok('C9 (test 8 / 20): Press detail exposes outcome (Success / Failure)',
      outcomeChips().length === 2 && outcomeChip('SUCCESS').textContent === 'Success' && outcomeChip('FAILURE').textContent === 'Failure');
    click(outcomeChip('SUCCESS'));
    await sleep(50);
    ok('C10 (test 8): Press SUCCESS set', outcomeChip('SUCCESS').classList.contains('selected'));
    detailDone();

    click(tagBtn('Turnover'));
    await sleep(50);
    ok('C11 (test 9 / 20): Turnover detail exposes outcome (Successful / Unsuccessful)',
      outcomeChips().length === 2 && outcomeChip('SUCCESS').textContent === 'Successful' && outcomeChip('FAILURE').textContent === 'Unsuccessful');
    click(outcomeChip('FAILURE'));
    await sleep(50);
    ok('C12 (test 9): Turnover FAILURE set', outcomeChip('FAILURE').classList.contains('selected'));
    detailDone();

    click(tagBtn('Cross'));
    await sleep(50);
    ok('C13 (test 10 / 20): Cross detail exposes outcome (Successful / Unsuccessful)',
      outcomeChips().length === 2 && outcomeChip('SUCCESS').textContent === 'Successful' && outcomeChip('FAILURE').textContent === 'Unsuccessful');
    click(outcomeChip('SUCCESS'));
    await sleep(50);
    ok('C14 (test 10): Cross SUCCESS set', outcomeChip('SUCCESS').classList.contains('selected'));
    detailDone();

    // Non-applicable events: no outcome control, Pass qualifier mechanism intact
    click(tagBtn('Pass'));
    await sleep(50);
    ok('C15 (test 25): Pass has NO outcome control (qualifier chips only, as before)',
      outcomeChips().length === 0 && Array.from(B.doc.querySelectorAll('#detailPanel .chip[data-kind="qualifier"]')).length === 4);
    const passQualChip = Array.from(B.doc.querySelectorAll('#detailPanel .chip[data-kind="qualifier"]')).find((c) => c.textContent === 'Successful');
    click(passQualChip);
    await sleep(50);
    const passQualSelected = Array.from(B.doc.querySelectorAll('#detailPanel .chip[data-kind="qualifier"]')).find((c) => c.textContent === 'Successful');
    ok('C16 (test 19): Pass qualifier outcome mechanism still works in the UI (Successful selectable)',
      passQualSelected.classList.contains('selected'));
    detailDone();

    click(tagBtn('Foul'));
    await sleep(50);
    ok('C17 (test 25): Foul has no outcome control',
      outcomeChips().length === 0);
    detailDone();

    // Persistence: autosave payload carries the outcome values (test 26)
    await sleep(1750); // AUTOSAVE_DEBOUNCE_MS + margin
    const payload = B.stub._calls.autosaveWrite[B.stub._calls.autosaveWrite.length - 1];
    const findEv = (label) => payload.events.find((e) => e.label === label);
    ok('C18 (test 26): autosave persistence preserves outcome exactly',
      payload && findEv('Press').outcome === 'SUCCESS' && findEv('Turnover').outcome === 'FAILURE' &&
      findEv('Cross').outcome === 'SUCCESS' && findEv('Duel').outcome === null && findEv('Pass').outcome === null,
      payload ? ['Duel:' + findEv('Duel').outcome, 'Press:' + findEv('Press').outcome, 'Turnover:' + findEv('Turnover').outcome, 'Cross:' + findEv('Cross').outcome, 'Pass:' + findEv('Pass').outcome].join(' ') : 'no autosave write');
    ok('C19 (test 19): Pass outcome stays in qualifiers (never the first-class field) in the persisted payload',
      payload && findEv('Pass').qualifiers['Outcome'] === 'Successful');

    // Export: standard CSV + full-analysis CSV carry outcome (test 27)
    click(id('btnExportCsv'));
    await sleep(80);
    const stdCsv = B.stub._calls.exportCsv[B.stub._calls.exportCsv.length - 1];
    const stdLines = stdCsv ? stdCsv.split('\n') : [];
    const stdHeader = stdLines[0] || '';
    const stdDuelRow = stdLines.find((l) => l.split(',')[5] === 'Duel');
    const stdPressRow = stdLines.find((l) => l.split(',')[5] === 'Press');
    const stdPassRow = stdLines.find((l) => l.split(',')[5] === 'Pass');
    ok('C20 (test 27): standard CSV header ends with the appended outcome column',
      stdHeader.endsWith(',outcome'), stdHeader.slice(-40));
    ok('C21 (test 27): standard CSV carries outcome values (Press SUCCESS, Pass empty) and null stays empty',
      stdPressRow && stdPressRow.split(',').pop() === 'SUCCESS' && stdPassRow && stdPassRow.split(',').pop() === '' && stdDuelRow && stdDuelRow.split(',').pop() === '',
      stdPressRow ? stdPressRow.split(',').pop() : 'no press row');

    click(id('btnExportCsv'), { shiftKey: true });
    await sleep(80);
    const fullCsv = B.stub._calls.exportCsv[B.stub._calls.exportCsv.length - 1];
    const fullHeader = (fullCsv || '').split('\n')[0] || '';
    const fullPressRow = (fullCsv || '').split('\n').find((l) => l.split(',')[17] === 'Press');
    ok('C22 (test 27): full-analysis CSV appends the Event Outcome column (36 cols) without touching the existing Outcome (qualifiers) column',
      fullHeader.split(',').length === 36 && fullHeader.endsWith('Event Outcome') && fullHeader.split(',').includes('Outcome'),
      fullHeader.split(',').length + ' cols');
    ok('C23 (test 27): full-analysis CSV row carries the first-class outcome (Press SUCCESS)',
      fullPressRow && fullPressRow.split(',').pop() === 'SUCCESS');
    ok('C23b (test 27): full-analysis CSV rows carry exactly 36 fields (header and rows agree — no ragged rows)',
      (fullCsv || '').split('\n').every((l) => l === '' || l.split(',').length === 36),
      'row lengths=' + Array.from(new Set((fullCsv || '').split('\n').filter(Boolean).map((l) => l.split(',').length))).join(','));
  }

  // ---- BOOT 2: Touchline — same detail panel (F1.1), no second system
  {
    B = boot({ squad: [{ id: 'player_1', number: '9', name: 'T One' }] });
    await sleep(300);
    selectTeam('our');
    click(id('btnTouchlineToggle'));
    await sleep(50);

    const pressQuick = Array.from(B.doc.querySelectorAll('#touchlineQuickTags .touchline-tag-btn')).find((b) => b.textContent.trim().startsWith('Press'));
    click(pressQuick);
    await sleep(50);
    ok('C24 (test 21): Touchline detail panel opens after a quick tag (F1.1 layering)',
      id('detailPanel').style.display === 'block' && id('detailPanel').classList.contains('touchline-detail'));
    ok('C25 (test 21): Touchline detail exposes the SAME outcome controls (no second detail system)',
      outcomeChips().length === 2 && outcomeChip('SUCCESS').textContent === 'Success');
    click(outcomeChip('SUCCESS'));
    await sleep(50);
    ok('C26 (tests 22/8): outcome settable from Touchline', outcomeChip('SUCCESS').classList.contains('selected'));
    click(outcomeChip('SUCCESS'));
    await sleep(50);
    ok('C27 (test 24): outcome clearable from Touchline back to null',
      !outcomeChips().some((c) => c.classList.contains('selected')));
    detailDone();
    click(id('btnExitTouchline'));
    await sleep(50);
  }

  // ---- BOOT 3: loading a v4 session preserves outcomes (test 26)
  {
    B = boot({ squad: [{ id: 'player_1', number: '9', name: 'L One' }] });
    await sleep(300);

    const v4 = {
      __schemaVersion: 4, videoPath: null, videoUrl: null,
      tags: [], squad: [{ id: 'player_1', number: '9', name: 'L One' }],
      matchInfo: { opponent: 'Load FC' },
      matchClock: { period: 'FT', clockBaseSeconds: 5400, clockRunning: false, clockStartedAt: null, scoreFor: 0, scoreAgainst: 0, selectedTeam: 'our', selectedPlayerId: null },
      events: [
        { id: 1, time: 60, matchTime: 60, matchSeconds: 60, officialMinute: 1, second: 0, period: '2H', label: 'Duel', subtype: null, outcome: 'SUCCESS', qualifiers: {}, location: null, playerId: 'player_1', playerOffId: null, playerOnId: null, side: 'for', team: 'our', sequenceId: null, scoreForBefore: 0, scoreAgainstBefore: 0 },
        { id: 2, time: 120, matchTime: 120, matchSeconds: 120, officialMinute: 2, second: 0, period: '2H', label: 'Turnover', subtype: null, outcome: 'FAILURE', qualifiers: {}, location: null, playerId: 'player_1', playerOffId: null, playerOnId: null, side: 'for', team: 'our', sequenceId: null, scoreForBefore: 0, scoreAgainstBefore: 0 },
        { id: 3, time: 180, matchTime: 180, matchSeconds: 180, officialMinute: 3, second: 0, period: '2H', label: 'Cross', subtype: null, outcome: null, qualifiers: {}, location: null, playerId: 'player_1', playerOffId: null, playerOnId: null, side: 'for', team: 'our', sequenceId: null, scoreForBefore: 0, scoreAgainstBefore: 0 },
        { id: 4, time: 240, matchTime: 240, matchSeconds: 240, officialMinute: 4, second: 0, period: '2H', label: 'Pass', subtype: null, outcome: null, qualifiers: { 'Outcome': 'Successful' }, location: null, playerId: 'player_1', playerOffId: null, playerOnId: null, side: 'for', team: 'our', sequenceId: null, scoreForBefore: 0, scoreAgainstBefore: 0 }
      ]
    };
    B.stub._setLoadSession(v4);
    click(id('btnLoadSession'));
    await sleep(300);

    ok('C28 (test 26): loading a v4 session restores all 4 events', rowCount() === 4, 'rows=' + rowCount());
    ok('C29 (test 26): event list shows the loaded outcome words (Won for the Duel, Unsuccessful for the Turnover)',
      /Won/.test(id('eventList').textContent) && /Unsuccessful/.test(id('eventList').textContent));

    // Re-open the loaded Duel via the edit pencil: the outcome chip state must match the loaded value.
    const duelRow = Array.from(B.doc.querySelectorAll('#eventList .event-row')).find((r) => r.textContent.includes('Duel'));
    click(duelRow.querySelector('.event-edit'));
    await sleep(50);
    ok('C30 (test 26): loaded Duel shows its outcome selected (Won) in the detail panel',
      outcomeChips().length === 2 && outcomeChip('SUCCESS').classList.contains('selected'));
    // Change it and clear it — the loaded event is still fully editable.
    click(outcomeChip('FAILURE'));
    await sleep(50);
    ok('C31 (tests 23/26): loaded event outcome changeable (Duel -> Lost)', outcomeChip('FAILURE').classList.contains('selected'));
    click(outcomeChip('FAILURE'));
    await sleep(50);
    ok('C32 (tests 24/26): loaded event outcome clearable (back to null)', !outcomeChips().some((c) => c.classList.contains('selected')));
    detailDone();

    // The loaded Pass still resolves through the QUALIFIER mechanism (not outcome).
    const passRow = Array.from(B.doc.querySelectorAll('#eventList .event-row')).find((r) => r.textContent.includes('Pass'));
    click(passRow.querySelector('.event-edit'));
    await sleep(50);
    ok('C33 (test 19): loaded Pass has no outcome control and its qualifier is intact',
      outcomeChips().length === 0 && Array.from(B.doc.querySelectorAll('#detailPanel .chip[data-kind="qualifier"]')).some((c) => c.textContent === 'Successful' && c.classList.contains('selected')));
    detailDone();
  }

  // ---- Report --------------------------------------------------------------
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
  console.log('---- R1 outcome check: ' + pass + ' passed, ' + fail + ' failed ----');
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('HARNESS CRASH:', err && err.stack ? err.stack : err);
  process.exit(1);
});
