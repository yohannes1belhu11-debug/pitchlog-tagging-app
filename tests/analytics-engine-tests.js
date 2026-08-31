#!/usr/bin/env node
// PitchLog / MatchTag — Analytics Engine V1 tests (pure Node, no jsdom)
// ====================================================================
// Verifies src/analytics.js against docs/metric-specification.md using
// HAND-COMPUTED oracle fixtures (spec §13: "hand-computed fixtures ... a
// double-count regression fixture implementing the §9.4 worked example").
//
// Sections:
//   A  determinism + input purity (spec §12.1/§12.6)
//   B  validation layer (RAW EVENTS -> VALIDATION)
//   C  Level 1 team counts (oracle fixture MAIN, 30 events)
//   D  possession intervals + TAGGED POSSESSION SHARE (M-B10..B13, M-L2-B4)
//      — full UNROUNDED interval seconds used internally
//      — raw interval list preserved
//      — our + opponent tagged durations reported
//      — insufficient data => null + reason, never false precision
//   E  Level 2 derived metrics (A1..A3, B1..B3, C1, C2, G4 per-90)
//   F  X-gates (X1..X6)
//   G  score state M-L2-F1/F2 (+ X1 gating)
//   H  transition linkage L(τ) — greedy backward match (spec §9.3)
//   I  Level 3 contexts (zone/third/channel/period/minute-bin/state)
//   J  players (M-G1/G2/G5, M-L2-G1/G3 interpretive)
//   K  sequences
//   L  §9.4 anti-double-count worked example + duplicate-tag watch
//   M  empty / minimal sessions
//   N  input contract: session JSON vs full-analysis CSV field set (§13)
//
// Run:  node tests/analytics-engine-tests.js   (from the pitchlog root)

'use strict';

const path = require('path');
const AE = require(path.join(__dirname, '..', 'src', 'analytics.js'));

let passCount = 0;
let failCount = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { passCount++; }
  else { failCount++; failures.push(name + (detail !== undefined && detail !== '' ? ' — ' + detail : '')); }
}
function eq(name, actual, expected) {
  const same = actual === expected;
  ok(name, same, 'actual=' + JSON.stringify(actual) + ' expected=' + JSON.stringify(expected));
}
function approxEq(name, actual, expected, tol) {
  tol = tol || 1e-9;
  const same = typeof actual === 'number' && typeof expected === 'number' &&
    Math.abs(actual - expected) <= tol;
  ok(name, same, 'actual=' + actual + ' expected=' + expected);
}

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

let nextId = 1;
function ev(fields) {
  const e = Object.assign({
    id: nextId++,
    time: null, matchTime: null,
    label: null, team: null, subtype: null,
    playerId: null, playerOffId: null, playerOnId: null,
    qualifiers: {}, location: null,
    period: '1H', matchSeconds: null,
    scoreForBefore: 0, scoreAgainstBefore: 0,
    scoreForAfter: null, scoreAgainstAfter: null,
    sequenceId: null,
    isInterval: false, startTime: null, endTime: null
  }, fields);
  if (e.time === null) e.time = e.matchTime;
  if (e.matchTime === null) e.matchTime = e.time;
  if (e.matchSeconds === null) e.matchSeconds = Math.floor(e.time);
  return e;
}

// MAIN fixture — 30 events, ids 1..30, deliberately listed OUT of canonical
// order to prove the (time asc, id asc) sort. All oracle numbers below were
// computed by hand from this list.
//
// our team ids: 1,2,3,4,5,6,7,8,10,11,12,13,16,17,18,19,20,21,22,24,25,26,30  (23)
// opponent ids: 9,14,15,23,27,28                                                (6)
// unattributed: 29                                                              (1)
function buildMainFixture() {
  nextId = 1;
  const list = [];
  const add = (fields) => list.push(ev(fields));

  // --- deliberately scrambled order (engine must sort) ---
  add({ id: 17, time: 3600, label: 'Goal', team: 'our', playerId: 'player_1',
    location: { x: 0.95, y: 0.5 }, period: '2H', matchSeconds: 3600,
    scoreForBefore: 1, scoreAgainstBefore: 1, scoreForAfter: 2, scoreAgainstAfter: 1,
    sequenceId: 'SEQ-003' });
  add({ id: 4, time: 200, label: 'Goal', team: 'our', playerId: 'player_1',
    qualifiers: { 'Body part': 'Right foot' }, location: { x: 0.95, y: 0.5 },
    period: '1H', matchSeconds: 200,
    scoreForBefore: 0, scoreAgainstBefore: 0, scoreForAfter: 1, scoreAgainstAfter: 0,
    sequenceId: 'SEQ-001' });
  add({ id: 14, time: 3300, label: 'Goal', team: 'opponent',
    location: { x: 0.05, y: 0.5 }, period: '2H', matchSeconds: 3300,
    scoreForBefore: 1, scoreAgainstBefore: 0, scoreForAfter: 1, scoreAgainstAfter: 1,
    sequenceId: 'SEQ-002' });
  add({ id: 1, time: 100, label: 'Pass', team: 'our', playerId: 'player_2', subtype: 'Progressive',
    qualifiers: { Outcome: 'Successful', Pressure: 'Under pressure' },
    location: { x: 0.5, y: 0.5 }, period: '1H', matchSeconds: 100,
    scoreForBefore: 0, scoreAgainstBefore: 0 });
  add({ id: 7, time: 2800, label: 'Possession', team: 'our', isInterval: true,
    startTime: 2800, endTime: 2804.04, qualifiers: { 'Ended by': 'Shot' },
    period: '2H', matchSeconds: 2800, scoreForBefore: 1, scoreAgainstBefore: 0 });
  add({ id: 12, time: 3110, label: 'Positive Transition', team: 'our', period: '2H', matchSeconds: 3110,
    scoreForBefore: 1, scoreAgainstBefore: 0 });
  add({ id: 2, time: 130, label: 'Shot', team: 'our', playerId: 'player_1', subtype: 'On target',
    qualifiers: { Situation: 'Open play', 'Body part': 'Left foot' },
    location: { x: 0.9, y: 0.5 }, period: '1H', matchSeconds: 130, sequenceId: 'SEQ-001',
    scoreForBefore: 0, scoreAgainstBefore: 0 });
  add({ id: 9, time: 3000, label: 'Possession', team: 'opponent', isInterval: true,
    startTime: 3000, endTime: 3001.96, qualifiers: { 'Ended by': 'Turnover' },
    period: '2H', matchSeconds: 3000, scoreForBefore: 1, scoreAgainstBefore: 0 });
  add({ id: 18, time: 5000, label: 'Press', team: 'our', playerId: 'player_2', period: '2H', matchSeconds: 5000,
    scoreForBefore: 2, scoreAgainstBefore: 1 });
  add({ id: 3, time: 131, label: 'Chance', team: 'our', playerId: 'player_1',
    location: { x: 0.9, y: 0.6 }, period: '1H', matchSeconds: 131, sequenceId: 'SEQ-001',
    scoreForBefore: 0, scoreAgainstBefore: 0 });
  add({ id: 23, time: 5350, label: 'Pass', team: 'opponent', subtype: null,
    qualifiers: { Outcome: 'Successful' }, period: '2H', matchSeconds: 5350,
    scoreForBefore: 2, scoreAgainstBefore: 1 });
  add({ id: 19, time: 5005, label: 'Press Win', team: 'our', playerId: 'player_2', period: '2H', matchSeconds: 5005,
    scoreForBefore: 2, scoreAgainstBefore: 1 });
  add({ id: 5, time: 2800, label: 'Foul', team: 'our', playerId: 'player_3', subtype: null,
    qualifiers: { Zone: 'Defensive third' }, location: { x: 0.1, y: 0.2 },
    period: '1H', matchSeconds: 2800, scoreForBefore: 1, scoreAgainstBefore: 0 }); // 1H stoppage (ms > 2700)
  add({ id: 24, time: 5380, label: 'Chance', team: 'our', playerId: 'player_1', period: '2H', matchSeconds: 5380,
    scoreForBefore: 2, scoreAgainstBefore: 1 });
  add({ id: 6, time: 2750, label: 'Pass', team: 'our', playerId: 'player_2', subtype: 'Lateral',
    qualifiers: { Outcome: 'Unsuccessful', Pressure: 'Free' },
    period: '2H', matchSeconds: 2750, scoreForBefore: 1, scoreAgainstBefore: 0 });
  add({ id: 30, time: 5600, label: 'Turnover', team: 'our', playerId: 'player_2',
    period: '2H', matchSeconds: 5600, scoreForBefore: 2, scoreAgainstBefore: 1 }); // 2H stoppage
  add({ id: 8, time: 2802, label: 'Shot', team: 'our', playerId: 'player_1', subtype: 'Off target',
    location: { x: 0.85, y: 0.8 }, period: '2H', matchSeconds: 2802,
    scoreForBefore: 1, scoreAgainstBefore: 0 });
  add({ id: 25, time: 5390, label: 'Cross', team: 'our', playerId: 'player_4', period: '2H', matchSeconds: 5390,
    scoreForBefore: 2, scoreAgainstBefore: 1 });
  add({ id: 10, time: 3100, label: 'Turnover', team: 'our', playerId: 'player_2',
    location: { x: 0.4, y: 0.5 }, period: '2H', matchSeconds: 3100,
    scoreForBefore: 1, scoreAgainstBefore: 0 });
  add({ id: 26, time: 5450, label: 'Corner', team: 'our', period: '2H', matchSeconds: 5450,
    scoreForBefore: 2, scoreAgainstBefore: 1 }); // 2H stoppage
  add({ id: 11, time: 3101, label: 'Negative Transition', team: 'our', period: '2H', matchSeconds: 3101,
    scoreForBefore: 1, scoreAgainstBefore: 0 });
  add({ id: 27, time: 5460, label: 'Card', team: 'opponent', subtype: 'Yellow',
    period: '2H', matchSeconds: 5460, scoreForBefore: 2, scoreAgainstBefore: 1 }); // 2H stoppage
  add({ id: 13, time: 3115, label: 'Shot', team: 'our', playerId: 'player_1', subtype: 'Blocked',
    location: { x: 0.7, y: 0.5 }, period: '2H', matchSeconds: 3115,
    scoreForBefore: 1, scoreAgainstBefore: 0 });
  add({ id: 28, time: 5465, label: 'Foul', team: 'opponent', period: '2H', matchSeconds: 5465,
    scoreForBefore: 2, scoreAgainstBefore: 1 }); // 2H stoppage
  add({ id: 16, time: 3500, label: 'Sub', team: 'our', playerOffId: 'player_3', playerOnId: 'player_4',
    period: '2H', matchSeconds: 3500, scoreForBefore: 1, scoreAgainstBefore: 1 });
  add({ id: 15, time: 3299.5, label: 'Shot', team: 'opponent', subtype: 'On target',
    location: { x: 0.05, y: 0.5 }, period: '2H', matchSeconds: 3299, sequenceId: 'SEQ-002',
    scoreForBefore: 1, scoreAgainstBefore: 0 });
  add({ id: 20, time: 5200, label: 'Interception', team: 'our', playerId: 'player_4', period: '2H', matchSeconds: 5200,
    scoreForBefore: 2, scoreAgainstBefore: 1 });
  add({ id: 29, time: 5500, label: 'Possession', team: null, isInterval: true,
    startTime: 5500, endTime: 5503, qualifiers: { 'Ended by': 'Out of play' },
    period: '2H', matchSeconds: 5500, scoreForBefore: 2, scoreAgainstBefore: 1 }); // unattributed interval, 2H stoppage
  add({ id: 21, time: 5250, label: 'Recovery', team: 'our', playerId: 'player_4', period: '2H', matchSeconds: 5250,
    scoreForBefore: 2, scoreAgainstBefore: 1 });
  add({ id: 22, time: 5300, label: 'Duel', team: 'our', playerId: 'player_2', period: '2H', matchSeconds: 5300,
    scoreForBefore: 2, scoreAgainstBefore: 1 });

  return {
    events: list,
    matchInfo: {
      opponent: 'Oracle FC', date: '2024-01-20', competition: 'Oracle League',
      homeAway: 'home', formation: '4-3-3',
      ourScore: '2', opponentScore: '1',
      startingXI: [{ playerId: 'player_1' }, { playerId: 'player_2' }, { playerId: 'player_3' }]
    },
    matchClock: { period: 'FT', scoreFor: 2, scoreAgainst: 1 },
    squad: [
      { id: 'player_1', number: '9', name: 'Striker' },
      { id: 'player_2', number: '8', name: 'Midfielder' },
      { id: 'player_3', number: '4', name: 'Defender' },
      { id: 'player_4', number: '10', name: 'Winger' }
    ]
  };
}

// ---------------------------------------------------------------------------
// A. Determinism + purity
// ---------------------------------------------------------------------------
console.log('== A. determinism & input purity (§12.1/§12.6) ==');
{
  const s1 = buildMainFixture();
  const before = JSON.stringify(s1.events);
  const A1 = AE.computeMatchAnalytics(s1);
  const A2 = AE.computeMatchAnalytics(s1);
  eq('A1 recompute is byte-identical (idempotence)', JSON.stringify(A1), JSON.stringify(A2));
  eq('A2 input events not mutated', JSON.stringify(s1.events), before);
  eq('A3 engine deterministic flag', A1.engine.deterministic, true);
  eq('A4 spec id', A1.spec, 'PitchLog-METRIC-SPEC-v1.0');
  // key-order stability (JSON.stringify already covers this, but double-check top level)
  eq('A5 stable top-level key order', Object.keys(A1).join(','),
    'spec,engine,input,validation,matchSummary,gates,level1,level3CountsNote,level3,level2,sequences,players,protocol');
}

// ---------------------------------------------------------------------------
// B. Validation layer
// ---------------------------------------------------------------------------
console.log('== B. validation (RAW EVENTS -> VALIDATION) ==');
{
  const A = AE.computeMatchAnalytics({
    events: [
      { id: 1, time: 10, label: 'Shot', team: 'our', period: '1H', matchSeconds: 10 },
      'not-an-object',
      { id: 3, time: 30, label: null, period: '2H', matchSeconds: 30 },
      { id: 4, time: 40, label: 'Foul', team: 'badteam', period: '1H', matchSeconds: 40 },
      { id: 5, label: 'Foul', period: '1H' } // no time
    ],
    matchInfo: null
  });
  const codes = {};
  A.validation.issues.forEach((i) => { codes[i.code] = i.count; });
  eq('B1 invalid event skipped', A.input.eventsSkipped, 1);
  eq('B2 MISSING_LABEL flagged', codes.MISSING_LABEL, 1);
  eq('B3 invalid team neutralised (not counted as our/opponent)', A.level1.team.unattributed.events.value, 3);
  ok('B4 missing time flagged', !!codes.MISSING_TIME, JSON.stringify(codes));
  ok('B5 issues sorted by code', A.validation.issues.every((v, i, a) => i === 0 || a[i - 1].code <= v.code), '');
  eq('B6 eventsUsed = rawCount - skipped', A.input.eventsUsed, 4);
  eq('B7 matchInfo null handled', A.matchSummary.opponent, '');
}

// ---------------------------------------------------------------------------
// C. Level 1 — team counts (MAIN oracle)
// ---------------------------------------------------------------------------
console.log('== C. Level 1 team counts (MAIN oracle, 30 events) ==');
{
  const A = AE.computeMatchAnalytics(buildMainFixture());
  const T = A.level1.team;
  const row = (side, key) => T[side][key].value;

  eq('C1  our events', row('our', 'events'), 23);
  eq('C2  opponent events', row('opponent', 'events'), 6);
  eq('C3  unattributed events', row('unattributed', 'events'), 1);

  eq('C4  our goals', row('our', 'goals'), 2);
  eq('C5  opponent goals', row('opponent', 'goals'), 1);
  eq('C6  our shots', row('our', 'shots'), 3);
  eq('C7  our shots on target', row('our', 'shotsOnTarget'), 1);
  eq('C8  our shots off target', row('our', 'shotsOffTarget'), 1);
  eq('C9  our shots blocked', row('our', 'shotsBlocked'), 1);
  eq('C10 our shots unknown outcome', row('our', 'shotsUnknownOutcome'), 0);
  eq('C11 opponent shots', row('opponent', 'shots'), 1);
  eq('C12 opponent shots on target', row('opponent', 'shotsOnTarget'), 1);

  eq('C13 our chances', row('our', 'chances'), 2);
  eq('C14 our crosses', row('our', 'crosses'), 1);
  eq('C15 our corners', row('our', 'corners'), 1);
  eq('C16 our fouls', row('our', 'fouls'), 1);
  eq('C17 opponent fouls', row('opponent', 'fouls'), 1);
  eq('C18 opponent yellow cards', row('opponent', 'yellowCards'), 0 + 1);
  eq('C19 our substitutions', row('our', 'substitutions'), 1);

  eq('C20 our passes', row('our', 'passes'), 2);
  eq('C21 our successful passes', row('our', 'successfulPasses'), 1);
  eq('C22 our unsuccessful passes', row('our', 'unsuccessfulPasses'), 1);
  eq('C23 our passes unknown outcome', row('our', 'passesUnknownOutcome'), 0);
  eq('C24 our progressive passes', row('our', 'progressivePasses'), 1);
  eq('C25 our lateral passes', row('our', 'lateralPasses'), 1);
  eq('C26 our backward passes', row('our', 'backwardPasses'), 0);
  eq('C27 our long passes', row('our', 'longPasses'), 0);
  eq('C28 our passes under pressure', row('our', 'passesUnderPressure'), 1);
  eq('C29 our passes free', row('our', 'passesFree'), 1);
  eq('C30 opponent passes', row('opponent', 'passes'), 1);
  eq('C31 opponent passes unknown subtype', row('opponent', 'passesUnknownSubtype'), 1);

  eq('C32 our presses', row('our', 'presses'), 1);
  eq('C33 our press wins', row('our', 'pressWins'), 1);
  eq('C34 our interceptions', row('our', 'interceptions'), 1);
  eq('C35 our recoveries', row('our', 'recoveries'), 1);
  eq('C36 our turnovers', row('our', 'turnovers'), 2);
  eq('C37 our duels', row('our', 'duels'), 1);
  eq('C38 our positive transitions', row('our', 'positiveTransitions'), 1);
  eq('C39 our negative transitions', row('our', 'negativeTransitions'), 1);

  // attributes (M-A16)
  eq('C40 shots by situation: Open play', A.level1.attributes.shotsBySituation.buckets['Open play'], 1);
  eq('C41 shots by situation: unknown', A.level1.attributes.shotsBySituation.unknown, 3);
  eq('C42 goals by body part: Right foot', A.level1.attributes.goalsByBodyPart.buckets['Right foot'], 1);
  eq('C43 goals by body part: unknown', A.level1.attributes.goalsByBodyPart.unknown, 2);
  eq('C44 fouls by zone: Defensive third', A.level1.attributes.foulsByZoneQualifier.buckets['Defensive third'], 1);
  eq('C45 fouls by zone: unknown', A.level1.attributes.foulsByZoneQualifier.unknown, 1);

  // located events (M-E1)
  eq('C46 located events', A.level1.spatial.locatedEvents.value, 11);
  eq('C47 located events excluded count', A.level1.spatial.locatedEvents.excluded.location, 19);

  // match summary facts
  const S = A.matchSummary;
  eq('C48 total events', S.totalEvents, 30);
  eq('C49 in-play events', S.inPlayEvents, 30);
  eq('C50 stoppage events', S.stoppageEvents, 6);
  eq('C51 stoppage flagged in 1H', S.stoppageByPeriod['1H'], true);
  eq('C52 stoppage flagged in 2H', S.stoppageByPeriod['2H'], true);
  eq('C53 periods played', S.periodsPlayed.join(','), '1H,2H');
  eq('C54 duration minutes (no ET)', S.durationMinutes, 90);
  eq('C55 unattributed (team) events', S.unattributedEvents, 1);
}

// ---------------------------------------------------------------------------
// D. Possession intervals + Tagged Possession Share (task directive)
// ---------------------------------------------------------------------------
console.log('== D. possession intervals & TAGGED POSSESSION SHARE ==');
{
  const A = AE.computeMatchAnalytics(buildMainFixture());
  const PO = A.level1.possession.our;
  const PP = A.level1.possession.opponent;
  const PU = A.level1.possession.unattributed;
  const share = A.level2.team.our.taggedPossessionShare;
  const oppShare = A.level2.team.opponent.taggedPossessionShare;

  eq('D1  our interval count (M-B10)', PO.intervals.value, 1);
  eq('D2  opponent interval count', PP.intervals.value, 1);
  eq('D3  unattributed interval count (explicit Unknown bucket)', PU.intervals.value, 1);

  // Full UNROUNDED seconds used internally; display value rounded (§12.3).
  approxEq('D4  our totalSecondsExact unrounded (M-B11)', PO.totalSecondsExact, 4.04);
  approxEq('D5  opponent totalSecondsExact unrounded', PP.totalSecondsExact, 1.96);
  eq('D6  our totalDuration display rounded', PO.totalDuration.value, 4);
  eq('D7  opponent totalDuration display rounded', PP.totalDuration.value, 2);

  // THE critical unrounded check: 4.04/(4.04+1.96) = 67.3% — computing from
  // rounded durations first would give 4.0/6.0 = 66.7% (WRONG).
  eq('D8  Tagged Possession Share uses UNROUNDED seconds (67.3, not 66.7)', share.value, 67.3);
  approxEq('D9  share numerator exact', share.num, 4.04);
  approxEq('D10 share denominator exact', share.den, 6.0);
  eq('D11 opponent share', oppShare.value, 32.7);

  // naming — never "Possession %", never an official statistic
  eq('D12 share is named "Tagged Possession Share"', share.name, 'Tagged Possession Share');
  eq('D13 share cites spec id M-L2-B4', share.specId, 'M-L2-B4');
  ok('D14 share basis states NOT an official match possession statistic',
    /not an official match possession statistic/i.test(share.basis), share.basis);
  ok('D15 limitation note present and mentions both durations + coverage',
    /Based only on 4\.0?4?s.*1\.96?2?s/.test(share.limitation) || /Based only on/.test(share.limitation) && /% of nominal match time tagged/.test(share.limitation),
    share.limitation);
  ok('D16 limitation note states NOT official', /NOT an official match possession/.test(share.limitation), '');
  approxEq('D17 coverage param (6.0s of 5400s)', share.params.taggedTimeCoveragePct, 0.1);
  eq('D18 match duration param', share.params.matchDurationSeconds, 5400);
  approxEq('D19 excluded unattributed interval seconds', share.excluded.unattributedTeamIntervalSeconds, 3.0);

  // raw interval data preserved verbatim
  eq('D20 raw interval list preserved (our)', PO.intervalList.length, 1);
  eq('D21 raw interval start/end preserved', PO.intervalList[0].startTime, 2800);
  eq('D22 raw interval end preserved', PO.intervalList[0].endTime, 2804.04);
  approxEq('D23 raw interval duration unrounded', PO.intervalList[0].durationSeconds, 4.04);
  eq('D24 raw interval end reason preserved', PO.intervalList[0].endedBy, 'Shot');
  eq('D25 raw unattributed interval team null preserved', PU.intervalList[0].team, null);

  // mean duration (M-B12)
  eq('D26 our mean duration display', PO.meanDuration.value, 4);
  eq('D27 opponent mean duration display', PP.meanDuration.value, 2);
  eq('D28 mean denominator = valid intervals', PO.meanDuration.den, 1);

  // end-reason distribution (M-B13)
  eq('D29 our end reasons: Shot', PO.endReasons.buckets.Shot, 1);
  eq('D30 opponent end reasons: Turnover', PP.endReasons.buckets.Turnover, 1);
  eq('D31 unattributed end reasons: Out of play', PU.endReasons.buckets['Out of play'], 1);
  eq('D32 end reasons unknown = 0', PO.endReasons.unknown + PP.endReasons.unknown + PU.endReasons.unknown, 0);

  // documented limitation appears in the protocol notes of the output
  ok('D33 protocol notes document the tagged-possession limitation',
    A.protocol.notes.some((n) => /TAGGED_POSSESSION_SHARE/.test(n) && /does NOT provide a complete independent possession dataset/.test(n)), '');

  // --- insufficient data: opponent intervals untagged -> null + reason ----
  nextId = 1;
  const small = AE.computeMatchAnalytics({
    events: [
      ev({ time: 100, label: 'Goal', team: 'our', scoreForAfter: 1, scoreAgainstAfter: 0, period: '1H', matchSeconds: 100 }),
      ev({ time: 200, label: 'Possession', team: 'our', isInterval: true, startTime: 200, endTime: 204, period: '1H', matchSeconds: 200 })
    ],
    matchInfo: { ourScore: '1', opponentScore: '0' }
  });
  const smallShare = small.level2.team.our.taggedPossessionShare;
  eq('D34 insufficient data: share value null (no false precision)', smallShare.value, null);
  eq('D35 insufficient data: reason OPPONENT_INTERVALS_UNTAGGED', smallShare.reason, 'OPPONENT_INTERVALS_UNTAGGED');
  ok('D36 insufficient data: limitation says so', /Insufficient tagged possession data/.test(smallShare.limitation), smallShare.limitation);
  // our + opponent durations still clearly reported
  eq('D37 our tagged duration still reported', small.level1.possession.our.totalDuration.value, 4);
  eq('D38 opponent tagged duration reported as 0', small.level1.possession.opponent.totalDuration.value, 0);
}

// ---------------------------------------------------------------------------
// E. Level 2 derived metrics
// ---------------------------------------------------------------------------
console.log('== E. Level 2 derived metrics ==');
{
  const A = AE.computeMatchAnalytics(buildMainFixture());
  const D = A.level2.team;

  // M-L2-A1 shot accuracy: blocked excluded from denominator
  eq('E1  our shot accuracy 1/(1+1)', D.our.shotAccuracy.value, 50);
  eq('E2  our shot accuracy excluded blocked', D.our.shotAccuracy.excluded.blocked, 1);
  eq('E3  opponent shot accuracy 1/(1+0)', D.opponent.shotAccuracy.value, 100);
  eq('E4  opponent shot accuracy denominator', D.opponent.shotAccuracy.den, 1);

  // M-L2-A2/A3 conversion
  eq('E5  our shot conversion 2/3', D.our.shotConversion.value, 66.7);
  eq('E6  our chance conversion 2/2', D.our.chanceConversion.value, 100);
  eq('E7  opponent chance conversion null (no chances)', D.opponent.chanceConversion.value, null);

  // M-L2-B1 pass success
  eq('E8  our pass success 1/2', D.our.passSuccess.value, 50);
  eq('E9  opponent pass success 1/1', D.opponent.passSuccess.value, 100);
  eq('E10 opponent unknown-outcome excluded reported', D.opponent.passSuccess.excluded.unknownOutcome, 0);

  // M-L2-B3 pressure-split pass success
  eq('E11 our under-pressure pass success 1/1', D.our.pressureSplitPassSuccess.underPressure.value, 100);
  eq('E12 our free pass success 0/1', D.our.pressureSplitPassSuccess.free.value, 0);
  eq('E13 opponent pressure splits null (no pressure-tagged passes)', D.opponent.pressureSplitPassSuccess.underPressure.value, null);

  // M-L2-B2 pass subtype profile
  eq('E14 our progressive share 1/2', D.our.passSubtypeProfile.shares.Progressive, 50);
  eq('E15 our lateral share 1/2', D.our.passSubtypeProfile.shares.Lateral, 50);
  eq('E16 our known subtype total', D.our.passSubtypeProfile.knownTotal, 2);
  eq('E17 opponent subtype profile all null (0 known)', D.opponent.passSubtypeProfile.shares.Progressive, null);
  eq('E18 opponent unknown subtype excluded', D.opponent.passSubtypeProfile.excluded.unknownSubtype, 1);

  // M-L2-C1 ball-winning events (the only sanctioned sum)
  eq('E19 our ball-winning events 1+1', D.our.ballWinningEvents.value, 2);
  eq('E20 opponent ball-winning events', D.opponent.ballWinningEvents.value, 0);

  // M-L2-C2 press win ratio
  eq('E21 our press win ratio 1/1', D.our.pressWinRatio.value, 100);
  eq('E22 opponent press win ratio null (0 presses)', D.opponent.pressWinRatio.value, null);

  // M-L2-G4 per-90 (degenerate for 90' matches = raw counts)
  eq('E23 our per-90 goals (90′ => raw)', D.our.per90.goals.value, 2);
  eq('E24 our per-90 shots', D.our.per90.shots.value, 3);
  eq('E25 per-90 duration param', D.our.per90.goals.params.durationMinutes, 90);

  // M-L2-A16 attribute shares
  eq('E26 shots by situation share (Open play 1/1)', A.level2.attributeShares.shotsBySituation.shares['Open play'], 100);
  eq('E27 shots by situation unknown total', A.level2.attributeShares.shotsBySituation.unknown, 3);
  eq('E28 goals by body part share', A.level2.attributeShares.goalsByBodyPart.shares['Right foot'], 100);

  // M-L2-E1 located-event share by label
  const lsl = A.level2.spatial.locatedEventShareByLabel;
  const shotShare = lsl.find((e) => e.label === 'Shot');
  const passShareRow = lsl.find((e) => e.label === 'Pass');
  const possShareRow = lsl.find((e) => e.label === 'Possession');
  eq('E29 located share: Shot 4/4', shotShare.share, 100);
  eq('E30 located share: Pass 1/3', passShareRow.share, 33.3);
  eq('E31 located share: Possession 0/3', possShareRow.share, 0);

  // ET match -> 120 nominal minutes, per-90 halves
  nextId = 1;
  const et = AE.computeMatchAnalytics({
    events: [
      ev({ time: 100, label: 'Goal', team: 'our', scoreForAfter: 1, scoreAgainstAfter: 0, period: '1H', matchSeconds: 100 }),
      ev({ time: 6400, label: 'Shot', team: 'our', period: 'ET2', matchSeconds: 6400 })
    ],
    matchInfo: null
  });
  eq('E32 ET events -> 120 nominal minutes', et.matchSummary.durationMinutes, 120);
  eq('E33 per-90 with 120′ (1 goal -> 0.8)', et.level2.team.our.per90.goals.value, 0.8);
}

// ---------------------------------------------------------------------------
// F. X-gates
// ---------------------------------------------------------------------------
console.log('== F. audit gates X1..X6 ==');
{
  const A = AE.computeMatchAnalytics(buildMainFixture());
  const G = A.gates;
  eq('F1  X1 MATCH (manual 2-1 = chain 2-1)', G.X1_scoreReconciliation.status, 'MATCH');
  eq('F2  X1 chain score', G.X1_scoreReconciliation.chain.for + '-' + G.X1_scoreReconciliation.chain.against, '2-1');
  eq('F3  X1 manual score parsed', G.X1_scoreReconciliation.manual.for + '-' + G.X1_scoreReconciliation.manual.against, '2-1');
  eq('F4  X2 unattributed total', G.X2_unattributedEvents.total, 1);
  eq('F5  X2 by label (Possession)', G.X2_unattributedEvents.byLabel.Possession, 1);
  eq('F6  X4 no flag (press wins <= presses)', G.X4_pressConsistency.our.flag || G.X4_pressConsistency.opponent.flag, false);
  eq('F7  X5 no flag (goals <= shots)', G.X5_goalShotCoTag.our.flag || G.X5_goalShotCoTag.opponent.flag, false);

  const x3 = {};
  G.X3_completeness.forEach((c) => { x3[c.scope + '|' + c.field] = c; });
  eq('F8  X3 Shot subtype 4/4', x3['Shot|subtype'].share, 100);
  eq('F9  X3 Pass subtype 2/3', x3['Pass|subtype'].share, 66.7);
  eq('F10 X3 Pass pressure 2/3', x3['Pass|Pressure qualifier'].share, 66.7);
  eq('F11 X3 Possession ended-by 3/3', x3['Possession|Ended-by qualifier'].share, 100);
  eq('F12 X3 all-events location 11/30', x3['All events|location'].share, 36.7);
  eq('F13 X3 all-events team 29/30', x3['All events|team'].share, 96.7);
  eq('F14 X3 all-events player 19/30', x3['All events|player attribution'].share, 63.3);

  const pair = (a, b) => G.X6_coTagAdvisory.pairs.find((p) => p.pair === a + ' / ' + b);
  eq('F15 X6 Chance/Shot co-timing 1 (same sequence)', pair('Chance', 'Shot').count, 1);
  eq('F16 X6 Turnover/Negative Transition 1', pair('Turnover', 'Negative Transition').count, 1);
  eq('F17 X6 Foul/Card 1 (Δt = 5s inclusive)', pair('Foul', 'Card').count, 1);
  eq('F18 X6 Recovery/Press Win 0', pair('Recovery', 'Press Win').count, 0);
  eq('F19 X6 no same-label near-duplicates in MAIN', G.X6_coTagAdvisory.sameLabel.length, 0);

  // X1 MISMATCH + MANUAL-EMPTY
  nextId = 1;
  const mm = AE.computeMatchAnalytics({
    events: [
      ev({ time: 100, label: 'Goal', team: 'our', scoreForAfter: 1, scoreAgainstAfter: 0, period: '1H', matchSeconds: 100 }),
      ev({ time: 200, label: 'Goal', team: 'opponent', scoreForBefore: 1, scoreAgainstBefore: 0, scoreForAfter: 1, scoreAgainstAfter: 1, period: '1H', matchSeconds: 200 })
    ],
    matchInfo: { ourScore: '3', opponentScore: '0' }
  });
  eq('F20 X1 MISMATCH detected', mm.gates.X1_scoreReconciliation.status, 'MISMATCH');
  eq('F21 X1 mismatch suppresses score-state metrics (F1/F2)', mm.level2.scoreState.changes.value, null);
  eq('F22 X1 mismatch reason recorded', mm.level2.scoreState.durationReason, 'SCORE_RECONCILIATION_MISMATCH');
  eq('F23 X1 mismatch suppresses CT-STATE (byState null)', mm.level3.byState, null);
  eq('F24 state suppressed reason exposed', mm.level3.stateSuppressedReason, 'SCORE_RECONCILIATION_MISMATCH');

  nextId = 1;
  const me = AE.computeMatchAnalytics({
    events: [ev({ time: 100, label: 'Goal', team: 'our', scoreForAfter: 1, scoreAgainstAfter: 0, period: '1H', matchSeconds: 100 })],
    matchInfo: {}
  });
  eq('F25 X1 MANUAL-EMPTY (chain is reference)', me.gates.X1_scoreReconciliation.status, 'MANUAL-EMPTY');
  eq('F26 manual-empty keeps state metrics', me.level2.scoreState.changes.value, 1);
}

// ---------------------------------------------------------------------------
// G. Score state M-L2-F1/F2
// ---------------------------------------------------------------------------
console.log('== G. score state (goal-chain based) ==');
{
  const A = AE.computeMatchAnalytics(buildMainFixture());
  const SS = A.level2.scoreState;
  eq('G1 state changes DRAW->W->D->W = 3', SS.changes.value, 3);
  eq('G2 time WINNING 3100+1800', SS.durationSeconds.WINNING, 4900);
  eq('G3 time DRAW 200+300', SS.durationSeconds.DRAW, 500);
  eq('G4 time LOSING 0', SS.durationSeconds.LOSING, 0);

  // unattributed goals break the chain
  nextId = 1;
  const ua = AE.computeMatchAnalytics({
    events: [
      ev({ time: 100, label: 'Goal', team: 'our', scoreForAfter: 1, scoreAgainstAfter: 0, period: '1H', matchSeconds: 100 }),
      ev({ time: 200, label: 'Goal', team: null, period: '1H', matchSeconds: 200 })
    ],
    matchInfo: {}
  });
  eq('G5 unattributed goal -> F1 null with reason', ua.level2.scoreState.changes.value, null);
  eq('G6 unattributed goal reason', ua.level2.scoreState.changes.reason, 'UNATTRIBUTED_GOALS');
  eq('G7 live clock reported from matchClock', A.matchSummary.score.liveClock.for + '-' + A.matchSummary.score.liveClock.against, '2-1');
}

// ---------------------------------------------------------------------------
// H. Transition linkage L(τ) — greedy backward match (§9.3)
// ---------------------------------------------------------------------------
console.log('== H. transition linkage (greedy backward L(τ)) ==');
{
  // GREEDY fixture: 5 PTs, 4 shots.
  //   PT 100(1H) PT 103(1H) PT 200(1H) PT 2695(1H) PT 2710(2H)
  //   Shot 108(1H) 210(1H) 2705(2H) 2718(2H)
  // Expected links: 108->PT103 (nearest, NOT PT100); 210->PT200 (Δt=10
  // inclusive); 2705-> none (Δt to 2695 is 10 but DIFFERENT PERIOD, and the
  // scan continues without finding a same-period one within τ);
  // 2718->PT2710 (Δt=8). Linked PTs = 3 of 5 = 60%.
  nextId = 1;
  const g = AE.computeMatchAnalytics({
    events: [
      ev({ time: 100, label: 'Positive Transition', team: 'our', period: '1H', matchSeconds: 100 }),
      ev({ time: 103, label: 'Positive Transition', team: 'our', period: '1H', matchSeconds: 103 }),
      ev({ time: 108, label: 'Shot', team: 'our', period: '1H', matchSeconds: 108 }),
      ev({ time: 200, label: 'Positive Transition', team: 'our', period: '1H', matchSeconds: 200 }),
      ev({ time: 210, label: 'Shot', team: 'our', period: '1H', matchSeconds: 210 }),
      ev({ time: 2695, label: 'Positive Transition', team: 'our', period: '1H', matchSeconds: 2695 }),
      ev({ time: 2705, label: 'Shot', team: 'our', period: '2H', matchSeconds: 2705 }),
      ev({ time: 2710, label: 'Positive Transition', team: 'our', period: '2H', matchSeconds: 2710 }),
      ev({ time: 2718, label: 'Shot', team: 'our', period: '2H', matchSeconds: 2718 })
    ],
    matchInfo: null
  });
  const D1 = g.level2.transitions.transitionToShot;
  eq('H1 greedy backward: one shot inflates at most one PT (3/5 not 4/5)', D1.value, 60);
  eq('H2 D1 denominator = all PTs', D1.den, 5);
  eq('H3 D1 tau reported (10s)', D1.params.tau, 10);

  // exclusive upper bound: Δt = τ links, Δt = τ+0.5 does not
  nextId = 1;
  const b = AE.computeMatchAnalytics({
    events: [
      ev({ time: 100, label: 'Positive Transition', team: 'our', period: '1H', matchSeconds: 100 }),
      ev({ time: 110, label: 'Shot', team: 'our', period: '1H', matchSeconds: 110 }),
      ev({ time: 300, label: 'Positive Transition', team: 'our', period: '1H', matchSeconds: 300 }),
      ev({ time: 310.5, label: 'Shot', team: 'our', period: '1H', matchSeconds: 310 })
    ],
    matchInfo: null
  });
  eq('H4 Δt = τ exactly links (inclusive)', b.level2.transitions.transitionToShot.num, 1);
  eq('H5 Δt = τ + 0.5 does not link', b.level2.transitions.transitionToShot.num, 1); // only the first PT linked

  // D4: opponent follow-ups, τ = 15
  nextId = 1;
  const d4 = AE.computeMatchAnalytics({
    events: [
      ev({ time: 100, label: 'Turnover', team: 'our', period: '1H', matchSeconds: 100 }),
      ev({ time: 105, label: 'Shot', team: 'opponent', period: '1H', matchSeconds: 105 }),
      ev({ time: 200, label: 'Turnover', team: 'our', period: '1H', matchSeconds: 200 }),
      ev({ time: 216, label: 'Chance', team: 'opponent', period: '1H', matchSeconds: 216 })
    ],
    matchInfo: null
  });
  const D4 = d4.level2.transitions.turnoversFollowedByOpponentShotOrChance;
  eq('H6 D4 links 1 of 2 (Δt=16 > τ=15 fails)', D4.value, 50);
  eq('H7 D4 tau reported (15s)', D4.params.tau, 15);

  // MAIN fixture D1..D4
  const A = AE.computeMatchAnalytics(buildMainFixture());
  const TR = A.level2.transitions;
  eq('H8  MAIN D1 1/1 (PT 3110 -> Shot 3115)', TR.transitionToShot.value, 100);
  eq('H9  MAIN D2 0/1 (chance 2270s later)', TR.transitionToChance.value, 0);
  eq('H10 MAIN D3 0/1', TR.transitionToGoal.value, 0);
  eq('H11 MAIN D4 0/2 (no opponent follow-up within 15s)', TR.turnoversFollowedByOpponentShotOrChance.value, 0);
}

// ---------------------------------------------------------------------------
// I. Level 3 contexts
// ---------------------------------------------------------------------------
console.log('== I. Level 3 contexts (CT-ZONE/THIRD/CHANNEL/PERIOD/MINBIN/STATE) ==');
{
  const A = AE.computeMatchAnalytics(buildMainFixture());
  const L3 = A.level3;

  eq('I1  attacking third events', L3.byThird['Attacking third'].events, 6);
  eq('I2  middle third events', L3.byThird['Middle third'].events, 2);
  eq('I3  defensive third events', L3.byThird['Defensive third'].events, 3);
  eq('I4  unlocated bucket', L3.byThird.Unlocated.events, 19);
  eq('I5  thirds sum to total (restriction, not addition)', 6 + 2 + 3 + 19, 30);
  eq('I6  attacking third goals', L3.byThird['Attacking third'].goals, 2);
  eq('I7  right channel events (y>=2/3)', L3.byChannel['Right channel'].events, 1);
  eq('I8  zone key: Attacking · Central', L3.byZone['Attacking third · Central channel'].events, 5);

  eq('I9  1H events', L3.byPeriod['1H'].counts.events, 5);
  eq('I10 2H events', L3.byPeriod['2H'].counts.events, 25);
  eq('I11 1H goals', L3.byPeriod['1H'].counts.goals, 1);
  eq('I12 2H goals', L3.byPeriod['2H'].counts.goals, 2);
  eq('I13 1H stoppage bucket events', L3.byPeriod['1H'].stoppage.events, 1);
  eq('I14 2H stoppage bucket events', L3.byPeriod['2H'].stoppage.events, 5);

  // minute bins derive from (period, matchSeconds), never officialMinute:
  // event at 1H ms=2800 is 45+ stoppage -> '1H 30-45+' bin.
  eq('I15 1H stoppage minute bin (45+)', L3.byMinuteBin['1H 30-45+'].events, 1);
  eq('I16 2H 45-60 bin', L3.byMinuteBin['2H 45-60'].events, 11);
  eq('I17 2H 60-75 bin', L3.byMinuteBin['2H 60-75'].events, 1);
  eq('I18 2H 75-90+ bin', L3.byMinuteBin['2H 75-90+'].events, 13);
  eq('I19 minute bins sum to 30', L3.byMinuteBin['1H 0-15'].events + L3.byMinuteBin['1H 15-30'].events +
    L3.byMinuteBin['1H 30-45+'].events + L3.byMinuteBin['2H 45-60'].events +
    L3.byMinuteBin['2H 60-75'].events + L3.byMinuteBin['2H 75-90+'].events, 30);
  eq('I20 1H 0-15 bin', L3.byMinuteBin['1H 0-15'].events, 4);

  eq('I21 byState DRAW events (state before event)', L3.byState.DRAW.events, 6);
  eq('I22 byState WINNING events', L3.byState.WINNING.events, 24);
  eq('I23 byState LOSING events', L3.byState.LOSING.events, 0);
  eq('I24 byState DRAW goals', L3.byState.DRAW.goals, 2);
  eq('I25 byState WINNING goals', L3.byState.WINNING.goals, 1);

  eq('I26 excluded block reports unlocated', L3.excluded.unlocated, 19);
  eq('I27 excluded block reports unattributed team', L3.excluded.unattributedTeam, 1);

  // officialMinute ambiguity regression: same officialMinute 45, different
  // (period, matchSeconds) => different bins (spec §6 CT-MINBIN note).
  nextId = 1;
  const amb = AE.computeMatchAnalytics({
    events: [
      ev({ time: 2695, label: 'Foul', team: 'our', period: '1H', matchSeconds: 2695, officialMinute: 45, second: 55 }),
      ev({ time: 2710, label: 'Foul', team: 'our', period: '2H', matchSeconds: 2710, officialMinute: 45, second: 10 })
    ],
    matchInfo: null
  });
  eq('I28 same officialMinute 45 -> different bins (1H 30-45+)', amb.level3.byMinuteBin['1H 30-45+'].fouls, 1);
  eq('I29 same officialMinute 45 -> different bins (2H 45-60)', amb.level3.byMinuteBin['2H 45-60'].fouls, 1);
}

// ---------------------------------------------------------------------------
// J. Players
// ---------------------------------------------------------------------------
console.log('== J. players (M-G1/G2/G5, M-L2-G1/G3) ==');
{
  const A = AE.computeMatchAnalytics(buildMainFixture());
  const P = A.players;
  const byId = {};
  P.list.forEach((p) => { byId[p.playerId] = p; });

  eq('J1  player_1 events', byId.player_1.events, 7);
  eq('J2  player_1 goals', byId.player_1.metrics.goals, 2);
  eq('J3  player_1 shots', byId.player_1.metrics.shots, 2 + 1); // e2 + e8 + e13 = 3
  eq('J4  player_1 shots on target', byId.player_1.metrics.shotsOnTarget, 1);
  eq('J5  player_1 chances', byId.player_1.metrics.chances, 2);
  eq('J6  player_2 pass success 1/2', byId.player_2.metrics.passSuccess.value, 50);
  eq('J7  player_2 turnovers', byId.player_2.metrics.turnovers, 2);
  eq('J8  player_2 positive events (pass-succ + press win)', byId.player_2.metrics.positiveEvents, 2);
  eq('J9  player_2 negative events (unsucc pass + 2 turnovers)', byId.player_2.metrics.negativeEvents, 3);
  eq('J10 player_3 subOff attribution', byId.player_3.metrics.subOff, 1);
  eq('J11 player_4 subOn attribution', byId.player_4.metrics.subOn, 1);
  eq('J12 player_4 events (sub-on + int + rec + cross)', byId.player_4.events, 4);
  eq('J13 player_4 positive events', byId.player_4.metrics.positiveEvents, 3);
  eq('J14 player_3 negative (foul committed by us)', byId.player_3.metrics.negativeEvents, 1);
  eq('J15 names resolved from squad', byId.player_1.name, 'Striker');
  eq('J16 appearance flags (XI + sub-on)', byId.player_1.appearance && byId.player_2.appearance &&
    byId.player_3.appearance && byId.player_4.appearance, true);
  eq('J17 deterministic sort (events desc, id asc): p1 before p2 on tie',
    P.list[0].playerId + ',' + P.list[1].playerId, 'player_1,player_2');
  eq('J18 unattributed player events', P.unattributed.events, 11);
  eq('J19 unattributed by label (Goal 1)', P.unattributed.byLabel.Goal, 1);
  eq('J20 unattributed by label (Possession 3)', P.unattributed.byLabel.Possession, 3);
  eq('J21 interpretive classification is flagged', P.classification, 'INTERPRETIVE');

  // opponent foul = neutral for OUR interpretive view (team perspective)
  nextId = 1;
  const f = AE.computeMatchAnalytics({
    events: [
      ev({ time: 100, label: 'Foul', team: 'opponent', playerId: 'player_1', period: '1H', matchSeconds: 100 })
    ],
    matchInfo: null
  });
  eq('J22 opponent foul is neutral in player classification', f.players.list[0].metrics.negativeEvents, 0);
}

// ---------------------------------------------------------------------------
// K. Sequences
// ---------------------------------------------------------------------------
console.log('== K. sequences ==');
{
  const A = AE.computeMatchAnalytics(buildMainFixture());
  const SQ = A.sequences;
  eq('K1 total sequences', SQ.total, 3);
  eq('K2 SEQ-001 event count', SQ.list[0].eventCount, 3);
  eq('K3 SEQ-001 duration', SQ.list[0].duration, 70);
  eq('K4 SEQ-001 team (first event)', SQ.list[0].team, 'our');
  approxEq('K5 SEQ-002 duration 0.5', SQ.list[1].duration, 0.5);
  eq('K6 SEQ-002 team', SQ.list[1].team, 'opponent');
  eq('K7 sorted ascending', SQ.list.map((s) => s.sequenceId).join(','), 'SEQ-001,SEQ-002,SEQ-003');
  eq('K8 mean event count (3+2+1)/3', SQ.meanEventCount, 2);
  eq('K9 mean duration (70+0.5+0)/3', SQ.meanDurationSeconds, 23.5);
  eq('K10 none span periods', SQ.spanningCount, 0);
  eq('K11 none contain transition markers', SQ.withTransition, 0);
}

// ---------------------------------------------------------------------------
// L. §9.4 worked example — anti-double-count + duplicate-tag watch
// ---------------------------------------------------------------------------
console.log('== L. anti-double-count (§9.4 worked example) ==');
{
  // The user's chain: Turnover(our, 61:04), Negative Transition(our, 61:05),
  // Shot(our, 61:09). Turnovers = 1 (not 2); Negative Transitions = 1;
  // Shots = 1; no metric anywhere shows 3 or 4; no "total transition events".
  nextId = 1;
  const w = AE.computeMatchAnalytics({
    events: [
      ev({ time: 3664, label: 'Turnover', team: 'our', period: '2H', matchSeconds: 3664 }),
      ev({ time: 3665, label: 'Negative Transition', team: 'our', period: '2H', matchSeconds: 3665 }),
      ev({ time: 3669, label: 'Shot', team: 'our', period: '2H', matchSeconds: 3669 })
    ],
    matchInfo: null
  });
  const T = w.level1.team.our;
  eq('L1 turnovers = 1 (not 2)', T.turnovers.value, 1);
  eq('L2 negative transitions = 1', T.negativeTransitions.value, 1);
  eq('L3 shots = 1', T.shots.value, 1);
  eq('L4 our events = 3 constructs, each counted once', T.events.value, 3);
  eq('L5 D4: no OPPONENT follow-up -> 0/1', w.level2.transitions.turnoversFollowedByOpponentShotOrChance.value, 0);
  const pair = w.gates.X6_coTagAdvisory.pairs.find((p) => p.pair === 'Turnover / Negative Transition');
  eq('L6 co-tagging is legitimate (advisory counts 1, metrics unchanged)', pair.count, 1);

  // same-label near-duplicate watch (the REAL double-tag risk)
  nextId = 1;
  const dup = AE.computeMatchAnalytics({
    events: [
      ev({ time: 100, label: 'Shot', team: 'our', period: '1H', matchSeconds: 100 }),
      ev({ time: 103, label: 'Shot', team: 'our', period: '1H', matchSeconds: 103 })
    ],
    matchInfo: null
  });
  eq('L7 duplicate watch flags 2 Shots within 5s', dup.gates.X6_coTagAdvisory.sameLabel.length, 1);
  eq('L8 duplicate watch label = Shot, count 1', dup.gates.X6_coTagAdvisory.sameLabel[0].label, 'Shot');
  // advisory only: counts are NOT deduplicated (no invented data removal)
  eq('L9 advisory does not deduplicate counts', dup.level1.team.our.shots.value, 2);
}

// ---------------------------------------------------------------------------
// M. Empty / minimal sessions
// ---------------------------------------------------------------------------
console.log('== M. empty & minimal sessions ==');
{
  const E = AE.computeMatchAnalytics({});
  eq('M1 empty session: 0 events', E.matchSummary.totalEvents, 0);
  eq('M2 empty session: share null NO_TAGGED_POSSESSION_INTERVALS',
    E.level2.team.our.taggedPossessionShare.reason, 'NO_TAGGED_POSSESSION_INTERVALS');
  eq('M3 empty session: X1 MANUAL-EMPTY', E.gates.X1_scoreReconciliation.status, 'MANUAL-EMPTY');
  eq('M4 empty session: score-state changes 0', E.level2.scoreState.changes.value, 0);
  eq('M5 empty session: DRAW 5400s', E.level2.scoreState.durationSeconds.DRAW, 5400);
  eq('M6 empty session: events-not-array flagged', E.validation.issues.some((i) => i.code === 'EVENTS_NOT_ARRAY'), true);

  const onlyGoals = AE.computeMatchAnalytics({ events: [] });
  eq('M7 zero-denominator ratios are null, never 0', onlyGoals.level2.team.our.shotAccuracy.value, null);
}

// ---------------------------------------------------------------------------
// N. Input contract: session JSON vs full-analysis CSV field set (§13)
// ---------------------------------------------------------------------------
console.log('== N. input contract: JSON vs full-analysis CSV columns ==');
{
  // Simulate the CSV-carried field set of buildFullAnalysisCsv (renderer.js):
  // carried: Label, Subtype, Team, Primary Player ID (playerId), Secondary
  // Player ID (playerOffId), Period, Match Seconds, Match Time (1 decimal),
  // X/Y (percent 1 decimal -> /100), Score Before/After, Sequence ID, and
  // qualifiers serialised into the Outcome column as "Group: value; ...".
  // NOT carried: playerOnId, isInterval/startTime/endTime (possession
  // duration metrics are therefore JSON-only), id (positional fallback).
  function csvRoundtrip(events) {
    return events.map((e) => {
      const out = {
        label: e.label, subtype: e.subtype || null, team: e.team || null,
        playerId: e.playerId || null, playerOffId: e.playerOffId || null, playerOnId: null,
        period: e.period, matchSeconds: e.matchSeconds,
        time: parseFloat(e.matchTime.toFixed(1)),
        sequenceId: e.sequenceId || null,
        scoreForBefore: e.scoreForBefore, scoreAgainstBefore: e.scoreAgainstBefore,
        scoreForAfter: e.scoreForAfter != null ? e.scoreForAfter : null,
        scoreAgainstAfter: e.scoreAgainstAfter != null ? e.scoreAgainstAfter : null,
        qualifiers: {}, location: null, isInterval: false
      };
      if (e.location) {
        out.location = {
          x: parseFloat((e.location.x * 100).toFixed(1)) / 100,
          y: parseFloat((e.location.y * 100).toFixed(1)) / 100
        };
      }
      const qualStr = Object.entries(e.qualifiers || {}).filter(([, v]) => v)
        .map(([k, v]) => k + ': ' + v).join('; ');
      qualStr.split('; ').filter(Boolean).forEach((pairStr) => {
        const i = pairStr.indexOf(': ');
        if (i > 0) out.qualifiers[pairStr.slice(0, i)] = pairStr.slice(i + 2);
      });
      return out;
    });
  }

  const s = buildMainFixture();
  const Ajson = AE.computeMatchAnalytics(s);
  const Acsv = AE.computeMatchAnalytics(Object.assign({}, s, { events: csvRoundtrip(s.events) }));

  const t = (A, side, k) => A.level1.team[side][k].value;
  eq('N1  team event counts identical', t(Ajson, 'our', 'events'), t(Acsv, 'our', 'events'));
  eq('N2  goals identical', t(Ajson, 'our', 'goals'), t(Acsv, 'our', 'goals'));
  eq('N3  shots identical', t(Ajson, 'our', 'shots'), t(Acsv, 'our', 'shots'));
  eq('N4  passes identical', t(Ajson, 'our', 'passes'), t(Acsv, 'our', 'passes'));
  eq('N5  successful passes identical (qualifiers roundtripped)', t(Ajson, 'our', 'successfulPasses'), t(Acsv, 'our', 'successfulPasses'));
  eq('N6  turnovers identical', t(Ajson, 'our', 'turnovers'), t(Acsv, 'our', 'turnovers'));
  eq('N7  pass success identical', Ajson.level2.team.our.passSuccess.value, Acsv.level2.team.our.passSuccess.value);
  eq('N8  X1 score chain identical', Acsv.gates.X1_scoreReconciliation.status, 'MATCH');
  eq('N9  byThird identical', Acsv.level3.byThird['Attacking third'].events, Ajson.level3.byThird['Attacking third'].events);
  eq('N10 byMinuteBin identical', Acsv.level3.byMinuteBin['2H 45-60'].events, Ajson.level3.byMinuteBin['2H 45-60'].events);
  eq('N11 attributes identical (situation)', Acsv.level1.attributes.shotsBySituation.buckets['Open play'], 1);
  eq('N12 players: p1 metrics identical', Acsv.players.list[0].events, 7);
  // documented CSV gaps:
  eq('N13 possession intervals NOT reconstructable from CSV (no bounds)',
    Acsv.level1.possession.our.intervals.value, 0);
  eq('N14 playerOnId not exported -> sub-on attribution lost in CSV',
    (Acsv.players.list.find((p) => p.playerId === 'player_4') || { events: 0 }).events, 3);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log('\n---- analytics engine tests: ' + passCount + ' passed, ' + failCount + ' failed ----');
if (failures.length) {
  console.log('FAILURES:');
  failures.forEach((f) => console.log('  ✗ ' + f));
  process.exitCode = 1;
}
