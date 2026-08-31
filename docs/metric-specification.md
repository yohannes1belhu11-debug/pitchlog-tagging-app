# PitchLog Analytics — Metric Specification

**Document ID:** PitchLog-METRIC-SPEC-v1.0-draft
**Status:** DRAFT FOR REVIEW — specification only. No analytics code has been written.
**Authority:** Source code of the PitchLog application at commit `65a1980` (`pitchlog-f2-f3-integrity-fix`), working tree clean. Files inspected: `src/renderer.js` (3,064 lines), `src/main.js` (754 lines), `src/index.html`, `src/integrity.js`, `src/preload.js`, `src/styles.css`.
**Scope:** Defines what PitchLog should calculate from its structured events. Does not change the event taxonomy, does not change the data model, does not add dependencies, does not implement anything.
**Reviewer roles:** football performance analyst (methodology), data-model architect (structure), developer (implementability).

---

## 0. How to read this document

- **Section 1** is the verified inventory of what PitchLog actually collects. Every metric definition in Sections 4–6 refers back to it. Nothing in this document invents a field that is not listed in Section 1.
- **Section 2** states the design principles. Any future metric that violates them is out of spec.
- **Section 3** defines the canonical predicates — the shared vocabulary used by every formula, so two developers implement the same metric identically.
- **Sections 4–6** are the metric catalog, strictly separated into **LEVEL 1 (raw counts)**, **LEVEL 2 (derived)**, and **LEVEL 3 (contextual)**. The levels are never mixed inside one metric definition.
- **Section 7** is the explicit catalogue of metrics that are **NOT CURRENTLY COMPUTABLE**, with reasons and required data.
- **Sections 8 and 9** give the careful proposed definitions for **pressing** and **transitions** (including the anti-double-counting rules).
- **Sections 10–14** define the tagging protocol the metrics rely on, audit/reconciliation rules, computation rules (ordering, rounding, season aggregation), implementation notes, and open questions for the reviewer.
- Every metric has a stable ID (`M-…`) for cross-referencing in reviews, tests, and future implementation tickets.

---

## 1. Verified data model (Part 1 — source inspection results)

All statements in this section were read directly from the source. Line references are to `src/renderer.js` at commit `65a1980` unless noted.

### 1.1 Canonical event/tag types (default tag set, lines 15–53)

| # | Label | Key | Structure | Details available at tagging time |
|---|-------|-----|-----------|------------------------------------|
| 1 | `Goal` | 1 | flat + qualifiers | Body part: `Left foot` / `Right foot` / `Head` / `Other` |
| 2 | `Shot` | 2 | subtypes + qualifiers | Subtype: `On target` / `Off target` / `Blocked`; Body part: `Left foot` / `Right foot` / `Head`; Situation: `Open play` / `Set piece` / `Penalty` |
| 3 | `Pass` | 3 | subtypes + qualifiers | Subtype: `Progressive` / `Lateral` / `Backward` / `Long`; Outcome: `Successful` / `Unsuccessful`; Pressure: `Under pressure` / `Free` |
| 4 | `Foul` | 4 | flat + qualifiers | Zone: `Defensive third` / `Middle third` / `Attacking third` |
| 5 | `Card` | 5 | subtypes | `Yellow` / `Red` |
| 6 | `Corner` | 6 | flat | none |
| 7 | `Sub` | 7 | substitution | playerOffId / playerOnId (set in detail panel) |
| 8 | `Possession` | 8 | **interval** + qualifiers | Ended by: `Shot` / `Turnover` / `Foul won` / `Out of play` |

The tag set is **user-extensible** (custom tags with arbitrary label, subtypes, qualifier groups, and optional interval flag; lines 1552–1581) and **persists per session**.

### 1.2 Touchline quick tags (line 2951)

`QUICK_TAGS = ['Shot','Chance','Cross','Key Pass','Press','Press Win','Turnover','Recovery','Interception','Duel','Positive Transition','Negative Transition','Goal','Card','Sub']`

Pressing a quick tag that is not already in the tag set auto-creates it as a **flat tag** (no subtypes, no qualifiers, no interval; line 2965). Therefore:

- `Chance`, `Cross`, `Key Pass`, `Press`, `Press Win`, `Turnover`, `Recovery`, `Interception`, `Duel`, `Positive Transition`, `Negative Transition` exist in practice as **flat, single-click events with no outcome representation**.
- `Shot`, `Goal`, `Card`, `Sub` resolve to the default tag definitions and do carry subtypes/qualifiers — but see §1.16 defect F6 (detail panel unreachable in Touchline Mode), which in practice prevents subtype/qualifier completion from the touchline.

### 1.3 Subtypes

One **single-select** string per event (`ev.subtype`, default `null`; set/cleared via chips in the detail panel, lines 1388–1431 — selecting the chosen chip again deselects it). A Pass is therefore **exactly one of** Progressive / Lateral / Backward / Long, or none. Direction and length are collapsed onto a single exclusive axis; a "long progressive pass" is not representable (see §7, NC-8).

### 1.4 Qualifier groups

Independent single-select groups stored as `ev.qualifiers = { groupName: value }` (value nullable). Current canonical groups: Body part (Goal, Shot), Situation (Shot), Outcome (Pass), Pressure (Pass), Zone (Foul), Ended by (Possession). Custom tags may define arbitrary groups. Qualifier values are optional and can be changed or removed at any time after logging (event list → edit → detail panel, lines 1741–1744).

### 1.5 Outcome representations (current state)

There is **no global outcome model**. Outcome is represented inconsistently across the ecosystem:

| Construct | Outcome representation | Completeness |
|---|---|---|
| `Shot` | subtype `On target`/`Off target`/`Blocked` | optional (may remain `null`) |
| `Pass` | qualifier `Outcome: Successful/Unsuccessful` | optional |
| `Possession` | qualifier `Ended by: Shot/Turnover/Foul won/Out of play` | optional |
| `Card` | subtype `Yellow`/`Red` | optional |
| `Chance`, `Cross`, `Key Pass`, `Press`, `Press Win`, `Turnover`, `Recovery`, `Interception`, `Duel`, `Positive Transition`, `Negative Transition` | **none — flat tags** | n/a |

**Consequence for the spec:** every outcome-based metric must be defined so that events with a missing outcome fall into an explicit *Unknown* bucket that is counted and reported, never silently re-classified (Principle P4, §2).

### 1.6 Team representation

- v3 field `ev.team`: `'our'` | `'opponent'` | `null` (null = unknown/neutral). Captured at log time from the persistent team toggle (`matchClock.selectedTeam`, default `'our'`; lines 905–906, 2853).
- v2 legacy field `ev.side`: `'for'` | `'against'` | `null`. On load, sessions are migrated: `for` → `our`, `against` → `opponent`, anything else → `null` (main.js lines 242–250). The original `side` value is preserved; **`team` is the analytics-grade field**.
- Events can be logged with `team = null` (migrated neutral events, or any state where team ownership was not chosen). Unattributed events must be surfaced, never assumed (§11).

### 1.7 Player representation

- `ev.playerId`: string (`player_<n>`), nullable, captured at log time from the persistent player selector. Resolved to the current squad entry `{ id, number, name }` at display time; missing players render as "Unknown player" (lines 1145–1154).
- `Sub` events additionally carry `ev.playerOffId` / `ev.playerOnId`.
- Squad is a global list, not per-match. `matchInfo.startingXI` maps formation positions (GK/RB/CB… from a fixed formation list, lines 397–405) to playerIds.
- **There is no minutes-played tracking, no on-pitch intervals, and no automatic substitution-derived playing time.** (Consequence: player per-90 metrics are not computable — §7, NC-13.)

### 1.8 Location representation

- `ev.location`: `{ x, y }` each in [0,1], **optional** (default `null`), set by clicking the pitch in the detail panel (desktop) or tapping the touchline pitch on the most recent event (line 3017).
- Zone model (line 1085–1089): third = `floor(x*3)` → `Defensive third` / `Middle third` / `Attacking third`; channel = `floor(y*3)` → `Left channel` / `Central channel` / `Right channel`. Zone string = `"<third> · <channel>"` (9 zones).
- **Orientation convention (implied, not enforced by code):** the pitch is drawn in one fixed orientation; the zone names "Defensive"/"Attacking" imply x = 0 is our goal line and x = 1 the opponent goal line. The code neither enforces nor documents this; it is a user convention. The spec adopts it as **Tagging Protocol T2** (§10) and every spatial metric states its dependence on it.
- The 3×3 grid is uniform in normalized coordinates; the underlying 3×3 pitch model must not be changed (per project constraints).

### 1.9 Sequence representation

- Manual: the analyst presses *Start Sequence* / *End Sequence* (desktop or touchline). While active, every logged event carries `ev.sequenceId = 'SEQ-NNN'` (per-match monotonic counter, lines 2855–2864).
- Sequences have **no type, no phase label, and no linkage to other events**. A sequence may span periods (no automatic close at end of half).
- Sequence linkage is the **only** grouping mechanism available for transition analysis (§9).

### 1.10 Score-state representation

- Every event carries `scoreForBefore` / `scoreAgainstBefore` (snapshot of the live score at log time; buildEventBase lines 908–909).
- `Goal` events logged with a team also carry `scoreForAfter` / `scoreAgainstAfter` (exactly one side +1; lines 956–970). Non-goal events have `scoreForAfter = null`.
- `scoreState` is **derived** at export time from the *Before* pair: `WINNING` (for > against), `DRAW`, `LOSING` (line 2923). The state therefore describes the game state **at the moment before the event** — this is the definition used by all game-state metrics (§6, CT-STATE).
- The F3 fix guarantees the score chain stays internally consistent when goals are undone/deleted (score fields of later events are shifted; live score restored; renderer.js lines 983–1045).
- `matchInfo.ourScore` / `opponentScore` are **manually entered final scores**, independent from the goal-event chain. Two sources of truth → reconciliation metric M-X1 (§5).

### 1.11 Match-time representation

- `period`: `PRE_MATCH` → `1H` → `HT` → `2H` → `FT` (→ optionally `ET1` → `ET_HT` → `ET2` → `FT`).
- `matchSeconds` (int) / `matchTime` (float): elapsed match time on the period timeline. Second half starts at 2700; ET1 at 5400; ET2 at 6300. `endHalf()` **snaps** the clock to the period boundary (2700 / 5400 / 6300 / 7200), so stoppage-play length is not preserved in the clock, but **events logged during stoppage keep `matchSeconds` beyond the boundary with the period unchanged** (e.g. period `1H`, matchSeconds 2735). Stoppage is therefore derivable: 1H stoppage = period `1H` ∧ matchSeconds > 2700; 2H stoppage = period `2H` ∧ matchSeconds > 5400 (similarly ET).
- `officialMinute` (int): `ceil(matchSeconds/60)`; in stoppage it is the boundary minute plus stoppage minutes (e.g. 45+2 → 47). **Stoppage is folded into the number and cannot be recovered from `officialMinute` alone** (a 2H event at 47' and a 1H-stoppage event at 45+2 both read 47) — minute-bin metrics must use (period, matchSeconds), never `officialMinute` (§6, CT-MINBIN).
- `videoTime`: nullable — null whenever no usable video is loaded; video-linked events carry both clocks. Match-time fields are always present (F2 fix).
- Event ordering in the app: sorted by `time` (= `matchTime`; for intervals `startTime`), stable; the spec's canonical order (§12) is `(time asc, id asc)`, `id` being monotonic at log time.

### 1.12 Interval events

- Only `Possession` (and custom interval tags) produce interval events: `isInterval: true`, `startTime`, `endTime`, duration = `endTime − startTime`. One active interval per label at a time. Bounds come from the video clock when a usable video is loaded, otherwise from the match clock (F2 fix; match-time fields anchored at interval start).
- Interval events still carry all standard fields (team, playerId, sequenceId, location optional, score-before pair).

### 1.13 Match metadata (`matchInfo`)

`competition`, `date`, `opponent`, `venue`, `homeAway` (`home`/`away`/`neutral`), `ourScore` / `opponentScore` (manual, strings), `formation`, `startingXI` [{position, playerId}]. MatchId used by the full-analysis export = `date + '_' + opponent` (line 2915) — collision risk noted in §12.4.

### 1.14 What the app already computes today (pre-spec baseline)

- A live/season stats panel (lines 1772–1879): counts by label, subtype counts, qualifier counts with percentages of the *tagged-value* subset, counts by `side` (for/against/neutral), and top-8 players by event involvement. Season view concatenates loaded sessions and reuses the same panel.
- A pitch-map dot plot filtered by tag/player/side (lines 1276–1323) — pure dot display, no aggregation.
- CSV exports: standard (18 cols) and full-analysis (35 cols, includes team/player IDs, period/minute/seconds, zone, thirds/channels, score before/after, score state, sequence).
- **No ratios beyond qualifier percentages, no time normalization, no zone aggregation, no game-state splits, no cross-event linkage.** This spec defines the first official layer above these raw exports.

### 1.15 Data-availability summary (what metrics may use)

| Field | Presence | Notes for metrics |
|---|---|---|
| id, label, time/matchTime, matchSeconds, period | always | deterministic ordering possible |
| videoTime | nullable | metrics must not depend on it |
| subtype | nullable | Unknown bucket required |
| qualifiers | nullable per group | Unknown bucket required |
| location | nullable | located-subset reporting required |
| team | `'our'`/`'opponent'`/null | unattributed bucket required |
| playerId / playerOffId / playerOnId | nullable | unattributed bucket required |
| sequenceId | nullable | optional grouping only |
| scoreForBefore/AgainstBefore | always (int ≥ 0) | game-state dimension |
| scoreForAfter/AgainstAfter | goals with team only | goal-chain replay |
| isInterval/startTime/endTime | Possession & custom intervals | duration metrics |

### 1.16 Known defects relevant to analytics (from the verification history — unchanged, all LOW)

- **F6**: detail panel is unreachable in Touchline Mode → subtypes/qualifiers effectively cannot be completed from the touchline (location can, via the touchline pitch tap). Affects completeness of Shot subtypes, Pass outcomes, Possession end reasons.
- **F7**: full-analysis CSV emits `Category` = `Event` = `Label` = the same string, `Outcome` and `Phase` columns are empty. Analytics must read `Label` + `Subtype`, not `Category`/`Outcome`.
- **F1**: player dropdown can be stale after a same-session bulk add → risk of unattributed events.
- **F8**: undo is single-shot by design (last logged event only). Metrics operate on the saved event set; undo consistency is guaranteed by the F3 fix.
- CSV files are LF-only without BOM (Excel import caveat — does not affect parsing by a proper CSV reader).

---

## 2. Metric design principles

- **P1 — Determinism.** Same input events → same output, always. Canonical ordering, explicit rounding, explicit null/zero semantics. No metric may depend on wall-clock time, random IDs, or iteration order of a hash map.
- **P2 — Tagged-universe honesty.** Every metric measures the **tagged** universe only. "Passes" means *tagged* Pass events, not all passes in the match. Every metric's definition names its universe; no metric extrapolates to untagged events.
- **P3 — Primary-event counting (double-count resistance).** Every Level 1 metric counts events of exactly one label (or one explicitly enumerated disjoint label set). No event is counted twice within a metric; metrics that legitimately share source events (e.g. Shots and Chances) are defined on different constructs and are never summed. Overlap rules are stated per metric and enforced globally in §9.4 (transitions) and §11.
- **P4 — Completeness reporting.** Any metric whose input field is optional (subtype, qualifier, location, team, playerId) is emitted together with its completeness figures: how many candidate events were excluded for missing data. Missing data is an **Unknown bucket**, never a silent re-classification.
- **P5 — Null vs zero.** If the denominator of a ratio is 0, the metric is `null` (displayed "n/a"), not `0`. Zero is reserved for a genuine count of zero qualifying events.
- **P6 — Level separation.** LEVEL 1 = raw counts; LEVEL 2 = derived from raw events; LEVEL 3 = raw/derived metrics restricted to a context (zone, game state, period, minute bin, player, sequence, match). A Level 3 metric is (base metric) × (context predicate); it never introduces a new counting rule.
- **P7 — No composite indices.** No weighted combination of metrics (no "performance score") in this spec. Combining counts into indices requires validation work that is out of scope.
- **P8 — Protocol dependence is documented, not hidden.** Several metrics rely on tagging conventions that the *code* does not enforce (team semantics per label, pitch orientation, goal/shot co-tagging). These are listed in §10; each dependent metric names the conventions it requires.
- **P9 — Auditability.** Every metric can be recomputed by hand from the event list (or the full-analysis CSV). Section 11 defines reconciliation checks that must run alongside the metrics and surface discrepancies rather than resolve them silently.
- **P10 — No invented data.** If a metric needs information outside §1, it is *NOT CURRENTLY COMPUTABLE* (§7) with (a) why, (b) what data is needed, (c) feasibility of adding it later.

---

## 3. Canonical predicates (shared formula vocabulary)

Implementations must provide exactly these predicates; every formula in Sections 4–6 is expressed with them.

| Predicate | Definition |
|---|---|
| `E` | an event object as stored/loaded by PitchLog (post-v3-migration) |
| `E.label` | label string, compared **case-sensitively** with the canonical strings of §1.1/§1.2 |
| `IsGoal(E)` | `E.label = 'Goal' ∨ E.label = 'GOAL'` (source recognises both, renderer.js lines 956, 1008) |
| `Team(E, t)` | `E.team = t`, t ∈ {'our','opponent'} |
| `Unattr(E)` | `E.team = null` |
| `Subtype(E, s)` | `E.subtype = s` |
| `Qual(E, g, v)` | `E.qualifiers[g] = v` |
| `HasOutcome(E)` | `E.qualifiers['Outcome'] ∈ {'Successful','Unsuccessful'}` |
| `HasZone(E, third, channel)` | `E.location ≠ null ∧ floor(E.location.x*3) = thirdIndex ∧ floor(E.location.y*3) = channelIndex` (indices 0/1/2 per §1.8) |
| `ThirdOf(E)` / `ChannelOf(E)` | `floor(E.location.x*3)` / `floor(E.location.y*3)` when located |
| `InPlayPeriod(E)` | `E.period ∈ {'1H','2H','ET1','ET2'}` (excludes PRE_MATCH/HT/ET_HT/FT — "non-play" tagged moments) |
| `IsStoppage(E)` | `(E.period='1H' ∧ E.matchSeconds>2700) ∨ (E.period='2H' ∧ E.matchSeconds>5400) ∨ (E.period='ET1' ∧ E.matchSeconds>6300) ∨ (E.period='ET2' ∧ E.matchSeconds>7200)` |
| `StateOf(E)` | from (scoreForBefore, scoreAgainstBefore): `WINNING` if for > against, `LOSING` if for < against, else `DRAW` (matches export, line 2923) |
| `Seq(E)` | `E.sequenceId` (nullable) |
| `PlayerOf(E)` | `E.playerId` (nullable) |
| `τ` | linkage window parameter; defaults per metric; **the value used must be emitted with the result** |
| `SortKey(E)` | `(E.time, E.id)` — canonical order (§12.1) |

Metric result envelope (all metrics): `{ value, numerator?, denominator?, excluded {missingField: count}, params? }` — see §12.5.

---

## 4. LEVEL 1 — RAW COUNT METRICS

Raw counts directly count tagged events. Each metric counts one label (or one explicitly disjoint label set). Unit: **count** unless stated otherwise.

### Group A — Match / team basic

#### M-A1 Goals (For)

**Definition:** Goals scored by our team in the tagged event set.
**Purpose:** Primary outcome metric; feeds conversion rates and the goal chain.
**Source Events:** `IsGoal(E) ∧ Team(E,'our')`.
**Inclusion Rules:** Goal events (label `Goal` or `GOAL`) with `team = 'our'`. Goals scored while logged without a team are excluded here and reported in M-A3.
**Exclusion Rules:** `team = 'opponent'` (→ M-A2); `team = null` (→ M-A3); duplicate tags of the same real-world goal are counted as separate events — deduplication is not possible without an event-linkage field (protocol T5 warns against double-tagging; audit X6 monitors).
**Formula:** `count { E : IsGoal(E) ∧ Team(E,'our') }`.
**Unit:** count.
**Team Level:** the metric itself (our). Mirror for opponent = M-A2.
**Player Level:** same predicate ∧ `PlayerOf(E) ≠ null`, grouped by playerId; unattributed goals counted in the player-unattributed bucket.
**Spatial Dimension:** yes, via CT-ZONE on located goals.
**Game-State Dimension:** yes, CT-STATE (state *before* the goal).
**Time Dimension:** yes, CT-PERIOD / CT-MINBIN.
**Double-Count Risk:** goal events are disjoint from all other labels; a goal is not also counted in Shots (Shot is a different construct — see M-A4 and protocol T4); Possession's `Ended by: Shot` qualifier is a qualifier on an interval event, not a Shot event, so it never increments any shot/goal metric.
**Data Requirement:** label, team. Always present (team may be null → completeness bucket).
**Confidence / Limitation:** exact for the tagged universe. An own goal scored by us follows the existing representation (team = opponent increments scoreAgainst — protocol T3); the current model has no own-goal flag, so own goals cannot be separated (§7 NC-14). Penalty goals are not separable (Goal has no Situation qualifier, unlike Shot).

#### M-A2 Goals (Against)

**Definition:** Goals scored by the opponent.
**Purpose:** defensive outcome metric.
**Source Events:** `IsGoal(E) ∧ Team(E,'opponent')`.
**Inclusion Rules:** goal events with team = opponent.
**Exclusion Rules:** as M-A1 (excluded mirror cases).
**Formula:** `count { E : IsGoal(E) ∧ Team(E,'opponent') }`.
**Unit:** count.
**Team Level:** the metric itself.
**Player Level:** applies if opponent players are tagged (playerId set); typically unattributed.
**Spatial / Game-State / Time Dimension:** yes (as M-A1).
**Double-Count Risk:** disjoint from M-A1 by the team predicate.
**Data Requirement:** label, team.
**Confidence / Limitation:** exact for tagged universe; opponent player attribution usually absent.

#### M-A3 Unattributed Goals

**Definition:** Goal events logged with no team.
**Purpose:** data-quality gate; must be resolved before match reports are trusted.
**Source Events:** `IsGoal(E) ∧ Unattr(E)`.
**Inclusion Rules:** goal events with team = null. Such goals never changed the live score (source: logEvent only increments with a selected team).
**Exclusion Rules:** all attributed goals.
**Formula:** `count { E : IsGoal(E) ∧ Unattr(E) }`.
**Unit:** count.
**Team Level:** n/a (it is a quality metric of the whole match).
**Player Level:** n/a.
**Spatial / Game-State / Time Dimension:** no (quality metric).
**Double-Count Risk:** none.
**Data Requirement:** label, team.
**Confidence / Limitation:** exact. Non-zero value invalidates the goal-chain reconciliation (M-X1) and game-state metrics.

#### M-A4 Shots

**Definition:** Shot attempts tagged, regardless of outcome.
**Purpose:** attacking volume metric; denominator for accuracy/conversion.
**Source Events:** `E.label = 'Shot'`.
**Inclusion Rules:** all Shot events (any team, any subtype, any qualifiers); team split reported simultaneously (`for`/`against`/`unattributed` buckets).
**Exclusion Rules:** no events excluded for missing subtype — outcome completeness is handled by M-A8; goal events are not shots unless separately tagged (protocol T4: tag Shot for every attempt including goals that are also tagged as Goal; audit X5 flags Goals > Shots).
**Formula:** `count { E : E.label = 'Shot' }` (with team-partitioned sub-counts).
**Unit:** count.
**Team Level:** team-partitioned counts.
**Player Level:** per playerId; unattributed bucket reported.
**Spatial Dimension:** yes (CT-ZONE on located shots).
**Game-State Dimension:** yes.
**Time Dimension:** yes.
**Double-Count Risk:** disjoint label. A shot and a chance for the same attempt are two events on two constructs — both counted, never summed (§11.3).
**Data Requirement:** label only.
**Confidence / Limitation:** exact for tagged universe; interpretation of "total shots" vs broadcast stats depends on tagging completeness (blocked shots may be under-tagged since the subtype is optional).

#### M-A5 Shots on Target

**Definition:** Shots judged on target (would have entered the goal without intervention).
**Purpose:** shot quality proxy; numerator of shot accuracy.
**Source Events:** `E.label='Shot' ∧ Subtype(E,'On target')`.
**Inclusion Rules:** subtype exactly `'On target'`. Saved shots, goals scored (when also tagged as Shot with subtype On target) included per tagging protocol.
**Exclusion Rules:** `Off target`, `Blocked`, subtype null (→ M-A8), other labels.
**Formula:** `count { E : E.label='Shot' ∧ Subtype(E,'On target') }`.
**Unit:** count.
**Team Level:** team-partitioned.
**Player Level:** per playerId (+ unattributed).
**Spatial / Game-State / Time Dimension:** yes.
**Double-Count Risk:** subtype is single-select → disjoint from M-A6/M-A7 by construction.
**Data Requirement:** label, subtype. Subtype optional → completeness (M-A8) must accompany this metric.
**Confidence / Limitation:** a *lower bound* whenever subtype completion is imperfect; on-target/off-target/blocked classification is the analyst's judgment; no goal-mouth placement data.

#### M-A6 Shots off Target

**Definition:** Shots judged off target.
**Purpose:** finishing-quality diagnostics.
**Source Events:** `E.label='Shot' ∧ Subtype(E,'Off target')`.
**Inclusion Rules / Exclusion Rules:** as M-A5 with `'Off target'`.
**Formula:** `count { E : E.label='Shot' ∧ Subtype(E,'Off target') }`.
**Unit:** count. All other dimensions as M-A5.
**Double-Count Risk:** single-select subtype → disjoint.
**Data Requirement:** label, subtype.
**Confidence / Limitation:** lower bound when completion is imperfect; no distinction miss vs blocked-for-corner beyond the given subtypes.

#### M-A7 Blocked Shots

**Definition:** Shots blocked (by any player, including team-mates — the model does not distinguish blocker identity).
**Purpose:** shot-volume context; blocked shots are reported separately and **excluded from shot accuracy** by convention (see M-L2-A1).
**Source Events:** `E.label='Shot' ∧ Subtype(E,'Blocked')`.
**Inclusion Rules / Exclusion Rules:** as M-A5 with `'Blocked'`.
**Formula:** `count { E : E.label='Shot' ∧ Subtype(E,'Blocked') }`.
**Unit:** count; dimensions as M-A5.
**Double-Count Risk:** disjoint by subtype.
**Data Requirement:** label, subtype.
**Confidence / Limitation:** blocker identity/team unknown; a shot blocked *by* us vs *by* them cannot be separated.

#### M-A8 Shots with Unknown Outcome

**Definition:** Shot events with subtype null.
**Purpose:** completeness gate for M-A5–M-A7 and derived shot ratios.
**Source Events:** `E.label='Shot' ∧ E.subtype = null`.
**Formula:** `count { E : E.label='Shot' ∧ E.subtype = null }`.
**Unit:** count. Team/player/spatial/state/time dimensions: reported only as a total (quality metric).
**Double-Count Risk:** none (quality bucket).
**Data Requirement:** label, subtype.
**Confidence / Limitation:** exact. Non-zero value must be displayed next to every shot-outcome metric.

#### M-A9 Chances

**Definition:** Tagged opportunities ("Chance" events). In the current model **one single construct** covers both the common notions of "big chance" and "chance created" — the model cannot distinguish them (see NC-5).
**Purpose:** attacking opportunity volume; denominator of chance conversion.
**Source Events:** `E.label='Chance'` (flat quick tag).
**Inclusion Rules:** all Chance events, team-partitioned.
**Exclusion Rules:** no outcome data exists for Chance; nothing to exclude on outcome; `team=null` → unattributed bucket.
**Formula:** `count { E : E.label='Chance' }` (team-partitioned).
**Unit:** count.
**Team Level / Player Level / Spatial / Game-State / Time:** all yes (fields exist on flat events).
**Double-Count Risk:** separate construct from Shot/Goal/Key Pass — never summed with them; a chance that is also a shot is two events (protocol-documented, §11.3).
**Data Requirement:** label (+ optional team/player/location).
**Confidence / Limitation:** analyst's judgment of "chance"; no magnitude/priority classification (no "big" vs "half"-chance); no direction of the chance (for/against is via team field only).

#### M-A10 Crosses

**Definition:** Cross events delivered.
**Purpose:** attacking-pattern volume.
**Source Events:** `E.label='Cross'`.
**Formula:** `count { E : E.label='Cross' }` (team-partitioned).
**Inclusion/Exclusion:** flat tag; team-null bucket; no outcome field (completed/intercepted cross not separable).
**Unit:** count; all dimensions yes.
**Double-Count Risk:** disjoint label; not part of Pass counts (a cross is not tagged as Pass unless the analyst double-tags — protocol T5 warns; audit X6 monitors via label-pair co-occurrence timing, advisory only).
**Data Requirement:** label.
**Confidence / Limitation:** no completion outcome; no cross type (byline/far post etc.).

#### M-A11 Corners

**Definition:** Corner kick events.
**Purpose:** set-play volume.
**Source Events:** `E.label='Corner'`.
**Formula:** `count { E : E.label='Corner' }` (team-partitioned; protocol: team = the team *taking* the corner).
**Unit:** count; dimensions yes.
**Double-Count Risk:** disjoint label.
**Data Requirement:** label.
**Confidence / Limitation:** no outcome (shot from corner not linked — linkage only via sequenceId if the analyst groups them); protocol T1 defines team semantics.

#### M-A12 Fouls Committed

**Definition:** Foul events; team field = the team that committed the foul (protocol T1).
**Purpose:** discipline and territorial-aggression diagnostics; input to opponent set-piece expectations.
**Source Events:** `E.label='Foul'`.
**Inclusion Rules:** all Foul events, team-partitioned (Fouls Committed (Our) / Fouls Committed (Opponent)).
**Exclusion Rules:** Card events are **not** fouls in this model (a red-card offence is a Card event; a Foul may be tagged additionally — that is two constructs; never summed; protocol T5).
**Formula:** `count { E : E.label='Foul' }` (team-partitioned).
**Unit:** count.
**Team Level:** team-partitioned. "Fouls Won/Suffered" is the mirror reading (fouls committed by the opponent).
**Player Level:** per playerId (offender).
**Spatial Dimension:** yes — but with a **choice**: location field (if set) *or* the Foul `Zone` qualifier (a manual, independent claim). The spec uses `location` for spatial metrics and treats the `Zone` qualifier as a self-reported breakdown attribute (M-A16); the two may disagree — disagreement is reported, not resolved.
**Game-State / Time:** yes.
**Double-Count Risk:** disjoint label; Zone qualifier double-reporting handled by the choice above.
**Data Requirement:** label (+ team).
**Confidence / Limitation:** foul definition is the analyst's; no foul type (tactical/technical/handball) beyond free-text absence.

#### M-A13 Yellow Cards

**Definition:** Card events with subtype Yellow.
**Source Events:** `E.label='Card' ∧ Subtype(E,'Yellow')`.
**Formula:** `count { E : E.label='Card' ∧ Subtype(E,'Yellow') }` (team-partitioned; protocol: team = team of the punished player).
**Unit:** count; player level yes (punished player); spatial n/a (cards rarely located — allowed but not sanctioned), game-state/time yes.
**Double-Count Risk:** subtype single-select → disjoint from Red.
**Data Requirement:** label, subtype (optional → unknown bucket reported).
**Confidence / Limitation:** second-yellow→red cannot be represented as such (two Card events; protocol T5 documents it).

#### M-A14 Red Cards

**Definition:** Card events with subtype Red.
**Source Events:** `E.label='Card' ∧ Subtype(E,'Red')`.
**Formula:** `count { E : E.label='Card' ∧ Subtype(E,'Red') }`.
**Unit:** count; dimensions as M-A13.
**Double-Count Risk:** disjoint by subtype.
**Data Requirement:** label, subtype.
**Confidence / Limitation:** dismissal impact (subsequent 10-v-11 state) affects game-state metrics implicitly via score-state only — numerical advantage state is NOT computable (§7 NC-15).

#### M-A15 Substitutions

**Definition:** Sub events (one per substitution).
**Source Events:** `E.label='Sub'`.
**Formula:** `count { E : E.label='Sub' }`; per-player sub-on counts from `playerOnId`, sub-off from `playerOffId`.
**Unit:** count; player level via playerOn/OffId; time dimension yes; team-partitioned per protocol (team = the team making the change).
**Double-Count Risk:** disjoint label.
**Data Requirement:** label, playerOnId/playerOffId (nullable → unattributed bucket).
**Confidence / Limitation:** no minute-linked playtime derivation is sanctioned (player minutes not computable, NC-13); playerOn/off mismatch (one missing) is an audit flag.

#### M-A16 Tagged-Attribute Distribution (parametrized family)

**Definition:** For a base label L and an attribute a ∈ {subtype, qualifier group g}, the distribution of a over L's events, counting nulls.
**Purpose:** the Level-1 generalisation of the app's existing stats-panel breakdown, made canonical.
**Source Events:** `E.label = L`.
**Formula:** for each value v of a: `count { E : E.label=L ∧ attr(E,a)=v }`, plus the null bucket.
**Unit:** counts (and shares of the *tagged-value* subset as Level 2, M-L2-A16).
**Team/Player/Spatial/State/Time:** distributions can be further partitioned by team/player/state/period (Level 3).
**Double-Count Risk:** buckets disjoint by value; shares sum to 100% of the tagged-value subset, with the null share reported alongside.
**Data Requirement:** label + attribute.
**Confidence / Limitation:** shares are conditional on the tagged subset (P4); canonical instances: Shots by Situation, Shots/Goals by Body part, Passes by subtype axis, Possession by Ended-by, Fouls by Zone qualifier.

### Group B — Possession / build-up

#### M-B1 Passes

**Definition:** Pass events tagged.
**Purpose:** build-up volume; denominator of pass success.
**Source Events:** `E.label='Pass'`.
**Inclusion Rules:** all Pass events, team-partitioned, unattributed bucket reported.
**Exclusion Rules:** crosses are a separate label (never merged — §11.3); passes without outcome qualifier are included in M-B1 but not in M-B2/M-B3.
**Formula:** `count { E : E.label='Pass' }`.
**Unit:** count; player/spatial/state/time dimensions yes.
**Double-Count Risk:** disjoint label; single-select subtype means B5–B8 are disjoint slices of the subtype-known subset.
**Data Requirement:** label.
**Confidence / Limitation:** **tagged-universe metric** — not total passes in the match (P2). Pass counts are only comparable across matches under a consistent tagging density protocol (T6).

#### M-B2 Successful Passes

**Definition:** Passes with Outcome qualifier `Successful`.
**Source Events:** `E.label='Pass' ∧ Qual(E,'Outcome','Successful')`.
**Formula:** `count{...}`; team/player/spatial/state/time yes.
**Double-Count Risk:** single-select qualifier → disjoint from M-B3; events without the qualifier are excluded (not assumed successful) — reported via M-B4.
**Data Requirement:** label + Outcome qualifier (optional → M-B4).
**Confidence / Limitation:** success judgment is the analyst's; no receiver information.

#### M-B3 Unsuccessful Passes

**Definition:** Passes with Outcome qualifier `Unsuccessful`.
**Source Events:** `E.label='Pass' ∧ Qual(E,'Outcome','Unsuccessful')`.
**Formula / Unit / dimensions / risks / data:** mirror of M-B2.
**Confidence / Limitation:** no failure mode (intercepted / out of play / technical) — not representable.

#### M-B4 Passes with Unknown Outcome

**Definition:** Pass events with no Outcome qualifier.
**Formula:** `count { E : E.label='Pass' ∧ ¬HasOutcome(E) }`.
**Unit:** count; quality gate for M-L2-B1.
**Confidence / Limitation:** exact; must be displayed with every pass-success figure.

#### M-B5 Progressive Passes / M-B6 Lateral Passes / M-B7 Backward Passes / M-B8 Long Passes

**Definition:** Passes by the single-select subtype axis.
**Source Events:** `E.label='Pass' ∧ Subtype(E, s)` for s ∈ {'Progressive','Lateral','Backward','Long'}.
**Formula:** `count{...}` per subtype; dimensions yes.
**Double-Count Risk:** single-select subtype → mutually disjoint; passes with subtype null fall to an Unknown bucket reported next to these counts.
**Data Requirement:** label + subtype (optional).
**Confidence / Limitation:** direction and range are **collapsed onto one exclusive axis** — a long pass cannot also be counted progressive (source structure, §1.3); "progressive" is the analyst's judgment (no end-location validation — NC-8); recommendation for a future tagging change (two qualifier groups) is recorded in §7 NC-8 but **not** part of this spec.

#### M-B9 Passes under Pressure

**Definition:** Passes with Pressure qualifier `Under pressure` (vs `Free`, M-B9f).
**Source Events:** `E.label='Pass' ∧ Qual(E,'Pressure','Under pressure')`.
**Formula:** `count{...}`; dimensions yes.
**Double-Count Risk:** single-select → disjoint from Free; unknown bucket reported.
**Data Requirement:** label + Pressure qualifier.
**Confidence / Limitation:** pressure judgment is the analyst's; no pressure source (opponent count/position) data.

#### M-B10 Possession Interval Count

**Definition:** Number of tagged Possession intervals.
**Source Events:** `E.label='Possession' ∧ E.isInterval`.
**Formula:** `count{...}`; team-partitioned (team = team in possession, protocol T1).
**Unit:** count; time/state dimensions yes; spatial: location of an interval = optional single point (its meaning is the analyst's choice — interval location is NOT a trajectory).
**Double-Count Risk:** intervals are one-at-a-time per label but can be logged consecutively without overlap enforcement; overlapping intervals across a session are impossible for the same label (start requires no active interval), but **gaps are unrecorded** — this metric is a count of tagged intervals, not of possessions.
**Data Requirement:** label, isInterval, startTime/endTime.
**Confidence / Limitation:** tagged-universe only; exhaustive possession segmentation is NOT assumed (that would be required for possession % — NC-1).

#### M-B11 Possession Duration (Total)

**Definition:** Sum of durations of tagged Possession intervals.
**Formula:** `Σ (endTime − startTime)` over `E.label='Possession' ∧ E.isInterval`, per team.
**Unit:** seconds (1 decimal).
**Double-Count Risk:** intervals of the same label cannot overlap (source enforces one active interval per label); custom interval tags are excluded by label predicate.
**Data Requirement:** startTime, endTime (always present for interval events post-migration).
**Confidence / Limitation:** tagged-universe; the sum is **not** ball-in-play time and **not** possession time share (NC-1).

#### M-B12 Possession Duration (Mean)

**Definition:** Mean duration of tagged Possession intervals.
**Formula:** M-B11 / M-B10 (per team); null if M-B10 = 0 (P5).
**Unit:** seconds (1 decimal).
**Double-Count Risk:** derived from disjoint intervals.
**Data Requirement:** as M-B11.
**Confidence / Limitation:** sensitive to tagging density (few, long intervals vs many, short); report alongside count.

#### M-B13 Possession End-Reason Distribution

**Definition:** Distribution of the `Ended by` qualifier over Possession intervals (Shot / Turnover / Foul won / Out of play / unset).
**Formula:** M-A16 family instance: `count{ E : label='Possession' ∧ Qual(E,'Ended by', v) }` per value + unset bucket.
**Unit:** counts.
**Double-Count Risk:** single-select → disjoint buckets; **note carefully**: the value string `'Shot'` here is a *qualifier value*, not a Shot event — it never counts toward M-A4 (§11.3).
**Data Requirement:** qualifier (optional → unset bucket).
**Confidence / Limitation:** analyst judgment; the end reason is not validated against subsequent events (no linkage).

### Group C — Pressing / out of possession

#### M-C1 Pressing Actions

**Definition:** Press events — a deliberate pressing action by the tagged team's player while out of possession (protocol T1: team = the pressing team).
**Source Events:** `E.label='Press'`.
**Formula:** `count { E : E.label='Press' }` (team-partitioned; unattributed bucket).
**Unit:** count; player/spatial/state/time yes.
**Double-Count Risk:** disjoint label; a Press and a Press Win for the same action are two constructs (action vs outcome) — never summed; see §8.
**Data Requirement:** label (+ team/player/location optional).
**Confidence / Limitation:** tagged-universe; no context field distinguishes counter-press from organised press (NC-9); no trigger information (NC-10); no duration (instant event).

#### M-C2 Press Wins

**Definition:** Press Win events — the analyst's judgment that a pressing action achieved its objective (possession regained or clear disruption).
**Source Events:** `E.label='Press Win'`.
**Formula:** `count { E : E.label='Press Win' }` (team-partitioned).
**Unit:** count; dimensions yes.
**Double-Count Risk:** **Press Win is an independent label with no structural link to any Press event** (§8). It is NOT counted as a recovery, interception, or turnover; those are separate labels. A Press Win and a Recovery logged for the same moment are two events on two constructs — never summed (§8.3).
**Data Requirement:** label.
**Confidence / Limitation:** whether a Press Win implies ball possession was regained is a protocol question, NOT a data fact — the model does not prove it (source inspection, §1.5: no linkage). All interpretations must cite protocol T7.

#### M-C3 Interceptions

**Definition:** Interception events.
**Source Events:** `E.label='Interception'`.
**Formula:** `count{...}`; dimensions yes.
**Double-Count Risk:** disjoint label; an interception that is also judged a "recovery" is analyst double-tagging of two constructs (T5) — never summed; audit X6 advisory.
**Data Requirement:** label.
**Confidence / Limitation:** no outcome needed (an interception is by definition a possession gain in this taxonomy).

#### M-C4 Recoveries

**Definition:** Ball-recovery events (possession regained by the tagging team, not via interception — protocol distinguishes usage).
**Source Events:** `E.label='Recovery'`.
**Formula:** `count{...}`; dimensions yes.
**Double-Count Risk:** as M-C3.
**Data Requirement:** label.
**Confidence / Limitation:** the boundary between Recovery and Interception is a tagging convention (T7); both are ball-winning events (M-L2-C1).

#### M-C5 Turnovers

**Definition:** Loss-of-possession events; protocol T1: team = the team that **lost** possession.
**Source Events:** `E.label='Turnover'`.
**Formula:** `count{...}`; dimensions yes.
**Double-Count Risk:** a turnover and a Negative Transition for the same incident are two constructs (event vs phase marker — §9.2); never summed. Possession `Ended by: Turnover` is a qualifier value, not a Turnover event (never counted here).
**Data Requirement:** label.
**Confidence / Limitation:** turnover type (unforced/error vs forced) not representable; "turnovers *won*" = mirror team partition.

#### M-C6 Duels

**Definition:** Duel events (contested situation between players of opposite teams).
**Source Events:** `E.label='Duel'`.
**Formula:** `count{...}`; dimensions yes.
**Double-Count Risk:** disjoint label; no winner recorded (see below).
**Data Requirement:** label.
**Confidence / Limitation:** **no outcome field — duel wins/losses are NOT COMPUTABLE** (§7 NC-11); protocol T7 recommends tagging the duel for the player engaged; team semantics per T1 (team of the tagged player).

### Group E — Spatial (raw counts; the Level 3 matrix in §6 applies)

#### M-E1 Located Events

**Definition:** Events with a location set.
**Source Events:** `E.location ≠ null`.
**Formula:** `count { E : E.location ≠ null }` (per label, team-partitioned).
**Purpose:** denominator of all spatial metrics and the spatial completeness gate.
**Unit:** count.
**Double-Count Risk:** none.
**Data Requirement:** location.
**Confidence / Limitation:** located subsets are **samples** of where events happened, chosen by the analyst; they are not a positional feed. Located-event share (M-L2-E1) must accompany every spatial figure.

#### M-E2 Event Counts by Zone (family)

**Definition:** For a label set L (or all events): counts per zone (third × channel), computed with `locationZone` semantics.
**Formula:** `count { E : E.label∈L ∧ HasZone(E, i, j) }` for each (i,j) ∈ 3×3; unlocated bucket reported.
**Unit:** count per zone.
**Team/Player:** partitionable.
**Double-Count Risk:** zones disjoint by construction; the 9 buckets + unlocated sum exactly to the base count.
**Data Requirement:** location.
**Confidence / Limitation:** equal-area assumption in normalized coordinates; single-point-per-event; orientation per T2; **this is explicitly NOT a heat map** — rendering/binning beyond the 3×3 model is out of scope (and the 3×3 model must not change).

#### M-E3 / M-E4 Event Counts by Third / by Channel

**Definition:** marginal counts of M-E2 over thirds / channels.
**Formula:** `Σ_j count(i,j)` per third i; `Σ_i count(i,j)` per channel j.
**Unit:** count; margins sum to the located total.
**Double-Count Risk:** margins are over disjoint buckets.
**Data Requirement:** location.
**Confidence / Limitation:** as M-E2.

### Group G — Player (raw counts)

#### M-G1 Appearances

**Definition:** A player "appears" in a match if (a) listed in `matchInfo.startingXI` (playerId set), or (b) referenced as `playerOnId` in any Sub event of that match.
**Formula:** `|{ p : p ∈ startingXI playerIds } ∪ { p : ∃ Sub E, E.playerOnId = p }|` (per match).
**Unit:** count (and per-player flag).
**Double-Count Risk:** union of two disjoint sources (starter vs sub-on); a starter subbed-off remains an appearance.
**Data Requirement:** startingXI, Sub events.
**Confidence / Limitation:** approximate: startingXI entries with empty playerId are unresolved (counted as "lineup slot empty" audit flag); no minutes (NC-13) → **not** a denominator for per-90.

#### M-G2 Player Event Counts (family)

**Definition:** For each player and each label: the number of that player's events (playerId partition), with the unattributed bucket.
**Formula:** `count { E : E.label = L ∧ PlayerOf(E) = p }` per (p, L); `count { E : E.label = L ∧ PlayerOf(E) = null }` unattributed.
**Unit:** count; spatial/state/time partitionable (Level 3).
**Double-Count Risk:** per-label disjoint; Sub events count the *event* once (attributed via playerOffId/playerOnId in M-G5, not via playerId which may also be set — the spec attributes Sub involvement ONLY through playerOff/playerOn to avoid double attribution within player metrics).
**Data Requirement:** playerId.
**Confidence / Limitation:** event volume ≠ player quality (§2 P2; see M-L2-G3 interpretation warning).

#### M-G5 Substitution Involvement

**Definition:** per player: sub-on count (`playerOnId`) and sub-off count (`playerOffId`).
**Formula:** counts as above.
**Unit:** count.
**Double-Count Risk:** one Sub event yields exactly one sub-on and one sub-off attribution (disjoint roles).
**Data Requirement:** playerOnId/playerOffId.
**Confidence / Limitation:** a Sub event with only one of the two IDs set produces an unpaired attribution (audit flag X8).

---

## 5. LEVEL 2 — DERIVED METRICS

Derived from raw events. Ratios follow P5 (null when denominator 0) and P4 (missing-field exclusions reported).

#### M-L2-A1 Shot Accuracy

**Definition:** Share of tagged shots (with known outcome) that were on target. **Convention: blocked shots are excluded from the denominator** (a blocked shot is by definition off target *for the shooter* but is a separate tactical outcome; excluding blocked keeps the metric "would the shot have gone in"). This convention is a **reviewable decision** and is stated here so there is exactly one number, not two.
**Purpose:** finishing/selection quality.
**Source Events:** Shot events.
**Formula:** `M-A5 / (M-A5 + M-A6)` — per team; null if denominator 0.
**Unit:** percentage, 1 decimal.
**Inclusion/Exclusion:** numerator On target; denominator On + Off target; **Blocked and Unknown excluded from both** (their counts must be printed next to the value).
**Team/Player:** yes both (player-level flagged with completeness).
**Double-Count Risk:** disjoint subtype buckets.
**Data Requirement:** subtype.
**Confidence / Limitation:** conditional on outcome completion; judgment-based subtype; no shot placement.

#### M-L2-A2 Shot Conversion

**Definition:** Goals per tagged shot.
**Formula:** `Goals(team) / Shots(team)`; null if 0 shots.
**Unit:** percentage, 1 decimal.
**Inclusion/Exclusion:** all goals and all shots of the team; **assumption (protocol T4): every goal is also tagged as a Shot** — otherwise the ratio is invalid. Audit X5 flags when Goals > Shots.
**Double-Count Risk:** goals and shots are different constructs; this is a ratio across constructs, not a sum.
**Data Requirement:** labels + team.
**Confidence / Limitation:** small numbers make the rate volatile — always report with numerator and denominator.

#### M-L2-A3 Chance Conversion

**Definition:** Goals per tagged Chance.
**Formula:** `Goals / M-A9` (same team); null if no chances.
**Unit:** percentage, 1 decimal.
**Double-Count Risk:** ratio across constructs (Chance vs Goal); no event is double counted because nothing is summed.
**Data Requirement:** labels + team.
**Confidence / Limitation:** depends on the analyst's chance-tagging generosity; conversion rates only comparable across matches with consistent Chance usage.

#### M-L2-A16 Tagged-Attribute Shares

**Definition:** shares of M-A16 buckets over the tagged-value subset, with the unknown share reported alongside.
**Formula:** `bucket / (Σ tagged-value buckets)`.
**Unit:** percentage, 1 decimal.

#### M-L2-B1 Pass Success %

**Definition:** Successful passes over passes with known outcome.
**Formula:** `M-B2 / (M-B2 + M-B3)` per team/player; null if denominator 0.
**Unit:** percentage, 1 decimal.
**Inclusion/Exclusion:** Unknown-outcome passes (M-B4) excluded from the denominator **and reported next to the value**.
**Double-Count Risk:** disjoint outcome qualifier values.
**Data Requirement:** Outcome qualifier.
**Confidence / Limitation:** tagged-universe (P2) — pass success is only meaningful relative to tagging density (T6); no pass receiver → no receiver-adjusted quality.

#### M-L2-B2 Pass Subtype Profile

**Definition:** shares of Progressive/Lateral/Backward/Long within the subtype-known passes.
**Formula:** `M-Bs / (M-B5+M-B6+M-B7+M-B8)`.
**Unit:** percentage, 1 decimal, per subtype.
**Confidence / Limitation:** single-axis exclusivity means the profile cannot express combined categories (long-progressive); unknown subtype share reported.

#### M-L2-B3 Pressure-Split Pass Success

**Definition:** Pass success % restricted to passes tagged `Under pressure` (and, separately, `Free`).
**Formula:** `M-B2∧UnderPressure / (M-B2+M-B3∧UnderPressure)`; mirror for Free.
**Unit:** percentage, 1 decimal.
**Confidence / Limitation:** pressure is analyst judgment; the two splits plus the unknown-pressure share must all be reported together.

#### M-L2-B4 Tagged Possession Interval Share

**Definition:** our share of *tagged* possession interval time.
**Formula:** `M-B11(our) / (M-B11(our) + M-B11(opponent))` — **only when both teams' intervals are tagged**; null otherwise. Deliberately NOT called "possession %" (NC-1).
**Unit:** percentage, 1 decimal.
**Double-Count Risk:** intervals of the same label cannot overlap; the share is over tagged interval time only.
**Confidence / Limitation:** conditional on exhaustive alternating tagging of both teams' possessions (protocol T8) — in practice rarely satisfied; the metric must display the tagged interval time total next to the share.
**Presentation constraint (v1.0 implementation directive — documentation only, definition unchanged):** the PitchLog tagging model does **not** provide a complete independent possession dataset. Therefore (a) any duration figure derived from Possession interval tags must be presented under the name **"Tagged Possession Share"** (or equivalent wording that clearly indicates it is based only on recorded PitchLog possession intervals) and must never be labelled "Possession %" or presented as an official match possession statistic; (b) computations use the **full unrounded interval durations** internally — rounding applies only to displayed values (§12.3); (c) the **raw possession interval data is preserved** in the analytics output for audit/re-derivation; (d) **our AND opponent tagged possession durations are both clearly reported** alongside the share; (e) when tagged possession data is insufficient (e.g. only one team's intervals tagged, or none), the result is reported as **limited/null with the reason** rather than presented with false precision.

#### M-L2-C1 Ball-Winning Events

**Definition:** Recoveries + Interceptions (an explicitly enumerated **disjoint** label set — the only sanctioned sum in this group).
**Formula:** `M-C3 + M-C4`.
**Unit:** count.
**Double-Count Risk:** labels disjoint; Press Wins are deliberately NOT included (they are a pressing-outcome construct, not a ball-winning event — §8.3).
**Confidence / Limitation:** tagging-convention dependent (T7 boundary between Recovery and Interception); the sum is stable because it counts events, not judgements.

#### M-L2-C2 Press Win Ratio

**Definition:** Press Wins per Press event, same team.
**Formula:** `M-C2 / M-C1`; null if M-C1 = 0.
**Unit:** percentage, 1 decimal.
**Inclusion/Exclusion:** uses only the two labels; **no linkage is claimed or implied** between individual Press and Press Win events (they cannot be paired in the current model).
**Double-Count Risk:** ratio of two disjoint label counts.
**Data Requirement:** both labels tagged under a consistent protocol (T7: a Press is logged for each pressing action; a Press Win for each judged success).
**Confidence / Limitation:** valid only under protocol T7; if the analyst logs Press Wins without corresponding Press events the ratio is meaningless — audit X4 flags when PressWins > Presses or when either count is zero while the other is not. **This is not "pressing success vs opportunities"** (NC-12).

#### M-L2-E1 Located-Event Share

**Definition:** share of events (per label) that have a location.
**Formula:** `M-E1(L) / M-base(L)`.
**Unit:** percentage, 1 decimal.
**Purpose:** spatial completeness gate (P4) — must accompany every spatial figure.

#### M-L2-F1 Score-State Changes

**Definition:** number of changes of the score state (WINNING↔DRAW↔LOSING) over the goal chain, in match order.
**Formula:** replay the goal chain (events sorted by SortKey; each attributed goal applies its After delta; M-A3 unattributed goals break the chain → metric null with the audit reason).
**Unit:** count.
**Double-Count Risk:** one state change per goal event by construction.
**Data Requirement:** attributed goal events only.
**Confidence / Limitation:** chain breaks on unattributed goals or manual score edits; reconciliation X1 must pass first.

#### M-L2-F2 Score-State Duration (goal-chain based)

**Definition:** total match time (in matchSeconds timeline) spent in each score state, computed from goal event timestamps (state boundaries = goal matchSeconds; period snaps cap segments at boundaries 2700/5400/6300/7200).
**Formula:** partition of [0, matchEnd] by the goal chain; `matchEnd` = 5400 (or 7200 with ET) — the official duration, because the clock snaps at endHalf (§1.11). Unattributed goals → null + audit.
**Unit:** seconds (1 decimal).
**Double-Count Risk:** segments disjoint by construction.
**Confidence / Limitation:** this is duration on the official timeline, **not ball-in-play time in each state** (NC-2); requires complete goal tagging (X1).

#### M-L2-G1 Player Pass Success %

**Definition:** M-L2-B1 restricted to `PlayerOf(E)=p`; unattributed and unknown-outcome buckets reported.
**Confidence / Limitation:** small denominators — report N alongside; interpretation warning (§2 P2): event success is not player quality.

#### M-L2-G3 Player Positive/Negative Event Counts (INTERPRETIVE — flagged)

**Definition:** per player, counts of events whose label is in one of two **classification sets**.
**Default classification (v1, explicitly interpretive, must be configurable, never hidden):**
- Positive set: `Goal`, `Shot`, `Chance`, `Key Pass`, `Cross`, `Press Win`, `Recovery`, `Interception`, `Positive Transition`, Pass with Outcome `Successful`.
- Negative set: `Turnover`, `Negative Transition`, `Foul` (committed by us), `Card` (any), Pass with Outcome `Unsuccessful`.
- Neutral/unclassified: `Possession`, `Press`, `Duel`, `Sub`, `Corner`, everything else, and all events without the required qualifier.
**Formula:** counts per player over the sets.
**Unit:** count.
**Purpose:** quick scan aid ONLY.
**Double-Count Risk:** the two sets are disjoint label-wise; a Pass Successful is counted once in Positive (its Outcome qualifier decides), never also as raw pass.
**Data Requirement:** labels + qualifiers.
**Confidence / Limitation:** **this metric is an interpretation layer, not a measurement.** A high positive count can mean a busy player, a high-usage role, or generous tagging (volume ≠ quality — §2 P2/P7). It must always be labelled "interpretive" in any output and its classification set printed with it.

#### M-L2-G4 Team Per-90 Normalization (restricted)

**Definition:** count × (90 / officialDurationMinutes), officialDurationMinutes = 90 (no ET) or 120 (ET match).
**Formula:** `count × 90 / duration`.
**Unit:** per 90.
**Double-Count Risk:** scaling, not counting.
**Confidence / Limitation:** degenerate for 90' matches (per-90 = raw count) — its only honest use is comparing ET-involving seasons; **player per-90 is NOT COMPUTABLE** (NC-13: no minutes). Not to be used as "per 90 minutes of ball-in-play" (NC-2).

### Audit group (Level 2 — data-integrity metrics; must run with every metric report)

#### M-X1 Goal-Chain vs Manual Score Reconciliation

**Definition:** compares the final score derived from the attributed goal chain with `matchInfo.ourScore`/`opponentScore`.
**Formula:** derived = (scoreForAfter, scoreAgainstAfter) of the last attributed goal in canonical order, else (0,0); compare to parsed manual values; report MATCH / MISMATCH / MANUAL-EMPTY.
**Unit:** status + both values.
**Purpose:** gate for game-state metrics (they are only valid when the chain reconciles or manual is empty).
**Confidence / Limitation:** manual score empty is common; MISMATCH must be displayed, never auto-resolved.

#### M-X2 Unattributed Events Count

**Formula:** `count { E : Unattr(E) }` (+ per label). Gate for team-partitioned metrics.

#### M-X3 Completeness Index (parametrized)

**Formula:** per (label, required-field): share of events with the field set. Gate for outcome/spatial/player metrics.

#### M-X4 Press/PressWin Consistency Advisory

**Formula:** flags when `M-C2 > M-C1` (per team) — under protocol T7 this should never happen.

#### M-X5 Goal/Shot Co-Tag Advisory

**Formula:** flags when `Goals > Shots` (per team) — violates protocol T4 assumption of M-L2-A2.

#### M-X6 Label-Pair Co-Timing Advisory (duplicate-tagging watch)

**Formula:** for sanctioned "different construct" pairs (Chance/Shot, Turnover/Negative Transition, Foul/Card, Recovery/Press Win), counts same-team same-`sequenceId` (or Δt ≤ 5s, same period) co-occurrences — **advisory only**: these are legitimate different constructs; the watch exists to detect accidental double-tagging of the same construct twice (e.g. two `Shot` events within 5s — same-label pairs are the real duplicate risk, also flagged).

---

## 6. LEVEL 3 — CONTEXTUAL METRICS

A Level 3 metric is `(base metric) × (context predicate)` — the counting rule of the base metric is never changed, only restricted. To avoid an explosion of near-identical 16-field entries, each context dimension is defined **once** as a context operator below; the sanctioned combinations are then listed in the matrix. Every Level 3 result inherits all fields of its base metric, with these additions:

**Definition (all Level 3):** base metric restricted to context C.
**Purpose:** context diagnostics — never summed with the base metric.
**Formula:** base formula ∧ context predicate C.
**Unit:** base unit.
**Team/Player level:** inherited.
**Double-Count Risk:** a Level 3 value is a *restriction*, not an addition — Σ over all values of one context dimension = base count (including the dimension's "unknown" bucket); the matrix forbids reporting two overlapping context dimensions in one figure without stating both.
**Data Requirement:** base fields + context field (missing context field → the dimension's Unknown bucket).
**Confidence / Limitation:** inherited from base + the sampling caveat of the context field.

### Context operators

| ID | Context | Predicate | Buckets | Notes |
|---|---|---|---|---|
| CT-ZONE | Zone | `HasZone(E,i,j)` | 9 zones + Unlocated | uses location; third/channel margins CT-THIRD / CT-CHANNEL |
| CT-STATE | Game state | `StateOf(E)` | WINNING / DRAW / LOSING | state *before* the event (§1.10); valid only if M-X1 passes or manual empty |
| CT-PERIOD | Period | `E.period` | 1H / 2H / ET1 / ET2 (+ stoppage sub-buckets via `IsStoppage`) / Non-play (PRE_MATCH, HT, ET_HT, FT) | default reporting splits In-Play vs Non-Play; stoppage derived per §1.11 |
| CT-MINBIN | Minute bin | from (period, matchSeconds): 1H bins 0–15/15–30/30–45+stoppage; 2H bins 45–60/60–75/75–90+stoppage; ET analogous | 6 (+ET) bins + non-play | **must use (period, matchSeconds)**, never officialMinute (folds stoppage ambiguously, §1.11) |
| CT-PLAYER | Player | `PlayerOf(E)=p` | players + Unattributed | for team metrics restricted per player |
| CT-SEQ | Sequence | `Seq(E)=s` | sequences + no-sequence | used by transition metrics (§9) |
| CT-MATCH | Match | per session | one bucket per loaded session | season aggregation (§12.4) |

### Sanctioned Level 3 matrix (v1)

| Base metric \ Context | ZONE | STATE | PERIOD | MINBIN | PLAYER | SEQ |
|---|---|---|---|---|---|---|
| M-A1/A2 Goals | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| M-A4–A8 Shots | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| M-A9 Chances | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| M-A10 Crosses / M-A11 Corners | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| M-A12 Fouls | ✅ (location; Zone qualifier via M-A16) | ✅ | ✅ | ✅ | ✅ | ✅ |
| M-A13/14 Cards | — | ✅ | ✅ | ✅ | ✅ | — |
| M-B1–B9 Passes | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| M-B10–B13 Possession intervals | ✅ (single point) | ✅ | ✅ | ✅ | — | ✅ |
| M-C1–C6 Pressing/defensive | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| M-D1–D2 Transitions (§9) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| M-E2 zone family | base | ✅ | ✅ | ✅ | ✅ | — |
| M-L2 ratios | ✅ (denominator = restricted base) | ✅ | ✅ | ✅ | ✅ | ✅ |

Examples of named Level 3 metrics (each = matrix cell, no new counting rules): *Shots while Losing* = M-A4 × CT-STATE(LOSING, our); *Press Wins while Drawing* = M-C2 × CT-STATE(DRAW, our); *Shots in Attacking third* = M-A4 × CT-ZONE(third=2); *Final-Third Tagged Events* = all-events × CT-ZONE(third=2) — **this is the honest replacement for "Final Third Entries", which is not computable** (NC-6: an entry requires a ball-position timeline and boundary crossing, which a single optional point per event cannot provide); *Recoveries in First 15' of each half* = M-C4 × CT-MINBIN; *Turnovers in Defensive Third (v1 "Dangerous Turnover" — spatial definition)* = M-C5 × CT-ZONE(third=0, our perspective per T2).

---

## 7. NOT CURRENTLY COMPUTABLE (Part 5)

Each entry: why it fails, what data is needed, whether it could reasonably be added later. Nothing here is faked.

**NC-1 Possession percentage.** Why: possession % requires exhaustive, alternating segmentation of ball-in-play time by team; PitchLog's Possession intervals are optional, single-label, one-at-a-time, and typically only our team's. Needed: a protocol (or automatic mechanism) that tags every possession of both teams with no gaps, plus a ball-in-play time definition. Later: feasible as a protocol discipline (T8) with heavy operator burden, or via video tracking — not a code-only fix. The spec's honest substitute is M-L2-B4 (tagged interval share, clearly labelled).

**NC-2 Ball-in-play time / effective time.** Why: the clock runs through stoppages in play; there is no dead-ball tagging. Needed: a dead-ball/ball-in-play event stream. Later: feasible (e.g. a whistle/dead-ball tag) but protocol-heavy.

**NC-3 PPDA (passes per defensive action).** Why: needs opponent pass counts during *our* out-of-possession windows — requires exhaustive opponent passing (NC-Pass totality) and exhaustive possession windows (NC-1). Needed: both of those. Later: only after NC-1-style discipline; not v1.

**NC-4 Distance covered, sprint counts, physical load.** Why: no tracking data; event locations are isolated optional points, not trajectories. Needed: player tracking (optical/wearable). Later: out of PitchLog's event-data scope.

**NC-5 "Big Chances" and "Chances Created" as two separate metrics.** Why: one flat `Chance` label serves both concepts; nothing distinguishes magnitude or creator/finisher perspective. Needed: qualifiers on Chance (e.g. `Size: Big/Regular`, `Perspective: For/Against`, or a `Chance Created` label distinct from `Chance`). Later: trivially feasible as a tagging-model change (new qualifier group), but that is a taxonomy change which this task forbids — recorded as a recommendation only (see §14).

**NC-6 Final Third Entries.** Why: an entry is a boundary-crossing of the ball's position; PitchLog stores at most one optional point per event and no consecutive ball position. Needed: ball-position timeline or pass end-locations. Later: feasible with pass end-location fields (also unlocks NC-8/NC-9 partially).

**NC-7 Switches of play.** Why: needs pass start and end positions with lateral displacement. Needed: pass end-location. Later: same as NC-6.

**NC-8 Progressive distance / line-breaking passes.** Why: pass end location and opponent block positions are absent; the `Progressive` subtype is an analyst judgment, not a measured displacement. Needed: pass end-locations (progressive distance); opponent line data (line-breaks). Later: progressive distance feasible with end-locations; line-breaks additionally need opponent structure data (hard).

**NC-9 Counter-press actions (as a distinct metric).** Why: distinguishing a counter-press from an organised press requires time-since-possession-loss, which requires exhaustive possession loss tagging (Turnover is optional and unlinked). The heuristic "Press within 10s of our Turnover" is definable but is complete only if every relevant turnover is tagged — it would silently miss counter-presses after untagged losses. Needed: either a `Context: Counter-press` qualifier on Press, or an exhaustive turnover/possession stream. Later: the qualifier is a trivial taxonomy addition (recommended in §8.5); not in this spec.

**NC-10 Press triggers.** Why: a trigger is the moment/location possession is lost by us (the cue for pressing); it needs an event link (which turnover cued which press) or automatic detection. Needed: event linkage (relatedEventId) or exhaustive loss tagging. Later: feasible with a linkage field (§8.5).

**NC-11 Duel wins / duel losses / duel success %.** Why: `Duel` is a flat tag with no outcome. Needed: a subtype (`Won`/`Lost`) or outcome qualifier on Duel. Later: trivial taxonomy addition (recommended §14); not in this spec.

**NC-12 Pressing success vs total press opportunities.** Why: the denominator would be the number of *occasions* the opponent received the ball under pressable conditions — no such segmentation exists. Needed: exhaustive opponent possession receipt data. Later: not realistically within manual event tagging.

**NC-13 Player minutes played / player per-90.** Why: playing time intervals require player-on/off times with reliable match end; PitchLog has startingXI (no time), Sub events (times, but no red-card/injury interruptions, no opponent subs unless tagged, no auto end-of-match attribution). A derived estimate would look exact while being wrong — rejected per P10. Needed: event-linked on/off (Sub already carries time) **plus** a reliable full-time marker **plus** a sendings-off convention. Later: feasible with modest additions; until then player metrics are counts and ratios, not rates.

**NC-14 Own goals (as a distinct class).** Why: the current goal representation is team-only (own goal = goal attributed to the benefiting team per protocol T3); no own-goal flag exists. Needed: an own-goal qualifier on Goal. Later: trivial taxonomy addition.

**NC-15 Numerical-advantage game state (10 vs 11).** Why: score-state is the only game-state field; red cards don't feed any live state machine. Needed: red-card-to-state linkage. Later: feasible (derived from Card+Sub stream with caveats).

**NC-16 xG / xA (expected goals / expected assists).** Why: xG requires a calibrated shot-quality model (shot location + type + situation + placement) — PitchLog has optional single-point shot locations, subtype, and a situation qualifier, but no model, and model outputs are estimates, not deterministic counts. xA additionally needs assist linkage. Needed: validated shot model + mandatory, validated shot end-state data. Later: possible as a separate modelling effort **outside this deterministic spec**; explicitly deferred, not approximated.

**NC-17 Pass completion from untagged passes / tagging-density-adjusted totals.** Why: the untagged universe is unknown; any extrapolation would invent data (P10). This is the structural completeness boundary of every tagged-universe metric (P2) and is handled by completeness reporting (M-X3), never by estimation.

**NC-18 Field tilt / territory share.** Why: needs positional sampling of ball/team location; PitchLog's located events are analyst-selected samples. The honest substitute: Level 3 located-event distribution by half/third with the located-share printed (M-E2 × CT-ZONE margins), explicitly not named "field tilt".

---

## 8. Pressing — precise proposed definitions (Part 6)

Nothing in this section is implemented. These are the definitions the metric layer **will assume**; several of them expose tagging-model gaps that are recorded as recommendations, not changes.

### 8.1 What the current taxonomy actually supports (source-verified)

- `Press` and `Press Win` are **independent flat labels** with no subtypes, no qualifiers, and **no event linkage** (§1.2, §1.5).
- There is no field anywhere in the event model that connects a Press Win to the Press action it belongs to, or to the possession that preceded it.
- `Recovery`, `Interception`, `Turnover` are likewise independent flat labels.
- Sequences (SEQ ids) are the only grouping mechanism, and they are analyst-manual and typeless.

### 8.2 Proposed definitions

- **Press Trigger** — *NOT CURRENTLY REPRESENTABLE* (NC-10). Proposed concept: the recognised cue that initiates a press — loss of possession (us) in a pressable context. Nearest existing data: a `Turnover` event; but turnovers are optional and unlinked, so trigger identification would be incomplete in an unquantifiable way. The spec does **not** define a trigger metric.
- **Press Attempt** — **`Press` event.** Definition: a deliberate defensive action by a tagged player of the out-of-possession team to apply pressure on the ball-carrier or a receiving option. One Press event = one press attempt by one player. Team field = the pressing team (protocol T1). Successive Press events by team-mates within one opponent possession are separate attempts (individual, not collective).
- **Press Win** — **`Press Win` event.** Definition: the analyst's judgment that a pressing situation ended with the pressing team regaining possession or provoking a dispossession. IMPORTANT: in the current model a Press Win is an *assertion*, not a proven possession change — it is not structurally tied to any Recovery/Interception/Turnover event. Metrics must never treat Press Win as a ball-winning event (M-C4/M-C3 stay separate; M-L2-C1 deliberately excludes it).
- **Successful Press** — v1 definition: **identical to Press Win** (the label exists precisely to mark success). No second success criterion is defined; a Press without a corresponding Press Win is not automatically a failed press (see the ratio caveat below).
- **Counter Press** — *NOT CURRENTLY COMPUTABLE as a distinct metric* (NC-9). Proposed concept: a press attempt initiated within a short window (suggested τ = 10s) after our own turnover, i.e. immediate pressing of the ball after loss. Definable only as a protocol discipline (tag `Press` with the counter-press context) or a linkage field — see 8.5.
- **Press Win Ratio** (already M-L2-C2): Press Wins ÷ Press attempts. Valid ONLY under protocol T7 (below). It measures *tagged pressing effectiveness*, not pressing success vs all press opportunities (NC-12).

### 8.3 Why "Press Win" must not be read as "ball recovery"

Source proof: (a) the labels are independent — a session can contain Press Win events with zero Recovery/Interception events, and vice versa; (b) no field links them; (c) nothing stops the analyst from tagging a Press Win for a press that forced a pass out of play (possession regained via throw-in only later, or not at all). Therefore:
- Press Win ⇒ possession regained is a **protocol claim**, not a data implication.
- The derived, honest, linkage-free view: report Press, Press Win, Recovery, Interception, Turnover as separate columns, plus M-L2-C1 (recoveries+interceptions) and M-L2-C2 (ratio), each with its own universe.
- A *heuristic* co-occurrence check (same team, Δt ≤ 5s, same period, optionally same sequenceId) can be computed as an **advisory** statistic (X6-style) — labelled heuristic, never used to merge counts.

### 8.4 Tagging protocol T7 (pressing)

For pressing metrics to be comparable, the operator commits to:
1. one `Press` event per press attempt by our player (team = our);
2. one `Press Win` event when the pressing situation is judged won (never instead of a Press, but alongside it — X4 flags violations);
3. `Recovery`/`Interception` tagged when possession is actually regained (independent of Press Win);
4. `Turnover` tagged with team = the team that lost the ball.

### 8.5 Minimum additional tagging needed (recommendation only — NOT part of this spec)

Option A (cheapest, keeps flat UX): add a qualifier group to `Press` — `Context: {Set press, Counter-press, Rest-defence}` — one extra chip; makes counter-press a Level 1 count and removes NC-9. Optionally later add `Outcome: {Won, Lost}` which would make `Press Win` redundant.
Option B (stronger, more invasive): add a `relatedEventId` field linking a Press Win (and optionally a Press) to the originating Turnover/Possession — enables trigger and counter-press metrics without new operator habits (auto-fill on tag), but changes the data model.
Minimum viable for v1 analytics is **Option A's Context qualifier**; Option B is the long-term structural fix. Neither is implemented now.

---

## 9. Transitions — precise definitions & anti-double-count rules (Part 7)

### 9.1 What the current taxonomy supports

`Positive Transition` and `Negative Transition` are flat quick tags (no type, no linkage). `Turnover` is a separate flat tag. Sequences are manual and typeless. There is no `Counterattack` label. Nothing links any of these to shots/chances/goals except time order and (optionally) sequenceId.

### 9.2 Proposed definitions

- **Positive Transition** — `Positive Transition` event. Definition: the moment our team regains possession with immediate attacking intent (a shift from out-of-possession to attack-minded possession). Team field = the team transitioning (normally `our`; opponent tagging allowed under the same predicate). Player = the player initiating the transition (regain/first action), when tagged.
- **Negative Transition** — `Negative Transition` event. Definition: the moment our team loses possession and enters its defensive-transition phase. **Relationship to Turnover (critical):** a Turnover is the *possession-loss event*; a Negative Transition is the *phase marker* of the same incident. They are different constructs on the same real-world moment. The protocol (T9) offers two consistent usages and the spec works with either, but the choice must be recorded per team/season:
  - **T9a (event-style):** tag only `Turnover` for a loss; use Negative Transition only for phase-level notes. Turnovers metric = loss count.
  - **T9b (phase-style):** tag both (Turnover = the loss event, Negative Transition = the phase); NEVER sum them; each metric stays on its own construct.
  In both usages, `M-C5 Turnovers` counts Turnover events and `M-D1`-family counts Negative Transition events; no metric adds the two.
- **Dangerous Turnover** — v1 definition (deterministic, spatial): **a Turnover event located in our Defensive third** (T2 orientation). This is reported as the Level 3 metric *Turnovers in Defensive Third* = M-C5 × CT-ZONE(third=0). A second, conditional definition — *Turnovers Followed by Opponent Shot/Chance (≤ τ=15s, same period, team=opponent)* — is defined in 9.3 as a linkage metric and reported separately. The two definitions are never summed and never both called "dangerous turnovers" in one report; each output names which definition it uses.
- **Counterattack** — *NOT CURRENTLY COMPUTABLE as a distinct construct* (no type field on Positive Transition). The nearest honest metrics are the linkage metrics of 9.3 (transition-to-shot) plus a spatial/temporal profile of Positive Transitions. Recommendation (not in this spec): a qualifier `Tempo: {Counter, Built-up}` on Positive Transition would make it a Level 1 count.
- **Transition Sequence** — a **derived grouping**, not an event: the set of events sharing a `sequenceId` that contains at least one transition event (`Positive/Negative Transition`). A transition sequence *begins* at the first event of that sequenceId (in canonical order) and *ends* at the last event of that sequenceId (in canonical order); its duration = last.time − first.time on the match-time timeline, capped at period boundaries (a sequence spanning a period boundary is reported as spanning, with both periods named, and excluded from within-period duration figures). If no sequenceId was active, the transition event still counts in M-D1/M-D2 but belongs to no transition sequence — reported in the no-sequence bucket.

### 9.3 Linkage (conditional) metrics — the transition family

All linkage metrics use the same core rule, stated once:

> **Linkage rule L(τ):** event B is "linked after" event A iff `B.period = A.period` ∧ `B.time − A.time ∈ (0, τ]` ∧ `Team(B) = 'our'` where A is our transition event (for follow-up metrics) — with B drawn from the specified label set. Default τ = 10s for shot follow-ups, 15s for turnover danger; **τ is a reported parameter**, not a hidden constant. Linkage is computed on the canonical order (§12.1). A follow-up event is linked to at most **one** transition event: the nearest preceding qualifying transition within τ (greedy backward match). This makes the linkage a function (deterministic) and prevents one shot from inflating two transition metrics.

- **M-L2-D1 Transition-to-Shot** — share of our `Positive Transition` events linked (L(10s)) to a our `Shot` within τ. Formula: `|{PT : ∃ Shot B, L(10)(B after PT)}| / |Positive Transitions|`. Unit: percentage + the linked pair count. Denominator = all Positive Transitions (tagged universe).
- **M-L2-D2 Transition-to-Chance** — same with label set {`Chance`}.
- **M-L2-D3 Transition-to-Goal** — same with label set {`Goal`} (attributed to our team).
- **M-L2-D4 Turnovers Followed by Opponent Shot/Chance** — `|{ TO(our) : ∃ B ∈ {Shot, Chance} with Team(B)='opponent', L(15) }| / |Turnovers(our)|`, plus the absolute count.
- **Transition Sequence profile (Level 3)** — counts and mean event-count/duration of transition sequences, partitionable by period/state.

**Confidence/limitations (family):** linkage is a **time-window heuristic on optionally and incompletely tagged events** — it is deterministic, but its completeness is bounded by tagging discipline; every linked-pair metric reports its denominator and the no-sequence/no-follow-up buckets. It is NOT a claim of causality.

### 9.4 Anti-double-count rules for the chain `Turnover → Negative Transition → Counterattack → Shot`

The four items in the user's example live on **four different constructs** in PitchLog:

| Item | Construct in PitchLog | Counted by | Level |
|---|---|---|---|
| Turnover | possession-loss event (label `Turnover`) | M-C5 | 1 |
| Negative Transition | phase marker (label `Negative Transition`) | M-D2 | 1 |
| Counterattack | **not a construct** (no field) | — | NC (§9.2) |
| Shot | attempt (label `Shot`) | M-A4 | 1 |

Rules that make the chain safe:
1. **One construct, one metric.** No metric sums events of different constructs. Turnovers, Negative Transitions, and Shots each appear exactly once in a report, in their own rows.
2. **Ratios, not additions, express the chain.** The relationship between constructs is expressed by conditional/linkage metrics with explicit denominators (M-L2-D1..D4). A conversion metric never adds the numerator into any total.
3. **Co-tagging is legitimate, summing is not.** For one real-world incident the analyst may tag Turnover + Negative Transition + Shot (three constructs). The event count grows by three; every *metric* still counts each construct once. Reports must therefore never present "total transition events" as Turnovers + Negative Transitions + Positive Transitions.
4. **Worked example (the user's chain):** an incident produces events: `Turnover`(our, 61:04), `Negative Transition`(our, 61:05), `Shot`(our, 61:09). Correct output: Turnovers = 1 (not 2); Negative Transitions = 1; Shots = 1; M-L2-D4 (if the shot were the opponent's) or D1-style linkage if ours: 1 linked turnover with denominator = our turnovers; no metric anywhere shows 3 or 4 for this incident; "Counterattack" is absent (not computable). The only number that combines constructs is a ratio, and it names its denominator.
5. **Level separation protects totals.** Level 3 restrictions (e.g. Shots in the 61–75 bin) never add to Level 1 totals — they are subsets, and the subset sums to the parent count including unknown buckets.

---

## 10. Tagging protocol requirements (conventions the metrics rely on)

The code enforces **none** of these; they are operator conventions. Metrics are valid only insofar as they hold. Each is testable via the audit metrics of §5.

- **T1 — Team-field semantics per label:** Goal = scoring team; Shot = shooting team; Pass = passing team; Foul = committing team; Card = team of the punished player; Corner = team taking the corner; Sub = team making the change; Possession = team in possession; Press = pressing team; Press Win = team that won the press; Turnover = team that **lost** the ball; Recovery / Interception = team that won the ball; Chance = team attacking; Cross / Key Pass = team attacking; Transitions = the team transitioning.
- **T2 — Pitch orientation:** one fixed frame — x = 0 is our goal line, x = 1 the opponent's; the same absolute frame is used for opponent events (an opponent shot near our goal is located in our Defensive third). y = 0 is the Left channel edge (from the perspective looking from our goal toward the opponent's, matching the UI layout).
- **T3 — Score changes:** only attributed Goal events change the score (matches code). Own goals are logged as goals for the benefiting team (NC-14 documents the limitation). Penalty goals: Goal has no situation qualifier; the accompanying Shot (if tagged) carries `Situation: Penalty`.
- **T4 — Shot/Goal co-tagging:** every shot attempt (including goals) gets a `Shot` event; goals additionally get a `Goal` event. Basis of M-L2-A2/A3; audit X5.
- **T5 — Different constructs may be co-tagged, the same construct must not be:** Chance+Shot for one attempt is fine (different constructs); two Shot events for one attempt is a duplicate (X6 same-label watch).
- **T6 — Tagging density discipline:** pass-volume metrics are comparable only across matches tagged with the same intended density (every pass vs key passes only). The session's density intention is not a field — it must travel with the report (recommendation: record it in the session filename or a future metadata field; not in this spec's scope).
- **T7 — Pressing discipline** (§8.4). **T8 — Possession-interval discipline** (exhaustive alternating intervals, both teams) required only for M-L2-B4. **T9 — Transition usage choice a/b** (§9.2), recorded per report.

---

## 11. Audit & reconciliation rules (summary)

1. Every metric output carries its envelope (§12.5): value, numerator/denominator where applicable, excluded-missing-field counts, parameters.
2. Gate metrics: M-X1 (score chain), M-X2 (unattributed), M-X3 (completeness), M-X4/X5/X6 (advisories). Gate failures are displayed, never silently resolved, and Level 3 STATE metrics are suppressed (nulled with reason) when X1 fails.
3. Construct separation table (§11.3 = §9.4 table pattern) is normative for every report: metrics of different constructs are never summed; ratios that cross constructs must name numerator and denominator.
4. The `Outcome`/`Phase`/`Category` columns of the current full-analysis CSV are **not** metric inputs (F7); the metric layer reads `Label` + `Subtype` + `qualifiers` only.
5. Possession's `Ended by` values (`Shot`, `Turnover`) are qualifier values, never event counts.
6. The Foul `Zone` qualifier and the `location` field are independent claims; spatial metrics use `location` only; disagreement is reportable, not resolvable.

---

## 12. Computation rules (determinism contract)

1. **Canonical order:** events sorted by `(time asc, id asc)`; `time` = `matchTime` (for interval events, `startTime` — which equals `time`). This matches the app's own sort (renderer.js lines 944/973) plus the stable id tie-break.
2. **Universe:** all computations run on the post-v3-migration event list of one session (or the concatenated season set, each event stamped with its session). Non-play periods (PRE_MATCH/HT/ET_HT/FT) are excluded from in-play metrics by default and reported in the non-play bucket.
3. **Rounding:** counts integers; durations 1 decimal; percentages 1 decimal (half-up); no floating-point equality tests — comparisons on stored fields only.
4. **Season aggregation:** Level 1 counts sum across matches. Level 2 ratios are recomputed from summed numerators/denominators (pooling), **never** averaged per-match. Level 3 contexts aggregate the same way within each context bucket. MatchId = `date_opponent` per current export — collision risk (same opponent twice on one date, or empty metadata) is flagged by a session-duplicate audit, and season aggregation must use the session's internal list position as the tie-break identity.
5. **Result envelope:** every metric emits `{ value, num?, den?, excluded{field:count}, params }`; denominators of 0 yield `null` (P5).
6. **Idempotence:** metric computation is a pure function of the event list; recomputation yields identical output.

---

## 13. Implementation notes (for the developer — nothing implemented here)

- **Input contract:** either (a) session JSON post-load/migration (fields per §1.15), or (b) the full-analysis CSV columns `Label, Subtype, Team, Primary Player ID, Secondary Player ID, Period, Match Seconds, Match Time, X, Y, Score For Before, Score Against Before, Score For After, Score Against After, Sequence ID` (note: use Match Seconds + Period, and the X/Y percent columns ÷100; ignore Category/Outcome/Phase per F7). Both inputs must yield identical metric values — a good implementation test.
- **Predicates before metrics:** implement §3 predicates once, with unit tests, then express metrics as compositions. This guarantees the determinism contract.
- **Envelope everywhere:** no metric returns a bare number.
- **Gates before derived metrics:** run X-group first; suppress STATE contexts on X1 failure.
- **Test oracles:** hand-computed fixtures (a synthetic event list with known answers for every Level 1/2 metric, plus a double-count regression fixture implementing the §9.4 worked example and asserting each construct's count is unchanged by co-tagging).
- **Possession durations (v1.0 implementation directive):** all M-B10..M-B13 / M-L2-B4 computations accumulate the **full unrounded** `endTime − startTime` seconds; rounding to 1 decimal happens only on displayed values. The analytics output preserves the raw interval list, reports our + opponent tagged durations next to the share, carries a limitation note (tagged-universe basis, NC-1), and returns null-with-reason when either team's intervals are untagged. The share is presented ONLY as "Tagged Possession Share" — never "Possession %".
- **No UI, no heat maps, no AI** — this spec is the review artefact; rendering decisions come after approval.

---

## 14. Open questions for the reviewer

1. **Shot Accuracy convention** (blocked excluded from denominator) — approve or switch to SoT / all known-outcome shots?
2. **Level 3 matrix coverage** — are all sanctioned cells wanted in v1, or should the first release ship a subset (recommendation: goals, shots, chances, pressing, transitions × state/period/zone)?
3. **Dangerous Turnover definition** — spatial (v1 default) vs conditional (≤15s follow-up) vs both, clearly named?
4. **Interpretive player classification set** (M-L2-G3) — approve the default sets or mark the metric out of v1?
5. **Tagging-model recommendations** recorded but not implemented (taxonomy changes are out of scope for this task; each unlocks a NOT-COMPUTABLE entry): Press `Context` qualifier (NC-9), Duel outcome subtype (NC-11), Chance size/perspective qualifiers (NC-5), Pass end-location fields (NC-6/7/8), Goal own-goal qualifier (NC-14), `relatedEventId` linkage (NC-10). Which of these, if any, should be scheduled as a *future* proposal?
6. **Tagging density metadata (T6)** — should a per-session density-intention field be proposed (metadata change, not taxonomy)?

---

## Appendix A — Metric ID index

**Level 1:** M-A1 Goals(For) · M-A2 Goals(Against) · M-A3 Unattributed Goals · M-A4 Shots · M-A5 Shots on Target · M-A6 Shots off Target · M-A7 Blocked Shots · M-A8 Shots Unknown Outcome · M-A9 Chances · M-A10 Crosses · M-A11 Corners · M-A12 Fouls Committed · M-A13 Yellow Cards · M-A14 Red Cards · M-A15 Substitutions · M-A16 Tagged-Attribute Distribution · M-B1 Passes · M-B2 Successful Passes · M-B3 Unsuccessful Passes · M-B4 Passes Unknown Outcome · M-B5/B6/B7/B8 Pass subtypes · M-B9 Passes under Pressure · M-B10 Possession Interval Count · M-B11 Possession Duration (Total) · M-B12 Possession Duration (Mean) · M-B13 Possession End-Reason Distribution · M-C1 Pressing Actions · M-C2 Press Wins · M-C3 Interceptions · M-C4 Recoveries · M-C5 Turnovers · M-C6 Duels · M-E1 Located Events · M-E2 Event Counts by Zone · M-E3 Counts by Third · M-E4 Counts by Channel · M-G1 Appearances · M-G2 Player Event Counts · M-G5 Substitution Involvement

**Level 2:** M-L2-A1 Shot Accuracy · M-L2-A2 Shot Conversion · M-L2-A3 Chance Conversion · M-L2-A16 Attribute Shares · M-L2-B1 Pass Success % · M-L2-B2 Pass Subtype Profile · M-L2-B3 Pressure-Split Pass Success · M-L2-B4 Tagged Possession Interval Share · M-L2-C1 Ball-Winning Events · M-L2-C2 Press Win Ratio · M-L2-D1 Transition-to-Shot · M-L2-D2 Transition-to-Chance · M-L2-D3 Transition-to-Goal · M-L2-D4 Turnovers Followed by Opponent Shot/Chance · M-L2-E1 Located-Event Share · M-L2-F1 Score-State Changes · M-L2-F2 Score-State Duration · M-L2-G1 Player Pass Success % · M-L2-G3 Positive/Negative Event Counts (interpretive) · M-L2-G4 Team Per-90 (restricted) · M-X1..X6 audit metrics

**Level 3:** context operators CT-ZONE / CT-THIRD / CT-CHANNEL / CT-STATE / CT-PERIOD / CT-MINBIN / CT-PLAYER / CT-SEQ / CT-MATCH + the sanctioned matrix (§6), including the named instances *Shots while Losing*, *Press Wins while Drawing*, *Shots in Attacking Third*, *Final-Third Tagged Events*, *Turnovers in Defensive Third*.

**NOT CURRENTLY COMPUTABLE:** NC-1 possession % · NC-2 ball-in-play time · NC-3 PPDA · NC-4 physical load · NC-5 big chances vs chances created (as separate metrics) · NC-6 final third entries · NC-7 switches · NC-8 progressive distance / line-breaks · NC-9 counter-press (distinct) · NC-10 press triggers · NC-11 duel wins/losses · NC-12 pressing success vs opportunities · NC-13 player minutes / per-90 · NC-14 own goals · NC-15 numerical advantage · NC-16 xG/xA · NC-17 untagged-universe extrapolation · NC-18 field tilt.

— END OF SPECIFICATION —
