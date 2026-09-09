#!/usr/bin/env node
// PitchLog / MatchTag — Video Player Volume Control regression harness
// (VV series).
// =====================================================================
// Verification-only harness. It does NOT modify any app source file.
//
// Verifies the transport-bar volume feature:
//   - .video-volume-control container with #volumeMuteBtn (+#volumeIcon
//     span) and #videoVolumeSlider (min 0, max 1, step 0.05, value 1)
//   - slider input drives <video>.volume and the icon (🔊 / 🔉 / 🔇)
//   - mute click toggles <video>.muted; lastVolume memory restores the
//     pre-muted level on unmute (including unmute-from-zero)
//   - boundary levels 0.0 and 1.0
//   - volume persists across seeks, a second video load, and the
//     detach→reattach source-change cycle
//   - controls follow the transport enable/disable lifecycle (disabled
//     until a video loads; disabled while the video plays detached)
//
// Covered:
//   STATIC  index.html structure + attributes, renderer.js listeners +
//           the source-change re-stamp points, lastVolume memory, CSS
//           accent-variable styling.
//   jsdom   two boots with the REAL index.html + integrity.js +
//           analytics.js + player-season.js + renderer.js and a stubbed
//           window.matchtag (same architecture as the other harnesses):
//     BOOT V1  session with a video: slider drives the element, icons,
//              boundaries, mute/unmute + lastVolume restore, seek
//              persistence, second-load persistence.
//     BOOT V2  detach → reattach round-trip: honest disable while
//              detached, volume + position preserved through the cycle.
//
// HONEST SCOPE: jsdom does not decode media or render audio. volume and
// muted are REAL settable HTMLMediaElement properties in jsdom, so every
// behavioral assertion checks the live element state; play()/pause()/
// load() are patched no-ops on the instance (an extension of the
// simulateLoadedVideo technique used by the other harnesses). Real
// audible output and Chromium's native slider rendering must be
// confirmed manually in Electron.
//
// Run:  node tests/video-volume-check.js   (from the project root)
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
const cssSrc = fs.readFileSync(path.join(srcDir, 'styles.css'), 'utf-8');
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
function approx(a, b) { return Math.abs(a - b) < 1e-9; }

// ---------------------------------------------------------------------------
// Static source-level checks
// ---------------------------------------------------------------------------
section('STATIC — volume control wiring (source-level checks)');
{
  ok('VV-S1: index.html defines the volume control (container, mute button with icon span, range slider min=0 max=1 step=0.05 value=1)',
    /id="videoVolumeControl"/.test(html) &&
    /<button id="volumeMuteBtn"[^>]*>[\s\S]*?<span id="volumeIcon">🔊<\/span>/.test(html) &&
    /<input id="videoVolumeSlider"[^>]*type="range"[^>]*min="0"[^>]*max="1"[^>]*step="0\.05"[^>]*value="1"/.test(html),
    'index.html volume control markup');

  ok('VV-S2: renderer.js wires the slider input and mute click listeners',
    /videoVolumeSlider\.addEventListener\('input'/.test(rendererSrc) &&
    /volumeMuteBtn\.addEventListener\('click'/.test(rendererSrc));

  ok('VV-S3: volume is re-stamped on every source-change path (loadVideoFromPath, loadedmetadata, reattach)',
    /video\.src = fileUrl;[\s\S]{0,500}?applyVolumeToVideo\(\);/.test(rendererSrc) &&
    /video\.addEventListener\('loadedmetadata', \(\) => \{[\s\S]{0,400}?applyVolumeToVideo\(\);/.test(rendererSrc) &&
    /video\.src = currentVideoUrl;[\s\S]{0,300}?applyVolumeToVideo\(\);/.test(rendererSrc));

  ok('VV-S4: lastVolume memory maintained (initial state, recorded on mute, restored on unmute)',
    /lastVolume: 1/.test(rendererSrc) &&
    (rendererSrc.match(/volumeState\.lastVolume/g) || []).length >= 3);

  ok('VV-S5: styles.css styles the control with the theme accent variables',
    /\.video-volume-control\s*\{/.test(cssSrc) &&
    /\.volume-mute-btn\.muted\s*\{/.test(cssSrc) &&
    /\.volume-slider\s*\{[^}]*accent-color: var\(--accent\)/.test(cssSrc) &&
    /\.volume-mute-btn:hover:not\(:disabled\)\s*\{[^}]*var\(--accent-bright\)/.test(cssSrc));

  ok('VV-S6: canonical volume state drives the video element (volume + muted setters)',
    /video\.volume = volumeState\.volume;/.test(rendererSrc) &&
    /video\.muted = volumeState\.muted;/.test(rendererSrc));
}

// ---------------------------------------------------------------------------
// jsdom boots
// ---------------------------------------------------------------------------
const SQUAD = [
  { id: 'player_1', number: '1', name: 'Ana One' },
  { id: 'player_2', number: '2', name: 'Ben Two' }
];

function makeStub() {
  const calls = { saveSession: [], autosaveWrite: [], saveSquad: [] };
  let loadSessionData = null;
  let onVideoClosedCb = null;
  const stub = {
    openVideo: async () => null,
    saveSession: async (d) => { calls.saveSession.push(clone(d)); return { canceled: false, filePath: '/tmp/vv-session.json' }; },
    exportCsv: async () => ({ canceled: true }),
    exportClipPlaylist: async () => ({ canceled: true }),
    loadSession: async () => { return clone(loadSessionData); },
    loadMultipleSessions: async () => [],
    loadSquad: async () => clone(SQUAD),
    saveSquad: async (s) => { calls.saveSquad.push(clone(s)); return true; },
    detachVideo: async () => true,
    reattachVideo: async () => true,
    sendVideoCommand: () => {},
    onVideoState: () => {},
    onVideoClosed: (cb) => { onVideoClosedCb = cb; },
    autosaveRead: async () => null,
    autosaveWrite: async (d) => { calls.autosaveWrite.push(clone(d)); return { ok: true, path: '/tmp/autosave.json' }; },
    autosaveDelete: async () => ({ ok: true }),
    autosaveFlushSync: () => {},
    onCloseRequested: () => {},
    closeProceed: () => {},
    _setLoadSession: (d) => { loadSessionData = d; },
    _getOnVideoClosed: () => onVideoClosedCb,
    _calls: calls
  };
  return stub;
}

function boot() {
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => { jsdomErrors.push(String(e.message || e)); });
  vc.on('error', (msg) => { jsdomErrors.push('console.error: ' + String(msg)); });
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'file://' + path.join(srcDir, 'index.html'), virtualConsole: vc });
  const win = dom.window;
  const stub = makeStub();
  win.matchtag = stub;
  win.eval(integritySrc);
  win.eval(analyticsSrc);
  win.eval(playerSeasonSrc);
  win.eval(rendererSrc);
  return { dom, win, doc: win.document, stub };
}

function click(el) { el.dispatchEvent(new el.ownerDocument.defaultView.MouseEvent('click', { bubbles: true, cancelable: true })); }
function inputEvent(el) { el.dispatchEvent(new el.ownerDocument.defaultView.Event('input', { bubbles: true, cancelable: true })); }
function changeEvent(el) { el.dispatchEvent(new el.ownerDocument.defaultView.Event('change', { bubbles: true, cancelable: true })); }
function fireLoadedMetadata(video) { video.dispatchEvent(new video.ownerDocument.defaultView.Event('loadedmetadata')); }
function setSlider(slider, value) { slider.value = String(value); inputEvent(slider); }

// Simulate a loaded, seekable video in jsdom (same technique as
// tests/f2-f3-fix-check.js F2-2 / video-seek-domain-check). The media
// element's not-implemented play/pause/load are patched to no-ops so the
// detach/reattach flows run without jsdom noise; volume/muted/currentTime
// stay REAL element properties.
function simulateLoadedVideo(doc, currentTime, duration) {
  const video = doc.getElementById('video');
  Object.defineProperty(video, 'readyState', { value: 4, configurable: true });
  Object.defineProperty(video, 'currentTime', { value: currentTime, configurable: true, writable: true });
  Object.defineProperty(video, 'duration', { value: duration, configurable: true, writable: true });
  video.play = () => {};
  video.pause = () => {};
  video.load = () => {};
  return video;
}

function videoSessionFixture(path_, url_) {
  return {
    __schemaVersion: 4,
    videoPath: path_, videoUrl: url_,
    tags: [], events: [], squad: SQUAD,
    matchInfo: { opponent: 'Volume FC' },
    matchClock: { clockStartedAt: null, clockBaseSeconds: 0, clockRunning: false, period: '1H',
      scoreFor: 0, scoreAgainst: 0, videoSyncOffset: 0, selectedTeam: 'our', selectedPlayerId: null,
      activeSequenceId: null, nextSequenceNumber: 1 }
  };
}

(async () => {
  // =====================================================================
  section('BOOT V1 — slider drives the element; boundaries; mute/unmute restore; persistence');
  // =====================================================================
  {
    const V = boot();
    const doc = V.doc;
    V.stub._setLoadSession(videoSessionFixture('/tmp/match.mp4', 'file:///tmp/match.mp4'));
    await sleep(300);
    click(doc.getElementById('btnLoadSession'));
    await sleep(350); // session load restores the video path (loadVideoFromPath)

    const video = simulateLoadedVideo(doc, 100, 5000);
    fireLoadedMetadata(video);
    await sleep(30);

    const slider = doc.getElementById('videoVolumeSlider');
    const muteBtn = doc.getElementById('volumeMuteBtn');
    const icon = doc.getElementById('volumeIcon');

    ok('VV1: volume control elements exist and are enabled once a video is loaded',
      !!doc.getElementById('videoVolumeControl') && !!slider && !!muteBtn && !!icon &&
      slider.disabled === false && muteBtn.disabled === false);

    ok('VV2: initial state — full volume, unmuted, loud icon, slider at 1',
      video.volume === 1 && video.muted === false && icon.textContent === '🔊' && slider.value === '1');

    // --- the slider drives the video element ---
    setSlider(slider, 0.35);
    ok('VV3: slider 0.35 applies exactly to video.volume (icon 🔉)',
      approx(video.volume, 0.35) && video.muted === false && icon.textContent === '🔉' && slider.value === '0.35');

    setSlider(slider, 1);
    ok('VV4: upper boundary 1.0 — video.volume exactly 1, loud icon restored',
      video.volume === 1 && icon.textContent === '🔊');

    setSlider(slider, 0);
    ok('VV5: lower boundary 0.0 — video.volume exactly 0, mute icon, but NOT muted',
      video.volume === 0 && video.muted === false && icon.textContent === '🔇');

    // --- mute / unmute with lastVolume memory ---
    setSlider(slider, 0.7);
    ok('VV6: back to 0.7 — loud icon, muted styling cleared',
      approx(video.volume, 0.7) && icon.textContent === '🔊' && !muteBtn.classList.contains('muted'));

    click(muteBtn);
    ok('VV7: mute click sets video.muted while the level stays on the element (0.7)',
      video.muted === true && approx(video.volume, 0.7) && icon.textContent === '🔇' && muteBtn.classList.contains('muted'));

    click(muteBtn);
    ok('VV8: unmute restores the pre-muted level exactly (0.7)',
      video.muted === false && approx(video.volume, 0.7) && icon.textContent === '🔊' && !muteBtn.classList.contains('muted'));

    // muted, then dragged to zero, then unmute -> lastVolume memory restores 0.4
    setSlider(slider, 0.4);
    click(muteBtn);
    setSlider(slider, 0);
    ok('VV9a: muted + dragged to 0 — volume 0, still muted, mute icon',
      video.volume === 0 && video.muted === true && icon.textContent === '🔇');
    click(muteBtn);
    ok('VV9b: unmute from zero restores the pre-muted level from lastVolume memory (0.4)',
      video.muted === false && approx(video.volume, 0.4) && icon.textContent === '🔉' && slider.value === '0.4');

    // dragging the slider while muted unmutes immediately at the new level
    click(muteBtn);
    setSlider(slider, 0.25);
    ok('VV10: moving the slider while muted unmutes at the new level (0.25)',
      video.muted === false && approx(video.volume, 0.25) && icon.textContent === '🔉');

    // --- volume survives seeks ---
    setSlider(slider, 0.45);
    const scrub = doc.getElementById('scrub');
    scrub.value = '500';
    changeEvent(scrub);
    ok('VV11: seeking leaves the volume untouched (currentTime moved to 50, volume kept 0.45)',
      Math.abs(video.currentTime - 50) < 1e-9 && approx(video.volume, 0.45) && video.muted === false);

    // --- volume survives a second video load (source-change cycle) ---
    click(doc.getElementById('btnLoadSession'));
    await sleep(350);
    fireLoadedMetadata(video);
    await sleep(30);
    ok('VV12: a second load of the session keeps the analyst volume (0.45, not reset to 1)',
      approx(video.volume, 0.45) && slider.value === '0.45' && icon.textContent === '🔉' &&
      slider.disabled === false && muteBtn.disabled === false);

    V.dom.window.close();
  }

  // =====================================================================
  section('BOOT V2 — detach/reattach source-change cycle preserves volume');
  // =====================================================================
  {
    const V = boot();
    const doc = V.doc;
    V.stub._setLoadSession(videoSessionFixture('/tmp/detach.mp4', 'file:///tmp/detach.mp4'));
    await sleep(300);
    click(doc.getElementById('btnLoadSession'));
    await sleep(350);

    const video = simulateLoadedVideo(doc, 100, 5000);
    fireLoadedMetadata(video);
    await sleep(30);

    const slider = doc.getElementById('videoVolumeSlider');
    const muteBtn = doc.getElementById('volumeMuteBtn');
    const icon = doc.getElementById('volumeIcon');
    setSlider(slider, 0.55);

    click(doc.getElementById('btnDetachVideo'));
    await sleep(300); // async detachVideo IPC resolves, then local teardown
    ok('VV13: detached — main video element is sourceless and the volume controls disable honestly',
      video.getAttribute('src') === null && slider.disabled === true && muteBtn.disabled === true,
      'src=' + video.getAttribute('src'));
    ok('VV13b: transport stays live while detached (play/pause forwards to the detached window)',
      doc.getElementById('btnPlayPause').disabled === false);

    const onClosed = V.stub._getOnVideoClosed();
    ok('VV14: reattach callback is registered (onVideoClosed captured)', typeof onClosed === 'function');
    onClosed();
    await sleep(50);
    ok('VV15: reattached — src restored and volume controls re-enabled',
      video.getAttribute('src') === 'file:///tmp/detach.mp4' && slider.disabled === false && muteBtn.disabled === false);

    fireLoadedMetadata(video);
    await sleep(30);
    ok('VV16: the full detach→reattach cycle preserves the analyst volume (0.55)',
      approx(video.volume, 0.55) && video.muted === false && icon.textContent === '🔊' && slider.value === '0.55');
    ok('VV17: reattach still restores the playback position (existing restore path intact)',
      Math.abs(video.currentTime - 100) < 1e-9);

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
  console.log('---- video volume check: ' + pass + ' passed, ' + fail + ' failed ----');
  console.log('NOTE: jsdom does not decode media or render audio. volume/muted are');
  console.log('real settable HTMLMediaElement properties in jsdom, so the state');
  console.log('machine, boundaries, restore memory, and persistence across');
  console.log('load/seek/detach cycles are verified against the live element;');
  console.log('play()/pause()/load() are instance-patched no-ops (same simulation');
  console.log('technique as the other harnesses). Real audio output and the native');
  console.log('slider rendering in Electron still require manual verification.');
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('HARNESS CRASH:', err && err.stack ? err.stack : err);
  process.exit(1);
});
