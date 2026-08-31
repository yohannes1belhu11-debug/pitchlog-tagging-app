// PitchLog / MatchTag — Analytics Engine V1 (deterministic, match-level)
// =====================================================================
// Implements docs/metric-specification.md (PitchLog-METRIC-SPEC-v1.0)
// for the metrics that are CURRENTLY COMPUTABLE from the structured
// event model. Levels are strictly separated:
//   LEVEL 1 — raw counts       (level1)
//   LEVEL 2 — derived metrics  (level2)
//   LEVEL 3 — contextual splits (level3, context operators only)
//
// Architecture (per task):
//   RAW EVENTS -> VALIDATION -> ANALYTICS ENGINE -> MATCH ANALYTICS OBJECT -> UI
//
// Determinism contract (spec §12):
//   - computeMatchAnalytics(session) is a PURE function: no wall-clock
//     reads, no randomness, no mutation of the input, stable key order.
//     Recomputing on the same session yields a byte-identical object.
//   - Canonical event order: (time asc, id asc).
//   - Ratios are null (not 0) when the denominator is 0 (P5).
//   - Percentages/durations rounded half-up to 1 decimal.
//   - Every Level 1/2 metric carries the spec §12.5 result envelope
//     { value, num?, den?, excluded, params? }. Level 3 buckets carry
//     plain counts; their unknown populations are explicit buckets
//     ('Unlocated', 'Unknown' period, unattributed team partition).
//
// NOT implemented here (out of scope / NOT CURRENTLY COMPUTABLE per the
// spec): OFFICIAL possession % (NC-1), PPDA, xG/xA, physical metrics,
// player minutes / per-90, heat maps, season intelligence, AI. The only
// possession-duration metric implemented is the spec's sanctioned
// substitute M-L2-B4, always named "Tagged Possession Share" and always
// labelled as based ONLY on recorded PitchLog Possession interval tags.
// Nothing in this file invents data: every number is derived from tagged
// events only.
//
// UMD: window.AnalyticsEngine in the renderer, module.exports in Node
// (tests). Loaded by index.html AFTER integrity.js, BEFORE renderer.js.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.AnalyticsEngine = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SPEC = 'PitchLog-METRIC-SPEC-v1.0';
  var VERSION = '1.0.0';

  // ---- Fixed vocabularies (mirror src/renderer.js; source is authority) ----

  var CANONICAL_LABELS = [
    'Goal', 'Shot', 'Pass', 'Foul', 'Card', 'Corner', 'Sub', 'Possession',
    'Chance', 'Cross', 'Key Pass', 'Press', 'Press Win', 'Turnover',
    'Recovery', 'Interception', 'Duel', 'Positive Transition', 'Negative Transition'
  ];

  var THIRDS = ['Defensive third', 'Middle third', 'Attacking third'];
  var CHANNELS = ['Left channel', 'Central channel', 'Right channel'];

  var PASS_SUBTYPES = ['Progressive', 'Lateral', 'Backward', 'Long'];
  var SHOT_SUBTYPES = ['On target', 'Off target', 'Blocked'];
  var CARD_SUBTYPES = ['Yellow', 'Red'];
  var POSSESSION_END_REASONS = ['Shot', 'Turnover', 'Foul won', 'Out of play'];
  var SHOT_SITUATIONS = ['Open play', 'Set piece', 'Penalty'];
  var BODY_PARTS_SHOT = ['Left foot', 'Right foot', 'Head'];
  var BODY_PARTS_GOAL = ['Left foot', 'Right foot', 'Head', 'Other'];
  var FOUL_ZONES = ['Defensive third', 'Middle third', 'Attacking third'];

  var PLAY_PERIODS = ['1H', '2H', 'ET1', 'ET2'];
  var NON_PLAY_PERIODS = ['PRE_MATCH', 'HT', 'ET_HT', 'FT'];
  var PERIOD_ORDER = ['1H', '2H', 'ET1', 'ET2', 'Non-play', 'Unknown'];

  // M-L2-G3 interpretive classification sets (spec §5; printed with results).
  var POSITIVE_LABELS = ['Goal', 'Shot', 'Chance', 'Key Pass', 'Cross',
    'Press Win', 'Recovery', 'Interception', 'Positive Transition'];
  var NEGATIVE_LABELS = ['Turnover', 'Negative Transition', 'Card'];

  // Linkage windows (spec §9.3): reported with every linkage metric.
  var TAU_SHOT = 10;      // seconds, transition -> shot/chance/goal
  var TAU_TURNOVER = 15;  // seconds, turnover -> opponent shot/chance
  var TAU_COTAG = 5;      // seconds, X6 advisory co-timing

  // ---- Small deterministic helpers ---------------------------------------

  function roundHalfUp1(x) {
    return Math.round((x + Number.EPSILON) * 10) / 10;
  }

  function pct1(num, den) {
    if (!(den > 0)) return null;           // P5: null, never 0-from-nothing
    return roundHalfUp1((num / den) * 100);
  }

  function isFinNum(v) {
    return typeof v === 'number' && isFinite(v);
  }

  function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  // Result envelopes (spec §12.5).
  function countEnv(n, excluded) {
    return { value: n, excluded: excluded || {} };
  }
  function ratioEnv(num, den, excluded, params) {
    var env = { value: pct1(num, den), num: num, den: den, excluded: excluded || {} };
    if (params) env.params = params;
    return env;
  }
  function distEnv(buckets, unknown) {
    return { buckets: buckets, unknown: unknown };
  }

  // Canonical label order for by-label maps: canonical list first, then any
  // extra labels sorted ascending (deterministic for custom tags).
  function orderedLabels(labelSet) {
    var out = CANONICAL_LABELS.filter(function (l) { return labelSet.has(l); });
    var extras = Array.from(labelSet).filter(function (l) {
      return CANONICAL_LABELS.indexOf(l) === -1;
    }).sort();
    return out.concat(extras);
  }

  // ---- Validation + normalization (RAW EVENTS -> VALIDATION) ------------

  // Returns { records, issues, rawCount, skipped }.
  // records are internal views; the source event objects are NEVER mutated.
  function validateAndNormalize(rawEvents) {
    var issues = {};
    function flag(code) { issues[code] = (issues[code] || 0) + 1; }

    var records = [];
    if (!Array.isArray(rawEvents)) {
      flag('EVENTS_NOT_ARRAY');
      rawEvents = [];
    }

    for (var i = 0; i < rawEvents.length; i++) {
      var ev = rawEvents[i];
      if (!isPlainObject(ev)) { flag('INVALID_EVENT_SKIPPED'); continue; }

      var label = (typeof ev.label === 'string' && ev.label) ? ev.label : null;
      if (!label) flag('MISSING_LABEL');

      var id = isFinNum(ev.id) ? ev.id : null;
      if (id === null) flag('MISSING_ID');

      var time = isFinNum(ev.time) ? ev.time : (isFinNum(ev.matchTime) ? ev.matchTime : null);
      if (time === null) { flag('MISSING_TIME'); time = 0; }

      var matchSeconds = isFinNum(ev.matchSeconds) ? ev.matchSeconds : Math.floor(time);
      var period = (typeof ev.period === 'string' && ev.period) ? ev.period : null;
      if (!period) flag('MISSING_PERIOD');

      var qualifiers = isPlainObject(ev.qualifiers) ? ev.qualifiers : {};
      if (ev.qualifiers !== undefined && !isPlainObject(ev.qualifiers)) flag('INVALID_QUALIFIERS');

      var location = null;
      if (ev.location != null) {
        if (isPlainObject(ev.location) && isFinNum(ev.location.x) && isFinNum(ev.location.y)) {
          location = { x: ev.location.x, y: ev.location.y };
          if (ev.location.x < 0 || ev.location.x > 1 || ev.location.y < 0 || ev.location.y > 1) {
            flag('LOCATION_OUT_OF_RANGE');
          }
        } else {
          flag('INVALID_LOCATION');
        }
      }

      var sfb = isFinNum(ev.scoreForBefore) ? ev.scoreForBefore : null;
      var sab = isFinNum(ev.scoreAgainstBefore) ? ev.scoreAgainstBefore : null;
      if (sfb === null || sab === null) { flag('MISSING_SCORE_BEFORE'); }
      if (sfb === null) sfb = 0;
      if (sab === null) sab = 0;

      var team = (ev.team === 'our' || ev.team === 'opponent') ? ev.team : null;

      records.push({
        ref: ev,
        id: id === null ? records.length : id,     // deterministic fallback
        time: time,
        label: label || '(unknown)',
        team: team,
        subtype: (typeof ev.subtype === 'string' && ev.subtype) ? ev.subtype : null,
        qualifiers: qualifiers,
        location: location,
        playerId: (typeof ev.playerId === 'string' && ev.playerId) ? ev.playerId : null,
        playerOffId: (typeof ev.playerOffId === 'string' && ev.playerOffId) ? ev.playerOffId : null,
        playerOnId: (typeof ev.playerOnId === 'string' && ev.playerOnId) ? ev.playerOnId : null,
        period: period || 'Unknown',
        matchSeconds: matchSeconds,
        isGoal: label === 'Goal' || label === 'GOAL',
        isInterval: ev.isInterval === true,
        startTime: isFinNum(ev.startTime) ? ev.startTime : null,
        endTime: isFinNum(ev.endTime) ? ev.endTime : null,
        sequenceId: (typeof ev.sequenceId === 'string' && ev.sequenceId) ? ev.sequenceId : null,
        sfb: sfb,
        sab: sab,
        sfa: isFinNum(ev.scoreForAfter) ? ev.scoreForAfter : null,
        saa: isFinNum(ev.scoreAgainstAfter) ? ev.scoreAgainstAfter : null,
        stateBefore: stateOfScore(sfb, sab)
      });
    }

    // Canonical order (spec §12.1): (time asc, id asc). Sort a copy of the
    // records array — the caller's event array is never touched.
    records.sort(function (a, b) {
      if (a.time !== b.time) return a.time - b.time;
      return a.id - b.id;
    });

    var issueList = Object.keys(issues).sort().map(function (code) {
      return { code: code, count: issues[code] };
    });

    return {
      records: records,
      issues: issueList,
      rawCount: rawEvents.length,
      skipped: (issues['INVALID_EVENT_SKIPPED'] || 0)
    };
  }

  // ---- Canonical predicates (spec §3) ------------------------------------

  function stateOfScore(f, a) {
    if (f > a) return 'WINNING';
    if (f < a) return 'LOSING';
    return 'DRAW';
  }

  function inPlayPeriod(rec) { return PLAY_PERIODS.indexOf(rec.period) !== -1; }
  function nonPlayPeriod(rec) { return NON_PLAY_PERIODS.indexOf(rec.period) !== -1; }

  function periodBucket(rec) {
    if (inPlayPeriod(rec)) return rec.period;
    if (nonPlayPeriod(rec)) return 'Non-play';
    return 'Unknown';
  }

  function isStoppage(rec) {
    var boundaries = { '1H': 2700, '2H': 5400, 'ET1': 6300, 'ET2': 7200 };
    var b = boundaries[rec.period];
    return b !== undefined && rec.matchSeconds > b;
  }

  function minuteBin(rec) {
    var ms = rec.matchSeconds;
    switch (periodBucket(rec)) {
      case '1H':
        if (ms < 900) return '1H 0-15';
        if (ms < 1800) return '1H 15-30';
        return '1H 30-45+';
      case '2H':
        if (ms < 3600) return '2H 45-60';
        if (ms < 4500) return '2H 60-75';
        return '2H 75-90+';
      case 'ET1':
        if (ms < 5850) return 'ET1 105-112';
        return 'ET1 112-120+';
      case 'ET2':
        if (ms < 6750) return 'ET2 120-127';
        return 'ET2 127+';
      case 'Non-play': return 'Non-play';
      default: return 'Unknown';
    }
  }

  function zoneKey(rec) {
    if (!rec.location) return 'Unlocated';
    var ti = Math.min(2, Math.max(0, Math.floor(rec.location.x * 3)));
    var ci = Math.min(2, Math.max(0, Math.floor(rec.location.y * 3)));
    return THIRDS[ti] + ' · ' + CHANNELS[ci];
  }
  function thirdKey(rec) {
    if (!rec.location) return 'Unlocated';
    return THIRDS[Math.min(2, Math.max(0, Math.floor(rec.location.x * 3)))];
  }
  function channelKey(rec) {
    if (!rec.location) return 'Unlocated';
    return CHANNELS[Math.min(2, Math.max(0, Math.floor(rec.location.y * 3)))];
  }

  function hasQual(rec, group, value) {
    return rec.qualifiers[group] === value;
  }
  function qual(rec, group) {
    var v = rec.qualifiers[group];
    return (typeof v === 'string' && v) ? v : null;
  }

  // Interval duration in seconds (0 when malformed; post-migration always set).
  function intervalDuration(rec) {
    if (!rec.isInterval) return 0;
    if (!isFinNum(rec.startTime) || !isFinNum(rec.endTime)) return 0;
    return Math.max(0, rec.endTime - rec.startTime);
  }

  // Level 3 bucket metric set (spec §6 sanctioned rows; plain counts).
  var L3_KEYS = [
    'events', 'goals', 'shots', 'chances', 'crosses', 'corners', 'fouls',
    'yellowCards', 'redCards', 'passes', 'possessionIntervals', 'presses',
    'pressWins', 'interceptions', 'recoveries', 'turnovers', 'duels',
    'positiveTransitions', 'negativeTransitions'
  ];

  function zeroBucket() {
    var b = {};
    L3_KEYS.forEach(function (k) { b[k] = 0; });
    return b;
  }

  function addToBucket(bucket, rec) {
    bucket.events++;
    if (rec.isGoal) bucket.goals++;
    switch (rec.label) {
      case 'Shot': bucket.shots++; break;
      case 'Chance': bucket.chances++; break;
      case 'Cross': bucket.crosses++; break;
      case 'Corner': bucket.corners++; break;
      case 'Foul': bucket.fouls++; break;
      case 'Card':
        if (rec.subtype === 'Yellow') bucket.yellowCards++;
        else if (rec.subtype === 'Red') bucket.redCards++;
        break;
      case 'Pass': bucket.passes++; break;
      case 'Possession': if (rec.isInterval) bucket.possessionIntervals++; break;
      case 'Press': bucket.presses++; break;
      case 'Press Win': bucket.pressWins++; break;
      case 'Interception': bucket.interceptions++; break;
      case 'Recovery': bucket.recoveries++; break;
      case 'Turnover': bucket.turnovers++; break;
      case 'Duel': bucket.duels++; break;
      case 'Positive Transition': bucket.positiveTransitions++; break;
      case 'Negative Transition': bucket.negativeTransitions++; break;
    }
  }

  // ---- Level 1 team counting (single partitioning pass) ------------------

  function teamPartition(records, teamVal) {
    return records.filter(function (r) { return r.team === teamVal; });
  }

  function countTeamMetrics(recs) {
    var m = {
      goals: 0, shots: 0, shotsOnTarget: 0, shotsOffTarget: 0, shotsBlocked: 0,
      shotsUnknownOutcome: 0, chances: 0, crosses: 0, corners: 0, fouls: 0,
      yellowCards: 0, redCards: 0, cardsUnknownSubtype: 0, substitutions: 0,
      passes: 0, successfulPasses: 0, unsuccessfulPasses: 0, passesUnknownOutcome: 0,
      progressivePasses: 0, lateralPasses: 0, backwardPasses: 0, longPasses: 0,
      passesUnknownSubtype: 0, passesUnderPressure: 0, passesFree: 0,
      passesUnknownPressure: 0, presses: 0, pressWins: 0, interceptions: 0,
      recoveries: 0, turnovers: 0, duels: 0, positiveTransitions: 0,
      negativeTransitions: 0, events: 0
    };
    recs.forEach(function (r) {
      m.events++;
      if (r.isGoal) m.goals++;
      switch (r.label) {
        case 'Shot':
          m.shots++;
          if (r.subtype === 'On target') m.shotsOnTarget++;
          else if (r.subtype === 'Off target') m.shotsOffTarget++;
          else if (r.subtype === 'Blocked') m.shotsBlocked++;
          else m.shotsUnknownOutcome++;
          break;
        case 'Chance': m.chances++; break;
        case 'Cross': m.crosses++; break;
        case 'Corner': m.corners++; break;
        case 'Foul': m.fouls++; break;
        case 'Card':
          if (r.subtype === 'Yellow') m.yellowCards++;
          else if (r.subtype === 'Red') m.redCards++;
          else m.cardsUnknownSubtype++;
          break;
        case 'Sub': m.substitutions++; break;
        case 'Pass':
          m.passes++;
          if (hasQual(r, 'Outcome', 'Successful')) m.successfulPasses++;
          else if (hasQual(r, 'Outcome', 'Unsuccessful')) m.unsuccessfulPasses++;
          else m.passesUnknownOutcome++;
          if (PASS_SUBTYPES.indexOf(r.subtype) !== -1) {
            if (r.subtype === 'Progressive') m.progressivePasses++;
            else if (r.subtype === 'Lateral') m.lateralPasses++;
            else if (r.subtype === 'Backward') m.backwardPasses++;
            else m.longPasses++;
          } else {
            m.passesUnknownSubtype++;
          }
          if (hasQual(r, 'Pressure', 'Under pressure')) m.passesUnderPressure++;
          else if (hasQual(r, 'Pressure', 'Free')) m.passesFree++;
          else m.passesUnknownPressure++;
          break;
        case 'Press': m.presses++; break;
        case 'Press Win': m.pressWins++; break;
        case 'Interception': m.interceptions++; break;
        case 'Recovery': m.recoveries++; break;
        case 'Turnover': m.turnovers++; break;
        case 'Duel': m.duels++; break;
        case 'Positive Transition': m.positiveTransitions++; break;
        case 'Negative Transition': m.negativeTransitions++; break;
      }
    });
    return m;
  }

  // Enveloped team metric block (spec §12.5; excluded keys always present).
  function teamEnvelope(m) {
    var shotOutcomeEx = { subtype: m.shotsUnknownOutcome };
    var passOutcomeEx = { outcome: m.passesUnknownOutcome };
    var passSubtypeEx = { subtype: m.passesUnknownSubtype };
    var passPressureEx = { pressure: m.passesUnknownPressure };
    var cardSubtypeEx = { subtype: m.cardsUnknownSubtype };
    return {
      events: countEnv(m.events),
      goals: countEnv(m.goals),
      shots: countEnv(m.shots),
      shotsOnTarget: countEnv(m.shotsOnTarget, shotOutcomeEx),
      shotsOffTarget: countEnv(m.shotsOffTarget, shotOutcomeEx),
      shotsBlocked: countEnv(m.shotsBlocked, shotOutcomeEx),
      shotsUnknownOutcome: countEnv(m.shotsUnknownOutcome),
      chances: countEnv(m.chances),
      crosses: countEnv(m.crosses),
      corners: countEnv(m.corners),
      fouls: countEnv(m.fouls),
      yellowCards: countEnv(m.yellowCards, cardSubtypeEx),
      redCards: countEnv(m.redCards, cardSubtypeEx),
      substitutions: countEnv(m.substitutions),
      passes: countEnv(m.passes),
      successfulPasses: countEnv(m.successfulPasses, passOutcomeEx),
      unsuccessfulPasses: countEnv(m.unsuccessfulPasses, passOutcomeEx),
      passesUnknownOutcome: countEnv(m.passesUnknownOutcome),
      progressivePasses: countEnv(m.progressivePasses, passSubtypeEx),
      lateralPasses: countEnv(m.lateralPasses, passSubtypeEx),
      backwardPasses: countEnv(m.backwardPasses, passSubtypeEx),
      longPasses: countEnv(m.longPasses, passSubtypeEx),
      passesUnknownSubtype: countEnv(m.passesUnknownSubtype),
      passesUnderPressure: countEnv(m.passesUnderPressure, passPressureEx),
      passesFree: countEnv(m.passesFree, passPressureEx),
      passesUnknownPressure: countEnv(m.passesUnknownPressure),
      presses: countEnv(m.presses),
      pressWins: countEnv(m.pressWins),
      interceptions: countEnv(m.interceptions),
      recoveries: countEnv(m.recoveries),
      turnovers: countEnv(m.turnovers),
      duels: countEnv(m.duels),
      positiveTransitions: countEnv(m.positiveTransitions),
      negativeTransitions: countEnv(m.negativeTransitions)
    };
  }

  // ---- Possession interval metrics (M-B10..M-B13) -------------------------
  //
  // METHOD CONSTRAINT (task directive + spec M-L2-B4 / NC-1): the PitchLog
  // tagging model does NOT provide a complete independent possession
  // dataset. Everything below is therefore TAGGED-UNIVERSE ONLY:
  //   - the full UNROUNDED interval duration is used for every internal
  //     computation and accumulation (rounding happens only at the
  //     displayed `value`, per spec §12.3);
  //   - the raw possession interval data is preserved verbatim in
  //     `intervalList` (audit / re-derivation);
  //   - any share derived from these durations is reported ONLY under the
  //     name "Tagged Possession Share" with our + opponent tagged
  //     durations and a limitation note — never as "Possession %" and
  //     never as an official match possession statistic.

  function wellFormedInterval(r) {
    return isFinNum(r.startTime) && isFinNum(r.endTime) && r.endTime >= r.startTime;
  }

  function possessionMetrics(recs) {
    var intervals = recs.filter(function (r) {
      return r.label === 'Possession' && r.isInterval;
    });
    var total = 0;          // exact, unrounded seconds
    var malformed = 0;      // intervals without usable bounds
    var valid = 0;
    var endReasons = {};
    POSSESSION_END_REASONS.forEach(function (v) { endReasons[v] = 0; });
    var unknown = 0;
    var intervalList = intervals.map(function (r) {
      var reason = qual(r, 'Ended by');
      if (reason && POSSESSION_END_REASONS.indexOf(reason) !== -1) endReasons[reason]++;
      else if (reason) { endReasons[reason] = (endReasons[reason] || 0) + 1; } // custom value
      else unknown++;
      if (wellFormedInterval(r)) {
        valid++;
        total += intervalDuration(r);   // exact (endTime − startTime)
      } else {
        malformed++;                     // no invented duration
      }
      return {
        id: r.id,
        team: r.team,
        period: r.period,
        startTime: r.startTime,
        endTime: r.endTime,
        durationSeconds: intervalDuration(r),  // raw, unrounded
        endedBy: reason,
        sequenceId: r.sequenceId
      };
    });
    return {
      intervals: countEnv(intervals.length),
      totalDuration: countEnv(roundHalfUp1(total), { malformedIntervalBounds: malformed }),
      totalSecondsExact: total,          // unrounded — internal + reporting basis
      meanDuration: valid > 0
        ? { value: roundHalfUp1(total / valid), num: roundHalfUp1(total), den: valid, excluded: { malformedIntervalBounds: malformed } }
        : { value: null, num: 0, den: 0, excluded: { malformedIntervalBounds: malformed } },
      endReasons: distEnv(endReasons, unknown),
      intervalList: intervalList        // RAW possession interval data preserved
    };
  }

  // M-L2-B4 envelope builder (the team the share is computed FOR is `poss`;
  // `otherPoss` supplies the rest of the tagged denominator). Uses full
  // unrounded seconds; displays a rounded share.
  function taggedPossessionShareEnvelope(poss, otherPoss, unattrSeconds, matchEndSeconds) {
    var dur = poss.totalSecondsExact;          // unrounded
    var otherDur = otherPoss.totalSecondsExact; // unrounded
    var taggedTotal = dur + otherDur;
    var env = ratioEnv(dur, taggedTotal,
      { unattributedTeamIntervalSeconds: roundHalfUp1(unattrSeconds) });
    env.name = 'Tagged Possession Share';
    env.specId = 'M-L2-B4';
    env.basis = 'Recorded PitchLog Possession interval tags ONLY — not an official match possession statistic (NC-1)';
    if (poss.intervals.value === 0 && otherPoss.intervals.value === 0) {
      env.value = null;
      env.reason = 'NO_TAGGED_POSSESSION_INTERVALS';
    } else if (otherPoss.intervals.value === 0) {
      env.value = null;
      env.reason = 'OPPONENT_INTERVALS_UNTAGGED';
    } else if (poss.intervals.value === 0) {
      env.value = null;
      env.reason = 'THIS_TEAM_INTERVALS_UNTAGGED';
    }
    env.limitation = env.value === null
      ? 'Insufficient tagged possession data — no share is computed (' + env.reason + ').'
      : 'Based only on ' + roundHalfUp1(dur) + 's (this team) + ' + roundHalfUp1(otherDur)
        + 's (opponent) of recorded Possession intervals = '
        + (taggedTotal > 0 ? roundHalfUp1((taggedTotal / matchEndSeconds) * 100) : 0)
        + '% of nominal match time tagged. Untagged possession time is not included;'
        + ' this is NOT an official match possession statistic.';
    env.params = {
      specId: 'M-L2-B4',
      basis: 'Possession interval tags only; untagged time excluded (NC-1)',
      taggedIntervalSeconds: { team: roundHalfUp1(dur), opponent: roundHalfUp1(otherDur) },
      taggedIntervalSecondsExact: { team: dur, opponent: otherDur },
      unattributedTeamIntervalSecondsExact: unattrSeconds,
      matchDurationSeconds: matchEndSeconds,
      taggedTimeCoveragePct: pct1(taggedTotal, matchEndSeconds)
    };
    return env;
  }

  // ---- Attribute distributions (M-A16) + shares (M-L2-A16) ----------------

  function attributeDistribution(recs, label, group, values) {
    var buckets = {};
    values.forEach(function (v) { buckets[v] = 0; });
    var extras = {};
    var unknown = 0;
    recs.forEach(function (r) {
      if (r.label !== label) return;
      var v = qual(r, group);
      if (!v) { unknown++; return; }
      if (values.indexOf(v) !== -1) buckets[v]++;
      else extras[v] = (extras[v] || 0) + 1;
    });
    Object.keys(extras).sort().forEach(function (k) { buckets[k] = extras[k]; });
    return distEnv(buckets, unknown);
  }

  function attributeShares(dist) {
    var known = 0;
    Object.keys(dist.buckets).forEach(function (k) { known += dist.buckets[k]; });
    var shares = {};
    Object.keys(dist.buckets).forEach(function (k) {
      shares[k] = pct1(dist.buckets[k], known);
    });
    return { shares: shares, knownTotal: known, unknown: dist.unknown };
  }

  // ---- Goal chain, X1, score-state metrics (M-L2-F1/F2) ------------------

  // Attributed goals = goal events with a team AND After fields set (the
  // same population that can change the score in logEvent()).
  function attributedGoals(records) {
    return records.filter(function (r) {
      return r.isGoal && r.team !== null && r.sfa !== null && r.saa !== null;
    });
  }

  function chainFinalScore(goals) {
    if (goals.length === 0) return { for: 0, against: 0 };
    var last = goals[goals.length - 1];
    return { for: last.sfa, against: last.saa };
  }

  function scoreStateMetrics(records, durationMinutes) {
    var unattributedGoals = records.filter(function (r) {
      return r.isGoal && r.team === null;
    }).length;
    var goals = attributedGoals(records);
    var matchEnd = durationMinutes * 60;

    if (unattributedGoals > 0) {
      return {
        changes: { value: null, excluded: {}, reason: 'UNATTRIBUTED_GOALS' },
        durationSeconds: null,
        durationReason: 'UNATTRIBUTED_GOALS',
        params: { matchEndSeconds: matchEnd }
      };
    }

    // Replay the chain (records are already in canonical order).
    var changes = 0;
    var f = 0, a = 0;
    var prevState = 'DRAW';
    var boundaries = [0]; // state segment start times
    var states = ['DRAW'];
    goals.forEach(function (g) {
      var df = g.sfa - g.sfb;
      var da = g.saa - g.sab;
      if (isFinNum(df) && isFinNum(da)) { f += df; a += da; }
      var st = stateOfScore(f, a);
      if (st !== prevState) changes++;
      prevState = st;
      // Segment boundary (capped at matchEnd, monotonic non-decreasing).
      var b = Math.min(Math.max(g.time, 0), matchEnd);
      if (b < boundaries[boundaries.length - 1]) b = boundaries[boundaries.length - 1];
      boundaries.push(b);
      states.push(st);
    });
    boundaries.push(matchEnd);

    var duration = { WINNING: 0, DRAW: 0, LOSING: 0 };
    for (var i = 0; i < states.length; i++) {
      var seg = boundaries[i + 1] - boundaries[i];
      if (seg > 0) duration[states[i]] += seg;
    }
    ['WINNING', 'DRAW', 'LOSING'].forEach(function (k) {
      duration[k] = roundHalfUp1(duration[k]);
    });

    return {
      changes: { value: changes, excluded: {} },
      durationSeconds: duration,
      params: { matchEndSeconds: matchEnd }
    };
  }

  // ---- Transition linkage (M-L2-D1..D4, spec §9.3) -----------------------

  // Linked count under the spec §9.3 linkage rule L(τ), implemented as the
  // greedy BACKWARD match: each B links to the NEAREST preceding qualifying
  // A (same period, 0 < B.time − A.time ≤ τ), so a follow-up can inflate at
  // most one transition (linkage is a function). Both lists are already in
  // canonical order; the returned count is |{A : some B links to A}|.
  function linkedCount(aRecs, bRecs, tau) {
    var linked = new Set();
    bRecs.forEach(function (b) {
      for (var i = aRecs.length - 1; i >= 0; i--) {
        var a = aRecs[i];
        var d = b.time - a.time;
        if (d > tau) break;            // earlier A's are strictly farther
        if (d <= 0) continue;          // A at/after B — keep scanning backward
        if (a.period === b.period) {   // nearest preceding qualifying A
          linked.add(a);
          break;
        }
        // within τ but different period → not qualifying; keep scanning
      }
    });
    return linked.size;
  }

  function transitionMetrics(records) {
    var ourPT = records.filter(function (r) {
      return r.label === 'Positive Transition' && r.team === 'our';
    });
    var ourTO = records.filter(function (r) {
      return r.label === 'Turnover' && r.team === 'our';
    });
    var ourShots = records.filter(function (r) { return r.label === 'Shot' && r.team === 'our'; });
    var ourChances = records.filter(function (r) { return r.label === 'Chance' && r.team === 'our'; });
    var ourGoals = records.filter(function (r) { return r.isGoal && r.team === 'our'; });
    var oppShotChance = records.filter(function (r) {
      return r.team === 'opponent' && (r.label === 'Shot' || r.label === 'Chance');
    });

    return {
      transitionToShot: ratioEnv(
        linkedCount(ourPT, ourShots, TAU_SHOT), ourPT.length, {}, { tau: TAU_SHOT }),
      transitionToChance: ratioEnv(
        linkedCount(ourPT, ourChances, TAU_SHOT), ourPT.length, {}, { tau: TAU_SHOT }),
      transitionToGoal: ratioEnv(
        linkedCount(ourPT, ourGoals, TAU_SHOT), ourPT.length, {}, { tau: TAU_SHOT }),
      turnoversFollowedByOpponentShotOrChance: ratioEnv(
        linkedCount(ourTO, oppShotChance, TAU_TURNOVER), ourTO.length, {}, { tau: TAU_TURNOVER })
    };
  }

  // ---- X6 advisory co-timing ----------------------------------------------

  var COTAG_PAIRS = [
    ['Chance', 'Shot'],
    ['Turnover', 'Negative Transition'],
    ['Foul', 'Card'],
    ['Recovery', 'Press Win']
  ];

  function x6Advisory(records) {
    var pairs = COTAG_PAIRS.map(function (pair) {
      var aRecs = records.filter(function (r) { return r.label === pair[0]; });
      var bRecs = records.filter(function (r) { return r.label === pair[1]; });
      var count = 0;
      bRecs.forEach(function (b) {
        for (var i = 0; i < aRecs.length; i++) {
          var aRec = aRecs[i];
          var sameSeq = !!(aRec.sequenceId && aRec.sequenceId === b.sequenceId);
          var sameTeamFast = !!(aRec.team !== null && aRec.team === b.team &&
            aRec.period === b.period &&
            Math.abs(b.time - aRec.time) > 0 && Math.abs(b.time - aRec.time) <= TAU_COTAG);
          if (sameSeq || sameTeamFast) { count++; break; }
        }
      });
      return { pair: pair[0] + ' / ' + pair[1], count: count };
    });

    // Same-label near-duplicates (the real double-tag risk, spec X6).
    var labelSet = new Set();
    records.forEach(function (r) { labelSet.add(r.label); });
    var sameLabel = orderedLabels(labelSet).map(function (label) {
      var recs = records.filter(function (r) { return r.label === label; });
      var count = 0;
      recs.forEach(function (b) {
        for (var i = 0; i < recs.length; i++) {
          var other = recs[i];
          if (other === b) continue;
          if (b.team !== null && other.team === b.team && b.period === other.period &&
            b.time > other.time && (b.time - other.time) <= TAU_COTAG) { count++; break; }
        }
      });
      return { label: label, count: count };
    }).filter(function (e) { return e.count > 0; });

    return { pairs: pairs, sameLabel: sameLabel, params: { tau: TAU_COTAG } };
  }

  // ---- Players (M-G1/G2/G5, M-L2-G1/G3) -----------------------------------

  function classifyInterpretive(rec) {
    // Pass outcome decides before the generic label sets (a Pass is never
    // positive/negative by label alone).
    if (rec.label === 'Pass') {
      if (hasQual(rec, 'Outcome', 'Successful')) return 'positive';
      if (hasQual(rec, 'Outcome', 'Unsuccessful')) return 'negative';
      return 'neutral';
    }
    if (POSITIVE_LABELS.indexOf(rec.label) !== -1) return 'positive';
    if (NEGATIVE_LABELS.indexOf(rec.label) !== -1) return 'negative';
    if (rec.label === 'Foul') return rec.team === 'our' ? 'negative' : 'neutral';
    return 'neutral';
  }

  function involvedPlayerIds(rec) {
    // Sub events attribute ONLY through playerOff/playerOn (spec M-G2 note);
    // every other label attributes through playerId.
    if (rec.label === 'Sub') {
      var ids = [];
      if (rec.playerOffId) ids.push(rec.playerOffId);
      if (rec.playerOnId) ids.push(rec.playerOnId);
      return ids;
    }
    return rec.playerId ? [rec.playerId] : [];
  }

  function playerMetrics(records, squad, startingXIIds, subOnIds) {
    var byId = {};      // playerId -> aggregates
    var unattributed = { events: 0, byLabelMap: new Map() };
    var labelSet = new Set();

    records.forEach(function (r) {
      labelSet.add(r.label);
      var ids = involvedPlayerIds(r);
      if (ids.length === 0) {
        unattributed.events++;
        unattributed.byLabelMap.set(r.label, (unattributed.byLabelMap.get(r.label) || 0) + 1);
        return;
      }
      ids.forEach(function (pid) {
        if (!byId[pid]) {
          byId[pid] = {
            events: 0, byLabelMap: new Map(), goals: 0, shots: 0, shotsOnTarget: 0,
            chances: 0, keyPasses: 0, crosses: 0, passes: 0, successfulPasses: 0,
            unsuccessfulPasses: 0, presses: 0, pressWins: 0, interceptions: 0,
            recoveries: 0, turnovers: 0, duels: 0, fouls: 0, yellowCards: 0,
            redCards: 0, positiveEvents: 0, negativeEvents: 0, subOn: 0, subOff: 0
          };
        }
        var p = byId[pid];
        p.events++;
        p.byLabelMap.set(r.label, (p.byLabelMap.get(r.label) || 0) + 1);
        if (r.isGoal) p.goals++;
        switch (r.label) {
          case 'Shot':
            p.shots++;
            if (r.subtype === 'On target') p.shotsOnTarget++;
            break;
          case 'Chance': p.chances++; break;
          case 'Key Pass': p.keyPasses++; break;
          case 'Cross': p.crosses++; break;
          case 'Pass':
            p.passes++;
            if (hasQual(r, 'Outcome', 'Successful')) p.successfulPasses++;
            else if (hasQual(r, 'Outcome', 'Unsuccessful')) p.unsuccessfulPasses++;
            break;
          case 'Press': p.presses++; break;
          case 'Press Win': p.pressWins++; break;
          case 'Interception': p.interceptions++; break;
          case 'Recovery': p.recoveries++; break;
          case 'Turnover': p.turnovers++; break;
          case 'Duel': p.duels++; break;
          case 'Foul': p.fouls++; break;
          case 'Card':
            if (r.subtype === 'Yellow') p.yellowCards++;
            else if (r.subtype === 'Red') p.redCards++;
            break;
          case 'Sub':
            if (r.playerOnId === pid) p.subOn++;
            if (r.playerOffId === pid) p.subOff++;
            break;
        }
        var cls = classifyInterpretive(r);
        if (cls === 'positive') p.positiveEvents++;
        else if (cls === 'negative') p.negativeEvents++;
      });
    });

    function mapToObj(map) {
      var out = {};
      orderedLabels(new Set(map.keys())).forEach(function (l) {
        out[l] = map.get(l);
      });
      return out;
    }

    var appearanceIds = {};
    startingXIIds.forEach(function (pid) { appearanceIds[pid] = true; });
    subOnIds.forEach(function (pid) { appearanceIds[pid] = true; });

    var list = Object.keys(byId).map(function (pid) {
      var p = byId[pid];
      var squadEntry = null;
      if (Array.isArray(squad)) {
        for (var i = 0; i < squad.length; i++) {
          if (squad[i] && squad[i].id === pid) { squadEntry = squad[i]; break; }
        }
      }
      var knownOut = p.successfulPasses + p.unsuccessfulPasses;
      return {
        playerId: pid,
        name: squadEntry ? squadEntry.name : 'Unknown player',
        number: squadEntry ? (squadEntry.number || '') : '',
        appearance: !!appearanceIds[pid],
        events: p.events,
        byLabel: mapToObj(p.byLabelMap),
        metrics: {
          goals: p.goals, shots: p.shots, shotsOnTarget: p.shotsOnTarget,
          chances: p.chances, keyPasses: p.keyPasses, crosses: p.crosses,
          passes: p.passes,
          passSuccess: ratioEnv(p.successfulPasses, knownOut,
            { unknownOutcome: p.passes - knownOut }),
          presses: p.presses, pressWins: p.pressWins,
          interceptions: p.interceptions, recoveries: p.recoveries,
          turnovers: p.turnovers, duels: p.duels, fouls: p.fouls,
          yellowCards: p.yellowCards, redCards: p.redCards,
          positiveEvents: p.positiveEvents, negativeEvents: p.negativeEvents,
          subOn: p.subOn, subOff: p.subOff
        }
      };
    });

    // Deterministic sort: total events desc, then playerId asc.
    list.sort(function (a, b) {
      if (b.events !== a.events) return b.events - a.events;
      return a.playerId < b.playerId ? -1 : (a.playerId > b.playerId ? 1 : 0);
    });

    return {
      classification: 'INTERPRETIVE',
      note: 'positive/negative event counts are an interpretation layer, not a player-quality measurement (spec M-L2-G3)',
      list: list,
      unattributed: { events: unattributed.events, byLabel: mapToObj(unattributed.byLabelMap) }
    };
  }

  // ---- Sequences (derived grouping, spec §9.2) -----------------------------

  function sequenceMetrics(records) {
    var groups = {};
    var order = [];
    records.forEach(function (r) {
      if (!r.sequenceId) return;
      if (!groups[r.sequenceId]) { groups[r.sequenceId] = { recs: [], periods: new Set() }; order.push(r.sequenceId); }
      groups[r.sequenceId].recs.push(r);
      groups[r.sequenceId].periods.add(r.period);
    });
    // Sequence ids are per-match monotonic SEQ-NNN; sort ascending (string
    // sort is equivalent for the zero-padded format, and deterministic for
    // any custom format too).
    order.sort();

    var list = order.map(function (seqId) {
      var g = groups[seqId];
      var first = g.recs[0];
      var last = g.recs[g.recs.length - 1];
      var containsTransition = g.recs.some(function (r) {
        return r.label === 'Positive Transition' || r.label === 'Negative Transition';
      });
      var spansPeriods = g.periods.size > 1;
      return {
        sequenceId: seqId,
        eventCount: g.recs.length,
        firstTime: roundHalfUp1(first.time),
        lastTime: roundHalfUp1(last.time),
        duration: roundHalfUp1(Math.max(0, last.time - first.time)),
        containsTransition: containsTransition,
        spansPeriods: spansPeriods,
        team: first.team
      };
    });

    var withTransition = list.filter(function (s) { return s.containsTransition; }).length;
    var nonSpanning = list.filter(function (s) { return !s.spansPeriods; });
    var meanDuration = nonSpanning.length > 0
      ? roundHalfUp1(nonSpanning.reduce(function (acc, s) { return acc + s.duration; }, 0) / nonSpanning.length)
      : null;
    var meanEventCount = list.length > 0
      ? roundHalfUp1(list.reduce(function (acc, s) { return acc + s.eventCount; }, 0) / list.length)
      : null;

    return {
      total: list.length,
      withTransition: withTransition,
      meanEventCount: meanEventCount,
      meanDurationSeconds: meanDuration,
      spanningCount: list.length - nonSpanning.length,
      note: 'meanDurationSeconds excludes sequences spanning period boundaries (spec §9.2)',
      list: list
    };
  }

  // ---- X3 completeness -----------------------------------------------------

  function completenessIndex(records) {
    function entry(scope, field, predicate, totalPredicate) {
      var total = 0, withValue = 0;
      records.forEach(function (r) {
        if (!totalPredicate(r)) return;
        total++;
        if (predicate(r)) withValue++;
      });
      return { scope: scope, field: field, withValue: withValue, total: total, share: pct1(withValue, total) };
    }
    var isShot = function (r) { return r.label === 'Shot'; };
    var isPass = function (r) { return r.label === 'Pass'; };
    var isPoss = function (r) { return r.label === 'Possession' && r.isInterval; };
    var isCard = function (r) { return r.label === 'Card'; };
    return [
      entry('Shot', 'subtype', function (r) { return !!r.subtype; }, isShot),
      entry('Pass', 'Outcome qualifier', function (r) { return qual(r, 'Outcome') !== null; }, isPass),
      entry('Pass', 'subtype', function (r) { return !!r.subtype; }, isPass),
      entry('Pass', 'Pressure qualifier', function (r) { return qual(r, 'Pressure') !== null; }, isPass),
      entry('Possession', 'Ended-by qualifier', function (r) { return qual(r, 'Ended by') !== null; }, isPoss),
      entry('Card', 'subtype', function (r) { return !!r.subtype; }, isCard),
      entry('All events', 'location', function (r) { return !!r.location; }, function () { return true; }),
      entry('All events', 'team', function (r) { return r.team !== null; }, function () { return true; }),
      entry('All events', 'player attribution', function (r) { return involvedPlayerIds(r).length > 0; }, function () { return true; })
    ];
  }

  // ---- X1 reconciliation -----------------------------------------------------

  function parseManualScore(matchInfo) {
    if (!isPlainObject(matchInfo)) return null;
    var f = parseInt(String(matchInfo.ourScore == null ? '' : matchInfo.ourScore).trim(), 10);
    var a = parseInt(String(matchInfo.opponentScore == null ? '' : matchInfo.opponentScore).trim(), 10);
    if (isFinite(f) && isFinite(a)) return { for: f, against: a };
    return null;
  }

  // ---- Main entry point ------------------------------------------------------

  // session: { events, matchInfo, matchClock, squad, tags } — read-only.
  function computeMatchAnalytics(session) {
    session = isPlainObject(session) ? session : {};

    // VALIDATION
    var v = validateAndNormalize(session.events);
    var records = v.records;

    var matchInfo = isPlainObject(session.matchInfo) ? session.matchInfo : null;
    if (session.matchInfo !== undefined && !isPlainObject(session.matchInfo)) {
      v.issues.push({ code: 'MISSING_MATCHINFO', count: 1 });
      v.issues.sort(function (a, b) { return a.code < b.code ? -1 : (a.code > b.code ? 1 : 0); });
    }
    var matchClock = isPlainObject(session.matchClock) ? session.matchClock : null;
    var squad = Array.isArray(session.squad) ? session.squad : [];

    // --- match-level facts ---------------------------------------------------
    var anyET = records.some(function (r) {
      return r.period === 'ET1' || r.period === 'ET2' || r.period === 'ET_HT';
    }) || (matchClock && (matchClock.period === 'ET1' || matchClock.period === 'ET2' || matchClock.period === 'ET_HT'));
    var durationMinutes = anyET ? 120 : 90;

    var inPlay = 0, nonPlay = 0, unknownPeriod = 0, stoppageCount = 0;
    var periodsPlayedSet = {};
    var stoppageByPeriod = { '1H': false, '2H': false, 'ET1': false, 'ET2': false };
    records.forEach(function (r) {
      if (inPlayPeriod(r)) {
        inPlay++;
        periodsPlayedSet[r.period] = true;
        if (isStoppage(r)) { stoppageCount++; stoppageByPeriod[r.period] = true; }
      } else if (nonPlayPeriod(r)) nonPlay++;
      else unknownPeriod++;
    });
    var periodsPlayed = PLAY_PERIODS.filter(function (p) { return !!periodsPlayedSet[p]; });

    var locatedCount = records.filter(function (r) { return !!r.location; }).length;
    var unattributedTeamCount = records.filter(function (r) { return r.team === null; }).length;

    // --- Gates (X-group; must run before derived/state metrics) -------------
    var goals = attributedGoals(records);
    var chain = chainFinalScore(goals);
    var manual = parseManualScore(matchInfo);
    var x1Status = manual === null ? 'MANUAL-EMPTY' : (manual.for === chain.for && manual.against === chain.against ? 'MATCH' : 'MISMATCH');

    var ourM = countTeamMetrics(teamPartition(records, 'our'));
    var oppM = countTeamMetrics(teamPartition(records, 'opponent'));
    var unattrM = countTeamMetrics(teamPartition(records, null));

    var ourPoss = possessionMetrics(teamPartition(records, 'our'));
    var oppPoss = possessionMetrics(teamPartition(records, 'opponent'));
    // Unattributed possession intervals form the explicit Unknown bucket of
    // the team partition (honest reporting, P4): they are excluded from the
    // tagged share denominator and the exclusion is reported on the envelope.
    var unattrPoss = possessionMetrics(teamPartition(records, null));

    var x4 = {
      our: { presses: ourM.presses, pressWins: ourM.pressWins, flag: ourM.pressWins > ourM.presses },
      opponent: { presses: oppM.presses, pressWins: oppM.pressWins, flag: oppM.pressWins > oppM.presses }
    };
    var x5 = {
      our: { goals: ourM.goals, shots: ourM.shots, flag: ourM.goals > ourM.shots },
      opponent: { goals: oppM.goals, shots: oppM.shots, flag: oppM.goals > oppM.shots }
    };
    var x2ByLabel = {};
    var unattrLabelSet = new Set();
    records.forEach(function (r) { if (r.team === null) unattrLabelSet.add(r.label); });
    orderedLabels(unattrLabelSet).forEach(function (l) {
      x2ByLabel[l] = records.filter(function (r) { return r.team === null && r.label === l; }).length;
    });

    // --- LEVEL 1 -------------------------------------------------------------
    var level1 = {
      team: {
        our: teamEnvelope(ourM),
        opponent: teamEnvelope(oppM),
        unattributed: teamEnvelope(unattrM)
      },
      possession: { our: ourPoss, opponent: oppPoss, unattributed: unattrPoss },
      attributes: {
        shotsBySituation: attributeDistribution(records, 'Shot', 'Situation', SHOT_SITUATIONS),
        shotsByBodyPart: attributeDistribution(records, 'Shot', 'Body part', BODY_PARTS_SHOT),
        goalsByBodyPart: attributeDistribution(records, 'Goal', 'Body part', BODY_PARTS_GOAL),
        foulsByZoneQualifier: attributeDistribution(records, 'Foul', 'Zone', FOUL_ZONES)
      },
      spatial: {
        locatedEvents: countEnv(locatedCount, { location: records.length - locatedCount })
      }
    };

    // Zone / third / channel / period / state / minute-bin counts (M-E2..E4
    // and the L3 operators applied to ALL events).
    var zoneCounts = {}; var thirdCounts = {}; var channelCounts = {};
    var zoneOrder = [];
    THIRDS.forEach(function (t) {
      CHANNELS.forEach(function (c) { zoneOrder.push(t + ' · ' + c); zoneCounts[t + ' · ' + c] = zeroBucket(); });
    });
    zoneCounts['Unlocated'] = zeroBucket();
    THIRDS.forEach(function (t) { thirdCounts[t] = zeroBucket(); });
    CHANNELS.forEach(function (c) { channelCounts[c] = zeroBucket(); });
    thirdCounts['Unlocated'] = zeroBucket();
    channelCounts['Unlocated'] = zeroBucket();

    var byPeriod = {};
    PERIOD_ORDER.forEach(function (p) {
      byPeriod[p] = { counts: zeroBucket(), stoppage: zeroBucket() };
    });
    var MINUTE_BINS = ['1H 0-15', '1H 15-30', '1H 30-45+', '2H 45-60', '2H 60-75', '2H 75-90+',
      'ET1 105-112', 'ET1 112-120+', 'ET2 120-127', 'ET2 127+', 'Non-play', 'Unknown'];
    var byMinuteBin = {};
    MINUTE_BINS.forEach(function (b) { byMinuteBin[b] = zeroBucket(); });
    var byState = { WINNING: zeroBucket(), DRAW: zeroBucket(), LOSING: zeroBucket() };

    records.forEach(function (r) {
      addToBucket(zoneCounts[zoneKey(r)], r);
      addToBucket(thirdCounts[thirdKey(r)], r);
      addToBucket(channelCounts[channelKey(r)], r);
      var pb = periodBucket(r);
      addToBucket(byPeriod[pb].counts, r);
      if (isStoppage(r)) addToBucket(byPeriod[pb].stoppage, r);
      addToBucket(byMinuteBin[minuteBin(r)], r);
      addToBucket(byState[r.stateBefore], r);
    });

    // --- LEVEL 2 -------------------------------------------------------------
    var matchEndSeconds = durationMinutes * 60;

    // Pressure-split pass success needs per-partition record access
    // (deterministic single pass per partition).
    function pressureSplits(teamVal) {
      var underSucc = 0, underTotal = 0, freeSucc = 0, freeTotal = 0;
      records.forEach(function (r) {
        if (r.label !== 'Pass' || r.team !== teamVal) return;
        var succ = hasQual(r, 'Outcome', 'Successful');
        if (hasQual(r, 'Pressure', 'Under pressure')) { underTotal++; if (succ) underSucc++; }
        else if (hasQual(r, 'Pressure', 'Free')) { freeTotal++; if (succ) freeSucc++; }
      });
      return { underPressure: [underSucc, underTotal], free: [freeSucc, freeTotal] };
    }
    var ourPS = pressureSplits('our');
    var oppPS = pressureSplits('opponent');

    function teamDerived(m, poss, otherPoss, ps) {
      var knownOutcomePasses = m.successfulPasses + m.unsuccessfulPasses;
      // Tagged Possession Share (M-L2-B4): computed from the FULL UNROUNDED
      // interval seconds (possession.totalSecondsExact); rounding happens
      // only on the displayed value (spec §12.3). Never labelled "possession
      // %" (NC-1) — the envelope carries the naming, both tagged durations
      // and the limitation note.
      var share = taggedPossessionShareEnvelope(poss, otherPoss, unattrPoss.totalSecondsExact, matchEndSeconds);
      return {
        shotAccuracy: ratioEnv(m.shotsOnTarget, m.shotsOnTarget + m.shotsOffTarget,
          { blocked: m.shotsBlocked, unknownOutcome: m.shotsUnknownOutcome }),
        shotConversion: ratioEnv(m.goals, m.shots),
        chanceConversion: ratioEnv(m.goals, m.chances),
        passSuccess: ratioEnv(m.successfulPasses, knownOutcomePasses,
          { unknownOutcome: m.passesUnknownOutcome }),
        pressureSplitPassSuccess: {
          underPressure: ratioEnv(ps.underPressure[0], ps.underPressure[1]),
          free: ratioEnv(ps.free[0], ps.free[1])
        },
        passSubtypeProfile: {
          shares: {
            Progressive: pct1(m.progressivePasses, m.progressivePasses + m.lateralPasses + m.backwardPasses + m.longPasses),
            Lateral: pct1(m.lateralPasses, m.progressivePasses + m.lateralPasses + m.backwardPasses + m.longPasses),
            Backward: pct1(m.backwardPasses, m.progressivePasses + m.lateralPasses + m.backwardPasses + m.longPasses),
            Long: pct1(m.longPasses, m.progressivePasses + m.lateralPasses + m.backwardPasses + m.longPasses)
          },
          knownTotal: m.progressivePasses + m.lateralPasses + m.backwardPasses + m.longPasses,
          excluded: { unknownSubtype: m.passesUnknownSubtype }
        },
        ballWinningEvents: countEnv(m.recoveries + m.interceptions),
        pressWinRatio: ratioEnv(m.pressWins, m.presses),
        taggedPossessionShare: share,
        per90: {
          goals: { value: roundHalfUp1(m.goals * 90 / durationMinutes), params: { durationMinutes: durationMinutes } },
          shots: { value: roundHalfUp1(m.shots * 90 / durationMinutes), params: { durationMinutes: durationMinutes } },
          passes: { value: roundHalfUp1(m.passes * 90 / durationMinutes), params: { durationMinutes: durationMinutes } },
          chances: { value: roundHalfUp1(m.chances * 90 / durationMinutes), params: { durationMinutes: durationMinutes } },
          presses: { value: roundHalfUp1(m.presses * 90 / durationMinutes), params: { durationMinutes: durationMinutes } },
          turnovers: { value: roundHalfUp1(m.turnovers * 90 / durationMinutes), params: { durationMinutes: durationMinutes } }
        }
      };
    }

    var level2Our = teamDerived(ourM, ourPoss, oppPoss, ourPS);
    var level2Opp = teamDerived(oppM, oppPoss, ourPoss, oppPS);

    // M-L2-E1 located-event share per label.
    var labelSet = new Set();
    records.forEach(function (r) { labelSet.add(r.label); });
    var locatedShareByLabel = orderedLabels(labelSet).map(function (l) {
      var total = 0, located = 0;
      records.forEach(function (r) {
        if (r.label !== l) return;
        total++;
        if (r.location) located++;
      });
      return { label: l, located: located, total: total, share: pct1(located, total) };
    });

    // M-X1 gate (spec §5 audit group): game-state metrics (M-L2-F1/F2 and the
    // CT-STATE context) are only valid when the chain reconciles or the
    // manual score is empty. On MISMATCH both are suppressed with the reason.
    var scoreState = x1Status === 'MISMATCH'
      ? {
        changes: { value: null, excluded: {}, reason: 'SCORE_RECONCILIATION_MISMATCH' },
        durationSeconds: null,
        durationReason: 'SCORE_RECONCILIATION_MISMATCH',
        params: { matchEndSeconds: durationMinutes * 60 }
      }
      : scoreStateMetrics(records, durationMinutes);
    var transitions = transitionMetrics(records);

    var level2 = {
      team: { our: level2Our, opponent: level2Opp },
      attributeShares: {
        shotsBySituation: attributeShares(level1.attributes.shotsBySituation),
        shotsByBodyPart: attributeShares(level1.attributes.shotsByBodyPart),
        goalsByBodyPart: attributeShares(level1.attributes.goalsByBodyPart),
        foulsByZoneQualifier: attributeShares(level1.attributes.foulsByZoneQualifier)
      },
      transitions: transitions,
      scoreState: scoreState,
      spatial: { locatedEventShareByLabel: locatedShareByLabel }
    };

    // --- LEVEL 3 (context operators; state gated by X1) ------------------------
    var stateGate = x1Status === 'MISMATCH'
      ? { passed: false, reason: 'SCORE_RECONCILIATION_MISMATCH' }
      : { passed: true, reason: null };

    var level3 = {
      stateGate: stateGate,
      byState: stateGate.passed ? byState : null,
      stateSuppressedReason: stateGate.passed ? null : stateGate.reason,
      byPeriod: byPeriod,
      byMinuteBin: byMinuteBin,
      byZone: zoneCounts,
      byThird: thirdCounts,
      byChannel: channelCounts,
      excluded: {
        unlocated: records.length - locatedCount,
        unknownPeriod: unknownPeriod,
        unattributedTeam: unattributedTeamCount
      }
    };

    // --- Players / sequences ---------------------------------------------------
    var startingXIIds = [];
    if (matchInfo && Array.isArray(matchInfo.startingXI)) {
      matchInfo.startingXI.forEach(function (s) {
        if (s && typeof s.playerId === 'string' && s.playerId) startingXIIds.push(s.playerId);
      });
    }
    var subOnIds = [];
    records.forEach(function (r) {
      if (r.label === 'Sub' && r.playerOnId) subOnIds.push(r.playerOnId);
    });

    var players = playerMetrics(records, squad, startingXIIds, subOnIds);
    var sequences = sequenceMetrics(records);

    // --- Assemble the MATCH ANALYTICS OBJECT -----------------------------------
    return {
      spec: SPEC,
      engine: { version: VERSION, deterministic: true },
      input: {
        eventCount: v.rawCount,
        eventsUsed: records.length,
        eventsSkipped: v.skipped,
        matchInfo: matchInfo ? {
          opponent: matchInfo.opponent || '',
          date: matchInfo.date || '',
          competition: matchInfo.competition || '',
          venue: matchInfo.venue || '',
          homeAway: matchInfo.homeAway || '',
          formation: matchInfo.formation || ''
        } : null
      },
      validation: { issues: v.issues },
      matchSummary: {
        opponent: matchInfo ? (matchInfo.opponent || '') : '',
        date: matchInfo ? (matchInfo.date || '') : '',
        competition: matchInfo ? (matchInfo.competition || '') : '',
        homeAway: matchInfo ? (matchInfo.homeAway || '') : '',
        formation: matchInfo ? (matchInfo.formation || '') : '',
        totalEvents: records.length,
        locatedEvents: locatedCount,
        unattributedEvents: unattributedTeamCount,
        inPlayEvents: inPlay,
        nonPlayEvents: nonPlay,
        unknownPeriodEvents: unknownPeriod,
        stoppageEvents: stoppageCount,
        periodsPlayed: periodsPlayed,
        stoppageByPeriod: stoppageByPeriod,
        durationMinutes: durationMinutes,
        score: {
          chain: { for: chain.for, against: chain.against, attributedGoals: goals.length },
          manual: manual,
          reconciliation: x1Status,
          liveClock: matchClock && isFinNum(matchClock.scoreFor) && isFinNum(matchClock.scoreAgainst)
            ? { for: matchClock.scoreFor, against: matchClock.scoreAgainst } : null
        }
      },
      gates: {
        X1_scoreReconciliation: {
          status: x1Status,
          chain: { for: chain.for, against: chain.against },
          manual: manual,
          detail: x1Status === 'MISMATCH'
            ? 'manual matchInfo score disagrees with the attributed goal chain'
            : (x1Status === 'MANUAL-EMPTY' ? 'manual score not set; chain is the reference' : 'chain equals manual score')
        },
        X2_unattributedEvents: { total: unattributedTeamCount, byLabel: x2ByLabel },
        X3_completeness: completenessIndex(records),
        X4_pressConsistency: x4,
        X5_goalShotCoTag: x5,
        X6_coTagAdvisory: x6Advisory(records)
      },
      level1: level1,
      level3CountsNote: 'byZone/byThird/byChannel/byPeriod/byMinuteBin/byState carry plain counts over the 3x3 model and fixed period bins; unknown buckets are explicit',
      level3: level3,
      level2: level2,
      sequences: sequences,
      players: players,
      protocol: {
        notes: [
          'TAGGED_UNIVERSE: every metric counts TAGGED events only; completeness is reported, never extrapolated',
          'PRIMARY_EVENT_COUNTING: metrics of different constructs are never summed; ratios carry explicit denominators',
          'MINUTE_BINS: derived from (period, matchSeconds); officialMinute folds stoppage ambiguously and is not used',
          'VIDEO_INTERVAL_TIMES: interval bounds may be video-clock times when a video was linked at tagging time',
          'SUB_ATTRIBUTION: Sub events attribute players via playerOff/playerOn only (spec M-G2)',
          'SCORE_STATE: state describes the score BEFORE the event (scoreForBefore/scoreAgainstBefore)',
          'TAGGED_POSSESSION_SHARE (M-L2-B4): the PitchLog tagging model does NOT provide a complete independent possession dataset — every possession-duration figure is based ONLY on recorded Possession interval tags, uses the full unrounded interval seconds internally, preserves the raw interval list, and reports OUR + OPPONENT tagged durations with a limitation note. It is never presented as "Possession %" or as an official match possession statistic (NC-1); when tagged data is insufficient the share is null with the reason stated'
        ],
        params: { tauShot: TAU_SHOT, tauTurnover: TAU_TURNOVER, tauCoTagAdvisory: TAU_COTAG },
        canonicalLabels: CANONICAL_LABELS.slice()
      }
    };
  }

  return {
    computeMatchAnalytics: computeMatchAnalytics,
    VERSION: VERSION,
    SPEC: SPEC
  };
});
