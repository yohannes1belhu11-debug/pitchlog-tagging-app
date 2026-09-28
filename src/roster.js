// PitchLog/MatchTag — R3-A: matchday roster data model (pure module).
//
// Loaded as a plain <script> before renderer.js (exposes window.Roster) and
// via require() in the plain-Node harness (module.exports). Contains no DOM
// and no Electron references so both environments execute the exact same
// code (same pattern as integrity.js).
//
// R3-A scope — DATA MODEL ONLY, no UI, no substitution transitions:
//
//   matchRoster  the match-scoped two-team roster:
//                  { our: [player…], opponent: [player…] }
//                Every player entry carries EXACTLY the six approved fields,
//                in this canonical order:
//                  { playerId, displayName, shirtNumber, position, role, status }
//
//   status       one of the four approved matchday statuses:
//                  'starter' | 'bench' | 'on' | 'substituted'
//                R3-A stores and validates these values only. It does NOT
//                implement substitution transitions and does NOT connect the
//                Sub tag to them (statuses change only through explicit
//                roster mutations; the Sub event stays event-only).
//
//   opponent ids opponent players live in their OWN id namespace:
//                  match_opp_<unique-id>
//                Generation is collision-safe against ANY existing id format
//                (roster, global squad, or historical event references) and
//                opponent entries are strictly isolated from the global
//                squad (squad.json) — they are never written to it and never
//                resolved through it.
//
//   resolver     resolveMatchPlayer(playerId, matchRoster, globalSquad):
//                  - our-team id  → match roster overlay first, then global
//                                   squad fallback
//                  - opponent id  → opponent roster ONLY (never the squad,
//                                   even if a colliding id somehow exists
//                                   there)
//                  - unknown id   → null (unresolved)
//                The returned object carries the six roster fields plus a
//                read-only `source` discriminator
//                ('match-roster' | 'opponent-roster' | 'global-squad') so
//                callers and tests can see WHICH store answered. A squad
//                fallback has no matchday fact of its own, so its `status`
//                is null (unknown) — never invented.
//
//   persistence the roster is an OPTIONAL top-level field (`matchRoster`) of
//                the schema-v4 session file. Schema v4 is PRESERVED (no
//                bump): legacy v4 files simply lack the field, load as an
//                empty roster, and re-save includes it. This module never
//                manufactures roster entries from historical events —
//                normalizeMatchRoster reads ONLY raw.our / raw.opponent and
//                ignores every other key by construction.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Roster = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // The four approved matchday statuses (R3-A data-model support only).
  var ROSTER_STATUSES = ['starter', 'bench', 'on', 'substituted'];

  // The opponent id namespace. Opponent players are addressed ONLY by ids
  // in this namespace; the namespace is what the resolver routes on and
  // what keeps opponent ids from ever colliding with (or being confused
  // with) global-squad `player_<n>` ids.
  var OPPONENT_ID_PREFIX = 'match_opp_';

  function isRosterStatus(value) {
    return typeof value === 'string' && ROSTER_STATUSES.indexOf(value) !== -1;
  }

  function isOpponentId(playerId) {
    return typeof playerId === 'string' && playerId.indexOf(OPPONENT_ID_PREFIX) === 0;
  }

  // Canonical shirt-number normalization: a finite number stays as-is, a
  // plain digit-string ('10') becomes the number 10, everything else (null,
  // '', '1x', objects…) becomes null (unknown). The stored shape keeps this
  // deterministic: shirtNumber is number | null.
  function normalizeShirtNumber(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
    return null;
  }

  // emptyMatchRoster(): a FRESH canonical empty roster. Always returns a new
  // object (never a shared singleton) so callers can mutate freely.
  function emptyMatchRoster() {
    return { our: [], opponent: [] };
  }

  // normalizeRosterPlayer(raw): coerce one raw entry to the canonical
  // six-field player shape. Returns null when the entry is unusable — the
  // only fatal defect is a missing/invalid playerId (an entry without an
  // identity can never be resolved, persisted meaningfully, or deduped).
  // Every other field falls back to its explicit unknown/empty value:
  //   displayName '' | shirtNumber null | position '' | role '' | status 'bench'
  // (a player not yet assigned to the XI or the pitch is 'bench' by
  // definition; 'starter' is never inferred from anything).
  function normalizeRosterPlayer(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    var playerId = raw.playerId;
    if (typeof playerId !== 'string' || playerId.length === 0) return null;
    return {
      playerId: playerId,
      displayName: typeof raw.displayName === 'string' ? raw.displayName : '',
      shirtNumber: normalizeShirtNumber(raw.shirtNumber),
      position: typeof raw.position === 'string' ? raw.position : '',
      role: typeof raw.role === 'string' ? raw.role : '',
      status: isRosterStatus(raw.status) ? raw.status : 'bench'
    };
  }

  // normalizeMatchRoster(raw): coerce ANY loaded value to the canonical
  // two-team roster:
  //   - null/undefined/non-object → empty roster (the legacy-v4 case: the
  //     field is simply absent from files saved before R3-A)
  //   - raw.our / raw.opponent arrays are normalized entry-by-entry; invalid
  //     entries (non-objects, missing playerId) are dropped, duplicates by
  //     playerId keep the FIRST occurrence
  //   - every OTHER key of `raw` is ignored — in particular an `events`
  //     array can never leak into the roster: roster entries are never
  //     manufactured from historical events, by construction.
  // Always returns a fresh object; the input is never mutated.
  function normalizeMatchRoster(raw) {
    var roster = emptyMatchRoster();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return roster;
    ['our', 'opponent'].forEach(function (side) {
      if (!Array.isArray(raw[side])) return;
      var seen = {};
      var list = [];
      raw[side].forEach(function (entry) {
        var player = normalizeRosterPlayer(entry);
        if (!player) return;                 // unusable entry — dropped
        if (seen[player.playerId]) return;   // duplicate id — first wins
        seen[player.playerId] = true;
        list.push(player);
      });
      roster[side] = list;
    });
    return roster;
  }

  // isEmptyMatchRoster(roster): true when both sides are empty.
  function isEmptyMatchRoster(roster) {
    if (!roster || typeof roster !== 'object') return true;
    var our = Array.isArray(roster.our) ? roster.our : [];
    var opp = Array.isArray(roster.opponent) ? roster.opponent : [];
    return our.length === 0 && opp.length === 0;
  }

  // generateOpponentId(existingIds): the next free id in the opponent
  // namespace, `match_opp_<n>` with the smallest n >= 1 that does NOT
  // collide with any id in `existingIds` (any iterable — the caller should
  // pass the FULL collision universe: roster ids + global squad ids +
  // historical event player references). Collision checks are by exact
  // string membership, so arbitrary existing id formats are respected.
  // Deterministic: the same universe always yields the same id.
  function generateOpponentId(existingIds) {
    var existing = existingIds instanceof Set ? existingIds : new Set(existingIds || []);
    var n = 1;
    while (existing.has(OPPONENT_ID_PREFIX + n)) n++;
    return OPPONENT_ID_PREFIX + n;
  }

  // collectPlayerIds(sources): build the full collision universe as a Set of
  // strings. Sources (all optional):
  //   matchRoster: { our, opponent } — both sides' playerIds
  //   squad:       [ { id, number, name } … ] — global-squad ids
  //   events:      [ event … ] — playerId / playerOffId / playerOnId refs
  function collectPlayerIds(sources) {
    var ids = new Set();
    if (!sources || typeof sources !== 'object') return ids;
    var roster = sources.matchRoster;
    if (roster && typeof roster === 'object') {
      ['our', 'opponent'].forEach(function (side) {
        (Array.isArray(roster[side]) ? roster[side] : []).forEach(function (p) {
          if (p && typeof p === 'object' && typeof p.playerId === 'string' && p.playerId) ids.add(p.playerId);
        });
      });
    }
    (Array.isArray(sources.squad) ? sources.squad : []).forEach(function (p) {
      if (p && typeof p === 'object' && typeof p.id === 'string' && p.id) ids.add(p.id);
    });
    (Array.isArray(sources.events) ? sources.events : []).forEach(function (ev) {
      if (!ev || typeof ev !== 'object') return;
      ['playerId', 'playerOffId', 'playerOnId'].forEach(function (field) {
        if (typeof ev[field] === 'string' && ev[field]) ids.add(ev[field]);
      });
    });
    return ids;
  }

  // upsertPlayer(roster, side, rawPlayer, generateId): insert-or-replace one
  // player in roster[side] ('our' | 'opponent'). Namespace rules are
  // ENFORCED at the mutation boundary:
  //   - 'opponent' entries must carry a match_opp_* id. If rawPlayer has no
  //     usable playerId, a collision-safe one is generated (via the optional
  //     generateId() callback — the renderer passes the full-universe
  //     generator; the default uses the ids already inside the roster).
  //     A supplied NON-namespace id is rejected (null, no mutation).
  //   - 'our' entries must NOT carry a match_opp_* id (the namespace is
  //     reserved for opponents); our-team ids are ordinary squad-style ids.
  //     R3-A has no our-player creation path, so a missing playerId on the
  //     our side is rejected (null, no mutation).
  //   - an entry with no valid id (normalizeRosterPlayer === null) is
  //     rejected the same way.
  // On success the entry is stored in canonical six-field shape (replacing
  // any existing entry with the same playerId, otherwise appended) and the
  // STORED player object is returned. The roster object is mutated in place
  // (it is the caller's state container); normalization guarantees the
  // canonical arrays exist first.
  function upsertPlayer(roster, side, rawPlayer, generateId) {
    if (!roster || typeof roster !== 'object') return null;
    if (side !== 'our' && side !== 'opponent') return null;
    var normalized = normalizeMatchRoster(roster);
    roster.our = normalized.our;
    roster.opponent = normalized.opponent;

    var candidate = rawPlayer ? Object.assign({}, rawPlayer) : {};
    if (side === 'opponent') {
      if (typeof candidate.playerId !== 'string' || candidate.playerId.length === 0) {
        var gen = (typeof generateId === 'function')
          ? generateId
          : function () { return generateOpponentId(collectPlayerIds({ matchRoster: roster })); };
        candidate.playerId = gen();
      }
      if (!isOpponentId(candidate.playerId)) return null; // namespace violation
    } else {
      if (typeof candidate.playerId !== 'string' || candidate.playerId.length === 0) return null;
      if (isOpponentId(candidate.playerId)) return null;  // namespace reserved
    }

    var player = normalizeRosterPlayer(candidate);
    if (!player) return null;

    var list = roster[side];
    var at = -1;
    for (var i = 0; i < list.length; i++) {
      if (list[i].playerId === player.playerId) { at = i; break; }
    }
    if (at === -1) list.push(player); else list[at] = player;
    return player;
  }

  // removePlayer(roster, side, playerId): remove the entry with that id from
  // roster[side]. Returns the removed canonical player, or null when nothing
  // matched (no mutation).
  function removePlayer(roster, side, playerId) {
    if (!roster || typeof roster !== 'object') return null;
    if (side !== 'our' && side !== 'opponent') return null;
    if (typeof playerId !== 'string' || playerId.length === 0) return null;
    var list = Array.isArray(roster[side]) ? roster[side] : [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].playerId === playerId) return list.splice(i, 1)[0];
    }
    return null;
  }

  // resolveMatchPlayer(playerId, matchRoster, globalSquad): resolve a player
  // reference against the two-team matchday context. Routing is strictly by
  // NAMESPACE:
  //   - match_opp_* → opponent roster ONLY. Never the global squad, never
  //     the our-roster: even if the same string id exists in squad.json the
  //     opponent route cannot see it (isolation by construction).
  //   - anything else → our-roster overlay first; if the id is not in the
  //     roster, fall back to the global squad (the pre-R3-A single-team
  //     behavior).
  //   - unknown / invalid input → null.
  // The input roster is normalized defensively, so any caller shape works.
  // The result carries the six canonical fields plus `source`
  // ('match-roster' | 'opponent-roster' | 'global-squad'); a global-squad
  // fallback has no matchday status of its own → status: null (unknown,
  // never invented).
  function resolveMatchPlayer(playerId, matchRoster, globalSquad) {
    if (typeof playerId !== 'string' || playerId.length === 0) return null;
    var roster = normalizeMatchRoster(matchRoster);
    var squad = Array.isArray(globalSquad) ? globalSquad : [];

    if (isOpponentId(playerId)) {
      for (var i = 0; i < roster.opponent.length; i++) {
        if (roster.opponent[i].playerId === playerId) {
          return Object.assign({}, roster.opponent[i], { source: 'opponent-roster' });
        }
      }
      return null; // unknown opponent id — NEVER falls through to the squad
    }

    for (var j = 0; j < roster.our.length; j++) {
      if (roster.our[j].playerId === playerId) {
        return Object.assign({}, roster.our[j], { source: 'match-roster' });
      }
    }
    for (var k = 0; k < squad.length; k++) {
      var p = squad[k];
      if (p && typeof p === 'object' && p.id === playerId) {
        return {
          playerId: p.id,
          displayName: typeof p.name === 'string' ? p.name : '',
          shirtNumber: normalizeShirtNumber(p.number),
          position: '',
          role: '',
          status: null,
          source: 'global-squad'
        };
      }
    }
    return null;
  }

  return {
    ROSTER_STATUSES: ROSTER_STATUSES,
    OPPONENT_ID_PREFIX: OPPONENT_ID_PREFIX,
    isRosterStatus: isRosterStatus,
    isOpponentId: isOpponentId,
    emptyMatchRoster: emptyMatchRoster,
    normalizeRosterPlayer: normalizeRosterPlayer,
    normalizeMatchRoster: normalizeMatchRoster,
    isEmptyMatchRoster: isEmptyMatchRoster,
    generateOpponentId: generateOpponentId,
    collectPlayerIds: collectPlayerIds,
    upsertPlayer: upsertPlayer,
    removePlayer: removePlayer,
    resolveMatchPlayer: resolveMatchPlayer
  };
});
