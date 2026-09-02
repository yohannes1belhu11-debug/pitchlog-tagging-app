// PitchLog — Season Player CSV Export V1 (PSD-V2, Phase E)
//
// Pure PRESENTATION layer for the Player & Season Core output (PS):
// docs/player-season-data-specification.md §8.2 PSD-V2 — one row per
// player×match plus one SEASON_SUMMARY row per player, with the EXACT
// 63-column order/names fixed by the spec.
//
// Spec: docs/player-season-data-specification.md (PitchLog-PLAYER-SEASON-SPEC-v1.0-draft, §8.2/§8.4/§8.5)
//
// ARCHITECTURE (spec §8.2/§8.3):
//   - Consumes the PS output READ-ONLY (PS is the PlayerSeasonEngine
//     computeSeason result). No recomputation, no methodology, no engine
//     changes, no new dependencies, no server, no network.
//   - UMD: window.SeasonCsvEngine in the renderer (loaded AFTER
//     player-season.js and recent-form.js, BEFORE renderer.js),
//     module.exports in Node (tests).
//   - csvEscape is behavior-identical to the renderer's exporter (§8.2
//     "reuse the existing exporters verbatim"): quote a cell iff it contains
//     a comma, double quote, or newline; double internal double quotes.
//     Line endings LF, no BOM, no trailing newline — the existing exporters'
//     conventions (join('\n'), writeFile utf-8), reused verbatim.
//   - Rendering conventions (§8.5 + approved presentation decisions):
//       counts → integers; minutes/percentages → 1 decimal half-up
//       (roundHalfUp1, same house helper); booleans → TRUE/FALSE;
//       unavailable values (null / missing denominator) → EMPTY cell,
//       NEVER 0 (null discipline — no silent zero-fill, spec §7/PSD-H);
//       minutes_reasons → engine reason codes joined with ';';
//       result → "W 2-1" / "D 1-1" / "L 0-2" (empty when no result);
//       state_suppressed → the engine's gameStateSuppressedReason or empty.
//   - SEASON_SUMMARY rows: sentinel match_key 'SEASON_SUMMARY'; the
//     per-match context columns (date/opponent/competition/home_away/
//     result/x1_status) and the per-match participation columns are empty;
//     participation_status carries 'SEASON_SUMMARY'; totals/percentages/
//     spatial/period/state cells come from PS.players[pid] (pooled season
//     rollups — never averages of percentages); minutes_est is the season
//     estimated-minutes rollup (reliable + estimated seconds / 60, 1
//     decimal) with the season minutes-quality code and reason rollup.
//   - Row order: player-major — players in PS.playerOrder (appearances
//     desc → totals.events desc → playerId asc, engine order); within a
//     player, match rows in season order (matchRecordIndexes), then that
//     player's SEASON_SUMMARY row.
//
// NOT in V1 here (spec RF-Q3 / PSD §8.2 scope): Recent Form blocks, legacy
// event-dump replacement, any CSV beyond the exact PSD-V2 column list.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.SeasonCsvEngine = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SPEC = 'PitchLog-PLAYER-SEASON-SPEC-v1.0-draft-PSD-V2';

  // §8.2 — EXACT 63-column order and names (verbatim from the spec).
  var COLUMNS = [
    'match_key', 'date', 'opponent', 'competition', 'home_away', 'result',
    'x1_status',
    'player_id', 'player_name', 'player_number',
    'participation_status', 'started', 'subbed_on', 'subbed_on_min',
    'subbed_off', 'subbed_off_min', 'sent_off',
    'minutes_est', 'minutes_quality', 'minutes_reasons',
    'goals', 'shots', 'shots_on_target', 'chances', 'key_passes', 'crosses',
    'passes', 'pass_success_pct', 'presses', 'press_wins', 'interceptions',
    'recoveries', 'turnovers', 'duels', 'fouls', 'yellow_cards', 'red_cards',
    'transitions_positive', 'transitions_negative', 'positive_events',
    'negative_events', 'events_total',
    'located_events', 'unlocated_events', 'located_share_pct',
    'events_1h', 'events_2h', 'events_et1', 'events_et2',
    'state_winning', 'state_drawing', 'state_losing', 'state_suppressed',
    'zone_dl', 'zone_dc', 'zone_dr', 'zone_ml', 'zone_mc', 'zone_mr',
    'zone_al', 'zone_ac', 'zone_ar', 'zone_unlocated'
  ];

  // csvEscape — behavior-identical to the renderer's exporter (verbatim).
  function csvEscape(value) {
    var str = String(value);
    if (str.indexOf(',') !== -1 || str.indexOf('"') !== -1 || str.indexOf('\n') !== -1) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  }

  // House precision helper (spec §1.3 convention, same formula as the engines).
  function roundHalfUp1(x) { return Math.round((x + Number.EPSILON) * 10) / 10; }

  function fmt1(v) {
    if (v === null || v === undefined || typeof v !== 'number' || !isFinite(v)) return '';
    return roundHalfUp1(v).toFixed(1);
  }
  function fmtInt(v) {
    if (v === null || v === undefined || typeof v !== 'number' || !isFinite(v)) return '';
    return String(Math.round(v));
  }
  function fmtBool(v) {
    if (v === true) return 'TRUE';
    if (v === false) return 'FALSE';
    return '';
  }
  function str(v) { return (typeof v === 'string') ? v : (v === null || v === undefined ? '' : String(v)); }

  // Player count metric key per CSV column (engine metric names, §1.2).
  var METRIC_MAP = {
    goals: 'goals', shots: 'shots', shots_on_target: 'shotsOnTarget',
    chances: 'chances', key_passes: 'keyPasses', crosses: 'crosses',
    passes: 'passes', presses: 'presses', press_wins: 'pressWins',
    interceptions: 'interceptions', recoveries: 'recoveries',
    turnovers: 'turnovers', duels: 'duels', fouls: 'fouls',
    yellow_cards: 'yellowCards', red_cards: 'redCards',
    transitions_positive: 'transitionsPositive',
    transitions_negative: 'transitionsNegative',
    positive_events: 'positiveEvents', negative_events: 'negativeEvents',
    events_total: 'events'
  };

  // 3×3 zone key per CSV column (engine spatial zone names, §1.2).
  var ZONE_MAP = {
    zone_dl: 'Defensive third · Left channel',
    zone_dc: 'Defensive third · Central channel',
    zone_dr: 'Defensive third · Right channel',
    zone_ml: 'Middle third · Left channel',
    zone_mc: 'Middle third · Central channel',
    zone_mr: 'Middle third · Right channel',
    zone_al: 'Attacking third · Left channel',
    zone_ac: 'Attacking third · Central channel',
    zone_ar: 'Attacking third · Right channel'
  };
  var STATE_COLS = [
    ['state_winning', 'WINNING'], ['state_drawing', 'DRAW'], ['state_losing', 'LOSING']
  ];
  var PERIOD_COLS = [
    ['events_1h', '1H'], ['events_2h', '2H'], ['events_et1', 'ET1'], ['events_et2', 'ET2']
  ];

  function resultCell(r) {
    if (!r || r.outcome === null || r.scoreFor === null || r.scoreAgainst === null) return '';
    return r.outcome + ' ' + r.scoreFor + '-' + r.scoreAgainst;
  }

  function countCells(countsObj, passSuccessValue) {
    var out = [];
    Object.keys(METRIC_MAP).forEach(function (col) {
      // pass_success_pct is spliced in at its exact spec position between
      // 'passes' and 'presses' — handled by the caller's column assembly.
      if (col === 'passes') {
        out.push(fmtInt(countsObj ? countsObj[METRIC_MAP.passes] : null));
        out.push(fmt1(passSuccessValue));
      }
      if (col !== 'passes') out.push(fmtInt(countsObj ? countsObj[METRIC_MAP[col]] : null));
    });
    return out;
  }

  function spatialLocatedCells(spatial) {
    // located_events, unlocated_events, located_share_pct (columns 43–45).
    return [
      fmtInt(spatial ? spatial.located : null),
      fmtInt(spatial ? spatial.unlocated : null),
      fmt1(spatial && spatial.locatedShare ? spatial.locatedShare.value : null)
    ];
  }

  function zoneCells(spatial) {
    // zone_dl … zone_ar (9 grid zones) + zone_unlocated (columns 54–63).
    var out = [];
    Object.keys(ZONE_MAP).forEach(function (col) {
      out.push(fmtInt(spatial && spatial.zones ? (spatial.zones[ZONE_MAP[col]] || 0) : null));
    });
    out.push(fmtInt(spatial ? (spatial.unlocatedZone || 0) : null));
    return out;
  }

  function stateCells(stateObj, suppressedReason) {
    var out = [];
    STATE_COLS.forEach(function (pair) {
      out.push(fmtInt(stateObj && stateObj[pair[1]] ? stateObj[pair[1]].events : null));
    });
    out.push(str(suppressedReason || ''));
    return out;
  }

  function periodCells(periodsObj) {
    return PERIOD_COLS.map(function (pair) {
      return fmtInt(periodsObj && periodsObj[pair[1]] ? periodsObj[pair[1]].events : null);
    });
  }

  // One player×match row (cells in the exact §8.2 order; not yet escaped).
  function matchRowCells(rec, match) {
    var r = match && match.result ? match.result : null;
    var cells = [];
    // match context (1–7)
    cells.push(str(rec.matchKey && rec.matchKey.label));
    cells.push(str(rec.date));
    cells.push(str(rec.opponent));
    cells.push(str(rec.competition));
    cells.push(str(rec.homeAway));
    cells.push(resultCell(r));
    cells.push(r ? str(r.x1Status) : '');
    // player identity (8–10)
    cells.push(str(rec.playerId));
    cells.push(str(rec.name));
    cells.push(str(rec.number));
    // participation (11–17)
    cells.push(str(rec.participation && rec.participation.status));
    cells.push(fmtBool(rec.participation && rec.participation.starter));
    cells.push(fmtBool(rec.participation && rec.participation.substitutedOn));
    cells.push(fmt1(rec.participation && rec.participation.substitutedOnSeconds != null
      ? rec.participation.substitutedOnSeconds / 60 : null));
    cells.push(fmtBool(rec.participation && rec.participation.substitutedOff));
    cells.push(fmt1(rec.participation && rec.participation.substitutedOffSeconds != null
      ? rec.participation.substitutedOffSeconds / 60 : null));
    cells.push(fmtBool(rec.participation && rec.participation.sentOff));
    // minutes (18–20)
    cells.push(fmt1(rec.minutes ? rec.minutes.value : null));
    cells.push(str(rec.minutes ? rec.minutes.quality : ''));
    cells.push(rec.minutes && rec.minutes.reasonCodes ? rec.minutes.reasonCodes.join(';') : '');
    // counts (21–42) — pass_success_pct spliced at its exact position
    var passValue = rec.metrics && rec.metrics.passSuccess ? rec.metrics.passSuccess.value : null;
    countCells(rec.metrics, passValue).forEach(function (c) { cells.push(c); });
    // located (43–45)
    spatialLocatedCells(rec.spatial).forEach(function (c) { cells.push(c); });
    // periods (46–49)
    periodCells(rec.periods).forEach(function (c) { cells.push(c); });
    // score states (50–53)
    stateCells(rec.gameState, rec.gameStateSuppressedReason).forEach(function (c) { cells.push(c); });
    // zones (54–63)
    zoneCells(rec.spatial).forEach(function (c) { cells.push(c); });
    return cells;
  }

  // One SEASON_SUMMARY row per player (cells in the exact §8.2 order).
  function summaryRowCells(p, ps) {
    var cells = [];
    // match context: sentinel + empty per-match context columns
    cells.push('SEASON_SUMMARY');
    cells.push(''); cells.push(''); cells.push(''); cells.push(''); cells.push(''); cells.push('');
    // player identity (season canonical name/number)
    cells.push(str(p.playerId));
    cells.push(str(p.name));
    cells.push(str(p.number));
    // participation: sentinel status + empty per-match cells
    cells.push('SEASON_SUMMARY');
    cells.push(''); cells.push(''); cells.push(''); cells.push(''); cells.push(''); cells.push('');
    // minutes: season rollup (reliable + estimated seconds), quality, reasons
    var totalSeconds = (p.minutes ? (p.minutes.reliableSeconds || 0) + (p.minutes.estimatedSeconds || 0) : 0);
    var hasMinutes = p.minutes && (totalSeconds > 0);
    cells.push(hasMinutes ? fmt1(totalSeconds / 60) : '');
    cells.push(str(p.minutes ? p.minutes.quality : ''));
    cells.push(p.minutes && p.minutes.reasonCodes ? p.minutes.reasonCodes.join(';') : '');
    // counts (season totals) — pooled pass success pct
    var passValue = p.percentages && p.percentages.passSuccess ? p.percentages.passSuccess.value : null;
    countCells(p.totals, passValue).forEach(function (c) { cells.push(c); });
    // located (season spatial rollup, 43–45)
    spatialLocatedCells(p.spatial).forEach(function (c) { cells.push(c); });
    // periods (season partitions, 46–49)
    periodCells(p.periods).forEach(function (c) { cells.push(c); });
    // score states — null (all matches suppressed) → derive the reason from
    // the player's match records (the engine's only suppression cause).
    var suppressedReason = '';
    if (p.gameState === null) {
      var idxs = p.matchRecordIndexes || [];
      for (var i = 0; i < idxs.length; i++) {
        var recs = (ps._recordsByMatch && ps._recordsByMatch[idxs[i]]) || [];
        for (var j = 0; j < recs.length; j++) {
          if (recs[j].playerId === p.playerId && recs[j].gameStateSuppressedReason) {
            suppressedReason = recs[j].gameStateSuppressedReason;
            break;
          }
        }
        if (suppressedReason) break;
      }
    }
    stateCells(p.gameState, suppressedReason).forEach(function (c) { cells.push(c); });
    // zones (season spatial rollup, 54–63)
    zoneCells(p.spatial).forEach(function (c) { cells.push(c); });
    return cells;
  }

  // buildSeasonPlayerCsv(PS) → CSV string (LF, no BOM, no trailing newline).
  // Deterministic and side-effect-free: PS is consumed read-only.
  function buildSeasonPlayerCsv(PS) {
    if (!PS || !Array.isArray(PS.playerMatchRecords) || !PS.players || !Array.isArray(PS.playerOrder)) {
      return '';
    }
    var matches = Array.isArray(PS.matches) ? PS.matches : [];

    // records grouped by matchIndex (lookup for match rows)
    var byMatch = {};
    PS.playerMatchRecords.forEach(function (rec) {
      if (!byMatch[rec.matchIndex]) byMatch[rec.matchIndex] = [];
      byMatch[rec.matchIndex].push(rec);
    });

    var rows = [];
    PS.playerOrder.forEach(function (pid) {
      var p = PS.players[pid];
      if (!p) return;
      (p.matchRecordIndexes || []).forEach(function (mi) {
        var recs = byMatch[mi] || [];
        for (var i = 0; i < recs.length; i++) {
          if (recs[i].playerId === pid) {
            rows.push(matchRowCells(recs[i], matches[mi]).map(csvEscape).join(','));
            return;
          }
        }
      });
      rows.push(summaryRowCells(p, { _recordsByMatch: byMatch }).map(csvEscape).join(','));
    });

    return [COLUMNS.join(',')].concat(rows).join('\n');
  }

  return {
    SPEC: SPEC,
    COLUMNS: COLUMNS,
    csvEscape: csvEscape,
    buildSeasonPlayerCsv: buildSeasonPlayerCsv
  };
});
