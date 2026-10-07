#!/usr/bin/env node
// PitchLog / MatchTag — Stage 4A Match Analysis Dashboard MODEL suite (M2)
// =============================================================================
// tests/match-analysis-model-check.js — rebuilt fresh per spec §10 of
// docs/match-analysis-dashboard-specification.md (V1.1 — AUTHORITATIVE).
//
// Verifies src/match-analysis.js as a PURE PROJECTION of the analytics engine
// (src/analytics.js) — every aggregate sourced from
// computeMatchAnalytics/computeSpatialView output, never recomputed locally.
//
// Fixtures (spec §10):
//   ORACLE — 19 recovered events, 17 key rows, 3 Substitutions (2 our + 1
//            opponent), 4 Positive Transitions (3 our + 1 opponent), seeks
//            240 / null→1350 fallback / 140, one team-null Corner (X2),
//            score chain 1–1 with manual MATCH, 11 located events.
//   BASE   — no Sub / Positive Transition (and no qualifying label at all):
//            drives the zero-card ('0 · 0') and empty-list surfaces, the
//            MANUAL-EMPTY X1 note, one tagged Possession interval, and
//            5-located (below min-sample) grids.
//   RATIO  — 3 our passes (2 successful + 1 unsuccessful) by one player:
//            the exact-string RATIO pin fixture ("66.7%", review rider).
//
// Sections:
//   MA-M1  module contract, vocabularies, fixture sanity, hostile inputs
//   MA-M2  D2 regression — no programmatic .click() anywhere; keyboard
//          delegation (Enter/Space, preventDefault, NO stopPropagation);
//          byte-identical double renders (incl. empty keyEvents)
//   MA-M3  identity & resolution (§7 — single resolver chain, no merging)
//   MA-M4  single-execution contract (§6 — engine once per render, shared
//          precomputed, no module-level caching)
//   MA-M5  match header (§13.1)
//   MA-M6  team summary & performance model (§13.4)
//   MA-M7  spatial analysis (§3/§13.6 — engine grid, min-sample gate from
//          the engine param, host-only visuals, numeric tables)
//   MA-M8  purity (§8 — the session snapshot is never mutated)
//   MA-M9  period analysis & sequences models (§13.5/§13.8)
//   MA-M10 lexical & structural scan (§2/§8/§12 laws on the module source)
//   MA-M11 THE CORRECTIVE-ROUND SECTION — exactly 18 assertions (spec §10):
//          exactly-N aggregates, envelope-source proof, 10-card render,
//          list rows/counts/order, seek inputs & rendered attributes,
//          zero case on both surfaces
//   MA-M12 section inventory & sourcing (§13.1/13.4/13.5/13.7/13.8/13.9 —
//          every value equals its named engine source; every L1_COUNT_ROWS /
//          L2_DERIVED_ROWS / PLAYER_COLS field proven REAL against the
//          engine envelopes; RIDER: exact-string "66.7%" Pass-success pin)
//
// The stub host mirrors the renderer's real markup/constants (renderer.js
// ZONE_LINES_SVG an-zoneline lines, pitchMarkingsSvg, DENSITY_FILLS crimson
// ramp, densityStep algorithm) — the module must consume them via the host
// API and never duplicate them.
//
// jsdom is NOT a project dependency: it lives only in the git-ignored
// tests/.jsdom-scratch folder (same as the other UI checks).
//
// Run:  node tests/match-analysis-model-check.js   (from the pitchlog root)

'use strict';

const path = require('path');
const fs = require('fs');

const jsdomDir = process.env.JSDOM_PATH
  ? process.env.JSDOM_PATH
  : path.join(__dirname, '.jsdom-scratch', 'node_modules');
let JSDOM;
try {
  JSDOM = require(path.join(jsdomDir, 'jsdom')).JSDOM;
} catch (e) {
  console.error('jsdom not found in ' + jsdomDir);
  console.error('Install it with:  cd tests/.jsdom-scratch && npm install jsdom');
  process.exit(2);
}

const srcDir = path.join(__dirname, '..', 'src');
const AE = require(path.join(srcDir, 'analytics.js'));       // the REAL engine
const MAD = require(path.join(srcDir, 'match-analysis.js')); // the module under test
const moduleSrc = fs.readFileSync(path.join(srcDir, 'match-analysis.js'), 'utf-8');

// ---------------------------------------------------------------------------
// Results bookkeeping
// ---------------------------------------------------------------------------
const results = [];
let currentSection = '';
const sectionCounts = {};

function ok(name, cond, detail) {
  const id = currentSection ? currentSection + ' ' + name : name;
  results.push({ id: id, pass: !!cond, detail: detail || '' });
  if (currentSection) sectionCounts[currentSection] = (sectionCounts[currentSection] || 0) + 1;
  if (!cond) process.exitCode = 1;
}

function section(name) {
  currentSection = name;
  console.log('== ' + name + ' ==');
}

// Deep-equal for plain arrays/scalars (vocabularies).
function arrEq(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length &&
    a.every((v, i) => v === b[i]);
}

// Robust class query in jsdom (SVG elements: use the class attribute).
function qsaClass(scope, cls) {
  return Array.from(scope.querySelectorAll('*')).filter((el) => {
    const c = el.getAttribute && el.getAttribute('class');
    return c && c.split(/\s+/).indexOf(cls) !== -1;
  });
}

// ---------------------------------------------------------------------------
// Fixtures (spec §10; every pinned value below was verified against the REAL
// engine before this suite was finalized)
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
    { id: 'player_3', name: 'Mulugeta Ayalew', number: '7' },   // in XI, no events
    { id: 'player_4', name: 'Dawit Haile', number: '4' },
    { id: 'player_5', name: 'Yonas Girma', number: '14' },
    { id: 'player_6', name: 'Solomon Mamo', number: '6' },
    { id: 'player_7', name: 'Tesfaye Alemu', number: '18' },
    { id: 'player_8', name: 'Getachew Worku', number: '21' }    // not in XI, no sub
  ];
  // NOTE: events 14 and 13 are deliberately in scrambled array order (equal
  // times, id tiebreak must come from the SORT, and purity must preserve the
  // source order).
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

function ratioSession() {
  const events = [
    E(1, { time: 100, period: '1H', matchSeconds: 100, label: 'Pass', team: 'our', playerId: 'player_1', subtype: 'Progressive', qualifiers: { Outcome: 'Successful', Pressure: 'Free' } }),
    E(2, { time: 200, period: '1H', matchSeconds: 200, label: 'Pass', team: 'our', playerId: 'player_1', subtype: 'Lateral', qualifiers: { Outcome: 'Successful', Pressure: 'Under pressure' } }),
    E(3, { time: 300, period: '1H', matchSeconds: 300, label: 'Pass', team: 'our', playerId: 'player_1', subtype: 'Long', qualifiers: { Outcome: 'Unsuccessful', Pressure: 'Free' } })
  ];
  return {
    __schemaVersion: 3, __savedAt: '2026-10-05T18:00:00.000Z',
    videoPath: null, videoUrl: null,
    matchInfo: { competition: 'Ratio Fixture League', homeAway: 'away', opponent: 'Pct United', date: '2026-10-05' },
    matchClock: null,
    squad: [{ id: 'player_1', name: 'Ratio Tester', number: '8' }],
    events: events
  };
}

// ---------------------------------------------------------------------------
// Stub host — mirrors the renderer's REAL markup/constants (renderer.js
// ZONE_LINES_SVG :3931 an-zoneline lines, pitchMarkingsSvg :2643,
// DENSITY_FILLS :3903 crimson ramp, densityStep :3912). The module must
// consume these through the host API and never duplicate them.
// ---------------------------------------------------------------------------
function stubHost(squadList, overrides) {
  const map = {};
  (squadList || []).forEach((p) => {
    map[p.id] = { displayName: p.name, shirtNumber: p.number };
  });
  return Object.assign({
    seekLog: [],
    resolveLog: [],
    seekTo: function (t) { this.seekLog.push(t); },
    resolvePlayer: function (pid) {
      this.resolveLog.push(pid);
      return map[pid] || null;
    },
    zoneLinesSvg: function () {
      return '<line x1="233.33" y1="0" x2="233.33" y2="450" class="an-zoneline"/>'
        + '<line x1="466.67" y1="0" x2="466.67" y2="450" class="an-zoneline"/>'
        + '<line x1="0" y1="150" x2="700" y2="150" class="an-zoneline"/>'
        + '<line x1="0" y1="300" x2="700" y2="300" class="an-zoneline"/>';
    },
    pitchMarkingsSvg: function () {
      return '<rect x="4" y="4" width="692" height="442" class="pitch-outline" rx="3" />';
    },
    densityFills: function () {
      return [null, 'rgba(216, 30, 46, 0.22)', 'rgba(216, 30, 46, 0.42)',
        'rgba(216, 30, 46, 0.62)', 'rgba(216, 30, 46, 0.82)'];
    },
    densityStep: function (count, maxCount) {
      if (!(count > 0) || !(maxCount > 0)) return 0;
      const s = count / maxCount;
      if (s <= 0.25) return 1;
      if (s <= 0.50) return 2;
      if (s <= 0.75) return 3;
      return 4;
    }
  }, overrides || {});
}

// Host with NO methods at all (hostile: missing seekTo/resolvePlayer/markings).
function emptyHost() { return {}; }

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------
function renderSession(session, host, precomputed) {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
  const win = dom.window;
  const doc = win.document;
  const container = doc.createElement('div');
  doc.body.appendChild(container);
  const model = MAD.renderAnalysis(container, session, host, precomputed);
  const root = container.firstElementChild;
  return {
    win: win, doc: doc, container: container, root: root, model: model,
    html: root ? root.innerHTML : ''
  };
}

function keyRowsOf(root) {
  return Array.from(root.querySelectorAll('button.ma-key-row'));
}

function cardsOf(root) {
  return Array.from(root.querySelectorAll('.ma-cards .ma-card'));
}

function cardValueText(cardEl) {
  const v = cardEl.querySelector('.ma-card-value');
  return v ? v.textContent : '';
}

function teamTables(root) {
  const sec = root.querySelector('section[data-ma-section="team"]');
  return sec ? Array.from(sec.querySelectorAll('table.ma-team')) : [];
}

function tableRows(tableEl) {
  return Array.from(tableEl.querySelectorAll('tbody tr'));
}

function findRowByLabel(rows, label) {
  return rows.find((tr) => tr.cells && tr.cells[0] && tr.cells[0].textContent === label) || null;
}

// Engine-side helpers (the sourcing comparisons use the ENGINE output the
// test computes itself — never the module's model).
function countOfTest(env) {
  return env && typeof env.value === 'number' ? env.value : 0;
}
function ratioTextTest(env) {
  return env && typeof env.value === 'number' ? String(env.value) + '%' : 'n/a';
}
function readPathTest(obj, p) {
  return p.split('.').reduce((cur, k) => (cur == null ? undefined : cur[k]), obj);
}

// Extract a `var NAME = [ ... ];` constant block from the module source.
function constBlock(name) {
  const m = moduleSrc.match(new RegExp('var ' + name + ' = \\[([\\s\\S]*?)\\n  \\];'));
  return m ? m[1] : null;
}

// Comment-stripped source (for the M10 lexical scans).
function strippedSource() {
  return moduleSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

// ===========================================================================
// MA-M1 — Module contract, vocabularies, fixture sanity, hostile inputs
// ===========================================================================
section('MA-M1');

ok('M1.1 UMD loads in Node; VERSION/SPEC exact',
  !!MAD && typeof MAD === 'object' && MAD.VERSION === '1.0.0' &&
  MAD.SPEC === 'PitchLog-MATCH-ANALYSIS-DASHBOARD-V1.1',
  'version=' + MAD.VERSION + ' spec=' + MAD.SPEC);

ok('M1.2 KEY_COUNT_FIELDS = exactly the ten §4 envelope fields, in card order',
  arrEq(MAD.KEY_COUNT_FIELDS, ['goals', 'shots', 'chances', 'crosses', 'corners',
    'fouls', 'yellowCards', 'redCards', 'substitutions', 'positiveTransitions']),
  JSON.stringify(MAD.KEY_COUNT_FIELDS));

ok('M1.3 CARD_LABELS = the ten sentence-case labels, in order',
  arrEq(MAD.CARD_LABELS, ['Goals', 'Shots', 'Chances', 'Crosses', 'Corners',
    'Fouls', 'Yellow cards', 'Red cards', 'Substitutions', 'Positive transitions']),
  JSON.stringify(MAD.CARD_LABELS));

ok('M1.4 KEY_EVENT_LABELS = the nine engine labels (§5)',
  arrEq(MAD.KEY_EVENT_LABELS, ['Goal', 'Shot', 'Chance', 'Cross', 'Corner',
    'Foul', 'Card', 'Sub', 'Positive Transition']),
  JSON.stringify(MAD.KEY_EVENT_LABELS));

ok('M1.5 DISPLAY_LABELS expands only Sub',
  typeof MAD.DISPLAY_LABELS === 'object' &&
  Object.keys(MAD.DISPLAY_LABELS).length === 1 &&
  MAD.DISPLAY_LABELS.Sub === 'Substitution',
  JSON.stringify(MAD.DISPLAY_LABELS));

ok('M1.6 DEFAULT_SPATIAL_FILTERS = engine defaults, all __all__ (§6/§13.6)',
  MAD.DEFAULT_SPATIAL_FILTERS &&
  ['scope', 'team', 'period', 'state', 'sequence', 'player'].every((k) =>
    MAD.DEFAULT_SPATIAL_FILTERS[k] === '__all__'),
  JSON.stringify(MAD.DEFAULT_SPATIAL_FILTERS));

ok('M1.7 public API: buildModel + renderAnalysis functions',
  typeof MAD.buildModel === 'function' && typeof MAD.renderAnalysis === 'function', '');

const M1_ORACLE = oracleSession();
ok('M1.8 oracle fixture sanity: 19 events; 3 Sub (2 our + 1 opp); 4 PT (3 our + 1 opp)',
  M1_ORACLE.events.length === 19 &&
  M1_ORACLE.events.filter((e) => e.label === 'Sub' && e.team === 'our').length === 2 &&
  M1_ORACLE.events.filter((e) => e.label === 'Sub' && e.team === 'opponent').length === 1 &&
  M1_ORACLE.events.filter((e) => e.label === 'Positive Transition' && e.team === 'our').length === 3 &&
  M1_ORACLE.events.filter((e) => e.label === 'Positive Transition' && e.team === 'opponent').length === 1,
  'events=' + M1_ORACLE.events.length);

ok('M1.9 oracle fixture sanity: 17 qualifying key rows, 2 non-qualifying (§10)',
  M1_ORACLE.events.filter((e) =>
    ['Goal', 'Shot', 'Chance', 'Cross', 'Corner', 'Foul', 'Card', 'Sub',
      'Positive Transition'].indexOf(e.label) !== -1).length === 17 &&
  M1_ORACLE.events.filter((e) => e.label === 'Pass' || e.label === 'Press').length === 2,
  '');

const M1_BASE = baseSession();
ok('M1.10 base fixture sanity: no Sub, no PT, zero qualifying labels (empty list)',
  M1_BASE.events.length === 12 &&
  M1_BASE.events.every((e) =>
    ['Goal', 'Shot', 'Chance', 'Cross', 'Corner', 'Foul', 'Card', 'Sub',
      'Positive Transition'].indexOf(e.label) === -1),
  '');

ok('M1.11 hostile: buildModel(null) renders zeros/empty without crashing',
  (() => {
    const m = MAD.buildModel(null, stubHost([]));
    return !!m && m.cards.length === 10 &&
      m.cards.every((c) => c.our === 0 && c.opponent === 0) &&
      m.keyEvents.empty === true &&
      m.header.metaText === 'No match details set';
  })(), '');

ok('M1.12 hostile: null container returns null; junk events render null-safe',
  (() => {
    if (MAD.renderAnalysis(null, M1_ORACLE, stubHost(M1_ORACLE.squad)) !== null) return false;
    const junk = {
      matchInfo: {}, squad: [],
      events: [42, { label: 7 }, {
        label: 'Goal', id: 'abc', time: undefined, matchTime: undefined,
        videoTime: 'x', qualifiers: 9, location: { x: 'z', y: 2 }
      }, { label: 'Sub', playerOffId: 5, playerOnId: true }]
    };
    const r = renderSession(junk, stubHost([]));
    if (!r.model) return false;
    // The Goal row survives with id fallback = source index 2, time fallback 0;
    // the Sub row renders an empty "off → on" pair (non-string ids are not
    // resolvable — the app's real Sub events always carry string ids).
    const rows = r.model.keyEvents.rows;
    return rows.length === 2 && rows[0].eventId === 2 && rows[0].time === 0 &&
      rows[1].playerText === ' → ';
  })(), '');

// ===========================================================================
// MA-M2 — D2 regression: no programmatic .click(); delegation; determinism
// ===========================================================================
section('MA-M2');

const M2_HOST = stubHost(oracleSession().squad);
const M2_R = renderSession(oracleSession(), M2_HOST);

// Poison HTMLElement.prototype.click (jsdom SVG elements do not expose
// .click() at all — the exact D2 environment). Any programmatic .click()
// anywhere in the module throws and is flagged.
function poisonClick(win) {
  const orig = win.HTMLElement.prototype.click;
  let invoked = false;
  win.HTMLElement.prototype.click = function () {
    invoked = true;
    throw new Error('D2 regression: programmatic .click() invoked');
  };
  return {
    wasInvoked: () => invoked,
    restore: () => { win.HTMLElement.prototype.click = orig; }
  };
}

ok('M2.1 full render under a poisoned .click() completes and never invokes it',
  (() => {
    const p = poisonClick(M2_R.win);
    try {
      // Render INTO the poisoned window (a fresh JSDOM would have its own
      // prototypes and the poison would not apply).
      const container2 = M2_R.doc.createElement('div');
      M2_R.doc.body.appendChild(container2);
      const model = MAD.renderAnalysis(container2, oracleSession(),
        stubHost(oracleSession().squad));
      return !!model && container2.firstElementChild !== null && !p.wasInvoked();
    } catch (e) {
      return false;
    } finally {
      p.restore();
    }
  })(), '');

ok('M2.2 dispatched click on a zone cell opens its trace (no .click(); §8 shared activation)',
  (() => {
    const p = poisonClick(M2_R.win);
    try {
      const cell = qsaClass(M2_R.root, 'ma-zcell').find((c) =>
        c.getAttribute('data-grid') === 'grid:scope=all:partition=our' &&
        c.getAttribute('data-zone') === 'Attacking third · Left channel');
      if (!cell) return false;
      cell.dispatchEvent(new M2_R.win.MouseEvent('click', { bubbles: true, cancelable: true }));
      const trace = M2_R.root.querySelector('.ma-trace[data-trace-grid="grid:scope=all:partition=our"]');
      const title = trace ? trace.querySelector('.ma-trace-title') : null;
      const rows = trace ? qsaClass(trace, 'ma-trace-row') : [];
      return !p.wasInvoked() && !!title &&
        title.textContent === 'Attacking third · Left channel — 2 located events' &&
        rows.length === 2;
    } finally {
      p.restore();
    }
  })(), '');

ok('M2.3 dispatched click on a key row seeks (no .click())',
  (() => {
    const p = poisonClick(M2_R.win);
    try {
      const host = M2_HOST;
      const before = host.seekLog.length;
      const row = M2_R.root.querySelector('button.ma-key-row[data-event-id="2"]');
      row.dispatchEvent(new M2_R.win.MouseEvent('click', { bubbles: true, cancelable: true }));
      return !p.wasInvoked() && host.seekLog.length === before + 1;
    } finally {
      p.restore();
    }
  })(), '');

ok('M2.4 Enter keydown on a zone cell: preventDefault + activation (§8)',
  (() => {
    const cell = qsaClass(M2_R.root, 'ma-zcell').find((c) =>
      c.getAttribute('data-grid') === 'grid:scope=all:partition=our' &&
      c.getAttribute('data-zone') === 'Middle third · Central channel');
    if (!cell) return false;
    const notCancelled = cell.dispatchEvent(new M2_R.win.KeyboardEvent('keydown',
      { key: 'Enter', bubbles: true, cancelable: true }));
    const trace = M2_R.root.querySelector('.ma-trace[data-trace-grid="grid:scope=all:partition=our"]');
    return notCancelled === false && !!trace &&
      trace.getAttribute('data-open-zone') === 'Middle third · Central channel';
  })(), '');

ok('M2.5 Space keydown propagates past the module root (NO stopPropagation; §8/§12.1)',
  (() => {
    let reachedContainer = false;
    M2_R.container.addEventListener('keydown', () => { reachedContainer = true; });
    const cell = qsaClass(M2_R.root, 'ma-zcell').find((c) =>
      c.getAttribute('data-grid') === 'grid:scope=all:partition=our' &&
      c.getAttribute('data-zone') === 'Defensive third · Central channel');
    if (!cell) return false;
    cell.dispatchEvent(new M2_R.win.KeyboardEvent('keydown',
      { key: ' ', bubbles: true, cancelable: true }));
    return reachedContainer === true;
  })(), '');

ok('M2.6 second activation on the same zone closes the trace (toggle)',
  (() => {
    const cell = qsaClass(M2_R.root, 'ma-zcell').find((c) =>
      c.getAttribute('data-grid') === 'grid:scope=all:partition=our' &&
      c.getAttribute('data-zone') === 'Defensive third · Central channel');
    cell.dispatchEvent(new M2_R.win.KeyboardEvent('keydown',
      { key: 'Enter', bubbles: true, cancelable: true }));
    const trace = M2_R.root.querySelector('.ma-trace[data-trace-grid="grid:scope=all:partition=our"]');
    return trace.getAttribute('data-open-zone') === null &&
      trace.textContent.indexOf('Select a zone cell to list its located events.') !== -1;
  })(), '');

ok('M2.7 determinism: oracle AND base (empty keyEvents) double renders byte-identical',
  (() => {
    const o1 = renderSession(oracleSession(), stubHost(oracleSession().squad));
    const o2 = renderSession(oracleSession(), stubHost(oracleSession().squad));
    const b1 = renderSession(baseSession(), stubHost(baseSession().squad));
    const b2 = renderSession(baseSession(), stubHost(baseSession().squad));
    return o1.html === o2.html && b1.html === b2.html && o1.html.length > 0 && b1.html.length > 0;
  })(), '');

// ===========================================================================
// MA-M3 — Identity & resolution (§7)
// ===========================================================================
section('MA-M3');

const M3_SESSION = oracleSession();
const M3_HOST = stubHost(M3_SESSION.squad);
const M3_R = renderSession(M3_SESSION, M3_HOST);

ok('M3.1 resolver receives the EXACT raw playerIds; rows keyed by id alone',
  M3_HOST.resolveLog.indexOf('player_1') !== -1 &&
  M3_HOST.resolveLog.indexOf('match_opp_9') !== -1 &&
  M3_HOST.resolveLog.indexOf('match_opp_10') !== -1 &&
  Array.from(M3_R.root.querySelectorAll('tr[data-player-id]'))
    .every((tr) => /^[\w]+$/.test(tr.getAttribute('data-player-id'))) &&
  !!M3_R.root.querySelector('tr[data-player-id="player_1"]') &&
  !!M3_R.root.querySelector('tr[data-player-id="match_opp_10"]'),
  '');

ok('M3.2 unresolvable ids render the standard "Unknown player" fallback (§7)',
  (() => {
    const r9 = M3_R.root.querySelector('tr[data-player-id="match_opp_9"]');
    const r10 = M3_R.root.querySelector('tr[data-player-id="match_opp_10"]');
    return r9 && r10 && r9.cells[0].textContent.indexOf('Unknown player') !== -1 &&
      r10.cells[0].textContent.indexOf('Unknown player') !== -1;
  })(), '');

ok('M3.3 no name merging: two distinct ids, same display name, two rows (§7)',
  (() => {
    const unknown = Array.from(M3_R.root.querySelectorAll('tr[data-player-id]'))
      .filter((tr) => tr.cells[0].textContent.indexOf('Unknown player') !== -1);
    return unknown.length === 2 &&
      unknown[0].getAttribute('data-player-id') !== unknown[1].getAttribute('data-player-id');
  })(), '');

ok('M3.4 Sub rows display "off → on" through the resolver chain',
  (() => {
    const our = M3_R.root.querySelector('button.ma-key-row[data-event-id="9"]');
    const opp = M3_R.root.querySelector('button.ma-key-row[data-event-id="11"]');
    return our && opp &&
      our.textContent.indexOf('4 Dawit Haile → 14 Yonas Girma') !== -1 &&
      opp.textContent.indexOf('Unknown player → Unknown player') !== -1;
  })(), '');

ok('M3.5 unattributed key rows show the em-dash player placeholder',
  (() => {
    const corner = M3_R.root.querySelector('button.ma-key-row[data-event-id="5"]');
    const goal = M3_R.root.querySelector('button.ma-key-row[data-event-id="19"]');
    const spanOf = (row) => row.querySelector('.ma-key-player').textContent;
    return corner && goal && spanOf(corner) === '—' && spanOf(goal) === '—' &&
      corner.querySelector('.ma-key-team').textContent === '—';
  })(), '');

ok('M3.6 host WITHOUT resolvePlayer: renders, standard fallback, no crash',
  (() => {
    const r = renderSession(oracleSession(), emptyHost());
    if (!r.model) return false;
    const first = r.root.querySelector('tr[data-player-id]');
    return !!first && first.cells[0].textContent.indexOf('Unknown player') !== -1 &&
      qsaClass(r.root, 'ma-dot').length > 0;
  })(), '');

// ===========================================================================
// MA-M4 — Single-execution contract (§6)
// ===========================================================================
section('MA-M4');

ok('M4.1 renderAnalysis without precomputed: each engine exactly once',
  (() => {
    let m = 0; let s = 0;
    const om = AE.computeMatchAnalytics; const os = AE.computeSpatialView;
    AE.computeMatchAnalytics = function (x) { m++; return om(x); };
    AE.computeSpatialView = function (a, f) { s++; return os(a, f); };
    try {
      renderSession(oracleSession(), stubHost(oracleSession().squad));
      return m === 1 && s === 1;
    } finally {
      AE.computeMatchAnalytics = om; AE.computeSpatialView = os;
    }
  })(), '');

ok('M4.2 renderAnalysis with precomputed: ZERO engine calls; objects shared by identity',
  (() => {
    const sess = oracleSession();
    const A = AE.computeMatchAnalytics(sess);
    const view = AE.computeSpatialView(A, MAD.DEFAULT_SPATIAL_FILTERS);
    let m = 0; let s = 0;
    const om = AE.computeMatchAnalytics; const os = AE.computeSpatialView;
    AE.computeMatchAnalytics = function (x) { m++; return om(x); };
    AE.computeSpatialView = function (a, f) { s++; return os(a, f); };
    try {
      const r = renderSession(sess, stubHost(sess.squad), { analytics: A, spatialView: view });
      return m === 0 && s === 0 && r.model.analytics === A && r.model.spatialView === view;
    } finally {
      AE.computeMatchAnalytics = om; AE.computeSpatialView = os;
    }
  })(), '');

ok('M4.3 buildModel without precomputed: fallback engine pass, once each (§6)',
  (() => {
    let m = 0; let s = 0;
    const om = AE.computeMatchAnalytics; const os = AE.computeSpatialView;
    AE.computeMatchAnalytics = function (x) { m++; return om(x); };
    AE.computeSpatialView = function (a, f) { s++; return os(a, f); };
    try {
      const bm = MAD.buildModel(oracleSession(), stubHost(oracleSession().squad));
      return m === 1 && s === 1 && !!bm.analytics && !!bm.spatialView;
    } finally {
      AE.computeMatchAnalytics = om; AE.computeSpatialView = os;
    }
  })(), '');

ok('M4.4 buildModel with precomputed: zero engine calls, shared identity',
  (() => {
    const sess = oracleSession();
    const A = AE.computeMatchAnalytics(sess);
    const view = AE.computeSpatialView(A, MAD.DEFAULT_SPATIAL_FILTERS);
    let m = 0; let s = 0;
    const om = AE.computeMatchAnalytics; const os = AE.computeSpatialView;
    AE.computeMatchAnalytics = function (x) { m++; return om(x); };
    AE.computeSpatialView = function (a, f) { s++; return os(a, f); };
    try {
      const bm = MAD.buildModel(sess, stubHost(sess.squad), { analytics: A, spatialView: view });
      return m === 0 && s === 0 && bm.analytics === A && bm.spatialView === view;
    } finally {
      AE.computeMatchAnalytics = om; AE.computeSpatialView = os;
    }
  })(), '');

ok('M4.5 no module-level caching: two renders = two engine passes (§6)',
  (() => {
    let m = 0; let s = 0;
    const om = AE.computeMatchAnalytics; const os = AE.computeSpatialView;
    AE.computeMatchAnalytics = function (x) { m++; return om(x); };
    AE.computeSpatialView = function (a, f) { s++; return os(a, f); };
    try {
      renderSession(oracleSession(), stubHost(oracleSession().squad));
      renderSession(oracleSession(), stubHost(oracleSession().squad));
      return m === 2 && s === 2;
    } finally {
      AE.computeMatchAnalytics = om; AE.computeSpatialView = os;
    }
  })(), '');

ok('M4.6 precomputed analytics is the object the model exposes (shared, not copied)',
  (() => {
    const sess = oracleSession();
    const A = AE.computeMatchAnalytics(sess);
    const view = AE.computeSpatialView(A, MAD.DEFAULT_SPATIAL_FILTERS);
    const bm = MAD.buildModel(sess, stubHost(sess.squad), { analytics: A, spatialView: view });
    return bm.analytics === A && bm.spatialView === view &&
      bm.minSampleForDensity === A.spatial.params.minSampleForDensity;
  })(), '');

// ===========================================================================
// MA-M5 — Match header (§13.1)
// ===========================================================================
section('MA-M5');

const M5_SESSION = oracleSession();
const M5_A = AE.computeMatchAnalytics(M5_SESSION);
const M5_MODEL = MAD.buildModel(M5_SESSION, stubHost(M5_SESSION.squad),
  { analytics: M5_A, spatialView: AE.computeSpatialView(M5_A, MAD.DEFAULT_SPATIAL_FILTERS) });
const M5_H = M5_MODEL.header;

ok('M5.1 metaText composed from session metadata, exact',
  M5_H.metaText === 'Bahir Dar Premier League · Home · vs Dashen Beer FC · 2026-10-03 · 4-3-3 · Bahir Dar Stadium',
  JSON.stringify(M5_H.metaText));

ok('M5.2 scoreText from the engine goal chain',
  M5_H.scoreText === '1–1' &&
  M5_H.scoreText === M5_A.matchSummary.score.chain.for + '–' + M5_A.matchSummary.score.chain.against,
  M5_H.scoreText);

ok('M5.3 scoreNote: chain attribution + manual + X1 status',
  M5_H.scoreNote === '(goal chain, 2 attributed · manual 1–1 · X1 MATCH)',
  M5_H.scoreNote);

ok('M5.4 facts line exact (events/located/periods/nominal from A.matchSummary)',
  M5_H.totalEvents === 19 && M5_H.locatedEvents === 11 &&
  arrEq(M5_H.periodsPlayed, ['1H', '2H']) && M5_H.durationMinutes === 90 &&
  M5_H.totalEvents === M5_A.matchSummary.totalEvents &&
  M5_H.locatedEvents === M5_A.matchSummary.locatedEvents &&
  M5_H.durationMinutes === M5_A.matchSummary.durationMinutes,
  M5_H.totalEvents + '/' + M5_H.locatedEvents);

ok('M5.5 rendered header shows the same facts (§13.1 renders the model)',
  (() => {
    const r = renderSession(M5_SESSION, stubHost(M5_SESSION.squad));
    const facts = r.root.querySelector('.ma-facts');
    const score = r.root.querySelector('.ma-score-value');
    const meta = r.root.querySelector('.ma-meta');
    return facts && facts.textContent === '19 events used · 11 located · periods 1H, 2H · nominal 90′' &&
      score && score.textContent === '1–1' &&
      meta && meta.textContent === M5_H.metaText;
  })(), '');

ok('M5.6 empty matchInfo → "No match details set" + zero-attribute note (X1 MANUAL-EMPTY)',
  (() => {
    const m = MAD.buildModel({ events: [] }, stubHost([]));
    return m.header.metaText === 'No match details set' &&
      m.header.scoreText === '0–0' &&
      m.header.scoreNote === '(goal chain, 0 attributed · X1 MANUAL-EMPTY)';
  })(), '');

ok('M5.7 base session: MANUAL-EMPTY X1 note + base facts',
  (() => {
    const b = baseSession();
    const A = AE.computeMatchAnalytics(b);
    const m = MAD.buildModel(b, stubHost(b.squad),
      { analytics: A, spatialView: AE.computeSpatialView(A, MAD.DEFAULT_SPATIAL_FILTERS) });
    return m.header.scoreText === '0–0' &&
      m.header.scoreNote === '(goal chain, 0 attributed · X1 MANUAL-EMPTY)' &&
      m.header.totalEvents === 12 && m.header.locatedEvents === 6 &&
      arrEq(m.header.periodsPlayed, ['1H']);
  })(), '');

// ===========================================================================
// MA-M6 — Team summary & performance model (§13.4)
// ===========================================================================
section('MA-M6');

const M6_SESSION = oracleSession();
const M6_A = AE.computeMatchAnalytics(M6_SESSION);
const M6_MODEL = MAD.buildModel(M6_SESSION, stubHost(M6_SESSION.squad),
  { analytics: M6_A, spatialView: AE.computeSpatialView(M6_A, MAD.DEFAULT_SPATIAL_FILTERS) });
const M6_BASE = baseSession();
const M6_BASE_A = AE.computeMatchAnalytics(M6_BASE);
const M6_BASE_MODEL = MAD.buildModel(M6_BASE, stubHost(M6_BASE.squad),
  { analytics: M6_BASE_A, spatialView: AE.computeSpatialView(M6_BASE_A, MAD.DEFAULT_SPATIAL_FILTERS) });

ok('M6.1 l1Rows: 27 rows (26 L1_COUNT_ROWS + combined pass-subtype row)',
  M6_MODEL.team.l1Rows.length === 27 &&
  M6_MODEL.team.l1Rows[0].label === 'Goals' &&
  M6_MODEL.team.l1Rows[25].label === 'All events' &&
  M6_MODEL.team.l1Rows[26].label === 'Progressive / lateral / backward / long' &&
  M6_MODEL.team.l1Rows[26].our === '1/0/0/0' &&
  M6_MODEL.team.l1Rows[26].opponent === '0/0/0/0',
  'len=' + M6_MODEL.team.l1Rows.length);

ok('M6.2 l1 spot: Shots on target 1·0; the team-null Corner excluded (Corners 0·0); All events 13·5',
  (() => {
    const byLabel = {};
    M6_MODEL.team.l1Rows.forEach((r) => { byLabel[r.label] = r; });
    return byLabel['Shots on target'].our === 1 && byLabel['Shots on target'].opponent === 0 &&
      byLabel['Corners'].our === 0 && byLabel['Corners'].opponent === 0 &&
      byLabel['All events'].our === 13 && byLabel['All events'].opponent === 5;
  })(), '');

ok('M6.3 l2Rows: 10 rows; ratios with P5 null rendering',
  M6_MODEL.team.l2Rows.length === 10 &&
  M6_MODEL.team.l2Rows[0].label === 'Shot accuracy (on/(on+off))' &&
  M6_MODEL.team.l2Rows[0].our === '50%' && M6_MODEL.team.l2Rows[0].opponent === 'n/a' &&
  M6_MODEL.team.l2Rows[3].label === 'Pass success' &&
  M6_MODEL.team.l2Rows[3].our === '100%' && M6_MODEL.team.l2Rows[3].opponent === 'n/a',
  'len=' + M6_MODEL.team.l2Rows.length);

ok('M6.4 genuine zero ratio vs null: Press win ratio 0% (0 of 1); ball-winning 0; subtype profile + per-90',
  (() => {
    const byLabel = {};
    M6_MODEL.team.l2Rows.forEach((r) => { byLabel[r.label] = r; });
    return byLabel['Press win ratio'].our === '0%' &&
      byLabel['Press win ratio'].opponent === 'n/a' &&
      byLabel['Ball-winning events (rec+int)'].our === '0' &&
      byLabel['Pass subtype profile'].our === 'Progressive 100% · Lateral 0% · Backward 0% · Long 0%' &&
      byLabel['Pass subtype profile'].opponent === 'Progressive n/a · Lateral n/a · Backward n/a · Long n/a' &&
      byLabel['Per-90 (goals · shots · passes)'].our === '1 · 2 · 1' &&
      byLabel['Per-90 (goals · shots · passes)'].opponent === '1 · 0 · 0';
  })(), '');

ok('M6.5 possession (oracle): no tagged intervals → n/a share with NC-1 basis + reason',
  (() => {
    const po = M6_MODEL.team.possession;
    return po.intervalsOur === 0 && po.intervalsOpp === 0 &&
      po.durationOur === '0s' && po.meanOur === 'n/a' && po.endedOur === 'n/a' &&
      po.shareOur === 'n/a' && po.shareOpp === 'n/a' &&
      po.basis.indexOf('NC-1') !== -1 &&
      po.limitation.indexOf('NO_TAGGED_POSSESSION_INTERVALS') !== -1;
  })(), '');

ok('M6.6 possession (base): 1 tagged interval, 60s, ended by Shot, share n/a (OPPONENT_INTERVALS_UNTAGGED)',
  (() => {
    const po = M6_BASE_MODEL.team.possession;
    return po.intervalsOur === 1 && po.durationOur === '60s' &&
      po.meanOur === '60s' && po.endedOur === 'Shot 1' &&
      po.shareOur === 'n/a' &&
      po.limitation.indexOf('OPPONENT_INTERVALS_UNTAGGED') !== -1;
  })(), '');

ok('M6.7 outcomeRows (R1): 4 applicable labels; Press + Cross pins',
  M6_MODEL.team.outcomeRows.length === 4 &&
  arrEq(M6_MODEL.team.outcomeRows.map((r) => r.label.split(' outcome')[0]), ['Duel', 'Press', 'Turnover', 'Cross']) &&
  M6_MODEL.team.outcomeRows[1].our === '1 / 0 / 0' &&
  M6_MODEL.team.outcomeRows[1].rateOur === '100%' &&
  M6_MODEL.team.outcomeRows[3].our === '0 / 0 / 1' &&
  M6_MODEL.team.outcomeRows[3].rateOur === 'n/a' &&
  M6_BASE_MODEL.team.outcomeRows[1].our === '1 / 1 / 0' &&
  M6_BASE_MODEL.team.outcomeRows[1].rateOur === '50%',
  '');

ok('M6.8 scoreState + transitions (τ from the engine envelopes)',
  M6_MODEL.team.scoreState.changes === 2 &&
  M6_MODEL.team.scoreState.winning === '5260s' &&
  M6_MODEL.team.scoreState.drawing === '140s' &&
  M6_MODEL.team.scoreState.losing === '0s' &&
  arrEq(M6_MODEL.team.transitionRows.map((r) => r.label),
    ['Positive Transition → Shot (≤10s)', 'Positive Transition → Chance (≤10s)',
      'Positive Transition → Goal (≤10s)', 'Turnover → opponent Shot/Chance (≤15s)']) &&
  arrEq(M6_MODEL.team.transitionRows.map((r) => r.our), ['0%', '0%', '0%', 'n/a']) &&
  arrEq(M6_BASE_MODEL.team.transitionRows.map((r) => r.our), ['n/a', 'n/a', 'n/a', '0%']),
  JSON.stringify(M6_MODEL.team.transitionRows.map((r) => r.our)));

// ===========================================================================
// MA-M7 — Spatial analysis (§3/§13.6)
// ===========================================================================
section('MA-M7');

const M7_SESSION = oracleSession();
const M7_A = AE.computeMatchAnalytics(M7_SESSION);
const M7_VIEW = AE.computeSpatialView(M7_A, MAD.DEFAULT_SPATIAL_FILTERS);
const M7_R = renderSession(M7_SESSION, stubHost(M7_SESSION.squad));
const M7_WRAPS = Array.from(M7_R.root.querySelectorAll('.ma-grid-wrap'));

ok('M7.1 two grids (Us + Opponent) with engine-sourced heads',
  M7_WRAPS.length === 2 &&
  M7_WRAPS[0].getAttribute('data-grid-wrap') === 'grid:scope=all:partition=our' &&
  M7_WRAPS[1].getAttribute('data-grid-wrap') === 'grid:scope=all:partition=opponent' &&
  M7_WRAPS[0].querySelector('.ma-grid-head').textContent === 'All events — Us · 8/13 located events (61.5%)' &&
  M7_WRAPS[1].querySelector('.ma-grid-head').textContent === 'All events — Opponent · 3/5 located events (60%)',
  M7_WRAPS[0].querySelector('.ma-grid-head').textContent);

ok('M7.2 grid heads equal the independently computed engine view values',
  (() => {
    const g = M7_VIEW.grids[0];
    const expected = g.scopeLabel + ' — ' + g.partitionLabel + ' · ' + g.located + '/' +
      g.population + ' located events (' + g.locatedShare.value + '%)';
    const g2 = M7_VIEW.grids[1];
    const expected2 = g2.scopeLabel + ' — ' + g2.partitionLabel + ' · ' + g2.located + '/' +
      g2.population + ' located events (' + g2.locatedShare.value + '%)';
    return M7_WRAPS[0].querySelector('.ma-grid-head').textContent === expected &&
      M7_WRAPS[1].querySelector('.ma-grid-head').textContent === expected2;
  })(), '');

ok('M7.3 minimum-sample gate READ from the engine param (never hard-coded)',
  M7_R.model.minSampleForDensity === 6 &&
  M7_R.model.minSampleForDensity === M7_A.spatial.params.minSampleForDensity &&
  M7_A.spatial.params.minSampleForDensity === AE.MIN_SAMPLE_FOR_DENSITY,
  'minSample=' + M7_R.model.minSampleForDensity);

ok('M7.4 our grid (8 located ≥ 6): fills + printed counts + max line',
  (() => {
    const w = M7_WRAPS[0];
    const counts = qsaClass(w, 'ma-zcount').map((t) => t.textContent);
    return counts.length === 5 && arrEq(counts, ['1', '2', '2', '2', '1']) &&
      w.textContent.indexOf('max = 2 (busiest cell) — colour scale is relative to this grid') !== -1;
  })(), JSON.stringify(qsaClass(M7_WRAPS[0], 'ma-zcount').map((t) => t.textContent)));

ok('M7.5 our grid fills: discrete host-ramp steps (3 cells at step 4, 2 at step 2)',
  (() => {
    const styled = qsaClass(M7_WRAPS[0], 'ma-zcell').filter((c) => c.getAttribute('style'));
    const s4 = styled.filter((c) => c.getAttribute('style') === 'fill:rgba(216, 30, 46, 0.82);');
    const s2 = styled.filter((c) => c.getAttribute('style') === 'fill:rgba(216, 30, 46, 0.42);');
    return styled.length === 5 && s4.length === 3 && s2.length === 2;
  })(), '');

ok('M7.6 nine zone cells per grid, row-major data-zone keys, data-grid ids',
  (() => {
    const ZK = ['Defensive third · Left channel', 'Defensive third · Central channel', 'Defensive third · Right channel',
      'Middle third · Left channel', 'Middle third · Central channel', 'Middle third · Right channel',
      'Attacking third · Left channel', 'Attacking third · Central channel', 'Attacking third · Right channel'];
    return [0, 1].every((gi) => {
      const cells = qsaClass(M7_WRAPS[gi], 'ma-zcell');
      return cells.length === 9 &&
        arrEq(cells.map((c) => c.getAttribute('data-zone')), ZK) &&
        cells.every((c) => c.getAttribute('data-grid') === M7_WRAPS[gi].getAttribute('data-grid-wrap'));
    });
  })(), '');

ok('M7.7 host-only visuals: 4 an-zoneline zone lines + pitch markings per grid',
  [0, 1].every((gi) =>
    qsaClass(M7_WRAPS[gi], 'an-zoneline').length === 4 &&
    qsaClass(M7_WRAPS[gi], 'pitch-outline').length === 1),
  '');

ok('M7.8 event dots: 8 our (incl. 1 goal dot), 3 opponent; titles carry label + minute bin',
  (() => {
    const ourDots = qsaClass(M7_WRAPS[0], 'ma-dot');
    const oppDots = qsaClass(M7_WRAPS[1], 'ma-dot');
    const goalDots = qsaClass(M7_WRAPS[0], 'ma-dot-goal');
    const title = ourDots.length ? ourDots[0].querySelector('title').textContent : '';
    return ourDots.length === 8 && oppDots.length === 3 && goalDots.length === 1 &&
      /\d/.test(title) && title.indexOf('·') !== -1;
  })(), 'our=' + qsaClass(M7_WRAPS[0], 'ma-dot').length + ' opp=' + qsaClass(M7_WRAPS[1], 'ma-dot').length);

ok('M7.9 opponent grid (3 located < 6): null state with reason, NO fills, NO counts',
  (() => {
    const w = M7_WRAPS[1];
    const msg = w.querySelector('.ma-grid-insufficient');
    return !!msg &&
      msg.textContent === 'Insufficient located events for spatial visualization. (3 located events in this view — see the table below)' &&
      qsaClass(w, 'ma-zcell').filter((c) => c.getAttribute('style')).length === 0 &&
      qsaClass(w, 'ma-zcount').length === 0;
  })(), '');

ok('M7.10 numeric tables render for BOTH grids (10 zone rows, engine L3 keys) + unlocated strips',
  (() => {
    const tOur = M7_R.root.querySelector('table[data-grid-table="grid:scope=all:partition=our"]');
    const tOpp = M7_R.root.querySelector('table[data-grid-table="grid:scope=all:partition=opponent"]');
    const rowsOur = tOur ? tableRows(tOur) : [];
    const rowsOpp = tOpp ? tableRows(tOpp) : [];
    const attL = rowsOur.find((tr) => tr.cells[0].textContent === 'Attacking third · Left channel');
    const unlocOur = rowsOur.find((tr) => tr.cells[0].textContent === 'Unlocated');
    const unlocOpp = rowsOpp.find((tr) => tr.cells[0].textContent === 'Unlocated');
    return rowsOur.length === 10 && rowsOpp.length === 10 &&
      tOur.querySelectorAll('thead th').length === 20 &&
      attL && attL.cells[1].textContent === '2' &&
      unlocOur && unlocOur.cells[1].textContent === '5' &&
      unlocOpp && unlocOpp.cells[1].textContent === '2' &&
      M7_WRAPS[0].textContent.indexOf('Unlocated: 5 — not shown on the pitch.') !== -1 &&
      M7_WRAPS[1].textContent.indexOf('Unlocated: 2 — not shown on the pitch.') !== -1;
  })(), '');

// ===========================================================================
// MA-M8 — Purity (§8)
// ===========================================================================
section('MA-M8');

ok('M8.1 the oracle session snapshot is never mutated by a full render',
  (() => {
    const sess = oracleSession();
    const before = JSON.stringify(sess);
    renderSession(sess, stubHost(sess.squad));
    return JSON.stringify(sess) === before;
  })(), '');

ok('M8.2 the scrambled source array order is preserved (sort happens on a copy)',
  (() => {
    const sess = oracleSession();
    renderSession(sess, stubHost(sess.squad));
    return sess.events[12].id === 14 && sess.events[13].id === 13;
  })(), '');

ok('M8.3 matchInfo, matchClock and squad untouched',
  (() => {
    const sess = oracleSession();
    const beforeMI = JSON.stringify(sess.matchInfo);
    const beforeMC = JSON.stringify(sess.matchClock);
    const beforeSQ = JSON.stringify(sess.squad);
    MAD.buildModel(sess, stubHost(sess.squad));
    return JSON.stringify(sess.matchInfo) === beforeMI &&
      JSON.stringify(sess.matchClock) === beforeMC &&
      JSON.stringify(sess.squad) === beforeSQ;
  })(), '');

ok('M8.4 keyEvents rows are a NEW array holding the ORIGINAL event objects (read-only refs)',
  (() => {
    const sess = oracleSession();
    const m = MAD.buildModel(sess, stubHost(sess.squad));
    return m.keyEvents.rows !== sess.events &&
      m.keyEvents.rows.length === 17 &&
      m.keyEvents.rows[0].event === sess.events[0];
  })(), '');

ok('M8.5 the base session snapshot is never mutated either',
  (() => {
    const sess = baseSession();
    const before = JSON.stringify(sess);
    renderSession(sess, stubHost(sess.squad));
    return JSON.stringify(sess) === before;
  })(), '');

// ===========================================================================
// MA-M9 — Period analysis & sequences models (§13.5/§13.8)
// ===========================================================================
section('MA-M9');

const M9_SESSION = oracleSession();
const M9_A = AE.computeMatchAnalytics(M9_SESSION);
const M9_MODEL = MAD.buildModel(M9_SESSION, stubHost(M9_SESSION.squad),
  { analytics: M9_A, spatialView: AE.computeSpatialView(M9_A, MAD.DEFAULT_SPATIAL_FILTERS) });

ok('M9.1 periodRows: only non-zero periods (1H, 2H); zero periods skipped',
  arrEq(M9_MODEL.periods.periodRows.map((r) => r.period), ['1H', '2H']),
  JSON.stringify(M9_MODEL.periods.periodRows.map((r) => r.period)));

ok('M9.2 every periodRow bucket count equals A.level3.byPeriod exactly (all 19 keys)',
  M9_MODEL.periods.periodRows.every((r) => {
    const eng = M9_A.level3.byPeriod[r.period].counts;
    return Object.keys(eng).every((k) => r.counts[k] === eng[k]);
  }), '');

ok('M9.3 stoppage sourced from the engine stoppage buckets (1H: 1, 2H: 0)',
  M9_MODEL.periods.periodRows[0].stoppage === 1 &&
  M9_MODEL.periods.periodRows[1].stoppage === 0 &&
  M9_A.level3.byPeriod['1H'].stoppage.events === 1 &&
  M9_A.level3.byPeriod['2H'].stoppage.events === 0,
  '');

ok('M9.4 binRows: the six non-zero minute bins with engine-equal event counts',
  (() => {
    const bins = M9_MODEL.periods.binRows;
    return bins.length === 6 &&
      arrEq(bins.map((b) => b.bin),
        ['1H 0-15', '1H 15-30', '1H 30-45+', '2H 45-60', '2H 60-75', '2H 75-90+']) &&
      arrEq(bins.map((b) => b.counts.events), [3, 4, 1, 3, 4, 4]) &&
      bins.every((b) => b.counts.events === M9_A.level3.byMinuteBin[b.bin].events);
  })(), JSON.stringify(M9_MODEL.periods.binRows.map((b) => b.counts.events)));

ok('M9.5 cellKeys sourced from the engine spatial contract model (19 L3 keys)',
  arrEq(M9_MODEL.periods.cellKeys, M9_A.spatial.model.cellKeys) &&
  M9_MODEL.periods.cellKeys.length === 19 &&
  M9_MODEL.periods.cellKeys[0] === 'events',
  'len=' + M9_MODEL.periods.cellKeys.length);

ok('M9.6 sequences model equals A.sequences (totals + both rows)',
  (() => {
    const s = M9_MODEL.sequences;
    const e = M9_A.sequences;
    return s.total === 2 && e.total === 2 &&
      s.withTransition === 0 && s.meanEventCount === '1.5' &&
      s.meanDurationSeconds === '0s' && s.spanningCount === 1 &&
      s.rows.length === 2 &&
      s.rows[0].sequenceId === 'SEQ-001' && s.rows[0].team === 'our' &&
      s.rows[0].eventCount === 2 && s.rows[0].firstTime === 40 &&
      s.rows[0].lastTime === 4900 && s.rows[0].duration === 4860 &&
      s.rows[0].spansPeriods === true && s.rows[0].containsTransition === false &&
      s.rows[1].sequenceId === 'SEQ-002' && s.rows[1].team === 'opponent' &&
      s.rows[1].eventCount === 1 && s.rows[1].duration === 0 &&
      s.rows[1].spansPeriods === false;
  })(), '');

// ===========================================================================
// MA-M10 — Lexical & structural scan (§2/§8/§12)
// ===========================================================================
section('MA-M10');

const M10_SRC = strippedSource();

ok('M10.1 zero console.* calls in the module source (§8)',
  !/console\s*\./.test(M10_SRC), '');

ok('M10.2 no programmatic .click( anywhere in the source (D2 law, §8)',
  !/\.click\s*\(/.test(M10_SRC), '');

ok('M10.3 no stopPropagation anywhere in the source (§8)',
  !/stopPropagation/.test(M10_SRC), '');

ok('M10.4 no renderer window globals read; document only in the ownerDocument fallback',
  !/window\s*\./.test(M10_SRC) &&
  (M10_SRC.match(/\bdocument\b/g) || []).length === 1,
  'document occurrences=' + (M10_SRC.match(/\bdocument\b/g) || []).length);

ok('M10.5 no duplicated renderer constants (zone lines / density ramp defined only in the host)',
  M10_SRC.indexOf('ZONE_LINES_SVG') === -1 &&
  M10_SRC.indexOf('DENSITY_FILLS') === -1 &&
  M10_SRC.indexOf('rgba(216') === -1,
  '');

ok('M10.6 NC-1 naming law: the forbidden "Possession %" label never appears in code',
  M10_SRC.indexOf('Possession %') === -1 && M10_SRC.indexOf('possession %') === -1, '');

ok('M10.7 §12.3 used-but-unstyled class hooks present in the markup (ma-card-our, ma-trace-label)',
  (() => {
    const r = renderSession(oracleSession(), stubHost(oracleSession().squad));
    const cell = qsaClass(r.root, 'ma-zcell').find((c) =>
      c.getAttribute('data-grid') === 'grid:scope=all:partition=our' &&
      c.getAttribute('data-zone') === 'Attacking third · Central channel');
    cell.dispatchEvent(new r.win.MouseEvent('click', { bubbles: true, cancelable: true }));
    // Read the LIVE markup (the trace rows are injected by the activation).
    const live = r.root.innerHTML;
    return live.indexOf('ma-card-our') !== -1 &&
      live.indexOf('ma-trace-label') !== -1;
  })(), '');

ok('M10.8 structural laws: 9 sections in §13 order; players framing "no per-90"; no key-list counter',
  (() => {
    const r = renderSession(oracleSession(), stubHost(oracleSession().squad));
    const sections = Array.from(r.root.querySelectorAll('section[data-ma-section]'))
      .map((s) => s.getAttribute('data-ma-section'));
    const keySec = r.root.querySelector('section[data-ma-section="key-events"]');
    const playersTitle = r.root.querySelector('section[data-ma-section="players"] .ma-section-title');
    return arrEq(sections, ['header', 'cards', 'key-events', 'team', 'periods',
      'spatial', 'players', 'sequences', 'protocol']) &&
      keySec.querySelectorAll(':scope > *').length === 2 &&
      playersTitle && playersTitle.textContent.indexOf('no per-90') !== -1;
  })(), '');

// ===========================================================================
// MA-M11 — THE CORRECTIVE-ROUND SECTION (spec §10 — EXACTLY 18 assertions)
//   exactly-N aggregates · envelope-source proof · 10-card render ·
//   list rows/counts/order · seek inputs & rendered attributes ·
//   zero case on both surfaces
// ===========================================================================
section('MA-M11');

const M11_SESSION = oracleSession();
const M11_A = AE.computeMatchAnalytics(M11_SESSION);
const M11_HOST = stubHost(M11_SESSION.squad);
const M11_R = renderSession(M11_SESSION, M11_HOST);
const M11_ROWS = keyRowsOf(M11_R.root);
const M11_CARDS = cardsOf(M11_R.root);

ok('M11.1 exactly-N: 19 events in, 17 key rows out',
  M11_SESSION.events.length === 19 && M11_ROWS.length === 17,
  'rows=' + M11_ROWS.length);

ok('M11.2 exactly-N-out: the 2 non-qualifying events (Pass, Press) are not listed',
  M11_ROWS.every((row) => ['Pass', 'Press'].indexOf(row.getAttribute('data-label')) === -1) &&
  M11_SESSION.events.filter((e) => e.label === 'Pass' || e.label === 'Press').length === 2,
  '');

ok('M11.3 Substitutions card = 2 · 1 (2 our + 1 opponent Sub events)',
  cardValueText(M11_CARDS.find((c) => c.getAttribute('data-card') === 'substitutions')) === '2 · 1',
  cardValueText(M11_CARDS.find((c) => c.getAttribute('data-card') === 'substitutions')));

ok('M11.4 Positive transitions card = 3 · 1 (3 our + 1 opponent PT events)',
  cardValueText(M11_CARDS.find((c) => c.getAttribute('data-card') === 'positiveTransitions')) === '3 · 1',
  cardValueText(M11_CARDS.find((c) => c.getAttribute('data-card') === 'positiveTransitions')));

ok('M11.5 the card strip renders EXACTLY 10 cards (§4)',
  M11_CARDS.length === 10, 'cards=' + M11_CARDS.length);

ok('M11.6 card order = KEY_COUNT_FIELDS order (data-card sequence)',
  arrEq(M11_CARDS.map((c) => c.getAttribute('data-card')), MAD.KEY_COUNT_FIELDS),
  JSON.stringify(M11_CARDS.map((c) => c.getAttribute('data-card'))));

ok('M11.7 card labels = the sentence-case CARD_LABELS, in order',
  arrEq(M11_CARDS.map((c) => c.querySelector('.ma-card-label').textContent), MAD.CARD_LABELS),
  '');

ok('M11.8 envelope-source proof: cards follow DOCTORED L1 envelopes, not the event list',
  (() => {
    const pre = {
      analytics: JSON.parse(JSON.stringify(M11_A)),
      spatialView: AE.computeSpatialView(M11_A, MAD.DEFAULT_SPATIAL_FILTERS)
    };
    pre.analytics.level1.team.our.substitutions = { value: 7, excluded: {} };
    pre.analytics.level1.team.opponent.substitutions = { value: 5, excluded: {} };
    pre.analytics.level1.team.our.positiveTransitions = { value: 9, excluded: {} };
    pre.analytics.level1.team.opponent.positiveTransitions = { value: 9, excluded: {} };
    pre.analytics.level1.team.our.goals = { value: 4, excluded: {} };
    pre.analytics.level1.team.opponent.goals = { value: 4, excluded: {} };
    const m = MAD.buildModel(M11_SESSION, stubHost(M11_SESSION.squad), pre);
    const byKey = {};
    m.cards.forEach((c) => { byKey[c.key] = c; });
    // The list is still built from the RAW session (3 Sub rows) while the
    // cards show the envelope numbers — proving envelope sourcing.
    return byKey.substitutions.our === 7 && byKey.substitutions.opponent === 5 &&
      byKey.positiveTransitions.our === 9 && byKey.positiveTransitions.opponent === 9 &&
      byKey.goals.our === 4 && byKey.goals.opponent === 4 &&
      m.keyEvents.rows.length === 17;
  })(), '');

ok('M11.9 envelope-source proof: cards equal the REAL engine envelope values (all 10)',
  (() => {
    const m = M11_R.model;
    return MAD.KEY_COUNT_FIELDS.every((f, i) =>
      m.cards[i].key === f &&
      m.cards[i].our === M11_A.level1.team.our[f].value &&
      m.cards[i].opponent === M11_A.level1.team.opponent[f].value);
  })(), '');

ok('M11.10 list order = canonical (time asc, id asc) — incl. the 13/14 id tiebreak',
  arrEq(M11_ROWS.map((r) => r.getAttribute('data-event-id')),
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15', '16', '19']),
  JSON.stringify(M11_ROWS.map((r) => r.getAttribute('data-event-id'))));

ok('M11.11 display labels: Sub → "Substitution"; Positive Transition verbatim',
  (() => {
    return M11_ROWS.every((r) => {
      const raw = r.getAttribute('data-label');
      const disp = r.querySelector('.ma-key-label').textContent;
      if (raw === 'Sub') return disp === 'Substitution';
      if (raw === 'Positive Transition') return disp === 'Positive Transition';
      return disp === raw;
    }) &&
    M11_ROWS.filter((r) => r.getAttribute('data-label') === 'Sub').length === 3 &&
    M11_ROWS.filter((r) => r.getAttribute('data-label') === 'Positive Transition').length === 4;
  })(), '');

ok('M11.12 seek input 240: activating row 2 seeks videoTime 240 (time is 245)',
  (() => {
    const row = M11_R.root.querySelector('button.ma-key-row[data-event-id="2"]');
    row.dispatchEvent(new M11_R.win.MouseEvent('click', { bubbles: true, cancelable: true }));
    return M11_HOST.seekLog[M11_HOST.seekLog.length - 1] === 240;
  })(), JSON.stringify(M11_HOST.seekLog));

ok('M11.13 seek fallback: row 6 (videoTime null) seeks time 1350 (?? fallback)',
  (() => {
    const row = M11_R.root.querySelector('button.ma-key-row[data-event-id="6"]');
    row.dispatchEvent(new M11_R.win.MouseEvent('click', { bubbles: true, cancelable: true }));
    return M11_HOST.seekLog[M11_HOST.seekLog.length - 1] === 1350;
  })(), JSON.stringify(M11_HOST.seekLog));

ok('M11.14 seek input 140: row 12 (videoTime 140, time 3700) seeks 140',
  (() => {
    const row = M11_R.root.querySelector('button.ma-key-row[data-event-id="12"]');
    row.dispatchEvent(new M11_R.win.MouseEvent('click', { bubbles: true, cancelable: true }));
    return M11_HOST.seekLog[M11_HOST.seekLog.length - 1] === 140;
  })(), JSON.stringify(M11_HOST.seekLog));

ok('M11.15 rendered seek attributes: data-videotime / data-time (§5)',
  (() => {
    const r2 = M11_R.root.querySelector('button.ma-key-row[data-event-id="2"]');
    const r6 = M11_R.root.querySelector('button.ma-key-row[data-event-id="6"]');
    const r12 = M11_R.root.querySelector('button.ma-key-row[data-event-id="12"]');
    return r2.getAttribute('data-videotime') === '240' &&
      r2.getAttribute('data-time') === '245' &&
      r6.getAttribute('data-videotime') === '' &&
      r6.getAttribute('data-time') === '1350' &&
      r12.getAttribute('data-videotime') === '140' &&
      r12.getAttribute('data-time') === '3700' &&
      r2.querySelector('.ma-key-time').textContent === '245s';
  })(), '');

ok('M11.16 zero case (cards): base session Substitutions AND Positive transitions = 0 · 0',
  (() => {
    const rb = renderSession(baseSession(), stubHost(baseSession().squad));
    const cb = cardsOf(rb.root);
    return cardValueText(cb.find((c) => c.getAttribute('data-card') === 'substitutions')) === '0 · 0' &&
      cardValueText(cb.find((c) => c.getAttribute('data-card') === 'positiveTransitions')) === '0 · 0';
  })(), '');

ok('M11.17 zero case (cards): ALL ten base cards render plain 0 · 0 (§4 zero law)',
  (() => {
    const rb = renderSession(baseSession(), stubHost(baseSession().squad));
    return cardsOf(rb.root).length === 10 &&
      cardsOf(rb.root).every((c) => cardValueText(c) === '0 · 0');
  })(), '');

ok('M11.18 zero case (list): base empty state ENUMERATES the qualifying classes (§5)',
  (() => {
    const rb = renderSession(baseSession(), stubHost(baseSession().squad));
    const el = rb.root.querySelector('.ma-key-empty');
    return !!el && el.textContent === 'No qualifying key events. The list shows: Goal, Shot, Chance, Cross, Corner, Foul, Card, Substitution, Positive Transition.';
  })(), '');

// ===========================================================================
// MA-M12 — Section inventory & sourcing (§13) + exact-string RATIO pin
// ===========================================================================
section('MA-M12');

const M12_SESSION = oracleSession();
const M12_A = AE.computeMatchAnalytics(M12_SESSION);
const M12_R = renderSession(M12_SESSION, stubHost(M12_SESSION.squad));

ok('M12.1 §13 section inventory: all nine sections render in the authoritative order',
  arrEq(Array.from(M12_R.root.querySelectorAll('section[data-ma-section]'))
    .map((s) => s.getAttribute('data-ma-section')),
    ['header', 'cards', 'key-events', 'team', 'periods', 'spatial', 'players', 'sequences', 'protocol']),
  '');

ok('M12.2 §13.1 sourcing: header values equal session.matchInfo + A.matchSummary',
  (() => {
    const r = M12_R.root;
    const meta = r.querySelector('.ma-meta').textContent;
    const score = r.querySelector('.ma-score-value').textContent;
    const facts = r.querySelector('.ma-facts').textContent;
    const S = M12_A.matchSummary;
    return meta === 'Bahir Dar Premier League · Home · vs Dashen Beer FC · 2026-10-03 · 4-3-3 · Bahir Dar Stadium' &&
      meta.indexOf(S.opponent) !== -1 &&
      score === S.score.chain.for + '–' + S.score.chain.against &&
      facts === S.totalEvents + ' events used · ' + S.locatedEvents + ' located · periods ' +
      S.periodsPlayed.join(', ') + ' · nominal ' + S.durationMinutes + '′';
  })(), '');

ok('M12.3 every L1_COUNT_ROWS field is a REAL engine envelope field (one wrong name FAILs)',
  (() => {
    const block = constBlock('L1_COUNT_ROWS');
    if (!block) return false;
    const pairs = [];
    let m; const re = /\[\s*'([^']*)'\s*,\s*'([^']*)'\s*\]/g;
    while ((m = re.exec(block))) pairs.push([m[1], m[2]]);
    const missing = [];
    pairs.forEach((p) => {
      ['our', 'opponent'].forEach((side) => {
        const env = M12_A.level1.team[side][p[1]];
        if (!env || typeof env.value !== 'number') missing.push(p[1] + ':' + side);
      });
    });
    ['progressivePasses', 'lateralPasses', 'backwardPasses', 'longPasses'].forEach((f) => {
      ['our', 'opponent'].forEach((side) => {
        const env = M12_A.level1.team[side][f];
        if (!env || typeof env.value !== 'number') missing.push(f + ':' + side);
      });
    });
    return pairs.length === 26 && missing.length === 0;
  })(), 'pairs=' + ((constBlock('L1_COUNT_ROWS') || '').match(/\[\s*'[^']*'\s*,\s*'[^']*'\s*\]/g) || []).length + ' missing=' + (function () {
    const b = constBlock('L1_COUNT_ROWS') || '';
    const pairs = []; let m; const re = /\[\s*'([^']*)'\s*,\s*'([^']*)'\s*\]/g;
    while ((m = re.exec(b))) pairs.push(m[2]);
    return pairs.filter((f) => !M12_A.level1.team.our[f]).length;
  })());

ok('M12.4 §13.4 L1 sourcing: every rendered cell equals the engine envelope value (26 rows + combined)',
  (() => {
    const tables = teamTables(M12_R.root);
    if (tables.length < 2) return false;
    const rows = tableRows(tables[0]);
    const block = constBlock('L1_COUNT_ROWS');
    const pairs = [];
    let m; const re = /\[\s*'([^']*)'\s*,\s*'([^']*)'\s*\]/g;
    while ((m = re.exec(block))) pairs.push([m[1], m[2]]);
    const bad = [];
    pairs.forEach((p) => {
      const tr = findRowByLabel(rows, p[0]);
      if (!tr) { bad.push('missing row ' + p[0]); return; }
      if (tr.cells[1].textContent !== String(M12_A.level1.team.our[p[1]].value)) bad.push(p[0] + ':our');
      if (tr.cells[2].textContent !== String(M12_A.level1.team.opponent[p[1]].value)) bad.push(p[0] + ':opp');
    });
    const combined = findRowByLabel(rows, 'Progressive / lateral / backward / long');
    if (!combined || combined.cells[1].textContent !== '1/0/0/0' ||
      combined.cells[2].textContent !== '0/0/0/0') bad.push('combined');
    return rows.length === 27 && bad.length === 0;
  })(), '');

ok('M12.5 §13.4 unattributed note: sourced from the L1 unattributed envelope (X2 surface)',
  (() => {
    const sec = M12_R.root.querySelector('section[data-ma-section="team"]');
    const note = Array.from(sec.querySelectorAll('.ma-note'))
      .find((n) => n.textContent.indexOf('Unattributed (no team)') !== -1);
    return !!note &&
      note.textContent === 'Unattributed (no team): 1 events — excluded from both columns.' &&
      M12_A.level1.team.unattributed.events.value === 1 &&
      M12_A.gates.X2_unattributedEvents.total === 1;
  })(), '');

ok('M12.6 every L2_DERIVED_ROWS field path is REAL on both team partitions',
  (() => {
    const block = constBlock('L2_DERIVED_ROWS');
    if (!block) return false;
    const triples = [];
    let m; const re = /\[\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*\]/g;
    while ((m = re.exec(block))) triples.push([m[1], m[2], m[3]]);
    const bad = [];
    triples.forEach((t) => {
      ['our', 'opponent'].forEach((side) => {
        const env = readPathTest(M12_A.level2.team[side], t[1]);
        if (!env || typeof env !== 'object' || !('value' in env)) bad.push(t[1] + ':' + side);
      });
    });
    return triples.length === 8 && bad.length === 0;
  })(), '');

ok('M12.7 RIDER (engine side): passSuccess is a percentage — 66.7 from 2/3, not the raw fraction',
  (() => {
    const rs = ratioSession();
    const A = AE.computeMatchAnalytics(rs);
    const env = A.level2.team.our.passSuccess;
    return env.num === 2 && env.den === 3 &&
      env.value === 66.7 &&
      env.value !== env.num / env.den;
  })(), '');

ok('M12.8 RIDER (exact string): "Pass success" cell renders exactly 66.7% · n/a',
  (() => {
    const rs = ratioSession();
    const A = AE.computeMatchAnalytics(rs);
    const r = renderSession(rs, stubHost(rs.squad));
    const tables = teamTables(r.root);
    const rows = tableRows(tables[1]);
    const tr = findRowByLabel(rows, 'Pass success');
    if (!tr) return false;
    const ourCell = tr.cells[1].textContent;
    const oppCell = tr.cells[2].textContent;
    return ourCell === '66.7%' &&
      ourCell === String(A.level2.team.our.passSuccess.value) + '%' &&
      oppCell === 'n/a' &&
      A.level2.team.opponent.passSuccess.value === null &&
      ourCell.indexOf('0.667') === -1 &&
      ourCell !== String(A.level2.team.our.passSuccess.num / A.level2.team.our.passSuccess.den);
  })(), '');

ok('M12.9 RIDER (player surface): the player Pass success cell renders exactly 66.7%',
  (() => {
    const rs = ratioSession();
    const A = AE.computeMatchAnalytics(rs);
    const r = renderSession(rs, stubHost(rs.squad));
    const table = r.root.querySelector('table[data-ma-table="players"]');
    const tr = table.querySelector('tr[data-player-id="player_1"]');
    const headers = Array.from(table.querySelectorAll('thead th')).map((th) => th.textContent);
    const colIdx = headers.indexOf('Pass success');
    if (!tr || colIdx === -1) return false;
    const cell = tr.cells[colIdx].textContent;
    const penv = A.players.list[0].metrics.passSuccess;
    return cell === '66.7%' &&
      cell === String(penv.value) + '%' &&
      penv.num === 2 && penv.den === 3;
  })(), '');

ok('M12.10 §13.5 sourcing: byPeriod table — every cell equals A.level3.byPeriod; stoppage marker',
  (() => {
    const table = M12_R.root.querySelector('table[data-ma-table="byPeriod"]');
    const rows = tableRows(table);
    const keys = M12_A.spatial.model.cellKeys;
    const bad = [];
    rows.forEach((tr) => {
      const p = tr.getAttribute('data-period');
      const eng = M12_A.level3.byPeriod[p];
      keys.forEach((k, i) => {
        if (tr.cells[1 + i].textContent !== String(eng.counts[k])) bad.push(p + ':' + k);
      });
    });
    const r1h = rows.find((tr) => tr.getAttribute('data-period') === '1H');
    const r2h = rows.find((tr) => tr.getAttribute('data-period') === '2H');
    return rows.length === 2 && bad.length === 0 &&
      r1h.textContent.indexOf('(+1 stoppage)') !== -1 &&
      r2h.textContent.indexOf('stoppage') === -1;
  })(), '');

ok('M12.11 §13.5 sourcing: byMinuteBin table — 6 non-zero bins, every cell engine-equal, 19-key header',
  (() => {
    const table = M12_R.root.querySelector('table[data-ma-table="byMinuteBin"]');
    const rows = tableRows(table);
    const keys = M12_A.spatial.model.cellKeys;
    const bad = [];
    rows.forEach((tr) => {
      const b = tr.getAttribute('data-bin');
      keys.forEach((k, i) => {
        if (tr.cells[1 + i].textContent !== String(M12_A.level3.byMinuteBin[b][k])) bad.push(b + ':' + k);
      });
    });
    return rows.length === 6 && bad.length === 0 &&
      table.querySelectorAll('thead th').length === 20 &&
      rows.every((tr) => M12_A.level3.byMinuteBin[tr.getAttribute('data-bin')].events > 0);
  })(), '');

ok('M12.12 §13.7 sourcing: players table = A.players.list (order, ids, cells)',
  (() => {
    const table = M12_R.root.querySelector('table[data-ma-table="players"]');
    const rows = tableRows(table);
    const ids = rows.map((tr) => tr.getAttribute('data-player-id'));
    const engineIds = M12_A.players.list.map((p) => p.playerId);
    if (!arrEq(ids, engineIds)) return false;
    // PLAYER_COLS header -> [metrics field, kind] (Events is a row field).
    const H2F = {
      'Events': ['events', 'count'], 'Goals': ['goals', 'count'],
      'Shots': ['shots', 'count'], 'On target': ['shotsOnTarget', 'count'],
      'Chances': ['chances', 'count'], 'Key passes': ['keyPasses', 'count'],
      'Crosses': ['crosses', 'count'], 'Passes': ['passes', 'count'],
      'Pass success': ['passSuccess', 'ratio'], 'Presses': ['presses', 'count'],
      'Press wins': ['pressWins', 'count'], 'Interceptions': ['interceptions', 'count'],
      'Recoveries': ['recoveries', 'count'], 'Turnovers': ['turnovers', 'count'],
      'Duels': ['duels', 'count'], 'Fouls': ['fouls', 'count'],
      'Yellow': ['yellowCards', 'count'], 'Red': ['redCards', 'count'],
      'Positive': ['positiveEvents', 'count'], 'Negative': ['negativeEvents', 'count'],
      'Sub on': ['subOn', 'count'], 'Sub off': ['subOff', 'count']
    };
    const headers = Array.from(table.querySelectorAll('thead th')).map((th) => th.textContent);
    const p2 = M12_A.players.list.find((p) => p.playerId === 'player_2');
    const tr2 = rows.find((tr) => tr.getAttribute('data-player-id') === 'player_2');
    const bad = [];
    headers.slice(1).forEach((h, i) => {
      const spec = H2F[h];
      if (!spec) { bad.push('unknown header ' + h); return; }
      const raw = spec[0] === 'events' ? p2.events : p2.metrics[spec[0]];
      const expected = spec[1] === 'ratio' ? ratioTextTest(raw) : String(raw);
      if (tr2.cells[1 + i].textContent !== expected) bad.push(h);
    });
    const tr1 = rows.find((tr) => tr.getAttribute('data-player-id') === 'player_1');
    return rows.length === 9 && bad.length === 0 &&
      tr1.cells[headers.indexOf('Pass success')].textContent === '100%' &&
      tr1.cells[headers.indexOf('Goals')].textContent === '1';
  })(), '');

ok('M12.13 §13.7 sourcing: unattributed-players note equals the engine byLabel',
  (() => {
    const sec = M12_R.root.querySelector('section[data-ma-section="players"]');
    const note = Array.from(sec.querySelectorAll('.ma-note'))
      .find((n) => n.textContent.indexOf('no player attributed') !== -1);
    return !!note &&
      note.textContent === '8 events have no player attributed (Goal 1, Foul 1, Card 1, Corner 1, Positive Transition 4).' &&
      M12_A.players.unattributed.events === 8;
  })(), '');

ok('M12.14 §13.8 + §13.9 sourcing: sequences rows and protocol notes equal the engine',
  (() => {
    const st = M12_R.root.querySelector('table[data-ma-table="sequences"]');
    const rows = tableRows(st);
    const s = M12_A.sequences;
    const seq1 = rows.find((tr) => tr.getAttribute('data-sequence-id') === 'SEQ-001');
    const seq2 = rows.find((tr) => tr.getAttribute('data-sequence-id') === 'SEQ-002');
    const seqOk = !!seq1 && !!seq2 && rows.length === 2 &&
      seq1.cells[0].textContent === 'SEQ-001' && seq1.cells[1].textContent === 'Us' &&
      seq1.cells[2].textContent === String(s.list[0].eventCount) &&
      seq1.cells[3].textContent === s.list[0].firstTime + 's' &&
      seq1.cells[4].textContent === s.list[0].lastTime + 's' &&
      seq1.cells[5].textContent === s.list[0].duration + 's' &&
      seq1.cells[6].textContent === 'No' && seq1.cells[7].textContent === 'Yes' &&
      seq2.cells[1].textContent === 'Opponent' && seq2.cells[7].textContent === 'No';
    const lis = Array.from(M12_R.root.querySelectorAll('ul.ma-protocol-notes li'));
    const engineLine = M12_R.root.querySelector('.ma-engine');
    const protoOk = lis.length === M12_A.protocol.notes.length && lis.length === 8 &&
      lis[0].textContent === M12_A.protocol.notes[0] &&
      lis[7].textContent === M12_A.protocol.notes[7] &&
      lis[0].textContent === 'TAGGED_UNIVERSE: every metric counts TAGGED events only; completeness is reported, never extrapolated' &&
      !!engineLine &&
      engineLine.textContent === M12_A.spec + ' · engine v' + M12_A.engine.version + ' · deterministic' &&
      engineLine.textContent === 'PitchLog-METRIC-SPEC-v1.0 · engine v1.2.0 · deterministic';
    return seqOk && protoOk;
  })(), '');

// ---------------------------------------------------------------------------
// Epilogue — suite structural law (spec §10)
// ---------------------------------------------------------------------------
section('MA-STRUCTURE');

ok('STRUCTURE.1 MA-M11 emits exactly 18 assertions (spec §10 law)',
  sectionCounts['MA-M11'] === 18,
  'count=' + (sectionCounts['MA-M11'] || 0));

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
const passed = results.filter((r) => r.pass).length;
const failed = results.filter((r) => !r.pass);
console.log('');
failed.forEach((r) => {
  console.log('FAIL ' + r.id + (r.detail ? '  [' + r.detail + ']' : ''));
});
console.log('MATCH-ANALYSIS MODEL SUITE: ' + passed + '/' + results.length + ' checks passed' +
  (failed.length ? ' — ' + failed.length + ' FAILED' : ''));
if (failed.length) process.exitCode = 1;
