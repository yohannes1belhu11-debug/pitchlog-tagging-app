# PitchLog — Match Analysis Dashboard Specification (V2)

**Status:** AUTHORITATIVE — V2.0. This document is the single build recipe for
Stage 4A (Match Analysis Dashboard) of the tagging app. It consolidates the
surviving architecture audit (worklog `STAGE4A-ARCHAUDIT-1`), the engine and
renderer contracts verified at this HEAD, and the corrective round that defined
the lost implementation's final state.

V1.1 amendment (review round): §13 dashboard section inventory added;
§1/§5/§6/§10 clarified.

V2.0 amendment: Stage 4B interactive filtering specified (§14); stage
boundary, §5, §6, §12, §13.3, §13.6, §10 updated. Covers Stage 4A
(implemented, closed) and Stage 4B (specified, pending implementation).

**Authority rule:** where any historical worklog note, review remark, or earlier
plan conflicts with this document, **this document wins**. Two known
supersessions are called out inline (§5 key-event seeking; §4 the ten-card set)
so future readers are not misled by the older notes.

**Baseline:** `main` @ `2c0748d6b3e597400f81ec9158ece0818d66b34e`. All line
numbers cited below were verified against this exact tree.

**Companion documents (normative where referenced):** `metric-specification.md`
(metric envelopes, P5 null-vs-zero, §12 determinism) and
`spatial-heatmap-specification.md` (SP-V rendering rules, §5.3 color scale,
§5.4 minimum-sample gate, §9 prohibitions).

---

## 1. Purpose & stage boundary

Stage 4A delivers the **Match Analysis Dashboard**: a dedicated, full-view,
**read-only analytical projection of the tagged match data** of the one
currently loaded session. It is the bridge from tagging to analysis — the
moment an analyst finishes (or pauses) tagging and wants to see the match as a
set of numbers and pitch pictures instead of a list of tags.

The dashboard is a **pure consumer** of the existing analytics engine. It
defines no metrics of its own. Every aggregate it renders comes from
`computeMatchAnalytics(session)` output; the only direct reads it makes of the
session are the raw event records behind the chronological key-event list
(§5), which is the app's own sanctioned event-list pathway.

**No schema change.** Stage 4A adds no fields, no tags, no qualifiers, no
event-taxonomy changes, no migration, no storage changes of any kind.

**Explicitly out of scope:**

- **Interactive filtering (Stage 4B) — IN SCOPE as of V2.0: view filtering
  only, per §14. Recomputation of aggregate metrics over filtered slices is
  NOT in scope (candidate for a later stage; requires engine work).**
- **Stage 4C coach export** — nothing in Stage 4A exports, prints, or formats
  for delivery.
- Tactical sequence DIAGRAMS and NARRATIVES (Stage 5) — out of scope.
  Rendering the engine's existing sequences data (A.sequences) as the
  dashboard's sequences section IS in scope (§13.8).
- **Season-wide analytics** — one session at a time; no multi-match aggregation
  (this inherits spatial spec SP-H10).
- **AI** — no models, no predictions, no generated text.
- **Computer vision** — nothing reads the video pixels; the video is only ever
  seeked (§5).
- **New tagging schema** — §1 "no schema change" restated as a prohibition: if
  a dashboard need appears to require a schema change, that is a stop condition
  for Stage 4A, not an extension of it.

---

## 2. Architecture

One new module: **`src/match-analysis.js`**, a UMD module in the same style as
the app's other engine/report modules (`analytics.js`, `player-season.js`).

**Pure projection.** The module's exported entry point
(`renderAnalysis`) takes the host-injected context and returns/attaches
dashboard markup. It is a pure projection of `computeMatchAnalytics(session)`
output: given the same engine output and host, it produces the same markup. It
contains **no metric definitions** — adding a metric to the dashboard is a
spec change against `metric-specification.md` first, never a local formula.

**Host-API injection.** The renderer supplies everything environmental; the
module hard-codes nothing about the host:

- the **session snapshot** (§8 purity: a snapshot, never the live arrays), and
- the **host methods**:
  - `seekTo(time)` — the app's video seek pathway (renderer.js:1395);
  - `resolvePlayer(playerId)` — display-name resolution (§7);
  - `pitchMarkingsSvg()` — the single source of pitch markings markup
    (renderer.js:2643);
  - zone-line markup (`ZONE_LINES_SVG`, renderer.js:3931);
  - density ramp accessors (`DENSITY_FILLS`, renderer.js:3903; `densityStep`,
    renderer.js:3912).

The module must never read `window.*` globals of the renderer, never duplicate
a renderer constant, and never reach into the DOM outside the container it is
given. There is **never a second renderer**: pitch markings, zone lines, and
the density ramp exist once, in renderer.js, and enter the dashboard through
the host API.

**Renderer owns the chrome.** `renderer.js` owns opening and closing the
dashboard modal. The modal reuses the app's existing conventions exactly — the
`seasonModal` pattern (index.html:525–532): a `modal-overlay` div hidden with
`display:none`, the standard modal header with a title and a **Done** button,
closing on Done and on Escape.

**No new IPC.** `main.js` and `preload.js` are untouched; the dashboard is a
renderer-side projection only.

**No new dependencies.** No libraries, no npm additions, no build changes
(inherits spatial spec §9.4).

---

## 3. Pitch & spatial

**Shared canvas.** All pitch views in the app share one geometry: the
**700×450 viewBox** with normalized coordinates mapped as `x*700`, `y*450`
(renderer.js:2577, 2665, 3976). The dashboard uses the same. Nothing
dashboard-specific is invented here.

**Shared visuals via the host.** Zone lines, pitch markings, and the density
ramp all come from renderer.js's existing constants **via the host API**
(§2) — never a second copy, never a restyle. `DENSITY_FILLS` is the crimson
ramp on the `#14301b` pitch defined by spatial spec §5.3; `densityStep` is its
exact step algorithm.

**Grid.** The 3×3 grid is the engine's own: **thirds on x** (`ti`), **channels
on y** (`ci`), row-major cell index **`cells[ti*3+ci]`** (analytics.js:1195,
1205, 1223, 1243, 1248). The dashboard renders that grid; it never re-bins,
re-orients, or renames it (spatial spec §9.1).

**Minimum-sample gate.** The threshold is read from
**`A.spatial.params.minSampleForDensity`** — the engine constant
`MIN_SAMPLE_FOR_DENSITY = 6` (analytics.js:1098, wired into
`A.spatial.params` at :1408, exported at :1944). The dashboard **never
hard-codes 6**; it reads the param. Below threshold, a grid renders the **null
state with reason** (the spatial spec §5.4 pattern: pitch outline + grid lines
+ the "Insufficient located events …" message), **no fills, no printed
counts** — and the **numeric table still renders** for every grid, because the
table is counts, not a density claim.

**Color scale.** Per-grid **relative** scale: each grid's ramp is relative to
that grid's own busiest cell (spatial spec §5.3). Comparability across grids
is via printed numbers, not colors.

**Prohibitions** (inherited from spatial spec §9.5/§9.6, binding here): **no
KDE, no blur, no gradients, no video**. No smoothing or interpolation of any
kind; no overlays on video frames; the dashboard's pitch views never embed or
control video.

---

## 4. Key-event summary cards

The summary strip renders **exactly 10 cards**, in this order:

1. Goals
2. Shots
3. Chances
4. Crosses
5. Corners
6. Fouls
7. Yellow cards
8. Red cards
9. **Substitutions**
10. **Positive transitions**

Labels are sentence-case, matching the app's existing Analytics-tab rows
exactly — renderer.js:4437 `['Substitutions', …]` and :4451
`['Positive transitions', …]` are the precedents.

**Source — L1 envelopes only.** Every card's two numbers are read **only**
from `A.level1.team.{our,opponent}` envelopes, through `countOf`-guarded
reads: `envelope && typeof envelope.value === 'number' ? envelope.value : 0`.
The guard is defensive only — it is never a data-quality fork. The engine
guarantees the shape: `countEnv` (analytics.js:118–120) emits
`{ value, excluded }` where `value` is a counter initialized to 0 and only
ever incremented (analytics.js:424, 429, 452, 476), so **count envelopes are
always numeric — never null**. The ten fields (verified at :492–:523):
`goals`, `shots`, `chances`, `crosses`, `corners`, `fouls`, `yellowCards`,
`redCards`, `substitutions`, `positiveTransitions`.

**No combined "Cards" card.** Yellow and red are separate cards (7 and 8).
This is deliberate: the engine itself partitions them by subtype
(`countEnv(m.yellowCards, cardSubtypeEx)` / `countEnv(m.redCards, …)`,
analytics.js:502–503).

**Zero case.** A genuine count of zero renders a plain `0` — never "n/a",
never a dash, never null. Metric spec P5 (null ≠ zero) reserves null for
zero-denominator *ratios*; counts are always numbers, and zero is a real
count. Card format is `our · opponent`, so a scoreless, cardless, subless
match shows e.g. `0 · 0` on those cards.

> **Supersession note.** The pre-correction implementation carried 8 cards
> (no Substitutions / Positive transitions). This section supersedes that:
> the correct set is the 10 above. `KEY_COUNT_FIELDS` in the implementation
> must name exactly these ten envelope fields.

---

## 5. Chronological key events

The chronological list is built **from the raw session event list** — the
sanctioned pathway (the app's own event domain, not an engine derivative).
It renders one row per qualifying key event, in match order.

**Qualifying labels.** `KEY_EVENT_LABELS` — the module's qualifying-label
constant — is exactly the nine engine labels 'Goal', 'Shot', 'Chance', 'Cross',
'Corner', 'Foul', 'Card', 'Sub', 'Positive Transition' (analytics.js:61–63,
436–476). 'Card' is one list label feeding BOTH card classes 7 and 8 (the
yellow/red split happens in the engine envelopes), so nine labels map to ten
cards.

**Display labels.** A display map expands the terse tag labels for humans:

```text
'Sub' → 'Substitution'
```

**`'Positive Transition'` renders verbatim** (no expansion, no abbreviation).

**Sorting.** Sort a **copy** — the source session array is never reordered
(§8 purity). Canonical order is the app's own: `(time asc, id asc)`.

**Row attributes.** Each row carries `data-videotime` / `data-time`
attributes (the event's `videoTime` / `time`), preserving the seek inputs as
rendered data.

**Activation seeks.** Activating a row seeks the video:
`host.seekTo(ev.videoTime ?? ev.time)` — the video-time-first fallback
convention used by the app's event list (renderer.js:1395 is the seek
pathway). This is the corrective round's final behavior and **supersedes** the
architecture-audit-era note that key-event rows would stay read-only with
seeking deferred to Stage 4B. (The spatial §9.6 prohibition on seeking from
*spatial views* is untouched — the chronological list is not a spatial view;
zone cells in §3 views still never seek.)

**Never a metric.** The list's length is **never displayed as a metric**
anywhere on the dashboard (no "17 key events" counter card or caption).

**Filtered-list exception (V2.0).** While at least one list filter is active,
the list's filter bar renders exactly one status line, phrased exactly
'Showing N of M', where M is the unfiltered qualifying-row count and N the
filtered count. It is a view-state indicator, never a metric: it is rendered
only while a list filter is active, styled as filter-bar UI text, never as a
card or standalone number, and never summarized elsewhere. With no list filter
active the line is absent. The empty state distinguishes two cases: (1) no
filters active and no qualifying events — the existing enumeration message;
(2) filters active and zero matches — exactly 'No key events match the current
filters.' plus the filter bar's reset affordance.

**Empty state.** When no qualifying events exist, the empty state
**enumerates the classes** — it names the qualifying event labels (the
`KEY_EVENT_LABELS` set, in display form) so the analyst sees what would have
been listed, rather than a bare "no data".

---

## 6. Single-execution contract

**Per open (engine budget):** `computeMatchAnalytics(session)` runs exactly
once per dashboard open. `computeSpatialView(A, filters)` runs once for the
initial render, plus once per spatial-filter change during that same open.
Key-list filtering performs ZERO engine calls — it is a pure DOM projection
of the already-built model. The renderer retains the model, host, and
container for the LIFETIME OF ONE OPEN only (per-open working state, not a
cache); on close (Done or Escape) the retained state is discarded; every
open recomputes from the current snapshot. No module-level state survives a
modal open, a modal close, or a session switch — unchanged.

Both are computed in `renderAnalysis` — the single orchestration point — and
the results are **shared into** every consumer: `buildModel` receives them via
its `precomputed` parameter:

```text
buildModel(session, host, precomputed?)
```

`buildModel`'s own engine calls (computing `A` and the spatial view itself
when `precomputed` is absent) exist **only as fallbacks for direct/test
callers**. In the wired production path the parameter is always supplied, so a
full dashboard render never triggers a second engine pass.

---

## 7. Identity & resolution

**`playerId` is preserved verbatim end-to-end.** The dashboard never rekeys,
relabels, merges, or string-matches identities. All player-keyed structures
(id → name, id → row, id → grid) are keyed by the id alone.

**Names come from the single resolver chain:**

```text
host.resolvePlayer(playerId)
  → renderer.js resolveMatchdayPlayer (:620)
    → window.Roster.resolveMatchPlayer (roster.js — the R3-A authority)
```

This is the app's one resolver (match-roster overlay, then squad, then
opponent roster for `match_opp_*` ids). The dashboard creates **no second
resolver** and no name-normalization layer.

**No name-merging.** Two different ids never share a row, a card, or a table
cell, even if their display names coincide. "Unknown player" display for
unresolvable ids follows whatever the resolver chain returns — the dashboard
does not guess.

---

## 8. Interaction & safety rules

**No `.click()` on SVG — anywhere.** (The D2 regression: SVG elements in the
app's target environments do not expose `.click()`.) Programmatic activation
of zone cells goes through a shared activation function that both the pointer
path and the keyboard path call directly. This is law for every SVG surface
the dashboard renders.

**Zone-cell keyboard access.** Zone cells are keyboard-activable via
**Enter/Space**, implemented with **event delegation** on the container. The
handler calls `preventDefault()` and **must NOT call `stopPropagation()`**.

**Space propagation is accepted.** Because there is no `stopPropagation()`, a
Space keydown on a zone cell also reaches the app's global play/pause handler.
This is **accepted and identical to the existing Analytics tab** — documented
in §12, not to be "fixed" locally.

**Purity.** The session snapshot handed to the dashboard is **never mutated**
— not the event array (see §5 sort-a-copy), not event records, not metadata.
The dashboard is a read-only projection (spatial spec SP-H8's read-only rule,
applied stage-wide).

**Close paths.** Escape and Done both close the modal (the app-wide
convention; wiring in §9).

**No debug logging.** The module ships with zero `console.*` calls. Nothing
logs on open, render, seek, or close.

---

## 9. Files & wiring map

Four existing files change; two new test files join them in their milestone.
Protected files (`src/main.js`, `src/preload.js`, `src/roster.js`) and all
other engine modules (`analytics.js`, `player-season.js`, `recent-form.js`,
`season-csv.js`) are **untouched**.

**`src/index.html`** (+~33 lines):

- a **topbar button** in `topbar-actions` (the `btn`-class convention,
  index.html:55–67), opening the dashboard;
- the **modal shell** — `matchAnalysisModal` — reusing the existing
  overlay/header patterns (`modal-overlay`, `display:none`, header + Done
  button, per the seasonModal pattern at index.html:525–532);
- the **script tag** for `match-analysis.js`, placed **between
  `season-csv.js` and `renderer.js`** (index.html:659/660 — the module must
  load after the engine family but before the renderer that wires it).

**`src/renderer.js`** (net ~+88/−3):

- **4 element references** (open button, modal root, Done button, dashboard
  content container);
- `closeMatchAnalysisModal()` inserted in **BOTH** Escape branches — the
  focus-in-form branch (renderer.js:3496) and the focus-elsewhere branch
  (~:3507) — in both cases between `closeMatchdaySquadModal()` and
  `settleTagConfirm(false)`, matching the MS-W4 regex (below);
- the **snapshot builder** (the purity-preserving session copy of §8);
- the **host API** object (§2: seekTo, resolvePlayer, pitchMarkingsSvg,
  zone lines, density accessors);
- **open/close** functions;
- **2 listeners** (open button, Done button).

**`src/styles.css`** (pure append, ~+521 lines):

- only `ma-*` class rules appended; **no existing rule is edited or removed**;
- responsive breakpoints at **1500 / 1180 / 820 px** — targeting comfortable
  full-view use at 1920 / 1600 / 1366 desktop widths and graceful reflow
  below.

**`tests/matchday-squad-ui-check.js`** (+12/−3):

- **MS-W1**: the script-chain array gains `'match-analysis.js'` **between
  `'season-csv.js'` and `'renderer.js'`** (assertion at :318–319);
- **MS-W4**: the Escape-branch regex gains `closeMatchAnalysisModal()`
  **before `settleTagConfirm(false)`**, and the matched-branch count **stays
  `=== 2`** (assertion at :325–326);
- **nothing weakened or removed** — every other assertion in the suite stands
  unchanged, and the suite remains 86/86.

---

## 10. Test expectations

Two new suites (jsdom, the app's established harness pattern — boot the real
`index.html` + module chain with a stubbed `window.matchtag`):

**Model suite — `tests/match-analysis-model-check.js` — 101 assertions**,
sections `MA-M1..M11`. **MA-M11 is the corrective-round section: 18
assertions** covering, in order of importance:

- exactly-N-in / exactly-N-out aggregates (fixtures engineered so each count
  is unambiguous);
- **envelope-source proof** (card numbers equal the L1 envelope values, not
  recomputed event-list counts);
- the **10-card render** (count and order, §4);
- list rows / counts / order (§5);
- **seek inputs and rendered attributes** (`data-videotime`/`data-time`,
  `videoTime ?? time` fallback);
- the **zero case on both surfaces** (cards `0 · 0`; empty-state list).

**UI suite — `tests/match-analysis-ui-check.js` — 90 assertions**,
sections `MA-U1..U13`.

**Existing suite:** `tests/matchday-squad-ui-check.js` — **86/86** (its
current self-report at this HEAD; unchanged count after the §9 edits).

**Regression battery:** 37 suites → **38** after the model suite lands →
**39** after the UI suite lands (`scripts/run-tests.js` auto-discovers
`tests/*.js`).

**Fixtures:**

- a **base session** with **no `Sub` / `Positive Transition` events** (drives
  the zero/empty-state surfaces);
- an **oracle session** with **3 Substitutions (2 our + 1 opponent)** and
  **4 Positive Transitions (3 our + 1 opponent)**, **19 recovered events**,
  **17 key rows**, and seek values **240 / null→1350 fallback / 140** (one
  row with `videoTime: 240`; one row with `videoTime: null` exercising the
  `?? time` fallback to 1350; one row seeking to 140).

Model suite additionally gains section MA-M12 "Section inventory & sourcing"
— for EACH of §13.1, 13.4, 13.5, 13.7, 13.8, 13.9: the section renders for
the fixture session, and spot-checked displayed values equal the named engine
source (not recomputed locally). UI suite gains section-presence assertions
for every §13 section at the standard fixture boot. The 101/90 totals were
the lost implementation's; with MA-M12 and the UI presence checks the totals
grow — exact final totals are recorded in this §10 at completion of
Milestones 2 and 3 respectively. The battery path stays 37 → 38 → 39.

**M2 COMPLETION RECORD (model suite, rebuilt M2 round 2):**
`tests/match-analysis-model-check.js` = **108 assertions** — sections
`MA-M1..M12` with 12 / 7 / 6 / 6 / 7 / 8 / 10 / 5 / 6 / 8 / **18** / 14
assertions respectively, plus one suite-structural law check asserting that
MA-M11 emits exactly 18. MA-M12 (14 assertions) proves every
`L1_COUNT_ROWS` / `L2_DERIVED_ROWS` / `PLAYER_COLS` field real against the
engine envelopes (one wrong name FAILs) and carries the review-rider
exact-string RATIO pins: with a 3-pass fixture (2 successful, 1
unsuccessful) the team and player "Pass success" cells render exactly
`66.7%` — the engine's percentage envelope `{value: 66.7, num: 2, den: 3}`,
never the raw fraction — and the zero-denominator cell renders `n/a`
(metric spec P5). Verified at completion: 108/108 green; sensitivity demo
(sha-sealed module → ONE targeted ratio defect → 6 FAILs across MA-M6 and
MA-M12, the rider pins among them → byte-exact restore, sha-verified →
green); regression battery **38/38 suites** (37 → 38 as planned). Milestone
3 (UI suite) totals pending; the battery path to 39 is unchanged.

**M3 COMPLETION RECORD (UI suite, rebuilt Milestone 3):**
`tests/match-analysis-ui-check.js` = **77 assertions** — sections `MA-U1..U13`
with 6 / 5 / 6 / 4 / 5 / 8 / 5 / 9 / 3 / 4 / 3 / 8 / 11 assertions
respectively. The suite boots the real index.html + script chain
(match-analysis.js evaluated between the engine family and renderer.js) with
a stubbed `window.matchtag`, loads the §10 fixtures through the app's own
load pathway, and verifies the commit-A wiring end-to-end: the modal
mechanism with all three close paths (Done, Escape-elsewhere,
Escape-in-form); the 9-section §13 inventory in exact order; the §4 card
strip (keys, labels, envelope values); the 17-row chronological list with
the id tiebreak and `data-videotime`/`data-time`; end-to-end seeks through
the REAL host (video.currentTime = 240 / null→1350 fallback / 140 / 40);
REAL host provenance (pitch-outline markings, 4 an-zoneline lines, the
crimson DENSITY_FILLS ramp); the minimum-sample gate on both sides; shared
zone activation on the pointer and Enter paths; §12.1 Space propagation
asserted, not fixed (reaches window, preventDefault, the global play/pause
acts, and the zone toggles — both effects from one keydown); snapshot purity
by double-save byte comparison with zero autosave writes; the Analytics tab
preserved; per-open recompute across an oracle→base session switch;
empty-session rendering; and the §9 static wiring/CSS law (breakpoints
1500/1180/820, the ma-* vocabulary, base sentinels intact). Verified at
completion: 77/77 green; sensitivity demo (sha-sealed renderer.js → ONE
targeted wiring defect: host.seekTo as a no-op → exactly the four
end-to-end seek checks FAIL, 73/77 → byte-exact restore, sha-verified →
green); regression battery **39/39 suites** (38 → 39 as planned).

**Stage 4B (V2.0):** the EXISTING suites grow new sections — model suite
gains MA-M13 'engine filter preconditions' (pinning, via the engine directly,
the behaviors the module relies on: zero-result on a NON-EMPTY session → 1–2
zero grids + playerGrids [] + locatedShare null; player-filter overrides team
partition; player filter excludes Sub events and unattributed events; invalid
team value normalizes to '__all__'; grid id format
'grid:scope=…:partition=…'; filtered grid.events contain only matching
records), MA-M14 'key-list filtering' (predicate correctness per §14.8,
Showing N of M, both empty-state strings, D2-extension: filtering the list
leaves the cards byte-identical), MA-M15 'spatial re-filter re-render'
(single computeSpatialView per change, no computeMatchAnalytics re-run,
traces/dots respect filters, below-gate null state under filters,
byte-identical double re-render at unchanged filters). UI suite gains MA-U14
'filter controls + interactions' (both filter bars render; per-change
re-render of ONLY the affected section; reset affordances; controls at
'__all__' on every fresh open), MA-U15 'suppression + context stating' (state
control disabled + explanation when view.stateFilterSuppressed is truthy;
'filtered view' markers; active-filter summary; unattributed note), MA-U16
'purity under filtering' (session save payload byte-identical across filter
changes; zero autosave writes). Totals are recorded in this §10 at
completion. Battery remains 39 suites (no new files). Where the filter bars
add DOM inside existing sections, a minimal number of 4A assertions may be
UPDATED to preserve their pinned intent — every such change listed at
completion; nothing weakened. FIXTURE LAW: any fixture exercising the state
filter must carry complete scoreForAfter/scoreAgainstAfter goal chains (the
X1 suppression otherwise silently disables the filter).

**Stage 4B COMPLETION RECORD (M3).** Implemented per §14; verified at
completion. Model suite **139/139** (108 4A + 31 new: MA-M13 9 — engine-direct
pins, incl. sub-role-only player (§12.5) and the X1 suppression active-vs-
forced pair; MA-M14 12; MA-M15 10); UI suite **91/91** (77 4A + 14 new:
MA-U14 7 — including the §9-style filter-bar CSS law; MA-U15 3 — ENGINE PATH
WITH A VALID CHAIN, chosen over a doctored envelope: the oracle's intact 1–1
goal chain against a doctored manual score 2–1, a genuine engine X1 MISMATCH
(FIXTURE LAW satisfied by construction); MA-U16 4 — including the RED-FIRST
retention source pin: the renderAnalysis return retained as
`matchAnalysisModel`, assigned in `openMatchAnalysisModal`, nulled in
`closeMatchAnalysisModal`; both close paths — Done and both Escape branches —
funnel there). Matchday 86/86; battery **39/39** at every commit.

The pinned exact strings (tests pin them verbatim):

- Banner: `Spatial filters active — all other sections remain whole-match.`
- Suppression explanation: `Score state filtering unavailable (X1 reconciliation gate): the manual matchInfo score disagrees with the attributed goal chain. The effective score-state filter is All.`
- Unattributed note: `Unattributed events (no Us/Opponent attribution) are excluded from all spatial grids; there is no option to view them spatially.`
- Filtered-view suffix: ` (filtered view)` — appended to the insufficient-events message and the `max = N` line.
- Active-filter summary format: `Active filters: ` + the non-default values in bar order joined ` · ` (e.g. `Active filters: Team Us · Period 1H`).
- Period vocabulary ORDER LAW (pinned): distinct RAW `rec.period` values from `A.spatial` (located + unlocated), ordered by `Object.keys(A.level3.byPeriod)` (the engine's own canonical order) excluding `Non-play` (a bucket name — FORBIDDEN as a filter value) and `Unknown`; then every remaining value (including `Unknown` when present, and raw non-play periods such as `PRE_MATCH`/`HT`/`ET_HT`/`FT`) sorted alphabetically after it.

4A assertions updated (nothing weakened; pinned intent preserved): **M10.8**
— the key-events section children count `=== 2` → `=== 3` (title + the §14
filter bar, whose wrapper carries the status line, + the list; still NO
counter/metric element — the §5 never-a-metric law). No other 4A assertion
changed.

Sensitivity demos (both live, no git for perturbation/restore): A —
`listRowPeriod` comparing byPeriod bucket names (`Non-play`) for non-play
periods instead of RAW values → exactly MA-M14.5 red (138/139), byte-exact
restore, sha pair verified; B — the renderer discarding the renderAnalysis
return immediately (statement call, never retained) → exactly MA-U16c+U16d
red (89/91), byte-exact restore, sha pair verified.

---

## 11. Engine anchors (verified at `2c0748d6`)

Every anchor below was re-verified in the current tree before this document
was written. Cite these in tests and implementation comments.

| Anchor | Cited | Found (actual) | Status |
|---|---|---|---|
| `case 'Sub': m.substitutions++` | ~:452 | analytics.js **:452** | exact |
| `case 'Positive Transition': m.positiveTransitions++` | ~:476 | analytics.js **:476** | exact |
| `substitutions: countEnv(m.substitutions)` | ~:504 | analytics.js **:504** | exact |
| `positiveTransitions: countEnv(m.positiveTransitions)` | ~:523 | analytics.js **:523** | exact |
| `level1.team` wiring (`our`/`opponent`/`unattributed` envelopes) | ~:1647–1651 | analytics.js **:1646–1650** | match (±1) |
| `countEnv` (always-numeric `value`) | ~:118–120 | analytics.js **:118–120** | exact |
| `MIN_SAMPLE_FOR_DENSITY = 6` | — | analytics.js **:1098** (const), **:1408** (`params.minSampleForDensity`), **:1944** (export) | verified |
| `computeSpatialView(A, filters)` | — | analytics.js **:1429**; filters `{scope, team, period, state, sequence, player}` | verified |
| `computeMatchAnalytics(session)` | — | analytics.js **:1577** | verified |
| row-major `cells[ti*3+ci]` | — | analytics.js **:1195, 1205, 1223, 1243, 1248** | verified |
| count envelopes for all ten cards | — | analytics.js **:492–503, 504, 523** | verified |
| Label precedent `'Substitutions'` | ~:4445 | renderer.js **:4437** | drift −8, exists |
| Label precedent `'Positive transitions'` | ~:4459 | renderer.js **:4451** | drift −8, exists |
| `pitchMarkingsSvg` | — | renderer.js **:2643** | verified |
| `ZONE_LINES_SVG` | — | renderer.js **:3931** | verified |
| `DENSITY_FILLS` / `densityStep` | — | renderer.js **:3903 / :3912** | verified |
| `seekTo(time)` | — | renderer.js **:1395** | verified |
| `resolveMatchdayPlayer` → `Roster.resolveMatchPlayer` | — | renderer.js **:620–621** | verified |
| Escape branches (both) | — | renderer.js **:3496** and **~:3507** | verified |
| Script chain slots | — | index.html **:659** (season-csv.js) / **:660** (renderer.js) | verified |
| MS-W1 chain array | — | tests/matchday-squad-ui-check.js **:318–319** | verified |
| MS-W4 Escape regex (`count === 2`) | — | tests/matchday-squad-ui-check.js **:325–326** | verified |

Engine taxonomy cross-check (all real labels): `'Goal'`, `'Shot'`,
`'Chance'`, `'Cross'`, `'Corner'`, `'Foul'`, `'Card'`, `'Sub'`,
`'Positive Transition'` (analytics.js:61–63, 436–476).

---

## 12. Accepted limitations (document, do not fix)

These are known, accepted behaviors of Stage 4A. They are **not** defects and
**must not** be "fixed" locally in the dashboard module:

1. **Space propagation.** A Space keydown on a dashboard zone cell reaches the
   global play/pause handler (because §8 forbids `stopPropagation`). Accepted:
   identical behavior to the existing Analytics tab.
2. **Shirt numbers.** The players table displays shirt numbers for players
   whose squad entries carry numeric numbers; no fallback invention for
   non-numeric or missing numbers.
3. **`.ma-card-our` / `.ma-trace-label` are used-but-unstyled.** The markup
   carries these class hooks and the stylesheet defines no rules for them.
   They exist for future stages; leaving them unstyled is deliberate.

12.4 Unattributed events are excluded from all spatial team grids (engine
semantics: team ∈ {our, opponent}); they appear in no grid and no option
exists to view them spatially — stated in one static note in the spatial
section, never 'fixed' with a pseudo-partition (that would be an engine
change).

12.5 A player filter excludes Sub events (SP records carry playerId null for
Subs) and unattributed events; players involved only via sub roles appear in
the dropdown yet yield a valid empty/below-gate grid.

12.6 The state filter is force-disabled by the engine under X1 MISMATCH; the
UI must surface this (disabled control + explanation), never filter silently.

12.7 Filtering never recomputes aggregate metrics — cards, team tables,
period tables, players, sequences remain whole-match under any filter; a
filtered spatial view must never be readable as recomputed statistics.

---

## 13. Dashboard section inventory (V1.1)

The Stage 4A constitution requires the dashboard to cover seven areas: match
header, team summary, team performance, period analysis, spatial analysis,
player analysis, key events. V1 specified spatial (§3) and key events (§4–§5).
This section inventories the remaining sections. All are engine-sourced
projections under the same laws as the rest of this document (§2 purity, §6
single-execution, no invented metrics, null ≠ zero per metric spec P5).

Section order below is now authoritative (the lost implementation's exact
order is unrecoverable):

13.1 Match header — source: session metadata + A.matchSummary. Content:
competition/opponent/date context, teams, final score, match state. Nothing
computed locally.

13.2 Key-event summary cards — §4.

13.3 Chronological key events — §5. List filtering (class/team/period) per
§14.7.

13.4 Team summary & performance — source: A.level1.team.{our,opponent} AND the
A.level2 team structures (the same envelopes the app's Analytics tab reads).
Content: the engine's team-level aggregates exactly as exposed (possession
tagging, outcomes, score-state, transitions). Count cells are numeric with
plain 0 allowed; ratio cells follow metric spec P5 — a null ratio renders as
not-applicable per the metric spec's rendering rule, never as 0.

13.5 Period analysis — source: A.level3.byPeriod and A.level3.byMinuteBin.
Content: per-period and per-minute-bin breakdowns exactly as the engine
exposes them (periods include 1H, HT, 2H, FT, ET1, ET_HT, ET2 where present).
No re-binning, no re-aggregation.

13.6 Spatial analysis — §3. Interactive filtering per §14; filter bar per
§14.2.

13.7 Player analysis — source: A.players.list, keyed by playerId (§7).
Content: per-player counts and ratios as the engine exposes them. Framing is
counts + ratios — no per-90, no physical or derived metrics. Shirt-number
display limitation per §12.2.

13.8 Sequences — source: A.sequences, rendered as the engine's sequence list.
This is the existing engine data surface, NOT Stage 5: no diagrams, no
narratives, no sequence editing (§1).

13.9 Protocol notes — source: A.protocol.notes, rendered read-only.

13.10 Section-sourcing law: every value in §13.1–13.9 comes from the named
engine structure or session metadata. If a desired display value has no engine
source, that is a metric-spec change request — never a local formula (§2).

---

## 14. Stage 4B — Interactive filtering (V2.0)

14.1 SURFACES. Spatial section: a filter bar (top of section) with six
dropdowns — Scope, Team, Period, Score state, Sequence, Player — plus a Reset
button. Key-events section: a filter bar with three dropdowns — Class, Team,
Period — plus Reset. No other section gains controls. While any spatial filter
is non-default, the spatial section shows an active-filter summary line (the
chosen values, human-readable) and an active-filter banner is the ONLY
indication that other sections remain whole-match (text pinned at
implementation, recorded in §10).

14.2 FILTER STATE. Defaults '__all__' (list: no filter). State is per-open
only: every fresh open starts at defaults (consistent with §6); Reset in a
bar restores that bar's defaults and re-renders only that section. Filter
changes apply immediately (no Apply button).

14.3 VOCABULARIES (single sources of truth). scope: event labels present in
the session, canonical order first then sorted customs; team: fixed
'our'/'opponent' (display 'Us'/'Opponent'); period: distinct RAW rec.period
values from A.spatial records (located + unlocated), ordered by the engine's
canonical period order with unknown/extra values after ('Unknown' included
when present) — byPeriod bucket names (incl. 'Non-play') are FORBIDDEN as
filter values; state: fixed WINNING/DRAW/LOSING; sequence:
view.sequenceOptions; player: A.players.list ids (display via the existing
resolver chain). List Class dropdown: the nine qualifying labels in display
form, filtering on the raw label; list Team: All/Us/Opponent (team-null rows
visible only under All); list Period: the SAME vocabulary source as spatial
period, with row.event.period undefined mapped to 'Unknown'.

14.4 SEMANTICS (engine-truth, pinned by MA-M13). Filters are conjunctions.
Grid structure: player filter → one grid 'player:<pid>'; team filter → one
grid; otherwise the Us+Opponent pair; player overrides team. Every grid's
.events contains ONLY filtered located records — dots and zone-cell traces
are filter-correct automatically and MUST be tested as such. Zero-result →
normal structure with zero counts, locatedShare null → 'n/a' (P5), never 0.

14.5 STATE SUPPRESSION UI. Read view.stateFilterSuppressed on every render.
When truthy: the Score state control renders DISABLED with a visible
explanation naming the X1 reconciliation gate, and the effective filter is
'__all__'. Never silent. Never re-enable while suppressed.

14.6 CONTEXT STATING (SP-H7). Grid heads already state scope+partition —
unchanged. When spatial filters are non-default: the insufficient-events
message and the 'max = N' line each gain a ' (filtered view)' suffix, and the
section carries the one static unattributed note (12.4). The minimum-sample
gate evaluates per filtered grid exactly as in Stage 4A (below-gate → null
state, numeric table still renders).

14.7 LIST FILTERING (§14.8 merged here). List filters are module-side
predicates on row fields: label equality; team equality; period via
row.event.period (undefined → 'Unknown'). Filtering re-renders ONLY the
key-events section innerHTML from the retained model; row order (time asc,
id asc), row markup, and seek behavior of visible rows are IDENTICAL to
Stage 4A; zero engine calls; the D2 law extends — filtering the list never
changes the cards or any other section.

14.8 MODULE API. The module gains ONE new exported re-render entry point
(name at implementation, e.g. updateFilters) with the contract: given the
root element, the per-open model, the host, and new filter sets, it (a) runs
computeSpatialView(model.analytics, spatialFilters) — the ONLY engine call,
(b) updates the model's spatial view in place, (c) re-renders ONLY the
spatial and key-events section DOM, (d) preserves the §8 delegation
(listeners live on the root element and MUST NOT be re-attached), (e)
performs no other engine work, no mutation of A, and returns nothing the
renderer needs to retain beyond the model it already holds. renderAnalysis
signature and behavior are UNCHANGED (its returned model is now RETAINED by
the renderer for the open's lifetime and discarded on close — a small
renderer wiring change: retain on open, null on Done/Escape; the wiring
block remains confined to the Stage 4A block's territory).

14.9 INHERITED CONSTRAINTS. All §2/§3/§5/§8 laws bind unchanged: purity (no
mutation of session or A — filter changes included in purity tests), no
.click(), delegation-only keyboard access, no seek from spatial views, no
new dependencies, no engine changes, protected files untouched.
Determinism: with unchanged filters and data, a re-render is byte-identical.

---

*End of specification. Implementation milestones follow this document in
order: module → tests → wiring → styles → battery green → commit and push at
every milestone.*
