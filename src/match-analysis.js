// PitchLog / MatchTag — MATCH ANALYSIS DASHBOARD (Stage 4A) V1
// =====================================================================
// File: src/match-analysis.js
// Spec: docs/match-analysis-dashboard-specification.md (V1.1 — AUTHORITATIVE).
//
// A dedicated, full-view, READ-ONLY analytical projection of the tagged
// match data of one session. The dashboard is a PURE CONSUMER of the
// analytics engine (src/analytics.js): every aggregate it renders comes
// from computeMatchAnalytics(session) output (§2); the only direct reads
// of the session are the raw event records behind the chronological
// key-event list (§5) and the match metadata of the header (§13.1).
//
// Laws implemented here (spec section numbers):
//   §2  Host-API injection. The renderer supplies the session snapshot and
//       the host methods (seekTo, resolvePlayer, pitchMarkingsSvg, zone-line
//       markup, density fills/step). This module never reads renderer
//       window globals, never duplicates a renderer constant (pitch
//       markings, zone lines and the density ramp enter through the host),
//       and never touches the DOM outside the container it is given.
//   §3  Pitch & spatial: shared 700×450 viewBox, x*700 / y*450 mapping,
//       engine 3×3 grid (thirds on x, channels on y, row-major
//       cells[ti*3+ci]), minimum-sample gate read from
//       A.spatial.params.minSampleForDensity (never hard-coded), per-grid
//       relative colour scale via the host density accessors, no KDE / blur
//       / gradients / video. Below the threshold: null state with reason,
//       no fills, no printed counts — the numeric table still renders.
//   §4  Exactly 10 key-event summary cards, countOf-guarded reads from the
//       A.level1.team.{our,opponent} envelopes ONLY, format "our · opponent",
//       a genuine zero renders a plain 0.
//   §5  Chronological key events built from the RAW session event list,
//       nine qualifying labels, 'Sub' displays as 'Substitution',
//       'Positive Transition' verbatim, sorted COPY by (time asc, id asc),
//       rows carry data-videotime / data-time, activation seeks
//       host.seekTo(ev.videoTime ?? ev.time), list length never shown as a
//       metric, empty state enumerates the classes in display form.
//   §6  Single-execution contract: renderAnalysis is the orchestration
//       point — computeMatchAnalytics + computeSpatialView run once each
//       per render pass and are shared into buildModel(session, host,
//       precomputed?). buildModel's own engine calls are fallbacks for
//       direct/test callers only. No module-level caching across modal
//       opens or sessions.
//   §7  playerId preserved verbatim end-to-end; names resolved ONLY
//       through host.resolvePlayer (the app's single resolver chain); no
//       name merging, no second resolver.
//   §8  Safety: no programmatic .click anywhere (the D2 regression rule —
//       zone cells activate through ONE shared function called by both the
//       pointer path and the keyboard path), zone-cell keyboard access via
//       Enter/Space event delegation with preventDefault and NO
//       stopPropagation, the session snapshot is never mutated, zero
//       console calls, no schema / persistence / IPC.
//   §13 Section inventory: match header, cards, chronological key events,
//       team summary & performance, period analysis, spatial, player
//       analysis (counts + ratios, no per-90), sequences list (no diagrams,
//       no narratives), protocol notes (read-only). Every displayed value
//       comes from the named engine structure or session metadata (§13.10
//       sourcing law); a null ratio renders not-applicable ("n/a") per
//       metric spec P5, never as 0.
//
// UMD: window.MatchAnalysisDashboard in the renderer (loaded AFTER the
// engine family, BEFORE renderer.js), module.exports in Node (tests).
// Requires the Analytics Engine at load time (require('./analytics.js') /
// root.AnalyticsEngine). No new dependencies (spec §2).

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./analytics.js'));
  } else {
    root.MatchAnalysisDashboard = factory(root.AnalyticsEngine);
  }
})(typeof self !== 'undefined' ? self : this, function (AnalyticsEngine) {
  'use strict';

  var SPEC = 'PitchLog-MATCH-ANALYSIS-DASHBOARD-V1.1';
  var VERSION = '1.0.0';

  // ---- Fixed vocabularies (spec law; engine is the authority) -------------

  // §4 + §13.2: exactly ten count envelope fields, in card order. The
  // engine guarantees the shape (countEnv, analytics.js:118-120 — value is
  // a counter, always numeric, never null); the countOf guard below is
  // defensive only.
  var KEY_COUNT_FIELDS = [
    'goals', 'shots', 'chances', 'crosses', 'corners', 'fouls',
    'yellowCards', 'redCards', 'substitutions', 'positiveTransitions'
  ];

  // §4: sentence-case card labels — the app's Analytics-tab precedents
  // (renderer.js:4437 'Substitutions', :4451 'Positive transitions').
  var CARD_LABELS = [
    'Goals', 'Shots', 'Chances', 'Crosses', 'Corners', 'Fouls',
    'Yellow cards', 'Red cards', 'Substitutions', 'Positive transitions'
  ];

  // §5: the qualifying-label constant — exactly the nine engine labels
  // (analytics.js:61-63, 436-476). 'Card' is one list label feeding BOTH
  // card classes 7 and 8 (the yellow/red split happens in the engine
  // envelopes), so nine labels map to ten cards.
  var KEY_EVENT_LABELS = [
    'Goal', 'Shot', 'Chance', 'Cross', 'Corner', 'Foul', 'Card', 'Sub',
    'Positive Transition'
  ];

  // §5: display map expands the terse tag labels for humans.
  // 'Positive Transition' renders verbatim (no expansion, no abbreviation).
  var DISPLAY_LABELS = { 'Sub': 'Substitution' };

  // §6 + §13.6: the dashboard renders with fixed default filters (§1 —
  // interactive filtering is Stage 4B). These are the engine's own
  // documented filter defaults (computeSpatialView normalizes every
  // missing filter to '__all__', analytics.js:1432-1441).
  var DEFAULT_SPATIAL_FILTERS = {
    scope: '__all__', team: '__all__', period: '__all__',
    state: '__all__', sequence: '__all__', player: '__all__'
  };

  // §3: the app-wide shared pitch geometry (every pitch view in the app
  // uses the 700×450 viewBox with normalized x*700 / y*450 mapping). The
  // MARKUP drawn in this space (markings, zone lines, density ramp) still
  // comes exclusively from the host — nothing renderer-specific is
  // duplicated here.
  var VIEWBOX_W = 700;
  var VIEWBOX_H = 450;

  // The dashboard's own event-dot rendering (classes carry the visual
  // identity; nothing here is a renderer constant).
  var DOT_RADIUS = 5.5;

  // Metric spec P5 rendering rule (metric-specification.md:177): a null
  // ratio is displayed "n/a", never 0. Zero is reserved for a genuine
  // count of zero qualifying events.
  var RATIO_NA = 'n/a';

  // §13.4: the Level-1 team rows (the same envelopes the app's Analytics
  // tab reads). [label, envelope field] pairs; the combined pass-subtype
  // row is expanded from its four envelopes.
  var L1_COUNT_ROWS = [
    ['Goals', 'goals'],
    ['Shots', 'shots'],
    ['Shots on target', 'shotsOnTarget'],
    ['Shots off target', 'shotsOffTarget'],
    ['Blocked shots', 'shotsBlocked'],
    ['Shots unknown outcome', 'shotsUnknownOutcome'],
    ['Chances', 'chances'],
    ['Crosses', 'crosses'],
    ['Corners', 'corners'],
    ['Fouls', 'fouls'],
    ['Yellow cards', 'yellowCards'],
    ['Red cards', 'redCards'],
    ['Substitutions', 'substitutions'],
    ['Passes', 'passes'],
    ['Successful passes', 'successfulPasses'],
    ['Passes unknown outcome', 'passesUnknownOutcome'],
    ['Passes under pressure', 'passesUnderPressure'],
    ['Presses', 'presses'],
    ['Press wins', 'pressWins'],
    ['Interceptions', 'interceptions'],
    ['Recoveries', 'recoveries'],
    ['Turnovers', 'turnovers'],
    ['Duels', 'duels'],
    ['Positive transitions', 'positiveTransitions'],
    ['Negative transitions', 'negativeTransitions'],
    ['All events', 'events']
  ];

  // §13.4: the Level-2 team derived rows. [label, envelope path, kind].
  var L2_DERIVED_ROWS = [
    ['Shot accuracy (on/(on+off))', 'shotAccuracy', 'ratio'],
    ['Shot conversion (goals/shots)', 'shotConversion', 'ratio'],
    ['Chance conversion (goals/chances)', 'chanceConversion', 'ratio'],
    ['Pass success', 'passSuccess', 'ratio'],
    ['Pass success · under pressure', 'pressureSplitPassSuccess.underPressure', 'ratio'],
    ['Pass success · free', 'pressureSplitPassSuccess.free', 'ratio'],
    ['Ball-winning events (rec+int)', 'ballWinningEvents', 'count'],
    ['Press win ratio', 'pressWinRatio', 'ratio']
  ];

  // §13.7: the player-table columns — per-player counts and ratios as the
  // engine exposes them (A.players.list[].metrics). No per-90, no physical
  // or derived metrics (spec §13.7). [header, field, kind]; 'events' is a
  // row-level field, not a metrics field.
  var PLAYER_COLS = [
    ['Events', 'events', 'count'],
    ['Goals', 'goals', 'count'],
    ['Shots', 'shots', 'count'],
    ['On target', 'shotsOnTarget', 'count'],
    ['Chances', 'chances', 'count'],
    ['Key passes', 'keyPasses', 'count'],
    ['Crosses', 'crosses', 'count'],
    ['Passes', 'passes', 'count'],
    ['Pass success', 'passSuccess', 'ratio'],
    ['Presses', 'presses', 'count'],
    ['Press wins', 'pressWins', 'count'],
    ['Interceptions', 'interceptions', 'count'],
    ['Recoveries', 'recoveries', 'count'],
    ['Turnovers', 'turnovers', 'count'],
    ['Duels', 'duels', 'count'],
    ['Fouls', 'fouls', 'count'],
    ['Yellow', 'yellowCards', 'count'],
    ['Red', 'redCards', 'count'],
    ['Positive', 'positiveEvents', 'count'],
    ['Negative', 'negativeEvents', 'count'],
    ['Sub on', 'subOn', 'count'],
    ['Sub off', 'subOff', 'count']
  ];

  // ---- Small helpers -------------------------------------------------------

  function isFinNum(v) {
    return typeof v === 'number' && isFinite(v);
  }

  function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  var ESCAPE_MAP = {
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  };

  function escapeHtml(s) {
    s = String(s);
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      out += Object.prototype.hasOwnProperty.call(ESCAPE_MAP, ch) ? ESCAPE_MAP[ch] : ch;
    }
    return out;
  }

  // Display rounding (half-up, 1 decimal) — the app-wide display rule
  // (metric spec §12.3); the engine keeps full precision internally.
  function roundHalfUp1(x) {
    return Math.round((x + Number.EPSILON) * 10) / 10;
  }

  // §4: countOf-guarded envelope read — defensive only, never a
  // data-quality fork. The engine guarantees { value, excluded } with an
  // always-numeric value (analytics.js:118-120, 424-523).
  function countOf(env) {
    return env && typeof env.value === 'number' ? env.value : 0;
  }

  // Metric spec P5 rendering rule: a null ratio renders not-applicable
  // ("n/a"), never 0; a computed ratio renders its engine value with %.
  function ratioText(env) {
    if (env && typeof env.value === 'number') return String(env.value) + '%';
    return RATIO_NA;
  }

  // Plain count cell: numeric with plain 0 allowed (§13.4). Defensive
  // against non-numeric junk in hostile/doctored inputs.
  function countText(v) {
    return typeof v === 'number' && isFinite(v) ? String(v) : '0';
  }

  // Display value coercion for session metadata: strings pass through,
  // finite numbers stringify, everything else is empty. Never renders
  // "undefined" / "NaN".
  function textOf(v) {
    if (typeof v === 'string') return v;
    if (typeof v === 'number' && isFinite(v)) return String(v);
    return '';
  }

  // §5: display label — the map expands only 'Sub'.
  function displayLabelOf(label) {
    return Object.prototype.hasOwnProperty.call(DISPLAY_LABELS, label)
      ? DISPLAY_LABELS[label]
      : label;
  }

  function teamLabelOf(team) {
    if (team === 'our') return 'Us';
    if (team === 'opponent') return 'Opponent';
    return '—';
  }

  // §7: the single name chain. The resolver (production:
  // renderer.js resolveMatchdayPlayer :620 → roster.js R3-A) returns an
  // entry { playerId, displayName, shirtNumber, ... } (or the squad-entry
  // shape { id, number, name }); null / a missing entry means the standard
  // app fallback 'Unknown player'. The dashboard never guesses and never
  // builds a second resolver.
  function resolvedPlayerLabel(host, pid) {
    if (!pid || typeof pid !== 'string') return null;
    var r = host && typeof host.resolvePlayer === 'function'
      ? host.resolvePlayer(pid)
      : null;
    if (!r || typeof r !== 'object') return 'Unknown player';
    var name = typeof r.displayName === 'string' && r.displayName
      ? r.displayName
      : (typeof r.name === 'string' && r.name ? r.name : '');
    if (!name) return 'Unknown player';
    var num = null;
    if (r.shirtNumber != null && isFinNum(Number(r.shirtNumber)) && String(r.shirtNumber) !== '') {
      num = String(r.shirtNumber);
    } else if ((typeof r.number === 'string' && r.number) || typeof r.number === 'number') {
      num = String(r.number);
    }
    return num ? num + ' ' + name : name;
  }

  // Nested envelope path read ('pressureSplitPassSuccess.underPressure').
  function readPath(obj, path) {
    var parts = path.split('.');
    var cur = obj;
    for (var i = 0; i < parts.length; i++) {
      if (cur == null) return undefined;
      cur = cur[parts[i]];
    }
    return cur;
  }

  function homeAwayLabel(v) {
    if (v === 'home') return 'Home';
    if (v === 'away') return 'Away';
    return 'Neutral';
  }

  function secText(v) {
    return typeof v === 'number' && isFinite(v) ? String(v) + 's' : RATIO_NA;
  }

  // ---- Model builders (pure projections; §2, §13.10) ----------------------

  // §13.1: session metadata + A.matchSummary. Nothing computed locally.
  function buildHeaderModel(session, A) {
    var mi = isPlainObject(session && session.matchInfo) ? session.matchInfo : {};
    var S = isPlainObject(A && A.matchSummary) ? A.matchSummary : {};
    var sc = isPlainObject(S.score) ? S.score : {};
    var chain = isPlainObject(sc.chain) ? sc.chain : {};
    var manual = sc.manual || null;

    var metaParts = [];
    var competition = textOf(mi.competition) || textOf(S.competition);
    var homeAway = typeof mi.homeAway === 'string' && mi.homeAway
      ? mi.homeAway
      : (typeof S.homeAway === 'string' ? S.homeAway : '');
    var opponent = textOf(mi.opponent) || textOf(S.opponent);
    var date = textOf(mi.date) || textOf(S.date);
    var formation = textOf(mi.formation) || textOf(S.formation);
    var venue = textOf(mi.venue);

    if (competition) metaParts.push(competition);
    if (homeAway) metaParts.push(homeAwayLabel(homeAway));
    if (opponent) metaParts.push('vs ' + opponent);
    if (date) metaParts.push(date);
    if (formation) metaParts.push(formation);
    if (venue) metaParts.push(venue);

    var scoreNoteParts = [];
    var attributed = typeof chain.attributedGoals === 'number' ? chain.attributedGoals : 0;
    scoreNoteParts.push('goal chain, ' + attributed + ' attributed');
    if (manual && typeof manual.for === 'number' && typeof manual.against === 'number') {
      scoreNoteParts.push('manual ' + manual.for + '–' + manual.against);
    }
    if (typeof sc.reconciliation === 'string' && sc.reconciliation) {
      scoreNoteParts.push('X1 ' + sc.reconciliation);
    }

    return {
      metaText: metaParts.length ? metaParts.join(' · ') : 'No match details set',
      scoreText: countText(chain.for) + '–' + countText(chain.against),
      scoreNote: '(' + scoreNoteParts.join(' · ') + ')',
      totalEvents: typeof S.totalEvents === 'number' ? S.totalEvents : 0,
      locatedEvents: typeof S.locatedEvents === 'number' ? S.locatedEvents : 0,
      periodsPlayed: Array.isArray(S.periodsPlayed) ? S.periodsPlayed.slice() : [],
      durationMinutes: typeof S.durationMinutes === 'number' ? S.durationMinutes : 90
    };
  }

  // §4 + §13.2: the ten cards — countOf-guarded reads from the
  // A.level1.team.{our,opponent} envelopes ONLY (never the event list).
  function buildCardsModel(A) {
    var team = A && A.level1 && A.level1.team ? A.level1.team : {};
    var our = team.our || {};
    var opp = team.opponent || {};
    var cards = [];
    for (var i = 0; i < KEY_COUNT_FIELDS.length; i++) {
      var field = KEY_COUNT_FIELDS[i];
      cards.push({
        key: field,
        label: CARD_LABELS[i],
        our: countOf(our[field]),
        opponent: countOf(opp[field])
      });
    }
    return cards;
  }

  // §5 + §13.3: the chronological key events — built from the RAW session
  // event list (the sanctioned pathway), sorted on a COPY by (time asc,
  // id asc). The source session array is never reordered (§8 purity).
  function keyPlayerText(ev, host) {
    if (ev.label === 'Sub') {
      // Sub events attribute players through playerOff/playerOn only
      // (engine convention, spec M-G2): display "off → on".
      var parts = [];
      if (ev.playerOffId) parts.push(resolvedPlayerLabel(host, ev.playerOffId));
      if (ev.playerOnId) parts.push(resolvedPlayerLabel(host, ev.playerOnId));
      return parts.length ? parts.join(' → ') : null;
    }
    if (ev.playerId) return resolvedPlayerLabel(host, ev.playerId);
    return null;
  }

  function buildKeyEventsModel(session, host) {
    var src = Array.isArray(session && session.events) ? session.events : [];
    var rows = [];
    for (var i = 0; i < src.length; i++) {
      var ev = src[i];
      if (!isPlainObject(ev)) continue;
      var label = typeof ev.label === 'string' ? ev.label : null;
      if (!label || KEY_EVENT_LABELS.indexOf(label) === -1) continue;
      // Canonical read (the engine's own convention, analytics.js:161-165):
      // time falls back to matchTime, then 0; id falls back to the source
      // index when not a finite number.
      var t = isFinNum(ev.time) ? ev.time : (isFinNum(ev.matchTime) ? ev.matchTime : 0);
      var id = isFinNum(ev.id) ? ev.id : i;
      var hasVideoTime = ev.videoTime !== null && ev.videoTime !== undefined;
      rows.push({
        event: ev,
        eventId: id,
        time: t,
        videoTime: hasVideoTime ? ev.videoTime : null,
        label: label,
        displayLabel: displayLabelOf(label),
        team: (ev.team === 'our' || ev.team === 'opponent') ? ev.team : null,
        playerText: keyPlayerText(ev, host)
      });
    }
    // rows is already a derived copy (new array of new row objects) — the
    // session's own array is never touched. Canonical order (time, id).
    rows.sort(function (a, b) {
      if (a.time !== b.time) return a.time - b.time;
      return a.eventId - b.eventId;
    });
    return { rows: rows, empty: rows.length === 0 };
  }

  // §13.4: team summary & performance — A.level1.team + A.level2 team
  // structures (possession tagging, outcomes, score-state, transitions).
  function buildTeamModel(A) {
    var L1 = A && A.level1 ? A.level1 : {};
    var L2 = A && A.level2 ? A.level2 : {};
    var T1 = L1.team || {};
    var our = T1.our || {};
    var opp = T1.opponent || {};
    var unattr = T1.unattributed || {};
    var D = (L2.team || {});
    var DOur = D.our || {};
    var DOpp = D.opponent || {};

    // Level 1 counts.
    var l1Rows = [];
    for (var i = 0; i < L1_COUNT_ROWS.length; i++) {
      var field = L1_COUNT_ROWS[i][1];
      l1Rows.push({
        label: L1_COUNT_ROWS[i][0],
        our: countOf(our[field]),
        opponent: countOf(opp[field])
      });
    }
    // Combined pass-subtype row (four envelopes, slash-joined).
    l1Rows.push({
      label: 'Progressive / lateral / backward / long',
      our: [countOf(our.progressivePasses), countOf(our.lateralPasses),
        countOf(our.backwardPasses), countOf(our.longPasses)].join('/'),
      opponent: [countOf(opp.progressivePasses), countOf(opp.lateralPasses),
        countOf(opp.backwardPasses), countOf(opp.longPasses)].join('/')
    });

    // Level 2 derived ratios/counts.
    var l2Rows = [];
    for (var j = 0; j < L2_DERIVED_ROWS.length; j++) {
      var spec = L2_DERIVED_ROWS[j];
      var ourEnv = readPath(DOur, spec[1]);
      var oppEnv = readPath(DOpp, spec[1]);
      l2Rows.push({
        label: spec[0],
        our: spec[2] === 'ratio' ? ratioText(ourEnv) : countText(countOf(ourEnv)),
        opponent: spec[2] === 'ratio' ? ratioText(oppEnv) : countText(countOf(oppEnv))
      });
    }
    // Pass subtype profile (engine shares; P5 null → n/a per share).
    function subtypeProfile(env) {
      var p = env && env.passSubtypeProfile ? env.passSubtypeProfile : null;
      var shares = p && p.shares ? p.shares : {};
      var keys = ['Progressive', 'Lateral', 'Backward', 'Long'];
      var parts = [];
      for (var k = 0; k < keys.length; k++) {
        parts.push(keys[k] + ' ' + ratioText({ value: shares[keys[k]] }));
      }
      return parts.join(' · ');
    }
    l2Rows.push({
      label: 'Pass subtype profile',
      our: subtypeProfile(DOur),
      opponent: subtypeProfile(DOpp)
    });
    // Per-90 (team level — engine-exposed; §13.7's no-per-90 rule is
    // player-specific).
    function per90Text(env) {
      var p = env && env.per90 ? env.per90 : {};
      function v(f) {
        var e = p[f];
        return e && typeof e.value === 'number' ? String(e.value) : RATIO_NA;
      }
      return v('goals') + ' · ' + v('shots') + ' · ' + v('passes');
    }
    l2Rows.push({
      label: 'Per-90 (goals · shots · passes)',
      our: per90Text(DOur),
      opponent: per90Text(DOpp)
    });

    // Possession tagging (M-L2-B4 constraint inherited: recorded Possession
    // interval tags only, never "Possession %", basis + limitation shown).
    var PO = (L1.possession && L1.possession.our) || {};
    var PP = (L1.possession && L1.possession.opponent) || {};
    var PU = (L1.possession && L1.possession.unattributed) || {};
    var shareOur = DOur.taggedPossessionShare || null;
    var shareOpp = DOpp.taggedPossessionShare || null;

    function endedByText(env) {
      var dist = env && env.endReasons ? env.endReasons : null;
      if (!dist || !dist.buckets) return RATIO_NA;
      var parts = [];
      var keys = Object.keys(dist.buckets);
      for (var k = 0; k < keys.length; k++) {
        if (dist.buckets[keys[k]] > 0) parts.push(keys[k] + ' ' + dist.buckets[keys[k]]);
      }
      if (dist.unknown > 0) parts.push('unknown ' + dist.unknown);
      return parts.length ? parts.join(' · ') : RATIO_NA;
    }
    function meanText(env) {
      var m = env && env.meanDuration ? env.meanDuration : null;
      if (m && typeof m.value === 'number') return String(m.value) + 's';
      return RATIO_NA;
    }

    var possession = {
      intervalsOur: countOf(PO.intervals), intervalsOpp: countOf(PP.intervals),
      durationOur: secText(countOf(PO.totalDuration)),
      durationOpp: secText(countOf(PP.totalDuration)),
      meanOur: meanText(PO), meanOpp: meanText(PP),
      endedOur: endedByText(PO), endedOpp: endedByText(PP),
      shareOur: shareOur && typeof shareOur.value === 'number' ? shareOur.value + '%' : RATIO_NA,
      shareOpp: shareOpp && typeof shareOpp.value === 'number' ? shareOpp.value + '%' : RATIO_NA,
      basis: shareOur && typeof shareOur.basis === 'string' ? shareOur.basis : '',
      limitation: shareOur && typeof shareOur.limitation === 'string' ? shareOur.limitation : '',
      unattributedIntervals: countOf(PU.intervals),
      unattributedDuration: secText(countOf(PU.totalDuration))
    };

    // R1 outcomes — per applicable label (engine label set from
    // A.level1.outcomes keys; SUCCESS/FAILURE are the engine's own values).
    var outcomeRows = [];
    var OC = L1.outcomes || {};
    var ocOur = OC.our || {};
    var ocOpp = OC.opponent || {};
    var ocLabels = Object.keys(ocOur);
    for (var m = 0; m < ocLabels.length; m++) {
      var lb = ocLabels[m];
      var o = ocOur[lb] || {};
      var p2 = ocOpp[lb] || {};
      function ocCounts(x) {
        return countOf(x.successCount) + ' / ' + countOf(x.failureCount)
          + ' / ' + countOf(x.unknownOutcomeCount);
      }
      outcomeRows.push({
        label: lb + ' outcome (SUCCESS / FAILURE / unknown)',
        our: ocCounts(o), opponent: ocCounts(p2),
        rateLabel: lb + ' success rate',
        rateOur: ratioText(o.successRate), rateOpp: ratioText(p2.successRate)
      });
    }

    // Score-state (goal-chain based; suppressed with reason on X1
    // MISMATCH — the engine's gate, surfaced verbatim).
    var SS = L2.scoreState || {};
    var scoreState = null;
    if (SS && SS.changes && typeof SS.changes.value === 'number') {
      var dur = SS.durationSeconds || {};
      scoreState = {
        changes: SS.changes.value,
        winning: secText(dur.WINNING),
        drawing: secText(dur.DRAW),
        losing: secText(dur.LOSING)
      };
    } else {
      var reason = (SS && SS.durationReason) || (SS && SS.changes && SS.changes.reason) || '';
      scoreState = { notComputed: reason ? reason : 'insufficient goal data' };
    }

    // Transition linkage (τ reported from the engine envelopes' params).
    var TR = L2.transitions || {};
    function tauOf(env) {
      return env && env.params && typeof env.params.tau === 'number' ? env.params.tau : null;
    }
    var transitionRows = [];
    var trDefs = [
      ['Positive Transition → Shot', 'transitionToShot'],
      ['Positive Transition → Chance', 'transitionToChance'],
      ['Positive Transition → Goal', 'transitionToGoal'],
      ['Turnover → opponent Shot/Chance', 'turnoversFollowedByOpponentShotOrChance']
    ];
    for (var q = 0; q < trDefs.length; q++) {
      var env = TR[trDefs[q][1]] || null;
      var tau = tauOf(env);
      transitionRows.push({
        label: trDefs[q][0] + (tau !== null ? ' (≤' + tau + 's)' : ''),
        our: ratioText(env)
      });
    }

    return {
      l1Rows: l1Rows,
      unattributedEvents: countOf(unattr.events),
      l2Rows: l2Rows,
      possession: possession,
      outcomeRows: outcomeRows,
      scoreState: scoreState,
      transitionRows: transitionRows
    };
  }

  // §13.5: period analysis — A.level3.byPeriod / byMinuteBin exactly as the
  // engine exposes them. No re-binning, no re-aggregation.
  function buildPeriodsModel(A) {
    var L3 = A && A.level3 ? A.level3 : {};
    var byPeriod = L3.byPeriod || {};
    var byMinuteBin = L3.byMinuteBin || {};

    // Column keys: the engine's own bucket-key list (L3_KEYS, exported via
    // the spatial contract model). Fallback: the key order of an actual
    // bucket object (engine insertion order).
    var cellKeys = (A && A.spatial && A.spatial.model && Array.isArray(A.spatial.model.cellKeys)
      && A.spatial.model.cellKeys.length)
      ? A.spatial.model.cellKeys
      : Object.keys((byPeriod['1H'] && byPeriod['1H'].counts) || {});

    var periodRows = [];
    var pKeys = Object.keys(byPeriod);
    for (var i = 0; i < pKeys.length; i++) {
      var b = byPeriod[pKeys[i]] || {};
      var counts = b.counts || {};
      if (countText(counts.events) === '0') continue; // app display convention
      periodRows.push({
        period: pKeys[i],
        stoppage: b.stoppage && typeof b.stoppage.events === 'number' ? b.stoppage.events : 0,
        counts: counts
      });
    }

    var binRows = [];
    var bKeys = Object.keys(byMinuteBin);
    for (var j = 0; j < bKeys.length; j++) {
      var bc = byMinuteBin[bKeys[j]] || {};
      if (countText(bc.events) === '0') continue;
      binRows.push({ bin: bKeys[j], counts: bc });
    }

    return { cellKeys: cellKeys, periodRows: periodRows, binRows: binRows };
  }

  // §13.7: player analysis — A.players.list keyed by playerId. Counts +
  // ratios only. Names resolve through the single resolver chain (§7);
  // rows are keyed by the id alone and never merged.
  function buildPlayersModel(A, host) {
    var PL = A && A.players ? A.players : {};
    var list = Array.isArray(PL.list) ? PL.list : [];
    var rows = [];
    for (var i = 0; i < list.length; i++) {
      var p = list[i] || {};
      var pid = typeof p.playerId === 'string' ? p.playerId : String(i);
      // §7: display name through the single resolver chain; unresolvable
      // ids render the app's standard 'Unknown player' fallback.
      var label = resolvedPlayerLabel(host, pid) || 'Unknown player';
      rows.push({
        playerId: pid,
        label: label,
        appearance: !!p.appearance,
        events: typeof p.events === 'number' ? p.events : 0,
        metrics: p.metrics || {}
      });
    }
    var unattr = PL.unattributed || {};
    return {
      rows: rows,
      note: typeof PL.note === 'string' ? PL.note : '',
      unattributedEvents: typeof unattr.events === 'number' ? unattr.events : 0,
      unattributedByLabel: unattr.byLabel || {}
    };
  }

  // §13.8: sequences — A.sequences rendered as the engine's sequence list.
  // No diagrams, no narratives, no editing (§1).
  function buildSequencesModel(A) {
    var SQ = A && A.sequences ? A.sequences : {};
    var list = Array.isArray(SQ.list) ? SQ.list : [];
    var rows = [];
    for (var i = 0; i < list.length; i++) {
      var s = list[i] || {};
      rows.push({
        sequenceId: textOf(s.sequenceId),
        team: (s.team === 'our' || s.team === 'opponent') ? s.team : null,
        eventCount: typeof s.eventCount === 'number' ? s.eventCount : 0,
        firstTime: typeof s.firstTime === 'number' ? s.firstTime : null,
        lastTime: typeof s.lastTime === 'number' ? s.lastTime : null,
        duration: typeof s.duration === 'number' ? s.duration : null,
        containsTransition: !!s.containsTransition,
        spansPeriods: !!s.spansPeriods
      });
    }
    return {
      total: typeof SQ.total === 'number' ? SQ.total : 0,
      withTransition: typeof SQ.withTransition === 'number' ? SQ.withTransition : 0,
      meanEventCount: typeof SQ.meanEventCount === 'number' ? String(SQ.meanEventCount) : RATIO_NA,
      meanDurationSeconds: typeof SQ.meanDurationSeconds === 'number'
        ? String(SQ.meanDurationSeconds) + 's'
        : RATIO_NA,
      spanningCount: typeof SQ.spanningCount === 'number' ? SQ.spanningCount : 0,
      note: typeof SQ.note === 'string' ? SQ.note : '',
      rows: rows
    };
  }

  // §6: buildModel(session, host, precomputed?). The precomputed engine
  // results are supplied by renderAnalysis in every full render; the
  // fallback computations below exist ONLY for direct/test callers (spec
  // §6). No module-level caching anywhere — every call recomputes.
  function buildModel(session, host, precomputed) {
    session = isPlainObject(session) ? session : {};
    var A;
    var view;
    if (precomputed && precomputed.analytics !== undefined) {
      A = precomputed.analytics;
    } else {
      A = AnalyticsEngine.computeMatchAnalytics(session);
    }
    if (precomputed && precomputed.spatialView !== undefined) {
      view = precomputed.spatialView;
    } else {
      view = AnalyticsEngine.computeSpatialView(A, DEFAULT_SPATIAL_FILTERS);
    }

    // §3: the minimum-sample threshold is READ from the engine param —
    // never hard-coded.
    var minSample = (A && A.spatial && A.spatial.params
      && typeof A.spatial.params.minSampleForDensity === 'number')
      ? A.spatial.params.minSampleForDensity
      : 0;

    return {
      analytics: A,
      spatialView: view,
      minSampleForDensity: minSample,
      header: buildHeaderModel(session, A),
      cards: buildCardsModel(A),
      keyEvents: buildKeyEventsModel(session, host),
      team: buildTeamModel(A),
      periods: buildPeriodsModel(A),
      spatial: {
        grids: (view && Array.isArray(view.grids)) ? view.grids : []
      },
      players: buildPlayersModel(A, host),
      sequences: buildSequencesModel(A),
      protocol: {
        notes: (A && A.protocol && Array.isArray(A.protocol.notes))
          ? A.protocol.notes.slice()
          : [],
        spec: (A && typeof A.spec === 'string') ? A.spec : '',
        engineVersion: (A && A.engine && typeof A.engine.version === 'string')
          ? A.engine.version
          : ''
      }
    };
  }

  // ---- HTML builders (string markup; every dynamic value escaped) ---------

  function sectionOpen(key) {
    return '<section class="ma-section" data-ma-section="' + escapeHtml(key) + '">';
  }

  function sectionTitle(text) {
    return '<h3 class="ma-section-title">' + escapeHtml(text) + '</h3>';
  }

  function buildHeaderHtml(model) {
    var h = model.header;
    var facts = [
      h.totalEvents + ' events used',
      h.locatedEvents + ' located',
      'periods ' + (h.periodsPlayed.length ? h.periodsPlayed.join(', ') : '—'),
      'nominal ' + h.durationMinutes + '′'
    ].join(' · ');
    return sectionOpen('header')
      + '<div class="ma-head">'
      + '<div class="ma-title">Match analysis</div>'
      + '<div class="ma-meta">' + escapeHtml(h.metaText) + '</div>'
      + '<div class="ma-score"><span class="ma-score-value">' + escapeHtml(h.scoreText) + '</span>'
      + ' <span class="ma-score-note">' + escapeHtml(h.scoreNote) + '</span></div>'
      + '<div class="ma-facts">' + escapeHtml(facts) + '</div>'
      + '</div>'
      + '</section>';
  }

  // §4 + §13.2: the ten-card strip. Card format 'our · opponent'; zero
  // renders plain 0.
  function buildCardsHtml(model) {
    var html = sectionOpen('cards')
      + sectionTitle('Key event summary')
      + '<div class="ma-cards">';
    for (var i = 0; i < model.cards.length; i++) {
      var c = model.cards[i];
      html += '<div class="ma-card" data-card="' + escapeHtml(c.key) + '">'
        + '<div class="ma-card-label">' + escapeHtml(c.label) + '</div>'
        + '<div class="ma-card-value">'
        + '<span class="ma-card-our">' + countText(c.our) + '</span>'
        + ' · '
        + '<span class="ma-card-opp">' + countText(c.opponent) + '</span>'
        + '</div>'
        + '</div>';
    }
    html += '</div></section>';
    return html;
  }

  // §5 + §13.3: the chronological list. One row per qualifying key event,
  // in match order. The list's length is never displayed as a metric.
  function buildKeyListHtml(model) {
    var html = sectionOpen('key-events')
      + sectionTitle('Key events — chronological')
      + '<div class="ma-keylist">';
    if (model.keyEvents.empty) {
      // Empty state enumerates the classes in display form (§5).
      var names = [];
      for (var i = 0; i < KEY_EVENT_LABELS.length; i++) {
        names.push(displayLabelOf(KEY_EVENT_LABELS[i]));
      }
      html += '<div class="ma-key-empty">No qualifying key events. The list shows: '
        + escapeHtml(names.join(', ')) + '.</div>';
    } else {
      var rows = model.keyEvents.rows;
      for (var j = 0; j < rows.length; j++) {
        var r = rows[j];
        html += '<button type="button" class="ma-key-row"'
          + ' data-event-id="' + countText(r.eventId) + '"'
          + ' data-label="' + escapeHtml(r.label) + '"'
          + ' data-videotime="' + (isFinNum(r.videoTime) ? escapeHtml(String(r.videoTime)) : '') + '"'
          + ' data-time="' + (isFinNum(r.time) ? escapeHtml(String(roundHalfUp1(r.time))) : '') + '">'
          + '<span class="ma-key-time">' + escapeHtml(String(roundHalfUp1(r.time)) + 's') + '</span>'
          + '<span class="ma-key-label">' + escapeHtml(r.displayLabel) + '</span>'
          + '<span class="ma-key-team">' + escapeHtml(teamLabelOf(r.team)) + '</span>'
          + '<span class="ma-key-player">' + escapeHtml(r.playerText || '—') + '</span>'
          + '</button>';
      }
    }
    html += '</div></section>';
    return html;
  }

  // §13.4: team summary & performance.
  function buildTeamHtml(model) {
    var t = model.team;
    var html = sectionOpen('team') + sectionTitle('Team summary & performance');

    html += '<div class="ma-sub-label">Team comparison — Level 1 counts</div>';
    html += '<table class="ma-table ma-team"><thead><tr><th></th><th class="ma-our">Us</th><th class="ma-opp">Opponent</th></tr></thead><tbody>';
    for (var i = 0; i < t.l1Rows.length; i++) {
      var r1 = t.l1Rows[i];
      html += '<tr><td>' + escapeHtml(r1.label) + '</td>'
        + '<td class="ma-our">' + escapeHtml(String(r1.our)) + '</td>'
        + '<td class="ma-opp">' + escapeHtml(String(r1.opponent)) + '</td></tr>';
    }
    html += '</tbody></table>';
    if (t.unattributedEvents > 0) {
      html += '<div class="ma-note">Unattributed (no team): ' + t.unattributedEvents
        + ' events — excluded from both columns.</div>';
    }

    html += '<div class="ma-sub-label">Team comparison — Level 2 derived</div>';
    html += '<table class="ma-table ma-team"><thead><tr><th></th><th class="ma-our">Us</th><th class="ma-opp">Opponent</th></tr></thead><tbody>';
    for (var j = 0; j < t.l2Rows.length; j++) {
      var r2 = t.l2Rows[j];
      html += '<tr><td>' + escapeHtml(r2.label) + '</td>'
        + '<td class="ma-our">' + escapeHtml(String(r2.our)) + '</td>'
        + '<td class="ma-opp">' + escapeHtml(String(r2.opponent)) + '</td></tr>';
    }
    html += '</tbody></table>';

    var po = t.possession;
    html += '<div class="ma-sub-label">Tagged possession (recorded intervals only)</div>';
    if (po.basis) html += '<div class="ma-note">' + escapeHtml(po.basis) + '.</div>';
    html += '<table class="ma-table ma-team"><thead><tr><th></th><th class="ma-our">Us</th><th class="ma-opp">Opponent</th></tr></thead><tbody>';
    html += teamRow('Tagged possession intervals', po.intervalsOur, po.intervalsOpp);
    html += teamRow('Tagged possession duration', po.durationOur, po.durationOpp);
    html += teamRow('Mean interval duration', po.meanOur, po.meanOpp);
    html += teamRow('Ended by', po.endedOur, po.endedOpp);
    html += teamRow('Tagged Possession Share', po.shareOur, po.shareOpp);
    html += '</tbody></table>';
    if (po.unattributedIntervals > 0) {
      html += '<div class="ma-note">' + po.unattributedIntervals + ' possession interval(s) ('
        + escapeHtml(po.unattributedDuration) + ') have no team attributed and are excluded from the share.</div>';
    }
    if (po.limitation) html += '<div class="ma-note ma-limit">' + escapeHtml(po.limitation) + '</div>';

    if (t.outcomeRows.length) {
      html += '<div class="ma-sub-label">Team outcomes (first-class outcome field)</div>';
      html += '<table class="ma-table ma-team"><thead><tr><th></th><th class="ma-our">Us</th><th class="ma-opp">Opponent</th></tr></thead><tbody>';
      for (var k = 0; k < t.outcomeRows.length; k++) {
        var o = t.outcomeRows[k];
        html += teamRow(o.label, o.our, o.opponent);
        html += teamRow(o.rateLabel, o.rateOur, o.rateOpp);
      }
      html += '</tbody></table>';
    }

    html += '<div class="ma-sub-label">Score state (goal-chain based)</div>';
    if (t.scoreState.notComputed) {
      html += '<div class="ma-note ma-limit">Not computed — '
        + escapeHtml(t.scoreState.notComputed) + '.</div>';
    } else {
      html += '<table class="ma-table"><tbody>';
      html += teamRow('State changes', t.scoreState.changes, '');
      html += teamRow('Time winning', t.scoreState.winning, '');
      html += teamRow('Time drawing', t.scoreState.drawing, '');
      html += teamRow('Time losing', t.scoreState.losing, '');
      html += '</tbody></table>';
    }

    html += '<div class="ma-sub-label">Transitions &amp; linkage (τ reported)</div>';
    html += '<table class="ma-table"><tbody>';
    for (var q = 0; q < t.transitionRows.length; q++) {
      html += teamRow(t.transitionRows[q].label, t.transitionRows[q].our, '');
    }
    html += '</tbody></table>';

    html += '</section>';
    return html;
  }

  function teamRow(label, our, opp) {
    return '<tr><td>' + escapeHtml(label) + '</td>'
      + '<td class="ma-our">' + escapeHtml(String(our)) + '</td>'
      + '<td class="ma-opp">' + escapeHtml(String(opp)) + '</td></tr>';
  }

  // §13.5: period analysis.
  function buildPeriodsHtml(model) {
    var p = model.periods;
    var keys = p.cellKeys;
    var html = sectionOpen('periods') + sectionTitle('Period analysis');

    html += '<div class="ma-sub-label">By period</div>';
    html += '<div class="ma-table-scroll"><table class="ma-table" data-ma-table="byPeriod">';
    html += '<thead><tr><th>Period</th>';
    for (var h = 0; h < keys.length; h++) html += '<th>' + escapeHtml(keys[h]) + '</th>';
    html += '</tr></thead><tbody>';
    for (var i = 0; i < p.periodRows.length; i++) {
      var row = p.periodRows[i];
      html += '<tr data-period="' + escapeHtml(row.period) + '"><td>'
        + escapeHtml(row.period)
        + (row.stoppage > 0 ? ' <span class="ma-excl">(+' + row.stoppage + ' stoppage)</span>' : '')
        + '</td>';
      for (var c = 0; c < keys.length; c++) {
        html += '<td>' + countText(row.counts[keys[c]]) + '</td>';
      }
      html += '</tr>';
    }
    html += '</tbody></table></div>';

    html += '<div class="ma-sub-label">By minute bin (period + match seconds)</div>';
    html += '<div class="ma-table-scroll"><table class="ma-table" data-ma-table="byMinuteBin">';
    html += '<thead><tr><th>Bin</th>';
    for (var h2 = 0; h2 < keys.length; h2++) html += '<th>' + escapeHtml(keys[h2]) + '</th>';
    html += '</tr></thead><tbody>';
    for (var b = 0; b < p.binRows.length; b++) {
      var brow = p.binRows[b];
      html += '<tr data-bin="' + escapeHtml(brow.bin) + '"><td>' + escapeHtml(brow.bin) + '</td>';
      for (var c2 = 0; c2 < keys.length; c2++) {
        html += '<td>' + countText(brow.counts[keys[c2]]) + '</td>';
      }
      html += '</tr>';
    }
    html += '</tbody></table></div>';

    html += '</section>';
    return html;
  }

  // §3 + §13.6: spatial analysis. Pitch markings, zone lines and the
  // density ramp come from the host ONLY; the 3×3 grid is the engine's own
  // (row-major cells[ti*3+ci]); minimum-sample gate read from the engine
  // param; per-grid relative colour scale; no KDE / blur / gradients /
  // video. Below the threshold: null state with reason, no fills, no
  // printed counts — the numeric table still renders for every grid.
  function hostZoneLines(host) {
    return host && typeof host.zoneLinesSvg === 'function' ? String(host.zoneLinesSvg()) : '';
  }

  function hostMarkings(host) {
    return host && typeof host.pitchMarkingsSvg === 'function' ? String(host.pitchMarkingsSvg()) : '';
  }

  function hostDensityFills(host) {
    return host && typeof host.densityFills === 'function' && Array.isArray(host.densityFills())
      ? host.densityFills()
      : [];
  }

  function hostDensityStep(host, count, maxCount) {
    if (!host || typeof host.densityStep !== 'function') return 0;
    var s = host.densityStep(count, maxCount);
    return typeof s === 'number' && isFinite(s) ? s : 0;
  }

  function dotMarkup(rec, host) {
    var cls = 'ma-dot';
    if (rec.isGoal) cls += ' ma-dot-goal';
    if (rec.team === 'our') cls += ' ma-dot-our';
    else if (rec.team === 'opponent') cls += ' ma-dot-opponent';
    else cls += ' ma-dot-unattr';
    var cx = (Number(rec.x) * VIEWBOX_W).toFixed(1);
    var cy = (Number(rec.y) * VIEWBOX_H).toFixed(1);
    var pname = rec.playerId ? resolvedPlayerLabel(host, rec.playerId) : null;
    var title = textOf(rec.label) + (rec.subtype ? ' · ' + textOf(rec.subtype) : '')
      + ' · ' + textOf(rec.minuteBin)
      + (pname ? ' · ' + pname : '')
      + (rec.sequenceId ? ' · ' + textOf(rec.sequenceId) : '');
    return '<circle class="' + cls + '" cx="' + cx + '" cy="' + cy + '" r="' + DOT_RADIUS + '">'
      + '<title>' + escapeHtml(title) + '</title></circle>';
  }

  function buildGridSvg(g, model, host) {
    var cells = Array.isArray(g.cells) ? g.cells : [];
    var maxCount = 0;
    for (var i = 0; i < cells.length; i++) {
      var n0 = cells[i] && cells[i].counts ? Number(cells[i].counts.events) : 0;
      if (isFinNum(n0) && n0 > maxCount) maxCount = n0;
    }
    var located = typeof g.located === 'number' ? g.located : 0;
    var insufficient = !(located >= model.minSampleForDensity);
    var fills = hostDensityFills(host);

    var s = '<svg class="ma-grid-svg" viewBox="0 0 ' + VIEWBOX_W + ' ' + VIEWBOX_H
      + '" preserveAspectRatio="xMidYMid meet" role="img" aria-label="'
      + escapeHtml(textOf(g.id)) + ' — tagged event density (3×3)">';

    // Row-major cell rects: thirds on x (ti), channels on y (ci),
    // cells[ti*3+ci] (engine law, analytics.js:1195-1248).
    for (var ti = 0; ti < 3; ti++) {
      for (var ci = 0; ci < 3; ci++) {
        var c = cells[ti * 3 + ci] || {};
        var counts = c.counts || {};
        var n = isFinNum(Number(counts.events)) ? Number(counts.events) : 0;
        var step = insufficient ? 0 : hostDensityStep(host, n, maxCount);
        var x = (ti * VIEWBOX_W / 3).toFixed(2);
        var y = (ci * VIEWBOX_H / 3).toFixed(2);
        var w = (VIEWBOX_W / 3).toFixed(2);
        var h = (VIEWBOX_H / 3).toFixed(2);
        var fill = '';
        if (step > 0 && fills[step]) {
          fill = ' style="fill:' + escapeHtml(String(fills[step])) + ';"';
        }
        s += '<rect class="ma-zcell" x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '"'
          + fill
          + ' data-grid="' + escapeHtml(textOf(g.id)) + '"'
          + ' data-zone="' + escapeHtml(textOf(c.zoneKey)) + '"'
          + ' tabindex="0" role="img" aria-label="' + escapeHtml(textOf(c.zoneKey)) + ': ' + n + ' tagged events"/>';
      }
    }

    // Shared visuals from the host ONLY (never a second copy, §3).
    s += hostZoneLines(host);
    s += hostMarkings(host);

    // Event dots: the ACTUAL recorded points (full precision, no
    // aggregation).
    var evs = Array.isArray(g.events) ? g.events : [];
    for (var d = 0; d < evs.length; d++) {
      if (evs[d] && isFinNum(Number(evs[d].x)) && isFinNum(Number(evs[d].y))) {
        s += dotMarkup(evs[d], host);
      }
    }

    // Printed counts: only when the grid passes the minimum-sample gate.
    if (!insufficient) {
      for (var ti2 = 0; ti2 < 3; ti2++) {
        for (var ci2 = 0; ci2 < 3; ci2++) {
          var c2 = cells[ti2 * 3 + ci2] || {};
          var n2 = c2.counts && isFinNum(Number(c2.counts.events)) ? Number(c2.counts.events) : 0;
          if (n2 === 0) continue;
          var cx = (ti2 * VIEWBOX_W / 3 + VIEWBOX_W / 6).toFixed(2);
          var cy = (ci2 * VIEWBOX_H / 3 + VIEWBOX_H / 6).toFixed(2);
          s += '<text class="ma-zcount" x="' + cx + '" y="' + cy + '">' + n2 + '</text>';
        }
      }
    }

    s += '</svg>';
    return { svg: s, insufficient: insufficient, maxCount: maxCount };
  }

  function buildGridNumericTable(g, cellKeys) {
    var cells = Array.isArray(g.cells) ? g.cells : [];
    var unloc = (g.unlocatedBucket && g.unlocatedBucket.counts) || {};
    var html = '<div class="ma-table-scroll"><table class="ma-table" data-grid-table="'
      + escapeHtml(textOf(g.id)) + '"><thead><tr><th>Zone</th>';
    for (var h = 0; h < cellKeys.length; h++) html += '<th>' + escapeHtml(cellKeys[h]) + '</th>';
    html += '</tr></thead><tbody>';
    for (var i = 0; i < cells.length; i++) {
      var c = cells[i] || {};
      html += '<tr data-zone="' + escapeHtml(textOf(c.zoneKey)) + '"><td>'
        + escapeHtml(textOf(c.zoneKey)) + '</td>';
      for (var k = 0; k < cellKeys.length; k++) {
        html += '<td>' + countText((c.counts || {})[cellKeys[k]]) + '</td>';
      }
      html += '</tr>';
    }
    html += '<tr data-zone="Unlocated"><td>Unlocated</td>';
    for (var k2 = 0; k2 < cellKeys.length; k2++) {
      html += '<td>' + countText(unloc[cellKeys[k2]]) + '</td>';
    }
    html += '</tr></tbody></table></div>';
    return html;
  }

  // Traceability rows for one zone cell (the shared activation target).
  function buildTraceRowsHtml(grid, zoneKey, host) {
    var recs = (Array.isArray(grid.events) ? grid.events : [])
      .filter(function (r) { return r && r.zoneKey === zoneKey; });
    var html = '<div class="ma-trace-title">' + escapeHtml(zoneKey) + ' — ' + recs.length
      + ' located event' + (recs.length === 1 ? '' : 's') + '</div>';
    for (var i = 0; i < recs.length; i++) {
      var r = recs[i];
      var pname = r.playerId ? resolvedPlayerLabel(host, r.playerId) : null;
      html += '<div class="ma-trace-row">'
        + '<span class="ma-trace-bin">' + escapeHtml(textOf(r.minuteBin)) + '</span>'
        + '<span class="ma-trace-label">' + escapeHtml(textOf(r.label))
        + (r.subtype ? ' · ' + escapeHtml(textOf(r.subtype)) : '') + '</span>'
        + '<span class="ma-trace-player">' + escapeHtml(pname || '—') + '</span>'
        + '<span class="ma-trace-team">' + escapeHtml(teamLabelOf(r.team)) + '</span>'
        + '<span class="ma-trace-id">#' + escapeHtml(textOf(r.eventId)) + '</span>'
        + '</div>';
    }
    return html;
  }

  function buildSpatialHtml(model, host) {
    var html = sectionOpen('spatial')
      + sectionTitle('Spatial analysis — tagged event density (3×3)');
    var grids = model.spatial.grids;
    if (!grids.length) {
      html += '<div class="ma-note">Spatial data unavailable.</div>';
      html += '</section>';
      return html;
    }
    var cellKeys = model.periods.cellKeys;
    for (var i = 0; i < grids.length; i++) {
      var g = grids[i] || {};
      var located = typeof g.located === 'number' ? g.located : 0;
      var population = typeof g.population === 'number' ? g.population : 0;
      var unlocated = typeof g.unlocated === 'number' ? g.unlocated : (population - located);
      var share = g.locatedShare && typeof g.locatedShare.value === 'number'
        ? g.locatedShare.value + '%'
        : RATIO_NA;
      var built = buildGridSvg(g, model, host);

      html += '<div class="ma-grid-wrap" data-grid-wrap="' + escapeHtml(textOf(g.id)) + '">';
      html += '<div class="ma-grid-head">' + escapeHtml(textOf(g.scopeLabel)) + ' — '
        + escapeHtml(textOf(g.partitionLabel)) + ' · ' + located + '/' + population
        + ' located events (' + escapeHtml(share) + ')</div>';
      html += built.svg;
      if (built.insufficient) {
        // Null state with reason (spatial spec §5.4 pattern): no fills, no
        // printed counts — the numeric table below still renders.
        html += '<div class="ma-grid-insufficient">Insufficient located events for spatial'
          + ' visualization. (' + located + ' located event' + (located === 1 ? '' : 's')
          + ' in this view — see the table below)</div>';
      } else {
        html += '<div class="ma-grid-max">max = ' + built.maxCount
          + ' (busiest cell) — colour scale is relative to this grid</div>';
      }
      if (unlocated > 0) {
        html += '<div class="ma-unloc-strip">Unlocated: ' + unlocated
          + ' — not shown on the pitch.</div>';
      }
      html += '<div class="ma-trace" data-trace-grid="' + escapeHtml(textOf(g.id)) + '">'
        + '<div class="ma-trace-hint">Select a zone cell to list its located events.</div>'
        + '</div>';
      html += buildGridNumericTable(g, cellKeys);
      html += '</div>';
    }
    html += '</section>';
    return html;
  }

  // §13.7: player analysis.
  function buildPlayersHtml(model) {
    var p = model.players;
    var html = sectionOpen('players') + sectionTitle('Player analysis — counts &amp; ratios (no per-90)');
    if (!p.rows.length) {
      html += '<div class="ma-note">No player-attributed events.</div>';
      html += '</section>';
      return html;
    }
    if (p.note) html += '<div class="ma-note">' + escapeHtml(p.note) + '</div>';
    html += '<div class="ma-table-scroll"><table class="ma-table" data-ma-table="players">';
    html += '<thead><tr><th>Player</th>';
    for (var h = 0; h < PLAYER_COLS.length; h++) {
      html += '<th>' + escapeHtml(PLAYER_COLS[h][0]) + '</th>';
    }
    html += '</tr></thead><tbody>';
    for (var i = 0; i < p.rows.length; i++) {
      var row = p.rows[i];
      html += '<tr data-player-id="' + escapeHtml(row.playerId) + '"><td>'
        + escapeHtml(row.label)
        + (row.appearance ? '' : ' <span class="ma-excl">(no appearance)</span>')
        + '</td>';
      for (var c = 0; c < PLAYER_COLS.length; c++) {
        var col = PLAYER_COLS[c];
        var src = col[1] === 'events' ? row : row.metrics;
        var v = src ? src[col[1]] : undefined;
        html += '<td>' + (col[2] === 'ratio' ? escapeHtml(ratioText(v)) : countText(v)) + '</td>';
      }
      html += '</tr>';
    }
    html += '</tbody></table></div>';
    if (p.unattributedEvents > 0) {
      var parts = [];
      var labels = Object.keys(p.unattributedByLabel);
      for (var l = 0; l < labels.length; l++) {
        parts.push(labels[l] + ' ' + p.unattributedByLabel[labels[l]]);
      }
      html += '<div class="ma-note">' + p.unattributedEvents + ' events have no player attributed'
        + (parts.length ? ' (' + escapeHtml(parts.join(', ')) + ')' : '')
        + '.</div>';
    }
    html += '</section>';
    return html;
  }

  // §13.8: sequences — the engine's list, no diagrams, no narratives.
  function buildSequencesHtml(model) {
    var s = model.sequences;
    var html = sectionOpen('sequences') + sectionTitle('Sequences');
    if (s.total === 0 && !s.rows.length) {
      html += '<div class="ma-note">No sequences tagged.</div>';
      html += '</section>';
      return html;
    }
    html += '<table class="ma-table"><tbody>';
    html += teamRow('Sequences', s.total, s.withTransition + ' contain a transition marker');
    html += teamRow('Mean events / duration', s.meanEventCount,
      s.meanDurationSeconds + ' (' + s.spanningCount + ' span periods, excluded from mean)');
    html += '</tbody></table>';
    if (s.note) html += '<div class="ma-note">' + escapeHtml(s.note) + '</div>';
    html += '<div class="ma-table-scroll"><table class="ma-table" data-ma-table="sequences">';
    html += '<thead><tr><th>Sequence</th><th>Team</th><th>Events</th><th>First</th><th>Last</th>'
      + '<th>Duration</th><th>Transition</th><th>Spans periods</th></tr></thead><tbody>';
    for (var i = 0; i < s.rows.length; i++) {
      var r = s.rows[i];
      html += '<tr data-sequence-id="' + escapeHtml(r.sequenceId) + '">'
        + '<td>' + escapeHtml(r.sequenceId) + '</td>'
        + '<td>' + escapeHtml(teamLabelOf(r.team)) + '</td>'
        + '<td>' + countText(r.eventCount) + '</td>'
        + '<td>' + (r.firstTime === null ? RATIO_NA : escapeHtml(String(r.firstTime) + 's')) + '</td>'
        + '<td>' + (r.lastTime === null ? RATIO_NA : escapeHtml(String(r.lastTime) + 's')) + '</td>'
        + '<td>' + (r.duration === null ? RATIO_NA : escapeHtml(String(r.duration) + 's')) + '</td>'
        + '<td>' + (r.containsTransition ? 'Yes' : 'No') + '</td>'
        + '<td>' + (r.spansPeriods ? 'Yes' : 'No') + '</td>'
        + '</tr>';
    }
    html += '</tbody></table></div>';
    html += '</section>';
    return html;
  }

  // §13.9: protocol notes — read-only.
  function buildProtocolHtml(model) {
    var pr = model.protocol;
    var html = sectionOpen('protocol') + sectionTitle('Protocol notes (read-only)');
    html += '<ul class="ma-protocol-notes">';
    for (var i = 0; i < pr.notes.length; i++) {
      html += '<li>' + escapeHtml(pr.notes[i]) + '</li>';
    }
    html += '</ul>';
    if (pr.spec || pr.engineVersion) {
      html += '<div class="ma-engine">' + escapeHtml(pr.spec)
        + ' · engine v' + escapeHtml(pr.engineVersion) + ' · deterministic</div>';
    }
    html += '</section>';
    return html;
  }

  function buildDashboardHtml(model, host) {
    // §13 section order (V1.1, authoritative).
    return buildHeaderHtml(model)
      + buildCardsHtml(model)
      + buildKeyListHtml(model)
      + buildTeamHtml(model)
      + buildPeriodsHtml(model)
      + buildSpatialHtml(model, host)
      + buildPlayersHtml(model)
      + buildSequencesHtml(model)
      + buildProtocolHtml(model);
  }

  // ---- Interaction (§8 safety laws) ---------------------------------------

  function findKeyEventRow(model, idAttr) {
    var rows = model.keyEvents.rows;
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i].eventId) === idAttr) return rows[i];
    }
    return null;
  }

  // §5: activating a row seeks the video — videoTime-first fallback, the
  // app's event-list convention (renderer.js:1395 is the seek pathway).
  function keyRowActivate(rowEl, model, host) {
    if (!host || typeof host.seekTo !== 'function') return;
    var idAttr = rowEl.getAttribute('data-event-id');
    var rec = findKeyEventRow(model, idAttr);
    if (!rec || !rec.event) return;
    host.seekTo(rec.event.videoTime ?? rec.event.time);
  }

  // §8: the ONE shared zone-cell activation function — both the pointer
  // path and the keyboard path call this directly (never a programmatic
  // element activation). Toggling re-renders only the grid's trace area
  // from the model — never a second engine pass (§6).
  function zoneCellActivate(cellEl, rootEl, model, host) {
    var gridId = cellEl.getAttribute('data-grid');
    var zoneKey = cellEl.getAttribute('data-zone');
    if (!gridId || !zoneKey) return;
    var traces = rootEl.querySelectorAll('.ma-trace');
    var trace = null;
    for (var i = 0; i < traces.length; i++) {
      if (traces[i].getAttribute('data-trace-grid') === gridId) { trace = traces[i]; break; }
    }
    if (!trace) return;
    var grids = model.spatial.grids;
    var grid = null;
    for (var g = 0; g < grids.length; g++) {
      if (grids[g] && grids[g].id === gridId) { grid = grids[g]; break; }
    }
    if (!grid) return;
    if (trace.getAttribute('data-open-zone') === zoneKey) {
      trace.removeAttribute('data-open-zone');
      trace.innerHTML = '<div class="ma-trace-hint">Select a zone cell to list its located events.</div>';
    } else {
      trace.setAttribute('data-open-zone', zoneKey);
      trace.innerHTML = buildTraceRowsHtml(grid, zoneKey, host);
    }
  }

  // ---- Entry point (§2, §6) ------------------------------------------------

  // renderAnalysis(container, session, host, precomputed?) — attaches the
  // dashboard markup inside the given container and returns the projection
  // model. Single orchestration point: computeMatchAnalytics and
  // computeSpatialView run at most once each per call (zero new engine
  // calls when `precomputed` is supplied) and the results are shared into
  // buildModel. No state survives the call (§6 no-caching law).
  function renderAnalysis(container, session, host, precomputed) {
    if (!container || typeof container.appendChild !== 'function') return null;
    var A;
    var view;
    if (precomputed && precomputed.analytics !== undefined) {
      A = precomputed.analytics;
    } else {
      A = AnalyticsEngine.computeMatchAnalytics(session);
    }
    if (precomputed && precomputed.spatialView !== undefined) {
      view = precomputed.spatialView;
    } else {
      view = AnalyticsEngine.computeSpatialView(A, DEFAULT_SPATIAL_FILTERS);
    }
    var model = buildModel(session, host, { analytics: A, spatialView: view });

    var doc = container.ownerDocument || document;
    var rootEl = doc.createElement('div');
    rootEl.className = 'ma-root';
    rootEl.innerHTML = buildDashboardHtml(model, host);
    while (container.firstChild) container.removeChild(container.firstChild);
    container.appendChild(rootEl);

    // §8 interaction wiring — delegation only, one shared activation
    // function for zone cells, preventDefault on Enter/Space and NO
    // stopPropagation (Space propagation to the global play/pause handler
    // is accepted, spec §12.1).
    rootEl.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || typeof t.closest !== 'function') return;
      var zoneCell = t.closest('.ma-zcell');
      if (zoneCell) {
        zoneCellActivate(zoneCell, rootEl, model, host);
        return;
      }
      var keyRow = t.closest('.ma-key-row');
      if (keyRow) keyRowActivate(keyRow, model, host);
    });

    rootEl.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var t = e.target;
      if (!t || typeof t.closest !== 'function') return;
      var zoneCell = t.closest('.ma-zcell');
      if (!zoneCell) return;
      e.preventDefault();
      zoneCellActivate(zoneCell, rootEl, model, host);
    });

    return model;
  }

  // Public API.
  return {
    VERSION: VERSION,
    SPEC: SPEC,
    KEY_COUNT_FIELDS: KEY_COUNT_FIELDS.slice(),
    CARD_LABELS: CARD_LABELS.slice(),
    KEY_EVENT_LABELS: KEY_EVENT_LABELS.slice(),
    DISPLAY_LABELS: DISPLAY_LABELS,
    DEFAULT_SPATIAL_FILTERS: DEFAULT_SPATIAL_FILTERS,
    buildModel: buildModel,
    renderAnalysis: renderAnalysis
  };
});
