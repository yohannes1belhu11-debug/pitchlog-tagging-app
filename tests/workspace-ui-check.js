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
//         sizes, letterbox-aware mapping, frame-relative height cap
//         (D1 regression: the dock never overflows a splitter-shrunken
//         video frame, on every path that resizes the frame)
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

function boot(initial, opts) {
  opts = opts || {};
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => { jsdomErrors.push(String(e.message || e)); });
  vc.on('error', (msg) => { jsdomErrors.push('console.error: ' + String(msg)); });
  // FLOATING DOCK: opts.url overrides the default file:// origin (jsdom
  // localStorage needs a non-opaque origin — file:// throws there; the
  // app guards it), and opts.preEval(win) runs BEFORE the renderer source
  // is evaluated (seed localStorage / stub boot-time geometry or window
  // size for the restore-pathway pins).
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: opts.url || ('file://' + path.join(srcDir, 'index.html')), virtualConsole: vc });
  const win = dom.window;
  win.Date.now = () => fakeNow;
  const RECT = { left: 0, top: 0, right: 700, bottom: 450, width: 700, height: 450, x: 0, y: 0 };
  if (win.SVGElement) win.SVGElement.prototype.getBoundingClientRect = function () { return { ...RECT }; };
  else win.Element.prototype.getBoundingClientRect = function () { return { ...RECT }; };
  const stub = makeStub(initial);
  win.matchtag = stub;
  if (opts.preEval) opts.preEval(win);
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
    ok('WS-A8: pitch dock DOM stays inside .video-frame (its DOM home; positioning is viewport-fixed via CSS)',
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
    // FLOATING WINDOW: the dock is viewport-fixed (position:fixed — safe:
    // no ancestor of the dock carries transform/filter/perspective, so
    // fixed coordinates are true viewport coordinates). The right/bottom
    // 12px rule is the NO-LAYOUT fallback anchor (window lower-right);
    // the app computes the DEFAULT home — the video frame's bottom-right
    // corner — as explicit window-coordinate left/top at boot/reset
    // (pinned in WS-F0b/WS-F6).
    ok('WS-A12: pitch dock CSS is viewport-fixed with the right/bottom 12px FALLBACK anchor (the frame-bottom-right home is computed by the renderer)',
      /\.pitch-dock\s*\{[^}]*position:\s*fixed;[^}]*right:\s*12px;[^}]*bottom:\s*12px;/s.test(css));
    // FLOATING WINDOW z-order law: the dock floats ABOVE workspace panel
    // content (detach button z 10, detail panel z 20) and BELOW every
    // overlay — modal-overlay z 50 (the app\'s modal convention), touchline
    // overlay z 200, touchline detail sheet z 300, autosave toast z 1000.
    // 40 is the value strictly between the highest workspace layer (20)
    // and the lowest overlay layer (50): a modal can never be blocked.
    ok('WS-A13: FLOATING z-order law — dock z-index 40 sits ABOVE workspace panels (detail z 20) and BELOW every overlay (modal z 50, touchline z 200, toast z 1000)',
      /\.pitch-dock\s*\{[^}]*z-index:\s*40;/s.test(css) && /\.detail-panel\s*\{[^}]*z-index:\s*20;/s.test(css) &&
      /\.modal-overlay\s*\{[^}]*z-index:\s*50;/s.test(css) && /\.touchline-overlay\s*\{[^}]*z-index:\s*200;/s.test(css) &&
      /\.autosave-toast\s*\{[^}]*z-index:\s*1000;/s.test(css));
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

    // Resize: pointer drag on the grip. FLOATING WINDOW: the bounds are
    // window-containment — [140, window width - 24]; the old absolute
    // [180, 420] clamp is gone (the max/min are pinned on their own in
    // WS-F4). jsdom boots at the default width (180 at the harness's
    // 1024px window): 180 + 500 = 680 lands inside [140, 1000] with no cap
    // bite — free resize.
    definePx(frame, 'clientWidth', 900);
    grip.dispatchEvent(new B.win.MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 500 }));
    B.win.dispatchEvent(new B.win.MouseEvent('pointermove', { bubbles: true, cancelable: true, clientX: 1000 }));
    B.win.dispatchEvent(new B.win.MouseEvent('pointerup', { bubbles: true, cancelable: true }));
    ok('WS-P6: grip drag widens the dock freely within containment (680px, no 420 ceiling)',
      dock.style.width === '680px', 'width=' + dock.style.width);
    grip.dispatchEvent(new B.win.MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 500 }));
    B.win.dispatchEvent(new B.win.MouseEvent('pointermove', { bubbles: true, cancelable: true, clientX: -4000 }));
    B.win.dispatchEvent(new B.win.MouseEvent('pointerup', { bubbles: true, cancelable: true }));
    ok('WS-P7: grip drag clamps at the relaxed minimum width (140)',
      dock.style.width === '140px', 'width=' + dock.style.width);
    keydown(grip, { key: 'ArrowRight' });
    ok('WS-P8: ArrowRight grows the dock by the keyboard step; aria-valuenow tracks width',
      dock.style.width === '160px' && grip.getAttribute('aria-valuenow') === '160',
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

    // ---- D1 regression: frame-relative pitch-dock height cap ----
    // Defect D1: with the splitter at the tag-area maximum the video
    // frame shrinks to its 200px floor; a 420px-wide dock was ~333px tall
    // there and its top spilled over the frame, covering the matchday
    // bar. The renderer now publishes --pitch-dock-max-h = frameHeight -
    // (dock chrome + bottom offset + rounding), which styles.css min()'s
    // with the viewport caps. Chrome stub: dock 322 - svg 270 = 52
    // (+12 bottom +2 rounding = 66 reserve; the real app measures ~48 -
    // the live measurement tracks CSS, the stub only needs to be
    // self-consistent). The svg stub uses clientHeight because the svg
    // is an SVGElement: offsetHeight is an HTMLElement-only API and
    // reads as undefined in real browsers.
    //
    // DECLUTTER (workspace declutter, item 1): the cap is additionally
    // min'd with the HALF-FRAME SHARE LAW — the dock's total height
    // (svg + chrome) never exceeds 50% of the video frame's height, so
    // the bottom-anchored dock hugs the bottom-right corner and its top
    // edge stays at/below the frame's vertical midline: it can never
    // cover the centre of the video (the reported defect at short video
    // regions, e.g. 1366x768 layouts). shareCap = frameH/2 - chrome;
    // the 60px PITCH_DOCK_MIN_SVG_PX floor still applies (degenerate
    // sub-200px frames may slightly exceed half — D1 still holds). The
    // anchor itself is unchanged and pinned above (WS-P0x: right/bottom
    // 12px) — this law only constrains SIZE, never position, grip, or
    // the boot widths.
    const pane = B.doc.querySelector('.video-pane');
    const transport = B.doc.querySelector('.video-pane .transport');
    const splitter = id('videoTagSplitter');
    const capValue = () => dockSvg.style.getPropertyValue('--pitch-dock-max-h');
    const stubCapGeometry = (frameH, dockH, svgH) => {
      definePx(frame, 'clientHeight', frameH);
      definePx(dock, 'offsetHeight', dockH);
      definePx(dockSvg, 'clientHeight', svgH);
    };

    // Pre-layout safety: with no measurable geometry the cap stays unset
    // and the pure viewport CSS caps keep governing.
    definePx(frame, 'clientHeight', 0);
    keydown(grip, { key: 'End' });
    ok('WS-P12: without layout the frame cap stays unset (viewport CSS caps govern); End now means the WINDOW containment max (1024-24=1000 — the 900px frame stub is irrelevant)',
      capValue() === '' && dock.style.width === '1000px',
      'cap=' + JSON.stringify(capValue()) + ' width=' + dock.style.width);

    // Width path: a USER-resized dock (grip End = manual size) inside the
    // 200px-floor frame (the D1 state). FLOATING DOCK: the half-frame
    // share law is a BOOT/DEFAULT law now — manual sizes are exempt
    // within D1, so the cap is the pure D1 value: 200-66 = 134.
    stubCapGeometry(200, 322, 270);
    keydown(grip, { key: 'End' });
    ok('WS-P13: a manually-resized dock in the 200px-floor frame caps at pure D1 (134 = frame-66; manual sizes are exempt from the share law)',
      capValue() === '134px',
      'cap=' + JSON.stringify(capValue()));

    // Splitter path: maximizing the tag area re-derives the cap through
    // applyTagpanelHeight (frame shrank to the floor again).
    definePx(pane, 'clientHeight', 700);
    definePx(transport, 'offsetHeight', 50);
    definePx(splitter, 'offsetHeight', 10);
    stubCapGeometry(180, 322, 270);
    keydown(splitter, { key: 'End' });
    ok('WS-P14: splitter End re-derives the cap from the resized frame (manual width still active -> pure D1 114 = 180-66)',
      capValue() === '114px',
      'cap=' + JSON.stringify(capValue()));

    // Topbar toggle path: hide grows the frame (cap relaxes), restore
    // shrinks it (cap tightens) — both directions recompute.
    stubCapGeometry(600, 322, 270);
    click(id('btnHideTopbar'));
    ok('WS-P15: hiding the topbar re-derives the relaxed cap (manual width -> pure D1 534 = 600-66)',
      capValue() === '534px', 'cap=' + JSON.stringify(capValue()));
    stubCapGeometry(240, 322, 270);
    click(id('btnShowTopbar'));
    ok('WS-P16: restoring the topbar re-clamps to the smaller frame (pure D1 174 = 240-66)',
      capValue() === '174px', 'cap=' + JSON.stringify(capValue()));

    // Window-resize path (re-clamps via both the splitter and the dock).
    stubCapGeometry(200, 322, 270);
    B.win.dispatchEvent(new B.win.Event('resize'));
    ok('WS-P17: window resize re-derives the cap (manual width -> pure D1 134 = 200-66)',
      capValue() === '134px', 'cap=' + JSON.stringify(capValue()));

    // DECLUTTER share law — FLOATING DOCK re-anchor: the share law is a
    // BOOT/DEFAULT law now (a user-resized dock may exceed half the frame
    // within D1 — pinned in WS-F4c). The original P17b drove grip End (a
    // MANUAL resize), which the floating-dock law exempts; the law is
    // therefore pinned here in its true domain: after a double-click
    // RESET (defaults restored: width 180 at this harness's 1024px
    // window), D1 alone would allow 414px — the share law caps the svg at
    // 240-52=188, keeping the default dock TOTAL (188+52=240) at exactly
    // half the 480px frame: the top edge sits on the midline, never above.
    const dockHeader = B.doc.querySelector('.pitch-dock-header');
    dockHeader.dispatchEvent(new B.win.MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    stubCapGeometry(480, 322, 270);
    B.win.dispatchEvent(new B.win.Event('resize'));
    ok('WS-P17b: the half-frame share law for DEFAULT sizes — after a reset (width 180) the dock total never exceeds 50% of the video frame (480px frame -> svg cap 188 = 240-52; dock total 240 = half)',
      capValue() === '188px' && dock.style.width === '180px',
      'cap=' + JSON.stringify(capValue()) + ' width=' + dock.style.width);

    // Coordinate exactness under the cap: a capped element box letterboxes
    // exactly as WS-P10 proves for the general case. At a 420x134 stubbed
    // box the drawn pitch is 208.4px wide and centered; its center maps
    // to (0.5, 0.5).
    const capped = math(420, 134, 210, 67);
    ok('WS-P18: click mapping stays exact inside a height-capped dock (letterboxed)',
      !!capped && Math.abs(capped.x - 0.5) < 0.01 && Math.abs(capped.y - 0.5) < 0.01,
      'capped=' + JSON.stringify(capped));

    // The CSS must actually consume the cap in BOTH rules (base + 740px).
    ok('WS-P19: styles.css min()s the frame cap with the viewport caps (base + 740px query)',
      /max-height:\s*min\(40vh,\s*var\(--pitch-dock-max-h,\s*40vh\)\)/.test(css) &&
      /max-height:\s*min\(30vh,\s*var\(--pitch-dock-max-h,\s*30vh\)\)/.test(css));

    B.dom.window.close();
  }

  // =====================================================================
  section('WS-F — floating pitch dock (header drag, free resize, persistence)');
  // =====================================================================
  {
    // ---- Part 1: drag + clamping (default file:// boot; storage inert) ----
    B = boot({ squad: SQUAD });
    await sleep(250);
    const dock = id('pitchDock');
    const dockSvg = id('pitchDockSvg');
    const grip = id('pitchDockGrip');
    const dockHeader = B.doc.querySelector('.pitch-dock-header');
    const frame = B.doc.querySelector('.video-frame');
    const md = (el, x, y) => el.dispatchEvent(new B.win.MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));
    const mm = (x, y) => B.win.dispatchEvent(new B.win.MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
    const mu = () => B.win.dispatchEvent(new B.win.MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    const dblClick = (el) => el.dispatchEvent(new B.win.MouseEvent('dblclick', { bubbles: true, cancelable: true }));

    // (g) boot defaults: with NO measurable frame rect (the jsdom
    // default — the frame's getBoundingClientRect is all zeros) the boot
    // falls back to the FIXED CSS anchor (window lower-right) at the
    // default size for this window.
    ok('WS-F0: boots at the fallback anchor (no inline position) at the default width (180 at the 1024px harness window)',
      dock.style.left === '' && dock.style.top === '' && dock.style.right === '' && dock.style.bottom === '' &&
      dock.style.width === '180px',
      'left=' + dock.style.left + ' width=' + dock.style.width);

    // (f) the boot DEFAULT with a measurable frame rect: the video frame's
    // bottom-right corner — the familiar home — computed from the frame's
    // live rect in WINDOW coordinates (the dock is position:fixed). Frame
    // rect {right:860, bottom:340}, dock box 240x160: left 860-12-240=608,
    // top 340-12-160=168.
    {
      const b2 = boot({ squad: SQUAD }, {
        preEval: (win) => {
          const f = win.document.querySelector('.video-frame');
          Object.defineProperty(f, 'getBoundingClientRect', {
            value: () => ({ left: 60, top: 40, right: 860, bottom: 340, width: 800, height: 300, x: 60, y: 40 }),
            configurable: true
          });
          const d = win.document.getElementById('pitchDock');
          Object.defineProperty(d, 'offsetWidth', { get: () => 240, configurable: true });
          Object.defineProperty(d, 'offsetHeight', { get: () => 160, configurable: true });
        }
      });
      await sleep(250);
      const d2 = b2.doc.getElementById('pitchDock');
      ok('WS-F0b: with a measurable frame rect the boot DEFAULT is the frame bottom-right corner in window coordinates (608/168; width tier 180)',
        d2.style.left === '608px' && d2.style.top === '168px' && d2.style.width === '180px',
        'left=' + d2.style.left + ' top=' + d2.style.top + ' width=' + d2.style.width);
      b2.dom.window.close();
    }

    // Geometry stubs for the drag math (jsdom has no layout). The frame is
    // stubbed SMALLER than the 1024x768 jsdom window (600x300): every
    // clamp pin below proves the boundary is the WINDOW, not the frame.
    definePx(frame, 'clientWidth', 600);
    definePx(frame, 'clientHeight', 300);
    definePx(dock, 'offsetLeft', 100);
    definePx(dock, 'offsetTop', 80);
    definePx(dock, 'offsetWidth', 240);
    definePx(dock, 'offsetHeight', 160);

    // (a) drag by header moves the dock by the pointer delta.
    md(dockHeader, 500, 300);
    ok('WS-F1a: mousedown on the header starts the drag (is-dragging affordance classes on dock + body)',
      dock.classList.contains('is-dragging') && B.doc.body.classList.contains('pitch-dock-dragging'));
    mm(540, 330);
    ok('WS-F1b: header drag moves the dock by the pointer delta (100+40, 80+30) and switches to the explicit anchor',
      dock.style.left === '140px' && dock.style.top === '110px' &&
      dock.style.right === 'auto' && dock.style.bottom === 'auto',
      'left=' + dock.style.left + ' top=' + dock.style.top + ' right=' + dock.style.right + ' bottom=' + dock.style.bottom);
    mu();
    ok('WS-F1c: mouseup ends the drag (affordance classes cleared)',
      !dock.classList.contains('is-dragging') && !B.doc.body.classList.contains('pitch-dock-dragging'));

    // (a) the dock is placeable ANYWHERE in the window: dragging BELOW the
    // frame's stubbed 600x300 box (the tag-bar region) leaves the dock
    // there — the frame no longer pulls it back; only the window edge
    // (768-160-4=604) would.
    md(dockHeader, 500, 300);
    mm(540, 620);
    ok('WS-F1d: dragging into the tag-bar region (below the frame) places the dock there, fully inside the window (top 400; the old frame clamp would give 136)',
      dock.style.left === '140px' && dock.style.top === '400px',
      'left=' + dock.style.left + ' top=' + dock.style.top);
    mu();

    // (h) zone interactivity is independent of position: while the dock
    // floats over the tag-bar region, tapping a pitch zone still locates
    // the latest event (the same click-to-locate pathway).
    click(tagBtn('Pass'));
    detailDone();
    click(dockSvg, { clientX: Math.round(0.8 * 700), clientY: Math.round(0.7 * 450) });
    const zmFloat = dockMarker();
    ok('WS-F1e: zone taps keep working while the dock floats over the tag bar (marker 0.8/0.7; dock still parked at top 400)',
      !!zmFloat && Math.abs(zmFloat.x - 0.8) < 0.01 && Math.abs(zmFloat.y - 0.7) < 0.01 && dock.style.top === '400px',
      JSON.stringify(zmFloat) + ' top=' + dock.style.top);

    // (b) the events-panel region (right of the frame's stubbed 600px
    // width) is equally reachable — only the window edges clamp.
    md(dockHeader, 500, 300);
    mm(1050, 250);
    ok('WS-F1f: dragging over the events-pane region (beyond the frame right edge) is allowed (left 650; the old frame clamp would give 356)',
      dock.style.left === '650px' && dock.style.top === '30px',
      'left=' + dock.style.left + ' top=' + dock.style.top);
    mu();

    // (b) a drag gesture from a pitch zone cell never moves the dock, and
    // the zone click keeps locating events (interactivity preserved).
    // PRESERVATION PINS: green by design pre-implementation (no drag
    // exists to mis-capture) — they guard the drag wiring against
    // capturing zone-cell/grip gestures.
    click(tagBtn('Pass'));
    detailDone();
    const zoneCell = dockSvg.querySelector('.pitch-outline');
    const beforeDrag = dock.style.left;
    md(zoneCell, 500, 300);
    ok('WS-F2a: mousedown on a pitch zone cell does NOT start a drag (no affordance)',
      !dock.classList.contains('is-dragging'));
    mm(540, 330);
    mu();
    ok('WS-F2b: a full drag gesture from a zone cell leaves the dock unmoved',
      dock.style.left === beforeDrag,
      'left=' + dock.style.left + ' before=' + beforeDrag);
    click(dockSvg, { clientX: Math.round(0.8 * 700), clientY: Math.round(0.7 * 450) });
    const zm = dockMarker();
    ok('WS-F2c: zone activation preserved — clicking the pitch still locates the latest event (0.8, 0.7)',
      !!zm && Math.abs(zm.x - 0.8) < 0.01 && Math.abs(zm.y - 0.7) < 0.01,
      JSON.stringify(zm));
    // The resize grip is INSIDE the header but owns its own gesture.
    md(grip, 500, 300);
    mm(540, 330);
    mu();
    ok('WS-F2d: a drag gesture from the resize grip does not move the dock (grip owns resizing)',
      dock.style.left === beforeDrag,
      'left=' + dock.style.left);

    // (c) real-time clamping during the drag: all four edges stay inside
    // the APP WINDOW (4px margin) — the tag bar, transport bar and events
    // panel are all coverable; only the window edges stop the dock.
    md(dockHeader, 500, 300);
    mm(10500, 10030);
    ok('WS-F3a: dragging past the bottom-right clamps inside the WINDOW (1024-240-4 / 768-160-4 — the 600x300 frame stub never bites)',
      dock.style.left === '780px' && dock.style.top === '604px',
      'left=' + dock.style.left + ' top=' + dock.style.top);
    mu();
    md(dockHeader, 500, 300);
    mm(-9500, -9970);
    ok('WS-F3b: dragging past the top-left clamps at the margin (4px)',
      dock.style.left === '4px' && dock.style.top === '4px',
      'left=' + dock.style.left + ' top=' + dock.style.top);
    mu();
    // A window resize re-clamps the dock into view (never stranded) —
    // window-relative: the shrunk WINDOW (700x400) governs; the frame
    // stub stays 600x300 and is irrelevant.
    md(dockHeader, 500, 300);
    mm(10500, 10030); // park at the far bottom-right corner of the window
    mu();
    Object.defineProperty(B.win, 'innerWidth', { get: () => 700, configurable: true });
    Object.defineProperty(B.win, 'innerHeight', { get: () => 400, configurable: true });
    B.win.dispatchEvent(new B.win.Event('resize'));
    ok('WS-F3c: window resize re-clamps the dragged dock into the shrunk WINDOW (700-240-4 / 400-160-4; the frame stub stays 600x300)',
      dock.style.left === '456px' && dock.style.top === '236px',
      'left=' + dock.style.left + ' top=' + dock.style.top);

    // (f) free resize bounds: min 140, max = WINDOW width - margins (the
    // frame stub stays 600 — deliberately different from the 900 window).
    Object.defineProperty(B.win, 'innerWidth', { get: () => 900, configurable: true });
    keydown(grip, { key: 'End' });
    ok('WS-F4a: grip End resizes to the WINDOW containment max (900-24=876; the 600px frame stub is irrelevant) and aria-valuemax tracks it',
      dock.style.width === '876px' && grip.getAttribute('aria-valuemax') === '876',
      'width=' + dock.style.width + ' aria-max=' + grip.getAttribute('aria-valuemax'));
    keydown(grip, { key: 'Home' });
    ok('WS-F4b: grip Home clamps at the relaxed minimum (140)',
      dock.style.width === '140px', 'width=' + dock.style.width);
    // A user-sized dock may exceed the half-frame law within D1 (the D1
    // height cap stays frame-based — stricter than the window, so a
    // floating dock can never overflow the window either).
    definePx(frame, 'clientHeight', 480);
    definePx(dock, 'offsetHeight', 322);
    definePx(dockSvg, 'clientHeight', 270);
    keydown(grip, { key: 'End' });
    ok('WS-F4c: a manually-resized dock may exceed half the frame within D1 (480px frame -> cap 414 = pure D1, not the 188 share value)',
      dockSvg.style.getPropertyValue('--pitch-dock-max-h') === '414px',
      'cap=' + JSON.stringify(dockSvg.style.getPropertyValue('--pitch-dock-max-h')));
    B.dom.window.close();

    // ---- Part 2: persistence + reset (http://localhost boots: jsdom's
    // file:// origin is opaque and localStorage throws there — the app
    // guards it; these boots exercise the real storage pathway). ----
    B = boot({ squad: SQUAD }, { url: 'http://localhost/' });
    await sleep(250);
    {
      const dock2 = id('pitchDock');
      const grip2 = id('pitchDockGrip');
      const header2 = B.doc.querySelector('.pitch-dock-header');
      const frame2 = B.doc.querySelector('.video-frame');
      // The frame is stubbed 800x450 — deliberately DIFFERENT from the
      // 1024x768 jsdom window: the pins below prove the boundary is the
      // WINDOW (a 1000px width restores although the frame stub is only
      // 800 wide).
      definePx(frame2, 'clientWidth', 800);
      definePx(frame2, 'clientHeight', 450);
      definePx(dock2, 'offsetLeft', 100);
      definePx(dock2, 'offsetTop', 80);
      definePx(dock2, 'offsetWidth', 240);
      definePx(dock2, 'offsetHeight', 160);
      md(header2, 500, 300);
      mm(540, 330);
      mu();
      keydown(grip2, { key: 'End' });
      const raw = B.win.localStorage.getItem('pitchlog.pitchDock');
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch (e) { /* pinned below */ }
      ok('WS-F5a: drag + manual resize persist under the single key pitchlog.pitchDock as a v:2 WINDOW-relative record ({v:2, left, top, width}; End max = 1024-24 = 1000)',
        !!raw && !!parsed && parsed.v === 2 && parsed.left === 140 && parsed.top === 110 && parsed.width === 1000,
        'raw=' + JSON.stringify(raw));

      // (d) round-trip: a fresh boot seeded with the exact stored value.
      const seed = raw;
      B = boot({ squad: SQUAD }, {
        url: 'http://localhost/',
        preEval: (win) => {
          win.localStorage.setItem('pitchlog.pitchDock', seed);
          const f = win.document.querySelector('.video-frame');
          const d = win.document.getElementById('pitchDock');
          Object.defineProperty(f, 'clientWidth', { get: () => 800, configurable: true });
          Object.defineProperty(f, 'clientHeight', { get: () => 450, configurable: true });
          Object.defineProperty(d, 'offsetWidth', { get: () => 240, configurable: true });
          Object.defineProperty(d, 'offsetHeight', { get: () => 160, configurable: true });
        }
      });
      await sleep(50);
      ok('WS-F5b: fresh boot restores the stored v:2 position AND size exactly (window-relative; the 1000px width fits the 1024px window, not the 800px frame stub)',
        id('pitchDock').style.left === '140px' && id('pitchDock').style.top === '110px' &&
        id('pitchDock').style.width === '1000px',
        'left=' + id('pitchDock').style.left + ' top=' + id('pitchDock').style.top + ' width=' + id('pitchDock').style.width);
      B.dom.window.close();

      // (d) out-of-bounds stored values are re-clamped to the current WINDOW.
      B = boot({ squad: SQUAD }, {
        url: 'http://localhost/',
        preEval: (win) => {
          win.localStorage.setItem('pitchlog.pitchDock', JSON.stringify({ v: 2, left: 5000, top: 4000, width: 5000 }));
          const f = win.document.querySelector('.video-frame');
          const d = win.document.getElementById('pitchDock');
          Object.defineProperty(f, 'clientWidth', { get: () => 800, configurable: true });
          Object.defineProperty(f, 'clientHeight', { get: () => 450, configurable: true });
          Object.defineProperty(d, 'offsetWidth', { get: () => 240, configurable: true });
          Object.defineProperty(d, 'offsetHeight', { get: () => 160, configurable: true });
        }
      });
      await sleep(50);
      ok('WS-F5c: out-of-bounds stored values restore RE-CLAMPED into the current WINDOW (width 5000->1000, left 5000->780, top 4000->604)',
        id('pitchDock').style.width === '1000px' && id('pitchDock').style.left === '780px' && id('pitchDock').style.top === '604px',
        'width=' + id('pitchDock').style.width + ' left=' + id('pitchDock').style.left + ' top=' + id('pitchDock').style.top);
      B.dom.window.close();

      // (d) corrupt storage falls back to the defaults.
      B = boot({ squad: SQUAD }, {
        url: 'http://localhost/',
        preEval: (win) => { win.localStorage.setItem('pitchlog.pitchDock', '{{{not json'); }
      });
      await sleep(50);
      ok('WS-F5d: a corrupt stored value falls back to the defaults (anchored bottom-right, boot width 180)',
        id('pitchDock').style.left === '' && id('pitchDock').style.top === '' && id('pitchDock').style.width === '180px',
        'left=' + id('pitchDock').style.left + ' width=' + id('pitchDock').style.width);
      B.dom.window.close();

      // Partial override: size only — the position stays at the default
      // home (no measurable frame rect in this boot, so the fallback
      // anchor governs).
      B = boot({ squad: SQUAD }, {
        url: 'http://localhost/',
        preEval: (win) => { win.localStorage.setItem('pitchlog.pitchDock', JSON.stringify({ v: 2, width: 300 })); }
      });
      await sleep(50);
      ok('WS-F5e: a size-only v:2 override restores the width and keeps the default position',
        id('pitchDock').style.left === '' && id('pitchDock').style.width === '300px',
        'left=' + id('pitchDock').style.left + ' width=' + id('pitchDock').style.width);
      B.dom.window.close();

      // (e) MIGRATION: a stored record WITHOUT a version field is a
      // pre-window (frame-relative) record — discarded silently, the
      // defaults apply (no frame-relative value can ever jump the dock).
      B = boot({ squad: SQUAD }, {
        url: 'http://localhost/',
        preEval: (win) => { win.localStorage.setItem('pitchlog.pitchDock', JSON.stringify({ left: 140, top: 110, width: 776 })); }
      });
      await sleep(50);
      ok('WS-F5f: an UNVERSIONED stored record (pre-window, frame-relative) is DISCARDED — defaults apply',
        id('pitchDock').style.left === '' && id('pitchDock').style.top === '' && id('pitchDock').style.width === '180px',
        'left=' + id('pitchDock').style.left + ' top=' + id('pitchDock').style.top + ' width=' + id('pitchDock').style.width);
      B.dom.window.close();

      // (e) MIGRATION: an explicit v:1 record is equally discarded.
      B = boot({ squad: SQUAD }, {
        url: 'http://localhost/',
        preEval: (win) => { win.localStorage.setItem('pitchlog.pitchDock', JSON.stringify({ v: 1, left: 140, top: 110, width: 776 })); }
      });
      await sleep(50);
      ok('WS-F5g: a v:1 stored record is DISCARDED — only v:2 (window-relative) records restore',
        id('pitchDock').style.left === '' && id('pitchDock').style.top === '' && id('pitchDock').style.width === '180px',
        'left=' + id('pitchDock').style.left + ' top=' + id('pitchDock').style.top + ' width=' + id('pitchDock').style.width);
      B.dom.window.close();

      // (f) double-click reset — a boot WITH a stored v:2 override AND a
      // measurable frame rect: the reset must return to the frame's
      // bottom-right home (computed from the LIVE rect — not the fixed
      // CSS fallback anchor) at the boot size, and clear the override.
      B = boot({ squad: SQUAD }, {
        url: 'http://localhost/',
        preEval: (win) => {
          win.localStorage.setItem('pitchlog.pitchDock', JSON.stringify({ v: 2, left: 140, top: 110, width: 1000 }));
          const f = win.document.querySelector('.video-frame');
          Object.defineProperty(f, 'getBoundingClientRect', {
            value: () => ({ left: 60, top: 40, right: 860, bottom: 340, width: 800, height: 300, x: 60, y: 40 }),
            configurable: true
          });
          const d = win.document.getElementById('pitchDock');
          Object.defineProperty(d, 'offsetWidth', { get: () => 240, configurable: true });
          Object.defineProperty(d, 'offsetHeight', { get: () => 160, configurable: true });
        }
      });
      await sleep(50);
      ok('WS-F6-pre: the seeded v:2 override restored (sanity for the reset pin; 1000px fits the window, not the 800px-wide frame stub)',
        id('pitchDock').style.left === '140px' && id('pitchDock').style.width === '1000px',
        'left=' + id('pitchDock').style.left + ' width=' + id('pitchDock').style.width);
      dblClick(B.doc.querySelector('.pitch-dock-header'));
      ok('WS-F6: double-click on the header resets to the DEFAULT home — the frame bottom-right corner (860-12-240=608, 340-12-160=168) — at the boot size and CLEARS the stored override',
        id('pitchDock').style.left === '608px' && id('pitchDock').style.top === '168px' &&
        id('pitchDock').style.right === 'auto' && id('pitchDock').style.bottom === 'auto' &&
        id('pitchDock').style.width === '180px' &&
        B.win.localStorage.getItem('pitchlog.pitchDock') === null,
        'left=' + id('pitchDock').style.left + ' top=' + id('pitchDock').style.top + ' width=' + id('pitchDock').style.width + ' stored=' + JSON.stringify(B.win.localStorage.getItem('pitchlog.pitchDock')));
      B.dom.window.close();
    }

    // (g) the boot width tiers stay EXACTLY as today (240/200/180).
    B = boot({ squad: SQUAD }, {
      url: 'http://localhost/',
      preEval: (win) => {
        Object.defineProperty(win, 'innerWidth', { get: () => 1600, configurable: true });
        Object.defineProperty(win, 'innerHeight', { get: () => 900, configurable: true });
      }
    });
    await sleep(50);
    ok('WS-F7a: large-window boot tier unchanged (1600x900 -> 240px default dock)',
      id('pitchDock').style.width === '240px', 'width=' + id('pitchDock').style.width);
    B.dom.window.close();
    B = boot({ squad: SQUAD }, {
      url: 'http://localhost/',
      preEval: (win) => {
        Object.defineProperty(win, 'innerWidth', { get: () => 1300, configurable: true });
      }
    });
    await sleep(50);
    ok('WS-F7b: mid-window boot tier unchanged (1300px -> 200px default dock; 180 pinned by WS-F0/WS-F6)',
      id('pitchDock').style.width === '200px', 'width=' + id('pitchDock').style.width);
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
