#!/usr/bin/env node
// PitchLog / MatchTag — F1.3 Autosave Safety regression harness (AS series).
// =====================================================================
// Verification-only harness. It does NOT modify any app source file.
//
// Verifies the F1.3 fixes for the two Phase F0 reliability findings:
//
//  1. UNHANDLED FLUSH FAILURES — the beforeunload flush
//     (flushAutosaveSync → 'autosave:flush-sync') used to discard the
//     {ok,error} result: a close-time write failure silently lost the
//     analyst's unsaved work. Now the renderer consumes the result and
//     surfaces the failure (toast + failure flags), and main shows a
//     native dialog.showErrorBox before returning {ok:false}.
//
//  2. WRITE/DELETE RACES — an async autosave write in flight could settle
//     (or land its rename in main) AFTER clearAutosave()'s delete:
//     stale completions mutated toast/flag state for a session the user
//     had already left, and the stale write could resurrect the autosave
//     file after the delete removed it (obsolete data offered for
//     recovery on next startup). Now: an epoch counter invalidates
//     in-flight write completions (stale = pure no-op), clearAutosave()
//     DRAINS the in-flight write before sending the delete, the
//     dirty-but-no-work cleanup delete routes through the same drain,
//     and main serializes the async write/delete handlers through one
//     queue.
//
// jsdom boots use a stub whose autosaveWrite can be GATED (the IPC
// promise resolves only when the test releases it) and can FAIL on
// demand; the stub also simulates the autosave FILE and keeps an
// operation log so landing order (write vs delete) is assertable.
//
// HONEST SCOPE: main.js cannot run under jsdom (Electron). Its changes
// (operation queue, flush dialog, distinct flush temp file) are verified
// by static source checks only; real fs behavior + the native dialog
// require manual Electron verification.
//
// Run:  node tests/autosave-safety-check.js   (from the project root)
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
const mainSrc = fs.readFileSync(path.join(srcDir, 'main.js'), 'utf-8');

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

// Extract a function's body (between its declaration and the next
// top-level 'function ' keyword) for static checks.
function fnBody(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) return '';
  const next = src.indexOf('\n  function ', start + 10);
  return start > -1 && next > start ? src.slice(start, next) : src.slice(start, start + 3000);
}

// ---------------------------------------------------------------------------
// Static source-level checks
// ---------------------------------------------------------------------------
section('STATIC — F1.3 wiring (source-level checks)');
{
  // --- renderer: race guards ---
  ok('AS-S1: renderer declares the autosave epoch + in-flight write promise',
    /let autosaveWritePromise = null;/.test(rendererSrc) && /let autosaveEpoch = 0;/.test(rendererSrc));

  const clearFn = fnBody(rendererSrc, 'clearAutosave');
  ok('AS-S2: clearAutosave bumps the epoch (stale completions become no-ops)',
    /autosaveEpoch\+\+/.test(clearFn), clearFn ? 'clear body found' : 'clear body missing');
  ok('AS-S3: clearAutosave bumps the epoch BEFORE draining the in-flight write',
    clearFn.indexOf('autosaveEpoch++') > -1 &&
    clearFn.indexOf('autosaveEpoch++') < clearFn.indexOf('await autosaveWritePromise'));
  ok('AS-S4: clearAutosave drains the in-flight write BEFORE sending the delete',
    clearFn.indexOf('await autosaveWritePromise') > -1 &&
    clearFn.indexOf('await autosaveWritePromise') < clearFn.indexOf('autosaveDelete'));

  const perfFn = fnBody(rendererSrc, 'performAutosave');
  ok('AS-S5: performAutosave stores the write promise for draining and clears it after settle',
    /autosaveWritePromise = writePromise/.test(perfFn) &&
    perfFn.indexOf('autosaveWritePromise = null') > perfFn.indexOf('const result = await writePromise'));
  ok('AS-S6: stale write completion performs NO state effects (epoch guard after settle)',
    perfFn.lastIndexOf('if (epochAtStart !== autosaveEpoch) return;') >
      perfFn.indexOf('autosaveWriteInFlight = false;'));
  ok('AS-S7: the reschedule branch does not re-arm a write after a clear (epoch guard)',
    /if \(epochAtStart !== autosaveEpoch\) return;\s*\n\s*autosaveTimer = setTimeout\(performAutosave/.test(perfFn));

  const schedFn = fnBody(rendererSrc, 'scheduleAutosave');
  ok('AS-S8: dirty-but-no-work cleanup delete routes through the draining helper',
    /clearStaleAutosaveFile\(\)/.test(schedFn) && !/autosaveDelete\(\)\.catch/.test(rendererSrc));
  ok('AS-S9: clearStaleAutosaveFile drains the in-flight write before deleting',
    /async function clearStaleAutosaveFile\(\)[\s\S]*?await autosaveWritePromise[\s\S]*?autosaveDelete/.test(rendererSrc));

  // --- renderer: flush failure feedback ---
  const flushFn = fnBody(rendererSrc, 'flushAutosaveSync');
  ok('AS-S10: flushAutosaveSync consumes the flush result (no discarded return)',
    /result = window\.matchtag\.autosaveFlushSync\(/.test(flushFn) &&
    flushFn.indexOf('result = window.matchtag.autosaveFlushSync(') < flushFn.indexOf('if (result && result.ok === false)'));
  ok('AS-S11: flush failure sets failure flags + shows an explicit toast',
    /autosaveLastWriteFailed = true/.test(flushFn) && /Autosave on close failed/.test(flushFn));

  // --- main: serialization, dialog, distinct temp ---
  ok('AS-S12: main defines the autosave operation queue and both async handlers use it',
    /function enqueueAutosaveOp\(op\)/.test(mainSrc) &&
    /ipcMain\.handle\('autosave:write'[\s\S]{0,200}await enqueueAutosaveOp/.test(mainSrc) &&
    /ipcMain\.handle\('autosave:delete'[\s\S]{0,200}await enqueueAutosaveOp/.test(mainSrc));

  ok('AS-S13: the sync flush uses its own temp file (no collision with in-flight async writes)',
    /function autosaveFlushTempPath\(\)/.test(mainSrc) &&
    /const tmp = autosaveFlushTempPath\(\);/.test(fnBody(mainSrc, 'writeAutosaveSync')));

  const flushSyncIdx = mainSrc.indexOf("ipcMain.on('autosave:flush-sync'");
  const flushSyncBlock = flushSyncIdx > -1 ? mainSrc.slice(flushSyncIdx, flushSyncIdx + 2200) : '';
  ok('AS-S14: flush failure shows a native dialog (write-loss and cleanup variants) and still returns {ok:false}',
    flushSyncBlock.includes('dialog.showErrorBox') &&
    (flushSyncBlock.match(/dialog\.showErrorBox/g) || []).length >= 2 &&
    /event\.returnValue = \{ ok: false, error: message \};/.test(flushSyncBlock));

  ok('AS-S15: both delete paths sweep the flush temp file',
    /autosaveFlushTempPath\(\)/.test(fnBody(mainSrc, 'deleteAutosaveSync')) &&
    /autosaveFlushTempPath\(\);[\s\S]{0,400}unlink\(flushTmp\)/.test(mainSrc));

  // --- preservation guards ---
  ok('AS-S16: schema version unchanged (no schema bump)',
    /CURRENT_SCHEMA_VERSION = 3/.test(mainSrc));
  ok('AS-S17: event creation semantics untouched (logEvent pushes before detail panel)',
    /function logEvent\(tag\)[\s\S]{0,900}events\.push\(event\)/.test(rendererSrc) &&
    rendererSrc.indexOf('events.push(event)') < rendererSrc.indexOf('openDetailPanel(tag, event)'));
  ok('AS-S18: save/load flows still funnel through setClean + clearAutosave',
    /setClean\(\);\s*\n\s*await clearAutosave\(\);/.test(rendererSrc) &&
    (rendererSrc.match(/await clearAutosave\(\);/g) || []).length === 4);
}

// ---------------------------------------------------------------------------
// jsdom boots
// ---------------------------------------------------------------------------
function makeStub(initial, opts) {
  const o = opts || {};
  const calls = {
    saveSession: [], saveSquad: [], flushSync: [],
    writeStart: 0, deleteCalls: 0, loadSessionCalls: 0
  };
  const file = { current: null };       // simulated userData/autosave.json
  const log = [];                        // landing-order log {op, seq}
  let seq = 0;
  let gates = [];
  let failNextWrite = false;
  let flushResult = null;
  let loadSessionData = null;

  const stub = {
    openVideo: async () => null,
    saveSession: async (d) => { calls.saveSession.push(clone(d)); return { canceled: false, filePath: '/tmp/as-session.json' }; },
    exportCsv: async () => ({ canceled: true }),
    exportClipPlaylist: async () => ({ canceled: true }),
    loadSession: async () => { calls.loadSessionCalls++; return clone(loadSessionData); },
    loadMultipleSessions: async () => [],
    loadSquad: async () => clone(initial.squad || []),
    saveSquad: async (s) => { calls.saveSquad.push(clone(s)); return true; },
    detachVideo: async () => true,
    reattachVideo: async () => true,
    sendVideoCommand: () => {},
    onVideoState: () => {},
    onVideoClosed: () => {},
    autosaveRead: async () => null,
    autosaveWrite: (data) => new Promise((resolve) => {
      const mySeq = ++seq;
      calls.writeStart++;
      log.push({ op: 'write:start', seq: mySeq });
      const land = () => {
        log.push({ op: 'write:land', seq: mySeq });
        const fail = failNextWrite;
        failNextWrite = false;
        if (fail) resolve({ ok: false, error: 'ENOSPC: test disk full' });
        else { file.current = clone(data); resolve({ ok: true, path: '/tmp/autosave.json' }); }
      };
      if (o.gateWrites) gates.push(land);
      else land();
    }),
    autosaveDelete: async () => {
      const mySeq = ++seq;
      calls.deleteCalls++;
      log.push({ op: 'delete:land', seq: mySeq });
      file.current = null;
      return { ok: true };
    },
    autosaveFlushSync: (data) => {
      calls.flushSync.push(clone(data));
      const r = flushResult != null ? clone(flushResult) : { ok: true };
      if (r.ok) file.current = clone(data); // null data = delete
      return r;
    },
    onCloseRequested: () => {},
    closeProceed: () => {},
    // test controls
    _releaseGates: () => { const g = gates; gates = []; g.forEach((fn) => fn()); },
    _setFailNextWrite: () => { failNextWrite = true; },
    _setFlushResult: (r) => { flushResult = r; },
    _setLoadSession: (d) => { loadSessionData = d; },
    _calls: calls, _file: file, _log: log
  };
  return stub;
}

function boot(initial, opts) {
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => { jsdomErrors.push(String(e.message || e)); });
  vc.on('error', (msg) => { jsdomErrors.push('console.error: ' + String(msg)); });
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'file://' + path.join(srcDir, 'index.html'), virtualConsole: vc });
  const win = dom.window;
  const stub = makeStub(initial, opts);
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
function toastEl(doc) { return doc.getElementById('autosaveToast'); }
function toastShown(doc) { const t = toastEl(doc); return !!t && t.style.display === 'flex'; }
function dirtyText(doc) { const d = doc.getElementById('dirtyIndicator'); return d ? d.textContent : ''; }

const SQUAD = [{ id: 'player_1', number: '1', name: 'Ana One' }];

(async () => {
  // =====================================================================
  section('BOOT R1 — save with in-flight gated write: drain, order, no resurrection');
  // =====================================================================
  {
    const B = boot({ squad: SQUAD }, { gateWrites: true });
    const doc = B.doc;
    await sleep(300);

    // Tag one event, let the debounce fire → W1 pending (gated).
    click(desktopTagBtn(doc, 'Shot'));
    click(doc.getElementById('detailPanelDone'));
    await sleep(1700);
    ok('R1a: debounced write started (W1 in flight, gated)',
      B.stub._calls.writeStart === 1 && B.stub._log.some((l) => l.op === 'write:start'),
      'writeStart=' + B.stub._calls.writeStart);

    // Save while W1 is pending.
    click(doc.getElementById('btnSaveSession'));
    await sleep(150);
    ok('R1b: DRAIN — delete is NOT sent while the write is still in flight',
      B.stub._calls.deleteCalls === 0 && !B.stub._log.some((l) => l.op === 'delete:land'),
      'deletes=' + B.stub._calls.deleteCalls);
    ok('R1b2: the save itself went through (manual save flow intact)',
      B.stub._calls.saveSession.length === 1 && B.stub._calls.saveSession[0].events.length === 1);
    ok('R1c: session marked clean by the save',
      /Saved/.test(dirtyText(doc)), dirtyText(doc));

    // Release W1 → it lands, THEN the delete lands.
    B.stub._releaseGates();
    await sleep(250);
    const writeLand = B.stub._log.find((l) => l.op === 'write:land');
    const deleteLand = B.stub._log.find((l) => l.op === 'delete:land');
    ok('R1d: write landed BEFORE the delete (strict order — no resurrection window)',
      !!writeLand && !!deleteLand && writeLand.seq < deleteLand.seq,
      'write=' + (writeLand && writeLand.seq) + ' delete=' + (deleteLand && deleteLand.seq));
    ok('R1e: autosave file is GONE after the save (stale write did NOT resurrect it)',
      B.stub._file.current === null);
    ok('R1f: delete sent exactly once', B.stub._calls.deleteCalls === 1, 'deletes=' + B.stub._calls.deleteCalls);
    ok('R1g: stale write completion shows NO toast (epoch guard — ok completion, no state effect)',
      !toastShown(doc), 'display=' + (toastEl(doc) ? toastEl(doc).style.display : 'missing'));

    // New work after the save: a fresh write must still be allowed (the
    // epoch must not over-block legitimate post-clear writes).
    click(desktopTagBtn(doc, 'Corner'));
    click(doc.getElementById('detailPanelDone'));
    await sleep(1700);
    ok('R1h: post-save tag schedules a new write (epoch does not over-block)',
      B.stub._calls.writeStart === 2, 'writeStart=' + B.stub._calls.writeStart);
    B.stub._releaseGates();
    await sleep(150);
    ok('R1i: the new write lands and re-creates the autosave for the CURRENT session',
      B.stub._file.current !== null && B.stub._file.current.events.length === 2);
    ok('R1j: no extra delete was triggered by the new write',
      B.stub._calls.deleteCalls === 1, 'deletes=' + B.stub._calls.deleteCalls);

    B.dom.window.close();
  }

  // =====================================================================
  section('BOOT R2 — stale write FAILURE during clear: suppressed, no toast, order kept');
  // =====================================================================
  {
    const B = boot({ squad: SQUAD }, { gateWrites: true });
    const doc = B.doc;
    await sleep(300);

    click(desktopTagBtn(doc, 'Shot'));
    click(doc.getElementById('detailPanelDone'));
    await sleep(1700);
    B.stub._setFailNextWrite(); // the in-flight write will FAIL when released

    click(doc.getElementById('btnSaveSession'));
    await sleep(150);
    B.stub._releaseGates(); // W1 settles with {ok:false} AFTER the clear began
    await sleep(250);

    ok('R2a: stale FAILED completion shows NO failure toast (epoch guard)',
      !toastShown(doc), 'display=' + (toastEl(doc) ? toastEl(doc).style.display : 'missing'));
    ok('R2b: the delete still ran after the failed write settled (drain holds for failures too)',
      B.stub._calls.deleteCalls === 1, 'deletes=' + B.stub._calls.deleteCalls);
    ok('R2c: autosave file gone (failed write wrote nothing to resurrect)',
      B.stub._file.current === null);
    ok('R2d: session clean after save', /Saved/.test(dirtyText(doc)), dirtyText(doc));

    B.dom.window.close();
  }

  // =====================================================================
  section('BOOT R3 — load path (with dirty-guard modal): drain + no resurrection');
  // =====================================================================
  {
    const B = boot({ squad: SQUAD }, { gateWrites: true });
    const doc = B.doc;
    await sleep(300);

    B.stub._setLoadSession({
      __schemaVersion: 3, videoPath: null, videoUrl: null,
      tags: [], events: [{
        id: 1, label: 'Foul', team: 'our', side: 'for', playerId: null,
        playerOffId: null, playerOnId: null, subtype: null, qualifiers: {},
        location: null, isInterval: false, time: 600, videoTime: null,
        matchTime: 600, matchSeconds: 600, officialMinute: 10, second: 0,
        period: '1H', scoreForBefore: 0, scoreAgainstBefore: 0, sequenceId: null
      }],
      squad: SQUAD, matchInfo: { opponent: 'Load FC' },
      matchClock: { clockStartedAt: null, clockBaseSeconds: 600, clockRunning: false, period: '1H',
        scoreFor: 0, scoreAgainst: 0, videoSyncOffset: 0, selectedTeam: 'our', selectedPlayerId: null,
        activeSequenceId: null, nextSequenceNumber: 1 }
    });

    click(desktopTagBtn(doc, 'Shot'));
    click(doc.getElementById('detailPanelDone'));
    await sleep(1700); // W1 (pre-load session) in flight, gated

    // Dirty load → the e801766 guard modal must appear first.
    click(doc.getElementById('btnLoadSession'));
    await sleep(100);
    const guard = doc.getElementById('loadConfirmModal');
    ok('R3a: dirty load shows the confirmation guard (guard intact)',
      !!guard && guard.style.display === 'flex', 'display=' + (guard ? guard.style.display : 'missing'));

    click(doc.getElementById('btnLoadConfirmProceed'));
    await sleep(200); // loadSession resolves, state replaced, clearAutosave draining W1
    ok('R3b: while the pre-load write is in flight, no delete has been sent (drain)',
      B.stub._calls.deleteCalls === 0, 'deletes=' + B.stub._calls.deleteCalls);
    ok('R3c: the loaded session event is rendered (load flow intact)',
      doc.querySelectorAll('#eventList .event-row').length === 1 &&
      /Foul/.test(doc.querySelector('#eventList .event-row').textContent));

    B.stub._releaseGates();
    await sleep(250);
    ok('R3d: pre-load write landed BEFORE the delete',
      (() => { const w = B.stub._log.find((l) => l.op === 'write:land'); const d = B.stub._log.find((l) => l.op === 'delete:land'); return !!w && !!d && w.seq < d.seq; })());
    ok('R3e: autosave file gone after load (no stale-session resurrection)',
      B.stub._file.current === null);
    ok('R3f: loaded session clean', /Saved/.test(dirtyText(doc)), dirtyText(doc));

    B.dom.window.close();
  }

  // =====================================================================
  section('BOOT F1 — flush FAILURE on close: visible, explicit feedback');
  // =====================================================================
  {
    const B = boot({ squad: SQUAD });
    const doc = B.doc;
    await sleep(300);

    click(desktopTagBtn(doc, 'Shot'));
    click(doc.getElementById('detailPanelDone'));
    await sleep(50); // dirty, before the debounce fires

    B.stub._setFlushResult({ ok: false, error: 'EIO: test disk full' });
    B.win.dispatchEvent(new B.win.Event('beforeunload'));
    await sleep(50);

    ok('F1a: the flush was actually called with the unsaved session (non-null data)',
      B.stub._calls.flushSync.length === 1 && B.stub._calls.flushSync[0] !== null &&
      B.stub._calls.flushSync[0].events.length === 1);
    ok('F1b: flush failure surfaces a VISIBLE toast (was silently discarded before F1.3)',
      toastShown(doc), 'display=' + (toastEl(doc) ? toastEl(doc).style.display : 'missing'));
    ok('F1c: the toast text names the failure and the risk',
      /Autosave on close failed/.test(toastEl(doc).textContent) &&
      /EIO/.test(toastEl(doc).textContent) &&
      /may be lost/.test(toastEl(doc).textContent),
      toastEl(doc).textContent.slice(0, 90));

    B.dom.window.close();
  }

  // =====================================================================
  section('BOOT F2 — flush SUCCESS + clean session: silent, deletes stale file');
  // =====================================================================
  {
    const B = boot({ squad: SQUAD });
    const doc = B.doc;
    await sleep(300);

    B.win.dispatchEvent(new B.win.Event('beforeunload'));
    await sleep(50);

    ok('F2a: clean session flush sends null (delete semantics)',
      B.stub._calls.flushSync.length === 1 && B.stub._calls.flushSync[0] === null);
    ok('F2b: successful flush shows NO toast',
      !toastShown(doc), 'display=' + (toastEl(doc) ? toastEl(doc).style.display : 'missing'));

    B.dom.window.close();
  }

  // =====================================================================
  section('BOOT N1 — normal lifecycle intact: coalescing, failure toast, save, re-dirty');
  // =====================================================================
  {
    const B = boot({ squad: SQUAD });
    const doc = B.doc;
    await sleep(300);

    // Two quick tags → ONE coalesced write.
    click(desktopTagBtn(doc, 'Shot'));
    click(doc.getElementById('detailPanelDone'));
    click(desktopTagBtn(doc, 'Corner'));
    click(doc.getElementById('detailPanelDone'));
    ok('N1a: session dirty immediately after tagging',
      /Unsaved/.test(dirtyText(doc)), dirtyText(doc));
    await sleep(1900);
    ok('N1b: two rapid tags coalesce into exactly ONE write (no double-write)',
      B.stub._calls.writeStart === 1, 'writeStart=' + B.stub._calls.writeStart);
    ok('N1c: the coalesced write carries both events',
      B.stub._file.current !== null && B.stub._file.current.events.length === 2);
    ok('N1d: autosave keeps the session dirty (write does not clean)',
      /Unsaved/.test(dirtyText(doc)), dirtyText(doc));

    // A genuine write failure still shows the existing failure toast.
    B.stub._setFailNextWrite();
    click(desktopTagBtn(doc, 'Foul'));
    click(doc.getElementById('detailPanelDone'));
    await sleep(1900);
    ok('N1e: failed write shows the existing Autosave-failed toast (feedback preserved)',
      toastShown(doc) && /Autosave failed/.test(toastEl(doc).textContent) && /ENOSPC/.test(toastEl(doc).textContent),
      toastEl(doc) ? toastEl(doc).textContent.slice(0, 70) : 'no toast');

    // Manual save: clean, toast hidden, file cleared.
    click(doc.getElementById('btnSaveSession'));
    await sleep(250);
    ok('N1f: manual save clears the failure toast and the autosave file',
      !toastShown(doc) && B.stub._file.current === null);
    ok('N1g: manual save saved the full session (3 events) and marked it clean',
      B.stub._calls.saveSession.length === 1 && B.stub._calls.saveSession[0].events.length === 3 &&
      /Saved/.test(dirtyText(doc)));
    ok('N1h: exactly one delete for the save',
      B.stub._calls.deleteCalls === 1, 'deletes=' + B.stub._calls.deleteCalls);

    // Re-dirty: a fresh write must happen (no missed dirty state).
    click(desktopTagBtn(doc, 'Goal'));
    click(doc.getElementById('detailPanelDone'));
    await sleep(100);
    ok('N1i: tagging after save re-marks the session dirty (no missed dirty)',
      /Unsaved/.test(dirtyText(doc)), dirtyText(doc));
    await sleep(1800);
    ok('N1j: a fresh write lands for the re-dirtied session',
      B.stub._calls.writeStart === 3 && B.stub._file.current !== null && B.stub._file.current.events.length === 4,
      'writeStart=' + B.stub._calls.writeStart);

    // Data intact end-to-end.
    ok('N1k: event list intact (4 events, no corruption through the lifecycle)',
      doc.querySelectorAll('#eventList .event-row').length === 4,
      'rows=' + doc.querySelectorAll('#eventList .event-row').length);

    B.dom.window.close();
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
  console.log('---- autosave safety check: ' + pass + ' passed, ' + fail + ' failed ----');
  console.log('NOTE: main.js (Electron) cannot run under jsdom. The main-side');
  console.log('guards (op queue, flush dialog, distinct flush temp) are verified');
  console.log('statically; real fs serialization and the native error dialog');
  console.log('require manual Electron verification.');
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('HARNESS CRASH:', err && err.stack ? err.stack : err);
  process.exit(1);
});
