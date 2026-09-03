#!/usr/bin/env node
// PitchLog / MatchTag — Load Session data-loss guard + squad reconciliation
// regression harness (LG series).
// =====================================================================
// Verification-only harness. It does NOT modify any app source file.
//
// Verifies the Load Session data-loss fix:
//   GUARD   clicking Load session while the session is dirty shows a
//           dedicated confirmation modal BEFORE the file dialog / any
//           state replacement. Cancel keeps the current session exactly
//           as it is (state, dirty flag, pending autosave timer and the
//           autosave file are all untouched). Confirm runs the load flow,
//           which keeps the previous successful-load behavior (state
//           replaced, session marked clean, autosave cleared).
//   NO FALSE POSITIVES   a clean session loads directly with no modal.
//   SQUAD RECONCILIATION   a manually loaded session embeds the squad it
//           was saved with. When its events reference players missing
//           from the current (local) squad, the missing REFERENCED
//           players are restored additively from the embedded squad
//           (persisted via saveSquad), and any references still missing
//           afterwards produce the recovery-style warning toast. When
//           all references resolve against the local squad, nothing is
//           merged, persisted or warned.
//
// Static source checks (LG-S*) pin the wiring; four jsdom boots with the
// REAL index.html + integrity.js + analytics.js + player-season.js +
// renderer.js (same load order as the app) exercise the real flows with
// a stubbed window.matchtag (same architecture as tests/matchday-sim.js).
//
// Run:  node tests/load-session-guard-check.js   (from the project root)
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
  process.exit(2);
}

const srcDir = path.join(__dirname, '..', 'src');
const html = fs.readFileSync(path.join(srcDir, 'index.html'), 'utf-8');
const integritySrc = fs.readFileSync(path.join(srcDir, 'integrity.js'), 'utf-8');
const analyticsSrc = fs.readFileSync(path.join(srcDir, 'analytics.js'), 'utf-8');
const playerSeasonSrc = fs.readFileSync(path.join(srcDir, 'player-season.js'), 'utf-8');
const rendererSrc = fs.readFileSync(path.join(srcDir, 'renderer.js'), 'utf-8');

const results = [];
let SECTION = '(pre)';
function section(name) { SECTION = name; console.log('\n===== ' + name + ' ====='); }
function ok(name, cond, detail) {
  results.push({ section: SECTION, name, pass: !!cond, detail: detail === undefined ? '' : String(detail) });
  if (!cond) console.log('  FAIL: ' + name + (detail === undefined ? '' : '  | ' + detail));
}

const jsdomErrors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function clone(x) { return x == null ? x : JSON.parse(JSON.stringify(x)); }

function makeStub(initial) {
  const calls = {
    saveSession: [], autosaveWrite: [], autosaveFlushSync: [], saveSquad: [],
    exportCsv: [], loadSession: 0, autosaveDelete: 0, closeProceed: 0
  };
  let loadSessionData = null;
  let closeCallback = null;
  const stub = {
    openVideo: async () => null,
    saveSession: async (d) => { calls.saveSession.push(clone(d)); return { canceled: false, filePath: '/tmp/lg-session.json' }; },
    exportCsv: async (csv) => { calls.exportCsv.push(String(csv)); return { canceled: false, filePath: '/tmp/lg-export.csv' }; },
    exportClipPlaylist: async () => ({ canceled: true }),
    loadSession: async () => { calls.loadSession++; return clone(loadSessionData); },
    loadMultipleSessions: async () => [],
    loadSquad: async () => clone(initial.squad || []),
    saveSquad: async (s) => { calls.saveSquad.push(clone(s)); return true; },
    detachVideo: async () => true,
    reattachVideo: async () => true,
    sendVideoCommand: () => {},
    onVideoState: () => {},
    onVideoClosed: () => {},
    autosaveRead: async () => clone(initial.autosave || null),
    autosaveWrite: async (d) => { calls.autosaveWrite.push(clone(d)); return { ok: true, path: '/tmp/autosave.json' }; },
    autosaveDelete: async () => { calls.autosaveDelete++; return { ok: true }; },
    autosaveFlushSync: (d) => { calls.autosaveFlushSync.push(clone(d)); return { ok: true }; },
    onCloseRequested: (cb) => { closeCallback = cb; },
    closeProceed: () => { calls.closeProceed++; },
    _setLoadSession: (d) => { loadSessionData = d; },
    _calls: calls,
    _getCloseCallback: () => closeCallback
  };
  return stub;
}

function boot(initial) {
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => { jsdomErrors.push(String(e.message || e)); });
  vc.on('error', (msg) => { jsdomErrors.push('console.error: ' + String(msg)); });
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'file://' + path.join(srcDir, 'index.html'), virtualConsole: vc });
  const win = dom.window;
  const stub = makeStub(initial);
  win.matchtag = stub;
  win.eval(integritySrc);
  win.eval(analyticsSrc);
  win.eval(playerSeasonSrc);
  win.eval(rendererSrc);
  return { dom, win, doc: win.document, stub };
}

// ---------------------------------------------------------------------------
// Static source-level checks
// ---------------------------------------------------------------------------
section('STATIC — Load Session guard wiring (source-level checks)');
{
  ok('LG-S1: index.html has loadConfirmModal + Cancel/Proceed buttons',
    html.includes('id="loadConfirmModal"') &&
    html.includes('id="btnLoadConfirmCancel"') &&
    html.includes('id="btnLoadConfirmProceed"'));

  ok('LG-S2: renderer.js defines the extracted doLoadSession() load flow',
    /async function doLoadSession\(\)/.test(rendererSrc));

  ok('LG-S3: btnLoadSession click handler guards on sessionDirty before anything else',
    /btnLoadSession\.addEventListener\('click',\s*async\s*\(\)\s*=>\s*\{\s*if\s*\(sessionDirty\)\s*\{/.test(rendererSrc));

  // The loadSession IPC call must live INSIDE doLoadSession, and only there.
  const ipcMatches = rendererSrc.match(/window\.matchtag\.loadSession\(/g) || [];
  const ipcIdx = rendererSrc.indexOf('window.matchtag.loadSession(');
  const fnIdx = rendererSrc.indexOf('async function doLoadSession()');
  ok('LG-S4: exactly one loadSession IPC call and it is inside doLoadSession()',
    ipcMatches.length === 1 && ipcIdx > -1 && fnIdx > -1 && ipcIdx > fnIdx);

  // Cancel must be a pure no-op: no state teardown, no autosave clear, no load.
  const cancelIdx = rendererSrc.indexOf('btnLoadConfirmCancel.addEventListener');
  const proceedIdx = rendererSrc.indexOf('btnLoadConfirmProceed.addEventListener');
  let cancelBlock = '';
  if (cancelIdx > -1 && proceedIdx > cancelIdx) cancelBlock = rendererSrc.slice(cancelIdx, proceedIdx);
  ok('LG-S5: Cancel handler exists and does not touch state, autosave or load',
    cancelBlock.length > 0 && !/clearAutosave|setClean|doLoadSession|matchtag|sessionDirty\s*=/.test(cancelBlock),
    cancelBlock ? 'block found' : 'cancel block missing');

  ok('LG-S6: Proceed handler runs the load flow',
    /btnLoadConfirmProceed\.addEventListener\('click',\s*async\s*\(\)\s*=>\s*\{[\s\S]{0,300}?doLoadSession\(\)/.test(rendererSrc));

  const fnEnd = rendererSrc.indexOf('btnLoadSession.addEventListener', fnIdx);
  const fnBody = fnIdx > -1 && fnEnd > fnIdx ? rendererSrc.slice(fnIdx, fnEnd) : '';
  ok('LG-S7: doLoadSession() reconciles the squad via Integrity + persistSquad',
    fnBody.includes('findMissingPlayerRefs') && fnBody.includes('persistSquad'),
    fnBody ? 'body found' : 'function body missing');

  ok('LG-S8: squad reconciliation is additive (no wholesale squad replacement)',
    !/squad\s*=\s*data\.squad/.test(rendererSrc) && !/squad\s*=\s*autosave\.squad/.test(rendererSrc) &&
    /squad\.push\(player\)/.test(rendererSrc));

  ok('LG-S9: recovery + safe-close code untouched (guard is additive)',
    rendererSrc.includes('function showRecoveryModal') &&
    rendererSrc.includes('async function recoverFromAutosave') &&
    rendererSrc.includes('function handleCloseRequested') &&
    rendererSrc.includes('function flushAutosaveSync') &&
    /We use the local squad/.test(rendererSrc));

  // The load-confirm modal must NOT be dismissible via the Escape key
  // (same protective policy as the recovery modal): a destructive choice
  // must never happen by accident.
  let escapeClean = true;
  let escFrom = 0;
  for (;;) {
    const i = rendererSrc.indexOf("e.key === 'Escape'", escFrom);
    if (i === -1) break;
    if (rendererSrc.slice(i, i + 600).includes('LoadConfirm')) escapeClean = false;
    escFrom = i + 1;
  }
  ok('LG-S10: Escape key does not dismiss the load-confirm modal', escapeClean);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
function fixtureEvent(id, label, playerId, matchSeconds) {
  return {
    id,
    label,
    team: 'our',
    side: 'for',
    playerId,
    playerOffId: null,
    playerOnId: null,
    subtype: null,
    qualifiers: {},
    location: null,
    isInterval: false,
    time: matchSeconds,
    matchTime: matchSeconds,
    matchSeconds,
    officialMinute: Math.ceil(matchSeconds / 60),
    second: matchSeconds * 1000,
    period: '1H',
    scoreForBefore: 0,
    scoreAgainstBefore: 0,
    sequenceId: null
  };
}

const XI = ['player_1', 'player_2', 'player_3', 'player_4', 'player_5', 'player_6', 'player_7', 'player_8', 'player_9', 'player_10', 'player_11'];

// A saved session from "another machine": 3 events, final score 2-1.
function fixtureOtherMachine() {
  return {
    __schemaVersion: 3,
    videoPath: null,
    videoUrl: null,
    tags: [],
    events: [
      fixtureEvent(1, 'Pass', 'player_4', 700),
      fixtureEvent(2, 'Goal', 'player_7', 1800),
      fixtureEvent(3, 'Foul', 'player_11', 2500)
    ],
    matchInfo: { opponent: 'Fixture FC', formation: '4-3-3', startingXI: XI },
    matchClock: {
      period: 'FT', clockBaseSeconds: 5400, clockRunning: false, clockStartedAt: null,
      scoreFor: 2, scoreAgainst: 1, videoSyncOffset: 0,
      selectedTeam: null, selectedPlayerId: null, activeSequenceId: null
    }
  };
}

(async () => {
  let B = null;
  function click(el, opts) { el.dispatchEvent(new B.win.MouseEvent('click', Object.assign({ bubbles: true, cancelable: true }, opts || {}))); }
  function change(el) { el.dispatchEvent(new B.win.Event('change', { bubbles: true })); }
  function id(x) { return B.doc.getElementById(x); }
  function txt(x) { const e = id(x); return e ? e.textContent : null; }
  function tagBtn(label) {
    return Array.from(B.doc.querySelectorAll('#tagButtons .tag-btn')).find((b) => b.textContent.replace('⏱', '').trim().startsWith(label));
  }
  function rowCount() { return B.doc.querySelectorAll('#eventList .event-row').length; }
  function scoreboard() { return txt('scoreboardDisplay'); }
  function selectPlayer(pid) { const sel = id('selectedPlayerSelect'); sel.value = pid; change(sel); }
  function selectTeam(team) { click(team === 'our' ? id('btnTeamOur') : id('btnTeamOpponent')); }
  function detailDone() { const b = id('detailPanelDone'); if (b) click(b); }
  function playerOptionValues() {
    const sel = id('selectedPlayerSelect');
    return sel ? Array.from(sel.options).map((o) => o.value) : [];
  }
  function modalShown(x) { const m = id(x); return !!m && m.style.display === 'flex'; }
  function toastShown() { const t = id('autosaveToast'); return !!t && t.style.display === 'flex'; }

  // =====================================================================
  section('BOOT A — dirty session: guard, cancel preserves, confirm loads');
  // =====================================================================
  {
    B = boot({ squad: [
      { id: 'player_1', number: '1', name: 'Guard One' },
      { id: 'player_2', number: '2', name: 'Guard Two' },
      { id: 'player_3', number: '3', name: 'Guard Three' }
    ] });
    await sleep(300); // let loadSquad + player selector settle

    // Tag two events (Pass + Goal for 'our') -> dirty session, score 1-0.
    selectTeam('our');
    selectPlayer('player_1');
    click(tagBtn('Pass'));
    detailDone();
    click(tagBtn('Goal'));
    detailDone();
    await sleep(50);

    ok('LG1: two events tagged, dirty indicator shows Unsaved',
      rowCount() === 2 && /Unsaved/.test(txt('dirtyIndicator')), 'rows=' + rowCount() + ' dirty=' + txt('dirtyIndicator'));
    ok('LG2: scoreboard 1 — 0 after our goal', scoreboard() === '1 — 0', scoreboard());

    // Snapshot the autosave-delete count BEFORE the Load click. (The
    // pre-existing scheduleAutosave "dirty but no autosavable work" branch
    // may legitimately have fired one stale-clear autosaveDelete earlier,
    // e.g. when a team was selected before any player/event existed — so
    // the guard checks below assert DELTAS, not absolute counts.)
    const deletesBeforeLoad = B.stub._calls.autosaveDelete;

    // --- Guard: click Load session while dirty -------------------------
    click(id('btnLoadSession'));
    await sleep(80);

    ok('LG3: guard intercepts — loadSession IPC NOT called', B.stub._calls.loadSession === 0, 'calls=' + B.stub._calls.loadSession);
    ok('LG4: load-confirm modal visible', modalShown('loadConfirmModal'), 'display=' + (id('loadConfirmModal') ? id('loadConfirmModal').style.display : 'missing'));
    ok('LG5: close-confirm modal NOT misused for the load guard', !modalShown('unsavedConfirmModal'));

    // --- Cancel ---------------------------------------------------------
    const cancelBtn = id('btnLoadConfirmCancel');
    if (!cancelBtn) {
      ok('LG6: cancel button exists', false, 'btnLoadConfirmCancel missing');
    } else {
      click(cancelBtn);
      await sleep(80);
      ok('LG6: cancel hides the modal', !modalShown('loadConfirmModal'));
      ok('LG7: cancel preserves events and score', rowCount() === 2 && scoreboard() === '1 — 0', 'rows=' + rowCount() + ' score=' + scoreboard());
      ok('LG8: cancel keeps the session dirty (Unsaved)', /Unsaved/.test(txt('dirtyIndicator')), txt('dirtyIndicator'));
      ok('LG9: cancel does NOT clear the autosave (no new autosaveDelete)',
        B.stub._calls.autosaveDelete === deletesBeforeLoad,
        'before=' + deletesBeforeLoad + ' after=' + B.stub._calls.autosaveDelete);
      ok('LG10: cancel does not open the file (loadSession still 0)', B.stub._calls.loadSession === 0, 'calls=' + B.stub._calls.loadSession);

      // The pending debounced autosave must still fire after cancel —
      // proving the safety net survived (setClean/clearAutosave would have
      // cancelled the timer).
      await sleep(1750);
      const P = B.stub._calls.autosaveWrite[B.stub._calls.autosaveWrite.length - 1];
      ok('LG11: pending autosave still fires after cancel (safety net intact)',
        P && P.events.length === 2, P ? 'events=' + P.events.length : 'no autosave write');
    }

    // --- Confirm ---------------------------------------------------------
    B.stub._setLoadSession(fixtureOtherMachine());
    click(id('btnLoadSession'));
    await sleep(80);
    ok('LG12: re-click while dirty shows the modal again', modalShown('loadConfirmModal') && B.stub._calls.loadSession === 0);

    const proceedBtn = id('btnLoadConfirmProceed');
    if (!proceedBtn) {
      ok('LG13: proceed button exists', false, 'btnLoadConfirmProceed missing');
    } else {
      click(proceedBtn);
      await sleep(250);
      ok('LG13: confirm runs the load (loadSession called once)', B.stub._calls.loadSession === 1, 'calls=' + B.stub._calls.loadSession);
      ok('LG14: loaded session replaces state (3 events, 2 — 1, Full-time)',
        rowCount() === 3 && scoreboard() === '2 — 1' && txt('matchPeriodDisplay') === 'Full-time' && txt('matchClockDisplay') === '90:00',
        'rows=' + rowCount() + ' score=' + scoreboard() + ' period=' + txt('matchPeriodDisplay'));
      ok('LG15: successful load marks the session clean (Saved)', /Saved/.test(txt('dirtyIndicator')), txt('dirtyIndicator'));
      ok('LG16: successful load clears the autosave exactly once (existing behavior)',
        B.stub._calls.autosaveDelete === deletesBeforeLoad + 1,
        'before=' + deletesBeforeLoad + ' after=' + B.stub._calls.autosaveDelete);
      ok('LG17: clock restored STOPPED (pause disabled)', id('btnClockPause').disabled === true);
    }
  }

  // =====================================================================
  section('BOOT B — clean session loads directly (no false-positive modal)');
  // =====================================================================
  {
    B = boot({ squad: [
      { id: 'player_1', number: '1', name: 'Clean One' },
      { id: 'player_2', number: '2', name: 'Clean Two' }
    ] });
    await sleep(300);

    const fx = clone(fixtureOtherMachine());
    fx.events = fx.events.slice(0, 2);
    fx.matchClock.scoreFor = 0;
    fx.matchClock.scoreAgainst = 0;
    B.stub._setLoadSession(fx);

    ok('LG18: clean session starts not dirty', /Saved/.test(txt('dirtyIndicator')), txt('dirtyIndicator'));
    click(id('btnLoadSession'));
    await sleep(250);
    ok('LG19: NO modal — load runs immediately', !modalShown('loadConfirmModal') && B.stub._calls.loadSession === 1, 'calls=' + B.stub._calls.loadSession);
    ok('LG20: clean load still restores the session', rowCount() === 2 && scoreboard() === '0 — 0', 'rows=' + rowCount() + ' score=' + scoreboard());
  }

  // =====================================================================
  section('BOOT C — manual load squad reconciliation (merge + warn)');
  // =====================================================================
  {
    B = boot({ squad: [
      { id: 'player_1', number: '1', name: 'Local One' },
      { id: 'player_2', number: '2', name: 'Local Two' }
    ] });
    await sleep(300);

    // Session saved on another machine: references player_5 (present in the
    // embedded squad) and player_9 (NOT in the embedded squad). The embedded
    // squad also contains unreferenced player_7, which must NOT be merged.
    const fx = fixtureOtherMachine();
    fx.events = [
      fixtureEvent(1, 'Pass', 'player_5', 700),
      fixtureEvent(2, 'Foul', 'player_9', 900)
    ];
    fx.squad = [
      { id: 'player_1', number: '1', name: 'Local One' },
      { id: 'player_2', number: '2', name: 'Local Two' },
      { id: 'player_5', number: '5', name: 'Away Five' },
      { id: 'player_7', number: '7', name: 'Away Seven' }
    ];
    fx.matchClock.scoreFor = 0;
    fx.matchClock.scoreAgainst = 0;
    B.stub._setLoadSession(fx);

    click(id('btnLoadSession'));
    await sleep(350);

    const savedSquad = B.stub._calls.saveSquad[B.stub._calls.saveSquad.length - 1];
    const savedIds = savedSquad ? savedSquad.map((p) => p.id) : null;
    ok('LG21: missing REFERENCED player_5 restored from the embedded squad',
      savedIds && savedIds.includes('player_5'), savedIds ? savedIds.join(',') : 'no saveSquad call');
    ok('LG22: local players kept (additive merge, nothing replaced)',
      savedIds && savedIds.includes('player_1') && savedIds.includes('player_2') && savedIds.length === 3, savedIds ? savedIds.join(',') : 'no saveSquad call');
    ok('LG23: unreferenced embedded player_7 NOT merged',
      savedIds && !savedIds.includes('player_7'), savedIds ? savedIds.join(',') : 'no saveSquad call');
    ok('LG24: unresolvable player_9 NOT fabricated into the squad',
      savedIds && !savedIds.includes('player_9'), savedIds ? savedIds.join(',') : 'no saveSquad call');

    const toastText = txt('autosaveToastText') || '';
    ok('LG25: warning toast visible and mentions the still-missing reference',
      toastShown() && /not currently in your squad/.test(toastText) && /loaded event/.test(toastText), toastText);
    ok('LG26: toast mentions the restored player(s)',
      /restored/.test(toastText), toastText);

    const options = playerOptionValues();
    ok('LG27: player selector offers restored player_5 (with name)',
      options.includes('player_5'), options.join(','));
    ok('LG28: player_9 stays absent from the selector', !options.includes('player_9'), options.join(','));

    const rows = Array.from(B.doc.querySelectorAll('#eventList .event-row'));
    ok('LG29: player_5 event resolves to the restored name (no Unknown)',
      rows.length === 2 && /Away Five/.test(rows[0].textContent) && !/Unknown/.test(rows[0].textContent), rows[0] ? rows[0].textContent : 'no rows');
    ok('LG30: player_9 event honestly shows Unknown player',
      rows.length === 2 && /Unknown player/.test(rows[1].textContent), rows[1] ? rows[1].textContent : 'no rows');
  }

  // =====================================================================
  section('BOOT D — all references resolve: no merge, no persist, no toast');
  // =====================================================================
  {
    B = boot({ squad: [
      { id: 'player_1', number: '1', name: 'Done One' },
      { id: 'player_2', number: '2', name: 'Done Two' }
    ] });
    await sleep(300);

    const fx = fixtureOtherMachine();
    fx.events = [fixtureEvent(1, 'Pass', 'player_1', 700)];
    fx.squad = [
      { id: 'player_1', number: '1', name: 'Done One' },
      { id: 'player_2', number: '2', name: 'Done Two' },
      { id: 'player_8', number: '8', name: 'Ghost Eight' }
    ];
    fx.matchClock.scoreFor = 0;
    fx.matchClock.scoreAgainst = 0;
    B.stub._setLoadSession(fx);

    click(id('btnLoadSession'));
    await sleep(350);

    ok('LG31: no squad merge when nothing is missing (saveSquad not called)',
      B.stub._calls.saveSquad.length === 0, 'calls=' + B.stub._calls.saveSquad.length);
    ok('LG32: no warning toast when nothing is missing', !toastShown(), 'display=' + (id('autosaveToast') ? id('autosaveToast').style.display : 'missing'));
    ok('LG33: session still loads normally (1 event)',
      rowCount() === 1 && /Saved/.test(txt('dirtyIndicator')), 'rows=' + rowCount() + ' dirty=' + txt('dirtyIndicator'));
    const options = playerOptionValues();
    ok('LG34: unreferenced embedded player_8 not merged into the live squad',
      !options.includes('player_8'), options.join(','));
  }

  // ---------------------------------------------------------------------
  // Report
  // ---------------------------------------------------------------------
  section('RESULTS');
  let pass = 0, fail = 0;
  results.forEach((r) => { if (r.pass) pass++; else fail++; });
  results.forEach((r) => {
    if (!r.pass) console.log('  FAIL [' + r.section + '] ' + r.name + (r.detail ? '  (' + r.detail + ')' : ''));
  });
  if (jsdomErrors.length) {
    console.log('  jsdom errors captured: ' + jsdomErrors.length);
    jsdomErrors.slice(0, 10).forEach((e) => console.log('    ' + e));
    fail += jsdomErrors.length;
  }
  console.log('---- load-session guard check: ' + pass + ' passed, ' + fail + ' failed ----');
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('HARNESS CRASH:', err && err.stack ? err.stack : err);
  process.exit(1);
});
