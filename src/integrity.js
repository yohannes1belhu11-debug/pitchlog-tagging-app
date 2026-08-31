// PitchLog/MatchTag — data-integrity helpers shared by the renderer and the
// plain-Node test harness (tests/integrity-harness.js).
//
// Loaded as a plain <script> before renderer.js (exposes window.Integrity)
// and via require() in the harness (module.exports). Contains no DOM and no
// Electron references so both environments execute the exact same code.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Integrity = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // nextFreePlayerId(existingIds, startCounter): returns { id, next } where
  // `id` is a `player_<n>` string guaranteed NOT to collide with ANY id in
  // `existingIds` — regardless of the existing ids' format (imported ids
  // outside the player_<digits> pattern included) — and `next` is the
  // counter value to pass on the next call. `startCounter` is only a hint
  // (usually the numeric max seen so far + 1); the loop skips any generated
  // value that already exists, so a stale or low counter can never cause a
  // collision.
  function nextFreePlayerId(existingIds, startCounter) {
    const existing = existingIds instanceof Set ? existingIds : new Set(existingIds);
    let n = Number.isFinite(startCounter) ? Math.max(1, Math.floor(startCounter)) : 1;
    while (existing.has('player_' + n)) n++;
    return { id: 'player_' + n, next: n + 1 };
  }

  // findMissingPlayerRefs(events, squadIds): cross-checks every player
  // reference in `events` (playerId, playerOffId, playerOnId) against the
  // currently loaded squad ids. Returns { missingIds, affectedEvents }:
  //   - missingIds: unique sorted list of referenced-but-absent player ids
  //   - affectedEvents: number of events referencing at least one missing
  //     player (each event counts once, even with several missing refs)
  // Used by recovery to warn explicitly instead of silently rendering
  // "Unknown player" after the squad and an autosave have diverged.
  // Non-array inputs are tolerated defensively.
  function findMissingPlayerRefs(events, squadIds) {
    if (!Array.isArray(events)) return { missingIds: [], affectedEvents: 0 };
    const squad = squadIds instanceof Set ? squadIds : new Set(Array.isArray(squadIds) ? squadIds : []);
    const missing = new Set();
    let affectedEvents = 0;
    events.forEach((ev) => {
      if (!ev || typeof ev !== 'object') return;
      let eventAffected = false;
      ['playerId', 'playerOffId', 'playerOnId'].forEach((field) => {
        const ref = ev[field];
        if (typeof ref === 'string' && ref && !squad.has(ref)) {
          missing.add(ref);
          eventAffected = true;
        }
      });
      if (eventAffected) affectedEvents++;
    });
    return { missingIds: Array.from(missing).sort(), affectedEvents: affectedEvents };
  }

  return { nextFreePlayerId: nextFreePlayerId, findMissingPlayerRefs: findMissingPlayerRefs };
});
