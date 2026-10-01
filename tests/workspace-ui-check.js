#!/usr/bin/env node
// PitchLog / MatchTag — Stage 3 workspace redesign verification harness
// (WS series) — F1 hideable top bar, F2 timeline removal, F3 single-team
// focus, F4 video/tag splitter, F5 pitch dock, F6 pitch resizing +
// normalized coordinates, F7 responsive structure, plus the workspace
// state / match-data persistence boundary.
// =====================================================================
// Verification-only harness. It does NOT modify any app source file.
//
// Structure:
//   WS-A  static structure: Stage 3 DOM present, timeline DOM absent,
//         reserved shortcut, splitter/dock aria + CSS rules
//   WS-B  F1 top bar: default visible, hide control, restore control,
//         Ctrl+Shift+B toggle, input guard, released vertical space (CSS)
//   WS-L  F2 timeline removal: no stale code/DOM; preserved seeking
//         (event-row click seeks the video domain)
//   WS-T  F3 single-team focus: team-aware player list, stale cross-team
//         selection cleared on the DESKTOP path, opponent players resolve
//         through the Stage 2 roster model, Touchline retention preserved
//   WS-S  F4 splitter: pointer drag, keyboard, min/max clamps,
//         window-resize re-clamp, aria-valuenow
//   WS-P  F5/F6 pitch dock: sync with detail/latest located event,
//         click-to-locate, resize clamp, coordinate invariance across
//         sizes, letterbox-aware mapping
//   WS-R  F7 responsive: media queries + shell rules that keep the
//         workspace structurally sound at 1920x1080 / 1600x900 / 1366x768
//   WS-D  persistence boundary: workspace UI state NEVER enters the
//         autosave/session payload
//   H     hygiene: no jsdom errors during any boot
//
// HONEST SCOPE: jsdom does not compute CSS layout or paint. Real visual
// verification at the three target resolutions is performed separately in
// Electron (post-commit QA); this harness pins structure, state flow,
// wiring, clamping math and coordinate math.
//
// Run:  node tests/workspace-ui-check.js   (from the project root)
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
const css = fs.readFileSync(path.join(srcDir, 'styles.css'), 'utf-8');
const integritySrc = fs.readFileSync(path.join(srcDir, 'integrity.js'), 'utf-8');
const rosterSrc = fs.readFileSync(path.join(srcDir, 'roster.js'), 'utf-8');
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
  const calls = { saveSession: [], autosaveWrite: [], autosaveFlushSync: [], saveSquad: [], exportCsv: [], autosaveDelete: 0 };
  let loadSessionData = null;
  const stub = {
    openVideo: async () => null,
    saveSession: async (d) => { calls.saveSession.push(clone(d)); return { canceled: false, filePath: '/tmp/ws-session.json' }; },
    exportCsv: async (csv) => { calls.exportCsv.push(String(csv)); return { canceled: false, filePath: '/tmp/ws-export.csv' }; },
    exportClipPlaylist: async () => ({ canceled: true }),
    loadSession: async () => clone(loadSessionData),
    loadMultipleSessions: async () => [],
    loadSquad: async () => clone(initial.squad || []),
    saveSquad: async () => true,
    detachVideo: async () => true,
    reattachVideo: async () => true,
    sendVideoCommand: () => {},
    onVideoState: () => {},
    onVideoClosed: () => {},
    autosaveRead: async () => clone(initial.autosave || null),
    autosaveWrite: async (d) => { calls.autosaveWrite.push(clone(d)); return { ok: true, path: '/tmp/autosave.json' }; },
    autosaveDelete: async () => { calls.autosaveDelete++; return { ok: true }; },
    autosaveFlushSync: (d) => { calls.autosaveFlushSync.push(clone(d)); return { ok: true }; },
    onCloseRequested: () => {},
    onAutosaveFlushRequested: () => {},
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
  win.Date.now = () => fakeNow;
  const RECT = { left: 0, top: 0, right: 700, bottom: 450, width: 700, height: 450, x: 0, y: 0 };
  if (win.SVGElement) win.SVGElement.prototype.getBoundingClientRect = function () { return { ...RECT }; };
  else win.Element.prototype.getBoundingClientRect = function () { return { ...RECT }; };
  const stub = makeStub(initial);
  win.matchtag = stub;
  win.eval(integritySrc);
  win.eval(rosterSrc);
  win.eval(rendererSrc);
  return { dom, win, doc: win.document, stub };
}

let fakeNow = Date.now();
let B = null;

const SQUAD = [
  { id: 'player_1', number: '9', name: 'Getachew Mulu' },
  { id: 'player_2', number: '8', name: 'Fitsum Girma' },
  { id: 'player_3', number: '4', name: 'Yohannes Haile' }
];

// Matchday roster with DISPLAY NAMES THAT DIFFER from the squad entries,
// so the overlay (roster-first) is provably in effect.
const ROSTER = {
  our: [
    { playerId: 'player_1', displayName: 'Getachew Matchday', shirtNumber: '9', position: 'ST', role: '', status: 'starter' },
    { playerId: 'player_2', displayName: 'Fitsum Matchday', shirtNumber: '8', position: 'CM', role: '', status: 'bench' }
  ],
  opponent: [
    { playerId: 'match_opp_1', displayName: 'Rival Winger', shirtNumber: '7', position: 'RW', role: '', status: 'starter' },
    { playerId: 'match_opp_2', displayName: 'Rival Keeper', shirtNumber: '1', position: 'GK', role: '', status: 'starter' }
  ]
};

(async () => {
  function click(el, opts) { el.dispatchEvent(new B.win.MouseEvent('click', Object.assign({ bubbles: true, cancelable: true }, opts || {}))); }
  function change(el) { el.dispatchEvent(new B.win.Event('change', { bubbles: true })); }
  function keydown(target, opts) { target.dispatchEvent(new B.win.KeyboardEvent('keydown', Object.assign({ bubbles: true, cancelable: true }, opts || {}))); }
  function id(x) { return B.doc.getElementById(x); }
  function txt(x) { const e = id(x); return e ? e.textContent : null; }
  function tagBtn(label) {
    return Array.from(B.doc.querySelectorAll('#tagButtons .tag-btn')).find((b) => b.textContent.replace('⏱', '').trim().startsWith(label));
  }
  function selectPlayerViaDom(pid) { const sel = id('selectedPlayerSelect'); sel.value = pid; change(sel); }
  function selectTeamViaDom(team) { click(team === 'our' ? id('btnTeamOur') : id('btnTeamOpponent')); }
  function detailDone() { const b = id('detailPanelDone'); if (b) click(b); }
  function definePx(el, prop, value) {
    Object.defineProperty(el, prop, { get: () => value, configurable: true });
  }
  function dockMarker() {
    const m = id('pitchDockSvg').innerHTML.match(/class="pitch-marker" cx="(-?[0-9.]+)" cy="(-?[0-9.]+)"/);
    return m ? { x: parseFloat(m[1]) / 700, y: parseFloat(m[2]) / 450 } : null;
  }

  // =====================================================================
  section('WS-A — static structure (Stage 3 DOM + CSS + reserved shortcut)');
  // =====================================================================
  {
    ok('WS-A1: top bar header exists with id=topbar (hideable target)',
      /<header[^>]*id="topbar"/.test(html));
    ok('WS-A2: hide + restore controls both exist',
      /id="btnHideTopbar"/.test(html) && /id="btnShowTopbar"/.test(html));
    ok('WS-A3: restore control lives OUTSIDE the topbar header (can never be hidden with it)',
      (() => {
        const header = html.match(/<header[^>]*id="topbar"[\s\S]*?<\/header>/);
        const restore = html.match(/id="btnShowTopbar"/);
        return !!header && !!restore && restore.index > header.index + header[0].length;
      })());
    ok('WS-A4: timeline strip DOM fully removed from index.html',
      !/id="timelineStrip"|timeline-strip-wrapper|class="timeline-strip/.test(html));
    ok('WS-A5: splitter element present with separator role, aria and tabindex',
      /id="videoTagSplitter"[^>]*role="separator"/.test(html) && /aria-orientation="horizontal"/.test(html) && /tabindex="0"/.test(html));
    ok('WS-A6: splitter sits between the transport bar and the tag panel',
      (() => {
        const t = html.search(/class="transport"/);
        const s = html.search(/id="videoTagSplitter"/);
        const p = html.search(/class="tagpanel"/);
        return t > -1 && s > t && p > s;
      })());
    ok('WS-A7: pitch dock present with svg (viewBox 700x450) + readout + grip',
      /id="pitchDock"/.test(html) && /id="pitchDockSvg"[^>]*viewBox="0 0 700 450"/.test(html) && /id="pitchDockReadout"/.test(html) && /id="pitchDockGrip"[^>]*role="separator"/.test(html));
    ok('WS-A8: pitch dock is inside .video-frame (never covers transport or tag controls)',
      (() => {
        const vf = html.match(/class="video-frame"[\s\S]*?\n      <\/div>/);
        return !!vf && /id="pitchDock"/.test(vf[0]);
      })());
    ok('WS-A9: Ctrl+Shift+B is a RESERVED shortcut identity (cannot be claimed by any tag)',
      /reserveShortcut\('b', \['ctrl', 'shift'\]/.test(rendererSrc));
    ok('WS-A10: CSS hides the topbar under body.topbar-hidden and shows the restore strip',
      /body\.topbar-hidden #topbar\s*\{\s*display:\s*none;?\s*\}/.test(css) &&
      /body\.topbar-hidden \.topbar-restore\s*\{\s*display:\s*flex;?\s*\}/.test(css));
    ok('WS-A11: splitter is fixed chrome (flex-shrink: 0) with a row-resize cursor',
      /\.workspace-splitter\s*\{[^}]*cursor:\s*row-resize/s.test(css) &&
      /\.workspace-splitter[\s\S]{0,300}flex-shrink:\s*0/.test(css));
    ok('WS-A12: pitch dock CSS anchors it absolute lower-right of the video frame',
      /\.pitch-dock\s*\{[^}]*position:\s*absolute;[^}]*right:\s*12px;[^}]*bottom:\s*12px;/s.test(css));
    ok('WS-A13: pitch dock sits BELOW the detail panel in stacking order (z-index 10 < 20)',
      /\.pitch-dock\s*\{[^}]*z-index:\s*10;/s.test(css) && /\.detail-panel\s*\{[^}]*z-index:\s*20;/s.test(css));
    ok('WS-A14: pitch dock svg preserves aspect via width 100% + height auto (viewBox governs)',
      /\.pitch-dock-svg\s*\{[^}]*width:\s*100%;[^}]*height:\s*auto;/s.test(css));
    ok('WS-A15: responsive media queries exist for the workspace (F7)',
      /@media \(max-width: 1500px\)/.test(css) && /@media \(max-width: 1200px\)/.test(css) && /@media \(max-height: 740px\)/.test(css));
    ok('WS-A16: renderer keeps ONE shared pitch click mapping (pitchPointFromClick) used by BOTH surfaces',
      (rendererSrc.match(/function pitchPointFromClick\(/g) || []).length === 1 &&
      /pitchPointFromClick\(pitchSvg, e\.clientX, e\.clientY\)/.test(rendererSrc) &&
      /pitchPointFromClick\(pitchDockSvgEl, e\.clientX, e\.clientY\)/.test(rendererSrc));
    ok('WS-A17: no timeline rendering/refs remain in renderer source (no stale listeners)',
      !/renderTimelineStrip|updateTimelinePlayhead|timelineStrip|timelineMarkersEl|timelinePlayheadEl/.test(rendererSrc));
    ok('WS-A18: timeline CSS fully removed (no dead .timeline-* rules)',
      !/\.timeline-strip-wrapper|\.timeline-strip\s*\{|\.timeline-mark\s*\{|\.timeline-playhead\s*\{/.test(css));
  }

  // =====================================================================
  section('WS-B — F1 hideable top bar (behavior)');
  // =====================================================================
  {
    B = boot({ squad: SQUAD });
    await sleep(250);

    ok('WS-B1: top bar visible by default (no body.topbar-hidden, header present)',
      !B.doc.body.classList.contains('topbar-hidden') && !!id('topbar'));
    click(id('btnHideTopbar'));
    ok('WS-B2: hide button sets body.topbar-hidden; hide aria-expanded false',
      B.doc.body.classList.contains('topbar-hidden') && id('btnHideTopbar').getAttribute('aria-expanded') === 'false');
    ok('WS-B3: restore control state follows the controlled region (aria-expanded false while bar hidden)',
      id('btnShowTopbar').getAttribute('aria-expanded') === 'false');
    click(id('btnShowTopbar'));
    ok('WS-B4: restore button brings the bar back (class cleared, aria states restored)',
      !B.doc.body.classList.contains('topbar-hidden') && id('btnHideTopbar').getAttribute('aria-expanded') === 'true');
    keydown(B.win, { key: 'b', code: 'KeyB', ctrlKey: true, shiftKey: true });
    ok('WS-B5: Ctrl+Shift+B hides the bar',
      B.doc.body.classList.contains('topbar-hidden'));
    keydown(B.win, { key: 'B', code: 'KeyB', ctrlKey: true, shiftKey: true });
    ok('WS-B6: Ctrl+Shift+B toggles back (restore works via shortcut)',
      !B.doc.body.classList.contains('topbar-hidden'));
    keydown(id('videoOffsetInput'), { key: 'b', code: 'KeyB', ctrlKey: true, shiftKey: true });
    ok('WS-B7: input guard — Ctrl+Shift+B typed in a text input does NOT toggle',
      !B.doc.body.classList.contains('topbar-hidden'));
    keydown(B.win, { key: 'B', code: 'KeyB', shiftKey: true });
    ok('WS-B8: plain Shift+B (no Ctrl) does not toggle the bar',
      !B.doc.body.classList.contains('topbar-hidden'));
    click(id('btnHideTopbar'));
    click(id('btnShowTopbar'));
    keydown(B.win, { key: 'b', code: 'KeyB', ctrlKey: true, shiftKey: true });
    keydown(B.win, { key: 'b', code: 'KeyB', ctrlKey: true, shiftKey: true });
    ok('WS-B9: hiding/restoring never marks the session dirty (workspace state is not data)',
      B.stub._calls.autosaveWrite.length === 0 && B.stub._calls.autosaveFlushSync.length === 0,
      'writes=' + B.stub._calls.autosaveWrite.length + ' flushes=' + B.stub._calls.autosaveFlushSync.length);
    B.dom.window.close();
  }

  // =====================================================================
  section('WS-L — F2 timeline removal with preserved seeking');
  // =====================================================================
  {
    B = boot({ squad: SQUAD });
    B.stub._setLoadSession({
      __schemaVersion: 4,
      videoPath: '/tmp/match.mp4', videoUrl: 'file:///tmp/match.mp4',
      tags: [], events: [], squad: SQUAD,
      matchInfo: { opponent: 'Video FC' },
      matchClock: { clockStartedAt: null, clockBaseSeconds: 4040, clockRunning: false, period: '2H',
        scoreFor: 1, scoreAgainst: 0, videoSyncOffset: 0, selectedTeam: 'our', selectedPlayerId: null,
        activeSequenceId: null, nextSequenceNumber: 1 },
      matchRoster: { our: [], opponent: [] }
    });
    await sleep(250);
    click(id('btnLoadSession'));
    await sleep(350);
    const video = id('video');
    Object.defineProperty(video, 'readyState', { value: 4, configurable: true });
    Object.defineProperty(video, 'duration', { value: 5000, configurable: true });
    Object.defineProperty(video, 'currentTime', { value: 100.5, configurable: true, writable: true });

    ok('WS-L1: no timeline strip node exists in the live DOM',
      !id('timelineStrip') && !B.doc.querySelector('.timeline-strip-wrapper'));
    ok('WS-L2: scrub bar and arrow-key seek surfaces still present',
      !!id('scrub') && /ArrowLeft/.test(rendererSrc));

    click(tagBtn('Pass'));
    detailDone();
    const rows = B.doc.querySelectorAll('#eventList .event-row');
    ok('WS-L3: event row rendered after tagging (model intact without the strip)',
      rows.length === 1);
    // Move the playhead away from the event's videoTime, then click the
    // row — it must seek BACK to the event's captured video timestamp.
    video.currentTime = 900;
    click(rows[0]);
    ok('WS-L4: clicking the event row still seeks the video to the event videoTime (seeking preserved)',
      Math.abs(video.currentTime - 100.5) < 0.01, 'currentTime=' + video.currentTime);
    B.dom.window.close();
  }

  // =====================================================================
  section('WS-T — F3 single-team focus (behavior)');
  // =====================================================================
  {
    B = boot({ squad: SQUAD });
    await sleep(250);
    // Build the matchday roster through the sanctioned programmatic path.
    B.win.matchRosterApi.setRoster(ROSTER);
    // Team switches refresh the team-aware list.
    selectTeamViaDom('opponent');
    selectTeamViaDom('our');

    ok('WS-T1: our list = roster overlay first (matchday names win), then squad-only players',
      (() => {
        const opts = Array.from(id('selectedPlayerSelect').options);
        return opts.length === 4 &&
          opts[0].value === '' &&
          opts[1].value === 'player_1' && opts[1].textContent === '9 Getachew Matchday' &&
          opts[2].value === 'player_2' && opts[2].textContent === '8 Fitsum Matchday' &&
          opts[3].value === 'player_3' && opts[3].textContent === '4 Yohannes Haile';
      })(), Array.from(id('selectedPlayerSelect').options).map((o) => o.textContent).join('|'));

    selectPlayerViaDom('player_1');
    ok('WS-T2: our-team player selectable while team is "our"',
      id('selectedPlayerSelect').value === 'player_1');

    selectTeamViaDom('opponent');
    ok('WS-T3: switching to opponent CLEARS the stale our-team player (desktop path)',
      id('selectedPlayerSelect').value === '');
    ok('WS-T3b: opponent list shows ONLY match_opp_* roster players (Stage 2 model)',
      (() => {
        const vals = Array.from(id('selectedPlayerSelect').options).map((o) => o.value).filter(Boolean);
        return vals.length === 2 && vals.every((v) => /^match_opp_\d+$/.test(v));
      })(), Array.from(id('selectedPlayerSelect').options).map((o) => o.value).join('|'));

    selectPlayerViaDom('match_opp_1');
    click(tagBtn('Foul'));
    const lastRow = Array.from(B.doc.querySelectorAll('#eventList .event-row')).pop();
    ok('WS-T4: opponent event tagged with the opponent player — identifiable via team/side row class',
      !!lastRow && /event-row-against/.test(lastRow.className),
      'class=' + (lastRow && lastRow.className));
    detailDone();

    ok('WS-T5: opponent player resolves through matchRosterApi (Stage 2 resolver)',
      (() => {
        const r = B.win.matchRosterApi.resolve('match_opp_1');
        return !!r && r.displayName === 'Rival Winger';
      })());

    selectTeamViaDom('our');
    ok('WS-T6: switching back to "our" clears the stale opponent player (desktop path)',
      id('selectedPlayerSelect').value === '');
    ok('WS-T6b: our list restored (roster + squad, no match_opp ids)',
      (() => {
        const vals = Array.from(id('selectedPlayerSelect').options).map((o) => o.value);
        return vals.includes('player_1') && !vals.some((v) => /^match_opp_/.test(v));
      })());

    // Touchline preservation: the touchline buttons keep the player.
    selectPlayerViaDom('player_2');
    click(id('btnTouchlineToggle'));
    click(id('tlBtnTeamOpp'));
    ok('WS-T7: TOUCHLINE team flip RETAINS the player selection (pinned pre-Stage-3 semantics)',
      B.doc.getElementById('tlPlayerSelect').value === 'player_2',
      'tlValue=' + B.doc.getElementById('tlPlayerSelect').value);
    ok('WS-T7b: touchline flip still drives the shared team state',
      id('tlBtnTeamOpp').classList.contains('active') && !id('tlBtnTeamOur').classList.contains('active'));
    click(id('btnExitTouchline'));
    B.dom.window.close();
  }

  // =====================================================================
  section('WS-S — F4 splitter (drag, keyboard, clamps, resize)');
  // =====================================================================
  {
    B = boot({ squad: SQUAD });
    await sleep(250);
    const splitter = id('videoTagSplitter');
    const pane = B.doc.querySelector('.video-pane');
    const transport = B.doc.querySelector('.video-pane .transport');
    const tagpanel = B.doc.querySelector('.video-pane .tagpanel');

    // jsdom has no layout: stub the geometry the clamps read.
    definePx(pane, 'clientHeight', 700);
    definePx(transport, 'offsetHeight', 50);
    definePx(splitter, 'offsetHeight', 10);

    ok('WS-S1: splitter starts with no forced tag height (natural layout)',
      !tagpanel.style.height);

    // Pointer drag: down at y=400, move to y=300 (100px up => tag area +100).
    // jsdom initial tagpanel height (no layout) falls back to the 150px floor.
    splitter.dispatchEvent(new B.win.MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientY: 400 }));
    B.win.dispatchEvent(new B.win.MouseEvent('pointermove', { bubbles: true, cancelable: true, clientY: 300 }));
    B.win.dispatchEvent(new B.win.MouseEvent('pointerup', { bubbles: true, cancelable: true }));
    ok('WS-S2: pointer drag grows the tag area (explicit height applied)',
      tagpanel.style.height === '250px', 'height=' + tagpanel.style.height);

    // Clamp: drag far beyond the maximum (max = 700-50-10-200 = 440).
    splitter.dispatchEvent(new B.win.MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientY: 400 }));
    B.win.dispatchEvent(new B.win.MouseEvent('pointermove', { bubbles: true, cancelable: true, clientY: -5000 }));
    B.win.dispatchEvent(new B.win.MouseEvent('pointerup', { bubbles: true, cancelable: true }));
    ok('WS-S3: dragging past the maximum clamps (video never becomes unusable)',
      tagpanel.style.height === '440px', 'height=' + tagpanel.style.height);

    splitter.dispatchEvent(new B.win.MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientY: 400 }));
    B.win.dispatchEvent(new B.win.MouseEvent('pointermove', { bubbles: true, cancelable: true, clientY: 9000 }));
    B.win.dispatchEvent(new B.win.MouseEvent('pointerup', { bubbles: true, cancelable: true }));
    ok('WS-S4: dragging past the minimum clamps (tag area never becomes unusable)',
      tagpanel.style.height === '150px', 'height=' + tagpanel.style.height);

    keydown(splitter, { key: 'ArrowUp' });
    ok('WS-S5: ArrowUp grows the tag area by the default step',
      tagpanel.style.height === '174px', 'height=' + tagpanel.style.height);
    keydown(splitter, { key: 'ArrowDown', shiftKey: true });
    ok('WS-S6: Shift+ArrowDown shrinks it by the large step (clamped at min)',
      tagpanel.style.height === '150px', 'height=' + tagpanel.style.height);
    keydown(splitter, { key: 'End' });
    ok('WS-S7: End jumps to the maximum tag share',
      tagpanel.style.height === '440px', 'height=' + tagpanel.style.height);
    keydown(splitter, { key: 'Home' });
    ok('WS-S8: Home jumps to the minimum tag share',
      tagpanel.style.height === '150px', 'height=' + tagpanel.style.height);

    keydown(splitter, { key: 'ArrowUp' });
    ok('WS-S9: aria-valuenow reflects the tag-area share of the pane (174/700 -> 25%)',
      splitter.getAttribute('aria-valuenow') === '25', 'valuenow=' + splitter.getAttribute('aria-valuenow'));

    // Window resize re-clamps: shrink the pane to 440 => max = 440-50-10-200 = 180.
    keydown(splitter, { key: 'End' }); // back to 440
    definePx(pane, 'clientHeight', 440);
    B.win.dispatchEvent(new B.win.Event('resize'));
    ok('WS-S10: window resize re-clamps the stored height (no unusable regions after shrink)',
      tagpanel.style.height === '180px', 'height=' + tagpanel.style.height);

    ok('WS-S11: splitter interactions never touch the autosave (workspace state is not data)',
      B.stub._calls.autosaveWrite.length === 0 && B.stub._calls.autosaveFlushSync.length === 0);
    B.dom.window.close();
  }

  // =====================================================================
  section('WS-P — F5/F6 pitch dock (sync, click-to-locate, resize, coordinates)');
  // =====================================================================
  {
    B = boot({ squad: SQUAD });
    await sleep(250);
    const dock = id('pitchDock');
    const dockSvg = id('pitchDockSvg');
    const grip = id('pitchDockGrip');
    const frame = B.doc.querySelector('.video-frame');

    ok('WS-P1: dock boots rendered with markings and the no-location readout',
      dockSvg.innerHTML.includes('pitch-outline') && txt('pitchDockReadout') === 'No location set');

    // Tag an event, then set its location through the DETAIL pitch — the
    // dock must sync to that event (latest + detail subject).
    click(tagBtn('Shot'));
    const detailSvg = B.doc.querySelector('#detailPanel #pitchSvg');
    click(detailSvg, { clientX: Math.round(0.35 * 700), clientY: Math.round(0.40 * 450) });
    ok('WS-P2: dock shows the located event marker at the PROPORTIONAL viewBox spot (x*700, y*450)',
      /class="pitch-marker" cx="245.0" cy="180.0"/.test(dockSvg.innerHTML),
      (dockSvg.innerHTML.match(/class="pitch-marker"[^/]*/) || ['none'])[0]);
    ok('WS-P3: dock readout shows the located zone and label follows the event',
      txt('pitchDockReadout') === 'Middle third · Central channel' && /Pitch — Shot/.test(txt('pitchDockLabel')),
      'readout=' + txt('pitchDockReadout') + ' label=' + txt('pitchDockLabel'));
    detailDone();

    // The dock click locates the most recent event (touchline rule).
    click(dockSvg, { clientX: Math.round(0.8 * 700), clientY: Math.round(0.7 * 450) });
    ok('WS-P4: clicking the dock sets the latest event location (0.8, 0.7)',
      (() => { const m = dockMarker(); return !!m && Math.abs(m.x - 0.8) < 0.01 && Math.abs(m.y - 0.7) < 0.01; })(),
      JSON.stringify(dockMarker()));

    click(id('btnUndo'));
    ok('WS-P5: undo clears the located subject without errors (readout back to no-location)',
      txt('pitchDockReadout') === 'No location set');

    // Resize: pointer drag on the grip, clamped [180, 420].
    definePx(frame, 'clientWidth', 900);
    grip.dispatchEvent(new B.win.MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 500 }));
    B.win.dispatchEvent(new B.win.MouseEvent('pointermove', { bubbles: true, cancelable: true, clientX: 1000 }));
    B.win.dispatchEvent(new B.win.MouseEvent('pointerup', { bubbles: true, cancelable: true }));
    ok('WS-P6: grip drag widens the dock within the clamp (caps at 420)',
      dock.style.width === '420px', 'width=' + dock.style.width);
    grip.dispatchEvent(new B.win.MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 500 }));
    B.win.dispatchEvent(new B.win.MouseEvent('pointermove', { bubbles: true, cancelable: true, clientX: -4000 }));
    B.win.dispatchEvent(new B.win.MouseEvent('pointerup', { bubbles: true, cancelable: true }));
    ok('WS-P7: grip drag clamps at the minimum width (180)',
      dock.style.width === '180px', 'width=' + dock.style.width);
    keydown(grip, { key: 'ArrowRight' });
    ok('WS-P8: ArrowRight grows the dock by the keyboard step; aria-valuenow tracks width',
      dock.style.width === '200px' && grip.getAttribute('aria-valuenow') === '200',
      'width=' + dock.style.width + ' aria=' + grip.getAttribute('aria-valuenow'));

    // ---- F6 coordinate invariance + letterbox math (pure geometry) ----
    // Same normalized point must map identically at two dock sizes, and a
    // letterboxed element box must map against the DRAWN content box.
    const math = (rectW, rectH, cx, cy) => {
      Object.defineProperty(dockSvg, 'getBoundingClientRect', {
        value: () => ({ left: 0, top: 0, right: rectW, bottom: rectH, width: rectW, height: rectH, x: 0, y: 0 }),
        configurable: true
      });
      click(tagBtn('Corner'));
      detailDone();
      click(dockSvg, { clientX: cx, clientY: cy });
      return dockMarker();
    };
    // Size A: 420x270 (exact 700:450 aspect) — click at 60% / 30%.
    const a = math(420, 270, 252, 81);
    // Size B: 280x180 (exact aspect, different size) — same proportions.
    const b = math(280, 180, 168, 54);
    ok('WS-P9: SAME normalized location at two different pitch sizes (resize invariance)',
      !!a && !!b && Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01 &&
      Math.abs(a.x - 0.6) < 0.01 && Math.abs(a.y - 0.3) < 0.01,
      'a=' + JSON.stringify(a) + ' b=' + JSON.stringify(b));
    // Letterboxed box: 400x400 element, content = 400x257.14 centered =>
    // content spans y in [71.43, 328.57]. Click at the content's 50% point
    // (y=200) must map to 0.5.
    const c = math(400, 400, 200, 200);
    ok('WS-P10: letterboxed element maps against the DRAWN content box (xMidYMid meet)',
      !!c && Math.abs(c.x - 0.5) < 0.01 && Math.abs(c.y - 0.5) < 0.01,
      'c=' + JSON.stringify(c));
    const d = math(400, 400, 200, 10);
    ok('WS-P11: a click inside the letterbox clamps to the pitch edge (never inverts / NaNs)',
      !!d && d.y === 0 && isFinite(d.x), 'd=' + JSON.stringify(d));
    B.dom.window.close();
  }

  // =====================================================================
  section('WS-R — F7 responsive structure (static)');
  // =====================================================================
  {
    ok('WS-R1: html,body keep overflow hidden (no page-level overflow at any resolution)',
      /html\s*,\s*body\s*\{[^}]*overflow\s*:\s*hidden/.test(css));
    ok('WS-R2: the shell is a flex column with fixed-chrome bars and a flexible .layout',
      /body\s*\{[^}]*flex-direction:\s*column/.test(css) && /\.layout\s*\{[^}]*flex:\s*1 1 auto;[^}]*min-height:\s*0/s.test(css));
    ok('WS-R3: video frame keeps a minimum height (never collapses under splitter extremes)',
      /\.video-frame\s*\{[^}]*min-height:\s*80px/s.test(css));
    ok('WS-R4: tag grid owns the vertical scroll (bounded, min-height 0)',
      /\.tag-grid\s*\{[^}]*overflow-y:\s*auto;[^}]*min-height:\s*0/s.test(css));
    ok('WS-R5: pitch dock svg caps its height in short windows (max-height guard)',
      /\.pitch-dock-svg\s*\{[^}]*max-height:/s.test(css) && /@media \(max-height: 740px\)\s*\{[^}]*\.pitch-dock-svg\s*\{[^}]*max-height:\s*30vh/s.test(css));
    ok('WS-R6: events pane narrows stepwise at smaller widths (1500px / 1200px queries)',
      /@media \(max-width: 1500px\)\s*\{[^}]*\.events-pane\s*\{[^}]*max-width:\s*330px/s.test(css) &&
      /@media \(max-width: 1200px\)\s*\{[^}]*\.events-pane\s*\{[^}]*max-width:\s*300px/s.test(css));
  }

  // =====================================================================
  section('WS-D — persistence boundary (workspace state never enters data)');
  // =====================================================================
  {
    B = boot({ squad: SQUAD });
    await sleep(250);
    // Real work so the autosave flush has something to write.
    B.win.matchRosterApi.setRoster(ROSTER);
    click(tagBtn('Pass'));
    detailDone();
    // Workspace interactions.
    click(id('btnHideTopbar'));
    keydown(B.win, { key: 'b', code: 'KeyB', ctrlKey: true, shiftKey: true });
    const splitter = id('videoTagSplitter');
    const pane = B.doc.querySelector('.video-pane');
    const transport = B.doc.querySelector('.video-pane .transport');
    definePx(pane, 'clientHeight', 700);
    definePx(transport, 'offsetHeight', 50);
    definePx(splitter, 'offsetHeight', 10);
    keydown(splitter, { key: 'End' });
    keydown(id('pitchDockGrip'), { key: 'ArrowRight', shiftKey: true });
    await sleep(50);
    // Flush (the same synchronous close path the app uses).
    B.win.dispatchEvent(new B.win.Event('beforeunload', { cancelable: true }));
    const payload = B.stub._calls.autosaveFlushSync[B.stub._calls.autosaveFlushSync.length - 1];
    ok('WS-D1: autosave flush captured a payload',
      !!payload);
    const keys = payload ? Object.keys(payload).sort() : [];
    ok('WS-D2: payload keys are exactly the session shape (no workspace fields)',
      JSON.stringify(keys) === JSON.stringify(['__savedAt', 'events', 'matchClock', 'matchInfo', 'matchRoster', 'squad', 'tags', 'videoPath']),
      'keys=' + keys.join(','));
    const mcKeys = payload && payload.matchClock ? Object.keys(payload.matchClock).sort() : [];
    ok('WS-D3: matchClock keeps exactly its historical fields (no topbar/splitter/dock state)',
      JSON.stringify(mcKeys) === JSON.stringify(['activeSequenceId', 'clockBaseSeconds', 'clockRunning', 'clockStartedAt', 'nextSequenceNumber', 'period', 'scoreAgainst', 'scoreFor', 'selectedPlayerId', 'selectedTeam', 'videoSyncOffset']),
      'mcKeys=' + mcKeys.join(','));
    ok('WS-D4: saved match/session data remains loadable-shaped (events + roster + matchClock intact)',
      payload && Array.isArray(payload.events) && payload.events.length === 1 &&
      payload.matchRoster && payload.matchRoster.opponent.length === 2);
    B.dom.window.close();
  }

  // =====================================================================
  section('HYGIENE — jsdom errors');
  // =====================================================================
  {
    ok('H1: no jsdom errors during any boot in this suite',
      jsdomErrors.length === 0, jsdomErrors.slice(0, 3).join(' | '));
  }

  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  console.log('\n===== RESULTS =====');
  if (failed) {
    results.filter((r) => !r.pass).forEach((r) => console.log('  FAIL [' + r.section + '] ' + r.name + (r.detail ? '  | ' + r.detail : '')));
  }
  console.log('---- workspace-ui-check: ' + passed + ' passed, ' + failed + ' failed ----');
  process.exit(failed ? 1 : 0);
})();
