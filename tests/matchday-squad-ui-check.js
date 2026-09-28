#!/usr/bin/env node
// PitchLog / MatchTag — R3-B Stage 1: Matchday squads UI harness (behavioral).
// ============================================================================
// Verification-only harness. It does NOT modify any app source file.
//
// Boots the REAL index.html + integrity.js + roster.js + analytics.js +
// player-season.js + renderer.js into jsdom with a stubbed window.matchtag
// bridge (call capture — same architecture as roster-renderer-check.js) and
// verifies the OUR-TEAM Matchday Squad panel (R3-B Stage 1) end-to-end:
//
//   MS-W   source-level wiring: script chain unchanged; statuses only via
//          matchRosterApi mutators (no direct .status writes — the R3-W7
//          discipline extended to the UI); R3-W4's two normalize sites
//          preserved; Escape closes the modal; the matchday-squad DOM
//          surface is exactly the approved 9-id set; no roster-labeled DOM
//          ids anywhere; the panel section never persists the global squad.
//   MS-1   open/close + structure: zones render; a clean open never
//          dirties; opponent entries never render in the our-team panel.
//   MS-2/3 add-from-squad: canonical six-field entries seeded from squad
//          facts; never a saveSquad; add-all; counts refresh.
//   MS-4   shirt/position/role edits: read-merge-write (fields preserved);
//          junk shirt → null; D5 isolation.
//   MS-5   D1 reconciliation: adds never touch slots; promote → first free
//          slot; demote → slot released; XI editor assign/move/replace/
//          clear with starter↔sub transitions; live 'on' statuses never
//          overwritten; XI hint counts.
//   MS-6   remove from the MATCH roster only (global squad intact, XI slot
//          released, opponent untouched).
//   MS-7   a hostile squad entry in the opponent namespace is never offered.
//   MS-8   persistence: panel work is autosavable; manual save carries the
//          roster AND the reconciled startingXI.
//   MS-9   loaded sessions render in the panel (overlay names, squad
//          fallback names, loaded XI, counts, badges) — view-only open
//          stays clean.
//   MS-10  D4/D6 advisories: duplicate-shirt warning; nothing blocks.
//   MS-11  stale XI mappings: open shows the formation skeleton WITHOUT
//          rewriting the stored mapping; the first write materializes it.
//   MS-12  non-roster XI references (squad-only players) stay visible and
//          are replaceable.
//
// Run:  node tests/matchday-squad-ui-check.js   (from the project root)
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
// matchtag stub with full call capture (identical shape to
// roster-renderer-check.js — the panel must ride the exact same bridge).
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
function lastAutosaveWrite(stub) { const a = stub._calls.autosaveWrite; return a.length ? a[a.length - 1] : null; }
function lastSave(stub) { const a = stub._calls.saveSession; return a.length ? a[a.length - 1] : null; }

// ----- panel-driving helpers -----
function openPanel(B) { clickIn(B, B.doc.getElementById('btnMatchdaySquad')); }
function xiSelect(B, i) { return B.doc.querySelector('#matchdaySquadXi select[data-mds-xi-index="' + i + '"]'); }
function xiValue(B, i) { const sel = xiSelect(B, i); return sel ? sel.value : null; }
function setXiSlot(B, i, playerId) {
  const sel = xiSelect(B, i);
  if (!sel) throw new Error('no XI select at index ' + i);
  sel.value = playerId;
  sel.dispatchEvent(new B.win.Event('change', { bubbles: true }));
}
function setRowField(B, playerId, selector, value) {
  const row = B.doc.querySelector('.matchday-squad-row[data-mds-player-id="' + playerId + '"]');
  if (!row) throw new Error('no roster row for ' + playerId);
  const el = row.querySelector(selector);
  if (!el) throw new Error('no ' + selector + ' in row for ' + playerId);
  el.value = value;
  el.dispatchEvent(new B.win.Event('change', { bubbles: true }));
}
function setRowStatus(B, playerId, status) { setRowField(B, playerId, '.mds-status', status); }
function statusOf(B, playerId) {
  const e = B.win.matchRosterApi.get().our.find((p) => p.playerId === playerId);
  return e ? e.status : null;
}
function addSquadPlayerViaPanel(B, playerId) {
  const btn = B.doc.querySelector('#matchdaySquadAddList .matchday-add-chip[data-mds-add-id="' + playerId + '"] .mds-add-btn');
  if (!btn) throw new Error('no add chip for ' + playerId);
  clickIn(B, btn);
}
function setFormationViaMatchSetup(B, formation) {
  clickIn(B, B.doc.getElementById('btnMatchSetup'));
  const sel = B.doc.getElementById('matchFormation');
  sel.value = formation;
  sel.dispatchEvent(new B.win.Event('change', { bubbles: true }));
  clickIn(B, B.doc.getElementById('btnSaveMatchSetup'));
}

// ----- fixtures -----
const SQUAD = [
  { id: 'player_1', number: '1', name: 'GK Kid' },
  { id: 'player_6', number: '6', name: 'Came Off' },
  { id: 'player_9', number: '22', name: 'Super Sub' },
  { id: 'player_12', number: '12', name: 'Bench Warmer' },
  { id: 'player_20', number: '20', name: 'Squad Twenty' },
  { id: 'player_25', number: '25', name: 'Late Callup' }
];

// A complete schema-v4 session whose startingXI matches its 4-4-2 formation
// (11 slots, 2 filled). The roster overlays three our-players (one with an
// empty displayName to exercise the squad-name fallback) plus one opponent.
const SESSION_FULL_XI = {
  __schemaVersion: 4,
  __savedAt: '2026-02-01T00:00:00.000Z',
  videoPath: null,
  tags: [],
  events: [],
  squad: SQUAD,
  matchInfo: {
    competition: 'EPL', date: '2026-02-01', opponent: 'Hawassa City', venue: 'Home',
    homeAway: 'home', ourScore: '0', opponentScore: '0', formation: '4-4-2',
    startingXI: [
      { position: 'GK', playerId: 'player_1' },
      { position: 'RB', playerId: '' },
      { position: 'CB', playerId: '' },
      { position: 'CB', playerId: '' },
      { position: 'LB', playerId: '' },
      { position: 'RM', playerId: '' },
      { position: 'CM', playerId: '' },
      { position: 'CM', playerId: '' },
      { position: 'LM', playerId: '' },
      { position: 'ST', playerId: 'player_9' },
      { position: 'ST', playerId: '' }
    ]
  },
  matchClock: {
    clockStartedAt: null, clockBaseSeconds: 0, clockRunning: false, period: '1H',
    scoreFor: 0, scoreAgainst: 0, videoSyncOffset: 0, selectedTeam: 'our',
    selectedPlayerId: null, activeSequenceId: null, nextSequenceNumber: 1
  },
  matchRoster: {
    our: [
      { playerId: 'player_1', displayName: 'GK Kid (matchday)', shirtNumber: 1, position: 'GK', role: 'Captain', status: 'starter' },
      { playerId: 'player_9', displayName: '', shirtNumber: 22, position: 'MF', role: '', status: 'starter' },
      { playerId: 'player_12', displayName: 'Bench Warmer', shirtNumber: 12, position: 'FW', role: '', status: 'bench' }
    ],
    opponent: [
      { playerId: 'match_opp_1', displayName: 'Opp One', shirtNumber: 9, position: 'ST', role: '', status: 'starter' }
    ]
  }
};

// Same session but with a STALE 2-slot startingXI under a 4-3-3 formation
// (the R3-A fixture shape): the panel must show the 11-slot skeleton,
// preserving assignments by position, WITHOUT rewriting the stored mapping
// until the user actually writes a slot.
const SESSION_STALE_XI = clone(SESSION_FULL_XI);
SESSION_STALE_XI.matchInfo.formation = '4-3-3';
SESSION_STALE_XI.matchInfo.startingXI = [
  { position: 'GK', playerId: 'player_1' },
  { position: 'ST', playerId: 'player_9' }
];

(async () => {

  // =======================================================================
  section('MS-W — source-level wiring');
  {
    const srcScripts = (html.match(/<script src="([^"]+)"/g) || []).map((s) => s.slice(13, -1));
    ok('MS-W1: script chain unchanged (integrity → roster → analytics → player-season → recent-form → season-csv → renderer)',
      JSON.stringify(srcScripts) === JSON.stringify(['integrity.js', 'roster.js', 'analytics.js', 'player-season.js', 'recent-form.js', 'season-csv.js', 'renderer.js']),
      srcScripts.join(','));
    ok('MS-W2: renderer never assigns roster status directly (statuses only via matchRosterApi mutators; === comparisons allowed)',
      !/\.status\s*=(?!=)/.test(rendererSrc));
    ok('MS-W3: R3-W4 shape preserved — exactly 2 direct normalizeMatchRoster assignments (load + recovery)',
      (rendererSrc.match(/matchRoster = window\.Roster\.normalizeMatchRoster\(/g) || []).length === 2);
    ok('MS-W4: BOTH Escape branches (focus-in-form and focus-elsewhere) close the matchday squad modal',
      (rendererSrc.match(/closeSeasonModal\(\);\s*closeMatchdaySquadModal\(\);\s*settleTagConfirm\(false\)/g) || []).length === 2);
    const APPROVED = [
      'btnMatchdaySquad', 'matchdaySquadModal', 'matchdaySquadCounts', 'matchdaySquadXiHint',
      'matchdaySquadXi', 'matchdaySquadList', 'matchdaySquadAddList',
      'btnAddAllMatchdaySquad', 'btnCloseMatchdaySquad'
    ];
    const htmlMdIds = (html.match(/id="[^"]*atchday[^"]*quad[^"]*"/g) || []).map((s) => s.slice(4, -1));
    const rendererLookups = (rendererSrc.match(/getElementById\('[^']*atchday[^']*quad[^']*'\)/g) || []).map((s) => s.slice(s.indexOf("'") + 1, s.lastIndexOf("'")));
    ok('MS-W5: the matchday-squad DOM surface is exactly the approved 9-id set (html + renderer lookups confined)',
      APPROVED.every((id) => (html.match(new RegExp('id="' + id + '"', 'g')) || []).length === 1) &&
      APPROVED.every((id) => rendererSrc.indexOf("getElementById('" + id + "')") !== -1) &&
      htmlMdIds.every((id) => APPROVED.indexOf(id) !== -1) &&
      rendererLookups.every((id) => APPROVED.indexOf(id) !== -1),
      'html=' + JSON.stringify(htmlMdIds) + ' lookups=' + JSON.stringify(rendererLookups));
    ok('MS-W6: no DOM id contains "roster" and the renderer looks up no roster-named id (R3-W5 original clauses)',
      !(html.match(/id="[^"]*[Rr]oster[^"]*"/g) || []).length &&
      !/getElementById\('[^']*[Rr]oster[^']*'\)/.test(rendererSrc));
    ok('MS-W7: the panel section never persists the global squad (no saveSquad / persistSquad invocation inside it; its comments may name the guarantee)',
      (() => {
        const start = rendererSrc.indexOf('Matchday squads — our-team panel');
        const end = rendererSrc.indexOf('---------- Time formatting ----------');
        const panelSection = rendererSrc.slice(start, end);
        // Call-syntax match only: the shipped block DOCUMENTS the guarantee
        // in comments that contain the bare words ("persistSquad/saveSquad"),
        // so a bare-word regex false-positives on prose. Any real persistence
        // call in this codebase uses invocation syntax — persistSquad() or
        // window.matchtag.saveSquad(...) — which this regex catches.
        return start !== -1 && end !== -1 && !/(?:persistSquad|saveSquad)\s*\(/.test(panelSection);
      })());
  }

  // =======================================================================
  section('MS-1 — open/close + structure + no phantom writes');
  {
    const B = boot({ squad: SQUAD });
    const { doc, stub } = B;
    await sleep(400);
    const api = B.win.matchRosterApi;

    openPanel(B);
    await sleep(50);
    ok('MS-1a: the topbar button opens the Matchday-squads modal',
      doc.getElementById('matchdaySquadModal').style.display === 'flex');
    ok('MS-1b: opening on a clean boot does NOT dirty the session and writes no autosave (view-only open)',
      api.isSessionDirty() === false && stub._calls.autosaveWrite.length === 0);
    ok('MS-1c: empty-roster structure — counts zone, XI "no formation" note, empty-squad note, 6 add chips, Add-all enabled',
      /Starters <b>0<\/b>/.test(doc.getElementById('matchdaySquadCounts').innerHTML) &&
      /No formation set/.test(doc.getElementById('matchdaySquadXi').textContent) &&
      /No players in this match/.test(doc.getElementById('matchdaySquadList').textContent) &&
      doc.querySelectorAll('#matchdaySquadAddList .matchday-add-chip').length === 6 &&
      doc.getElementById('btnAddAllMatchdaySquad').disabled === false);
    ok('MS-1d: opponent-roster entries are never rendered in the our-team panel (isolation by side)',
      (() => {
        api.upsertPlayer('opponent', { displayName: 'Opp Winger', shirtNumber: 7, position: 'RW' });
        clickIn(B, doc.getElementById('btnCloseMatchdaySquad'));
        openPanel(B);
        return !/Opp Winger/.test(doc.getElementById('matchdaySquadModal').textContent) &&
          api.get().opponent.length === 1;
      })());
    ok('MS-1e: Done closes the modal; Escape closes it from BOTH a form control and plain (non-form) focus',
      (() => {
        clickIn(B, doc.getElementById('btnCloseMatchdaySquad'));
        const doneClosed = doc.getElementById('matchdaySquadModal').style.display === 'none';
        openPanel(B);
        // focus inside a form control → the INPUT/SELECT/TEXTAREA branch
        doc.getElementById('matchFormation').dispatchEvent(new B.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        const escFormClosed = doc.getElementById('matchdaySquadModal').style.display === 'none';
        openPanel(B);
        // focus on a plain element (body) → the non-input branch
        doc.body.dispatchEvent(new B.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        const escBodyClosed = doc.getElementById('matchdaySquadModal').style.display === 'none';
        return doneClosed && escFormClosed && escBodyClosed;
      })());
    B.dom.window.close();
  }

  // =======================================================================
  section('MS-2/3 — add from global squad (+ add-all)');
  {
    const B = boot({ squad: SQUAD });
    const { doc, stub } = B;
    await sleep(400);
    const api = B.win.matchRosterApi;
    openPanel(B);
    await sleep(50);

    addSquadPlayerViaPanel(B, 'player_1');
    await sleep(30);
    const entry = api.get().our.find((p) => p.playerId === 'player_1');
    ok('MS-2a: adding a squad player creates the canonical six-field entry (squad name, normalized shirt, bench default)',
      !!entry && entry.displayName === 'GK Kid' && entry.shirtNumber === 1 && entry.position === '' &&
      entry.role === '' && entry.status === 'bench' &&
      JSON.stringify(Object.keys(entry)) === JSON.stringify(['playerId', 'displayName', 'shirtNumber', 'position', 'role', 'status']),
      JSON.stringify(entry));
    ok('MS-2b: the add marks the session dirty (autosave-eligible roster work)',
      api.isSessionDirty() === true);
    ok('MS-2c: the global squad is NEVER written (no saveSquad call)',
      stub._calls.saveSquad.length === 0);
    ok('MS-2d: the add list refreshes (5 remaining) and the counts update (Match squad 1)',
      doc.querySelectorAll('#matchdaySquadAddList .matchday-add-chip').length === 5 &&
      /Match squad <b>1<\/b>/.test(doc.getElementById('matchdaySquadCounts').innerHTML));
    ok('MS-2e: the new row renders with the squad name and the shirt input prefilled',
      (() => {
        const row = doc.querySelector('.matchday-squad-row[data-mds-player-id="player_1"]');
        return !!row && /GK Kid/.test(row.textContent) && row.querySelector('.mds-shirt').value === '1';
      })());

    clickIn(B, doc.getElementById('btnAddAllMatchdaySquad'));
    await sleep(50);
    ok('MS-3a: Add-all brings every remaining squad player in (6 total rows)',
      api.get().our.length === 6 && doc.querySelectorAll('.matchday-squad-row').length === 6);
    ok('MS-3b: the add list reports completeness and disables Add-all',
      /already in this match/.test(doc.getElementById('matchdaySquadAddList').textContent) &&
      doc.getElementById('btnAddAllMatchdaySquad').disabled === true);

    // MS-4 continues in this window.
    setRowField(B, 'player_9', '.mds-shirt', '9');
    await sleep(30);
    setRowField(B, 'player_9', '.mds-position', 'MF');
    await sleep(30);
    setRowField(B, 'player_9', '.mds-role', 'Captain');
    await sleep(30);
    const e9 = api.get().our.find((p) => p.playerId === 'player_9');
    ok('MS-4a: shirt/position/role edits merge into the entry (all other fields preserved, canonical shape kept)',
      e9.shirtNumber === 9 && e9.position === 'MF' && e9.role === 'Captain' &&
      e9.displayName === 'Super Sub' && e9.status === 'bench' &&
      JSON.stringify(Object.keys(e9)) === JSON.stringify(['playerId', 'displayName', 'shirtNumber', 'position', 'role', 'status']),
      JSON.stringify(e9));
    setRowField(B, 'player_9', '.mds-shirt', 'xx');
    await sleep(30);
    ok('MS-4b: a non-numeric shirt normalizes to null (unknown) — permissive, never a crash',
      api.get().our.find((p) => p.playerId === 'player_9').shirtNumber === null);
    ok('MS-4c: field edits never write the global squad (D5 isolation)',
      stub._calls.saveSquad.length === 0);
    B.dom.window.close();
  }

  // =======================================================================
  section('MS-5 — status designation + D1 XI reconciliation');
  {
    const B = boot({ squad: SQUAD });
    const { doc } = B;
    await sleep(400);
    const api = B.win.matchRosterApi;
    setFormationViaMatchSetup(B, '4-3-3');
    await sleep(50);
    openPanel(B);
    await sleep(50);
    ['player_1', 'player_9', 'player_12', 'player_6'].forEach((id) => {
      addSquadPlayerViaPanel(B, id);
    });
    await sleep(50);

    ok('MS-5a: adds never touch the XI (all bench, hint 0/11, no slot filled)',
      api.get().our.every((p) => p.status === 'bench') &&
      /4-3-3 · 0\/11 filled/.test(doc.getElementById('matchdaySquadXiHint').textContent) &&
      xiValue(B, 0) === '' && doc.querySelectorAll('#matchdaySquadXi select').length === 11);

    setRowStatus(B, 'player_1', 'starter');
    await sleep(30);
    ok('MS-5b: promoting a bench player via the row control fills their first free XI slot (GK) and sets starter',
      statusOf(B, 'player_1') === 'starter' && xiValue(B, 0) === 'player_1');

    setRowStatus(B, 'player_1', 'bench');
    await sleep(30);
    ok('MS-5c: demoting a starter to Sub releases their XI slot',
      statusOf(B, 'player_1') === 'bench' && xiValue(B, 0) === '');

    setXiSlot(B, 3, 'player_9');
    await sleep(30);
    ok('MS-5d: assigning a player to a slot via the XI editor promotes them to starter',
      xiValue(B, 3) === 'player_9' && statusOf(B, 'player_9') === 'starter');
    ok('MS-5e: the roster row shows the XI slot badge while slotted',
      (() => {
        const badge = doc.querySelector('.matchday-squad-row[data-mds-player-id="player_9"] .mds-xi-badge');
        return !!badge && /XI CB/.test(badge.textContent);
      })());

    setXiSlot(B, 9, 'player_9');
    await sleep(30);
    ok('MS-5f: reassigning a player MOVES them (previous slot emptied, still a starter)',
      xiValue(B, 3) === '' && xiValue(B, 9) === 'player_9' && statusOf(B, 'player_9') === 'starter');

    setXiSlot(B, 9, 'player_12');
    await sleep(30);
    ok('MS-5g: replacing a starter in a slot returns the displaced player to Sub and promotes the newcomer',
      xiValue(B, 9) === 'player_12' && statusOf(B, 'player_9') === 'bench' && statusOf(B, 'player_12') === 'starter');

    setXiSlot(B, 9, '');
    await sleep(30);
    ok('MS-5h: clearing a slot returns the displaced starter to Sub',
      xiValue(B, 9) === '' && statusOf(B, 'player_12') === 'bench');

    setRowStatus(B, 'player_6', 'on');
    await sleep(30);
    setXiSlot(B, 2, 'player_6');
    await sleep(30);
    ok('MS-5i: assigning an on-pitch player to a slot never overwrites their live status',
      xiValue(B, 2) === 'player_6' && statusOf(B, 'player_6') === 'on');
    setXiSlot(B, 2, '');
    await sleep(30);
    ok('MS-5j: clearing the slot of an on-pitch player leaves the live status untouched',
      xiValue(B, 2) === '' && statusOf(B, 'player_6') === 'on');
    ok('MS-5k: the XI hint shows formation + filled count after the churn (0/11)',
      /4-3-3 · 0\/11 filled/.test(doc.getElementById('matchdaySquadXiHint').textContent));
    B.dom.window.close();
  }

  // =======================================================================
  section('MS-6 — remove from the MATCH roster only');
  {
    const B = boot({ squad: SQUAD });
    const { doc, stub } = B;
    await sleep(400);
    const api = B.win.matchRosterApi;
    api.upsertPlayer('opponent', { displayName: 'Opp Anchor', shirtNumber: 5, position: 'CB' });
    const opponentBefore = JSON.stringify(api.get().opponent);
    setFormationViaMatchSetup(B, '4-3-3');
    await sleep(50);
    openPanel(B);
    await sleep(50);
    addSquadPlayerViaPanel(B, 'player_1');
    await sleep(30);
    addSquadPlayerViaPanel(B, 'player_9');
    await sleep(30);
    setRowStatus(B, 'player_1', 'starter');
    await sleep(30);
    clickIn(B, doc.querySelector('.matchday-squad-row[data-mds-player-id="player_1"] .mds-remove'));
    await sleep(50);

    ok('MS-6a: removal drops the entry from the MATCH roster only (player back in the add list, never a saveSquad)',
      !api.get().our.some((p) => p.playerId === 'player_1') &&
      api.get().our.length === 1 &&
      doc.querySelectorAll('#matchdaySquadAddList .matchday-add-chip').length === 5 &&
      stub._calls.saveSquad.length === 0);
    ok('MS-6b: removal releases the player\'s XI slot',
      xiValue(B, 0) === '');
    ok('MS-6c: the opponent roster is byte-identical after our-panel operations',
      JSON.stringify(api.get().opponent) === opponentBefore);
    ok('MS-6d: the surviving row is intact',
      statusOf(B, 'player_9') === 'bench' &&
      !!doc.querySelector('.matchday-squad-row[data-mds-player-id="player_9"]'));
    B.dom.window.close();
  }

  // =======================================================================
  section('MS-7 — hostile squad entry (opponent namespace) never offered');
  {
    const B = boot({ squad: SQUAD.concat([{ id: 'match_opp_2', number: '66', name: 'SMUGGLED' }]) });
    const { doc } = B;
    await sleep(400);
    const api = B.win.matchRosterApi;
    openPanel(B);
    await sleep(50);
    ok('MS-7a: a hostile squad entry in the opponent namespace is never offered on the our side',
      doc.querySelectorAll('#matchdaySquadAddList .matchday-add-chip').length === 6 &&
      !/SMUGGLED/.test(doc.getElementById('matchdaySquadModal').textContent));
    clickIn(B, doc.getElementById('btnAddAllMatchdaySquad'));
    await sleep(50);
    ok('MS-7b: add-all also rejects the hostile entry (6 our-players, none in the opponent namespace)',
      api.get().our.length === 6 &&
      api.get().our.every((p) => !/^match_opp_/.test(p.playerId)));
    B.dom.window.close();
  }

  // =======================================================================
  section('MS-8 — persistence (autosave eligibility + manual save payload)');
  {
    const B = boot({ squad: SQUAD });
    const { doc, stub } = B;
    await sleep(400);
    const api = B.win.matchRosterApi;
    setFormationViaMatchSetup(B, '4-3-3');
    await sleep(50);
    openPanel(B);
    await sleep(50);
    addSquadPlayerViaPanel(B, 'player_1');
    await sleep(30);
    setRowStatus(B, 'player_1', 'starter');
    await sleep(1900); // > AUTOSAVE_DEBOUNCE_MS (1500)

    ok('MS-8a: panel mutations are autosavable work — the debounced autosave fires with the roster AND the reconciled XI',
      (() => {
        const w = lastAutosaveWrite(stub);
        return !!w && w.matchRoster && w.matchRoster.our.length === 1 &&
          w.matchRoster.our[0].status === 'starter' &&
          w.matchInfo && w.matchInfo.startingXI[0].playerId === 'player_1';
      })());

    stub._setSaveResult({ canceled: false, filePath: '/tmp/mds.json' });
    clickIn(B, doc.getElementById('btnSaveSession'));
    await sleep(300);
    const saved = lastSave(stub);
    ok('MS-8b: the manual save payload carries the panel-built roster and the reconciled startingXI',
      !!saved && saved.matchRoster.our.length === 1 && saved.matchRoster.our[0].status === 'starter' &&
      saved.matchInfo.startingXI.length === 11 && saved.matchInfo.startingXI[0].playerId === 'player_1');
    B.dom.window.close();
  }

  // =======================================================================
  section('MS-9/10 — loaded session rendering + D4/D6 advisories');
  {
    const B = boot({ squad: SQUAD });
    const { doc, stub } = B;
    await sleep(400);
    const api = B.win.matchRosterApi;
    stub._setLoadSession(SESSION_FULL_XI);
    clickIn(B, doc.getElementById('btnLoadSession'));
    await sleep(500);
    openPanel(B);
    await sleep(50);

    ok('MS-9a: loaded roster entries render (3 rows) with the match-overlay display name',
      doc.querySelectorAll('.matchday-squad-row').length === 3 &&
      /GK Kid \(matchday\)/.test(doc.querySelector('.matchday-squad-row[data-mds-player-id="player_1"] .mds-name').textContent));
    ok('MS-9b: an empty overlay displayName falls back to the global-squad name',
      doc.querySelector('.matchday-squad-row[data-mds-player-id="player_9"] .mds-name').textContent === 'Super Sub');
    ok('MS-9c: the XI editor reflects the loaded 4-4-2 mapping (11 slots, GK=player_1, ST=player_9)',
      doc.querySelectorAll('#matchdaySquadXi select').length === 11 &&
      xiValue(B, 0) === 'player_1' && xiValue(B, 9) === 'player_9');
    ok('MS-9d: counts and hint reflect the loaded state (2 starters, 1 sub, 3 total, 2/11 filled)',
      /Starters <b>2<\/b>/.test(doc.getElementById('matchdaySquadCounts').innerHTML) &&
      /Match squad <b>3<\/b>/.test(doc.getElementById('matchdaySquadCounts').innerHTML) &&
      /4-4-2 · 2\/11 filled/.test(doc.getElementById('matchdaySquadXiHint').textContent));
    ok('MS-9e: slotted players carry the XI badge (GK for player_1)',
      /XI GK/.test(doc.querySelector('.matchday-squad-row[data-mds-player-id="player_1"] .mds-xi-badge').textContent));
    ok('MS-9f: the loaded opponent entry stays out of the our-team panel',
      !/Opp One/.test(doc.getElementById('matchdaySquadModal').textContent) &&
      api.get().opponent.length === 1);
    ok('MS-9g: a view-only open of a loaded session stays CLEAN (no rewrite of roster or XI)',
      api.isSessionDirty() === false);
    ok('MS-9h: the add list shows only squad players not in the match roster (3)',
      doc.querySelectorAll('#matchdaySquadAddList .matchday-add-chip').length === 3);

    setRowField(B, 'player_12', '.mds-shirt', '22');
    await sleep(30);
    ok('MS-10a: duplicate shirt numbers surface an advisory warning (D4 — nothing blocks)',
      /Duplicate shirt numbers: 22/.test(doc.getElementById('matchdaySquadCounts').textContent));
    ok('MS-10b: the duplicate is stored permissively (both entries keep their shirt numbers)',
      api.get().our.filter((p) => p.shirtNumber === 22).length === 2);
    B.dom.window.close();
  }

  // =======================================================================
  section('MS-11 — stale XI mapping: read-safe open, write-materialize');
  {
    const B = boot({ squad: SQUAD });
    const { doc, stub } = B;
    await sleep(400);
    const api = B.win.matchRosterApi;
    stub._setLoadSession(SESSION_STALE_XI);
    clickIn(B, doc.getElementById('btnLoadSession'));
    await sleep(500);
    openPanel(B);
    await sleep(50);

    ok('MS-11a: a stale 2-slot mapping opens as the 11-slot formation skeleton, PRESERVING assignments by position',
      doc.querySelectorAll('#matchdaySquadXi select').length === 11 &&
      xiValue(B, 0) === 'player_1' && xiValue(B, 9) === 'player_9');
    ok('MS-11b: merely OPENING the panel does NOT dirty the session',
      api.isSessionDirty() === false);
    stub._setSaveResult({ canceled: false, filePath: '/tmp/stale.json' });
    clickIn(B, doc.getElementById('btnSaveSession'));
    await sleep(300);
    ok('MS-11c: a view-only open saves the ORIGINAL 2-slot startingXI (no silent rewrite)',
      !!lastSave(stub) && lastSave(stub).matchInfo.startingXI.length === 2);

    setXiSlot(B, 1, 'player_12');
    await sleep(30);
    ok('MS-11d: the first slot write materializes the 11-slot mapping (preserved GK/ST + the new RB) and promotes the newcomer',
      xiValue(B, 0) === 'player_1' && xiValue(B, 9) === 'player_9' && xiValue(B, 1) === 'player_12' &&
      statusOf(B, 'player_12') === 'starter' && api.isSessionDirty() === true);
    stub._setSaveResult({ canceled: false, filePath: '/tmp/mat.json' });
    clickIn(B, doc.getElementById('btnSaveSession'));
    await sleep(300);
    ok('MS-11e: the saved startingXI is the materialized 11-slot mapping with all three assignments',
      (() => {
        const xi = lastSave(stub) && lastSave(stub).matchInfo.startingXI;
        return !!xi && xi.length === 11 && xi[0].playerId === 'player_1' &&
          xi[1].playerId === 'player_12' && xi[9].playerId === 'player_9';
      })());
    B.dom.window.close();
  }

  // =======================================================================
  section('MS-12 — non-roster XI references stay visible + replaceable');
  {
    const B = boot({ squad: SQUAD });
    const { doc } = B;
    await sleep(400);
    const api = B.win.matchRosterApi;
    setFormationViaMatchSetup(B, '4-4-2');
    await sleep(50);
    // Assign a squad-ONLY player (player_20, not in the match roster) to
    // slot 0 through the classic Match-setup XI editor.
    clickIn(B, doc.getElementById('btnMatchSetup'));
    const msel = doc.querySelector('#lineupSlots select[data-slot-index="0"]');
    msel.value = 'player_20';
    msel.dispatchEvent(new B.win.Event('change', { bubbles: true }));
    clickIn(B, doc.getElementById('btnSaveMatchSetup'));
    await sleep(50);
    openPanel(B);
    await sleep(50);

    ok('MS-12a: the squad-only XI reference is preserved visibly (not shown as Empty)',
      xiValue(B, 0) === 'player_20' &&
      /Squad Twenty \(not in this match squad\)/.test(xiSelect(B, 0).textContent));
    addSquadPlayerViaPanel(B, 'player_9');
    await sleep(30);
    setXiSlot(B, 0, 'player_9');
    await sleep(30);
    ok('MS-12b: replacing the non-roster reference via the panel works (slot now the roster player, promoted)',
      xiValue(B, 0) === 'player_9' && statusOf(B, 'player_9') === 'starter');
    B.dom.window.close();
  }

  // =======================================================================
  section('HYGIENE — jsdom errors');
  {
    ok('H1: no jsdom errors during any boot in this suite', jsdomErrors.length === 0,
      jsdomErrors.slice(0, 3).join(' | '));
  }

  const failed = results.filter((r) => !r.pass).length;
  console.log('\nmatchday-squad-ui-check: ' + (results.length - failed) + '/' + results.length + ' checks passed' +
    (failed ? ', FAILED: ' + failed : ''));
  if (failed) process.exit(1);

})().catch((e) => { console.error('HARNESS CRASH:', e); process.exit(1); });
