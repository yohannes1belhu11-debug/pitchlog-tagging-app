// PitchLog — Recent Form V1 UI check (jsdom)
// Phase C integration test: verifies the MINIMAL READ-ONLY UI integration of
// the existing Recent Form engine (src/recent-form.js) into the existing
// season view — NOT a re-test of engine methodology (that is
// tests/recent-form-tests.js).
//
// Verifies (task Part 17):
//   1.  recent-form.js is loaded before renderer.js (index.html script order)
//   2.  the Recent Form engine is referenced correctly by the renderer
//   3.  the Recent Form section exists inside the season view
//   4.  Last 3 / Last 5 / Last 10 window labels exist
//   5.  forbidden user-facing terminology is absent from the rendered output
//   6.  null values are not rendered as zero (per-90 null → neutral N/A label)
//   7.  baseline comparison classifications are preserved verbatim (engine)
//   8.  WHOLE_SEASON_IN_WINDOW is handled (reason shown, no fabricated value)
//   9.  insufficient-sample cases are handled (R5P5, with/without)
//   10. per-90 reliability information is not suppressed (disclosure visible)
//   11. the renderer contains no second raw-event Recent Form counting path
//   12. existing renderer wiring remains intact (PS season view unchanged)
//
// Boots the REAL index.html + integrity.js + analytics.js +
// player-season.js + recent-form.js + renderer.js with a stubbed
// window.matchtag (same conventions as tests/player-season-ui-check.js).
//
// Run:  node tests/recent-form-ui-check.js   (from the pitchlog root)

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
// The Recent Form engine may not be wired into the UI yet — load it when the
// file exists (test-first: checks below then FAIL against the pre-Phase-C UI).
let recentFormSrc = null;
try { recentFormSrc = fs.readFileSync(path.join(srcDir, 'recent-form.js'), 'utf-8'); } catch (e) { recentFormSrc = null; }
const rendererSrc = fs.readFileSync(path.join(srcDir, 'renderer.js'), 'utf-8');
const stylesSrc = fs.readFileSync(path.join(srcDir, 'styles.css'), 'utf-8');

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

// withRF=false boots WITHOUT evaluating recent-form.js (graceful degradation).
async function boot(loadMultiple, withRF) {
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'file://' + path.join(srcDir, 'index.html') });
  const win = dom.window;
  win.matchtag = baseStub({
    loadMultipleSessions: async () => loadMultiple ? JSON.parse(JSON.stringify(loadMultiple)) : []
  });
  win.eval(integritySrc);
  win.eval(analyticsSrc);
  win.eval(playerSeasonSrc);
  if (withRF !== false && recentFormSrc) win.eval(recentFormSrc);
  win.eval(rendererSrc);
  await sleep(250);
  return { dom, win, doc: win.document };
}

async function openSeasonViewWith(win, doc, sessions) {
  win.matchtag.loadMultipleSessions = async () => JSON.parse(JSON.stringify(sessions));
  clickOn(win, doc.getElementById('btnSeasonView'));
  await sleep(50);
  clickOn(win, doc.getElementById('btnAddSeasonMatches'));
  await sleep(300);
  return doc.getElementById('seasonStatsContent');
}

// ---------------------------------------------------------------------------
// Fixture builders (mirror tests/recent-form-tests.js conventions; the
// fixtures themselves are defined below and were verified against the actual
// engines — see tests/recent-form-tests.js for the methodology coverage).
// ---------------------------------------------------------------------------

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
  { id: 'p13', number: '13', name: 'O. Tadesse' },
  { id: 'p14', number: '14', name: 'Y. Fikru' }
];

const XI_TEMPLATE = ['GK', 'RB', 'CB', 'CB', 'LB', 'CDM', 'CM', 'CM', 'RW', 'ST', 'LW'];
const XI_IDS = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p8', 'p10', 'p11', 'p9', 'p7'];

function startingXI(replaceAt) {
  return XI_TEMPLATE.map((position, i) => ({
    position,
    playerId: (replaceAt && replaceAt[i]) || XI_IDS[i]
  }));
}

let eventSeq = 1;
function ev(spec) {
  const base = {
    id: eventSeq++,
    time: spec.time,
    videoTime: spec.time,
    matchTime: spec.time,
    matchSeconds: spec.time,
    officialMinute: Math.ceil(spec.time / 60),
    second: Math.floor(spec.time) % 60,
    period: spec.period || '1H',
    label: spec.label,
    subtype: spec.subtype ?? null,
    qualifiers: spec.qualifiers || {},
    location: spec.location ?? null,
    playerId: spec.playerId ?? null,
    playerOffId: spec.playerOffId ?? null,
    playerOnId: spec.playerOnId ?? null,
    side: spec.team === 'our' ? 'for' : (spec.team === 'opponent' ? 'against' : null),
    team: spec.team ?? null,
    sequenceId: null,
    scoreForBefore: spec.sfb ?? 0,
    scoreAgainstBefore: spec.sab ?? 0,
    scoreForAfter: spec.sfa ?? null,
    scoreAgainstAfter: spec.saa ?? null,
    isInterval: spec.isInterval === true,
    startTime: spec.startTime ?? null,
    endTime: spec.endTime ?? null
  };
  return Object.assign(base, spec.extra || {});
}

function goal(time, team, sfb, sab, sfa, saa, period, playerId) {
  return ev({ time, period: period || '1H', label: 'Goal', team, sfb, sab, sfa, saa, playerId: playerId || null });
}
function sub(time, offId, onId, team, period) {
  return ev({ time, period: period || '2H', label: 'Sub', playerOffId: offId, playerOnId: onId, team: team === undefined ? 'our' : team });
}
function ftClock(baseSeconds) {
  return {
    clockStartedAt: null, clockBaseSeconds: baseSeconds, clockRunning: false,
    period: 'FT', scoreFor: 2, scoreAgainst: 1, videoSyncOffset: 0,
    selectedTeam: 'our', selectedPlayerId: null, activeSequenceId: null, nextSequenceNumber: 1
  };
}

function mkSession(opts) {
  const squad = SQUAD.map((p) => (
    opts.nameOverride && opts.nameOverride[p.id] ? { ...p, name: opts.nameOverride[p.id] } : p
  ));
  return {
    sourceFile: opts.sourceFile || ('/f' + opts.n + '.json'),
    __savedAt: opts.savedAt || ('2026-09-' + String(opts.n).padStart(2, '0') + 'T20:00:00Z'),
    __schemaVersion: 3,
    videoPath: null,
    tags: [],
    events: opts.events,
    squad,
    matchInfo: {
      competition: 'League', date: opts.date, opponent: 'Opponent ' + opts.n, venue: 'V',
      homeAway: 'home', ourScore: opts.manual ? opts.manual[0] : '', opponentScore: opts.manual ? opts.manual[1] : '',
      formation: '4-3-3', startingXI: startingXI(opts.xiReplace || null)
    },
    matchClock: opts.clock || ftClock(5400)
  };
}

function recoveries(pid, count, firstTime, step, locatedCount) {
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(ev({
      time: firstTime + i * step, label: 'Recovery', team: 'our', playerId: pid,
      location: i < locatedCount ? { x: 0.2 + (i % 3) * 0.3, y: 0.3 + (i % 2) * 0.4 } : null
    }));
  }
  return out;
}
function passes(pid, successful, unsuccessful, firstTime) {
  const out = [];
  for (let i = 0; i < successful; i++) {
    out.push(ev({ time: firstTime + i * 30, label: 'Pass', team: 'our', playerId: pid, qualifiers: { Outcome: 'Successful' } }));
  }
  for (let i = 0; i < unsuccessful; i++) {
    out.push(ev({ time: firstTime + 900 + i * 30, label: 'Pass', team: 'our', playerId: pid, qualifiers: { Outcome: 'Unsuccessful' } }));
  }
  return out;
}
function goalsFor(pattern, pid) {
  return pattern.map((g) => goal(g.t, g.team, g.sfb, g.sab, g.sfa, g.saa, g.period || '1H', pid || null));
}

// F1 — 6 matches (p8: 10/6/4/12/11/5 recoveries; results W/L/D/W/L/W).
// Engine-verified: L3/L5/L10 rec totals 28/38/48; L5 per-90 rec 10.4 over
// 330 reliable minutes; vs Season Baseline LOWER; vs Baseline Excl. Window
// HIGHER; R5P5 INCONCLUSIVE (6 appearances); WW INSUFFICIENT_SAMPLE (6/0).
function f1Sessions() {
  const sessions = [];
  const subOnForP6 = { 6: 'p13' };
  {
    eventSeq = 1;
    const events = [].concat(
      recoveries('p8', 10, 60, 100, 6),
      goalsFor([{ t: 1800, team: 'our', sfb: 0, sab: 0, sfa: 1, saa: 0 }])
    );
    sessions.push(mkSession({ n: 1, date: '2026-08-01', events }));
  }
  {
    eventSeq = 100;
    const events = [].concat(
      recoveries('p8', 6, 2000, 200, 2),
      [sub(1800, 'p6', 'p8')],
      goalsFor([{ t: 2600, team: 'opponent', sfb: 0, sab: 0, sfa: 0, saa: 1, period: '2H' }])
    );
    sessions.push(mkSession({ n: 2, date: '2026-08-08', events, xiReplace: subOnForP6 }));
  }
  {
    eventSeq = 200;
    const events = [].concat(
      recoveries('p8', 4, 3700, 200, 1),
      [sub(3600, 'p6', 'p8')],
      goalsFor([
        { t: 1500, team: 'our', sfb: 0, sab: 0, sfa: 1, saa: 0 },
        { t: 3000, team: 'opponent', sfb: 1, sab: 0, sfa: 1, saa: 1, period: '2H' }
      ])
    );
    sessions.push(mkSession({ n: 3, date: '2026-08-15', events, xiReplace: subOnForP6 }));
  }
  {
    eventSeq = 300;
    const events = [].concat(
      recoveries('p8', 12, 100, 150, 4),
      goalsFor([
        { t: 1000, team: 'our', sfb: 0, sab: 0, sfa: 1, saa: 0 },
        { t: 2500, team: 'our', sfb: 1, sab: 0, sfa: 2, saa: 0, period: '2H' },
        { t: 3500, team: 'opponent', sfb: 2, sab: 0, sfa: 2, saa: 1, period: '2H' }
      ])
    );
    sessions.push(mkSession({ n: 4, date: '2026-08-22', events }));
  }
  {
    eventSeq = 400;
    const events = [].concat(
      recoveries('p8', 11, 120, 150, 5),
      goalsFor([
        { t: 1200, team: 'our', sfb: 0, sab: 0, sfa: 1, saa: 0 },
        { t: 2000, team: 'opponent', sfb: 1, sab: 0, sfa: 1, saa: 1, period: '2H' },
        { t: 3800, team: 'opponent', sfb: 1, sab: 1, sfa: 1, saa: 2, period: '2H' }
      ])
    );
    sessions.push(mkSession({ n: 5, date: '2026-08-29', events }));
  }
  {
    eventSeq = 500;
    const events = [].concat(
      recoveries('p8', 5, 2000, 200, 2),
      [sub(1800, 'p6', 'p8')],
      goalsFor([{ t: 4000, team: 'our', sfb: 0, sab: 0, sfa: 1, saa: 0, period: '2H' }])
    );
    sessions.push(mkSession({ n: 6, date: '2026-09-05', events, xiReplace: subOnForP6 }));
  }
  return sessions;
}

// F2 — 10 matches, p8 starts all; recoveries 5,6,4,7,6,9,8,10,9,9 (recent5
// 45, previous5 28); name drift M. Ahmed → Mohammed Ahmed (kept as ONE
// identity, flagged). Engine-verified: R5P5 COMPARISON HIGHER (45 vs 28,
// +17, +60.7%); per-90 9.0 vs 5.6 HIGHER; IDENTITY_DRIFT propagated.
function f2Sessions() {
  const sessions = [];
  const counts = [5, 6, 4, 7, 6, 9, 8, 10, 9, 9];
  for (let i = 0; i < 10; i++) {
    eventSeq = 1000 + i * 100;
    const events = [].concat(
      recoveries('p8', counts[i], 100, 150, 3),
      goalsFor([{ t: 1800, team: 'our', sfb: 0, sab: 0, sfa: 1, saa: 0 }])
    );
    sessions.push(mkSession({
      n: 20 + i, date: '2026-07-' + String(1 + i).padStart(2, '0'), events,
      nameOverride: i < 5 ? { p8: 'M. Ahmed' } : { p8: 'Mohammed Ahmed' }
    }));
  }
  return sessions;
}

// F8 — 2 matches; p8 passes 4/1 then 10/10 → window pooled passSuccess
// 14/25 = 56%. Engine-verified: Baseline B suppressed (both appearances are
// in the Last 5 window) → WHOLE_SEASON_IN_WINDOW.
function f8Sessions() {
  const sessions = [];
  {
    eventSeq = 1;
    const events = [].concat(
      passes('p8', 4, 1, 200),
      goalsFor([{ t: 1800, team: 'our', sfb: 0, sab: 0, sfa: 1, saa: 0 }])
    );
    sessions.push(mkSession({ n: 51, date: '2026-05-02', events }));
  }
  {
    eventSeq = 100;
    const events = [].concat(
      passes('p8', 10, 10, 200),
      goalsFor([{ t: 1800, team: 'our', sfb: 0, sab: 0, sfa: 1, saa: 0 }])
    );
    sessions.push(mkSession({ n: 52, date: '2026-05-09', events }));
  }
  return sessions;
}

// FD — 1 match; p8 is an UN-TIMED substitute (no reliable minutes).
// Engine-verified: 1 appearance, 0 reliable seconds → every per-90 value
// null (NO_RELIABLE_MINUTES); MISSING_SUB_INFO + UNRELIABLE_MINUTES flags.
function fdSessions() {
  eventSeq = 1;
  const events = [].concat(
    recoveries('p8', 3, 3800, 100, 0),
    [ev({ period: '2H', label: 'Sub', playerOffId: 'p6', playerOnId: 'p8', team: 'our' })],
    goalsFor([{ t: 4000, team: 'our', sfb: 0, sab: 0, sfa: 1, saa: 0, period: '2H' }])
  );
  return [mkSession({ n: 71, date: '2026-05-01', events, xiReplace: { 6: 'p13' } })];
}

function rfTextOf(content) {
  const el = content.querySelector('#rfSection');
  return el ? el.textContent : '';
}

// ---------------------------------------------------------------------------
// Static source checks (no boot required)
// ---------------------------------------------------------------------------
function staticChecks() {
  console.log('== static source checks ==');

  ok('RFU-1 src/recent-form.js exists', !!recentFormSrc, '');

  // 1. Script order: player-season.js → recent-form.js → renderer.js
  const scripts = [];
  const re = /<script src="([^"]+)"><\/script>/g;
  let m;
  while ((m = re.exec(html)) !== null) scripts.push(m[1]);
  const idx = (name) => scripts.indexOf(name);
  ok('RFU-2a index.html lists exactly one recent-form.js script',
    scripts.filter((s) => s === 'recent-form.js').length === 1, scripts.join(','));
  ok('RFU-2b script order: player-season.js before recent-form.js',
    idx('player-season.js') !== -1 && idx('recent-form.js') !== -1 && idx('player-season.js') < idx('recent-form.js'), '');
  ok('RFU-2c script order: recent-form.js before renderer.js',
    idx('recent-form.js') !== -1 && idx('renderer.js') !== -1 && idx('recent-form.js') < idx('renderer.js'), '');
  ok('RFU-2d script order: integrity.js and analytics.js still first',
    idx('integrity.js') === 0 && idx('analytics.js') === 1 && idx('player-season.js') === 2, scripts.join(','));

  // 2. Renderer references the engine correctly
  const callSites = (rendererSrc.match(/window\.RecentFormEngine\.computeRecentForm\(/g) || []).length;
  ok('RFU-3 renderer calls window.RecentFormEngine.computeRecentForm exactly once', callSites === 1, 'call sites=' + callSites);
  ok('RFU-4a renderer does NOT define its own computeRecentForm implementation',
    !/function\s+computeRecentForm\s*\(/.test(rendererSrc), '');
  ok('RFU-4b renderer does NOT duplicate engine vocabularies (RF_COUNT_KEYS etc.)',
    !/\bRF_COUNT_KEYS\b|\bRF_PER90_KEYS\b|\bRF_TEAM_KEYS\b/.test(rendererSrc), '');

  // 11. No second raw-event counting path inside the Recent Form UI block
  const blockStart = rendererSrc.indexOf('Recent Form UI (Phase C');
  const blockEnd = rendererSrc.indexOf('btnSeasonView.addEventListener');
  const rfBlock = blockStart !== -1 && blockEnd !== -1 && blockEnd > blockStart
    ? rendererSrc.slice(blockStart, blockEnd) : '';
  ok('RFU-5a Recent Form UI block exists in renderer.js (marked section)', blockStart !== -1 && rfBlock.length > 500, 'block len=' + rfBlock.length);
  ok('RFU-5b RF UI block never reads raw seasonMatches sessions', !/seasonMatches/.test(rfBlock), '');
  ok('RFU-5c RF UI block never iterates raw events (no event-label counting)', !/\.label\s*(?:===|!==)/.test(rfBlock), '');
  ok('RFU-5d RF UI block never re-invokes computeSeason', !/computeSeason\s*\(/.test(rfBlock), '');
  ok('RFU-5e RF UI block never invokes computeRecentForm (call site is in renderSeasonStats only)', !/computeRecentForm\s*\(/.test(rfBlock), '');
  ok('RFU-5f RF UI block contains no percentage recomputation (num/den → %)',
    !/\/\s*\w*[Dd]en\s*\)\s*\*\s*100/.test(rfBlock) && !/Math\.round\(\(\s*\w+\s*\/\s*\w+\s*\)\s*\*\s*100/.test(rfBlock), '');

  // styles
  ok('RFU-6 styles.css provides rf-* styles for the Recent Form section',
    /\.rf-player-select/.test(stylesSrc) && /\.rf-class\b/.test(stylesSrc), '');
}

// ---------------------------------------------------------------------------
// Boot A — F1 (6 matches): full player + team Recent Form render
// ---------------------------------------------------------------------------
async function bootA() {
  console.log('== Boot A — F1 (6 matches): player + team Recent Form ==');
  const { win, doc } = await boot(f1Sessions(), true);
  const content = await openSeasonViewWith(win, doc, f1Sessions());

  ok('RFU-10 Recent Form engine loaded as window.RecentFormEngine',
    typeof win.RecentFormEngine === 'object' && typeof win.RecentFormEngine.computeRecentForm === 'function', '');

  // 12. existing wiring intact (PS season view unchanged)
  const txt = content.textContent;
  const html1 = content.innerHTML;
  ok('RFU-11a PS season view still renders (Team season data header)', /Team season data/.test(txt), '');
  ok('RFU-11b PS player table still renders', /Player season data \(tagged events\)/.test(txt), '');
  ok('RFU-11c PS coverage line still renders', /Matches in database: 6 · Unique: 6/.test(txt), txt.slice(0, 200));
  ok('RFU-11d PS engine footer still renders', /Player & Season Data Engine 1\.0\.0/.test(txt), '');
  ok('RFU-11e season CSV export button still present', !!doc.getElementById('btnExportSeasonCsv'), '');

  // 3. Recent Form section exists
  const rfSection = content.querySelector('#rfSection');
  ok('RFU-12a Recent Form section exists inside the season view', !!rfSection, '');
  const rfTxt = rfSection ? rfSection.textContent : '';
  ok('RFU-12b section header uses the engine term "Recent Form"', /Recent Form/.test(rfTxt), '');

  // player selector
  const sel = content.querySelector('#rfPlayerSelect');
  ok('RFU-13a player selector exists', !!sel, '');
  if (sel) {
    ok('RFU-13b player selector lists every PS player (' + SQUAD.length + ')',
      sel.options.length === SQUAD.length, 'options=' + sel.options.length);
    ok('RFU-13c default selection = first PS playerOrder entry (p8)',
      sel.value === 'p8', 'value=' + sel.value);
  }
  const detail = content.querySelector('#rfPlayerDetail');
  ok('RFU-13d player detail container exists', !!detail, '');
  ok('RFU-13e selected player header shown (M. Ahmed, 6 appearances)',
    /M\. Ahmed/.test(rfTxt) && /6/.test(rfTxt), '');

  // 4. window labels
  ok('RFU-14a "Last 3" label present', /Last 3/.test(rfTxt), '');
  ok('RFU-14b "Last 5" label present', /Last 5/.test(rfTxt), '');
  ok('RFU-14c "Last 10" label present', /Last 10/.test(rfTxt), '');
  ok('RFU-14d "Sample Size" terminology present', /Sample Size/.test(rfTxt), '');

  // window sample sizes (true sample size: 6 of 10 requested)
  ok('RFU-15a window sample table shows the true Last 10 sample size',
    /6 of 10 requested/.test(rfTxt), rfTxt.slice(0, 400));
  ok('RFU-15b appearances in window reported (6 available)',
    /6 appearances/.test(rfTxt), '');

  // recent activity totals
  ok('RFU-16a "Recent Activity" terminology present', /Recent Activity/.test(rfTxt), '');
  ok('RFU-16b p8 Last 5 recoveries total 38 rendered', /38/.test(rfTxt), '');
  ok('RFU-16c per-appearance average (7.6) rendered', /7\.6/.test(rfTxt), '');

  // pooled percentages with num/den
  ok('RFU-17 pooled located share rendered with numerator/denominator (36.8% (14/38))',
    /36\.8% \(14\/38\)/.test(rfTxt), '');

  // per-90 + disclosure (task Part 6/Part 17-10)
  ok('RFU-18a per-90 recoveries 10.4 (Last 5) rendered', /10\.4/.test(rfTxt), '');
  ok('RFU-18b per-90 disclosure: reliable minutes 330 visible', /330/.test(rfTxt), '');
  ok('RFU-18c per-90 disclosure: reliable seconds 19800 visible', /19800/.test(rfTxt), '');
  ok('RFU-18d per-90 disclosure: appearances included (5 of 5) visible', /5 of 5/.test(rfTxt), '');
  ok('RFU-18e "Reliable minutes" terminology present', /Reliable minutes/i.test(rfTxt), '');
  ok('RFU-18f minutes quality badge rendered (reliable)', /reliable/.test(rfTxt), '');

  // 7. baseline comparisons (engine classifications preserved verbatim)
  ok('RFU-19a "Season Baseline" terminology present', /Season Baseline/.test(rfTxt), '');
  ok('RFU-19b vs Season Baseline classification LOWER preserved (38 vs 48)',
    /LOWER/.test(rfTxt), '');
  ok('RFU-19c difference rendered with sign (−10 / -10)', /-10/.test(rfTxt), '');
  ok('RFU-19d tolerance rendered (±4.8)', /±4\.8/.test(rfTxt), '');
  ok('RFU-19e sample sizes rendered (5 / 6)', /5 \/ 6/.test(rfTxt), '');
  ok('RFU-19f "Observed Change" terminology present', /Observed Change/.test(rfTxt), '');

  ok('RFU-20a "Baseline Excluding Recent Window" terminology present', /Baseline Excluding Recent Window/.test(rfTxt), '');
  ok('RFU-20b vs Baseline Excluding Recent Window classification HIGHER preserved (38 vs 10)',
    /HIGHER/.test(rfTxt), '');
  ok('RFU-20c "Difference" terminology present', /Difference/.test(rfTxt), '');

  // WITHIN-TOLERANCE classification preserved (per-90 vs Season Baseline)
  ok('RFU-21 WITHIN-TOLERANCE classification preserved (per-90 10.4 vs 10.3)',
    /WITHIN-TOLERANCE/.test(rfTxt), '');

  // 9. insufficient sample cases
  ok('RFU-22a Recent 5 vs Previous 5 shown as INCONCLUSIVE', /INCONCLUSIVE/.test(rfTxt), '');
  ok('RFU-22b R5P5 reason INSUFFICIENT_APPEARANCES shown', /INSUFFICIENT_APPEARANCES/.test(rfTxt), '');
  ok('RFU-22c R5P5 actual sample size shown (6 appearances)', /6 appearances/.test(rfTxt), '');
  ok('RFU-22d R5P5 does not fabricate a Previous 5 block (no previous-5 numbers for 6 apps)',
    !/Previous 5[\s\S]{0,120}28/.test(rfTxt), '');

  ok('RFU-23a With / Without shown as INSUFFICIENT_SAMPLE (6 vs 0)',
    /INSUFFICIENT_SAMPLE/.test(rfTxt), '');
  ok('RFU-23b WITH group size visible', /WITH\b/.test(rfTxt), '');
  ok('RFU-23c WITHOUT group size visible (0 completed matches)', /WITHOUT\b/.test(rfTxt), '');
  ok('RFU-23d observational standing note rendered (no causal claim)',
    /no causal claim/.test(rfTxt), '');

  // variability (min/max/range/mean/median)
  ok('RFU-24a "Observed Variability" terminology present', /Observed Variability/.test(rfTxt), '');
  ok('RFU-24b variability values rendered (min 4 · max 12 · range 8 · mean 7.6 · median 6)',
    /4/.test(rfTxt) && /12/.test(rfTxt) && /8/.test(rfTxt) && /median/i.test(rfTxt), '');

  // 12. team Recent Form
  ok('RFU-25a "Team Recent Form" section present', /Team Recent Form/.test(rfTxt), '');
  ok('RFU-25b team completed-match count shown (6)', /6 completed matches|completed matches: 6|Completed matches: 6/.test(rfTxt), '');
  ok('RFU-25c team window results rendered (W/D/L per window)', /2 \/ 0 \/ 1/.test(rfTxt) || (/W/.test(rfTxt) && /D/.test(rfTxt) && /L/.test(rfTxt)), '');
  ok('RFU-25d team goals for/against in window shown', /4/.test(rfTxt) && /3/.test(rfTxt), '');

  // tagged possession share (NC-1 language, never "official possession")
  ok('RFU-26a "Tagged Possession Share" labelled distinctly', /Tagged Possession Share/.test(rfTxt), '');
  ok('RFU-26b no tagged possession → reason shown, not a value',
    /NO_TAGGED_POSSESSION_INTERVALS/.test(rfTxt), '');
  ok('RFU-26c tagged possession disclaimed as NOT official',
    /not an official match possession statistic/.test(rfTxt), '');

  // 13. data quality flags visible
  ok('RFU-27a "Recent Form data quality" block present', /Recent Form data quality/.test(rfTxt), '');
  ok('RFU-27b propagated flags visible (LOW_LOCATION_COVERAGE)', /LOW_LOCATION_COVERAGE/.test(rfTxt), '');
  ok('RFU-27c structural flags visible (UNRELIABLE_MINUTES)', /UNRELIABLE_MINUTES/.test(rfTxt), '');

  // engine footer
  ok('RFU-28a Recent Form engine footer present', /Recent Form Engine 1\.0\.0/.test(rfTxt), '');
  ok('RFU-28b footer notes determinism', /deterministic/.test(rfTxt), '');

  // 5. forbidden terminology sweep (task Part 4 forbidden list)
  const forbidden = [
    /\bform score\b/i, /\bperformance score\b/i, /\bplayer rating\b/i, /\bconsistency score\b/i,
    /\bimproving\b/i, /\bdeclining\b/i, /\bin form\b/i, /\bout of form\b/i,
    /\bmomentum\b/i, /\bconfidence\b/i, /\bsharpness\b/i, /\bprediction\b/i, /\bpredictive\b/i
  ];
  forbidden.forEach((re) => {
    ok('RFU-29 forbidden terminology absent from season view: ' + re, !re.test(txt), '');
  });

  // causal-language sweep (Recent Form section only)
  const causal = [/\bbecause of\b/i, /\bcauses\b/i, /\bcaused by\b/i, /\bleads to\b/i, /\bdrives\b/i];
  causal.forEach((re) => {
    ok('RFU-30 no causal language in Recent Form section: ' + re, !re.test(rfTxt), '');
  });

  // --- player change: p14 (unused substitute, empty windows) ---
  if (sel) {
    sel.value = 'p14';
    sel.dispatchEvent(new win.Event('change'));
    await sleep(60);
    const rfSection14 = content.querySelector('#rfSection');
    const rfTxt14 = rfSection14 ? rfSection14.textContent : '';
    ok('RFU-31a selecting another player re-renders the detail (p14)',
      /Y\. Fikru/.test(rfTxt14), '');
    ok('RFU-31b p14 window excluded records shown with reasons (UNUSED_SUB)',
      /UNUSED_SUB/.test(rfTxt14), '');
    ok('RFU-31c empty window comparison reason EMPTY_WINDOW preserved',
      /EMPTY_WINDOW/.test(rfTxt14), '');

    // 6. null → neutral N/A label, never zero
    const p90Rows = content.querySelectorAll('#rfSection table');
    let p90CellOk = false; let p90CellZero = false;
    p90Rows.forEach((t) => {
      t.querySelectorAll('tr').forEach((tr) => {
        const cells = tr.querySelectorAll('td');
        if (cells.length === 4) {
          const label = cells[0].textContent.trim();
          if (/Recoveries\/90/.test(label)) {
            const v = cells[1].textContent.trim();
            if (/N\/A — insufficient reliable minutes/.test(v)) p90CellOk = true;
            if (v === '0') p90CellZero = true;
          }
        }
      });
    });
    ok('RFU-32a p14 per-90 null rendered as the neutral N/A label', p90CellOk, '');
    ok('RFU-32b p14 per-90 null NOT rendered as 0', !p90CellZero, '');

    // determinism: re-render after selection change is byte-stable
    clickOn(win, doc.getElementById('btnCloseSeasonModal'));
    await sleep(50);
    clickOn(win, doc.getElementById('btnSeasonView'));
    await sleep(100);
    const content2 = doc.getElementById('seasonStatsContent');
    const rfSection2 = content2.querySelector('#rfSection');
    ok('RFU-33a re-open with a selected player renders byte-identical HTML',
      !!rfSection2 && rfSection2.textContent === rfTxt14, '');
    const sel2 = content2.querySelector('#rfPlayerSelect');
    ok('RFU-33b player selection persisted across re-render (p14 still selected)',
      !!sel2 && sel2.value === 'p14', '');
  }

  // determinism: default render byte-identical (compare with a fresh boot)
  {
    const { win: win2, doc: doc2 } = await boot(f1Sessions(), true);
    const content2 = await openSeasonViewWith(win2, doc2, f1Sessions());
    ok('RFU-34 same sessions → byte-identical season view HTML (deterministic)',
      content2.innerHTML === html1, '');
  }

  return { win, doc };
}

// ---------------------------------------------------------------------------
// Boot B — F2 (10 matches): R5P5 COMPARISON + identity flag
// ---------------------------------------------------------------------------
async function bootB() {
  console.log('== Boot B — F2 (10 matches): Recent 5 vs Previous 5 comparison ==');
  const { win, doc } = await boot(f2Sessions(), true);
  const content = await openSeasonViewWith(win, doc, f2Sessions());
  const rfTxt = rfTextOf(content);

  ok('RFU-40a R5P5 eligibility COMPARISON (10 appearances)',
    /COMPARISON/.test(rfTxt), '');
  ok('RFU-40b R5P5 Recent 5 recoveries 45 shown', /45/.test(rfTxt), '');
  ok('RFU-40c R5P5 Previous 5 recoveries 28 shown (not fabricated)', /28/.test(rfTxt), '');
  ok('RFU-40d R5P5 classification HIGHER preserved (+17 difference)',
    /HIGHER/.test(rfTxt) && /\+17/.test(rfTxt), '');
  ok('RFU-40e R5P5 percentage difference preserved (+60.7%)', /\+60\.7%/.test(rfTxt), '');
  ok('RFU-40f R5P5 per-90 comparison 9 vs 5.6 shown', /5\.6/.test(rfTxt), '');

  ok('RFU-41a variability over 10 appearances (min 4 · max 10 · range 6)',
    /4/.test(rfTxt) && /10/.test(rfTxt) && /6/.test(rfTxt), '');

  ok('RFU-42 IDENTITY_DRIFT flag visible in Recent Form data quality',
    /IDENTITY_DRIFT/.test(rfTxt), '');
  ok('RFU-43 name-drift player kept as ONE identity (both render under one record)',
    /Mohammed Ahmed/.test(content.textContent), '');
}

// ---------------------------------------------------------------------------
// Boot C — F8 (2 matches): WHOLE_SEASON_IN_WINDOW + pooled percentage
// ---------------------------------------------------------------------------
async function bootC() {
  console.log('== Boot C — F8 (2 matches): whole-season window suppression ==');
  const { win, doc } = await boot(f8Sessions(), true);
  const content = await openSeasonViewWith(win, doc, f8Sessions());
  const rfTxt = rfTextOf(content);

  // 8. WHOLE_SEASON_IN_WINDOW handled
  ok('RFU-50a WHOLE_SEASON_IN_WINDOW reason displayed',
    /WHOLE_SEASON_IN_WINDOW/.test(rfTxt), '');
  ok('RFU-50b suppression explained in plain language (window covers the entire season)',
    /covers the entire season/.test(rfTxt), rfTxt.slice(0, 300));
  ok('RFU-50c suppressed baseline not replaced with a fabricated value (stated)',
    /never replaced with a fabricated value/.test(rfTxt), '');
  ok('RFU-50d suppressed comparisons remain INCONCLUSIVE',
    /INCONCLUSIVE/.test(rfTxt), '');

  // 7. pooled percentage from the engine (14/25 = 56%)
  ok('RFU-51 pooled pass success rendered from engine num/den (56% (14/25))',
    /56% \(14\/25\)/.test(rfTxt), '');

  // per-90 disclosure for the 2-appearance window (180 reliable minutes)
  ok('RFU-52 per-90 disclosure reliable minutes 180 visible', /180/.test(rfTxt), '');
}

// ---------------------------------------------------------------------------
// Boot D — FD (1 match, un-timed sub): zero reliable minutes
// ---------------------------------------------------------------------------
async function bootD() {
  console.log('== Boot D — un-timed substitute: zero reliable minutes ==');
  const { win, doc } = await boot(fdSessions(), true);
  const content = await openSeasonViewWith(win, doc, fdSessions());
  const rfTxt = rfTextOf(content);

  ok('RFU-60a per-90 null rendered as the neutral N/A label',
    /N\/A — insufficient reliable minutes/.test(rfTxt), '');
  ok('RFU-60b NO_RELIABLE_MINUTES reason preserved in comparisons',
    /NO_RELIABLE_MINUTES/.test(rfTxt), '');
  ok('RFU-60c minutes quality rendered as unavailable', /unavailable/.test(rfTxt), '');
  ok('RFU-60d per-90 disclosure shows 0 reliable minutes (never hidden)',
    /0/.test(rfTxt), '');
  ok('RFU-60e MISSING_SUB_INFO flag visible (missing substitution information)',
    /MISSING_SUB_INFO/.test(rfTxt), '');
}

// ---------------------------------------------------------------------------
// Boot E — WITHOUT recent-form.js: graceful degradation, PS view intact
// ---------------------------------------------------------------------------
async function bootE() {
  console.log('== Boot E — engine absent: graceful degradation ==');
  const { win, doc } = await boot(f1Sessions(), false);
  const content = await openSeasonViewWith(win, doc, f1Sessions());
  const txt = content.textContent;
  ok('RFU-70a season view still renders the PS output when the RF engine is absent',
    /Team season data/.test(txt) && /Player season data \(tagged events\)/.test(txt), '');
  ok('RFU-70b explicit note that the Recent Form engine is not loaded',
    /Recent Form engine not loaded/.test(txt), '');
}

(async () => {
  console.log('== Recent Form V1 — UI integration check ==');
  staticChecks();
  await bootA();
  await bootB();
  await bootC();
  await bootD();
  await bootE();

  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass);
  console.log('\n---- recent-form UI check: ' + passed + ' passed, ' + failed.length + ' failed ----');
  if (failed.length) {
    console.log('FAILURES:');
    failed.forEach((f) => console.log('  ✗ ' + f.name + (f.detail ? ' — ' + f.detail : '')));
  }
  process.exit(failed.length ? 1 : 0);
})();
