#!/usr/bin/env node
// PitchLog / MatchTag — matchday regression harness (post F2+F3 fix)
// =====================================================================
// Verification-only harness. It does NOT modify any app source file.
// Originally written for the Phase 3A controlled matchday simulation
// (defects recorded, not fixed); after the F2/F3 integrity fixes it now
// ASSERTS THE FIXED BEHAVIOR as the broad matchday regression suite:
//   F2 fixed: no-video interval events use the match clock for
//       startTime/endTime/matchTime/matchSeconds/officialMinute/second/
//       period (start-anchored), so they carry real times and sort
//       correctly instead of collapsing to time 0.
//   F3 fixed: undo (and per-event delete) of a Goal reverts/corrects the
//       match score, and events logged after a removed goal are shifted
//       onto the corrected trajectory.
// The remaining recorded findings (F1/F5/F6/F7/F8) are LOW-severity and
// deliberately NOT fixed.
//
// BOOT A  squad creation via the real Manage-squad modal (fresh install).
// BOOT B  the matchday: squad loaded at startup (as squad.json would be),
//         Match setup, PRE_MATCH -> 1H -> HT -> 2H -> FT, structured
//         tagging (players/teams/locations/sequences/goals/sub/card/
//         possession interval), Touchline Mode workflow, 100+ rapid
//         events, manual save/load, autosave, beforeunload flush,
//         safe-close, CSV exports, goal-undo behavior (now FIXED).
// BOOT C  recovery from the flushed autosave.
//
// Every event creation is recorded in a ledger driven by an independent
// clock/score model; final payloads are audited field-by-field (Step 11).
//
// Run:  node tests/matchday-sim.js   (from the pitchlog project root)

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
const rendererSrc = fs.readFileSync(path.join(srcDir, 'renderer.js'), 'utf-8');

const results = [];
let SECTION = '(pre)';
function section(name) { SECTION = name; console.log('\n===== ' + name + ' ====='); }
function ok(name, cond, detail) {
  results.push({ section: SECTION, name, pass: !!cond, detail: detail === undefined ? '' : String(detail) });
  if (!cond) console.log('  FAIL: ' + name + (detail === undefined ? '' : '  | ' + detail));
}
const findings = [];
function finding(id, sev, text) { findings.push({ id, sev, text }); console.log('  FINDING ' + id + ' [' + sev + '] ' + text); }

const jsdomErrors = [];

// Deterministic clock: the app's match clock is Date.now()-based.
let fakeNow = Date.now();
function advanceMatchSeconds(s) { fakeNow += s * 1000; }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function clone(x) { return x == null ? x : JSON.parse(JSON.stringify(x)); }

function makeStub(initial) {
  const calls = {
    saveSession: [], autosaveWrite: [], autosaveFlushSync: [], saveSquad: [],
    exportCsv: [], autosaveDelete: 0, closeProceed: 0
  };
  let loadSessionData = null;
  let loadMultipleData = null;
  let closeCallback = null;
  const stub = {
    openVideo: async () => null,
    saveSession: async (d) => { calls.saveSession.push(clone(d)); return { canceled: false, filePath: '/tmp/matchday-session.json' }; },
    exportCsv: async (csv) => { calls.exportCsv.push(String(csv)); return { canceled: false, filePath: '/tmp/matchday-export.csv' }; },
    exportClipPlaylist: async () => ({ canceled: true }),
    loadSession: async () => clone(loadSessionData),
    loadMultipleSessions: async () => clone(loadMultipleData) || [],
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
    _setLoadMultiple: (d) => { loadMultipleData = d; },
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
  win.Date.now = () => fakeNow;
  const RECT = { left: 0, top: 0, right: 700, bottom: 450, width: 700, height: 450, x: 0, y: 0 };
  if (win.SVGElement) win.SVGElement.prototype.getBoundingClientRect = function () { return { ...RECT }; };
  else win.Element.prototype.getBoundingClientRect = function () { return { ...RECT }; };
  const stub = makeStub(initial);
  win.matchtag = stub;
  win.eval(integritySrc);
  win.eval(rendererSrc);
  return { dom, win, doc: win.document, stub };
}

// Independent clock + score model (oracle), mirrors the documented rules.
const ck = { base: 0, running: false, startedAt: null, period: 'PRE_MATCH' };
function ckNow() { return ck.running ? ck.base + (fakeNow - ck.startedAt) / 1000 : ck.base; }
function ckOfficialMinute(s, period) {
  if (!period || period === 'PRE_MATCH') return 0;
  const b = { '1H': 2700, 'HT': 2700, '2H': 5400, 'FT': 5400, 'ET1': 6300, 'ET_HT': 6300, 'ET2': 7200 }[period] || 0;
  if (s > b && (period === '1H' || period === '2H' || period === 'ET1' || period === 'ET2')) return Math.floor(b / 60) + Math.ceil((s - b) / 60);
  return Math.ceil(s / 60);
}

const ledger = [];
let ledgerNextId = 1;
const score = { f: 0, a: 0 };
// Interval start info captured when the sim STARTS a Possession interval
// (mirrors the app's post-F2 start-anchored interval capture).
let intervalStartInfo = null;
function markIntervalStart() { intervalStartInfo = { seconds: ckNow(), period: ck.period }; }
function recEvent(o) {
  o.id = ledgerNextId++;
  o.period = ck.period;
  if (o.isInterval) {
    // F2 model: interval events are anchored to the match-clock START.
    o.matchTime = intervalStartInfo ? intervalStartInfo.seconds : 0;
    o.startPeriod = intervalStartInfo ? intervalStartInfo.period : ck.period;
    o.startTime = o.matchTime;
    o.endTime = ckNow();
    o.matchSeconds = Math.floor(o.matchTime);
    o.officialMinute = ckOfficialMinute(o.matchTime, o.startPeriod);
  } else {
    o.matchTime = ckNow();
    o.matchSeconds = Math.floor(ckNow());
    o.officialMinute = ckOfficialMinute(ckNow(), ck.period);
  }
  o.scoreBefore = { f: score.f, a: score.a };
  if (o.goal) {
    if (o.goal === 'our') score.f++; else score.a++;
    o.scoreAfter = { f: score.f, a: score.a };
  }
  ledger.push(o);
  return o;
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
  function quickBtn(label) {
    return Array.from(B.doc.querySelectorAll('#touchlineQuickTags .touchline-tag-btn')).find((b) => b.textContent.trim() === label);
  }
  function lastRow() { const rows = B.doc.querySelectorAll('#eventList .event-row'); return rows[rows.length - 1]; }
  function rowCount() { return B.doc.querySelectorAll('#eventList .event-row').length; }
  function scoreboard() { return txt('scoreboardDisplay'); }
  function scoreState() { return txt('scoreStateDisplay'); }
  function selectPlayer(pid) { const sel = id('selectedPlayerSelect'); sel.value = pid; change(sel); }
  function selectTeam(team) { click(team === 'our' ? id('btnTeamOur') : id('btnTeamOpponent')); }
  function mStart() { click(id('btnClockStart')); if (ck.period === 'PRE_MATCH') ck.period = '1H'; if (!ck.running) { ck.startedAt = fakeNow; ck.running = true; } }
  function mPause() { click(id('btnClockPause')); if (ck.running) { ck.base = ckNow(); ck.startedAt = null; ck.running = false; } }
  function mEndHalf() { click(id('btnClockEndHalf')); if (ck.running) { ck.base = ckNow(); ck.startedAt = null; ck.running = false; } if (ck.period === '1H') { ck.base = 2700; ck.period = 'HT'; } else if (ck.period === '2H') { ck.base = 5400; ck.period = 'FT'; } }
  function mNextHalf() { click(id('btnClockNextHalf')); if (ck.period === 'HT') { ck.period = '2H'; ck.base = 2700; } ck.startedAt = fakeNow; ck.running = true; }
  function setDetailChip(kind, value) {
    const chip = Array.from(B.doc.querySelectorAll('#detailPanel .chip')).find((c) => c.dataset.kind === kind && (value === undefined || c.dataset.value === value || c.dataset.playerId === value));
    if (!chip) throw new Error('chip not found: ' + kind + ' ' + value);
    click(chip);
  }
  function detailDone() { const b = id('detailPanelDone'); if (b) click(b); }
  function tapDetailPitch(x, y) {
    const svg = B.doc.querySelector('#detailPanel #pitchSvg');
    click(svg, { clientX: Math.round(x * 700), clientY: Math.round(y * 450) });
  }
  // mirror of the app's tap math: clientX->x fraction (rect 700x450, left/top 0)
  function loc(x, y) { return { x: Math.round(x * 700) / 700, y: Math.round(y * 450) / 450 }; }

  // =====================================================================
  section('S0 — BOOT A: squad creation (fresh install, real modal flow)');
  // =====================================================================
  {
    const A = boot({ squad: [], autosave: null });
    B = A; await sleep(250);
    ok('A1 fresh boot: no recovery modal', id('recoveryModal').style.display === 'none');
    ok('A2 fresh boot: PRE_MATCH clock', txt('matchClockDisplay') === '00:00' && txt('matchPeriodDisplay') === 'Pre-match');
    click(id('btnManageSquad'));
    ok('A3 squad modal opens', id('squadModal').style.display === 'flex');
    const NAMES = ['1, Tesfaye Girma', '2, Abebe Kebede', '3, Kebede Wolde', '4, Yohannes Haile', '5, Mengistu Alemu',
      '6, Dawit Bekele', '7, Solomon Tadesse', '8, Fitsum Girma', '9, Getachew Mulu', '10, Birhanu Assefa',
      '11, Tewodros Lemma', '12, Samuel Kassa', '13, Elias Fikru', '14, Nahom Zewde'];
    id('squadBulkInput').value = NAMES.join('\n');
    click(id('btnAddSquadBulk'));
    await sleep(200);
    ok('A4 14 players added to squad list', B.doc.querySelectorAll('#squadList .squad-chip').length === 14);
    const saved = A.stub._calls.saveSquad[0];
    ok('A5 squad persisted (saveSquad called once)', A.stub._calls.saveSquad.length === 1 && saved.length === 14);
    ok('A6 ids generated player_1..player_14', saved[13].id === 'player_14' && saved[0].id === 'player_1');
    const opts = id('selectedPlayerSelect').options.length;
    ok('A7 player dropdown still empty after same-session add (PRE-EXISTING quirk)', opts === 1, 'options=' + opts);
    if (opts === 1) finding('F1', 'LOW', 'Player selector dropdown does not refresh after a same-session squad bulk-add (desktop). Workaround: restart app, load a session, or use the Touchline Mode selector. Pre-existing; previously documented by the prior session.');
    globalThis.__squadA = saved;
    A.dom.window.close();
  }

  // =====================================================================
  section('S1 — BOOT B startup + Match setup');
  // =====================================================================
  {
    B = boot({ squad: globalThis.__squadA, autosave: null });
    await sleep(250);
    ok('B1 squad loaded at startup (14 players in dropdown)', id('selectedPlayerSelect').options.length === 15);
    ok('B2 no autosave -> no recovery modal', id('recoveryModal').style.display === 'none');
    ok('B3 scoreboard 0 — 0 DRAW', scoreboard() === '0 — 0' && scoreState() === 'DRAW');

    click(id('btnMatchSetup'));
    ok('B4 match setup modal opens', id('matchSetupModal').style.display === 'flex');
    id('matchCompetition').value = 'Ethiopian Premier League';
    id('matchDate').value = '2026-05-30';
    id('matchOpponent').value = 'Bahir Dar City';
    id('matchVenue').value = 'Bahir Dar Stadium';
    id('matchHomeAway').value = 'home';
    id('matchFormation').value = '4-3-3'; change(id('matchFormation'));
    const slots = B.doc.querySelectorAll('#lineupSlots .lineup-player-select');
    ok('B5 4-3-3 renders 11 lineup slots', slots.length === 11);
    for (let i = 0; i < 11; i++) { slots[i].value = 'player_' + (i + 1); change(slots[i]); }
    click(id('btnSaveMatchSetup'));
    ok('B6 modal closed after save', id('matchSetupModal').style.display === 'none');
    ok('B7 match summary rendered', /vs Bahir Dar City/.test(txt('matchSummary')) && /4-3-3/.test(txt('matchSummary')), txt('matchSummary'));
  }

  // =====================================================================
  section('S2 — Match clock: PRE_MATCH -> 1H, ticks, authoritative source');
  // =====================================================================
  {
    ok('C1 start enabled, others disabled (PRE_MATCH)', !id('btnClockStart').disabled && id('btnClockPause').disabled && id('btnClockEndHalf').disabled && id('btnClockNextHalf').disabled);
    mStart();
    ok('C2 start -> 1st Half, clock running', txt('matchPeriodDisplay') === '1st Half' && id('btnClockPause').disabled === false && id('btnClockStart').disabled === true);
    ok('C3 display at 00:00 immediately', txt('matchClockDisplay') === '00:00');
    advanceMatchSeconds(600); await sleep(320);
    ok('C4 display advances to 10:00 via 250ms display timer', txt('matchClockDisplay') === '10:00', txt('matchClockDisplay'));

    mPause();
    ok('C5 pause: clock stopped, pause disabled', id('btnClockPause').disabled === true);
    advanceMatchSeconds(500); await sleep(320);
    ok('C6 paused: display frozen at 10:00 despite 500s elapsed', txt('matchClockDisplay') === '10:00', txt('matchClockDisplay'));
    click(id('btnClockStart')); ck.startedAt = fakeNow; ck.running = true;
    advanceMatchSeconds(120); await sleep(320);
    ok('C7 resume: continues from 10:00 to 12:00', txt('matchClockDisplay') === '12:00', txt('matchClockDisplay'));

    // Display timer is NOT the authoritative source: advance 300s without
    // yielding (no display tick can fire), then tag an event.
    advanceMatchSeconds(300);
    const staleDisplay = txt('matchClockDisplay');
    selectTeam('our'); selectPlayer('player_7');
    click(tagBtn('Pass'));
    const ev = recEvent({ label: 'Pass', team: 'our', playerId: 'player_7' });
    ok('C8 event matchTime computed from clock model even while display stale', Math.abs(ev.matchTime - ckNow()) < 0.001, 'matchTime=' + ev.matchTime + ' model=' + ckNow());
    ok('C9 display was stale at creation time (display not authoritative)', staleDisplay === '12:00', staleDisplay);
    await sleep(320);
    ok('C10 display catches up to 17:00', txt('matchClockDisplay') === '17:00', txt('matchClockDisplay'));
    ok('C11 event count 1, undo enabled', rowCount() === 1 && !id('btnUndo').disabled);
    setDetailChip('subtype', 'Progressive');
    setDetailChip('qualifier', 'Successful');
    setDetailChip('qualifier', 'Free');
    tapDetailPitch(0.65, 0.3);
    ev.location = loc(0.65, 0.3); ev.subtype = 'Progressive'; ev.qualifiers = { Outcome: 'Successful', Pressure: 'Free' };
    ok('C12 detail row shows subtype + qualifiers + zone (Middle third · Left channel)', /Progressive/.test(lastRow().textContent) && /Successful/.test(lastRow().textContent) && /Left channel/.test(lastRow().textContent), lastRow().textContent.replace(/\s+/g, ' ').slice(0, 140));
    detailDone();
    ok('C13 detail Done closes panel', id('detailPanel').style.display === 'none');
  }

  // =====================================================================
  section('S3 — 1H structured tagging (goals: 0-0 -> 1-0 -> 1-1 -> 2-1)');
  // =====================================================================
  {
    advanceMatchSeconds(40); selectTeam('our'); selectPlayer('player_9');
    click(tagBtn('Shot'));
    const shot = recEvent({ label: 'Shot', team: 'our', playerId: 'player_9' });
    setDetailChip('subtype', 'On target'); setDetailChip('qualifier', 'Left foot'); tapDetailPitch(0.8, 0.45);
    shot.subtype = 'On target'; shot.qualifiers = { 'Body part': 'Left foot' }; shot.location = loc(0.8, 0.45);
    detailDone();
    ok('G1 shot row: player #9 + On target', /#9 Getachew Mulu/.test(lastRow().textContent) && /On target/.test(lastRow().textContent));

    advanceMatchSeconds(55); selectTeam('opponent'); selectPlayer('');
    click(tagBtn('Foul'));
    const foul = recEvent({ label: 'Foul', team: 'opponent', playerId: null });
    setDetailChip('qualifier', 'Attacking third'); tapDetailPitch(0.15, 0.5);
    foul.qualifiers = { Zone: 'Attacking third' }; foul.location = loc(0.15, 0.5);
    detailDone();
    ok('G2 foul row is opponent-styled (against)', lastRow().className.includes('event-row-against'), lastRow().className);

    // GOALS — exact Step 6 sequence
    advanceMatchSeconds(325); selectTeam('our'); selectPlayer('player_9');
    click(tagBtn('Goal'));
    recEvent({ label: 'Goal', team: 'our', playerId: 'player_9', goal: 'our' });
    ok('S6a our goal -> 1 — 0 WINNING', scoreboard() === '1 — 0' && scoreState() === 'WINNING', scoreboard() + '/' + scoreState());
    advanceMatchSeconds(300); selectTeam('opponent'); selectPlayer('');
    click(tagBtn('Goal'));
    recEvent({ label: 'Goal', team: 'opponent', playerId: null, goal: 'opponent' });
    ok('S6b opponent goal -> 1 — 1 DRAW', scoreboard() === '1 — 1' && scoreState() === 'DRAW', scoreboard() + '/' + scoreState());
    advanceMatchSeconds(300); selectTeam('our'); selectPlayer('player_10');
    click(tagBtn('Goal'));
    recEvent({ label: 'Goal', team: 'our', playerId: 'player_10', goal: 'our' });
    ok('S6c our goal -> 2 — 1 WINNING', scoreboard() === '2 — 1' && scoreState() === 'WINNING', scoreboard() + '/' + scoreState());
    ok('S6d scoreboard matches independent score model', score.f === 2 && score.a === 1);

    // Possession interval WITHOUT video (F2 FIXED: bounds from the match clock)
    advanceMatchSeconds(120);
    click(tagBtn('Possession'));
    markIntervalStart();
    advanceMatchSeconds(45);
    click(tagBtn('Possession'));
    recEvent({ label: 'Possession', team: 'our', playerId: 'player_10', isInterval: true });
    detailDone();
    const firstRow = B.doc.querySelector('#eventList .event-row');
    const possRow = Array.from(B.doc.querySelectorAll('#eventList .event-row')).find((r) => /Possession/.test(r.textContent));
    ok('D1a interval row sorts at its START time, NOT first (F2 fixed)', !/Possession/.test(firstRow.textContent) && /Pass/.test(firstRow.textContent), firstRow.textContent.slice(0, 60));
    ok('D1b interval row shows a real time range (00:36:00 → 00:36:45), not 00:00:00', possRow && /00:36:00/.test(possRow.textContent) && !/00:00:00/.test(possRow.textContent), possRow ? possRow.textContent.slice(0, 40) : 'missing');

    advanceMatchSeconds(90); selectTeam('opponent'); selectPlayer('');
    click(tagBtn('Card'));
    const card = recEvent({ label: 'Card', team: 'opponent', playerId: null });
    setDetailChip('subtype', 'Yellow'); card.subtype = 'Yellow'; detailDone();
    ok('G3 card row shows Yellow', /Yellow/.test(lastRow().textContent));
    advanceMatchSeconds(120); selectTeam('our'); selectPlayer('');
    click(tagBtn('Sub'));
    const sub = recEvent({ label: 'Sub', team: 'our', playerId: null });
    click(Array.from(B.doc.querySelectorAll('#detailPanel .chip[data-kind="playerOff"]')).find((c) => c.dataset.playerId === 'player_6'));
    click(Array.from(B.doc.querySelectorAll('#detailPanel .chip[data-kind="playerOn"]')).find((c) => c.dataset.playerId === 'player_12'));
    sub.playerOffId = 'player_6'; sub.playerOnId = 'player_12';
    detailDone();
    ok('G4 sub row shows #6 Dawit Bekele -> #12 Samuel Kassa', /#6 Dawit Bekele → #12 Samuel Kassa/.test(lastRow().textContent), lastRow().textContent.replace(/\s+/g, ' ').slice(0, 110));
    advanceMatchSeconds(30);
    click(tagBtn('Corner'));
    recEvent({ label: 'Corner', team: 'our', playerId: null });
    detailDone();

    click(id('btnStartSequence'));
    ok('G5 sequence display SEQ-001', txt('activeSequenceDisplay') === 'SEQ-001');
    advanceMatchSeconds(45); selectPlayer('player_8');
    click(tagBtn('Pass'));
    recEvent({ label: 'Pass', team: 'our', playerId: 'player_8', seq: 'SEQ-001' });
    detailDone();
    advanceMatchSeconds(40); selectPlayer('player_9');
    click(tagBtn('Shot'));
    const shot2 = recEvent({ label: 'Shot', team: 'our', playerId: 'player_9', seq: 'SEQ-001' });
    setDetailChip('subtype', 'Off target'); shot2.subtype = 'Off target'; detailDone();
    click(id('btnEndSequence'));
    ok('G6 sequence ended (display cleared, End disabled)', txt('activeSequenceDisplay') === '' && id('btnEndSequence').disabled);

    advanceMatchSeconds(190); selectTeam('opponent'); selectPlayer('');
    click(tagBtn('Foul'));
    recEvent({ label: 'Foul', team: 'opponent', playerId: null });
    detailDone();
    await sleep(320);
    ok('C14 1H stoppage display 45+20', txt('matchClockDisplay') === '45+20', txt('matchClockDisplay'));
    ok('C15 officialMinute 46 at 45+20 (model)', ckOfficialMinute(2720, '1H') === 46);
  }

  // =====================================================================
  section('S4 — Half transitions: HT -> 2H -> FT');
  // =====================================================================
  {
    mEndHalf();
    ok('H1 End Half -> Half-time, clock stopped at 45:00', txt('matchPeriodDisplay') === 'Half-time' && txt('matchClockDisplay') === '45:00');
    ok('H2 Next Half enabled, labelled Start 2nd Half', !id('btnClockNextHalf').disabled && id('btnClockNextHalf').textContent === 'Start 2nd Half');
    advanceMatchSeconds(600); await sleep(320);
    ok('H3 HT clock frozen (45:00)', txt('matchClockDisplay') === '45:00', txt('matchClockDisplay'));
    mNextHalf();
    ok('H4 2nd Half starts at 45:00, running', txt('matchPeriodDisplay') === '2nd Half' && txt('matchClockDisplay') === '45:00' && !id('btnClockPause').disabled);
    advanceMatchSeconds(25); await sleep(320);
    ok('H5 2H time continues 45:25', txt('matchClockDisplay') === '45:25', txt('matchClockDisplay'));
    advanceMatchSeconds(375); selectTeam('our'); selectPlayer('player_12');
    click(tagBtn('Pass'));
    recEvent({ label: 'Pass', team: 'our', playerId: 'player_12' });
    detailDone();
    advanceMatchSeconds(375); selectTeam('our'); selectPlayer('player_5');
    click(tagBtn('Foul'));
    const f3 = recEvent({ label: 'Foul', team: 'our', playerId: 'player_5' });
    tapDetailPitch(0.22, 0.72); f3.location = loc(0.22, 0.72); detailDone();
    advanceMatchSeconds(200); selectTeam('opponent'); selectPlayer('');
    click(tagBtn('Shot'));
    recEvent({ label: 'Shot', team: 'opponent', playerId: null });
    detailDone();
    await sleep(320);
    ok('H6 2H display 61:15 after structured 2H events', txt('matchClockDisplay') === '61:15', txt('matchClockDisplay'));
  }

  // =====================================================================
  section('S5 — Touchline Mode workflow');
  // =====================================================================
  {
    click(id('btnTouchlineToggle'));
    ok('T1 touchline overlay opens', id('touchlineOverlay').style.display === 'flex' && id('btnTouchlineToggle').textContent === 'Desktop Mode');
    ok('T2 scoreboard mirrors 2 — 1 WINNING', txt('touchlineScore') === '2 — 1' && txt('touchlineScoreState') === 'WINNING', txt('touchlineScore') + '/' + txt('touchlineScoreState'));
    ok('T3 clock + period mirror 61:15 / 2nd Half', txt('touchlineClock') === '61:15' && txt('touchlinePeriod') === '2nd Half', txt('touchlineClock') + '/' + txt('touchlinePeriod'));
    ok('T4 team selector mirrors current selection (opponent active, matching desktop)', id('tlBtnTeamOpp').className.includes('active') && !id('tlBtnTeamOur').className.includes('active') && id('btnTeamOpponent').className.includes('active'));
    ok('T5 15 quick tag buttons rendered', B.doc.querySelectorAll('#touchlineQuickTags .touchline-tag-btn').length === 15);
    ok('T6 pitch readout + sequence controls present', id('touchlinePitchReadout') && id('tlBtnStartSeq') && id('tlBtnEndSeq') && id('tlBtnUndo'));
    ok('T7 save indicator shows static SAVED (deferred defect 8: decorative)', txt('touchlineSaveStatus') === '✓ SAVED');
    finding('F5', 'LOW', 'Touchline save-status indicator is decorative: renderTouchlineSaveStatus() is never invoked anywhere (grep: 1 occurrence = its definition). Always shows "✓ SAVED" regardless of actual autosave state. This is the previously deferred LOW defect #8, correctly untouched by the integrity fixes.');

    click(id('tlBtnTeamOur'));
    const tlSel = id('tlPlayerSelect');
    tlSel.value = 'player_3'; change(tlSel);
    click(id('tlBtnStartSeq'));
    ok('T8 touchline sequence starts (SEQ-002)', txt('tlActiveSeq') === 'SEQ-002');
    advanceMatchSeconds(10);
    click(quickBtn('Press'));
    recEvent({ label: 'Press', team: 'our', playerId: 'player_3', seq: 'SEQ-002' });
    advanceMatchSeconds(10);
    click(quickBtn('Recovery'));
    const rec1 = recEvent({ label: 'Recovery', team: 'our', playerId: 'player_3', seq: 'SEQ-002' });
    click(id('touchlinePitchSvg'), { clientX: 140, clientY: 270 });
    rec1.location = { x: 0.2, y: 0.6 };
    ok('T9 pitch tap sets location + readout zone (Defensive third · Central channel)', /Defensive third/.test(txt('touchlinePitchReadout')) && /Central channel/.test(txt('touchlinePitchReadout')), txt('touchlinePitchReadout'));
    advanceMatchSeconds(10);
    click(quickBtn('Interception'));
    recEvent({ label: 'Interception', team: 'our', playerId: 'player_3', seq: 'SEQ-002' });
    const countBeforeUndo = rowCount();
    click(id('tlBtnUndo')); click(id('tlBtnUndo')); // second is a no-op (design)
    ok('T10 undo removes exactly ONE event; consecutive 2nd undo is a no-op', rowCount() === countBeforeUndo - 1, countBeforeUndo + ' -> ' + rowCount());
    const undone = ledger.pop();
    finding('F8', 'LOW', 'Undo is single-shot: undoLastTag() clears lastLoggedEventId, so consecutive undo clicks without intermediate tagging are no-ops. Removing several events requires the per-event delete button in the event list. Design observation, not corruption.');
    click(id('tlBtnEndSeq'));
    ok('T11 sequence ends (display cleared)', txt('tlActiveSeq') === '');
    const recent = B.doc.querySelectorAll('#touchlineRecentEvents .touchline-recent-item');
    ok('T12 recent events list shows entries (latest first)', recent.length >= 2 && /Recovery/.test(recent[0].textContent), recent[0] ? recent[0].textContent.replace(/\s+/g, ' ') : 'none');
    ok('T13 undo disabled state synced in touchline', id('tlBtnUndo').disabled === id('btnUndo').disabled && id('tlBtnUndo').disabled === true);
    click(id('tlBtnPause'));
    ck.base = ckNow(); ck.startedAt = null; ck.running = false;
    ok('T14 touchline pause works (clock stops)', id('btnClockPause').disabled === true);
    click(id('tlBtnStart'));
    ck.startedAt = fakeNow; ck.running = true;
    ok('T15 touchline resume works', id('btnClockPause').disabled === false);
    // observation: detail panel (subtypes/qualifiers) opens BEHIND the overlay
    advanceMatchSeconds(10);
    click(quickBtn('Shot'));
    recEvent({ label: 'Shot', team: 'our', playerId: 'player_3' });
    ok('T16 observation: detail panel opens behind the full-screen touchline overlay', id('detailPanel').style.display === 'block' && id('touchlineOverlay').style.display === 'flex');
    finding('F6', 'LOW', 'Touchline workflow: subtype/qualifier editing requires exiting Touchline Mode — the detail panel opens behind the full-screen overlay. Quick tags themselves are flat (1 click each), which is fine for touchline use.');
    click(id('btnExitTouchline'));
    ok('T17 exit touchline restores desktop', id('touchlineOverlay').style.display === 'none' && id('btnTouchlineToggle').textContent === 'Touchline Mode');
  }

  // =====================================================================
  section('S6 — RAPID TAGGING: 100+ events stress test');
  // =====================================================================
  {
    click(id('btnTouchlineToggle'));
    const TL_LABELS = ['Shot', 'Card', 'Sub', 'Press', 'Press Win', 'Turnover', 'Recovery', 'Interception', 'Duel', 'Positive Transition', 'Negative Transition'];
    const GOAL_AT = new Set([20, 45, 70]);
    const GOAL_TEAM = { 20: 'our', 45: 'opponent', 70: 'our' };
    const durations = [];
    let seqCounter = 2;
    let lastPlayer = 'player_3';
    const t0 = Date.now();
    for (let i = 0; i < 82; i++) {
      advanceMatchSeconds(4 + (i % 6));
      if (i % 3 === 0) { const s = id('tlPlayerSelect'); s.value = 'player_' + (1 + (i % 14)); change(s); lastPlayer = s.value; }
      if (i % 20 === 19) { seqCounter++; click(id('tlBtnStartSeq')); }
      if (i % 20 === 8 && i > 20) { click(id('tlBtnEndSeq')); }
      const seqActive = (i % 20 === 19) || (i % 20 <= 7 && i >= 20);
      const seqId = seqActive ? 'SEQ-' + String(seqCounter).padStart(3, '0') : null;
      if (GOAL_AT.has(i)) {
        click(GOAL_TEAM[i] === 'our' ? id('tlBtnTeamOur') : id('tlBtnTeamOpp'));
        click(quickBtn('Goal'));
        recEvent({ label: 'Goal', team: GOAL_TEAM[i], playerId: lastPlayer, seq: seqId, goal: GOAL_TEAM[i] });
        continue;
      }
      const team = (i % 10 < 5) ? 'our' : 'opponent';
      click(team === 'our' ? id('tlBtnTeamOur') : id('tlBtnTeamOpp'));
      const label = TL_LABELS[i % TL_LABELS.length];
      const evt0 = performance.now();
      click(quickBtn(label));
      durations.push(performance.now() - evt0);
      const e = recEvent({ label: label, team: team, playerId: lastPlayer, seq: seqId });
      if (i % 7 === 3) {
        const cx = 100 + (i * 13) % 500, cy = 50 + (i * 29) % 350;
        click(id('touchlinePitchSvg'), { clientX: cx, clientY: cy });
        e.location = { x: cx / 700, y: cy / 450 };
      }
    }
    const beforeUndo = rowCount();
    click(id('tlBtnUndo'));
    ok('R1 undo removes exactly one event (single-shot by design)', rowCount() === beforeUndo - 1);
    ledger.pop();
    if (!id('tlBtnEndSeq').disabled) click(id('tlBtnEndSeq'));
    const rapidWallMs = Date.now() - t0;

    click(id('btnExitTouchline'));
    const DESK = ['Pass', 'Shot', 'Foul', 'Card', 'Corner', 'Sub', 'Press', 'Turnover', 'Recovery', 'Interception', 'Duel', 'Positive Transition', 'Negative Transition'];
    for (let i = 0; i < 30; i++) {
      advanceMatchSeconds(4 + (i % 5));
      if (i === 5 || i === 15 || i === 24) {
        selectPlayer(''); selectTeam('our');
        click(tagBtn('Possession'));
        markIntervalStart();
        advanceMatchSeconds(30 + i);
        click(tagBtn('Possession'));
        recEvent({ label: 'Possession', team: 'our', playerId: null, isInterval: true });
        detailDone();
        continue;
      }
      const isGoal = (i === 10 || i === 25);
      const label = isGoal ? 'Goal' : DESK[i % DESK.length];
      const team = i % 2 ? 'opponent' : 'our';
      selectTeam(team);
      const pid = (team === 'opponent' || i % 3 === 0) ? '' : 'player_' + (1 + (i % 14));
      selectPlayer(pid);
      const evt0 = performance.now();
      click(tagBtn(label));
      durations.push(performance.now() - evt0);
      const e = recEvent({ label: label, team: team, playerId: pid || null, goal: isGoal ? team : undefined });
      if (label === 'Card') { setDetailChip('subtype', i % 4 ? 'Yellow' : 'Red'); e.subtype = i % 4 ? 'Yellow' : 'Red'; }
      if (label === 'Sub' && i === 18) {
        click(Array.from(B.doc.querySelectorAll('#detailPanel .chip[data-kind="playerOff"]')).find((c) => c.dataset.playerId === 'player_4'));
        click(Array.from(B.doc.querySelectorAll('#detailPanel .chip[data-kind="playerOn"]')).find((c) => c.dataset.playerId === 'player_13'));
        e.playerOffId = 'player_4'; e.playerOnId = 'player_13';
      }
      if (i % 4 === 1) { const x = (i * 17 % 100) / 100, y = (i * 31 % 100) / 100; tapDetailPitch(x, y); e.location = loc(x, y); }
      detailDone();
    }
    advanceMatchSeconds(6);
    selectTeam('our'); selectPlayer('');
    B.win.document.body.dispatchEvent(new B.win.KeyboardEvent('keydown', { key: '6', code: 'Digit6', bubbles: true }));
    recEvent({ label: 'Corner', team: 'our', playerId: null });

    const totalCreated = 82 + 30 + 1;
    ok('R2 rapid phase created ' + totalCreated + ' events (>=100 required)', totalCreated >= 100);
    ok('R3 event count matches ledger (nothing dropped)', rowCount() === ledger.length, 'rows=' + rowCount() + ' ledger=' + ledger.length);
    ok('R4 score after rapid goals = 5 — 3', scoreboard() === '5 — 3', scoreboard());
    ok('R5 event count badge matches', parseInt(txt('eventCount'), 10) === ledger.length, txt('eventCount'));
    durations.sort((a, b) => a - b);
    const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
    const p95 = durations[Math.floor(durations.length * 0.95)];
    const maxd = durations[durations.length - 1];
    ok('R6 dispatch latency avg ' + avg.toFixed(1) + 'ms / p95 ' + p95.toFixed(1) + 'ms / max ' + maxd.toFixed(1) + 'ms (jsdom logic+DOM, no real rendering)', avg < 250 && maxd < 1500, 'avg=' + avg.toFixed(1) + ' p95=' + p95.toFixed(1) + ' max=' + maxd.toFixed(1));
    ok('R7 rapid-A wall time ' + (rapidWallMs / 1000).toFixed(1) + 's for 82 touchline events', rapidWallMs < 120000);
    console.log('  perf: rapid wall=' + (rapidWallMs / 1000).toFixed(1) + 's; dispatch avg=' + avg.toFixed(1) + 'ms p95=' + p95.toFixed(1) + 'ms max=' + maxd.toFixed(1) + 'ms over ' + durations.length + ' clicks');
  }

  advanceMatchSeconds(800);
  mEndHalf();
  ok('H7 End Half (2H) -> Full-time 90:00', txt('matchPeriodDisplay') === 'Full-time' && txt('matchClockDisplay') === '90:00', txt('matchClockDisplay'));
  ok('H8 FT: start disabled, next half offers Extra Time', id('btnClockStart').disabled && id('btnClockNextHalf').textContent === 'Start Extra Time');

  // =====================================================================
  section('S7 — Manual save + manual load');
  // =====================================================================
  {
    const nLedger = ledger.length;
    ok('V1 dirty indicator shows Unsaved before save', /Unsaved/.test(txt('dirtyIndicator')), txt('dirtyIndicator'));
    click(id('btnSaveSession'));
    await sleep(150);
    const P1 = B.stub._calls.saveSession[0];
    ok('V2 manual save payload: ' + nLedger + ' events', P1 && P1.events.length === nLedger, P1 ? P1.events.length : 'none');
    ok('V3 payload matchClock (score 5-3, FT, base 5400)', P1.matchClock.scoreFor === 5 && P1.matchClock.scoreAgainst === 3 && P1.matchClock.period === 'FT' && P1.matchClock.clockBaseSeconds === 5400);
    ok('V4 payload matchInfo (opponent, formation, XI)', P1.matchInfo.opponent === 'Bahir Dar City' && P1.matchInfo.formation === '4-3-3' && P1.matchInfo.startingXI.length === 11);
    ok('V5 payload squad (14, id-referenced)', P1.squad.length === 14 && P1.squad[9].id === 'player_10');
    ok('V6 payload tags (incl. touchline-created)', P1.tags.length > 8);
    ok('V7 after save: indicator Saved + autosave cleared', /Saved/.test(txt('dirtyIndicator')) && B.stub._calls.autosaveDelete >= 1);
    globalThis.__P1 = P1;

    B.stub._setLoadSession(Object.assign(clone(P1), { __schemaVersion: 3, __videoExists: false }));
    click(id('btnLoadSession'));
    await sleep(250);
    ok('V8 load restores events', rowCount() === nLedger && parseInt(txt('eventCount'), 10) === nLedger, rowCount() + ' vs ' + nLedger);
    ok('V9 load restores scoreboard 5 — 3 / Full-time / 90:00', scoreboard() === '5 — 3' && txt('matchPeriodDisplay') === 'Full-time' && txt('matchClockDisplay') === '90:00');
    ok('V10 load leaves clock STOPPED (safe)', id('btnClockPause').disabled === true);
    const prevMax = P1.events.reduce((m, e) => Math.max(m, e.id), 0);
    advanceMatchSeconds(1);
    selectTeam('our'); selectPlayer('player_2');
    click(tagBtn('Pass'));
    const cont = recEvent({ label: 'Pass', team: 'our', playerId: 'player_2' });
    detailDone();
    ok('V11 new event after load continues id sequence (max ' + prevMax + ' -> ' + cont.id + ')', cont.id === prevMax + 1);
  }

  // =====================================================================
  section('S8 — Autosave (debounced), beforeunload flush, safe-close');
  // =====================================================================
  {
    await sleep(1900);
    const P2 = B.stub._calls.autosaveWrite[B.stub._calls.autosaveWrite.length - 1];
    ok('A1 debounced autosave fired and captured state', P2 && P2.events.length === ledger.length, P2 ? P2.events.length : 'none');
    ok('A2 autosave payload matches events + score', P2 && P2.events.length === ledger.length && P2.matchClock.scoreFor === 5);

    advanceMatchSeconds(1);
    click(tagBtn('Foul'));
    recEvent({ label: 'Foul', team: 'our', playerId: 'player_2' }); detailDone(); // selection persists from V11
    advanceMatchSeconds(1);
    click(tagBtn('Corner'));
    recEvent({ label: 'Corner', team: 'our', playerId: 'player_2' }); detailDone();
    B.win.dispatchEvent(new B.win.Event('beforeunload', { cancelable: true }));
    const P3 = B.stub._calls.autosaveFlushSync[B.stub._calls.autosaveFlushSync.length - 1];
    ok('A3 beforeunload flush captured the latest state synchronously', P3 && P3.events.length === ledger.length, P3 ? P3.events.length : 'none');
    ok('A4 flush payload includes the last event just tagged', P3 && P3.events[P3.events.length - 1].label === 'Corner');
    globalThis.__P3 = P3;

    const closeCb = B.stub._getCloseCallback();
    ok('A5 close:requested handler registered', typeof closeCb === 'function');
    closeCb();
    ok('A6 dirty close shows unsaved-changes modal', id('unsavedConfirmModal').style.display === 'flex');
    click(id('btnUnsavedCancel'));
    ok('A7 Cancel keeps window open (no closeProceed)', B.stub._calls.closeProceed === 0 && id('unsavedConfirmModal').style.display === 'none');
    closeCb();
    click(id('btnUnsavedSave'));
    await sleep(150);
    ok('A8 Save path: session saved then close proceeds', B.stub._calls.closeProceed === 1 && B.stub._calls.saveSession.length >= 2);
  }

  // =====================================================================
  section('S9 — CSV exports: standard, full analysis (Shift+Click), season');
  // =====================================================================
  {
    const exportCalls = B.stub._calls.exportCsv;
    const before = exportCalls.length;
    click(id('btnExportCsv'));
    await sleep(150);
    ok('E1 normal click: exactly ONE export call', exportCalls.length === before + 1, 'calls=' + (exportCalls.length - before));
    const stdCsv = exportCalls[exportCalls.length - 1];
    const before2 = exportCalls.length;
    click(id('btnExportCsv'), { shiftKey: true });
    await sleep(150);
    ok('E2 Shift+Click: exactly ONE export call (no double-fire)', exportCalls.length === before2 + 1, 'calls=' + (exportCalls.length - before2));
    const fullCsv = exportCalls[exportCalls.length - 1];
    globalThis.__csvStd = stdCsv; globalThis.__csvFull = fullCsv;

    B.stub._setLoadMultiple([
      Object.assign(clone(globalThis.__P1), { sourceFile: '/tmp/match-a.json' }),
      Object.assign(clone(globalThis.__P3), { sourceFile: '/tmp/match-b.json' })
    ]);
    click(id('btnSeasonView'));
    click(id('btnAddSeasonMatches'));
    await sleep(200);
    const matchRows = B.doc.querySelectorAll('#seasonMatchList .season-match-row');
    ok('E3 season view loads 2 matches (dedup by file)', matchRows.length === 2, 'rows=' + matchRows.length);
    const before3 = exportCalls.length;
    click(id('btnExportSeasonCsv'));
    await sleep(150);
    ok('E4 season CSV: one export call', exportCalls.length === before3 + 1);
    globalThis.__csvSeason = exportCalls[exportCalls.length - 1];
    click(id('btnCloseSeasonModal'));
  }

  // =====================================================================
  section('S10 — Goal-undo behavior (F3 FIXED: score reverts)');
  // =====================================================================
  {
    advanceMatchSeconds(1);
    selectTeam('our');
    click(tagBtn('Goal'));
    recEvent({ label: 'Goal', team: 'our', playerId: null, goal: 'our' });
    ok('U1 goal logged -> 6 — 3', scoreboard() === '6 — 3', scoreboard());
    click(id('btnUndo'));
    ledger.pop(); score.f--; // event removed AND oracle score reverted (app now reverts too)
    ok('U2 undo removes the goal event', rowCount() === ledger.length);
    ok('U3 undo REVERTS the scoreboard to 5 — 3 (F3 fixed)', scoreboard() === '5 — 3', scoreboard());
    ok('U3b score state back to WINNING', scoreState() === 'WINNING', scoreState());
    click(id('btnSaveSession'));
    await sleep(150);
    globalThis.__P4 = B.stub._calls.saveSession[B.stub._calls.saveSession.length - 1];
    const goalCount = globalThis.__P4.events.filter((e) => e.label === 'Goal').length;
    const ourGoals = globalThis.__P4.events.filter((e) => e.label === 'Goal' && e.team === 'our').length;
    const oppGoals = goalCount - ourGoals;
    ok('U4 saved payload CONSISTENT: matchClock 5-3 and ' + goalCount + ' goal events imply 5-3 (F3 fixed)',
      globalThis.__P4.matchClock.scoreFor === 5 && globalThis.__P4.matchClock.scoreAgainst === 3 && ourGoals === 5 && oppGoals === 3,
      'matchClock=' + globalThis.__P4.matchClock.scoreFor + '-' + globalThis.__P4.matchClock.scoreAgainst + ' goals=' + ourGoals + '+' + oppGoals);
  }

  // =====================================================================
  section('S11 — BOOT C: recovery from the flushed autosave');
  // =====================================================================
  {
    const C = boot({ squad: globalThis.__squadA, autosave: Object.assign(clone(globalThis.__P3), { __schemaVersion: 3, __savedAt: new Date().toISOString(), __videoExists: false }) });
    B = C; await sleep(300);
    ok('RC1 recovery modal appears on startup', id('recoveryModal').style.display === 'flex');
    const details = id('recoveryDetails').textContent;
    ok('RC2 modal shows event count', details.includes(String(globalThis.__P3.events.length)), details.replace(/\s+/g, ' ').slice(0, 160));
    click(id('btnRecoverAutosave'));
    await sleep(250);
    ok('RC3 recovery closes modal', id('recoveryModal').style.display === 'none');
    ok('RC4 events restored', parseInt(txt('eventCount'), 10) === globalThis.__P3.events.length, txt('eventCount'));
    ok('RC5 score + clock restored (5 — 3, Full-time, 90:00, stopped)', scoreboard() === '5 — 3' && txt('matchPeriodDisplay') === 'Full-time' && id('btnClockPause').disabled === true);
    ok('RC6 squad NOT replaced (14 local players in dropdown)', id('selectedPlayerSelect').options.length === 15);
    ok('RC7 match info restored (summary shows opponent)', /Bahir Dar City/.test(txt('matchSummary')), txt('matchSummary'));
    const prevMax = globalThis.__P3.events.reduce((m, e) => Math.max(m, e.id), 0);
    ledgerNextId = prevMax + 1; // app recomputes nextEventId from the recovered events
    advanceMatchSeconds(1);
    selectTeam('our'); selectPlayer('player_11');
    click(tagBtn('Pass'));
    const rc = recEvent({ label: 'Pass', team: 'our', playerId: 'player_11' });
    detailDone();
    ok('RC8 new event after recovery continues id sequence (' + prevMax + ' -> ' + rc.id + ')', rc.id === prevMax + 1);
    ok('RC9 session marked Unsaved after recovery', /Unsaved/.test(txt('dirtyIndicator')));
    C.dom.window.close();
  }

  // =====================================================================
  section('S12 — Data integrity audit of resulting session data (Step 11)');
  // =====================================================================
  {
    const P3 = globalThis.__P3;
    const evs = P3.events;
    const squadIds = new Set(globalThis.__P1.squad.map((p) => String(p.id)));
    const ids = evs.map((e) => e.id);
    const maxId = Math.max.apply(null, ids);
    const L = ledger.filter((l) => l.id <= maxId);
    ok('D-ID1 event ids unique', new Set(ids).size === ids.length);
    ok('D-ID2 ledger ids == payload ids (nothing missing/extra)', JSON.stringify(ids.slice().sort((a, b) => a - b)) === JSON.stringify(L.map((l) => l.id).sort((a, b) => a - b)), ids.length + ' vs ' + L.length);
    ok('D-T1 all times finite and >= 0', evs.every((e) => Number.isFinite(e.time) && e.time >= 0 && Number.isFinite(e.matchTime)));
    ok('D-T2 time === matchTime on every event', evs.every((e) => e.time === e.matchTime));
    const mism = evs.filter((e) => e.matchSeconds !== Math.floor(e.matchTime));
    ok('D-T3 matchSeconds === floor(matchTime) on EVERY event incl. intervals (F2 fixed)', mism.length === 0, 'mismatches=' + mism.length);
    ok('D-T4 period values all valid', evs.every((e) => ['PRE_MATCH', '1H', 'HT', '2H', 'FT', 'ET1', 'ET_HT', 'ET2'].includes(e.period)));
    ok('D-T5 videoTime null on every event (no video loaded)', evs.every((e) => e.videoTime === null));
    const perLedgerDetails = [];
    const perLedger = evs.every((e) => {
      const l = L.find((x) => x.id === e.id);
      if (!l) { perLedgerDetails.push('id ' + e.id + ': no ledger entry'); return false; }
      const bad = [];
      if (e.label !== l.label) bad.push('label ' + e.label + '!=' + l.label);
      if (e.team !== l.team) bad.push('team ' + e.team + '!=' + l.team);
      if ((e.playerId || null) !== (l.playerId || null)) bad.push('playerId ' + e.playerId + '!=' + l.playerId);
      if (e.isInterval === true) {
        // F2-fixed interval audit: start-anchored bounds + match-time fields.
        if (e.period !== l.startPeriod) bad.push('period ' + e.period + '!=' + l.startPeriod);
        if (Math.abs(e.time - l.startTime) > 0.001) bad.push('time ' + e.time + '!=' + l.startTime);
        if (Math.abs(e.matchTime - l.matchTime) > 0.001) bad.push('matchTime ' + e.matchTime + '!=' + l.matchTime);
        if (Math.abs(e.startTime - l.startTime) > 0.001) bad.push('startTime ' + e.startTime + '!=' + l.startTime);
        if (Math.abs(e.endTime - l.endTime) > 0.001) bad.push('endTime ' + e.endTime + '!=' + l.endTime);
        if (e.matchSeconds !== l.matchSeconds) bad.push('matchSeconds ' + e.matchSeconds + '!=' + l.matchSeconds);
        if (e.officialMinute !== l.officialMinute) bad.push('officialMinute ' + e.officialMinute + '!=' + l.officialMinute);
        if (e.second !== l.matchSeconds % 60) bad.push('second ' + e.second + '!=' + (l.matchSeconds % 60));
        if ((e.sequenceId || null) !== (l.seq || null)) bad.push('seq ' + e.sequenceId + '!=' + l.seq);
        if (e.scoreForBefore !== l.scoreBefore.f || e.scoreAgainstBefore !== l.scoreBefore.a) bad.push('scoreBefore ' + e.scoreForBefore + '-' + e.scoreAgainstBefore + '!=' + l.scoreBefore.f + '-' + l.scoreBefore.a);
        if (JSON.stringify(e.location || null) !== JSON.stringify(l.location || null)) bad.push('location ' + JSON.stringify(e.location) + '!=' + JSON.stringify(l.location));
      } else {
        if (e.period !== l.period) bad.push('period ' + e.period + '!=' + l.period);
        if (Math.abs(e.matchTime - l.matchTime) > 0.001) bad.push('matchTime ' + e.matchTime + '!=' + l.matchTime);
        if (e.matchSeconds !== l.matchSeconds) bad.push('matchSeconds ' + e.matchSeconds + '!=' + l.matchSeconds);
        if (e.officialMinute !== l.officialMinute) bad.push('officialMinute ' + e.officialMinute + '!=' + l.officialMinute);
        if ((e.sequenceId || null) !== (l.seq || null)) bad.push('seq ' + e.sequenceId + '!=' + l.seq);
        if (e.scoreForBefore !== l.scoreBefore.f || e.scoreAgainstBefore !== l.scoreBefore.a) bad.push('scoreBefore ' + e.scoreForBefore + '-' + e.scoreAgainstBefore + '!=' + l.scoreBefore.f + '-' + l.scoreBefore.a);
        if (JSON.stringify(e.location || null) !== JSON.stringify(l.location || null)) bad.push('location ' + JSON.stringify(e.location) + '!=' + JSON.stringify(l.location));
      }
      if (bad.length) perLedgerDetails.push('id ' + e.id + ' (' + e.label + '): ' + bad.join('; '));
      return bad.length === 0;
    });
    if (perLedgerDetails.length) console.log('  D-T6 mismatches:\n    ' + perLedgerDetails.slice(0, 6).join('\n    '));
    ok('D-T6 every event matches the independent ledger (label/team/player/period/matchTime/matchSeconds/officialMinute/seq/scoreBefore/location)', perLedger);
    ok('D-O1 events sorted by time ascending', evs.every((e, i, a) => i === 0 || a[i - 1].time <= e.time));
    const nonInterval = evs.filter((e) => !e.isInterval);
    ok('D-O2 non-interval events: id order == time order (creation order preserved)', nonInterval.every((e, i, a) => i === 0 || (a[i - 1].time < e.time) || (a[i - 1].time === e.time && a[i - 1].id < e.id)));
    const intervalEvs = evs.filter((e) => e.isInterval);
    ok('D-O3 all 4 intervals carry REAL match times (start-anchored, F2 fixed)', intervalEvs.length === 4 && intervalEvs.every((e) => e.time > 0 && e.startTime === e.time && e.endTime > e.startTime && e.matchSeconds === Math.floor(e.startTime) && e.officialMinute === ckOfficialMinute(e.startTime, e.period)), intervalEvs.map((e) => e.time).join(','));
    ok('D-P1 every player ref resolves to squad (or null)', evs.every((e) => [e.playerId, e.playerOffId, e.playerOnId].every((r) => r == null || squadIds.has(r))));
    ok('D-P2 player refs are IDs (strings), never objects', evs.every((e) => [e.playerId, e.playerOffId, e.playerOnId].every((r) => r == null || typeof r === 'string')));
    ok('D-M1 team values valid', evs.every((e) => e.team === 'our' || e.team === 'opponent' || e.team === null));
    ok('D-M2 side consistent with team', evs.every((e) => (e.team === 'our' ? e.side === 'for' : e.team === 'opponent' ? e.side === 'against' : true)));
    ok('D-L1 locations within 0-1', evs.every((e) => !e.location || (e.location.x >= 0 && e.location.x <= 1 && e.location.y >= 0 && e.location.y <= 1)));
    ok('D-S1 sequence ids valid format or null', evs.every((e) => e.sequenceId === null || /^SEQ-\d{3}$/.test(e.sequenceId)));
    const seqs = Array.from(new Set(evs.map((e) => e.sequenceId).filter(Boolean)));
    ok('D-S2 sequence numbering monotonic across session', seqs.every((s, i) => i === 0 || parseInt(s.slice(4), 10) > parseInt(seqs[i - 1].slice(4), 10)), seqs.join(','));
    const goalsInOrder = evs.filter((e) => e.label === 'Goal').slice().sort((a, b) => a.time - b.time);
    let sf = 0, sa = 0, chainOk = true;
    goalsInOrder.forEach((g) => {
      if (g.scoreForBefore !== sf || g.scoreAgainstBefore !== sa) chainOk = false;
      if (g.team === 'our') { if (g.scoreForAfter !== sf + 1 || g.scoreAgainstAfter !== sa) chainOk = false; sf = g.scoreForAfter; }
      else { if (g.scoreAgainstAfter !== sa + 1 || g.scoreForAfter !== sf) chainOk = false; sa = g.scoreAgainstAfter; }
    });
    ok('D-C1 goal score transitions form a consistent chain', chainOk);
    ok('D-C2 final score from goal chain = 5-3 = matchClock score', sf === 5 && sa === 3 && P3.matchClock.scoreFor === 5 && P3.matchClock.scoreAgainst === 3);
    ok('D-C3 scoreAfter present ONLY on goal events', evs.every((e) => (e.label === 'Goal') ? ('scoreForAfter' in e) : !('scoreForAfter' in e)));
    ok('D-N1 no undefined-valued fields (null used, never undefined)', evs.every((e) => ['subtype', 'location', 'playerId', 'playerOffId', 'playerOnId', 'side', 'sequenceId'].every((k) => !(k in e) || e[k] !== undefined)));
    ok('D-N2 qualifiers always an object', evs.every((e) => e.qualifiers && typeof e.qualifiers === 'object' && !Array.isArray(e.qualifiers)));
    const P4 = globalThis.__P4;
    const g4 = P4.events.filter((e) => e.label === 'Goal').length;
    const g4Our = P4.events.filter((e) => e.label === 'Goal' && e.team === 'our').length;
    ok('D-C4 P4 CONSISTENT after undo: matchClock 5-3 and ' + g4 + ' goal events (' + g4Our + ' our + ' + (g4 - g4Our) + ' opp) imply 5-3 (F3 fixed)', P4.matchClock.scoreFor === 5 && P4.matchClock.scoreAgainst === 3 && g4 === 8 && g4Our === 5);
  }

  // =====================================================================
  section('S13 — CSV content audit (Step 10)');
  // =====================================================================
  {
    const P3 = globalThis.__P3;
    const n = P3.events.length;
    function parseCsvLine(line) {
      const fields = []; let cur = ''; let inQ = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (inQ) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; } else cur += c; }
        else {
          if (c === '"') { if (cur === '') inQ = true; else return null; }
          else if (c === ',') { fields.push(cur); cur = ''; }
          else cur += c;
        }
      }
      if (inQ) return null; fields.push(cur); return fields;
    }
    function audit(name, csv, expectedCols, expectedRows) {
      const lines = csv.split('\n');
      const header = parseCsvLine(lines[0]);
      ok(name + '-1 header parsed, ' + expectedCols + ' columns', !!header && header.length === expectedCols, header ? header.length : 'unparseable');
      ok(name + '-2 ' + expectedRows + ' data rows (matches events)', lines.length - 1 === expectedRows, 'rows=' + (lines.length - 1));
      let bad = 0; const parsed = [];
      for (let i = 1; i < lines.length; i++) {
        const f = parseCsvLine(lines[i]);
        if (!f || f.length !== expectedCols) bad++; else parsed.push(f);
      }
      ok(name + '-3 all rows well-formed (no malformed/ragged rows)', bad === 0, 'bad=' + bad);
      ok(name + '-4 LF-only, no CR, no BOM (deferred defect 6 unchanged)', !csv.includes('\r') && csv.charCodeAt(0) !== 0xFEFF);
      return { header, parsed };
    }
    const std = audit('CSV-STD', globalThis.__csvStd, 18, n);
    ok('CSV-STD-5 header exactly as specified', std.header && std.header.join(',') === 'timecode,seconds,end_timecode,end_seconds,duration_seconds,label,side,player_number,player_name,player_off_number,player_off_name,player_on_number,player_on_name,subtype,qualifiers,location_zone,location_x,location_y');
    const stdGoalRow = std.parsed.find((r) => r[5] === 'Goal' && r[1] === '1440.0');
    ok('CSV-STD-6 first goal row: 1440.0s, side for, #9 Getachew Mulu', !!stdGoalRow && stdGoalRow[6] === 'for' && stdGoalRow[7] === '9' && stdGoalRow[8] === 'Getachew Mulu', stdGoalRow ? stdGoalRow.slice(5, 10).join('|') : 'missing');
    const stdSubRow = std.parsed.find((r) => r[5] === 'Sub' && r[9] === '6' && r[11] === '12');
    ok('CSV-STD-7 sub row carries off/on numbers+names', !!stdSubRow && stdSubRow[10] === 'Dawit Bekele' && stdSubRow[12] === 'Samuel Kassa', stdSubRow ? stdSubRow.slice(9, 14).join('|') : 'missing');
    const stdPoss = std.parsed.filter((r) => r[5] === 'Possession');
    ok('CSV-STD-8 4 possession rows export REAL times (no 00:00:00.0 / 0.0; F2 fixed)', stdPoss.length === 4 && stdPoss.every((r) => r[0] !== '00:00:00.0' && parseFloat(r[1]) > 0 && parseFloat(r[4]) > 0), stdPoss.map((r) => r[0] + '/' + r[1]).slice(0, 2).join(' ; '));
    const stdCard = std.parsed.find((r) => r[5] === 'Card' && r[13] === 'Yellow');
    ok('CSV-STD-9 card subtype column populated', !!stdCard);
    const stdLoc = std.parsed.find((r) => r[15] !== '' && r[5] === 'Pass');
    ok('CSV-STD-10 located pass row has zone + x/y', !!stdLoc && stdLoc[15].includes('third') && stdLoc[16] !== '', stdLoc ? stdLoc.slice(15, 18).join('|') : 'missing');

    const full = audit('CSV-FULL', globalThis.__csvFull, 35, n);
    const H = {}; full.header.forEach((h, i) => { H[h] = i; });
    ok('CSV-FULL-5 header includes all required analysis columns', ['Period', 'Official Minute', 'Second', 'Match Seconds', 'Match Time', 'Video Time', 'Team', 'Primary Player ID', 'Score For Before', 'Score Against Before', 'Score For After', 'Score Against After', 'Score State', 'Sequence ID', 'X', 'Y', 'Pitch Zone'].every((k) => k in H));
    ok('CSV-FULL-6 Video Time empty for all rows (no video)', full.parsed.every((r) => r[H['Video Time']] === ''));
    const fGoals = full.parsed.filter((r) => r[H['Event']] === 'Goal');
    ok('CSV-FULL-7 8 goal rows with before/after scores', fGoals.length === 8, 'goals=' + fGoals.length);
    const g1 = fGoals.find((r) => parseFloat(r[H['Match Seconds']]) === 1440);
    ok('CSV-FULL-8 goal@1440s: 1H, minute 24, our, 0-0 -> 1-0, state DRAW (before)', g1 && g1[H['Period']] === '1H' && g1[H['Official Minute']] === '24' && g1[H['Team']] === 'our' && g1[H['Score For Before']] === '0' && g1[H['Score For After']] === '1' && g1[H['Score State']] === 'DRAW', g1 ? [g1[H['Period']], g1[H['Official Minute']], g1[H['Team']], g1[H['Score For Before']], g1[H['Score For After']], g1[H['Score State']]].join('|') : 'missing');
    const gLast = fGoals[fGoals.length - 1];
    ok('CSV-FULL-9 last goal (rapid, opp): before 5-2 -> after 5-3', gLast && gLast[H['Score For Before']] === '5' && gLast[H['Score Against After']] === '3', gLast ? gLast[H['Score For Before']] + '->' + gLast[H['Score Against After']] : 'missing');
    const fSeq = full.parsed.filter((r) => r[H['Sequence ID']] !== '');
    ok('CSV-FULL-10 sequence-tagged rows carry SEQ-###', fSeq.length > 5 && fSeq.every((r) => /^SEQ-\d{3}$/.test(r[H['Sequence ID']])), 'rows=' + fSeq.length);
    const f2H = full.parsed.find((r) => r[H['Period']] === '2H' && r[H['Official Minute']] === '52' && parseFloat(r[H['Match Seconds']]) === 3100);
    ok('CSV-FULL-11 2H event (Pass @3100s, minute 52) present', !!f2H);
    const fPoss = full.parsed.filter((r) => r[H['Event']] === 'Possession');
    ok('CSV-FULL-12 4 possession rows: Match Time > 0 and consistent with Match Seconds (F2 fixed)', fPoss.length === 4 && fPoss.every((r) => parseFloat(r[H['Match Time']]) > 0 && parseInt(r[H['Match Seconds']], 10) === Math.floor(parseFloat(r[H['Match Time']]))), fPoss.map((r) => r[H['Match Time']] + '/' + r[H['Match Seconds']]).slice(0, 2).join(' ; '));
    const fPrim = full.parsed.find((r) => r[H['Primary Player ID']] === 'player_7');
    ok('CSV-FULL-13 primary player stored as ID (player_7)', !!fPrim);
    const dupCats = full.parsed.every((r) => r[H['Category']] === r[H['Event']] && r[H['Label']] === r[H['Event']]);
    ok('CSV-FULL-14 (deferred defect 7 confirmed) Category/Event/Label all duplicate the label', dupCats);
    finding('F7', 'LOW', 'Full-analysis CSV semantics (deferred defect 7, unchanged): Category = Event = Label (all event.label); Outcome = qualifiers; Phase/Note/Created At/Updated At always empty. Confirmed still present.');
    const season = audit('CSV-SEASON', globalThis.__csvSeason, 19, globalThis.__P1.events.length + globalThis.__P3.events.length);
    ok('CSV-SEASON-5 first column carries match labels', season.parsed.every((r) => r[0].includes('Bahir Dar City')));
  }

  // =====================================================================
  section('RESULTS');
  // =====================================================================
  console.log('  SUMMARY: P1 manual-save events=' + (globalThis.__P1 ? globalThis.__P1.events.length : '?') +
    ' | P3 interruption-flush events=' + (globalThis.__P3 ? globalThis.__P3.events.length : '?') +
    ' | goals=' + (globalThis.__P3 ? globalThis.__P3.events.filter((e) => e.label === 'Goal').length : '?') +
    ' | final score=' + (globalThis.__P3 ? globalThis.__P3.matchClock.scoreFor + '-' + globalThis.__P3.matchClock.scoreAgainst : '?') +
    ' | intervals=' + (globalThis.__P3 ? globalThis.__P3.events.filter((e) => e.isInterval).length : '?') +
    ' | season rows=' + (globalThis.__P1 && globalThis.__P3 ? globalThis.__P1.events.length + globalThis.__P3.events.length : '?'));
  let pass = 0, fail = 0;
  const bySec = {};
  results.forEach((r) => {
    if (r.pass) pass++; else fail++;
    bySec[r.section] = bySec[r.section] || { pass: 0, fail: 0 };
    bySec[r.section][r.pass ? 'pass' : 'fail']++;
  });
  results.forEach((r) => { if (!r.pass) console.log('  FAIL [' + r.section + '] ' + r.name + ' | ' + r.detail); });
  console.log('\n  ' + pass + ' passed, ' + fail + ' failed, ' + results.length + ' total');
  Object.keys(bySec).forEach((s) => console.log('    ' + s + ': ' + bySec[s].pass + ' passed / ' + bySec[s].fail + ' failed'));
  console.log('\n  FINDINGS (defect candidates — recorded, NOT fixed):');
  findings.forEach((f) => console.log('    ' + f.id + ' [' + f.sev + '] ' + f.text));
  if (jsdomErrors.length) { console.log('\n  jsdom errors captured: ' + jsdomErrors.length); jsdomErrors.slice(0, 5).forEach((e) => console.log('    ' + e)); }
  else console.log('\n  no jsdom errors captured');
  console.log(fail === 0 ? '\nALL MATCHDAY SIM CHECKS PASSED' : '\nFAILURES PRESENT');
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error('MATCHDAY SIM CRASHED:', err);
  process.exit(1);
});
