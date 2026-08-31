# PitchLog — Spatial & Heat-Map Engine Specification (V1)

| | |
|---|---|
| **Document ID** | PitchLog-SPATIAL-SPEC-v1.0 |
| **Status** | APPROVED — implemented (Spatial Engine V1, Task ID 9). Approved reviewer decisions: custom tags participate in scoped grids (§12.2 answered: yes); v1 includes Event/Team/Period/Score-state/Sequence/Player filters (the approved SHOULD list — delivered as population filters through the pure `computeSpatialView` transform rather than §4 SP-A9 cross-tabs); the exact minimum-sample wording "Insufficient tagged locations for spatial visualization." with the actual located count; custom tags never receive a standardized football interpretation. Implementation deltas (doc-only notes): scoped grids cover EVERY label present (not the 13 fixed labels of §3.4.2); contract playerGrids carry `events` record arrays for traceability/dots (consistent with view grids); the pitch-map modal dot filter skips malformed locations (finite numeric x/y, mirroring engine validation). All prohibitions (§9) and honesty rules (§6) unchanged and enforced. |
| **Task type** | Planning / specification. **No application source code is modified by this document.** No UI code, no dependencies, no heat-map implementation, no taxonomy change, no event-data-model change, no 3×3-model change — in this task or as a consequence of adopting this spec. |
| **Implementation baseline** | Checkpoint `4e5a708` — pitchlog-analytics-engine-v1 (Analytics Engine V1 complete: validation → deterministic engine → Match Analytics Object → Analytics UI; 670 checks green) |
| **Parent authority** | `docs/metric-specification.md` (PitchLog-METRIC-SPEC-v1.0). Where this document and the metric spec could disagree, **the metric spec wins**; this document only *arranges and renders* what the metric spec already sanctions. |
| **Source of truth for the current state** | Actual source at `4e5a708` (src/analytics.js, src/renderer.js, src/index.html, src/styles.css), inspected line-by-line for this document. Previous reports were re-verified, not trusted. |

---

## 0. How to read this document

- §1 is the **verified inventory** of spatial information that already exists (Part 1 of the task). Nothing in §1 is assumed; every claim cites the actual file/function.
- §2 states spatial design principles that extend the metric spec's P1–P10 into the visual domain.
- §3 is the **Spatial Data Contract** (Part 2 of the task): the exact input the spatial visualization layer receives from the analytics engine.
- §4 specifies the spatial aggregation layer (pure compute, inside the existing engine).
- §5 specifies the visualization layer (density views, dot views, player views) **without implementing anything**.
- §6 is the naming/honesty constraint set (the spatial analogue of the "Tagged Possession Share" constraint).
- §7 defines spatial data-quality gates. §8 the testing strategy. §9 prohibitions. §10 implementation notes (no code). §11 acceptance criteria. §12 open questions.
- Identifiers in this document use the **SP-** prefix (SP-H principles, SP-C contract fields, SP-A aggregation rules, SP-V view rules, SP-N naming rules, SP-X gates, SP-T tests). They intentionally never collide with the metric spec's M-/CT-/NC- identifiers. **No new metric definitions are introduced** — every number in this spec is an already-sanctioned M-E/M-L2-E/M-B/CT-ZONE metric applied to a partition; the SP layer only *delivers and draws* them.

**Terminology note (engine name vs. artifact name).** The project phase is called *Spatial & Heat-Map Engine V1*; this is a project-management label only. Because PitchLog contains **manually tagged, analyst-selected event locations — not positional tracking data** — no user-visible artifact may be labelled "heat map" as if it were one (metric spec §4 Group E, M-E2: *"this is explicitly NOT a heat map"*; NC-4/NC-18). The user-visible canonical artifact name is **"Tagged Event Density (3×3)"** (§6). This is the same honesty pattern as "Tagged Possession Share" (M-L2-B4) vs. "Possession %".

---

## 1. Verified spatial state (Part 1 — source inspection results)

Everything below was read from the source at `4e5a708`.

### 1.1 Event model — location fields (unchanged, must stay unchanged)

- `ev.location` is `{ x, y }` with x, y ∈ [0, 1] normalized, **optional** (default `null`); at most **one point per event** (renderer.js `buildEventBase` line 904; metric spec §1.8).
- Set paths (both clamp to [0,1] at input via `clamp01`):
  - Detail-panel pitch click (desktop): renderer.js lines 1495–1507 — `ev.location = { x: clamp01((e.clientX − rect.left)/rect.width), y: clamp01((e.clientY − rect.top)/rect.height) }`, then `renderDetailPanel(); renderEventList(); markAutosaveDirty()`.
  - Touchline pitch tap: renderer.js line 3320 — sets location on the **most recently logged** event only.
- Fields available on every event for spatial slicing: `id, time, videoTime, matchTime, matchSeconds, officialMinute, second, period, label, subtype, qualifiers, location, playerId, playerOffId, playerOnId, side (legacy 'for'/'against'/'neutral'), team ('our'/'opponent'/null), sequenceId, scoreForBefore, scoreAgainstBefore, scoreForAfter/scoreAgainstAfter (goals only), isInterval, startTime, endTime` (renderer.js `buildEventBase` 890–913, `finishInterval` 916–954).
- There is **no** pass end-location, no second point per event, no trajectories, no ball-position timeline (metric spec NC-4/NC-6/NC-7/NC-8). Any spatial artifact in this spec therefore uses **single points only**.
- Zone derivation (identical in renderer and engine, source-verified):
  - renderer.js `locationZone(x,y)` lines 1088–1092; analytics.js `zoneKey/thirdKey/channelKey` lines 270–283.
  - third index `ti = min(2, max(0, floor(x*3)))` → `['Defensive third','Middle third','Attacking third']`; channel index `ci = min(2, max(0, floor(y*3)))` → `['Left channel','Central channel','Right channel']`; zone string `"<third> · <channel>"` (9 zones + Unlocated).
  - **Orientation convention T2** (metric spec §1.8/§10): x = 0 is our goal line, x = 1 the opponent's; y = 0 the Left-channel edge, looking from our goal toward the opponent's. Not enforced by code; every spatial artifact states its dependence on T2.

### 1.2 Analytics engine — spatial structures that exist today (analytics.js)

- **Validation** (`validateAndNormalize`, lines 159–169): a location is kept only if it is a plain object with finite numeric x and y; malformed → issue `INVALID_LOCATION` and `location = null`; values outside [0,1] → **kept, flagged** `LOCATION_OUT_OF_RANGE` (binning clamps via `min(2,max(0,…))`).
- **Level 1** (`level1.spatial`): `locatedEvents` = `countEnv(locatedCount, { location: total − located })` — the engine's M-E1.
- **Level 2** (`level2.spatial`): `locatedEventShareByLabel` — array of `{ label, located, total, share }` per label (M-L2-E1), canonical label order.
- **Level 3** (`level3`): `byZone` (9 zone buckets + `Unlocated`), `byThird` (3 + Unlocated), `byChannel` (3 + Unlocated). Each bucket is a plain-count object over the fixed 19-key `L3_KEYS` set: `events, goals, shots, chances, crosses, corners, fouls, yellowCards, redCards, passes, possessionIntervals, presses, pressWins, interceptions, recoveries, turnovers, duels, positiveTransitions, negativeTransitions`. Built in a **single pass over ALL records — not partitioned by team, label, or player**.
- `level3.excluded` = `{ unlocated, unknownPeriod, unattributedTeam }`; `level3CountsNote` documents the plain-count convention.
- **Match Analytics Object** (main entry, lines 1261–1336): `spec, engine, input, validation, matchSummary (incl. locatedEvents), gates (X1–X6), level1, level3, level2, sequences, players, protocol`. **No per-event x/y is emitted anywhere in the output object** — only aggregates. `players` entries carry counts/ratios but **no spatial breakdown**.
- The engine is a **pure, deterministic function** (recompute → byte-identical object; canonical order `(time asc, id asc)`; source events never mutated; envelope conventions `{ value, num?, den?, excluded, params? }`; ratios null when denominator 0; rounding half-up 1 decimal at display boundary).

### 1.3 Renderer — spatial features that exist today

- **Detail panel** (per event): SVG pitch (`viewBox="0 0 700 450"`, `pitchMarkingsSvg()` 1107–1122), marker circle at `(x·700, y·450)` r=8, click-to-set, `Clear` button, zone text readout.
- **Pitch-map modal** (aggregate dot view; index.html 368–394, renderer.js 1264–1345): filters by **tag label**, **player**, and **legacy `side` ('for'/'against'/'neutral')** — *not* `team`; renders located events as r=7 dots colored by `PITCH_MAP_PALETTE` (8 colors; Card gets literal yellow/red), legend when >1 label type, and a count line "Showing N of M located events" / empty-state guidance. **Pure dot plot — no aggregation, no zones, no density, no shading.**
- **Touchline pitch** (line 3302, 3320): shows the last logged event's marker; tap sets that event's location.
- **Analytics tab** (Events/Stats/Analytics tabs, index.html 224–246; renderer.js 1875–2179): `renderAnalyticsPanel()` recomputes the full Match Analytics Object on every render and refreshes live via the `renderStatsPanel` hook; `buildAnalyticsHtml(A)` renders the read-only report: gates, match summary, L1/L2 team tables, tagged-possession section, score state, transitions, **`byPeriod`, `byMinuteBin`, `byThird` tables — but NOT `byZone` and NOT `byChannel`**, players, sequences, method notes.
- Old Stats tab (`computeStatsFor`/`buildStatsHtml` 1775–1873): byType/bySide/byPlayer only — **no spatial data at all**.

### 1.4 Visual language (styles.css, verified)

- Dark theme: `--bg #0d0e10`, `--panel #17181b`, `--panel-alt #1e2024`, `--border #2a2c30`, `--text #ededec`, `--text-dim #8c8f94`, accent crimson `--accent #8e0e1b` / `--accent-bright #d81e2e`.
- Pitch: `.pitch-svg` background **`#14301b`** (dark green), markings `rgba(255,255,255,0.55)` 2px, spots 55% white, marker `var(--accent-bright)` with white 2px stroke.
- `.pitch-map-svg` (cursor default), `.pitchmap-legend`/`.legend-dot` (9px swatches), `.pitchmap-count`.
- `.an-*` classes for the analytics report (tables `.an-table`, flags `.an-flag-ok/warn/bad`, notes `.an-poss-note`, `.an-poss-limit`, `.an-protocol`, `.an-engine`).
- All pitch SVGs share `viewBox="0 0 700 450"` with `preserveAspectRatio="xMidYMid meet"` — aspect ≈ 1.556 (a real 105×68 m pitch is ≈ 1.544; the existing geometry is accepted as-is and is normative for this spec).

### 1.5 Exports (spatial columns that exist today)

- Standard CSV: `location_zone`, `location_x` (3 decimals), `location_y` (3 decimals) — renderer.js 2284–2296.
- Full-analysis CSV (35 cols): `Pitch Zone`, `X`/`Y` as 0–100 with 1 decimal, `Third`, `Channel`, plus `Team`, `Score State`, `Sequence ID`; `Category/Outcome/Phase` columns exist but are **empty (defect F7 — ignored as metric input per metric spec §11.4)** — renderer.js 3216–3231.

### 1.6 Gaps found (the delta this spec closes in the next phase)

1. **`level3.byZone` and `level3.byChannel` are computed but never rendered** in the Analytics UI (only `byThird` is).
2. The Level 3 zone grid is **not team-partitioned, not label-scoped, not player-scoped** — although the metric spec's sanctioned matrix explicitly allows M-E2 × CT-ZONE/CT-PLAYER ("Team/Player: partitionable", matrix row "M-E2 zone family": PLAYER ✅).
3. **No per-event spatial data (x/y) is emitted by the engine** — a visualization layer consuming only the Match Analytics Object cannot draw dots.
4. The pitch-map modal filters on **legacy `ev.side`** while the analytics layer uses `ev.team` — two vocabularies for the same concept (metric spec §1.6 documents the v3 semantics; `side` is the v2 mirror).
5. There is **no aggregated/visual spatial view at all** — only raw dots (modal) and one marginal table (`byThird`).
6. Out-of-range locations are silently clamped into a zone at binning time (flag exists in `validation.issues`, but no spatial artifact surfaces it).
7. `players` output has **no located counts and no spatial breakdown**; located-share-by-label exists but per-player located completeness is not reported.

### 1.7 Authority references (metric spec sections this document builds on)

- §1.8 location representation; §3 `HasZone(E,i,j)` predicate; §4 Group E (M-E1 Located Events, M-E2 zone family, M-E3/E4 margins); §5 M-L2-E1 (located-event share must accompany **every** spatial figure); §5 audit group M-X1–X6; §6 CT-ZONE/CT-THIRD/CT-CHANNEL operators + sanctioned matrix (M-B10–B13 Possession intervals × ZONE is sanctioned with the note "(single point)"); §7 NC-4 (no trajectories), NC-6/7/8 (no pass end-locations), NC-16 (no xG), NC-18 (field tilt forbidden — honest substitute is the located-event distribution with located-share printed, "explicitly not named field tilt"); §10 protocol T2 (orientation); §11.6 (Foul Zone qualifier vs location: independent claims, disagreement reportable, not resolvable); §12 computation rules (canonical order, rounding, null-not-zero, idempotence); M-L2-B4 presentation constraint (tagged-possession honesty pattern that §6 of this document mirrors).

---

## 2. Spatial design principles (SP-H)

These extend metric-spec P1–P10 (§2) into the visual domain. Each is normative.

- **SP-H1 — Discrete 3×3 only.** Every spatial artifact draws counts over the fixed 3×3 grid (thirds × channels) plus the explicit Unlocated bucket. The 3×3 model is **not changed, not subdivided, not smoothed**. No rendering or binning beyond the 3×3 model (metric spec M-E2 limitation, quoted as normative).
- **SP-H2 — No invented density.** No kernel density estimation, no bilinear/Gaussian interpolation, no blur, no gradients between cells, no contouring, no heat diffusion. A cell's color is a function of its own integer count and the grid's maximum count only (§5.3). Smoothing would manufacture spatial precision the data does not have (P10: no invented data).
- **SP-H3 — Tagged-sample honesty.** Locations are analyst-selected samples, not a positional feed (M-E1 limitation). Every spatial view is labelled with its universe ("tagged events") and carries the located-share (M-L2-E1) and the standing limitation note (§6.3). The words "heat map", "possession %"-style officiality, "field tilt", "territory" are governed by §6.2.
- **SP-H4 — Numbers before color.** Color is never the only channel: the exact integer count is printed in every non-empty cell, and a full numeric table of every rendered grid is always available adjacent to (or one interaction away from) the visual. A grid without its numbers is a defect.
- **SP-H5 — Deterministic rendering.** Same input → same SVG markup (byte-identical re-render, matching the engine's determinism contract). No randomness, no time-based animation state, no layout jitter. Visual parameters (color steps, thresholds) are fixed constants defined in this spec.
- **SP-H6 — Zero ≠ null ≠ unknown.** A cell with count 0 (true zero in the tagged universe) renders as an empty outlined cell. A grid whose located population is 0 renders a null state with a reason (never as an all-zero grid, which would falsely imply "no events there"). Unlocated events are an explicit reported bucket, never silently dropped.
- **SP-H7 — Partitions stated, never mixed silently.** A grid is always bound to exactly one team partition ('our' / 'opponent' / 'unattributed' / 'all') and one scope (label set or 'All events'), both printed with the grid. Reporting two context dimensions in one figure requires stating both (metric spec §6 Level 3 rule).
- **SP-H8 — Read-only layer.** The visualization layer never mutates events, matchInfo, matchClock or squad; it consumes the Spatial Data Contract (§3) and re-renders on refresh, exactly like the Analytics tab today.
- **SP-H9 — Zero new dependencies.** Pure SVG generation in the renderer (string-building, same technique as `pitchMarkingsSvg()` and the pitch-map dots). No canvas, no chart libraries, no d3, no heatmap libraries, no new npm packages, no build-step changes.
- **SP-H10 — Match-level only in v1.** One session at a time. No season/multi-match spatial aggregation, no cross-match grids (out of scope, §9).

---

## 3. Spatial Data Contract (Part 2) — the exact input the visualization layer receives

### 3.1 Position in the chain

```text
LIVE TAGGING → STRUCTURED EVENT → VALIDATED EVENT → ANALYTICS ENGINE
                                      │
                                      ├─ (existing) matchSummary / gates / level1 / level2 / level3 / players / sequences
                                      └─ (new, this spec) A.spatial ──→ SPATIAL VISUALIZATION LAYER
```

The visualization layer receives **one object**: the existing Match Analytics Object `A`, extended with a single new top-level section `A.spatial`. It must not read raw session events (that path stays reserved to the existing pitch-map modal, §5.6). The contract is fully satisfied by `A.spatial`; no other engine output is required to draw any v1 view.

### 3.2 `A.spatial` schema (field by field)

```jsonc
{
  "spec": "PitchLog-SPATIAL-SPEC-v1.0",
  "model": {                                    // SP-C1 — fixed, echo of the 3×3 model
    "thirds":  ["Defensive third", "Middle third", "Attacking third"],
    "channels": ["Left channel", "Central channel", "Right channel"],
    "zoneKeys": ["Defensive third · Left channel", "… (9, row-major: third-major)", "…"],
    "unlocatedKey": "Unlocated",
    "orientation": "T2: x=0 our goal line, x=1 opponent goal line; y=0 Left channel edge",
    "cellKeys": [ /* the 19 L3_KEYS, engine order */ ]
  },
  "completeness": {                             // SP-C2 — P4/M-L2-E1 gate data
    "located": 41, "total": 60,                 // integers
    "locatedShare": { "value": 68.3, "num": 41, "den": 60, "excluded": {} },   // ratioEnv
    "byLabel": [ { "label": "Shot", "located": 12, "total": 15, "share": 80.0 }, "…" ],
    "locationOutOfRange": 2,                    // count of kept-but-flagged records
    "invalidLocation": 1                        // count of records whose location was dropped (validation.issues mirrors)
  },
  "locatedEvents": [ /* SP-C3, see §3.3 — one record per located validated record, canonical (time,id) order */ ],
  "grids": [ /* SP-C4, see §3.4 — partitioned M-E2 grids */ ],
  "playerGrids": [ /* SP-C5, see §3.4.4 */ ],
  "possessionDurationByZone": { /* SP-C6, see §3.6 */ },
  "gates": { "SP-X1": "…", "SP-X2": "…" },      // §7
  "params": { "minSampleForDensity": 6 },       // fixed defaults, §5.4
  "limitations": [ "… standing notes, exact strings in §6.3 …" ]
}
```

All integer counts are JavaScript numbers; all shares use the engine envelope (`{ value, num, den, excluded }`, value null when den = 0, rounding half-up 1 decimal at display only). Key order is fixed as written (determinism contract).

### 3.3 SP-C3 — the located event record (exact fields)

One record per **validated** record with `location ≠ null`, in canonical `(time asc, id asc)` order:

| Field | Type | Source / rule |
|---|---|---|
| `eventId` | number | validated `id` (deterministic fallback id if raw was missing — engine rule) |
| `label` | string | validated label (canonical first, custom tags sorted after) |
| `subtype` | string \| null | |
| `team` | 'our' \| 'opponent' \| null | v3 team semantics (never the legacy `side`) |
| `playerId` | string \| null | Sub events: `null` (attribution is playerOff/playerOn, not spatial-relevant; Sub dots, if drawn, are unattributed) |
| `x`, `y` | number | **full validated precision, unrounded, un-clamped** (values may be slightly outside [0,1] only when flagged `outOfRange`) |
| `outOfRange` | boolean | true when x or y ∉ [0,1] (kept + flagged per §1.2) |
| `thirdIndex`, `channelIndex` | 0\|1\|2 | `min(2, max(0, floor(v*3)))` — the clamped bin actually used |
| `zoneKey` | string | `"<third> · <channel>"` |
| `period` | string | validated period ('Unknown' possible) |
| `matchSeconds` | number | |
| `minuteBin` | string | engine `minuteBin()` (period+matchSeconds, never officialMinute) |
| `stateBefore` | 'WINNING'\|'DRAW'\|'LOSING' | score-before state |
| `sequenceId` | string \| null | |
| `isGoal` | boolean | |
| `isInterval` | boolean | |
| `durationSecondsExact` | number \| null | **intervals only**: unrounded `endTime − startTime` (0 when malformed); null for instant events |

**Why there is no `phase` field.** The conceptual contract sketch in the task mentions a phase; the event model has none (the full-CSV `Phase` column is empty — F7; possession-phase requires exhaustive two-team possession segmentation, which the tagging model does not provide — NC-1, the same structural reason behind "Tagged Possession Share"). The honest substitutes already in the contract are `team`, `stateBefore`, `period`, `minuteBin`, `sequenceId`. **`phase` must not be invented.**

**Precision rule (possession constraint applied spatially).** `x`/`y` and `durationSecondsExact` are carried at full internal precision; rounding happens only at the display boundary (metric spec §12.3). `x`/`y` are never rounded to 2 decimals "for tidiness" anywhere in the chain.

### 3.4 SP-C4 — grid objects (the partitioned M-E2 family)

#### 3.4.1 Grid object shape

```jsonc
{
  "id": "grid:scope=all:partition=our",
  "scope": "all",                     // 'all' | a single label string (see 3.4.2)
  "scopeLabel": "All events",
  "partition": "our",                 // 'our' | 'opponent' | 'unattributed' | 'all'
  "partitionLabel": "Us",
  "population": 40,                   // ALL events in scope ∧ partition (located + unlocated)
  "located": 31,                      // located events in scope ∧ partition
  "unlocated": 9,
  "locatedShare": { "value": 77.5, "num": 31, "den": 40, "excluded": {} },
  "cells": [                          // 9 entries, ROW-MAJOR, fixed order (third-major, channel-minor)
    { "thirdIndex": 0, "channelIndex": 0, "zoneKey": "Defensive third · Left channel",
      "counts": { "events": 3, "goals": 0, "shots": 0, "…": "…19 L3_KEYS" } },
    "…" ],
  "unlocatedBucket": { "counts": { "…19 L3_KEYS, unlocated events only" } },
  "margins": {                        // M-E3 / M-E4 of this grid (sums of cells)
    "byThird":  [ { "index": 0, "name": "Defensive third", "events": 11, "…": "…" } ],
    "byChannel": [ { "index": 0, "name": "Left channel", "events": 9, "…": "…" } ]
  }
}
```

`counts` uses exactly the engine's 19 `L3_KEYS` (same key order). Every count is a plain integer (true zeros allowed — these are counts, not ratios). `grids` is an **array** (fixed deterministic order: scope-major per §3.4.2, then partition order `our, opponent, unattributed, all`).

#### 3.4.2 Scopes (v1, fixed set)

1. `"all"` — all events (the base grid).
2. One grid per **canonical spatial label**, in `orderedLabels` order, restricted to this label set: `Goal, Shot, Chance, Cross, Corner, Pass, Foul, Turnover, Recovery, Interception, Press, Press Win, Possession`.
   - This is the M-E2 family "for a label set L" exactly as the metric spec defines it — **not a new metric**.
   - Custom tags are **excluded from scoped grids in v1** (they appear in the `"all"` grid and in `completeness.byLabel`); rationale: unknown spatial semantics of arbitrary custom tags (open question §12.2).
3. `Sub`, `Card`, `Duel`, `Positive Transition`, `Negative Transition` get **no scoped grids** in v1 (rarely located, no spatial workflow; still present in `"all"`). Record as open question §12.2.

#### 3.4.3 Partitions (v1)

`'our'`, `'opponent'`, `'unattributed'`, `'all'` (no team restriction — includes unattributed). The unattributed partition exists for honesty (X2 pattern): it is rendered only as a data row, never as a density view (§5.1).

#### 3.4.4 SP-C5 — `playerGrids`

One grid per playerId with ≥ 1 located event (all labels, no team partition — the player's own events). Shape = grid object with `partition: "player:<playerId>"`, plus `playerId`, and resolved `name`/`number` **resolved from the squad at compute time, mirroring the engine's `players` list behavior** (`'Unknown player'` fallback). Order: located count desc, then name asc, then playerId asc (deterministic). Player grids are diagnostics, never performance claims (P2/M-G2 warning).

### 3.5 What is intentionally NOT in the contract

- No `phase`, no `averagePosition`, no mean x/y (mean-position plots imply positional sampling; excluded, §9).
- No event-to-event links, no pass arrows (NC-6/7/8).
- No per-cell ratios (e.g. "shot share by zone") — ratios are Level 2 territory; v1 cells carry counts only. (Level 2 × CT-ZONE is sanctioned by the matrix but **deferred**, §12.3.)
- No cross-tabs beyond ZONE (ZONE × STATE / ZONE × PERIOD are sanctioned but optional v1.1, §4.6).
- No smoothing kernel, no bandwidth parameter — nothing to configure because none exists (SP-H2).

### 3.6 SP-C6 — `possessionDurationByZone`

The sanctioned matrix already allows M-B10–B13 (tagged possession interval metrics) × CT-ZONE with the note "(single point)". This contract field delivers it under the **same presentation constraint as M-L2-B4**:

```jsonc
"possessionDurationByZone": {
  "name": "Tagged Possession Duration by Zone",
  "basis": "Recorded PitchLog Possession interval tags ONLY — not an official match possession statistic (NC-1)",
  "attribution": "single tagged point per interval (interval start semantics, T2 orientation)",
  "our": {
    "locatedIntervals": 5, "unlocatedIntervals": 2,
    "secondsExact": { "cells": [ 301.5, 0, 64.2, "…9 values, row-major" ], "unlocated": 118.0 },
    "totalSecondsExact": 483.7                      // Σ cells + unlocated (unrounded)
  },
  "opponent": { "… same shape …" },
  "unattributed": { "… same shape …" },
  "display": "seconds rounded half-up to 1 decimal at render only"
}
```

Rules (all inherited from the M-L2-B4 directive, none new):

- Internal values are **full unrounded seconds** summed from `durationSecondsExact`; rounding happens only at display.
- Only `Possession` **interval** events participate; each contributes its whole duration to the zone of its single tagged point, or to `unlocated` when no point is set.
- Never mixed with event counts; never divided into an official-sounding percentage; the `basis` string is rendered with the view.
- Σ(cells + unlocated) = the partition's tagged possession total — cross-checkable against the existing `level1.possession[partition].totalDuration` (reconciliation invariant §3.8).

### 3.7 SP-C7 — `limitations` (standing notes, exact strings)

Rendered with every spatial view (§6.3 for the exact texts and placement rules).

### 3.8 Contract invariants (must hold; all are testable)

1. `A.spatial.locatedEvents.length` = `A.matchSummary.locatedEvents` = `A.level1.spatial.locatedEvents.value`.
2. For every grid: `population = located + unlocated`; `Σ(9 cells.events) + unlocatedBucket.counts.events = located`.
3. For scope `"all"`: the four partitions satisfy `our + opponent + unattributed = all` for `population`, `located`, and every cell count.
4. For scope `"all"`, partition `"all"`: cell counts and margins **must equal** the existing `A.level3.byZone/byThird/byChannel` (the v1 engine output) — the spatial layer is a partitioned re-delivery of the same numbers, never a recomputation with different rules.
5. `possessionDurationByZone[P].totalSecondsExact` = `A.level1.possession[P].totalDuration` basis (unrounded; the level1 envelope's value is the rounded display twin — the invariant is on the unrounded source, tested via `durationSecondsExact` sums).
6. Every `locatedEvents` record satisfies: `floor-clamped bin from x,y` = (`thirdIndex`, `channelIndex`); records with `outOfRange:true` are exactly the `locationOutOfRange` count; records with malformed-dropped location do not exist in this list (they are `unlocated`).
7. All grids' `located` sums (over partitions, scope "all") reconcile with `completeness.located`.

### 3.9 JSON example

A minimal worked example (3 located shots, 1 unlocated pass, our team; everything else empty) is given in Appendix A. It is normative for field names and ordering.

---

## 4. Spatial aggregation layer (SP-A) — pure compute inside the engine

- **SP-A1 — Placement.** The aggregation is a pure function computed inside `src/analytics.js` (or a new pure module loaded alongside it — implementer's choice, §10), invoked from `computeMatchAnalytics` as a late stage (after validation, after X-gates), producing `A.spatial` per §3. It must preserve the engine contract: pure, deterministic, input-never-mutated, stable key order, byte-identical recompute.
- **SP-A2 — Single-pass counting.** Grids are accumulated by iterating the validated records once and incrementing: `(scope match) × (partition match) × (cell from zoneKey)`. No per-grid rescans beyond the fixed scope/partition sets (O(events × scopes), scopes ≈ 14, events in the hundreds — trivially fast; no caching layer needed or allowed).
- **SP-A3 — Scope matching.** Scope `"all"` matches every record; a label scope matches `record.label === scope`. Custom-tag records match only `"all"` (§3.4.2).
- **SP-A4 — Partition matching.** `team === 'our' | 'opponent' | null`; partition `'all'` matches every record. No fallbacks, no team inference from `side`, no inference from label.
- **SP-A5 — Out-of-range handling.** Out-of-range located records participate (clamped bin) AND set `outOfRange: true`; the count is surfaced in `completeness.locationOutOfRange` and gate SP-X1. They are **not** excluded (exclusion would silently shrink the population; the flag is the honesty mechanism — mirrors `LOCATION_OUT_OF_RANGE` in `validation.issues`).
- **SP-A6 — `playerGrids`.** Group located records by `playerId` (Sub events attribute via playerOff/playerOn; in v1 Sub records carry `playerId: null` in the contract (§3.3) and are excluded from player grids — documented, consistent with the engine's Sub-attribution rule).
- **SP-A7 — Duration by zone.** Per §3.6: sum unrounded `durationSecondsExact` of Possession intervals per partition × cell; unlocated intervals to the unlocated bucket.
- **SP-A8 — No new counting rules.** The cell `counts` are produced by the **existing** `L3_KEYS` switch (`addToBucket`) — the aggregation layer partitions, it never re-defines what counts as a shot/goal/etc.
- **SP-A9 — Optional v1.1 cross-tabs.** `zoneByPeriod` (cells × 6 period buckets) and `zoneByState` (cells × 3 states, gated by X1 like CT-STATE) are sanctioned by the matrix and MAY be added later behind the same contract section; v1 does not require them.

---

## 5. Visualization layer (SP-V) — rendering rules, no implementation

### 5.1 View inventory (v1)

| ID | View | Where | Data |
|---|---|---|---|
| SP-V1 | **Team Density View** — "Tagged Event Density (3×3)" for Us and for Opponent, side by side on desktop / stacked on narrow widths | Analytics tab, new "Spatial" section | `grids[scope][our/opponent]` |
| SP-V2 | **Numeric Zone Matrix** — the full 19-key table for the selected scope × partition (the numbers-first twin of SP-V1; always rendered adjacent) | same | same |
| SP-V3 | **Label selector** — one scope at a time ('All events' + the 13 label scopes) | controls above SP-V1/2 | `grids` |
| SP-V4 | **Player Density small multiples** — per-player grids, top 12 by located count, "showing 12 of N" when more | below SP-V1/2 | `playerGrids` |
| SP-V5 | **Tagged Possession Duration by Zone** — two mono-color intensity grids (Us / Opponent) with seconds labels | separate sub-section | `possessionDurationByZone` |
| SP-V6 | **Existing dot plot alignment** — the pitch-map modal keeps its dot rendering but its Side filter switches from legacy `side` to `team` semantics, and gains an optional 3×3 overlay toggle (grid lines only, no shading) | pitch-map modal | raw events (unchanged data path) + `model` |

No other views in v1. No overlay on video frames (Once Sport owns video), no click-to-video, no clip creation (§9).

### 5.2 Density view rendering rules (SP-V1/V5)

- **Canvas**: the existing SVG technique and geometry — `viewBox="0 0 700 450"`, `preserveAspectRatio="xMidYMid meet"`, `pitchMarkingsSvg()` markings drawn **on top** of the cell fills. Draw order: cell rects (fills) → zone grid lines → pitch markings → cell text → unlocated strip (outside the SVG, as a DOM line below it).
- **Zone grid lines**: vertical at x = 700/3 ≈ 233.3 and 700·2/3 ≈ 466.7; horizontal at y = 150 and 300; `stroke: rgba(255,255,255,0.28); stroke-width: 1` — visually distinct from the 2px/55% pitch markings.
- **Cell rects**: 9 rects covering the pitch interior (the existing outline spans x 4–696, y 4–446; cells span that interior, row-major thirds × channels; exact pixel edges computed from the fixed viewBox — no measurement of rendered size, ever).
- **Cell text**: the integer count, centered, 12px bold, `#ffffff` with a `1.4` line-height and a subtle dark text-shadow for contrast on light cells; cells with 0 events show **no text** (empty cell). The text is the primary channel; color is secondary (SP-H4).
- **Heading per grid**: `"<scopeLabel> — <partitionLabel> · <located>/<population> located events (<share>%)"` — universe and located-share always stated (M-L2-E1 rule).
- **Unlocated strip** under each grid: `Unlocated: N (<share of scope>%) — not shown on the pitch` (SP-H6).
- **SP-V5 specifics**: cell label is seconds (1 decimal, display-rounded from `secondsExact`); mono-hue intensity per §5.3 but with **step thresholds relative to the max cell seconds** of that team's grid; the `basis` string (§3.6) rendered beneath; both team grids always shown together (mirrors the OUR + OPPONENT tagged-duration reporting rule of the possession constraint).

### 5.3 Deterministic color scale (exact algorithm — SP-H5)

Function `densityStep(count, maxCount)`:

```text
if count = 0            → step 0  (no fill, outlined cell)
if maxCount = 0         → the grid is not rendered at all (null state, §5.4)
s = count / maxCount
0  < s ≤ 0.25           → step 1
0.25 < s ≤ 0.50         → step 2
0.50 < s ≤ 0.75         → step 3
0.75 < s ≤ 1.00         → step 4   (maxCount itself is always step 4)
```

Fill values (crimson ramp on the existing `#14301b` pitch; matches the app's accent family; no blue):

```text
step 1 → rgba(216, 30, 46, 0.22)   /* #d81e2e @ 22% */
step 2 → rgba(216, 30, 46, 0.42)
step 3 → rgba(216, 30, 46, 0.62)
step 4 → rgba(216, 30, 46, 0.82)
step 0 → no fill
```

- The scale is **relative to the grid's own maximum cell** and is recomputed per grid (a 3-event grid and a 30-event grid both use the full ramp — comparability across grids is via the printed numbers, not the colors; this is stated in the legend).
- Legend (per grid): 4 swatches with the step boundaries as share-of-max ranges, plus `max = <count> (busiest cell)`. Legend is part of the deterministic markup.
- **Forbidden**: gradients, blurred shapes, radial fades, opacity ramps on dot clusters, any non-integer-interpolated fill.

### 5.4 Minimum-sample gate (params.minSampleForDensity = 6)

- If `grid.located < 6` the density view for that grid renders the **null state**: pitch outline + grid lines only + message `Insufficient located events (N of scope M) for a density view — see the table.` The numeric table (SP-V2) still renders for every grid. The threshold is a fixed param echoed in `params`; changing it is a spec change (open question §12.4).
- Rationale: same pattern as the possession insufficient-data null-with-reason; small samples produce visual false precision.

### 5.5 SP-V4 — player small multiples

- Grid per player at reduced size (same viewBox, CSS-scaled ~45% width, 2 per row desktop / 1 per row narrow), same color rules per grid, heading `"<number> <name> · <located> located events"`, `'(no appearance)'` badge when the engine's players list marks the player as no-appearance.
- Order: located desc, name asc, playerId asc (contract order). Cap display at 12 with the "showing 12 of N — full list in the table" note + a full numeric table for all playerGrids.
- A player grid with 1–5 located events renders via the §5.4 null state (single dots may still be drawn as dots — allowed: a 1–5 dot scatter is a truthful view; counts printed).

### 5.6 SP-V6 — existing dot plot alignment (pitch-map modal)

- Keep: dot rendering, tag/player filters, legend, count line, empty-state guidance, raw-events data path.
- Change (required in the implementation phase): the "Side" filter becomes a **"Team"** filter with values `Us / Opponent / Unattributed / All teams`, matching on `ev.team` (v3 semantics; identical vocabulary to the analytics layer). The legacy `side` field remains untouched in the data model — only the filter's source field changes. (This is a filter alignment, not a taxonomy change.)
- Add (optional, cheap): a toggle "Show 3×3 zones" that overlays the §5.2 zone lines (lines only, no fills, no counts) so analysts can eyeball zone membership while tagging review.
- The modal must NOT gain density shading in v1 (density lives in the Analytics tab; avoids two color-coded artifacts with different legends).

### 5.7 Interaction (all views)

- Scope selector (SP-V3) and nothing else changes data; team grids (Us/Opponent) render together by default; an 'All teams' partition grid is available in the table only (mixing partitions silently is forbidden — SP-H7).
- Hover on a cell → tooltip with the full 19-key bucket for that cell (title attribute or CSS tooltip; deterministic markup).
- Click a cell → the underlying located events for that cell listed read-only beneath the view (from `locatedEvents` filtered by zoneKey + scope + partition; ordered `(time asc, id asc)`; each row: `minuteBin · label · subtype · player name · team`). No navigation to other tabs, no video seek (§9).
- Keyboard: cells are focusable SVG rects with `role="img"` + `aria-label` = `"<zoneKey>: <count> events"`; the numeric table is the accessible fallback (SP-H4).
- Live refresh: recompute + re-render through the existing `renderStatsPanel → renderAnalyticsPanel` hook on every event change while the Analytics tab is visible (byte-identical when nothing changed).

### 5.8 Performance

- One engine pass (SP-A2), one render pass per visible view; string-built SVG like today's modal. No virtualization, no memoization beyond the existing recompute-on-render model, no async, no workers. Expected cost per refresh: linear in events (< 5 ms for a full match on current hardware).

### 5.9 Export / print fallback

- The SP-V2 numeric table is plain HTML — it prints and copies as-is. No image export, no PNG/SVG download in v1 (open question §12.5). The full-analysis CSV already carries zone/x/y/third/channel columns; no CSV changes in this spec.

---

## 6. Naming and honesty constraints (SP-N) — the spatial analogue of the possession constraint

### 6.1 Canonical names (required in every user-visible artifact)

| Artifact | REQUIRED name (UI label) |
|---|---|
| SP-V1 shaded grid | **"Tagged Event Density (3×3)"** — with the scope/partition in the heading |
| SP-V5 duration grid | **"Tagged Possession Duration by Zone (recorded interval tags only)"** |
| Marginal tables | "Tagged events by third / by channel (3×3 model)" — as the Analytics tab already labels byThird |
| Dot plot (modal) | "Pitch map — located events" (existing wording retained) |
| Player grids | "<player> — tagged event density (3×3)" |

### 6.2 Forbidden names (never rendered, in any view, tooltip, legend, or export)

| Forbidden | Why |
|---|---|
| "Heat map" / "Heatmap" (standalone, as the artifact's label) | implies continuous positional/tracking data (NC-4); M-E2: "explicitly NOT a heat map". The phase/engine may keep the name internally (project label); user-visible labels may not. |
| "Possession map" / "Possession heat" | possession coverage is not exhaustive (NC-1, M-L2-B4 constraint) |
| "Field tilt" / "Territory" / "Territory share" | NC-18 (explicitly forbidden there; the substitute is this density view + located-share) |
| "Pressure map" / "Pressing intensity" | press events are analyst-selected samples, no spatial continuity |
| "Average position" / "Mean position" | mean of sparse tagged points implies positional sampling; excluded (§3.5) |
| "Coverage" / "Zones of control" / "Dominance" | imply continuous team presence |
| Any percentage implying share of *match* space or *official* territory | not computable |

### 6.3 Standing limitation strings (exact texts, rendered with the views)

1. Under SP-V1/SP-V2/SP-V4 (one line, always):
   `Locations are analyst-tagged samples of tagged events only — not positional tracking; unlocated events are excluded from the grid and reported below.`
2. Under SP-V5 (one line, always):
   `Based ONLY on recorded PitchLog Possession interval tags (single tagged point per interval) — not an official match possession statistic (NC-1); unrounded seconds summed internally, rounded for display only.`
3. Orientation footnote in the Spatial section header:
   `Orientation per tagging protocol T2: x = 0 our goal line → x = 1 opponent goal line; Left channel at y = 0.`

### 6.4 Precision rules

- No smoothing, interpolation, kernel, blur, gradient, or contour anywhere (SP-H2) — this is a hard prohibition on the implementation, not a style preference.
- No duration-weighted event density (counts and seconds are separate artifacts — SP-V1 counts events, SP-V5 sums seconds; they are never mixed into one visual).
- Display rounding: counts are integers (never "3.0"); seconds 1 decimal half-up; shares 1 decimal half-up (metric spec §12.3).
- Colors encode only the integer count vs. the grid max; no color for null states (they render messages, not maps).

---

## 7. Spatial data-quality gates (SP-X) — advisories, displayed never silently resolved

- **SP-X1 — Location completeness advisory.** `{ locatedShareOverall, byLabel (M-L2-E1 list), labelsBelowShare: [ { label, share } ] for share < 50% , locationOutOfRange, invalidLocation }`. Displayed in the Spatial section as a gate line, X-gate style (`an-flag-warn` when any label below 50% or outOfRange > 0). Non-blocking: density views still render; the advisory is the honesty mechanism.
- **SP-X2 — Foul Zone-qualifier disagreement advisory.** Count of Foul events that have **both** a location and a Zone qualifier whose third disagrees with the location's third. Per metric spec §11.6: spatial metrics use `location` only; the disagreement is reported (this gate), not resolved. Non-blocking.
- Interaction with existing gates: none of X1–X6 changes. The X1 score-reconciliation gate continues to govern CT-STATE; if ZONE × STATE cross-tabs are added in v1.1 they inherit the X1 suppression rule.

---

## 8. Testing strategy (SP-T) — for the future implementation phase

All tests are Node-runnable, following the existing harness conventions (pure-function tests + jsdom UI checks; no GUI/Electron launch in this environment).

- **SP-T1 — Determinism & purity.** `computeMatchAnalytics` twice on the same session → deep-equal/byte-identical `A.spatial`; input session deep-frozen and compared after (no mutation).
- **SP-T2 — Oracle grid.** Hand-computed fixture (~30 events incl. out-of-range x=1.2, malformed location, unlocated events, both teams, one interval Possession 301.5 s located, one unlocated 118 s): every cell, margin, bucket, share, and duration entry asserted by hand-written expected values.
- **SP-T3 — Invariants.** All seven contract invariants of §3.8 asserted programmatically over randomized-but-seeded event sets (fixture permutations), including equality with the v1 `level3.byZone/byThird/byChannel` for scope=all/partition=all (invariant 4 — guards against a silent recomputation drift).
- **SP-T4 — Unrounded-seconds regression (possession constraint).** Durations that sum to non-round values (e.g. 301.5 + 64.2 + 118 = 483.7) must appear exactly in `secondsExact`; the rendered view must show 483.7; assert no rounding happened before display (the spatial twin of the 67.3-vs-66.7 regression).
- **SP-T5 — Color scale boundaries.** `densityStep` unit tests at every boundary (0; max=0; s=0.25; s=0.25+ε; 0.50; 0.75; 1.0) and the exact rgba strings.
- **SP-T6 — Minimum-sample gate.** Grids with located = 0 / 1 / 5 / 6 render null-state vs. density per §5.4, with the reason string.
- **SP-T7 — Naming prohibitions (UI, jsdom).** Rendered Analytics HTML must contain the canonical names (§6.1) and the limitation strings (§6.3), and must **not** contain the forbidden labels of §6.2 as standalone artifact labels (word-boundary checks; the phase name may appear in code comments/commit messages but not in user-visible labels).
- **SP-T8 — Full UI render + live refresh (jsdom).** Recovered-session boot: Spatial section renders; scope selector switches grids; cell click lists events read-only; adding an event while the tab is visible updates the grid; byte-identical re-render when nothing changed; modal Team filter filters on `ev.team`.
- **SP-T9 — Player grids.** Sub events excluded; unattributed located events counted in grids' 'unattributed' partition; order cap 12 + "showing 12 of N".
- **SP-T10 — Out-of-range.** Out-of-range record: participates (clamped), flagged, `outOfRange:true`, counted in SP-X1; malformed location → unlocated bucket + `invalidLocation` count.

---

## 9. Out of scope / prohibitions (binding on the implementation phase)

1. **No change to the 3×3 model** — no sub-cells, no 4×4, no thirds renames, no second orientation.
2. **No change to the event taxonomy or data model** — no new tags, qualifiers, fields (location stays one optional `{x,y}` per event).
3. **No heat-map implementation in this task** — this document is the specification; implementation (compute + render) is the next phase.
4. **No new dependencies** — no chart/heat/canvas libraries, no d3, no npm additions, no build changes.
5. **No smoothing / interpolation / KDE / contours / gradients / blur** (SP-H2, §6.4).
6. **No video integration** — no overlays on video frames, no frame seeking from spatial views, no clip creation. Once Sport owns VIDEO → CLIPS → PLAYER MEETINGS; PitchLog owns the DATA side.
7. **No season/multi-match spatial aggregation in v1** (SP-H10).
8. **No xG/xA/PPDA/possession%-style artifacts** (NC-16/NC-3/NC-1) and no field tilt/territory naming (NC-18).
9. **No player ratings, no per-90, no physical metrics** (NC-13/NC-4) — player grids are counts only.
10. **No pass maps / pass arrows / average positions / voronoi control zones** (NC-6/7/8, §3.5).
11. **No mutation of events from any spatial view** (SP-H8) — all views are read-only reports.
12. **No extrapolation, weighting, or model-fitting of any kind** — counts and unrounded tagged durations only (P10, NC-17).

---

## 10. Implementation notes (for the next phase — NO CODE HERE)

- **Engine side**: `A.spatial` per §3, built per SP-A inside the analytics module (pure; UMD unchanged; loaded by index.html in the same position). `protocol.notes` gains one line: `TAGGED_EVENT_DENSITY: spatial views show tagged, analyst-located events over the fixed 3×3 model; no smoothing; located-share always printed (M-L2-E1)`.
- **UI side**: Analytics tab gains the "Spatial" section (SP-V1..V5) inside the existing `buildAnalyticsHtml` flow or a sibling builder; reuses `.an-*` styles + 3 new style groups (`.an-spatial-*` for section/legend/strip; `.an-grid-*` for cells/overlay; player-multiple sizing). All SVG string-built like `pitchMarkingsSvg()`.
- **Modal**: filter alignment per §5.6 (Team filter on `ev.team`; optional zone-lines toggle).
- **Tests**: extend `tests/analytics-engine-tests.js` (or a sibling `spatial-engine-tests.js`) with SP-T1..T6, T9, T10; extend `tests/analytics-ui-check.js` with SP-T7, T8.
- **Docs**: this file becomes the reviewed authority; the metric spec gains a one-line cross-reference in §13 (doc-only, as done for M-L2-B4).

---

## 11. Acceptance criteria (definition of done for the implementation phase)

1. All §3.8 invariants hold on every test fixture; SP-T1..T10 green; existing 670 checks still green (no regression in the v1 engine/UI).
2. Analytics tab renders SP-V1..V5 with canonical names, limitation strings, located-shares, unlocated strips, and the numeric twins; determinism verified byte-identical.
3. `byZone` and `byChannel` tables are rendered (closing gap §1.6-1) and equal the density grids' margins.
4. Tagged Possession Duration by Zone uses unrounded seconds internally (SP-T4) and shows both team totals with the NC-1 basis line.
5. Pitch-map modal filters on `team`; legacy `side` untouched in the data.
6. Zero source-side model changes: taxonomy, event fields, 3×3 semantics, dependencies — all unchanged (diff-verified).
7. Naming-prohibition checks (SP-T7) pass; no forbidden label appears in any user-visible string.
8. A new checkpoint is created only after the full harness is green, and the worklog entry (next Task ID) references this document.

---

## 12. Open questions for the reviewer

1. **Scoped-grid label set** (§3.4.2): are the 13 label scopes right, or should `Sub`/`Card`/`Duel`/transitions also get scoped grids? (Default here: no.)
2. **Custom tags** in scoped grids — currently `"all"`-only. Allow analyst-defined spatial scopes later?
3. **Level 2 × CT-ZONE ratios** (e.g. pass-success-by-zone) — sanctioned by the matrix but deferred; schedule for v1.1 alongside ZONE×STATE / ZONE×PERIOD cross-tabs?
4. **minSampleForDensity = 6** — confirm or tune (possession envelope used hard nulls; this is a soft visual gate).
5. **Image export of grids** (PNG/SVG download) for meeting decks — wanted in v1.1?
6. **Player-grid cap = 12** with full table below — sufficient?
7. Should the touchline pitch gain a zone overlay toggle too (currently desktop-modal only, §5.6)?

---

## Appendix A — minimal contract example (normative for shape/order)

```jsonc
"A.spatial": {
  "spec": "PitchLog-SPATIAL-SPEC-v1.0",
  "model": {
    "thirds": ["Defensive third", "Middle third", "Attacking third"],
    "channels": ["Left channel", "Central channel", "Right channel"],
    "zoneKeys": ["Defensive third · Left channel", "Defensive third · Central channel", "Defensive third · Right channel",
                 "Middle third · Left channel", "Middle third · Central channel", "Middle third · Right channel",
                 "Attacking third · Left channel", "Attacking third · Central channel", "Attacking third · Right channel"],
    "unlocatedKey": "Unlocated",
    "orientation": "T2: x=0 our goal line, x=1 opponent goal line; y=0 Left channel edge",
    "cellKeys": ["events", "goals", "shots", "chances", "crosses", "corners", "fouls", "yellowCards",
                 "redCards", "passes", "possessionIntervals", "presses", "pressWins", "interceptions",
                 "recoveries", "turnovers", "duels", "positiveTransitions", "negativeTransitions"]
  },
  "completeness": {
    "located": 3, "total": 4,
    "locatedShare": { "value": 75.0, "num": 3, "den": 4, "excluded": {} },
    "byLabel": [
      { "label": "Pass", "located": 0, "total": 1, "share": 0.0 },
      { "label": "Shot", "located": 3, "total": 3, "share": 100.0 }
    ],
    "locationOutOfRange": 0, "invalidLocation": 0
  },
  "locatedEvents": [
    { "eventId": 2, "label": "Shot", "subtype": "On target", "team": "our", "playerId": "p-7",
      "x": 0.83, "y": 0.51, "outOfRange": false, "thirdIndex": 2, "channelIndex": 1,
      "zoneKey": "Attacking third · Central channel", "period": "1H", "matchSeconds": 610,
      "minuteBin": "1H 15-30", "stateBefore": "DRAW", "sequenceId": "SEQ-001",
      "isGoal": false, "isInterval": false, "durationSecondsExact": null },
    { "eventId": 3, "label": "Shot", "subtype": null, "team": "our", "playerId": null,
      "x": 0.91, "y": 0.20, "outOfRange": false, "thirdIndex": 2, "channelIndex": 0,
      "zoneKey": "Attacking third · Left channel", "period": "1H", "matchSeconds": 1495,
      "minuteBin": "1H 30-45+", "stateBefore": "WINNING", "sequenceId": null,
      "isGoal": true, "isInterval": false, "durationSecondsExact": null },
    { "eventId": 5, "label": "Shot", "subtype": "Off target", "team": "opponent", "playerId": null,
      "x": 0.12, "y": 0.60, "outOfRange": false, "thirdIndex": 0, "channelIndex": 1,
      "zoneKey": "Defensive third · Central channel", "period": "2H", "matchSeconds": 3400,
      "minuteBin": "2H 60-75", "stateBefore": "WINNING", "sequenceId": null,
      "isGoal": false, "isInterval": false, "durationSecondsExact": null }
  ],
  "grids": [
    { "id": "grid:scope=all:partition=our", "scope": "all", "scopeLabel": "All events",
      "partition": "our", "partitionLabel": "Us", "population": 3, "located": 2, "unlocated": 1,
      "locatedShare": { "value": 66.7, "num": 2, "den": 3, "excluded": {} },
      "cells": [
        { "thirdIndex": 0, "channelIndex": 0, "zoneKey": "Defensive third · Left channel",
          "counts": { "events": 0, "goals": 0, "shots": 0, "chances": 0, "crosses": 0, "corners": 0, "fouls": 0, "yellowCards": 0, "redCards": 0, "passes": 0, "possessionIntervals": 0, "presses": 0, "pressWins": 0, "interceptions": 0, "recoveries": 0, "turnovers": 0, "duels": 0, "positiveTransitions": 0, "negativeTransitions": 0 } },
        { "thirdIndex": 0, "channelIndex": 1, "zoneKey": "Defensive third · Central channel", "counts": { "…": "all zero" } },
        { "thirdIndex": 0, "channelIndex": 2, "zoneKey": "Defensive third · Right channel", "counts": { "…": "all zero" } },
        { "thirdIndex": 1, "channelIndex": 0, "zoneKey": "Middle third · Left channel", "counts": { "…": "all zero" } },
        { "thirdIndex": 1, "channelIndex": 1, "zoneKey": "Middle third · Central channel", "counts": { "…": "all zero" } },
        { "thirdIndex": 1, "channelIndex": 2, "zoneKey": "Middle third · Right channel", "counts": { "…": "all zero" } },
        { "thirdIndex": 2, "channelIndex": 0, "zoneKey": "Attacking third · Left channel",
          "counts": { "events": 1, "goals": 1, "shots": 1, "chances": 0, "crosses": 0, "corners": 0, "fouls": 0, "yellowCards": 0, "redCards": 0, "passes": 0, "possessionIntervals": 0, "presses": 0, "pressWins": 0, "interceptions": 0, "recoveries": 0, "turnovers": 0, "duels": 0, "positiveTransitions": 0, "negativeTransitions": 0 } },
        { "thirdIndex": 2, "channelIndex": 1, "zoneKey": "Attacking third · Central channel",
          "counts": { "events": 1, "goals": 0, "shots": 1, "…": "rest zero" } },
        { "thirdIndex": 2, "channelIndex": 2, "zoneKey": "Attacking third · Right channel", "counts": { "…": "all zero" } }
      ],
      "unlocatedBucket": { "counts": { "events": 1, "passes": 1, "…": "rest zero" } },
      "margins": {
        "byThird": [
          { "index": 0, "name": "Defensive third", "events": 0 },
          { "index": 1, "name": "Middle third", "events": 0 },
          { "index": 2, "name": "Attacking third", "events": 2 }
        ],
        "byChannel": [
          { "index": 0, "name": "Left channel", "events": 1 },
          { "index": 1, "name": "Central channel", "events": 1 },
          { "index": 2, "name": "Right channel", "events": 0 }
        ]
      }
    }
    /* … partitions 'opponent' (Defensive third · Central: 1 shot), 'unattributed' (empty),
         'all'; then one scoped-grid entry per label with located events ('Shot') × 4 partitions … */
  ],
  "playerGrids": [
    { "id": "grid:player=p-7", "scope": "all", "scopeLabel": "All events", "partition": "player:p-7",
      "playerId": "p-7", "name": "7 Striker", "number": "9",
      "population": 1, "located": 1, "unlocated": 0,
      "locatedShare": { "value": 100.0, "num": 1, "den": 1, "excluded": {} },
      "cells": [ "…one event in Attacking third · Central channel…" ],
      "unlocatedBucket": { "counts": { "…zero…" } }, "margins": { "…" } }
  ],
  "possessionDurationByZone": {
    "name": "Tagged Possession Duration by Zone",
    "basis": "Recorded PitchLog Possession interval tags ONLY — not an official match possession statistic (NC-1)",
    "attribution": "single tagged point per interval (interval start semantics, T2 orientation)",
    "our":       { "locatedIntervals": 0, "unlocatedIntervals": 0, "secondsExact": { "cells": [0,0,0,0,0,0,0,0,0], "unlocated": 0 }, "totalSecondsExact": 0 },
    "opponent":  { "locatedIntervals": 0, "unlocatedIntervals": 0, "secondsExact": { "cells": [0,0,0,0,0,0,0,0,0], "unlocated": 0 }, "totalSecondsExact": 0 },
    "unattributed": { "locatedIntervals": 0, "unlocatedIntervals": 0, "secondsExact": { "cells": [0,0,0,0,0,0,0,0,0], "unlocated": 0 }, "totalSecondsExact": 0 }
  },
  "gates": {
    "SP-X1": { "locatedShareOverall": 75.0, "labelsBelowShare": [{ "label": "Pass", "share": 0.0 }], "locationOutOfRange": 0, "invalidLocation": 0 },
    "SP-X2": { "foulZoneQualifierMismatches": 0 }
  },
  "params": { "minSampleForDensity": 6 },
  "limitations": [
    "Locations are analyst-tagged samples of tagged events only — not positional tracking; unlocated events are excluded from the grid and reported below.",
    "Based ONLY on recorded PitchLog Possession interval tags (single tagged point per interval) — not an official match possession statistic (NC-1); unrounded seconds summed internally, rounded for display only.",
    "Orientation per tagging protocol T2: x = 0 our goal line → x = 1 opponent goal line; Left channel at y = 0."
  ]
}
```

— END OF SPECIFICATION —

**Do not implement from this document until it is reviewed and approved.** No source files were modified in producing it.
