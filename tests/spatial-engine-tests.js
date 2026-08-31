#!/usr/bin/env node
// PitchLog / MatchTag — Spatial Engine V1 tests (pure Node, no jsdom)
// ====================================================================
// Verifies src/analytics.js A.spatial + computeSpatialView against
// docs/spatial-heatmap-specification.md (PitchLog-SPATIAL-SPEC-v1.0) using
// HAND-COMPUTED oracle fixtures.
//
// Sections:
//   S1  determinism + input purity (SP-T1)
//   S2  contract oracle (SP-T2): completeness, event records, grids, player
//       grids, possession-duration-by-zone, SP-X gates — 23-event fixture
//   S3  contract invariants (SP-T3): reconciliation with level1/level3,
//       partition sums, scope sums, record/bin consistency
//   S4  computeSpatialView (SP-T4): default view == contract; scope/team/
//       period/state/sequence/player filters; X1 state suppression
//   S5  UNROUNDED seconds (SP-T4b): exact interval durations in cells
//   S6  minimum sample param + exports
//   S7  out-of-range + invalid locations (SP-T10)
//   S8  custom tags participate (Part 5) without football interpretation
//   S9  player grids: Sub exclusion, ordering (SP-T9)
//   S10 empty session
//
// Run:  node tests/spatial-engine-tests.js   (from the pitchlog root)

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
function jeq(name, actual, expected) {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  ok(name, same, 'actual=' + JSON.stringify(actual) + ' expected=' + JSON.stringify(expected));
}
function approxEq(name, actual, expected, tol) {
  tol = tol || 1e-9;
  const same = typeof actual === 'number' && typeof expected === 'number' &&
    Math.abs(actual - expected) <= tol;
  ok(name, same, 'actual=' + actual + ' expected=' + expected);
}

// ---------------------------------------------------------------------------
// SPATIAL fixture — 23 events (hand-computed oracle). Goal chain: 1–1
// (id3 our, id7 opponent); matchInfo manual 1–1 => X1 MATCH (state filter
// allowed). Ids 1..23 have unique ascending times; events listed scrambled
// to prove canonical (time, id) ordering.
// ---------------------------------------------------------------------------

const SQUAD = [
  { id: 'pA', number: '9', name: 'Alpha' },
  { id: 'pB', number: '8', name: 'Bravo' }
];

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

function buildSpatialFixture() {
  nextId = 1;
  const list = [];
  const add = (fields) => list.push(ev(fields));

  // deliberately scrambled relative to id order
  add({ id: 9, time: 900, label: 'Possession', team: 'our', isInterval: true,
    startTime: 900, endTime: 1201.5, qualifiers: { 'Ended by': 'Shot' },
    location: { x: 0.5, y: 0.5 }, period: '2H', matchSeconds: 900,
    scoreForBefore: 1, scoreAgainstBefore: 1 });
  add({ id: 1, time: 130, label: 'Shot', team: 'our', playerId: 'pA', subtype: 'On target',
    location: { x: 0.9, y: 0.5 }, period: '1H', matchSeconds: 130, sequenceId: 'SEQ-001' });
  add({ id: 23, time: 2700, label: 'Chance', team: 'our', playerId: 'pA',
    location: { x: 0.85, y: 0.55 }, period: '2H', matchSeconds: 2700,
    scoreForBefore: 1, scoreAgainstBefore: 1 });
  add({ id: 2, time: 200, label: 'Shot', team: 'our', playerId: 'pA', subtype: 'Off target',
    location: { x: 0.88, y: 0.78 }, period: '1H', matchSeconds: 200, sequenceId: 'SEQ-001' });
  add({ id: 13, time: 1700, label: 'Possession', team: null, isInterval: true,
    startTime: 1700, endTime: 1740,
    location: { x: 0.35, y: 0.2 }, period: '2H', matchSeconds: 1700,
    scoreForBefore: 1, scoreAgainstBefore: 1 });
  add({ id: 3, time: 300, label: 'Goal', team: 'our', playerId: 'pA',
    location: { x: 0.95, y: 0.5 }, period: '1H', matchSeconds: 300, sequenceId: 'SEQ-001',
    scoreForBefore: 0, scoreAgainstBefore: 0, scoreForAfter: 1, scoreAgainstAfter: 0 });
  add({ id: 18, time: 2200, label: 'Opponent Overload', team: 'opponent',
    location: { x: 0.4, y: 0.9 }, period: '2H', matchSeconds: 2200,
    scoreForBefore: 1, scoreAgainstBefore: 1 });
  add({ id: 4, time: 400, label: 'Pass', team: 'our', playerId: 'pB', subtype: 'Progressive',
    location: { x: 0.5, y: 0.5 }, period: '1H', matchSeconds: 400,
    scoreForBefore: 1, scoreAgainstBefore: 0 });
  add({ id: 6, time: 600, label: 'Shot', team: 'opponent', subtype: 'On target',
    location: { x: 0.12, y: 0.6 }, period: '1H', matchSeconds: 600,
    scoreForBefore: 1, scoreAgainstBefore: 0 });
  add({ id: 21, time: 2500, label: 'Shot', team: 'our', subtype: 'Off target',
    location: { x: 1.2, y: 0.5 }, period: '2H', matchSeconds: 2500,
    scoreForBefore: 1, scoreAgainstBefore: 1 });
  add({ id: 5, time: 500, label: 'Pass', team: 'our', playerId: 'pB',
    location: null, period: '1H', matchSeconds: 500,
    scoreForBefore: 1, scoreAgainstBefore: 0 });
  add({ id: 10, time: 1300, label: 'Possession', team: 'our', isInterval: true,
    startTime: 1300, endTime: 1418, qualifiers: { 'Ended by': 'Turnover' },
    location: null, period: '2H', matchSeconds: 1300,
    scoreForBefore: 1, scoreAgainstBefore: 1 });
  add({ id: 7, time: 700, label: 'Goal', team: 'opponent',
    location: { x: 0.05, y: 0.5 }, period: '1H', matchSeconds: 700,
    scoreForBefore: 1, scoreAgainstBefore: 0, scoreForAfter: 1, scoreAgainstAfter: 1 });
  add({ id: 20, time: 2400, label: 'Sub', team: 'our', playerId: 'pB',
    playerOffId: 'pB', playerOnId: 'pC',
    location: { x: 0.5, y: 0.5 }, period: '2H', matchSeconds: 2400,
    scoreForBefore: 1, scoreAgainstBefore: 1 });
  add({ id: 14, time: 1800, label: 'Turnover', team: 'our', playerId: 'pB',
    location: { x: 0.15, y: 0.5 }, period: '2H', matchSeconds: 1800, sequenceId: 'SEQ-002',
    scoreForBefore: 1, scoreAgainstBefore: 1 });
  add({ id: 8, time: 800, label: 'Foul', team: 'our', playerId: 'pB',
    qualifiers: { Zone: 'Defensive third' },
    location: { x: 0.85, y: 0.5 }, period: '1H', matchSeconds: 800,
    scoreForBefore: 1, scoreAgainstBefore: 1 });
  add({ id: 11, time: 1500, label: 'Possession', team: 'opponent', isInterval: true,
    startTime: 1500, endTime: 1562.2, qualifiers: { 'Ended by': 'Out of play' },
    location: { x: 0.2, y: 0.5 }, period: '2H', matchSeconds: 1500,
    scoreForBefore: 1, scoreAgainstBefore: 1 });
  add({ id: 15, time: 1900, label: 'Recovery', team: 'our', playerId: 'pA',
    location: { x: 0.1, y: 0.8 }, period: '2H', matchSeconds: 1900, sequenceId: 'SEQ-002',
    scoreForBefore: 1, scoreAgainstBefore: 1 });
  add({ id: 22, time: 2600, label: 'Shot', team: 'our', subtype: 'Blocked',
    location: { x: 'bad', y: 0.5 }, period: '2H', matchSeconds: 2600,
    scoreForBefore: 1, scoreAgainstBefore: 1 });
  add({ id: 16, time: 2000, label: 'Press', team: 'our', playerId: 'pB',
    location: { x: 0.7, y: 0.3 }, period: '2H', matchSeconds: 2000, sequenceId: 'SEQ-002',
    scoreForBefore: 1, scoreAgainstBefore: 1 });
  add({ id: 12, time: 1600, label: 'Possession', team: 'opponent', isInterval: true,
    startTime: 1600, endTime: 1609.84, qualifiers: { 'Ended by': 'Foul won' },
    location: null, period: '2H', matchSeconds: 1600,
    scoreForBefore: 1, scoreAgainstBefore: 1 });
  add({ id: 17, time: 2100, label: 'Press Win', team: 'our', playerId: 'pB',
    location: { x: 0.75, y: 0.25 }, period: '2H', matchSeconds: 2100, sequenceId: 'SEQ-002',
    scoreForBefore: 1, scoreAgainstBefore: 1 });
  add({ id: 19, time: 2300, label: 'Opponent Overload', team: 'opponent',
    location: null, period: '2H', matchSeconds: 2300,
    scoreForBefore: 1, scoreAgainstBefore: 1 });

  return list;
}

const session = (events) => ({
  events,
  matchInfo: { opponent: 'Spatial FC', date: '2024-06-01', ourScore: '1', opponentScore: '1' },
  matchClock: { period: '2H', seconds: 2800, running: false, scoreFor: 1, scoreAgainst: 1 },
  squad: SQUAD,
  tags: []
});

// ---------------------------------------------------------------------------
// S1 — determinism + input purity (SP-T1)
// ---------------------------------------------------------------------------
{
  const events = buildSpatialFixture();
  const before = JSON.stringify(events);
  const A1 = AE.computeMatchAnalytics(session(events));
  const A2 = AE.computeMatchAnalytics(session(events));
  ok('S1a spatial deterministic (byte-identical recompute)',
    JSON.stringify(A1.spatial) === JSON.stringify(A2.spatial));
  eq('S1b input events not mutated', JSON.stringify(events), before);
  ok('S1c computeSpatialView deterministic',
    JSON.stringify(AE.computeSpatialView(A1, {})) === JSON.stringify(AE.computeSpatialView(A1, {})));
  eq('S1d spatial spec id', A1.spatial.spec, 'PitchLog-SPATIAL-SPEC-v1.0');
}

const A = AE.computeMatchAnalytics(session(buildSpatialFixture()));
const SP = A.spatial;

// ---------------------------------------------------------------------------
// S2 — contract oracle (SP-T2)
// ---------------------------------------------------------------------------
{
  // completeness
  const C = SP.completeness;
  eq('S2a total', C.total, 23);
  eq('S2b located', C.located, 18);
  eq('S2c unlocated', C.unlocated, 5);
  eq('S2d locatedShare value (18/23 = 78.3)', C.locatedShare.value, 78.3);
  eq('S2e locatedShare num/den', C.locatedShare.num + '/' + C.locatedShare.den, '18/23');
  eq('S2f locationOutOfRange', C.locationOutOfRange, 1);
  eq('S2g invalidLocation', C.invalidLocation, 1);

  const byLabelMap = {};
  C.byLabel.forEach((r) => { byLabelMap[r.label] = r; });
  eq('S2h byLabel Shot 4/5', byLabelMap.Shot.located + '/' + byLabelMap.Shot.total, '4/5');
  eq('S2i byLabel Pass 1/2', byLabelMap.Pass.located + '/' + byLabelMap.Pass.total, '1/2');
  eq('S2j byLabel Possession 3/5 (ids 9,10,11,12,13)', byLabelMap.Possession.located + '/' + byLabelMap.Possession.total, '3/5');
  eq('S2k custom tag in byLabel (1/2)', byLabelMap['Opponent Overload'].located + '/' + byLabelMap['Opponent Overload'].total, '1/2');

  // located event records (full precision x/y, bins, traceability fields)
  eq('S2l locatedEvents length', SP.locatedEvents.length, 18);
  eq('S2m unlocatedEvents length', SP.unlocatedEvents.length, 5);
  const rec1 = SP.locatedEvents.find((r) => r.eventId === 1);
  ok('S2n record id1 full field set', rec1 && rec1.label === 'Shot' && rec1.subtype === 'On target' &&
    rec1.team === 'our' && rec1.playerId === 'pA' && rec1.period === '1H' &&
    rec1.matchSeconds === 130 && rec1.minuteBin === '1H 0-15' && rec1.stateBefore === 'DRAW' &&
    rec1.sequenceId === 'SEQ-001' && rec1.isGoal === false && rec1.isInterval === false &&
    rec1.durationSecondsExact === null, JSON.stringify(rec1));
  eq('S2o record id1 x full precision', rec1 && rec1.x, 0.9);
  eq('S2p record id1 zone fields', rec1 && rec1.thirdIndex + '|' + rec1.channelIndex + '|' + rec1.zoneKey,
    '2|1|Attacking third · Central channel');
  const rec21 = SP.locatedEvents.find((r) => r.eventId === 21);
  ok('S2q out-of-range record kept with flag', rec21 && rec21.outOfRange === true && rec21.x === 1.2, JSON.stringify(rec21));
  eq('S2r out-of-range record clamped bin', rec21 && rec21.thirdIndex + '|' + rec21.channelIndex, '2|1');
  const rec20 = SP.locatedEvents.find((r) => r.eventId === 20);
  eq('S2s Sub record playerId nulled (spatial player grouping)', rec20 && rec20.playerId, null);
  const rec9 = SP.locatedEvents.find((r) => r.eventId === 9);
  eq('S2t interval record durationSecondsExact unrounded', rec9 && rec9.durationSecondsExact, 301.5);
  eq('S2u interval record isInterval', rec9 && rec9.isInterval, true);
  const unrec22 = SP.unlocatedEvents.find((r) => r.eventId === 22);
  ok('S2v invalid-location record is unlocated (no x/y/zoneKey)', unrec22 && unrec22.label === 'Shot' &&
    unrec22.x === undefined && unrec22.zoneKey === undefined, JSON.stringify(unrec22));
  const unrec10 = SP.unlocatedEvents.find((r) => r.eventId === 10);
  eq('S2w unlocated interval keeps exact duration', unrec10 && unrec10.durationSecondsExact, 118);

  // canonical (time asc, id asc) order of the record lists
  const ordered = SP.locatedEvents.every((r, i, arr) => i === 0 ||
    arr[i - 1].matchSeconds < r.matchSeconds || (arr[i - 1].matchSeconds === r.matchSeconds && arr[i - 1].eventId < r.eventId));
  ok('S2x locatedEvents canonical order', ordered);

  // grid object for scope all / partition all (hand-computed)
  const g = SP.grids.find((x) => x.scope === 'all' && x.partition === 'all');
  ok('S2y all/all grid exists', !!g);
  eq('S2z all/all population', g.population, 23);
  eq('S2z2 all/all located', g.located, 18);
  eq('S2z3 all/all unlocated', g.unlocated, 5);
  eq('S2z4 all/all locatedShare value', g.locatedShare.value, 78.3);
  const cellEvents = g.cells.map((c) => c.counts.events);
  jeq('S2z5 all/all cell event counts (row-major)', cellEvents, [0, 4, 1, 1, 3, 1, 2, 5, 1]);
  const attC = g.cells[7];
  eq('S2z6 Att·C bucket keys', attC.counts.events + '|' + attC.counts.goals + '|' + attC.counts.shots + '|' +
    attC.counts.fouls + '|' + attC.counts.chances, '5|1|2|1|1');
  const defC = g.cells[1];
  eq('S2z7 Def·C bucket keys', defC.counts.events + '|' + defC.counts.goals + '|' + defC.counts.shots + '|' +
    defC.counts.turnovers + '|' + defC.counts.possessionIntervals, '4|1|1|1|1');
  const attL = g.cells[6];
  eq('S2z8 Att·L presses/pressWins', attL.counts.presses + '/' + attL.counts.pressWins, '1/1');
  const midR = g.cells[5];
  eq('S2z9 custom tag counts only in events key (Mid·R)', midR.counts.events + '/' + (midR.counts.shots + midR.counts.passes + midR.counts.chances), '1/0');
  eq('S2za unlocated bucket keys', g.unlocatedBucket.counts.events + '|' + g.unlocatedBucket.counts.passes + '|' +
    g.unlocatedBucket.counts.possessionIntervals + '|' + g.unlocatedBucket.counts.shots, '5|1|2|1');
  jeq('S2zb byThird margin events', g.margins.byThird.map((m) => m.counts.events), [5, 5, 8]);
  jeq('S2zc byChannel margin events', g.margins.byChannel.map((m) => m.counts.events), [3, 12, 3]);

  // partition grids
  const gOur = SP.grids.find((x) => x.scope === 'all' && x.partition === 'our');
  eq('S2zd our population/located/unlocated', gOur.population + '/' + gOur.located + '/' + gOur.unlocated, '16/13/3');
  jeq('S2ze our cell events', gOur.cells.map((c) => c.counts.events), [0, 1, 1, 0, 3, 0, 2, 5, 1]);
  const gOpp = SP.grids.find((x) => x.scope === 'all' && x.partition === 'opponent');
  eq('S2zf opponent population/located/unlocated', gOpp.population + '/' + gOpp.located + '/' + gOpp.unlocated, '6/4/2');
  jeq('S2zg opponent cell events', gOpp.cells.map((c) => c.counts.events), [0, 3, 0, 0, 0, 1, 0, 0, 0]);
  const gUn = SP.grids.find((x) => x.scope === 'all' && x.partition === 'unattributed');
  eq('S2zh unattributed population/located', gUn.population + '/' + gUn.located, '1/1');
  eq('S2zi unattributed Mid·L possessionIntervals', gUn.cells[3].counts.possessionIntervals, 1);

  // scoped grids: Shot / custom tag / Goal
  const shotAll = SP.grids.find((x) => x.scope === 'Shot' && x.partition === 'all');
  eq('S2zj scope Shot population/located', shotAll.population + '/' + shotAll.located, '5/4');
  const shotOur = SP.grids.find((x) => x.scope === 'Shot' && x.partition === 'our');
  jeq('S2zk scope Shot our cells', shotOur.cells.map((c) => c.counts.events), [0, 0, 0, 0, 0, 0, 0, 2, 1]);
  const customOpp = SP.grids.find((x) => x.scope === 'Opponent Overload' && x.partition === 'opponent');
  eq('S2zl custom-tag scope grid', customOpp.population + '/' + customOpp.located + '/' + customOpp.unlocated, '2/1/1');
  const goalAll = SP.grids.find((x) => x.scope === 'Goal' && x.partition === 'all');
  eq('S2zm scope Goal located cells', goalAll.cells[1].counts.goals + '/' + goalAll.cells[7].counts.goals, '1/1');

  // possessionDurationByZone (UNROUNDED seconds, M-L2-B4 constraint)
  const D = SP.possessionDurationByZone;
  eq('S2zn duration name', D.name, 'Tagged Possession Duration by Zone');
  ok('S2zo duration basis NC-1 string', /not an official match possession statistic \(NC-1\)/.test(D.basis));
  eq('S2zp our locatedIntervals/unlocatedIntervals', D.our.locatedIntervals + '/' + D.our.unlocatedIntervals, '1/1');
  approxEq('S2zq our Mid·C exact seconds', D.our.secondsExact.cells[4], 301.5);
  approxEq('S2zr our unlocated exact seconds', D.our.secondsExact.unlocated, 118);
  approxEq('S2zs our totalSecondsExact (419.5)', D.our.totalSecondsExact, 419.5);
  approxEq('S2zt opponent Def·C exact seconds', D.opponent.secondsExact.cells[1], 62.2);
  approxEq('S2zu opponent unlocated exact (9.84)', D.opponent.secondsExact.unlocated, 9.84);
  approxEq('S2zv opponent totalSecondsExact (72.04)', D.opponent.totalSecondsExact, 72.04);
  approxEq('S2zw unattributed Mid·L exact seconds', D.unattributed.secondsExact.cells[3], 40);
  approxEq('S2zx unattributed totalSecondsExact', D.unattributed.totalSecondsExact, 40);

  // gates
  eq('S2zy SP-X1 locatedShareOverall', SP.gates['SP-X1'].locatedShareOverall, 78.3);
  eq('S2zz SP-X1 out-of-range/invalid', SP.gates['SP-X1'].locationOutOfRange + '/' + SP.gates['SP-X1'].invalidLocation, '1/1');
  eq('S2zza SP-X2 foul zone-qualifier mismatches (Defensive claim vs Attacking location)', SP.gates['SP-X2'].foulZoneQualifierMismatches, 1);
  eq('S2zzb minSampleForDensity param', SP.params.minSampleForDensity, 6);
  eq('S2zzc model zoneKeys row-major', SP.model.zoneKeys[0] + '|' + SP.model.zoneKeys[4] + '|' + SP.model.zoneKeys[8],
    'Defensive third · Left channel|Middle third · Central channel|Attacking third · Right channel');
  eq('S2zzd model cellKeys count', SP.model.cellKeys.length, 19);
}

// ---------------------------------------------------------------------------
// S3 — contract invariants (SP-T3)
// ---------------------------------------------------------------------------
{
  eq('S3a located == matchSummary.locatedEvents', SP.locatedEvents.length, A.matchSummary.locatedEvents);
  eq('S3b located == level1.spatial.locatedEvents.value', SP.locatedEvents.length, A.level1.spatial.locatedEvents.value);
  eq('S3c located + unlocated == total records', SP.locatedEvents.length + SP.unlocatedEvents.length, SP.completeness.total);

  // grid internal consistency + partition sums for every scope
  const scopes = [...new Set(SP.grids.map((g) => g.scope))];
  let gridOk = true;
  let partOk = true;
  let scopeSumOk = true;
  scopes.forEach((sc) => {
    const byPart = {};
    SP.grids.filter((g) => g.scope === sc).forEach((g) => { byPart[g.partition] = g; });
    // internal: Σ cells + unlocated bucket == population; margins == located
    SP.grids.filter((g) => g.scope === sc).forEach((g) => {
      const sum = g.cells.reduce((a, c) => a + c.counts.events, 0) + g.unlocatedBucket.counts.events;
      if (sum !== g.located + g.unlocated) gridOk = false;
      if (g.located + g.unlocated !== g.population) gridOk = false;
      // margins reconcile with cells
      const th = g.margins.byThird.reduce((a, m) => a + m.counts.events, 0);
      const ch = g.margins.byChannel.reduce((a, m) => a + m.counts.events, 0);
      if (th !== g.located || ch !== g.located) gridOk = false;
    });
    // partitions: our + opponent + unattributed == all (population, located, every key)
    ['population', 'located'].forEach((f) => {
      if (byPart.our[f] + byPart.opponent[f] + byPart.unattributed[f] !== byPart.all[f]) partOk = false;
    });
    for (let i = 0; i < 9; i++) {
      SP.model.cellKeys.forEach((k) => {
        const s = byPart.our.cells[i].counts[k] + byPart.opponent.cells[i].counts[k] + byPart.unattributed.cells[i].counts[k];
        if (s !== byPart.all.cells[i].counts[k]) partOk = false;
      });
      if (byPart.our.unlocatedBucket.counts.events + byPart.opponent.unlocatedBucket.counts.events +
        byPart.unattributed.unlocatedBucket.counts.events !== byPart.all.unlocatedBucket.counts.events) partOk = false;
    }
    // scope sums: Σ label scopes == 'all' scope (per partition, per cell)
    if (sc === 'all') {
      ['our', 'opponent', 'unattributed', 'all'].forEach((p) => {
        for (let i = 0; i < 9; i++) {
          SP.model.cellKeys.forEach((k) => {
            const s = SP.grids.filter((g) => g.scope !== 'all' && g.partition === p)
              .reduce((a, g) => a + g.cells[i].counts[k], 0);
            if (s !== byPart[p].cells[i].counts[k]) scopeSumOk = false;
          });
        }
      });
    }
  });
  ok('S3d every grid: cells + unlocated bucket == population; margins == located', gridOk);
  ok('S3e every scope: our + opponent + unattributed == all (all keys)', partOk);
  ok('S3f Σ label-scope grids == aggregate grid (all partitions, all keys)', scopeSumOk);

  // equality with the v1 engine output (scope all / partition all)
  const g = SP.grids.find((x) => x.scope === 'all' && x.partition === 'all');
  let zoneEq = true;
  g.cells.forEach((c) => {
    const l3 = A.level3.byZone[c.zoneKey];
    if (!l3) { zoneEq = false; return; }
    SP.model.cellKeys.forEach((k) => { if (l3[k] !== c.counts[k]) zoneEq = false; });
  });
  SP.model.cellKeys.forEach((k) => {
    if (A.level3.byZone.Unlocated[k] !== g.unlocatedBucket.counts[k]) zoneEq = false;
  });
  ok('S3g grid cells == level3.byZone (all 19 keys incl. Unlocated)', zoneEq);
  let thirdEq = true;
  g.margins.byThird.forEach((m) => {
    SP.model.cellKeys.forEach((k) => { if (A.level3.byThird[m.name][k] !== m.counts[k]) thirdEq = false; });
  });
  ok('S3h grid byThird margins == level3.byThird', thirdEq);
  let chanEq = true;
  g.margins.byChannel.forEach((m) => {
    SP.model.cellKeys.forEach((k) => { if (A.level3.byChannel[m.name][k] !== m.counts[k]) chanEq = false; });
  });
  ok('S3i grid byChannel margins == level3.byChannel', chanEq);

  // possession duration invariant vs level1 (unrounded basis)
  approxEq('S3j duration our total == level1.possession.our.totalSecondsExact', SP.possessionDurationByZone.our.totalSecondsExact, A.level1.possession.our.totalSecondsExact);
  approxEq('S3k duration opp total == level1.possession.opponent.totalSecondsExact', SP.possessionDurationByZone.opponent.totalSecondsExact, A.level1.possession.opponent.totalSecondsExact);
  approxEq('S3l duration unattr total == level1.possession.unattributed.totalSecondsExact', SP.possessionDurationByZone.unattributed.totalSecondsExact, A.level1.possession.unattributed.totalSecondsExact);

  // record/bin consistency + outOfRange reconciliation
  let binOk = true;
  SP.locatedEvents.forEach((r) => {
    const ti = Math.min(2, Math.max(0, Math.floor(r.x * 3)));
    const ci = Math.min(2, Math.max(0, Math.floor(r.y * 3)));
    if (ti !== r.thirdIndex || ci !== r.channelIndex) binOk = false;
    if (r.zoneKey !== SP.model.thirds[ti] + ' · ' + SP.model.channels[ci]) binOk = false;
  });
  ok('S3m every record bin matches floor-clamped (x, y)', binOk);
  eq('S3n outOfRange flags == completeness.locationOutOfRange',
    SP.locatedEvents.filter((r) => r.outOfRange).length, SP.completeness.locationOutOfRange);

  // players reconciliation: player grids cover exactly the playerId-attributed non-Sub events
  const nonSubWithPlayer = SP.locatedEvents.filter((r) => r.playerId).map((r) => r.eventId).sort((a, b) => a - b);
  const inPlayerGrids = SP.playerGrids.reduce((a, g) => a.concat(g.events.map((r) => r.eventId)), []).sort((a, b) => a - b);
  jeq('S3o playerGrids cover located playerId events exactly', inPlayerGrids, nonSubWithPlayer);
}

// ---------------------------------------------------------------------------
// S4 — computeSpatialView (SP-T4)
// ---------------------------------------------------------------------------
{
  const view = AE.computeSpatialView(A, {});
  eq('S4a default view total/located/unlocated', view.completeness.total + '/' + view.completeness.located + '/' + view.completeness.unlocated, '23/18/5');
  eq('S4b default grids = our + opponent', view.grids.map((g) => g.partition).join(','), 'our,opponent');
  eq('S4c default our grid == contract our grid (cells)',
    JSON.stringify(view.grids[0].cells), JSON.stringify(SP.grids.find((g) => g.scope === 'all' && g.partition === 'our').cells));
  eq('S4d default opponent grid == contract opponent grid (cells)',
    JSON.stringify(view.grids[1].cells), JSON.stringify(SP.grids.find((g) => g.scope === 'all' && g.partition === 'opponent').cells));
  eq('S4e default tableGrid == contract all grid (cells)',
    JSON.stringify(view.tableGrid.cells), JSON.stringify(SP.grids.find((g) => g.scope === 'all' && g.partition === 'all').cells));
  eq('S4f default view unattributedLocated', view.unattributedLocated, 1);
  eq('S4g view grids carry events arrays for dots/traceability', view.grids[0].events.length, 13);
  jeq('S4h sequenceOptions', view.sequenceOptions, ['SEQ-001', 'SEQ-002']);
  eq('S4i stateFilterSuppressed null on MATCH', view.stateFilterSuppressed, null);

  // scope filter (Shot)
  const vShot = AE.computeSpatialView(A, { scope: 'Shot' });
  eq('S4j scope Shot total/located', vShot.completeness.total + '/' + vShot.completeness.located, '5/4');
  jeq('S4k scope Shot our cells', vShot.grids[0].cells.map((c) => c.counts.events), [0, 0, 0, 0, 0, 0, 0, 2, 1]);
  eq('S4l scope Shot our events array', vShot.grids[0].events.length, 3);

  // team filter (opponent focus)
  const vOpp = AE.computeSpatialView(A, { team: 'opponent' });
  eq('S4m team opponent single grid', vOpp.grids.map((g) => g.partition).join(','), 'opponent');
  eq('S4n team opponent located', vOpp.grids[0].located, 4);
  eq('S4o team filter tableGrid reflects restriction', vOpp.tableGrid.located, 4);

  // period filter (1H: ids 1..8)
  const v1H = AE.computeSpatialView(A, { period: '1H' });
  eq('S4p period 1H total/located/unlocated', v1H.completeness.total + '/' + v1H.completeness.located + '/' + v1H.completeness.unlocated, '8/7/1');
  jeq('S4q period 1H tableGrid cells', v1H.tableGrid.cells.map((c) => c.counts.events), [0, 2, 0, 0, 1, 0, 0, 3, 1]);

  // state filter (WINNING: ids 4,5,6,7)
  const vWin = AE.computeSpatialView(A, { state: 'WINNING' });
  eq('S4r state WINNING total/located', vWin.completeness.total + '/' + vWin.completeness.located, '4/3');
  jeq('S4s state WINNING tableGrid cells', vWin.tableGrid.cells.map((c) => c.counts.events), [0, 2, 0, 0, 1, 0, 0, 0, 0]);

  // sequence filter
  const vSeq = AE.computeSpatialView(A, { sequence: 'SEQ-001' });
  eq('S4t sequence SEQ-001 located', vSeq.completeness.located, 3);
  jeq('S4u sequence SEQ-001 cells', vSeq.tableGrid.cells.map((c) => c.counts.events), [0, 0, 0, 0, 0, 0, 0, 2, 1]);

  // player filter (pA: single grid, partition label, 5 located)
  const vPA = AE.computeSpatialView(A, { player: 'pA' });
  eq('S4v player pA single grid partition', vPA.grids.map((g) => g.partition).join(','), 'player:pA');
  ok('S4w player pA partition label resolved from squad', vPA.grids[0].partitionLabel === 'Player: 9 Alpha', vPA.grids[0].partitionLabel);
  eq('S4x player pA located', vPA.grids[0].located, 5);
  jeq('S4y player pA cells', vPA.grids[0].cells.map((c) => c.counts.events), [0, 0, 1, 0, 0, 0, 0, 3, 1]);

  // combined filters: period 1H + scope Shot (ids 1,2,6 — all located)
  const vComb = AE.computeSpatialView(A, { scope: 'Shot', period: '1H' });
  eq('S4z combined scope+period total/located', vComb.completeness.total + '/' + vComb.completeness.located, '3/3');

  // view playerGrids (filtered): pA 5 located, pB 5 located — order Alpha first
  jeq('S4za view playerGrids order', view.playerGrids.map((g) => g.partitionLabel), ['9 Alpha', '8 Bravo']);
  eq('S4zb view playerGrids have events arrays', view.playerGrids[0].events.length, 5);

  // view possession duration (default == contract)
  approxEq('S4zc view duration our total == contract', view.possessionDurationByZone.our.totalSecondsExact, 419.5);
  const v2H = AE.computeSpatialView(A, { period: '2H' });
  approxEq('S4zd duration filtered to 2H (all intervals are 2H)', v2H.possessionDurationByZone.our.totalSecondsExact, 419.5);
  const vShotDur = AE.computeSpatialView(A, { scope: 'Shot' });
  eq('S4ze scope Shot: no possession intervals in view', vShotDur.possessionDurationByZone.our.totalSecondsExact, 0);

  // X1 MISMATCH: state filter suppressed (forced off + reported)
  const evMis = buildSpatialFixture();
  const Amis = AE.computeMatchAnalytics(session(evMis).matchInfo ? {
    events: evMis,
    matchInfo: { opponent: 'Spatial FC', date: '2024-06-01', ourScore: '5', opponentScore: '0' },
    matchClock: null, squad: SQUAD, tags: []
  } : { events: evMis });
  eq('S4zf mismatch fixture X1 status', Amis.gates.X1_scoreReconciliation.status, 'MISMATCH');
  const vMis = AE.computeSpatialView(Amis, { state: 'WINNING' });
  eq('S4zg state filter forced off under MISMATCH', vMis.filters.state, '__all__');
  ok('S4zh stateFilterSuppressed reported', !!vMis.stateFilterSuppressed);
  eq('S4zi MISMATCH view completeness unaffected', vMis.completeness.total, 23);

  // defensive: view on an analytics object without spatial -> null
  eq('S4zj view returns null without A.spatial', AE.computeSpatialView({ gates: {} }, {}), null);
}

// ---------------------------------------------------------------------------
// S5 — UNROUNDED seconds regression (SP-T4b, spatial twin of the 67.3% test)
// ---------------------------------------------------------------------------
{
  // 301.5 + 118 = 419.5: values that a rounded-early implementation would
  // turn into 302 + 118 = 420 (or share-based 419.5 -> 420).
  const D = SP.possessionDurationByZone.our;
  ok('S5a exact unrounded sums preserved (301.5, 118, 419.5)',
    D.secondsExact.cells[4] === 301.5 && D.secondsExact.unlocated === 118 && D.totalSecondsExact === 419.5,
    JSON.stringify(D));
  // x/y full precision preserved (not pre-rounded to 2 decimals)
  const rec = SP.locatedEvents.find((r) => r.eventId === 23);
  eq('S5b x full precision preserved', rec.x, 0.85);
  const recOor = SP.locatedEvents.find((r) => r.eventId === 21);
  eq('S5c out-of-range x preserved exactly (1.2)', recOor.x, 1.2);
}

// ---------------------------------------------------------------------------
// S6 — exports
// ---------------------------------------------------------------------------
{
  eq('S6a MIN_SAMPLE_FOR_DENSITY exported', AE.MIN_SAMPLE_FOR_DENSITY, 6);
  eq('S6b SPATIAL_SPEC exported', AE.SPATIAL_SPEC, 'PitchLog-SPATIAL-SPEC-v1.0');
  eq('S6c engine version bumped for spatial', typeof AE.VERSION === 'string' && AE.VERSION >= '1.1.0', true);
}

// ---------------------------------------------------------------------------
// S7 — out-of-range + invalid locations (SP-T10)
// ---------------------------------------------------------------------------
{
  ok('S7a out-of-range participates clamped + flagged (S2q/S2r)',
    SP.locatedEvents.find((r) => r.eventId === 21).thirdIndex === 2 &&
    SP.locatedEvents.find((r) => r.eventId === 21).outOfRange === true);
  const gOur = SP.grids.find((x) => x.scope === 'all' && x.partition === 'our');
  eq('S7b out-of-range shot counted in our Att·C', gOur.cells[7].counts.shots, 2);
  ok('S7c invalid location dropped to unlocated bucket (S2v)',
    SP.unlocatedEvents.find((r) => r.eventId === 22) !== undefined);
  eq('S7d invalid counted in completeness.invalidLocation', SP.completeness.invalidLocation, 1);
  eq('S7e invalid NOT in completeness.locationOutOfRange', SP.completeness.locationOutOfRange, 1);
  // negative out-of-range clamps to index 0
  const events = buildSpatialFixture();
  events.push(ev({ id: 24, time: 2800, label: 'Shot', team: 'our',
    location: { x: -0.3, y: 0.5 }, period: '2H', matchSeconds: 2800,
    scoreForBefore: 1, scoreAgainstBefore: 1 }));
  const A24 = AE.computeMatchAnalytics(session(events));
  const r24 = A24.spatial.locatedEvents.find((r) => r.eventId === 24);
  ok('S7f negative x clamps to Defensive third + flagged', r24.thirdIndex === 0 && r24.outOfRange === true, JSON.stringify(r24));
  eq('S7g out-of-range count now 2', A24.spatial.completeness.locationOutOfRange, 2);
}

// ---------------------------------------------------------------------------
// S8 — custom tags participate without football interpretation (Part 5)
// ---------------------------------------------------------------------------
{
  const scopes = [...new Set(SP.grids.map((g) => g.scope))];
  ok('S8a custom tag has its own scope grid', scopes.indexOf('Opponent Overload') !== -1);
  const cg = SP.grids.find((g) => g.scope === 'Opponent Overload' && g.partition === 'all');
  const onlyEvents = SP.model.cellKeys.every((k) => k === 'events' || cg.cells.every((c) => c.counts[k] === 0));
  ok('S8b custom tag counts land ONLY in the generic events key', onlyEvents);
  eq('S8c custom tag grid total', cg.population, 2);
  const view = AE.computeSpatialView(A, { scope: 'Opponent Overload' });
  eq('S8d custom tag selectable in view (scope filter)', view.completeness.total, 2);
  ok('S8e scope set covers every label present (canonical first, custom sorted)',
    scopes.indexOf('Goal') < scopes.indexOf('Shot') && scopes.indexOf('Recovery') < scopes.indexOf('Opponent Overload'),
    scopes.join(','));
}

// ---------------------------------------------------------------------------
// S9 — player grids (SP-T9)
// ---------------------------------------------------------------------------
{
  jeq('S9a playerGrids order (located desc, name asc)', SP.playerGrids.map((g) => g.partitionLabel), ['9 Alpha', '8 Bravo']);
  const pa = SP.playerGrids.find((g) => g.playerId === 'pA');
  const pb = SP.playerGrids.find((g) => g.playerId === 'pB');
  eq('S9b pA population (Sub excluded by playerId-null rule)', pa.population, 5);
  eq('S9c pB population (Sub id20 NOT attributed spatially)', pb.population, 6);
  eq('S9d pB unlocated (id5 Pass)', pb.unlocated, 1);
  ok('S9e Sub event (id20) not in any player grid',
    SP.playerGrids.every((g) => !g.events.some((r) => r.eventId === 20)));
  ok('S9f playerOnId pC not in player grids', SP.playerGrids.every((g) => g.playerId !== 'pC'));
  // squad-name resolution + Unknown player fallback
  eq('S9g name resolution from squad', pa.name + '/' + pa.number, 'Alpha/9');
  const events = buildSpatialFixture();
  events.push(ev({ id: 25, time: 2850, label: 'Shot', team: 'our', playerId: 'pX',
    location: { x: 0.6, y: 0.6 }, period: '2H', matchSeconds: 2850,
    scoreForBefore: 1, scoreAgainstBefore: 1 }));
  const AX = AE.computeMatchAnalytics(session(events));
  const gx = AX.spatial.playerGrids.find((g) => g.playerId === 'pX');
  eq('S9h unknown player fallback label', gx && gx.partitionLabel, 'Unknown player');
}

// ---------------------------------------------------------------------------
// S10 — empty session
// ---------------------------------------------------------------------------
{
  const A0 = AE.computeMatchAnalytics({ events: [] });
  eq('S10a empty completeness total/located', A0.spatial.completeness.total + '/' + A0.spatial.completeness.located, '0/0');
  eq('S10b empty locatedShare null (P5)', A0.spatial.completeness.locatedShare.value, null);
  eq('S10c empty grids = one scope × 4 partitions', A0.spatial.grids.length, 4);
  eq('S10d empty playerGrids', A0.spatial.playerGrids.length, 0);
  const v0 = AE.computeSpatialView(A0, {});
  eq('S10e empty view total', v0.completeness.total, 0);
  eq('S10f empty view grids our+opponent at 0', v0.grids.map((g) => g.located).join(','), '0,0');
}

// --- summary -----------------------------------------------------------------
console.log('\n---- spatial engine tests: ' + passCount + ' passed, ' + failCount + ' failed ----');
if (failCount) {
  console.log('FAILURES:');
  failures.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
process.exit(0);
