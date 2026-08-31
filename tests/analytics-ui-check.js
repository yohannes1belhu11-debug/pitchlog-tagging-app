#!/usr/bin/env node
// PitchLog / MatchTag — Analytics tab UI wiring check (functional, jsdom)
// =====================================================================
// Companion to tests/analytics-engine-tests.js. Boots the REAL index.html
// + integrity.js + analytics.js + renderer.js into jsdom with a stubbed
// window.matchtag (preload bridge) and functionally verifies the Analytics
// tab wiring:
//
//   UI-1  third tab exists; panel hidden until clicked; events/stats panels
//         toggle correctly (existing Events/Stats behaviour preserved).
//   UI-2  empty session -> friendly empty state, no engine crash.
//   UI-3  recovered session (10 events incl. possession intervals, goals
//         with score fields, qualifiers) -> full report renders from the
//         MATCH ANALYTICS OBJECT.
//   UI-4  TAGGED POSSESSION presentation: section named "Tagged possession
//         (recorded intervals only)", "Tagged Possession Share" row, BOTH
//         our + opponent tagged durations, the 67.3% share (computed from
//         UNROUNDED seconds), and the limitation note stating it is NOT an
//         official match possession statistic.
//   UI-5  determinism: re-opening the tab renders byte-identical HTML.
//   UI-6  live refresh: tagging a new event while the Analytics tab is
//         visible re-renders the report (renderStatsPanel hook).
//
// jsdom is NOT a project dependency: it lives only in the git-ignored
// tests/.jsdom-scratch folder (same as renderer-wiring-check.js).
//
// Run:  node tests/analytics-ui-check.js   (from the pitchlog root)

'use strict';

const path = require('path');
const fs = require('fs');

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

const srcDir = path.join(__dirname, '..', 'src');
const html = fs.readFileSync(path.join(srcDir, 'index.html'), 'utf-8');
const integritySrc = fs.readFileSync(path.join(srcDir, 'integrity.js'), 'utf-8');
const analyticsSrc = fs.readFileSync(path.join(srcDir, 'analytics.js'), 'utf-8');
const playerSeasonSrc = fs.readFileSync(path.join(srcDir, 'player-season.js'), 'utf-8');
const rendererSrc = fs.readFileSync(path.join(srcDir, 'renderer.js'), 'utf-8');

const results = [];
function ok(name, cond, detail) {
  results.push({ name, pass: !!cond, detail: detail || '' });
  if (!cond) process.exitCode = 1;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function baseStub(overrides) {
  return Object.assign({
    openVideo: async () => null,
    saveSession: async () => ({ canceled: true }),
    exportCsv: async () => ({ canceled: true }),
    exportClipPlaylist: async () => ({ canceled: true }),
    loadSession: async () => null,
    loadMultipleSessions: async () => [],
    loadSquad: async () => [],
    saveSquad: async () => true,
    detachVideo: async () => true,
    reattachVideo: async () => true,
    sendVideoCommand: () => {},
    onVideoState: () => {},
    onVideoClosed: () => {},
    autosaveRead: async () => null,
    autosaveWrite: async () => ({ ok: true }),
    autosaveDelete: async () => ({ ok: true }),
    autosaveFlushSync: () => ({ ok: true }),
    onCloseRequested: () => {},
    closeProceed: () => {}
  }, overrides || {});
}

async function boot(autosave, squad) {
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'file://' + path.join(srcDir, 'index.html') });
  const win = dom.window;
  win.matchtag = baseStub({
    autosaveRead: async () => autosave ? JSON.parse(JSON.stringify(autosave)) : null,
    loadSquad: async () => squad ? JSON.parse(JSON.stringify(squad)) : []
  });
  win.eval(integritySrc);
  win.eval(analyticsSrc);
  win.eval(playerSeasonSrc);
  win.eval(rendererSrc);
  await sleep(250); // squad load + autosave recovery check
  return { dom, win, doc: win.document };
}

(async () => {
  // =========================================================================
  // Boot A — empty session (no autosave): tab mechanics + empty state
  // =========================================================================
  console.log('== UI-1/UI-2. empty session: tab mechanics + empty state ==');
  {
    const { win, doc } = await boot(null);
    const tabEvents = doc.getElementById('tabEvents');
    const tabStats = doc.getElementById('tabStats');
    const tabAnalytics = doc.getElementById('tabAnalytics');
    const eventListEl = doc.getElementById('eventList');
    const statsPanelEl = doc.getElementById('statsPanel');
    const analyticsPanelEl = doc.getElementById('analyticsPanel');
    const analyticsContentEl = doc.getElementById('analyticsContent');

    ok('A1 analytics tab button exists', !!tabAnalytics, '');
    ok('A2 analytics panel exists', !!analyticsPanelEl, '');
    ok('A3 analytics panel hidden initially', analyticsPanelEl.style.display === 'none', 'display=' + analyticsPanelEl.style.display);
    ok('A4 engine loaded as window.AnalyticsEngine', typeof win.AnalyticsEngine === 'object' &&
      typeof win.AnalyticsEngine.computeMatchAnalytics === 'function', '');

    tabAnalytics.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
    await sleep(50);
    ok('A5 click: analytics panel visible', analyticsPanelEl.style.display === 'block', '');
    ok('A6 click: events list hidden', eventListEl.style.display === 'none', '');
    ok('A7 click: stats panel hidden', statsPanelEl.style.display === 'none', '');
    ok('A8 click: tab marked active, others not', tabAnalytics.classList.contains('active') &&
      !tabEvents.classList.contains('active') && !tabStats.classList.contains('active'), '');
    ok('A9 empty state message shown', /No events tagged yet/.test(analyticsContentEl.textContent), analyticsContentEl.textContent.slice(0, 80));

    tabStats.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
    await sleep(50);
    ok('A10 stats tab still works (analytics hidden again)', analyticsPanelEl.style.display === 'none' &&
      statsPanelEl.style.display === 'block', '');
    tabEvents.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
    await sleep(50);
    ok('A11 events tab still works', eventListEl.style.display === 'block' &&
      analyticsPanelEl.style.display === 'none' && statsPanelEl.style.display === 'none', '');
  }

  // =========================================================================
  // Boot B — recovered session: full report render
  // =========================================================================
  console.log('== UI-3..UI-6. recovered session: full analytics render ==');
  {
    const autosaveFixture = {
      __schemaVersion: 3,
      __savedAt: new Date().toISOString(),
      videoPath: null,
      videoUrl: null,
      tags: [],
      squad: [
        { id: 'player_1', number: '9', name: 'Striker' },
        { id: 'player_2', number: '8', name: 'Midfielder' }
      ],
      matchInfo: {
        opponent: 'UI Test FC', date: '2024-05-01', competition: 'UI League',
        homeAway: 'home', formation: '4-3-3', ourScore: '2', opponentScore: '1'
      },
      matchClock: {
        period: '2H', seconds: 2700, running: false,
        scoreFor: 2, scoreAgainst: 1,
        selectedTeam: 'our', selectedPlayerId: 'player_2',
        activeSequenceId: null, videoSyncOffset: 0
      },
      events: [
        { id: 1, time: 100, matchTime: 100, label: 'Pass', team: 'our', playerId: 'player_2',
          playerOffId: null, playerOnId: null, subtype: 'Progressive',
          qualifiers: { Outcome: 'Successful', Pressure: 'Under pressure' },
          location: { x: 0.5, y: 0.5 }, period: '1H', matchSeconds: 100, officialMinute: 1, second: 40,
          scoreForBefore: 0, scoreAgainstBefore: 0, scoreForAfter: null, scoreAgainstAfter: null,
          sequenceId: null, isInterval: false, startTime: null, endTime: null },
        { id: 2, time: 130, matchTime: 130, label: 'Shot', team: 'our', playerId: 'player_1',
          playerOffId: null, playerOnId: null, subtype: 'On target',
          qualifiers: { Situation: 'Open play' },
          location: { x: 0.9, y: 0.5 }, period: '1H', matchSeconds: 130, officialMinute: 2, second: 10,
          scoreForBefore: 0, scoreAgainstBefore: 0, scoreForAfter: null, scoreAgainstAfter: null,
          sequenceId: 'SEQ-001', isInterval: false, startTime: null, endTime: null },
        { id: 3, time: 131, matchTime: 131, label: 'Chance', team: 'our', playerId: 'player_1',
          playerOffId: null, playerOnId: null, subtype: null, qualifiers: {},
          location: { x: 0.9, y: 0.6 }, period: '1H', matchSeconds: 131, officialMinute: 2, second: 11,
          scoreForBefore: 0, scoreAgainstBefore: 0, scoreForAfter: null, scoreAgainstAfter: null,
          sequenceId: 'SEQ-001', isInterval: false, startTime: null, endTime: null },
        { id: 4, time: 200, matchTime: 200, label: 'Goal', team: 'our', playerId: 'player_1',
          playerOffId: null, playerOnId: null, subtype: null, qualifiers: { 'Body part': 'Right foot' },
          location: { x: 0.95, y: 0.5 }, period: '1H', matchSeconds: 200, officialMinute: 3, second: 20,
          scoreForBefore: 0, scoreAgainstBefore: 0, scoreForAfter: 1, scoreAgainstAfter: 0,
          sequenceId: 'SEQ-001', isInterval: false, startTime: null, endTime: null },
        { id: 5, time: 2800, matchTime: 2800, label: 'Foul', team: 'our', playerId: 'player_2',
          playerOffId: null, playerOnId: null, subtype: null, qualifiers: { Zone: 'Defensive third' },
          location: { x: 0.1, y: 0.2 }, period: '1H', matchSeconds: 2800, officialMinute: 45, second: 20,
          scoreForBefore: 1, scoreAgainstBefore: 0, scoreForAfter: null, scoreAgainstAfter: null,
          sequenceId: null, isInterval: false, startTime: null, endTime: null },
        { id: 6, time: 2800, matchTime: 2800, label: 'Possession', team: 'our', playerId: null,
          playerOffId: null, playerOnId: null, subtype: null, qualifiers: { 'Ended by': 'Shot' },
          location: null, period: '2H', matchSeconds: 2800, officialMinute: 46, second: 40,
          scoreForBefore: 1, scoreAgainstBefore: 0, scoreForAfter: null, scoreAgainstAfter: null,
          sequenceId: null, isInterval: true, startTime: 2800, endTime: 2804.04 },
        { id: 7, time: 2802, matchTime: 2802, label: 'Shot', team: 'our', playerId: 'player_1',
          playerOffId: null, playerOnId: null, subtype: 'Off target', qualifiers: {},
          location: { x: 0.85, y: 0.8 }, period: '2H', matchSeconds: 2802, officialMinute: 46, second: 42,
          scoreForBefore: 1, scoreAgainstBefore: 0, scoreForAfter: null, scoreAgainstAfter: null,
          sequenceId: null, isInterval: false, startTime: null, endTime: null },
        { id: 8, time: 3000, matchTime: 3000, label: 'Possession', team: 'opponent', playerId: null,
          playerOffId: null, playerOnId: null, subtype: null, qualifiers: { 'Ended by': 'Turnover' },
          location: null, period: '2H', matchSeconds: 3000, officialMinute: 50, second: 0,
          scoreForBefore: 1, scoreAgainstBefore: 0, scoreForAfter: null, scoreAgainstAfter: null,
          sequenceId: null, isInterval: true, startTime: 3000, endTime: 3001.96 },
        { id: 9, time: 3300, matchTime: 3300, label: 'Goal', team: 'opponent', playerId: null,
          playerOffId: null, playerOnId: null, subtype: null, qualifiers: {},
          location: { x: 0.05, y: 0.5 }, period: '2H', matchSeconds: 3300, officialMinute: 55, second: 0,
          scoreForBefore: 1, scoreAgainstBefore: 0, scoreForAfter: 1, scoreAgainstAfter: 1,
          sequenceId: null, isInterval: false, startTime: null, endTime: null },
        { id: 10, time: 3600, matchTime: 3600, label: 'Goal', team: 'our', playerId: 'player_1',
          playerOffId: null, playerOnId: null, subtype: null, qualifiers: {},
          location: { x: 0.95, y: 0.5 }, period: '2H', matchSeconds: 3600, officialMinute: 60, second: 0,
          scoreForBefore: 1, scoreAgainstBefore: 1, scoreForAfter: 2, scoreAgainstAfter: 1,
          sequenceId: null, isInterval: false, startTime: null, endTime: null }
      ]
    };

    const { win, doc } = await boot(autosaveFixture, autosaveFixture.squad);
    const tabEvents = doc.getElementById('tabEvents');
    const tabAnalytics = doc.getElementById('tabAnalytics');
    const analyticsPanelEl = doc.getElementById('analyticsPanel');
    const analyticsContentEl = doc.getElementById('analyticsContent');
    const eventCountEl = doc.getElementById('eventCount');
    const btnRecoverAutosave = doc.getElementById('btnRecoverAutosave');

    // Recover the autosaved session (injects the 10 fixture events)
    ok('B1 recovery modal offered', !!btnRecoverAutosave, '');
    btnRecoverAutosave.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
    await sleep(200);
    ok('B2 10 events recovered', eventCountEl.textContent === '10', 'count=' + eventCountEl.textContent);

    tabAnalytics.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
    await sleep(100);
    ok('B3 analytics panel visible', analyticsPanelEl.style.display === 'block', '');

    const html1 = analyticsContentEl.innerHTML;
    const text = analyticsContentEl.textContent;

    // --- header / gates / summary ------------------------------------------
    ok('B4 title rendered', /Match analytics/.test(text), '');
    ok('B5 opponent rendered', /UI Test FC/.test(text), '');
    ok('B6 chain score rendered 2–1', /2–1/.test(text) && /goal chain, 3 attributed/.test(text), text.slice(0, 200));
    ok('B7 X1 reconciliation MATCH rendered', /X1 score reconciliation:\s*MATCH/.test(text), '');
    ok('B8 validation clean rendered', /Validation: clean/.test(text), '');
    ok('B9 X2 unattributed events 0 (both possession rows are team-attributed)', /X2 unattributed events: 0/.test(text), text.match(/X2[^\n]{0,40}/) && text.match(/X2[^\n]{0,40}/)[0]);

    // --- team comparison -----------------------------------------------------
    ok('B10 Level 1 table rendered with our goals 2', /Goals<\/td><td class="an-our">2<\/td>/.test(html1), '');
    ok('B11 our shots on target 1', /Shots on target<\/td><td class="an-our">1<\/td>/.test(html1), '');
    ok('B12 shot accuracy 50% (blocked excluded, envelope)', /50% \(1\/2\)/.test(text), '');
    ok('B13 pass success rendered with num/den', /100% \(1\/1\)/.test(text), '');

    // --- TAGGED POSSESSION presentation (task directive) --------------------
    ok('B14 possession section explicitly named "Tagged possession (recorded intervals only)"',
      /Tagged possession \(recorded intervals only\)/.test(text), '');
    ok('B15 share row named "Tagged Possession Share"', /Tagged Possession Share/.test(text), '');
    ok('B16 share value 67.3% (UNROUNDED seconds: 4.04/6.0, not 66.7)', /67\.3%/.test(text), text.slice(text.indexOf('Tagged Possession'), text.indexOf('Tagged Possession') + 120));
    ok('B17 our tagged duration reported (4s)', /Tagged possession duration<\/td><td class="an-our">4s/.test(html1), '');
    ok('B18 opponent tagged duration reported (2s)', /Tagged possession duration<\/td><td class="an-our">4s<\/td><td class="an-opp">2s/.test(html1), '');
    ok('B19 limitation note states NOT an official match possession statistic',
      /NOT an official match possession statistic/.test(text), '');
    ok('B20 limitation note reports coverage of nominal match time',
      /% of nominal match time tagged/.test(text), '');
    ok('B21 no metric row/section labelled "Possession %" (the method-note'
      + ' prohibition text may mention the banned label)',
      !/>Possession %<\/td>/.test(html1) && !/>Possession %<\/th>/.test(html1) &&
      !/class="stats-section-label">Possession %/.test(html1), '');
    ok('B22 method notes include the tagged-possession protocol note',
      /TAGGED_POSSESSION_SHARE/.test(text) && /complete independent possession dataset/.test(text), '');

    // --- score state / players / method -------------------------------------
    ok('B23 score state changes 3 rendered', /State changes/.test(text) && /3<\/td>/.test(html1), '');
    ok('B24 player table rendered with squad names', /Striker/.test(text) && /Midfielder/.test(text), '');
    ok('B25 player interpretive note rendered', /interpretation layer, not a player-quality/.test(text), '');
    ok('B26 method notes rendered', /Method notes/.test(text) && /TAGGED_UNIVERSE/.test(text), '');
    ok('B27 engine version footer', /engine v\d+\.\d+\.\d+ · deterministic/.test(text), '');

    // --- determinism: re-open renders identical HTML ------------------------
    tabEvents.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
    await sleep(50);
    tabAnalytics.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
    await sleep(100);
    const html2 = analyticsContentEl.innerHTML;
    ok('B28 re-open renders byte-identical HTML (determinism)', html1 === html2,
      'len1=' + html1.length + ' len2=' + html2.length);

    // --- live refresh: tag an event while analytics is visible ----------------
    const tagButtons = Array.from(doc.querySelectorAll('#tagButtons .tag-btn'));
    const foulBtn = tagButtons.find((b) => b.textContent.trim().startsWith('Foul'));
    ok('B29 Foul tag button found', !!foulBtn, '');
    if (foulBtn) {
      foulBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
      await sleep(150);
      ok('B30 event count incremented to 11', eventCountEl.textContent === '11', 'count=' + eventCountEl.textContent);
      ok('B31 analytics re-rendered while visible (Fouls 2, events used 11)',
        /Fouls<\/td><td class="an-our">2<\/td>/.test(analyticsContentEl.innerHTML) &&
        /Events used<\/td><td class="an-our">11<\/td>/.test(analyticsContentEl.innerHTML), '');
    }
  }

  // --- summary ---------------------------------------------------------------
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass);
  console.log('\n---- analytics UI wiring: ' + passed + ' passed, ' + failed.length + ' failed ----');
  if (failed.length) {
    console.log('FAILURES:');
    failed.forEach((f) => console.log('  ✗ ' + f.name + (f.detail ? ' — ' + f.detail : '')));
    process.exitCode = 1;
  }
  // The renderer schedules autosave debounce timers; exit explicitly so the
  // Node event loop is not kept alive by jsdom window timers.
  process.exit(failed.length ? 1 : 0);
})();
