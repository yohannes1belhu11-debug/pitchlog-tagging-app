#!/usr/bin/env node
// PitchLog / MatchTag — F1.5 Tag Set Completeness regression harness
// (TS series).
// =====================================================================
// Verification-only harness. It does NOT modify any app source file.
//
// Verifies the F1.5 fix for the Phase F0 audit finding (#5 impact):
// only 8 of the 19 analytics-canonical labels shipped as default tags,
// so Press / Duel / Turnover / Chance / … metrics silently read zero
// for a desktop-only analyst (those labels existed only as touchline
// quick tags that auto-created flat tags on first use).
//
// F1.5 ships the 11 remaining canonical labels as DEFAULT FLAT tags —
// exactly the shape the metric specification declares for them
// (§1.5 outcome table: "none — flat tags"; all their metrics are pure
// label counts), with Press='9' and Duel='0' as the only new keyboard
// keys (the remaining free digits).
//
// Checks:
//   STATIC  TS-S1..S13 — default set wiring, flatness, key map,
//           original-8 preservation, spec-doc delta, engine-oracle
//           cross-check (analytics.js canonical labels ⊆ defaults).
//   BOOT T1 fresh desktop boot: 19 buttons, flat-tag behavior (panel
//           without chips), keyboard '9'/'0' log Press/Duel, '6' still
//           logs Corner, filter options, autosave embeds 19 tags.
//   BOOT T2 touchline: quick taps resolve to the default flat tags (no
//           auto-create), Shot still opens the rich detail panel.
//   BOOT T3 ENGINE PROOF: real UI taps (Press our + opp, Duel, Chance)
//           produce a session whose analytics come out NON-ZERO — the
//           actual audit-gap closure, no custom tags needed.
//   BOOT T4 old-session compat: an 8-tag embedded session keeps its
//           own tag set; the touchline auto-create flat path still
//           works for labels absent from a session's array.
//   BOOT T5 custom-tag modal: with all 10 digit keys used, a new
//           custom tag is created keyless (documented trade-off).
//
// HONEST SCOPE: jsdom boots verify DOM wiring and engine data flow only;
// visual grid layout (19 buttons wrapping) and real keyboard input in
// Electron require manual verification.
//
// Run:  node tests/tag-set-completeness-check.js   (from the project root)
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
  console.error('Boot the jsdom sandbox first (see tests/f2-f3-fix-check.js header).');
  process.exit(2);
}

const srcDir = path.join(__dirname, '..', 'src');
const html = fs.readFileSync(path.join(srcDir, 'index.html'), 'utf8');
const integritySrc = fs.readFileSync(path.join(srcDir, 'integrity.js'), 'utf8');
const analyticsSrc = fs.readFileSync(path.join(srcDir, 'analytics.js'), 'utf8');
const playerSeasonSrc = fs.readFileSync(path.join(srcDir, 'player-season.js'), 'utf8');
const rendererSrc = fs.readFileSync(path.join(srcDir, 'renderer.js'), 'utf8');
const specSrc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'metric-specification.md'), 'utf8');

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

function fnBody(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) return '';
  const next = src.indexOf('\n  function ', start + 10);
  return start > -1 && next > start ? src.slice(start, next) : src.slice(start, start + 3000);
}

// ---------------------------------------------------------------------------
// Static source-level checks
// ---------------------------------------------------------------------------
section('STATIC — F1.5 wiring (source-level checks)');
{
  // The default tags array source (between 'let tags = [' and its '];').
  const tagsStart = rendererSrc.indexOf('let tags = [');
  const tagsEnd = rendererSrc.indexOf('\n  ];', tagsStart);
  const tagsSrc = rendererSrc.slice(tagsStart, tagsEnd);
  ok('TS-S0: default tags array located', tagsStart > -1 && tagsEnd > tagsStart);

  const CANONICAL_19 = ['Goal','Shot','Pass','Foul','Card','Corner','Sub','Possession',
    'Chance','Cross','Key Pass','Press','Press Win','Turnover','Recovery',
    'Interception','Duel','Positive Transition','Negative Transition'];
  const NEW_11 = CANONICAL_19.slice(8);

  const labelsInOrder = [];
  const labelRe = /label:\s*'([^']+)'/g;
  let m;
  while ((m = labelRe.exec(tagsSrc)) !== null) labelsInOrder.push(m[1]);
  ok('TS-S1: default set carries all 19 canonical labels in order (8 original + 11 new)',
    JSON.stringify(labelsInOrder) === JSON.stringify(CANONICAL_19),
    'labels=' + labelsInOrder.join(','));
  ok('TS-S2: no duplicate labels in the default set',
    new Set(labelsInOrder).size === labelsInOrder.length);

  // Flatness of the 11 new entries: each must be exactly { label: X, key: K }
  // (no subtypes / qualifierGroups / interval / substitution).
  const newFlat = NEW_11.every((l) =>
    new RegExp("\\{ label: '" + l.replace(/[.*+?^${}()|\\[\\]\\\\]/g, '\\\\$&') + "', key: '[^']*' \\},?\\s*(\\n|$|//|$)").test(tagsSrc));
  const noRich = NEW_11.every((l) => {
    const idx = tagsSrc.indexOf("label: '" + l + "'");
    const entryEnd = tagsSrc.indexOf('},', idx) > -1 ? Math.min(tagsSrc.indexOf('},', idx), idx + 60) : idx + 60;
    const entry = tagsSrc.slice(idx, entryEnd);
    return !/subtypes|qualifierGroups|interval|substitution/.test(entry);
  });
  ok('TS-S3: the 11 new entries are FLAT tags (spec §1.5 fidelity)',
    newFlat && noRich, 'newFlat=' + newFlat + ' noRich=' + noRich);

  ok('TS-S4: key map — original 8 keep keys 1-8, Press=9, Duel=0, others keyless',
    /label: 'Press', key: '9'/.test(tagsSrc) &&
    /label: 'Duel', key: '0'/.test(tagsSrc) &&
    NEW_11.filter((l) => l !== 'Press' && l !== 'Duel').every((l) =>
      new RegExp("label: '" + l.replace(/[.*+?^${}()|\\[\\]\\\\]/g, '\\\\$&') + "', key: ''").test(tagsSrc)) &&
    ['Goal','Shot','Pass','Foul','Card','Corner','Sub','Possession'].every((l, i) =>
      new RegExp("label: '" + l + "', key: '" + (i + 1) + "'").test(tagsSrc)));

  ok('TS-S5: original 8 definitions unchanged (Possession interval + Ended by intact)',
    /label: 'Possession', key: '8', interval: true,/.test(tagsSrc) &&
    /name: 'Ended by', options: \['Shot', 'Turnover', 'Foul won', 'Out of play'\]/.test(tagsSrc) &&
    /subtypes: \['On target', 'Off target', 'Blocked'\]/.test(tagsSrc) &&
    /label: 'Sub', key: '7', substitution: true/.test(tagsSrc));

  ok('TS-S6: DEFAULT_TAGS_LENGTH still captured from tags.length (autosave consistency)',
    /const DEFAULT_TAGS_LENGTH = tags\.length;/.test(rendererSrc));

  ok('TS-S7: QUICK_TAGS unchanged (16 entries incl. Possession, F1.4)',
    /const QUICK_TAGS = \['Possession','Shot','Chance','Cross','Key Pass','Press','Press Win','Turnover','Recovery','Interception','Duel','Positive Transition','Negative Transition','Goal','Card','Sub'\];/.test(rendererSrc));

  ok('TS-S8: F1.4 Possession auto-create interval guard still present',
    /if \(label === 'Possession'\) tag\.interval = true;/.test(rendererSrc));

  ok('TS-S9: loader tag-replacement semantics unchanged (embedded non-empty array wins)',
    // R2-E Phase 1: the load line gained .map(normalizeTagFields) (sanitize
    // optional customization fields); the replacement semantics are
    // unchanged — an embedded non-empty tags array still wins wholesale.
    /tags = Array\.isArray\(data\.tags\) && data\.tags\.length\s*\n\s*\? data\.tags\.map\(normalizeTagFields\).*\n\s*: tags;/.test(rendererSrc));

  // Engine oracle: every canonical label the engine counts is a default tag.
  const engineLabelsSrc = analyticsSrc.slice(
    analyticsSrc.indexOf('var TEAM_LABELS') > -1 ? analyticsSrc.indexOf('var TEAM_LABELS') : analyticsSrc.indexOf("'Chance', 'Cross'") - 200,
    analyticsSrc.indexOf(']', analyticsSrc.indexOf("'Chance', 'Cross'")) + 1);
  const engineLabels = [];
  const elRe = /'([^']+)'/g;
  while ((m = elRe.exec(engineLabelsSrc)) !== null) engineLabels.push(m[1]);
  ok('TS-S10: ENGINE ORACLE — every canonical label in analytics.js ships as a default tag',
    engineLabels.length > 0 && engineLabels.every((l) => CANONICAL_19.includes(l)),
    'engineLabels=' + engineLabels.join(',') + ' missing=' + engineLabels.filter((l) => !CANONICAL_19.includes(l)).join(','));

  ok('TS-S11: keydown tag lookup + unified exact-identity dispatch (R2-E Phase 2A)',
    // R2-E Phase 2A: the dispatch find-line shape is unchanged, now wrapped
    // in the §7 dispatch-layer reserved guard; tagShortcutMatches became
    // the UNIFIED exact-identity matcher (spec §6) — the Phase 1 legacy
    // quirk line (mods-less tags firing on ANY modifier state of their
    // key, e.g. Ctrl+3 firing the plain '3' tag) is pinned ABSENT.
    /const evIdentity = eventShortcutIdentity\(e\);\s*\n\s*if \(evIdentity && !reservedShortcutWhy\(evIdentity\.key, evIdentity\.mods\)\) \{\s*\n\s*const tag = tags\.find\(\(t\) => isActiveTag\(t\) && tagShortcutMatches\(t, e\)\);\s*\n\s*if \(tag\) handleTagPress\(tag\);/.test(rendererSrc) &&
    /function tagShortcutMatches\(tag, e\) \{[\s\S]*?const stored = storedShortcutIdentity\(tag\);[\s\S]*?return stored\.key === ev\.key && modsSetEqual\(stored\.mods, ev\.mods\);/.test(rendererSrc) &&
    !/if \(mods\.length === 0\) return tag\.key === e\.key;/.test(rendererSrc));

  // Spec doc honesty: §1.1 documents 19 rows + the F1.5 delta note.
  const specTable = specSrc.slice(specSrc.indexOf('### 1.1'), specSrc.indexOf('### 1.2'));
  const specRows = (specTable.match(/^\| \d+ \|/gm) || []).length;
  ok('TS-S12: metric-spec §1.1 table documents all 19 default tags + F1.5 delta note',
    specRows === 19 && /Implementation-status delta \(F1\.5\)/.test(specTable),
    'rows=' + specRows);
  const spec15 = specSrc.slice(specSrc.indexOf('### 1.5'), specSrc.indexOf('### 1.6'));
  ok('TS-S13: metric-spec §1.5 still declares the 11 labels flat (no taxonomy invention)',
    /none — flat tags/.test(spec15) && spec15.indexOf('Chance') > -1);

  ok('TS-S14: schema version pinned at v4 (R1 outcome-field bump; tags remain session data)',
    /CURRENT_SCHEMA_VERSION = 4/.test(fs.readFileSync(path.join(srcDir, 'main.js'), 'utf8')));
}

// ---------------------------------------------------------------------------
// jsdom boots
// ---------------------------------------------------------------------------
function makeStub(initial) {
  const calls = { saveSession: [], autosaveWrite: [], loadSessionCalls: 0 };
  const file = { current: null };
  let loadSessionData = null;
  const stub = {
    openVideo: async () => null,
    saveSession: async (d) => { calls.saveSession.push(clone(d)); return { canceled: false, filePath: '/tmp/ts-session.json' }; },
    exportCsv: async () => ({ canceled: true }),
    exportClipPlaylist: async () => ({ canceled: true }),
    loadSession: async () => { calls.loadSessionCalls++; return clone(loadSessionData); },
    loadMultipleSessions: async () => [],
    loadSquad: async () => clone(initial.squad || []),
    saveSquad: async (s) => true,
    detachVideo: async () => true,
    reattachVideo: async () => true,
    sendVideoCommand: () => {},
    onVideoState: () => {},
    onVideoClosed: () => {},
    autosaveRead: async () => null,
    autosaveWrite: async (d) => { calls.autosaveWrite.push(clone(d)); file.current = clone(d); return { ok: true, path: '/tmp/autosave.json' }; },
    autosaveDelete: async () => { file.current = null; return { ok: true }; },
    autosaveFlushSync: (d) => { file.current = d === null ? null : clone(d); return { ok: true }; },
    onCloseRequested: () => {},
    onAutosaveFlushRequested: () => {}, // R2-C-4: power-flush bridge (not exercised here)
    closeProceed: () => {},
    _setLoadSession: (d) => { loadSessionData = d; },
    _calls: calls, _file: file
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
function pressKey(win, key) {
  win.dispatchEvent(new win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}
function desktopTagBtn(doc, label) {
  return Array.from(doc.querySelectorAll('#tagButtons .tag-btn')).find((b) => b.textContent.replace(/⏱/g, '').trim().indexOf(label) === 0) || null;
}
function quickBtn(doc, label) {
  return Array.from(doc.querySelectorAll('#touchlineQuickTags .touchline-tag-btn')).find((b) => b.textContent === label) || null;
}
function eventRows(doc) { return Array.from(doc.querySelectorAll('#eventList .event-row')); }
function rowByLabel(doc, label) { return eventRows(doc).find((r) => r.textContent.indexOf(label) > -1) || null; }
function detailPanel(doc) { return doc.getElementById('detailPanel'); }

const SQUAD = [{ id: 'player_1', number: '1', name: 'Ana One' }];

(async () => {
  // =====================================================================
  section('BOOT T1 — fresh desktop boot: 19 flat defaults, keys, filter, payload');
  // =====================================================================
  {
    const B = boot({ squad: SQUAD });
    const doc = B.doc;
    await sleep(300);

    const btns = Array.from(doc.querySelectorAll('#tagButtons .tag-btn'));
    ok('T1a: 19 desktop tag buttons rendered', btns.length === 19, 'buttons=' + btns.length);

    const NEW_11 = ['Chance','Cross','Key Pass','Press','Press Win','Turnover','Recovery','Interception','Duel','Positive Transition','Negative Transition'];
    const allPresent = NEW_11.every((l) => !!desktopTagBtn(doc, l));
    ok('T1b: every new canonical label has a desktop button', allPresent,
      'missing=' + NEW_11.filter((l) => !desktopTagBtn(doc, l)).join(','));

    const pressBtn = desktopTagBtn(doc, 'Press');
    const duelBtn = desktopTagBtn(doc, 'Duel');
    ok('T1c: Press shows key badge 9, Duel shows key badge 0',
      !!pressBtn && !!pressBtn.querySelector('.key') && pressBtn.querySelector('.key').textContent === '9' &&
      !!duelBtn && !!duelBtn.querySelector('.key') && duelBtn.querySelector('.key').textContent === '0');

    click(pressBtn);
    const panel = detailPanel(doc);
    ok('T1d: flat tag logs instantly (1 event, label Press, not an interval)',
      eventRows(doc).length === 1 && !!rowByLabel(doc, 'Press'));
    ok('T1e: detail panel opens with NO subtype/qualifier chips (flat)',
      !!panel && panel.style.display === 'block' &&
      panel.querySelectorAll('.chip[data-kind="subtype"], .chip[data-kind="qualifier"]').length === 0,
      'chips=' + (panel ? panel.querySelectorAll('.chip[data-kind="subtype"], .chip[data-kind="qualifier"]').length : 'n/a'));
    click(doc.getElementById('detailPanelDone'));

    pressKey(B.win, '9');
    await sleep(30);
    pressKey(B.win, '0');
    await sleep(30);
    pressKey(B.win, '6'); // Corner — original key family intact
    await sleep(30);
    ok('T1f: keyboard 9/0/6 log Press, Duel, Corner (digit family intact)',
      eventRows(doc).length === 4 &&
      !!rowByLabel(doc, 'Press') && !!rowByLabel(doc, 'Duel') && !!rowByLabel(doc, 'Corner'),
      'rows=' + eventRows(doc).length);
    click(doc.getElementById('detailPanelDone'));

    const filterOptions = Array.from(doc.querySelectorAll('#eventTypeFilter option')).map((o) => o.textContent);
    ok('T1g: event-type filter offers the new labels',
      ['Press','Duel','Chance','Turnover'].every((l) => filterOptions.includes(l)),
      'options=' + filterOptions.length);

    await sleep(1700); // autosave debounce
    const payload = B.stub._file.current;
    ok('T1h: autosave payload embeds the 19-tag set',
      !!payload && Array.isArray(payload.tags) && payload.tags.length === 19,
      'tags=' + (payload && payload.tags && payload.tags.length));

    B.dom.window.close();
  }

  // =====================================================================
  section('BOOT T2 — touchline: quick taps resolve to default flat tags (no auto-create)');
  // =====================================================================
  {
    const B = boot({ squad: SQUAD });
    const doc = B.doc;
    await sleep(300);

    click(doc.getElementById('btnTouchlineToggle'));
    ok('T2a: 16 quick tag buttons (F1.4 set, unchanged)',
      doc.querySelectorAll('#touchlineQuickTags .touchline-tag-btn').length === 16);

    click(quickBtn(doc, 'Chance'));
    ok('T2b: touchline Chance logs instantly via the DEFAULT tag (no auto-create: desktop grid stays 19)',
      eventRows(doc).length === 1 && !!rowByLabel(doc, 'Chance') &&
      doc.querySelectorAll('#tagButtons .tag-btn').length === 19,
      'buttons=' + doc.querySelectorAll('#tagButtons .tag-btn').length);
    click(doc.getElementById('detailPanelDone'));

    click(quickBtn(doc, 'Shot'));
    ok('T2c: rich quick tag (Shot) still opens the detail panel with subtype chips',
      detailPanel(doc).style.display === 'block' &&
      detailPanel(doc).querySelectorAll('.chip[data-kind="subtype"]').length > 0);
    click(doc.getElementById('detailPanelDone'));

    B.dom.window.close();
  }

  // =====================================================================
  section('BOOT T3 — ENGINE PROOF: default-set taps yield non-zero metrics');
  // =====================================================================
  {
    const B = boot({ squad: SQUAD });
    const doc = B.doc;
    await sleep(300);

    click(desktopTagBtn(doc, 'Press'));                 // our
    click(doc.getElementById('detailPanelDone'));
    click(doc.getElementById('btnTeamOpponent'));       // switch team
    click(desktopTagBtn(doc, 'Press'));                 // opponent
    click(doc.getElementById('detailPanelDone'));
    click(doc.getElementById('btnTeamOur'));
    click(desktopTagBtn(doc, 'Duel'));
    click(doc.getElementById('detailPanelDone'));
    click(desktopTagBtn(doc, 'Chance'));
    click(doc.getElementById('detailPanelDone'));
    await sleep(1700);

    const session = B.stub._file.current;
    ok('T3a: session has 4 tagged events via default tags only (no custom tags)',
      !!session && session.events.length === 4 && session.tags.length === 19,
      'events=' + (session && session.events.length) + ' tags=' + (session && session.tags.length));

    const R = B.win.AnalyticsEngine.computeMatchAnalytics(session);
    const L1 = R && R.level1 && R.level1.team;
    ok('T3b: Presses count 1 our / 1 opponent (non-zero WITHOUT custom tags)',
      !!L1 && L1.our.presses.value === 1 && L1.opponent.presses.value === 1,
      'our=' + (L1 && L1.our.presses.value) + ' opp=' + (L1 && L1.opponent.presses.value));
    ok('T3c: Duels count 1 our (non-zero)',
      !!L1 && L1.our.duels.value === 1, 'duels=' + (L1 && L1.our.duels.value));
    ok('T3d: Chances count 1 our (non-zero)',
      !!L1 && L1.our.chances.value === 1, 'chances=' + (L1 && L1.our.chances.value));

    B.dom.window.close();
  }

  // =====================================================================
  section('BOOT T4 — old-session compat: embedded 8-tag set wins; auto-create still works');
  // =====================================================================
  {
    const B = boot({ squad: SQUAD });
    const doc = B.doc;
    await sleep(300);

    // An e801766-era session: the OLD 8-tag default array, no Chance.
    const oldDefaultTags = [
      { label: 'Goal', key: '1', qualifierGroups: [{ name: 'Body part', options: ['Left foot', 'Right foot', 'Head', 'Other'] }] },
      { label: 'Shot', key: '2', subtypes: ['On target', 'Off target', 'Blocked'] },
      { label: 'Pass', key: '3' },
      { label: 'Foul', key: '4' },
      { label: 'Card', key: '5', subtypes: ['Yellow', 'Red'] },
      { label: 'Corner', key: '6' },
      { label: 'Sub', key: '7', substitution: true },
      { label: 'Possession', key: '8', interval: true, qualifierGroups: [{ name: 'Ended by', options: ['Shot', 'Turnover', 'Foul won', 'Out of play'] }] }
    ];
    B.stub._setLoadSession({
      __schemaVersion: 3, videoPath: null, videoUrl: null,
      tags: oldDefaultTags, events: [], squad: SQUAD,
      matchInfo: { opponent: 'Old FC' },
      matchClock: { clockStartedAt: null, clockBaseSeconds: 0, clockRunning: false, period: 'PRE_MATCH',
        scoreFor: 0, scoreAgainst: 0, videoSyncOffset: 0, selectedTeam: 'our', selectedPlayerId: null,
        activeSequenceId: null, nextSequenceNumber: 1 }
    });
    click(doc.getElementById('btnLoadSession'));
    await sleep(350);

    ok('T4a: loaded session keeps its own 8-tag set (replacement semantics preserved)',
      doc.querySelectorAll('#tagButtons .tag-btn').length === 8,
      'buttons=' + doc.querySelectorAll('#tagButtons .tag-btn').length);

    click(doc.getElementById('btnTouchlineToggle'));
    click(quickBtn(doc, 'Chance'));
    ok('T4b: touchline auto-create flat path STILL WORKS for labels absent from the session (9 buttons)',
      doc.querySelectorAll('#tagButtons .tag-btn').length === 9 && !!rowByLabel(doc, 'Chance'),
      'buttons=' + doc.querySelectorAll('#tagButtons .tag-btn').length);
    click(doc.getElementById('detailPanelDone'));

    B.dom.window.close();
  }

  // =====================================================================
  section('BOOT T5 — custom-tag modal: no free digit left → keyless custom tag');
  // =====================================================================
  {
    const B = boot({ squad: SQUAD });
    const doc = B.doc;
    await sleep(300);

    click(doc.getElementById('btnAddCustom'));
    doc.getElementById('newTagName').value = 'Custom Test';
    click(doc.getElementById('btnConfirmAddTag'));

    const btns = Array.from(doc.querySelectorAll('#tagButtons .tag-btn'));
    ok('T5a: custom tag appended (20 buttons)',
      btns.length === 20, 'buttons=' + btns.length);
    ok('T5b: with all 10 digit keys used by defaults, the custom tag is created KEYLESS (documented trade-off)',
      !!desktopTagBtn(doc, 'Custom Test') &&
      desktopTagBtn(doc, 'Custom Test').querySelector('.key').textContent === '',
      'key badge=' + JSON.stringify(desktopTagBtn(doc, 'Custom Test') && desktopTagBtn(doc, 'Custom Test').querySelector('.key').textContent));

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
  console.log('---- tag set completeness check: ' + pass + ' passed, ' + fail + ' failed ----');
  console.log('NOTE: jsdom boots verify DOM wiring and engine data flow. Visual grid');
  console.log('layout (19 wrapping buttons) and real keyboard input in Electron require');
  console.log('manual verification.');
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('HARNESS CRASH:', err && err.stack ? err.stack : err);
  process.exit(1);
});
