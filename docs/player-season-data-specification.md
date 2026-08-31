# PitchLog — Player & Season Data Engine Specification (V1)

**Document ID:** `PitchLog-PLAYER-SEASON-SPEC-v1.0-draft`
**Status:** CORE V1 IMPLEMENTED (checkpoint `pitchlog-player-season-core-v1`) — see the implementation status note below. **Draft remains the governing methodology document.**
**Predecessors:** `docs/metric-specification.md` (`PitchLog-METRIC-SPEC-v1.0`, implemented), `docs/spatial-heatmap-specification.md` (`PitchLog-SPATIAL-SPEC-v1.0`, implemented).
**Reviewer roles:** football performance analyst (methodology), data-model architect (structure), developer (implementability).

---

## IMPLEMENTATION STATUS — core v1 (doc-only delta record)

The core aggregation layer (Implementation 1) is implemented in `src/player-season.js` (`computeSeason`) + the season view. The reviewer's approved implementation decisions delta this draft as follows (recorded here so the document stays the single source of truth):

1. **Per-90 is IMPLEMENTED, gated on reliable minutes** (approved decision): `total ÷ reliable minutes × 90`, never `matches × 90`; null when no reliable minutes. This supersedes the draft §10 prohibition item 4 ("no per-90 in V1 deliverables"). Interpretation note: the per-90 **numerator is restricted to the same reliable-minutes matches** as the denominator (documented in the engine protocol notes) so numerator and denominator describe one match set; the full season totals are always reported separately.
2. **Minutes quality codes are named RELIABLE / ESTIMATED / UNAVAILABLE** (approved decision) — mapping the draft §3.4 codes `ESTIMATED_FULL → RELIABLE`, `ESTIMATED_PARTIAL → ESTIMATED`, `UNKNOWN → UNAVAILABLE`. The season-level minutes rollup adds **MIXED** (some records reliable, others not; per-90 still uses only the reliable subset, with per-quality counts reported). The NC-13 amendment block (§3.4) is thereby APPROVED as implemented.
3. **Participation semantics as approved**: `selected` = listed in the session's squad snapshot (PitchLog has no bench/matchday-squad list); `unused` = selected ∧ ¬starter ∧ ¬substitute **and provable** (requires a starting XI to exist — otherwise the record is UNKNOWN, never guessed). An unused substitute is not an appearance.
4. **Record-completeness status** (VALID/PARTIAL/INSUFFICIENT) reflects identity/XI/FT/score/chain flags; location-coverage flags (LOW_LOCATION_COVERAGE, MISSING_LOCATION) remain reported but informational.
5. **Deferred to Implementation 2** (per the task instruction): recent form, trends, with/without-player, consistency — all still specified here (§5.3–§5.8) and still not implemented.
6. Multiple sub-ons: overlapping intervals are not summed — the **longest span** is used, flagged MULTIPLE_SUB_ON, quality ESTIMATED (spec §3.4 rule, now exact).

---

## 0. How to read this document

1. This specification defines the **PLAYER & SEASON DATA ENGINE V1**: the layer that turns *N validated saved match sessions* into a **player performance database** and a **team performance database** — match records, match history, recent form, season totals, season averages, trend analysis — as the data foundation for FUTURE (explicitly out-of-scope-here) AI analysis.
2. **Nothing in this document is implemented yet.** It is the review artefact. Implementation happens only after approval, as a separate task.
3. The chain this spec formalises:

   ```text
   MATCH 1 .. MATCH N  (saved session .json files, schema v3)
   ↓
   VALIDATED MATCH ANALYTICS      (EXISTING Analytics Engine V1 — unchanged)
   ↓
   PSD LAYER                      (NEW pure deterministic module — this spec)
   ↓
   PLAYER MATCH RECORDS · TEAM MATCH RECORDS
   ↓
   MATCH HISTORY · RECENT FORM · SEASON TOTALS · SEASON AVERAGES · TRENDS
   ↓
   VISUALIZATION / CSV            (future implementation phase)
   ↓
   (FUTURE AI ANALYSIS — explicitly NOT in V1)
   ```

4. **Authority rule:** where this document and the actual source disagree, the source wins; the implementation phase must re-verify the line references in §1 (they drift as the renderer grows).
5. **Inheritance rule:** this spec inherits, without restating, every binding constraint of the metric specification — the P1–P10 principles (§2 there), the envelope rule (§12.5), construct separation (§11.3), the determinism contract (§12), the tagging protocol (§10), and the NC-1..NC-18 not-computable list (§7). Where this spec *proposes to amend* one of those constraints (exactly one: NC-13 player minutes), the amendment is marked **[NC-13 AMENDMENT — REQUIRES REVIEWER APPROVAL]** and isolated in §3.4/§12.1 so it can be accepted or rejected independently.
6. **Naming honesty rule (project-wide convention):** every user-visible artifact of this engine is named for what the data actually is — *tagged* event counts, *recorded* intervals, *estimated* minutes — never for what a football report would call the official statistic. The canonical/forbidden name lists are in §8.4 (PSD-N).
7. **Task-message note:** the reviewer's instruction list for this phase was received in two parts and the field list of the player match record ends at "2H Events". This document completes the record from the verified data model (§1) and the stated product objective; every completion decision that a reviewer might want to decide differently is listed in §12 (open questions). Nothing outside the stated objective has been invented.

---

## 1. Verified current data capabilities (Part 1 — source inspection results)

Inspected: `src/analytics.js` (v1.1.0, 1,873 lines), `src/renderer.js` (3,894 lines), `src/main.js` (753 lines), `src/index.html`, session/squad/matchInfo model, substitutions, starting XI, existing season view, existing season CSV, current analytics output. Working tree = `8b8ce76`, clean.

### 1.1 Session & persistence model (main.js)

- A saved match session is a single JSON file: `{ videoPath, tags, events, squad, matchInfo, matchClock, __schemaVersion: 3, __savedAt: ISO-8601 }` (`file:saveSession`, main.js 336–363; payload built at renderer.js 2861–2863). `__savedAt` is stamped at save time (346) — **every session file carries a UTC save timestamp**.
- `file:loadMultipleSessions` (main.js 444–465) loads N user-selected session files, migrates each to v3, attaches `sourceFile` (absolute path), and **skips invalid files without failing the batch**.
- The **squad is a global roster** persisted at `userData/squad.json` as `{__schemaVersion, players:[{id, number, name}]}` (main.js 475–532). Player objects carry **no position, no DOB, no attributes** — identity only.
- **Each session file embeds its own squad snapshot** (the `squad` field above) — the roster *as it was when the match was tagged*. This snapshot is currently **dropped by every consumer**:
  - session load (renderer.js 2874–2934) restores tags/events/matchInfo/matchClock but **never restores squad** (the global roster is kept);
  - the season view keeps only `{id, sourceFile, matchInfo, events, tags}` per loaded match (renderer.js 2796–2802) — **the per-session squad snapshot is discarded**;
  - the season CSV resolves player names/numbers via `resolvePlayer` against the **current live squad** (renderer.js 2836–2841, 1158–1161).
  → Cross-match player-name fidelity is therefore currently broken-by-design; §3.1/PSD-H3 makes the *session's own* snapshot the resolution source, with audits (PSD-X4/X5) for drift.

### 1.2 Player identity

- Events reference players by **string id only**: `playerId`, `playerOffId`, `playerOnId` (schema v2 conversion, main.js 200–224). Ids are stable only within one squad.json lineage (same machine/userData). There is no person-level key, no squad-version field.
- `resolvePlayer(pid)` (renderer.js 1158–1161) knows **only the live squad**; unknown ids render as "Unknown player".
- No identity audit exists anywhere (same id with different names across sessions, or same name with different ids, both pass silently today).

### 1.3 Starting XI & substitutions

- `matchInfo.startingXI` = array of `{ position, playerId }` slots, positions templated from `FORMATIONS` (renderer.js 404–412; slots built 451–492). Properties that matter to this spec:
  - **optional** — the analyst may never set a formation;
  - **partially fillable** — any slot can keep `playerId: ''` ("lineup slot empty" in metric-spec M-G1);
  - **reset on formation change** (513–516) — a mid-session formation change wipes and rebuilds the XI;
  - **carries no time** — a starting XI entry implies kick-off of 1H (matchSeconds 0) by convention only.
- **Substitution events:** the `Sub` tag (renderer.js 46) logs one event per substitution; the detail panel sets `playerOffId` / `playerOnId` via **optional** squad chips (1394–1404, click toggles 1440–1446). A Sub event carries:
  - `matchSeconds` — the substitution moment at tag-time precision (the ONLY on/off timing data that exists);
  - `team` — the team selected at tag time (`'our' | 'opponent' | null`); opponent-side subs reference **our squad's chips** when set (attribution noise — audit PSD-X6);
  - an optional `location`;
  - **no subtype** — one event encodes both directions (off and on) of the same substitution;
  - no count limit, no ordering constraint (a second sub-on for the same player is representable and is audited, PSD-X6).
- Red cards: `Card` events with `subtype: 'Red'` (renderer.js 44) may carry `playerId` + `team` — a player-attributed red card is a **detectable end-of-participation marker** (used by the minutes model §3.4, audited when absent).

### 1.4 Match clock & the minutes question (verified, per the reviewer's explicit instruction)

The task instruction: *"Do not assume minutes can be calculated accurately until the substitution/start-time data is verified."* Verification results:

**What exists:**

| Data | Location | Quality |
|---|---|---|
| Substitution moments | Sub events' `matchSeconds` | exact at tag-time precision |
| Start-of-play for starters | implied 1H = 0:00 | convention, reliable |
| Start-of-play for subs | Sub `playerOnId` event's `matchSeconds` | exact |
| End-of-participation, subbed off | Sub `playerOffId` event's `matchSeconds` | exact |
| End-of-participation, sent off | Card/Red event `matchSeconds` when player-attributed | exact when tagged |
| Match end (FT) | persisted `matchClock.period === 'FT'` + `clockBaseSeconds` | **conditional** |
| Red-card convention | none documented | inference, gated |

**What breaks exactness (the honest limits):**

1. **`endHalf()` snaps the clock to the 45/90/105/120 boundary** (renderer.js 144–155): stoppage is folded away if the analyst ends the half before/after tagging the stoppage events. A sub tagged at 45+2 then `endHalf` → its `matchSeconds` is 1620+120; a sub tagged *after* `endHalf` → 1620 exactly. Minutes inherit whatever the analyst did.
2. **Sessions saved mid-match** (period `2H`, clock stopped at e.g. 63:12) have **no FT marker** — the observed end is the last known event/clock base, and true playing time beyond it is unknown.
3. **No FT marker at all** if the analyst never pressed End Half (period stays `2H` with `clockBaseSeconds` possibly > 5400 — a usable *observed-lower-bound* end, quality-flagged).
4. **Sendings-off convention absent** (metric-spec NC-13): a sent-off player with no Sub-off and no tagged Card/Red looks like a full-match player.
5. **Opponent-tagged Subs** can reference our squad ids (§1.3) — noise in the off/on markers.
6. **Injury time / abandoned matches / non-standard durations**: nothing in the model records them.

**Conclusion (binding):** *participation* (started / subbed on / off / sent off / unused) is **exactly computable**; *minutes* are computable **only as a gated estimate with explicit quality codes and reason flags** (PSD-PM-M, §3.4). The metric specification currently **rejects** player minutes outright (NC-13, metric-spec §7/§886: "a derived estimate would look exact while being wrong — rejected per P10"; "Needed: event-linked on/off **plus** a reliable full-time marker **plus** a sendings-off convention"). All three ingredients are *detectable-when-present* in the current model; therefore this spec defines minutes as an **explicit NC-13 amendment proposal** (§3.4) that ships the estimate only behind gates, and keeps **per-90 rates excluded from V1 deliverables** (§10). **Approval or rejection of §3.4 is the single most important review decision of this document** (open question §12.1). If rejected, every other section stands unchanged with the minutes block returning `null` + reason `NC_13_NOT_AMENDED`.

### 1.5 Match context (matchInfo)

`matchInfo = { competition, date, opponent, venue, homeAway('home'|'away'|'neutral'), ourScore, opponentScore, formation, startingXI }` (renderer.js 414–419; echoed into the analytics input contract, analytics.js 1791–1798). Verified facts:

- `date` comes from `<input type="date">` (index.html 322) → `'YYYY-MM-DD'` string or `''`. ISO string sort = chronological sort; empty dates are possible and must be handled (PSD-S0).
- `ourScore`/`opponentScore` are **strings, possibly `''`** — the manual final score. Result W/D/L derivation: manual score when both non-empty; otherwise the attributed goal chain; the per-match **X1 reconciliation status** (MATCH / MISMATCH / MANUAL-EMPTY, analytics.js 1826–1833) already tells which is authoritative and flags disagreement (propagated by PSD-X7).
- **There is no "our team" name field anywhere** (only `opponent`). Team-level season records are for "Us"; per-opponent splits key on the opponent string. Team naming limitation is standing text PSD-N.
- `venue`, `competition` are free text (may be empty).

### 1.6 Match identity

- **Events carry NO `matchId`** (verified: `buildEventBase`, renderer.js 894–918 — no match-id field; the only `matchId` in the codebase is a **CSV export synthesis** `date + '_' + opponent`, renderer.js 3746, with the collision risk already documented in metric-spec §12.4).
- Available identity material per loaded session: `sourceFile` (absolute path — unique per file, breaks if the user renames/moves files), `__savedAt` (ISO, unique per save), `date + opponent` (human label, collision-prone), and the load-order index (metric-spec §12.4 designates the session's **internal list position as the tie-break identity**).
- PSD-C therefore defines a **match key** external to the event model (§5.1) and a duplicate audit (PSD-X1). **No event-model change is proposed or permitted.**

### 1.7 What the Analytics Engine V1 already provides per match (consumed unchanged)

`AnalyticsEngine.computeMatchAnalytics({ events, matchInfo, matchClock, squad, tags })` (analytics.js 1512) — exactly a saved session's shape, so **per-match analytics for every loaded session are already computable with zero engine changes**. Outputs PSD consumes:

- `A.players.list[]`: per player — `playerId, name, number, appearance, events, byLabel{}, metrics{goals, shots, shotsOnTarget, chances, keyPasses, crosses, passes, passSuccess(ratio envelope), presses, pressWins, interceptions, recoveries, turnovers, duels, fouls, yellowCards, redCards, positiveEvents, negativeEvents, subOn, subOff}` + `unattributed{events, byLabel}`; interpretive classification note attached (analytics.js 790–908; metric-spec M-G1/G2/G5, M-L2-G1/G3).
- `A.spatial`: `locatedEvents[]` records (full-precision x/y, `playerId` (Sub → null), `period, matchSeconds, minuteBin, stateBefore, sequenceId, team, label, subtype`, zone/third/channel) — **per-player period / state / spatial partitions are derivable from these records**; `playerGrids[]` (9-cell zone counts + Unlocated + located share, per player); `completeness` (located/unlocated/out-of-range/invalid + locatedShare envelope) (analytics.js 1046–1330).
- `A.level1.possession`: `totalSecondsExact` (unrounded) + raw interval list + tagged-possession-share envelope with the NC-1 basis (M-L2-B4) — season pooling input.
- `A.level3`: byPeriod / byState / byZone / byThird / byChannel / byMinuteBin (19-key L3 buckets); `PERIOD_ORDER = ['1H','2H','ET1','ET2','Non-play','Unknown']` (analytics.js 80).
- `A.matchSummary`: `durationMinutes` (90, or 120 when any ET-period event exists, analytics.js 1531), score chain + manual + X1 status, periodsPlayed, stoppage counts.
- `A.gates.X1..X6`, `A.protocol.notes` — inherited verbatim into PSD records' provenance.

**Not present anywhere (and PSD must not pretend they are):** per-player minutes, per-player score-state or period partitions (engine-level), per-player possession involvement (possession intervals are team-attributed; interval events may carry a `playerId` from tag-time selection, but no sanctioned player-possession metric exists — PSD does not create one), phase (F7/NC), opponent player identities, ball-in-play time.

### 1.8 Current season view & season CSV (the state of the art today)

- **Season view** (renderer.js 2726–2853, modal index.html 400–417): user adds N session files (dedupe by `sourceFile`); in-memory list only — **nothing persists** (no registry; re-loaded from files each time); combined totals = `computeStatsFor(flatMap(events))` — the legacy live-stats panel: label/subtype/qualifier counts, **legacy `side`** (for/against/neutral), top-8 players by involvement count. **No per-match records, no dates, no results, no ratios, no gates, no honesty layer, no player view, no spatial.**
- **Season CSV** (renderer.js 2809–2853): flat event dump across matches, one `match` label column (human string), **legacy `side` column — not `team`**; player names from the **live** squad; zone/x/y columns included.
- **No match-history / form / trend / player-season anything exists.**

### 1.9 Gaps this spec closes (the delta)

1. No canonical **player match record** (one player × one match).
2. No **participation model** (started/sub-on/off/unused/unknown) beyond the boolean `appearance`.
3. No **minutes estimate** with gates (NC-13 amendment).
4. No **team match record** (result W/D/L + tagged context).
5. No **match identity** & duplicate audit for multi-match data.
6. No **per-session squad snapshot** resolution (names come from the live squad — wrong after roster edits).
7. No **identity audit** (id drift / same-person-different-id).
8. No **season aggregation** of any engine metric (the season view bypasses the engine entirely).
9. No **recent form**, **trend**, **with/without player**, **spatial tendencies**, **consistency** views.
10. No **pooled tagged-possession share** across matches.
11. Season CSV uses legacy `side` and live-squad names.
12. No per-player period (1H/2H/ET) and score-state (W/D/L) partitions.

---

## 2. Design principles (PSD-H)

- **PSD-H1 — Sessions are the unit of truth.** Every season figure derives from saved session files via the EXISTING per-match analytics chain. PSD never recomputes a metric the engine already computed — it *consumes* `A.*` outputs and *derives* only the new partitions (participation, minutes, per-player period/state, cross-match aggregation). Where PSD's own record-level pass overlaps an engine output, equality is a **tested invariant** (PSD-T3), not an assumption.
- **PSD-H2 — Derive-on-load, stateless.** The V1 season universe is the set of sessions loaded in the current app run. No new on-disk store, no registry, no caching layer (persistence is open question §12.2). Pure function: `computeSeason(sessions[], options) → PS`.
- **PSD-H3 — Identity is playerId; resolution is per-session.** Names/numbers resolve from the **session's own embedded squad snapshot**; the live squad is never used for historical resolution. Cross-session id/name mismatches are audits (PSD-X4/X5), never silent merges or renames.
- **PSD-H4 — Tagged universe.** Season counts are sums of *tagged* counts. Completeness (located shares, unattributed, unlocated) is inherited per match and pooled — nothing is extrapolated to untagged reality (NC-17).
- **PSD-H5 — Pool ratios, never average them** (metric-spec §12.4 verbatim): every season ratio is recomputed from summed numerators/denominators. Averaging is allowed **only** as a simple arithmetic mean of *counts* or *exact durations* (per-appearance / per-match averages, rolling means of counts), always so labelled.
- **PSD-H6 — Minutes are a gated estimate** (the NC-13 amendment, §3.4): participation exact; minutes carry quality codes and reason flags; **no per-90 rates anywhere in V1**.
- **PSD-H7 — Envelope everywhere; construct separation inherited.** No bare numbers; metrics of different constructs are never summed (metric-spec §11.3/§12.5).
- **PSD-H8 — Gates before derived.** Per-match X1 status propagates into every season record; season-level PSD-X gates are displayed, never silently resolved.
- **PSD-H9 — Honest naming** (PSD-N, §8.4): "Tagged", "recorded", "estimated", "observational" qualifiers in every user-visible artifact; the forbidden-name list is binding on the future implementation.
- **PSD-H10 — Determinism & purity.** PSD is a pure function of `(sessions, options)`: no I/O, no DOM, no `Date.now()` (ordering uses data fields only), idempotent, stable key order, stable sorts with full tie-breaks. Identical inputs → byte-identical output.
- **PSD-H11 — Zero model change.** PSD consumes sessions read-only. No event fields added/removed/renamed; taxonomy, 3×3 model, team/player/time/sequence/score-state models untouched; **no new dependencies**; **no AI** (the "FUTURE AI ANALYSIS" box is downstream of, and outside, this engine).
- **PSD-H12 — Read-only artefact.** This document specifies; it does not implement. Nothing in the app changes until the reviewer approves.

---

## 3. The PLAYER MATCH RECORD (PSD-PM) — Part 2 canonical structure

One record = **one player × one match**. Only players with ≥1 participation fact or ≥1 attributed event get a record (see §3.2 population rule). Every block is a plain JSON object; every count field carries the standard envelope `{ value, num?, den?, excluded? }` inherited from the metric spec (§12.5) — the schema below states `type` once per family and does not repeat envelope structure per field.

### 3.1 PSD-PM-1 — Identity & match context block

```json
{
  "playerId": "player_ab12cd34",
  "name": "Resolved from THIS session's embedded squad snapshot; 'Unknown player' fallback",
  "number": "9",
  "matchKey": { "sourceFile": "/abs/path/match.json", "savedAt": "2026-08-31T18:00:00Z",
                "label": "2026-08-15_vs Team X", "loadIndex": 2 },
  "opponent": "Team X", "competition": "League", "date": "2026-08-15",
  "homeAway": "home", "venue": "…", "formation": "4-3-3",
  "engineVersion": "1.1.0", "specIds": { "metric": "…v1.0", "spatial": "…v1.0", "psd": "…v1.0" }
}
```

Rules: `matchKey.label` = `date || '(no date)'` + `_vs ` + `opponent || '(no opponent)'` — **display label only, never a join key** (PSD-S0). `loadIndex` = the session's position in the loaded list (metric-spec §12.4 tie-break identity).

### 3.2 PSD-PM-2 — Participation block

Derived **exactly** (no estimation involved):

| field | rule |
|---|---|
| `started` | bool — playerId ∈ `matchInfo.startingXI` with non-empty playerId |
| `subbedOn` / `subbedOnSeconds` | bool / Sub event matchSeconds where `playerOnId = playerId` (team-agnostic, per engine M-G5 semantics; team noise audited PSD-X6) |
| `subbedOff` / `subbedOffSeconds` | bool / Sub event matchSeconds where `playerOffId = playerId` |
| `sentOff` / `sentOffSeconds` | bool / Card-Red event matchSeconds where `playerId = pid ∧ team = 'our'` |
| `appearance` | bool — M-G1 union (started ∨ subbedOn) — **identical to the engine's flag (tested invariant PSD-T3)** |
| `participationStatus` | enum, deterministic precedence: `STARTED` · `STARTED_SUBBED_OFF` · `STARTED_SENT_OFF` · `SUB_ON` · `SUB_ON_SUBBED_OFF` · `SUB_ON_SENT_OFF` · `STARTED_FULL` (started, no off marker, FT present) · `UNUSED_SUB` · `NOT_INVOLVED` · `UNKNOWN` |
| `participationUnknownReason` | `STARTING_XI_MISSING` (no XI set at all) / `STARTING_XI_INCOMPLETE` (XI present but the player is neither in it nor subbed on — cannot distinguish unused sub from not-in-squad) / null |

**Population rule:** records exist for (a) every player with ≥1 participation fact, ∪ (b) every playerId with ≥1 attributed event. `UNUSED_SUB` / `NOT_INVOLVED` records exist **only when the starting XI is complete enough to prove them** (≥11 filled slots for NOT_INVOLVED; see PSD-X2 for the completeness audit) — otherwise the player falls under (b) with `UNKNOWN` status if he has events but no XI evidence. **Squad-wide `UNUSED_SUB` enumeration is a season-level view, not a per-match obligation.**

### 3.3 PSD-PM-3 — Event-counts block (all from the engine's `A.players` output, verbatim)

`goals, shots, shotsOnTarget, chances, keyPasses, crossEvents, passEvents, passSuccess (ratio envelope, pooled basis), passesUnderPressure, recoveries, interceptions, pressEvents, pressWins, turnovers, duels, fouls, yellowCards, redCards, positiveEvents, negativeEvents (interpretive — M-L2-G3 note carried verbatim), transitions { positive, negative, total }, events (total attributed), byLabel (full distribution — **custom tags listed verbatim, no football interpretation**), unattributedToPlayer: excluded count`

Notes: `transitions` = Positive/Negative Transition label counts (the two never summed with other constructs; the `total` is the sum of the two transition labels only). Every field's source is `A.players.list[i].metrics` / `.byLabel` — **PSD does not recount; it copies and restructures** (invariant PSD-T3). `byLabel` keys use the engine's ordered label ordering.

### 3.4 PSD-PM-4 — Minutes block **[NC-13 AMENDMENT — REQUIRES REVIEWER APPROVAL]**

> **Metric-spec NC-13 (current, binding):** player minutes / per-90 NOT computable — "a derived estimate would look exact while being wrong — rejected per P10." **This section proposes the honest alternative:** ship the estimate only when its ingredients are present, label every figure "estimated", carry machine-readable quality codes, and keep per-90 excluded. If the reviewer rejects the amendment, this block returns `{ value: null, reason: 'NC_13_NOT_AMENDED' }` and everything else in the spec stands.

```json
{
  "minutes": {
    "value": 82.5,                  // minutes, 1-decimal DISPLAY; internal is secondsExact
    "secondsExact": 4950,           // FULL UNROUNDED sum of on-pitch intervals
    "onPitchIntervals": [
      { "fromSeconds": 0,   "toSeconds": 4020, "startMarker": "KICK_OFF_1H", "endMarker": "SUB_OFF" },
      { "fromSeconds": 4020,"toSeconds": 4950, "startMarker": "SUB_ON",      "endMarker": "FT" }
    ],
    "quality": "ESTIMATED_FULL",    // ESTIMATED_FULL | ESTIMATED_PARTIAL | UNKNOWN
    "reasonCodes": [],              // see table below; empty ⇒ ESTIMATED_FULL
    "basis": "Participation intervals from starting XI, Sub events, player-attributed red cards, and the persisted full-time marker (matchClock). Stoppage time is included only as far as the match clock ran past the period boundary before the half was ended. Not an official minutes-played statistic."
  }
}
```

**Interval construction (deterministic):**

1. `startMarkers`: `KICK_OFF_1H` (seconds 0) for starters; each Sub-on event for the player.
2. `endMarkers`: each Sub-off event; a player-attributed Card-Red; else the match end.
3. **Match end resolution:** `matchClock.period === 'FT'` → `endSeconds = matchClock.clockBaseSeconds` (`FT` marker); otherwise `endSeconds = max(last in-play event matchSeconds, clockBaseSeconds)` with reason `END_FALLBACK_LAST_KNOWN` (an observed lower bound — partial quality).
4. Matching: pair each start with the **earliest end marker after it**; an unmatched start runs to the match end; overlapping intervals (double sub-on, data noise) are flagged `MULTIPLE_SUB_ON` and **not silently merged** — the longest span is used and the conflict is reported.
5. `UNKNOWN` quality: no starting XI evidence and no sub-on for a player with events (`participationUnknownReason` set).

**Reason codes (all machine-readable, all rendered by the future UI):**

| code | trigger |
|---|---|
| `NO_FT_MARKER` | matchClock period ≠ FT at save time |
| `END_FALLBACK_LAST_KNOWN` | end resolved from last event / clock base, not FT |
| `STARTING_XI_INCOMPLETE` | XI missing or partially filled (empty slots) |
| `SUB_TIME_MISSING` | Sub event with playerOff/playerOn set but non-numeric matchSeconds (validation-excluded) |
| `OPPONENT_SUB_REFERENCES_PLAYER` | a Sub event with team 'opponent' references this player (attribution noise) |
| `MULTIPLE_SUB_ON` | ≥2 Sub-on events for the player |
| `SEND_OFF_UNTAGGED_RISK` | match has a red-card-for-us goal-state discontinuity without an attributed Card-Red (advisory only, from engine X-gates where derivable; otherwise omitted) |

Quality mapping: `ESTIMATED_FULL` = no reason codes; `ESTIMATED_PARTIAL` = any of NO_FT_MARKER / END_FALLBACK_LAST_KNOWN / MULTIPLE_SUB_ON; `UNKNOWN` = XI-less player or `SUB_TIME_MISSING` on all markers. **Minutes never feed a denominator (no per-90, PSD-H6); they are a descriptive participation figure only.**

### 3.5 PSD-PM-5 — Located / unlocated block

`locatedEvents, unlocatedEvents, locatedShare (pooled envelope from the player's own events), outOfRange` — derived from `A.spatial` located/unlocated records filtered by `playerId` (Sub records carry `playerId: null` by SP-A6 — they never enter player spatial records; involvement remains in the participation block). Unlocated events are **counted and reported, never discarded** (inherited SP principle).

### 3.6 PSD-PM-6 — Spatial distribution block

`zones: { 9 zoneKeys + 'Unlocated', each an integer count of the player's located events }`, `thirds: { DEFENSIVE, MIDDLE, ATTACKING + Unlocated }`, `channels: { LEFT, CENTRAL, RIGHT + Unlocated }` — **identical to `A.spatial.playerGrids` for that player** (same 19 L3_KEYS buckets, same T2 orientation, same clamped binning). PSD copies, does not recompute (invariant PSD-T3). Located share accompanies; no smoothing/KDE/interpolation — the whole spatial-honesty constraint set of `PitchLog-SPATIAL-SPEC-v1.0` §2/§9 applies verbatim to every season spatial artifact.

### 3.7 PSD-PM-7 — Context partitions block (NEW computation — the only record-level pass PSD owns)

Per player, over that session's validated records (same canonical order, same predicates semantics as the engine):

```json
{
  "byPeriod":  { "1H": 4, "2H": 7, "ET1": 0, "ET2": 0, "Non-play": 0, "Unknown": 0 },   // attributed event counts; PERIOD_ORDER
  "byScoreState": { "WINNING": 3, "DRAW": 6, "LOSING": 2 } | null,                        // null + reason when the match's X1 = MISMATCH (inherited suppression)
  "byScoreStateReason": "X1_MISMATCH_SUPPRESSED" | null,
  "scoreStateBasis": "state BEFORE the event, from scoreForBefore/scoreAgainstBefore (engine protocol)"
}
```

Rules: `byPeriod` uses the engine's `periodBucket` semantics (1H/2H/ET1/ET2/Non-play/Unknown) — **not** raw `period` strings; "1H events / 2H events" from the reviewer's list map here (ET matches get ET1/ET2 columns, open question §12.7). `byScoreState` follows the engine's `stateBefore` (WINNING/DRAW/LOSING of the score *before* the event) and inherits the X1 suppression rule exactly. These partitions are **counts of attributed events only**; the unattributed bucket is reported at match level, not per player.

### 3.8 What is intentionally NOT in the player match record

- **Player possession involvement** — possession intervals are team-attributed (M-B10..13); interval events may carry a tag-time `playerId`, but no sanctioned player-possession metric exists; PSD does not invent one (open question §12.8 records the option).
- **Phase, Category, Outcome columns** (F7 — not metric inputs).
- **Per-90 anything** (PSD-H6).
- **Opponent-player data** — events carry our squad ids only; there is no opponent squad model (a "duels vs opponent #6" view is impossible without a model change — out of scope).
- **Quality judgments** — no rating, no score, no index (P7).

---

## 4. The TEAM MATCH RECORD (PSD-TM)

One record per match. Sources: `matchInfo`, `A.matchSummary`, `A.level1/2/3`, `A.spatial`, engine gates — copied/derived, never recomputed.

```json
{
  "matchKey": { … §3.1 … },
  "result": {
    "outcome": "W" | "D" | "L" | null,
    "scoreFor": 2, "scoreAgainst": 1,
    "source": "MANUAL" | "CHAIN",           // manual when both ourScore/opponentScore non-empty; else chain
    "x1Status": "MATCH" | "MISMATCH" | "MANUAL-EMPTY"   // propagated verbatim; MISMATCH ⇒ result carries a visible flag (PSD-X7), never silently dropped
  },
  "context": { "opponent": "…", "competition": "…", "date": "…", "homeAway": "…", "venue": "…", "formation": "…",
               "startingXISlots": 11, "startingXIFilled": 10 },        // PSD-X2 input
  "durationMinutes": 90 | 120,               // engine matchSummary (anyET rule)
  "ftMarkerPresent": true,                    // minutes-model input (§3.4)
  "tagged": {                                 // all envelopes, all from engine outputs
    "goalsFor/Against (chain)", "shotsFor/Against", "chancesFor/Against", "pressesFor/Against",
    "pressWinsFor/Against", "turnoversFor/Against", "passesFor/Against", "passSuccessFor (pooled envelope)",
    "foulsFor/Against", "cardsFor/Against", "eventTotals { our, opponent, unattributed }",
    "possession": { "ourSecondsExact", "opponentSecondsExact", "shareEnvelope (M-L2-B4 basis, NC-1 string, verbatim)" }
  },
  "spatial": { "located { our, opponent, unattributed, all }", "locatedShare envelopes", "zone/third/channel grids: REFERENCE to A.spatial grids — copied, not recomputed" },
  "state": { "byScoreState (level3, X1-gated)", "periodsPlayed" },
  "appearanceCounts": { "starters", "subOns", "unusedSubs (only when XI complete)", "unknown" }
}
```

Team record rules: result W/D/L only when a score source exists (`null` + reason otherwise); MISMATCH matches **count** in season results with a permanent flag (never excluded silently — exclusion is open question §12.9's default is *include with flag*). Tagged-possession figures inherit the full M-L2-B4 presentation constraint (unrounded seconds internally, NC-1 basis, never "Possession %").

---

## 5. Season aggregation layer (PSD-S)

### 5.1 PSD-S0 — Season universe, match ordering & identity

- **Input:** `sessions[]` = the loaded, migrated session objects (each with `sourceFile`, `__savedAt`, `matchInfo`, `events`, `squad`, `matchClock`, `tags`), in load order.
- **Deterministic match order:** sort by `(date asc [ISO string; empty dates LAST], savedAt asc, sourceFile asc, loadIndex asc)`. All four tie-breaks specified; sort is total, stable, and independent of `Date.now()`.
- **Match key:** the tuple `{sourceFile, savedAt, label, loadIndex}` (§3.1). `sourceFile` is the primary disambiguator; `loadIndex` is the final tie-break per metric-spec §12.4. **The key is external to the event model** — no `matchId` field is added to events (PSD-H11).
- **Duplicate audit (PSD-X1):** same `sourceFile` twice; same `savedAt`; same `date+opponent` label (the CSV-collision case) → each flagged; duplicates are **reported, not merged** (the season view already dedupes by sourceFile at load — PSD keeps that behavior and audits whatever else slips through).

### 5.2 PSD-S1 — Season totals (per player)

Sum every count metric of PSD-PM-3/5/6/7 across the player's match records; pool ratio envelopes from summed num/den (passSuccess, locatedShare); sum `secondsExact` minutes with **worst-of quality rollup** (any partial/unknown match downgrades the season minutes quality and collects that match's reason codes). `appearances, starts, subOns, subOffs, sendOffs` are sums of the exact participation facts. Output block `PS.players[pid].totals`.

### 5.3 PSD-S2 — Season averages

Two (and only two) average families — both simple arithmetic means of **counts / exact durations**, both labelled with their denominator:

- `perAppearance` = total ÷ appearances (null when appearances = 0);
- `perMatchInRecord` = total ÷ matches-in-record (the matches where the player has a record; labelled as such — NOT "per match played", which would imply minutes knowledge).

**Ratios are never averaged** (PSD-H5; regression-tested with a mean-of-ratios wrong-answer fixture, PSD-T6).

### 5.4 PSD-S3 — Recent form (last N)

- `form` = the player's **last N match records in season order** (default `N = 5`, a `params` field, not a hardcode) — the per-match series of core counts (goals, shots, chances, keyPasses, passEvents, recoveries, interceptions, pressEvents, pressWins, turnovers, duels, transitions, events) plus totals over the window and the window's pooled ratios.
- Basis: season order (§5.1); players with <N matches use all of them, with `matchesInWindow` printed.
- Canonical label: **"Recent tagged event counts — last N matches"** (PSD-N). No form index, no form score, no "hot/cold" language.

### 5.5 PSD-S4 — Trend analysis (deterministic, descriptive)

Per metric, per player:

1. **The series itself** — per-match values in season order (the primary artifact; the analyst reads the numbers).
2. **Rolling mean (window 3, counts only)** — simple arithmetic means over the count series; printed alongside, labelled "3-match rolling mean (tagged counts)".
3. **Direction summary** — a deterministic comparison of first-third vs last-third arithmetic means of the count series: `higher` / `lower` / `similar` / `insufficient-data`. Exact rule: needs ≥3 matches; `similar` when |lastMean − firstMean| < max(1, 0.1 × firstMean); else `higher`/`lower` by sign. Rendered as e.g. "Shot events: 4.0 → 6.7 per match (last third higher)".

**Explicit constraints:** descriptive only — no regression/slope/correlation/statistical test/significance/prediction/extrapolation (all on the DEFER list, §10); no label may claim a player is "improving/declining" (forbidden names PSD-N); the direction rule is a fixed arithmetic comparison, not an inference.

### 5.6 PSD-S5 — Team outcomes with / without player (observational)

For each player: split the season's matches into `with` (appearance = true) and `without` (appearance = false); for each side report matches, W/D/L counts, goals for/against (score-source basis §4), and tagged event totals (our team only). Sample sizes are **always printed**. Standing note (exact string, PSD-N): *"Observational split by tagged participation only — small samples, no causal claim; the team record with/without a player is not a player-value measurement."* Minimum-display gate: both sides ≥1 match (values exist whenever data does); any interpretive comparison text requires ≥3 matches per side (open question §12.4).

### 5.7 PSD-S6 — Spatial tendencies (cross-match)

Sum the player's 9-cell zone counts (+ Unlocated) and thirds/channels across match records; pool the located share; emit the per-match located-count series. Same 3×3 model, same T2 orientation, same discrete-count semantics; the future rendering **reuses the existing deterministic density presentation and its minimum-sample gate (6 located events, same approved message)** — no new spatial methodology is invented (SP spec §5 applies verbatim; season-level grid = sum of per-match grids, invariant PSD-T3).

### 5.8 PSD-S7 — Consistency (per-match series + range)

Per metric: the per-match series, `min / max / range` (counts only), and matches-in-record. **No consistency index, no coefficient of variation, no composite** (P7). Canonical label: "Per-match tagged counts (spread shown as min–max)".

### 5.9 PSD-S8 — Team season record

Match-by-match results series (season order, with X1 flags), W/D/L totals, goals for/against sums, per-opponent splits (opponent string, deterministic sort), home/away/neutral splits, tagged event sums by team (envelopes), pooled tagged-possession share (Σ exact seconds both sides → recomputed share, NC-1 basis verbatim), appearance counts. Standing note: results are the analyst-entered/derived score, not an official league table; no table position/points/extrapolation.

### 5.10 What is NOT season-aggregated (explicit)

- **Sequences** (per-match SEQ-NNN namespaces — cross-match sequence ids are meaningless);
- **Minute bins** (match-relative; stay per-match);
- **Phase** (F7 — doesn't exist);
- **Opponent-player anything**;
- **Per-90 rates** (PSD-H6);
- Any merged single event stream: **all season figures derive from per-match records/envelopes** (PSD-H1) — no cross-session event concatenation is fed to any metric.

---

## 6. The DATA CONTRACT (PSD-C) — `PS` season object

`computeSeason(sessions, options) → PS` (pure; `options = { formWindowN = 5, trendWindow = 3, minSampleForDensity = 6 (echo) }`). Key order is normative (tested, PSD-T1).

```json
{
  "spec": "PitchLog-PLAYER-SEASON-SPEC-v1.0",
  "engine": { "version": "…", "deterministic": true },
  "input": { "sessionCount": 3, "sessions": [ { "loadIndex": 1, "sourceFile": "…", "savedAt": "…", "label": "…", "eventCount": 214, "x1Status": "MATCH" } ] },
  "matches": [                                 // season order; each = { matchKey, teamRecord (PSD-TM §4),
                                               //   players: [ PSD-PM records §3 ] , ordered by (events desc, playerId asc) }
  ],
  "players": {                                 // keyed by playerId; deterministic order: appearances desc, events desc, playerId asc
    "player_ab12cd34": {
      "identity": { "playerId": "…", "nameVariants": [ { "name": "…", "number": "9", "matchKeys": [ … ] } ],  // per-session snapshot variants (PSD-X4 basis)
                    "canonicalName": "most recent non-'Unknown player' variant" },
      "participation": { "appearances": 8, "starts": 5, "subOns": 3, "subOffs": 4, "sendOffs": 0 },
      "minutes": { "secondsExactTotal": …, "valueTotal": …, "quality": "worst-of", "reasonCodes": [ … ] },
      "totals": { … PSD-S1 … }, "averages": { … PSD-S2 … },
      "form": { "windowN": 5, "matchKeys": [ … ], "series": { … }, "windowTotals": { … } },
      "trends": { … PSD-S4 per metric … },
      "spatial": { … PSD-S6 … }, "consistency": { … PSD-S7 … },
      "withWithout": { … PSD-S5 … },
      "matchRecordKeys": [ … ]                  // join back to PS.matches[].players[]
    }
  },
  "teamSeason": { … PSD-S8 … },
  "identityAudit": { "drift": [ … ], "possibleDuplicates": [ … ] },   // PSD-X4/X5
  "gates": { … PSD-X §7 … },
  "protocol": { "notes": [ …exact strings… ], "params": { formWindowN, trendWindow }, "canonicalNames": [ … ] }
}
```

**Contract invariants (all testable, all mandatory):**

1. `PS.matches.length === PS.input.sessionCount` (post-dedupe audit reconciles with the loader's own dedupe).
2. For every count metric: `Σ PS.matches[].players[].metric === PS.players[pid].totals.metric` (exact integer equality).
3. Every pooled ratio equals the ratio of summed envelopes' num/den (bit-reproducible recomputation).
4. `PS.players[pid].matchRecordKeys.length` = number of matches with a record for that player; every key resolves.
5. For every player×match: PSD-PM counts equal `A.players` metrics for that session (engine-consumption invariant).
6. For every player×match with a spatial grid: PSD-PM zones equal `A.spatial.playerGrids` (same 19 keys).
7. Season spatial grid = element-wise sum of the player's per-match grids.
8. `withWithout.with.matches + withWithout.without.matches === teamSeason.matches` (excluding UNKNOWN-participation matches from both sides, reported separately).
9. Determinism: two calls on deep-cloned inputs produce byte-identical JSON (key order included).
10. Purity: input sessions deep-equal before/after (no mutation, no shared references into outputs).

---

## 7. Gates & data-quality audits (PSD-X) — displayed, never silently resolved

| id | trigger | effect |
|---|---|---|
| **PSD-X1** | duplicate match identity (same sourceFile / savedAt / date+opponent label) | flag on both matches; no merge; season counts include both with the flag visible |
| **PSD-X2** | starting XI missing or incomplete (empty slots) per match | participation UNKNOWN downgrades; unused-sub enumeration suppressed for that match; slot count printed |
| **PSD-X3** | FT marker absent per match | minutes reason `NO_FT_MARKER`/`END_FALLBACK_LAST_KNOWN`; season minutes quality rollup |
| **PSD-X4** | identity drift: same playerId, different name/number across sessions | per-player `nameVariants` + drift list; canonicalName rule stated; **never auto-renamed** |
| **PSD-X5** | possible duplicate persons: same name (± number), different playerIds across sessions (or within a session's squad) | audit list; **never auto-merged** |
| **PSD-X6** | sub-team attribution noise: Sub event with team 'opponent' referencing our player; multiple sub-ons; sub markers with invalid time | counted per match; minutes reason codes; never silently dropped |
| **PSD-X7** | per-match X1 = MISMATCH | result flagged in match history & W/D/L aggregates; that match's `byScoreState` partitions nulled with reason (engine suppression inherited) |
| **PSD-X8** | empty metadata (no date / no opponent) | ordering fallback engaged; label shows placeholders; counted |
| **PSD-X9** | session squad snapshot vs live squad mismatch | informational note (historical names win per PSD-H3) |

All gates are advisory-audit style (like SP-X): they gate *presentation quality* (nulled values with reasons), never *exclude data silently*, and are always rendered in the future UI.

---

## 8. Presentation & export layer (PSD-V) — specification for the FUTURE implementation; **nothing is built now**

### 8.1 PSD-V1 — Season view structure (extends the existing modal)

Match history table (season order: date, opponent, H/A, result + X1 flag, tagged event totals, appearance counts) → player selector (deterministic order, canonicalName + variants) → per-player: totals table, averages table, **Recent tagged event counts — last N matches** strip, trend tables (series + rolling mean + direction line), spatial tendencies grid, consistency table, with/without observational block, minutes block with quality codes. Every table has a numeric-twin rule (numbers before any color; the spatial grid reuses the existing deterministic 4-step density presentation, minimum-sample 6, exact approved insufficient message). Read-only.

### 8.2 PSD-V2 — Season player CSV export (new; legacy event-dump CSV untouched, open question §12.3)

One row per player×match + season-summary rows per player. Columns (exact, ordered): `match_key, date, opponent, competition, home_away, result, x1_status, player_id, player_name, player_number, participation_status, started, subbed_on, subbed_on_min, subbed_off, subbed_off_min, sent_off, minutes_est, minutes_quality, minutes_reasons, goals, shots, shots_on_target, chances, key_passes, crosses, passes, pass_success_pct, presses, press_wins, interceptions, recoveries, turnovers, duels, fouls, yellow_cards, red_cards, transitions_positive, transitions_negative, positive_events, negative_events, events_total, located_events, unlocated_events, located_share_pct, events_1h, events_2h, events_et1, events_et2, state_winning, state_drawing, state_losing, state_suppressed, zone_dl, zone_dc, zone_dr, zone_ml, zone_mc, zone_mr, zone_al, zone_ac, zone_ar, zone_unlocated`. BOM/CRLF conventions and `csvEscape` reuse the existing exporters verbatim. **`team`-era semantics** (the legacy export's `side` column is not replicated).

### 8.3 PSD-V3 — Integration points

Analytics-tab unchanged; season engine consumed by the season modal only; engine module loaded as a plain script (same UMD pattern as analytics.js, `window.PlayerSeasonEngine` / `module.exports`); **no new dependencies**; no server, no network.

### 8.4 PSD-N — Naming constraints (binding on the future implementation)

**Canonical (required) names:** "Player Match Record (tagged events)" · "Tagged Season Totals" · "Tagged Season Averages (per appearance / per match in record)" · "Recent tagged event counts — last N matches" · "3-match rolling mean (tagged counts)" · "Estimated Minutes (gated)" · "Team Results With/Without Player (observational)" · "Tagged Possession Share — season (recorded interval tags only, NC-1 basis)" · "Per-match tagged counts (spread shown as min–max)".

**Forbidden (never rendered, in any view, tooltip, legend, CSV header, or export):** "per 90", "P90", "p90", "minutes played" (without the Estimated qualifier), "Possession %", "form index", "form score", "hot streak", "cold streak", "player rating", "performance score", "impact", "consistency index", "improving", "declining", "season xG" or any x-anything, "career", "scouting report", "AI analysis", "prediction", "trend significance".

**Standing limitation strings (exact texts, rendered with the views):**

1. *"All season figures are sums and recomputed ratios of TAGGED match events only — they measure what was tagged, not what happened. Tagging coverage differs between matches; nothing is extrapolated."*
2. *"Minutes are gated estimates from the starting XI, Substitution events, attributed red cards, and the recorded full-time marker. They are not official minutes played and are never used as a rate denominator."*
3. *"The with/without-player split is observational by tagged participation — small samples, no causal claim; it is not a player-value measurement."*
4. *"Trend lines are fixed arithmetic comparisons of tagged counts (first third vs last third of the matches in record). They are descriptive, not statistical, and predict nothing."*

### 8.5 PSD-V4 — Precision rules (inherited verbatim)

Counts integer; durations 1 decimal (display only — internal secondsExact unrounded, the M-L2-B4/§12.3 discipline); percentages 1 decimal half-up; no floating-point equality tests; full precision in the contract, rounding only at render.

---

## 9. Testing strategy (PSD-T) — for the future implementation phase

All Node + jsdom, pure-function style, mirroring the existing suites (no GUI). Target: a new `tests/player-season-tests.js` + `tests/player-season-ui-check.js`; **the existing 904 checks must stay green (regression is release-blocking)**.

- **PSD-T1** determinism/purity/idempotence: deep-clone inputs, byte-identical output, no input mutation, stable key order, `Date.now` never called (shimmed to throw).
- **PSD-T2** ordering oracle: empty dates, tied savedAt, tied labels → exact order per §5.1 tie-break chain.
- **PSD-T3** engine-consumption invariants: PSD-PM counts == `A.players` metrics; zones == `A.spatial.playerGrids`; season grid == Σ per-match grids; appearance flag equality (contract invariants 5–7).
- **PSD-T4** hand-computed oracle: 3 synthetic sessions — starter subbed off; sub-on later subbed off; red card; ET match (120′); a no-XI session (UNKNOWN participation); missing FT marker; opponent-sub noise; hand-checked records for every block.
- **PSD-T5** minutes edge cases: endHalf snap, mid-match save, stoppage sub, double sub-on conflict, red-card end, XI-less player, all reason codes + quality mapping.
- **PSD-T6** pooling-vs-averaging regression: a fixture where mean-of-ratios ≠ pooled ratio (e.g. 2/2 and 8/8 → pooled 69.2%≠ mean 90.7%… hand-computed exact figures) asserting the pooled value.
- **PSD-T7** X1 propagation: MISMATCH match → result flag + state partitions null with reason; MANUAL-EMPTY → CHAIN source.
- **PSD-T8** identity audits: drift, possible duplicates, unknown-player fallback, canonicalName rule.
- **PSD-T9** form/trend: window N (5 default, smaller rosters), direction-rule boundaries (the `similar` threshold both sides), rolling-mean arithmetic, <3 matches → `insufficient-data`.
- **PSD-T10** with/without: split arithmetic; UNKNOWN-participation matches excluded from both sides and reported; sample sizes printed.
- **PSD-T11** CSV contract: exact column list/order, escaping, team-era semantics, estimated-minutes columns carry quality codes.
- **PSD-T12** UI naming greps (jsdom): forbidden-name list absent from all rendered season HTML; canonical names + standing limitation strings present; numbers-before-color; minimum-sample message reuse.

---

## 10. Prohibitions (binding on the implementation phase)

1. **No event-model, taxonomy, 3×3, team/player/time/sequence/score-state model changes.** No `matchId` on events — the match key is external (PSD-S0).
2. **No new on-disk store in V1** (no registry, no cache, no database files; derive-on-load only — PSD-H2; persistence open question §12.2).
3. **No AI, no ML, no statistical inference, no regression/slope/correlation, no significance, no prediction, no extrapolation.**
4. **No per-90 rates** (even if the minutes amendment is approved — per-90 stays out of V1 deliverables; open question §12.1 records it as a possible V2 with a permanent "estimated denominator" label).
5. **No composite indices** (no ratings, form scores, consistency indices, impact measures — P7).
6. **No opponent-player modeling; no merging of identities; no auto-renaming.**
7. **No new dependencies; no network; no server.**
8. **No merged cross-session event stream fed to any metric** — season figures derive from per-match engine outputs and per-match PSD records only (PSD-H1).
9. **No recomputation of engine metrics** — consumption with tested equality (PSD-T3), never a parallel implementation.
10. **This task itself: zero source changes** — verified in §11.

---

## 11. Acceptance criteria (for the implementation phase, after approval)

1. `computeSeason` exists as a pure UMD module with the §6 contract; all 10 contract invariants hold on the test fixtures.
2. PSD-T1..T12 green; the pre-existing 904 checks green; zero regressions in analytics/spatial outputs (byte-equality of `A` before/after the phase on a fixed session fixture).
3. All §8.4 naming constraints enforced and grep-tested; all standing limitation strings render.
4. The NC-13 amendment (if approved) renders every minutes figure with its quality code; if rejected, the minutes block is `{null, NC_13_NOT_AMENDED}` everywhere.
5. Event model, taxonomy, 3×3 model, dependencies: unchanged (git diff of the implementation checkpoint proves it).
6. Worklog + checkpoint per project convention.

**This task's own acceptance (already met):** source byte-identical to `8b8ce76`; only this document (+ worklog entry) produced.

---

## 12. Open questions for the reviewer

1. **NC-13 MINUTES AMENDMENT (§3.4) — the core decision.** Approve gated estimated minutes (with quality codes, never a denominator), or keep NC-13 unamended (minutes = null + reason)? Default if unreviewed: **implement the gated estimate as specified** — the reviewer's Part 2 field list explicitly includes "Minutes", and §3.4 confines it to a labelled, gated, non-denominator figure; but this flag stays open because it contradicts metric-spec NC-13 as written.
2. **Season registry persistence:** V1 is derive-on-load (stateless). Should a `userData/season.json` registry (remembering loaded match files across restarts) be proposed for V2?
3. **Season CSV:** add the new player×match export alongside the legacy event-dump (default), or replace the legacy one (its `side` column is legacy semantics)?
4. **With/without-player interpretive threshold:** ≥3 matches per side before any comparison sentence (default), or numbers-only always?
5. **Trend "similar" threshold:** |Δ| < max(1, 10% of first mean) (default) — confirm or adjust.
6. **Form window N:** default 5 — confirm.
7. **ET handling in the period partition:** separate ET1/ET2 columns (default, matching the engine) vs folding into "2H Events" as the reviewer's field list literally says.
8. **Player possession involvement:** interval events can carry a tag-time playerId, but no sanctioned player-possession metric exists. Record as a future tagging-protocol proposal (like metric-spec §14.5), or leave out entirely? (Default: leave out.)
9. **X1-MISMATCH matches in W/D/L aggregates:** include with flag (default) vs exclude with counts shown separately.
10. **Message-truncation note:** the reviewer's Part 2 field list ended at "2H Events". Any intended fields beyond this spec's §3 coverage (e.g. per-player shot-map per match, duel-partner detail, per-player sequence involvement) should be added by amendment; nothing beyond the verified data model has been assumed.

---

## Appendix A — Normative JSON example (abridged)

```json
{
  "spec": "PitchLog-PLAYER-SEASON-SPEC-v1.0",
  "input": { "sessionCount": 2, "sessions": [
    { "loadIndex": 1, "sourceFile": "/m1.json", "savedAt": "2026-08-16T20:00:00Z", "label": "2026-08-15_vs Riverside FC", "eventCount": 214, "x1Status": "MATCH" },
    { "loadIndex": 2, "sourceFile": "/m2.json", "savedAt": "2026-08-23T20:00:00Z", "label": "2026-08-22_vs Northport", "eventCount": 187, "x1Status": "MANUAL-EMPTY" } ] },
  "matches": [ { "matchKey": { "sourceFile": "/m1.json", "savedAt": "2026-08-16T20:00:00Z", "label": "2026-08-15_vs Riverside FC", "loadIndex": 1 },
      "teamRecord": { "result": { "outcome": "W", "scoreFor": 2, "scoreAgainst": 1, "source": "MANUAL", "x1Status": "MATCH" },
        "ftMarkerPresent": true, "durationMinutes": 90, "context": { "startingXISlots": 11, "startingXIFilled": 11 } },
      "players": [ { "playerId": "p1", "participation": { "started": true, "subbedOn": false, "subbedOff": true, "subbedOffSeconds": 4020,
            "sentOff": false, "appearance": true, "participationStatus": "STARTED_SUBBED_OFF" },
          "minutes": { "value": 67.0, "secondsExact": 4020, "quality": "ESTIMATED_FULL", "reasonCodes": [],
            "onPitchIntervals": [ { "fromSeconds": 0, "toSeconds": 4020, "startMarker": "KICK_OFF_1H", "endMarker": "SUB_OFF" } ] },
          "counts": { "goals": { "value": 1 }, "shots": { "value": 3 }, "shotsOnTarget": { "value": 2 }, "presses": { "value": 9 } },
          "located": { "locatedEvents": 11, "unlocatedEvents": 4, "locatedShare": { "value": 73.3, "num": 11, "den": 15 } },
          "byPeriod": { "1H": 6, "2H": 9, "ET1": 0, "ET2": 0, "Non-play": 0, "Unknown": 0 },
          "byScoreState": { "WINNING": 4, "DRAW": 8, "LOSING": 3 } } ] } ],
  "players": { "p1": { "canonicalName": "A. Kebede", "participation": { "appearances": 2, "starts": 2, "subOns": 0, "subOffs": 1, "sendOffs": 0 },
      "minutes": { "secondsExactTotal": 9420, "valueTotal": 157.0, "quality": "ESTIMATED_PARTIAL", "reasonCodes": ["NO_FT_MARKER"] },
      "totals": { "goals": 2, "shots": 6 }, "averages": { "perAppearance": { "goals": 1.0 } },
      "form": { "windowN": 5, "matchKeys": [ "…m1", "…m2" ], "series": { "goals": [1, 1] } } } },
  "gates": { "PSD_X3": [ { "matchKey": "…m2", "reason": "NO_FT_MARKER" } ] }
}
```

— END OF SPECIFICATION —
