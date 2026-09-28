#!/usr/bin/env node
// PitchLog / MatchTag — R3-A: matchday roster DATA MODEL harness (pure module).
// ============================================================================
// Verification-only harness. It does NOT modify any app source file.
//
// Requires the REAL src/roster.js directly in plain Node (UMD module — the
// exact same code the renderer runs as window.Roster) and verifies the
// R3-A contract at the model level:
//
//   R3-01  canonical player shape: EXACTLY the six approved fields
//          { playerId, displayName, shirtNumber, position, role, status }
//   R3-02  all four approved statuses (starter/bench/on/substituted) are
//          supported, data-model only; invalid status coerces to 'bench'
//   R3-03  roster normalization: legacy/absent/invalid shapes, entry
//          dropping, duplicate handling, fresh-object semantics
//   R3-04  no manufacturing: normalizeMatchRoster ignores every key except
//          our/opponent — historical events can never produce roster entries
//   R3-05  opponent id namespace match_opp_<unique-id>
//   R3-06  collision-safe opponent id generation + full-universe collection
//   R3-07  mutation-boundary namespace enforcement (upsertPlayer/removePlayer)
//   R3-08..R3-12  the approved resolver behavior:
//          our-team id → match roster overlay first, then global squad
//          fallback; opponent id → opponent roster ONLY (never the global
//          squad, even on an id collision); unknown id → null
//
// Run:  node tests/roster-model-check.js   (from the project root)
'use strict';

const path = require('path');
const Roster = require(path.join(__dirname, '..', 'src', 'roster.js'));

const results = [];
function ok(name, cond, detail) {
  results.push({ name, pass: !!cond, detail: detail || '' });
  console.log((cond ? '[PASS] ' : '[FAIL] ') + name + (detail ? '  | ' + detail : ''));
  if (!cond) process.exitCode = 1;
}
function section(title) { console.log('\n== ' + title + ' =='); }
function clone(x) { return JSON.parse(JSON.stringify(x)); }

// ---------------------------------------------------------------------------
section('R3-01 — canonical player shape (six approved fields, exact)');
{
  const p = Roster.normalizeRosterPlayer({
    playerId: 'player_3', displayName: 'Abebe Bikila', shirtNumber: '10',
    position: 'ST', role: 'captain', status: 'starter'
  });
  ok('R3-01a: normalizeRosterPlayer returns an object', !!p && typeof p === 'object');
  ok('R3-01b: EXACTLY the six approved keys, in canonical order',
    p && JSON.stringify(Object.keys(p)) === JSON.stringify(['playerId', 'displayName', 'shirtNumber', 'position', 'role', 'status']),
    p ? JSON.stringify(Object.keys(p)) : 'null');
  ok('R3-01c: field values carried through',
    p && p.playerId === 'player_3' && p.displayName === 'Abebe Bikila' && p.position === 'ST' && p.role === 'captain');
  ok('R3-01d: digit-string shirtNumber normalizes to number (10)', p && p.shirtNumber === 10);
  ok('R3-01e: numeric shirtNumber stays a number', Roster.normalizeRosterPlayer({ playerId: 'x', shirtNumber: 7 }).shirtNumber === 7);
  ok('R3-01f: unusable shirtNumber becomes null (never invented)',
    Roster.normalizeRosterPlayer({ playerId: 'x', shirtNumber: '1x' }).shirtNumber === null &&
    Roster.normalizeRosterPlayer({ playerId: 'x' }).shirtNumber === null);
  ok('R3-01g: defaults are explicit (displayName "", position "", role "")',
    (() => { const q = Roster.normalizeRosterPlayer({ playerId: 'x' }); return q.displayName === '' && q.position === '' && q.role === ''; })());
  ok('R3-01h: entry WITHOUT a usable playerId is rejected (null)',
    Roster.normalizeRosterPlayer({ displayName: 'No Id' }) === null &&
    Roster.normalizeRosterPlayer({ playerId: '' }) === null &&
    Roster.normalizeRosterPlayer(null) === null &&
    Roster.normalizeRosterPlayer('junk') === null &&
    Roster.normalizeRosterPlayer([1, 2]) === null);
}

// ---------------------------------------------------------------------------
section('R3-02 — the four approved statuses (data-model support only)');
{
  ok('R3-02a: ROSTER_STATUSES is exactly the approved set',
    JSON.stringify(Roster.ROSTER_STATUSES) === JSON.stringify(['starter', 'bench', 'on', 'substituted']),
    JSON.stringify(Roster.ROSTER_STATUSES));
  Roster.ROSTER_STATUSES.forEach((s) => {
    ok('R3-02b: status "' + s + '" is valid and storable',
      Roster.isRosterStatus(s) && Roster.normalizeRosterPlayer({ playerId: 'x', status: s }).status === s);
  });
  ok('R3-02c: invalid status coerces to the explicit default "bench"',
    Roster.normalizeRosterPlayer({ playerId: 'x', status: 'captain' }).status === 'bench' &&
    Roster.normalizeRosterPlayer({ playerId: 'x', status: null }).status === 'bench' &&
    Roster.normalizeRosterPlayer({ playerId: 'x' }).status === 'bench');
  ok('R3-02d: "starter" is never inferred from anything (missing → bench)',
    Roster.normalizeRosterPlayer({ playerId: 'x', position: 'GK' }).status === 'bench');
  ok('R3-02e: isRosterStatus rejects non-strings and unknown values',
    !Roster.isRosterStatus('Starter') && !Roster.isRosterStatus('') && !Roster.isRosterStatus(null) && !Roster.isRosterStatus(1));
}

// ---------------------------------------------------------------------------
section('R3-03 — roster normalization (legacy, invalid, duplicates)');
{
  ok('R3-03a: undefined (the legacy-v4 case) → canonical empty roster',
    (() => { const r = Roster.normalizeMatchRoster(undefined); return r.our.length === 0 && r.opponent.length === 0; })());
  ok('R3-03b: null / non-object / array → empty roster',
    Roster.isEmptyMatchRoster(Roster.normalizeMatchRoster(null)) &&
    Roster.isEmptyMatchRoster(Roster.normalizeMatchRoster('junk')) &&
    Roster.isEmptyMatchRoster(Roster.normalizeMatchRoster([1, 2])));
  ok('R3-03c: missing sides → empty arrays present (canonical shape)',
    (() => { const r = Roster.normalizeMatchRoster({}); return Array.isArray(r.our) && Array.isArray(r.opponent); })());
  ok('R3-03d: valid entries normalize to the six-field shape',
    (() => {
      const r = Roster.normalizeMatchRoster({ our: [{ playerId: 'player_1', displayName: 'A', shirtNumber: 1, status: 'starter' }] });
      return r.our.length === 1 && JSON.stringify(Object.keys(r.our[0])) === JSON.stringify(['playerId', 'displayName', 'shirtNumber', 'position', 'role', 'status']);
    })());
  ok('R3-03e: invalid entries are DROPPED (never partially kept)',
    (() => {
      const r = Roster.normalizeMatchRoster({ our: [{ displayName: 'no id' }, null, 'junk', { playerId: 'player_2' }], opponent: [{}] });
      return r.our.length === 1 && r.our[0].playerId === 'player_2' && r.opponent.length === 0;
    })());
  ok('R3-03f: duplicate playerIds keep the FIRST occurrence (deterministic)',
    (() => {
      const r = Roster.normalizeMatchRoster({ our: [
        { playerId: 'player_1', displayName: 'First' },
        { playerId: 'player_1', displayName: 'Second' }
      ] });
      return r.our.length === 1 && r.our[0].displayName === 'First';
    })());
  ok('R3-03g: normalization never mutates its input and returns fresh objects',
    (() => {
      const input = { our: [{ playerId: 'player_1' }], opponent: [] };
      const r1 = Roster.normalizeMatchRoster(input);
      r1.our.push({ playerId: 'player_9' });
      const r2 = Roster.normalizeMatchRoster(input);
      return r2.our.length === 1 && JSON.stringify(input) === JSON.stringify({ our: [{ playerId: 'player_1' }], opponent: [] });
    })());
  ok('R3-03h: unknown extra fields on an entry are dropped (canonical shape only)',
    (() => {
      const r = Roster.normalizeMatchRoster({ our: [{ playerId: 'player_1', nickname: 'Z', minutes: 90 }] });
      return !('nickname' in r.our[0]) && !('minutes' in r.our[0]);
    })());
}

// ---------------------------------------------------------------------------
section('R3-04 — no manufacturing from historical events (structural)');
{
  const sessionShaped = {
    events: [
      { id: 1, label: 'Pass', playerId: 'player_5' },
      { id: 2, label: 'Sub', playerOffId: 'player_6', playerOnId: 'player_12' },
      { id: 3, label: 'Foul', playerId: 'match_opp_7' }
    ],
    squad: [{ id: 'player_5' }, { id: 'player_6' }, { id: 'player_12' }],
    matchInfo: { startingXI: [{ position: 'GK', playerId: 'player_1' }] }
  };
  const r = Roster.normalizeMatchRoster(sessionShaped);
  ok('R3-04a: a session-shaped input (events/squad/matchInfo keys) yields an EMPTY roster',
    r.our.length === 0 && r.opponent.length === 0,
    JSON.stringify(r));
  ok('R3-04b: the input object is untouched (no event was consumed)',
    sessionShaped.events.length === 3 && sessionShaped.squad.length === 3);
  ok('R3-04c: emptyMatchRoster is fresh on every call (no shared singleton)',
    (() => { const a = Roster.emptyMatchRoster(); const b = Roster.emptyMatchRoster(); a.our.push(1); return b.our.length === 0; })());
}

// ---------------------------------------------------------------------------
section('R3-05 — opponent id namespace');
{
  ok('R3-05a: prefix constant is match_opp_', Roster.OPPONENT_ID_PREFIX === 'match_opp_');
  ok('R3-05b: isOpponentId truth table',
    Roster.isOpponentId('match_opp_1') === true &&
    Roster.isOpponentId('match_opp_abc-42') === true &&
    Roster.isOpponentId('player_1') === false &&
    Roster.isOpponentId('') === false &&
    Roster.isOpponentId(null) === false &&
    Roster.isOpponentId(7) === false &&
    Roster.isOpponentId('match_opponent_1') === false);
}

// ---------------------------------------------------------------------------
section('R3-06 — collision-safe opponent id generation');
{
  ok('R3-06a: empty universe → match_opp_1', Roster.generateOpponentId([]) === 'match_opp_1');
  ok('R3-06b: skips occupied slots (match_opp_1 taken → match_opp_2)',
    Roster.generateOpponentId(['match_opp_1']) === 'match_opp_2');
  ok('R3-06c: fills the first gap deterministically',
    Roster.generateOpponentId(['match_opp_1', 'match_opp_2', 'match_opp_4']) === 'match_opp_3');
  ok('R3-06d: runs past a dense block',
    Roster.generateOpponentId(['match_opp_1', 'match_opp_2', 'match_opp_3']) === 'match_opp_4');
  ok('R3-06e: non-namespace ids (squad/event refs) never collide by construction — still match_opp_1',
    Roster.generateOpponentId(['player_1', 'player_2', 'imported-x9']) === 'match_opp_1');
  ok('R3-06f: accepts a Set (the collectPlayerIds output)',
    Roster.generateOpponentId(new Set(['match_opp_1'])) === 'match_opp_2');
  ok('R3-06g: deterministic — same universe, same result',
    Roster.generateOpponentId(['match_opp_2', 'match_opp_1']) === Roster.generateOpponentId(['match_opp_1', 'match_opp_2']));

  ok('R3-06h: collectPlayerIds gathers the full universe (roster + squad + event refs)',
    (() => {
      const ids = Roster.collectPlayerIds({
        matchRoster: { our: [{ playerId: 'player_1' }], opponent: [{ playerId: 'match_opp_1' }] },
        squad: [{ id: 'player_99', number: '9', name: 'S' }],
        events: [
          { playerId: 'player_5', playerOffId: 'player_6', playerOnId: 'match_opp_3' },
          { playerId: null }
        ]
      });
      return ids.has('player_1') && ids.has('match_opp_1') && ids.has('player_99') &&
             ids.has('player_5') && ids.has('player_6') && ids.has('match_opp_3') && ids.size === 6;
    })());
  ok('R3-06i: generation over the full universe skips ids referenced ANYWHERE',
    Roster.generateOpponentId(Roster.collectPlayerIds({
      matchRoster: { our: [], opponent: [{ playerId: 'match_opp_1' }] },
      squad: [],
      events: [{ playerOnId: 'match_opp_2' }]
    })) === 'match_opp_3');
  ok('R3-06j: collectPlayerIds tolerates missing sources',
    Roster.collectPlayerIds({}).size === 0 && Roster.collectPlayerIds(undefined).size === 0);
}

// ---------------------------------------------------------------------------
section('R3-07 — mutation boundary (upsertPlayer / removePlayer)');
{
  ok('R3-07a: opponent upsert WITHOUT an id gets a generated collision-safe match_opp_* id',
    (() => {
      const roster = Roster.emptyMatchRoster();
      const p = Roster.upsertPlayer(roster, 'opponent', { displayName: 'Opp Winger', shirtNumber: 7 });
      return p && Roster.isOpponentId(p.playerId) && p.playerId === 'match_opp_1' &&
             roster.opponent.length === 1 && roster.opponent[0].playerId === 'match_opp_1';
    })());
  ok('R3-07b: opponent upsert WITH a valid namespace id keeps it',
    (() => {
      const roster = Roster.emptyMatchRoster();
      const p = Roster.upsertPlayer(roster, 'opponent', { playerId: 'match_opp_9', displayName: 'X' });
      return p && p.playerId === 'match_opp_9';
    })());
  ok('R3-07c: opponent upsert REJECTS a non-namespace id (isolation boundary)',
    (() => {
      const roster = Roster.emptyMatchRoster();
      const p = Roster.upsertPlayer(roster, 'opponent', { playerId: 'player_5', displayName: 'Smuggled' });
      return p === null && roster.opponent.length === 0;
    })());
  ok('R3-07d: our-side upsert REJECTS opponent-namespace ids (namespace reserved)',
    (() => {
      const roster = Roster.emptyMatchRoster();
      const p = Roster.upsertPlayer(roster, 'our', { playerId: 'match_opp_1', displayName: 'Wrong side' });
      return p === null && roster.our.length === 0;
    })());
  ok('R3-07e: our-side upsert REQUIRES an explicit id (no our-player creation in R3-A)',
    Roster.upsertPlayer(Roster.emptyMatchRoster(), 'our', { displayName: 'No id' }) === null);
  ok('R3-07f: upsert replaces by playerId (same id → updated in place, no duplicate)',
    (() => {
      const roster = Roster.emptyMatchRoster();
      Roster.upsertPlayer(roster, 'our', { playerId: 'player_1', status: 'bench' });
      const p2 = Roster.upsertPlayer(roster, 'our', { playerId: 'player_1', status: 'starter', shirtNumber: 4 });
      return roster.our.length === 1 && p2.status === 'starter' && p2.shirtNumber === 4;
    })());
  ok('R3-07g: invalid side is rejected without mutation',
    Roster.upsertPlayer(Roster.emptyMatchRoster(), 'bench', { playerId: 'player_1' }) === null &&
    Roster.upsertPlayer(null, 'our', { playerId: 'player_1' }) === null);
  ok('R3-07h: generated id skips ids already inside the roster (module-default generator)',
    (() => {
      const roster = Roster.emptyMatchRoster();
      Roster.upsertPlayer(roster, 'opponent', { displayName: 'A' });           // match_opp_1
      const p = Roster.upsertPlayer(roster, 'opponent', { displayName: 'B' }); // should be match_opp_2
      return p.playerId === 'match_opp_2';
    })());
  ok('R3-07i: injected generator is honored (renderer passes the full universe)',
    (() => {
      const roster = Roster.emptyMatchRoster();
      const p = Roster.upsertPlayer(roster, 'opponent', { displayName: 'A' }, () => 'match_opp_42');
      return p.playerId === 'match_opp_42';
    })());
  ok('R3-07j: removePlayer removes and returns the canonical entry; miss = null, no mutation',
    (() => {
      const roster = Roster.emptyMatchRoster();
      Roster.upsertPlayer(roster, 'our', { playerId: 'player_1', displayName: 'A' });
      const removed = Roster.removePlayer(roster, 'our', 'player_1');
      const miss = Roster.removePlayer(roster, 'our', 'player_1');
      return removed && removed.playerId === 'player_1' && roster.our.length === 0 && miss === null;
    })());
  ok('R3-07k: upsert normalizes the whole roster defensively (junk side arrays are cleaned)',
    (() => {
      const roster = { our: [{ playerId: 'player_1' }, { playerId: '' }], opponent: 'junk' };
      const p = Roster.upsertPlayer(roster, 'our', { playerId: 'player_2' });
      return p && roster.our.length === 2 && Array.isArray(roster.opponent) && roster.opponent.length === 0;
    })());
}

// ---------------------------------------------------------------------------
section('R3-08..R3-10 — resolver: overlay, fallback, opponent-only');
{
  const roster = {
    our: [
      { playerId: 'player_10', displayName: 'Roster Ten', shirtNumber: 10, position: 'ST', role: '', status: 'starter' }
    ],
    opponent: [
      { playerId: 'match_opp_1', displayName: 'Opp One', shirtNumber: 9, position: 'ST', role: '', status: 'starter' }
    ]
  };
  const squad = [
    { id: 'player_10', number: '99', name: 'Squad Ten (renamed)' },  // same id as roster overlay
    { id: 'player_20', number: '20', name: 'Squad Twenty' },
    { id: 'match_opp_1', number: '66', name: 'SQUAD-CONTAMINATING ENTRY' } // hostile: squad entry in opponent namespace
  ];

  // R3-08 our-team overlay precedence
  const overlay = Roster.resolveMatchPlayer('player_10', roster, squad);
  ok('R3-08a: our-team id present in BOTH roster and squad resolves from the MATCH ROSTER overlay',
    overlay && overlay.source === 'match-roster' && overlay.displayName === 'Roster Ten' && overlay.shirtNumber === 10,
    JSON.stringify(overlay));
  ok('R3-08b: overlay answer carries the six canonical fields',
    overlay && JSON.stringify(Object.keys(overlay).slice(0, 6)) === JSON.stringify(['playerId', 'displayName', 'shirtNumber', 'position', 'role', 'status']));

  // R3-09 global squad fallback
  const fallback = Roster.resolveMatchPlayer('player_20', roster, squad);
  ok('R3-09a: our-team id NOT in the roster falls back to the GLOBAL SQUAD',
    fallback && fallback.source === 'global-squad' && fallback.displayName === 'Squad Twenty' && fallback.playerId === 'player_20');
  ok('R3-09b: squad fallback maps the six-field shape (number→shirtNumber, name→displayName)',
    fallback && fallback.shirtNumber === 20 && fallback.position === '' && fallback.role === '');
  ok('R3-09c: squad fallback has NO matchday status of its own → null (never invented)',
    fallback && fallback.status === null);

  // R3-10 opponent-only routing
  const opp = Roster.resolveMatchPlayer('match_opp_1', roster, squad);
  ok('R3-10a: opponent id resolves through the OPPONENT ROSTER only',
    opp && opp.source === 'opponent-roster' && opp.displayName === 'Opp One' && opp.status === 'starter');
  ok('R3-10b: an opponent id NOT in the opponent roster is null — NEVER the global squad (collision test)',
    Roster.resolveMatchPlayer('match_opp_2', roster, squad) === null);
  ok('R3-10c: hostile squad entry in the opponent namespace is unreachable through opponent routing',
    (() => {
      // match_opp_1 exists in the squad as a contaminated entry; the resolver
      // must answer from the OPPONENT ROSTER (Opp One), never the squad.
      return opp && opp.displayName === 'Opp One';
    })());
  ok('R3-10d: opponent id never resolves through our-roster either',
    (() => {
      const r2 = { our: [{ playerId: 'match_opp_5', displayName: 'Misplaced' }], opponent: [] };
      return Roster.resolveMatchPlayer('match_opp_5', r2, []) === null;
    })());
}

// ---------------------------------------------------------------------------
section('R3-11/R3-12 — unknown ids, invalid input, hygiene');
{
  const roster = { our: [{ playerId: 'player_1' }], opponent: [{ playerId: 'match_opp_1' }] };
  const squad = [{ id: 'player_2', number: '2', name: 'Two' }];
  ok('R3-11a: unknown our-team id → null', Roster.resolveMatchPlayer('player_999', roster, squad) === null);
  ok('R3-11b: unknown opponent id → null', Roster.resolveMatchPlayer('match_opp_999', roster, squad) === null);
  ok('R3-11c: invalid inputs → null (null/undefined/number/object/empty string)',
    Roster.resolveMatchPlayer(null, roster, squad) === null &&
    Roster.resolveMatchPlayer(undefined, roster, squad) === null &&
    Roster.resolveMatchPlayer(42, roster, squad) === null &&
    Roster.resolveMatchPlayer({ id: 'x' }, roster, squad) === null &&
    Roster.resolveMatchPlayer('', roster, squad) === null);
  ok('R3-11d: resolver tolerates missing/blank stores (no crash)',
    Roster.resolveMatchPlayer('player_1', undefined, undefined) === null &&
    Roster.resolveMatchPlayer('player_2', roster, null) === null &&
    Roster.resolveMatchPlayer('player_2', null, squad) !== null);
  ok('R3-11e: resolver normalizes its roster input defensively (unnormalized entries still resolve)',
    Roster.resolveMatchPlayer('player_1', { our: [{ playerId: 'player_1', junk: 1 }], opponent: [] }, []).source === 'match-roster');
  ok('R3-12a: resolver returns COPIES — mutating the result never touches the roster',
    (() => {
      const r = { our: [{ playerId: 'player_1', displayName: 'Orig' }], opponent: [] };
      const res = Roster.resolveMatchPlayer('player_1', r, []);
      res.displayName = 'Mutated';
      return r.our[0].displayName === 'Orig';
    })());
  ok('R3-12b: isEmptyMatchRoster truth table',
    Roster.isEmptyMatchRoster(Roster.emptyMatchRoster()) === true &&
    Roster.isEmptyMatchRoster({ our: [], opponent: [{ playerId: 'match_opp_1' }] }) === false &&
    Roster.isEmptyMatchRoster(undefined) === true);
}

// ---------------------------------------------------------------------------
const failed = results.filter((r) => !r.pass).length;
console.log('\nroster-model-check: ' + (results.length - failed) + '/' + results.length + ' checks passed' +
  (failed ? ', FAILED: ' + failed : ''));
if (failed) process.exit(1);
