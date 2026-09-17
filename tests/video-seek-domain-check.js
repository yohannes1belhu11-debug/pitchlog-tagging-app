#!/usr/bin/env node
// PitchLog / MatchTag — F1.2 Video Seeking Domain regression harness
// (VD series).
// =====================================================================
// Verification-only harness. It does NOT modify any app source file.
//
// Verifies the F1.2 fix for the Phase F0 audit finding:
// the DESKTOP event-row click handler used to call
//   seekTo(ev.time)
// where ev.time is the LEGACY ALIAS OF matchTime (the independent match
// clock domain), while seekTo() drives the VIDEO player. Whenever the
// two domains are not aligned (non-zero video sync offset, or tagging
// with the match clock while the video plays independently), clicking
// an event row sent the video to the wrong moment. The touchline
// recent-events list already seeked ev.videoTime; the desktop rows did
// not.
//
// THE FIX: desktop event rows now seek
//   ev.videoTime != null ? ev.videoTime : ev.time
// — the exact video timestamp captured at tag time, falling back to
// ev.time ONLY for events that carry no video time (tagged without a
// usable video — previous behavior preserved for those).
//
// Covered:
//   STATIC   the row-click handler uses the videoTime-first expression;
//            no bare seekTo(ev.time) remains anywhere; the touchline
//            recent-click still seek ev.videoTime; the timeline-strip
//            marker seek, scrub bar and arrow-key seeks are untouched
//            (out of F1.2 scope); buildEventBase still stores videoTime
//            (data model unchanged); the edit/delete click guard of the
//            row handler is preserved.
//   jsdom    three boots with the REAL index.html + integrity.js +
//            analytics.js + player-season.js + renderer.js and a stubbed
//            window.matchtag (same architecture as the other harnesses):
//     BOOT V1  video session + RUNNING match clock (real domain
//              mismatch): instant and interval events carry
//              videoTime != ev.time; clicking a row seeks videoTime,
//              NOT the match-domain time; clicking the edit pencil does
//              NOT seek (opens the detail panel instead).
//     BOOT V2  no-video session (videoTime null): clicking a row falls
//              back to ev.time (previous behavior preserved).
//     BOOT V3  mixed session loaded from a saved file (one event with
//              videoTime, one without): each row seeks its own domain
//              correctly after a load (migration/loader path).
//
// HONEST SCOPE: jsdom does not decode or play media. Video "playback"
// is simulated with settable readyState/currentTime/duration properties
// (the same technique as tests/f2-f3-fix-check.js). The seek assertion
// checks video.currentTime receives the right domain value; real
// decoder-level seeking must be confirmed manually in Electron.
//
// Run:  node tests/video-seek-domain-check.js   (from the project root)
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

// Extract the event-row click handler binding from renderEventList().
function rowClickHandler() {
  const idx = rendererSrc.indexOf("row.addEventListener('click'");
  const end = idx > -1 ? rendererSrc.indexOf('});', idx) : -1;
  return idx > -1 && end > idx ? rendererSrc.slice(idx, end) : '';
}

// ---------------------------------------------------------------------------
// Static source-level checks
// ---------------------------------------------------------------------------
section('STATIC — F1.2 wiring (source-level checks)');
{
  const handler = rowClickHandler();
  ok('VD-S1: event-row click seeks ev.videoTime first with ev.time fallback',
    /seekTo\(ev\.videoTime\s*!=\s*null\s*\?\s*ev\.videoTime\s*:\s*ev\.time\)/.test(handler),
    handler ? 'handler found' : 'row click handler not found');

  ok('VD-S2: no bare seekTo(ev.time) remains anywhere in renderer.js',
    !/seekTo\(ev\.time\)/.test(rendererSrc));

  // The edit/delete guard must still be the first statement of the handler.
  ok('VD-S3: row click still ignores clicks on the edit/delete buttons (guard first)',
    /if \(e\.target\.classList\.contains\('event-delete'\) \|\| e\.target\.classList\.contains\('event-edit'\)\) return;/.test(handler));

  ok('VD-S4: touchline recent-events click still seeks ev.videoTime (unchanged)',
    /ev\.videoTime\s*!==\s*null\)\s*seekTo\(ev\.videoTime\)/.test(rendererSrc));

  // Out-of-scope seeks must be untouched: timeline markers use their own
  // dataset.time (marker position == seek target — self-consistent), the
  // scrub bar and arrow keys operate on the video clock directly.
  ok('VD-S5: timeline-strip marker seek unchanged (seeks its own dataset.time)',
    /seekTo\(parseFloat\(el\.dataset\.time\)\)/.test(rendererSrc));
  ok('VD-S6: arrow-key seek unchanged (video-clock domain via getCurrentTime)',
    /seekTo\(Math\.min\(max, Math\.max\(0, getCurrentTime\(\) \+ dir \* step\)\)\)/.test(rendererSrc));

  ok('VD-S7: buildEventBase still stores videoTime (event data model unchanged)',
    /videoTime: ts\.videoTime/.test(rendererSrc));
  ok('VD-S8: buildEventTimestamps still nulls videoTime when no usable video',
    /const videoTime = videoLoaded \? getCurrentTime\(\) : null;/.test(rendererSrc));
}

// ---------------------------------------------------------------------------
// jsdom boots
// ---------------------------------------------------------------------------
function makeStub(initial) {
  const calls = { saveSession: [], autosaveWrite: [], saveSquad: [] };
  let loadSessionData = null;
  const stub = {
    openVideo: async () => null,
    saveSession: async (d) => { calls.saveSession.push(clone(d)); return { canceled: false, filePath: '/tmp/vd-session.json' }; },
    exportCsv: async () => ({ canceled: true }),
    exportClipPlaylist: async () => ({ canceled: true }),
    loadSession: async () => { return clone(loadSessionData); },
    loadMultipleSessions: async () => [],
    loadSquad: async () => clone(initial.squad || []),
    saveSquad: async (s) => { calls.saveSquad.push(clone(s)); return true; },
    detachVideo: async () => true,
    reattachVideo: async () => true,
    sendVideoCommand: () => {},
    onVideoState: () => {},
    onVideoClosed: () => {},
    autosaveRead: async () => null,
    autosaveWrite: async (d) => { calls.autosaveWrite.push(clone(d)); return { ok: true, path: '/tmp/autosave.json' }; },
    autosaveDelete: async () => ({ ok: true }),
    autosaveFlushSync: () => {},
    onCloseRequested: () => {},
    onAutosaveFlushRequested: () => {}, // R2-C-4: power-flush bridge (not exercised here)
    closeProceed: () => {},
    _setLoadSession: (d) => { loadSessionData = d; },
    _calls: calls
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

function click(el) { el.dispatchEvent(new el.ownerDocument.defaultView.MouseEvent('click', { bubbles: true, cancelable: true })); }
function desktopTagBtn(doc, label) {
  return Array.from(doc.querySelectorAll('#tagButtons .tag-btn')).find((b) => b.textContent.replace(/⏱/g, '').trim().indexOf(label) === 0) || null;
}
function eventRows(doc) { return Array.from(doc.querySelectorAll('#eventList .event-row')); }
function rowByLabel(doc, label) { return eventRows(doc).find((r) => r.textContent.indexOf(label) > -1) || null; }

// Simulate a loaded, seekable video in jsdom (same technique as
// tests/f2-f3-fix-check.js F2-2).
function simulateLoadedVideo(doc, currentTime, duration) {
  const video = doc.getElementById('video');
  Object.defineProperty(video, 'readyState', { value: 4, configurable: true });
  Object.defineProperty(video, 'currentTime', { value: currentTime, configurable: true, writable: true });
  Object.defineProperty(video, 'duration', { value: duration, configurable: true, writable: true });
  return video;
}

const SQUAD = [
  { id: 'player_1', number: '1', name: 'Ana One' },
  { id: 'player_2', number: '2', name: 'Ben Two' }
];

(async () => {
  // =====================================================================
  section('BOOT V1 — video session + running match clock: rows seek the VIDEO domain');
  // =====================================================================
  {
    const V = boot({ squad: SQUAD });
    const doc = V.doc;
    const videoSession = {
      __schemaVersion: 3,
      videoPath: '/tmp/match.mp4', videoUrl: 'file:///tmp/match.mp4',
      tags: [], events: [], squad: SQUAD,
      matchInfo: { opponent: 'Video FC' },
      matchClock: { clockStartedAt: null, clockBaseSeconds: 4040, clockRunning: false, period: '2H',
        scoreFor: 1, scoreAgainst: 0, videoSyncOffset: 0, selectedTeam: 'our', selectedPlayerId: null,
        activeSequenceId: null, nextSequenceNumber: 1 }
    };
    V.stub._setLoadSession(videoSession);
    await sleep(250);
    click(doc.getElementById('btnLoadSession'));
    await sleep(350); // load restores the video path and stops the clock (base 4040)

    // Simulate the loaded video at 100.5s while the MATCH clock base is
    // 4040s — the two domains genuinely disagree.
    const video = simulateLoadedVideo(doc, 100.5, 5000);

    // Start the match clock so tagging records MATCH time != VIDEO time
    // (realistic matchday flow: match clock running, video independent).
    click(doc.getElementById('btnClockStart'));
    await sleep(60);

    // --- instant event ---
    click(desktopTagBtn(doc, 'Shot'));
    await sleep(60);
    click(doc.getElementById('detailPanelDone'));
    await sleep(30);

    // --- interval event (Possession): START at video 100.5, advance, FINISH ---
    video.currentTime = 130.25;
    click(desktopTagBtn(doc, 'Possession'));
    await sleep(60);
    video.currentTime = 205.75;
    click(desktopTagBtn(doc, 'Possession'));
    await sleep(60);
    click(doc.getElementById('detailPanelDone'));
    await sleep(30);

    const rows = eventRows(doc);
    ok('VD1: two events on the list (Shot + Possession interval)', rows.length === 2, 'rows=' + rows.length);

    // Sanity: the fixture genuinely produces a domain mismatch (otherwise
    // the assertions below prove nothing). Row time text shows match-domain
    // timecodes; we verify via the seek behavior itself.
    const shotRow = rowByLabel(doc, 'Shot');
    ok('VD2: Shot row exists', !!shotRow);

    // --- THE FIX: clicking the Shot row seeks videoTime (100.5), not
    //     matchTime (~4040+) ---
    video.currentTime = 999;
    click(shotRow);
    await sleep(30);
    ok('VD3: Shot row click seeks the VIDEO timestamp (100.5), not match time',
      Math.abs(video.currentTime - 100.5) < 0.001,
      'video.currentTime=' + video.currentTime);
    ok('VD4: the seek did NOT land on the match-domain value (~4040+)',
      video.currentTime < 1000, 'video.currentTime=' + video.currentTime);

    // --- interval event: videoTime (finish moment, video domain) ---
    const possRow = rowByLabel(doc, 'Possession');
    ok('VD5: Possession row exists', !!possRow);
    video.currentTime = 999;
    click(possRow);
    await sleep(30);
    ok('VD6: interval row click seeks the event videoTime (205.75, video domain)',
      Math.abs(video.currentTime - 205.75) < 0.001,
      'video.currentTime=' + video.currentTime);

    // --- edit pencil: opens detail panel, must NOT seek ---
    video.currentTime = 999;
    const editBtn = shotRow.querySelector('.event-edit');
    click(editBtn);
    await sleep(30);
    const panel = doc.getElementById('detailPanel');
    ok('VD7: edit button still opens the detail panel without seeking',
      panel.style.display === 'block' && video.currentTime === 999,
      'panel=' + panel.style.display + ' video.currentTime=' + video.currentTime);
    click(doc.getElementById('detailPanelDone'));
    await sleep(30);

    // --- delete button: removes the event, no seek, no crash ---
    video.currentTime = 999;
    const delBtn = shotRow.querySelector('.event-delete');
    click(delBtn);
    await sleep(30);
    ok('VD8: delete button still removes the event without seeking',
      eventRows(doc).length === 1 && video.currentTime === 999,
      'rows=' + eventRows(doc).length + ' video.currentTime=' + video.currentTime);

    V.dom.window.close();
  }

  // =====================================================================
  section('BOOT V2 — no video (videoTime null): rows keep the ev.time fallback');
  // =====================================================================
  {
    const V = boot({ squad: SQUAD });
    const doc = V.doc;
    await sleep(300);

    const noVideoSession = {
      __schemaVersion: 3,
      videoPath: null, videoUrl: null,
      tags: [], events: [], squad: SQUAD,
      matchInfo: { opponent: 'No Video FC' },
      matchClock: { clockStartedAt: null, clockBaseSeconds: 777, clockRunning: false, period: '1H',
        scoreFor: 0, scoreAgainst: 0, videoSyncOffset: 0, selectedTeam: 'our', selectedPlayerId: null,
        activeSequenceId: null, nextSequenceNumber: 1 }
    };
    V.stub._setLoadSession(noVideoSession);
    click(doc.getElementById('btnLoadSession'));
    await sleep(350);

    // No video path → videoTime stays null; stopped clock base 777 is the
    // match time. Simulate a writable currentTime anyway so the fallback
    // seek (if any) is observable.
    const video = simulateLoadedVideo(doc, 999, 5000);

    click(desktopTagBtn(doc, 'Shot'));
    await sleep(60);
    click(doc.getElementById('detailPanelDone'));
    await sleep(30);

    const shotRow = rowByLabel(doc, 'Shot');
    ok('VD9: no-video Shot row exists', !!shotRow);

    click(shotRow);
    await sleep(30);
    ok('VD10: videoTime-null event falls back to ev.time (777, previous behavior)',
      Math.abs(video.currentTime - 777) < 0.001,
      'video.currentTime=' + video.currentTime);

    V.dom.window.close();
  }

  // =====================================================================
  section('BOOT V3 — mixed loaded session: each row seeks its own domain');
  // =====================================================================
  {
    const V = boot({ squad: SQUAD });
    const doc = V.doc;
    await sleep(300);

    function loadedEvent(id, label, time, videoTime) {
      return {
        id, label, team: 'our', side: 'for', playerId: null,
        playerOffId: null, playerOnId: null, subtype: null, qualifiers: {},
        location: null, isInterval: false,
        time, videoTime, matchTime: time, matchSeconds: Math.floor(time),
        officialMinute: Math.ceil(time / 60), second: Math.floor(time) % 60,
        period: '1H', scoreForBefore: 0, scoreAgainstBefore: 0, sequenceId: null
      };
    }

    const mixedSession = {
      __schemaVersion: 3,
      videoPath: '/tmp/mixed.mp4', videoUrl: 'file:///tmp/mixed.mp4',
      tags: [], events: [
        loadedEvent(1, 'Shot', 4040, 100.5),   // video-tagged: videoTime wins
        loadedEvent(2, 'Foul', 777, null)      // no-video: fallback to ev.time
      ],
      squad: SQUAD,
      matchInfo: { opponent: 'Mixed FC' },
      matchClock: { clockStartedAt: null, clockBaseSeconds: 0, clockRunning: false, period: '1H',
        scoreFor: 0, scoreAgainst: 0, videoSyncOffset: 0, selectedTeam: 'our', selectedPlayerId: null,
        activeSequenceId: null, nextSequenceNumber: 1 }
    };
    V.stub._setLoadSession(mixedSession);
    click(doc.getElementById('btnLoadSession'));
    await sleep(350);

    const video = simulateLoadedVideo(doc, 999, 5000);

    const shotRow = rowByLabel(doc, 'Shot');
    const foulRow = rowByLabel(doc, 'Foul');
    ok('VD11: mixed session rendered both rows', !!shotRow && !!foulRow,
      'shot=' + !!shotRow + ' foul=' + !!foulRow);

    video.currentTime = 999;
    click(shotRow);
    await sleep(30);
    ok('VD12: loaded video-tagged event (videoTime 100.5) seeks 100.5',
      Math.abs(video.currentTime - 100.5) < 0.001, 'video.currentTime=' + video.currentTime);

    video.currentTime = 999;
    click(foulRow);
    await sleep(30);
    ok('VD13: loaded no-video event (videoTime null) falls back to ev.time (777)',
      Math.abs(video.currentTime - 777) < 0.001, 'video.currentTime=' + video.currentTime);

    V.dom.window.close();
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
  console.log('---- video seek domain check: ' + pass + ' passed, ' + fail + ' failed ----');
  console.log('NOTE: jsdom does not decode media. Video state is simulated with');
  console.log('settable readyState/currentTime/duration properties (same technique');
  console.log('as f2-f3-fix-check). Real decoder-level seeking in Electron still');
  console.log('requires manual verification.');
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('HARNESS CRASH:', err && err.stack ? err.stack : err);
  process.exit(1);
});
