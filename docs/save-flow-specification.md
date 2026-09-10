# PitchLog — Save-Flow Specification

**Task ID:** R2-C-SPEC-D4
**Status:** PROPOSED SPECIFICATION — no implementation. This document changes
no source, no tests, no UI, no schema. It records the verified current state
(Part A), rates its risks (Part B), proposes a target design in prose
(Part C), and surfaces every decision this codebase and its precedents
cannot settle (Parts D and E).
**Baseline:** `ca0a13a` (D3 architect rulings recorded as spec Part F). All
source citations below are line numbers at this commit. Note: local repo
config now carries `core.filemode=false` per architect decision D4-a
(environment-side mode flapping); repo content is byte-identical to
`ca0a13a` and the config is local-only, never committed.
**Companion documents:** `docs/export-readability-specification.md` (export
contracts, Part F rulings), `docs/export-data-dictionary.md` (per-column
export reference), `docs/pitchlog-data-dictionary.csv` (glossary of record),
and `docs/player-season-data-specification.md` (PSD — session files as the
unit of truth). This spec cross-references them; it does not duplicate them.

**Constraints (all honored by this being a doc-only commit):** schema v4
untouched; analytics untouched; autosave behavior untouched; R2-A export
filename/BOM behavior untouched; Season Player 63-column contract untouched;
R1 outcome-last-column invariant untouched; D2-0 consumer-contracts-win
(Part F of the readability spec) respected throughout; no new dependencies;
Part C is prose, not code.

---

## Part 0 — Scope discovery: what "save flow" concretely covers here

The backlog gives R2-C only the name ("the save flow — persistence of match
data from entry to export-ready storage"). Reading the code, the term maps
to **three distinct persistence layers**, which this document treats as the
scope of R2-C:

1. **The current-match session layer** (the core): every mutation of the
   working session (events, tags, squad, matchInfo, matchClock, videoPath),
   the debounced autosave safety net at `userData/autosave.json`, the
   manual "Save session" / "Load session" file flows, the squad roster's
   own always-persisted file at `userData/squad.json`, the crash/close/
   recovery protection around all of it. (renderer.js:4473–5139, main.js
   file/autosave/squad handlers.)
2. **The season-view consumption layer** (read-only over saved files): the
   season modal loads previously *saved* session .json files into an
   in-memory list; nothing there ever persists. It is the downstream
   consumer that gives saved files their value. (renderer.js:2988–3027,
   3889–3909.)
3. **The export write layer** (the handoff): where working state becomes
   deliverable files. Exports serialize *in-memory* state at click time and
   write via the main-process dialog+BOM writers; they never read the
   autosave file. (renderer.js:3958–3973, 4304–4471; main.js:420–466.)

Layer boundaries worth naming precisely (evidence in Part A): there is **no
browser storage at all** (zero occurrences of localStorage, sessionStorage,
or IndexedDB in `src/`), **no backend endpoint**, and **no network I/O** —
all persistence is local files reached through the Electron IPC bridge
(preload.js:3–31). "Offline behavior" is therefore the only behavior; there
is nothing to synchronize. "Multi-tab" does not exist (single BrowserWindow;
the only second window is the detached video window, which carries no
session state — detached-video.js is 60 lines of transport relaying). What
*does* exist and is unplanned-for is **multi-instance** (two app processes
sharing the same `userData` directory — main.js:60–68 has no
`requestSingleInstanceLock`); Part B rates it.

---

## Part A — Current-state inventory (verified at ca0a13a)

### A.1 The persistence surface (IPC bridge)

Every renderer→disk path goes through `src/preload.js` (`window.matchtag`):

| Bridge method | IPC channel | Direction | Purpose | preload.js |
|---|---|---|---|---|
| `saveSession(data)` | `file:saveSession` | invoke | manual session save (JSON, user-chosen path) | :5 |
| `loadSession()` | `file:loadSession` | invoke | manual session load | :10 |
| `loadMultipleSessions()` | `file:loadMultipleSessions` | invoke | season view: load N session files | :11 |
| `loadSquad()` / `saveSquad(s)` | `squad:load` / `squad:save` | invoke | squad roster persistence (fixed path) | :12–13 |
| `autosaveRead()` | `autosave:read` | invoke | startup recovery check | :20 |
| `autosaveWrite(data)` | `autosave:write` | invoke | debounced autosave write | :21 |
| `autosaveDelete()` | `autosave:delete` | invoke | clear autosave after save/load/discard | :22 |
| `autosaveFlushSync(data)` | `autosave:flush-sync` | **sendSync** | beforeunload synchronous flush | :23–25 |
| `onCloseRequested(cb)` / `closeProceed()` | `close:requested` / `close:proceed` | event/send | safe-close handshake | :26–30 |
| `exportCsv(csv, name)` | `file:exportCsv` | invoke | CSV export write (BOM layer) | :8 |
| `exportClipPlaylist({csv,script})` | `file:exportClipPlaylist` | invoke | clip CSV + .bat folder write | :9 |

### A.2 Every save/persistence trigger

**A.2.1 Autosave (the safety net).**
- Root cause: `setDirty()` — renderer.js:4576–4584 — called from **every**
  state mutation point; legacy alias `markAutosaveDirty()` delegates to it
  (renderer.js:4646–4647). Mutation sites (all verified):
  - event log / interval finish / undo / event delete: renderer.js:1149,
    1121, 1239, 1996;
  - detail-panel edits (outcome & qualifier chips, timing nudges, set-to-
    playhead ×3, pitch location, clear location): renderer.js:1659, 1680,
    1691, 1703, 1713, 1727, 1738;
  - touchline corrections: renderer.js:1659–1738 region (same handlers) and
    touchline pitch tap: 5601;
  - custom tag creation: renderer.js:1805;
  - match setup (formation change, save-match-info): renderer.js:590, 605;
  - starting-XI slot changes: renderer.js:564;
  - squad add (bulk) and squad remove: renderer.js:474, 439 (each *also*
    persists squad.json immediately — see A.2.3);
  - video load: renderer.js:652 (inside `loadVideoFromPath`, 636–653);
  - match clock start/pause/end-half/next-half: renderer.js:198, 206, 219,
    229; team/player selection: 5180–5181; sequence start/end: 5185, 5190;
    video sync offset: 5224;
  - recovery restore (recovered work is deliberately dirty):
    renderer.js:4999.
- Debounce: `scheduleAutosave()` (renderer.js:4651–4667) clears any armed
  timer and re-arms `setTimeout(performAutosave, AUTOSAVE_DEBOUNCE_MS)`
  with **1500 ms** (renderer.js:4526). This is a **trailing, full-reset
  debounce with no maximum-wait cap**: every new mutation postpones the
  write (the setDirty comment says so explicitly — renderer.js:4574–4575).
  The write is therefore guaranteed only after the *last* mutation plus
  1.5 s of quiet; during continuous sub-1.5-second tagging bursts no write
  lands at all (rated in Part B, risk B1).
- Gate: `hasAutosavableWork()` (renderer.js:4615–4633) — autosave only if
  events exist, a video is loaded, the tag set deviates from the 18 shipped
  defaults (`DEFAULT_TAGS_LENGTH`, renderer.js:15–85), matchInfo deviates
  from blank (489–494), or matchClock is non-default. Dirty-but-no-work
  instead triggers a *stale-file cleanup delete* (renderer.js:4654–4664 →
  `clearStaleAutosaveFile()`, 4674–4679).
- The write itself: `performAutosave()` (renderer.js:4684–4733) →
  `autosaveWrite` IPC → main's queued atomic write (main.js:729–738 →
  668–674). Failure surfaces as a toast + sticky error flags
  (renderer.js:4724–4732); the previous valid autosave file survives
  because the write is temp+rename atomic (main.js:559–567).

**A.2.2 beforeunload flush (the last line of defense).**
- `window.addEventListener('beforeunload', …)` → `flushAutosaveSync()`
  (renderer.js:5137–5139, 4771–4800). If dirty AND work-worthy, it calls
  the **synchronous** `autosaveFlushSync(data)` (preload.js:23–25,
  `ipcRenderer.sendSync` — the write completes before the renderer is torn
  down); otherwise it passes `null`, which *deletes* the autosave so a
  stale file can't offer a spurious recovery prompt (main.js:770–777).
- Flush failures are no longer silent (F1.3): main shows a native
  `dialog.showErrorBox` telling the analyst work may be lost
  (main.js:782–797), and the renderer consumes the `{ok:false}` result and
  paints the failure flags/toast if the window survives (renderer.js:
  4783–4799).
- Guard: the flush is skipped while the recovery modal is visible
  (renderer.js:4772) — close is *blocked* in that state anyway
  (renderer.js:5067–5071), so the autosave file survives for the next
  startup's recovery prompt.

**A.2.3 Squad roster persistence (independent, immediate, no debounce).**
- Every squad change (bulk add, remove, missing-player restore after load)
  calls `persistSquad()` (renderer.js:413–419) → `squad:save` → main wraps
  `{__schemaVersion, players}` and writes atomically to
  `userData/squad.json` (main.js:580–595, 538–540). Failure → toast
  (renderer.js:416). At startup the squad is loaded *before* the recovery
  check so recovery reconciles against it (renderer.js:5625–5646).
- Note the dual-write: the squad is persisted immediately (own file) *and*
  embedded as a snapshot in every session/autosave payload
  (renderer.js:4103, 4600–4610).

**A.2.4 Manual "Save session" button.**
- `btnSaveSession` (index.html:56) → `saveSession()` (renderer.js:4102–
  4111, wiring 4113): payload `{videoPath, tags, events, squad, matchInfo,
  matchClock}` (4103) → main `file:saveSession` (main.js:361–388): save
  dialog (default `match-session.json`), stamps `__schemaVersion: 4` +
  `__savedAt` ISO-8601 (369–372), **atomic** temp+rename write (378 →
  `writeFileAtomic`, 559–567). On success the renderer marks the session
  clean and *deletes* the autosave (renderer.js:4108–4109) — the saved
  file becomes the source of truth. On write failure main shows a native
  error box and returns `{canceled: true, error}` — the session **stays
  dirty and the autosave stays intact** (main.js:380–387). User cancel of
  the dialog is indistinguishable from failure to the dirty flag (both
  `canceled: true`) except for the extra `error` field (382–387).

**A.2.5 Manual "Load session" button (with dirty guard).**
- `btnLoadSession` (index.html:55) → if `sessionDirty`, the load-confirm
  modal first (renderer.js:4266–4272, modal index.html:493–506; Cancel =
  keep everything untouched, 4287–4291; "Discard and load" = explicit
  accept, 4295–4300). The modal is deliberately **not** Escape-dismissable
  (index.html:486–492; the global Escape handler closes only the six
  non-guard modals — renderer.js:1811, 1815–1823).
- `doLoadSession()` (renderer.js:4123–4257): IPC load (main.js:471–503 —
  dialog, read, **migrate** 482, recompute `videoUrl`, probe `__videoExists`
  483–497; any error → native error box, renderer state untouched, 499–502)
  → renderer replaces tags/events/matchInfo/matchClock (clock **stopped**
  on load, 4198–4204), restores video if path still valid (4212), resets
  `nextEventId`/undo/filters, then `setClean()` + `clearAutosave()`
  (4230–4231) — the loaded file is the new source of truth. Squad
  reconciliation: the local squad wins; missing referenced players are
  restored *additively* from the embedded squad and persisted, remaining
  unresolvable references are warned (4145–4189, 4237–4256).

**A.2.6 Safe-close handshake (OS close / Alt+F4).**
- Main intercepts the window close (`mainWindow.on('close')` →
  `preventDefault` → sends `close:requested`, main.js:40–50, design comment
  27–37; `forceClose` flag breaks the loop, 38, 807–812).
- Renderer `handleCloseRequested()` (renderer.js:5066–5081): recovery
  modal up → block close; clean → `closeProceed()` immediately; dirty →
  the unsaved-changes modal (index.html:465–485) with three explicit
  choices: **Cancel** (stay open, 5083–5088), **Don't save** (setClean +
  delete autosave + proceed, 5090–5100), **Save** (run `saveSession()`; if
  the user cancels the save dialog the window *stays open* and remains
  dirty, 5102–5116). Proceeding sets `forceClose` and re-closes; the
  resulting beforeunload then flushes (clean → delete; hard-kill path →
  write) (renderer.js:5123–5136 comment).

**A.2.7 Startup recovery check.**
- Init sequence: `loadSquad()` **then** `checkForRecoverableAutosave()`
  (renderer.js:5625–5646, 4815–4824) → `autosaveRead` (main.js:692–724:
  missing file → null; unreadable/corrupt → **null with the file left on
  disk** for manual inspection, 719–723; valid → migrate + recompute
  videoUrl + `__videoExists`).
- The recovery modal (index.html:443–457) shows last-preserved time, video
  (with "file not found" warning), event count, and a **pre-recovery
  missing-player warning** computed against the live squad
  (renderer.js:4853–4870, using `window.Integrity.findMissingPlayerRefs`,
  integrity.js:40–58). **Recover** → `recoverFromAutosave()` (renderer.js:
  4899–5000): restores tags/events/matchInfo/video/clock (clock stopped,
  4983–4988), keeps the autosave file as a continued safety net, marks the
  session **dirty** (4999). **Discard** → `setClean()` + `clearAutosave()`
  — delete the file, start fresh (renderer.js:5014–5022).

**A.2.8 Triggers that do NOT exist (verified absent).**
- No autosave/flush on suspend/shutdown OS events (no `powerMonitor` use
  anywhere in src/).
- No periodic heartbeat save (the only timers are the 1.5 s debounce and
  the UI-only clock display interval, renderer.js:126–128 comment).
- No save on export (exports never touch the dirty flag or the autosave).
- No interval-start persistence: `startInterval()` records the start in
  the in-memory `activeIntervals` map only (renderer.js:973, 1010–1021) —
  it does **not** call `setDirty()` and `activeIntervals` is **not** in the
  autosave payload (renderer.js:4600–4610); on load/recovery it is reset to
  `{}` (renderer.js:4143, 4955). An in-flight interval is therefore
  unpersisted by design (risk B2).

### A.3 Storage targets (what actually exists)

| Target | Path | Format | Writer | Atomic? |
|---|---|---|---|---|
| Manual session file | user-chosen via save dialog (default `match-session.json`) | pretty-printed JSON, `__schemaVersion: 4`, `__savedAt` | main.js:361–388 | yes (temp+rename, 378) |
| Autosave safety net | `userData/autosave.json` (+ `.tmp`, + `.flush.tmp`) | same session shape + `__savedAt` (double-stamped — renderer 4602, main overwrites 660–663/669–672) | main.js:657–674 (sync + async variants, distinct temp files per F1.3, 623–629) | yes |
| Squad roster | `userData/squad.json` (+ `.tmp`) | `{__schemaVersion: 4, players}` wrapper (main.js:581–585) | main.js:588–595 | yes |
| CSV exports | user-chosen via save dialog | CSV string, **UTF-8 with BOM** added by the write layer (main.js:431, 458) | main.js:420–438 | no (direct `writeFile`) |
| Clip playlist | user-chosen folder: `clip_playlist.csv` (BOM) + `cut_clips.bat` (BOM-free — cmd.exe breaks on a BOM, main.js:447) | CSV + Windows batch | main.js:448–466 | no |

All writes share `writeFileAtomic` (temp + rename; rename failure cleans
the temp best-effort) for the three JSON targets (main.js:549–567). **No
fsync** — the helper's own comment states the durability guarantee is
unchanged from the original writers: data is handed to the OS but not
flushed to disk (main.js:556–558). The autosave async write/delete ops are
serialized through one in-process promise queue (main.js:644–651) so a
delete can never interleave between an older write's writeFile and rename
(F1.3 resurrection guard, 631–643). The sync flush bypasses the queue by
design and uses its own temp file (623–629, 638–643).

### A.4 Data shapes (as persisted)

- **Session/autosave payload** (renderer.js:4103, 4600–4610; the autosave
  adds only `__savedAt`):
  `{ videoPath, tags, events, squad, matchInfo, matchClock }`.
- **Event** at creation (renderer.js:1054–1082): `id, time, videoTime,
  matchTime, matchSeconds, officialMinute, second, period, label, subtype,
  outcome (null | 'SUCCESS' | 'FAILURE'), qualifiers{}, location, playerId,
  playerOffId, playerOnId, side, team, sequenceId, scoreForBefore,
  scoreAgainstBefore` (+ `isInterval, startTime, endTime` for intervals,
  1111–1113; goal events add `score*After`, 1128–1140).
- **matchInfo** (renderer.js:489–494): `competition, date, opponent, venue,
  homeAway, ourScore, opponentScore, formation, startingXI[]`.
- **matchClock** (renderer.js:136–143): `clockStartedAt, clockBaseSeconds,
  clockRunning, period, scoreFor, scoreAgainst, videoSyncOffset,
  selectedTeam, selectedPlayerId, activeSequenceId, nextSequenceNumber`.
  On load and recovery the clock is always restored **stopped** with
  `clockStartedAt = null` (renderer.js:4198–4201, 4984–4988).
- **Squad player** (renderer.js:397; main.js:177–181): `{id, number, name}`
  with `player_<n>` ids (renderer.js:405–409, integrity.js:24–29).
- **Season-view record** (renderer.js:3895–3904): `{id, sourceFile,
  savedAt, matchInfo, events, tags, squad, matchClock}` — in-memory only.

### A.5 Versioning and migration of saved state

- Every persisted JSON carries `__schemaVersion`; version-less files are
  v0 (main.js:70–103 design comment). Current version: **4** (main.js:104).
- `migrateSessionData()` (main.js:109–296) runs **in the main process at
  every load** (session load 482, multi-load 520, autosave read 702) so the
  renderer always receives current-version data. Chain: v0→v1 structural
  normalization (arrays, matchInfo, per-event null defaults, **forward-
  compatible preservation of unknown fields**, 167–170); v1→v2 player
  snapshots → `playerId` string references (184–236); v2→v3 match-time
  fields + `matchClock` default (238–272); v3→v4 additive `outcome: null`
  — never inferred, never rewritten (274–293).
- **Forward rejection:** a file stamped with a *newer* schema version than
  the app supports throws a explicit "update MatchTag" error for sessions
  (main.js:116–122) and squad files (322–327); load returns null with a
  native error box (499–502).
- Squad migration (main.js:305–338) accepts the legacy bare array and the
  wrapper transparently. Observed quirk (harmless today): saves stamp the
  wrapper `__schemaVersion: 4` (main.js:582) while the wrapped-object
  migration path returns a `__schemaVersion: 1` wrapper (main.js:331–333);
  invisible because `squad:load` returns only `.players` (573–574).
- There is **no backup/rotation of any file** and no version history: a
  manual save over the same path atomically *replaces* the previous
  content (risk B6).

### A.6 Failure and recovery behavior

- **Crash / hard kill (power loss, kill -9):** no beforeunload runs; the
  recovery point is whatever the *last debounced* autosave wrote (A.2.1) —
  bounded by the debounce discipline and the no-fsync write (risks B1/B3).
  A corrupted autosave is silently treated as absent (file kept on disk,
  main.js:719–723) — no user-visible signal (risk B5).
- **Graceful close:** safe-close modal → decision → `closeProceed` →
  beforeunload sync flush (A.2.2/A.2.6). Sync IPC means the write completes
  before teardown; main shows a native dialog on failure.
- **Renderer reload** (devtools/Electron reload): beforeunload fires →
  flush writes the autosave (dirty) or cleans it (clean). The safe-close
  modal does not appear (it is window-close-only) — a reload while dirty
  silently persists to the safety net and the next startup offers
  recovery. Data survives; the analyst is not prompted.
- **Multi-"tab":** N/A — single-window app (Part 0). The detached video
  window holds no session state (main.js:814–877 relays transport only).
- **Multi-instance:** possible — no `requestSingleInstanceLock`
  (main.js:60–68). Two processes share `userData/autosave.json` and
  `squad.json`; the F1.3 epoch/drain/queue guards are **per-process**, so
  instance A's autosave writes and deletes interleave with instance B's at
  the filesystem level with no coordination (risk B4).
- **Races already closed (F1.3, verified by tests/autosave-safety-check.js
  header, lines 1–36):** flush-failure silence; write-vs-delete
  resurrection; stale-completion side effects. Renderer guards: epoch
  counter (renderer.js:4513–4519, 4686, 4716), write-drain before delete
  (4747–4752, 4674–4679), in-flight reschedule suppression (4687–4694).
  Main guard: the op queue (main.js:644–651). Residual documented window:
  the sync flush can only interleave with an async write of the *same
  still-dirty session* — benign staleness ≤ the debounce window
  (main.js:638–643).
- **Manual save failure:** session stays dirty; autosave intact
  (main.js:380–387). **Load failure:** state untouched (main.js:499–502).
  **Squad save failure:** toast; squad changes remain in memory only
  (renderer.js:413–419).
- **Recovery reconciliation:** local squad wins over the payload snapshot;
  missing player references are warned before *and* after recovery
  (renderer.js:4853–4870, 4942–4953) — events are never rewritten.

### A.7 Handoff to the export layer

- Exports are computed from **in-memory state at click time**: the current
  session's `events`/`matchInfo` (renderer.js:4304–4353 standard,
  5257–5270 full-analysis) or the season view's `seasonMatches`
  (renderer.js:3975–4094). No export reads `autosave.json` or a session
  file. An export can therefore exist for work that was never manually
  saved (risk B7 — provenance, not loss).
- The shared write infrastructure is the main-process dialog writers
  (main.js:420–466): R2-A filename sanitizing (394–404, renderer-side
  suggestion 3911–3951), UTF-8 BOM on CSVs, BOM-free `.bat`, and the
  failure-result pattern `{canceled, error}`. The JSON session writer
  (atomic, no BOM) is the same layer's third writer.
- The save flow "hands off" precisely by being the in-memory source of
  truth that exports serialize; nothing mediates between them. In the
  other direction, the export layer's **future** F2 obligation (readability
  spec Part F, BINDING): *whenever a data export is written, the write
  layer also writes the glossary sidecar `pitchlog-data-dictionary.csv`
  next to it (UTF-8 BOM, overwrite in place), except in the clip-playlist
  folder* — the save-flow's write layer is where that ruling will land,
  which is why this spec records the writer inventory (A.3) rather than
  duplicating the glossary content (see docs/pitchlog-data-dictionary.csv,
  the Tier 1 glossary of record).
- Export triggers and pinned behaviors are cross-referenced, not restated:
  docs/export-data-dictionary.md §2 (trigger table, lines 53–59) and the
  R2-A pins in tests/r2a-export-check.js / r2b-data-quality-check.js.

### A.8 What is deliberately NOT persisted (in-memory only)

Season-view match list (renderer.js:2988, 3889–3909 — re-loaded from files
each run, deduped by `sourceFile` within a run, 3894; PSD §1.8 line 146:
"in-memory list only — nothing persists"); in-flight interval starts
(A.2.8); touchline mode on/off; event-list filters/search; undo selection
(`lastLoggedEventId`); `activeIntervals` (973); video transport state.

---

## Part B — Risk register

Likelihood × Impact, each tied to Part A evidence. "L/I" scale: LOW /
MEDIUM / HIGH.

| # | Risk | L | I | Evidence |
|---|---|---|---|---|
| B1 | **Debounce-window loss on hard kill.** Trailing full-reset debounce (every mutation re-arms 1500 ms, no cap) means during continuous sub-1.5 s tagging bursts *no* autosave lands; a hard kill loses all work since the last ≥1.5 s pause — potentially an entire continuously-tagged half. beforeunload does not run on hard kill. | MED | HIGH | renderer.js:4526, 4574–4575, 4651–4667; A.2.1/A.2.8 |
| B2 | **In-flight interval never persisted.** Interval start lives only in `activeIntervals` (not dirty-marked, not in the autosave payload); a crash/close mid-interval loses the running Possession-style interval outright; after recovery it cannot be finished. | MED | LOW | renderer.js:973, 1010–1021, 4600–4610, 4955; A.2.8 |
| B3 | **No fsync — durability of "written" is OS-dependent.** Atomic rename protects against partial writes, not against power loss before the OS flushes; the last autosave (or manual save) may be absent/zero-length after a crash on some filesystems. Documented as accepted in the helper's comment. | LOW | MED | main.js:556–558, 559–567 |
| B4 | **Multi-instance clobber.** No single-instance lock; two instances share `userData/autosave.json` + `squad.json`; per-process F1.3 guards cannot see each other; last writer wins; recovery can offer the wrong session's state; one instance's save-clear can delete the other's safety net. | LOW | HIGH | main.js:60–68, 644–651 (per-process), 615–621; Part 0 |
| B5 | **Corrupt autosave is silently ignored.** `autosave:read` returns null on parse failure with the file left on disk — no notice, no path shown; the analyst may not know recoverable-looking work exists. | LOW | MED | main.js:719–723; A.6 |
| B6 | **Manual save silently overwrites previous file content; no backups.** Atomic rename replaces the destination; saving an (accidentally) empty session over a full one is unrecoverable. Only the *load* path is dirty-guarded, never the save path. | LOW–MED | HIGH | main.js:378, 559–567; renderer.js:4102–4111 |
| B7 | **Export ≠ saved (provenance gap).** Exports serialize unsaved in-memory state; a consumer can hold a CSV for a session that was never saved — the deliverable exists while the "source of truth" file does not. No reminder exists. | MED | LOW–MED | A.7; renderer.js:4304–4353 |
| B8 | **Autosave vs manual-save vs export races.** F1.3 closed the write/delete resurrection and stale-completion races (verified by a dedicated suite); residual documented window is the flush interleaving with an async write of the same dirty session (benign staleness ≤ debounce). Exports never touch save state, so no export race exists by construction. | V.LOW | LOW | main.js:631–651, 638–643; tests/autosave-safety-check.js:1–36 |
| B9 | **Squad dual-write divergence.** squad.json persists immediately while the session's embedded squad snapshot rides the debounced autosave; a crash between the two leaves them out of sync. Bounded: recovery reconciles against the local squad and warns on missing refs (both pre- and post-recovery), events never rewritten. | MED | LOW | renderer.js:439/474 vs 4600–4610; 4853–4870, 4942–4953 |
| B10 | **Session portability / video relink.** `videoPath` is stored absolute; moving files or machines leaves `__videoExists: false` (warned in the recovery modal and load path) but no relink helper; events keep match-time so data survives. | MED | LOW | main.js:483–497; renderer.js:4840–4848 |
| B11 | **Unbounded session size / write amplification.** The full session (pretty-printed, embedded squad) is rewritten on every debounced autosave; very large event counts make each write multi-MB and every mutation re-arms it. No quota limit exists (plain files), so this is performance/wear, not loss. | LOW | LOW | main.js:378, 664–665; renderer.js:4600–4610 |
| B12 | **Version conflicts.** Forward files are rejected with an explicit update prompt (good); migration is one-way and additive-only (good); unknown fields are preserved (main.js:167–170). Residual: hand-edited or third-party-written files with malformed fields are silently normalized per v0→v1 rules (ids become 0, labels 'Unknown') rather than rejected. | LOW | LOW | main.js:116–122, 145–172 |
| B13 | **Offline / multi-device / multi-user.** Not risks in the current design: the app is fully offline with no sync surface (Part 0). Any future multi-device expectation would be net-new architecture — routed to Part E, not designed around here. | — | — | Part 0; A.3 |

**Top risks by L×I:** B1 (debounce-window loss), B4 (multi-instance
clobber), B6 (save-overwrite without backup), B2 (in-flight interval), B5
(corrupt-autosave silence). Part C addresses these first.

---

## Part C — Target design (PROPOSAL ONLY — prose, not code)

All proposals are **additive and contract-safe**: schema v4, the autosave
semantics (dirty tracking, 1500 ms trailing debounce, clear-on-save/load,
recovery UX), R2-A export filename/BOM behavior, the Season Player
63-column contract, the R1 outcome-last-column invariant, and D2-0
(consumer contracts win) are all preserved. Each increment is small,
independently shippable, and testable by the existing harness pattern
(static source checks + jsdom behavioral suites). None is implemented here.

**C.1 (INC-1) Single-instance lock — closes B4.**
On startup, call Electron's `app.requestSingleInstanceLock()`; when the
lock is not acquired, focus the existing window and quit the second
process. This is a launch-behavior change only: no persisted format, no
IPC channel, no autosave semantics touched. Requires an architect ruling
on whether running two instances is ever a supported workflow (D.2).
Regression risk: minimal; the change is confined to main.js's app-lifecycle
section (main.js:60–68 today).

**C.2 (INC-2) Flush on OS power events — shrinks B1's hard-kill window.**
Register Electron's `powerMonitor` 'suspend'/'shutdown' events in the main
process and ask the renderer to run the *existing* flush path (the same
`flushAutosaveSync` semantics, synchronously). This adds a trigger, never
changes an existing one: the debounce, the close handshake, and the
beforeunload behavior are untouched, and power events that never arrive
change nothing. This is the honest mitigation for the part of B1 that
beforeunload cannot cover (power loss mid-burst). Requires a ruling that
adding a trigger is within "existing autosave behavior" (D.4). Bounded
residual: instant power loss still loses the open debounce window — only
C.4-style journaling could close that, and it is deliberately NOT proposed
(complexity vs. payoff, and it would alter autosave behavior).

**C.3 (INC-3) Save-over backup rotation — closes B6.**
In `file:saveSession`, before the atomic rename over an existing
destination, copy the current file (if any) to `<name>.bak` (single
generation; timestamped generations only if the product owner wants
history — E.2). The `.bak` is written *before* the new content lands, so
the worst case is a stale backup, never a lost one; the save contract
(return shape, dialog, stamping, atomicity) is unchanged. A `.bak` is
plain JSON at the same schema version — recoverable today via "Load
session" with zero new read-path code.

**C.4 (INC-4) Corrupt-autosave surfacing — closes B5.**
Extend `autosave:read`'s *failure* return from bare `null` to a
distinguishable result (e.g. `{ corrupt: true, path }`) — an additive
return field; the renderer's null-check ("no autosave") keeps working and
a new branch shows a one-line notice with the file location ("an autosave
file exists but couldn't be read — left in place for manual inspection").
No file is deleted, no recovery flow changes. Needs a ruling on the IPC
return-shape contract vs. the pinned jsdom stub surface (D.5).

**C.5 (INC-5) Export-from-unsaved reminder — addresses B7.**
When a match export is triggered while `sessionDirty` is true, show a
toast suggesting a manual save ("Exported from an unsaved session — save
the session to keep the source data"). Pure feedback after the export
completes; the CSV bytes, filename suggestion, BOM, and existing
success/error toasts (R2-A contract) are untouched. Requires a ruling on
toast-wording interaction with the R2-A pins (D.8).

**C.6 (INC-6, architect-flagged) Durability hardening — addresses B3.**
Optionally add `fs.fsync` on the temp file (and temp-file directory) in
`writeFileAtomic` before the rename. This *strengthens* the write path the
existing comment explicitly froze ("neither weakened nor strengthened",
main.js:556–558), so it is proposed **only with an explicit ruling** that
durability hardening does not violate the autosave-behavior invariant's
letter (D.1). Cost: one fsync per debounced write (measurable on the
courtside laptops the product targets). Everything else about the write —
temp+rename, queueing, failure semantics — is unchanged.

**C.7 In-flight intervals (B2) and debounce cadence (B1's core) —
deliberately NOT proposed.**
Persisting `activeIntervals` or capping the debounce would change the
autosave payload or the debounce discipline — both inside the frozen
"existing autosave behavior" invariant. They are surfaced as questions
(D.6, D.7) instead of proposals. If the architect rules them in, they
belong in a dedicated implementation round with their own spec.

**Sequencing (proposal):** INC-1 and INC-3 are the cheapest
highest-impact shippables; INC-4 and INC-5 are pure-feedback additions;
INC-2 needs one ruling; INC-6 is last and gated on D.1. Every increment
lands behind the existing regression battery with no schema change, no
new dependency, and no consumer-visible export change.

---

## Part D — Open questions for the ARCHITECT

D.1 Does adding fsync to `writeFileAtomic` violate the "autosave
untouched" invariant, given main.js:556–558's explicit note that the
existing writers' durability is "neither weakened nor strengthened"?
Is durability hardening a behavior change in the invariant's letter, or
only in its guarantees?

D.2 Is multi-instance ever a supported workflow (two windows, two
analysts, one machine)? A single-instance lock changes app launch
behavior — does that require a product decision (E.3) before an
architectural one, and if the lock ships, should the second launch's
"focus existing" path carry any message?

D.3 For save-over backups (INC-3): is a single `.bak` generation the
right shape, or is timestamped rotation required? Is `.bak` an acceptable
new file in user-chosen directories, given the D2-1 conservative-freeze
spirit that (per Part F F2-d) keeps new files out of machine-watched
export folders? Are user-chosen session directories ever machine-watched
the way clip-playlist folders are?

D.4 Does adding powerMonitor suspend/shutdown flush triggers count as
"existing autosave behavior" (the trigger set was enumerated in the F1.3
design: debounce, beforeunload, close handshake) or as an extension
requiring a ruling like F1/F2? If an extension: is it Tier-2-gated?

D.5 The autosave IPC surface is pinned by tests (jsdom stubs in
tests/autosave-safety-check.js). For the corrupt-autosave result (INC-4),
which is contract-safe: an additive field on the existing `autosave:read`
return, or a new IPC channel? What is the canonical test-pinning
procedure when an IPC return shape is extended additively?

D.6 Should in-flight interval starts (B2) be persisted (e.g. included in
the autosave payload and restored on recovery with the interval resumed),
or is the current loss-on-crash semantics an accepted trade-off of the
frozen autosave payload shape? If persisted, does the recovered interval
resume "running" or present as an unfinished marker requiring an explicit
finish?

D.7 The 1500 ms trailing full-reset debounce (no max-wait) is the
documented design. Is a max-wait cap (e.g. write at least every N seconds
while continuously dirty) within the frozen behavior, or does B1's
burst-window loss require reopening that design decision in a dedicated
round? What N, if any, matches the product's loss tolerance (E.1)?

D.8 The R2-A suite pins export toast wording (success/error/nothing-to-
export). An "exported from an unsaved session" toast (INC-5) is a new
post-success message: does it need an R2-A-contract amendment, and should
it fire on all five export kinds or only the two current-match CSVs?

D.9 The squad wrapper's version quirk (saves stamp `__schemaVersion: 4`,
the wrapped-object migration returns a `1`-stamped wrapper — main.js:582
vs 331–333, invisible because only `.players` is consumed): is this worth
normalizing now (chore-level, no consumer), or does it stay as-is until
the squad format next evolves?

D.10 If INC-1 (single-instance lock) ships, the multi-instance race
class (B4) closes by prevention. If the architect instead rules
multi-instance supported: should the autosave/squad files be namespaced
per-instance (a format change) or last-writer-wins accepted (documented)?

---

## Part E — Open questions for the PRODUCT OWNER

E.1 When the app is killed without warning (power cut, freeze, forced
shutdown), how much tagging work is it acceptable to lose? Today the
answer is roughly "everything since the last pause of a second and a half
(or the last save)". Is that fine, or must every button press survive?

E.2 When you save a session over an existing file, the old content is
gone for good. Should we keep one automatic backup copy of what was
there before (`.bak` next to your file)? Just one, or several dated
copies?

E.3 Do you ever need to run the app twice at the same time on one
computer (or might someone else open it while you have it open)? If not,
should a second launch simply bring your existing window to the front?

E.4 Is it a problem that a CSV report can be exported from work you
never saved? Would you like a reminder at export time ("this export came
from an unsaved session — save it to keep the source data"), or is that
noise?

E.5 When you open a saved session on a different computer (or after
moving your video files), the video will not auto-load and you get a
"file not found" note. Is that enough, or do you want a "find the video
again" helper?

E.6 The season view forgets its match list every time the app closes —
you re-add the saved match files each session. Should it remember the
list, or is re-adding acceptable for now?

E.7 Is any sharing or syncing between computers or people planned for
match data (coach and analyst, home and stadium laptops), or does
everything live on the one courtside laptop for the foreseeable future?

E.8 If the app finds a recovery file but cannot read it (corrupted), it
currently stays silent and leaves the file in place. Should it tell you
where the file is so you (or support) can try to rescue it manually?

E.9 Priorities: if we can only do a few of the fixes behind this
specification (backup-on-save, second-launch handling, power-cut
protection, corruption notice, export reminder), which matter most to
you before Real Match-Day Validation?

---

*End of specification. No source, test, UI, or schema file was modified by
this document. Part C is proposal-only prose; Parts D/E are open questions
awaiting rulings.*
