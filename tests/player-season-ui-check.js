// PitchLog — Player & Season Data Engine V1 UI check (jsdom)
// Verifies the minimal season-view integration (task Part 28):
//   - the season view renders the season engine output (not legacy stats)
//   - coverage line, legend (RECORDED/DERIVED/UNAVAILABLE), team + player
//     tables, minutes quality tags, per-90 columns, gates, footer
//   - duplicate session handling, determinism of the rendered HTML
//   - forbidden names absent from the rendered output
// Boots the REAL index.html + integrity.js + analytics.js +
// player-season.js + renderer.js with a stubbed window.matchtag.

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
function clickOn(win, el) { el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true })); }

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

async function boot(loadMultiple) {
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'file://' + path.join(srcDir, 'index.html') });
  const win = dom.window;
  win.matchtag = baseStub({
    loadMultipleSessions: async () => loadMultiple ? JSON.parse(JSON.stringify(loadMultiple)) : []
  });
  win.eval(integritySrc);
  win.eval(analyticsSrc);
  win.eval(playerSeasonSrc);
  win.eval(rendererSrc);
  await sleep(250);
  return { dom, win, doc: win.document };
}

// ---- fixtures (same shapes as the engine tests, condensed) -----------------

const SQUAD = [
  { id: 'p1', number: '1', name: 'G. Tesfaye' },
  { id: 'p2', number: '2', name: 'B. Worku' },
  { id: 'p3', number: '3', name: 'A. Haile' },
  { id: 'p4', number: '4', name: 'T. Girma' },
  { id: 'p5', number: '5', name: 'K. Alemu' },
  { id: 'p6', number: '6', name: 'N. Desalegn' },
  { id: 'p7', number: '7', name: 'L. Mengistu' },
  { id: 'p8', number: '8', name: 'M. Ahmed' },
  { id: 'p9', number: '9', name: 'S. Bekele' },
  { id: 'p10', number: '10', name: 'D. Bekele' },
  { id: 'p11', number: '11', name: 'R. Kebede' },
  { id: 'p12', number: '12', name: 'S. Chala' },
  { id: 'p15', number: '15', name: 'Y. Fikru' }
];
const XI_TEMPLATE = ['GK', 'RB', 'CB', 'CB', 'LB', 'CDM', 'CM', 'CM', 'RW', 'ST', 'LW'];
const XI_IDS = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p8', 'p10', 'p11', 'p9', 'p7'];

function mkEvent(id, time, period, label, team, playerId, extra) {
  return Object.assign({
    id, time, videoTime: time, matchTime: time, matchSeconds: time,
    officialMinute: Math.ceil(time / 60), second: Math.floor(time) % 60,
    period, label, subtype: null, qualifiers: {}, location: null,
    playerId: playerId || null, playerOffId: null, playerOnId: null,
    side: team === 'our' ? 'for' : (team === 'opponent' ? 'against' : null),
    team: team || null, sequenceId: null,
    scoreForBefore: 0, scoreAgainstBefore: 0,
    scoreForAfter: null, scoreAgainstAfter: null,
    isInterval: false, startTime: null, endTime: null
  }, extra || {});
}

function matchSession(sourceFile, savedAt, date, opponent, ourScore, oppScore) {
  const events = [];
  let id = 1;
  // p8: 6 recoveries (5 located) + 3 turnovers (2 located)
  for (let i = 0; i < 6; i++) {
    events.push(mkEvent(id++, 60 + i * 200, '1H', 'Recovery', 'our', 'p8',
      { location: i < 5 ? { x: 0.2 + (i % 3) * 0.25, y: 0.3 + (i % 2) * 0.3 } : null }));
  }
  for (let i = 0; i < 3; i++) {
    events.push(mkEvent(id++, 1500 + i * 300, '2H', 'Turnover', 'our', 'p8',
      { location: i < 2 ? { x: 0.7, y: 0.4 } : null }));
  }
  // goals 2-1
  events.push(mkEvent(id++, 1800, '1H', 'Goal', 'our', null,
    { scoreForBefore: 0, scoreAgainstBefore: 0, scoreForAfter: 1, scoreAgainstAfter: 0 }));
  events.push(mkEvent(id++, 3000, '2H', 'Goal', 'opponent', null,
    { scoreForBefore: 1, scoreAgainstBefore: 0, scoreForAfter: 1, scoreAgainstAfter: 1 }));
  events.push(mkEvent(id++, 4000, '2H', 'Goal', 'our', null,
    { scoreForBefore: 1, scoreAgainstBefore: 1, scoreForAfter: 2, scoreAgainstAfter: 1 }));
  // sub: p7 off, p12 on at 2700
  events.push(mkEvent(id++, 2700, '2H', 'Sub', 'our', null,
    { playerOffId: 'p7', playerOnId: 'p12' }));
  // p10 passes: 4 successful / 1 unsuccessful
  for (let i = 0; i < 4; i++) events.push(mkEvent(id++, 400 + i * 100, '1H', 'Pass', 'our', 'p10', { qualifiers: { Outcome: 'Successful' } }));
  events.push(mkEvent(id++, 900, '1H', 'Pass', 'our', 'p10', { qualifiers: { Outcome: 'Unsuccessful' } }));
  // possession intervals: our 100-200, opp 400-450
  events.push(mkEvent(id++, 100, '1H', 'Possession', 'our', null,
    { isInterval: true, startTime: 100, endTime: 200 }));
  events.push(mkEvent(id++, 400, '1H', 'Possession', 'opponent', null,
    { isInterval: true, startTime: 400, endTime: 450 }));

  return {
    sourceFile,
    __savedAt: savedAt,
    __schemaVersion: 3,
    videoPath: null,
    tags: [],
    events,
    squad: SQUAD.map((p) => ({ ...p })),
    matchInfo: {
      competition: 'League', date, opponent, venue: 'V', homeAway: 'home',
      ourScore: ourScore, opponentScore: oppScore, formation: '4-3-3',
      startingXI: XI_TEMPLATE.map((position, i) => ({ position, playerId: XI_IDS[i] }))
    },
    matchClock: {
      clockStartedAt: null, clockBaseSeconds: 5400, clockRunning: false,
      period: 'FT', scoreFor: 2, scoreAgainst: 1, videoSyncOffset: 0,
      selectedTeam: 'our', selectedPlayerId: null, activeSequenceId: null, nextSequenceNumber: 1
    }
  };
}

(async () => {
  console.log('== Player & Season Data Engine V1 — season view UI check ==');

  const m1 = matchSession('/ui-m1.json', '2026-08-16T20:00:00Z', '2026-08-15', 'Riverside FC', '2', '1');
  const m2 = matchSession('/ui-m2.json', '2026-08-23T20:00:00Z', '2026-08-22', 'Northport', '1', '2');
  // m2 must LOSE 1-2 consistently: flip the third goal to the opponent and
  // rebuild the score chain (manual 1-2 == chain 1-2 → X1 MATCH, result L).
  m2.events = m2.events.map((e) => {
    if (e.label === 'Goal' && e.time === 1800) return e; // our 1-0
    if (e.label === 'Goal' && e.time === 3000) return e; // 1-1
    if (e.label === 'Goal' && e.time === 4000) {
      return { ...e, team: 'opponent', side: 'against', scoreForBefore: 1, scoreAgainstBefore: 1, scoreForAfter: 1, scoreAgainstAfter: 2 };
    }
    return e;
  });
  m2.matchClock = { ...m2.matchClock, scoreFor: 1, scoreAgainst: 2 };

  // =========================================================================
  // Boot A — 2 sessions: full season render
  // =========================================================================
  {
    const { win, doc } = await boot([m1, m2]);
    const content = doc.getElementById('seasonStatsContent');

    ok('S1 season engine loaded as window.PlayerSeasonEngine',
      typeof win.PlayerSeasonEngine === 'object' && typeof win.PlayerSeasonEngine.computeSeason === 'function', '');

    clickOn(win, doc.getElementById('btnSeasonView'));
    await sleep(50);
    ok('S2 season modal opens', doc.getElementById('seasonModal').style.display === 'flex', '');
    ok('S3 empty state before adding matches', /Load one or more match sessions above/.test(content.textContent), '');

    clickOn(win, doc.getElementById('btnAddSeasonMatches'));
    await sleep(300);

    const matchRows = doc.querySelectorAll('#seasonMatchList .season-match-row');
    ok('S4 both sessions listed', matchRows.length === 2, 'rows=' + matchRows.length);

    const html1 = content.innerHTML;
    const txt = content.textContent;
    ok('S3b stats content rendered (not the empty state)', html1.length > 500, 'len=' + html1.length);

    // --- header + coverage + legend ---
    ok('S5 team season section header', /Team season data/.test(txt), '');
    ok('S6 player season section header', /Player season data \(tagged events\)/.test(txt), '');
    ok('S7 coverage line', /Matches in database: 2 · Unique: 2 · Complete records: 2 · Partial records: 0/.test(txt), txt.slice(0, 300));
    ok('S8 legend RECORDED', /RECORDED — counted directly from tagged events/.test(txt), '');
    ok('S9 legend DERIVED', /DERIVED — computed from recorded counts/.test(txt), '');
    ok('S10 legend UNAVAILABLE', /UNAVAILABLE — insufficient data/.test(txt), '');

    // --- team table ---
    ok('S11 team W/D/L = 1/0/1 (W home, L away)', /<tr>\s*<td>2<\/td><td>1<\/td><td>0<\/td><td>1<\/td>/.test(html1), '');
    ok('S12 goals for 3, against 3', /Goals for \[R\]<\/th>/.test(html1) && /<td>3<\/td><td>3<\/td>/.test(html1), '');
    ok('S13 tagged totals table present', /Tagged event totals \[R\]/.test(txt), '');
    ok('S14 pooled pass success rendered (4/5 + 4/5 = 8/10 = 80%)', /Pass success \(pooled\) \[D\]<\/td><td>80%/.test(html1), '');
    ok('S15 tagged possession seconds note (NC-1 basis)', /not an official match possession statistic \(NC-1\)/.test(txt), '');
    ok('S16 located/unlocated reported', /Us 14 located \/ 21 unlocated · Opponent 0 located \/ 5 unlocated/.test(txt), txt.slice(txt.indexOf('Located tagged'), txt.indexOf('Located tagged') + 120));

    // --- player table ---
    ok('S17 player row M. Ahmed present', /M\. Ahmed \(8\)/.test(html1), '');
    ok('S18 p8 apps 2, starts 2', /M\. Ahmed \(8\)<\/td>\s*<td>2<\/td><td>2<\/td><td>0<\/td><td>0<\/td>/.test(html1), '');
    ok('S19 p8 minutes 180 (reliable)', /<td>180<\/td><td><span class="sn-qual sn-qual-reliable">reliable<\/span>/.test(html1), '');
    // columns: Goals 0 Shots 0 SoT 0 Chances 0 KeyP 0 Passes 0 Pass% — Rec 12 Int 0 Press 0 PressW 0 TO 6 Rec/90 6 TO/90 3
    ok('S20 p8 recoveries 12, turnovers 6', /<td>0<\/td>\s*<td>0<\/td>\s*<td>0<\/td>\s*<td>0<\/td>\s*<td>0<\/td>\s*<td>0<\/td>\s*<td>—<\/td>\s*<td>12<\/td>\s*<td>0<\/td>\s*<td>0<\/td>\s*<td>0<\/td>\s*<td>6<\/td>\s*<td>6<\/td>\s*<td>3<\/td>/.test(html1), '');
    // per-90: 12 recoveries over 180 reliable minutes = 6.0
    ok('S21 p8 per-90 recoveries 6', /<td>6<\/td><td>3<\/td>/.test(html1), '');
    ok('S22 p10 pass% 80% (8/12 known-outcome pooled)', /D\. Bekele \(10\)/.test(html1) && /80%/.test(html1), '');
    ok('S23 p15 unused: 2 unused, 0 apps, — minutes', /Y\. Fikru \(15\)<\/td>\s*<td>0<\/td><td>0<\/td><td>0<\/td><td>2<\/td>/.test(html1), '');
    ok('S24 unused substitute note rendered', /Unused = squad-listed, never started, never substituted on/.test(txt), '');

    // --- gates / quality ---
    ok('S25 no-warning state', /No data-quality warnings for the loaded matches/.test(txt), '');
    ok('S26 minutes quality summary line', /reliable 24 · estimated 0 · unavailable 2/.test(txt), txt.slice(-400));
    ok('S27 engine footer', /Player & Season Data Engine 1\.0\.0/.test(txt) && /deterministic/.test(txt), '');

    // --- forbidden names absent (naming constraints) ---
    const forbidden = [/form score/i, /player rating/i, /performance score/i, /\btrend/i, /improving/i, /declining/i,
      /\bAI\b/, /Possession %/, /heat map/i, /field tilt/i, /possession map/i];
    forbidden.forEach((re) => {
      ok('S28 forbidden name absent: ' + re, !re.test(txt), '');
    });

    // --- determinism of the rendered HTML ---
    clickOn(win, doc.getElementById('btnCloseSeasonModal'));
    await sleep(50);
    clickOn(win, doc.getElementById('btnSeasonView'));
    await sleep(100);
    ok('S29 re-open renders byte-identical HTML', html1 === content.innerHTML, '');

    // --- live add: a duplicate of m1 is excluded at the loader level AND the
    //     engine gates would catch a same-sourceFile duplicate if passed twice
    const dup = JSON.parse(JSON.stringify(m1));
    win.matchtag.loadMultipleSessions = async () => [dup];
    clickOn(win, doc.getElementById('btnAddSeasonMatches'));
    await sleep(250);
    const matchRows2 = doc.querySelectorAll('#seasonMatchList .season-match-row');
    ok('S30 duplicate sourceFile NOT added twice (loader dedupe)', matchRows2.length === 2, 'rows=' + matchRows2.length);
    ok('S31 totals unchanged after duplicate attempt', /Matches in database: 2 · Unique: 2/.test(content.textContent), '');

    // --- remove one match: re-render reflects it ---
    const removeBtn = content.previousElementSibling.querySelector('.season-match-remove');
    if (removeBtn) {
      clickOn(win, removeBtn);
      await sleep(200);
      ok('S32 match removed, view re-rendered', /Matches in database: 1 · Unique: 1/.test(content.textContent), content.textContent.slice(0, 200));
    }
  }

  // =========================================================================
  // Boot B — problem session (no FT, no XI, unresolved player): gates render
  // =========================================================================
  {
    const bad = matchSession('/ui-bad.json', '2026-09-06T20:00:00Z', '2026-09-05', 'Hawassa', '', '');
    bad.matchInfo.formation = '';
    bad.matchInfo.startingXI = [];
    bad.matchClock.period = '2H';
    bad.matchClock.clockBaseSeconds = 3540;
    bad.events[0].playerId = 'pUnknown9'; // unresolved reference

    const { win, doc } = await boot([bad]);
    const content = doc.getElementById('seasonStatsContent');
    clickOn(win, doc.getElementById('btnSeasonView'));
    await sleep(50);
    clickOn(win, doc.getElementById('btnAddSeasonMatches'));
    await sleep(300);

    const txt = content.textContent;
    ok('S33 partial match coverage line', /Matches in database: 1 · Unique: 1 · Complete records: 0 · Partial records: 1/.test(txt), txt.slice(0, 220));
    ok('S34 no-FT gate line', /No full-time marker: 1 match/.test(txt), '');
    ok('S35 starting XI gate line', /Starting XI missing or incomplete: 1 match/.test(txt), '');
    ok('S36 minutes quality: unavailable present', /unavailable \d+/.test(txt), '');
    ok('S37 minutes fall back note (ESTIMATED, never per-90)', /minutes fall back to last-known evidence \(ESTIMATED, never per-90\)/.test(txt), '');
    ok('S38 Unknown player rendered for unresolved id', /Unknown player/.test(txt), '');
    ok('S39 no result flag shown (chain 2-1 W from goal events)', /<td>1<\/td><td>0<\/td><td>0<\/td>/.test(content.innerHTML), '');
    ok('S40 per-90 cells show — for players without reliable minutes', /—<\/td><td>—<\/td><td>—<\/td><td>—<\/td>/.test(content.innerHTML), '');
  }

  // =========================================================================
  // Boot C — empty: no matches loaded
  // =========================================================================
  {
    const { win, doc } = await boot([]);
    const content = doc.getElementById('seasonStatsContent');
    clickOn(win, doc.getElementById('btnSeasonView'));
    await sleep(50);
    ok('S41 empty state message preserved', /Load one or more match sessions above to see combined totals/.test(content.textContent), '');
  }

  // --- summary ---------------------------------------------------------------
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass);
  console.log('\n---- player-season UI check: ' + passed + ' passed, ' + failed.length + ' failed ----');
  if (failed.length) {
    console.log('FAILURES:');
    failed.forEach((f) => console.log('  ✗ ' + f.name + (f.detail ? ' — ' + f.detail : '')));
  }
  process.exit(failed.length ? 1 : 0);
})();
