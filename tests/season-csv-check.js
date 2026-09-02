// PitchLog — Season Player CSV Export V1 check (PSD-V2, Phase E)
//
// Verifies the PSD-V2 season player×match CSV export (doc:
// docs/player-season-data-specification.md §8.2 PSD-V2, §8.4 PSD-N,
// §8.5 PSD-V4). NOT a re-test of the Player & Season Core or Recent Form
// engines — those are tests/player-season-tests.js / recent-form-tests.js.
// This suite verifies the EXPORT LAYER ONLY:
//
//   SC-T1  module loads (src/season-csv.js) with spec id + COLUMNS export
//   SC-T2  exact 63-column order/names (module COLUMNS == spec §8.2 list ==
//          rendered header row)
//   SC-T3  forbidden header/output terminology absent (PSD-N §8.4)
//   SC-T4  row structure: one row per player×match + one SEASON_SUMMARY row
//          per player, deterministic ordering
//   SC-T5  hand-computed oracles (counts, minutes, percentages, statuses)
//   SC-T6  null discipline: unavailable values are EMPTY cells, never 0
//   SC-T7  precision: 1-decimal half-up on minutes/percentage cells
//   SC-T8  booleans rendered TRUE/FALSE (uppercase)
//   SC-T9  X1 MISMATCH match: state partitions suppressed with reason cell
//   SC-T10 determinism: byte-identical output on recompute
//   SC-T11 immutability: PS deep-unchanged by export
//   SC-T12 csvEscape behavior-identical to renderer (comma/quote/newline)
//   SC-T13 mapping fidelity: every metric/spatial/period/state/zone cell
//          equals the PS record value (no recomputation, no transposition)
//   SC-T14 UI wiring (jsdom): script order, new export button, click exports
//          the player CSV via window.matchtag.exportCsv, legacy event-dump
//          button byte-unchanged, engine-absent graceful no-op
//
// Pure part mirrors tests/recent-form-tests.js conventions (fixtures are
// real saved sessions fed through the ACTUAL Player & Season Core).
// Run:  node tests/season-csv-check.js   (from the pitchlog root)

'use strict';

const path = require('path');
const fs = require('fs');

const PSE = require(path.join(__dirname, '..', 'src', 'player-season.js'));

// Test-first: the export module may not exist yet — every check then FAILS.
let SC = null;
try { SC = require(path.join(__dirname, '..', 'src', 'season-csv.js')); } catch (e) { SC = null; }

let pass = 0, fail = 0, failures = [];
function ok(label, cond, detail) {
  if (cond) { pass++; }
  else { fail++; failures.push(label + (detail ? ' — ' + detail : '')); }
}
function eq(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  ok(label, a === e, 'actual=' + a + ' expected=' + e);
}
function deepClone(o) { return JSON.parse(JSON.stringify(o)); }

// ---------------------------------------------------------------------------
// SC-T1 / SC-T2 — module surface + exact 63-column list
// ---------------------------------------------------------------------------

ok('SC-T1.1 season-csv module loads', !!SC, 'src/season-csv.js missing or not requireable');
ok('SC-T1.2 buildSeasonPlayerCsv is a function', SC && typeof SC.buildSeasonPlayerCsv === 'function');
ok('SC-T1.3 csvEscape is a function', SC && typeof SC.csvEscape === 'function');
ok('SC-T1.4 COLUMNS array exported', SC && Array.isArray(SC.COLUMNS));

// The spec is the source of truth: extract the §8.2 column list from the
// PSD document itself and compare verbatim (order + names).
const specText = fs.readFileSync(path.join(__dirname, '..', 'docs', 'player-season-data-specification.md'), 'utf-8');
const m = /Columns \(exact, ordered\): `(.*?)`/.exec(specText);
ok('SC-T2.1 spec §8.2 column list found in PSD doc', !!m);
const SPEC_COLUMNS = m ? m[1].split(',').map((s) => s.trim()) : [];

ok('SC-T2.2 spec column count is 63', SPEC_COLUMNS.length === 63, 'got ' + SPEC_COLUMNS.length);
ok('SC-T2.3 module COLUMNS count is 63', SC && SC.COLUMNS && SC.COLUMNS.length === 63, 'got ' + (SC && SC.COLUMNS ? SC.COLUMNS.length : 'n/a'));
eq('SC-T2.4 module COLUMNS equal spec list exactly', SC && SC.COLUMNS, SPEC_COLUMNS);

// ---------------------------------------------------------------------------
// Fixture builders (mirror tests/recent-form-tests.js conventions)
// ---------------------------------------------------------------------------

const SQUAD = [
  { id: 'p1', number: '1', name: 'G. Tesfaye' },
  { id: 'p2', number: '2', name: 'B. Worku' },
  { id: 'p3', number: '3', name: 'A. Haile' },
  { id: 'p4', number: '4', name: 'T. Girma' },
  { id: 'p5', number: '5', name: 'K. Alemu' },
  { id: 'p6', number: '6', name: 'N. Desalegn' },
  { id: 'p7', number: '7', name: 'L. Mengistu' },
  { id: 'p8', number: '8', name: 'M. Ahmed' },
  { id: 'p9', number: '9', name: 'S. Bekele' },
  { id: 'p10', number: '10', name: 'D. Bekele' },
  { id: 'p11', number: '11', name: 'R. Kebede' },
  { id: 'p12', number: '12', name: 'S. Chala' },
  { id: 'p13', number: '13', name: 'O. Tadesse' },
  { id: 'p14', number: '14', name: 'Y. Fikru' }
];

const XI_TEMPLATE = ['GK', 'RB', 'CB', 'CB', 'LB', 'CDM', 'CM', 'CM', 'RW', 'ST', 'LW'];
const XI_IDS = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p8', 'p10', 'p11', 'p9', 'p7'];

function startingXI(replaceAt) {
  return XI_TEMPLATE.map((position, i) => ({
    position,
    playerId: (replaceAt && replaceAt[i]) || XI_IDS[i]
  }));
}

let eventSeq = 1;
function ev(spec) {
  const base = {
    id: eventSeq++,
    time: spec.time,
    videoTime: spec.time,
    matchTime: spec.time,
    matchSeconds: spec.time,
    officialMinute: Math.ceil(spec.time / 60),
    second: Math.floor(spec.time) % 60,
    period: spec.period || '1H',
    label: spec.label,
    subtype: spec.subtype ?? null,
    qualifiers: spec.qualifiers || {},
    location: spec.location ?? null,
    playerId: spec.playerId ?? null,
    playerOffId: spec.playerOffId ?? null,
    playerOnId: spec.playerOnId ?? null,
    side: spec.team === 'our' ? 'for' : (spec.team === 'opponent' ? 'against' : null),
    team: spec.team ?? null,
    sequenceId: null,
    scoreForBefore: spec.sfb ?? 0,
    scoreAgainstBefore: spec.sab ?? 0,
    scoreForAfter: spec.sfa ?? null,
    scoreAgainstAfter: spec.saa ?? null,
    isInterval: spec.isInterval === true,
    startTime: spec.startTime ?? null,
    endTime: spec.endTime ?? null
  };
  return Object.assign(base, spec.extra || {});
}

function goal(time, team, sfb, sab, sfa, saa, period, playerId) {
  return ev({ time, period: period || '1H', label: 'Goal', team, sfb, sab, sfa, saa, playerId: playerId || null });
}
function sub(time, offId, onId, team, period) {
  return ev({ time, period: period || '2H', label: 'Sub', playerOffId: offId, playerOnId: onId, team: team === undefined ? 'our' : team });
}
function ftClock(baseSeconds) {
  return {
    clockStartedAt: null, clockBaseSeconds: baseSeconds, clockRunning: false,
    period: 'FT', scoreFor: 2, scoreAgainst: 1, videoSyncOffset: 0,
    selectedTeam: 'our', selectedPlayerId: null, activeSequenceId: null, nextSequenceNumber: 1
  };
}

function mkSession(opts) {
  const squad = SQUAD.map((p) => (
    opts.nameOverride && opts.nameOverride[p.id] ? { ...p, name: opts.nameOverride[p.id] } : p
  ));
  return {
    sourceFile: opts.sourceFile || ('/f' + opts.n + '.json'),
    __savedAt: opts.savedAt || ('2026-09-' + String(opts.n).padStart(2, '0') + 'T20:00:00Z'),
    __schemaVersion: 3,
    videoPath: null,
    tags: [],
    events: opts.events,
    squad,
    matchInfo: {
      competition: 'League', date: opts.date, opponent: 'Opponent ' + opts.n, venue: 'V',
      homeAway: opts.homeAway || 'home', ourScore: opts.manual ? opts.manual[0] : '', opponentScore: opts.manual ? opts.manual[1] : '',
      formation: '4-3-3', startingXI: startingXI(opts.xiReplace || null)
    },
    matchClock: opts.clock || ftClock(5400)
  };
}

// ---------------------------------------------------------------------------
// FIXTURE FE — 3 matches, hand-computed oracles for p8 (+ special cases)
//   M1 2026-08-01 home, manual 1-0 (W, MATCH):  p8 starter full 90:
//       4 recoveries (3 located), 2 successful + 1 unsuccessful pass, 1 goal;
//       p12 subbed ON at 1800 for p7 (60.0'); p14 unused sub (UNAVAILABLE).
//   M2 2026-08-08 away, manual 0-2 (L, MATCH):  p8 starter subbed OFF 2700
//       (45.0'): 2 recoveries (located), 1 shot (0-2 → LOSING); 2 opponent
//       goals; p13 subbed on for p8.
//   M3 2026-08-15 home, manual 3-0 vs chain 1-0 (W, X1 MISMATCH): p8 starter
//       full 90: 1 goal, 1 successful + 1 unsuccessful pass. State partitions
//       suppressed for the whole match.
//   p10's name is overridden with comma+quotes for the csvEscape oracle.
// ---------------------------------------------------------------------------

function feSessions() {
  const out = [];
  // M1
  {
    eventSeq = 1;
    const events = [].concat(
      ev({ time: 60, label: 'Recovery', team: 'our', playerId: 'p8', location: { x: 0.2, y: 0.3 } }),
      ev({ time: 120, label: 'Recovery', team: 'our', playerId: 'p8', location: { x: 0.5, y: 0.5 } }),
      ev({ time: 180, label: 'Recovery', team: 'our', playerId: 'p8', location: { x: 0.8, y: 0.7 } }),
      ev({ time: 240, label: 'Recovery', team: 'our', playerId: 'p8' }),
      ev({ time: 300, label: 'Pass', team: 'our', playerId: 'p8', qualifiers: { Outcome: 'Successful' } }),
      ev({ time: 330, label: 'Pass', team: 'our', playerId: 'p8', qualifiers: { Outcome: 'Successful' } }),
      ev({ time: 900, label: 'Pass', team: 'our', playerId: 'p8', qualifiers: { Outcome: 'Unsuccessful' } }),
      goal(1800, 'our', 0, 0, 1, 0, '1H', 'p8'),
      sub(1800, 'p7', 'p12', 'our', '2H')
    );
    out.push(mkSession({
      n: 1, date: '2026-08-01', manual: [1, 0], events,
      nameOverride: { p10: 'D. "Big" Bekele, Jr.' }
    }));
  }
  // M2
  {
    const events = [].concat(
      ev({ time: 60, label: 'Recovery', team: 'our', playerId: 'p8', location: { x: 0.3, y: 0.4 } }),
      ev({ time: 120, label: 'Recovery', team: 'our', playerId: 'p8', location: { x: 0.6, y: 0.6 } }),
      ev({ time: 1500, label: 'Shot', subtype: 'On target', team: 'our', playerId: 'p8', period: '2H', sfb: 0, sab: 2 }),
      goal(600, 'opponent', 0, 0, 0, 1, '1H'),
      goal(1200, 'opponent', 0, 1, 0, 2, '1H'),
      sub(2700, 'p8', 'p13', 'our', '2H')
    );
    out.push(mkSession({ n: 2, date: '2026-08-08', homeAway: 'away', manual: [0, 2], events }));
  }
  // M3
  {
    const events = [].concat(
      goal(1800, 'our', 0, 0, 1, 0, '1H', 'p8'),
      ev({ time: 2000, label: 'Pass', team: 'our', playerId: 'p8', qualifiers: { Outcome: 'Successful' }, period: '1H' }),
      ev({ time: 2100, label: 'Pass', team: 'our', playerId: 'p8', qualifiers: { Outcome: 'Unsuccessful' }, period: '1H' })
    );
    out.push(mkSession({ n: 3, date: '2026-08-15', manual: [3, 0], events }));
  }
  return out;
}

const PS_FE = PSE.computeSeason(feSessions());

// ---------------------------------------------------------------------------
// Build the CSV + parse rows
// ---------------------------------------------------------------------------

const CSV = SC ? SC.buildSeasonPlayerCsv(PS_FE) : null;
const LINES = CSV ? CSV.split('\n') : [];
const HEADER = LINES[0] || '';
const ROWS = LINES.slice(1);
const IDX = {};
if (SC && SC.COLUMNS) SC.COLUMNS.forEach((c, i) => { IDX[c] = i; });
// Simple CSV row parser (handles quoted fields with doubled quotes).
function parseRow(line) {
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

const PARSED = ROWS.map(parseRow);
function val(rowIdx, col) { return PARSED[rowIdx][IDX[col]]; }

// ---------------------------------------------------------------------------
// SC-T3 — forbidden terminology (PSD-N §8.4) in header + full output
// ---------------------------------------------------------------------------

const FORBIDDEN = [
  'per 90', 'P90', 'p90', 'minutes played', 'Possession %', 'form index',
  'form score', 'hot streak', 'cold streak', 'player rating',
  'performance score', 'impact', 'consistency index', 'improving',
  'declining', 'season xG', 'career', 'scouting report', 'AI analysis',
  'prediction', 'trend significance'
];
if (CSV) {
  FORBIDDEN.forEach((term) => {
    ok('SC-T3 forbidden term absent from output: "' + term + '"', CSV.indexOf(term) === -1, 'term found in output');
  });
} else {
  FORBIDDEN.forEach((t) => ok('SC-T3 forbidden term absent (module missing)', false));
}

// ---------------------------------------------------------------------------
// SC-T2.5 / SC-T4 — header row + row structure
// ---------------------------------------------------------------------------

ok('SC-T2.5 rendered header row equals COLUMNS join', HEADER === (SC ? SC.COLUMNS.join(',') : ''), 'header="' + HEADER + '"');
ok('SC-T2.6 header field count is 63', parseRow(HEADER).length === 63, 'got ' + parseRow(HEADER).length);

// FE expected rows: 42 player×match rows (every squad-listed player gets a
// record in every match: 14 players × 3 matches) + 14 SEASON_SUMMARY rows =
// 56 data rows. NOTE (engine semantics, verified): Sub events count in
// player metrics.events and subOn/subOff but NOT in byPeriod/byState/spatial
// partitions — the oracles below reflect that.
ok('SC-T4.1 data row count is 56', ROWS.length === 56, 'got ' + ROWS.length);
ok('SC-T4.2 every data row has 63 cells', PARSED.length > 0 && PARSED.every((r) => r.length === 63));

// Summary rows: one per player, 14 total.
const summaryRows = PARSED.filter((r) => r[IDX.match_key] === 'SEASON_SUMMARY');
eq('SC-T4.3 SEASON_SUMMARY row count is 14', summaryRows.length, 14);
ok('SC-T4.4 summary rows carry participation_status SEASON_SUMMARY',
  summaryRows.length === 14 && summaryRows.every((r) => r[IDX.participation_status] === 'SEASON_SUMMARY'));

// Player-major ordering: playerOrder = p8, p1..p7, p9..p11, p12, p13, p14;
// p8's block first: M1, M2, M3, SUMMARY.
if (PARSED.length === 56) {
  eq('SC-T4.5 first data row is p8 M1', [val(0, 'match_key'), val(0, 'player_id')], ['2026-08-01_vs Opponent 1', 'p8']);
  eq('SC-T4.6 p8 block order M1→M2→M3→SUMMARY',
    [val(0, 'match_key'), val(1, 'match_key'), val(2, 'match_key'), val(3, 'match_key')],
    ['2026-08-01_vs Opponent 1', '2026-08-08_vs Opponent 2', '2026-08-15_vs Opponent 3', 'SEASON_SUMMARY']);
  eq('SC-T4.7 last data row is p14 summary', [val(55, 'match_key'), val(55, 'player_id')], ['SEASON_SUMMARY', 'p14']);
} else {
  ok('SC-T4.5 row-order check (skipped — rows missing)', false);
  ok('SC-T4.6 row-order check (skipped — rows missing)', false);
  ok('SC-T4.7 row-order check (skipped — rows missing)', false);
}

// ---------------------------------------------------------------------------
// SC-T5 — hand-computed oracles (p8)
// ---------------------------------------------------------------------------

if (CSV && PARSED.length === 56) {
  // --- p8 M1 row (row 0)
  eq('SC-T5.1 p8 M1 context', [val(0, 'date'), val(0, 'opponent'), val(0, 'competition'), val(0, 'home_away'), val(0, 'result'), val(0, 'x1_status')],
    ['2026-08-01', 'Opponent 1', 'League', 'home', 'W 1-0', 'MATCH']);
  eq('SC-T5.2 p8 M1 identity', [val(0, 'player_id'), val(0, 'player_name'), val(0, 'player_number')], ['p8', 'M. Ahmed', '8']);
  eq('SC-T5.3 p8 M1 participation', [val(0, 'participation_status'), val(0, 'started'), val(0, 'subbed_on'), val(0, 'subbed_on_min'), val(0, 'subbed_off'), val(0, 'subbed_off_min'), val(0, 'sent_off')],
    ['STARTED_FULL', 'TRUE', 'FALSE', '', 'FALSE', '', 'FALSE']);
  eq('SC-T5.4 p8 M1 minutes', [val(0, 'minutes_est'), val(0, 'minutes_quality'), val(0, 'minutes_reasons')], ['90.0', 'RELIABLE', '']);
  eq('SC-T5.5 p8 M1 counts', [val(0, 'goals'), val(0, 'shots'), val(0, 'passes'), val(0, 'recoveries'), val(0, 'events_total')],
    ['1', '0', '3', '4', '8']);
  eq('SC-T5.6 p8 M1 pass success pct (2/3)', val(0, 'pass_success_pct'), '66.7');
  eq('SC-T5.7 p8 M1 located (3/8)', [val(0, 'located_events'), val(0, 'unlocated_events'), val(0, 'located_share_pct')], ['3', '5', '37.5']);
  eq('SC-T5.8 p8 M1 periods (all 1H)', [val(0, 'events_1h'), val(0, 'events_2h'), val(0, 'events_et1'), val(0, 'events_et2')], ['8', '0', '0', '0']);
  eq('SC-T5.9 p8 M1 states (all DRAW 0-0)', [val(0, 'state_winning'), val(0, 'state_drawing'), val(0, 'state_losing'), val(0, 'state_suppressed')], ['0', '8', '0', '']);

  // --- p8 M2 row (row 1)
  eq('SC-T5.10 p8 M2 context', [val(1, 'date'), val(1, 'home_away'), val(1, 'result'), val(1, 'x1_status')], ['2026-08-08', 'away', 'L 0-2', 'MATCH']);
  eq('SC-T5.11 p8 M2 participation subbed off', [val(1, 'participation_status'), val(1, 'subbed_off'), val(1, 'subbed_off_min'), val(1, 'minutes_est')],
    ['STARTED_SUBBED_OFF', 'TRUE', '45.0', '45.0']);
  eq('SC-T5.12 p8 M2 counts (incl. subOff marker in events)', [val(1, 'goals'), val(1, 'shots'), val(1, 'shots_on_target'), val(1, 'recoveries'), val(1, 'events_total')], ['0', '1', '1', '2', '4']);
  eq('SC-T5.12b p8 M2 periods (sub not in partitions)', [val(1, 'events_1h'), val(1, 'events_2h')], ['2', '1']);
  eq('SC-T5.12c p8 M2 pass pct empty (no passes)', val(1, 'pass_success_pct'), '');
  eq('SC-T5.13 p8 M2 states (2 DRAW + 1 LOSING)', [val(1, 'state_drawing'), val(1, 'state_losing'), val(1, 'state_suppressed')], ['2', '1', '']);

  // --- p8 M3 row (row 2) — X1 MISMATCH suppression
  eq('SC-T5.14 p8 M3 context (MISMATCH)', [val(2, 'result'), val(2, 'x1_status')], ['W 3-0', 'MISMATCH']);
  eq('SC-T5.15 p8 M3 states suppressed with reason', [val(2, 'state_winning'), val(2, 'state_drawing'), val(2, 'state_losing'), val(2, 'state_suppressed')],
    ['', '', '', 'X1_MISMATCH_SUPPRESSED']);
  eq('SC-T5.16 p8 M3 counts + pass pct (1/2)', [val(2, 'goals'), val(2, 'passes'), val(2, 'pass_success_pct'), val(2, 'events_total')], ['1', '2', '50.0', '3']);
  eq('SC-T5.17 p8 M3 located_share 0/3 is a real 0.0 (null only at den=0)', [val(2, 'located_events'), val(2, 'unlocated_events'), val(2, 'located_share_pct')], ['0', '3', '0.0']);

  // --- p8 SEASON_SUMMARY row (row 3)
  eq('SC-T5.18 p8 summary context columns empty', [val(3, 'date'), val(3, 'opponent'), val(3, 'competition'), val(3, 'home_away'), val(3, 'result'), val(3, 'x1_status')],
    ['', '', '', '', '', '']);
  eq('SC-T5.19 p8 summary totals (incl. sub markers)', [val(3, 'goals'), val(3, 'shots'), val(3, 'passes'), val(3, 'recoveries'), val(3, 'events_total')],
    ['2', '1', '5', '6', '15']);
  eq('SC-T5.20 p8 summary pooled pass pct (3/5)', val(3, 'pass_success_pct'), '60.0');
  eq('SC-T5.21 p8 summary minutes 225.0 RELIABLE', [val(3, 'minutes_est'), val(3, 'minutes_quality'), val(3, 'minutes_reasons')], ['225.0', 'RELIABLE', '']);
  eq('SC-T5.22 p8 summary located (5/14)', [val(3, 'located_events'), val(3, 'unlocated_events'), val(3, 'located_share_pct')], ['5', '9', '35.7']);
  eq('SC-T5.23 p8 summary participation cells empty', [val(3, 'started'), val(3, 'subbed_on'), val(3, 'subbed_off'), val(3, 'sent_off')], ['', '', '', '']);

  // --- special players
  // p12: sub on 1800 in M1 — 60.0', SUB_ON, events include the subOn marker.
  const p12m1 = PARSED.findIndex((r) => r[IDX.player_id] === 'p12' && r[IDX.match_key] === '2026-08-01_vs Opponent 1');
  ok('SC-T5.24 p12 M1 row exists', p12m1 !== -1);
  if (p12m1 !== -1) {
    eq('SC-T5.25 p12 M1 sub-on cells', [val(p12m1, 'participation_status'), val(p12m1, 'subbed_on'), val(p12m1, 'subbed_on_min'), val(p12m1, 'minutes_est')],
      ['SUB_ON', 'TRUE', '30.0', '60.0']);
    eq('SC-T5.26 p12 zero tagged events → pct cells EMPTY not 0 (events carries the subOn marker)', [val(p12m1, 'events_total'), val(p12m1, 'pass_success_pct'), val(p12m1, 'located_share_pct')], ['1', '', '']);
  }
  // p12 M2: squad-listed but unused → UNUSED_SUB row with UNAVAILABLE minutes.
  const p12m2 = PARSED.findIndex((r) => r[IDX.player_id] === 'p12' && r[IDX.match_key] === '2026-08-08_vs Opponent 2');
  ok('SC-T5.26b p12 M2 unused-sub row exists (squad-listed in every match)', p12m2 !== -1);
  if (p12m2 !== -1) {
    eq('SC-T5.26c p12 M2 unused-sub cells', [val(p12m2, 'participation_status'), val(p12m2, 'minutes_est'), val(p12m2, 'minutes_quality')], ['UNUSED_SUB', '', 'UNAVAILABLE']);
  }
  // p14: unused sub all 3 matches — minutes UNAVAILABLE → empty.
  const p14m1 = PARSED.findIndex((r) => r[IDX.player_id] === 'p14' && r[IDX.match_key] === '2026-08-01_vs Opponent 1');
  ok('SC-T5.27 p14 M1 row exists', p14m1 !== -1);
  if (p14m1 !== -1) {
    eq('SC-T5.28 p14 unused-sub cells', [val(p14m1, 'participation_status'), val(p14m1, 'started'), val(p14m1, 'minutes_est'), val(p14m1, 'minutes_quality')],
      ['UNUSED_SUB', 'FALSE', '', 'UNAVAILABLE']);
  }
  // p10 csvEscape oracle — name with comma + double quotes.
  const p10m1 = PARSED.findIndex((r) => r[IDX.player_id] === 'p10' && r[IDX.match_key] === '2026-08-01_vs Opponent 1');
  eq('SC-T5.29 p10 escaped name parses back exactly', p10m1 !== -1 ? val(p10m1, 'player_name') : null, 'D. "Big" Bekele, Jr.');
  ok('SC-T5.30 p10 raw CSV cell is quoted with doubled quotes',
    p10m1 !== -1 && /(^|,)"D\. ""Big"" Bekele, Jr\."(,|$)/.test(ROWS[p10m1]), ROWS[p10m1]);
} else {
  ['SC-T5.1', 'SC-T5.30'].forEach((n) => ok(n + ' (skipped — CSV missing)', false));
}

// ---------------------------------------------------------------------------
// SC-T6/SC-T7/SC-T8 — null discipline, precision, booleans (targeted greps)
// ---------------------------------------------------------------------------

if (CSV && PARSED.length === 56) {
  // Booleans: only TRUE/FALSE appear in boolean columns.
  ok('SC-T8.1 boolean columns contain only TRUE/FALSE/empty',
    PARSED.every((r) => ['started', 'subbed_on', 'subbed_off', 'sent_off'].every((c) => ['TRUE', 'FALSE', ''].indexOf(r[IDX[c]]) !== -1)));
  // Precision: minutes/percent columns match the 1-decimal format when present.
  const DEC_RE = /^-?\d+\.\d$/;
  ok('SC-T7.1 minutes/percent cells are 1-decimal when present',
    PARSED.every((r) => ['minutes_est', 'subbed_on_min', 'subbed_off_min', 'pass_success_pct', 'located_share_pct']
      .every((c) => r[IDX[c]] === '' || DEC_RE.test(r[IDX[c]]))),
    'some cell not 1-decimal');
  // Counts are integers when present.
  ok('SC-T7.2 count cells are integers',
    PARSED.every((r) => ['goals', 'shots', 'passes', 'events_total', 'located_events', 'unlocated_events', 'events_1h', 'events_2h', 'events_et1', 'events_et2', 'state_winning', 'state_drawing', 'state_losing']
      .every((c) => r[IDX[c]] === '' || /^\d+$/.test(r[IDX[c]]))));
  // LF endings, no BOM, trailing newline absent (matches legacy join('\n')).
  ok('SC-T7.3 LF line endings only', CSV.indexOf('\r') === -1);
  ok('SC-T7.4 no BOM', CSV.charCodeAt(0) !== 0xFEFF);
  ok('SC-T7.5 no trailing newline (legacy join convention)', CSV[CSV.length - 1] !== '\n');
}

// ---------------------------------------------------------------------------
// SC-T10 / SC-T11 — determinism + immutability
// ---------------------------------------------------------------------------

if (SC && CSV) {
  const psBefore = JSON.stringify(PS_FE);
  const csv2 = SC.buildSeasonPlayerCsv(PS_FE);
  ok('SC-T10.1 byte-identical on rerun', csv2 === CSV);
  const PS2 = PSE.computeSeason(feSessions());
  const csv3 = SC.buildSeasonPlayerCsv(PS2);
  ok('SC-T10.2 byte-identical across PS recompute', csv3 === CSV);
  ok('SC-T11.1 PS deep-unchanged by export', JSON.stringify(PS_FE) === psBefore);
}

// ---------------------------------------------------------------------------
// SC-T12 — csvEscape behavior-identical to the renderer's
// ---------------------------------------------------------------------------

if (SC && typeof SC.csvEscape === 'function') {
  eq('SC-T12.1 plain value unquoted', SC.csvEscape('League'), 'League');
  eq('SC-T12.2 comma → quoted', SC.csvEscape('a,b'), '"a,b"');
  eq('SC-T12.3 quote → quoted with doubled quotes', SC.csvEscape('say "hi"'), '"say ""hi"""');
  eq('SC-T12.4 newline → quoted', SC.csvEscape('a\nb'), '"a\nb"');
  eq('SC-T12.5 number String()-ed', SC.csvEscape(12), '12');
  eq('SC-T12.6 empty string stays empty', SC.csvEscape(''), '');
}

// ---------------------------------------------------------------------------
// SC-T13 — mapping fidelity (CSV cells equal PS record values verbatim)
// ---------------------------------------------------------------------------

if (CSV && PARSED.length === 56) {
  const recs = PS_FE.playerMatchRecords;
  const metricMap = {
    goals: 'goals', shots: 'shots', shots_on_target: 'shotsOnTarget', chances: 'chances',
    key_passes: 'keyPasses', crosses: 'crosses', passes: 'passes', presses: 'presses',
    press_wins: 'pressWins', interceptions: 'interceptions', recoveries: 'recoveries',
    turnovers: 'turnovers', duels: 'duels', fouls: 'fouls', yellow_cards: 'yellowCards',
    red_cards: 'redCards', transitions_positive: 'transitionsPositive',
    transitions_negative: 'transitionsNegative', positive_events: 'positiveEvents',
    negative_events: 'negativeEvents', events_total: 'events'
  };
  const zoneMap = {
    zone_dl: 'Defensive third · Left channel', zone_dc: 'Defensive third · Central channel', zone_dr: 'Defensive third · Right channel',
    zone_ml: 'Middle third · Left channel', zone_mc: 'Middle third · Central channel', zone_mr: 'Middle third · Right channel',
    zone_al: 'Attacking third · Left channel', zone_ac: 'Attacking third · Central channel', zone_ar: 'Attacking third · Right channel'
  };
  let mismatches = 0;
  recs.forEach((rec) => {
    const rowIdx = PARSED.findIndex((r) => r[IDX.player_id] === rec.playerId && r[IDX.match_key] === rec.matchKey.label);
    if (rowIdx === -1) { mismatches++; return; }
    Object.keys(metricMap).forEach((col) => {
      if (String(rec.metrics[metricMap[col]]) !== val(rowIdx, col)) mismatches++;
    });
    if (String(rec.spatial.located) !== val(rowIdx, 'located_events')) mismatches++;
    if (String(rec.spatial.unlocated) !== val(rowIdx, 'unlocated_events')) mismatches++;
    Object.keys(zoneMap).forEach((col) => {
      if (String(rec.spatial.zones[zoneMap[col]] || 0) !== val(rowIdx, col)) mismatches++;
    });
    if (String(rec.spatial.unlocatedZone || 0) !== val(rowIdx, 'zone_unlocated')) mismatches++;
    if (String(rec.periods['1H'].events) !== val(rowIdx, 'events_1h')) mismatches++;
    if (String(rec.periods['2H'].events) !== val(rowIdx, 'events_2h')) mismatches++;
    if (String(rec.periods.ET1.events) !== val(rowIdx, 'events_et1')) mismatches++;
    if (String(rec.periods.ET2.events) !== val(rowIdx, 'events_et2')) mismatches++;
    if (rec.gameState) {
      if (String(rec.gameState.WINNING.events) !== val(rowIdx, 'state_winning')) mismatches++;
      if (String(rec.gameState.DRAW.events) !== val(rowIdx, 'state_drawing')) mismatches++;
      if (String(rec.gameState.LOSING.events) !== val(rowIdx, 'state_losing')) mismatches++;
      if (val(rowIdx, 'state_suppressed') !== '') mismatches++;
    } else {
      if (val(rowIdx, 'state_winning') !== '' || val(rowIdx, 'state_drawing') !== '' || val(rowIdx, 'state_losing') !== '') mismatches++;
      if (val(rowIdx, 'state_suppressed') !== (rec.gameStateSuppressedReason || '')) mismatches++;
    }
    if (String(rec.participation.status) !== val(rowIdx, 'participation_status')) mismatches++;
    if (String(rec.participation.starter ? 'TRUE' : 'FALSE') !== val(rowIdx, 'started')) mismatches++;
    if (String(rec.participation.substitutedOn ? 'TRUE' : 'FALSE') !== val(rowIdx, 'subbed_on')) mismatches++;
    if (String(rec.participation.substitutedOff ? 'TRUE' : 'FALSE') !== val(rowIdx, 'subbed_off')) mismatches++;
    if (String(rec.participation.sentOff ? 'TRUE' : 'FALSE') !== val(rowIdx, 'sent_off')) mismatches++;
    if (String(rec.minutes.quality) !== val(rowIdx, 'minutes_quality')) mismatches++;
    if (String(rec.opponent) !== val(rowIdx, 'opponent')) mismatches++;
    if (String(rec.competition) !== val(rowIdx, 'competition')) mismatches++;
    if (String(rec.homeAway) !== val(rowIdx, 'home_away')) mismatches++;
    if (String(rec.date) !== val(rowIdx, 'date')) mismatches++;
  });
  ok('SC-T13.1 all player×match cells map 1:1 to PS record values (0 mismatches)', mismatches === 0, mismatches + ' mismatches');

  // Summary rows map to PS.players totals.
  let sumMismatches = 0;
  PS_FE.playerOrder.forEach((pid) => {
    const p = PS_FE.players[pid];
    const rowIdx = PARSED.findIndex((r) => r[IDX.player_id] === pid && r[IDX.match_key] === 'SEASON_SUMMARY');
    if (rowIdx === -1) { sumMismatches++; return; }
    if (String(p.name) !== val(rowIdx, 'player_name')) sumMismatches++;
    if (String(p.number) !== val(rowIdx, 'player_number')) sumMismatches++;
    if (String(p.totals.goals) !== val(rowIdx, 'goals')) sumMismatches++;
    if (String(p.totals.events) !== val(rowIdx, 'events_total')) sumMismatches++;
    if (String(p.minutes.quality) !== val(rowIdx, 'minutes_quality')) sumMismatches++;
    if (String(p.periods['1H'].events) !== val(rowIdx, 'events_1h')) sumMismatches++;
    if (String(p.periods['2H'].events) !== val(rowIdx, 'events_2h')) sumMismatches++;
    if (String(p.spatial.located) !== val(rowIdx, 'located_events')) sumMismatches++;
    if (String(p.spatial.unlocated) !== val(rowIdx, 'unlocated_events')) sumMismatches++;
    if (p.gameState) {
      if (String(p.gameState.WINNING.events) !== val(rowIdx, 'state_winning')) sumMismatches++;
      if (String(p.gameState.DRAW.events) !== val(rowIdx, 'state_drawing')) sumMismatches++;
      if (String(p.gameState.LOSING.events) !== val(rowIdx, 'state_losing')) sumMismatches++;
    }
  });
  ok('SC-T13.2 SEASON_SUMMARY cells map 1:1 to PS player season records', sumMismatches === 0, sumMismatches + ' mismatches');
}

// ---------------------------------------------------------------------------
// SC-T14 — UI wiring (jsdom)
// ---------------------------------------------------------------------------

(async function uiPart() {
  const jsdomDir = process.env.JSDOM_PATH
    ? process.env.JSDOM_PATH
    : path.join(__dirname, '.jsdom-scratch', 'node_modules');
  let JSDOM;
  try { JSDOM = require(path.join(jsdomDir, 'jsdom')).JSDOM; } catch (e) {
    console.error('jsdom not found in ' + jsdomDir);
    process.exit(2);
  }

  const srcDir = path.join(__dirname, '..', 'src');
  const html = fs.readFileSync(path.join(srcDir, 'index.html'), 'utf-8');
  const integritySrc = fs.readFileSync(path.join(srcDir, 'integrity.js'), 'utf-8');
  const analyticsSrc = fs.readFileSync(path.join(srcDir, 'analytics.js'), 'utf-8');
  const playerSeasonSrc = fs.readFileSync(path.join(srcDir, 'player-season.js'), 'utf-8');
  const recentFormSrc = fs.readFileSync(path.join(srcDir, 'recent-form.js'), 'utf-8');
  let seasonCsvSrc = null;
  try { seasonCsvSrc = fs.readFileSync(path.join(srcDir, 'season-csv.js'), 'utf-8'); } catch (e) { seasonCsvSrc = null; }
  const rendererSrc = fs.readFileSync(path.join(srcDir, 'renderer.js'), 'utf-8');

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function clickOn(win, el) { el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true })); }

  // SC-T14.1 — static script order in index.html (player-season < season-csv < renderer).
  // Match the actual <script src="..."> tags, not comment text.
  function scriptTagPos(name) { return html.indexOf('<script src="' + name + '"></script>'); }
  const pSeasonTag = scriptTagPos('player-season.js');
  const rfTag = scriptTagPos('recent-form.js');
  const scTag = scriptTagPos('season-csv.js');
  const rendererTag = scriptTagPos('renderer.js');
  ok('SC-T14.1a index.html has a season-csv.js script tag', scTag !== -1);
  ok('SC-T14.1b script order: player-season.js < season-csv.js', pSeasonTag !== -1 && scTag !== -1 && pSeasonTag < scTag);
  ok('SC-T14.1c script order: recent-form.js < season-csv.js', rfTag !== -1 && scTag !== -1 && rfTag < scTag);
  ok('SC-T14.1d script order: season-csv.js < renderer.js', scTag !== -1 && rendererTag !== -1 && scTag < rendererTag);

  function baseStub(overrides) {
    return Object.assign({
      openVideo: async () => null,
      saveSession: async () => ({ canceled: true }),
      exportCsv: async () => ({ canceled: true }),
      exportClipPlaylist: async () => ({ canceled: true }),
      loadSession: async () => null,
      loadMultipleSessions: async () => [],
      loadSquad: async () => [],
      saveSquad: async () => true,
      detachVideo: async () => true,
      reattachVideo: async () => true,
      sendVideoCommand: () => {},
      onVideoState: () => {},
      onVideoClosed: () => {},
      autosaveRead: async () => null,
      autosaveWrite: async () => ({ ok: true }),
      autosaveDelete: async () => ({ ok: true }),
      autosaveFlushSync: () => ({ ok: true }),
      onCloseRequested: () => {},
      closeProceed: () => {}
    }, overrides || {});
  }

  async function boot(loadMultiple, withSeasonCsv) {
    const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'file://' + path.join(srcDir, 'index.html') });
    const win = dom.window;
    win.matchtag = baseStub({
      loadMultipleSessions: async () => loadMultiple ? deepClone(loadMultiple) : []
    });
    win.eval(integritySrc);
    win.eval(analyticsSrc);
    win.eval(playerSeasonSrc);
    win.eval(recentFormSrc);
    if (withSeasonCsv && seasonCsvSrc) win.eval(seasonCsvSrc);
    win.eval(rendererSrc);
    await sleep(250);
    return { dom, win, doc: win.document };
  }

  // ---- Boot A: full wiring — new button exports the player CSV
  {
    console.log('== Boot A — full wiring: player×match CSV export ==');
    let booted = null;
    try { booted = await boot(feSessions(), true); } catch (e) { booted = null; }
    ok('SC-T14.2 boot A completes', !!booted);
    if (!booted) {
      ['SC-T14.3', 'SC-T14.4', 'SC-T14.5', 'SC-T14.6', 'SC-T14.7', 'SC-T14.8', 'SC-T14.9', 'SC-T14.10', 'SC-T14.11'].forEach((n) => ok(n + ' (skipped — boot failed)', false));
    } else {
    const { win, doc } = booted;
    ok('SC-T14.2 SeasonCsvEngine exposed on window', typeof win.SeasonCsvEngine === 'object' && typeof win.SeasonCsvEngine.buildSeasonPlayerCsv === 'function');

    const btn = doc.getElementById('btnExportSeasonPlayerCsv');
    ok('SC-T14.3 new export button exists in the season modal', !!btn);
    ok('SC-T14.4 legacy event-dump button still exists', !!doc.getElementById('btnExportSeasonCsv'));

    let modalOpened = false;
    if (btn) {
      clickOn(win, doc.getElementById('btnSeasonView'));
      modalOpened = doc.getElementById('seasonModal').style.display === 'flex';
    }
    ok('SC-T14.5 season modal opens', modalOpened);
    if (modalOpened) {
      clickOn(win, doc.getElementById('btnAddSeasonMatches'));
      await sleep(300);
    }

    const exported = [];
    win.matchtag.exportCsv = async (csvString) => { exported.push(csvString); return { canceled: true }; };

    if (btn && modalOpened) {
      clickOn(win, btn);
      await sleep(200);
    }
    ok('SC-T14.6 click triggers exactly one exportCsv call', exported.length === 1, 'calls=' + exported.length);
    if (exported.length === 1) {
      const csvString = exported[0];
      const headerLine = csvString.split('\n')[0];
      ok('SC-T14.7 exported header is the 63-column PSD-V2 header', headerLine === (SC ? SC.COLUMNS.join(',') : ''), headerLine);
      ok('SC-T14.8 exported row count is 57 lines (56 rows + header)', csvString.split('\n').length === 57);
      ok('SC-T14.9 exported CSV contains SEASON_SUMMARY rows', csvString.indexOf('SEASON_SUMMARY') !== -1);
    } else {
      ok('SC-T14.7 exported header check (skipped — no export)', false);
      ok('SC-T14.8 exported row count check (skipped — no export)', false);
      ok('SC-T14.9 SEASON_SUMMARY check (skipped — no export)', false);
    }

    // Legacy button: byte-unchanged event dump.
    exported.length = 0;
    if (modalOpened && doc.getElementById('btnExportSeasonCsv')) {
      clickOn(win, doc.getElementById('btnExportSeasonCsv'));
      await sleep(200);
    }
    ok('SC-T14.10 legacy button still exports (one call)', exported.length === 1, 'calls=' + exported.length);
    if (exported.length === 1) {
      const legacyHeader = exported[0].split('\n')[0];
      eq('SC-T14.11 legacy header byte-identical (event dump untouched)',
        legacyHeader,
        'match,timecode,seconds,end_timecode,end_seconds,duration_seconds,label,side,player_number,player_name,player_off_number,player_off_name,player_on_number,player_on_name,subtype,qualifiers,location_zone,location_x,location_y');
    } else {
      ok('SC-T14.11 legacy header check (skipped — no export)', false);
    }
    }
  }

  // ---- Boot B: engine absent — graceful no-op, no crash
  {
    console.log('== Boot B — engine absent: graceful no-op ==');
    let booted = null;
    try { booted = await boot(feSessions(), false); } catch (e) { booted = null; }
    if (booted) {
    const { win, doc } = booted;
    const btn = doc.getElementById('btnExportSeasonPlayerCsv');
    if (btn) {
      clickOn(win, doc.getElementById('btnSeasonView'));
      clickOn(win, doc.getElementById('btnAddSeasonMatches'));
      await sleep(300);
    }
    const exported = [];
    win.matchtag.exportCsv = async (csvString) => { exported.push(csvString); return { canceled: true }; };
    let crashed = false;
    try {
      if (btn) {
        clickOn(win, btn);
        await sleep(150);
      }
    } catch (e) { crashed = true; }
    ok('SC-T14.12 no crash when SeasonCsvEngine absent', !crashed);
    ok('SC-T14.13 no export when SeasonCsvEngine absent', exported.length === 0, 'calls=' + exported.length);
    } else {
      ok('SC-T14.12 (skipped — boot failed)', false);
      ok('SC-T14.13 (skipped — boot failed)', false);
    }
  }

  // ---- Boot C: no matches loaded — no-op
  {
    console.log('== Boot C — no matches loaded: no-op ==');
    let booted = null;
    try { booted = await boot(null, true); } catch (e) { booted = null; }
    if (booted) {
    const { win, doc } = booted;
    const btn = doc.getElementById('btnExportSeasonPlayerCsv');
    if (btn) {
      clickOn(win, doc.getElementById('btnSeasonView'));
      await sleep(150);
    }
    const exported = [];
    win.matchtag.exportCsv = async (csvString) => { exported.push(csvString); return { canceled: true }; };
    let crashed = false;
    try {
      if (btn) {
        clickOn(win, btn);
        await sleep(150);
      }
    } catch (e) { crashed = true; }
    ok('SC-T14.14 no crash with zero matches', !crashed);
    ok('SC-T14.15 no export with zero matches', exported.length === 0, 'calls=' + exported.length);
    } else {
      ok('SC-T14.14 (skipped — boot failed)', false);
      ok('SC-T14.15 (skipped — boot failed)', false);
    }
  }

  // ---- Summary
  console.log('');
  if (failures.length) {
    console.log('FAILURES:');
    failures.forEach((f) => console.log('  ✗ ' + f));
  }
  console.log('---- season-csv check: ' + pass + ' passed, ' + fail + ' failed ----');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
