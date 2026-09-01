// PitchLog — Recent Form & Descriptive Trends Engine V1 tests (RF-T1..RF-T35
// + task Part 28 invariant checks). Node, pure-function style (no GUI),
// mirroring the conventions of the other suites: ok()/eq() counts, explicit
// process.exit.
//
// Spec: docs/recent-form-trends-specification.md (PitchLog-RECENT-FORM-SPEC-v1.0-reestablished)
// Engine under test: src/recent-form.js — window.RecentFormEngine / module.exports.
//
// Fixtures are real saved sessions fed through the ACTUAL Player & Season
// Core (computeSeason), then consumed by computeRecentForm — engine reuse is
// exercised end-to-end, not assumed.

'use strict';

const path = require('path');
const PSE = require(path.join(__dirname, '..', 'src', 'player-season.js'));

// Test-first: the engine may not exist yet — every check then FAILS.
let RFM = null;
try { RFM = require(path.join(__dirname, '..', 'src', 'recent-form.js')); } catch (e) { RFM = null; }

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
// Fixture builders (mirror tests/player-season-tests.js conventions)
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
  // opts: { n, date, events, xiReplace, nameOverride, savedAt, clock, manual: [our, opp], sourceFile }
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
      homeAway: 'home', ourScore: opts.manual ? opts.manual[0] : '', opponentScore: opts.manual ? opts.manual[1] : '',
      formation: '4-3-3', startingXI: startingXI(opts.xiReplace || null)
    },
    matchClock: opts.clock || ftClock(5400)
  };
}

function recoveries(pid, count, firstTime, step, locatedCount) {
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(ev({
      time: firstTime + i * step, label: 'Recovery', team: 'our', playerId: pid,
      location: i < locatedCount ? { x: 0.2 + (i % 3) * 0.3, y: 0.3 + (i % 2) * 0.4 } : null
    }));
  }
  return out;
}
function passes(pid, successful, unsuccessful, firstTime) {
  const out = [];
  for (let i = 0; i < successful; i++) {
    out.push(ev({ time: firstTime + i * 30, label: 'Pass', team: 'our', playerId: pid, qualifiers: { Outcome: 'Successful' } }));
  }
  for (let i = 0; i < unsuccessful; i++) {
    out.push(ev({ time: firstTime + 900 + i * 30, label: 'Pass', team: 'our', playerId: pid, qualifiers: { Outcome: 'Unsuccessful' } }));
  }
  return out;
}
function goalsFor(pattern, pid) {
  // pattern: array of {t, team, sfb, sab, sfa, saa}
  return pattern.map((g) => goal(g.t, g.team, g.sfb, g.sab, g.sfa, g.saa, g.period || '1H', pid || null));
}

// ---------------------------------------------------------------------------
// FIXTURE F1 — the task Part 24 hand fixture (6 matches, p8 = tracked player)
// p8 appearances/minutes/recoveries:
//   M1 90' 10 rec (starter)   M2 60' 6 rec (sub on 1800)
//   M3 30' 4 rec (sub on 3600) M4 90' 12 rec (starter)
//   M5 90' 11 rec (starter)   M6 60' 5 rec (sub on 1800)
// Season: 48 recoveries, 420 minutes. Recent 5: 38 recoveries, 330 minutes.
// p14 = squad-listed unused substitute in every match (never XI, never sub).
// Results: M1 W1-0, M2 L0-1, M3 D1-1, M4 W2-1, M5 L1-2, M6 W1-0 (chain-derived).
// ---------------------------------------------------------------------------

function f1Sessions() {
  const sessions = [];
  const subOnForP6 = { 6: 'p13' }; // p13 takes p8's CM slot when p8 is a sub

  // M1: p8 starter, 90', 10 recoveries (6 located); our goal 1800 (1-0 W)
  {
    eventSeq = 1;
    const events = [].concat(
      recoveries('p8', 10, 60, 100, 6),
      goalsFor([{ t: 1800, team: 'our', sfb: 0, sab: 0, sfa: 1, saa: 0 }])
    );
    sessions.push(mkSession({ n: 1, date: '2026-08-01', events }));
  }
  // M2: p8 sub on 1800 for p6 (60'), 6 recoveries (2 located); opp goal 2000 (0-1 L)
  {
    eventSeq = 100;
    const events = [].concat(
      recoveries('p8', 6, 2000, 200, 2),
      [sub(1800, 'p6', 'p8')],
      goalsFor([{ t: 2600, team: 'opponent', sfb: 0, sab: 0, sfa: 0, saa: 1, period: '2H' }])
    );
    sessions.push(mkSession({ n: 2, date: '2026-08-08', events, xiReplace: subOnForP6 }));
  }
  // M3: p8 sub on 3600 for p6 (30'), 4 recoveries (1 located); 1-1 D
  {
    eventSeq = 200;
    const events = [].concat(
      recoveries('p8', 4, 3700, 200, 1),
      [sub(3600, 'p6', 'p8')],
      goalsFor([
        { t: 1500, team: 'our', sfb: 0, sab: 0, sfa: 1, saa: 0 },
        { t: 3000, team: 'opponent', sfb: 1, sab: 0, sfa: 1, saa: 1, period: '2H' }
      ])
    );
    sessions.push(mkSession({ n: 3, date: '2026-08-15', events, xiReplace: subOnForP6 }));
  }
  // M4: p8 starter, 90', 12 recoveries (4 located); 2-1 W
  {
    eventSeq = 300;
    const events = [].concat(
      recoveries('p8', 12, 100, 150, 4),
      goalsFor([
        { t: 1000, team: 'our', sfb: 0, sab: 0, sfa: 1, saa: 0 },
        { t: 2500, team: 'our', sfb: 1, sab: 0, sfa: 2, saa: 0, period: '2H' },
        { t: 3500, team: 'opponent', sfb: 2, sab: 0, sfa: 2, saa: 1, period: '2H' }
      ])
    );
    sessions.push(mkSession({ n: 4, date: '2026-08-22', events }));
  }
  // M5: p8 starter, 90', 11 recoveries (5 located); 1-2 L
  {
    eventSeq = 400;
    const events = [].concat(
      recoveries('p8', 11, 120, 150, 5),
      goalsFor([
        { t: 1200, team: 'our', sfb: 0, sab: 0, sfa: 1, saa: 0 },
        { t: 2000, team: 'opponent', sfb: 1, sab: 0, sfa: 1, saa: 1, period: '2H' },
        { t: 3800, team: 'opponent', sfb: 1, sab: 1, sfa: 1, saa: 2, period: '2H' }
      ])
    );
    sessions.push(mkSession({ n: 5, date: '2026-08-29', events }));
  }
  // M6: p8 sub on 1800 for p6 (60'), 5 recoveries (2 located); 1-0 W
  {
    eventSeq = 500;
    const events = [].concat(
      recoveries('p8', 5, 2000, 200, 2),
      [sub(1800, 'p6', 'p8')],
      goalsFor([{ t: 4000, team: 'our', sfb: 0, sab: 0, sfa: 1, saa: 0, period: '2H' }])
    );
    sessions.push(mkSession({ n: 6, date: '2026-09-05', events, xiReplace: subOnForP6 }));
  }
  return sessions;
}

// ---------------------------------------------------------------------------
// FIXTURE F2 — 10 matches, p8 starts all (90' each, RELIABLE).
// Recoveries: 5,6,4,7,6,9,8,10,9,9  (season 73; recent5 45; previous5 28)
// Name variant: p8 = 'M. Ahmed' (M1-M5), 'Mohammed Ahmed' (M6-M10).
// Each match 1-0 W via one our goal (chain).
// ---------------------------------------------------------------------------

function f2Sessions() {
  const sessions = [];
  const counts = [5, 6, 4, 7, 6, 9, 8, 10, 9, 9];
  for (let i = 0; i < 10; i++) {
    eventSeq = 1000 + i * 100;
    const events = [].concat(
      recoveries('p8', counts[i], 100, 150, 3),
      goalsFor([{ t: 1800, team: 'our', sfb: 0, sab: 0, sfa: 1, saa: 0 }])
    );
    sessions.push(mkSession({
      n: 20 + i, date: '2026-07-' + String(1 + i).padStart(2, '0'), events,
      nameOverride: i < 5 ? { p8: 'M. Ahmed' } : { p8: 'Mohammed Ahmed' }
    }));
  }
  return sessions;
}

// ---------------------------------------------------------------------------
// FIXTURE F3 — 3 matches; M2 has manual 2-0 vs chain 1 goal → X1 MISMATCH.
// p8 starts all 3: M1 4 rec (2 pre-goal DRAW + 2 post-goal WINNING),
// M2 3 rec, M3 5 rec (2 DRAW + 3 WINNING). M2 gameState suppressed.
// ---------------------------------------------------------------------------

function f3Sessions() {
  const sessions = [];
  // M1: 2 recoveries pre-goal (DRAW state), 2 post-goal (WINNING, sfb 1); 1-0 W
  {
    eventSeq = 1;
    const events = [].concat(
      recoveries('p8', 2, 200, 100, 0),
      goalsFor([{ t: 1000, team: 'our', sfb: 0, sab: 0, sfa: 1, saa: 0 }]),
      [0, 1].map((i) => ev({
        time: 1500 + i * 100, label: 'Recovery', team: 'our', playerId: 'p8',
        sfb: 1, sab: 0, sfa: 1, saa: 0
      }))
    );
    sessions.push(mkSession({ n: 31, date: '2026-06-01', events }));
  }
  // M2: manual 2-0 but chain 1 goal → X1 MISMATCH; p8 3 recoveries (state irrelevant — suppressed)
  {
    eventSeq = 100;
    const events = [].concat(
      recoveries('p8', 3, 200, 150, 0),
      goalsFor([{ t: 1000, team: 'our', sfb: 0, sab: 0, sfa: 1, saa: 0 }])
    );
    sessions.push(mkSession({ n: 32, date: '2026-06-08', events, manual: ['2', '0'] }));
  }
  // M3: 2 pre-goal (DRAW), 3 post-goal (WINNING, sfb 1); 1-0 W
  {
    eventSeq = 200;
    const events = [].concat(
      recoveries('p8', 2, 300, 100, 0),
      goalsFor([{ t: 1200, team: 'our', sfb: 0, sab: 0, sfa: 1, saa: 0 }]),
      [0, 1, 2].map((i) => ev({
        time: 1600 + i * 100, label: 'Recovery', team: 'our', playerId: 'p8',
        sfb: 1, sab: 0, sfa: 1, saa: 0
      }))
    );
    sessions.push(mkSession({ n: 33, date: '2026-06-15', events }));
  }
  return sessions;
}

// ---------------------------------------------------------------------------
// FIXTURE F4 — 8 matches; p14 starts M1-M5 (W 2-0 each), absent M6-M8 (L 0-2 each).
// With/without for p14: WITH 5 (5W, GF10, GA0), WITHOUT 3 (3L, GF0, GA6) → eligible.
// ---------------------------------------------------------------------------

function f4Sessions() {
  const sessions = [];
  const p14AtLW = { 10: 'p14' }; // p14 takes the LW slot
  for (let i = 0; i < 8; i++) {
    eventSeq = 2000 + i * 100;
    const win = i < 5;
    const pattern = win
      ? [
          { t: 1500, team: 'our', sfb: 0, sab: 0, sfa: 1, saa: 0 },
          { t: 2500, team: 'our', sfb: 1, sab: 0, sfa: 2, saa: 0, period: '2H' }
        ]
      : [
          { t: 1500, team: 'opponent', sfb: 0, sab: 0, sfa: 0, saa: 1 },
          { t: 2500, team: 'opponent', sfb: 0, sab: 1, sfa: 0, saa: 2, period: '2H' }
        ];
    const events = goalsFor(pattern, win ? 'p14' : null);
    sessions.push(mkSession({
      n: 40 + i, date: '2026-05-' + String(1 + i).padStart(2, '0'),
      events, xiReplace: win ? p14AtLW : null
    }));
  }
  return sessions;
}

// ---------------------------------------------------------------------------
// FIXTURE F5 — 7 matches; p14 starts M1-M5 (W 2-0), absent M6-M7 (L 0-2).
// With/without for p14: WITH 5, WITHOUT 2 → INSUFFICIENT_SAMPLE (sizes visible).
// ---------------------------------------------------------------------------

function f5Sessions() {
  return f4Sessions().slice(0, 7);
}

// ---------------------------------------------------------------------------
// FIXTURE F7 — 5 matches, mixed minutes quality for p8:
//   M1 RELIABLE (starter, FT) 10 rec; M2 ESTIMATED (starter, NO FT) 6 rec;
//   M3 UNAVAILABLE (un-timed sub-on) 4 rec; M4 RELIABLE 12 rec; M5 RELIABLE 11 rec.
// Per-90 must use only M1+M4+M5 (33 rec, 270', 16200s → 11.0).
// ---------------------------------------------------------------------------

function f7Sessions() {
  const sessions = [];
  {
    eventSeq = 1;
    const events = [].concat(
      recoveries('p8', 10, 100, 150, 2),
      goalsFor([{ t: 1800, team: 'our', sfb: 0, sab: 0, sfa: 1, saa: 0 }])
    );
    sessions.push(mkSession({ n: 61, date: '2026-04-01', events }));
  }
  {
    eventSeq = 100;
    const events = [].concat(
      recoveries('p8', 6, 100, 200, 1),
      goalsFor([{ t: 1800, team: 'our', sfb: 0, sab: 0, sfa: 1, saa: 0 }])
    );
    sessions.push(mkSession({
      n: 62, date: '2026-04-08', events,
      clock: { clockStartedAt: null, clockBaseSeconds: 3540, clockRunning: false, period: '2H', scoreFor: 1, scoreAgainst: 0, videoSyncOffset: 0, selectedTeam: 'our', selectedPlayerId: null, activeSequenceId: null, nextSequenceNumber: 1 }
    }));
  }
  {
    eventSeq = 200;
    const events = [].concat(
      recoveries('p8', 4, 3800, 100, 0),
      // un-timed sub: p8 comes on for p6 with NO time evidence at all
      [ev({ period: '2H', label: 'Sub', playerOffId: 'p6', playerOnId: 'p8', team: 'our' })],
      goalsFor([{ t: 4000, team: 'our', sfb: 0, sab: 0, sfa: 1, saa: 0, period: '2H' }])
    );
    sessions.push(mkSession({ n: 63, date: '2026-04-15', events, xiReplace: { 6: 'p13' } }));
  }
  {
    eventSeq = 300;
    const events = [].concat(
      recoveries('p8', 12, 100, 150, 3),
      goalsFor([{ t: 1800, team: 'our', sfb: 0, sab: 0, sfa: 1, saa: 0 }])
    );
    sessions.push(mkSession({ n: 64, date: '2026-04-22', events }));
  }
  {
    eventSeq = 400;
    const events = [].concat(
      recoveries('p8', 11, 100, 150, 2),
      goalsFor([{ t: 1800, team: 'our', sfb: 0, sab: 0, sfa: 1, saa: 0 }])
    );
    sessions.push(mkSession({ n: 65, date: '2026-04-29', events }));
  }
  return sessions;
}

// ---------------------------------------------------------------------------
// FIXTURE F8 — 2 matches, pooled-percentage anchor:
//   M1: p8 passes 4 successful / 1 unsuccessful (4/5)
//   M2: p8 passes 10 successful / 10 unsuccessful (10/20)
//   Window pooled passSuccess = 14/25 = 56% (never 65%).
// ---------------------------------------------------------------------------

function f8Sessions() {
  const sessions = [];
  {
    eventSeq = 1;
    const events = [].concat(
      passes('p8', 4, 1, 200),
      goalsFor([{ t: 1800, team: 'our', sfb: 0, sab: 0, sfa: 1, saa: 0 }])
    );
    sessions.push(mkSession({ n: 71, date: '2026-03-01', events }));
  }
  {
    eventSeq = 100;
    const events = [].concat(
      passes('p8', 10, 10, 200),
      goalsFor([{ t: 1800, team: 'our', sfb: 0, sab: 0, sfa: 1, saa: 0 }])
    );
    sessions.push(mkSession({ n: 72, date: '2026-03-08', events }));
  }
  return sessions;
}

// ---------------------------------------------------------------------------
// FIXTURE F9 — 6 matches, tolerance boundary (percentage):
//   M1-M3: p8 passes 10, 0 successful each; M4-M6: p8 passes 20, 3 successful each.
//   Window 3 passSuccess = 9/60 = 15%; Baseline A = 9/90 = 10%; diff 5.0 pp
//   = fixed 5.0 pp tolerance (inclusive boundary) → WITHIN-TOLERANCE.
// ---------------------------------------------------------------------------

function f9Sessions() {
  const sessions = [];
  for (let i = 0; i < 6; i++) {
    eventSeq = 300 + i * 100;
    const events = [].concat(
      i < 3 ? passes('p8', 0, 10, 200) : passes('p8', 3, 17, 200),
      goalsFor([{ t: 1800, team: 'our', sfb: 0, sab: 0, sfa: 1, saa: 0 }])
    );
    sessions.push(mkSession({ n: 80 + i, date: '2026-02-' + String(1 + i).padStart(2, '0'), events }));
  }
  return sessions;
}

// ---------------------------------------------------------------------------
// Compute the fixture PS outputs once (REAL Player & Season Core)
// ---------------------------------------------------------------------------

console.log('== Recent Form & Descriptive Trends Engine V1 — core tests ==');
console.log(RFM ? '(engine loaded: ' + (RFM.VERSION || '?') + ')' : '(ENGINE NOT LOADABLE — src/recent-form.js missing)');

const PS_F1 = PSE.computeSeason(f1Sessions());
const PS_F2 = PSE.computeSeason(f2Sessions());
const PS_F3 = PSE.computeSeason(f3Sessions());
const PS_F4 = PSE.computeSeason(f4Sessions());
const PS_F5 = PSE.computeSeason(f5Sessions());
const PS_F7 = PSE.computeSeason(f7Sessions());
const PS_F8 = PSE.computeSeason(f8Sessions());
const PS_F9 = PSE.computeSeason(f9Sessions());
// F6 = F1 + an exact duplicate session (same sourceFile) — must not inflate.
const PS_F6 = PSE.computeSeason(f1Sessions().concat([f1Sessions()[0]]));

const RF_F1 = RFM ? RFM.computeRecentForm(PS_F1, {}) : null;
const RF_F2 = RFM ? RFM.computeRecentForm(PS_F2, {}) : null;
const RF_F3 = RFM ? RFM.computeRecentForm(PS_F3, {}) : null;
const RF_F4 = RFM ? RFM.computeRecentForm(PS_F4, {}) : null;
const RF_F5 = RFM ? RFM.computeRecentForm(PS_F5, {}) : null;
const RF_F6 = RFM ? RFM.computeRecentForm(PS_F6, {}) : null;
const RF_F7 = RFM ? RFM.computeRecentForm(PS_F7, {}) : null;
const RF_F8 = RFM ? RFM.computeRecentForm(PS_F8, {}) : null;
const RF_F9 = RFM ? RFM.computeRecentForm(PS_F9, {}) : null;
// selectedWindow = 10 on F1 → whole season in window → Baseline B suppressed.
const RF_F1W10 = RFM ? RFM.computeRecentForm(PS_F1, { selectedWindow: 10 }) : null;

// ===========================================================================
// RF-T1 — Last 3 appearance window
// ===========================================================================
{
  const w = RF_F1 && RF_F1.players['p8'].windows['3'];
  ok('RF-T1a last-3 included = 3', !!w && w.included === 3, JSON.stringify(w && w.included));
  eq('RF-T1b last-3 matchIndexes (season order)', w && w.matchIndexes, [3, 4, 5]);
  eq('RF-T1c last-3 recoveries total = 12+11+5 = 28', w && w.totals.recoveries, 28);
  eq('RF-T1d last-3 requested = 3', w && w.requested, 3);
  eq('RF-T1e last-3 available = 6', w && w.available, 6);
}

// ===========================================================================
// RF-T2 — Last 5 appearance window
// ===========================================================================
{
  const w = RF_F1 && RF_F1.players['p8'].windows['5'];
  eq('RF-T2a last-5 matchIndexes', w && w.matchIndexes, [1, 2, 3, 4, 5]);
  eq('RF-T2b last-5 recoveries total = 6+4+12+11+5 = 38', w && w.totals.recoveries, 38);
  eq('RF-T2c last-5 included = 5', w && w.included, 5);
  const w10f2 = RF_F2 && RF_F2.players['p8'].windows['5'];
  eq('RF-T2d F2 last-5 recoveries = 45', w10f2 && w10f2.totals.recoveries, 45);
}

// ===========================================================================
// RF-T3 — Last 10 appearance window
// ===========================================================================
{
  const w = RF_F2 && RF_F2.players['p8'].windows['10'];
  eq('RF-T3a F2 last-10 matchIndexes = all 10', w && w.matchIndexes, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  eq('RF-T3b F2 last-10 recoveries = 73', w && w.totals.recoveries, 73);
  eq('RF-T3c F2 last-10 included = 10', w && w.included, 10);
}

// ===========================================================================
// RF-T4 — Fewer-than-window handling (true sample, never padded)
// ===========================================================================
{
  const w = RF_F1 && RF_F1.players['p8'].windows['10'];
  eq('RF-T4a F1 last-10 included = 6 (true sample)', w && w.included, 6);
  eq('RF-T4b F1 last-10 available = 6', w && w.available, 6);
  eq('RF-T4c F1 last-10 requested = 10', w && w.requested, 10);
  eq('RF-T4d F1 last-10 matchIndexes = all 6', w && w.matchIndexes, [0, 1, 2, 3, 4, 5]);
  eq('RF-T4e no artificial zero records (records length = 6)', w && w.matchIndexes.length, 6);
}

// ===========================================================================
// RF-T5 — Unused substitute excluded from windows
// ===========================================================================
{
  const p = RF_F1 && RF_F1.players['p14'];
  ok('RF-T5a p14 (unused sub) present in players', !!p);
  eq('RF-T5b p14 appearancesTotal = 0', p && p.appearancesTotal, 0);
  const w = p && p.windows['5'];
  eq('RF-T5c p14 window included = 0', w && w.included, 0);
  eq('RF-T5d p14 window totals.recoveries = 0', w && w.totals.recoveries, 0);
  ok('RF-T5e p14 window excludedRecords non-empty (UNUSED_SUB reasons)',
    w && w.excludedRecords.length === 6 && w.excludedRecords.every((x) => x.reason === 'UNUSED_SUB'),
    JSON.stringify(w && w.excludedRecords));
  eq('RF-T5f p14 window dataQuality INSUFFICIENT', w && w.dataQuality.status, 'INSUFFICIENT');
}

// ===========================================================================
// RF-T6 — Recent totals equal the selected PS records (engine reuse)
// ===========================================================================
{
  const p8recs = PS_F1.playerMatchRecords.filter((r) => r.playerId === 'p8' && r.participation.appearance);
  const last5 = p8recs.slice(-5);
  const expected = {};
  ['events', 'goals', 'shots', 'shotsOnTarget', 'chances', 'keyPasses', 'crosses', 'passes',
    'successfulPasses', 'unsuccessfulPasses', 'passesUnknownOutcome', 'presses', 'pressWins',
    'interceptions', 'recoveries', 'turnovers', 'duels', 'fouls', 'yellowCards', 'redCards',
    'positiveEvents', 'negativeEvents', 'neutralEvents', 'transitionsPositive', 'transitionsNegative'
  ].forEach((k) => {
    expected[k] = last5.reduce((acc, r) => acc + (r.metrics[k] || 0), 0);
  });
  const w = RF_F1 && RF_F1.players['p8'].windows['5'];
  eq('RF-T6a window totals equal Σ selected PS record metrics (all 25 keys)', w && w.totals, expected);
  eq('RF-T6b PS p8 appearances = 6 (fixture sanity)', PS_F1.players['p8'].appearances, 6);
  eq('RF-T6c PS p8 season recoveries = 48 (fixture sanity)', PS_F1.players['p8'].totals.recoveries, 48);
}

// ===========================================================================
// RF-T7 — Recent averages use appearances (not selections, not requested)
// ===========================================================================
{
  const w = RF_F1 && RF_F1.players['p8'].windows['5'];
  eq('RF-T7a last-5 recoveries/appearance = 38/5 = 7.6', w && w.averagesPerAppearance.recoveries, 7.6);
  const w3 = RF_F1 && RF_F1.players['p8'].windows['3'];
  eq('RF-T7b last-3 recoveries/appearance = 28/3 = 9.3', w3 && w3.averagesPerAppearance.recoveries, 9.3);
  const p14 = RF_F1 && RF_F1.players['p14'];
  eq('RF-T7c unused-sub averages = null (no appearances)', p14 && p14.windows['5'].averagesPerAppearance.recoveries, null);
}

// ===========================================================================
// RF-T8 — Reliable-minute per-90 (Part 24 hand fixture)
// ===========================================================================
{
  const w = RF_F1 && RF_F1.players['p8'].windows['5'];
  const p90 = w && w.per90;
  eq('RF-T8a per-90 recoveries = 38/330×90 = 10.3636 → 10.4', p90 && p90.metrics.recoveries.value, 10.4);
  eq('RF-T8b per-90 restricted total = 38', p90 && p90.metrics.recoveries.total, 38);
  eq('RF-T8c reliableSeconds = 19800 (330 minutes)', p90 && p90.reliableSeconds, 19800);
  eq('RF-T8d appearances in window = 5', p90 && p90.appearancesInWindow, 5);
  eq('RF-T8e appearances included in per-90 = 5', p90 && p90.appearancesIncludedInPer90, 5);
  eq('RF-T8f minutesQuality = RELIABLE', p90 && p90.minutesQuality, 'RELIABLE');
  // exact unrounded basis check: 38 × 5400 / 19800 = 10.3636...
  ok('RF-T8g unrounded basis = 10.3636...', p90 && Math.abs((38 * 5400 / 19800) - 10.3636363636) < 1e-9);
}

// ===========================================================================
// RF-T9 — Estimated/unavailable minutes never a per-90 denominator
// ===========================================================================
{
  const w = RF_F7 && RF_F7.players['p8'].windows['5'];
  const p90 = w && w.per90;
  eq('RF-T9a F7 appearancesInWindow = 5', p90 && p90.appearancesInWindow, 5);
  eq('RF-T9b F7 appearancesIncludedInPer90 = 3 (M1, M4, M5 only)', p90 && p90.appearancesIncludedInPer90, 3);
  eq('RF-T9c F7 reliableSeconds = 16200', p90 && p90.reliableSeconds, 16200);
  eq('RF-T9d F7 per-90 recoveries = 33/270×90 = 11.0', p90 && p90.metrics.recoveries.value, 11);
  eq('RF-T9e F7 restricted total = 33', p90 && p90.metrics.recoveries.total, 33);
  eq('RF-T9f F7 minutesQuality = MIXED', p90 && p90.minutesQuality, 'MIXED');
  const recs = PS_F7.playerMatchRecords.filter((r) => r.playerId === 'p8');
  eq('RF-T9g fixture sanity: M2 minutes ESTIMATED', recs[1].minutes.quality, 'ESTIMATED');
  eq('RF-T9h fixture sanity: M3 minutes UNAVAILABLE', recs[2].minutes.quality, 'UNAVAILABLE');
  eq('RF-T9i fixture sanity: M1/M4/M5 RELIABLE', [recs[0].minutes.quality, recs[3].minutes.quality, recs[4].minutes.quality], ['RELIABLE', 'RELIABLE', 'RELIABLE']);
}

// ===========================================================================
// RF-T10 — Pooled percentage (4/5 + 10/20 = 14/25 = 56%)
// ===========================================================================
{
  const w = RF_F8 && RF_F8.players['p8'].windows['3'];
  const ps = w && w.percentages.passSuccess;
  eq('RF-T10a pooled passSuccess value = 56', ps && ps.value, 56);
  eq('RF-T10b pooled num = 14', ps && ps.num, 14);
  eq('RF-T10c pooled den = 25', ps && ps.den, 25);
  ok('RF-T10d pooled value is NOT the mean-of-percentages 65', ps && ps.value !== 65);
}

// ===========================================================================
// RF-T11 — Full-season baseline (consumed from PS, not recomputed)
// ===========================================================================
{
  const cmp = RF_F1 && RF_F1.players['p8'].comparisons['5'].vsBaselineA;
  eq('RF-T11a baseline A recoveries = PS season total 48', cmp && cmp.counts.recoveries.baselineValue, 48);
  eq('RF-T11b baseline A value equals PS.players.totals (consumed)',
    cmp && cmp.counts.recoveries.baselineValue, PS_F1.players['p8'].totals.recoveries);
  const cmpP90 = cmp && cmp.per90.recoveries;
  eq('RF-T11c baseline A per-90 equals PS per-90 value (consumed)',
    cmpP90 && cmpP90.baselineValue, PS_F1.players['p8'].per90.metrics.recoveries.value);
  eq('RF-T11d baseline A per-90 = 48/420×90 = 10.3', cmpP90 && cmpP90.baselineValue, 10.3);
  const teamCmp = RF_F1 && RF_F1.team.comparisons['3'].vsBaselineA;
  eq('RF-T11e team baseline A wins = PS.teamSeason.wins (consumed)', teamCmp && teamCmp.results.wins.baselineValue, PS_F1.teamSeason.wins);
  eq('RF-T11f team baseline A our goals = 6 (consumed)', teamCmp && teamCmp.our.goals.baselineValue, PS_F1.teamSeason.totals.our.goals);
}

// ===========================================================================
// RF-T12 — Season-excluding-window baseline (Baseline B)
// ===========================================================================
{
  const cmpB = RF_F1 && RF_F1.players['p8'].comparisons['5'].vsBaselineB;
  ok('RF-T12a Baseline B present for selected window 5', !!cmpB);
  eq('RF-T12b Baseline B recoveries = M1 only = 10', cmpB && cmpB.counts.recoveries.baselineValue, 10);
  eq('RF-T12c Baseline B per-90 = 10/90×90 = 10.0', cmpB && cmpB.per90.recoveries.baselineValue, 10);
  const teamB = RF_F1 && RF_F1.team.comparisons['5'].vsBaselineB;
  ok('RF-T12d team Baseline B present', !!teamB);
  // window 5 = M2..M6 → B = M1 (W 1-0): wins 1, GF 1, GA 0
  eq('RF-T12e team Baseline B wins = 1', teamB && teamB.results.wins.baselineValue, 1);
  eq('RF-T12f team Baseline B goalsFor = 1', teamB && teamB.results.goalsFor.baselineValue, 1);
}

// ===========================================================================
// RF-T13 — Baseline reconciliation (window + B = full season, additive)
// ===========================================================================
{
  const cmpA = RF_F1 && RF_F1.players['p8'].comparisons['5'].vsBaselineA;
  const cmpB = RF_F1 && RF_F1.players['p8'].comparisons['5'].vsBaselineB;
  ok('RF-T13a 38 + 10 = 48 (recoveries)', !!cmpA && !!cmpB &&
    ((cmpA.counts.recoveries.recentValue || 0) + (cmpB.counts.recoveries.baselineValue || 0)) === 48);
  const win = RF_F1 && RF_F1.players['p8'].windows['5'];
  const winEvents = win && win.totals.events;
  const bEvents = cmpB && cmpB.counts.events.baselineValue;
  eq('RF-T13b window events + B events = PS season events', (winEvents || 0) + (bEvents || 0), PS_F1.players['p8'].totals.events);
  // envelope num/den reconciliation (F2: full 10-appearance split)
  const wA = RF_F2 && RF_F2.players['p8'].comparisons['5'].vsBaselineA;
  const wB = RF_F2 && RF_F2.players['p8'].comparisons['5'].vsBaselineB;
  ok('RF-T13c F2: recent5 45 + B 28 = 73 season recoveries', !!wA && !!wB &&
    ((wA.counts.recoveries.recentValue || 0) + (wB.counts.recoveries.baselineValue || 0)) === 73);
}

// ===========================================================================
// RF-T14 — Recent-vs-baseline difference (F1 window 5 vs A: 38 vs 48)
// ===========================================================================
{
  const c = RF_F1 && RF_F1.players['p8'].comparisons['5'].vsBaselineA.counts.recoveries;
  eq('RF-T14a recentValue = 38', c && c.recentValue, 38);
  eq('RF-T14b baselineValue = 48', c && c.baselineValue, 48);
  eq('RF-T14c absoluteDifference = -10', c && c.absoluteDifference, -10);
  eq('RF-T14d percentageDifference = -20.8', c && c.percentageDifference, -20.8);
  eq('RF-T14e recentSample = 5 (included)', c && c.recentSample, 5);
  eq('RF-T14f tolerance = max(1, 0.1×48) = 4.8', c && c.tolerance, 4.8);
  eq('RF-T14g toleranceRule = MAX_1_OR_10PCT_BASELINE', c && c.toleranceRule, 'MAX_1_OR_10PCT_BASELINE');
}

// ===========================================================================
// RF-T15 — Tolerance classification (boundary inclusive)
// ===========================================================================
{
  const c = RF_F1 && RF_F1.players['p8'].comparisons['5'].vsBaselineA.counts.recoveries;
  eq('RF-T15a |−10| > 4.8 → LOWER', c && c.classification, 'LOWER');
  const p = RF_F9 && RF_F9.players['p8'].comparisons['3'].vsBaselineA.percentages.passSuccess;
  eq('RF-T15b F9 boundary: recent = 15 (9/60)', p && p.recentValue, 15);
  eq('RF-T15c F9 boundary: baseline = 10 (9/90)', p && p.baselineValue, 10);
  eq('RF-T15d F9 diff = 5.0 pp', p && p.absoluteDifference, 5);
  eq('RF-T15e F9 tolerance = 5.0 (FIXED_5PP)', p && p.tolerance, 5);
  eq('RF-T15f F9 |5.0| ≤ 5.0 → WITHIN-TOLERANCE (inclusive)', p && p.classification, 'WITHIN-TOLERANCE');
  eq('RF-T15g F9 boundary convention INCLUSIVE', p && p.boundary, 'INCLUSIVE');
}

// ===========================================================================
// RF-T16 — Recent 5 vs Previous 5 (structure + hand math)
// ===========================================================================
{
  const r = RF_F2 && RF_F2.players['p8'].recentVsPrevious5;
  eq('RF-T16a eligibility = COMPARISON (10 appearances)', r && r.eligibility, 'COMPARISON');
  eq('RF-T16b appearancesTotal = 10', r && r.appearancesTotal, 10);
  eq('RF-T16c recent5 recoveries = 45', r && r.recent5.totals.recoveries, 45);
  eq('RF-T16d previous5 recoveries = 28', r && r.previous5.totals.recoveries, 28);
  eq('RF-T16e recent5 matchIndexes = [5..9]', r && r.recent5.matchIndexes, [5, 6, 7, 8, 9]);
  eq('RF-T16f previous5 matchIndexes = [0..4]', r && r.previous5.matchIndexes, [0, 1, 2, 3, 4]);
  const c = r && r.comparisons.per90.recoveries;
  eq('RF-T16g per-90 recent = 9.0', c && c.recentValue, 9);
  eq('RF-T16h per-90 previous = 5.6', c && c.baselineValue, 5.6);
  eq('RF-T16i difference = 3.4', c && c.absoluteDifference, 3.4);
  eq('RF-T16j tolerance = max(1, 0.56) = 1', c && c.tolerance, 1);
  eq('RF-T16k classification = HIGHER', c && c.classification, 'HIGHER');
  eq('RF-T16l percentageDifference = 60.7', c && c.percentageDifference, 60.7);
}

// ===========================================================================
// RF-T17 — Previous 5 suppressed below 10 appearances
// ===========================================================================
{
  const r = RF_F1 && RF_F1.players['p8'].recentVsPrevious5;
  eq('RF-T17a eligibility = INCONCLUSIVE (6 appearances)', r && r.eligibility, 'INCONCLUSIVE');
  eq('RF-T17b real sample size shown (6)', r && r.appearancesTotal, 6);
  eq('RF-T17c previous5 = null (never fabricated)', r && r.previous5, null);
  eq('RF-T17d comparisons = null', r && r.comparisons, null);
  eq('RF-T17e reason = INSUFFICIENT_APPEARANCES', r && r.reason, 'INSUFFICIENT_APPEARANCES');
  eq('RF-T17f recent5 still displays (38 recoveries)', r && r.recent5.totals.recoveries, 38);
}

// ===========================================================================
// RF-T18 — Variability min/max/range/mean/median
// ===========================================================================
{
  const v5 = RF_F1 && RF_F1.players['p8'].variability['5'].recoveries;
  eq('RF-T18a F1 window-5 min = 4', v5 && v5.min, 4);
  eq('RF-T18b F1 window-5 max = 12', v5 && v5.max, 12);
  eq('RF-T18c F1 window-5 range = 8', v5 && v5.range, 8);
  eq('RF-T18d F1 window-5 mean = 7.6', v5 && v5.mean, 7.6);
  eq('RF-T18e F1 window-5 median = 6 (odd n)', v5 && v5.median, 6);
  const v10 = RF_F2 && RF_F2.players['p8'].variability['10'].recoveries;
  eq('RF-T18f F2 window-10 median = 7.5 (even n: (7+8)/2)', v10 && v10.median, 7.5);
  eq('RF-T18g F2 window-10 min = 4, max = 10, range = 6', v10 && [v10.min, v10.max, v10.range], [4, 10, 6]);
  eq('RF-T18h F2 window-10 mean = 7.3', v10 && v10.mean, 7.3);
  const v3 = RF_F1 && RF_F1.players['p8'].variability['3'].recoveries;
  eq('RF-T18i F1 window-3 series [12,11,5]: min 5 max 12 range 7 mean 9.3 median 11',
    v3 && [v3.min, v3.max, v3.range, v3.mean, v3.median], [5, 12, 7, 9.3, 11]);
  const p14v = RF_F1 && RF_F1.players['p14'].variability['5'].recoveries;
  eq('RF-T18j empty window variability = null everywhere', p14v && [p14v.min, p14v.max, p14v.range, p14v.mean, p14v.median, p14v.matches], [null, null, null, null, null, 0]);
}

// ===========================================================================
// RF-T19 — With-player group
// ===========================================================================
{
  const ww = RF_F4 && RF_F4.players['p14'].withWithout;
  eq('RF-T19a WITH matches = 5', ww && ww.with.matches, 5);
  eq('RF-T19b WITH wins = 5 (all W 2-0)', ww && ww.with.wins, 5);
  eq('RF-T19c WITH draws = 0', ww && ww.with.draws, 0);
  eq('RF-T19d WITH losses = 0', ww && ww.with.losses, 0);
  eq('RF-T19e WITH goalsFor = 10', ww && ww.with.goalsFor, 10);
  eq('RF-T19f WITH goalsAgainst = 0', ww && ww.with.goalsAgainst, 0);
}

// ===========================================================================
// RF-T20 — Without-player group
// ===========================================================================
{
  const ww = RF_F4 && RF_F4.players['p14'].withWithout;
  eq('RF-T20a WITHOUT matches = 3', ww && ww.without.matches, 3);
  eq('RF-T20b WITHOUT wins = 0, draws = 0, losses = 3', ww && [ww.without.wins, ww.without.draws, ww.without.losses], [0, 0, 3]);
  eq('RF-T20c WITHOUT goalsFor = 0', ww && ww.without.goalsFor, 0);
  eq('RF-T20d WITHOUT goalsAgainst = 6', ww && ww.without.goalsAgainst, 6);
  ok('RF-T20e WITHOUT our-team totals present (31 keys)',
    ww && ww.without.totals && Object.keys(ww.without.totals).length === 31, JSON.stringify(ww && ww.without.totals && Object.keys(ww.without.totals).length));
}

// ===========================================================================
// RF-T21 — Unused substitute is NOT WITH
// ===========================================================================
{
  const ww = RF_F1 && RF_F1.players['p14'].withWithout;
  eq('RF-T21a p14 WITH matches = 0', ww && ww.with.matches, 0);
  eq('RF-T21b p14 WITHOUT matches = 6 (completed)', ww && ww.without.matches, 6);
  const ww8 = RF_F1 && RF_F1.players['p8'].withWithout;
  eq('RF-T21c p8 WITH matches = 6 (every appearance is WITH)', ww8 && ww8.with.matches, 6);
}

// ===========================================================================
// RF-T22 — With/without 3v3 eligibility
// ===========================================================================
{
  const ww = RF_F4 && RF_F4.players['p14'].withWithout;
  eq('RF-T22a 5v3 → status COMPARISON', ww && ww.status, 'COMPARISON');
  ok('RF-T22b comparisons present when eligible', ww && !!ww.comparisons);
  const g = ww && ww.comparisons.goalsFor;
  eq('RF-T22c goalsFor per-match WITH = 2.0', g && g.withValue, 2);
  eq('RF-T22d goalsFor per-match WITHOUT = 0.0', g && g.withoutValue, 0);
  eq('RF-T22e goalsFor difference = 2.0', g && g.difference, 2);
  eq('RF-T22f goalsFor tolerance = max(1, 0) = 1', g && g.tolerance, 1);
  eq('RF-T22g goalsFor classification = HIGHER', g && g.classification, 'HIGHER');
  const ga = ww && ww.comparisons.goalsAgainst;
  eq('RF-T22h goalsAgainst WITH 0.0 vs WITHOUT 2.0 → LOWER', ga && ga.classification, 'LOWER');
  ok('RF-T22i comparison basis documented (PER_MATCH_AVERAGE)', ww && ww.comparisonBasis === 'PER_MATCH_AVERAGE');
  ok('RF-T22j observational standing note present',
    ww && typeof ww.standingNote === 'string' && ww.standingNote.indexOf('no causal claim') !== -1);
}

// ===========================================================================
// RF-T23 — Below-3 comparison suppressed (sizes still visible)
// ===========================================================================
{
  const ww = RF_F5 && RF_F5.players['p14'].withWithout;
  eq('RF-T23a 5v2 → status INSUFFICIENT_SAMPLE', ww && ww.status, 'INSUFFICIENT_SAMPLE');
  eq('RF-T23b WITH size still visible = 5', ww && ww.with.matches, 5);
  eq('RF-T23c WITHOUT size still visible = 2', ww && ww.without.matches, 2);
  eq('RF-T23d comparisons suppressed (null)', ww && ww.comparisons, null);
  eq('RF-T23e group data still displayed (WITHOUT losses = 2)', ww && ww.without.losses, 2);
  eq('RF-T23f WITH goalsFor still displayed = 10', ww && ww.with.goalsFor, 10);
}

// ===========================================================================
// RF-T24 — Team Last 3/5/10 windows
// ===========================================================================
{
  const t = RF_F1 && RF_F1.team;
  eq('RF-T24a team completedMatchesTotal = 6', t && t.completedMatchesTotal, 6);
  const w3 = t && t.windows['3'];
  eq('RF-T24b team window-3 matchIndexes = [3,4,5]', w3 && w3.matchIndexes, [3, 4, 5]);
  eq('RF-T24c team window-3 W/D/L = 2/0/1', w3 && [w3.results.wins, w3.results.draws, w3.results.losses], [2, 0, 1]);
  eq('RF-T24d team window-3 goalsFor = 4, goalsAgainst = 3', w3 && [w3.goalsFor, w3.goalsAgainst], [4, 3]);
  const w5 = t && t.windows['5'];
  eq('RF-T24e team window-5 matchIndexes = [1..5]', w5 && w5.matchIndexes, [1, 2, 3, 4, 5]);
  eq('RF-T24f team window-5 W/D/L = 2/1/2', w5 && [w5.results.wins, w5.results.draws, w5.results.losses], [2, 1, 2]);
  eq('RF-T24g team window-5 GF/GA = 5/5', w5 && [w5.goalsFor, w5.goalsAgainst], [5, 5]);
  const w10 = t && t.windows['10'];
  eq('RF-T24h team window-10 included = 6 (true sample)', w10 && w10.included, 6);
  eq('RF-T24i team window-10 W/D/L = 3/1/2', w10 && [w10.results.wins, w10.results.draws, w10.results.losses], [3, 1, 2]);
  eq('RF-T24j team window-3 our goals total = 4', w3 && w3.totals.our.goals, 4);
  eq('RF-T24k team window-3 opponent goals total = 3', w3 && w3.totals.opponent.goals, 3);
  eq('RF-T24l team window-5 averagesPerMatch our goals = 1.0', w5 && w5.averagesPerMatch.our.goals, 1);
}

// ===========================================================================
// RF-T25 — Duplicate exclusion (no inflation)
// ===========================================================================
{
  eq('RF-T25a PS excluded the duplicate session', PS_F6.input.duplicateSessions.length, 1);
  eq('RF-T25b player totals unchanged (48 recoveries)', RF_F6 && RF_F6.players['p8'].windows['10'].totals.recoveries, 48);
  eq('RF-T25c team window-3 unchanged (W2 L1)', RF_F6 && RF_F6.team.windows['3'].results.wins === 2 && RF_F6.team.windows['3'].results.losses === 1, true);
  eq('RF-T25d team totals.our.goals unchanged', RF_F6 && RF_F6.team.windows['10'].totals.our.goals, RF_F1 && RF_F1.team.windows['10'].totals.our.goals);
  ok('RF-T25e duplicate exclusion flagged in propagated data quality',
    RF_F6 && RF_F6.dataQuality.propagatedFlags.indexOf('DUPLICATE_SESSIONS_EXCLUDED') !== -1,
    JSON.stringify(RF_F6 && RF_F6.dataQuality.propagatedFlags));
}

// ===========================================================================
// RF-T26 — Data-quality propagation
// ===========================================================================
{
  const w = RF_F3 && RF_F3.players['p8'].windows['3'];
  eq('RF-T26a F3 p8 window-3 status = PARTIAL (X1 match included)', w && w.dataQuality.status, 'PARTIAL');
  ok('RF-T26b INCONSISTENT_GOAL_CHAIN propagated to window flags',
    w && w.dataQuality.flags.indexOf('INCONSISTENT_GOAL_CHAIN') !== -1, JSON.stringify(w && w.dataQuality.flags));
  const w7 = RF_F7 && RF_F7.players['p8'].windows['5'];
  ok('RF-T26c UNRELIABLE_MINUTES propagated (F7 mixed quality)',
    w7 && w7.dataQuality.flags.indexOf('UNRELIABLE_MINUTES') !== -1, JSON.stringify(w7 && w7.dataQuality.flags));
  ok('RF-T26d MISSING_SUB_INFO propagated (F7 un-timed sub)',
    w7 && w7.dataQuality.flags.indexOf('MISSING_SUB_INFO') !== -1);
  eq('RF-T26e F7 window status = PARTIAL', w7 && w7.dataQuality.status, 'PARTIAL');
  const p14 = RF_F1 && RF_F1.players['p14'].windows['5'];
  eq('RF-T26f empty window = INSUFFICIENT', p14 && p14.dataQuality.status, 'INSUFFICIENT');
}

// ===========================================================================
// RF-T27 — Spatial reconciliation with PS (window = Σ per-record grids)
// ===========================================================================
{
  const w = RF_F1 && RF_F1.players['p8'].windows['5'];
  const recs = PS_F1.playerMatchRecords.filter((r) => r.playerId === 'p8' && r.participation.appearance).slice(-5);
  const expLocated = recs.reduce((a, r) => a + r.spatial.located, 0);
  const expUnlocated = recs.reduce((a, r) => a + r.spatial.unlocated, 0);
  const expZones = {};
  Object.keys(recs[0].spatial.zones).forEach((z) => { expZones[z] = recs.reduce((a, r) => a + r.spatial.zones[z], 0); });
  const expThirds = {};
  Object.keys(recs[0].spatial.thirds).forEach((t) => { expThirds[t] = recs.reduce((a, r) => a + r.spatial.thirds[t], 0); });
  const expChannels = {};
  Object.keys(recs[0].spatial.channels).forEach((c) => { expChannels[c] = recs.reduce((a, r) => a + r.spatial.channels[c], 0); });
  eq('RF-T27a window located = Σ records', w && w.spatial.located, expLocated);
  eq('RF-T27b window unlocated = Σ records', w && w.spatial.unlocated, expUnlocated);
  eq('RF-T27c window zones = Σ records (9 keys)', w && w.spatial.zones, expZones);
  eq('RF-T27d window thirds = Σ records (3 keys)', w && w.spatial.thirds, expThirds);
  eq('RF-T27e window channels = Σ records (3 keys)', w && w.spatial.channels, expChannels);
  eq('RF-T27f window locatedShare = pooled envelope', w && w.spatial.locatedShare.num, expLocated);
  eq('RF-T27g window locatedShare den', w && w.spatial.locatedShare.den, expLocated + expUnlocated);
  ok('RF-T27h fixture has located events (non-trivial check)', expLocated > 0);
}

// ===========================================================================
// RF-T28 — Game-state propagation (WINNING/DRAW/LOSING, X1 suppression)
// ===========================================================================
{
  const w = RF_F3 && RF_F3.players['p8'].windows['3'];
  const recs = PS_F3.playerMatchRecords.filter((r) => r.playerId === 'p8');
  const suppressed = recs.filter((r) => !r.gameState).length;
  eq('RF-T28a suppressed matches count propagates (1 = M2)', w && w.gameStateSuppressedMatches, suppressed);
  eq('RF-T28b fixture sanity: exactly 1 suppressed record', suppressed, 1);
  ok('RF-T28c gameState block present (not all suppressed)', !!w && !!w.gameState);
  const expWinning = recs.reduce((a, r) => a + (r.gameState ? r.gameState.WINNING.events : 0), 0);
  const expDraw = recs.reduce((a, r) => a + (r.gameState ? r.gameState.DRAW.events : 0), 0);
  eq('RF-T28d WINNING events = Σ non-suppressed records', w && w.gameState.WINNING.events, expWinning);
  eq('RF-T28e DRAW events = Σ non-suppressed records', w && w.gameState.DRAW.events, expDraw);
  eq('RF-T28f WINNING/DRAW/LOSING vocabulary (keys)', w && Object.keys(w.gameState).sort(), ['DRAW', 'LOSING', 'WINNING']);
  eq('RF-T28g hand check: WINNING events = 5 (2+3 post-goal)', w && w.gameState.WINNING.events, 5);
  eq('RF-T28h hand check: DRAW events = 4 (2+2 pre-goal)', w && w.gameState.DRAW.events, 4);
  // result vs state are separate constructs
  const t = RF_F3 && RF_F3.team;
  eq('RF-T28i team match result W/D/L separate from state keys',
    t && [t.windows['3'].results.wins, t.windows['3'].results.draws, t.windows['3'].results.losses], [2, 0, 0]);
  eq('RF-T28j X1-MISMATCH match excluded from team windows with reason',
    t && t.windows['3'].excludedMatches.length === 1 && /INCONSISTENT_GOAL_CHAIN/.test(t.windows['3'].excludedMatches[0].reason),
    true);
}

// ===========================================================================
// RF-T29 — Determinism (identical output for identical input)
// ===========================================================================
{
  const a = RFM ? RFM.computeRecentForm(PS_F2, {}) : null;
  const b = RFM ? RFM.computeRecentForm(deepClone(PS_F2), {}) : null;
  ok('RF-T29a double-run byte-identical', !!a && !!b && JSON.stringify(a) === JSON.stringify(b));
  const a1 = RFM ? RFM.computeRecentForm(PS_F1, { selectedWindow: 10 }) : null;
  const b1 = RFM ? RFM.computeRecentForm(deepClone(PS_F1), { selectedWindow: 10 }) : null;
  ok('RF-T29b options-dependent run also deterministic', !!a1 && !!b1 && JSON.stringify(a1) === JSON.stringify(b1));
}

// ===========================================================================
// RF-T30 — Input immutability (PS not mutated)
// ===========================================================================
{
  const before = deepClone(PS_F2);
  if (RFM) { RFM.computeRecentForm(PS_F2, {}); }
  ok('RF-T30a PS deep-equal before/after computeRecentForm', JSON.stringify(before) === JSON.stringify(PS_F2));
  const beforeF7 = deepClone(PS_F7);
  if (RFM) { RFM.computeRecentForm(PS_F7, { selectedWindow: 3 }); }
  ok('RF-T30b PS_F7 untouched (options path)', JSON.stringify(beforeF7) === JSON.stringify(PS_F7));
}

// ===========================================================================
// RF-T31 — Player identity stability (name change ≠ second player)
// ===========================================================================
{
  ok('RF-T31a p8 present exactly once (by playerId)', RF_F2 && !!RF_F2.players['p8']);
  eq('RF-T31b p8 appearancesTotal = 10 across both names', RF_F2 && RF_F2.players['p8'].appearancesTotal, 10);
  eq('RF-T31c p8 season totals span both names (73 recoveries)', RF_F2 && RF_F2.players['p8'].windows['10'].totals.recoveries, 73);
  eq('RF-T31d canonical name = most recent variant', RF_F2 && RF_F2.players['p8'].name, 'Mohammed Ahmed');
  ok('RF-T31e identity drift flagged via PS identityAudit reuse',
    RF_F2 && RF_F2.dataQuality.propagatedFlags.indexOf('IDENTITY_DRIFT') !== -1,
    JSON.stringify(RF_F2 && RF_F2.dataQuality.propagatedFlags));
  eq('RF-T31f fixture sanity: PS flags name drift', PS_F2.identityAudit.drift.length >= 1, true);
}

// ===========================================================================
// RF-T32 — 10+ appearance Recent5-vs-Previous5 valid case (Part 25)
// ===========================================================================
{
  const r = RF_F2 && RF_F2.players['p8'].recentVsPrevious5;
  const counts = r && r.comparisons.counts.recoveries;
  eq('RF-T32a counts recent 45 vs previous 28', counts && [counts.recentValue, counts.baselineValue], [45, 28]);
  eq('RF-T32b counts difference = 17', counts && counts.absoluteDifference, 17);
  eq('RF-T32c counts tolerance = max(1, 2.8) = 2.8', counts && counts.tolerance, 2.8);
  eq('RF-T32d counts classification = HIGHER', counts && counts.classification, 'HIGHER');
  eq('RF-T32e previous5 per-90 = 5.6 (28/450×90)', r && r.previous5.per90.metrics.recoveries.value, 5.6);
  eq('RF-T32f recent5 per-90 = 9.0 (45/450×90)', r && r.recent5.per90.metrics.recoveries.value, 9);
  eq('RF-T32g recent5 appearances = 5, previous5 = 5', r && [r.recent5.included, r.previous5.included], [5, 5]);
}

// ===========================================================================
// RF-T33 — Mixed reliable/unavailable-minute case
// ===========================================================================
{
  const w = RF_F7 && RF_F7.players['p8'].windows['5'];
  eq('RF-T33a window appearances = 5 (unavailable-minute appearance retained)', w && w.per90.appearancesInWindow, 5);
  eq('RF-T33b per-90 uses only the reliable subset (3)', w && w.per90.appearancesIncludedInPer90, 3);
  eq('RF-T33c reliable minutes = 16200s (270 minutes)', w && w.per90.reliableSeconds, 16200);
  eq('RF-T33d window totals still count all 5 appearances (43 recoveries)', w && w.totals.recoveries, 43);
  eq('RF-T33e averages over 5 appearances = 8.6', w && w.averagesPerAppearance.recoveries, 8.6);
}

// ===========================================================================
// RF-T34 — Whole-season-in-window baseline suppression
// ===========================================================================
{
  const cmpB = RF_F1W10 && RF_F1W10.players['p8'].comparisons['10'].vsBaselineB;
  ok('RF-T34a Baseline B suppressed for whole-season window', !!cmpB);
  eq('RF-T34b baselineValue = null (never fabricated)', cmpB && cmpB.counts.recoveries.baselineValue, null);
  eq('RF-T34c reason = WHOLE_SEASON_IN_WINDOW', cmpB && cmpB.counts.recoveries.reason, 'WHOLE_SEASON_IN_WINDOW');
  eq('RF-T34d classification = INCONCLUSIVE', cmpB && cmpB.counts.recoveries.classification, 'INCONCLUSIVE');
  const b8 = RF_F8 && RF_F8.players['p8'].comparisons['5'].vsBaselineB;
  eq('RF-T34e F8 (2 appearances, window 5) also suppressed', b8 && b8.counts.recoveries.reason, 'WHOLE_SEASON_IN_WINDOW');
  ok('RF-T34f Baseline A still reported for the same window',
    RF_F1W10 && RF_F1W10.players['p8'].comparisons['10'].vsBaselineA.counts.recoveries.baselineValue === 48);
}

// ===========================================================================
// RF-T35 — Unequal ratio denominators (pooling, never averaging)
// ===========================================================================
{
  const ps3 = RF_F8 && RF_F8.players['p8'].windows['3'].percentages.passSuccess;
  eq('RF-T35a unequal den(5 vs 20) pooled: num 14', ps3 && ps3.num, 14);
  eq('RF-T35b pooled den 25', ps3 && ps3.den, 25);
  eq('RF-T35c pooled value 56 (not the 65 average)', ps3 && ps3.value, 56);
  const r5 = RF_F8 && RF_F8.players['p8'].recentVsPrevious5;
  eq('RF-T35d eligibility INCONCLUSIVE (2 < 10 appearances)', r5 && r5.eligibility, 'INCONCLUSIVE');
}

// ===========================================================================
// Task Part 28 — property / invariant checks
// ===========================================================================

// #3 Window ordering: windows follow the PS deterministic order
{
  const w = RF_F2 && RF_F2.players['p8'].windows['10'];
  ok('INV-3a window matchIndexes ascending (season order)', w && w.matchIndexes.every((v, i, arr) => i === 0 || arr[i - 1] < v));
  const t = RF_F1 && RF_F1.team.windows['5'];
  ok('INV-3b team window matchIndexes ascending', t && t.matchIndexes.every((v, i, arr) => i === 0 || arr[i - 1] < v));
}

// #4 Additive baseline reconciliation over every count key (F1, window 5)
{
  const A = RF_F1 && RF_F1.players['p8'].comparisons['5'].vsBaselineA;
  const B = RF_F1 && RF_F1.players['p8'].comparisons['5'].vsBaselineB;
  let allOk = false, bad = '';
  if (A && B) {
    allOk = true;
    Object.keys(A.counts).forEach((k) => {
      const sum = (A.counts[k].recentValue || 0) + (B.counts[k].baselineValue || 0);
      if (sum !== PS_F1.players['p8'].totals[k]) { allOk = false; bad = k; }
    });
  }
  ok('INV-4a window + B = season for ALL 25 count keys', allOk, 'mismatch at ' + bad);
  const teamA = RF_F1 && RF_F1.team.comparisons['5'].vsBaselineA;
  const teamB = RF_F1 && RF_F1.team.comparisons['5'].vsBaselineB;
  eq('INV-4b team window-5 wins + B wins = season wins (2+1=3)',
    ((teamA && teamA.results.wins.recentValue) || 0) + ((teamB && teamB.results.wins.baselineValue) || 0), 3);
  eq('INV-4c team window-5 our goals + B = season (5+1=6)',
    ((teamA && teamA.our.goals.recentValue) || 0) + ((teamB && teamB.our.goals.baselineValue) || 0), 6);
}

// #6 Ratio numerator/denominator preservation (envelopes keep num/den)
{
  const ps = RF_F8 && RF_F8.players['p8'].windows['3'].percentages;
  ok('INV-6a passSuccess envelope carries num+den', ps && typeof ps.passSuccess.num === 'number' && typeof ps.passSuccess.den === 'number');
  ok('INV-6b pressWinRatio envelope carries num+den', ps && typeof ps.pressWinRatio.num === 'number' && typeof ps.pressWinRatio.den === 'number');
  ok('INV-6c locatedShare envelope carries num+den', ps && typeof ps.locatedShare.num === 'number' && typeof ps.locatedShare.den === 'number');
}

// #8 Reliable-minute denominator integrity (F7)
{
  const p90 = RF_F7 && RF_F7.players['p8'].windows['5'].per90;
  ok('INV-8a per-90 denominator = reliable seconds only (16200)', p90 && p90.reliableSeconds === 16200);
  ok('INV-8b per-90 included = 3 (estimated/unavailable excluded)', p90 && p90.appearancesIncludedInPer90 === 3);
  const recs = PS_F7.playerMatchRecords.filter((r) => r.playerId === 'p8');
  const reliableSeconds = recs.filter((r) => r.minutes.quality === 'RELIABLE').reduce((a, r) => a + r.minutes.secondsExact, 0);
  eq('INV-8c matches Σ PS reliable seconds exactly', p90 && p90.reliableSeconds, reliableSeconds);
}

// #9 No unsupported metrics appear (window totals keys = the 25-key RF vocabulary)
{
  const EXPECTED_KEYS = ['events', 'goals', 'shots', 'shotsOnTarget', 'chances', 'keyPasses', 'crosses', 'passes',
    'successfulPasses', 'unsuccessfulPasses', 'passesUnknownOutcome', 'presses', 'pressWins', 'interceptions',
    'recoveries', 'turnovers', 'duels', 'fouls', 'yellowCards', 'redCards', 'positiveEvents', 'negativeEvents',
    'neutralEvents', 'transitionsPositive', 'transitionsNegative'].sort();
  const w = RF_F1 && RF_F1.players['p8'].windows['5'];
  eq('INV-9a player window totals keys = RF count vocabulary (no invented metrics)', w && Object.keys(w.totals).sort(), EXPECTED_KEYS);
  const p90 = w && w.per90.metrics;
  eq('INV-9b per-90 keys = PS PER90 vocabulary (17)', p90 && Object.keys(p90).length, 17);
  const tw = RF_F1 && RF_F1.team.windows['3'];
  eq('INV-9c team totals our keys = 31 (PS team vocabulary)', tw && Object.keys(tw.totals.our).length, 31);
}

// #10 No banned classification values anywhere in the output
{
  const ALLOWED = ['HIGHER', 'LOWER', 'WITHIN-TOLERANCE', 'INCONCLUSIVE'];
  const seen = [];
  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (Object.prototype.hasOwnProperty.call(node, 'classification')) seen.push(node.classification);
    Object.keys(node).forEach((k) => walk(node[k]));
  })(RF_F2);
  const bad = seen.filter((c) => ALLOWED.indexOf(c) === -1);
  ok('INV-10a all classifications ∈ {HIGHER, LOWER, WITHIN-TOLERANCE, INCONCLUSIVE}', bad.length === 0, JSON.stringify(bad));
  ok('INV-10b classifications actually occur (non-empty)', seen.length > 0);
}

// Forbidden user-facing language sweep over the serialized output
{
  const blob = JSON.stringify(RF_F2) + JSON.stringify(RF_F4) + JSON.stringify(RF_F7);
  const banned = ['Form Score', 'Performance Score', 'Player Rating', 'Consistency Score', 'Improving', 'Declining',
    'In Form', 'Out of Form', 'Momentum', 'Confidence', 'Sharpness', 'improving', 'declining', 'good form', 'bad form',
    'consistency index', 'form score', 'performance index', 'streak'];
  const found = banned.filter((w) => blob.indexOf(w) !== -1);
  eq('INV-LANG banned language absent from output', found, []);
}

// Output contract structure (task Part 20 / spec §30)
{
  const rf = RF_F1;
  const TOP = ['spec', 'engine', 'input', 'players', 'playerOrder', 'team', 'dataQuality', 'protocol'].sort();
  eq('OC-1 RF top-level contract keys', rf && Object.keys(rf).sort(), TOP);
  eq('OC-2 spec id', rf && rf.spec, 'PitchLog-RECENT-FORM-SPEC-v1.0-reestablished');
  ok('OC-3 engine metadata (version + deterministic + ps link)',
    rf && rf.engine.version && rf.engine.deterministic === true && rf.engine.psEngineVersion === '1.0.0');
  eq('OC-4 playerOrder reuses PS order verbatim', rf && rf.playerOrder, PS_F1.playerOrder);
  const p = rf && rf.players['p8'];
  const PKEYS = ['playerId', 'name', 'number', 'appearancesTotal', 'recordsInSeason', 'windows', 'comparisons',
    'recentVsPrevious5', 'variability', 'withWithout', 'dataQuality'].sort();
  eq('OC-5 player record keys', p && Object.keys(p).sort(), PKEYS);
  const t = rf && rf.team;
  const TKEYS = ['completedMatchesTotal', 'windows', 'comparisons', 'dataQuality'].sort();
  eq('OC-6 team record keys', t && Object.keys(t).sort(), TKEYS);
  const w = p && p.windows['5'];
  const WKEYS = ['requested', 'available', 'included', 'matchIndexes', 'excludedRecords', 'totals',
    'averagesPerAppearance', 'percentages', 'per90', 'periods', 'gameState', 'gameStateSuppressedMatches',
    'spatial', 'dataQuality'].sort();
  eq('OC-7 player window keys', w && Object.keys(w).sort(), WKEYS);
  ok('OC-8 protocol notes + params + minutes standards present',
    rf && Array.isArray(rf.protocol.notes) && rf.protocol.params.selectedWindow === 5 && !!rf.protocol.minutesStandards);
  eq('OC-9 input completedMatchCount', rf && rf.input.completedMatchCount, 6);
  eq('OC-10 sample visibility fields on every window',
    w && [w.requested, w.available, w.included, Array.isArray(w.excludedRecords)], [5, 6, 5, true]);
}

// With/without group structure for a mid-squad player (integration sanity)
{
  const p13 = RF_F1 && RF_F1.players['p13'];
  // p13 started M2/M3/M6 (XI slot replacement) → WITH 3, WITHOUT 3 → eligible
  const ww = p13 && p13.withWithout;
  eq('WW-SANITY p13 WITH = 3, WITHOUT = 3 → COMPARISON',
    ww && [ww.with.matches, ww.without.matches, ww.status], [3, 3, 'COMPARISON']);
  eq('WW-SANITY p13 WITH wins = 3 (M2? no: M2 L, M3 D, M6 W)', ww && [ww.with.wins, ww.with.draws, ww.with.losses], [1, 1, 1]);
}

// Team window percentages pooled from PS match envelopes (reconciliation)
{
  const w3 = RF_F1 && RF_F1.team.windows['3'];
  const ms = PS_F1.matches.filter((m) => [3, 4, 5].indexOf(m.matchIndex) !== -1);
  const expNum = ms.reduce((a, m) => a + (m.derived.our.passSuccess.num || 0), 0);
  const expDen = ms.reduce((a, m) => a + (m.derived.our.passSuccess.den || 0), 0);
  eq('TEAM-PCT window passSuccess num = Σ match envelopes', w3 && w3.percentages.our.passSuccess.num, expNum);
  eq('TEAM-PCT window passSuccess den = Σ match envelopes', w3 && w3.percentages.our.passSuccess.den, expDen);
  // period + game-state propagation on team windows
  const periodsOk = w3 && Object.keys(w3.periods).indexOf('1H') !== -1 && w3.periods['2H'] && typeof w3.periods['2H'].counts === 'object';
  ok('TEAM-PERIOD team window periods present (counts+stoppage shape)', !!periodsOk);
  ok('TEAM-GS team window gameState present or null-propagated', w3 && (w3.gameState === null || typeof w3.gameState === 'object'));
}

// Empty-input defensive behaviour
{
  const rfEmpty = RFM ? RFM.computeRecentForm(PSE.computeSeason([]), {}) : null;
  ok('EMPTY-1 empty season → INSUFFICIENT top status', rfEmpty && rfEmpty.dataQuality.status === 'INSUFFICIENT');
  eq('EMPTY-2 empty season → no players', rfEmpty && Object.keys(rfEmpty.players).length, 0);
  eq('EMPTY-3 empty season → team windows empty', rfEmpty && rfEmpty.team.windows['3'].included, 0);
}

// ---------------------------------------------------------------------------
// PERF (task Part 29) — actual measurements, no premature optimization
// ---------------------------------------------------------------------------

function perfFixture(nMatches, eventsPerMatch) {
  const sessions = [];
  for (let m = 0; m < nMatches; m++) {
    eventSeq = m * 10000 + 1;
    const events = [];
    for (let i = 0; i < eventsPerMatch; i++) {
      const pid = 'p' + (1 + (i % 14));
      events.push(ev({
        time: 60 + i * 20, period: i % 2 ? '1H' : '2H',
        label: i % 5 === 0 ? 'Pass' : (i % 5 === 1 ? 'Recovery' : (i % 5 === 2 ? 'Press' : 'Turnover')),
        team: 'our', playerId: pid,
        qualifiers: i % 5 === 0 ? { Outcome: i % 10 === 0 ? 'Successful' : 'Unsuccessful' } : {},
        location: i % 3 === 0 ? { x: 0.15 + (i % 7) * 0.1, y: 0.2 + (i % 5) * 0.12 } : null
      }));
    }
    events.push(ev({ time: 1800, label: 'Goal', team: 'our', sfb: 0, sab: 0, sfa: 1, saa: 0 }));
    events.push(sub(2700, 'p7', 'p12'));
    sessions.push(mkSession({
      n: 900 + (m % 60), date: '2026-01-' + String(1 + (m % 28)).padStart(2, '0'), events,
      sourceFile: '/perf' + m + '.json',
      savedAt: '2026-01-01T' + String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0') + ':00Z'
    }));
  }
  return sessions;
}

(function perf() {
  [10, 50, 100, 500].forEach((n) => {
    const sessions = perfFixture(n, 200);
    const t0 = Date.now();
    const PS = PSE.computeSeason(sessions);
    const t1 = Date.now();
    const RF = RFM ? RFM.computeRecentForm(PS, {}) : null;
    const t2 = Date.now();
    const players = RF ? Object.keys(RF.players).length : 0;
    console.log('PERF: ' + n + ' matches × 200 events = PS ' + (t1 - t0) + 'ms + RF ' + (t2 - t1) + 'ms (' + players + ' players)');
  });
})();

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log('');
if (failures.length) {
  console.log('Failures:');
  failures.forEach((f) => console.log('  ' + f));
}
console.log('');
console.log('==========================================');
console.log('PASS: ' + pass + '  FAIL: ' + fail + (RFM ? '' : '  [ENGINE ABSENT — TEST-FIRST BASELINE]'));
console.log('==========================================');
process.exit(fail > 0 ? 1 : 0);
