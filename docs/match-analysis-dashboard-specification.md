# PitchLog — Stage 4A Match Analysis Dashboard Specification (V1)

**Status:** AUTHORITATIVE — V1.1. This document is the single build recipe for
Stage 4A (Match Analysis Dashboard) of the tagging app. It consolidates the
surviving architecture audit (worklog `STAGE4A-ARCHAUDIT-1`), the engine and
renderer contracts verified at this HEAD, and the corrective round that defined
the lost implementation's final state.

V1.1 amendment (review round): §13 dashboard section inventory added;
§1/§5/§6/§10 clarified.

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

- **Stage 4B interactive filtering** — the dashboard renders with fixed default
  filters; per-section filter controls are a later stage.
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

**Empty state.** When no qualifying events exist, the empty state
**enumerates the classes** — it names the qualifying event labels (the
`KEY_EVENT_LABELS` set, in display form) so the analyst sees what would have
been listed, rather than a bare "no data".

---

## 6. Single-execution contract

**Per render pass, the engine runs exactly once each:** one
`computeMatchAnalytics(session)` call and one `computeSpatialView(A, filters)`
call (analytics.js:1577, 1429).

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

**No module-level caching.** There is **no cache that survives a modal open,
a modal close, or a session switch**. Every open recomputes from the current
snapshot. (The lost implementation recomputed the engine twice per render;
this contract eliminates that and additionally forbids any cross-open caching
— both stated as law.)

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

13.3 Chronological key events — §5.

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

13.6 Spatial analysis — §3.

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

*End of specification. Implementation milestones follow this document in
order: module → tests → wiring → styles → battery green → commit and push at
every milestone.*
