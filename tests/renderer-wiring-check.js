#!/usr/bin/env node
// PitchLog / MatchTag — renderer wiring check (functional, DOM-level)
// =====================================================================
// SMALL, targeted companion to tests/integrity-harness.js. It loads the
// REAL index.html + integrity.js + renderer.js into jsdom with a stubbed
// window.matchtag (preload bridge) and functionally verifies the
// renderer-side wiring of the fixes:
//
//   FIX 2  normal click  -> exactly ONE exportCsv call with the STANDARD
//          CSV header; Shift+Click -> exactly ONE call with the FULL
//          ANALYSIS header (previously both listeners fired).
//   FIX 4  recovery modal shows the missing-player warning BEFORE
//          recovery; recovering shows the explicit toast warning; the
//          current squad is never replaced.
//   FIX 5  bulk-adding players generates collision-free ids alongside
//          mixed-format existing ids (player_abc etc.).
//
// jsdom is NOT a project dependency: it lives only in the git-ignored
// tests/.jsdom-scratch folder. Install it with:
//   cd tests/.jsdom-scratch && npm install jsdom
// (a package.json already exists there so npm does not touch the app).
//
// Run:  node tests/renderer-wiring-check.js   (from the pitchlog root)

'use strict';

const path = require('path');
const fs = require('fs');

// Resolve jsdom from the scratch folder (or override via JSDOM_PATH env).
const jsdomDir = process.env.JSDOM_PATH
  ? process.env.JSDOM_PATH
  : path.join(__dirname, '.jsdom-scratch', 'node_modules');
let JSDOM;
try {
  JSDOM = require(path.join(jsdomDir, 'jsdom')).JSDOM;
} catch (e) {
  console.error('jsdom not found in ' + jsdomDir);
  console.error('Install it with:  cd tests/.jsdom-scratch && npm install jsdom');
  process.exit(2);
}

(async () => {
  const srcDir = path.join(__dirname, '..', 'src');
  const html = fs.readFileSync(path.join(srcDir, 'index.html'), 'utf-8');
  const integritySrc = fs.readFileSync(path.join(srcDir, 'integrity.js'), 'utf-8');
  const rendererSrc = fs.readFileSync(path.join(srcDir, 'renderer.js'), 'utf-8');

  const results = [];
  function ok(name, cond, detail) {
    results.push({ name, pass: !!cond, detail: detail || '' });
    if (!cond) process.exitCode = 1;
  }

  // --- Fixtures ---------------------------------------------------------
  const squadFixture = [
    { id: 'player_1', number: '1', name: 'One' },
    { id: 'player_2', number: '2', name: 'Two' },
    { id: 'player_abc', number: '7', name: 'Imported' } // non-numeric-format id
  ];
  const autosaveFixture = {
    __schemaVersion: 3,
    __savedAt: new Date().toISOString(),
    videoPath: null,
    videoUrl: null,
    tags: [],
    squad: [{ id: 'player_1', number: '1', name: 'One' }], // older snapshot; must NOT replace local squad
    matchInfo: { opponent: 'Wiring FC' },
    matchClock: { period: '2H', scoreFor: 1, scoreAgainst: 0, selectedTeam: 'our', selectedPlayerId: null, activeSequenceId: null, videoSyncOffset: 0 },
    events: [
      { id: 1, time: 10, label: 'Shot', side: 'for', team: 'our', playerId: 'player_1', playerOffId: null, playerOnId: null, qualifiers: {}, location: null },
      { id: 2, time: 20, label: 'Foul', side: 'neutral', team: null, playerId: 'player_9', playerOffId: null, playerOnId: null, qualifiers: {}, location: null },   // missing ref
      { id: 3, time: 30, label: 'Sub', side: null, team: null, playerId: null, playerOffId: 'player_10', playerOnId: 'player_1', qualifiers: {}, location: null } // missing ref
    ]
  };

  // --- window.matchtag stub (mirrors preload.js API) --------------------
  const exportCsvCalls = [];
  const savedSquads = [];
  const stub = {
    openVideo: async () => null,
    saveSession: async () => ({ canceled: true }),
    exportCsv: async (csv) => { exportCsvCalls.push(String(csv)); return { canceled: false, filePath: '/tmp/wiring-export.csv' }; },
    exportClipPlaylist: async () => ({ canceled: true }),
    loadSession: async () => null,
    loadMultipleSessions: async () => [],
    loadSquad: async () => JSON.parse(JSON.stringify(squadFixture)),
    saveSquad: async (s) => { savedSquads.push(JSON.parse(JSON.stringify(s))); return true; },
    detachVideo: async () => true,
    reattachVideo: async () => true,
    sendVideoCommand: () => {},
    onVideoState: () => {},
    onVideoClosed: () => {},
    autosaveRead: async () => JSON.parse(JSON.stringify(autosaveFixture)),
    autosaveWrite: async () => ({ ok: true }),
    autosaveDelete: async () => ({ ok: true }),
    autosaveFlushSync: () => ({ ok: true }),
    onCloseRequested: () => {},
    closeProceed: () => {}
  };

  // --- Boot the real renderer inside jsdom ------------------------------
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'file://' + path.join(srcDir, 'index.html') });
  const win = dom.window;
  win.matchtag = stub;
  win.eval(integritySrc);
  win.eval(rendererSrc);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(200); // let loadSquad().finally(...) -> checkForRecoverableAutosave() run

  const doc = win.document;
  const recoveryModal = doc.getElementById('recoveryModal');
  const recoveryDetails = doc.getElementById('recoveryDetails');
  const autosaveToast = doc.getElementById('autosaveToast');
  const autosaveToastText = doc.getElementById('autosaveToastText');
  const btnExportCsv = doc.getElementById('btnExportCsv');
  const btnRecoverAutosave = doc.getElementById('btnRecoverAutosave');
  const squadBulkInput = doc.getElementById('squadBulkInput');
  const btnAddSquadBulk = doc.getElementById('btnAddSquadBulk');
  const playerSelect = doc.getElementById('selectedPlayerSelect');

  console.log('== FIX 4 — recovery reconciliation wiring (functional) ==');

  ok('recovery modal appeared on startup', recoveryModal && recoveryModal.style.display === 'flex', 'display=' + (recoveryModal && recoveryModal.style.display));
  const detailsHtml = recoveryDetails ? recoveryDetails.innerHTML : '';
  ok('pre-recovery warning present in modal', detailsHtml.includes('Missing players') && detailsHtml.includes('2 recovered events') && detailsHtml.includes('2 players'), detailsHtml.replace(/\s+/g, ' ').slice(0, 200));
  ok('event count shown (3)', detailsHtml.includes('>3<'), '');

  // Recover
  btnRecoverAutosave.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(200);
  ok('recovery closed the modal', recoveryModal.style.display === 'none');
  ok('warning toast shown after recovery', autosaveToast.style.display === 'flex' && /2 recovered events reference 2 players not currently in your squad/.test(autosaveToastText.textContent), 'toast="' + autosaveToastText.textContent + '"');
  // current squad NOT replaced by autosave snapshot: player selector still lists the
  // local 3-player squad (player_abc from squad.json, NOT the 1-player autosave snapshot)
  const optionTexts = Array.from(playerSelect.options).map((o) => o.textContent);
  ok('current squad preserved (not replaced by autosave snapshot)',
    optionTexts.some((t) => t.includes('Imported')) && optionTexts.filter((t) => t !== '— None —').length === 3,
    JSON.stringify(optionTexts));

  console.log('== FIX 2 — CSV export click routing (functional) ==');

  // Normal click -> standard CSV ONLY
  exportCsvCalls.length = 0;
  btnExportCsv.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: false }));
  await sleep(150);
  ok('normal click: exactly ONE export', exportCsvCalls.length === 1, 'calls=' + exportCsvCalls.length);
  ok('normal click: standard CSV header', exportCsvCalls.length === 1 && exportCsvCalls[0].startsWith('timecode,seconds,end_timecode,end_seconds,duration_seconds,label,side,'), (exportCsvCalls[0] || '').slice(0, 60));

  // Shift+Click -> full analysis CSV ONLY
  exportCsvCalls.length = 0;
  btnExportCsv.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true }));
  await sleep(150);
  ok('shift+click: exactly ONE export', exportCsvCalls.length === 1, 'calls=' + exportCsvCalls.length);
  ok('shift+click: full analysis CSV header', exportCsvCalls.length === 1 && exportCsvCalls[0].startsWith('Match ID,Date,Competition,Home Team,Away Team,Opponent,'), (exportCsvCalls[0] || '').slice(0, 60));

  console.log('== REG — basic existing tagging (functional) ==');

  const tagButtons = Array.from(doc.querySelectorAll('#tagButtons .tag-btn'));
  const plainTagBtn = tagButtons.find((b) => !b.textContent.includes('⏱')); // non-interval tag
  const eventListEl = doc.getElementById('eventList');
  const eventCountEl = doc.getElementById('eventCount');
  const btnUndo = doc.getElementById('btnUndo');
  const countBefore = parseInt(eventCountEl.textContent, 10) || 0;
  const rowsBefore = eventListEl.querySelectorAll('.event-row, [data-event-id], .event-item').length;
  ok('tag buttons rendered at bootstrap', tagButtons.length > 0, 'buttons=' + tagButtons.length);
  plainTagBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(100);
  const countAfter = parseInt(eventCountEl.textContent, 10) || 0;
  ok('tag click logged exactly one event (no video loaded)', countAfter === countBefore + 1, countBefore + ' -> ' + countAfter);
  ok('event list gained a row', eventListEl.querySelectorAll('.event-row, [data-event-id], .event-item').length === rowsBefore + 1, '');
  ok('undo enabled after tagging', btnUndo && btnUndo.disabled === false, '');

  console.log('== FIX 5 — collision-safe player id generation (functional wiring) ==');

  savedSquads.length = 0;
  squadBulkInput.value = '9, New Player A\n8, New Player B';
  btnAddSquadBulk.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(200);
  ok('bulk add persisted the squad', savedSquads.length >= 1, 'saves=' + savedSquads.length);
  const lastSquad = savedSquads[savedSquads.length - 1] || [];
  const ids = lastSquad.map((p) => p.id);
  ok('new ids are player_3 / player_4 (first free, no collision)', ids.includes('player_3') && ids.includes('player_4'), JSON.stringify(ids));
  ok('all 5 ids unique (mixed formats coexist)', new Set(ids).size === 5 && ids.includes('player_abc'), JSON.stringify(ids));
  // NOTE: the player-selector dropdown NOT refreshing immediately after a
  // bulk add is PRE-EXISTING behavior (the original handler never called
  // renderPlayerSelector either) — not one of the 8 defects, so it is left
  // untouched and deliberately NOT asserted here.

  // --- Report ------------------------------------------------------------
  console.log('\n== RESULTS ==');
  let pass = 0, fail = 0;
  results.forEach((r) => {
    if (r.pass) pass++; else { fail++; console.log('  FAIL ' + r.name + (r.detail ? '  (' + r.detail + ')' : '')); }
  });
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  console.log(fail === 0 ? '\nALL WIRING CHECKS PASSED' : '\nFAILURES PRESENT');
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error('WIRING CHECK CRASHED:', err);
  process.exit(1);
});
