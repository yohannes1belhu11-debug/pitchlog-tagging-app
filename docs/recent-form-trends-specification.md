# PitchLog Recent Form & Descriptive Trends V1 Specification

**Document ID:** `PitchLog-RECENT-FORM-SPEC-v1.0-reestablished`
**Status:**

> **RE-ESTABLISHED SPECIFICATION — NEW AUTHORITATIVE DOCUMENT**
>
> The original Recent Form V1 specification artifact was not recoverable
> from the current repository or workspace. This document therefore
> establishes a new authoritative specification from the project decisions
> already explicitly approved before implementation. It is NOT a recovered
> copy of the missing document.

**Authored against:** Player & Season Core `1.0.0` (`PitchLog-PLAYER-SEASON-SPEC-v1.0`) at checkpoint `4b0d20c` (`pitchlog-player-season-opponent-channel-fix`), including Analytics Engine `1.1.0` (Spatial Engine V1). All capability claims in §1 were verified against the actual source tree at authoring time.
**Predecessors:** `docs/metric-specification.md` (`PitchLog-METRIC-SPEC-v1.0`, implemented), `docs/spatial-heatmap-specification.md` (`PitchLog-SPATIAL-SPEC-v1.0`, implemented), `docs/player-season-data-specification.md` (`PitchLog-PLAYER-SEASON-SPEC-v1.0`, core implemented).
**Reviewer roles:** football performance analyst (methodology), data-model architect (structure), developer (implementability).

---

## 0. How to read this document

1. This specification defines the **RECENT FORM & DESCRIPTIVE TRENDS layer V1** (Implementation 2 of the player-data chain): the pure deterministic layer that turns the Player & Season Core output (`PS`) into recent-window evidence — recent totals, averages, pooled percentages, reliable-minute per-90, dual-baseline comparisons, Recent 5 vs Previous 5, observed variability, with/without observational splits, team recent windows.
2. **Precedence.** The older draft text in `docs/player-season-data-specification.md` §5.3–§5.8 (last-N with default N=5, first-vs-last-third trends, etc.) is **superseded by this document** wherever the two differ. The draft remains in place as historical review text; at implementation time a doc-only delta marker should be added to that file's IMPLEMENTATION STATUS section pointing here (no methodology text may be silently rewritten).
3. **Approval status marking.** Sections marked `APPROVED` restate decisions already explicitly approved before implementation; they are normative and must not be reopened by this document. Items marked `DEFINED IN THIS SPEC` are deterministic definitions required to make the approved methodology implementable (rounding, boundary behavior, key vocabularies); they follow the house conventions of the implemented specs. Items genuinely unresolved are listed ONLY in §33 (Open Questions), marked `OPEN` — never silently inside methodology sections.
4. **Source of truth.** Current technical capability claims cite the actual current source (`src/player-season.js`, `src/analytics.js`, `src/renderer.js`, `src/index.html`). Recent Form methodology comes ONLY from the approved decisions restated here; no unapproved external methodology is imported.
5. **Nothing in this document is implemented yet.** Implementation happens in controlled phases (§34), after review approval, as separate tasks.

---

## 1. Verified technical foundation (source-inspected)

Everything Recent Form consumes already exists in the Player & Season Core output `PS = PlayerSeasonEngine.computeSeason(sessions)`. Verified facts (current source, checkpoint `4b0d20c`):

### 1.1 Datasets

- `PS.playerMatchRecords` — one record per player×match: `matchIndex`, `matchKey {loadIndex, sourceFile, savedAt, label}` (external identity — events carry no matchId), `playerId`, `name`, `number`, `unresolvedPlayer`, context fields, `participation`, `minutes`, `metrics`, `spatial`, `periods`, `gameState`, `gameStateSuppressedReason`, `dataQuality`.
- `PS.players[pid]` + `PS.playerOrder` — player season records: appearances, starts, minutes rollup (RELIABLE/MIXED/ESTIMATED/UNAVAILABLE), `totals`, `averagesPerAppearance`, pooled `percentages`, gated `per90`, `spatial`, `periods`, `gameState`, `dataQuality`, `matchRecordIndexes` (record list in season order).
- `PS.matches` — team match records: result (`outcome W/D/L`, source MANUAL/CHAIN, `x1Status`, `reason`), `durationMinutes`, `ftMarkerPresent`, tagged event totals (our/opponent/unattributed), `derived` ratio envelopes (our/opponent), possession (NC-1 basis), `spatial` (our/opponent/all), `periods`, `gameState` (X1-suppressed), `appearanceCounts`, `dataQuality`.
- `PS.teamSeason` — pooled team season record (W/D/L, totals, percentages, possession, spatial, periods, gameState, averagesPerMatch).
- `PS.coverage` — `completeMatchRecords` / `partialMatchRecords` (see §2.2), minutes-quality record counts.
- `PS.identityAudit`, `PS.gates`, `PS.protocol` (notes, minutes standards).

### 1.2 Exact vocabularies (source is authority)

- **Player count metrics** (per record `metrics` / season `totals`): `events, goals, shots, shotsOnTarget, chances, keyPasses, crosses, passes, successfulPasses, unsuccessfulPasses, passesUnknownOutcome, presses, pressWins, interceptions, recoveries, turnovers, duels, fouls, yellowCards, redCards, positiveEvents, negativeEvents, neutralEvents, transitionsPositive, transitionsNegative` (+ `subOn, subOff` participation markers; + `byLabel` copy + `passSuccess` envelope).
- **Per-90 metric family** (PS `PER90_KEYS`): `events, goals, shots, shotsOnTarget, chances, keyPasses, crosses, passes, presses, pressWins, interceptions, recoveries, turnovers, duels, fouls, transitionsPositive, transitionsNegative`.
- **Team count keys** (PS `TEAM_COUNT_KEYS`, our/opponent/unattributed partitions): `events, goals, shots, shotsOnTarget, shotsOffTarget, shotsBlocked, shotsUnknownOutcome, chances, crosses, corners, fouls, yellowCards, redCards, substitutions, passes, successfulPasses, unsuccessfulPasses, passesUnknownOutcome, progressivePasses, lateralPasses, backwardPasses, longPasses, passesUnderPressure, presses, pressWins, interceptions, recoveries, turnovers, duels, positiveTransitions, negativeTransitions`.
- **Ratio envelopes** available per record: player `passSuccess`; team `passSuccess, shotAccuracy, shotConversion, chanceConversion, pressWinRatio` (our + opponent). Envelope shape: `{ value, num, den, excluded, params? }`.
- **Participation statuses** (9-status enum): `STARTED, STARTED_FULL, STARTED_SUBBED_OFF, STARTED_SENT_OFF, SUB_ON, SUB_ON_SUBBED_OFF, SUB_ON_SENT_OFF, UNUSED_SUB, NOT_INVOLVED, UNKNOWN`; `participation.appearance = starter || substitute` (invariant-tested against the Analytics Engine).
- **Minutes**: per-record `minutes { value, secondsExact, onPitchIntervals, quality: RELIABLE | ESTIMATED | UNAVAILABLE, reasonCodes, basis }`; season rollup adds `MIXED`.
- **Spatial**: per-player `zones` (9 keys `'<third> · <channel>'` + `Unlocated`), `thirds` (`Defensive third, Middle third, Attacking third` + Unlocated), `channels` (`Left channel, Central channel, Right channel` + Unlocated), `located`, `unlocated`, `locatedShare` — copies of `A.spatial.playerGrids` (invariant PSD-T3: season grid = sum of per-match grids).
- **Periods**: `1H, 2H, ET1, ET2` (+ `Non-play, Unknown` buckets in partitions), `matchSeconds` semantics on all engine records.
- **Event score states** (source keys): `WINNING, DRAW, LOSING` (displayed as Winning/Drawing/Losing), X1-MISMATCH suppression nulls the partitions with `gameStateSuppressedReason`.
- **Season ordering** (deterministic, 4-key): `date` asc empty-last → `savedAt` asc null-last → `sourceFile` asc null-last → `loadIndex` asc. Player order: appearances desc → totals.events desc → playerId asc.

### 1.3 Precision and envelope conventions (house rules, reused verbatim)

- `roundHalfUp1(x)` = `Math.round((x + Number.EPSILON) * 10) / 10` — all displayed rates/percentages carry 1 decimal.
- `pct1(num, den)` = `null` when `den ≤ 0`, else `roundHalfUp1(num/den × 100)`.
- Per-90 value = `roundHalfUp1(total × 5400 / reliableSeconds)` with the raw `total` retained alongside.
- Percentages aggregate by **summing `num` and `den` first** (`sumEnvelopes` pattern) — never by averaging match percentages.

### 1.4 Integration seam

`src/index.html` loads `integrity.js → analytics.js → player-season.js → renderer.js`. The future `src/recent-form.js` is a UMD module (global `window.RecentFormEngine`, Node `module.exports`) inserted between `player-season.js` and `renderer.js`; the season view entry point `renderSeasonStats()` (renderer.js, currently ~2783) already recomputes `PS` on every render — Recent Form derives from that same `PS` object.

---

## 2. Units (RF-U) — APPROVED

### 2.1 Player unit: ACTUAL APPEARANCE

A player recent-form unit is an **actual appearance**: the player started the match (named in the starting XI) **or** entered as a substitute (Sub `playerOn` reference, engine M-G1 semantics — exactly `participation.appearance === true` in the PS Core).

- **Include:** starter; substitute who actually entered.
- **Exclude:** unused substitute (`UNUSED_SUB`); selected but never entered (`NOT_INVOLVED` when provable; `UNKNOWN` when participation cannot be determined); absent player (no record at all).
- **An appearance is not discarded merely because a derived metric is unavailable** (e.g., minutes UNAVAILABLE, PARTIAL data quality). Such appearances stay in the window with their quality flags propagated (§19).

### 2.2 Team unit: COMPLETED MATCH

A team recent-form unit is a **completed match**, using the Player & Season Core's approved completed-match criteria — exactly the PS Core's `completeMatchRecords` rule: **`match.dataQuality.status === 'VALID'`** (coverage block, player-season.js).

- **Never silently treat as completed:** an incomplete match (e.g., `INCOMPLETE_MATCH_NO_FT`), or a no-result match (`MISSING_FINAL_SCORE` / result `outcome === null` / `NO_SCORE_SOURCE`). Both are excluded from team windows with the exclusion recorded (§20).
- A player appearance inside a match that is not team-completed **still counts for the player unit** (the units are deliberately independent; the asymmetry is disclosed by sample-visibility fields, not hidden).

---

## 3. Windows and ordering (RF-W) — APPROVED

### 3.1 Window sizes

| Unit | Windows |
|---|---|
| Player | Last **3** appearances, Last **5** appearances, Last **10** appearances |
| Team | Last **3** completed matches, Last **5** completed matches, Last **10** completed matches |

### 3.2 Insufficient sample rule

If fewer than the requested number exist, **report the true sample size**. Never pad a window. Never create artificial zero-valued matches or appearances. `available` (true count) is always printed; `included` equals `min(requested, available)`.

### 3.3 Ordering

Windows take the **last N units in the exact Player & Season deterministic ordering** (§1.2: date → savedAt → sourceFile → loadIndex, ascending, with the documented null/empty placement). Recent Form introduces **no second ordering mechanism** — it reads the already-ordered `PS` record sequence (player: `matchRecordIndexes` order; team: `PS.matches` order).

DEFINED IN THIS SPEC — window construction: for a player with records `[r1 … rn]` in season order, the Last-N window is `[r(n−N+1) … rn]` (or all records when `n < N`); for the team, the same slice over completed matches only.

---

## 4. Recent totals (RF-TOT) — APPROVED

Recent totals **consume metrics already produced by the Player & Season Core**; raw events are never recounted (§24 architecture; test-asserted, not assumed).

The metric set is **exactly what the current PS contract provides** (§1.2): the player tagged-count family (all 25 keys of §1.2's player count metrics — `events` … `transitionsNegative`, including `successfulPasses`, `unsuccessfulPasses`, `passesUnknownOutcome`, `neutralEvents`), plus the team count family for team windows. `subOn`/`subOff` are participation markers and are carried by the participation block, not by window totals. Metrics absent from the PS contract are **not invented** by this layer.

---

## 5. Recent averages (RF-AVG) — APPROVED

- **Player:** `recent total ÷ valid appearances` (appearances = window units of §2.1). `roundHalfUp1`, `null` when the window is empty.
- **Team:** `recent total ÷ valid completed matches` (window units of §2.2).
- **Unused substitutes are not appearances. Absent players are not appearances.** The denominator is `included`, never `requested`, never selections.

---

## 6. Per-90 (RF-P90) — APPROVED

Per-90 is permitted **ONLY using reliable minutes**.

- **Formula:** `metric total ÷ reliable minutes × 90` (house form: `roundHalfUp1(total × 5400 / reliableSeconds)`).
- **Estimated minutes MUST NOT be used as a denominator. Unavailable minutes MUST NOT be used.**
- **Mixed-quality window:** per-90 uses **only the reliable-minute subset** of the window — both the summed `secondsExact` denominators AND the metric numerators are restricted to records whose `minutes.quality === 'RELIABLE'` (numerator/denominator must describe one record set; house rule from the PS Core).
- **Mandatory disclosure triple on every per-90 block:** total appearances in window; appearances included in per-90; reliable minutes used.
- **If reliable minutes = 0: per-90 = null** (never 0, never `matches × 90`).
- Metric family = PS `PER90_KEYS` (§1.2) — no additions.

---

## 7. Percentage aggregation (RF-PCT) — APPROVED

**Never average match percentages. Pool numerators and denominators first.**

- Player windows: `passSuccess` pooled from per-record envelopes; `pressWinRatio` = `ΣpressWins / Σpresses`; `locatedShare` = `Σlocated / (Σlocated + Σunlocated)` — the same three families and envelope shapes as the PS player season record.
- Team windows: `passSuccess, shotAccuracy, shotConversion, chanceConversion, pressWinRatio`, our and opponent, pooled from the per-match `derived` envelopes; tagged possession share pooled from exact seconds both sides with the **NC-1 basis string verbatim** (tagged intervals, never official possession).

Worked anchor (normative): `4/5 + 10/20` pools to **`14/25 = 56%`**; the forbidden alternative `(80% + 50%) / 2 = 65%` must never appear. Numerator and denominator are **retained** wherever the underlying metric supports them (envelope `{value, num, den, excluded}`).

---

## 8. Dual baselines (RF-BASE) — APPROVED

Every recent comparison uses **two** baselines:

- **BASELINE A — Full valid season:** the Player & Season Core season values (`PS.players[pid].totals / percentages / per90`, team `PS.teamSeason`), consumed directly.
- **BASELINE B — Season excluding the selected recent window:** computed over the remaining records (pooled percentages recomputed from the remaining envelopes; per-90 recomputed from the remaining reliable minutes; NOT obtained by subtracting rates).

**Reconciliation invariant (additive metrics):** `recent window total + Baseline B total = full-season total` — exact for integer counts (e.g., 38 + 10 = 48 recoveries). Envelope reconciliation: `window.num + B.num = A.num`, same for `den`. This is a test-asserted invariant (RF-T12).

**Suppression rule:** if the selected window contains the entire available season (e.g., 5 total appearances with the 5-window selected), **Baseline B is unavailable/suppressed** — reported with reason `WHOLE_SEASON_IN_WINDOW`, never fabricated, never zero-filled.

DEFINED IN THIS SPEC — the *selected* window for Baseline B is a parameter (`options.selectedWindow`, default 5); Baseline A comparisons are reported for every window, Baseline B for the selected one.

---

## 9. Recent vs baseline (RF-CMP) — APPROVED

For supported metrics, each comparison reports:

`recent value · baseline value · absolute difference · percentage difference (where valid) · sample size · included sample · exclusions · tolerance · classification`

- **Allowed classifications:** `HIGHER · LOWER · WITHIN-TOLERANCE · INCONCLUSIVE`.
- **Percentage difference where valid:** `(recent − baseline) / baseline × 100`, `roundHalfUp1`; valid ONLY when both values are numbers and `baseline ≠ 0`; otherwise `null` (never a fabricated ∞).
- **INCONCLUSIVE when:** the window is empty; the baseline value is `null`/undefined for that metric; the denominator basis is 0; Baseline B is suppressed (for B-comparisons); or sample-visibility gates fail.
- User-facing output **must NOT classify a player as** improving / declining / better / worse / good form / bad form (§25). Classification is a property of **numbers**, never of the player.

---

## 10. Tolerance (RF-TOL) — APPROVED + DEFINED

- **Count/rate comparisons** (additive counts, per-appearance averages, per-90 values): `max(1, 0.1 × baseline)`.
- **Percentage comparisons** (envelope metrics — `passSuccess`, `shotAccuracy`, … ): `5.0` **percentage points** (difference computed in pp).
- **Tolerance must be explicitly reported** with every comparison (rule id + numeric value).
- **Boundary behavior (deterministic):** `|difference| ≤ tolerance` → `WITHIN-TOLERANCE` (boundary is **inclusive**); `|difference| > tolerance` → `HIGHER` if `recent > baseline`, `LOWER` if `recent < baseline`. Ties and exact-boundary cases are thereby fully determined; no floating-point ambiguity is permitted in tests (use the hand-computed decimal fixtures of §32).

---

## 11. Recent 5 vs Previous 5 (RF-R5P5) — APPROVED

- **Eligibility:** at least **10 valid appearances** (player unit, §2.1).
- **Recent 5** = the five most recent appearances. **Previous 5** = the five appearances immediately before them (records `n−9 … n−5` in season order).
- **If fewer than 10 valid appearances:** overall classification = `INCONCLUSIVE` with the **true sample size shown**; the Recent-5 block itself may still display (it is an ordinary window), but the Previous-5 block and per-metric comparisons are suppressed with reason `INSUFFICIENT_APPEARANCES`. **Never fabricate Previous 5.**
- Per-metric comparisons (difference, tolerance per §10, classification) follow §9; pooled percentages and per-90 within each 5-block follow §6–§7; the per-90 disclosure triple applies to each block.

---

## 12. Observed variability (RF-VAR) — APPROVED

V1 supports **ONLY**: `minimum · maximum · range · mean · median` — over the per-appearance series of the window's count metrics.

- **No** standard deviation, variance, coefficient of variation, consistency index, consistency score. **Never classify a player as "inconsistent."**
- The user-facing label is **"Observed Variability"**.
- DEFINED IN THIS SPEC — deterministic statistics: `range = max − min`; `mean = roundHalfUp1(Σ/n)`; `median` = middle element of the ascending-sorted series for odd `n`, arithmetic mean of the two middle elements (`roundHalfUp1`) for even `n`. Series with `n = 0` → all statistics `null`.

---

## 13. With/without player (RF-WW) — APPROVED

This is an **OBSERVATIONAL comparison**. No causal claims of any kind.

- **WITH:** the player actually appeared (`participation.appearance === true`). **An unused substitute is NOT WITH.**
- **WITHOUT:** the player did not appear, subject to the established Player & Season participation/XI rules (`NOT_INVOLVED`, or `UNUSED_SUB`, or no record for that match).
- **If participation cannot be determined** (`UNKNOWN`, e.g., no starting XI): the match is counted as **UNRESOLVED** — reported as a count, excluded from both groups.
- **Normal comparison requires at least 3 valid matches in BOTH groups.** Below that: status `INSUFFICIENT_SAMPLE` — but the **actual group sizes and available data are still displayed** (never hidden).
- Reported per group: matches, W/D/L, goals for/against, our-team tagged event totals. Comparisons (difference, tolerance, classification) only when the 3v3 gate passes.
- Standing note (exact string, user-facing, always attached): *"Observational split by tagged participation only — small samples, no causal claim; the team record with/without a player is not a player-value measurement."*
- Forbidden output (verbatim examples): "team performs better because of player" or any equivalent causal phrasing.
- DEFINED IN THIS SPEC — the with/without universe is the **team unit** (§2.2, completed matches), so W/D/L classification is result-based; group sizes and the unresolved count are always printed (§20).

---

## 14. Team recent form (RF-TEAM) — APPROVED

Windows: last 3 / 5 / 10 **completed matches** (§2.2). Where supported, each team window reports:

- `wins, draws, losses` (+ `noResult`/`flaggedResults` counts where relevant), `goalsFor, goalsAgainst`;
- team tagged event totals (our side primary; opponent partitions available as consumed from `PS.matches`);
- per-match averages (our-side count family ÷ completed matches);
- pooled percentages (§7), including tagged possession share with the NC-1 basis string.

**Do not invent official possession** — the only possession figure permitted is the tagged-interval pooled share carrying the NC-1 disclaimer verbatim.

---

## 15. Match result vs event score state (RF-STATE) — APPROVED

These are **separate constructs and must never be conflated**:

- **MATCH RESULT** (final, per `PS.matches[].result`): `WIN · DRAW · LOSS` (source MANUAL/CHAIN, X1 status propagated).
- **EVENT SCORE STATE** (in-match, per partitions): `WINNING · DRAW · LOSING` (source keys; displayed Winning/Drawing/Losing), X1-MISMATCH suppression nulls the block.

Recent Form never treats them as the same construct, never derives one from the other, and labels them distinctly in every output.

---

## 16. Spatial reuse (RF-SP) — APPROVED

Recent Form **consumes existing Player & Season / Spatial Engine spatial data** and creates **no new spatial calculation methodology**.

- **Allowed:** located events, unlocated events, thirds, channels, 3×3 zone sums — the per-record `spatial` blocks summed over a window (invariant: window spatial = Σ per-record grids, carrying PSD-T3 into windows; season grid = Σ windows + remainder).
- **Not allowed — do not create:** average position, territory, field tilt, positional tracking claims (forbidden names §25).
- Any density presentation reuses the existing deterministic presentation and its **minimum-sample gate (6 located events) with the exact approved insufficient message** (spatial spec §5, verbatim).

---

## 17. Game state (RF-GS) — APPROVED

Preserve `WINNING / DRAW / LOSING` using **recorded event score state** (the PS partitions; X1-suppressed matches propagate the suppression reason, never zero-filled). **No causal inference from the state** — states are descriptive partitions of tagged events, nothing more.

---

## 18. Period (RF-PER) — APPROVED

Preserve `1H / 2H / ET1 / ET2` (plus the `Non-play / Unknown` partition buckets) where applicable, using the **existing period + `matchSeconds` semantics** of the engine records. **`officialMinute` alone is never used** as a time basis.

---

## 19. Data quality (RF-DQ) — APPROVED

Recent Form **propagates existing Player & Season quality flags** — it never invents its own quality system. Propagated examples:

- unreliable minutes (`minutes.quality ≠ RELIABLE`, `UNRELIABLE_MINUTES` flag);
- unresolved player (`unresolvedPlayer`, identity audit);
- incomplete match (`INCOMPLETE_MATCH_NO_FT`, PARTIAL status);
- duplicate match (PS `PSD_X1` gates — already excluded from aggregation);
- missing data (missing location — `MISSING_LOCATION`, `LOW_LOCATION_COVERAGE` informational);
- X1 mismatch (`INCONSISTENT_GOAL_CHAIN`, state partitions suppressed);
- missing match identity (`MISSING_MATCH_IDENTITY`).

**Never silently convert unavailable data into zero.** A window-level rollup distinguishes `VALID / PARTIAL / INSUFFICIENT` exactly as the PS Core defines them: `VALID` — every included record VALID; `PARTIAL` — ≥1 included record PARTIAL; `INSUFFICIENT` — window empty (no included records).

---

## 20. Sample visibility (RF-SV) — APPROVED

- **Every recent window shows:** requested sample, available sample, included sample, excluded records (with match reference), exclusion reasons.
- **Every with/without comparison shows:** WITH sample size, WITHOUT sample size, unresolved count (where applicable).
- **Every per-90 shows:** window appearances, per-90 included appearances, reliable minutes.

These fields are part of the output contract (§30), not optional decoration.

---

## 21. Player identity (RF-ID) — APPROVED

- **Stable `playerId` is the identity.** Never aggregate by name. A name change does not create a second player.
- Conflicting identity information (name drift, possible duplicate persons) is **flagged** by reusing the PS `identityAudit` output — never merged, never auto-renamed, never re-detected by a second system.

---

## 22. Duplicates (RF-DUP) — APPROVED

**Reuse the Player & Season duplicate-match handling.** Recent Form creates **no second duplicate identity system.** Because `computeSeason` already excludes exact `sourceFile` duplicates and audits same-`savedAt` / same-label look-alikes before aggregation, the record sequence Recent Form windows over is already deduplicated — **duplicate matches cannot inflate recent windows, baselines, totals, or averages**. The PS `gates`/`duplicateSessions` output is propagated into RF data quality (§19) so exclusions stay visible.

---

## 23. Determinism and purity (RF-DET) — APPROVED

The implementation must:

- produce **identical output for identical input** (byte-identical on re-run);
- use **deterministic ordering** (§3.3 — the PS ordering only);
- perform **no I/O** inside the analytical calculation;
- perform **no time-dependent calculation** (no `Date.now`, no clocks);
- **mutate no source data** (the `PS` object is consumed read-only; test-asserted by deep comparison before/after).

---

## 24. Architecture (RF-ARCH) — APPROVED

```text
MATCH SESSIONS (saved .json, schema v3)
↓
ANALYTICS ENGINE V1 (analytics.js — UNCHANGED)
↓
PLAYER & SEASON CORE (player-season.js — computeSeason)
↓
RECENT FORM (recent-form.js — computeRecentForm(PS, options))   ← this layer
↓
UI (renderer.js season view)
```

Recent Form **consumes Player & Season output**. It **does not reread raw events** and **does not duplicate event counting** (engine-reuse is test-asserted: window totals must equal the sum of the consumed PS record metrics — reconciliation invariants RF-T21). It does not modify the Analytics Engine, the Spatial Engine, or the event schema; no `matchId` is added to events; the module is a pure function over `PS`.

---

## 25. User-facing language (RF-LANG) — APPROVED

**Allowed labels:** `Recent Form · Recent Activity · Season Baseline · Baseline Excluding Recent Window · Observed Change · Difference · Higher · Lower · Within Tolerance · Inconclusive · Observed Variability · Sample Size · Reliable Minutes` (plus the neutral metric names).

**Forbidden user-facing:** `Form Score · Performance Score · Player Rating · Consistency Score · Improving · Declining · In Form · Out of Form · Momentum · Confidence · Sharpness · Prediction` — and any causal language, plus the project-wide forbidden set (x-anything, heat map, possession %, field tilt, average position, territory). Implementation acceptance includes a grep test over rendered output (house convention from the PS UI check).

---

## 26. AI boundary (RF-AI) — APPROVED

**No AI in this layer.** The output is numerical/descriptive evidence. Future AI will consume this layer (that consumer is out of scope here and adds no obligation to this specification).

---

## 27. No player rating (RF-RATING) — APPROVED

No: player score, rating, ranking, form index, performance index, best/worst player. Nothing in this layer ranks players.

---

## 28. No predictive analytics (RF-PRED) — APPROVED

No: prediction, regression, statistical significance, causal inference, forecasting. Comparisons are descriptive arithmetic with explicit tolerances (§10).

---

## 29. Scope (RF-SCOPE) — APPROVED

Keep V1 realistic for the agreed project target — **most likely useful completion: October 19 – November 2, 2026**. V1 is exactly the layer specified in this document: **no new analytics project**. The deferral list of §35 (Prohibitions) is normative.

---

## 30. Output contract (RF-C) — APPROVED / DEFINED

Single entry point (pure function):

```js
RecentFormEngine.computeRecentForm(PS, options) → RF
// options: { windows: [3,5,10] (default), selectedWindow: 3|5|10 (default 5) }
// PS: the PlayerSeasonEngine.computeSeason output, consumed read-only
```

```js
RF = {
  spec: 'PitchLog-RECENT-FORM-SPEC-v1.0-reestablished',
  engine: { version, spec, deterministic: true, psEngineVersion, psSpec },
  input: {
    orderedMatchCount, completedMatchCount, optionsEcho,
    selectedWindow
  },
  players: { [playerId]: PlayerRecentForm },   // keyed, like PS.players
  playerOrder: [...],                          // REUSES the PS playerOrder verbatim
  team: TeamRecentForm,
  dataQuality: { status: 'VALID'|'PARTIAL'|'INSUFFICIENT', propagatedFlags: [...] },
  protocol: { notes: [...], params: { windows, selectedWindow } }
}

PlayerRecentForm = {
  playerId, name, number,                       // canonical, from PS
  appearancesTotal, recordsInSeason,
  windows: { '3': PlayerWindow, '5': PlayerWindow, '10': PlayerWindow },
  recentVsPrevious5: RecentVsPrevious5,
  variability: { '3': VariabilityBlock, '5': VariabilityBlock, '10': VariabilityBlock },
  withWithout: WithWithout,
  dataQuality: { status, flags }                // propagated (§19)
}

PlayerWindow = {
  requested, available, included,               // §20 sample visibility
  matchIndexes: [...],                          // season-order slice (§3.3)
  excludedRecords: [ { matchIndex, reason } ],
  totals:        { <25 count keys of §1.2> },
  averagesPerAppearance: { <count keys>: value|null },
  percentages:   { passSuccess: env, pressWinRatio: env, locatedShare: env },
  per90: {
    basis: <PS MINUTES_STANDARDS.per90Basis, verbatim>,
    appearancesInWindow, appearancesIncludedInPer90, reliableSeconds,
    minutesQuality: 'RELIABLE'|'MIXED'|'ESTIMATED'|'UNAVAILABLE',
    metrics: { <PER90_KEYS>: { value, total } }
  },
  spatial: { located, unlocated, thirds, channels, zones },   // §16 sums
  dataQuality: { status, flags }
}

BaselineComparison (per metric, for every window vs Baseline A,
                    and for the selected window vs Baseline B) = {
  metric,
  recent:    { value, sample },
  baselineA: { value, sample },
  baselineB: { value, sample, available: bool, reason: null|'WHOLE_SEASON_IN_WINDOW' },
  differenceA, differenceB,                     // absolute
  percentDifferenceA: value|null,               // §9 validity rule
  tolerance: { rule: 'MAX_1_OR_10PCT_BASELINE'|'FIXED_5PP', value, boundary: 'INCLUSIVE' },
  classificationA, classificationB: 'HIGHER'|'LOWER'|'WITHIN-TOLERANCE'|'INCONCLUSIVE'
}

RecentVsPrevious5 = {
  eligibility: 'COMPARISON'|'INCONCLUSIVE',
  appearancesTotal,
  recent5:   { included, totals, averagesPerAppearance, percentages, per90 } | null,
  previous5: { included, totals, averagesPerAppearance, percentages, per90 } | null,
  comparisons: { [metric]: { difference, tolerance, classification } } | null,
  reason: null | 'INSUFFICIENT_APPEARANCES'
}

VariabilityBlock = { [metric]: { min, max, range, mean, median, matches } }

WithWithout = {
  with:    { matches, wins, draws, losses, goalsFor, goalsAgainst, totals: {our-team counts} },
  without: { matches, wins, draws, losses, goalsFor, goalsAgainst, totals: {our-team counts} },
  unresolved: n,
  status: 'COMPARISON'|'INSUFFICIENT_SAMPLE'|'UNRESOLVED',
  standingNote: <exact string §13>,
  comparisons: { [metric]: { difference, tolerance, classification } } | null
}

TeamRecentForm = {
  completedMatchesTotal,
  windows: { '3': TeamWindow, '5': TeamWindow, '10': TeamWindow },
  dataQuality: { status, flags }
}

TeamWindow = {
  requested, available, included,
  matchIndexes: [...],
  excludedMatches: [ { matchIndex, reason } ],
  results: { wins, draws, losses, noResult, flaggedResults },
  goalsFor, goalsAgainst,
  totals: { our: {<TEAM_COUNT_KEYS>}, opponent: {<TEAM_COUNT_KEYS>} },
  averagesPerMatch: { our: {<TEAM_COUNT_KEYS>} },
  percentages: { our: {passSuccess, shotAccuracy, shotConversion, chanceConversion, pressWinRatio},
                 opponent: {same} },
  taggedPossessionShare: env | null,            // NC-1 basis string attached, never official
  dataQuality: { status, flags }
}
```

Every derived result retains, where applicable: `value · numerator · denominator · sample size · included sample · excluded sample · reason · comparison · tolerance · methodology/version` — carried by the structures above (envelopes carry num/den; windows carry sample visibility; comparisons carry tolerance + classification; `RF.spec/engine` carry methodology/version).

---

## 31. Test specification (RF-T) — APPROVED

Node, pure-function style, mirroring the house conventions of the existing suites (check() counts, explicit process.exit, hand-computed fixtures). Suites to create at Phase B: `tests/recent-form-tests.js` (engine) and `tests/recent-form-ui-check.js` (jsdom, real `index.html` + all scripts).

| ID | Acceptance test |
|---|---|
| RF-T1 | Last 3 window — exact slice, hand-computed totals |
| RF-T2 | Last 5 window — exact slice, hand-computed totals |
| RF-T3 | Last 10 window — exact slice, hand-computed totals |
| RF-T4 | Insufficient windows — true sample size, no padding, no artificial zeros |
| RF-T5 | Unused substitute exclusion — `UNUSED_SUB` never a unit; `NOT_INVOLVED`/`UNKNOWN` handling; appearance-with-unavailable-metric retained |
| RF-T6 | Reliable-minute per-90 — exact value, disclosure triple, null at 0 reliable minutes |
| RF-T7 | Mixed minute quality — per-90 uses only the reliable subset (numerator + denominator), disclosure shows subset |
| RF-T8 | Unavailable minutes — never a denominator; per-90 null; no zero-fill |
| RF-T9 | Pooled percentages — 4/5 + 10/20 = 14/25 = 56% fixture; mean-of-percentages (65%) rejected |
| RF-T10 | Full-season baseline — Baseline A equals `PS.players[pid]` values (consumed, not recomputed) |
| RF-T11 | Excluded-window baseline — Baseline B recomputed over remaining records (percentages pooled, per-90 recomputed) |
| RF-T12 | Baseline reconciliation — window + B = A for additive metrics and envelope num/den (38 + 10 = 48 fixture) |
| RF-T13 | Recent 5 vs Previous 5 — valid 10-appearance comparison, classification by tolerance |
| RF-T14 | <10-appearance suppression — INCONCLUSIVE, true sample size, Previous 5 never fabricated |
| RF-T15 | Observed variability — min/max/range/mean/median hand-checked; even-n median rule; no SD/CV anywhere |
| RF-T16 | With/without 3v3 — both groups ≥3 → comparison; unused-sub NOT WITH; observational note present |
| RF-T17 | Below-3 suppression — INSUFFICIENT_SAMPLE with group sizes and data still displayed |
| RF-T18 | Team windows — completed-match units only; incomplete/no-result matches excluded with reasons |
| RF-T19 | Duplicates — PS-excluded duplicate sessions do not inflate any window/baseline (fixture with a doubled sourceFile) |
| RF-T20 | Data-quality propagation — PARTIAL/INSUFFICIENT rollups, flags surfaced, no unavailable→zero conversion |
| RF-T21 | Spatial reconciliation — window spatial = Σ per-record grids (PSD-T3 carried into windows) |
| RF-T22 | Determinism — double-run byte-identical; no Date.now/I/O |
| RF-T23 | Immutability — `PS` deep-equal before/after `computeRecentForm` |
| RF-T24 | Player identity — playerId-stable across a name change (no second player); drift flagged via PS identityAudit reuse |

Plus: forbidden-names grep over rendered output (§25) in the UI check; full cross-suite regression of all pre-existing suites unmodified.

---

## 32. Worked examples (RF-EX) — APPROVED

### 32.1 Six-appearance player (Recent 5; Previous 5 INCONCLUSIVE)

All minutes RELIABLE. Season order M1…M6:

| Match | Minutes | Recoveries |
|---|---|---|
| M1 | 90 | 10 |
| M2 | 60 | 6 |
| M3 | 30 | 4 |
| M4 | 90 | 12 |
| M5 | 90 | 11 |
| M6 | 60 | 5 |

**Season totals: 48 recoveries, 420 minutes.**

**Recent 5** (M2–M6, the five most recent appearances): **38 recoveries, 330 minutes** →
- 38 ÷ 5 = **7.6 recoveries/appearance**;
- 38 ÷ 330 × 90 = **10.363636… recoveries/90** (display 10.4 via `roundHalfUp1`; the unrounded value is the normative oracle);
- disclosure triple: window appearances 5, per-90 included 5, reliable minutes 330.

**Recent 5 vs Previous 5: INCONCLUSIVE** — only six appearances exist (< 10); true sample size 6; Previous 5 never fabricated.

**Baseline reconciliation:** Recent-5 total 38 + excluded remainder 10 (= M1) = **48** = full-season total. With the 5-window selected and 6 appearances existing, Baseline B covers M1 only (10 recoveries, 90 reliable minutes → per-90 10.0). If the season had exactly 5 appearances, Baseline B would be suppressed (`WHOLE_SEASON_IN_WINDOW`).

### 32.2 Ten-appearance player (valid Recent 5 vs Previous 5)

All minutes RELIABLE, 90 each. Recoveries M1–M10: `5, 6, 4, 7, 6, 9, 8, 10, 9, 9`.

- **Previous 5** (M1–M5): 28 recoveries, 450 min → 5.6/app; per-90 28×5400/27000 = **5.6**.
- **Recent 5** (M6–M10): 45 recoveries, 450 min → 9.0/app; per-90 45×5400/27000 = **9.0**.
- **Difference (per-90):** 9.0 − 5.6 = 3.4. **Tolerance:** max(1, 0.1 × 5.6) = 1.0. 3.4 > 1.0 → classification **HIGHER**.
- **Percentage difference:** 3.4 ÷ 5.6 × 100 = 60.714…% → **60.7%** (baseline ≠ 0, valid).
- **Observed Variability (Recent 5):** series 9, 8, 10, 9, 9 → min 8, max 10, range 2, mean 9.0, median 9 (odd n → middle element).
- Sample sizes: 5 vs 5; full season 10. No improving/declining language — the output states the numbers and `HIGHER`, nothing more.

### 32.3 Pooled percentage anchor

Window of two appearances, `passSuccess` envelopes `4/5` and `10/20`: pooled `num = 14`, `den = 25`, **value 56%** (envelope retains 14/25). The mean-of-percentages alternative `(80% + 50%) ÷ 2 = 65%` is **forbidden** (regression fixture RF-T9). Percentage-point comparisons against a baseline use the fixed 5.0 pp tolerance, boundary inclusive.

---

## 33. Open questions (RF-Q)

Decisions genuinely unresolved (presentation-layer; **none of them reopen the approved methodology above**):

| ID | Question | Default proposal (needs reviewer approval before Phase C) |
|---|---|---|
| RF-Q1 (OPEN) | Season-view UI placement and layout of the Recent Form blocks | Extend the existing season stats panel below the player table, reusing `.sn-*` styles |
| RF-Q2 (OPEN) | Render all three windows (3/5/10) simultaneously, or one selectable | Render all three compactly (sample sizes printed), `selectedWindow = 5` for Baseline B |
| RF-Q3 (OPEN) | CSV export of Recent Form blocks | Not in V1 phasing; defer to a follow-up task (consistent with the PS CSV precedent, decided separately) |
| RF-Q4 (OPEN) | Minimum-display floor for window per-90 with very small reliable-minute totals (e.g., < 45) | Display with disclosure per the approved rules (null only at 0); a floor would be an extension requiring approval |

**APPROVED (not open):** every methodology decision in §§2–32 — units, windows, ordering, totals, averages, per-90, pooled percentages, dual baselines, comparison/tolerance, Recent 5 vs Previous 5, variability statistics, with/without, team form, result-vs-state separation, spatial reuse, game state, period, data quality, sample visibility, identity, duplicates, determinism, architecture, language, AI/rating/predictive exclusions, scope.

---

## 34. Implementation phasing (RF-PH) — APPROVED

Controlled layers; **none implemented by this document**:

- **PHASE A — pure Recent Form calculation engine:** `src/recent-form.js` (UMD, `window.RecentFormEngine` / Node export; loaded after `player-season.js`, before `renderer.js`); `computeRecentForm(PS, options)` exactly per §30; no engine/UI changes elsewhere.
- **PHASE B — deterministic tests:** `tests/recent-form-tests.js` (RF-T1…RF-T24 engine subset) written to fail first against a stub, then pass; no modification of any pre-existing suite or oracle.
- **PHASE C — minimal UI integration:** season view (renderer.js + index.html script tag + styles.css) rendering the RF output read-only; forbidden-names grep included; placement per RF-Q1 resolution.
- **PHASE D — full regression + checkpoint:** all pre-existing suites unmodified and green (integrity 77, wiring 17, F2/F3 97, analytics 274, analytics-UI 42, spatial 151, spatial-UI 83, player-season 151, player-season-UI 52, matchday-sim) + new RF suites green; doc-only delta marker added to `docs/player-season-data-specification.md` IMPLEMENTATION STATUS (PSD §5.3–§5.8 superseded by this document); checkpoint `pitchlog-recent-form-v1-reestablished` (content-only commit; pre-existing mode-only file bits excluded per house precedent).

---

## 35. Prohibitions (RF-N)

No AI (§26); no player rating/ranking/form index/performance index/best-worst player (§27); no prediction/regression/significance/causal inference/forecasting (§28); no SD/variance/CV/consistency index (§12); no mean-of-percentages (§7); no estimated/unavailable minutes as denominator (§6); no official-possession invention (§14); no second duplicate-identity system (§22); no second ordering mechanism (§3.3); no second spatial methodology — no average position, territory, field tilt, positional tracking (§16); no new event schema / no matchId on events; no modification of the Analytics or Spatial Engine; no rereading of raw events (§24); no causal language, no improving/declining/good form/bad form/momentum/confidence/sharpness (§25); no scope expansion beyond the October window (§29); no silent zero-fill of unavailable data (§19).

---

## 36. Acceptance criteria (RF-AC)

1. All RF-T1…RF-T24 checks pass (hand-computed oracles, exact expected values).
2. All pre-existing suites pass **unmodified** (the 944 checks + matchday-sim current baseline at `4b0d20c`); zero changes to any pre-existing test or oracle.
3. `src/analytics.js`, `src/player-season.js` aggregation semantics, event schema, taxonomy, and the 3×3 model are **byte-unchanged** except: the new `src/recent-form.js`, the script tag, the season-view UI wiring, and the two new test files (+ the PSD doc-only delta marker).
4. Determinism: double-run byte-identical; purity: `PS` not mutated (deep-compare asserted).
5. Forbidden-name grep over all rendered RF output is clean (§25 list).
6. Sample visibility fields present on every window/per-90/with-without output (§20).
7. Reconciliation invariants hold: window + Baseline B = Baseline A (additive, envelope num/den); window spatial = Σ per-record grids; Baseline A equals the PS season record (consumed, not recomputed).
8. This document remains the single source of truth for the Recent Form layer; the PSD draft §5.3–§5.8 is marked superseded at Phase D.

---

*End of `PitchLog-RECENT-FORM-SPEC-v1.0-reestablished`.*
