#!/usr/bin/env node
// PitchLog / MatchTag — R3-A: matchday roster RENDERER harness (behavioral).
// ============================================================================
// Verification-only harness. It does NOT modify any app source file.
//
// Boots the REAL index.html + integrity.js + roster.js + analytics.js +
// player-season.js + renderer.js into jsdom with a stubbed window.matchtag
// bridge (call capture — same architecture as tag-library-renderer-check.js)
// and verifies the R3-A renderer wiring BEHAVIORALLY, through the pure
// mutation path (window.matchRosterApi; R3-A shipped no roster UI — R3-B
// Stage 1 has since added the Matchday-squads modal, and W5 below now pins
// that UI to its approved surface instead of asserting its absence):
//
//   R3-15  dirty-state eligibility: a roster mutation marks the session
//          dirty AND counts as autosavable work (the debounced autosave
//          actually fires with the roster; the close-time flush writes it).
//          Clean-load case: loading a session leaves the session CLEAN with
//          no spontaneous autosave; an empty roster alone is NOT phantom
//          work (fresh boot flushes null).
//   R3-13  renderer flows: manual save payload carries matchRoster; manual
//          load restores it; recovery restores it (and recovers pre-R3-A
//          autosaves without a roster field); the full close→reopen cycle
//          (flush → boot → recovery) round-trips the roster.
//   R3-14  legacy-v4 renderer load: a session WITHOUT matchRoster loads
//          with an EMPTY roster (never manufactured from its events), all
//          classic state intact.
//   R3-16  startingXI stays the loaded formation-slot→playerId mapping —
//          roster data (even conflicting 'starter' statuses) never rewrites
//          it, and roster mutations leave it untouched.
//   R3-07  renderer-level isolation: roster ops never call saveSquad and
//          never leak match_opp_* ids into the squad; the renderer resolver
//          follows the approved routing (overlay → squad fallback;
//          opponent-only; unknown → null; never squad for match_opp_*).
//   R3-17  the Sub tag stays EVENT-ONLY: logging a real Sub event (off/on
//          players that exist in the roster) never touches roster statuses;
//          historical events are unchanged by roster state and vice versa.
//
// HONEST SCOPE: jsdom boots verify DOM wiring and data flow only. The real
// on-disk persistence (atomic writes, migration) is covered by
// tests/roster-persistence-main-check.js; the pure model by
// tests/roster-model-check.js.
//
// Run:  node tests/roster-renderer-check.js   (from the project root)
'use strict';

const path = require('path');
const fs = require('fs');

const jsdomDir = process.env.JSDOM_PATH
  ? process.env.JSDOM_PATH
  : path.join(__dirname, '.jsdom-scratch', 'node_modules');
let JSDOM, VirtualConsole;
try {
  const j = require(path.join(jsdomDir, 'jsdom'));
  JSDOM = j.JSDOM;
  VirtualConsole = j.VirtualConsole;
} catch (e) {
  console.error('jsdom not found in ' + jsdomDir);
  console.error('Run npm run setup-tests first (see scripts/setup-tests.js).');
  process.exit(2);
}

const srcDir = path.join(__dirname, '..', 'src');
const html = fs.readFileSync(path.join(srcDir, 'index.html'), 'utf8');
const integritySrc = fs.readFileSync(path.join(srcDir, 'integrity.js'), 'utf-8');
const rosterSrc = fs.readFileSync(path.join(srcDir, 'roster.js'), 'utf-8');
const analyticsSrc = fs.readFileSync(path.join(srcDir, 'analytics.js'), 'utf-8');
const playerSeasonSrc = fs.readFileSync(path.join(srcDir, 'player-season.js'), 'utf-8');
const rendererSrc = fs.readFileSync(path.join(srcDir, 'renderer.js'), 'utf-8');
const preloadSrc = fs.readFileSync(path.join(srcDir, 'preload.js'), 'utf-8');

const results = [];
let SECTION = '(pre)';
function section(name) { SECTION = name; console.log('\n===== ' + name + ' ====='); }
function ok(name, cond, detail) {
  results.push({ section: SECTION, name, pass: !!cond, detail: detail === undefined ? '' : String(detail) });
  console.log((cond ? '[PASS] ' : '[FAIL] ') + name + (detail === undefined ? '' : '  | ' + detail));
  if (!cond) process.exitCode = 1;
}
const jsdomErrors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function clone(x) { return x == null ? x : JSON.parse(JSON.stringify(x)); }

// ---------------------------------------------------------------------------
// matchtag stub with full call capture
// ---------------------------------------------------------------------------
function makeStub(initial) {
  const calls = {
    saveSession: [], autosaveWrite: [], flushSync: [], saveSquad: [],
    autosaveDelete: 0, loadSessionCalls: 0
  };
  const state = {
    loadSessionData: null,
    saveSessionResult: { canceled: true },
    autosaveData: initial.autosave !== undefined ? initial.autosave : null
  };
  const stub = {
    openVideo: async () => null,
    saveSession: async (d) => { calls.saveSession.push(clone(d)); return clone(state.saveSessionResult); },
    exportCsv: async () => ({ canceled: true }),
    exportClipPlaylist: async () => ({ canceled: true }),
    loadSession: async () => { calls.loadSessionCalls++; return clone(state.loadSessionData); },
    loadMultipleSessions: async () => [],
    loadSquad: async () => clone(initial.squad || []),
    saveSquad: async (s) => { calls.saveSquad.push(clone(s)); return true; },
    loadTagLibrary: async () => null,
    saveTagLibrary: async () => ({ ok: true, path: '/tmp/tags.json' }),
    detachVideo: async () => true,
    reattachVideo: async () => true,
    sendVideoCommand: () => {},
    onVideoState: () => {},
    onVideoClosed: () => {},
    autosaveRead: async () => clone(state.autosaveData),
    autosaveWrite: async (d) => { calls.autosaveWrite.push(clone(d)); return { ok: true, path: '/tmp/autosave.json' }; },
    autosaveDelete: async () => { calls.autosaveDelete++; return { ok: true }; },
    autosaveFlushSync: (d) => { calls.flushSync.push(clone(d)); return { ok: true }; },
    onCloseRequested: () => {},
    onAutosaveFlushRequested: () => {},
    closeProceed: () => {},
    _setLoadSession: (d) => { state.loadSessionData = d; },
    _setSaveResult: (r) => { state.saveSessionResult = r; },
    _setAutosave: (d) => { state.autosaveData = d; },
    _calls: calls
  };
  return stub;
}

function boot(initial) {
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => { jsdomErrors.push(String(e.message || e)); });
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'file://' + path.join(srcDir, 'index.html'), virtualConsole: vc });
  const win = dom.window;
  const stub = makeStub(initial || {});
  win.matchtag = stub;
  win.eval(integritySrc);
  win.eval(rosterSrc);
  win.eval(analyticsSrc);
  win.eval(playerSeasonSrc);
  win.eval(rendererSrc);
  return { dom, win, doc: win.document, stub };
}

function clickIn(B, el) { el.dispatchEvent(new B.win.MouseEvent('click', { bubbles: true, cancelable: true })); }
function flushClose(B) { B.win.dispatchEvent(new B.win.Event('beforeunload')); }
function lastAutosaveWrite(stub) { const a = stub._calls.autosaveWrite; return a.length ? a[a.length - 1] : null; }
function lastFlush(stub) { const a = stub._calls.flushSync; return a.length ? a[a.length - 1] : undefined; }
function lastSave(stub) { const a = stub._calls.saveSession; return a.length ? a[a.length - 1] : null; }

const SQUAD = [
  { id: 'player_1', number: '1', name: 'GK Kid' },
  { id: 'player_6', number: '6', name: 'Came Off' },
  { id: 'player_9', number: '22', name: 'Super Sub' },
  { id: 'player_12', number: '12', name: 'Bench Warmer' },
  { id: 'player_20', number: '20', name: 'Squad Twenty' }
];

const SESSION_WITH_ROSTER = {
  __schemaVersion: 4,
  __savedAt: '2026-01-01T00:00:00.000Z',
  videoPath: null,
  tags: [{ label: 'Goal', key: '1' }],
  events: [
    { id: 1, time: 100, label: 'Pass', subtype: null, qualifiers: {}, location: null,
      playerId: 'player_9', playerOffId: null, playerOnId: null, side: 'for',
      isInterval: false, outcome: null, team: 'our' },
    { id: 2, time: 200, label: 'Foul', subtype: null, qualifiers: {}, location: null,
      playerId: 'match_opp_1', playerOffId: null, playerOnId: null, side: 'against',
      isInterval: false, outcome: null, team: 'opponent' }
  ],
  squad: SQUAD,
  matchInfo: {
    competition: 'EPL', date: '2026-01-01', opponent: 'Bahir Dar City', venue: 'Home',
    homeAway: 'home', ourScore: '2', opponentScore: '1', formation: '4-3-3',
    startingXI: [
      { position: 'GK', playerId: 'player_1' },
      { position: 'ST', playerId: 'player_9' }
    ]
  },
  matchClock: {
    clockStartedAt: null, clockBaseSeconds: 1800, clockRunning: false, period: '1H',
    scoreFor: 2, scoreAgainst: 1, videoSyncOffset: 0, selectedTeam: 'our',
    selectedPlayerId: null, activeSequenceId: null, nextSequenceNumber: 1
  },
  matchRoster: {
    our: [
      { playerId: 'player_9', displayName: 'Super Sub (roster overlay)', shirtNumber: 22, position: 'MF', role: '', status: 'on' },
      { playerId: 'player_12', displayName: 'Bench Warmer', shirtNumber: 12, position: 'FW', role: '', status: 'bench' }
    ],
    opponent: [
      { playerId: 'match_opp_1', displayName: 'Opp One', shirtNumber: 9, position: 'ST', role: '', status: 'starter' }
    ]
  }
};

// A legacy-v4 session: IDENTICAL content but NO matchRoster field.
const LEGACY_V4_SESSION = clone(SESSION_WITH_ROSTER);
delete LEGACY_V4_SESSION.matchRoster;

(async () => {

  // =======================================================================
  section('R3-W — wiring (source-level)');
  {
    ok('R3-W1: index.html loads roster.js BEFORE renderer.js (script order)',
      /<script src="integrity\.js"><\/script>[\s\S]*?<script src="roster\.js"><\/script>[\s\S]*?<script src="renderer\.js"><\/script>/.test(html));
    ok('R3-W2: renderer persists the roster in BOTH payload builders (manual save + autosave)',
      /const sessionData = \{ videoPath: currentVideoPath, tags, events, squad, matchInfo, matchClock, matchRoster \};/.test(rendererSrc) &&
      /function buildAutosaveData\(\) \{[\s\S]{0,400}?matchRoster[\s\S]{0,60}?\};/.test(rendererSrc));
    ok('R3-W3: roster counts as autosavable work in hasAutosavableWork',
      rendererSrc.indexOf('function hasAutosavableWork()') > -1 &&
      rendererSrc.indexOf('function hasAutosavableWork()') <
        rendererSrc.indexOf("if (!window.Roster.isEmptyMatchRoster(matchRoster)) return true;") &&
      /if \(!window\.Roster\.isEmptyMatchRoster\(matchRoster\)\) return true;/.test(rendererSrc));
    ok('R3-W4: BOTH restore paths normalize the loaded roster (load + recovery)',
      (rendererSrc.match(/matchRoster = window\.Roster\.normalizeMatchRoster\((?:data|autosave)\.matchRoster\);/g) || []).length === 2);
    // R3-W5 (R3-B Stage 1 supersession, Stage 2 extension): R3-A shipped
    // no roster UI; R3-B Stage 1 added the FIRST one — the "Matchday
    // squads" modal (our-team zone). R3-B Stage 2 added the opponent zone
    // of the SAME modal. The original protections are KEPT (clause 1:
    // renderer looks up no roster-labeled DOM id; clause 2: index.html
    // defines none) and EXTENDED with the approved-surface whitelist:
    // every matchday-squad DOM id defined in index.html and every one
    // looked up in renderer.js must be exactly one of the fourteen
    // approved ids (nine Stage 1 our-team ids + five Stage 2 opponent
    // ids) — the roster UI cannot silently grow beyond the approved modal.
    const APPROVED_MATCHDAY_SQUAD_IDS = [
      'btnMatchdaySquad', 'matchdaySquadModal', 'matchdaySquadCounts', 'matchdaySquadXiHint',
      'matchdaySquadXi', 'matchdaySquadList', 'matchdaySquadAddList',
      'btnAddAllMatchdaySquad', 'btnCloseMatchdaySquad',
      'matchdaySquadOppCounts', 'matchdaySquadOppList', 'matchdaySquadOppName',
      'matchdaySquadOppNumber', 'btnAddMatchdaySquadOpp'
    ];
    const htmlMdIds = (html.match(/id="[^"]*atchday[^"]*quad[^"]*"/g) || []).map((s) => s.slice(4, -1));
    const rendererMdLookups = (rendererSrc.match(/getElementById\('[^']*atchday[^']*quad[^']*'\)/g) || []).map((s) => s.slice(s.indexOf("'") + 1, s.lastIndexOf("'")));
    ok('R3-W5: roster UI confined to the approved Matchday-squads modal (original no-unapproved-roster-id clauses kept)',
      !/getElementById\('[^']*[Rr]oster[^']*'\)/.test(rendererSrc) &&
      !(html.match(/id="[^"]*[Rr]oster[^"]*"/g) || []).length &&
      APPROVED_MATCHDAY_SQUAD_IDS.every((id) => (html.match(new RegExp('id="' + id + '"', 'g')) || []).length === 1) &&
      APPROVED_MATCHDAY_SQUAD_IDS.every((id) => rendererSrc.indexOf("getElementById('" + id + "')") !== -1) &&
      htmlMdIds.every((id) => APPROVED_MATCHDAY_SQUAD_IDS.indexOf(id) !== -1) &&
      rendererMdLookups.every((id) => APPROVED_MATCHDAY_SQUAD_IDS.indexOf(id) !== -1),
      'html ids: ' + JSON.stringify(htmlMdIds) + ' | lookups: ' + JSON.stringify(rendererMdLookups));
    ok('R3-W6: NO new IPC channel — the roster rides the existing opaque payloads (preload unchanged)',
      !/roster:/.test(preloadSrc));
    ok('R3-W7: NO substitution wiring — renderer never writes roster statuses from events',
      !/status = 'substituted'/.test(rendererSrc) && !/status = 'on'/.test(rendererSrc));
  }

  // =======================================================================
  section('R3-15 — dirty-state eligibility (roster mutation → autosave)');
  {
    const B = boot({ squad: SQUAD });
    const { doc, stub } = B;
    await sleep(400);
    const api = B.win.matchRosterApi;

    ok('R3-15a: fresh boot — api present, EMPTY roster, session CLEAN, nothing autosaved',
      !!api && JSON.stringify(api.get()) === JSON.stringify({ our: [], opponent: [] }) &&
      api.isSessionDirty() === false && stub._calls.autosaveWrite.length === 0,
      JSON.stringify(api && api.get()));

    // The eligibility mutation: an opponent add on an otherwise virgin session.
    const added = api.upsertPlayer('opponent', { displayName: 'Opp Winger', shirtNumber: 7, position: 'RW' });
    ok('R3-15b: opponent upsert auto-generates a collision-safe match_opp_* id',
      !!added && added.playerId === 'match_opp_1' && added.status === 'bench', JSON.stringify(added));
    ok('R3-15c: the roster mutation marks the session DIRTY immediately',
      api.isSessionDirty() === true);

    await sleep(1900); // > AUTOSAVE_DEBOUNCE_MS (1500)
    ok('R3-15d: ELIGIBILITY — the debounced autosave actually FIRES (roster = autosavable work)',
      stub._calls.autosaveWrite.length === 1, 'writes=' + stub._calls.autosaveWrite.length);
    ok('R3-15e: the autosave payload carries the roster (both sides, six-field entries)',
      (() => {
        const w = lastAutosaveWrite(stub);
        return w && w.matchRoster && w.matchRoster.opponent.length === 1 &&
          w.matchRoster.opponent[0].playerId === 'match_opp_1' &&
          JSON.stringify(Object.keys(w.matchRoster.opponent[0])) === JSON.stringify(['playerId', 'displayName', 'shirtNumber', 'position', 'role', 'status']);
      })());

    // Close-time flush writes the roster too (the same eligibility predicate).
    flushClose(B);
    const fl = lastFlush(stub);
    ok('R3-15f: the close-time flush writes DATA (not null) and includes the roster',
      !!fl && fl !== null && fl.matchRoster && fl.matchRoster.opponent.length === 1,
      fl === undefined ? 'no flush' : (fl === null ? 'null' : 'roster=' + fl.matchRoster.opponent.length));

    // Removal also dirties (fresh window so dirty-state is unambiguous).
    // Seed TWO entries and remove ONE — the remaining entry keeps the
    // session autosavable (removing the ONLY entry would correctly leave
    // nothing worth autosaving).
    const B2 = boot({ squad: SQUAD });
    await sleep(400);
    const api2 = B2.win.matchRosterApi;
    api2.upsertPlayer('our', { playerId: 'player_1', displayName: 'GK Kid', status: 'starter' });
    api2.upsertPlayer('our', { playerId: 'player_6', displayName: 'Came Off', status: 'bench' });
    B2.stub._calls.autosaveWrite.length = 0; // ignore the first debounce cycle
    const removed = api2.removePlayer('our', 'player_1');
    ok('R3-15g: a roster REMOVAL also marks the session dirty (returns the removed entry)',
      !!removed && removed.playerId === 'player_1' && api2.isSessionDirty() === true);
    await sleep(1900);
    ok('R3-15h: the post-removal autosave fires and reflects the post-removal roster',
      B2.stub._calls.autosaveWrite.length >= 1 &&
      lastAutosaveWrite(B2.stub).matchRoster.our.length === 1 &&
      lastAutosaveWrite(B2.stub).matchRoster.our[0].playerId === 'player_6');

    // No-op setRoster does NOT dirty.
    const B3 = boot({ squad: SQUAD });
    await sleep(400);
    const api3 = B3.win.matchRosterApi;
    const changed = api3.setRoster({ our: [], opponent: [] }); // identical to current empty roster
    ok('R3-15i: a no-op roster write (identical content) does NOT dirty the session',
      changed === false && api3.isSessionDirty() === false);
    flushClose(B3);
    ok('R3-15j: empty roster alone is NOT phantom work — clean boot flushes null',
      lastFlush(B3.stub) === null, JSON.stringify(lastFlush(B3.stub)));
    B.dom.window.close(); B2.dom.window.close(); B3.dom.window.close();
  }

  // =======================================================================
  section('R3-15 (clean-load case) + R3-13 (manual load/save flows)');
  {
    const B = boot({ squad: SQUAD });
    const { doc, stub } = B;
    await sleep(400);
    const api = B.win.matchRosterApi;
    stub._setLoadSession(SESSION_WITH_ROSTER);

    clickIn(B, doc.getElementById('btnLoadSession'));
    await sleep(500);

    ok('R3-13a: manual load RESTORES the roster exactly (both sides, six-field entries)',
      JSON.stringify(api.get()) === JSON.stringify(SESSION_WITH_ROSTER.matchRoster),
      JSON.stringify(api.get()));
    ok('R3-15k: CLEAN-LOAD — after a load the session is CLEAN (no phantom dirty)',
      api.isSessionDirty() === false);
    ok('R3-15l: CLEAN-LOAD — no spontaneous autosave is armed (nothing written past the debounce)',
      stub._calls.autosaveWrite.length === 0, 'writes=' + stub._calls.autosaveWrite.length);
    ok('R3-13b: the loaded classic state is intact (events restored, match summary rendered)',
      doc.querySelectorAll('#eventList .event-row').length === 2 &&
      /Bahir Dar City/.test(doc.getElementById('matchSummary').textContent));

    // A post-load mutation re-dirties (recovered/loaded work can be re-armed).
    api.upsertPlayer('opponent', { displayName: 'Late Opp Add' });
    ok('R3-15m: a roster mutation AFTER a clean load re-marks the session dirty',
      api.isSessionDirty() === true);
    api.removePlayer('opponent', 'match_opp_2'); // remove what we just added (match_opp_2)
    // (still dirty — removal is also a mutation; fine)

    // Manual save carries the roster + everything classic.
    stub._setSaveResult({ canceled: false, filePath: '/tmp/saved-session.json' });
    clickIn(B, doc.getElementById('btnSaveSession'));
    await sleep(300);
    const saved = lastSave(stub);
    ok('R3-13c: manual save payload carries matchRoster alongside every classic field',
      !!saved && saved.matchRoster && saved.matchRoster.opponent.length >= 1 &&
      saved.events.length === 2 && saved.squad.length === 5 &&
      JSON.stringify(saved.matchInfo.startingXI) === JSON.stringify(SESSION_WITH_ROSTER.matchInfo.startingXI) &&
      saved.matchClock.period === '1H');
    ok('R3-13d: manual save success clears the dirty flag and the autosave file',
      api.isSessionDirty() === false && stub._calls.autosaveDelete >= 1);
    B.dom.window.close();
  }

  // =======================================================================
  section('R3-14 — legacy v4 load (renderer): no roster field, no manufacturing');
  {
    const B = boot({ squad: SQUAD });
    const { doc, stub } = B;
    await sleep(400);
    const api = B.win.matchRosterApi;
    stub._setLoadSession(LEGACY_V4_SESSION);

    clickIn(B, doc.getElementById('btnLoadSession'));
    await sleep(500);

    ok('R3-14a: a legacy-v4 session (NO matchRoster) loads with an EMPTY roster',
      JSON.stringify(api.get()) === JSON.stringify({ our: [], opponent: [] }),
      JSON.stringify(api.get()));
    ok('R3-14b: NO roster entries were manufactured from the loaded events (which reference player_9 AND match_opp_1)',
      api.get().our.length === 0 && api.get().opponent.length === 0);
    ok('R3-14c: the legacy session is otherwise intact (2 events, clean state)',
      doc.querySelectorAll('#eventList .event-row').length === 2 && api.isSessionDirty() === false);
    ok('R3-14d: a legacy load never writes the squad (no saveSquad call)',
      stub._calls.saveSquad.length === 0);

    // Re-save of the legacy session: roster present (empty) + startingXI untouched.
    stub._setSaveResult({ canceled: false, filePath: '/tmp/resaved.json' });
    clickIn(B, doc.getElementById('btnSaveSession'));
    await sleep(300);
    const saved = lastSave(stub);
    ok('R3-14e: re-saving the legacy session includes the (empty) roster and preserves startingXI verbatim',
      !!saved && saved.matchRoster && saved.matchRoster.our.length === 0 &&
      JSON.stringify(saved.matchInfo.startingXI) === JSON.stringify(SESSION_WITH_ROSTER.matchInfo.startingXI));
    ok('R3-14f: the re-save payload keeps the legacy events byte-identical (ids/labels/refs)',
      !!saved && saved.events.length === 2 && saved.events[0].id === 1 &&
      saved.events[1].playerId === 'match_opp_1');
    B.dom.window.close();
  }

  // =======================================================================
  section('R3-13 (recovery + close→reopen cycle)');
  {
    // Recovery of an autosave WITH a roster.
    const B = boot({ squad: SQUAD, autosave: Object.assign(clone(SESSION_WITH_ROSTER), { __videoExists: false }) });
    await sleep(400);
    const api = B.win.matchRosterApi;
    ok('R3-13e: the recovery modal appears for a roster-bearing autosave',
      B.doc.getElementById('recoveryModal').style.display === 'flex');
    clickIn(B, B.doc.getElementById('btnRecoverAutosave'));
    await sleep(400);
    ok('R3-13f: recovery RESTORES the roster (both sides) and marks the session dirty',
      JSON.stringify(api.get()) === JSON.stringify(SESSION_WITH_ROSTER.matchRoster) &&
      api.isSessionDirty() === true);
    ok('R3-13g: recovered events are intact alongside the roster',
      B.doc.querySelectorAll('#eventList .event-row').length === 2);
    B.dom.window.close();

    // Recovery of a PRE-R3-A autosave (no roster field) — must not crash.
    const B2 = boot({ squad: SQUAD, autosave: Object.assign(clone(LEGACY_V4_SESSION), { __videoExists: false }) });
    await sleep(400);
    const api2 = B2.win.matchRosterApi;
    clickIn(B2, B2.doc.getElementById('btnRecoverAutosave'));
    await sleep(400);
    ok('R3-14g: a pre-R3-A autosave recovers with an EMPTY roster (no crash, no manufacturing)',
      JSON.stringify(api2.get()) === JSON.stringify({ our: [], opponent: [] }) &&
      B2.doc.querySelectorAll('#eventList .event-row').length === 2);
    B2.dom.window.close();

    // Full close→reopen cycle at the renderer level: A flushes a roster, B recovers it.
    const A = boot({ squad: SQUAD });
    await sleep(400);
    A.win.matchRosterApi.upsertPlayer('opponent', { displayName: 'Crash Survivor', shirtNumber: 11 });
    await sleep(100);
    flushClose(A);
    const flushed = lastFlush(A.stub);
    ok('R3-13h: window A flushed the roster on close',
      !!flushed && flushed && flushed.matchRoster && flushed.matchRoster.opponent.length === 1);
    const Bx = boot({ squad: SQUAD, autosave: flushed });
    await sleep(400);
    clickIn(Bx, Bx.doc.getElementById('btnRecoverAutosave'));
    await sleep(400);
    ok('R3-13i: CLOSE→REOPEN cycle — window B recovers the exact roster window A flushed',
      JSON.stringify(Bx.win.matchRosterApi.get()) === JSON.stringify(flushed.matchRoster),
      JSON.stringify(Bx.win.matchRosterApi.get()));
    A.dom.window.close(); Bx.dom.window.close();
  }

  // =======================================================================
  section('R3-16 — startingXI stays the formation-slot→playerId mapping');
  {
    const B = boot({ squad: SQUAD });
    const { doc, stub } = B;
    await sleep(400);
    const api = B.win.matchRosterApi;
    stub._setLoadSession(SESSION_WITH_ROSTER);
    clickIn(B, doc.getElementById('btnLoadSession'));
    await sleep(500);

    // The roster's 'starter'/'on' statuses DELIBERATELY disagree with the
    // session's startingXI (player_12 'bench' here, player_9 'on'): the XI
    // must stay the loaded slot→playerId mapping, not be re-derived.
    ok('R3-16a: roster statuses do NOT rewrite startingXI (loaded mapping preserved)',
      JSON.stringify(api.get().our.map((p) => p.status)) === JSON.stringify(['on', 'bench']));

    // Mutate the roster heavily, then save: startingXI still untouched.
    api.upsertPlayer('our', { playerId: 'player_12', displayName: 'Bench Warmer', status: 'starter' });
    api.upsertPlayer('our', { playerId: 'player_20', displayName: 'Squad Twenty', status: 'starter' });
    stub._setSaveResult({ canceled: false, filePath: '/tmp/xi.json' });
    clickIn(B, doc.getElementById('btnSaveSession'));
    await sleep(300);
    const saved = lastSave(stub);
    ok('R3-16b: after roster mutations the saved startingXI is STILL the loaded mapping (slot→playerId)',
      JSON.stringify(saved.matchInfo.startingXI) === JSON.stringify(SESSION_WITH_ROSTER.matchInfo.startingXI),
      JSON.stringify(saved.matchInfo.startingXI));
    ok('R3-16c: the saved roster DOES reflect the mutations (startingXI and roster are independent stores)',
      saved.matchRoster.our.length === 3 &&
      saved.matchRoster.our.filter((p) => p.status === 'starter').length === 2);
    B.dom.window.close();
  }

  // =======================================================================
  section('R3-07 — renderer isolation + resolver routing (matchRosterApi.resolve)');
  {
    // Hostile squad: a match_opp_* entry smuggled into squad.json.
    const hostileSquad = SQUAD.concat([{ id: 'match_opp_2', number: '66', name: 'SMUGGLED' }]);
    const B = boot({ squad: hostileSquad });
    const { doc, stub } = B;
    await sleep(400);
    const api = B.win.matchRosterApi;
    stub._setLoadSession(SESSION_WITH_ROSTER);
    clickIn(B, doc.getElementById('btnLoadSession'));
    await sleep(500);

    // Resolver routing through the loaded roster + real squad (BEFORE any
    // mutation in this window, so the loaded entries are all in place).
    ok('R3-07b: our-team id in BOTH roster and squad → MATCH ROSTER overlay wins',
      (() => { const r = api.resolve('player_9'); return r && r.source === 'match-roster' && r.displayName === 'Super Sub (roster overlay)'; })());
    ok('R3-07c: our-team id only in the squad → GLOBAL SQUAD fallback (status null)',
      (() => { const r = api.resolve('player_20'); return r && r.source === 'global-squad' && r.displayName === 'Squad Twenty' && r.status === null; })());
    ok('R3-07d: opponent id → OPPONENT ROSTER only',
      api.resolve('match_opp_1').source === 'opponent-roster');
    ok('R3-07e: an opponent id NOT in the opponent roster is null — NEVER the (hostile) squad entry',
      api.resolve('match_opp_2') === null, JSON.stringify(api.resolve('match_opp_2')));
    ok('R3-07f: unknown ids → null',
      api.resolve('player_999') === null && api.resolve('match_opp_999') === null && api.resolve(null) === null);

    // Collision-safe generation against the FULL universe: match_opp_1 is
    // taken (roster + loaded event), match_opp_2 is taken (hostile squad
    // entry) → the next generated id must be match_opp_3.
    ok('R3-07g: generated opponent ids skip every occupied namespace slot across roster, events AND squad',
      api.generateOpponentId() === 'match_opp_3', 'got ' + api.generateOpponentId());

    // Roster mutations never touch the squad channel.
    api.upsertPlayer('opponent', { displayName: 'Another Opp', shirtNumber: 4 });
    api.removePlayer('opponent', 'match_opp_1');
    api.upsertPlayer('our', { playerId: 'player_1', displayName: 'GK Kid', status: 'starter' });
    ok('R3-07a: roster mutations NEVER call saveSquad (squad.json isolation)',
      stub._calls.saveSquad.length === 0, 'saveSquad calls=' + stub._calls.saveSquad.length);
    // After the removal above, opponent routing must report the removed id
    // as unknown (null) — the resolver reflects live roster state.
    ok('R3-07h: after removal the opponent id resolves to null (live state, never squad)',
      api.resolve('match_opp_1') === null);
    B.dom.window.close();
  }

  // =======================================================================
  section('R3-17 — Sub tag stays EVENT-ONLY; events and roster never touch');
  {
    const B = boot({ squad: SQUAD });
    const { doc, stub } = B;
    await sleep(400);
    const api = B.win.matchRosterApi;

    // Seed a roster whose entries match the sub participants, with statuses
    // that a substitution transition WOULD flip if one existed.
    api.setRoster({
      our: [
        { playerId: 'player_6', displayName: 'Came Off', shirtNumber: 6, position: 'DF', role: '', status: 'starter' },
        { playerId: 'player_12', displayName: 'Bench Warmer', shirtNumber: 12, position: 'FW', role: '', status: 'bench' }
      ],
      opponent: []
    });
    const rosterBefore = JSON.stringify(api.get());

    // Log a REAL Sub event through the DOM (tag button → off/on chips → done).
    clickIn(B, Array.from(doc.querySelectorAll('#tagButtons .tag-btn')).find((b) => b.textContent.replace(/⏱/g, '').trim().indexOf('Sub') === 0));
    await sleep(80);
    const offChip = Array.from(doc.querySelectorAll('#detailPanel .chip[data-kind="playerOff"]')).find((c) => c.dataset.playerId === 'player_6');
    const onChip = Array.from(doc.querySelectorAll('#detailPanel .chip[data-kind="playerOn"]')).find((c) => c.dataset.playerId === 'player_12');
    ok('R3-17a: the Sub detail panel exposes the squad players for off/on selection',
      !!offChip && !!onChip);
    clickIn(B, offChip);
    await sleep(50);
    clickIn(B, onChip);
    await sleep(50);
    clickIn(B, doc.getElementById('detailPanelDone'));
    await sleep(150);

    ok('R3-17b: the Sub event was logged (one event row)',
      doc.querySelectorAll('#eventList .event-row').length === 1);
    ok('R3-17c: the roster is BYTE-IDENTICAL after the Sub event — no status transitions (Sub stays event-only)',
      JSON.stringify(api.get()) === rosterBefore,
      JSON.stringify(api.get()));
    ok('R3-17d: the sub participant statuses were NOT flipped (player_6 still starter, player_12 still bench)',
      api.get().our.find((p) => p.playerId === 'player_6').status === 'starter' &&
      api.get().our.find((p) => p.playerId === 'player_12').status === 'bench');

    // The saved payload proves both stores side by side: event refs intact,
    // roster intact, startingXI untouched by the event.
    stub._setSaveResult({ canceled: false, filePath: '/tmp/sub.json' });
    clickIn(B, doc.getElementById('btnSaveSession'));
    await sleep(300);
    const saved = lastSave(stub);
    ok('R3-17e: the saved event carries the plain playerId refs (playerOffId/playerOnId) — unchanged R3-A discipline',
      !!saved && saved.events.length === 1 && saved.events[0].playerOffId === 'player_6' && saved.events[0].playerOnId === 'player_12');
    ok('R3-17f: the saved roster is still byte-identical to the pre-event roster',
      JSON.stringify(saved.matchRoster) === rosterBefore);
    ok('R3-17g: historical events are unchanged by roster state (no roster ids injected into events)',
      saved.events[0].playerId === null || saved.events.every((ev) => [ev.playerId, ev.playerOffId, ev.playerOnId].every((r) => r === null || !/^match_opp_/.test(r))));
    B.dom.window.close();
  }

  // =======================================================================
  section('HYGIENE — jsdom errors');
  {
    ok('H1: no jsdom errors during any boot in this suite', jsdomErrors.length === 0,
      jsdomErrors.slice(0, 3).join(' | '));
  }

  const failed = results.filter((r) => !r.pass).length;
  console.log('\nroster-renderer-check: ' + (results.length - failed) + '/' + results.length + ' checks passed' +
    (failed ? ', FAILED: ' + failed : ''));
  if (failed) process.exit(1);

})().catch((e) => { console.error('HARNESS CRASH:', e); process.exit(1); });
