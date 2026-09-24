#!/usr/bin/env node
// PitchLog / MatchTag — R2-E Phase 3: persistent tag library, RENDERER
// harness (tags.json + custom tag management).
// ============================================================================
// Verification-only harness. It does NOT modify any app source file.
//
// Boots the REAL index.html + integrity.js + analytics.js + player-season.js
// + renderer.js into jsdom with a stubbed window.matchtag bridge that
// implements the NEW tag-library methods (loadTagLibrary / saveTagLibrary)
// with call capture — the same architecture as tag-controls-check.js.
//
// Covers the R2-E Phase 3 architect rulings:
//
//   R1  tag ops persist to the library REGARDLESS of which session is
//       loaded (edit during a loaded session upserts into the library)
//   R2  a loaded session's embedded tags stay AUTHORITATIVE for the
//       session's working set (load replaces the grid, never the library)
//   R3  session load / recovery never write tags.json
//   R4  startup chain: loadSquad → loadTagLibraryAtStartup →
//       checkForRecoverableAutosave; missing library → defaults, nothing
//       written back; corrupt library → notice + defaults
//   BASELINE  a customized library boots CLEAN (no phantom autosavable
//       work — flush on close sends null), while a mid-session tag edit
//       still counts as work (flush sends data)
//   RESTORE   Restore-default-tags: strong confirmation, library reset to
//       the pristine 19, session scope leaves the working set untouched
//   OPS       create / edit / delete / reactivate / touchline auto-create
//       ('ensure' — never flattens an existing library definition) all
//       persist; substitution stays built-in-only and survives edits;
//       duplicate-shortcut rejection still guards creates with a library
//
// HONEST SCOPE: jsdom boots verify DOM wiring and data flow only. The real
// tags.json file, its atomic write, and the true cross-restart persistence
// are covered by tests/tag-library-main-check.js (plain-Node main harness)
// and the real-Electron QA probe.
//
// Run:  node tests/tag-library-renderer-check.js   (from the project root)
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
const preloadSrc = fs.readFileSync(path.join(srcDir, 'preload.js'), 'utf8');
const stylesSrc = fs.readFileSync(path.join(srcDir, 'styles.css'), 'utf8');

const results = [];
let SECTION = '(pre)';
function section(name) { SECTION = name; console.log('\n===== ' + name + ' ====='); }
function ok(name, cond, detail) {
  results.push({ section: SECTION, name, pass: !!cond, detail: detail === undefined ? '' : String(detail) });
  if (!cond) console.log('  FAIL: ' + name + (detail === undefined ? '' : '  (' + detail + ')'));
}

const jsdomErrors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function clone(x) { return x == null ? x : JSON.parse(JSON.stringify(x)); }

const CANONICAL_19 = ['Goal','Shot','Pass','Foul','Card','Corner','Sub','Possession',
  'Chance','Cross','Key Pass','Press','Press Win','Turnover','Recovery',
  'Interception','Duel','Positive Transition','Negative Transition'];

// ---------------------------------------------------------------------------
// jsdom boot with the tag-library-aware matchtag stub
// ---------------------------------------------------------------------------
function makeStub(initial) {
  const calls = {
    saveSession: [], autosaveWrite: [], saveTagLibrary: [], flushSync: [],
    loadSessionCalls: 0, loadTagLibraryCalls: 0
  };
  const state = { loadSessionData: null };
  const stub = {
    openVideo: async () => null,
    saveSession: async (d) => { calls.saveSession.push(clone(d)); return { canceled: true }; },
    exportCsv: async () => ({ canceled: true }),
    exportClipPlaylist: async () => ({ canceled: true }),
    loadSession: async () => { calls.loadSessionCalls++; return clone(state.loadSessionData); },
    loadMultipleSessions: async () => [],
    loadSquad: async () => clone(initial.squad || []),
    saveSquad: async (s) => true,
    // R2-E Phase 3 bridge:
    //   initial.tagLibrary === undefined        → method MISSING (old preload)
    //   initial.tagLibrary === null             → no library file
    //   initial.tagLibrary = { tags: [...] }    → a saved library
    //   initial.tagLibrary = { corrupt: true }  → corrupt library
    ...(initial.tagLibrary !== undefined ? {
      loadTagLibrary: async () => { calls.loadTagLibraryCalls++; return clone(initial.tagLibrary); },
      saveTagLibrary: async (tags) => { calls.saveTagLibrary.push(clone(tags)); return { ok: true, path: '/tmp/tags.json' }; }
    } : {}),
    detachVideo: async () => true,
    reattachVideo: async () => true,
    sendVideoCommand: () => {},
    onVideoState: () => {},
    onVideoClosed: () => {},
    autosaveRead: async () => null,
    autosaveWrite: async (d) => { calls.autosaveWrite.push(clone(d)); return { ok: true, path: '/tmp/autosave.json' }; },
    autosaveDelete: async () => ({ ok: true }),
    autosaveFlushSync: (d) => { calls.flushSync.push(clone(d)); return { ok: true }; },
    onCloseRequested: () => {},
    onAutosaveFlushRequested: () => {},
    closeProceed: () => {},
    _setLoadSession: (d) => { state.loadSessionData = d; },
    _calls: calls
  };
  return stub;
}

function boot(initial) {
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => { jsdomErrors.push(String(e.message || e)); });
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'file://' + path.join(srcDir, 'index.html'), virtualConsole: vc });
  const win = dom.window;
  const stub = makeStub(initial || {});
  win.matchtag = stub;
  win.eval(integritySrc);
  win.eval(analyticsSrc);
  win.eval(playerSeasonSrc);
  win.eval(rendererSrc);
  return { dom, win, doc: win.document, stub };
}

function click(el) { el.dispatchEvent(new el.ownerDocument.defaultView.MouseEvent('click', { bubbles: true, cancelable: true })); }
function contextmenu(el) { el.dispatchEvent(new el.ownerDocument.defaultView.MouseEvent('contextmenu', { bubbles: true, cancelable: true })); }
function tagBtn(doc, label) {
  return Array.from(doc.querySelectorAll('#tagButtons .tag-btn')).find((b) => b.textContent.replace(/⏱/g, '').trim().indexOf(label) === 0) || null;
}
function tagBtns(doc) { return Array.from(doc.querySelectorAll('#tagButtons .tag-btn')); }
function modalVisible(doc, id) { const m = doc.getElementById(id); return !!m && m.style.display === 'flex'; }
function lastLibrarySave(stub) { return stub._calls.saveTagLibrary[stub._calls.saveTagLibrary.length - 1] || null; }
function lastFlush(stub) {
  const arr = stub._calls.flushSync;
  return arr.length ? arr[arr.length - 1] : undefined; // null ("no work") is a REAL value
}

// Fill the Add/Edit modal and click confirm.
function fillModal(doc, opts) {
  doc.getElementById('newTagName').value = opts.name;
  doc.getElementById('newTagKey').value = opts.key || '';
  doc.getElementById('newTagModCtrl').checked = !!opts.ctrl;
  doc.getElementById('newTagModShift').checked = !!opts.shift;
  doc.getElementById('newTagModAlt').checked = !!opts.alt;
  doc.getElementById('newTagUseColor').checked = !!opts.color;
  doc.getElementById('newTagColor').value = opts.color || '#2ecc71';
  doc.getElementById('newTagSize').value = opts.size || '';
  doc.getElementById('newTagSubtypes').value = opts.subtypes || '';
  doc.getElementById('newTagQualifiers').value = opts.qualifiers || '';
  doc.getElementById('newTagIsInterval').checked = !!opts.interval;
  click(doc.getElementById('btnConfirmAddTag'));
}

function flushClose(B) { B.win.dispatchEvent(new B.win.Event('beforeunload')); }

(async () => {

  // =======================================================================
  section('STATIC — bridge, startup chain, op wiring (source-level)');
  // =======================================================================
  {
    ok('TL-S1: preload exposes loadTagLibrary / saveTagLibrary (tags:load / tags:save IPC)',
      /loadTagLibrary: \(\) => ipcRenderer\.invoke\('tags:load'\)/.test(preloadSrc) &&
      /saveTagLibrary: \(tags\) => ipcRenderer\.invoke\('tags:save', tags\)/.test(preloadSrc));
    ok('TL-S2: startup chain loadSquad → loadTagLibraryAtStartup → checkForRecoverableAutosave (strict order)',
      /window\.matchtag\.loadSquad\(\)[\s\S]*?\.finally\(\(\) => \{[\s\S]*?loadTagLibraryAtStartup\(\)[\s\S]*?\.finally\(\(\) => \{[\s\S]*?checkForRecoverableAutosave\(\);/.test(rendererSrc));
    ok('TL-S3: ALL four tag op sites sync the library (create/edit/delete upsert + touchline ensure)',
      /function applyTagCreate[\s\S]*?syncTagLibraryAfterOp\('upsert', label, librarySyncTag\);/.test(rendererSrc) &&
      /function applyTagEdit[\s\S]*?syncTagLibraryAfterOp\('upsert', oldLabel, tag\);/.test(rendererSrc) &&
      /tag\.active = false;[\s\S]*?syncTagLibraryAfterOp\('upsert', tag\.label, tag\);/.test(rendererSrc) &&
      /syncTagLibraryAfterOp\('ensure', label, tag\);/.test(rendererSrc));
    ok('TL-S4: session load + recovery switch scope WITHOUT writing the library',
      (rendererSrc.match(/tagsScope = 'session';\s*\n\s*captureTagsBaseline\(\);/g) || []).length === 2 &&
      !/doLoadSession[\s\S]{0,600}persistTagLibrary\(\)/.test(rendererSrc));
    ok('TL-S5: Restore-default-tags wired in the existing Add/Edit Tag modal (no parallel UI)',
      /btnRestoreDefaultTags/.test(html) &&
      /const btnRestoreDefaultTags = document\.getElementById\('btnRestoreDefaultTags'\);/.test(rendererSrc) &&
      /function restoreDefaultTags\(\) \{/.test(rendererSrc));
    ok('TL-S6: cd48114 tag-size CSS fix untouched (.tag-grid align-items: start stands)',
      /\/\* R2-E[\s\S]*?\*\/|\.tag-grid\s*\{[^}]*align-items\s*:\s*start/.test(stylesSrc) &&
      /\.tag-grid\s*\{[^}]*align-items\s*:\s*start/.test(stylesSrc.replace(/\/\*[\s\S]*?\*\//g, '')));
  }

  // A small customized library: differs from the pristine defaults in every
  // dimension Phase 3 must carry (size on a default, a custom tag, a
  // deactivated default, a substitution built-in).
  const LIB_SMALL = [
    { label: 'Goal', key: '1', size: 'l', qualifierGroups: [{ name: 'Body part', options: ['Left foot', 'Right foot', 'Head', 'Other'] }] },
    { label: 'Sub', key: '7', substitution: true },
    { label: 'Tackle', key: 'q', mods: ['ctrl'], color: '#00aa55' },
    { label: 'Corner', key: '6', active: false }
  ];

  // =======================================================================
  section('BOOT — library replaces the working set; nothing written back');
  // =======================================================================
  {
    const B = boot({ tagLibrary: { tags: LIB_SMALL } });
    const { doc, stub } = B;
    await sleep(300);

    ok('TL-B1: library loads at startup (loadTagLibrary called once)', stub._calls.loadTagLibraryCalls === 1);
    const btns = tagBtns(doc);
    ok('TL-B2: grid shows the LIBRARY\'s active tags (Goal, Sub, Tackle — NOT deactivated Corner, NOT the 19 defaults)',
      btns.length === 3 &&
      !!tagBtn(doc, 'Goal') && !!tagBtn(doc, 'Sub') && !!tagBtn(doc, 'Tackle') &&
      !tagBtn(doc, 'Corner') && !tagBtn(doc, 'Shot'),
      'buttons=' + btns.length);
    ok('TL-B3: per-tag customizations applied (Goal renders tag-btn-l from library size)',
      /tag-btn-l/.test(tagBtn(doc, 'Goal').className));
    ok('TL-B4: boot writes NOTHING back to the library (no saveTagLibrary call)',
      stub._calls.saveTagLibrary.length === 0);
    ok('TL-B5: no jsdom errors during boot', jsdomErrors.length === 0, jsdomErrors.slice(0, 3).join(' | '));
    B.dom.window.close();
  }

  // =======================================================================
  section('BASELINE — customized library boots clean; mid-session edit is work');
  // =======================================================================
  {
    const B = boot({ tagLibrary: { tags: LIB_SMALL } });
    const { doc, stub } = B;
    await sleep(300);

    // Dirty the session with a change that is NOT autosavable work by
    // itself (team select — the matchClock checks ignore selectedTeam):
    // with the Phase 1 pristine-default comparison this state produced a
    // PHANTOM autosave (library ≠ defaults); the session-start baseline
    // must recognize the library as the clean starting point.
    click(doc.getElementById('btnTeamOur'));
    await sleep(30);
    flushClose(B);
    ok('TL-B6: customized library + trivial dirty state → close flush sends NULL (no phantom autosave)',
      lastFlush(stub) === null, 'flush=' + JSON.stringify(lastFlush(stub)));

    // A tag edit during the session IS autosavable work (Phase 1 goal kept).
    const B2 = boot({ tagLibrary: { tags: LIB_SMALL } });
    const d2 = B2.doc, s2 = B2.stub;
    await sleep(300);
    contextmenu(tagBtn(d2, 'Goal'));
    fillModal(d2, { name: 'Goal', key: '1', size: 's' });
    await sleep(30);
    flushClose(B2);
    ok('TL-B7: a mid-session tag edit still counts as autosavable work (flush writes data)',
      lastFlush(s2) !== null && lastFlush(s2) !== undefined && lastFlush(s2).tags !== undefined,
      'flush=' + (lastFlush(s2) === null ? 'null' : 'data'));
    ok('TL-B8: the edit persisted to the library (one save, Goal now size s)',
      s2._calls.saveTagLibrary.length === 1 &&
      lastLibrarySave(s2).find((t) => t.label === 'Goal').size === 's');
    B.dom.window.close();
    B2.dom.window.close();
  }

  // =======================================================================
  section('MISSING / CORRUPT / OLD-BRIDGE libraries');
  // =======================================================================
  {
    // Missing: defaults, nothing written.
    const B = boot({ tagLibrary: null });
    const { doc, stub } = B;
    await sleep(300);
    ok('TL-B9: missing library → the 19 defaults render', tagBtns(doc).length === 19);
    ok('TL-B10: missing library → nothing written back', stub._calls.saveTagLibrary.length === 0);
    B.dom.window.close();

    // Corrupt: notice + defaults.
    const B2 = boot({ tagLibrary: { corrupt: true, path: '/tmp/xdg/tags.json' } });
    const d2 = B2.doc, s2 = B2.stub;
    await sleep(300);
    ok('TL-B11: corrupt library → the 19 defaults render (no crash)', tagBtns(d2).length === 19);
    const toast = d2.getElementById('autosaveToast');
    ok('TL-B12: corrupt library → explicit notice names the preserved .corrupt copy',
      toast.style.display === 'flex' &&
      /couldn\u2019t be read/.test(d2.getElementById('autosaveToastText').textContent) &&
      /tags\.json\.corrupt/.test(d2.getElementById('autosaveToastText').textContent));
    ok('TL-B13: corrupt library → nothing written back', s2._calls.saveTagLibrary.length === 0);
    B2.dom.window.close();

    // Old bridge (no methods): graceful degradation to defaults.
    const B3 = boot({ tagLibrary: undefined });
    const d3 = B3.doc, s3 = B3.stub;
    await sleep(300);
    ok('TL-B14: old preload (methods absent) → defaults render, no crash (graceful degradation)',
      tagBtns(d3).length === 19 && jsdomErrors.length === 0);
    B3.dom.window.close();
  }

  // =======================================================================
  section('OPS — create / edit / delete / reactivate all persist (global scope)');
  // =======================================================================
  {
    const B = boot({ tagLibrary: null });
    const { doc, stub } = B;
    await sleep(300);

    // Create a custom tag.
    click(doc.getElementById('btnAddCustom'));
    fillModal(doc, { name: 'Tackle', key: 'q', ctrl: true, color: '#ff5500', size: 'l', subtypes: 'Won, Lost' });
    await sleep(30);
    let payload = lastLibrarySave(stub);
    ok('TL-O1: create persists to the library (defaults + the new tag)',
      stub._calls.saveTagLibrary.length === 1 &&
      payload.length === 20 &&
      payload.find((t) => t.label === 'Tackle').key === 'q' &&
      JSON.stringify(payload.find((t) => t.label === 'Tackle').mods) === JSON.stringify(['ctrl']));

    // Edit a default tag in place.
    contextmenu(tagBtn(doc, 'Goal'));
    fillModal(doc, { name: 'Goal', key: '1', size: 'l' });
    await sleep(30);
    payload = lastLibrarySave(stub);
    ok('TL-O2: edit persists (Goal size l in the library, set still 20)',
      stub._calls.saveTagLibrary.length === 2 &&
      payload.length === 20 &&
      payload.find((t) => t.label === 'Goal').size === 'l');

    // Delete the custom tag (soft) — definition stays, active:false.
    contextmenu(tagBtn(doc, 'Tackle'));
    click(doc.getElementById('btnDeleteTag'));
    await sleep(30);
    ok('TL-O3: delete confirmation shown', modalVisible(doc, 'tagConfirmModal'));
    click(doc.getElementById('btnTagConfirmYes'));
    await sleep(30);
    payload = lastLibrarySave(stub);
    const deleted = payload.find((t) => t.label === 'Tackle');
    ok('TL-O4: delete persists as soft-delete (Tackle active:false, definition retained)',
      stub._calls.saveTagLibrary.length === 3 &&
      !!deleted && deleted.active === false && deleted.key === 'q');
    ok('TL-O5: deleted tag leaves the grid', !tagBtn(doc, 'Tackle'));

    // Re-create the same name → reactivation → active:true persists.
    click(doc.getElementById('btnAddCustom'));
    fillModal(doc, { name: 'Tackle', key: 'q', ctrl: true });
    await sleep(30);
    payload = lastLibrarySave(stub);
    ok('TL-O6: reactivation persists (Tackle active:true through the SAME validator path)',
      stub._calls.saveTagLibrary.length === 4 &&
      payload.find((t) => t.label === 'Tackle').active !== false &&
      !!tagBtn(doc, 'Tackle'));

    // Shortcut guards still hold with a library loaded. NOTE the Phase 2A
    // contract: CREATE with a duplicate-ACTIVE key takes the documented
    // T5b silent digit fallback (never a hard block); the hard blocks are
    // RESERVED combos on create and DUPLICATE-ACTIVE on edit/reactivate.
    click(doc.getElementById('btnAddCustom'));
    fillModal(doc, { name: 'NewTag', key: 'r', ctrl: true }); // reserved: menu reload
    await sleep(30);
    let err = doc.getElementById('addTagError');
    ok('TL-O7: RESERVED shortcut still rejected on create (blocked, nothing persisted)',
      err.style.display === 'block' && /reserved/.test(err.textContent) &&
      stub._calls.saveTagLibrary.length === 4 && !tagBtn(doc, 'NewTag'));
    click(doc.getElementById('btnCancelAddTag'));
    await sleep(30);
    contextmenu(tagBtn(doc, 'Tackle'));
    fillModal(doc, { name: 'Tackle', key: '1' }); // duplicate-ACTIVE: Goal holds '1'
    await sleep(30);
    err = doc.getElementById('addTagError');
    ok('TL-O8: duplicate ACTIVE shortcut still rejected on EDIT (blocked, nothing persisted)',
      err.style.display === 'block' && /already used/.test(err.textContent) &&
      stub._calls.saveTagLibrary.length === 4);
    click(doc.getElementById('btnCancelAddTag'));
    await sleep(30);

    // Substitution stays built-in-only and survives library edits.
    contextmenu(tagBtn(doc, 'Sub'));
    fillModal(doc, { name: 'Sub', key: '7', size: 's' });
    await sleep(30);
    payload = lastLibrarySave(stub);
    ok('TL-O9: editing Sub preserves substitution:true in the library (built-in-only behavior)',
      payload.find((t) => t.label === 'Sub').substitution === true &&
      payload.find((t) => t.label === 'Sub').size === 's');

    ok('TL-O10: no jsdom errors during the op sequence', jsdomErrors.length === 0, jsdomErrors.slice(0, 3).join(' | '));
    B.dom.window.close();
  }

  // =======================================================================
  section('RESTART — the saved library round-trips through a fresh boot');
  // =======================================================================
  {
    // Boot 1: pristine → create a custom tag.
    const B1 = boot({ tagLibrary: null });
    const d1 = B1.doc, s1 = B1.stub;
    await sleep(300);
    click(d1.getElementById('btnAddCustom'));
    fillModal(d1, { name: 'Tackle', key: 'q', color: '#ff5500', size: 'l' });
    await sleep(30);
    const saved = clone(lastLibrarySave(s1));
    B1.dom.window.close();

    // Boot 2 ("restart"): feed the saved payload back as tags.json.
    const B2 = boot({ tagLibrary: { tags: saved } });
    const d2 = B2.doc, s2 = B2.stub;
    await sleep(300);
    ok('TL-R1: custom tag SURVIVES the restart (renders from the library)',
      !!tagBtn(d2, 'Tackle') && /tag-btn-l/.test(tagBtn(d2, 'Tackle').className));
    ok('TL-R2: deactivated default would stay hidden across restart (Corner absent from LIB_SMALL boot — see TL-B2) and no write-back occurs',
      s2._calls.saveTagLibrary.length === 0);
    B2.dom.window.close();
  }

  // =======================================================================
  section('SESSION SCOPE — session tags authoritative; library still written (rulings 1–3)');
  // =======================================================================
  {
    const B = boot({ tagLibrary: { tags: LIB_SMALL } });
    const { doc, stub } = B;
    await sleep(300);

    // Load a session whose embedded tags differ from the library.
    stub._setLoadSession({
      videoPath: null,
      tags: [
        { label: 'Shot', key: '2', subtypes: ['On target', 'Off target', 'Blocked'] },
        { label: 'MySessionTag', key: '', color: '#d84b4b' }
      ],
      events: [{ id: 1, time: 10, label: 'Shot', side: 'for', team: 'our', subtype: 'On target', qualifiers: {}, playerId: null }],
      squad: [], matchInfo: {}, matchClock: {}
    });
    click(doc.getElementById('btnLoadSession'));
    await sleep(100);

    ok('TL-R3: the SESSION\'s tags replace the working set (Shot + MySessionTag render; library tags do not)',
      tagBtns(doc).length === 2 && !!tagBtn(doc, 'Shot') && !!tagBtn(doc, 'MySessionTag') && !tagBtn(doc, 'Goal'));
    ok('TL-R4: loading a session writes NOTHING to the library',
      stub._calls.saveTagLibrary.length === 0);

    // Edit a SESSION tag → persists to the library by UPCERT (ruling 1).
    // The modal owns every field it shows: pass the session tag's colour
    // through the fill so the edit KEEPS it (unchecking would clear it).
    contextmenu(tagBtn(doc, 'MySessionTag'));
    fillModal(doc, { name: 'MySessionTag', key: '', color: '#d84b4b', size: 'l' });
    await sleep(30);
    const payload = lastLibrarySave(stub);
    ok('TL-R5: editing a tag during a loaded session persists to the library (upsert)',
      stub._calls.saveTagLibrary.length === 1);
    ok('TL-R6: the library keeps its own base (Goal/Sub/Tackle untouched) and GAINS the session tag',
      payload.length === 5 &&
      payload.find((t) => t.label === 'Goal').size === 'l' &&
      payload.find((t) => t.label === 'MySessionTag').size === 'l' &&
      payload.find((t) => t.label === 'MySessionTag').color === '#d84b4b');
    ok('TL-R7: the working set stays the session\'s (2 buttons, library did not leak in)',
      tagBtns(doc).length === 2 && !tagBtn(doc, 'Goal'));

    // Rename relink in the library: renaming a session tag upserts by the
    // PRE-edit label, so the library entry follows the rename.
    contextmenu(tagBtn(doc, 'MySessionTag'));
    fillModal(doc, { name: 'RenamedTag', key: '', size: 'l' });
    await sleep(60); // rename of a tag with 0 matching events → no confirm needed
    const payload2 = lastLibrarySave(stub);
    ok('TL-R8: renaming a session tag RELINKS the library entry (no duplicate)',
      stub._calls.saveTagLibrary.length === 2 &&
      !payload2.find((t) => t.label === 'MySessionTag') &&
      !!payload2.find((t) => t.label === 'RenamedTag') &&
      payload2.length === 5);

    ok('TL-R9: no jsdom errors during the session-scope sequence', jsdomErrors.length === 0, jsdomErrors.slice(0, 3).join(' | '));
    B.dom.window.close();
  }

  // =======================================================================
  section('TOUCHLINE — auto-create joins the library additively (ensure)');
  // =======================================================================
  {
    const B = boot({ tagLibrary: { tags: [
      { label: 'Goal', key: '1' },
      { label: 'Shot', key: '2', subtypes: ['On target', 'Off target', 'Blocked'] }
    ] } });
    const { doc, stub } = B;
    await sleep(300);

    // Load a session WITHOUT a Shot definition (auto-create will fire).
    stub._setLoadSession({
      videoPath: null,
      tags: [{ label: 'Goal', key: '1' }],
      events: [], squad: [], matchInfo: {}, matchClock: {}
    });
    click(doc.getElementById('btnLoadSession'));
    await sleep(100);
    ok('TL-T1: session loaded without Shot (auto-create precondition)', !tagBtn(doc, 'Shot'));

    // Enter Touchline Mode and tap the Shot quick tag.
    click(doc.getElementById('btnTouchlineToggle'));
    await sleep(30);
    const shotQuick = Array.from(doc.querySelectorAll('#touchlineQuickTags .touchline-tag-btn'))
      .find((b) => b.textContent.replace(/⏱/g, '').trim() === 'Shot');
    ok('TL-T2: Shot quick-tag button rendered in touchline mode', !!shotQuick);
    click(shotQuick);
    await sleep(50);

    ok('TL-T3: auto-create fired in the working set (flat Shot button now in the grid)', !!tagBtn(doc, 'Shot'));
    const payload = lastLibrarySave(stub);
    ok('TL-T4: the auto-create persisted to the library WITHOUT flattening the configured Shot (ensure semantics)',
      stub._calls.saveTagLibrary.length === 1 &&
      JSON.stringify(payload.find((t) => t.label === 'Shot').subtypes) === JSON.stringify(['On target', 'Off target', 'Blocked']));
    // The session's own embedded set stays flat.
    click(doc.getElementById('btnSaveSession'));
    const sess = stub._calls.saveSession[stub._calls.saveSession.length - 1];
    ok('TL-T5: the session file embeds the working set\'s flat Shot (session stays authoritative)',
      sess.tags.find((t) => t.label === 'Shot').subtypes === undefined);
    ok('TL-T6: no jsdom errors during the touchline sequence', jsdomErrors.length === 0, jsdomErrors.slice(0, 3).join(' | '));
    B.dom.window.close();
  }

  // =======================================================================
  section('RESTORE — Restore default tags (global + session scope)');
  // =======================================================================
  {
    // Global scope: the working set resets with the library.
    const B = boot({ tagLibrary: { tags: LIB_SMALL } });
    const { doc, stub } = B;
    await sleep(300);

    click(doc.getElementById('btnAddCustom'));
    await sleep(30);
    click(doc.getElementById('btnRestoreDefaultTags'));
    await sleep(30);
    ok('TL-D1: strong confirmation modal shown',
      modalVisible(doc, 'tagConfirmModal'));
    const confirmText = doc.getElementById('tagConfirmText').textContent;
    ok('TL-D2: the confirmation quantifies what is discarded and promises session files are untouched',
      /Restore the DEFAULT tag library/.test(confirmText) &&
      /1 custom tag/.test(confirmText) && /Tackle/.test(confirmText) &&
      /deactivated default tag/.test(confirmText) &&
      /NOT modified/.test(confirmText));
    click(doc.getElementById('btnTagConfirmYes'));
    await sleep(50);

    const payload = lastLibrarySave(stub);
    const labels = (payload || []).map((t) => t.label);
    ok('TL-D3: the library is reset to the pristine 19 defaults',
      stub._calls.saveTagLibrary.length === 1 &&
      payload.length === 19 &&
      JSON.stringify(labels) === JSON.stringify(CANONICAL_19));
    ok('TL-D4: customizations and deletions are gone (no size on Goal, no inactive tags, no Tackle)',
      !('size' in payload.find((t) => t.label === 'Goal')) &&
      !payload.some((t) => t.active === false) &&
      !payload.find((t) => t.label === 'Tackle'));
    ok('TL-D5: the working set reset with it (19 buttons, Corner back, Tackle gone)',
      tagBtns(doc).length === 19 && !!tagBtn(doc, 'Corner') && !tagBtn(doc, 'Tackle'));
    ok('TL-D6: the Add Tag modal closed and feedback toast shown',
      !modalVisible(doc, 'addTagModal') &&
      doc.getElementById('autosaveToast').style.display === 'flex' &&
      /Default tags restored/.test(doc.getElementById('autosaveToastText').textContent));
    // Cancel path: nothing happens.
    click(doc.getElementById('btnAddCustom'));
    await sleep(30);
    click(doc.getElementById('btnRestoreDefaultTags'));
    await sleep(30);
    click(doc.getElementById('btnTagConfirmNo'));
    await sleep(30);
    ok('TL-D7: CANCELLING the restore changes nothing (no extra library write, modal flow closes)',
      stub._calls.saveTagLibrary.length === 1 && !modalVisible(doc, 'tagConfirmModal'));
    click(doc.getElementById('btnCancelAddTag'));
    ok('TL-D8: no jsdom errors during the restore sequence', jsdomErrors.length === 0, jsdomErrors.slice(0, 3).join(' | '));
    B.dom.window.close();
  }
  {
    // Session scope: the working set stays; only the library resets.
    const B = boot({ tagLibrary: { tags: LIB_SMALL } });
    const { doc, stub } = B;
    await sleep(300);
    stub._setLoadSession({
      videoPath: null,
      tags: [{ label: 'Shot', key: '2' }, { label: 'MySessionTag', key: '' }],
      events: [], squad: [], matchInfo: {}, matchClock: {}
    });
    click(doc.getElementById('btnLoadSession'));
    await sleep(100);

    click(doc.getElementById('btnAddCustom'));
    await sleep(30);
    click(doc.getElementById('btnRestoreDefaultTags'));
    await sleep(30);
    const confirmText = doc.getElementById('tagConfirmText').textContent;
    ok('TL-D9: session-scope confirmation says the loaded session KEEPS its tags',
      /currently loaded session keeps its own tags/.test(confirmText));
    click(doc.getElementById('btnTagConfirmYes'));
    await sleep(50);

    const payload = lastLibrarySave(stub);
    ok('TL-D10: the LIBRARY resets to the pristine 19',
      stub._calls.saveTagLibrary.length === 1 && payload.length === 19);
    ok('TL-D11: the SESSION working set is untouched (Shot + MySessionTag still render — ruling 2)',
      tagBtns(doc).length === 2 && !!tagBtn(doc, 'Shot') && !!tagBtn(doc, 'MySessionTag'));
    ok('TL-D12: session-scope restore toast explains the scope',
      /session keeps its own tags/.test(doc.getElementById('autosaveToastText').textContent));
    ok('TL-D13: no jsdom errors during the session-scope restore', jsdomErrors.length === 0, jsdomErrors.slice(0, 3).join(' | '));
    B.dom.window.close();
  }

  // ---------------------------------------------------------------------------
  const pass = results.filter((r) => r.pass).length;
  const fail = results.length - pass;
  console.log('\n===== RESULTS =====');
  (fail ? results.filter((r) => !r.pass) : []).forEach((r) => {
    console.log('  FAIL [' + r.section + '] ' + r.name + (r.detail ? '  (' + r.detail + ')' : ''));
  });
  console.log('---- tag-library renderer check: ' + pass + ' passed, ' + fail + ' failed ----');
  process.exit(fail ? 1 : 0);

})().catch((err) => {
  console.error('tag-library renderer check: harness crashed:', err);
  process.exit(1);
});
