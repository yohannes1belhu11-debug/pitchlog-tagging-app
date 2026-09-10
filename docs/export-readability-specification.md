# PitchLog — Export Readability Specification

**Task ID:** R2-EXREAD
**Status:** PROPOSED SPECIFICATION — no implementation. This document changes
no source, no tests, no UI. It records the verified current state, proposes
the readable layer, and freezes the compatibility contract.
**Baseline:** `e99cacf` (R2-B data quality & analysis readiness). All source
citations below are line numbers at this commit.
**Companion document:** `docs/export-data-dictionary.md` (R2-B) is the
authoritative per-column reference for all five CSV exports. This spec does
NOT duplicate it — it verifies it (Part A), then proposes the readable layer
on top (Parts B–E).

**Constraints (all honored by this being a doc-only commit):** schema v4
untouched; analytics untouched; autosave untouched; R2-A filename/BOM/feedback
behavior untouched; Season Player 63-column contract untouched; no new
dependencies.

---

## 0. Change manifest — what the baseline `e99cacf` changed

From `git show --stat e99cacf` (7 files, +1152/−26) and the R2B-DATA-QUALITY
worklog entry:

| File | Δ | Intent |
|---|---|---|
| `docs/export-data-dictionary.md` | new, 403 lines | Authoritative per-column reference for all five CSV exports (schema blocks, join keys, Excel guidance, known quirks) |
| `docs/metric-specification.md` | +4/−2 | Truth updates only: BOM line now covers `clip_playlist.csv`; F7 line corrected to name the real `Event Outcome` column |
| `README.md` | +16/−1 | Stale suite count replaced with count-free phrasing; dictionary pointer |
| `src/main.js` | +9/−1 | Write layer only: `clip_playlist.csv` gets the UTF-8 BOM (string-guarded); `cut_clips.bat` stays BOM-free |
| `src/renderer.js` | +40/−10 | Export layer only: season-events player cells resolve against each match's own squad (`resolveMatchPlayer`); clip-export empty guards + button tooltip |
| `tests/r2a-export-check.js` | +26/−2 | Pins moved with the R2-B boundary (M10b/M10c/S3) |
| `tests/r2b-data-quality-check.js` | new, 680 lines | 48 checks: clip BOM bytes, per-match squad scoping, empty guards, five dictionary-vs-implementation header contracts, static pins |

**STOP-level audit result: PASS.** The complete source diff
(`git show e99cacf -- src/renderer.js src/main.js`) is confined to the export
layer — the season-events player-cell resolver, clip-modal guards, and the
file-write BOM. No schema (v4 event/session format), no analytics
(`src/analytics.js`, `src/player-season.js`, metric computation), and no
autosave code is touched. Doc diffs are documentation truth updates; test
diffs are test files. No STOP-level finding.

---

## Part A — Verification of `docs/export-data-dictionary.md` (corrections only, cited from source)

### A.1 Column orders — all five CONFIRMED

The dictionary's five `json` schema blocks were compared, column by column,
against the real builders at `e99cacf`:

| Export | Dictionary § | Source (verified) | Result |
|---|---|---|---|
| match-events (19) | §3 | header string `renderer.js:4316`, row assembly `renderer.js:4327-4349` | **CONFIRMED** — exact order |
| match-events-full-analysis (36) | §4 | header array `renderer.js:5241`, row assembly `renderer.js:5252` | **CONFIRMED** — exact order |
| season-events (20) | §5 | header string `renderer.js:3988`, row assembly `renderer.js:4015-4038` | **CONFIRMED** — exact order |
| season-player (63) | §6 | `COLUMNS` array `season-csv.js:62-79`; cell assembly `season-csv.js:195-235` / summary `season-csv.js:239-284` | **CONFIRMED** — exact order (63) |
| clip_playlist (7) | §7 | header string `renderer.js:4414`, row assembly `renderer.js:4415-4423` | **CONFIRMED** — exact order |

The shared conventions were also re-verified: `formatTimecode` produces
`HH:MM:SS.t` (`renderer.js:610-622`); `csvEscape` quotes only on comma /
double-quote / newline with `""` doubling (`renderer.js:4355-4361`,
duplicated verbatim in `season-csv.js:82-88`); `TRUE`/`FALSE` literals
(`season-csv.js:101-105`); BOM added only at the main-process write layer
(`main.js` `file:exportCsv` / `file:exportClipPlaylist`); LF line endings,
no trailing newline.

### A.2 Corrections found (recorded per the STOP rules — nothing is fixed in this commit)

1. **`participation_status` value set is WRONG in the dictionary.**
   Dictionary §6 (column 11 note) claims
   `STARTED / SUB_ON / SUB_OFF / UNUSED / UNKNOWN`. The actual engine enum
   (`player-season.js:710-730`, matching `player-season-data-specification.md`
   line 216) is:

   `STARTED`, `STARTED_FULL`, `STARTED_SUBBED_OFF`, `STARTED_SENT_OFF`,
   `SUB_ON`, `SUB_ON_SUBBED_OFF`, `SUB_ON_SENT_OFF`, `UNUSED_SUB`,
   `NOT_INVOLVED`, `UNKNOWN` — plus the `SEASON_SUMMARY` sentinel in the
   status cell of summary rows (`season-csv.js:249`).

   The claimed values `SUB_OFF` and `UNUSED` are **never emitted**;
   `STARTED_FULL`, `STARTED_SUBBED_OFF`, `STARTED_SENT_OFF`,
   `SUB_ON_SUBBED_OFF`, `SUB_ON_SENT_OFF`, `NOT_INVOLVED` are missing from
   the note. Consumers filtering on the dictionary's set would mis-bucket
   six real statuses.

2. **`x1_status` values are not enumerated.** Actual emitted values:
   `MATCH` / `MISMATCH` / `MANUAL-EMPTY`
   (`analytics.js:1618`; `player-season.js:614,637`). The dictionary note
   only says "score-chain status; MISMATCH flags an inconsistent goal chain".

3. **`minutes_reasons` codes are not enumerated.** Observed emission set
   (`player-season.js:358,371,375-376,447-450` and participation context
   `player-season.js:724-727`): `NO_PARTICIPATION_MARKERS`,
   `SUB_TIME_MISSING`, `MULTIPLE_SUB_ON`, `NO_FT_MARKER`,
   `END_FALLBACK_LAST_KNOWN`, `STARTING_XI_MISSING`, `NOT_IN_SQUAD`
   (joined with `;`, `season-csv.js:223`). The dictionary documents the
   format but not the vocabulary.

4. **`state_suppressed` codes are not enumerated.** Only observed value:
   `X1_MISMATCH_SUPPRESSED` (`player-season.js:804`). The dictionary gives
   it only as an example.

5. **Trigger labels in dictionary §2 do not match the actual button texts.**
   Actual buttons (`index.html:60-61,430,438`): `Export CSV` (dictionary:
   correct), `Export clip playlist` (dictionary says "Export Clips"),
   `Export season CSV` (dictionary says "Export season events"),
   `Export player×match CSV` (dictionary says "Export season player CSV").

### A.3 Confirmed-correct claims worth pinning (no action)

- `side` values `for` / `against` (`renderer.js:5445`); full-analysis `Team`
  values `our` / `opponent` (`renderer.js:5439`); `Home Team`/`Away Team`
  use `Us`/opponent name (`renderer.js:5243-5244`).
- `outcome` cells are exactly `SUCCESS` / `FAILURE` / empty
  (`renderer.js:122-124`), applicable to Duel/Press/Turnover/Cross
  (`renderer.js:101`); Pass outcome stays qualifier-based
  (`renderer.js:94-97`).
- Season `result` cells `W 2-1` / `D 1-1` / `L 0-2`
  (`season-csv.js:141-144`, outcome from `player-season.js:622`).
- `zone_dl`…`zone_ar` map to the readable zone names via `ZONE_MAP`
  (`season-csv.js:123-133`); `location_zone` strings are
  `'Third · Channel'` from `PITCH_THIRDS`/`PITCH_CHANNELS`
  (`renderer.js:1249-1259`).
- SEASON_SUMMARY two-sentinel labeling and row order
  (`season-csv.js:242,249,301-314`); match label format and
  `(Match with no details set)` fallback (`renderer.js:2991-3002`).
- `state_winning/drawing/losing` are event counts, not booleans
  (`season-csv.js:134-136,179-186`).

---

## Part B — Proposed readable headers + value dictionaries (new territory)

### B.0 Column classification and design principles

Classification of every column's values (Task 2 of the task book) —
**machine key** vs **already human-readable**:

| Export | Machine keys / machine formats | Already human-readable |
|---|---|---|
| match-events (19) | `side` (for/against); `outcome` (SUCCESS/FAILURE); timecode columns (machine format `HH:MM:SS.t`); `location_x/y` (0–1 scale) | `label`, 6 `player_*` cells, `subtype`, `qualifiers` (`k: v; …`), `location_zone` |
| season-events (20) | same 19 as match-events | `match` (composite label) + same readable set |
| full-analysis (36) | `Period` (PRE_MATCH/1H/…); `Team` (our/opponent); `Score State` (WINNING/DRAW/LOSING); `Event Outcome` (SUCCESS/FAILURE); `Primary/Secondary Player ID` (player_N); `X/Y` (0–100 scale); time columns (machine formats) | `Match ID` (composite), `Date`, `Competition`, `Home/Away Team`, `Opponent`, `Category/Event/Label` (duplicated label), `Subtype`, legacy `Outcome` (qualifier string), `Pitch Zone/Third/Channel`, `Sequence ID` (SEQ-NNN) |
| season-player (63) | `home_away`; `result` (W/D/L code); `x1_status`; `participation_status` (10-value enum); `started/subbed_on/subbed_off/sent_off` (TRUE/FALSE); `minutes_quality`; `minutes_reasons`; `state_suppressed`; `SEASON_SUMMARY` sentinels; `zone_*` headers (machine zone keys); `player_id` | `match_key` (composite), `date`, `opponent`, `competition`, `player_name`, `player_number`, all count/percentage columns (readable semantics) |
| clip_playlist (7) | `start_timecode`/`end_timecode` (machine format, video clock); `filename` (ASCII-safe) | `clip`, `label`, `details` (composite summary), `duration_seconds` |

**Design principles for the readable layer:**

1. **Machine columns are never renamed, reordered, or re-formatted.** The
   machine keys are load-bearing: tests pin them, analytics reads them, and
   (per Part C) Once Sport workflows depend on them.
2. **Readability is additive only**: new readable columns are strictly
   APPENDED after existing columns, and/or delivered as a glossary sheet
   (B.4). No existing column's name, position, or value format changes.
3. **Readable cells never invent data.** Empty stays empty (or `—` in
   dedicated readable columns only — see E6). The null discipline of the
   machine columns is untouchable.
4. **Every mapping must be total** — each machine value actually emitted has
   exactly one readable label, verified by tests in a future implementation
   commit (same drift-pinning technique as the dictionary contract tests).

### B.1 Master value dictionaries (machine value → readable label)

These tables are the proposed single source for the readable layer and the
glossary sheet (B.4).

**Outcome** (`outcome` / `Event Outcome` columns):

| Machine | Readable (generic) | Event-specific display (existing in-app `OUTCOME_DISPLAY`, `renderer.js:102-106`) |
|---|---|---|
| `SUCCESS` | Success | Duel **Won**; Press **Success**; Turnover/Cross **Successful** |
| `FAILURE` | Failure | Duel **Lost**; Press **Failure**; Turnover/Cross **Unsuccessful** |
| *(empty)* | — | *(empty — no outcome recorded; never "failed")* |

Pass outcome (qualifier-based, `renderer.js:94-97`) is already the readable
words `Successful` / `Unsuccessful` inside the `qualifiers` column.

**Side / team / venue:**

| Column | Machine | Readable |
|---|---|---|
| `side` (match-events, season-events) | `for` | Our team |
| | `against` | Opponent |
| `Team` (full-analysis) | `our` | Us |
| | `opponent` | Opponent |
| `home_away` (season-player) | `home` / `away` / `neutral` | Home / Away / Neutral |

**Period** (full-analysis `Period`; readable labels verbatim from the
in-app `PERIOD_LABELS`, `renderer.js:130-134`):

| Machine | Readable |
|---|---|
| `PRE_MATCH` | Pre-match |
| `1H` / `2H` | 1st Half / 2nd Half |
| `HT` | Half-time |
| `FT` | Full-time |
| `ET1` / `ET2` | ET 1st Half / ET 2nd Half |
| `ET_HT` | ET Half-time |

**Score state** (full-analysis `Score State`): `WINNING` → Winning,
`DRAW` → Drawing, `LOSING` → Losing.

**Participation status** (season-player; corrects and extends the
dictionary per A.2-1):

| Machine | Readable |
|---|---|
| `STARTED` | Started |
| `STARTED_FULL` | Started (full match) |
| `STARTED_SUBBED_OFF` | Started, subbed off |
| `STARTED_SENT_OFF` | Started, sent off |
| `SUB_ON` | Substitute on |
| `SUB_ON_SUBBED_OFF` | Sub on, subbed off |
| `SUB_ON_SENT_OFF` | Sub on, sent off |
| `UNUSED_SUB` | Unused substitute |
| `NOT_INVOLVED` | Not involved |
| `UNKNOWN` | Unknown |
| `SEASON_SUMMARY` (sentinel) | Season summary |

**Minutes quality / reasons / score-chain status:**

| Machine | Readable |
|---|---|
| `RELIABLE` / `ESTIMATED` / `UNAVAILABLE` | Reliable / Estimated / Unavailable |
| `NO_FT_MARKER` | No full-time marker |
| `END_FALLBACK_LAST_KNOWN` | End fell back to last-known evidence |
| `SUB_TIME_MISSING` | Substitution time missing |
| `MULTIPLE_SUB_ON` | Multiple sub-on markers |
| `NO_PARTICIPATION_MARKERS` | No participation markers |
| `STARTING_XI_MISSING` | Starting XI missing |
| `NOT_IN_SQUAD` | Not in squad |
| `MATCH` / `MISMATCH` / `MANUAL-EMPTY` (x1_status) | Score chain consistent / Score chain inconsistent / No manual score |
| `X1_MISMATCH_SUPPRESSED` (state_suppressed) | Suppressed — score chain inconsistent |

**Booleans** (readable columns only): `TRUE` → Yes, `FALSE` → No.

**Result** (season-player `result`): keep the compact football notation
`W 2-1` in the machine column; the glossary maps `W/D/L` → Win/Draw/Loss for
report prose. (E7.)

**Zone column-name mapping** (season-player headers; verbatim `ZONE_MAP`,
`season-csv.js:123-133`): `zone_dl` = Defensive third · Left channel,
`zone_dc` = Defensive third · Central channel, `zone_dr` = Defensive third ·
Right channel, `zone_ml`…`zone_mr` = Middle third · (Left/Central/Right)
channel, `zone_al`…`zone_ar` = Attacking third · (Left/Central/Right)
channel, `zone_unlocated` = Unlocated.

**Event label vocabulary** (event/zone name mapping): the 18 default tags
(`renderer.js:15-79`) — Goal, Shot, Pass, Foul, Card, Corner, Sub,
Possession, Chance, Cross, Key Pass, Press, Press Win, Turnover, Recovery,
Interception, Duel, Positive Transition, Negative Transition — are already
human-readable words; the closed set (plus custom tags) is documented in the
glossary. Subtype and qualifier-group vocabularies per tag (e.g. Shot:
On target / Off target / Blocked; Body part: Left foot / Right foot / Head;
Pass Outcome: Successful / Unsuccessful; Pressure: Under pressure / Free;
Possession Ended by: Shot / Turnover / Foul won / Out of play) are likewise
readable and belong in the glossary's vocabulary section.

### B.2 mm:ss time proposals

- **Match clock columns** (`timecode` / `end_timecode` in match-events and
  season-events): propose ADDITIVE `clock_mmss` / `end_clock_mmss` columns
  rendering `MM:SS` — minutes:seconds, no hours, no tenths (a football match
  clock stays below 130 minutes including extra time, so `90:00` /
  `105:30` are unambiguous). Tenths remain available in the machine columns;
  the mm:ss column truncates them (whole seconds), matching the integer
  second the timecode already displays. Machine `seconds` /
  `end_seconds` / `duration_seconds` stay the numeric source of truth.
- **Video clock columns** (clip_playlist `start_timecode` / `end_timecode`,
  full-analysis `Video Time`): KEEP `HH:MM:SS.t`. Broadcast recordings
  routinely exceed one hour; an mm:ss rendering would be ambiguous or
  corrupt. Readability for clips is already served by the `details` column
  and the playlist's one-row-per-clip layout.
- **Excel caution (already in dictionary §1):** timecode-shaped cells may be
  auto-converted to time-of-day on double-click open. The mm:ss column is
  for human reading and report tables; machine and Excel-fidelity consumers
  should keep importing those columns as Text or use the numeric columns.

### B.3 Per-export readable column proposals (strictly appended)

| Export | Current | Proposed appended readable columns (in order) | Notes |
|---|---|---|---|
| match-events | 19 | `side_name`, `outcome_label`, `clock_mmss`, `end_clock_mmss` → 23 | Appending after `outcome` displaces the R1-pinned "outcome as final column" invariant — see E2 |
| season-events | 20 | same four, appended after `outcome` → 24 | Same E2 caveat |
| match-events-full-analysis | 36 | `Team Name`, `Period Name`, `Score State Name`, `Event Outcome Label` → 40 | 36-column semantics are pinned by R1 tests (C22) — see E2 |
| season-player | 63 | **NONE** — the 63-column contract is frozen | Readability via glossary sheet (B.4) only; a separate readable companion export is E3 |
| clip_playlist | 7 | **NONE** — already human-readable | No machine keys to translate; video clock stays HH:MM:SS.t (B.2) |

`outcome_label` uses the generic Success/Failure/— mapping (B.1); the
event-specific words (Won/Lost/…) remain a report-layer choice documented in
the glossary.

### B.4 Glossary sheet (value-dictionary delivery)

Propose a machine-generated **glossary sheet** — `pitchlog-data-dictionary.csv`
(three columns: `vocabulary`, `machine_value`, `readable_label`, plus a
`columns` reference column) containing every B.1 dictionary, the zone map,
the event/subtype/qualifier vocabularies, and the header display names (B.5).
Delivery options: (a) written automatically next to every CSV export,
(b) a separate "Export data dictionary" button, (c) shipped in the repo docs
only. Recommendation: (a) — the analyst who opens the CSV in Excel has the
translation on disk next to it. Decision: E5. Implementation must pin the
sheet's contents with the same drift-guard test technique the data
dictionary uses (`tests/r2b-data-quality-check.js` D-series).

### B.5 Readable header display names

CSV header rows keep the machine headers (compatibility contract, Part C).
Display names for reports and the glossary:

| Machine header | Display name |
|---|---|
| `timecode` / `end_timecode` | Timecode / End timecode (HH:MM:SS.t) |
| `seconds` / `end_seconds` / `duration_seconds` | Start second / End second / Duration (seconds) |
| `side` | Team perspective |
| `player_off_*` / `player_on_*` | Player off (number/name) / Player on (number/name) |
| `location_zone` / `location_x` / `location_y` | Pitch zone / X (0–1) / Y (0–1) |
| `outcome` | Outcome (SUCCESS/FAILURE) |
| `pass_success_pct` / `located_share_pct` | Pass success % (pooled) / Located share % |
| `minutes_est` / `minutes_quality` / `minutes_reasons` | Estimated minutes / Minutes quality / Minutes reasons |
| `state_winning` / `state_drawing` / `state_losing` | Events while winning / drawing / losing |
| `zone_dl` … `zone_ar` / `zone_unlocated` | (zone name via B.1 map) / Unlocated events |
| … | (full table maintained in the glossary sheet, not duplicated here) |

---

## Part C — Compatibility contract

### C.1 Once Sport boundary (cited)

`docs/spatial-heatmap-specification.md` (lines 310, 460): **"Once Sport owns
VIDEO → CLIPS → PLAYER MEETINGS; PitchLog owns the DATA side."** PitchLog's
CSVs are the hand-off surface for that division of labor.

### C.2 MUST-NOT-CHANGE columns (name, position, value format)

Columns that plausibly feed an Once Sport import keyed on **start/end time +
action name** — frozen exactly as they are today:

| Export | Frozen columns | Why |
|---|---|---|
| clip_playlist | `start_timecode`, `end_timecode`, `label`, `filename` (+ the entire `cut_clips.bat` contract: ffmpeg command shape, CRLF, BOM-free) | A clip list is (start, end, action name, output file); the .bat must keep executing |
| match-events / season-events | `timecode`, `seconds`, `end_timecode`, `end_seconds`, `label` | Event start/end time + action name for event-level imports |
| match-events-full-analysis | `Label`, `Category`, `Event` (all carry the action name), `Match Seconds`, `Match Time`, `Video Time` | Same event-level import surface; `Category`/`Event` duplicate `Label` and must keep doing so |

Frozen means: no rename, no reorder, no format change (including the
`HH:MM:SS.t` timecode rendering and the numeric second columns), no value
vocabulary change. Readable mirror columns (B.3) may only be appended AFTER
the frozen set, never interleaved.

**Caveat (see E1):** the repo contains no explicit Once Sport import-format
document — the set above is the conservative superset inferred from the task
book ("start/end time, action name") and the Once Sport ownership split. If
the actual Once Sport import consumes different columns, this contract must
be re-frozen by an architect decision, not extended silently.

### C.3 Additive-only rule (all other changes)

Everything not frozen in C.2 may change **additively only**: new columns
appended at the end, new files (glossary sheet), new documentation. Never:
renaming an existing header, reordering columns, changing a value's format
or vocabulary in place, removing a column, or changing the R2-A
filename/BOM/toast/empty-guard behavior.

Additionally frozen by prior, still-binding contracts (echo of the task
book's constraints):

- season-player: the **63-column contract** (PSD-V2 §8.2,
  `player-season-data-specification.md` lines 474-476) — no appends, no
  `row_type` column (two-sentinel labeling is the explicit row distinction).
- full-analysis: the 36-column **legacy quirk semantics** pinned by R1 tests
  (C22): `Category` = `Event` = `Label`, legacy `Outcome` = qualifiers,
  `Phase`/`Note`/`Created At`/`Updated At` empty, `Secondary Player ID` =
  playerOffId.
- schema v4 (event/session JSON), the analytics engines, and the autosave
  pipeline: outside the export layer entirely.

---

## Part D — Gaps in the existing dictionary

Each gap is a candidate for a future dictionary doc update (separate,
doc-only commit — not fixed now, per the STOP rules):

1. **No machine-value dictionaries.** The dictionary documents formats and
   column orders, but no machine-key → readable-label tables (B.1 fills
   this; it should be folded into the dictionary or shipped as the glossary
   sheet).
2. **`participation_status` enum wrong** (A.2-1) — six real statuses missing,
   two claimed statuses never emitted.
3. **`x1_status` values unenumerated** (A.2-2).
4. **`minutes_reasons` codes unenumerated** (A.2-3).
5. **`state_suppressed` codes unenumerated** (A.2-4).
6. **Trigger labels vs actual button texts** (A.2-5).
7. **Tag vocabularies not listed:** the closed event-label set, per-tag
   subtypes, and qualifier groups/options (renderer.js:15-79) — readable
   but undocumented as vocabularies.
8. **Event-appropriate outcome display words** (`OUTCOME_DISPLAY`,
   renderer.js:102-106) and the Pass qualifier-outcome mechanism
   (renderer.js:94-97) are not documented in the dictionary.
9. **No glossary artifact ships WITH exports** — the dictionary is a repo
   doc; the Excel analyst who receives only the CSV has no value
   dictionary on disk (B.4 proposes the fix).
10. **The Once Sport data boundary is not stated in the dictionary** — it
    lives only in `docs/spatial-heatmap-specification.md`; the export
    dictionary should reference it (and this spec's Part C) so the frozen
    columns are discoverable from the export documentation itself.
11. **`PERIOD_LABELS` readable mapping exists in-app** (renderer.js:130-134)
    **but is not surfaced** anywhere in export documentation.

---

## Part E — Open questions needing architect decision

1. **Once Sport import format.** No in-repo document specifies which
   columns Once Sport actually consumes (only the ownership split,
   spatial-heatmap-spec.md:310,460). C.2 freezes the conservative superset
   (start/end time, action name, clip outputs). Confirm the real import
   column set — if narrower, C.2 can be relaxed; if wider, re-freeze via an
   explicit decision. Until then, treat every C.2 column as frozen.
2. **Appended readable columns displace pinned invariants.** R1 pinned
   `outcome` as the FINAL column of match-events/season-events (and the
   source comments say so, renderer.js:4346-4347); R1 test C22 pins the
   full-analysis 36-column semantics. B.3's appends move those boundaries.
   Options: (a) append + update the test pins in the same implementation
   commit; (b) ship separate readable export variants
   (e.g. `match-events-readable.csv`) leaving the existing exports
   byte-identical; (c) glossary-only, no column changes at all (zero
   contract risk, least Excel convenience). Recommendation: (a) for
   match-events/season-events, (b) or (c) for full-analysis, (c)-equivalent
   (glossary only) for season-player — but this is an architect call.
3. **Season-player readable companion.** The 63-column contract forbids
   appends. If analysts need readable participation/minutes cells, decide
   whether a NEW companion export (e.g. `season-player-readable.csv`, same
   rows, translated cells, no contract) is wanted, or whether the glossary
   sheet suffices.
4. **mm:ss details.** Truncate vs round tenths (proposal: truncate); exact
   column names (`clock_mmss` vs `match_clock`); and whether season-events
   should carry both match-clock and video-clock readables (today only the
   match clock is exported; video time exists only in full-analysis).
5. **Glossary sheet delivery** (B.4): automatic sidecar next to every
   export (recommended), separate button, or repo-docs only; and its
   filename (`pitchlog-data-dictionary.csv` proposed).
6. **`—` vs empty for readable outcome cells.** The task book suggests
   `Success/Failure/—`; the empty-means-unknown discipline argues for
   keeping empty. Proposal: `—` ONLY in dedicated `*_label` readable
   columns (visually explicit), empty everywhere machine columns are read.
   Confirm.
7. **Readable label language.** English only, or Amharic variants? Player
   and opponent names are already Unicode (Amharic preserved); the proposed
   value labels are English. A second label column per language would
   double the readable layer — decide before implementation.
8. **Dictionary corrections (A.2) application.** The five corrections are
   recorded here; applying them to `docs/export-data-dictionary.md` is a
   separate doc-only commit that must keep the r2b dictionary-contract
   tests green (they pin column orders, not value notes — the
   participation_status note fix should be safe, but verify).

---

*Deliverable per the R2-EXREAD task book: this commit contains ONLY this
document. No source, test, or UI files are modified.*
