#!/usr/bin/env node
// PitchLog / MatchTag — Spatial section UI wiring check (functional, jsdom)
// =====================================================================
// Companion to tests/spatial-engine-tests.js. Boots the REAL index.html +
// integrity.js + analytics.js + renderer.js into jsdom with a stubbed
// window.matchtag and functionally verifies the Spatial & Heat-Map Engine
// V1 UI (docs/spatial-heatmap-specification.md §5, §6):
//
//   SP-UI-1  recovered session (23 events incl. the spatial oracle fixture)
//            -> Spatial section renders: completeness line, limitation +
//            orientation notes, SP-X1/SP-X2 gates, filter bar, Us +
//            Opponent grids (fills + printed counts + event dots + legend),
//            minimum-sample null state with the exact approved message,
//            byZone/byThird/byChannel tables, full 19-key matrix, player
//            small multiples + table, Tagged Possession Duration by Zone
//            with the NC-1 basis and exact unrounded-derived seconds.
//   SP-UI-2  naming prohibitions (spec §6.2) in the rendered spatial HTML.
//   SP-UI-3  filters: Event (scope) / Team / Period / State / Sequence /
//            Player re-render the section from computeSpatialView output.
//   SP-UI-4  cell traceability: click a zone cell -> its located events
//            listed read-only; click again -> closed.
//   SP-UI-5  determinism: re-open renders byte-identical HTML.
//   SP-UI-6  live refresh: tagging an event while the tab is visible.
//   SP-UI-7  pitch-map modal: Team filter (v3 semantics) + 3×3 zone toggle.
//   SP-UI-8  X1 MISMATCH: score-state filter disabled + suppressed note.
//
// jsdom is NOT a project dependency: it lives only in the git-ignored
// tests/.jsdom-scratch folder (same as the other UI checks).
//
// Run:  node tests/spatial-ui-check.js   (from the pitchlog root)

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
  await sleep(250);
  return { dom, win, doc: win.document };
}

// Robust class query in jsdom (SVG elements: use the class attribute).
function qsaClass(doc, cls, root) {
  const scope = root || doc;
  return Array.from(scope.querySelectorAll('*')).filter((el) => {
    const c = el.getAttribute && el.getAttribute('class');
    return c && c.split(/\s+/).indexOf(cls) !== -1;
  });
}

// The 23-event spatial oracle fixture (same as tests/spatial-engine-tests.js).
function spatialAutosave(matchInfoOverrides) {
  const E = (id, time, fields) => Object.assign({
    id, time, matchTime: time, label: null, team: null, subtype: null,
    playerId: null, playerOffId: null, playerOnId: null,
    qualifiers: {}, location: null, period: '1H', matchSeconds: time,
    officialMinute: Math.ceil(time / 60), second: Math.floor(time) % 60,
    scoreForBefore: 0, scoreAgainstBefore: 0,
    scoreForAfter: null, scoreAgainstAfter: null,
    sequenceId: null, isInterval: false, startTime: null, endTime: null
  }, fields);
  return {
    __schemaVersion: 3,
    __savedAt: new Date().toISOString(),
    videoPath: null,
    videoUrl: null,
    tags: [],
    squad: [
      { id: 'pA', number: '9', name: 'Alpha' },
      { id: 'pB', number: '8', name: 'Bravo' }
    ],
    matchInfo: Object.assign({
      opponent: 'Spatial FC', date: '2024-06-01', competition: 'Test League',
      homeAway: 'home', formation: '4-3-3', ourScore: '1', opponentScore: '1'
    }, matchInfoOverrides || {}),
    matchClock: {
      period: '2H', seconds: 2800, running: false,
      scoreFor: 1, scoreAgainst: 1,
      selectedTeam: 'our', selectedPlayerId: null,
      activeSequenceId: null, videoSyncOffset: 0
    },
    events: [
      E(1, 130, { label: 'Shot', team: 'our', playerId: 'pA', subtype: 'On target', location: { x: 0.9, y: 0.5 }, sequenceId: 'SEQ-001' }),
      E(2, 200, { label: 'Shot', team: 'our', playerId: 'pA', subtype: 'Off target', location: { x: 0.88, y: 0.78 }, sequenceId: 'SEQ-001' }),
      E(3, 300, { label: 'Goal', team: 'our', playerId: 'pA', location: { x: 0.95, y: 0.5 }, sequenceId: 'SEQ-001', scoreForAfter: 1, scoreAgainstAfter: 0 }),
      E(4, 400, { label: 'Pass', team: 'our', playerId: 'pB', subtype: 'Progressive', location: { x: 0.5, y: 0.5 }, scoreForBefore: 1, scoreAgainstBefore: 0 }),
      E(5, 500, { label: 'Pass', team: 'our', playerId: 'pB', scoreForBefore: 1, scoreAgainstBefore: 0 }),
      E(6, 600, { label: 'Shot', team: 'opponent', subtype: 'On target', location: { x: 0.12, y: 0.6 }, scoreForBefore: 1, scoreAgainstBefore: 0 }),
      E(7, 700, { label: 'Goal', team: 'opponent', location: { x: 0.05, y: 0.5 }, scoreForBefore: 1, scoreAgainstBefore: 0, scoreForAfter: 1, scoreAgainstAfter: 1 }),
      E(8, 800, { label: 'Foul', team: 'our', playerId: 'pB', qualifiers: { Zone: 'Defensive third' }, location: { x: 0.85, y: 0.5 }, scoreForBefore: 1, scoreAgainstBefore: 1 }),
      E(9, 900, { label: 'Possession', team: 'our', isInterval: true, startTime: 900, endTime: 1201.5, qualifiers: { 'Ended by': 'Shot' }, location: { x: 0.5, y: 0.5 }, period: '2H', scoreForBefore: 1, scoreAgainstBefore: 1 }),
      E(10, 1300, { label: 'Possession', team: 'our', isInterval: true, startTime: 1300, endTime: 1418, qualifiers: { 'Ended by': 'Turnover' }, period: '2H', scoreForBefore: 1, scoreAgainstBefore: 1 }),
      E(11, 1500, { label: 'Possession', team: 'opponent', isInterval: true, startTime: 1500, endTime: 1562.2, qualifiers: { 'Ended by': 'Out of play' }, location: { x: 0.2, y: 0.5 }, period: '2H', scoreForBefore: 1, scoreAgainstBefore: 1 }),
      E(12, 1600, { label: 'Possession', team: 'opponent', isInterval: true, startTime: 1600, endTime: 1609.84, qualifiers: { 'Ended by': 'Foul won' }, period: '2H', scoreForBefore: 1, scoreAgainstBefore: 1 }),
      E(13, 1700, { label: 'Possession', team: null, isInterval: true, startTime: 1700, endTime: 1740, location: { x: 0.35, y: 0.2 }, period: '2H', scoreForBefore: 1, scoreAgainstBefore: 1 }),
      E(14, 1800, { label: 'Turnover', team: 'our', playerId: 'pB', location: { x: 0.15, y: 0.5 }, period: '2H', sequenceId: 'SEQ-002', scoreForBefore: 1, scoreAgainstBefore: 1 }),
      E(15, 1900, { label: 'Recovery', team: 'our', playerId: 'pA', location: { x: 0.1, y: 0.8 }, period: '2H', sequenceId: 'SEQ-002', scoreForBefore: 1, scoreAgainstBefore: 1 }),
      E(16, 2000, { label: 'Press', team: 'our', playerId: 'pB', location: { x: 0.7, y: 0.3 }, period: '2H', sequenceId: 'SEQ-002', scoreForBefore: 1, scoreAgainstBefore: 1 }),
      E(17, 2100, { label: 'Press Win', team: 'our', playerId: 'pB', location: { x: 0.75, y: 0.25 }, period: '2H', sequenceId: 'SEQ-002', scoreForBefore: 1, scoreAgainstBefore: 1 }),
      E(18, 2200, { label: 'Opponent Overload', team: 'opponent', location: { x: 0.4, y: 0.9 }, period: '2H', scoreForBefore: 1, scoreAgainstBefore: 1 }),
      E(19, 2300, { label: 'Opponent Overload', team: 'opponent', period: '2H', scoreForBefore: 1, scoreAgainstBefore: 1 }),
      E(20, 2400, { label: 'Sub', team: 'our', playerId: 'pB', playerOffId: 'pB', playerOnId: 'pC', location: { x: 0.5, y: 0.5 }, period: '2H', scoreForBefore: 1, scoreAgainstBefore: 1 }),
      E(21, 2500, { label: 'Shot', team: 'our', subtype: 'Off target', location: { x: 1.2, y: 0.5 }, period: '2H', scoreForBefore: 1, scoreAgainstBefore: 1 }),
      E(22, 2600, { label: 'Shot', team: 'our', subtype: 'Blocked', location: { x: 'bad', y: 0.5 }, period: '2H', scoreForBefore: 1, scoreAgainstBefore: 1 }),
      E(23, 2700, { label: 'Chance', team: 'our', playerId: 'pA', location: { x: 0.85, y: 0.55 }, period: '2H', scoreForBefore: 1, scoreAgainstBefore: 1 })
    ]
  };
}

(async () => {
  // =========================================================================
  // Boot B — recovered session: full spatial render (SP-UI-1, SP-UI-2)
  // =========================================================================
  console.log('== SP-UI-1/2. recovered session: spatial section render ==');
  const fixture = spatialAutosave();
  const { win, doc } = await boot(fixture, fixture.squad);
  const tabAnalytics = doc.getElementById('tabAnalytics');
  const tabEvents = doc.getElementById('tabEvents');
  const analyticsPanelEl = doc.getElementById('analyticsPanel');
  const analyticsContentEl = doc.getElementById('analyticsContent');
  const eventCountEl = doc.getElementById('eventCount');
  const btnRecoverAutosave = doc.getElementById('btnRecoverAutosave');

  ok('B1 recovery modal offered', !!btnRecoverAutosave, '');
  btnRecoverAutosave.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(200);
  ok('B2 23 events recovered', eventCountEl.textContent === '23', 'count=' + eventCountEl.textContent);

  tabAnalytics.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(100);
  ok('B3 analytics panel visible', analyticsPanelEl.style.display === 'block', '');

  const anSpatial = doc.getElementById('anSpatial');
  ok('B4 spatial container rendered', !!anSpatial && anSpatial.innerHTML.length > 0, '');
  const spText = anSpatial.textContent;
  const spHtml = anSpatial.innerHTML;

  // header + section label
  ok('B5 section label "Spatial — Tagged Event Density (3×3)"',
    /Spatial — Tagged Event Density \(3×3\)/.test(analyticsContentEl.textContent), '');

  // completeness line (approved Part 9 format)
  ok('B6 completeness line exact format',
    /Total tagged events: 23 · Located: 18 \(78\.3%\) · Unlocated: 5/.test(spText), spText.slice(0, 160));

  // standing notes (spec §6.3 exact strings)
  ok('B7 limitation string (analyst-tagged samples)', /analyst-tagged samples of tagged events only/.test(spText), '');
  ok('B8 orientation note (T2)', /Orientation per tagging protocol T2/.test(spText), '');
  ok('B9 out-of-range advisory rendered', /1 located event\(s\) have coordinates outside \[0,1\]/.test(spText), '');

  // spatial gates
  ok('B10 SP-X1 line with located share', /SP-X1 location completeness: 18\/23 located \(78\.3%\)/.test(spText), '');
  ok('B11 SP-X2 foul Zone-qualifier disagreements = 1', /SP-X2 foul Zone-qualifier vs location disagreements: 1/.test(spText), '');

  // filter bar
  const filters = qsaClass(doc, 'an-sp-filter', anSpatial);
  ok('B12 six filter selects rendered', filters.length === 6, 'count=' + filters.length);
  const filterKeys = filters.map((s) => s.getAttribute('data-filter')).sort().join(',');
  ok('B13 filter keys scope/team/period/state/sequence/player',
    filterKeys === 'period,player,scope,sequence,state,team', filterKeys);
  const scopeSel = filters.find((s) => s.getAttribute('data-filter') === 'scope');
  ok('B14 scope options include custom tag', scopeSel && Array.from(scopeSel.options).some((o) => o.value === 'Opponent Overload'), '');
  const playerSel = filters.find((s) => s.getAttribute('data-filter') === 'player');
  ok('B15 player options resolved from squad', playerSel && Array.from(playerSel.options).some((o) => o.textContent === '9 Alpha'), '');

  // density grids: our (13 located, filled) + opponent (4 located, insufficient).
  // (The possession-duration grids reuse .an-grid-wrap further down; the
  // density grids are the ones containing .an-zcell cells and come first.)
  const gridWraps = qsaClass(doc, 'an-grid-wrap', anSpatial);
  const densityWraps = gridWraps.filter((w) => qsaClass(doc, 'an-zcell', w).length > 0);
  ok('B16 two density grid blocks rendered (Us + Opponent; duration grids excluded)',
    densityWraps.length === 2, 'density=' + densityWraps.length + ' total=' + gridWraps.length);
  const ourWrap = densityWraps[0];
  const oppWrap = densityWraps[1];
  ok('B17 our grid heading with located share', /All events — Us · 13\/16 located events \(81\.3%\)/.test(ourWrap.textContent), ourWrap.textContent.slice(0, 80));
  ok('B18 opponent grid heading', /All events — Opponent · 4\/6 located events/.test(oppWrap.textContent), '');

  const ourCells = qsaClass(doc, 'an-zcell', ourWrap);
  ok('B19 our grid has 9 clickable zone cells', ourCells.length === 9, 'count=' + ourCells.length);
  const ourFilled = ourCells.filter((c) => (c.getAttribute('style') || '').indexOf('rgba(216, 30, 46') !== -1);
  ok('B20 our grid cells filled with the fixed deterministic scale', ourFilled.length >= 6, 'filled=' + ourFilled.length);
  ok('B21 no gradient/blur in fills (discrete rgba steps only)',
    ourFilled.every((c) => /^fill:rgba\(216, 30, 46, 0\.(22|42|62|82)\);$/.test(c.getAttribute('style'))),
    ourFilled.slice(0, 2).map((c) => c.getAttribute('style')).join(' | '));
  const ourCounts = qsaClass(doc, 'an-zcount', ourWrap);
  jeq('B22 our grid printed cell counts (numbers before color)',
    ourCounts.map((t) => t.textContent), ['1', '1', '3', '2', '5', '1']);
  const ourDots = qsaClass(doc, 'an-dot', ourWrap);
  ok('B23 our grid draws 13 actual event dots', ourDots.length === 13, 'count=' + ourDots.length);
  const goalDots = qsaClass(doc, 'an-dot-goal', ourWrap);
  ok('B24 goal dot ringed', goalDots.length === 1, 'count=' + goalDots.length);
  ok('B25 our grid legend with max', /max = 5 \(busiest cell\)/.test(ourWrap.textContent), '');

  ok('B26 opponent grid below minimum sample: exact approved message',
    /Insufficient tagged locations for spatial visualization\./.test(oppWrap.textContent), '');
  ok('B27 insufficient message shows the actual located count', /\(4 located events in this view/.test(oppWrap.textContent), '');
  const oppFilled = qsaClass(doc, 'an-zcell', oppWrap).filter((c) => c.getAttribute('style'));
  ok('B28 insufficient grid draws NO density fills', oppFilled.length === 0, 'filled=' + oppFilled.length);
  ok('B29 insufficient grid still shows the 4 actual dots', qsaClass(doc, 'an-dot', oppWrap).length === 4, '');
  ok('B30 unlocated strips rendered', /Unlocated: 3 \(18\.8% of selection\)/.test(ourWrap.textContent) && /Unlocated: 2 \(33\.3% of selection\)/.test(oppWrap.textContent), ourWrap.textContent.slice(-140));

  // numeric tables
  const zoneRows = Array.from(anSpatial.querySelectorAll('tr')).filter((tr) => tr.cells && tr.cells[0] && tr.cells[0].textContent === 'Attacking third · Central channel');
  ok('B31 byZone table: Att·C row with 5 events', zoneRows.length >= 1 && zoneRows[0].cells[1].textContent === '5', '');
  const unlocRow = Array.from(anSpatial.querySelectorAll('tr')).filter((tr) => tr.cells && tr.cells[0] && tr.cells[0].textContent === 'Unlocated');
  ok('B32 byZone table: explicit Unlocated row (5 events)', unlocRow.length >= 1 && unlocRow[0].cells[1].textContent === '5', '');
  ok('B33 byThird margin table rendered', /By third \(3×3 margins — current selection\)/.test(spText), '');
  ok('B34 byChannel margin table rendered', /By channel \(3×3 margins — current selection\)/.test(spText), '');
  const matrixRows = qsaClass(doc, 'an-fullmatrix', anSpatial).length
    ? Array.from(qsaClass(doc, 'an-fullmatrix', anSpatial)[0].querySelectorAll('tbody tr')) : [];
  ok('B35 full zone × metric matrix has all 19 bucket-key rows', matrixRows.length === 19, 'rows=' + matrixRows.length);

  // player section
  const playerGrids = qsaClass(doc, 'an-player-grid', anSpatial);
  ok('B36 player small multiples rendered (2 players)', playerGrids.length === 2, 'count=' + playerGrids.length);
  ok('B37 player heads print located counts', /9 Alpha · 5 located/.test(playerGrids[0].textContent) && /8 Bravo · 5 located/.test(playerGrids[1].textContent), playerGrids[0].textContent.slice(0, 40));
  const playerDotsA = qsaClass(doc, 'an-dot', playerGrids[0]);
  ok('B38 player mini grid draws the player\'s 5 dots', playerDotsA.length === 5, 'count=' + playerDotsA.length);
  const playerTableRows = Array.from(anSpatial.querySelectorAll('tbody tr')).filter((tr) => tr.cells && tr.cells[0] && /^(9 Alpha|8 Bravo)/.test(tr.cells[0].textContent) && tr.cells.length === 12);
  ok('B39 player × zone table (2 rows, 9 zones + Unloc + Tot)', playerTableRows.length === 2, 'rows=' + playerTableRows.length);

  // possession duration section
  ok('B40 duration section canonical name', /Tagged Possession Duration by Zone \(recorded interval tags only\)/.test(spText), '');
  ok('B41 duration NC-1 basis line', /not an official match possession statistic \(NC-1\)/.test(spText), '');
  ok('B42 our unrounded-derived seconds in cells (301.5)', /301\.5/.test(spText), '');
  ok('B43 our tagged total (419.5s)', /Tagged total: 419\.5s/.test(spText), '');
  ok('B44 opponent seconds + total (62.2 / 72s)', /62\.2/.test(spText) && /Tagged total: 72s/.test(spText), '');
  ok('B45 our unlocated interval seconds reported (118s)', /118s not shown on the pitch/.test(spText), '');
  ok('B46 unattributed intervals excluded note', /Unattributed intervals: 1 \(40s\)/.test(spText), '');

  // honesty notes
  ok('B47 phase filter honesty note', /Phase filter: not available — the event model has no phase field/.test(spText), '');
  ok('B48 unattributed located events note', /1 located event\(s\) have no team attributed/.test(spText), '');

  // SP-UI-2 naming prohibitions (spec §6.2) — on the spatial section text
  ok('B49 no "heat map"/"heatmap" artifact label', !/heat\s*map/i.test(spText), '');
  ok('B50 no "field tilt"', !/field tilt/i.test(spText), '');
  ok('B51 no "territory"', !/territory/i.test(spText), '');
  ok('B52 no "average position"', !/average position/i.test(spText), '');
  ok('B53 no "Possession %" row in spatial section', !/Possession %/.test(spText), '');

  function jeq(name, actual, expected) {
    const same = JSON.stringify(actual) === JSON.stringify(expected);
    ok(name, same, 'actual=' + JSON.stringify(actual));
  }

  // =========================================================================
  // SP-UI-3 — filter interactions (re-render from computeSpatialView)
  // =========================================================================
  console.log('== SP-UI-3. filters ==');
  function setFilter(key, value) {
    const sel = qsaClass(doc, 'an-sp-filter', anSpatial).find((s) => s.getAttribute('data-filter') === key);
    sel.value = value;
    sel.dispatchEvent(new win.Event('change', { bubbles: true }));
  }

  setFilter('scope', 'Shot');
  await sleep(50);
  ok('B54 scope=Shot: completeness 5/4/1', /Total tagged events: 5 · Located: 4 \(80%\) · Unlocated: 1/.test(anSpatial.textContent), anSpatial.textContent.slice(0, 110));
  ok('B55 scope=Shot: grid head "Shot — Us"', /Shot — Us · 3\/4 located events/.test(anSpatial.textContent), '');
  ok('B56 scope=Shot: our grid now 3 dots', qsaClass(doc, 'an-dot', qsaClass(doc, 'an-grid-wrap', anSpatial)[0]).length === 3, '');
  setFilter('scope', '__all__');
  await sleep(50);

  setFilter('team', 'opponent');
  await sleep(50);
  const focusWraps = qsaClass(doc, 'an-grid-wrap', anSpatial).filter((w) => qsaClass(doc, 'an-zcell', w).length > 0);
  ok('B57 team=opponent: single focused density grid', focusWraps.length === 1 && /All events — Opponent · 4\/6 located events/.test(focusWraps[0].textContent), focusWraps[0] && focusWraps[0].textContent.slice(0, 60));
  setFilter('team', '__all__');
  await sleep(50);

  setFilter('period', '1H');
  await sleep(50);
  ok('B58 period=1H: completeness 8/7/1', /Total tagged events: 8 · Located: 7 \(87\.5%\)/.test(anSpatial.textContent), anSpatial.textContent.slice(0, 110));
  setFilter('period', '__all__');
  await sleep(50);

  setFilter('state', 'WINNING');
  await sleep(50);
  ok('B59 state=WINNING: completeness 4/3', /Total tagged events: 4 · Located: 3 \(75%\)/.test(anSpatial.textContent), anSpatial.textContent.slice(0, 110));
  setFilter('state', '__all__');
  await sleep(50);

  setFilter('sequence', 'SEQ-001');
  await sleep(50);
  ok('B60 sequence=SEQ-001: 3 located', /Total tagged events: 3 · Located: 3 \(100%\)/.test(anSpatial.textContent), anSpatial.textContent.slice(0, 110));
  setFilter('sequence', '__all__');
  await sleep(50);

  setFilter('player', 'pA');
  await sleep(50);
  const pWraps = qsaClass(doc, 'an-grid-wrap', anSpatial);
  ok('B61 player=pA: single player grid with squad name', pWraps.length === 1 && /Player: 9 Alpha · 5\/5 located events \(100%\)/.test(pWraps[0].textContent), pWraps[0] && pWraps[0].textContent.slice(0, 60));
  const teamSelNow = qsaClass(doc, 'an-sp-filter', anSpatial).find((s) => s.getAttribute('data-filter') === 'team');
  ok('B62 team filter disabled while a player is selected', teamSelNow.disabled === true, '');
  setFilter('player', '__all__');
  await sleep(50);
  ok('B63 team filter re-enabled when player cleared', qsaClass(doc, 'an-sp-filter', anSpatial).find((s) => s.getAttribute('data-filter') === 'team').disabled === false, '');

  // =========================================================================
  // SP-UI-4 — cell traceability (click a zone cell -> its events)
  // =========================================================================
  console.log('== SP-UI-4. cell traceability ==');
  const attCCell = qsaClass(doc, 'an-zcell', anSpatial).find((c) =>
    c.getAttribute('data-grid') === 'grid:scope=all:partition=our' &&
    c.getAttribute('data-zone') === 'Attacking third · Central channel');
  ok('B64 our Att·C cell found', !!attCCell, '');
  attCCell.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(50);
  const traceRows = qsaClass(doc, 'an-trace-row', anSpatial);
  ok('B65 trace lists the 5 located events of the cell', traceRows.length === 5, 'rows=' + traceRows.length);
  const traceText = qsaClass(doc, 'an-trace', anSpatial)[0].textContent;
  ok('B66 trace rows carry label/subtype/player/team/event id',
    /Shot · On target/.test(traceText) && /Shot · Off target/.test(traceText) &&
    /Goal/.test(traceText) && /Foul/.test(traceText) && /Chance/.test(traceText) &&
    /9 Alpha/.test(traceText) && /8 Bravo/.test(traceText) && /Us/.test(traceText) &&
    qsaClass(doc, 'an-trace-id', anSpatial).some((s) => s.textContent === '#1') &&
    qsaClass(doc, 'an-trace-id', anSpatial).some((s) => s.textContent === '#21'),
    traceText.slice(0, 200));
  ok('B67 trace header names the zone + count', /Attacking third · Central channel — 5 located events/.test(traceText), '');

  // click the same cell again -> closes
  const attCCell2 = qsaClass(doc, 'an-zcell', anSpatial).find((c) =>
    c.getAttribute('data-grid') === 'grid:scope=all:partition=our' &&
    c.getAttribute('data-zone') === 'Attacking third · Central channel');
  attCCell2.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(50);
  ok('B68 clicking the open cell again closes the trace', qsaClass(doc, 'an-trace-row', anSpatial).length === 0, '');

  // =========================================================================
  // SP-UI-5 — determinism (byte-identical re-render)
  // =========================================================================
  console.log('== SP-UI-5. determinism ==');
  const html1 = analyticsContentEl.innerHTML;
  tabEvents.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(50);
  tabAnalytics.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(100);
  ok('B69 re-open renders byte-identical HTML (incl. spatial section)',
    html1 === analyticsContentEl.innerHTML, '');

  // =========================================================================
  // SP-UI-6 — live refresh while the tab is visible
  // =========================================================================
  console.log('== SP-UI-6. live refresh ==');
  const tagButtons = Array.from(doc.querySelectorAll('#tagButtons .tag-btn'));
  const foulBtn = tagButtons.find((b) => b.textContent.trim().startsWith('Foul'));
  ok('B70 Foul tag button found', !!foulBtn, '');
  foulBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(150);
  ok('B71 event count incremented to 24', eventCountEl.textContent === '24', 'count=' + eventCountEl.textContent);
  ok('B72 spatial completeness refreshed (24 total, 18 located, 75%)',
    /Total tagged events: 24 · Located: 18 \(75%\) · Unlocated: 6/.test(doc.getElementById('anSpatial').textContent),
    doc.getElementById('anSpatial').textContent.slice(0, 120));

  // =========================================================================
  // SP-UI-7 — pitch-map modal: team filter + zone overlay toggle
  // =========================================================================
  console.log('== SP-UI-7. pitch map modal (SP-V6) ==');
  const btnPitchMap = doc.getElementById('btnPitchMap');
  const pitchMapModal = doc.getElementById('pitchMapModal');
  const pitchMapTeamFilter = doc.getElementById('pitchMapTeamFilter');
  const pitchMapZonesToggle = doc.getElementById('pitchMapZonesToggle');
  const pitchMapSvg = doc.getElementById('pitchMapSvg');
  ok('B73 team filter present with 4 v3 options', !!pitchMapTeamFilter &&
    Array.from(pitchMapTeamFilter.options).map((o) => o.value).join(',') === '__all__,our,opponent,unattributed', '');
  ok('B74 legacy side filter removed from the DOM', !doc.getElementById('pitchMapSideFilter'), '');

  btnPitchMap.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(50);
  ok('B75 modal opens', pitchMapModal.style.display === 'flex', '');
  const totalDots = () => qsaClass(doc, 'pitch-map-dot', pitchMapSvg).length;
  const allLocatedDots = totalDots();
  ok('B76 all-teams view shows every located event (18; the freshly tagged Foul is unlocated)',
    allLocatedDots === 18, 'dots=' + allLocatedDots);

  pitchMapTeamFilter.value = 'opponent';
  pitchMapTeamFilter.dispatchEvent(new win.Event('change', { bubbles: true }));
  await sleep(50);
  ok('B77 team filter (v3 semantics) filters to opponent dots (4)', totalDots() === 4, 'dots=' + totalDots());

  pitchMapTeamFilter.value = 'unattributed';
  pitchMapTeamFilter.dispatchEvent(new win.Event('change', { bubbles: true }));
  await sleep(50);
  ok('B78 unattributed option matches team-less events (1)', totalDots() === 1, 'dots=' + totalDots());

  const zoneLinesBefore = qsaClass(doc, 'an-zoneline', pitchMapSvg).length;
  pitchMapZonesToggle.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(50);
  ok('B79 zone toggle adds 3×3 grid lines (4 lines, no shading)',
    zoneLinesBefore === 0 && qsaClass(doc, 'an-zoneline', pitchMapSvg).length === 4, '');
  ok('B80 toggle label updated', pitchMapZonesToggle.textContent === '3×3 zones: on', pitchMapZonesToggle.textContent);

  // =========================================================================
  // SP-UI-8 — X1 MISMATCH: score-state filter suppressed
  // =========================================================================
  console.log('== SP-UI-8. X1 MISMATCH suppression ==');
  {
    const fixMis = spatialAutosave({ ourScore: '5', opponentScore: '0' });
    const mis = await boot(fixMis, fixMis.squad);
    const d = mis.doc, w = mis.win;
    d.getElementById('btnRecoverAutosave').dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
    await sleep(200);
    d.getElementById('tabAnalytics').dispatchClick ? null : d.getElementById('tabAnalytics').dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
    await sleep(100);
    const spMis = d.getElementById('anSpatial');
    const stateSelMis = qsaClass(d, 'an-sp-filter', spMis).find((s) => s.getAttribute('data-filter') === 'state');
    ok('B81 X1 MISMATCH: state filter disabled', stateSelMis && stateSelMis.disabled === true, '');
    ok('B82 X1 MISMATCH: suppression note rendered', /Score-state filter suppressed: score reconciliation MISMATCH \(X1\)/.test(spMis.textContent), '');
    ok('B83 MISMATCH fixture still renders the full spatial section',
      /Total tagged events: 23 · Located: 18 \(78\.3%\)/.test(spMis.textContent), '');
  }

  // --- summary ---------------------------------------------------------------
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass);
  console.log('\n---- spatial UI wiring: ' + passed + ' passed, ' + failed.length + ' failed ----');
  if (failed.length) {
    console.log('FAILURES:');
    failed.forEach((f) => console.log('  ✗ ' + f.name + (f.detail ? ' — ' + f.detail : '')));
    process.exitCode = 1;
  }
  process.exit(failed.length ? 1 : 0);
})();
