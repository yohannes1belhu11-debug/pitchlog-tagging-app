# PitchLog — Export Data Dictionary

**Status:** authoritative reference for every CSV file PitchLog writes to disk.
**Audience:** Excel analysis, reports, charts, and the future AI report layer.
**Introduced:** R2-B (data quality & analysis readiness). Baseline commit `2247a07` (R2-A export hygiene) for filename/BOM/feedback behavior.

This document is the single source of truth for the five CSV outputs. Each
export section contains a fenced `json` schema block whose `columns` array
gives the **exact column order** — the regression harness
(`tests/r2b-data-quality-check.js`) validates every block against the real
export builders, so this document cannot drift from the implementation.

---

## 1. Shared conventions (all five CSVs)

| Convention | Value |
|---|---|
| Encoding | UTF-8 **with BOM** (`EF BB BF`) — added at file-write time only, so Excel double-click-open decodes Amharic/Unicode correctly. The BOM is an encoding marker: escaping, column order, and every cell are byte-identical with or without it. |
| Line endings | LF only. No trailing newline after the last row. |
| Escaping (`csvEscape`) | A cell is quoted `"…"` iff it contains a comma, a double quote, or a newline; internal double quotes are doubled (`""`). Otherwise the cell is written raw. |
| Null discipline | Unavailable values (null / missing / non-applicable) are **empty cells — never `0`, never invented text**. An empty numeric cell means "unknown/not applicable", not zero. |
| Numbers | `.` decimal separator, no thousands separators. Counts are integers; durations, minutes and percentages carry 1 decimal. |
| Booleans | `TRUE` / `FALSE` (empty when unknown). |
| Dates | ISO `YYYY-MM-DD` (from the match setup date picker) or empty. |
| Timecodes | `HH:MM:SS.t` — elapsed match clock, tenths included. `00:00:10.5` = 10.5 seconds in. |
| Row order | Events in logged order; player rows follow the engine's deterministic order (see each section). |

**Excel import notes (important):**

- **Timecode cells** (`00:45:30.5`) — Excel may auto-convert them to time-of-day
  values on open. If you need the literal string, import the column as Text
  (Data → Get Data → CSV, set the column type to Text), or use the paired
  numeric `seconds` / `end_seconds` / `duration_seconds` columns instead.
- **`player_number`** is text, because squad numbers may have leading zeros
  (`07`) or be non-numeric. Excel may strip leading zeros on open — the same
  Text-import advice applies if that matters to you.
- The BOM at the start of the file is invisible in a proper CSV reader and is
  what makes Excel decode the file as UTF-8 rather than mangle Amharic.

**For machine / AI consumption:** parse with any RFC-4180-style CSV reader that
honors doubled quotes; treat an empty cell as `null` (NOT zero); `TRUE`/`FALSE`
are uppercase literals; all metrics that appear pre-computed (season-player
counts, percentages) must be consumed as-is — they follow the rounding and
null rules of `docs/metric-specification.md` §12 and must not be re-derived
from raw events without reading that spec.

---

## 2. The five exports at a glance

| # | Export | Trigger in the app | Suggested file name | One row per | Columns |
|---|---|---|---|---|---|
| 1 | match-events | "Export CSV" click | `match-events_<date>_vs_<opponent>.csv` | event (current match) | 19 |
| 2 | match-events-full-analysis | "Export CSV" **Shift+Click** | `match-events-full-analysis_<date>_vs_<opponent>.csv` | event (current match) | 36 |
| 3 | season-events | Season view → "Export season events" | `season-events.csv` | event (all loaded season matches) | 20 |
| 4 | season-player | Season view → "Export season player CSV" | `season-player.csv` | player×match, plus one SEASON_SUMMARY row per player | 63 |
| 5 | clip_playlist | "Export Clips" → confirm | `clip_playlist.csv` (+ companion `cut_clips.bat`) | event (current match, as video clips) | 7 |

Filenames are suggestions in the native save dialog — the user picks the real
location and name; Windows-invalid characters in the metadata part are
replaced with `_` (Unicode, including Amharic, is preserved). Match exports
carry `date`+`opponent` from the session; season/clip exports stay plain.

**Join model between the exports:**

- `season-events.match` uses the same match label string as the season view
  (`vs <opponent> · Home|Away|Neutral · <our>–<opp> · <date>`), and
  `season-player.match_key` carries that same label — so **season-events and
  season-player join on the match label** (`match` = `match_key`), plus
  `player_name`/`player_number` within the match.
- `match-events-full-analysis`'s `Match ID` column uses a different,
  compact format: `<date>_<opponent with spaces→_>`. It identifies a single
  match's own export; to line it up with season data, join on
  `Date` + `Opponent` instead.
- `player_id` values are **per squad file** (every squad has its own
  `player_1`, `player_2`, …). Within one season load the engine already
  canonicalizes identity (name-drift and possible-duplicate persons are
  flagged in the season view, never silently merged). Do not join on raw ids
  across independently saved squads.

---

## 3. match-events — standard event log (19 columns)

One row per tagged event of the **current** match, in logged order. Player
names/numbers resolve against the current session's squad; a reference to a
player not in the squad leaves the cells empty.

```json
{
  "export": "match-events",
  "scope": "current match",
  "rows": "one per tagged event, logged order",
  "columns": [
    { "name": "timecode", "type": "timecode", "empty": "never", "notes": "elapsed match clock HH:MM:SS.t" },
    { "name": "seconds", "type": "decimal", "empty": "never", "notes": "same instant as timecode, numeric (1 decimal)" },
    { "name": "end_timecode", "type": "timecode", "empty": "never", "notes": "event end; equals timecode for instant events" },
    { "name": "end_seconds", "type": "decimal", "empty": "never" },
    { "name": "duration_seconds", "type": "decimal", "empty": "never", "notes": "end-start for intervals (e.g. Possession), 0 for instants" },
    { "name": "label", "type": "text", "empty": "never", "notes": "the tag label (Shot, Pass, Possession, …)" },
    { "name": "side", "type": "code", "empty": "when no team chosen", "notes": "for = our team, against = opponent" },
    { "name": "player_number", "type": "text", "empty": "when unattributed/unknown" },
    { "name": "player_name", "type": "text", "empty": "when unattributed/unknown" },
    { "name": "player_off_number", "type": "text", "empty": "non-Sub events", "notes": "player going off (Sub events)" },
    { "name": "player_off_name", "type": "text", "empty": "non-Sub events" },
    { "name": "player_on_number", "type": "text", "empty": "non-Sub events", "notes": "player coming on (Sub events)" },
    { "name": "player_on_name", "type": "text", "empty": "non-Sub events" },
    { "name": "subtype", "type": "text", "empty": "when not set", "notes": "e.g. Yellow (Card), one-word detail" },
    { "name": "qualifiers", "type": "text", "empty": "when none set", "notes": "key: value pairs joined with '; '" },
    { "name": "location_zone", "type": "text", "empty": "unlocated events", "notes": "'Third · Channel', e.g. 'Attacking third · Central channel'" },
    { "name": "location_x", "type": "decimal", "empty": "unlocated events", "notes": "0–1 scale, 3 decimals" },
    { "name": "location_y", "type": "decimal", "empty": "unlocated events", "notes": "0–1 scale, 3 decimals" },
    { "name": "outcome", "type": "code", "empty": "null/absent/not applicable", "notes": "SUCCESS or FAILURE — recorded for Duel, Press, Turnover, Cross (R1 schema v4)" }
  ]
}
```

Notes:

- `location_x`/`location_y` are the **0–1 pitch-normalized** coordinates
  (origin at the pitch corner). The full-analysis export scales the same
  coordinates to **0–100** — do not mix the two without converting.
- The `outcome` column is the R1 first-class outcome; it is `SUCCESS`/`FAILURE`
  and only meaningful for the four outcome-applicable labels. Empty means "no
  outcome recorded", never "failed".

---

## 4. match-events-full-analysis — expanded per-event analysis sheet (36 columns)

One row per tagged event of the **current** match, in logged order, enriched
with match metadata, score context, period/sequence fields and coordinates.
Same trigger button as the standard export, but **Shift+Click**.

```json
{
  "export": "match-events-full-analysis",
  "scope": "current match",
  "rows": "one per tagged event, logged order",
  "columns": [
    { "name": "Match ID", "type": "text", "empty": "when no date set", "notes": "<date>_<opponent>, spaces→_ ; identifies this match's export" },
    { "name": "Date", "type": "date", "empty": "when unset" },
    { "name": "Competition", "type": "text", "empty": "when unset" },
    { "name": "Home Team", "type": "text", "empty": "never", "notes": "'Us' when we are home, else the opponent name" },
    { "name": "Away Team", "type": "text", "empty": "never", "notes": "'Us' when we are away, else the opponent name" },
    { "name": "Opponent", "type": "text", "empty": "when unset" },
    { "name": "Period", "type": "code", "empty": "when unset", "notes": "PRE_MATCH, 1H, HT, 2H, FT, ET1, ET_HT, ET2" },
    { "name": "Official Minute", "type": "int", "empty": "when unset", "notes": "referee's clock minute" },
    { "name": "Second", "type": "int", "empty": "when unset", "notes": "second within the official minute" },
    { "name": "Match Seconds", "type": "int", "empty": "when unset", "notes": "elapsed match-clock seconds" },
    { "name": "Match Time", "type": "decimal", "empty": "when unset", "notes": "elapsed match time, 1 decimal" },
    { "name": "Video Time", "type": "decimal", "empty": "no video loaded", "notes": "position in the video file" },
    { "name": "Team", "type": "code", "empty": "when no team chosen", "notes": "our or opponent" },
    { "name": "Primary Player ID", "type": "id", "empty": "unattributed", "notes": "squad player id (player_N); ids are per squad file" },
    { "name": "Secondary Player ID", "type": "id", "empty": "non-Sub events", "notes": "KNOWN GAP: carries playerOffId only — the incoming player (playerOnId) is not in this legacy layout; use the standard export or season data for full Sub attribution" },
    { "name": "Category", "type": "text", "empty": "never", "notes": "KNOWN QUIRK: always equals the event label (legacy column)" },
    { "name": "Event", "type": "text", "empty": "never", "notes": "KNOWN QUIRK: always equals the event label (legacy column)" },
    { "name": "Label", "type": "text", "empty": "never", "notes": "the tag label — read this one" },
    { "name": "Subtype", "type": "text", "empty": "when not set" },
    { "name": "Outcome", "type": "text", "empty": "usually", "notes": "KNOWN QUIRK (legacy): serialized qualifiers 'k: v; …', NOT the R1 outcome — the real outcome is the final 'Event Outcome' column" },
    { "name": "Phase", "type": "text", "empty": "always", "notes": "KNOWN QUIRK: legacy placeholder, always empty" },
    { "name": "Pitch Zone", "type": "text", "empty": "unlocated events", "notes": "'Third · Channel'" },
    { "name": "X", "type": "decimal", "empty": "unlocated events", "notes": "0–100 scale, 1 decimal (NOT the 0–1 scale of the standard export)" },
    { "name": "Y", "type": "decimal", "empty": "unlocated events", "notes": "0–100 scale, 1 decimal" },
    { "name": "Third", "type": "text", "empty": "unlocated events", "notes": "Defensive / Middle / Attacking third" },
    { "name": "Channel", "type": "text", "empty": "unlocated events", "notes": "Left / Central / Right channel" },
    { "name": "Score For Before", "type": "int", "empty": "never", "notes": "defaults to 0" },
    { "name": "Score Against Before", "type": "int", "empty": "never", "notes": "defaults to 0" },
    { "name": "Score For After", "type": "int", "empty": "non-goal events", "notes": "goal events only" },
    { "name": "Score Against After", "type": "int", "empty": "non-goal events" },
    { "name": "Score State", "type": "code", "empty": "never", "notes": "WINNING / DRAW / LOSING — state BEFORE the event" },
    { "name": "Sequence ID", "type": "code", "empty": "outside sequences", "notes": "SEQ-### (match-clock sequence grouping)" },
    { "name": "Note", "type": "text", "empty": "always", "notes": "KNOWN QUIRK: legacy placeholder, always empty" },
    { "name": "Created At", "type": "text", "empty": "always", "notes": "KNOWN QUIRK: legacy placeholder, always empty" },
    { "name": "Updated At", "type": "text", "empty": "always", "notes": "KNOWN QUIRK: legacy placeholder, always empty" },
    { "name": "Event Outcome", "type": "code", "empty": "null/absent/not applicable", "notes": "SUCCESS or FAILURE (R1 first-class outcome) — this is the real outcome column" }
  ]
}
```

The four KNOWN QUIRK columns are legacy layout decisions pinned by the R1
tests (`tests/r1-outcome-check.js` C22): `Category`/`Event` duplicate `Label`,
the legacy `Outcome` column carries qualifiers, and `Phase`/`Note`/`Created
At`/`Updated At` are always empty. They are documented here rather than
changed — changing them would alter the pinned 36-column semantics. Read
`Label` + `Subtype` + `Event Outcome`, never `Category`/`Outcome`.

---

## 5. season-events — multi-match event dump (20 columns)

One row per tagged event across **all loaded season matches**, matches in
season order (date/saved-at), events in logged order within each match. The
first column identifies the match; the remaining 19 are identical in name,
order and format to the match-events export.

**Since R2-B**, the player cells of each match's rows resolve against **that
match's own squad** (the squad saved inside its session file) — not the live
session's squad. Unresolved references stay empty.

```json
{
  "export": "season-events",
  "scope": "all loaded season matches",
  "rows": "one per tagged event; matches in season order, events in logged order",
  "columns": [
    { "name": "match", "type": "text", "empty": "never", "notes": "match label 'vs <opponent> · Home|Away|Neutral · <our>–<opp> · <date>' — same string as season-player's match_key; '(Match with no details set)' fallback" },
    { "name": "timecode", "type": "timecode", "empty": "never" },
    { "name": "seconds", "type": "decimal", "empty": "never" },
    { "name": "end_timecode", "type": "timecode", "empty": "never" },
    { "name": "end_seconds", "type": "decimal", "empty": "never" },
    { "name": "duration_seconds", "type": "decimal", "empty": "never" },
    { "name": "label", "type": "text", "empty": "never" },
    { "name": "side", "type": "code", "empty": "when no team chosen" },
    { "name": "player_number", "type": "text", "empty": "unattributed/unknown", "notes": "resolved from THIS match's own squad (R2-B)" },
    { "name": "player_name", "type": "text", "empty": "unattributed/unknown", "notes": "resolved from THIS match's own squad (R2-B)" },
    { "name": "player_off_number", "type": "text", "empty": "non-Sub events" },
    { "name": "player_off_name", "type": "text", "empty": "non-Sub events" },
    { "name": "player_on_number", "type": "text", "empty": "non-Sub events" },
    { "name": "player_on_name", "type": "text", "empty": "non-Sub events" },
    { "name": "subtype", "type": "text", "empty": "when not set" },
    { "name": "qualifiers", "type": "text", "empty": "when none set" },
    { "name": "location_zone", "type": "text", "empty": "unlocated events" },
    { "name": "location_x", "type": "decimal", "empty": "unlocated events", "notes": "0–1 scale, 3 decimals" },
    { "name": "location_y", "type": "decimal", "empty": "unlocated events", "notes": "0–1 scale, 3 decimals" },
    { "name": "outcome", "type": "code", "empty": "null/absent/not applicable", "notes": "SUCCESS or FAILURE (R1)" }
  ]
}
```

The score part of the match label uses an en dash (`–`), the separators are
`·` (middle dot). Both are plain text inside a properly quoted CSV cell only
when they contain a comma — they never do — so they appear raw.

---

## 6. season-player — player×match season sheet (63 columns)

Full specification: `docs/player-season-data-specification.md` §8.2
(PSD-V2). One row per player×match (match rows first, in season order) plus
one **SEASON_SUMMARY** row per player immediately after that player's match
rows; players ordered by appearances desc → total events desc → player id.

SEASON_SUMMARY rows are labeled by **two sentinels**: `match_key` = `SEASON_SUMMARY`
and `participation_status` = `SEASON_SUMMARY`. Their per-match context columns
(date/opponent/competition/home_away/result/x1_status) and per-match
participation columns (started…sent_off) are empty; totals, percentages,
spatial, period and state cells are pooled season rollups — never averages of
percentages. `minutes_est` is the season estimated-minutes rollup.

```json
{
  "export": "season-player",
  "scope": "all loaded season matches",
  "rows": "player-major: match rows in season order, then that player's SEASON_SUMMARY row",
  "columns": [
    { "name": "match_key", "type": "text", "empty": "never", "notes": "match label, or the SEASON_SUMMARY sentinel" },
    { "name": "date", "type": "date", "empty": "summary rows / unset" },
    { "name": "opponent", "type": "text", "empty": "summary rows / unset" },
    { "name": "competition", "type": "text", "empty": "summary rows / unset" },
    { "name": "home_away", "type": "code", "empty": "summary rows / unset", "notes": "home / away / neutral" },
    { "name": "result", "type": "code", "empty": "summary rows / no final score", "notes": "'W 2-1' / 'D 1-1' / 'L 0-2'" },
    { "name": "x1_status", "type": "code", "empty": "summary rows", "notes": "score-chain status; MISMATCH flags an inconsistent goal chain" },
    { "name": "player_id", "type": "id", "empty": "never", "notes": "engine-canonical player id" },
    { "name": "player_name", "type": "text", "empty": "never", "notes": "season canonical name (drift is flagged, never merged)" },
    { "name": "player_number", "type": "text", "empty": "no number" },
    { "name": "participation_status", "type": "code", "empty": "never", "notes": "STARTED / SUB_ON / SUB_OFF / UNUSED / UNKNOWN — or the SEASON_SUMMARY sentinel" },
    { "name": "started", "type": "bool", "empty": "summary rows" },
    { "name": "subbed_on", "type": "bool", "empty": "summary rows" },
    { "name": "subbed_on_min", "type": "decimal", "empty": "summary rows / not subbed on", "notes": "minute of coming on, 1 decimal" },
    { "name": "subbed_off", "type": "bool", "empty": "summary rows" },
    { "name": "subbed_off_min", "type": "decimal", "empty": "summary rows / not subbed off" },
    { "name": "sent_off", "type": "bool", "empty": "summary rows" },
    { "name": "minutes_est", "type": "decimal", "empty": "no minutes evidence", "notes": "estimated minutes (reliable+estimated), 1 decimal — never official minutes" },
    { "name": "minutes_quality", "type": "code", "empty": "never", "notes": "RELIABLE / ESTIMATED / UNAVAILABLE" },
    { "name": "minutes_reasons", "type": "text", "empty": "no reasons", "notes": "engine reason codes joined with ';'" },
    { "name": "goals", "type": "int", "empty": "no tagged data" },
    { "name": "shots", "type": "int", "empty": "no tagged data" },
    { "name": "shots_on_target", "type": "int", "empty": "no tagged data" },
    { "name": "chances", "type": "int", "empty": "no tagged data" },
    { "name": "key_passes", "type": "int", "empty": "no tagged data" },
    { "name": "crosses", "type": "int", "empty": "no tagged data" },
    { "name": "passes", "type": "int", "empty": "no tagged data" },
    { "name": "pass_success_pct", "type": "decimal", "empty": "no pass outcome data", "notes": "pooled %, 1 decimal — not an average of per-match %" },
    { "name": "presses", "type": "int", "empty": "no tagged data" },
    { "name": "press_wins", "type": "int", "empty": "no tagged data" },
    { "name": "interceptions", "type": "int", "empty": "no tagged data" },
    { "name": "recoveries", "type": "int", "empty": "no tagged data" },
    { "name": "turnovers", "type": "int", "empty": "no tagged data" },
    { "name": "duels", "type": "int", "empty": "no tagged data" },
    { "name": "fouls", "type": "int", "empty": "no tagged data" },
    { "name": "yellow_cards", "type": "int", "empty": "no tagged data" },
    { "name": "red_cards", "type": "int", "empty": "no tagged data" },
    { "name": "transitions_positive", "type": "int", "empty": "no tagged data" },
    { "name": "transitions_negative", "type": "int", "empty": "no tagged data" },
    { "name": "positive_events", "type": "int", "empty": "no tagged data" },
    { "name": "negative_events", "type": "int", "empty": "no tagged data" },
    { "name": "events_total", "type": "int", "empty": "no tagged data" },
    { "name": "located_events", "type": "int", "empty": "no tagged data" },
    { "name": "unlocated_events", "type": "int", "empty": "no tagged data" },
    { "name": "located_share_pct", "type": "decimal", "empty": "no located data" },
    { "name": "events_1h", "type": "int", "empty": "no tagged data" },
    { "name": "events_2h", "type": "int", "empty": "no tagged data" },
    { "name": "events_et1", "type": "int", "empty": "no tagged data" },
    { "name": "events_et2", "type": "int", "empty": "no tagged data" },
    { "name": "state_winning", "type": "int", "empty": "suppressed/no data", "notes": "events while WINNING; suppressed when a match's score chain is inconsistent" },
    { "name": "state_drawing", "type": "int", "empty": "suppressed/no data" },
    { "name": "state_losing", "type": "int", "empty": "suppressed/no data" },
    { "name": "state_suppressed", "type": "code", "empty": "not suppressed", "notes": "e.g. X1_MISMATCH_SUPPRESSED" },
    { "name": "zone_dl", "type": "int", "empty": "no located data", "notes": "Defensive third · Left channel" },
    { "name": "zone_dc", "type": "int", "empty": "no located data" },
    { "name": "zone_dr", "type": "int", "empty": "no located data" },
    { "name": "zone_ml", "type": "int", "empty": "no located data" },
    { "name": "zone_mc", "type": "int", "empty": "no located data" },
    { "name": "zone_mr", "type": "int", "empty": "no located data" },
    { "name": "zone_al", "type": "int", "empty": "no located data" },
    { "name": "zone_ac", "type": "int", "empty": "no located data" },
    { "name": "zone_ar", "type": "int", "empty": "no located data" },
    { "name": "zone_unlocated", "type": "int", "empty": "no tagged data" }
  ]
}
```

Metric definitions, the null discipline, and the exact 63-column contract are
pinned by `docs/player-season-data-specification.md` and
`tests/season-csv-check.js`; this section mirrors the column list for
completeness. `state_winning/drawing/losing` columns hold **event counts**
while in that score state (not booleans).

---

## 7. clip_playlist — video clip reference sheet (7 columns) + cut_clips.bat

Written together by "Export Clips": the CSV is the human/machine reference for
the clip reel; the `.bat` (CRLF line endings, ASCII, **no BOM** — cmd.exe
requires that) runs ffmpeg to cut and merge the clips. One row per event, in
logged order; clip timestamps include the pre/post-roll values chosen in the
modal and are clamped to the video duration.

```json
{
  "export": "clip_playlist",
  "scope": "current match (requires a loaded video)",
  "rows": "one per tagged event, logged order",
  "columns": [
    { "name": "clip", "type": "int", "empty": "never", "notes": "1-based clip number" },
    { "name": "label", "type": "text", "empty": "never", "notes": "event label, full Unicode (Amharic preserved)" },
    { "name": "details", "type": "text", "empty": "often", "notes": "human summary: '#10 Name · Subtype · Won · qualifier values · 📍 Zone'" },
    { "name": "start_timecode", "type": "timecode", "empty": "never", "notes": "clip start incl. pre-roll (video clock)" },
    { "name": "end_timecode", "type": "timecode", "empty": "never", "notes": "clip end incl. post-roll, clamped to video duration" },
    { "name": "duration_seconds", "type": "decimal", "empty": "never", "notes": "end-start, 1 decimal" },
    { "name": "filename", "type": "text", "empty": "never", "notes": "clip_NNN_<sanitized-label>.mp4 — ASCII-ONLY (non-ASCII labels collapse to '_' and may fall back to 'event'); Unicode lives in the label/details columns, not the file name" }
  ]
}
```

Since R2-B the CSV is written UTF-8 **with BOM** (same convention as the other
exports); the `.bat` deliberately is not.

---

## 8. Data quality — what PitchLog already checks for you

The season view shows a **Data quality** panel computed from the same loaded
matches you export. Warnings (never silently applied):

- Duplicate/identity — a file loaded twice is **excluded** from totals;
  look-alike matches (same save timestamp or same label) are flagged, never
  merged.
- Starting XI missing/incomplete → participation "unknown" for non-starters.
- No full-time marker → minutes fall back to estimates (never per-90).
- Score-chain inconsistency (X1 MISMATCH) → result flagged, score-state
  partitions suppressed for that match.
- Missing date/opponent metadata.
- Substitution attribution noise (opponent-team subs referencing our players).
- Player name drift (same id, different names across matches — one identity,
  flagged) and possible duplicate persons (different ids, same name — never
  merged).

Minutes quality across records is summarized (reliable / estimated /
unavailable). Treat these gates as the completeness caveat for any analysis:
the CSV cells follow the empty-means-unknown discipline, so pivot tables that
count blanks are counting genuinely missing evidence.

## 9. Known limitations (deliberate, documented, not bugs)

- The four legacy full-analysis quirks (see §4): `Category`/`Event` duplicate
  `Label`, legacy `Outcome` holds qualifiers, `Phase`/`Note`/`Created At`/
  `Updated At` always empty, and `Secondary Player ID` carries only the
  outgoing player. Pinned by R1 tests; changing them would break the frozen
  36-column contract.
- Coordinate scale differs: 0–1 in match-events/season-events, 0–100 in
  match-events-full-analysis (X/Y columns).
- Recent Form trends (docs/recent-form-trends-specification.md) are view-only
  in the app — not exported.
- `SEASON_SUMMARY` rows carry no explicit row_type column — the two sentinels
  (`match_key`, `participation_status`) are the labeling (deferred: a
  row_type column would break the pinned 63-column contract).
- Clip file names are ASCII-only (ffmpeg/batch safety); Unicode is preserved
  in the CSV's label/details columns.
- The native save-dialog experience (name pre-fill, overwrite prompt, error
  boxes) is Electron-level and outside the automated harnesses.
