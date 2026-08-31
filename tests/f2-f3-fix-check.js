#!/usr/bin/env node
// PitchLog / MatchTag — F2 + F3 data-integrity fix verification harness
// ====================================================================
// Focused verification for the two MEDIUM data-integrity fixes ONLY:
//
//   F2  no-video interval events (Possession) must use the independent
//       match clock for startTime/endTime/matchTime/matchSeconds/
//       officialMinute/second/period, while video-linked interval
//       behavior stays byte-identical to the pre-fix code.
//   F3  undoing (or row-deleting) a Goal must restore/correct the match
//       score (matchClock, scoreboard, subsequent events' score fields,
//       autosave payload, reloaded session, exported CSV).
//
// Structure (per the task spec):
//   F2-1 no-video interval at a known match time -> all 7 fields consistent
//   F2-2 video-loaded interval -> OLD (git 0732b35) vs NEW event payloads
//        must be IDENTICAL (existing workflow preserved)
//   F2-3 no-video interval followed by a normal event -> ordering correct
//   F2-4 no-video interval spanning a minute boundary (44:58 -> 45:03)
//   F3-1 our goal:      0-0 -> 1-0 -> undo -> 0-0
//   F3-2 opponent goal: 1-0 -> 1-1 -> undo -> 1-0
//   F3-3 goal + subsequent event: undo path AND row-delete path
//   F3-4 goal persisted via autosave, undone, autosave corrected
//   F3-5 save/reload after undo
//   F3-6 export after undo (deleted goal absent, fields consistent)
//   REG  focused regressions (non-goal undo, repeated goals, touchline)
//   DI   realistic session audit: EVENT TIME / TEAM / PLAYER / PERIOD /
//        MATCH TIME / MATCH SECONDS / SCORE / SCORE STATE / SEQUENCE /
//        LOCATION
//
// Runs the REAL index.html + integrity.js + renderer.js inside jsdom with
// a stubbed window.matchtag bridge and a deterministic fake Date.now (the
// match clock is timestamp-based). No Electron GUI required.
//
// Run:  node tests/f2-f3-fix-check.js   (from the pitchlog project root)

'use strict';

const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

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
const rendererSrcNew = fs.readFileSync(path.join(srcDir, 'renderer.js'), 'utf-8');
// Pre-fix renderer (the state the F2/F3 defects were recorded against).
const rendererSrcOld = execSync('git show 0732b35:src/renderer.js', { cwd: path.join(__dirname, '..'), encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 });

const results = [];
let SECTION = '(pre)';
function section(name) { SECTION = name; console.log('\n===== ' + name + ' ====='); }
function ok(name, cond, detail) {
  results.push({ section: SECTION, name, pass: !!cond, detail: detail === undefined ? '' : String(detail) });
  if (!cond) console.log('  FAIL: ' + name + (detail === undefined ? '' : '  | ' + detail));
}

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
  let closeCallback = null;
  const stub = {
    openVideo: async () => null,
    saveSession: async (d) => { calls.saveSession.push(clone(d)); return { canceled: false, filePath: '/tmp/f2f3-session.json' }; },
    exportCsv: async (csv) => { calls.exportCsv.push(String(csv)); return { canceled: false, filePath: '/tmp/f2f3-export.csv' }; },
    exportClipPlaylist: async () => ({ canceled: true }),
    loadSession: async () => clone(loadSessionData),
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
  win.Date.now = () => fakeNow;
  const RECT = { left: 0, top: 0, right: 700, bottom: 450, width: 700, height: 450, x: 0, y: 0 };
  if (win.SVGElement) win.SVGElement.prototype.getBoundingClientRect = function () { return { ...RECT }; };
  else win.Element.prototype.getBoundingClientRect = function () { return { ...RECT }; };
  const stub = makeStub(initial);
  win.matchtag = stub;
  // The current index.html replaced the legacy pitch-map Side filter with
  // the v3 Team filter (spatial-engine task, SP-V6). When an OLD renderer
  // source (git 0732b35) is eval'd here for the F2-2 old-vs-new interval
  // comparison, inject a hidden inert legacy select so the old code can
  // bind its listener; it never affects the NEW renderer.
  if (initial.rendererSrc && !win.document.getElementById('pitchMapSideFilter')) {
    const legacy = win.document.createElement('select');
    legacy.id = 'pitchMapSideFilter';
    legacy.setAttribute('style', 'display:none;');
    win.document.body.appendChild(legacy);
  }
  win.eval(initial.integritySrc || integritySrc);
  win.eval(initial.rendererSrc || rendererSrcNew);
  return { dom, win, doc: win.document, stub };
}

// Official-minute oracle (mirrors the app's formatOfficialMinute rules).
function oracleOfficialMinute(seconds, period) {
  if (!period || period === 'PRE_MATCH') return 0;
  const s = Math.max(0, Math.floor(seconds));
  const b = { '1H': 2700, 'HT': 2700, '2H': 5400, 'FT': 5400, 'ET1': 6300, 'ET_HT': 6300, 'ET2': 7200 }[period] || 0;
  if (s > b && (period === '1H' || period === '2H' || period === 'ET1' || period === 'ET2')) return Math.floor(b / 60) + Math.ceil((s - b) / 60);
  return Math.ceil(s / 60);
}

// Independent clock model (mirrors the documented clock rules).
const ck = { base: 0, running: false, startedAt: null, period: 'PRE_MATCH' };
function ckNow() { return ck.running ? ck.base + (fakeNow - ck.startedAt) / 1000 : ck.base; }

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

const SQUAD = [
  { id: 'player_1', number: '9', name: 'Getachew Mulu' },
  { id: 'player_2', number: '8', name: 'Fitsum Girma' },
  { id: 'player_3', number: '4', name: 'Yohannes Haile' }
];

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
  function rowCount() { return B.doc.querySelectorAll('#eventList .event-row').length; }
  function scoreboard() { return txt('scoreboardDisplay'); }
  function scoreState() { return txt('scoreStateDisplay'); }
  function selectPlayer(pid) { const sel = id('selectedPlayerSelect'); sel.value = pid; change(sel); }
  function selectTeam(team) { click(team === 'our' ? id('btnTeamOur') : id('btnTeamOpponent')); }
  function mStart() { click(id('btnClockStart')); if (ck.period === 'PRE_MATCH') ck.period = '1H'; if (!ck.running) { ck.startedAt = fakeNow; ck.running = true; } }
  function mEndHalf() { click(id('btnClockEndHalf')); if (ck.running) { ck.base = ckNow(); ck.startedAt = null; ck.running = false; } if (ck.period === '1H') { ck.base = 2700; ck.period = 'HT'; } }
  function mNextHalf() { click(id('btnClockNextHalf')); if (ck.period === 'HT') { ck.period = '2H'; ck.base = 2700; } ck.startedAt = fakeNow; ck.running = true; }
  function detailDone() { const b = id('detailPanelDone'); if (b) click(b); }
  function setDetailChip(kind, value) {
    const chip = Array.from(B.doc.querySelectorAll('#detailPanel .chip')).find((c) => c.dataset.kind === kind && (value === undefined || c.dataset.value === value || c.dataset.playerId === value));
    if (!chip) throw new Error('chip not found: ' + kind + ' ' + value);
    click(chip);
  }
  function tapDetailPitch(x, y) {
    const svg = B.doc.querySelector('#detailPanel #pitchSvg');
    click(svg, { clientX: Math.round(x * 700), clientY: Math.round(y * 450) });
  }
  function loc(x, y) { return { x: Math.round(x * 700) / 700, y: Math.round(y * 450) / 450 }; }

  // Non-destructive snapshot of the live session state: fires the real
  // beforeunload synchronous flush (kept dirty, autosave untouched).
  function snapshot() {
    B.win.dispatchEvent(new B.win.Event('beforeunload', { cancelable: true }));
    const arr = B.stub._calls.autosaveFlushSync;
    return arr[arr.length - 1];
  }
  async function saveNow() {
    click(id('btnSaveSession'));
    await sleep(200);
    const arr = B.stub._calls.saveSession;
    return arr[arr.length - 1];
  }

  // Reset the independent clock model + fake time before each scenario.
  function resetClock() { ck.base = 0; ck.running = false; ck.startedAt = null; ck.period = 'PRE_MATCH'; }

  // =====================================================================
  section('F2-1 — no-video interval: all timestamp fields consistent (2H 67:20 -> 67:48)');
  // =====================================================================
  {
    B = boot({ squad: SQUAD, autosave: null }); resetClock(); await sleep(250);
    mStart(); advanceMatchSeconds(2700); mEndHalf(); mNextHalf(); advanceMatchSeconds(1340); // 2H 67:20 = 4040s
    selectTeam('our'); selectPlayer('player_1');
    click(tagBtn('Possession'));            // START at 4040 (67:20)
    advanceMatchSeconds(28);                // -> 4068 (67:48)
    click(tagBtn('Possession'));            // FINISH
    detailDone();
    const P = snapshot();
    const ev = P.events.find((e) => e.label === 'Possession');
    ok('F2-1a interval event exists', !!ev);
    if (ev) {
      ok('F2-1b startTime = 67:20 (4040s, match clock)', Math.abs(ev.startTime - 4040) < 0.001, 'startTime=' + ev.startTime);
      ok('F2-1c endTime = 67:48 (4068s, match clock)', Math.abs(ev.endTime - 4068) < 0.001, 'endTime=' + ev.endTime);
      ok('F2-1d matchTime === startTime (not 0)', ev.matchTime === ev.startTime && ev.matchTime !== 0, 'matchTime=' + ev.matchTime);
      ok('F2-1e legacy time field === startTime (not 0)', ev.time === ev.startTime && ev.time !== 0, 'time=' + ev.time);
      ok('F2-1f matchSeconds === floor(startTime)', ev.matchSeconds === Math.floor(ev.startTime), 'matchSeconds=' + ev.matchSeconds);
      ok('F2-1g second === matchSeconds % 60 (=20)', ev.second === ev.matchSeconds % 60 && ev.second === 20, 'second=' + ev.second);
      ok('F2-1h officialMinute derived from start (68 in 2H)', ev.officialMinute === oracleOfficialMinute(4040, '2H'), 'officialMinute=' + ev.officialMinute);
      ok('F2-1i period = 2H (period at start)', ev.period === '2H', 'period=' + ev.period);
      ok('F2-1j videoTime stays null (no video)', ev.videoTime === null);
      ok('F2-1k isInterval flag set', ev.isInterval === true);
      ok('F2-1l team/player captured', ev.team === 'our' && ev.playerId === 'player_1');
    }
    ok('F2-1m event list row shows real time range, not 00:00:00', /01:07:20/.test(B.doc.querySelector('#eventList .event-row').textContent), B.doc.querySelector('#eventList .event-row').textContent.slice(0, 60));
    B.dom.window.close();
  }

  // =====================================================================
  section('F2-2 — video-loaded interval: NEW code identical to pre-fix code (0732b35)');
  // =====================================================================
  {
    const videoSession = {
      videoPath: '/tmp/match.mp4', videoUrl: 'file:///tmp/match.mp4',
      tags: [], events: [], squad: SQUAD,
      matchInfo: { opponent: 'Video FC' },
      matchClock: { clockStartedAt: null, clockBaseSeconds: 4040, clockRunning: false, period: '2H',
        scoreFor: 1, scoreAgainst: 0, videoSyncOffset: 0, selectedTeam: 'our', selectedPlayerId: null,
        activeSequenceId: null, nextSequenceNumber: 1 }
    };
    function runVideoScenario(rendererSrc) {
      const X = boot({ squad: SQUAD, autosave: null, rendererSrc });
      const ctx = { B: X };
      const c = (el) => el.dispatchEvent(new X.win.MouseEvent('click', { bubbles: true, cancelable: true }));
      X.stub._setLoadSession(clone(videoSession));
      c(X.doc.getElementById('btnLoadSession'));
      return new Promise((resolve) => setTimeout(() => {
        const video = X.doc.getElementById('video');
        // Simulate a loaded, seekable video in jsdom (the real app reads
        // video.readyState / video.currentTime / video.duration).
        Object.defineProperty(video, 'readyState', { value: 4, configurable: true });
        Object.defineProperty(video, 'currentTime', { value: 100.5, configurable: true, writable: true });
        Object.defineProperty(video, 'duration', { value: 5000, configurable: true, writable: true });
        const poss = Array.from(X.doc.querySelectorAll('#tagButtons .tag-btn')).find((b) => b.textContent.replace('⏱', '').trim().startsWith('Possession'));
        c(poss);                      // START at video 100.5
        video.currentTime = 130.25;   // advance the video
        c(poss);                      // FINISH at video 130.25
        const done = X.doc.getElementById('detailPanelDone'); if (done) c(done);
        c(X.doc.getElementById('btnSaveSession'));
        setTimeout(() => {
          const saves = X.stub._calls.saveSession;
          resolve({ payload: saves[saves.length - 1], win: X.win, dom: X.dom });
        }, 200);
      }, 250));
    }
    const oldRun = await runVideoScenario(rendererSrcOld);
    const newRun = await runVideoScenario(rendererSrcNew);
    const oldEv = oldRun.payload.events.find((e) => e.label === 'Possession');
    const newEv = newRun.payload.events.find((e) => e.label === 'Possession');
    ok('F2-2a OLD (pre-fix) run produced the interval event', !!oldEv);
    ok('F2-2b NEW run produced the interval event', !!newEv);
    if (oldEv && newEv) {
      ok('F2-2c event payload BYTE-IDENTICAL old vs new (video workflow preserved)', JSON.stringify(oldEv) === JSON.stringify(newEv),
        'old=' + JSON.stringify(oldEv).slice(0, 140) + ' new=' + JSON.stringify(newEv).slice(0, 140));
      ok('F2-2d bounds are VIDEO times (startTime 100.5 / endTime 130.25)', newEv.startTime === 100.5 && newEv.endTime === 130.25,
        newEv.startTime + ' / ' + newEv.endTime);
      ok('F2-2e matchTime aliased to video startTime (existing convention)', newEv.matchTime === 100.5, 'matchTime=' + newEv.matchTime);
      ok('F2-2f videoTime recorded (finish-time video clock)', newEv.videoTime === 130.25, 'videoTime=' + newEv.videoTime);
      ok('F2-2g matchSeconds from video-derived match clock (floor 130)', newEv.matchSeconds === 130, 'matchSeconds=' + newEv.matchSeconds);
    }
    ok('F2-2h full save payload identical old vs new (events + matchClock)',
      JSON.stringify(oldRun.payload.events) === JSON.stringify(newRun.payload.events) &&
      JSON.stringify(oldRun.payload.matchClock) === JSON.stringify(newRun.payload.matchClock));
    oldRun.dom.window.close(); newRun.dom.window.close();
  }

  // =====================================================================
  section('F2-3 — no-video interval followed by a normal event: ordering');
  // =====================================================================
  {
    B = boot({ squad: SQUAD, autosave: null }); resetClock(); await sleep(250);
    mStart();
    advanceMatchSeconds(50); selectTeam('our'); selectPlayer('player_1');
    click(tagBtn('Corner'));                       // t=50 (flat tag)
    advanceMatchSeconds(50);                       // t=100
    click(tagBtn('Possession'));                   // interval START at 100
    advanceMatchSeconds(28);                       // t=128
    click(tagBtn('Possession'));                   // interval FINISH (time=100)
    detailDone();
    advanceMatchSeconds(12);                       // t=140
    click(tagBtn('Shot'));                         // normal event at 140
    detailDone();
    const P = snapshot();
    const evs = P.events;
    ok('F2-3a three events logged', evs.length === 3, 'events=' + evs.length);
    ok('F2-3b array sorted by time: Corner(50) < Possession(100) < Shot(140)',
      evs[0].label === 'Corner' && evs[0].time === 50 && evs[1].label === 'Possession' && evs[1].time === 100 && evs[2].label === 'Shot' && evs[2].time === 140,
      evs.map((e) => e.label + '@' + e.time).join(', '));
    ok('F2-3c interval no longer sorts to the TOP of the event list',
      !/Possession/.test(B.doc.querySelector('#eventList .event-row').textContent) && /Corner/.test(B.doc.querySelector('#eventList .event-row').textContent),
      B.doc.querySelector('#eventList .event-row').textContent.slice(0, 50));
    ok('F2-3d interval endTime (128) < following Shot time (140) — both sides ordered',
      evs[1].endTime === 128 && evs[1].endTime < evs[2].time);
    B.dom.window.close();
  }

  // =====================================================================
  section('F2-4 — no-video interval spanning a minute boundary (44:58 -> 45:03)');
  // =====================================================================
  {
    B = boot({ squad: SQUAD, autosave: null }); resetClock(); await sleep(250);
    mStart(); advanceMatchSeconds(2698);           // 1H 44:58
    selectTeam('our'); selectPlayer('player_2');
    click(tagBtn('Possession'));                   // START at 2698
    advanceMatchSeconds(5);                        // -> 2703 (45:03)
    click(tagBtn('Possession'));                   // FINISH
    detailDone();
    const P = snapshot();
    const ev = P.events.find((e) => e.label === 'Possession');
    ok('F2-4a interval exists', !!ev);
    if (ev) {
      ok('F2-4b START side: startTime = 2698s (44:58)', Math.abs(ev.startTime - 2698) < 0.001, 'startTime=' + ev.startTime);
      ok('F2-4c END side: endTime = 2703s (45:03)', Math.abs(ev.endTime - 2703) < 0.001, 'endTime=' + ev.endTime);
      ok('F2-4d matchSeconds = 2698 (start side)', ev.matchSeconds === 2698, 'matchSeconds=' + ev.matchSeconds);
      ok('F2-4e second = 58 (start side)', ev.second === 58, 'second=' + ev.second);
      ok('F2-4f officialMinute = 45 (start side, 1H)', ev.officialMinute === 45 && ev.officialMinute === oracleOfficialMinute(2698, '1H'), 'officialMinute=' + ev.officialMinute);
      ok('F2-4g period = 1H on both sides (same half)', ev.period === '1H');
      ok('F2-4h duration implied = 5s (end - start)', Math.abs((ev.endTime - ev.startTime) - 5) < 0.001);
    }
    B.dom.window.close();
  }

  // =====================================================================
  section('F3-1 — our goal: 0-0 -> 1-0 -> undo -> 0-0');
  // =====================================================================
  {
    B = boot({ squad: SQUAD, autosave: null }); resetClock(); await sleep(250);
    mStart(); advanceMatchSeconds(60); selectTeam('our'); selectPlayer('player_1');
    click(tagBtn('Goal'));
    ok('F3-1a goal logged -> 1 — 0 WINNING', scoreboard() === '1 — 0' && scoreState() === 'WINNING', scoreboard() + '/' + scoreState());
    const Pgoal = snapshot();
    const g = Pgoal.events.find((e) => e.label === 'Goal');
    ok('F3-1b goal event carries exact before/after (0-0 -> 1-0)',
      g && g.scoreForBefore === 0 && g.scoreAgainstBefore === 0 && g.scoreForAfter === 1 && g.scoreAgainstAfter === 0);
    click(id('btnUndo'));
    ok('F3-1c undo -> 0 — 0 DRAW (scoreboard reverted)', scoreboard() === '0 — 0' && scoreState() === 'DRAW', scoreboard() + '/' + scoreState());
    const Pundo = snapshot();
    ok('F3-1d goal event removed from events', Pundo.events.length === 0 && !Pundo.events.some((e) => e.label === 'Goal'));
    ok('F3-1e matchClock.scoreFor/scoreAgainst reverted to 0-0', Pundo.matchClock.scoreFor === 0 && Pundo.matchClock.scoreAgainst === 0,
      Pundo.matchClock.scoreFor + '-' + Pundo.matchClock.scoreAgainst);
    ok('F3-1f undo button disabled again (single-shot preserved)', id('btnUndo').disabled === true);
    B.dom.window.close();
  }

  // =====================================================================
  section('F3-2 — opponent goal: 1-0 -> 1-1 -> undo -> 1-0');
  // =====================================================================
  {
    B = boot({ squad: SQUAD, autosave: null }); resetClock(); await sleep(250);
    mStart(); advanceMatchSeconds(60); selectTeam('our'); selectPlayer('player_1');
    click(tagBtn('Goal'));                          // 1-0
    advanceMatchSeconds(30); selectTeam('opponent'); selectPlayer('');
    click(tagBtn('Goal'));                          // 1-1
    ok('F3-2a opponent goal -> 1 — 1 DRAW', scoreboard() === '1 — 1' && scoreState() === 'DRAW', scoreboard() + '/' + scoreState());
    click(id('btnUndo'));
    ok('F3-2b undo -> 1 — 0 WINNING (opponent goal reverted)', scoreboard() === '1 — 0' && scoreState() === 'WINNING', scoreboard() + '/' + scoreState());
    const P = snapshot();
    ok('F3-2c only the OUR goal remains (opponent goal removed)', P.events.length === 1 && P.events[0].team === 'our');
    ok('F3-2d matchClock reverted to 1-0', P.matchClock.scoreFor === 1 && P.matchClock.scoreAgainst === 0);
    ok('F3-2e remaining goal chain intact (0-0 -> 1-0)', P.events[0].scoreForBefore === 0 && P.events[0].scoreForAfter === 1);
    B.dom.window.close();
  }

  // =====================================================================
  section('F3-3 — goal + subsequent event (undo path AND row-delete path)');
  // =====================================================================
  {
    // (a) UNDO path: the single-shot undo system removes the MOST RECENTLY
    // LOGGED event, so the goal is undoable while it is the last logged
    // event; the remaining (previously logged) event's score fields must
    // stay consistent with the restored score.
    B = boot({ squad: SQUAD, autosave: null }); resetClock(); await sleep(250);
    mStart(); advanceMatchSeconds(10); selectTeam('our'); selectPlayer('player_1');
    click(tagBtn('Shot')); setDetailChip('subtype', 'On target'); detailDone();   // t=10, Before 0-0
    advanceMatchSeconds(10);
    click(tagBtn('Goal'));                                                        // 1-0
    click(id('btnUndo'));                                                         // -> 0-0
    const Pa = snapshot();
    const shotA = Pa.events.find((e) => e.label === 'Shot');
    ok('F3-3a undo path: goal gone, Shot remains', Pa.events.length === 1 && !!shotA);
    ok('F3-3b remaining Shot score fields consistent with restored 0-0',
      shotA && shotA.scoreForBefore === 0 && shotA.scoreAgainstBefore === 0,
      shotA ? shotA.scoreForBefore + '-' + shotA.scoreAgainstBefore : 'none');
    ok('F3-3c matchClock 0-0 matches remaining event data', Pa.matchClock.scoreFor === 0 && Pa.matchClock.scoreAgainst === 0);
    B.dom.window.close();

    // (b) ROW-DELETE path (the literal sequence): a goal is followed by
    // another event, then the GOAL is removed via the per-event delete
    // button. The score must be corrected AND the subsequent event's score
    // fields must be shifted to the corrected trajectory.
    B = boot({ squad: SQUAD, autosave: null }); resetClock(); await sleep(250);
    mStart(); advanceMatchSeconds(10); selectTeam('our'); selectPlayer('player_1');
    click(tagBtn('Goal'));                                       // id1: 0-0 -> 1-0
    advanceMatchSeconds(10);
    click(tagBtn('Pass')); detailDone();                         // id2: logged after goal, Before 1-0
    ok('F3-3d setup: 1 — 0 with Pass logged after goal', scoreboard() === '1 — 0' && rowCount() === 2);
    const goalRow = Array.from(B.doc.querySelectorAll('#eventList .event-row')).find((r) => /Goal/.test(r.textContent));
    click(goalRow.querySelector('.event-delete'));
    const Pb = snapshot();
    const passB = Pb.events.find((e) => e.label === 'Pass');
    ok('F3-3e goal deleted, Pass remains', Pb.events.length === 1 && !!passB);
    ok('F3-3f scoreboard corrected to 0 — 0', scoreboard() === '0 — 0', scoreboard());
    ok('F3-3g matchClock corrected to 0-0', Pb.matchClock.scoreFor === 0 && Pb.matchClock.scoreAgainst === 0);
    ok('F3-3h subsequent Pass score fields SHIFTED to 0-0 (consistent with corrected state)',
      passB && passB.scoreForBefore === 0 && passB.scoreAgainstBefore === 0,
      passB ? passB.scoreForBefore + '-' + passB.scoreAgainstBefore : 'none');
    B.dom.window.close();
  }

  // =====================================================================
  section('F3-4 — goal persisted via autosave, undone, autosave corrected');
  // =====================================================================
  {
    B = boot({ squad: SQUAD, autosave: null }); resetClock(); await sleep(250);
    mStart(); advanceMatchSeconds(60); selectTeam('our'); selectPlayer('player_1');
    click(tagBtn('Goal'));
    await sleep(2000); // let the 1500ms debounced autosave fire
    const withGoal = B.stub._calls.autosaveWrite[B.stub._calls.autosaveWrite.length - 1];
    ok('F3-4a autosave captured the goal (1-0) BEFORE undo',
      withGoal && withGoal.matchClock.scoreFor === 1 && withGoal.events.some((e) => e.label === 'Goal'),
      withGoal ? 'score=' + withGoal.matchClock.scoreFor + ' events=' + withGoal.events.length : 'none');
    click(id('btnUndo'));
    await sleep(2000); // debounced autosave fires again after the undo
    const afterUndo = B.stub._calls.autosaveWrite[B.stub._calls.autosaveWrite.length - 1];
    ok('F3-4b autosave after undo contains the CORRECTED score 0-0',
      afterUndo && afterUndo.matchClock.scoreFor === 0 && afterUndo.matchClock.scoreAgainst === 0,
      afterUndo ? afterUndo.matchClock.scoreFor + '-' + afterUndo.matchClock.scoreAgainst : 'none');
    ok('F3-4c autosave after undo no longer contains the goal event',
      afterUndo && !afterUndo.events.some((e) => e.label === 'Goal'));
    B.dom.window.close();
  }

  // =====================================================================
  section('F3-5 — save / reload after undo');
  // =====================================================================
  {
    B = boot({ squad: SQUAD, autosave: null }); resetClock(); await sleep(250);
    mStart(); advanceMatchSeconds(60); selectTeam('our'); selectPlayer('player_1');
    click(tagBtn('Shot')); setDetailChip('subtype', 'On target'); detailDone();   // 0-0
    advanceMatchSeconds(10);
    click(tagBtn('Goal'));                                                        // 1-0
    click(id('btnUndo'));                                                         // -> 0-0
    const P1 = await saveNow();
    ok('F3-5a saved payload: score 0-0, no goal, 1 event',
      P1.matchClock.scoreFor === 0 && P1.matchClock.scoreAgainst === 0 && P1.events.length === 1 && !P1.events.some((e) => e.label === 'Goal'),
      'score=' + P1.matchClock.scoreFor + '-' + P1.matchClock.scoreAgainst + ' events=' + P1.events.length);
    B.stub._setLoadSession(clone(P1));
    click(id('btnLoadSession'));
    await sleep(300);
    ok('F3-5b reloaded session shows 0 — 0 DRAW', scoreboard() === '0 — 0' && scoreState() === 'DRAW', scoreboard() + '/' + scoreState());
    ok('F3-5c reloaded event list has the Shot only', rowCount() === 1 && parseInt(txt('eventCount'), 10) === 1);
    const P2 = await saveNow();
    ok('F3-5d re-saved payload stays corrected (0-0, no goal)',
      P2.matchClock.scoreFor === 0 && !P2.events.some((e) => e.label === 'Goal') && P2.events.length === 1);
    B.dom.window.close();
  }

  // =====================================================================
  section('F3-6 — export after undo (deleted goal absent, fields consistent)');
  // =====================================================================
  {
    B = boot({ squad: SQUAD, autosave: null }); resetClock(); await sleep(250);
    mStart(); advanceMatchSeconds(60); selectTeam('our'); selectPlayer('player_1');
    click(tagBtn('Shot')); setDetailChip('subtype', 'On target'); detailDone();   // Before 0-0
    advanceMatchSeconds(10);
    click(tagBtn('Goal'));                                                        // 1-0
    click(id('btnUndo'));                                                         // -> 0-0
    click(id('btnExportCsv'), { shiftKey: true });                                // full analysis CSV
    await sleep(200);
    click(id('btnExportCsv'));                                                    // standard CSV
    await sleep(200);
    const calls = B.stub._calls.exportCsv;
    const fullCsv = calls[calls.length - 2];
    const stdCsv = calls[calls.length - 1];
    const fullLines = fullCsv.split('\n');
    const header = parseCsvLine(fullLines[0]);
    const H = {}; header.forEach((h, i) => { H[h] = i; });
    const rows = fullLines.slice(1).map(parseCsvLine);
    ok('F3-6a full CSV: exactly one data row (the Shot)', rows.length === 1 && rows[0][H['Event']] === 'Shot', 'rows=' + rows.length);
    ok('F3-6b deleted goal is ABSENT from the export', !rows.some((r) => r[H['Event']] === 'Goal'));
    ok('F3-6c remaining Shot row score fields consistent with corrected 0-0',
      rows[0][H['Score For Before']] === '0' && rows[0][H['Score Against Before']] === '0',
      rows[0][H['Score For Before']] + '-' + rows[0][H['Score Against Before']]);
    ok('F3-6d Score State column consistent (DRAW at 0-0)', rows[0][H['Score State']] === 'DRAW', rows[0][H['Score State']]);
    const stdLines = stdCsv.split('\n');
    ok('F3-6e standard CSV: one row, no Goal', stdLines.length === 2 && !/Goal/.test(stdCsv));
    B.dom.window.close();
  }

  // =====================================================================
  section('REG — focused regressions around the two fixes');
  // =====================================================================
  {
    // R1: undo of a NON-goal event must not touch the score.
    B = boot({ squad: SQUAD, autosave: null }); resetClock(); await sleep(250);
    mStart(); advanceMatchSeconds(60); selectTeam('our'); selectPlayer('player_1');
    click(tagBtn('Goal'));                                     // 1-0
    advanceMatchSeconds(10);
    click(tagBtn('Pass')); detailDone();                       // last logged
    click(id('btnUndo'));                                      // removes the Pass
    ok('R1 undo of non-goal keeps the score at 1 — 0', scoreboard() === '1 — 0' && rowCount() === 1, scoreboard());
    B.dom.window.close();

    // R2: goal -> undo -> goal again (id never reused, score re-applies).
    B = boot({ squad: SQUAD, autosave: null }); resetClock(); await sleep(250);
    mStart(); advanceMatchSeconds(60); selectTeam('our'); selectPlayer('player_1');
    click(tagBtn('Goal'));
    const P1 = snapshot(); const id1 = P1.events[0].id;
    click(id('btnUndo'));
    advanceMatchSeconds(10);
    click(tagBtn('Goal'));
    const P2 = snapshot(); const g2 = P2.events.find((e) => e.label === 'Goal');
    ok('R2a goal re-tagged after undo -> 1 — 0 again', scoreboard() === '1 — 0' && P2.events.length === 1);
    ok('R2b new goal id is fresh (no id reuse after undo)', g2 && g2.id > id1, 'ids ' + id1 + ' -> ' + (g2 ? g2.id : '?'));
    ok('R2c new goal chain fields clean (0-0 -> 1-0)', g2 && g2.scoreForBefore === 0 && g2.scoreForAfter === 1);
    B.dom.window.close();

    // R3: two goals -> undo -> exact state before the SECOND goal.
    B = boot({ squad: SQUAD, autosave: null }); resetClock(); await sleep(250);
    mStart(); advanceMatchSeconds(60); selectTeam('our'); selectPlayer('player_1');
    click(tagBtn('Goal'));                                     // 1-0
    advanceMatchSeconds(10); selectPlayer('player_2');
    click(tagBtn('Goal'));                                     // 2-0
    click(id('btnUndo'));                                      // -> 1-0
    ok('R3a undo restores 1 — 0 (exact pre-2nd-goal state)', scoreboard() === '1 — 0', scoreboard());
    const P3 = snapshot();
    const g1 = P3.events[0];
    ok('R3b first goal intact with its own 0-0 -> 1-0 fields', g1.scoreForBefore === 0 && g1.scoreForAfter === 1);
    B.dom.window.close();

    // R4: Touchline Mode undo path reverts the score too.
    B = boot({ squad: SQUAD, autosave: null }); resetClock(); await sleep(250);
    mStart(); advanceMatchSeconds(60);
    click(id('btnTouchlineToggle'));
    click(id('tlBtnTeamOur'));
    click(quickBtn('Goal'));
    ok('R4a touchline goal -> touchlineScore 1 — 0', txt('touchlineScore') === '1 — 0', txt('touchlineScore'));
    click(id('tlBtnUndo'));
    ok('R4b touchline undo -> touchlineScore 0 — 0 DRAW', txt('touchlineScore') === '0 — 0' && txt('touchlineScoreState') === 'DRAW',
      txt('touchlineScore') + '/' + txt('touchlineScoreState'));
    click(id('btnExitTouchline'));
    ok('R4c desktop scoreboard agrees (0 — 0 DRAW)', scoreboard() === '0 — 0' && scoreState() === 'DRAW', scoreboard() + '/' + scoreState());
    const P4 = snapshot();
    ok('R4d matchClock in payload corrected (0-0)', P4.matchClock.scoreFor === 0 && P4.matchClock.scoreAgainst === 0);
    B.dom.window.close();
  }

  // =====================================================================
  section('DI — realistic session data-integrity audit (incl. F2 + F3 paths)');
  // =====================================================================
  {
    B = boot({ squad: SQUAD, autosave: null }); resetClock(); await sleep(250);
    mStart();
    // t=100 Shot (our, #9, located)
    advanceMatchSeconds(100); selectTeam('our'); selectPlayer('player_1');
    click(tagBtn('Shot')); setDetailChip('subtype', 'On target'); tapDetailPitch(0.72, 0.35); detailDone();
    // t=200 GOAL our (0-0 -> 1-0)
    advanceMatchSeconds(100);
    click(tagBtn('Goal'));
    // t=250 Pass (our, #8)
    advanceMatchSeconds(50); selectPlayer('player_2');
    click(tagBtn('Pass')); setDetailChip('subtype', 'Progressive'); detailDone();
    // t=310-320 Corner inside SEQ-001 (our, #4), sequence ends right after
    advanceMatchSeconds(60); selectPlayer('player_3');
    click(id('btnStartSequence'));
    advanceMatchSeconds(10);
    click(tagBtn('Corner')); detailDone();
    click(id('btnEndSequence'));
    // t=340 Possession interval START (our, #8) — goal happens DURING it
    advanceMatchSeconds(20); selectPlayer('player_2');
    click(tagBtn('Possession'));
    // t=360 GOAL our (1-0 -> 2-0) logged while the interval is recording
    advanceMatchSeconds(20);
    click(tagBtn('Goal'));
    // t=385 Possession interval FINISH (event time anchored to 340)
    advanceMatchSeconds(25);
    click(tagBtn('Possession')); detailDone();
    // t=400 Foul (opponent)
    advanceMatchSeconds(15); selectTeam('opponent'); selectPlayer('');
    click(tagBtn('Foul')); setDetailChip('qualifier', 'Middle third'); detailDone();
    // t=430 GOAL opponent (2-0 -> 2-1) … then UNDONE at t=440
    advanceMatchSeconds(30);
    click(tagBtn('Goal'));
    ok('DI-a opponent goal logged -> 2 — 1', scoreboard() === '2 — 1', scoreboard());
    click(id('btnUndo'));
    ok('DI-b undo of the opponent goal restores 2 — 0 WINNING', scoreboard() === '2 — 0' && scoreState() === 'WINNING', scoreboard() + '/' + scoreState());
    // t=460 Shot (our, #9, located)
    advanceMatchSeconds(20); selectTeam('our'); selectPlayer('player_1');
    click(tagBtn('Shot')); setDetailChip('subtype', 'Off target'); tapDetailPitch(0.55, 0.6); detailDone();
    // Final: 2-0, 8 events (1 undone goal removed).
    const P = snapshot();
    const evs = P.events;
    ok('DI-1 session shape: 8 events (goal undone is absent)', evs.length === 8, 'events=' + evs.length);
    ok('DI-2 undone goal absent, 2 goals remain (both ours)', evs.filter((e) => e.label === 'Goal').length === 2 && evs.every((e) => e.team !== 'opponent' || e.label !== 'Goal'));

    // ---- EVENT TIME / MATCH TIME / MATCH SECONDS ----
    ok('DI-3 time === matchTime on every event', evs.every((e) => e.time === e.matchTime));
    ok('DI-4 matchSeconds === floor(matchTime) on every event (F2 consistency, intervals included)',
      evs.every((e) => e.matchSeconds === Math.floor(e.matchTime)),
      evs.filter((e) => e.matchSeconds !== Math.floor(e.matchTime)).map((e) => e.label + ':' + e.matchSeconds + '/' + e.matchTime).join(','));
    ok('DI-5 events sorted by time ascending', evs.every((e, i, a) => i === 0 || a[i - 1].time <= e.time));
    ok('DI-6 event ids unique', new Set(evs.map((e) => e.id)).size === evs.length);
    // Per-event oracle (id order = log order).
    const oracle = [
      { id: 1, label: 'Shot',       t: 100, team: 'our',      playerId: 'player_1', subtype: 'On target',  seq: null,     scoreBefore: [0, 0] },
      { id: 2, label: 'Goal',       t: 200, team: 'our',      playerId: 'player_1', subtype: null,         seq: null,     scoreBefore: [0, 0], goalAfter: [1, 0] },
      { id: 3, label: 'Pass',       t: 250, team: 'our',      playerId: 'player_2', subtype: 'Progressive', seq: null,     scoreBefore: [1, 0] },
      { id: 4, label: 'Corner',      t: 320, team: 'our',      playerId: 'player_3', subtype: null,         seq: 'SEQ-001', scoreBefore: [1, 0] },
      { id: 5, label: 'Goal',       t: 360, team: 'our',      playerId: 'player_2', subtype: null,         seq: null,     scoreBefore: [1, 0], goalAfter: [2, 0] },
      { id: 6, label: 'Possession', t: 340, team: 'our',      playerId: 'player_2', subtype: null,         seq: null,     scoreBefore: [2, 0], interval: [340, 385] },
      { id: 7, label: 'Foul',       t: 400, team: 'opponent', playerId: null,      subtype: null,         seq: null,     scoreBefore: [2, 0] },
      { id: 8, label: 'Shot',       t: 450, team: 'our',      playerId: 'player_1', subtype: 'Off target', seq: null,     scoreBefore: [2, 0] }
    ];
    const details = [];
    const perOracle = evs.every((e) => {
      const l = oracle.find((x) => x.id === (e.id === 9 ? 8 : e.id)); // last event got id 9 (8 was consumed by the undone goal)
      if (!l) { details.push('id ' + e.id + ': no oracle row'); return false; }
      const bad = [];
      if (e.label !== l.label) bad.push('label');
      if (Math.abs(e.time - l.t) > 0.001) bad.push('time ' + e.time + '!=' + l.t);
      if (e.matchSeconds !== l.t) bad.push('matchSeconds ' + e.matchSeconds + '!=' + l.t);
      if (e.officialMinute !== oracleOfficialMinute(l.t, '1H')) bad.push('officialMinute ' + e.officialMinute);
      if (e.second !== l.t % 60) bad.push('second ' + e.second);
      if (e.period !== '1H') bad.push('period ' + e.period);
      if (e.team !== l.team) bad.push('team ' + e.team + '!=' + l.team);
      if ((e.playerId || null) !== (l.playerId || null)) bad.push('playerId ' + e.playerId);
      if ((e.subtype || null) !== (l.subtype || null)) bad.push('subtype ' + e.subtype);
      if ((e.sequenceId || null) !== l.seq) bad.push('seq ' + e.sequenceId);
      if (e.scoreForBefore !== l.scoreBefore[0] || e.scoreAgainstBefore !== l.scoreBefore[1]) bad.push('scoreBefore ' + e.scoreForBefore + '-' + e.scoreAgainstBefore);
      if (l.interval) {
        if (Math.abs(e.startTime - l.interval[0]) > 0.001 || Math.abs(e.endTime - l.interval[1]) > 0.001) bad.push('interval ' + e.startTime + '-' + e.endTime);
        if (e.isInterval !== true) bad.push('isInterval');
      }
      if (l.goalAfter && (e.scoreForAfter !== l.goalAfter[0] || e.scoreAgainstAfter !== l.goalAfter[1])) bad.push('goalAfter ' + e.scoreForAfter + '-' + e.scoreAgainstAfter);
      if (bad.length) details.push('id ' + e.id + ' (' + e.label + '): ' + bad.join(', '));
      return bad.length === 0;
    });
    if (details.length) console.log('  DI-7 mismatches: ' + details.join(' | '));
    ok('DI-7 every event matches the independent oracle (time/matchSeconds/minute/second/period/team/player/subtype/seq/score fields)', perOracle);

    // ---- SCORE / SCORE STATE chain ----
    let sf = 0, sa = 0, chainOk = true;
    evs.slice().sort((a, b) => a.id - b.id).forEach((e) => {
      if (e.scoreForBefore !== sf || e.scoreAgainstBefore !== sa) chainOk = false;
      if (e.label === 'Goal' && e.scoreForAfter != null) {
        if (e.team === 'our') { if (e.scoreForAfter !== sf + 1 || e.scoreAgainstAfter !== sa) chainOk = false; sf = e.scoreForAfter; }
        else { if (e.scoreAgainstAfter !== sa + 1 || e.scoreForAfter !== sf) chainOk = false; sa = e.scoreAgainstAfter; }
      }
    });
    ok('DI-8 goal chain replays consistently in log order', chainOk);
    ok('DI-9 chain final (2-0) === matchClock score === scoreboard', sf === 2 && sa === 0 && P.matchClock.scoreFor === 2 && P.matchClock.scoreAgainst === 0 && scoreboard() === '2 — 0');
    ok('DI-10 score state WINNING matches 2-0', scoreState() === 'WINNING');

    // ---- PLAYER / SEQUENCE / LOCATION / TEAM ----
    const squadIds = new Set(SQUAD.map((p) => p.id));
    ok('DI-11 every player ref resolves to the squad (or null)', evs.every((e) => [e.playerId, e.playerOffId, e.playerOnId].every((r) => r == null || squadIds.has(r))));
    ok('DI-12 sequence events carry SEQ-001, others null', evs.filter((e) => e.label === 'Corner').length >= 1 && evs.filter((e) => e.label === 'Corner')[0].sequenceId === 'SEQ-001' && evs.every((e) => e.sequenceId === null || e.sequenceId === 'SEQ-001'));
    const located = evs.filter((e) => e.location);
    ok('DI-13 two located events, both within [0,1]', located.length === 2 && located.every((e) => e.location.x >= 0 && e.location.x <= 1 && e.location.y >= 0 && e.location.y <= 1));
    ok('DI-14 teams valid; side consistent with team', evs.every((e) => (e.team === 'our' || e.team === 'opponent') && (e.team === 'our' ? e.side === 'for' : e.side === 'against')));
    ok('DI-15 videoTime null throughout (no-video session)', evs.every((e) => e.videoTime === null));

    // ---- CSV export consistency ----
    click(id('btnExportCsv'), { shiftKey: true });
    await sleep(200);
    const fullCsv = B.stub._calls.exportCsv[B.stub._calls.exportCsv.length - 1];
    const lines = fullCsv.split('\n');
    const header = parseCsvLine(lines[0]);
    const Hf = {}; header.forEach((h, i) => { Hf[h] = i; });
    const rows = lines.slice(1).map(parseCsvLine);
    ok('DI-16 full CSV: 8 rows, no Goal rows beyond the 2 remaining, no row for the undone goal',
      rows.length === 8 && rows.filter((r) => r[Hf['Event']] === 'Goal').length === 2, 'rows=' + rows.length);
    const stateByRow = rows.map((r) => [r[Hf['Event']], r[Hf['Score State']], r[Hf['Score For Before']], r[Hf['Score Against Before']], r[Hf['Match Time']], r[Hf['Match Seconds']]].join('|'));
    ok('DI-17 CSV Score State column consistent with each row\'s before-score',
      rows.every((r, i) => {
        const sfb = parseInt(r[Hf['Score For Before']], 10), sab = parseInt(r[Hf['Score Against Before']], 10);
        const expect = sfb > sab ? 'WINNING' : sfb < sab ? 'LOSING' : 'DRAW';
        return r[Hf['Score State']] === expect;
      }), stateByRow.slice(0, 3).join(' ; '));
    const possRow = rows.find((r) => r[Hf['Event']] === 'Possession');
    ok('DI-18 CSV interval row carries real match times (Match Time 340 / Match Seconds 340, not 0)',
      possRow && possRow[Hf['Match Time']] === '340.0' && possRow[Hf['Match Seconds']] === '340', possRow ? possRow[Hf['Match Time']] + '/' + possRow[Hf['Match Seconds']] : 'missing');

    // ---- save -> reload -> audit again (recovered session state) ----
    const Psaved = await saveNow();
    ok('DI-19 saved payload: 8 events, score 2-0', Psaved.events.length === 8 && Psaved.matchClock.scoreFor === 2 && Psaved.matchClock.scoreAgainst === 0);
    B.stub._setLoadSession(clone(Psaved));
    click(id('btnLoadSession'));
    await sleep(300);
    ok('DI-20 reload restores 2 — 0 WINNING and 8 events', scoreboard() === '2 — 0' && scoreState() === 'WINNING' && rowCount() === 8, scoreboard() + ' rows=' + rowCount());
    const Pre = await saveNow();
    ok('DI-21 re-saved payload still consistent (8 events, 2-0, 2 goals)', Pre.events.length === 8 && Pre.matchClock.scoreFor === 2 && Pre.events.filter((e) => e.label === 'Goal').length === 2);
    B.dom.window.close();
  }

  // ---- Report ------------------------------------------------------------
  console.log('\n== RESULTS ==');
  let pass = 0, fail = 0;
  const bySec = {};
  results.forEach((r) => {
    if (r.pass) pass++; else fail++;
    bySec[r.section] = bySec[r.section] || { pass: 0, fail: 0 };
    bySec[r.section][r.pass ? 'pass' : 'fail']++;
  });
  results.forEach((r) => { if (!r.pass) console.log('  FAIL [' + r.section + '] ' + r.name + ' | ' + r.detail); });
  console.log('  ' + pass + ' passed, ' + fail + ' failed, ' + results.length + ' total');
  Object.keys(bySec).forEach((s) => console.log('    ' + s + ': ' + bySec[s].pass + ' passed / ' + bySec[s].fail + ' failed'));
  if (jsdomErrors.length) { console.log('  jsdom errors captured: ' + jsdomErrors.length + ' (first: ' + jsdomErrors[0] + ')'); }
  console.log(fail === 0 ? '\nALL F2/F3 CHECKS PASSED' : '\nFAILURES PRESENT');
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error('F2/F3 CHECK CRASHED:', err);
  process.exit(1);
});
