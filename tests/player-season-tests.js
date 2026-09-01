// PitchLog — Player & Season Data Engine V1 core tests (PM-T1..PM-T20)
// Node, pure-function style (no GUI). Mirrors the conventions of the other
// suites: check() counts, explicit process.exit.
//
// Covers (task Part 32):
//   PM-T1  player identity follows playerId, not name
//   PM-T2  starter identified
//   PM-T3  unused substitute is not an appearance
//   PM-T4  substitute appearance identified
//   PM-T5  substitution-off handled
//   PM-T6  reliable minutes only when evidence exists
//   PM-T7  unreliable minutes gated from per-90
//   PM-T8  season totals = sum of valid match records
//   PM-T9  average per appearance uses appearances, not selections
//   PM-T10 per-90 uses reliable minutes
//   PM-T11 percentages aggregate num/den (never average)
//   PM-T12 player spatial totals reconcile with Spatial Engine V1
//   PM-T13 team totals reconcile with Match Analytics
//   PM-T14 score state distinct from match result
//   PM-T15 duplicate matches not counted twice
//   PM-T16 missing/invalid player references flagged
//   PM-T17 incomplete matches do not silently become zeros
//   PM-T18 identical output on re-run (determinism)
//   PM-T19 source objects not mutated (purity)
//   PM-T20 realistic multi-match fixture with hand-computed totals
// Plus: cross-engine reconciliation invariants (Part 34), minutes edge cases,
// ordering, empty input, performance measurements (Part 35), team-season
// opponent-channel bucket regression (PM-T21).

'use strict';

const fs = require('fs');
const path = require('path');
const PSE = require(path.join(__dirname, '..', 'src', 'player-season.js'));
const AE = require(path.join(__dirname, '..', 'src', 'analytics.js'));

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
const REAL_NOW = Date.now.bind(Date);

// ---------------------------------------------------------------------------
// Fixture builders
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
  { id: 'p15', number: '15', name: 'Y. Fikru' }
];

// 4-3-3 XI slot template
const XI_TEMPLATE = ['GK', 'RB', 'CB', 'CB', 'LB', 'CDM', 'CM', 'CM', 'RW', 'ST', 'LW'];
const XI_IDS = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p8', 'p10', 'p11', 'p9', 'p7'];

function startingXI(replaceAt) {
  // replaceAt: { index: playerId } — M3 swaps p8's CM slot to p13 so that
  // p8 is a SUBSTITUTE in match 3 (the Part 33 example requires it).
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

const PERIOD_BUCKETS_ALL = ['1H', '2H', 'ET1', 'ET2', 'Non-play', 'Unknown'];
function periodOf(p) {
  if (PERIOD_BUCKETS_ALL.indexOf(p) !== -1) return p;
  if (p === 'PRE_MATCH' || p === 'HT' || p === 'ET_HT' || p === 'FT') return 'Non-play';
  return 'Unknown';
}

// ---------------------------------------------------------------------------
// MATCH 1 — 2026-08-15 vs Riverside FC (home, manual 2-1, FT 5400)
// p8 starter full match (90 reliable), 10 Recoveries (8 located), 5 Turnovers (4 located)
// p10 passes 4 successful / 1 unsuccessful
// goals: ours 1800 (0-0 -> 1-0), theirs 3000 (1-0 -> 1-1), ours 4000 (1-1 -> 2-1)
// p7 subbed off 2700 for p12
// possession: our 100-200 + 300-360.5, opp 400-450
// ---------------------------------------------------------------------------

function match1Events() {
  eventSeq = 1;
  const events = [];
  // pre-goal events (DRAW state)
  for (let i = 0; i < 10; i++) {
    events.push(ev({
      time: 60 + i * 100, label: 'Recovery', team: 'our', playerId: 'p8',
      location: i < 8 ? { x: 0.15 + (i % 3) * 0.3, y: 0.2 + (i % 2) * 0.4 } : null
    }));
  }
  for (let i = 0; i < 5; i++) {
    events.push(ev({
      time: 130 + i * 90, label: 'Turnover', team: 'our', playerId: 'p8',
      location: i < 4 ? { x: 0.7, y: 0.3 + i * 0.1 } : null
    }));
  }
  events.push(ev({ time: 200, label: 'Pass', team: 'our', playerId: 'p10', qualifiers: { Outcome: 'Successful' } }));
  events.push(ev({ time: 240, label: 'Pass', team: 'our', playerId: 'p10', qualifiers: { Outcome: 'Successful' } }));
  events.push(ev({ time: 280, label: 'Pass', team: 'our', playerId: 'p10', qualifiers: { Outcome: 'Successful' } }));
  events.push(ev({ time: 320, label: 'Pass', team: 'our', playerId: 'p10', qualifiers: { Outcome: 'Successful' } }));
  events.push(ev({ time: 360, label: 'Pass', team: 'our', playerId: 'p10', qualifiers: { Outcome: 'Unsuccessful' } }));
  events.push(ev({ time: 500, label: 'Shot', team: 'our', playerId: 'p9', subtype: 'On target' }));
  // goals
  events.push(goal(1800, 'our', 0, 0, 1, 0, '1H'));
  // WINNING state events (1800-3000)
  events.push(ev({ time: 2200, period: '2H', label: 'Chance', team: 'our', playerId: 'p9' }));
  events.push(ev({ time: 2400, period: '2H', label: 'Press', team: 'our', playerId: 'p8' }));
  events.push(goal(3000, 'opponent', 1, 0, 1, 1, '2H'));
  // DRAW state events (3000-4000)
  events.push(ev({ time: 3200, period: '2H', label: 'Foul', team: 'our', playerId: 'p5', qualifiers: { Zone: 'Middle third' } }));
  // sub: p7 off, p12 on at 2700
  events.push(sub(2700, 'p7', 'p12'));
  events.push(goal(4000, 'our', 1, 1, 2, 1, '2H'));
  // WINNING state events (4000+)
  events.push(ev({ time: 4200, period: '2H', label: 'Press Win', team: 'our', playerId: 'p8' }));
  events.push(ev({ time: 4300, period: '2H', label: 'Recovery', team: 'our', playerId: 'p12', location: { x: 0.4, y: 0.5 } }));
  // possession intervals
  events.push(ev({ time: 100, label: 'Possession', team: 'our', isInterval: true, startTime: 100, endTime: 200 }));
  events.push(ev({ time: 300, label: 'Possession', team: 'our', isInterval: true, startTime: 300, endTime: 360.5 }));
  events.push(ev({ time: 400, label: 'Possession', team: 'opponent', isInterval: true, startTime: 400, endTime: 450 }));
  return events;
}

function match1(squadOverride, nameOverride) {
  const squad = (squadOverride || SQUAD).map((p) => (
    nameOverride && nameOverride[p.id] ? { ...p, name: nameOverride[p.id] } : p
  ));
  return {
    sourceFile: '/m1.json',
    __savedAt: '2026-08-16T20:00:00Z',
    __schemaVersion: 3,
    videoPath: null,
    tags: [],
    events: match1Events(),
    squad,
    matchInfo: {
      competition: 'League', date: '2026-08-15', opponent: 'Riverside FC', venue: 'Bahirdar Stadium',
      homeAway: 'home', ourScore: '2', opponentScore: '1', formation: '4-3-3', startingXI: startingXI()
    },
    matchClock: ftClock(5400)
  };
}

// ---------------------------------------------------------------------------
// MATCH 2 — 2026-08-22 @ Northport (away, manual 1-2, FT 5400)
// p8 starter subbed off 3600 (60 reliable): 6 Recoveries, 2 Turnovers
// p10 passes 10 successful / 10 unsuccessful
// p5 red card at 4500 (75 reliable)
// goals: ours 2000 (0-0->1-0), theirs 2500 (1-0->1-1), theirs 4600 (1-1->1-2)
// ---------------------------------------------------------------------------

function match2Events() {
  eventSeq = 1000;
  const events = [];
  for (let i = 0; i < 6; i++) {
    events.push(ev({
      time: 200 + i * 400, label: 'Recovery', team: 'our', playerId: 'p8',
      location: i < 4 ? { x: 0.25, y: 0.25 + i * 0.2 } : null
    }));
  }
  events.push(ev({ time: 900, label: 'Turnover', team: 'our', playerId: 'p8', location: { x: 0.6, y: 0.5 } }));
  events.push(ev({ time: 1500, label: 'Turnover', team: 'our', playerId: 'p8', location: null }));
  for (let i = 0; i < 10; i++) {
    events.push(ev({ time: 300 + i * 130, label: 'Pass', team: 'our', playerId: 'p10', qualifiers: { Outcome: 'Successful' } }));
  }
  for (let i = 0; i < 10; i++) {
    events.push(ev({ time: 350 + i * 130, label: 'Pass', team: 'our', playerId: 'p10', qualifiers: { Outcome: 'Unsuccessful' } }));
  }
  events.push(goal(2000, 'our', 0, 0, 1, 0, '1H'));
  events.push(ev({ time: 2200, period: '2H', label: 'Duel', team: 'our', playerId: 'p3' }));
  events.push(goal(2500, 'opponent', 1, 0, 1, 1, '2H'));
  events.push(ev({ time: 2800, period: '2H', label: 'Cross', team: 'our', playerId: 'p11' }));
  events.push(sub(3600, 'p8', null)); // p8 subbed off, no sub on
  events.push(ev({ time: 4000, period: '2H', label: 'Interception', team: 'our', playerId: 'p4' }));
  events.push(ev({ time: 4500, period: '2H', label: 'Card', subtype: 'Red', team: 'our', playerId: 'p5' }));
  events.push(goal(4600, 'opponent', 1, 1, 1, 2, '2H'));
  return events;
}

function match2() {
  return {
    sourceFile: '/m2.json',
    __savedAt: '2026-08-23T20:00:00Z',
    __schemaVersion: 3,
    videoPath: null,
    tags: [],
    events: match2Events(),
    squad: SQUAD.map((p) => ({ ...p })),
    matchInfo: {
      competition: 'League', date: '2026-08-22', opponent: 'Northport', venue: 'Northport Arena',
      homeAway: 'away', ourScore: '1', opponentScore: '2', formation: '4-3-3', startingXI: startingXI()
    },
    matchClock: ftClock(5400)
  };
}

// ---------------------------------------------------------------------------
// MATCH 3 — 2026-08-29 vs Adama City (home, NO manual score -> CHAIN 1-0 W)
// p8 sub ON at 3600 for p6 (30 reliable): 4 Recoveries, 1 Turnover
// goal: ours 4000 (0-0 -> 1-0)
// p12: sub on 2700 for p9 (45 reliable)
// ---------------------------------------------------------------------------

function match3Events() {
  eventSeq = 2000;
  const events = [];
  events.push(ev({ time: 500, label: 'Chance', team: 'our', playerId: 'p9' }));
  events.push(ev({ time: 1000, label: 'Key Pass', team: 'our', playerId: 'p10', location: { x: 0.8, y: 0.5 } }));
  events.push(ev({ time: 1500, label: 'Foul', team: 'opponent', playerId: null }));
  events.push(sub(2700, 'p9', 'p12'));
  events.push(ev({ time: 2800, period: '2H', label: 'Recovery', team: 'our', playerId: 'p12', location: { x: 0.3, y: 0.6 } }));
  events.push(ev({ time: 3000, period: '2H', label: 'Recovery', team: 'our', playerId: 'p12', location: { x: 0.35, y: 0.65 } }));
  events.push(sub(3600, 'p6', 'p8')); // p8 comes on for p6
  for (let i = 0; i < 4; i++) {
    events.push(ev({
      time: 3700 + i * 200, period: '2H', label: 'Recovery', team: 'our', playerId: 'p8',
      location: i < 3 ? { x: 0.5, y: 0.4 + i * 0.1 } : null
    }));
  }
  events.push(ev({ time: 4500, period: '2H', label: 'Turnover', team: 'our', playerId: 'p8', location: { x: 0.9, y: 0.5 } }));
  events.push(goal(4000, 'our', 0, 0, 1, 0, '2H'));
  return events;
}

function match3() {
  return {
    sourceFile: '/m3.json',
    __savedAt: '2026-08-30T20:00:00Z',
    __schemaVersion: 3,
    videoPath: null,
    tags: [],
    events: match3Events(),
    squad: SQUAD.map((p) => ({ ...p })),
    matchInfo: {
      competition: 'League', date: '2026-08-29', opponent: 'Adama City', venue: 'Bahirdar Stadium',
      homeAway: 'home', ourScore: '', opponentScore: '', formation: '4-3-3',
      startingXI: startingXI({ 6: 'p13' }) // p13 starts; p8 comes on at 60'
    },
    matchClock: ftClock(5400)
  };
}

// ---------------------------------------------------------------------------
// MATCH 4 — problem match (2026-09-05 vs Hawassa):
//  - no FT marker (period 2H, clockBaseSeconds 3540) -> ESTIMATED minutes
//  - starting XI MISSING (formation '', startingXI: []) -> UNKNOWN participation
//  - p10 has events (3 Recoveries) but no provable start -> minutes UNAVAILABLE
//  - unresolved player reference pUnknown1
//  - opponent-team Sub referencing p12 (attribution noise)
//  - un-timed sub: Sub with playerOnId p9, no time at all
//  - p8 name variant 'Mohammed Ahmed' + p16 'M. Ahmed' (possible duplicate person)
// ---------------------------------------------------------------------------

function match4Events() {
  eventSeq = 3000;
  const events = [];
  events.push(ev({ time: 600, label: 'Recovery', team: 'our', playerId: 'p10', location: { x: 0.4, y: 0.4 } }));
  events.push(ev({ time: 1200, label: 'Recovery', team: 'our', playerId: 'p10', location: null }));
  events.push(ev({ time: 1800, label: 'Recovery', team: 'our', playerId: 'p10', location: { x: 0.5, y: 0.5 } }));
  events.push(ev({ time: 900, label: 'Shot', team: 'our', playerId: 'pUnknown1', subtype: 'On target' }));
  events.push(ev({ time: 1500, label: 'Recovery', team: 'opponent', playerId: 'p12' }));
  events.push(ev({ time: 2400, period: '2H', label: 'Turnover', team: 'our', playerId: 'pUnknown1' }));
  // opponent-team sub referencing our p12 (noise)
  events.push(sub(2000, null, 'p12', 'opponent'));
  // un-timed sub for p9 (time AND matchSeconds unusable)
  events.push({
    id: 3999, time: null, videoTime: null, matchTime: null, matchSeconds: null,
    officialMinute: null, second: null, period: '2H', label: 'Sub', subtype: null,
    qualifiers: {}, location: null, playerId: null, playerOffId: null, playerOnId: 'p9',
    side: 'for', team: 'our', sequenceId: null, scoreForBefore: 0, scoreAgainstBefore: 0,
    scoreForAfter: null, scoreAgainstAfter: null, isInterval: false, startTime: null, endTime: null
  });
  return events;
}

function match4() {
  const squad4 = SQUAD.map((p) => ({ ...p }));
  squad4.push({ id: 'p16', number: '16', name: 'M. Ahmed' });
  const named = squad4.map((p) => (p.id === 'p8' ? { ...p, name: 'Mohammed Ahmed' } : p));
  return {
    sourceFile: '/m4.json',
    __savedAt: '2026-09-06T20:00:00Z',
    __schemaVersion: 3,
    videoPath: null,
    tags: [],
    events: match4Events(),
    squad: named,
    matchInfo: {
      competition: 'League', date: '2026-09-05', opponent: 'Hawassa', venue: 'Hawassa Stadium',
      homeAway: 'neutral', ourScore: '', opponentScore: '', formation: '', startingXI: []
    },
    matchClock: {
      clockStartedAt: null, clockBaseSeconds: 3540, clockRunning: false,
      period: '2H', scoreFor: 0, scoreAgainst: 0, videoSyncOffset: 0,
      selectedTeam: 'our', selectedPlayerId: null, activeSequenceId: null, nextSequenceNumber: 1
    }
  };
}

// ---------------------------------------------------------------------------
// Core fixture: matches 1-4 (m4 = problem match). #8's numbers come from
// M1-M3 only (he is merely squad-listed/UNKNOWN in M4).
// ---------------------------------------------------------------------------

function coreFixture() {
  return [match1(), match2(), match3(), match4()];
}

// ===========================================================================
console.log('== Player & Season Data Engine V1 — core tests ==\n');

// --- PM-T18: determinism (two runs, byte-identical) -------------------------
{
  const a = PSE.computeSeason(coreFixture());
  const b = PSE.computeSeason(coreFixture());
  eq('PM-T18a deterministic output (byte-identical JSON)', JSON.stringify(a), JSON.stringify(b));
  const c = PSE.computeSeason(coreFixture());
  eq('PM-T18b idempotent third run', JSON.stringify(a), JSON.stringify(c));
}

// --- PM-T19: purity (inputs not mutated) -------------------------------------
{
  const sessions = coreFixture();
  const before = JSON.stringify(sessions);
  PSE.computeSeason(sessions);
  eq('PM-T19a source sessions unmutated', JSON.stringify(sessions), before);
  // outputs do not alias input arrays/objects
  const PS = PSE.computeSeason(sessions);
  ok('PM-T19b playerMatchRecords is a new array', Array.isArray(PS.playerMatchRecords) && PS.playerMatchRecords !== sessions[0].events);
  ok('PM-T19c no shared byLabel reference', (() => {
    const r = PS.playerMatchRecords.find((x) => x.playerId === 'p8');
    const A = AE.computeMatchAnalytics(sessions[0]);
    const eng = A.players.list.find((p) => p.playerId === 'p8');
    return r.metrics.byLabel !== eng.byLabel;
  })());
}

const PS = PSE.computeSeason(coreFixture());

// --- structure ---------------------------------------------------------------
eq('PS spec id', PS.spec, 'PitchLog-PLAYER-SEASON-SPEC-v1.0');
eq('PS engine version', PS.engine.version, '1.0.0');
eq('PS unique matches', PS.coverage.uniqueMatches, 4);
eq('PS sessions loaded', PS.coverage.sessionsLoaded, 4);
eq('PS dataset: matches (team match records)', PS.matches.length, 4);
ok('PS dataset: playerMatchRecords populated', PS.playerMatchRecords.length > 0);
ok('PS dataset: players keyed + ordered', PS.playerOrder.length > 0 && Object.keys(PS.players).length === PS.playerOrder.length);
ok('PS dataset: teamSeason single record', PS.teamSeason && PS.teamSeason.matches === 4);

// deterministic season order: M1(08-15), M2(08-22), M3(08-29), M4(09-05)
eq('season order by date', PS.matches.map((m) => m.matchKey.label).slice(0, 2),
  ['2026-08-15_vs Riverside FC', '2026-08-22_vs Northport']);

// --- PM-T20: hand-computed fixture (#8) --------------------------------------
{
  const p8 = PS.players['p8'];
  eq('PM-T20a appearances = 3', p8.appearances, 3);
  eq('PM-T20b starts = 2', p8.starts, 2);
  eq('PM-T20c substitute appearances = 1', p8.substituteAppearances, 1);
  eq('PM-T20d matches selected = 4 (squad-listed in all)', p8.matchesSelected, 4);
  eq('PM-T20e reliable minutes = 180', p8.minutes.reliableMinutes, 180);
  eq('PM-T20f recoveries = 20', p8.totals.recoveries, 20);
  eq('PM-T20g turnovers = 8', p8.totals.turnovers, 8);
  eq('PM-T20h recoveries/90 = 10', p8.per90.metrics.recoveries.value, 10);
  eq('PM-T20i turnovers/90 = 4', p8.per90.metrics.turnovers.value, 4);
  eq('PM-T20j per-90 matches included = 3', p8.per90.matchesIncluded, 3);
  eq('PM-T20k per-90 minutes = 10800s', p8.per90.minutes, 10800);
  eq('PM-T20l minutes quality MIXED (3 reliable + 1 unavailable)', p8.minutes.quality, 'MIXED');
  eq('PM-T20m reliable/estimated/unavailable matches', [p8.minutes.reliableMatches, p8.minutes.estimatedMatches, p8.minutes.unavailableMatches], [3, 0, 1]);
  // M1: 90 reliable; M2: 60 reliable; M3: 30 reliable
  const m1r = PS.playerMatchRecords.find((r) => r.playerId === 'p8' && r.matchKey.label.includes('Riverside'));
  const m2r = PS.playerMatchRecords.find((r) => r.playerId === 'p8' && r.matchKey.label.includes('Northport'));
  const m3r = PS.playerMatchRecords.find((r) => r.playerId === 'p8' && r.matchKey.label.includes('Adama'));
  const m4r = PS.playerMatchRecords.find((r) => r.playerId === 'p8' && r.matchKey.label.includes('Hawassa'));
  eq('PM-T20m M1 minutes 90 reliable', [m1r.minutes.value, m1r.minutes.quality], [90, 'RELIABLE']);
  eq('PM-T20n M2 minutes 60 reliable (subbed off 3600)', [m2r.minutes.value, m2r.minutes.quality], [60, 'RELIABLE']);
  eq('PM-T20o M3 minutes 30 reliable (sub on 3600)', [m3r.minutes.value, m3r.minutes.quality], [30, 'RELIABLE']);
  eq('PM-T20p M4 minutes UNAVAILABLE (no XI, no marker)', [m4r.minutes.value, m4r.minutes.quality], [null, 'UNAVAILABLE']);
  eq('PM-T20q M4 participation UNKNOWN', m4r.participation.status, 'UNKNOWN');
  ok('PM-T20r M4 unknownReason STARTING_XI_MISSING', m4r.participation.unknownReason === 'STARTING_XI_MISSING');
}

// --- PM-T1: identity by playerId, not name -----------------------------------
{
  const p8 = PS.players['p8'];
  ok('PM-T1a one identity for p8 despite name variant in M4', !!p8);
  eq('PM-T1b canonical name from most recent non-unknown variant', p8.name, 'Mohammed Ahmed');
  eq('PM-T1c nameVariants recorded', p8.nameVariants.length, 2);
  ok('PM-T1d drift audit fired', PS.identityAudit.drift.some((d) => d.playerId === 'p8' && d.variants.length === 2));
  // p16 is a different player (different id, same name 'M. Ahmed')
  ok('PM-T1e p16 is a separate record (id-based)', !!PS.players['p16']);
  ok('PM-T1f possible duplicate persons flagged, never merged',
    PS.identityAudit.possibleDuplicates.some((d) => d.name === 'M. Ahmed' && d.playerIds.length === 2));
}

// --- PM-T2 / PM-T3 / PM-T4 / PM-T5: participation ----------------------------
{
  const m1 = 0; // matchIndex 0
  const p8m1 = PS.playerMatchRecords.find((r) => r.playerId === 'p8' && r.matchIndex === m1);
  ok('PM-T2a starter identified (p8 in XI)', p8m1.participation.starter === true);
  eq('PM-T2b starter status STARTED_FULL (FT, no off marker)', p8m1.participation.status, 'STARTED_FULL');
  const p15 = PS.players['p15'];
  eq('PM-T3a unused sub appearances = 0', p15.appearances, 0);
  // unused is only provable with a starting XI — M4 has none, so 3 of 4
  eq('PM-T3b unused sub count = 3 (M4 has no XI — unknown there)', p15.unusedSubstitutions, 3);
  eq('PM-T3c unused not an appearance; UNKNOWN where XI missing', (() => {
    const recs = PS.playerMatchRecords.filter((r) => r.playerId === 'p15');
    return recs.every((r) => !r.participation.appearance) &&
      recs.filter((r) => r.matchIndex !== 3).every((r) => r.participation.unused) &&
      recs[3].participation.status === 'UNKNOWN';
  })(), true);
  const p12m1 = PS.playerMatchRecords.find((r) => r.playerId === 'p12' && r.matchIndex === 0);
  ok('PM-T4a substitute appearance identified (p12 on at 2700)', p12m1.participation.substitute && p12m1.participation.appearance);
  eq('PM-T4b substitutedOnSeconds 2700', p12m1.participation.substitutedOnSeconds, 2700);
  const p7m1 = PS.playerMatchRecords.find((r) => r.playerId === 'p7' && r.matchIndex === 0);
  ok('PM-T5a substitution-off handled (p7 off 2700)', p7m1.participation.substitutedOff && p7m1.participation.substitutedOffSeconds === 2700);
  eq('PM-T5b p7 status STARTED_SUBBED_OFF', p7m1.participation.status, 'STARTED_SUBBED_OFF');
  eq('PM-T5c p7 minutes 45 reliable', [p7m1.minutes.value, p7m1.minutes.quality], [45, 'RELIABLE']);
  // engine appearance reconciliation
  const A1 = AE.computeMatchAnalytics(match1());
  A1.players.list.forEach((p) => {
    const rec = PS.playerMatchRecords.find((r) => r.playerId === p.playerId && r.matchIndex === 0);
    eq('PM-T2c engine appearance == season appearance (' + p.playerId + ')', rec.participation.appearance, p.appearance);
  });
}

// --- PM-T6: reliable minutes only with evidence -------------------------------
{
  const p10m4 = PS.playerMatchRecords.find((r) => r.playerId === 'p10' && r.matchIndex === 3);
  eq('PM-T6a no XI + no sub -> UNAVAILABLE', [p10m4.minutes.value, p10m4.minutes.quality], [null, 'UNAVAILABLE']);
  ok('PM-T6b reason recorded', p10m4.minutes.reasonCodes.indexOf('STARTING_XI_MISSING') !== -1);
  const p9m4 = PS.playerMatchRecords.find((r) => r.playerId === 'p9' && r.matchIndex === 3);
  eq('PM-T6c un-timed sub-on -> UNAVAILABLE (SUB_TIME_MISSING)', [p9m4.minutes.value, p9m4.minutes.quality], [null, 'UNAVAILABLE']);
  ok('PM-T6d SUB_TIME_MISSING reason', p9m4.minutes.reasonCodes.indexOf('SUB_TIME_MISSING') !== -1);
  // starter with FT is reliable
  const p1m1 = PS.playerMatchRecords.find((r) => r.playerId === 'p1' && r.matchIndex === 0);
  eq('PM-T6e full-match starter with FT -> 90 reliable', [p1m1.minutes.value, p1m1.minutes.quality], [90, 'RELIABLE']);
  // red card end marker
  const p5m2 = PS.playerMatchRecords.find((r) => r.playerId === 'p5' && r.matchIndex === 1);
  eq('PM-T6f red card ends participation (75 reliable)', [p5m2.minutes.value, p5m2.minutes.quality], [75, 'RELIABLE']);
  ok('PM-T6g sentOff flagged', p5m2.participation.sentOff === true);
  eq('PM-T6h status STARTED_SENT_OFF', p5m2.participation.status, 'STARTED_SENT_OFF');
}

// --- PM-T7: unreliable minutes gated from per-90 -------------------------------
{
  const p10 = PS.players['p10'];
  // p10 starts M1, M2, M3 (reliable 90 each); M4 has no XI -> UNAVAILABLE there.
  // M4's 3 recoveries are therefore EXCLUDED from the per-90 numerator.
  eq('PM-T7a per-90 matches included = 3', p10.per90.matchesIncluded, 3);
  eq('PM-T7b per-90 recoveries total excludes M4 (0 of 3)', p10.per90.metrics.recoveries.total, 0);
  eq('PM-T7c per-90 recoveries value 0 (zero events in reliable set — a real zero, not null)', p10.per90.metrics.recoveries.value, 0);
  eq('PM-T7d per-90 passes = 25/270×90 = 8.3', p10.per90.metrics.passes.value, 8.3);
  // pUnknown1: only M4, no reliable minutes -> per-90 null
  const pu = PS.players['pUnknown1'];
  ok('PM-T7e no reliable minutes -> per-90 null', pu.per90.metrics.shots.value === null);
  eq('PM-T7f minutes quality UNAVAILABLE', pu.minutes.quality, 'UNAVAILABLE');
}

// --- PM-T8: season totals = sum of match records -------------------------------
{
  const keys = ['events', 'goals', 'shots', 'shotsOnTarget', 'chances', 'keyPasses', 'crosses',
    'passes', 'successfulPasses', 'unsuccessfulPasses', 'presses', 'pressWins',
    'interceptions', 'recoveries', 'turnovers', 'duels', 'fouls', 'yellowCards', 'redCards',
    'positiveEvents', 'negativeEvents', 'transitionsPositive', 'transitionsNegative', 'subOn', 'subOff'];
  PS.playerOrder.forEach((pid) => {
    const p = PS.players[pid];
    const recs = PS.playerMatchRecords.filter((r) => r.playerId === pid);
    keys.forEach((k) => {
      const s = recs.reduce((acc, r) => acc + r.metrics[k], 0);
      if (p.totals[k] !== s) {
        ok('PM-T8 totals sum (' + pid + '.' + k + ')', false, 'total=' + p.totals[k] + ' sum=' + s);
        return;
      }
    });
  });
  ok('PM-T8 season totals equal sum of match records (all players, all metrics)', true);
  // appearance/participation sums
  PS.playerOrder.forEach((pid) => {
    const p = PS.players[pid];
    const recs = PS.playerMatchRecords.filter((r) => r.playerId === pid);
    const apps = recs.filter((r) => r.participation.appearance).length;
    const starts = recs.filter((r) => r.participation.starter).length;
    if (p.appearances !== apps || p.starts !== starts) {
      ok('PM-T8b participation sums (' + pid + ')', false);
    }
  });
  ok('PM-T8b participation counts equal per-match sums', true);
}

// --- PM-T9: averages use appearances, not selections ---------------------------
{
  const p8 = PS.players['p8'];
  eq('PM-T9a recoveries per appearance = 20/3', p8.averagesPerAppearance.recoveries, 6.7);
  const p15 = PS.players['p15'];
  eq('PM-T9b unused sub: averages null (0 appearances)', p15.averagesPerAppearance.recoveries, null);
  eq('PM-T9c appearances (4 selected, 0 apps) — division by appearances only', p15.appearances, 0);
}

// --- PM-T10: per-90 uses reliable minutes --------------------------------------
{
  const p8 = PS.players['p8'];
  eq('PM-T10a recoveries/90 = 10 (20 over 180 reliable)', p8.per90.metrics.recoveries.value, 10);
  eq('PM-T10b per-90 denominator = 10800 seconds', p8.per90.minutes, 10800);
  eq('PM-T10c presses/90 = 0.5 (1 press in 180 reliable min; Press Win is a separate metric)', p8.per90.metrics.presses.value, 0.5);
}

// --- PM-T11: percentages pool num/den ------------------------------------------
{
  const p10 = PS.players['p10'];
  // M1: 4/5; M2: 10/20; M3: none; M4: none -> pooled 14/25 = 56%
  eq('PM-T11a pooled pass success = 56% (14/25)', p10.percentages.passSuccess.value, 56);
  eq('PM-T11b pooled num/den', [p10.percentages.passSuccess.num, p10.percentages.passSuccess.den], [14, 25]);
  const wrong = (80 + 50) / 2; // 65 — the value averaging would give
  ok('PM-T11c NOT the mean of percentages (65)', p10.percentages.passSuccess.value !== wrong);
  // team pooled: our pass success is also 14/25 = 56% (p10 is the only passer)
  const T = PS.teamSeason;
  eq('PM-T11d team pooled pass success = 56% (14/25)', [T.percentages.our.passSuccess.value, T.percentages.our.passSuccess.num, T.percentages.our.passSuccess.den], [56, 14, 25]);
}

// --- PM-T12: player spatial totals reconcile with Spatial Engine V1 ------------
{
  // per-match: zones == engine playerGrids cells; season: element-wise sum
  const sessions = coreFixture();
  sessions.forEach((session, mi) => {
    const A = AE.computeMatchAnalytics(session);
    (A.spatial.playerGrids || []).forEach((g) => {
      const rec = PS.playerMatchRecords.find((r) => r.playerId === g.playerId && r.matchIndex === mi);
      if (!rec) { ok('PM-T12 record exists for grid player ' + g.playerId, false); return; }
      g.cells.forEach((cell) => {
        if (rec.spatial.zones[cell.zoneKey] !== cell.counts.events) {
          ok('PM-T12a zone match (' + g.playerId + ' ' + cell.zoneKey + ')', false,
            'season=' + rec.spatial.zones[cell.zoneKey] + ' engine=' + cell.counts.events);
        }
      });
      if (rec.spatial.located !== g.located || rec.spatial.unlocated !== g.unlocated) {
        ok('PM-T12b located/unlocated (' + g.playerId + ')', false);
      }
    });
  });
  ok('PM-T12 player match spatial == engine playerGrids (all matches, all players)', true);
  // season: sum of per-match zone counts
  const p8 = PS.players['p8'];
  const p8recs = PS.playerMatchRecords.filter((r) => r.playerId === 'p8');
  const keys = Object.keys(p8.spatial.zones);
  const sums = keys.map((z) => p8recs.reduce((a, r) => a + r.spatial.zones[z], 0));
  eq('PM-T12c season zones == sum of match zones', p8.spatial.zones, Object.fromEntries(keys.map((z, i) => [z, sums[i]])));
  // p8 located events: M1 12, M2 5, M3 4 -> 21
  eq('PM-T12d p8 season located = 21', p8.spatial.located, 21);
  eq('PM-T12e p8 season unlocated = 9 (incl. unlocated Press/Press Win)', p8.spatial.unlocated, 9);
}

// --- PM-T21: team-season OPPONENT channel aggregation reads the opponent bucket ---
// Regression for the defect where the season opponent-channel sum read the
// OUR channel bucket (m.spatial.our.channels) instead of the OPPONENT bucket
// (m.spatial.opponent.channels). Fixture: OUR and OPPONENT channel
// distributions are deliberately different in every channel key, across two
// matches, so a mirrored read cannot pass by coincidence. Channel binning
// (analytics.js): y → floor(y*3): [0,1/3) Left, [1/3,2/3) Central, [2/3,1] Right.
{
  const ftClock00 = () => ({
    clockStartedAt: null, clockBaseSeconds: 5400, clockRunning: false, period: 'FT',
    scoreFor: 0, scoreAgainst: 0, videoSyncOffset: 0, selectedTeam: 'our',
    selectedPlayerId: null, activeSequenceId: null, nextSequenceNumber: 1
  });
  const channelMatch = (idx, date, ourYs, oppYs) => {
    const events = [];
    let t = 600;
    ourYs.forEach((y) => events.push(ev({ time: (t += 100), label: 'Recovery', team: 'our', playerId: 'p8', location: { x: 0.5, y } })));
    oppYs.forEach((y) => events.push(ev({ time: (t += 100), label: 'Recovery', team: 'opponent', location: { x: 0.5, y } })));
    return {
      sourceFile: '/ch-' + idx + '.json',
      __savedAt: '2026-07-' + String(idx + 1).padStart(2, '0') + 'T20:00:00Z',
      __schemaVersion: 3,
      videoPath: null,
      tags: [],
      events,
      squad: SQUAD.map((p) => ({ ...p })),
      matchInfo: {
        competition: 'League', date, opponent: 'Channel Opp ' + idx, venue: 'V', homeAway: 'home',
        ourScore: '0', opponentScore: '0', formation: '4-3-3', startingXI: startingXI()
      },
      matchClock: ftClock00()
    };
  };
  // Match A: OUR {Left 1, Central 2, Right 0}; OPPONENT {Left 0, Central 7, Right 3}
  const chA = channelMatch(0, '2026-07-01', [0.2, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.8, 0.8, 0.8]);
  // Match B: OUR {Left 0, Central 0, Right 2}; OPPONENT {Left 4, Central 1, Right 0}
  const chB = channelMatch(1, '2026-07-08', [0.8, 0.9], [0.1, 0.1, 0.1, 0.1, 0.4]);
  const PSch = PSE.computeSeason([chA, chB]);

  // fixture sanity — the distributions must differ, or the test proves nothing
  ok('PM-T21 fixture sanity: our and opponent channels differ (match A)',
    JSON.stringify(PSch.matches[0].spatial.our.channels) !== JSON.stringify(PSch.matches[0].spatial.opponent.channels), '');
  ok('PM-T21 fixture sanity: our and opponent channels differ (match B)',
    JSON.stringify(PSch.matches[1].spatial.our.channels) !== JSON.stringify(PSch.matches[1].spatial.opponent.channels), '');

  // per-match ground truth (consumed from the analytics engine grids)
  eq('PM-T21a match A our channels', PSch.matches[0].spatial.our.channels,
    { 'Left channel': 1, 'Central channel': 2, 'Right channel': 0 });
  eq('PM-T21b match A opponent channels', PSch.matches[0].spatial.opponent.channels,
    { 'Left channel': 0, 'Central channel': 7, 'Right channel': 3 });
  eq('PM-T21c match B our channels', PSch.matches[1].spatial.our.channels,
    { 'Left channel': 0, 'Central channel': 0, 'Right channel': 2 });
  eq('PM-T21d match B opponent channels', PSch.matches[1].spatial.opponent.channels,
    { 'Left channel': 4, 'Central channel': 1, 'Right channel': 0 });

  // season aggregation — exact expected values, all three channel keys
  eq('PM-T21e season our channels == Σ per-match OUR bucket', PSch.teamSeason.spatial.channels.our,
    { 'Left channel': 1, 'Central channel': 2, 'Right channel': 2 });
  eq('PM-T21f season OPPONENT channels == Σ per-match OPPONENT bucket (exact values)',
    PSch.teamSeason.spatial.channels.opponent,
    { 'Left channel': 4, 'Central channel': 8, 'Right channel': 3 });
  const oppSum = { 'Left channel': 0, 'Central channel': 0, 'Right channel': 0 };
  PSch.matches.forEach((m) => {
    Object.keys(oppSum).forEach((c) => { oppSum[c] += m.spatial.opponent.channels[c]; });
  });
  eq('PM-T21g invariant: season opponent channels == Σ m.spatial.opponent.channels',
    PSch.teamSeason.spatial.channels.opponent, oppSum);
  ok('PM-T21h season opponent channels do not mirror the our bucket',
    JSON.stringify(PSch.teamSeason.spatial.channels.opponent) !== JSON.stringify(PSch.teamSeason.spatial.channels.our), '');
}

// --- PM-T13: team totals reconcile with Match Analytics -------------------------
{
  const sessions = coreFixture();
  const TK = ['events', 'goals', 'shots', 'shotsOnTarget', 'chances', 'crosses', 'corners',
    'fouls', 'yellowCards', 'redCards', 'substitutions', 'passes', 'successfulPasses',
    'unsuccessfulPasses', 'presses', 'pressWins', 'interceptions', 'recoveries',
    'turnovers', 'duels', 'positiveTransitions', 'negativeTransitions'];
  sessions.forEach((session, mi) => {
    const A = AE.computeMatchAnalytics(session);
    const tm = PS.matches[mi];
    TK.forEach((k) => {
      if (tm.events.our[k].value !== A.level1.team.our[k].value) {
        ok('PM-T13a team our.' + k + ' (match ' + mi + ')', false, 'season=' + tm.events.our[k].value + ' engine=' + A.level1.team.our[k].value);
      }
      if (tm.events.opponent[k].value !== A.level1.team.opponent[k].value) {
        ok('PM-T13b team opp.' + k + ' (match ' + mi + ')', false);
      }
    });
    if (tm.possession.ourSecondsExact !== A.level1.possession.our.totalSecondsExact) {
      ok('PM-T13c possession seconds (match ' + mi + ')', false);
    }
  });
  ok('PM-T13 team match records == engine level1 (all matches, both teams)', true);
  // season team totals = sum of match values
  const T = PS.teamSeason;
  const summed = PS.matches.reduce((a, m) => a + m.events.our.recoveries.value, 0);
  eq('PM-T13d team season recoveries = sum', T.totals.our.recoveries, summed);
  const summedGoals = PS.matches.reduce((a, m) => a + m.events.our.goals.value, 0);
  eq('PM-T13e team season goals = sum', T.totals.our.goals, summedGoals);
}

// --- PM-T14: score state distinct from match result ----------------------------
{
  const m1 = PS.matches[0];
  eq('PM-T14a M1 result W', m1.result.outcome, 'W');
  eq('PM-T14b M1 result source MANUAL', m1.result.source, 'MANUAL');
  ok('PM-T14c M1 drawing-state events exist (result is W)',
    m1.gameState.DRAW && m1.gameState.DRAW.events > 0);
  ok('PM-T14d M1 winning-state events exist',
    m1.gameState.WINNING && m1.gameState.WINNING.events > 0);
  ok('PM-T14e result != state: W result with DRAW bucket non-zero',
    m1.result.outcome === 'W' && m1.gameState.DRAW.events > 0);
  // M3: no manual score -> CHAIN source
  const m3 = PS.matches[2];
  eq('PM-T14f M3 result source CHAIN (manual empty)', m3.result.source, 'CHAIN');
  eq('PM-T14g M3 result W from chain 1-0', m3.result.outcome, 'W');
  // engine level3.byState equality (all-events partition)
  const A1 = AE.computeMatchAnalytics(match1());
  ['WINNING', 'DRAW', 'LOSING'].forEach((s) => {
    if (A1.level3.byState[s].events !== m1.gameState[s].events) {
      ok('PM-T14h byState ' + s + ' == engine level3', false);
    }
  });
  ok('PM-T14h team gameState == engine level3.byState', true);
}

// --- PM-T15: duplicate matches not counted twice --------------------------------
{
  const sessions = coreFixture();
  const dup = match1(); // same sourceFile '/m1.json'
  const withDup = PSE.computeSeason(sessions.concat([dup]));
  eq('PM-T15a duplicate excluded (unique matches still 4)', withDup.coverage.uniqueMatches, 4);
  eq('PM-T15b duplicate audit count', withDup.coverage.duplicateSessionsExcluded, 1);
  eq('PM-T15c totals unchanged with duplicate loaded', withDup.teamSeason.totals.our.recoveries, PS.teamSeason.totals.our.recoveries);
  eq('PM-T15d p8 numbers unchanged', [withDup.players['p8'].totals.recoveries, withDup.players['p8'].appearances], [20, 3]);
}

// --- PM-T16: unresolved player references flagged --------------------------------
{
  const pu = PS.players['pUnknown1'];
  ok('PM-T16a unresolved player record exists', !!pu);
  const m4rec = PS.playerMatchRecords.find((r) => r.playerId === 'pUnknown1');
  ok('PM-T16b UNRESOLVED_PLAYER flag', m4rec.dataQuality.flags.indexOf('UNRESOLVED_PLAYER') !== -1);
  eq('PM-T16c unresolved name fallback', m4rec.name, 'Unknown player');
  ok('PM-T16d season-level unresolved flag', pu.dataQuality.flags.indexOf('UNRESOLVED_PLAYER') !== -1);
}

// --- PM-T17: incomplete match not silently zeroed ---------------------------------
{
  const m4 = PS.matches[3];
  ok('PM-T17a M4 flagged partial', m4.dataQuality.status === 'PARTIAL');
  ok('PM-T17b INCOMPLETE_MATCH_NO_FT flag', m4.dataQuality.flags.indexOf('INCOMPLETE_MATCH_NO_FT') !== -1);
  ok('PM-T17c STARTING_XI_MISSING flag', m4.dataQuality.flags.indexOf('STARTING_XI_MISSING') !== -1);
  // its events still count in totals (not zeroed, not dropped)
  eq('PM-T17d M4 recoveries present in team totals', PS.matches[3].events.our.recoveries.value, 3);
  // minutes fall back to ESTIMATED for players with markers but no FT
  const p10m4 = PS.playerMatchRecords.find((r) => r.playerId === 'p10' && r.matchIndex === 3);
  eq('PM-T17e p10 M4 minutes null (cannot prove start)', p10m4.minutes.value, null);
  // coverage reports the partial match
  eq('PM-T17f coverage partial records = 1', PS.coverage.partialMatchRecords, 1);
  eq('PM-T17g coverage complete records = 3', PS.coverage.completeMatchRecords, 3);
}

// --- X1 MISMATCH suppression propagates ------------------------------------------
{
  // build a mismatch session from match1 by editing the manual score
  const bad = match1();
  bad.matchInfo = { ...bad.matchInfo, ourScore: '3', opponentScore: '1' };
  const psBad = PSE.computeSeason([bad]);
  const mb = psBad.matches[0];
  eq('X1a MISMATCH detected', mb.result.x1Status, 'MISMATCH');
  ok('X1b result flagged, not dropped', mb.result.flagged === true && mb.result.outcome === 'W');
  ok('X1c team gameState suppressed', mb.gameState === null && mb.gameStateSuppressedReason === 'SCORE_RECONCILIATION_MISMATCH');
  const p8rec = psBad.playerMatchRecords.find((r) => r.playerId === 'p8');
  ok('X1d player gameState suppressed', p8rec.gameState === null);
  ok('X1e INCONSISTENT_GOAL_CHAIN flag', mb.dataQuality.flags.indexOf('INCONSISTENT_GOAL_CHAIN') !== -1);
}

// --- cross-engine partition reconciliation (Part 34) ------------------------------
{
  const sessions = coreFixture();
  sessions.forEach((session, mi) => {
    const A = AE.computeMatchAnalytics(session);
    const recs = A.spatial.locatedEvents.concat(A.spatial.unlocatedEvents);
    // per-player partition sums == engine A.players metrics (qualifier-free family)
    const fam = ['events', 'goals', 'shots', 'shotsOnTarget', 'chances', 'keyPasses', 'crosses',
      'passes', 'presses', 'pressWins', 'interceptions', 'recoveries', 'turnovers', 'duels',
      'fouls', 'yellowCards', 'redCards', 'transitionsPositive', 'transitionsNegative'];
    A.players.list.forEach((p) => {
      const rec = PS.playerMatchRecords.find((r) => r.playerId === p.playerId && r.matchIndex === mi);
      if (!rec) { ok('R1 record exists ' + p.playerId, false); return; }
      fam.forEach((k) => {
        // 'events' includes Sub involvement in the engine (M-G5: off/on ids);
        // partitions count playerId-attributed events only — the invariant
        // is Σ partitions + (subOn+subOff) == engine events.
        const mapped = k === 'events' ? p.events - (p.metrics.subOn + p.metrics.subOff)
          : k === 'transitionsPositive' ? (p.byLabel['Positive Transition'] || 0)
          : k === 'transitionsNegative' ? (p.byLabel['Negative Transition'] || 0)
          : p.metrics[k];
        const partSum = PERIOD_BUCKETS_ALL.reduce((a, pb) => a + rec.periods[pb][k], 0);
        if (partSum !== mapped) {
          ok('R1 partition sum (' + p.playerId + '.' + k + ')', false, 'partition=' + partSum + ' engine=' + mapped);
        }
      });
    });
  });
  ok('R1 player partitions == engine A.players metrics (all matches)', true);

  // per-period totals: sum over all player records + unattributed == engine level3.byPeriod
  sessions.forEach((session, mi) => {
    const A = AE.computeMatchAnalytics(session);
    PERIOD_BUCKETS_ALL.forEach((pb) => {
      let total = 0;
      PS.playerMatchRecords.filter((r) => r.matchIndex === mi).forEach((r) => { total += r.periods[pb].events; });
      const recs = A.spatial.locatedEvents.concat(A.spatial.unlocatedEvents);
      const unattr = recs.filter((r) => !r.playerId && periodOf(r.period) === pb).length;
      if (total + unattr !== A.level3.byPeriod[pb].counts.events) {
        ok('R2 period total (' + pb + ', match ' + mi + ')', false,
          'players=' + total + ' unattr=' + unattr + ' engine=' + A.level3.byPeriod[pb].counts.events);
      }
    });
  });
  ok('R2 Σ player byPeriod + unattributed == engine level3.byPeriod (all matches)', true);
}

// --- minutes edge cases -----------------------------------------------------------
{
  // starter subbed off in stoppage after the clock ran past 45:00
  const s = match1();
  s.events = s.events.filter((e) => e.label !== 'Sub');
  eventSeq = 5000;
  s.events.push(ev({ time: 2820, period: '1H', label: 'Sub', playerOffId: 'p7', playerOnId: 'p12', team: 'our' }));
  const ps = PSE.computeSeason([s]);
  const p7 = ps.playerMatchRecords.find((r) => r.playerId === 'p7');
  eq('E1 sub-off in 1H stoppage: minutes 47', [p7.minutes.value, p7.minutes.quality], [47, 'RELIABLE']);
  const p12 = ps.playerMatchRecords.find((r) => r.playerId === 'p12');
  eq('E2 sub-on in stoppage, FT end: [2820,5400] = 43', [p12.minutes.value, p12.minutes.quality], [43, 'RELIABLE']);

  // double sub-on -> MULTIPLE_SUB_ON, ESTIMATED, longest span
  const s2 = match1();
  eventSeq = 6000;
  s2.events.push(ev({ time: 3000, period: '2H', label: 'Sub', playerOffId: 'p6', playerOnId: 'p12', team: 'our' }));
  const ps2 = PSE.computeSeason([s2]);
  const p12b = ps2.playerMatchRecords.find((r) => r.playerId === 'p12');
  ok('E3 MULTIPLE_SUB_ON flagged', p12b.minutes.reasonCodes.indexOf('MULTIPLE_SUB_ON') !== -1);
  eq('E4 double sub-on -> ESTIMATED', p12b.minutes.quality, 'ESTIMATED');
  // longest span: on 2700 -> FT 5400 = 45 min (overlapping spans not summed)
  eq('E5 longest span used (not the sum 85)', p12b.minutes.value, 45);

  // opponent-team sub referencing our player: no minutes marker, noise flagged
  const s3 = match1();
  eventSeq = 7000;
  s3.events.push(ev({ time: 3300, period: '2H', label: 'Sub', playerOffId: null, playerOnId: 'p15', team: 'opponent' }));
  const ps3 = PSE.computeSeason([s3]);
  const p15 = ps3.playerMatchRecords.find((r) => r.playerId === 'p15');
  // p15 IS squad-listed; the opponent sub noise makes his on-marker unusable -> unused stays true
  // (engine M-G5 counts an appearance, so participation.substitute mirrors it)
  ok('E6 opponent-sub noise flagged in gates', ps3.gates.PSD_X6_subAttributionNoise.length === 1);
  ok('E7 OPPONENT_SUB_REFERENCES_PLAYER reason on minutes', p15.minutes.reasonCodes.indexOf('OPPONENT_SUB_REFERENCES_PLAYER') !== -1);
  ok('E8 p15 opponent-ref does not produce reliable minutes', p15.minutes.quality !== 'RELIABLE');
}

// --- ET match: 120-minute duration + ET periods ----------------------------------
{
  const s = match1();
  eventSeq = 8000;
  s.events.push(ev({ time: 5600, period: 'ET1', label: 'Recovery', team: 'our', playerId: 'p8', location: { x: 0.5, y: 0.5 } }));
  s.matchClock = ftClock(7200); // ET FT at 120'
  const ps = PSE.computeSeason([s]);
  const p8 = ps.playerMatchRecords.find((r) => r.playerId === 'p8');
  eq('ET1 full-match starter with ET FT = 120 reliable', [p8.minutes.value, p8.minutes.quality], [120, 'RELIABLE']);
  eq('ET2 ET1 period bucket populated', p8.periods.ET1.events, 1);
  const tm = ps.matches[0];
  eq('ET3 engine durationMinutes 120', tm.durationMinutes, 120);
}

// --- empty input -------------------------------------------------------------------
{
  const ps = PSE.computeSeason([]);
  eq('Z1 empty input: zero matches', ps.coverage.uniqueMatches, 0);
  eq('Z2 empty input: empty player order', ps.playerOrder.length, 0);
  eq('Z3 empty input: team season zero', ps.teamSeason.matches, 0);
  const ps2 = PSE.computeSeason([{ not: 'a session' }]);
  eq('Z4 malformed session tolerated (0 events)', ps2.coverage.uniqueMatches, 1);
}

// --- ordering: empty dates last, savedAt tie-break ---------------------------------
{
  const a = match1(), b = match2(), c = match3();
  b.matchInfo = { ...b.matchInfo, date: '' };
  c.matchInfo = { ...c.matchInfo, date: '' };
  b.__savedAt = '2026-09-01T10:00:00Z';
  c.__savedAt = '2026-08-01T10:00:00Z';
  const ps = PSE.computeSeason([a, b, c]);
  // a (dated) first; c (earlier savedAt among undated) second; b third
  eq('O1 ordering: dated first, undated by savedAt', ps.matches.map((m) => m.matchKey.label)[0], '2026-08-15_vs Riverside FC');
  ok('O2 undated sorted by savedAt (c before b)', ps.matches[1].matchKey.label.includes('Northport') === false);
  const ps2 = PSE.computeSeason([a, b, c]);
  eq('O3 ordering deterministic', JSON.stringify(ps.input.sessions), JSON.stringify(ps2.input.sessions));
}

// --- determinism guard: no Date.now inside the engine ------------------------------
{
  const realNow = Date.now;
  let threw = false;
  try {
    Date.now = function () { throw new Error('engine called Date.now()'); };
    PSE.computeSeason(coreFixture());
  } catch (e) { threw = true; }
  finally { Date.now = realNow; }
  ok('D1 engine never calls Date.now()', !threw);
}

// --- performance (Part 35) ----------------------------------------------------------
{
  function syntheticMatch(i) {
    eventSeq = i * 10000;
    const events = [];
    for (let k = 0; k < 200; k++) {
      const t = 30 + k * 25;
      events.push(ev({
        time: t, period: t >= 2700 ? '2H' : '1H', label: LABELS[k % LABELS.length],
        team: k % 5 === 0 ? 'opponent' : 'our',
        playerId: k % 3 === 0 ? null : SQUAD[k % 11].id,
        location: k % 4 === 0 ? null : { x: (k % 10) / 10, y: ((k + 3) % 10) / 10 },
        qualifiers: LABELS[k % LABELS.length] === 'Pass' ? { Outcome: k % 2 ? 'Successful' : 'Unsuccessful' } : {}
      }));
    }
    return {
      sourceFile: '/perf-' + i + '.json',
      __savedAt: '2026-0' + ((i % 9) + 1) + '-15T20:00:00Z',
      __schemaVersion: 3, videoPath: null, tags: [],
      events, squad: SQUAD.map((p) => ({ ...p })),
      matchInfo: {
        competition: 'League', date: '2026-0' + ((i % 9) + 1) + '-' + String(10 + (i % 18)).padStart(2, '0'),
        opponent: 'Opp ' + (i % 7), venue: 'V', homeAway: i % 2 ? 'home' : 'away',
        ourScore: String(i % 3), opponentScore: String((i + 1) % 3), formation: '4-3-3', startingXI: startingXI()
      },
      matchClock: ftClock(5400)
    };
  }
  const LABELS = ['Recovery', 'Pass', 'Press', 'Turnover', 'Shot', 'Chance', 'Duel', 'Interception'];
  [10, 50, 100, 500].forEach((n) => {
    const sessions = [];
    for (let i = 0; i < n; i++) sessions.push(syntheticMatch(i));
    const t0 = REAL_NOW();
    const ps = PSE.computeSeason(sessions);
    const ms = REAL_NOW() - t0;
    console.log('PERF: ' + n + ' matches × 200 events = ' + ms + 'ms (' +
      ps.coverage.uniqueMatches + ' unique matches, ' + ps.playerMatchRecords.length + ' player-match records)');
    ok('PERF n=' + n + ' matches completed (' + ms + 'ms)', ps.coverage.uniqueMatches === n);
  });
}

// ---------------------------------------------------------------------------
console.log('\n==========================================');
console.log('PASS: ' + pass + '  FAIL: ' + fail);
if (failures.length) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log('  - ' + f));
}
console.log('==========================================');
process.exit(fail > 0 ? 1 : 0);
