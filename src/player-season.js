// PitchLog — PLAYER & SEASON DATA ENGINE V1 (core aggregation)
// File: src/player-season.js
// Spec: docs/player-season-data-specification.md (PitchLog-PLAYER-SEASON-SPEC-v1.0)
//       + the approved implementation decisions for this task:
//         - minutes quality codes RELIABLE / ESTIMATED / UNAVAILABLE
//           (mapping the spec §3.4 ESTIMATED_FULL/ESTIMATED_PARTIAL/UNKNOWN)
//         - per-90 PERMITTED from RELIABLE minutes only (supersedes the draft
//           spec §10.4 prohibition — approved reviewer decision)
//         - participation: selected = listed in the session's squad snapshot
//           (PitchLog has no bench/matchday-squad list); unused substitute =
//           squad-listed, not in the starting XI, never substituted on
//         - recent form / trends / with-without / consistency: NOT in this
//           implementation (Implementation 2)
//
// ARCHITECTURE (task Part 2):
//   SAVED SESSIONS → ANALYTICS ENGINE V1 (per match, UNCHANGED)
//   → PLAYER MATCH RECORDS → TEAM MATCH RECORDS → SEASON AGGREGATION
//
// Principles (spec PSD-H, task core principle):
//   - REUSE: every count the Analytics Engine already computes is CONSUMED
//     from A.* outputs (A.players, A.level1/2/3, A.spatial, A.matchSummary,
//     A.gates) — never recounted in a second incompatible way. The ONLY new
//     record-level passes this engine owns are the ones the Analytics Engine
//     does not compute: participation markers (Sub/Card events, raw read),
//     gated minutes, and per-player period/score-state partitions (from the
//     engine's own A.spatial event records). Reconciliation with the engine
//     is asserted by tests (PM-T12/T13 + partition invariants).
//   - POOLED PERCENTAGES: ratios aggregate numerator + denominator first and
//     are NEVER averaged across matches (task Part 17).
//   - PER-90: only from RELIABLE minutes; numerator restricted to the same
//     reliable-minutes matches (documented); null when no reliable minutes.
//   - DETERMINISTIC + PURE: no Date.now(), no I/O, no DOM; stable sorts with
//     full tie-breaks; inputs are never mutated; outputs share no mutable
//     state with inputs.
//   - TAGGED UNIVERSE: every number is traceable to validated match data;
//     nothing is extrapolated; missing evidence is flagged, never zero-filled.
//
// UMD: window.PlayerSeasonEngine in the renderer (loaded AFTER analytics.js,
// BEFORE renderer.js), module.exports in Node (tests). Requires the Analytics
// Engine at load time (require('./analytics.js') / root.AnalyticsEngine).

(function (root, factory) {
  var AE = null;
  if (typeof module === 'object' && module.exports) {
    AE = require('./analytics.js');
    module.exports = factory(AE);
  } else {
    AE = root.AnalyticsEngine;
    root.PlayerSeasonEngine = factory(AE);
  }
})(typeof self !== 'undefined' ? self : this, function (AnalyticsEngine) {
  'use strict';

  var SPEC = 'PitchLog-PLAYER-SEASON-SPEC-v1.0';
  var VERSION = '1.0.0';

  // ---- Fixed vocabularies (mirror the analytics engine; source is authority)

  var THIRDS = ['Defensive third', 'Middle third', 'Attacking third'];
  var CHANNELS = ['Left channel', 'Central channel', 'Right channel'];
  var ZONE_KEYS = (function () {
    var out = [];
    THIRDS.forEach(function (t) {
      CHANNELS.forEach(function (c) { out.push(t + ' · ' + c); });
    });
    return out;
  })();

  var PLAY_PERIODS = ['1H', '2H', 'ET1', 'ET2'];
  var PERIOD_BUCKETS = ['1H', '2H', 'ET1', 'ET2', 'Non-play', 'Unknown'];
  var SCORE_STATES = ['WINNING', 'DRAW', 'LOSING'];

  // Per-player partition metric family (qualifier-free subset of the engine's
  // counting — pass-outcome metrics need qualifiers, which the A.spatial
  // event records do not carry; they are reported unpartitioned from
  // A.players envelopes).
  var PARTITION_KEYS = [
    'events', 'goals', 'shots', 'shotsOnTarget', 'chances', 'keyPasses',
    'crosses', 'passes', 'presses', 'pressWins', 'interceptions',
    'recoveries', 'turnovers', 'duels', 'fouls', 'yellowCards', 'redCards',
    'transitionsPositive', 'transitionsNegative'
  ];

  // Count metrics aggregated into player season totals (engine metrics +
  // envelope-derived pass outcomes + transitions + neutral).
  var COUNT_KEYS = [
    'events', 'goals', 'shots', 'shotsOnTarget', 'chances', 'keyPasses',
    'crosses', 'passes', 'successfulPasses', 'unsuccessfulPasses',
    'passesUnknownOutcome', 'presses', 'pressWins', 'interceptions',
    'recoveries', 'turnovers', 'duels', 'fouls', 'yellowCards', 'redCards',
    'positiveEvents', 'negativeEvents', 'neutralEvents',
    'transitionsPositive', 'transitionsNegative', 'subOn', 'subOff'
  ];

  // Metrics exposed as per-90 values (raw tagged counts only).
  var PER90_KEYS = [
    'events', 'goals', 'shots', 'shotsOnTarget', 'chances', 'keyPasses',
    'crosses', 'passes', 'presses', 'pressWins', 'interceptions',
    'recoveries', 'turnovers', 'duels', 'fouls',
    'transitionsPositive', 'transitionsNegative'
  ];

  var MINUTES_STANDARDS = {
    basis: 'Participation intervals from the starting XI, Substitution events, player-attributed red cards, and the recorded full-time marker (matchClock). Not an official minutes-played statistic; estimated minutes are never used as a rate denominator.',
    per90Basis: 'Per-90 values use RELIABLE minutes only (sum of minutes with fully explicit participation boundaries). Totals and the per-90 denominator cover the same matches; matches with estimated or unavailable minutes are excluded and reported.'
  };

  var PROTOCOL_NOTES = [
    'SEASON_TAGGED_UNIVERSE: every season figure is a sum or pooled recomputation of TAGGED match-event counts from the Analytics Engine V1; nothing is extrapolated to untagged reality',
    'ENGINE_REUSE: player/team match records consume the existing Analytics Engine V1 outputs (A.players, A.level1/2/3, A.spatial, A.gates); reconciliation with those outputs is test-asserted, not assumed',
    'POOLED_PERCENTAGES: ratios aggregate numerator and denominator across matches first; percentages are never averaged per-match',
    'MINUTES_QUALITY: RELIABLE (all boundaries explicit — Sub on/off, player-attributed red card, or the recorded FT marker) / ESTIMATED (display only — boundary fell back to last-known evidence) / UNAVAILABLE (null — no meaningful value); never official minutes; never a denominator unless RELIABLE',
    'PER90: computed ONLY from reliable minutes (numerator restricted to the same reliable-minutes matches); matches×90 is never used as a denominator',
    'PLAYER_IDENTITY: playerId is the stable identity; names resolve from each session\u2019s own embedded squad snapshot; name drift and possible duplicate persons are flagged for review, never merged or renamed',
    'MATCH_IDENTITY: external deterministic key (sourceFile, savedAt, label, loadIndex); duplicate sessions are excluded from totals and audited; ambiguous look-alike matches are flagged, never merged; no matchId was added to the event schema',
    'UNUSED_SUBSTITUTE: PitchLog has no bench/matchday-squad list — "selected" means listed in the session\u2019s squad snapshot, so unused-substitute counts may include players who were not in the matchday squad',
    'SUB_PARTITION_NOTE: per-player period/score-state partitions count playerId-attributed events; Sub events attribute through playerOff/playerOn (engine M-G5) and carry playerId null in the spatial records, so they appear in participation and byLabel but not in the period/state partitions',
    'PARTICIPATION: starter = named in startingXI; substitute appearance = entered via a Sub playerOn reference; unused = squad-listed, never started, never entered; an unused substitute is NOT an appearance'
  ];

  // ---- Small deterministic helpers (mirroring analytics.js semantics) ------

  function roundHalfUp1(x) {
    return Math.round((x + Number.EPSILON) * 10) / 10;
  }
  function pct1(num, den) {
    if (!(den > 0)) return null;
    return roundHalfUp1((num / den) * 100);
  }
  function isFinNum(v) {
    return typeof v === 'number' && isFinite(v);
  }
  function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }
  // ratioEnv mirror (engine §12.5 envelope; reconciliation-tested)
  function ratioEnv(num, den, excluded, params) {
    var env = { value: pct1(num, den), num: num, den: den, excluded: excluded || {} };
    if (params) env.params = params;
    return env;
  }
  function countEnv(n) {
    return { value: n };
  }
  function str(v, fallback) {
    return (typeof v === 'string' && v) ? v : (fallback == null ? '' : fallback);
  }

  // ---- Session normalization + match identity -------------------------------

  function matchLabel(matchInfo) {
    var date = str(matchInfo && matchInfo.date);
    var opp = str(matchInfo && matchInfo.opponent);
    return (date || '(no date)') + '_vs ' + (opp || '(no opponent)');
  }

  function parseSession(session, loadIndex) {
    var s = isPlainObject(session) ? session : {};
    var matchInfo = isPlainObject(s.matchInfo) ? s.matchInfo : {};
    var matchClock = isPlainObject(s.matchClock) ? s.matchClock : null;
    return {
      loadIndex: loadIndex,
      sourceFile: (typeof s.sourceFile === 'string' && s.sourceFile) ? s.sourceFile : null,
      savedAt: (typeof s.__savedAt === 'string' && s.__savedAt) ? s.__savedAt : null,
      events: Array.isArray(s.events) ? s.events : [],
      squad: Array.isArray(s.squad) ? s.squad : [],
      matchInfo: matchInfo,
      matchClock: matchClock,
      tags: Array.isArray(s.tags) ? s.tags : [],
      label: matchLabel(matchInfo)
    };
  }

  // Deterministic match order (spec PSD-S0): date asc (empty LAST),
  // savedAt asc (null LAST), sourceFile asc (null LAST), loadIndex asc.
  function compareSessions(a, b) {
    var ad = str(a.matchInfo.date), bd = str(b.matchInfo.date);
    if (!!ad !== !!bd) return ad ? -1 : 1;
    if (ad && bd && ad !== bd) return ad < bd ? -1 : 1;
    var as = a.savedAt, bs = b.savedAt;
    if (!!as !== !!bs) return as ? -1 : 1;
    if (as && bs && as !== bs) return as < bs ? -1 : 1;
    var af = a.sourceFile, bf = b.sourceFile;
    if (!!af !== !!bf) return af ? -1 : 1;
    if (af && bf && af !== bf) return af < bf ? -1 : 1;
    return a.loadIndex - b.loadIndex;
  }

  // Duplicate detection (task Part 24 / spec PSD-X1): EXACT sourceFile
  // duplicates are excluded from aggregation (the same saved match must not
  // count twice); look-alike identities (same savedAt, same label) are
  // flagged for review and NEVER merged.
  function dedupeSessions(parsed) {
    var kept = [];
    var duplicates = [];        // { loadIndex, sourceFile, duplicateOfLoadIndex }
    var seenByFile = {};
    parsed.forEach(function (p) {
      if (p.sourceFile) {
        if (Object.prototype.hasOwnProperty.call(seenByFile, p.sourceFile)) {
          duplicates.push({
            loadIndex: p.loadIndex,
            sourceFile: p.sourceFile,
            duplicateOfLoadIndex: seenByFile[p.sourceFile]
          });
          return; // excluded from aggregation (source data untouched)
        }
        seenByFile[p.sourceFile] = p.loadIndex;
      }
      kept.push(p);
    });
    return { kept: kept, duplicates: duplicates };
  }

  function auditIdentity(parsedKept) {
    var sameSavedAt = [];
    var sameLabel = [];
    for (var i = 0; i < parsedKept.length; i++) {
      for (var j = i + 1; j < parsedKept.length; j++) {
        var a = parsedKept[i], b = parsedKept[j];
        if (a.savedAt && b.savedAt && a.savedAt === b.savedAt) {
          sameSavedAt.push({ matchKeys: [a.loadIndex, b.loadIndex], savedAt: a.savedAt });
        }
        if (a.label === b.label) {
          sameLabel.push({ matchKeys: [a.loadIndex, b.loadIndex], label: a.label });
        }
      }
    }
    return { sameSavedAt: sameSavedAt, sameLabel: sameLabel };
  }

  // ---- Participation markers (raw event read — Sub + Card only) ------------
  //
  // The Analytics Engine counts subOn/subOff involvement (M-G5) but not the
  // participation TIMES; minutes need them. This pass reads ONLY Sub and
  // Card events (defensively, never mutating) and mirrors the engine's
  // time fallback chain (matchSeconds ?? floor(time)) so marker times agree
  // with the engine's validated records.
  //
  // Team semantics: Sub events with team 'opponent' are opponent
  // substitutions — a reference to one of our squad ids there is attribution
  // noise (flagged, excluded from minute markers). Sub events with team null
  // or 'our' create our-participation markers (consistent with the engine's
  // team-agnostic M-G5 counting).

  function eventSeconds(ev) {
    if (isFinNum(ev.matchSeconds)) return ev.matchSeconds;
    var time = isFinNum(ev.time) ? ev.time : (isFinNum(ev.matchTime) ? ev.matchTime : null);
    return time === null ? null : Math.floor(time);
  }

  function collectMarkers(rawEvents) {
    var subOn = {};      // pid -> [{ seconds, team, eventId }]
    var subOff = {};     // pid -> [{ seconds, team, eventId }]
    var redCards = {};   // pid -> [{ seconds, eventId }]
    var opponentSubRefs = {};  // pid -> count (noise)
    var untimedMarkers = {};   // pid -> count
    var multipleSubOn = {};    // pid -> count (extra on-markers)

    rawEvents.forEach(function (ev) {
      if (!isPlainObject(ev)) return;
      var label = ev.label;
      var seconds = eventSeconds(ev);
      var id = isFinNum(ev.id) ? ev.id : null;

      if (label === 'Sub') {
        var team = (ev.team === 'our' || ev.team === 'opponent') ? ev.team : null;
        var onId = (typeof ev.playerOnId === 'string' && ev.playerOnId) ? ev.playerOnId : null;
        var offId = (typeof ev.playerOffId === 'string' && ev.playerOffId) ? ev.playerOffId : null;
        [onId, offId].forEach(function (pid) {
          if (!pid) return;
          if (team === 'opponent') {
            opponentSubRefs[pid] = (opponentSubRefs[pid] || 0) + 1;
            return; // opponent substitution — noise for our participation
          }
          if (seconds === null) untimedMarkers[pid] = (untimedMarkers[pid] || 0) + 1;
          var target = (pid === onId) ? subOn : subOff;
          if (!target[pid]) target[pid] = [];
          target[pid].push({ seconds: seconds, team: team, eventId: id });
        });
      } else if (label === 'Card' && ev.subtype === 'Red') {
        // Send-off marker: only player-attributed red cards for OUR team
        // ("sent off where explicitly represented").
        var pid = (typeof ev.playerId === 'string' && ev.playerId) ? ev.playerId : null;
        if (!pid || ev.team !== 'our') return;
        if (seconds === null) untimedMarkers[pid] = (untimedMarkers[pid] || 0) + 1;
        if (!redCards[pid]) redCards[pid] = [];
        redCards[pid].push({ seconds: seconds, eventId: id });
      }
    });

    Object.keys(subOn).forEach(function (pid) {
      if (subOn[pid].length > 1) multipleSubOn[pid] = subOn[pid].length - 1;
    });

    return {
      subOn: subOn, subOff: subOff, redCards: redCards,
      opponentSubRefs: opponentSubRefs, untimedMarkers: untimedMarkers,
      multipleSubOn: multipleSubOn
    };
  }

  // ---- Gated minutes (task Part 7; spec §3.4 as approved) ------------------
  //
  // QUALITY:
  //   RELIABLE    — every interval boundary is an explicit recorded fact
  //                 (Sub on/off time, player-attributed red card, or the
  //                 recorded FT marker) and no conflict flags fired.
  //   ESTIMATED   — a value exists but at least one boundary fell back to
  //                 last-known evidence (no FT / fallback end / un-timed
  //                 sub-off / conflicting sub-ons). Display ONLY — never a
  //                 per-90 denominator.
  //   UNAVAILABLE — null: no meaningful value (no start evidence, or the
  //                 start marker itself is un-timed).

  function ftEndSeconds(matchClock) {
    if (!matchClock || matchClock.period !== 'FT') return null;
    var base = matchClock.clockBaseSeconds;
    return (isFinNum(base) && base > 0) ? base : null;
  }

  // Fallback end (observed lower bound) when no FT marker: the later of the
  // last in-play event (from the engine's A.spatial records — validated) and
  // the persisted clock base.
  function fallbackEndSeconds(records, matchClock) {
    var last = 0;
    records.forEach(function (r) {
      if (PLAY_PERIODS.indexOf(r.period) !== -1 && isFinNum(r.matchSeconds)) {
        if (r.matchSeconds > last) last = r.matchSeconds;
      }
    });
    if (matchClock && isFinNum(matchClock.clockBaseSeconds) && matchClock.clockBaseSeconds > last) {
      last = matchClock.clockBaseSeconds;
    }
    return last;
  }

  function computeMinutes(ctx, part, playerId) {
    var reasons = [];
    var opponentRefs = ctx.markers.opponentSubRefs[playerId] || 0;
    if (opponentRefs > 0) reasons.push('OPPONENT_SUB_REFERENCES_PLAYER'); // informational

    var onMarkers = [];
    if (part.starter) onMarkers.push({ seconds: 0, marker: 'KICK_OFF_1H' });
    (ctx.markers.subOn[playerId] || []).forEach(function (m) {
      onMarkers.push({ seconds: m.seconds, marker: 'SUB_ON' });
    });
    var offMarkers = (ctx.markers.subOff[playerId] || []).map(function (m) {
      return { seconds: m.seconds, marker: 'SUB_OFF' };
    });
    (ctx.markers.redCards[playerId] || []).forEach(function (m) {
      offMarkers.push({ seconds: m.seconds, marker: 'SENT_OFF' });
    });

    var untimed = (ctx.markers.untimedMarkers[playerId] || 0) + (ctx.markers.multipleSubOn[playerId] || 0);

    // UNAVAILABLE: no start evidence at all.
    if (onMarkers.length === 0) {
      var reason = part.unknownReason || 'NO_PARTICIPATION_MARKERS';
      return {
        value: null, secondsExact: null, onPitchIntervals: [], quality: 'UNAVAILABLE',
        reasonCodes: reasons.concat([reason]), basis: MINUTES_STANDARDS.basis
      };
    }

    // UNAVAILABLE: a start marker (sub-on) with no usable time — the start
    // boundary cannot be established.
    var startUntimed = onMarkers.some(function (m) { return m.seconds === null; }) && !part.starter;
    if (startUntimed) {
      return {
        value: null, secondsExact: null, onPitchIntervals: [], quality: 'UNAVAILABLE',
        reasonCodes: reasons.concat(['SUB_TIME_MISSING']), basis: MINUTES_STANDARDS.basis
      };
    }

    if (onMarkers.length > 1) reasons.push('MULTIPLE_SUB_ON');
    if (!ctx.ftEnd) reasons.push('NO_FT_MARKER');

    // Deterministic marker order: by seconds (null sorts LAST), then marker
    // name, then eventId.
    function cmpMarkers(a, b) {
      var as = a.seconds, bs = b.seconds;
      if (as === null && bs === null) return 0;
      if (as === null) return 1;
      if (bs === null) return -1;
      if (as !== bs) return as - bs;
      return a.marker < b.marker ? -1 : (a.marker > b.marker ? 1 : 0);
    }
    onMarkers.sort(cmpMarkers);
    offMarkers.sort(cmpMarkers);

    var intervals = [];
    var endFallbackUsed = false;
    var endUntimedUsed = false;

    for (var i = 0; i < onMarkers.length; i++) {
      var start = onMarkers[i].seconds;
      if (start === null) continue; // a starter start (0) is always timed

      // earliest explicit off marker strictly after this start
      var end = null, endMarker = null;
      for (var j = 0; j < offMarkers.length; j++) {
        var om = offMarkers[j];
        if (om.seconds !== null && om.seconds > start) { end = om.seconds; endMarker = om.marker; break; }
      }
      if (end === null) {
        if (ctx.ftEnd !== null) { end = ctx.ftEnd; endMarker = 'FT'; }
        else { end = ctx.fallbackEnd; endMarker = 'END_FALLBACK_LAST_KNOWN'; endFallbackUsed = true; }
      }
      // an un-timed off marker later in the match means an end we cannot
      // place explicitly — the interval still closes at the resolved end,
      // and the fact is flagged
      if (offMarkers.length > 0 && offMarkers[offMarkers.length - 1].seconds === null) endUntimedUsed = true;

      intervals.push({
        fromSeconds: start,
        toSeconds: end,
        startMarker: onMarkers[i].marker,
        endMarker: endMarker
      });
    }

    if (endFallbackUsed) reasons.push('END_FALLBACK_LAST_KNOWN');
    if (endUntimedUsed && (ctx.markers.untimedMarkers[playerId] || 0) > 0) reasons.push('SUB_TIME_MISSING');

    // Multiple sub-ons (data conflict, spec §3.4): overlapping intervals are
    // NOT summed — the LONGEST span is used and the conflict is reported.
    if (intervals.length > 1) {
      intervals.sort(function (a, b) {
        var la = a.toSeconds - a.fromSeconds, lb = b.toSeconds - b.fromSeconds;
        if (la !== lb) return lb - la;              // longest span first
        return a.fromSeconds - b.fromSeconds;       // tie: earliest start
      });
      intervals = intervals.slice(0, 1);
    }

    // dedupe reason codes, keep deterministic order of first appearance
    var seen = {}; var unique = [];
    reasons.forEach(function (r) {
      if (!seen[r]) { seen[r] = 1; unique.push(r); }
    });

    var secondsExact = 0;
    intervals.forEach(function (iv) {
      secondsExact += Math.max(0, iv.toSeconds - iv.fromSeconds);
    });

    var boundaryAffecting = unique.filter(function (r) {
      return r === 'NO_FT_MARKER' || r === 'END_FALLBACK_LAST_KNOWN' ||
        r === 'SUB_TIME_MISSING' || r === 'MULTIPLE_SUB_ON';
    });

    return {
      value: roundHalfUp1(secondsExact / 60),
      secondsExact: secondsExact,
      onPitchIntervals: intervals,
      quality: boundaryAffecting.length > 0 ? 'ESTIMATED' : 'RELIABLE',
      reasonCodes: unique,
      basis: MINUTES_STANDARDS.basis
    };
  }

  // ---- Per-player period / score-state partitions --------------------------
  //
  // Source: the engine's OWN A.spatial event records (locatedEvents +
  // unlocatedEvents = every validated record), each carrying playerId
  // (Sub → null), period, stateBefore, label, subtype, isGoal. Qualifier-free
  // metric family only (see PARTITION_KEYS). Reconciliation with A.players
  // metrics and A.level3 is test-asserted.

  function zeroPartition() {
    var b = {};
    PARTITION_KEYS.forEach(function (k) { b[k] = 0; });
    return b;
  }

  function addToPartition(bucket, rec) {
    bucket.events++;
    if (rec.isGoal) bucket.goals++;
    switch (rec.label) {
      case 'Shot':
        bucket.shots++;
        if (rec.subtype === 'On target') bucket.shotsOnTarget++;
        break;
      case 'Chance': bucket.chances++; break;
      case 'Key Pass': bucket.keyPasses++; break;
      case 'Cross': bucket.crosses++; break;
      case 'Pass': bucket.passes++; break;
      case 'Press': bucket.presses++; break;
      case 'Press Win': bucket.pressWins++; break;
      case 'Interception': bucket.interceptions++; break;
      case 'Recovery': bucket.recoveries++; break;
      case 'Turnover': bucket.turnovers++; break;
      case 'Duel': bucket.duels++; break;
      case 'Foul': bucket.fouls++; break;
      case 'Card':
        if (rec.subtype === 'Yellow') bucket.yellowCards++;
        else if (rec.subtype === 'Red') bucket.redCards++;
        break;
      case 'Positive Transition': bucket.transitionsPositive++; break;
      case 'Negative Transition': bucket.transitionsNegative++; break;
    }
  }

  function periodBucketOf(period) {
    if (PLAY_PERIODS.indexOf(period) !== -1) return period;
    if (period === 'PRE_MATCH' || period === 'HT' || period === 'ET_HT' || period === 'FT') return 'Non-play';
    return 'Unknown';
  }

  function playerPartitions(spatialRecords) {
    var byPlayer = {};   // pid -> { byPeriod: {bucket->partition}, byState: {...}, unattributed: {...} }
    var unattributedByPeriod = {};   // period bucket -> partition (playerId null)
    var unattributedByState = {};

    PERIOD_BUCKETS.forEach(function (p) { unattributedByPeriod[p] = zeroPartition(); });
    SCORE_STATES.forEach(function (s) { unattributedByState[s] = zeroPartition(); });

    function bucketFor(pid) {
      if (!byPlayer[pid]) {
        var bp = {}, bs = {};
        PERIOD_BUCKETS.forEach(function (p) { bp[p] = zeroPartition(); });
        SCORE_STATES.forEach(function (s) { bs[s] = zeroPartition(); });
        byPlayer[pid] = { byPeriod: bp, byState: bs };
      }
      return byPlayer[pid];
    }

    spatialRecords.forEach(function (rec) {
      var pb = periodBucketOf(rec.period);
      var sb = rec.stateBefore;
      if (rec.playerId) {
        var b = bucketFor(rec.playerId);
        addToPartition(b.byPeriod[pb], rec);
        if (SCORE_STATES.indexOf(sb) !== -1) addToPartition(b.byState[sb], rec);
      } else {
        addToPartition(unattributedByPeriod[pb], rec);
        if (SCORE_STATES.indexOf(sb) !== -1) addToPartition(unattributedByState[sb], rec);
      }
    });

    return { byPlayer: byPlayer, unattributedByPeriod: unattributedByPeriod, unattributedByState: unattributedByState };
  }

  // ---- Player spatial block (from A.spatial.playerGrids — copied, not
  // recomputed; players without a grid (0 located events) get zeros + their
  // unlocated count) ---------------------------------------------------------

  function playerSpatialBlock(playerGrid, attributedEventCount) {
    var zones = {};
    ZONE_KEYS.forEach(function (z) { zones[z] = 0; });
    var thirds = { 'Defensive third': 0, 'Middle third': 0, 'Attacking third': 0 };
    var channels = { 'Left channel': 0, 'Central channel': 0, 'Right channel': 0 };
    var located = 0, unlocated = 0;

    if (playerGrid) {
      located = playerGrid.located;
      unlocated = playerGrid.unlocated;
      playerGrid.cells.forEach(function (cell) {
        zones[cell.zoneKey] = cell.counts.events;
      });
      playerGrid.margins.byThird.forEach(function (m) { thirds[m.name] = m.counts.events; });
      playerGrid.margins.byChannel.forEach(function (m) { channels[m.name] = m.counts.events; });
    } else {
      unlocated = attributedEventCount; // playerId-attributed events, all unlocated
    }

    return {
      zones: zones,
      unlocatedZone: unlocated,
      thirds: thirds,
      channels: channels,
      located: located,
      unlocated: unlocated,
      locatedShare: ratioEnv(located, located + unlocated)
    };
  }

  // ---- Data-quality flags ---------------------------------------------------

  function playerMatchQuality(rec, ctx) {
    var flags = [];
    if (rec.unresolvedPlayer) flags.push('UNRESOLVED_PLAYER');
    if (!ctx.session.sourceFile && !ctx.session.savedAt) flags.push('MISSING_MATCH_IDENTITY');
    if ((ctx.markers.untimedMarkers[rec.playerId] || 0) > 0) flags.push('MISSING_SUB_INFO');
    if (!ctx.ftEnd) flags.push('INCOMPLETE_MATCH_NO_FT');
    if (rec.minutes.quality !== 'RELIABLE' && rec.minutes.quality !== null) flags.push('UNRELIABLE_MINUTES');
    if (rec.metrics.events > 0 && rec.spatial.locatedShare.value === null) flags.push('MISSING_LOCATION');
    else if (rec.spatial.locatedShare.value !== null && rec.spatial.locatedShare.value < 50 && rec.metrics.events > 0) flags.push('LOW_LOCATION_COVERAGE');
    if (ctx.result.outcome === null) flags.push('MISSING_FINAL_SCORE');
    if (ctx.x1Status === 'MISMATCH') flags.push('INCONSISTENT_GOAL_CHAIN');

    // Record-completeness status: identity/XI/FT/score/chain flags decide
    // VALID vs PARTIAL. Location-coverage flags are informational (a coverage
    // metric of the tagged data, not record completeness) — reported, but
    // they do not by themselves make a record partial.
    var structural = flags.filter(function (f) {
      return f !== 'LOW_LOCATION_COVERAGE' && f !== 'MISSING_LOCATION';
    });

    var status;
    if (rec.metrics.events === 0 && !rec.participation.appearance) status = 'INSUFFICIENT';
    else if (structural.length === 0) status = 'VALID';
    else status = 'PARTIAL';

    return { status: status, flags: flags };
  }

  // ---- Result (task Part 12) ------------------------------------------------

  function matchResult(A) {
    var score = A.matchSummary && A.matchSummary.score || {};
    var manual = score.manual || null;   // { for, against } | null
    var chain = score.chain || { for: 0, against: 0 };
    var x1 = score.reconciliation || 'MANUAL-EMPTY';

    var source = null, scoreFor = null, scoreAgainst = null;
    if (manual) { source = 'MANUAL'; scoreFor = manual.for; scoreAgainst = manual.against; }
    else { source = 'CHAIN'; scoreFor = chain.for; scoreAgainst = chain.against; }

    var outcome = null, reason = null;
    if (scoreFor !== null && scoreAgainst !== null && isFinNum(scoreFor) && isFinNum(scoreAgainst)) {
      outcome = scoreFor > scoreAgainst ? 'W' : (scoreFor < scoreAgainst ? 'L' : 'D');
    } else {
      reason = 'NO_SCORE_SOURCE';
    }
    if (x1 === 'MANUAL-EMPTY' && !manual && chain.for === 0 && chain.against === 0 && A.matchSummary && A.matchSummary.totalEvents > 0) {
      // chain empty + no manual: no goals recorded at all — 0-0 is the
      // engine's reference result, keep it (source CHAIN), no extra reason.
    }

    return {
      outcome: outcome,
      scoreFor: scoreFor,
      scoreAgainst: scoreAgainst,
      source: source,
      x1Status: x1,
      flagged: x1 === 'MISMATCH',
      reason: reason
    };
  }

  // ---- Per-match record builders --------------------------------------------

  function buildPlayerMatchRecords(ctx) {
    var A = ctx.A;
    var session = ctx.session;

    // Squad snapshot resolution (PSD-H3): THIS session's embedded squad.
    var squadEntry = {};
    session.squad.forEach(function (p) {
      if (isPlainObject(p) && typeof p.id === 'string' && p.id) {
        squadEntry[p.id] = { name: str(p.name, 'Unknown player') || 'Unknown player', number: str(p.number) };
      }
    });

    // Referenced player ids: XI + markers + engine player list
    var ids = {};
    function addId(pid) { if (pid && typeof pid === 'string') ids[pid] = true; }
    ctx.startingXI.forEach(addId);
    Object.keys(ctx.markers.subOn).forEach(addId);
    Object.keys(ctx.markers.subOff).forEach(addId);
    Object.keys(ctx.markers.redCards).forEach(addId);
    (A.players && A.players.list || []).forEach(function (p) { addId(p.playerId); });
    Object.keys(squadEntry).forEach(addId); // selected (squad-listed)

    // Engine player metrics lookup
    var engineById = {};
    (A.players && A.players.list || []).forEach(function (p) { engineById[p.playerId] = p; });

    // Engine spatial player grids lookup
    var gridByPid = {};
    (A.spatial && A.spatial.playerGrids || []).forEach(function (g) { gridByPid[g.playerId] = g; });

    var records = Object.keys(ids).map(function (pid) {
      var entry = squadEntry[pid] || null;
      var enginePlayer = engineById[pid] || null;
      var m = enginePlayer ? enginePlayer.metrics : null;

      // participation (task Part 6)
      var starter = ctx.startingXI.indexOf(pid) !== -1;
      var onMarkers = (ctx.markers.subOn[pid] || []).filter(function (x) { return x.team !== 'opponent'; });
      var offMarkers = (ctx.markers.subOff[pid] || []).filter(function (x) { return x.team !== 'opponent'; });
      var reds = ctx.markers.redCards[pid] || [];
      var substitute = (ctx.markers.subOn[pid] || []).length > 0; // engine M-G1 semantics (any team)
      var selected = !!entry;
      // Unused-substitute proof requires XI evidence: with no starting XI at
      // all, "did not start" is not provable, so unused stays false and the
      // record lands in UNKNOWN (never guessed).
      var unused = selected && !starter && !substitute && ctx.xiPresent;
      var unknownReason = null;
      if (!starter && !substitute && !selected && !m) unknownReason = 'NOT_IN_SQUAD';
      else if (!starter && !substitute && !ctx.xiPresent) unknownReason = 'STARTING_XI_MISSING';

      var participation = {
        selected: selected,
        starter: starter,
        substitute: substitute,
        unused: unused,
        substitutedOn: onMarkers.length > 0,
        substitutedOnSeconds: onMarkers.length > 0 ? onMarkers[0].seconds : null,
        substitutedOff: offMarkers.length > 0,
        substitutedOffSeconds: offMarkers.length > 0 ? offMarkers[0].seconds : null,
        sentOff: reds.length > 0,
        sentOffSeconds: reds.length > 0 ? reds[0].seconds : null,
        appearance: starter || substitute, // == engine A.players.appearance (tested)
        status: null,
        unknownReason: unknownReason
      };

      // participation status enum (spec §3.2)
      if (participation.appearance) {
        if (starter) {
          if (reds.length > 0) participation.status = 'STARTED_SENT_OFF';
          else if (offMarkers.length > 0) participation.status = 'STARTED_SUBBED_OFF';
          else if (ctx.ftEnd !== null) participation.status = 'STARTED_FULL';
          else participation.status = 'STARTED';
        } else {
          if (reds.length > 0) participation.status = 'SUB_ON_SENT_OFF';
          else if (offMarkers.length > 0) participation.status = 'SUB_ON_SUBBED_OFF';
          else participation.status = 'SUB_ON';
        }
      } else if (unused) {
        participation.status = 'UNUSED_SUB';
      } else if (unknownReason === 'STARTING_XI_MISSING') {
        participation.status = 'UNKNOWN';
      } else if (unknownReason === 'NOT_IN_SQUAD') {
        participation.status = 'NOT_INVOLVED';
      } else {
        participation.status = 'NOT_INVOLVED';
      }

      // metrics (engine-verbatim; envelope-derived pass outcomes; byLabel copy)
      var metrics = {
        events: enginePlayer ? enginePlayer.events : 0,
        byLabel: enginePlayer ? Object.assign({}, enginePlayer.byLabel) : {},
        goals: m ? m.goals : 0,
        shots: m ? m.shots : 0,
        shotsOnTarget: m ? m.shotsOnTarget : 0,
        chances: m ? m.chances : 0,
        keyPasses: m ? m.keyPasses : 0,
        crosses: m ? m.crosses : 0,
        passes: m ? m.passes : 0,
        successfulPasses: m && m.passSuccess ? m.passSuccess.num : 0,
        unsuccessfulPasses: m && m.passSuccess ? (m.passSuccess.den - m.passSuccess.num) : 0,
        passesUnknownOutcome: m ? Math.max(0, (m.passes || 0) - (m.passSuccess ? m.passSuccess.den : 0)) : 0,
        passSuccess: m ? m.passSuccess : ratioEnv(0, 0),
        presses: m ? m.presses : 0,
        pressWins: m ? m.pressWins : 0,
        interceptions: m ? m.interceptions : 0,
        recoveries: m ? m.recoveries : 0,
        turnovers: m ? m.turnovers : 0,
        duels: m ? m.duels : 0,
        fouls: m ? m.fouls : 0,
        yellowCards: m ? m.yellowCards : 0,
        redCards: m ? m.redCards : 0,
        positiveEvents: m ? m.positiveEvents : 0,
        negativeEvents: m ? m.negativeEvents : 0,
        neutralEvents: enginePlayer ? Math.max(0, enginePlayer.events - m.positiveEvents - m.negativeEvents) : 0,
        transitionsPositive: enginePlayer ? (enginePlayer.byLabel['Positive Transition'] || 0) : 0,
        transitionsNegative: enginePlayer ? (enginePlayer.byLabel['Negative Transition'] || 0) : 0,
        subOn: m ? m.subOn : 0,
        subOff: m ? m.subOff : 0
      };

      // partitions
      var part = ctx.partitions.byPlayer[pid] || null;
      var byPeriod = {}, byState = {};
      PERIOD_BUCKETS.forEach(function (p) {
        byPeriod[p] = part ? Object.assign({}, part.byPeriod[p]) : zeroPartition();
      });
      if (ctx.stateSuppressed) {
        byState = null;
      } else {
        SCORE_STATES.forEach(function (s) {
          byState[s] = part ? Object.assign({}, part.byState[s]) : zeroPartition();
        });
      }

      // spatial
      var attributedEventCount = part ? part.byPeriod['1H'].events + part.byPeriod['2H'].events +
        part.byPeriod['ET1'].events + part.byPeriod['ET2'].events +
        part.byPeriod['Non-play'].events + part.byPeriod['Unknown'].events : 0;
      var spatial = playerSpatialBlock(gridByPid[pid] || null, attributedEventCount);

      var rec = {
        matchIndex: ctx.matchIndex,
        matchKey: { loadIndex: session.loadIndex, sourceFile: session.sourceFile, savedAt: session.savedAt, label: session.label },
        playerId: pid,
        name: entry ? entry.name : 'Unknown player',
        number: entry ? entry.number : '',
        unresolvedPlayer: !entry,
        opponent: str(session.matchInfo.opponent),
        competition: str(session.matchInfo.competition),
        date: str(session.matchInfo.date),
        homeAway: str(session.matchInfo.homeAway),
        venue: str(session.matchInfo.venue),
        formation: str(session.matchInfo.formation),
        participation: participation,
        minutes: computeMinutes(ctx, participation, pid),
        metrics: metrics,
        spatial: spatial,
        periods: byPeriod,
        gameState: byState,
        gameStateSuppressedReason: ctx.stateSuppressed ? 'X1_MISMATCH_SUPPRESSED' : null,
        dataQuality: null // filled below
      };
      rec.dataQuality = playerMatchQuality(rec, ctx);
      return rec;
    });

    // Deterministic order: events desc, playerId asc (mirrors A.players order)
    records.sort(function (a, b) {
      if (b.metrics.events !== a.metrics.events) return b.metrics.events - a.metrics.events;
      return a.playerId < b.playerId ? -1 : (a.playerId > b.playerId ? 1 : 0);
    });
    return records;
  }

  function copyEnvelope(env) {
    if (!isPlainObject(env)) return { value: null };
    var out = { value: env.value };
    if (env.excluded !== undefined) out.excluded = env.excluded;
    if (env.num !== undefined) { out.num = env.num; out.den = env.den; }
    if (env.params !== undefined) out.params = env.params;
    return out;
  }

  var TEAM_COUNT_KEYS = ['events', 'goals', 'shots', 'shotsOnTarget', 'shotsOffTarget',
    'shotsBlocked', 'shotsUnknownOutcome', 'chances', 'crosses', 'corners', 'fouls',
    'yellowCards', 'redCards', 'substitutions', 'passes', 'successfulPasses',
    'unsuccessfulPasses', 'passesUnknownOutcome', 'progressivePasses', 'lateralPasses',
    'backwardPasses', 'longPasses', 'passesUnderPressure', 'presses', 'pressWins',
    'interceptions', 'recoveries', 'turnovers', 'duels', 'positiveTransitions', 'negativeTransitions'];

  function teamCountsFromLevel1(level1Team) {
    var out = {};
    TEAM_COUNT_KEYS.forEach(function (k) {
      out[k] = level1Team && isPlainObject(level1Team[k]) ? copyEnvelope(level1Team[k]) : countEnv(0);
    });
    return out;
  }

  function buildTeamMatchRecord(ctx) {
    var A = ctx.A;
    var session = ctx.session;
    var mi = session.matchInfo;
    var score = A.matchSummary && A.matchSummary.score || {};

    // spatial: located/unlocated per team partition + zone/third/channel
    // (all-events scope, team partitions — copied from A.spatial grids)
    var grids = {};
    (A.spatial && A.spatial.grids || []).forEach(function (g) {
      if (g.scope === 'all') grids[g.partition] = g;
    });
    function teamSpatial(partition) {
      var g = grids[partition] || null;
      var zones = {};
      ZONE_KEYS.forEach(function (z) { zones[z] = g ? g.cells.reduce(function (acc, c) { return acc + (c.zoneKey === z ? c.counts.events : 0); }, 0) : 0; });
      // NOTE: cells are row-major zone order — direct index access is exact;
      // the reduce above stays robust to future cell ordering changes.
      if (g) {
        zones = {};
        g.cells.forEach(function (c) { zones[c.zoneKey] = c.counts.events; });
      }
      var thirds = {}, channels = {};
      THIRDS.forEach(function (t) { thirds[t] = 0; });
      CHANNELS.forEach(function (c) { channels[c] = 0; });
      if (g) {
        g.margins.byThird.forEach(function (m) { thirds[m.name] = m.counts.events; });
        g.margins.byChannel.forEach(function (m) { channels[m.name] = m.counts.events; });
      }
      return {
        located: g ? g.located : 0,
        unlocated: g ? g.unlocated : 0,
        locatedShare: g ? copyEnvelope(g.locatedShare) : ratioEnv(0, 0),
        zones: zones,
        unlocatedZone: g ? g.unlocatedBucket.counts.events : 0,
        thirds: thirds,
        channels: channels
      };
    }

    var level3 = A.level3 || {};
    var byPeriod = {};
    PERIOD_BUCKETS.forEach(function (p) {
      byPeriod[p] = level3.byPeriod && level3.byPeriod[p]
        ? { counts: level3.byPeriod[p].counts, stoppage: level3.byPeriod[p].stoppage }
        : { counts: null, stoppage: null };
    });

    var flags = [];
    if (!session.sourceFile && !session.savedAt) flags.push('MISSING_MATCH_IDENTITY');
    if (!ctx.ftEnd) flags.push('INCOMPLETE_MATCH_NO_FT');
    if (ctx.xiPresent && ctx.xiFilled < ctx.xiSlots) flags.push('STARTING_XI_INCOMPLETE');
    if (!ctx.xiPresent) flags.push('STARTING_XI_MISSING');
    if (ctx.result.outcome === null) flags.push('MISSING_FINAL_SCORE');
    if (ctx.x1Status === 'MISMATCH') flags.push('INCONSISTENT_GOAL_CHAIN');
    var oppSubNoise = Object.keys(ctx.markers.opponentSubRefs).length;
    if (oppSubNoise > 0) flags.push('OPPONENT_SUB_NOISE');
    var locatedShare = A.spatial && A.spatial.completeness ? A.spatial.completeness.locatedShare : null;
    if (A.matchSummary && A.matchSummary.totalEvents > 0 && (!locatedShare || locatedShare.value === null || locatedShare.value < 50)) flags.push('LOW_LOCATION_COVERAGE');
    // Status reflects record completeness (identity/XI/FT/score/chain);
    // location coverage is informational, not record completeness.
    var structural = flags.filter(function (f) { return f !== 'LOW_LOCATION_COVERAGE'; });
    var status = structural.length === 0 ? 'VALID' : 'PARTIAL';

    return {
      matchIndex: ctx.matchIndex,
      matchKey: { loadIndex: session.loadIndex, sourceFile: session.sourceFile, savedAt: session.savedAt, label: session.label },
      opponent: str(mi.opponent),
      competition: str(mi.competition),
      date: str(mi.date),
      homeAway: str(mi.homeAway),
      venue: str(mi.venue),
      formation: str(mi.formation),
      startingXI: { slots: ctx.xiSlots, filled: ctx.xiFilled, present: ctx.xiPresent },
      result: ctx.result,
      durationMinutes: A.matchSummary ? A.matchSummary.durationMinutes : 90,
      ftMarkerPresent: ctx.ftEnd !== null,
      ftEndSeconds: ctx.ftEnd,
      events: {
        our: teamCountsFromLevel1(A.level1 && A.level1.team ? A.level1.team.our : null),
        opponent: teamCountsFromLevel1(A.level1 && A.level1.team ? A.level1.team.opponent : null),
        unattributed: teamCountsFromLevel1(A.level1 && A.level1.team ? A.level1.team.unattributed : null)
      },
      derived: {
        our: {
          passSuccess: (A.level2 && A.level2.team && A.level2.team.our) ? copyEnvelope(A.level2.team.our.passSuccess) : ratioEnv(0, 0),
          shotAccuracy: (A.level2 && A.level2.team && A.level2.team.our) ? copyEnvelope(A.level2.team.our.shotAccuracy) : ratioEnv(0, 0),
          shotConversion: (A.level2 && A.level2.team && A.level2.team.our) ? copyEnvelope(A.level2.team.our.shotConversion) : ratioEnv(0, 0),
          chanceConversion: (A.level2 && A.level2.team && A.level2.team.our) ? copyEnvelope(A.level2.team.our.chanceConversion) : ratioEnv(0, 0),
          pressWinRatio: (A.level2 && A.level2.team && A.level2.team.our) ? copyEnvelope(A.level2.team.our.pressWinRatio) : ratioEnv(0, 0)
        },
        opponent: {
          passSuccess: (A.level2 && A.level2.team && A.level2.team.opponent) ? copyEnvelope(A.level2.team.opponent.passSuccess) : ratioEnv(0, 0),
          shotAccuracy: (A.level2 && A.level2.team && A.level2.team.opponent) ? copyEnvelope(A.level2.team.opponent.shotAccuracy) : ratioEnv(0, 0),
          shotConversion: (A.level2 && A.level2.team && A.level2.team.opponent) ? copyEnvelope(A.level2.team.opponent.shotConversion) : ratioEnv(0, 0),
          chanceConversion: (A.level2 && A.level2.team && A.level2.team.opponent) ? copyEnvelope(A.level2.team.opponent.chanceConversion) : ratioEnv(0, 0),
          pressWinRatio: (A.level2 && A.level2.team && A.level2.team.opponent) ? copyEnvelope(A.level2.team.opponent.pressWinRatio) : ratioEnv(0, 0)
        }
      },
      possession: {
        basis: 'Recorded PitchLog Possession interval tags ONLY — not an official match possession statistic (NC-1)',
        ourSecondsExact: A.level1 && A.level1.possession && A.level1.possession.our ? A.level1.possession.our.totalSecondsExact : 0,
        opponentSecondsExact: A.level1 && A.level1.possession && A.level1.possession.opponent ? A.level1.possession.opponent.totalSecondsExact : 0,
        ourIntervals: A.level1 && A.level1.possession && A.level1.possession.our ? A.level1.possession.our.intervals.value : 0,
        opponentIntervals: A.level1 && A.level1.possession && A.level1.possession.opponent ? A.level1.possession.opponent.intervals.value : 0,
        share: (A.level2 && A.level2.team && A.level2.team.our && A.level2.team.our.taggedPossessionShare)
          ? copyEnvelope(A.level2.team.our.taggedPossessionShare) : null
      },
      spatial: {
        completeness: A.spatial ? copyEnvelope(A.spatial.completeness.locatedShare) : ratioEnv(0, 0),
        our: teamSpatial('our'),
        opponent: teamSpatial('opponent'),
        all: teamSpatial('all')
      },
      periods: byPeriod,
      gameState: level3.byState || null,
      gameStateSuppressedReason: level3.stateSuppressedReason || null,
      appearanceCounts: ctx.appearanceCounts,
      dataQuality: { status: status, flags: flags }
    };
  }

  // ---- Season aggregation ---------------------------------------------------

  function sumCounts(target, source) {
    COUNT_KEYS.forEach(function (k) {
      target[k] += (source[k] || 0);
    });
  }
  function zeroCounts() {
    var c = {};
    COUNT_KEYS.forEach(function (k) { c[k] = 0; });
    return c;
  }
  function sumPartition(target, source) {
    PARTITION_KEYS.forEach(function (k) { target[k] += (source[k] || 0); });
  }
  function sumEnvelopes(list) {
    // pooled ratio from summed num/den (task Part 17)
    var num = 0, den = 0;
    var excluded = {};
    list.forEach(function (e) {
      if (!e) return;
      num += (e.num || 0);
      den += (e.den || 0);
      if (e.excluded) {
        Object.keys(e.excluded).forEach(function (k) {
          excluded[k] = (excluded[k] || 0) + (e.excluded[k] || 0);
        });
      }
    });
    return ratioEnv(num, den, excluded);
  }

  function buildPlayerSeason(records, allMatches) {
    var pid = records[0].playerId;
    var totals = zeroCounts();
    var spatialZones = {};
    ZONE_KEYS.forEach(function (z) { spatialZones[z] = 0; });
    var spatialThirds = { 'Defensive third': 0, 'Middle third': 0, 'Attacking third': 0 };
    var spatialChannels = { 'Left channel': 0, 'Central channel': 0, 'Right channel': 0 };
    var spatialLocated = 0, spatialUnlocated = 0, spatialUnlocatedZone = 0;

    var periods = {};
    PERIOD_BUCKETS.forEach(function (p) { periods[p] = zeroPartition(); });
    var gameState = {};
    SCORE_STATES.forEach(function (s) { gameState[s] = zeroPartition(); });
    var stateSuppressedMatches = 0;

    var minutes = {
      reliableSeconds: 0, estimatedSeconds: 0,
      reliableMatches: 0, estimatedMatches: 0, unavailableMatches: 0
    };
    var reasonRollup = [];
    var passEnvelopes = [];
    var appearances = 0, starts = 0, substituteAppearances = 0, unusedSubstitutions = 0;
    var matchesSelected = 0, sentOffs = 0, subOns = 0, subOffs = 0;
    var matchRecordIndexes = [];
    var nameVariantsMap = {};   // 'name|number' -> { name, number, matchIndexes }
    var flags = {};
    var unresolvedMatches = 0;

    var per90Totals = zeroCounts();   // totals restricted to RELIABLE-minute matches
    var per90MatchIndexes = [];

    records.forEach(function (rec) {
      matchRecordIndexes.push(rec.matchIndex);
      sumCounts(totals, rec.metrics);

      // participation
      if (rec.participation.appearance) appearances++;
      if (rec.participation.starter) starts++;
      if (rec.participation.substitute && rec.participation.appearance) substituteAppearances++;
      if (rec.participation.unused) unusedSubstitutions++;
      if (rec.participation.selected) matchesSelected++;
      if (rec.participation.sentOff) sentOffs++;
      subOns += rec.metrics.subOn;
      subOffs += rec.metrics.subOff;

      // minutes quality buckets
      var q = rec.minutes.quality;
      if (q === 'RELIABLE') { minutes.reliableSeconds += rec.minutes.secondsExact; minutes.reliableMatches++; }
      else if (q === 'ESTIMATED') { minutes.estimatedSeconds += rec.minutes.secondsExact; minutes.estimatedMatches++; }
      else minutes.unavailableMatches++;
      rec.minutes.reasonCodes.forEach(function (r) {
        if (reasonRollup.indexOf(r) === -1) reasonRollup.push(r);
      });

      // per-90 numerator: only RELIABLE-minute matches (same match set as the
      // denominator — documented in MINUTES_STANDARDS.per90Basis)
      if (q === 'RELIABLE') {
        sumCounts(per90Totals, rec.metrics);
        per90MatchIndexes.push(rec.matchIndex);
      }

      // percentages inputs
      if (rec.metrics.passes > 0) {
        passEnvelopes.push(ratioEnv(rec.metrics.successfulPasses, rec.metrics.successfulPasses + rec.metrics.unsuccessfulPasses, { unknownOutcome: rec.metrics.passesUnknownOutcome }));
      }

      // spatial
      ZONE_KEYS.forEach(function (z) { spatialZones[z] += rec.spatial.zones[z] || 0; });
      THIRDS.forEach(function (t) { spatialThirds[t] += rec.spatial.thirds[t] || 0; });
      CHANNELS.forEach(function (c) { spatialChannels[c] += rec.spatial.channels[c] || 0; });
      spatialLocated += rec.spatial.located;
      spatialUnlocated += rec.spatial.unlocated;
      spatialUnlocatedZone += rec.spatial.unlocatedZone || 0;

      // partitions
      PERIOD_BUCKETS.forEach(function (p) { sumPartition(periods[p], rec.periods[p]); });
      if (rec.gameState) {
        SCORE_STATES.forEach(function (s) { sumPartition(gameState[s], rec.gameState[s]); });
      } else stateSuppressedMatches++;

      // identity variants
      var vkey = rec.name + '|' + rec.number;
      if (!nameVariantsMap[vkey]) nameVariantsMap[vkey] = { name: rec.name, number: rec.number, matchIndexes: [] };
      nameVariantsMap[vkey].matchIndexes.push(rec.matchIndex);

      // quality flags
      if (rec.unresolvedPlayer) { flags.UNRESOLVED_PLAYER = true; unresolvedMatches++; }
      rec.dataQuality.flags.forEach(function (f) { flags[f] = true; });
    });

    var nameVariants = Object.keys(nameVariantsMap).map(function (k) { return nameVariantsMap[k]; });
    // canonical name: the most recent non-'Unknown player' variant (records
    // are in season order because matches are)
    var canonical = null;
    for (var i = records.length - 1; i >= 0; i--) {
      if (records[i].name !== 'Unknown player') { canonical = records[i].name; break; }
    }
    var canonicalNumber = null;
    for (var j = records.length - 1; j >= 0; j--) {
      if (records[j].number !== '') { canonicalNumber = records[j].number; break; }
    }

    // per-90 values: total / (reliable minutes) × 90 — computed from the
    // UNROUNDED reliable seconds (value = total × 5400 / seconds)
    var per90Metrics = {};
    PER90_KEYS.forEach(function (k) {
      per90Metrics[k] = minutes.reliableSeconds > 0
        ? { value: roundHalfUp1(per90Totals[k] * 5400 / minutes.reliableSeconds), total: per90Totals[k] }
        : { value: null, total: per90Totals[k] };
    });

    // averages per appearance
    var averages = {};
    COUNT_KEYS.forEach(function (k) {
      averages[k] = appearances > 0 ? roundHalfUp1(totals[k] / appearances) : null;
    });

    // pooled percentages
    var percentages = {
      passSuccess: sumEnvelopes(passEnvelopes),
      pressWinRatio: ratioEnv(totals.pressWins, totals.presses),
      locatedShare: ratioEnv(spatialLocated, spatialLocated + spatialUnlocated)
    };

    var flagList = Object.keys(flags);
    var status = 'INSUFFICIENT';
    if (appearances > 0 && flagList.length === 0) status = 'VALID';
    else if (appearances > 0 || totals.events > 0) status = 'PARTIAL';

    // Season minutes quality (rollup):
    //   RELIABLE    — every record's minutes are reliable
    //   MIXED       — some records reliable, others estimated/unavailable
    //                 (per-90 uses only the reliable subset; counts reported)
    //   ESTIMATED   — no reliable minutes, but estimated values exist
    //   UNAVAILABLE — no usable minutes at all
    var quality;
    if (records.length > 0 && minutes.reliableMatches === records.length) quality = 'RELIABLE';
    else if (minutes.reliableMatches > 0) quality = 'MIXED';
    else if (minutes.estimatedMatches > 0) quality = 'ESTIMATED';
    else quality = 'UNAVAILABLE';

    return {
      playerId: pid,
      name: canonical || 'Unknown player',
      number: canonicalNumber || '',
      nameVariants: nameVariants,
      matchesSelected: matchesSelected,
      appearances: appearances,
      starts: starts,
      substituteAppearances: substituteAppearances,
      unusedSubstitutions: unusedSubstitutions,
      sentOffs: sentOffs,
      subOns: subOns,
      subOffs: subOffs,
      minutes: {
        reliableSeconds: minutes.reliableSeconds,
        estimatedSeconds: minutes.estimatedSeconds,
        reliableMinutes: roundHalfUp1(minutes.reliableSeconds / 60),
        estimatedMinutes: roundHalfUp1(minutes.estimatedSeconds / 60),
        reliableMatches: minutes.reliableMatches,
        estimatedMatches: minutes.estimatedMatches,
        unavailableMatches: minutes.unavailableMatches,
        quality: quality,
        reasonCodes: reasonRollup,
        basis: MINUTES_STANDARDS.basis
      },
      totals: totals,
      averagesPerAppearance: averages,
      per90: {
        basis: MINUTES_STANDARDS.per90Basis,
        matchesIncluded: per90MatchIndexes.length,
        matchesInRecord: records.length,
        minutes: minutes.reliableSeconds,
        metrics: per90Metrics
      },
      percentages: percentages,
      spatial: {
        zones: spatialZones,
        unlocatedZone: spatialUnlocatedZone,
        thirds: spatialThirds,
        channels: spatialChannels,
        located: spatialLocated,
        unlocated: spatialUnlocated,
        locatedShare: ratioEnv(spatialLocated, spatialLocated + spatialUnlocated)
      },
      periods: periods,
      gameState: stateSuppressedMatches === records.length && records.length > 0 ? null : gameState,
      gameStateSuppressedMatches: stateSuppressedMatches,
      dataQuality: { status: status, flags: flagList, unresolvedPlayerMatches: unresolvedMatches },
      matchRecordIndexes: matchRecordIndexes
    };
  }

  function buildTeamSeason(matchRecords) {
    var matches = matchRecords.length;

    var wins = 0, draws = 0, losses = 0, noResult = 0, flaggedResults = 0;
    var goalsFor = 0, goalsAgainst = 0;

    function zeroTeamCounts() {
      var c = {};
      TEAM_COUNT_KEYS.forEach(function (k) { c[k] = 0; });
      return c;
    }
    var totals = { our: zeroTeamCounts(), opponent: zeroTeamCounts(), unattributed: zeroTeamCounts() };

    var passSuccOur = [], passSuccOpp = [];
    var shotAccOur = [], shotAccOpp = [];
    var convOur = [], convOpp = [], chanceConvOur = [], chanceConvOpp = [];
    var pressRatioOur = [], pressRatioOpp = [];
    var possOur = 0, possOpp = 0, possOurInt = 0, possOppInt = 0;

    var spatialZones = { our: {}, opponent: {} };
    ZONE_KEYS.forEach(function (z) { spatialZones.our[z] = 0; spatialZones.opponent[z] = 0; });
    var spatialThirds = { our: {}, opponent: {} };
    var spatialChannels = { our: {}, opponent: {} };
    THIRDS.forEach(function (t) { spatialThirds.our[t] = 0; spatialThirds.opponent[t] = 0; });
    CHANNELS.forEach(function (c) { spatialChannels.our[c] = 0; spatialChannels.opponent[c] = 0; });
    var spatialLocated = { our: 0, opponent: 0 }, spatialUnlocated = { our: 0, opponent: 0 };

    var periods = {};
    PERIOD_BUCKETS.forEach(function (p) {
      periods[p] = { events: 0, goals: 0, shots: 0, passes: 0, presses: 0, turnovers: 0, recoveries: 0, chances: 0 };
    });
    var gameState = {};
    SCORE_STATES.forEach(function (s) {
      gameState[s] = { events: 0, goals: 0, shots: 0, passes: 0, presses: 0, turnovers: 0, recoveries: 0, chances: 0 };
    });
    var stateSuppressedMatches = 0;

    var flags = {};

    matchRecords.forEach(function (m) {
      var r = m.result;
      if (r.outcome === 'W') wins++;
      else if (r.outcome === 'D') draws++;
      else if (r.outcome === 'L') losses++;
      else noResult++;
      if (r.flagged) flaggedResults++;
      if (r.outcome !== null) { goalsFor += r.scoreFor; goalsAgainst += r.scoreAgainst; }

      TEAM_COUNT_KEYS.forEach(function (k) {
        totals.our[k] += (m.events.our[k] ? m.events.our[k].value : 0);
        totals.opponent[k] += (m.events.opponent[k] ? m.events.opponent[k].value : 0);
        totals.unattributed[k] += (m.events.unattributed[k] ? m.events.unattributed[k].value : 0);
      });

      passSuccOur.push(m.derived.our.passSuccess);
      passSuccOpp.push(m.derived.opponent.passSuccess);
      shotAccOur.push(m.derived.our.shotAccuracy);
      shotAccOpp.push(m.derived.opponent.shotAccuracy);
      convOur.push(m.derived.our.shotConversion);
      convOpp.push(m.derived.opponent.shotConversion);
      chanceConvOur.push(m.derived.our.chanceConversion);
      chanceConvOpp.push(m.derived.opponent.chanceConversion);
      pressRatioOur.push(m.derived.our.pressWinRatio);
      pressRatioOpp.push(m.derived.opponent.pressWinRatio);

      possOur += m.possession.ourSecondsExact || 0;
      possOpp += m.possession.opponentSecondsExact || 0;
      possOurInt += m.possession.ourIntervals || 0;
      possOppInt += m.possession.opponentIntervals || 0;

      ZONE_KEYS.forEach(function (z) {
        spatialZones.our[z] += m.spatial.our.zones[z] || 0;
        spatialZones.opponent[z] += m.spatial.opponent.zones[z] || 0;
      });
      THIRDS.forEach(function (t) {
        spatialThirds.our[t] += m.spatial.our.thirds[t] || 0;
        spatialThirds.opponent[t] += m.spatial.opponent.thirds[t] || 0;
      });
      CHANNELS.forEach(function (c) {
        spatialChannels.our[c] += m.spatial.our.channels[c] || 0;
        spatialChannels.opponent[c] += m.spatial.our.channels[c] || 0;
      });
      spatialLocated.our += m.spatial.our.located || 0;
      spatialLocated.opponent += m.spatial.opponent.located || 0;
      spatialUnlocated.our += m.spatial.our.unlocated || 0;
      spatialUnlocated.opponent += m.spatial.opponent.unlocated || 0;

      if (m.gameState) {
        SCORE_STATES.forEach(function (s) {
          var b = m.gameState[s];
          if (!b) return;
          gameState[s].events += b.events || 0;
          gameState[s].goals += b.goals || 0;
          gameState[s].shots += b.shots || 0;
          gameState[s].passes += b.passes || 0;
          gameState[s].presses += b.presses || 0;
          gameState[s].turnovers += b.turnovers || 0;
          gameState[s].recoveries += b.recoveries || 0;
          gameState[s].chances += b.chances || 0;
        });
      } else stateSuppressedMatches++;

      PERIOD_BUCKETS.forEach(function (p) {
        var b = m.periods[p] && m.periods[p].counts;
        if (!b) return;
        periods[p].events += b.events || 0;
        periods[p].goals += b.goals || 0;
        periods[p].shots += b.shots || 0;
        periods[p].passes += b.passes || 0;
        periods[p].presses += b.presses || 0;
        periods[p].turnovers += b.turnovers || 0;
        periods[p].recoveries += b.recoveries || 0;
        periods[p].chances += b.chances || 0;
      });

      m.dataQuality.flags.forEach(function (f) {
        flags[f] = (flags[f] || 0) + 1;
      });
    });

    // Tagged possession share, season-pooled (M-L2-B4 semantics, NC-1)
    var possReason = null;
    if (possOurInt === 0 && possOppInt === 0) possReason = 'NO_TAGGED_POSSESSION_INTERVALS';
    else if (possOurInt === 0) possReason = 'THIS_TEAM_INTERVALS_UNTAGGED';
    else if (possOppInt === 0) possReason = 'OPPONENT_INTERVALS_UNTAGGED';
    var possession = {
      name: 'Tagged Possession Share — season',
      basis: 'Recorded PitchLog Possession interval tags ONLY — not an official match possession statistic (NC-1); pooled from summed unrounded interval seconds across matches',
      ourSecondsExact: possOur,
      opponentSecondsExact: possOpp,
      ourIntervals: possOurInt,
      opponentIntervals: possOppInt,
      share: possReason === null
        ? ratioEnv(possOur, possOur + possOpp)
        : { value: null, num: possOur, den: possOur + possOpp, excluded: {}, reason: possReason }
    };

    function avgOf(map, key) {
      return matches > 0 ? roundHalfUp1(map[key] / matches) : null;
    }

    return {
      matches: matches,
      wins: wins,
      draws: draws,
      losses: losses,
      noResultMatches: noResult,
      resultFlaggedMatches: flaggedResults,
      goalsFor: goalsFor,
      goalsAgainst: goalsAgainst,
      totals: totals,
      percentages: {
        our: {
          passSuccess: sumEnvelopes(passSuccOur),
          shotAccuracy: sumEnvelopes(shotAccOur),
          shotConversion: sumEnvelopes(convOur),
          chanceConversion: sumEnvelopes(chanceConvOur),
          pressWinRatio: sumEnvelopes(pressRatioOur)
        },
        opponent: {
          passSuccess: sumEnvelopes(passSuccOpp),
          shotAccuracy: sumEnvelopes(shotAccOpp),
          shotConversion: sumEnvelopes(convOpp),
          chanceConversion: sumEnvelopes(chanceConvOpp),
          pressWinRatio: sumEnvelopes(pressRatioOpp)
        }
      },
      possession: possession,
      spatial: {
        located: spatialLocated,
        unlocated: spatialUnlocated,
        zones: spatialZones,
        thirds: spatialThirds,
        channels: spatialChannels,
        note: 'Located vs unlocated tagged events over the fixed 3×3 model (T2 orientation); not positional tracking'
      },
      periods: periods,
      gameState: stateSuppressedMatches === matches && matches > 0 ? null : gameState,
      gameStateSuppressedMatches: stateSuppressedMatches,
      averagesPerMatch: {
        our: {
          events: avgOf(totals.our, 'events'), goals: avgOf(totals.our, 'goals'),
          shots: avgOf(totals.our, 'shots'), chances: avgOf(totals.our, 'chances'),
          passes: avgOf(totals.our, 'passes'), presses: avgOf(totals.our, 'presses'),
          pressWins: avgOf(totals.our, 'pressWins'), turnovers: avgOf(totals.our, 'turnovers'),
          recoveries: avgOf(totals.our, 'recoveries'), duels: avgOf(totals.our, 'duels'),
          fouls: avgOf(totals.our, 'fouls')
        },
        opponent: {
          events: avgOf(totals.opponent, 'events'), goals: avgOf(totals.opponent, 'goals'),
          shots: avgOf(totals.opponent, 'shots'), chances: avgOf(totals.opponent, 'chances'),
          passes: avgOf(totals.opponent, 'passes'), presses: avgOf(totals.opponent, 'presses'),
          pressWins: avgOf(totals.opponent, 'pressWins'), turnovers: avgOf(totals.opponent, 'turnovers'),
          recoveries: avgOf(totals.opponent, 'recoveries'), duels: avgOf(totals.opponent, 'duels'),
          fouls: avgOf(totals.opponent, 'fouls')
        }
      },
      dataQuality: { flags: flags, matchesValid: matchRecords.filter(function (m) { return m.dataQuality.status === 'VALID'; }).length }
    };
  }

  // ---- Identity audit (PSD-X4 / PSD-X5) --------------------------------------

  function identityAudit(players, playerOrder) {
    var drift = [];
    var possibleDuplicates = {};

    playerOrder.forEach(function (pid) {
      var p = players[pid];
      if (p.nameVariants.length > 1) {
        drift.push({
          playerId: pid,
          variants: p.nameVariants
        });
      }
      p.nameVariants.forEach(function (v) {
        if (v.name === 'Unknown player') return;
        if (!possibleDuplicates[v.name]) possibleDuplicates[v.name] = [];
        if (possibleDuplicates[v.name].indexOf(pid) === -1) possibleDuplicates[v.name].push(pid);
      });
    });

    var duplicates = Object.keys(possibleDuplicates).filter(function (name) {
      return possibleDuplicates[name].length > 1;
    }).map(function (name) {
      return { name: name, playerIds: possibleDuplicates[name].sort() };
    });

    return { drift: drift, possibleDuplicates: duplicates };
  }

  // ---- Orchestration ---------------------------------------------------------

  function computeSeason(sessions) {
    if (typeof AnalyticsEngine !== 'object' || AnalyticsEngine === null ||
        typeof AnalyticsEngine.computeMatchAnalytics !== 'function') {
      throw new Error('PlayerSeasonEngine requires the Analytics Engine (src/analytics.js) to be loaded first.');
    }

    var arr = Array.isArray(sessions) ? sessions : [];

    // 1. parse + identity
    var parsed = arr.map(parseSession);
    var dedupe = dedupeSessions(parsed);
    var unique = dedupe.kept.slice().sort(compareSessions);
    var identityWarnings = auditIdentity(unique);

    // 2. per-match records
    var matches = [];               // team match records
    var playerMatchRecords = [];    // flat player×match records
    var gates = {
      PSD_X1_duplicates: dedupe.duplicates.concat(identityWarnings.sameSavedAt.map(function (w) {
        return { type: 'SAVED_AT', matchKeys: w.matchKeys, savedAt: w.savedAt };
      })).concat(identityWarnings.sameLabel.map(function (w) {
        return { type: 'LABEL', matchKeys: w.matchKeys, label: w.label };
      })),
      PSD_X2_startingXI: [],
      PSD_X3_ftMarker: [],
      PSD_X7_x1Mismatch: [],
      PSD_X8_emptyMetadata: []
    };
    var subNoise = [];

    unique.forEach(function (session, matchIndex) {
      var A;
      try {
        A = AnalyticsEngine.computeMatchAnalytics({
          events: session.events,
          matchInfo: session.matchInfo,
          matchClock: session.matchClock,
          squad: session.squad,
          tags: session.tags
        });
      } catch (err) {
        throw new Error('Season engine: analytics failed for session loadIndex=' + session.loadIndex +
          ' (' + session.label + '): ' + (err && err.message ? err.message : String(err)));
      }

      var markers = collectMarkers(session.events);

      // spatial records = ALL validated records (located + unlocated)
      var spatialRecords = [];
      if (A.spatial) {
        spatialRecords = (A.spatial.locatedEvents || []).concat(A.spatial.unlocatedEvents || []);
      }

      var startingXI = [];
      if (Array.isArray(session.matchInfo.startingXI)) {
        session.matchInfo.startingXI.forEach(function (slot) {
          if (isPlainObject(slot) && typeof slot.playerId === 'string' && slot.playerId) {
            startingXI.push(slot.playerId);
          }
        });
      }
      var xiSlots = Array.isArray(session.matchInfo.startingXI) ? session.matchInfo.startingXI.length : 0;
      var xiFilled = startingXI.length;
      var xiPresent = xiSlots > 0;

      var result = matchResult(A);
      var x1Status = result.x1Status;
      var ftEnd = ftEndSeconds(session.matchClock);
      var fallbackEnd = fallbackEndSeconds(spatialRecords, session.matchClock);

      var partitions = playerPartitions(spatialRecords);
      var stateSuppressed = x1Status === 'MISMATCH';

      // appearance counts for the team record
      var appearanceCounts = { starters: xiFilled, subOns: 0, unusedSubs: 0, unknown: 0 };
      var squadIds = {};
      session.squad.forEach(function (p) {
        if (isPlainObject(p) && typeof p.id === 'string' && p.id) squadIds[p.id] = true;
      });
      Object.keys(markers.subOn).forEach(function (pid) { appearanceCounts.subOns += markers.subOn[pid].length; });
      Object.keys(squadIds).forEach(function (pid) {
        if (startingXI.indexOf(pid) === -1 && !markers.subOn[pid] && xiPresent) appearanceCounts.unusedSubs++;
      });
      if (!xiPresent) appearanceCounts.unusedSubs = null; // not provable without an XI

      var ctx = {
        session: session, A: A, markers: markers,
        startingXI: startingXI, xiSlots: xiSlots, xiFilled: xiFilled, xiPresent: xiPresent,
        result: result, x1Status: x1Status, ftEnd: ftEnd, fallbackEnd: fallbackEnd,
        partitions: partitions, stateSuppressed: stateSuppressed,
        matchIndex: matchIndex, appearanceCounts: appearanceCounts
      };

      matches.push(buildTeamMatchRecord(ctx));
      var recs = buildPlayerMatchRecords(ctx);
      recs.forEach(function (r) { playerMatchRecords.push(r); });

      // gates
      if (!xiPresent || (xiSlots > 0 && xiFilled < xiSlots)) {
        gates.PSD_X2_startingXI.push({ matchIndex: matchIndex, slots: xiSlots, filled: xiFilled, present: xiPresent });
      }
      if (ftEnd === null) gates.PSD_X3_ftMarker.push({ matchIndex: matchIndex, label: session.label });
      if (x1Status === 'MISMATCH') gates.PSD_X7_x1Mismatch.push({ matchIndex: matchIndex, label: session.label });
      var missingMeta = [];
      if (!str(session.matchInfo.date)) missingMeta.push('date');
      if (!str(session.matchInfo.opponent)) missingMeta.push('opponent');
      if (missingMeta.length) gates.PSD_X8_emptyMetadata.push({ matchIndex: matchIndex, missing: missingMeta });

      var noisePids = Object.keys(markers.opponentSubRefs);
      if (noisePids.length > 0 || Object.keys(markers.untimedMarkers).length > 0 || Object.keys(markers.multipleSubOn).length > 0) {
        subNoise.push({
          matchIndex: matchIndex,
          opponentSubRefs: noisePids.map(function (pid) { return { playerId: pid, count: markers.opponentSubRefs[pid] }; }),
          untimedMarkers: Object.keys(markers.untimedMarkers).map(function (pid) { return { playerId: pid, count: markers.untimedMarkers[pid] }; }),
          multipleSubOn: Object.keys(markers.multipleSubOn).map(function (pid) { return { playerId: pid, count: markers.multipleSubOn[pid] }; })
        });
      }
    });

    gates.PSD_X6_subAttributionNoise = subNoise;

    // 3. player season aggregation (records grouped by playerId; each group's
    // records are already in season order because matches are)
    var byPlayer = {};
    var playerOrder = [];
    playerMatchRecords.forEach(function (rec) {
      if (!byPlayer[rec.playerId]) { byPlayer[rec.playerId] = []; playerOrder.push(rec.playerId); }
      byPlayer[rec.playerId].push(rec);
    });
    var players = {};
    playerOrder.forEach(function (pid) {
      players[pid] = buildPlayerSeason(byPlayer[pid], matches);
    });

    // deterministic player order: appearances desc, totals.events desc, playerId asc
    playerOrder.sort(function (a, b) {
      if (players[a].appearances !== players[b].appearances) return players[b].appearances - players[a].appearances;
      if (players[a].totals.events !== players[b].totals.events) return players[b].totals.events - players[a].totals.events;
      return a < b ? -1 : (a > b ? 1 : 0);
    });

    // 4. team season
    var teamSeason = buildTeamSeason(matches);

    // 5. identity audit
    var audit = identityAudit(players, playerOrder);

    // 6. coverage
    var completeMatches = matches.filter(function (m) {
      return m.dataQuality.status === 'VALID';
    }).length;
    var minutesReliable = playerMatchRecords.filter(function (r) { return r.minutes.quality === 'RELIABLE'; }).length;
    var minutesEstimated = playerMatchRecords.filter(function (r) { return r.minutes.quality === 'ESTIMATED'; }).length;
    var minutesUnavailable = playerMatchRecords.filter(function (r) { return r.minutes.quality === 'UNAVAILABLE'; }).length;

    var coverage = {
      sessionsLoaded: arr.length,
      uniqueMatches: matches.length,
      duplicateSessionsExcluded: dedupe.duplicates.length,
      completeMatchRecords: completeMatches,
      partialMatchRecords: matches.length - completeMatches,
      players: playerOrder.length,
      playerMatchRecords: playerMatchRecords.length,
      minutesReliableRecords: minutesReliable,
      minutesEstimatedRecords: minutesEstimated,
      minutesUnavailableRecords: minutesUnavailable,
      gameStateSuppressedMatches: teamSeason.gameStateSuppressedMatches
    };

    return {
      spec: SPEC,
      engine: { version: VERSION, deterministic: true, analyticsEngineVersion: AnalyticsEngine.VERSION || null },
      input: {
        sessionCount: arr.length,
        duplicateSessions: dedupe.duplicates,
        identityWarnings: identityWarnings,
        sessions: unique.map(function (s, i) {
          return {
            matchIndex: i,
            loadIndex: s.loadIndex,
            sourceFile: s.sourceFile,
            savedAt: s.savedAt,
            label: s.label,
            eventCount: s.events.length,
            result: matches[i].result.outcome,
            x1Status: matches[i].result.x1Status
          };
        })
      },
      coverage: coverage,
      matches: matches,               // TEAM MATCH DATASET (one per match)
      playerMatchRecords: playerMatchRecords,  // PLAYER MATCH DATASET (one per player×match)
      players: players,               // PLAYER SEASON DATASET (keyed by playerId)
      playerOrder: playerOrder,
      teamSeason: teamSeason,         // TEAM SEASON DATASET (one record)
      identityAudit: audit,
      gates: gates,
      protocol: {
        notes: PROTOCOL_NOTES,
        params: {},
        minutesStandards: MINUTES_STANDARDS
      }
    };
  }

  return {
    computeSeason: computeSeason,
    VERSION: VERSION,
    SPEC: SPEC
  };
});
