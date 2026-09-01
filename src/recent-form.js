// PitchLog — RECENT FORM & DESCRIPTIVE TRENDS ENGINE V1 (pure calculation)
// File: src/recent-form.js
// Spec: docs/recent-form-trends-specification.md
//       (PitchLog-RECENT-FORM-SPEC-v1.0-reestablished — NEW AUTHORITATIVE DOCUMENT)
//
// ARCHITECTURE (spec §24):
//   MATCH SESSIONS → ANALYTICS ENGINE V1 (unchanged)
//   → PLAYER & SEASON CORE (player-season.js — computeSeason)
//   → RECENT FORM (this module — computeRecentForm(PS, options))
//   → UI (Phase C; NOT in this file)
//
// Principles:
//   - CONSUME PS OUTPUT ONLY: every figure derives from PS.playerMatchRecords,
//     PS.matches, PS.players, PS.teamSeason; raw events are never reread; no
//     second counting methodology exists in this layer (test-asserted).
//   - UNITS: player window = ACTUAL APPEARANCE (starter or substitute who
//     entered); team window = COMPLETED MATCH (PS dataQuality.status VALID).
//   - ORDERING: windows slice the PS deterministic season order
//     (date → savedAt → sourceFile → loadIndex); no second ordering mechanism.
//   - POOLED PERCENTAGES: numerators and denominators sum first; match
//     percentages are never averaged (4/5 + 10/20 = 14/25 = 56%).
//   - PER-90: RELIABLE minutes only; the numerator is restricted to the SAME
//     reliable-minute appearances as the denominator; null at zero reliable
//     minutes; disclosure triple on every per-90 block.
//   - DUAL BASELINES: A = full season consumed from the PS season record;
//     B = season excluding the selected window (same methodology);
//     window + B reconciles to the full season for additive metrics;
//     B is suppressed (WHOLE_SEASON_IN_WINDOW), never fabricated.
//   - TOLERANCE: counts/rates max(1, 0.1 × baseline); percentages fixed 5.0
//     percentage points; boundary INCLUSIVE; classifications
//     HIGHER / LOWER / WITHIN-TOLERANCE / INCONCLUSIVE describe numbers,
//     never players.
//   - NEUTRAL LANGUAGE ONLY (spec §25); no AI, no ratings, no prediction.
//   - DETERMINISTIC + PURE: no Date.now, no Math.random, no I/O, no DOM; the
//     PS input is never mutated; outputs share no mutable references with the
//     input (envelope primitives are copied, never the envelope objects).
//
// UMD: window.RecentFormEngine in the renderer (loaded AFTER player-season.js,
// BEFORE renderer.js), module.exports in Node (tests).

/* global self */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.RecentFormEngine = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SPEC = 'PitchLog-RECENT-FORM-SPEC-v1.0-reestablished';
  var VERSION = '1.0.0';

  // ---- Fixed vocabularies (mirror src/player-season.js; source is authority)

  // Player tagged-count family (PS COUNT_KEYS minus the subOn/subOff
  // participation markers, which are carried by the participation block).
  var RF_COUNT_KEYS = [
    'events', 'goals', 'shots', 'shotsOnTarget', 'chances', 'keyPasses',
    'crosses', 'passes', 'successfulPasses', 'unsuccessfulPasses',
    'passesUnknownOutcome', 'presses', 'pressWins', 'interceptions',
    'recoveries', 'turnovers', 'duels', 'fouls', 'yellowCards', 'redCards',
    'positiveEvents', 'negativeEvents', 'neutralEvents',
    'transitionsPositive', 'transitionsNegative'
  ];

  // Per-90 metric family (PS PER90_KEYS).
  var RF_PER90_KEYS = [
    'events', 'goals', 'shots', 'shotsOnTarget', 'chances', 'keyPasses',
    'crosses', 'passes', 'presses', 'pressWins', 'interceptions',
    'recoveries', 'turnovers', 'duels', 'fouls',
    'transitionsPositive', 'transitionsNegative'
  ];

  // Team tagged-count family (PS TEAM_COUNT_KEYS; match records carry these
  // as count envelopes {value, excluded} — summed via .value).
  var RF_TEAM_KEYS = [
    'events', 'goals', 'shots', 'shotsOnTarget', 'shotsOffTarget',
    'shotsBlocked', 'shotsUnknownOutcome', 'chances', 'crosses', 'corners', 'fouls',
    'yellowCards', 'redCards', 'substitutions', 'passes', 'successfulPasses',
    'unsuccessfulPasses', 'passesUnknownOutcome', 'progressivePasses', 'lateralPasses',
    'backwardPasses', 'longPasses', 'passesUnderPressure', 'presses', 'pressWins',
    'interceptions', 'recoveries', 'turnovers', 'duels', 'positiveTransitions', 'negativeTransitions'
  ];

  // Team percentage families (PS derived envelopes, our + opponent).
  var RF_TEAM_PCT_KEYS = ['passSuccess', 'shotAccuracy', 'shotConversion', 'chanceConversion', 'pressWinRatio'];

  var THIRDS = ['Defensive third', 'Middle third', 'Attacking third'];
  var CHANNELS = ['Left channel', 'Central channel', 'Right channel'];
  var ZONE_KEYS = (function () {
    var out = [];
    THIRDS.forEach(function (t) {
      CHANNELS.forEach(function (c) { out.push(t + ' · ' + c); });
    });
    return out;
  })();

  var PERIOD_BUCKETS = ['1H', '2H', 'ET1', 'ET2', 'Non-play', 'Unknown'];
  var SCORE_STATES = ['WINNING', 'DRAW', 'LOSING'];

  // Per-player partition metric family (PS PARTITION_KEYS).
  var PARTITION_KEYS = [
    'events', 'goals', 'shots', 'shotsOnTarget', 'chances', 'keyPasses',
    'crosses', 'passes', 'presses', 'pressWins', 'interceptions',
    'recoveries', 'turnovers', 'duels', 'fouls', 'yellowCards', 'redCards',
    'transitionsPositive', 'transitionsNegative'
  ];

  var PLAYER_PCT_KEYS = ['passSuccess', 'pressWinRatio', 'locatedShare'];

  var STANDING_NOTE = 'Observational split by tagged participation only — small samples, no causal claim; the team record with/without a player is not a player-value measurement.';

  var PROTOCOL_NOTES = [
    'RECENT_FORM_ENGINE_REUSE: all figures derive from Player & Season Core output (PS records); raw events are never reread; no second counting methodology exists in this layer',
    'WINDOW_UNITS: player windows count ACTUAL APPEARANCES (starter or substitute who entered); team windows count COMPLETED MATCHES (PS dataQuality.status VALID); incomplete or no-result matches are excluded with reasons',
    'WINDOW_ORDER: windows slice the PS deterministic season order (date, savedAt, sourceFile, loadIndex); true sample sizes are always reported; windows are never padded',
    'POOLED_PERCENTAGES: ratios sum numerator and denominator across records first; match percentages are never averaged (4/5 + 10/20 pools to 14/25 = 56%)',
    'PER90: reliable minutes only; the numerator is restricted to the same reliable-minute appearances as the denominator; every per-90 block discloses window appearances, per-90-included appearances and reliable minutes; null when reliable minutes are zero',
    'DUAL_BASELINES: Baseline A is the full season consumed from the PS season record; Baseline B is the season excluding the selected window, computed with the same methodology; window + Baseline B reconciles to the full season for additive metrics; Baseline B is suppressed (WHOLE_SEASON_IN_WINDOW) when the window covers the whole season',
    'TOLERANCE: count and rate comparisons use max(1, 0.1 × baseline); percentage comparisons use a fixed 5.0 percentage points; the boundary is INCLUSIVE; classifications are HIGHER / LOWER / WITHIN-TOLERANCE / INCONCLUSIVE and describe numbers, never players',
    'WITH_WITHOUT: observational split by tagged participation only; unused substitutes are NOT in the WITH group; comparisons require at least 3 valid matches in BOTH groups and use per-match averages; no causal claims',
    'OBSERVED_VARIABILITY: minimum, maximum, range, mean and median only; no standard deviation, variance, coefficient of variation or composite index',
    'IDENTITY: playerId is the stable identity; duplicate handling reuses the Player & Season deduplication; name drift and possible duplicate persons are flagged, never merged',
    'PURITY: deterministic; no I/O, no clocks, no randomness; the PS input is never mutated'
  ];

  // ---- Small deterministic helpers (mirroring player-season.js semantics) --

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
  function ratioEnv(num, den, excluded) {
    return { value: pct1(num, den), num: num, den: den, excluded: excluded || {} };
  }
  function sumEnvelopes(list) {
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

  function zeroCounts(keys) {
    var c = {};
    keys.forEach(function (k) { c[k] = 0; });
    return c;
  }

  // ---- Comparison engine (spec §9–§11) --------------------------------------

  // rule: 'COUNT' (max(1, 0.1 × baseline)) or 'PCT' (fixed 5.0 pp).
  // ctx: { emptyWindow, baselineSuppressed, suppressionReason, per90Recent,
  //        isPer90, isPct }
  function compareValues(recentValue, baselineValue, recentSample, baselineSample, rule, ctx) {
    var c = ctx || {};
    var reason = null;

    // A suppressed Baseline B is never fabricated: the value is null.
    if (c.baselineSuppressed) baselineValue = null;

    if (c.emptyWindow) reason = 'EMPTY_WINDOW';
    else if (c.baselineSuppressed) reason = c.suppressionReason || 'WHOLE_SEASON_IN_WINDOW';
    else if (c.isPer90 && (recentValue === null || recentValue === undefined)) reason = 'NO_RELIABLE_MINUTES';
    else if (recentValue === null || recentValue === undefined) reason = 'NULL_RECENT_VALUE';
    else if (baselineValue === null || baselineValue === undefined) reason = 'NULL_BASELINE_VALUE';

    var bothNumbers = isFinNum(recentValue) && isFinNum(baselineValue) && reason === null;
    var absoluteDifference = bothNumbers ? roundHalfUp1(recentValue - baselineValue) : null;
    var percentageDifference = (bothNumbers && baselineValue !== 0)
      ? roundHalfUp1(((recentValue - baselineValue) / baselineValue) * 100)
      : null;

    var tolerance;
    if (rule === 'PCT') {
      tolerance = 5;
    } else {
      tolerance = isFinNum(baselineValue) ? Math.max(1, roundHalfUp1(0.1 * baselineValue)) : null;
    }
    var toleranceRule = rule === 'PCT' ? 'FIXED_5PP' : 'MAX_1_OR_10PCT_BASELINE';

    var classification = 'INCONCLUSIVE';
    if (reason === null && bothNumbers && isFinNum(tolerance)) {
      if (Math.abs(absoluteDifference) <= tolerance) classification = 'WITHIN-TOLERANCE';
      else classification = absoluteDifference > 0 ? 'HIGHER' : 'LOWER';
    }

    var out = {
      recentValue: bothNumbers || recentValue === undefined ? (recentValue === undefined ? null : recentValue) : recentValue,
      baselineValue: baselineValue === undefined ? null : baselineValue,
      absoluteDifference: absoluteDifference,
      percentageDifference: percentageDifference,
      recentSample: recentSample,
      baselineSample: baselineSample,
      tolerance: tolerance,
      toleranceRule: toleranceRule,
      boundary: 'INCLUSIVE',
      classification: classification,
      reason: reason
    };
    return out;
  }

  // Percentage comparison with envelope num/den preservation.
  function compareEnvelopes(recentEnv, baselineEnv, recentSample, baselineSample, ctx) {
    var rEnv = recentEnv || { value: null, num: 0, den: 0 };
    var bEnv = baselineEnv || { value: null, num: 0, den: 0 };
    var c = compareValues(rEnv.value, bEnv.value, recentSample, baselineSample, 'PCT', ctx);
    c.recentNum = rEnv.num;
    c.recentDen = rEnv.den;
    c.baselineNum = bEnv.num;
    c.baselineDen = bEnv.den;
    return c;
  }

  // ---- Player record stats (shared by windows, R5P5 blocks, Baseline B) ----

  function sumTotals(recs) {
    var totals = zeroCounts(RF_COUNT_KEYS);
    recs.forEach(function (r) {
      var m = r.metrics || {};
      RF_COUNT_KEYS.forEach(function (k) { totals[k] += (m[k] || 0); });
    });
    return totals;
  }

  function averagesOver(recs, totals) {
    var out = {};
    var n = recs.length;
    RF_COUNT_KEYS.forEach(function (k) {
      out[k] = n > 0 ? roundHalfUp1(totals[k] / n) : null;
    });
    return out;
  }

  function poolPlayerPercentages(recs) {
    // passSuccess: mirror the PS season rule — only records with passes > 0
    // contribute ratioEnv(successful, successful + unsuccessful).
    var passEnvs = [];
    var pressWins = 0, presses = 0, located = 0, unlocated = 0;
    recs.forEach(function (r) {
      var m = r.metrics || {};
      if ((m.passes || 0) > 0) {
        passEnvs.push(ratioEnv(
          m.successfulPasses || 0,
          (m.successfulPasses || 0) + (m.unsuccessfulPasses || 0),
          { unknownOutcome: m.passesUnknownOutcome || 0 }
        ));
      }
      pressWins += m.pressWins || 0;
      presses += m.presses || 0;
      var sp = r.spatial || {};
      located += sp.located || 0;
      unlocated += sp.unlocated || 0;
    });
    return {
      passSuccess: sumEnvelopes(passEnvs),
      pressWinRatio: ratioEnv(pressWins, presses),
      locatedShare: ratioEnv(located, located + unlocated)
    };
  }

  function per90Block(recs, per90Basis) {
    var reliable = [];
    var reliableSeconds = 0;
    var nEstimated = 0;
    recs.forEach(function (r) {
      var mi = r.minutes || {};
      if (mi.quality === 'RELIABLE') {
        reliable.push(r);
        reliableSeconds += (mi.secondsExact || 0);
      } else if (mi.quality === 'ESTIMATED') {
        nEstimated++;
      }
    });
    var metrics = {};
    RF_PER90_KEYS.forEach(function (k) {
      var total = 0;
      reliable.forEach(function (r) { total += ((r.metrics || {})[k] || 0); });
      metrics[k] = {
        value: reliableSeconds > 0 ? roundHalfUp1(total * 5400 / reliableSeconds) : null,
        total: total
      };
    });
    var minutesQuality = 'UNAVAILABLE';
    if (recs.length > 0) {
      if (reliable.length === recs.length) minutesQuality = 'RELIABLE';
      else if (reliable.length > 0) minutesQuality = 'MIXED';
      else if (nEstimated > 0) minutesQuality = 'ESTIMATED';
    }
    return {
      basis: per90Basis,
      appearancesInWindow: recs.length,
      appearancesIncludedInPer90: reliable.length,
      reliableSeconds: reliableSeconds,
      minutesQuality: minutesQuality,
      metrics: metrics
    };
  }

  function sumPlayerPeriods(recs) {
    var periods = {};
    PERIOD_BUCKETS.forEach(function (p) { periods[p] = zeroCounts(PARTITION_KEYS); });
    recs.forEach(function (r) {
      var src = r.periods || {};
      PERIOD_BUCKETS.forEach(function (p) {
        var part = src[p];
        if (!part) return;
        PARTITION_KEYS.forEach(function (k) { periods[p][k] += (part[k] || 0); });
      });
    });
    return periods;
  }

  function sumPlayerGameState(recs) {
    var block = {};
    SCORE_STATES.forEach(function (s) { block[s] = zeroCounts(PARTITION_KEYS); });
    var suppressed = 0;
    recs.forEach(function (r) {
      if (r.gameState) {
        SCORE_STATES.forEach(function (s) {
          var src = r.gameState[s] || {};
          PARTITION_KEYS.forEach(function (k) { block[s][k] += (src[k] || 0); });
        });
      } else {
        suppressed++;
      }
    });
    return {
      block: (recs.length > 0 && suppressed === recs.length) ? null : block,
      suppressed: suppressed
    };
  }

  function sumPlayerSpatial(recs) {
    var zones = zeroCounts(ZONE_KEYS);
    var thirds = zeroCounts(THIRDS);
    var channels = zeroCounts(CHANNELS);
    var located = 0, unlocated = 0, unlocatedZone = 0;
    recs.forEach(function (r) {
      var sp = r.spatial || {};
      ZONE_KEYS.forEach(function (z) { zones[z] += (sp.zones && sp.zones[z]) || 0; });
      THIRDS.forEach(function (t) { thirds[t] += (sp.thirds && sp.thirds[t]) || 0; });
      CHANNELS.forEach(function (c) { channels[c] += (sp.channels && sp.channels[c]) || 0; });
      located += sp.located || 0;
      unlocated += sp.unlocated || 0;
      unlocatedZone += sp.unlocatedZone || 0;
    });
    return {
      zones: zones,
      unlocatedZone: unlocatedZone,
      thirds: thirds,
      channels: channels,
      located: located,
      unlocated: unlocated,
      locatedShare: ratioEnv(located, located + unlocated)
    };
  }

  function recordSetQuality(recs) {
    var flagsMap = {};
    recs.forEach(function (r) {
      var dq = r.dataQuality || {};
      (dq.flags || []).forEach(function (f) { flagsMap[f] = true; });
    });
    var status = 'INSUFFICIENT';
    if (recs.length > 0) {
      status = recs.every(function (r) { return (r.dataQuality || {}).status === 'VALID'; }) ? 'VALID' : 'PARTIAL';
    }
    return { status: status, flags: Object.keys(flagsMap).sort() };
  }

  // ---- Player window (spec §30 PlayerWindow) ---------------------------------

  function buildPlayerWindow(records, appearances, N, per90Basis) {
    var included = appearances.slice(-N);
    var scanFrom = included.length ? records.indexOf(included[0]) : 0;
    var excludedRecords = [];
    for (var i = scanFrom; i < records.length; i++) {
      var r = records[i];
      if (!(r.participation || {}).appearance) {
        excludedRecords.push({ matchIndex: r.matchIndex, reason: (r.participation || {}).status || 'NOT_INVOLVED' });
      }
    }

    var totals = sumTotals(included);
    var periods = sumPlayerPeriods(included);
    var gs = sumPlayerGameState(included);

    return {
      requested: N,
      available: appearances.length,
      included: included.length,
      matchIndexes: included.map(function (r) { return r.matchIndex; }),
      excludedRecords: excludedRecords,
      totals: totals,
      averagesPerAppearance: averagesOver(included, totals),
      percentages: poolPlayerPercentages(included),
      per90: per90Block(included, per90Basis),
      periods: periods,
      gameState: gs.block,
      gameStateSuppressedMatches: gs.suppressed,
      spatial: sumPlayerSpatial(included),
      dataQuality: recordSetQuality(included)
    };
  }

  // ---- Baseline value packs ---------------------------------------------------

  function playerBaselineA(psPlayer) {
    var p = psPlayer || {};
    var totals = p.totals || {};
    var pct = p.percentages || {};
    var per90Metrics = (p.per90 || {}).metrics || {};
    var per90 = {};
    RF_PER90_KEYS.forEach(function (k) {
      var src = per90Metrics[k] || {};
      per90[k] = isFinNum(src.value) ? src.value : null;
    });
    var sample = Array.isArray(p.matchRecordIndexes) ? p.matchRecordIndexes.length : 0;
    return {
      counts: function (k) { return isFinNum(totals[k]) ? totals[k] : 0; },
      pct: pct,
      per90: per90,
      per90Sample: (p.per90 || {}).matchesIncluded || 0,
      sample: sample,
      suppressed: false,
      suppressionReason: null
    };
  }

  function playerBaselineB(records, windowMatchIndexes) {
    var winSet = {};
    windowMatchIndexes.forEach(function (i) { winSet[i] = true; });
    var bRecs = records.filter(function (r) { return !winSet[r.matchIndex]; });
    var available = bRecs.length > 0;
    var reason = null;
    if (!available) {
      reason = (records.length === 0) ? 'NO_DATA' : 'WHOLE_SEASON_IN_WINDOW';
    }
    var totals = sumTotals(bRecs);
    var pct = poolPlayerPercentages(bRecs);
    var p90 = per90Block(bRecs, null);
    var per90 = {};
    RF_PER90_KEYS.forEach(function (k) { per90[k] = p90.metrics[k].value; });
    return {
      counts: function (k) { return totals[k]; },
      pct: pct,
      per90: per90,
      per90Sample: p90.appearancesIncludedInPer90,
      sample: bRecs.length,
      suppressed: !available,
      suppressionReason: reason
    };
  }

  function playerComparisonSet(win, baseline) {
    var empty = win.included === 0;
    var counts = {};
    RF_COUNT_KEYS.forEach(function (k) {
      counts[k] = compareValues(win.totals[k], baseline.counts(k), win.included, baseline.sample, 'COUNT',
        { emptyWindow: empty, baselineSuppressed: baseline.suppressed, suppressionReason: baseline.suppressionReason });
    });
    var percentages = {};
    PLAYER_PCT_KEYS.forEach(function (k) {
      percentages[k] = compareEnvelopes(win.percentages[k], baseline.pct[k], win.included, baseline.sample,
        { emptyWindow: empty, baselineSuppressed: baseline.suppressed, suppressionReason: baseline.suppressionReason });
    });
    var per90 = {};
    RF_PER90_KEYS.forEach(function (k) {
      per90[k] = compareValues(win.per90.metrics[k].value, baseline.per90[k], win.per90.appearancesIncludedInPer90, baseline.per90Sample, 'COUNT',
        { emptyWindow: empty, baselineSuppressed: baseline.suppressed, suppressionReason: baseline.suppressionReason, isPer90: true });
    });
    return { counts: counts, percentages: percentages, per90: per90 };
  }

  // ---- Variability (spec §12: min/max/range/mean/median ONLY) ------------------

  function buildVariability(recs) {
    var out = {};
    RF_COUNT_KEYS.forEach(function (k) {
      if (recs.length === 0) {
        out[k] = { min: null, max: null, range: null, mean: null, median: null, matches: 0 };
        return;
      }
      var series = recs.map(function (r) { return (r.metrics || {})[k] || 0; });
      var sorted = series.slice().sort(function (a, b) { return a - b; });
      var n = sorted.length;
      var min = sorted[0];
      var max = sorted[n - 1];
      var sum = 0;
      series.forEach(function (v) { sum += v; });
      var median = (n % 2 === 1)
        ? sorted[(n - 1) / 2]
        : roundHalfUp1((sorted[n / 2 - 1] + sorted[n / 2]) / 2);
      out[k] = {
        min: min,
        max: max,
        range: max - min,
        mean: roundHalfUp1(sum / n),
        median: median,
        matches: n
      };
    });
    return out;
  }

  // ---- Recent 5 vs Previous 5 (spec §11) --------------------------------------

  function miniBlock(recs, per90Basis) {
    var totals = sumTotals(recs);
    return {
      included: recs.length,
      matchIndexes: recs.map(function (r) { return r.matchIndex; }),
      totals: totals,
      averagesPerAppearance: averagesOver(recs, totals),
      percentages: poolPlayerPercentages(recs),
      per90: per90Block(recs, per90Basis)
    };
  }

  function buildR5P5(appearances, per90Basis) {
    var total = appearances.length;
    var eligible = total >= 10;
    var recent5 = total > 0 ? miniBlock(appearances.slice(-5), per90Basis) : null;
    var previous5 = eligible ? miniBlock(appearances.slice(-10, -5), per90Basis) : null;
    var comparisons = null;
    if (eligible) {
      var counts = {};
      RF_COUNT_KEYS.forEach(function (k) {
        counts[k] = compareValues(recent5.totals[k], previous5.totals[k], recent5.included, previous5.included, 'COUNT', {});
      });
      var percentages = {};
      PLAYER_PCT_KEYS.forEach(function (k) {
        percentages[k] = compareEnvelopes(recent5.percentages[k], previous5.percentages[k], recent5.included, previous5.included, {});
      });
      var per90 = {};
      RF_PER90_KEYS.forEach(function (k) {
        per90[k] = compareValues(recent5.per90.metrics[k].value, previous5.per90.metrics[k].value,
          recent5.per90.appearancesIncludedInPer90, previous5.per90.appearancesIncludedInPer90, 'COUNT', { isPer90: true });
      });
      comparisons = { counts: counts, percentages: percentages, per90: per90 };
    }
    return {
      eligibility: eligible ? 'COMPARISON' : 'INCONCLUSIVE',
      appearancesTotal: total,
      recent5: recent5,
      previous5: previous5,
      comparisons: comparisons,
      reason: eligible ? null : 'INSUFFICIENT_APPEARANCES'
    };
  }

  // ---- With / without player (spec §13: observational) -------------------------

  function wwCompare(withTotal, withMatches, withoutTotal, withoutMatches) {
    var withValue = roundHalfUp1(withTotal / withMatches);
    var withoutValue = roundHalfUp1(withoutTotal / withoutMatches);
    var difference = roundHalfUp1(withValue - withoutValue);
    var tolerance = Math.max(1, roundHalfUp1(0.1 * withoutValue));
    var classification;
    if (Math.abs(difference) <= tolerance) classification = 'WITHIN-TOLERANCE';
    else classification = difference > 0 ? 'HIGHER' : 'LOWER';
    return {
      withValue: withValue,
      withoutValue: withoutValue,
      difference: difference,
      tolerance: tolerance,
      classification: classification
    };
  }

  function emptyWwGroup() {
    return {
      matches: 0, wins: 0, draws: 0, losses: 0,
      goalsFor: 0, goalsAgainst: 0,
      totals: zeroCounts(RF_TEAM_KEYS)
    };
  }

  function buildWithWithout(recByMatch, completed) {
    var withG = emptyWwGroup();
    var withoutG = emptyWwGroup();
    var unresolved = 0;

    completed.forEach(function (m) {
      var rec = recByMatch[m.matchIndex];
      var part = (rec || {}).participation;
      var group;
      if (part && part.appearance) {
        group = withG;
      } else if (part && part.status === 'UNKNOWN') {
        unresolved++;
        return;
      } else {
        group = withoutG;
      }
      group.matches++;
      var o = (m.result || {}).outcome;
      if (o === 'W') group.wins++;
      else if (o === 'D') group.draws++;
      else if (o === 'L') group.losses++;
      group.goalsFor += (m.result || {}).scoreFor || 0;
      group.goalsAgainst += (m.result || {}).scoreAgainst || 0;
      var our = (m.events || {}).our || {};
      RF_TEAM_KEYS.forEach(function (k) {
        group.totals[k] += (our[k] && isFinNum(our[k].value)) ? our[k].value : 0;
      });
    });

    var status;
    if (withG.matches >= 3 && withoutG.matches >= 3) status = 'COMPARISON';
    else if (withG.matches + withoutG.matches > 0) status = 'INSUFFICIENT_SAMPLE';
    else status = 'UNRESOLVED';

    var comparisons = null;
    if (status === 'COMPARISON') {
      comparisons = {};
      comparisons.goalsFor = wwCompare(withG.goalsFor, withG.matches, withoutG.goalsFor, withoutG.matches);
      comparisons.goalsAgainst = wwCompare(withG.goalsAgainst, withG.matches, withoutG.goalsAgainst, withoutG.matches);
      RF_TEAM_KEYS.forEach(function (k) {
        comparisons[k] = wwCompare(withG.totals[k], withG.matches, withoutG.totals[k], withoutG.matches);
      });
    }

    return {
      with: withG,
      without: withoutG,
      unresolved: unresolved,
      status: status,
      standingNote: STANDING_NOTE,
      comparisonBasis: 'PER_MATCH_AVERAGE',
      comparisons: comparisons
    };
  }

  // ---- Player record assembly ---------------------------------------------------

  function buildPlayerRecentForm(pid, records, psPlayer, recByMatch, completed, opts, per90Basis) {
    var appearances = records.filter(function (r) { return (r.participation || {}).appearance; });

    var windows = {};
    var variability = {};
    opts.windows.forEach(function (N) {
      windows[String(N)] = buildPlayerWindow(records, appearances, N, per90Basis);
      variability[String(N)] = buildVariability(appearances.slice(-N));
    });

    var comparisons = {};
    opts.windows.forEach(function (N) {
      var win = windows[String(N)];
      comparisons[String(N)] = {
        vsBaselineA: playerComparisonSet(win, playerBaselineA(psPlayer)),
        vsBaselineB: (N === opts.selectedWindow)
          ? playerComparisonSet(win, playerBaselineB(records, win.matchIndexes))
          : null
      };
    });

    var p = psPlayer || {};
    var dq = p.dataQuality || {};

    return {
      playerId: pid,
      name: p.name || 'Unknown player',
      number: p.number || '',
      appearancesTotal: appearances.length,
      recordsInSeason: records.length,
      windows: windows,
      comparisons: comparisons,
      recentVsPrevious5: buildR5P5(appearances, per90Basis),
      variability: variability,
      withWithout: buildWithWithout(recByMatch, completed),
      dataQuality: {
        status: dq.status || 'INSUFFICIENT',
        flags: (dq.flags || []).slice(),
        unresolvedPlayerMatches: dq.unresolvedPlayerMatches || 0
      }
    };
  }

  // ---- Team windows (spec §14) ---------------------------------------------------

  function teamCountValue(envelope) {
    return (envelope && isFinNum(envelope.value)) ? envelope.value : 0;
  }

  function structuralTeamReason(m) {
    var flags = ((m.dataQuality || {}).flags || []).filter(function (f) { return f !== 'LOW_LOCATION_COVERAGE'; });
    return flags.length ? flags.join(';') : 'NOT_VALID';
  }

  function sumTeamPeriods(recs) {
    var periods = {};
    PERIOD_BUCKETS.forEach(function (p) { periods[p] = { counts: {}, stoppage: {} }; });
    recs.forEach(function (m) {
      var src = m.periods || {};
      PERIOD_BUCKETS.forEach(function (p) {
        var part = src[p];
        if (!part) return;
        ['counts', 'stoppage'].forEach(function (sub) {
          var s = part[sub];
          if (!s) return;
          Object.keys(s).forEach(function (k) {
            periods[p][sub][k] = (periods[p][sub][k] || 0) + (s[k] || 0);
          });
        });
      });
    });
    return periods;
  }

  function sumTeamGameState(recs) {
    var acc = {};
    SCORE_STATES.forEach(function (s) { acc[s] = {}; });
    var suppressed = 0;
    recs.forEach(function (m) {
      if (m.gameState) {
        SCORE_STATES.forEach(function (s) {
          var src = m.gameState[s] || {};
          Object.keys(src).forEach(function (k) {
            acc[s][k] = (acc[s][k] || 0) + (src[k] || 0);
          });
        });
      } else {
        suppressed++;
      }
    });
    return {
      block: (recs.length > 0 && suppressed === recs.length) ? null : acc,
      suppressed: suppressed
    };
  }

  function buildTeamWindow(matches, completed, N) {
    var included = completed.slice(-N);
    var firstIdx = included.length ? included[0].matchIndex
      : (matches.length ? matches[0].matchIndex : -1);

    var excludedMatches = [];
    matches.forEach(function (m) {
      if (m.matchIndex >= firstIdx && (m.dataQuality || {}).status !== 'VALID') {
        excludedMatches.push({ matchIndex: m.matchIndex, reason: structuralTeamReason(m) });
      }
    });

    var wins = 0, draws = 0, losses = 0, noResult = 0, flagged = 0;
    var goalsFor = 0, goalsAgainst = 0;
    var our = zeroCounts(RF_TEAM_KEYS);
    var opp = zeroCounts(RF_TEAM_KEYS);
    var pctOur = {}, pctOpp = {};
    RF_TEAM_PCT_KEYS.forEach(function (k) { pctOur[k] = []; pctOpp[k] = []; });
    var possOur = 0, possOpp = 0, possBasis = null;

    included.forEach(function (m) {
      var o = (m.result || {}).outcome;
      if (o === 'W') wins++;
      else if (o === 'D') draws++;
      else if (o === 'L') losses++;
      else noResult++;
      if ((m.result || {}).flagged) flagged++;
      goalsFor += (m.result || {}).scoreFor || 0;
      goalsAgainst += (m.result || {}).scoreAgainst || 0;

      var ev = m.events || {};
      var evOur = ev.our || {};
      var evOpp = ev.opponent || {};
      RF_TEAM_KEYS.forEach(function (k) {
        our[k] += teamCountValue(evOur[k]);
        opp[k] += teamCountValue(evOpp[k]);
      });

      var derived = m.derived || {};
      var dOur = derived.our || {};
      var dOpp = derived.opponent || {};
      RF_TEAM_PCT_KEYS.forEach(function (k) {
        pctOur[k].push(dOur[k]);
        pctOpp[k].push(dOpp[k]);
      });

      var poss = m.possession || {};
      possOur += poss.ourSecondsExact || 0;
      possOpp += poss.opponentSecondsExact || 0;
      if (!possBasis && poss.basis) possBasis = poss.basis;
    });

    var percentages = { our: {}, opponent: {} };
    RF_TEAM_PCT_KEYS.forEach(function (k) {
      percentages.our[k] = sumEnvelopes(pctOur[k]);
      percentages.opponent[k] = sumEnvelopes(pctOpp[k]);
    });

    var share = {
      value: pct1(possOur, possOur + possOpp),
      num: possOur,
      den: possOur + possOpp,
      basis: possBasis
    };
    if (possOur + possOpp === 0) share.reason = 'NO_TAGGED_POSSESSION_INTERVALS';

    var averages = {};
    RF_TEAM_KEYS.forEach(function (k) {
      averages[k] = included.length > 0 ? roundHalfUp1(our[k] / included.length) : null;
    });

    var flagsMap = {};
    included.forEach(function (m) {
      ((m.dataQuality || {}).flags || []).forEach(function (f) { flagsMap[f] = true; });
    });
    var status = included.length === 0 ? 'INSUFFICIENT' : 'VALID';

    var gs = sumTeamGameState(included);

    return {
      requested: N,
      available: completed.length,
      included: included.length,
      matchIndexes: included.map(function (m) { return m.matchIndex; }),
      excludedMatches: excludedMatches,
      results: { wins: wins, draws: draws, losses: losses, noResult: noResult, flaggedResults: flagged },
      goalsFor: goalsFor,
      goalsAgainst: goalsAgainst,
      totals: { our: our, opponent: opp },
      averagesPerMatch: { our: averages },
      percentages: percentages,
      taggedPossessionShare: share,
      periods: sumTeamPeriods(included),
      gameState: gs.block,
      gameStateSuppressedMatches: gs.suppressed,
      dataQuality: { status: status, flags: Object.keys(flagsMap).sort() }
    };
  }

  function teamWindowTotals(matchesList) {
    var our = zeroCounts(RF_TEAM_KEYS);
    var opp = zeroCounts(RF_TEAM_KEYS);
    var pctOur = {}, pctOpp = {};
    RF_TEAM_PCT_KEYS.forEach(function (k) { pctOur[k] = []; pctOpp[k] = []; });
    var wins = 0, draws = 0, losses = 0, goalsFor = 0, goalsAgainst = 0;
    matchesList.forEach(function (m) {
      var o = (m.result || {}).outcome;
      if (o === 'W') wins++;
      else if (o === 'D') draws++;
      else if (o === 'L') losses++;
      goalsFor += (m.result || {}).scoreFor || 0;
      goalsAgainst += (m.result || {}).scoreAgainst || 0;
      var ev = m.events || {};
      var evOur = ev.our || {};
      var evOpp = ev.opponent || {};
      RF_TEAM_KEYS.forEach(function (k) {
        our[k] += teamCountValue(evOur[k]);
        opp[k] += teamCountValue(evOpp[k]);
      });
      var derived = m.derived || {};
      var dOur = derived.our || {};
      var dOpp = derived.opponent || {};
      RF_TEAM_PCT_KEYS.forEach(function (k) {
        pctOur[k].push(dOur[k]);
        pctOpp[k].push(dOpp[k]);
      });
    });
    var pct = { our: {}, opponent: {} };
    RF_TEAM_PCT_KEYS.forEach(function (k) {
      pct.our[k] = sumEnvelopes(pctOur[k]);
      pct.opponent[k] = sumEnvelopes(pctOpp[k]);
    });
    return {
      results: { wins: wins, draws: draws, losses: losses, goalsFor: goalsFor, goalsAgainst: goalsAgainst },
      our: our,
      opponent: opp,
      pct: pct,
      sample: matchesList.length
    };
  }

  function teamBaselineA(psTeamSeason, matches) {
    var ts = psTeamSeason || {};
    var totals = ts.totals || {};
    var pct = ts.percentages || {};
    function sideVal(side, k) {
      var v = totals[side] && totals[side][k];
      return isFinNum(v) ? v : 0;
    }
    return {
      results: {
        wins: ts.wins || 0,
        draws: ts.draws || 0,
        losses: ts.losses || 0,
        goalsFor: ts.goalsFor || 0,
        goalsAgainst: ts.goalsAgainst || 0
      },
      our: function (k) { return sideVal('our', k); },
      opponent: function (k) { return sideVal('opponent', k); },
      pct: pct,
      sample: matches.length,
      suppressed: false,
      suppressionReason: null
    };
  }

  function teamBaselineB(matches, windowMatchIndexes) {
    var winSet = {};
    windowMatchIndexes.forEach(function (i) { winSet[i] = true; });
    var bMatches = matches.filter(function (m) { return !winSet[m.matchIndex]; });
    var available = bMatches.length > 0;
    var reason = null;
    if (!available) {
      reason = (matches.length === 0) ? 'NO_DATA' : 'WHOLE_SEASON_IN_WINDOW';
    }
    var t = teamWindowTotals(bMatches);
    return {
      results: t.results,
      our: function (k) { return t.our[k]; },
      opponent: function (k) { return t.opponent[k]; },
      pct: t.pct,
      sample: t.sample,
      suppressed: !available,
      suppressionReason: reason
    };
  }

  function teamComparisonSet(win, baseline) {
    var empty = win.included === 0;
    var ctxBase = { emptyWindow: empty, baselineSuppressed: baseline.suppressed, suppressionReason: baseline.suppressionReason };
    var results = {};
    ['wins', 'draws', 'losses', 'goalsFor', 'goalsAgainst'].forEach(function (k) {
      results[k] = compareValues(win.results[k], baseline.results[k], win.included, baseline.sample, 'COUNT', ctxBase);
    });
    var our = {};
    var opponent = {};
    RF_TEAM_KEYS.forEach(function (k) {
      our[k] = compareValues(win.totals.our[k], baseline.our(k), win.included, baseline.sample, 'COUNT', ctxBase);
      opponent[k] = compareValues(win.totals.opponent[k], baseline.opponent(k), win.included, baseline.sample, 'COUNT', ctxBase);
    });
    var percentages = { our: {}, opponent: {} };
    ['our', 'opponent'].forEach(function (side) {
      RF_TEAM_PCT_KEYS.forEach(function (k) {
        percentages[side][k] = compareEnvelopes(win.percentages[side][k], (baseline.pct[side] || {})[k], win.included, baseline.sample, ctxBase);
      });
    });
    return { results: results, our: our, opponent: opponent, percentages: percentages };
  }

  function buildTeamRecentForm(matches, completed, opts, psTeamSeason) {
    var windows = {};
    opts.windows.forEach(function (N) {
      windows[String(N)] = buildTeamWindow(matches, completed, N);
    });
    var comparisons = {};
    opts.windows.forEach(function (N) {
      var w = windows[String(N)];
      comparisons[String(N)] = {
        vsBaselineA: teamComparisonSet(w, teamBaselineA(psTeamSeason, matches)),
        vsBaselineB: (N === opts.selectedWindow)
          ? teamComparisonSet(w, teamBaselineB(matches, w.matchIndexes))
          : null
      };
    });
    var flagsMap = {};
    matches.forEach(function (m) {
      ((m.dataQuality || {}).flags || []).forEach(function (f) { flagsMap[f] = true; });
    });
    var matchesValid = completed.length;
    var status = matches.length === 0 ? 'INSUFFICIENT' : (matchesValid === matches.length ? 'VALID' : 'PARTIAL');
    return {
      completedMatchesTotal: completed.length,
      windows: windows,
      comparisons: comparisons,
      dataQuality: { status: status, flags: Object.keys(flagsMap).sort(), matchesValid: matchesValid }
    };
  }

  // ---- Options --------------------------------------------------------------------

  function normalizeOptions(options) {
    var o = isPlainObject(options) ? options : {};
    var windows = [3, 5, 10];
    if (Array.isArray(o.windows) && o.windows.length) {
      var seen = {};
      var list = [];
      o.windows.forEach(function (n) {
        if (isFinNum(n) && n > 0 && Math.floor(n) === n && !seen[n]) {
          seen[n] = true;
          list.push(n);
        }
      });
      if (list.length) {
        list.sort(function (a, b) { return a - b; });
        windows = list;
      }
    }
    var selectedWindow = 5;
    if (isFinNum(o.selectedWindow) && o.selectedWindow > 0 && Math.floor(o.selectedWindow) === o.selectedWindow) {
      selectedWindow = o.selectedWindow;
    }
    if (windows.indexOf(selectedWindow) === -1) {
      windows.push(selectedWindow);
      windows.sort(function (a, b) { return a - b; });
    }
    return { windows: windows, selectedWindow: selectedWindow };
  }

  // ---- Entry point ------------------------------------------------------------------

  function computeRecentForm(PS, options) {
    var opts = normalizeOptions(options);
    var ps = isPlainObject(PS) ? PS : {};
    var matches = Array.isArray(ps.matches) ? ps.matches.filter(isPlainObject) : [];
    var playerOrder = Array.isArray(ps.playerOrder) ? ps.playerOrder.slice() : [];
    var psPlayers = isPlainObject(ps.players) ? ps.players : {};

    var minutesStandards = (ps.protocol || {}).minutesStandards || {};
    var per90Basis = typeof minutesStandards.per90Basis === 'string' ? minutesStandards.per90Basis : null;

    // Records by player, season order preserved (PS.playerMatchRecords is
    // built in deterministic match order; filtering preserves it).
    var recordsByPid = {};
    var recByPidMatch = {};
    (Array.isArray(ps.playerMatchRecords) ? ps.playerMatchRecords : []).forEach(function (r) {
      if (!isPlainObject(r) || typeof r.playerId !== 'string') return;
      var pid = r.playerId;
      if (!recordsByPid[pid]) { recordsByPid[pid] = []; recByPidMatch[pid] = {}; }
      recordsByPid[pid].push(r);
      recByPidMatch[pid][r.matchIndex] = r;
    });

    var completed = matches.filter(function (m) {
      return (m.dataQuality || {}).status === 'VALID';
    });

    var players = {};
    playerOrder.forEach(function (pid) {
      players[pid] = buildPlayerRecentForm(
        pid,
        recordsByPid[pid] || [],
        psPlayers[pid],
        recByPidMatch[pid] || {},
        completed,
        opts,
        per90Basis
      );
    });

    var team = buildTeamRecentForm(matches, completed, opts, ps.teamSeason);

    // Top-level data quality: propagate PS season-level flags + gates.
    var flagsMap = {};
    function addFlag(f) { if (typeof f === 'string' && f) flagsMap[f] = true; }
    playerOrder.forEach(function (pid) {
      var dq = (psPlayers[pid] || {}).dataQuality || {};
      (dq.flags || []).forEach(addFlag);
    });
    matches.forEach(function (m) {
      ((m.dataQuality || {}).flags || []).forEach(addFlag);
    });
    var psInput = ps.input || {};
    if (Array.isArray(psInput.duplicateSessions) && psInput.duplicateSessions.length) addFlag('DUPLICATE_SESSIONS_EXCLUDED');
    var audit = ps.identityAudit || {};
    if (Array.isArray(audit.drift) && audit.drift.length) addFlag('IDENTITY_DRIFT');
    if (Array.isArray(audit.possibleDuplicates) && audit.possibleDuplicates.length) addFlag('POSSIBLE_DUPLICATE_PERSONS');
    var propagatedFlags = Object.keys(flagsMap).sort();
    var structuralFlags = propagatedFlags.filter(function (f) {
      return f !== 'LOW_LOCATION_COVERAGE' && f !== 'MISSING_LOCATION';
    });
    var status = matches.length === 0 ? 'INSUFFICIENT' : (structuralFlags.length > 0 ? 'PARTIAL' : 'VALID');

    return {
      spec: SPEC,
      engine: {
        version: VERSION,
        spec: SPEC,
        deterministic: true,
        psEngineVersion: (ps.engine || {}).version || null,
        psSpec: ps.spec || null
      },
      input: {
        orderedMatchCount: matches.length,
        completedMatchCount: completed.length,
        optionsEcho: { windows: opts.windows.slice(), selectedWindow: opts.selectedWindow },
        selectedWindow: opts.selectedWindow
      },
      players: players,
      playerOrder: playerOrder,
      team: team,
      dataQuality: {
        status: status,
        propagatedFlags: propagatedFlags,
        structuralFlags: structuralFlags
      },
      protocol: {
        notes: PROTOCOL_NOTES,
        params: { windows: opts.windows.slice(), selectedWindow: opts.selectedWindow },
        minutesStandards: {
          basis: typeof minutesStandards.basis === 'string' ? minutesStandards.basis : null,
          per90Basis: per90Basis
        }
      }
    };
  }

  return {
    computeRecentForm: computeRecentForm,
    VERSION: VERSION,
    SPEC: SPEC
  };
});
