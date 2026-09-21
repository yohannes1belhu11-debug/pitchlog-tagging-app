#!/usr/bin/env node
// PitchLog / MatchTag — R2-E Phase 2A: Shortcut System harness.
// =====================================================================
// Verification-only harness. It does NOT modify any app source file.
//
// Verifies the Phase 2A shortcut system against Specification v4.1
// (v4 + AMD-1/AMD-2/AMD-3):
//
//   IDENTITY   §5/§6  shortcut identity model: derived (key + exact
//                     modifier set), NONE = keyless (dispatches nothing,
//                     conflicts with nothing, NONE-vs-NONE allowed),
//                     case-insensitive character comparison, malformed
//                     stored shortcut fields preserved + inert (no silent
//                     mutation), meta→ctrl for dispatch only (R5).
//   RESERVED   §7     two enforcement layers over ONE evidence-based set:
//                     assignment blocks (invalid/reserved categories) and
//                     dispatch protection (Case B: reserved identity in
//                     stored data never fires).
//   UNDO       §13    the EXACT both-assertions guard (Ctrl OR Meta) AND
//                     (typeof string 'z', case-insensitive, no shift/alt
//                     exclusion) — full matrix.
//   CONFLICTS  §10    three categories (invalid → reserved → duplicate),
//                     fixed validation order, non-mutating duplicates (R1):
//                     duplicate-ACTIVE blocks, duplicate-INACTIVE only
//                     warns.
//   REACTIVATION AMD-2 R-1: soft-delete reactivation passes the SAME
//                     shared validator as edit/save; T5b silent fallback
//                     prohibited (empty key → NONE); blocked reactivation
//                     mutates nothing; inactive tags are inert (REACT-1..6).
//   DISPATCH   §6     unified exact-identity dispatch for EVERY tag —
//                     the Phase 1 legacy quirk (Ctrl+3 firing the plain
//                     '3' tag) is closed; B1–B7 binding groups (all seven
//                     modifier combinations) dispatch exactly; duplicates
//                     are first-match-wins (Case A); NONE never dispatches.
//   DIAGNOSTICS §15   three channels: inline modal error (assignment),
//                     warn-dot (stored-data states), console warnings
//                     (structured, once per changed set).
//   VIEWS      R4/R7  effective-form derived badge labels, fixed modifier
//                     order Ctrl→Alt→Shift, badge truncation + title.
//   UI         R8     the Clear button resets key + modifiers to NONE.
//   LEGACY     compat old v4 sessions load unchanged; bare-key dispatch
//                     preserved; T5b digit fallback preserved for CREATE
//                     (R3: the scan skips reserved identities).
//
// NAT-4 (AMD-1): the numpad ctrl+'+' question is an OPEN pre-delivery
// gate — the interim no-inference rule is pinned here: ('+'|ctrl) is NOT
// treated as reserved (assignable), while ('+'|ctrl+shift) IS reserved
// (the Stage 0-confirmed zoom-in identity).
//
// HONEST SCOPE: jsdom boots verify DOM wiring and data flow only. The
// menu-accelerator surface itself (whether Electron's default menu fires
// on a combo) is NOT observable from jsdom — that is what the Stage 0
// xdotool evidence and the real-Electron QA gate cover. jsdom dispatch
// tests exercise the renderer's own decision logic given a keydown event.
//
// Run:  node tests/shortcut-system-check.js   (from the project root)
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

// ---------------------------------------------------------------------------
// jsdom boot (same architecture as tag-controls-check.js) + console.warn
// capture for the §15 channel-3 diagnostics.
// ---------------------------------------------------------------------------
const warnCalls = [];

function makeStub(initial) {
  const calls = { saveSession: [], autosaveWrite: [], loadSessionCalls: 0 };
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
    detachVideo: async () => true,
    reattachVideo: async () => true,
    sendVideoCommand: () => {},
    onVideoState: () => {},
    onVideoClosed: () => {},
    autosaveRead: async () => null,
    autosaveWrite: async (d) => { calls.autosaveWrite.push(clone(d)); return { ok: true, path: '/tmp/autosave.json' }; },
    autosaveDelete: async () => ({ ok: true }),
    autosaveFlushSync: () => ({ ok: true }),
    onCloseRequested: () => {},
    onAutosaveFlushRequested: () => {},
    closeProceed: () => {},
    _setLoadSession: (d) => { state.loadSessionData = d; },
    _calls: calls
  };
  return stub;
}

function boot(initial) {
  warnCalls.length = 0;
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => { jsdomErrors.push(String(e.message || e)); });
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'file://' + path.join(srcDir, 'index.html'), virtualConsole: vc });
  const win = dom.window;
  // §15 channel 3: capture console.warn BEFORE the renderer boots.
  win.console.warn = (...args) => { warnCalls.push(args.join(' ')); };
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
function pressKey(win, key, opts) {
  win.dispatchEvent(new win.KeyboardEvent('keydown', Object.assign({ key, bubbles: true, cancelable: true }, opts || {})));
}
// A keydown with NO string key at all (typeof-guard edge, §13).
function pressBareKeydown(win, props) {
  const ev = new win.Event('keydown', { bubbles: true, cancelable: true });
  Object.assign(ev, props || {});
  win.dispatchEvent(ev);
}
function tagBtn(doc, label) {
  return Array.from(doc.querySelectorAll('#tagButtons .tag-btn')).find((b) => b.textContent.replace(/⏱/g, '').trim().indexOf(label) === 0) || null;
}
function modalVisible(doc, id) { const m = doc.getElementById(id); return !!m && m.style.display === 'flex'; }
function modalError(doc) { const e = doc.getElementById('addTagError'); return e ? e.textContent : ''; }

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

function lastSave(stub) { return stub._calls.saveSession[stub._calls.saveSession.length - 1] || null; }
function captureEvents(win, doc, stub) {
  const done = doc.getElementById('detailPanelDone');
  if (done) click(done);
  click(doc.getElementById('btnSaveSession'));
  const s = lastSave(stub);
  return s ? s.events : null;
}
function eventCount(win, doc, stub, label) {
  const evs = captureEvents(win, doc, stub) || [];
  return label ? evs.filter((e) => e.label === label).length : evs.length;
}
function shortcutWarns() { return warnCalls.filter((w) => w.indexOf('[PitchLog][shortcut]') === 0); }
function loadSessionFixture(B, tags, events) {
  B.stub._setLoadSession({
    __schemaVersion: 4,
    videoPath: null,
    events: events || [],
    tags,
    squad: [],
    matchInfo: {},
    matchClock: null
  });
  click(B.doc.getElementById('btnLoadSession'));
}
function deleteTagFlow(doc, label) {
  contextmenu(tagBtn(doc, label));
  click(doc.getElementById('btnDeleteTag'));
  click(doc.getElementById('btnTagConfirmYes'));
}
function defOf(saved, label) { return saved.tags ? saved.tags.find((t) => t.label === label) : null; }

(async () => {

  // =======================================================================
  section('STATIC — the Phase 2A contract, pinned at source level');
  // =======================================================================
  {
    ok('SSC-S1a: §13 exact undo guard present verbatim (both assertions + typeof)',
      /\(e\.ctrlKey \|\| e\.metaKey\) && typeof e\.key === 'string' && e\.key\.toLowerCase\(\) === 'z'/.test(rendererSrc));
    ok('SSC-S1b: the old pre-Phase-2A undo guard is gone (no meta-less variant)',
      !/if \(e\.ctrlKey && e\.key\.toLowerCase\(\) === 'z'\)/.test(rendererSrc));
    ok('SSC-S2a: reserved set registers every Stage 0-confirmed accelerator',
      /reserveShortcut\('r', \['ctrl'\], 'menu accelerator: reload'\);/.test(rendererSrc) &&
      /reserveShortcut\('r', \['ctrl', 'shift'\], 'menu accelerator: force reload'\);/.test(rendererSrc) &&
      /reserveShortcut\('i', \['ctrl', 'shift'\], 'menu accelerator: developer tools'\);/.test(rendererSrc) &&
      /reserveShortcut\('-', \['ctrl'\], 'menu accelerator: zoom out'\);/.test(rendererSrc) &&
      /reserveShortcut\('0', \['ctrl'\], 'menu accelerator: reset zoom'\);/.test(rendererSrc) &&
      /reserveShortcut\('\+', \['ctrl', 'shift'\], 'menu accelerator: zoom in'\);/.test(rendererSrc) &&
      /reserveShortcut\('w', \['ctrl'\], 'menu accelerator: close window'\);/.test(rendererSrc) &&
      /reserveShortcut\('f11', \[\], 'menu accelerator: toggle fullscreen'\);/.test(rendererSrc));
    ok('SSC-S2b: undo z-family reserved (all ctrl-supersets of z)',
      /reserveShortcut\('z', \['ctrl'\], 'app function: undo \(Ctrl\/Cmd\+Z\)'\);/.test(rendererSrc) &&
      /reserveShortcut\('z', \['ctrl', 'shift'\]/.test(rendererSrc) &&
      /reserveShortcut\('z', \['ctrl', 'alt'\]/.test(rendererSrc) &&
      /reserveShortcut\('z', \['ctrl', 'alt', 'shift'\]/.test(rendererSrc));
    ok('SSC-S2c: app function keys reserved across ALL modifier states (space/escape/arrows)',
      /\[' ', 'app function: play\/pause \(Space\)'\]/.test(rendererSrc) &&
      /for \(const mods of ALL_MOD_COMBOS\) reserveShortcut\(reservedAppKey\[0\], mods, reservedAppKey\[1\]\);/.test(rendererSrc));
    ok('SSC-S3: ONE shared validator wired into all three write paths (create new / create-reactivation / edit)',
      /const check = validateTagShortcut\(key, mods, inactive\);/.test(rendererSrc) &&
      /const check = validateTagShortcut\(key, mods, null\);/.test(rendererSrc) &&
      /const shortcutCheck = validateTagShortcut\(key, mods, tag\);/.test(rendererSrc) &&
      (rendererSrc.match(/validateTagShortcut\(key, mods, (?:inactive|null|tag)\)/g) || []).length === 3);
    ok('SSC-S4: normalizeTagFields no longer touches the shortcut fields (no silent mutation)',
      (() => {
        const m = rendererSrc.match(/function normalizeTagFields\(tag\) \{[\s\S]*?\n  \}/);
        return !!m && !/tag\.(key|mods) =/.test(m[0]);
      })());
    ok('SSC-S5: validator order is invalid → reserved → duplicate (§10 fixed order)',
      (() => {
        const m = rendererSrc.match(/function validateTagShortcut\(key, mods, exceptTag\) \{[\s\S]*?\n  \}/);
        if (!m) return false;
        const iInvalid = m[0].indexOf("category: 'invalid'");
        const iReserved = m[0].indexOf("category: 'reserved'");
        const iDup = m[0].indexOf("category: 'duplicate-active'");
        return iInvalid > -1 && iReserved > iInvalid && iDup > iReserved;
      })());
    ok('SSC-S6: T5b digit scan skips reserved identities (R3)',
      /if \(reservedShortcutWhy\(d, mods\)\) continue;/.test(rendererSrc));
    ok('SSC-S7: meta→ctrl mapping is dispatch-only (eventShortcutIdentity), never stored',
      /if \(e\.ctrlKey \|\| e\.metaKey\) mods\.push\('ctrl'\);/.test(rendererSrc) &&
      !/mods\.push\('meta'\)/.test(rendererSrc));
    ok('SSC-S8: Clear button present in the modal + wired (R8)',
      /id="btnClearShortcut"/.test(html) &&
      /btnClearShortcut\.addEventListener\('click'/.test(rendererSrc));
    ok('SSC-S9: warn-dot CSS + badge truncation CSS present',
      /\.tag-warn-dot\s*\{/.test(stylesSrc) &&
      /\.tag-btn \.key\s*\{[^}]*text-overflow: ellipsis;/.test(stylesSrc));
    ok('SSC-S10: effective-form badge derives from the stored identity (R4/R7 order Ctrl→Alt→Shift)',
      /function shortcutDisplayLabel\(tag\) \{[\s\S]*?parts\.push\('Ctrl'\);[\s\S]*?parts\.push\('Alt'\);[\s\S]*?parts\.push\('Shift'\);[\s\S]*?parts\.push\(tag\.key\);/.test(rendererSrc));
    ok('SSC-S11: attribute-safe escaping for badge/warn-dot titles',
      /function escapeAttr\(str\)/.test(rendererSrc));
    ok('SSC-S12: NAT-4 interim no-inference rule — ctrl+'+' (no shift) is NOT reserved; ctrl+shift+'+' IS',
      !/reserveShortcut\('\+', \['ctrl'\],/.test(rendererSrc) &&
      /reserveShortcut\('\+', \['ctrl', 'shift'\],/.test(rendererSrc));
  }

  // =======================================================================
  section('IDENTITY — NONE, case, malformed preservation, meta→ctrl (§5/§6/R5)');
  // =======================================================================
  {
    // NONE: keyless tags never dispatch and never conflict (incl. NONE-vs-NONE).
    const B = boot({});
    const { win, doc, stub } = B;
    await sleep(300);
    click(doc.getElementById('btnAddCustom'));
    fillModal(doc, { name: 'Keyless One' }); // edit-path not used; create: empty key -> T5b digit fallback
    await sleep(30);
    // All 10 digits are taken by defaults -> keyless (T5b trade-off).
    const saved0 = lastSave(stub) || { tags: [] };
    const k1 = defOf(saved0, 'Keyless One');
    // (The create fallback may assign a digit; to force NONE, EDIT the tag to empty.)
    contextmenu(tagBtn(doc, 'Keyless One'));
    doc.getElementById('newTagKey').value = '';
    click(doc.getElementById('btnConfirmAddTag'));
    await sleep(30);
    click(doc.getElementById('btnAddCustom'));
    fillModal(doc, { name: 'Keyless Two', key: 'x' });
    await sleep(30);
    contextmenu(tagBtn(doc, 'Keyless Two'));
    doc.getElementById('newTagKey').value = '';
    click(doc.getElementById('btnConfirmAddTag'));
    await sleep(30);
    click(doc.getElementById('btnSaveSession'));
    const saved = lastSave(stub);
    ok('SSC-I1a: two keyless (NONE) tags coexist — NONE never conflicts (§5)',
      defOf(saved, 'Keyless One') && defOf(saved, 'Keyless Two') &&
      defOf(saved, 'Keyless One').key === '' && defOf(saved, 'Keyless Two').key === '');
    // A key whose letter is pressed bare/with modifiers never fires a NONE tag.
    pressKey(win, 'x', {}); await sleep(20);
    pressKey(win, 'x', { ctrlKey: true }); await sleep(20);
    ok('SSC-I1b: NONE never dispatches (press x and Ctrl+X: zero events)',
      eventCount(win, doc, stub) === 0);
    // Badge: keyless tags render an empty badge and NO warn-dot.
    const btn = tagBtn(doc, 'Keyless One');
    ok('SSC-I1c: keyless tag renders empty badge, no warn-dot',
      !!btn && btn.querySelector('.key').textContent === '' &&
      !btn.querySelector('.tag-warn-dot'));
    B.dom.window.close();
  }

  {
    // Case-insensitive identity + meta→ctrl dispatch (R5).
    const B = boot({});
    const { win, doc, stub } = B;
    await sleep(300);
    click(doc.getElementById('btnAddCustom'));
    fillModal(doc, { name: 'Upper K', key: 'K', ctrl: true }); // stored uppercase char
    await sleep(30);
    click(doc.getElementById('btnAddCustom'));
    fillModal(doc, { name: 'Lower K', key: 'k', alt: true }); // same letter, different identity
    await sleep(30);
    // ('K'|ctrl) and ('k'|alt) are DIFFERENT identities — both stored fine.
    pressKey(win, 'k', { ctrlKey: true }); await sleep(20); // fires Upper K (case-insensitive)
    pressKey(win, 'K', { altKey: true }); await sleep(20);   // fires Lower K (case-insensitive, uppercase event key)
    const evs = captureEvents(win, doc, stub) || [];
    ok('SSC-I2a: case-insensitive character identity (stored K fires on k; stored k fires on K)',
      evs.filter((e) => e.label === 'Upper K').length === 1 &&
      evs.filter((e) => e.label === 'Lower K').length === 1,
      'labels=' + JSON.stringify(evs.map((e) => e.label)));
    pressKey(win, 'k', { metaKey: true }); await sleep(20);  // fires Upper K via meta→ctrl (R5)
    const evsMeta = captureEvents(win, doc, stub) || [];
    ok('SSC-I2b: meta maps to ctrl for dispatch only — Cmd/Cmd-equivalent+K fires the Ctrl+K tag (R5)',
      evsMeta.filter((e) => e.label === 'Upper K').length === 2,
      'upperK=' + evsMeta.filter((e) => e.label === 'Upper K').length);
    // Stored side never gains 'meta'.
    click(doc.getElementById('btnSaveSession'));
    const saved = lastSave(stub);
    const uk = defOf(saved, 'Upper K');
    ok('SSC-I2c: meta is never a storable modifier (payload mods stay ctrl only)',
      JSON.stringify(uk.mods) === '["ctrl"]');
    // Case-mixed stored mods tokens are valid at the identity layer without mutation.
    // (Fresh boot: loading into a dirty session is guarded by the unsaved-changes
    // flow — each fixture load gets its own boot.)
    const B2 = boot({});
    loadSessionFixture(B2, [{ label: 'Case Mods', key: 'n', mods: ['Ctrl', 'ALT'] }, { label: 'Goal', key: '1' }]);
    await sleep(100);
    pressKey(B2.win, 'n', { ctrlKey: true, altKey: true }); await sleep(20);
    const evs2 = captureEvents(B2.win, B2.doc, B2.stub) || [];
    ok('SSC-I2d: case-mixed stored mods tokens canonicalize at the identity layer (Ctrl/ALT fires on ctrl+alt)',
      evs2.filter((e) => e.label === 'Case Mods').length === 1,
      'labels=' + JSON.stringify(evs2.map((e) => e.label)));
    click(B2.doc.getElementById('btnSaveSession'));
    const saved2 = lastSave(B2.stub);
    ok('SSC-I2e: the stored mods field is NOT rewritten (["Ctrl","ALT"] preserved verbatim)',
      JSON.stringify(defOf(saved2, 'Case Mods').mods) === '["Ctrl","ALT"]');
    B2.dom.window.close();
    B.dom.window.close();
  }

  {
    // Malformed stored shortcut fields: preserved, inert, diagnosed (no inference).
    const B = boot({});
    const { win, doc, stub } = B;
    await sleep(300);
    loadSessionFixture(B, [
      { label: 'Mal Key Num', key: 5 },                    // non-string key
      { label: 'Mal Key Long', key: 'ab' },                // multi-char key
      { label: 'Mal Mods Str', key: 's', mods: 'ctrl' },   // non-array mods
      { label: 'Mal Mods Tok', key: 't', mods: ['ctrl', 'meta'] }, // unknown token
      { label: 'Goal', key: '1' }
    ]);
    await sleep(100);
    ok('SSC-I3a: malformed shortcut fields do not crash the load (all render)',
      !!tagBtn(doc, 'Mal Key Num') && !!tagBtn(doc, 'Mal Key Long') &&
      !!tagBtn(doc, 'Mal Mods Str') && !!tagBtn(doc, 'Mal Mods Tok'));
    ok('SSC-I3b: every malformed tag gets a warn-dot (channel 2)',
      ['Mal Key Num', 'Mal Key Long', 'Mal Mods Str', 'Mal Mods Tok']
        .every((l) => tagBtn(doc, l) && !!tagBtn(doc, l).querySelector('.tag-warn-dot')));
    // Inert on every plausible keypress: their raw key characters (5/'5', 'a', 's', 't') fire nothing.
    pressKey(win, '5'); await sleep(20);
    pressKey(win, 's', { ctrlKey: true }); await sleep(20);
    pressKey(win, 't', { ctrlKey: true }); await sleep(20);
    ok('SSC-I3c: malformed shortcuts are dispatch-inert (no key fires them)',
      eventCount(win, doc, stub) === 0);
    // Preservation through save (no silent mutation).
    click(doc.getElementById('btnSaveSession'));
    const saved = lastSave(stub);
    ok('SSC-I3d: malformed fields PRESERVED through save (key:5, key:"ab", mods:"ctrl", mods incl. "meta" verbatim)',
      defOf(saved, 'Mal Key Num').key === 5 &&
      defOf(saved, 'Mal Key Long').key === 'ab' &&
      defOf(saved, 'Mal Mods Str').mods === 'ctrl' &&
      JSON.stringify(defOf(saved, 'Mal Mods Tok').mods) === '["ctrl","meta"]');
    // Channel 3: console warned for each malformed tag (once per changed set).
    ok('SSC-I3e: console diagnostics fired for the malformed set (channel 3)',
      shortcutWarns().some((w) => w.indexOf('Mal Mods Str') > -1 && w.indexOf('malformed') > -1));
    B.dom.window.close();
  }

  // =======================================================================
  section('RESERVED — assignment layer (§7)');
  // =======================================================================
  {
    const B = boot({});
    const { win, doc, stub } = B;
    await sleep(300);

    // Each reserved accelerator combo is blocked at assignment with the category message.
    const reservedAttempts = [
      { name: 'Block Reload', key: 'r', ctrl: true, expect: 'reload' },
      { name: 'Block HardReload', key: 'r', ctrl: true, shift: true, expect: 'force reload' },
      { name: 'Block Devtools', key: 'i', ctrl: true, shift: true, expect: 'developer tools' },
      { name: 'Block ZoomOut', key: '-', ctrl: true, expect: 'zoom out' },
      { name: 'Block ZoomReset', key: '0', ctrl: true, expect: 'reset zoom' },
      { name: 'Block ZoomIn', key: '+', ctrl: true, shift: true, expect: 'zoom in' },
      { name: 'Block CloseWin', key: 'w', ctrl: true, expect: 'close window' }
    ];
    let allBlocked = true;
    const details = [];
    for (const att of reservedAttempts) {
      click(doc.getElementById('btnAddCustom'));
      fillModal(doc, att);
      await sleep(30);
      const blocked = modalVisible(doc, 'addTagModal') &&
        /is reserved/.test(modalError(doc)) && modalError(doc).indexOf(att.expect) > -1;
      if (!blocked) { allBlocked = false; details.push(att.name + ':' + modalError(doc)); }
      click(doc.getElementById('btnCancelAddTag'));
      await sleep(20);
    }
    ok('SSC-R1: every Stage 0-confirmed accelerator combo is BLOCKED at assignment, with the accelerator named',
      allBlocked, details.join(' | '));

    // Undo z-family blocked at assignment (all ctrl-supersets of z).
    const zAttempts = [
      { ctrl: true }, { ctrl: true, shift: true }, { ctrl: true, alt: true }, { ctrl: true, alt: true, shift: true }
    ];
    let zBlocked = true;
    const zDetails = [];
    for (const mods of zAttempts) {
      click(doc.getElementById('btnAddCustom'));
      fillModal(doc, Object.assign({ name: 'Block Z', key: 'z' }, mods));
      await sleep(30);
      const blocked = modalVisible(doc, 'addTagModal') && /is reserved/.test(modalError(doc));
      if (!blocked) { zBlocked = false; zDetails.push(JSON.stringify(mods)); }
      click(doc.getElementById('btnCancelAddTag'));
      await sleep(20);
    }
    ok('SSC-R2: the undo z-family (every ctrl-superset of z) is BLOCKED at assignment',
      zBlocked, zDetails.join(' | '));

    // Bare z is FREE (only ctrl-supersets are the undo family).
    click(doc.getElementById('btnAddCustom'));
    fillModal(doc, { name: 'Zed Tag', key: 'z' });
    await sleep(30);
    ok('SSC-R3: bare z (no ctrl/meta) is free and assignable',
      !modalVisible(doc, 'addTagModal') && !!tagBtn(doc, 'Zed Tag'));
    click(doc.getElementById('btnCancelAddTag'));

    // FREE combos (Stage 0-confirmed): ctrl+x, alt+f, ctrl+= (key '='), ctrl+j.
    let freeOk = true;
    const freeDetails = [];
    for (const att of [
      { name: 'Free Cut', key: 'x', ctrl: true },
      { name: 'Free AltF', key: 'f', alt: true },
      { name: 'Free CtrlEq', key: '=', ctrl: true },
      { name: 'Free CtrlJ', key: 'j', ctrl: true }
    ]) {
      click(doc.getElementById('btnAddCustom'));
      fillModal(doc, att);
      await sleep(30);
      if (modalVisible(doc, 'addTagModal') || !tagBtn(doc, att.name)) {
        freeOk = false; freeDetails.push(att.name + ':' + modalError(doc));
        click(doc.getElementById('btnCancelAddTag'));
      }
      await sleep(20);
    }
    ok('SSC-R4: Stage 0-confirmed FREE combos assign cleanly (ctrl+x, alt+f, ctrl+=, ctrl+j)',
      freeOk, freeDetails.join(' | '));

    // NAT-4 interim rule: ('+'|ctrl) is NOT reserved (no inference); ('+'|ctrl+shift) IS.
    click(doc.getElementById('btnAddCustom'));
    fillModal(doc, { name: 'Numpad Plus Ctrl', key: '+', ctrl: true });
    await sleep(30);
    ok('SSC-R5: NAT-4 interim no-inference — ctrl+"+" (numpad-reachable, no shift) is assignable',
      !modalVisible(doc, 'addTagModal') && !!tagBtn(doc, 'Numpad Plus Ctrl'));

    // Reserved block on the EDIT path too.
    contextmenu(tagBtn(doc, 'Zed Tag'));
    doc.getElementById('newTagKey').value = 'r';
    doc.getElementById('newTagModCtrl').checked = true;
    click(doc.getElementById('btnConfirmAddTag'));
    await sleep(30);
    ok('SSC-R6: editing a tag ONTO a reserved combo is blocked with the inline error',
      modalVisible(doc, 'addTagModal') && /is reserved/.test(modalError(doc)));
    click(doc.getElementById('btnCancelAddTag'));

    // Space is reserved for every modifier state — verifiable via dispatch
    // protection on file-loaded data (the modal trims ' ' to '', so the UI
    // cannot even attempt it; see SSC-RP2).
    ok('SSC-R7: space reserved across all modifier states (source enumeration)',
      /\[' ', 'app function: play\/pause \(Space\)'\]/.test(rendererSrc));

    // Console diagnostics accompanied the blocked assignments (channel 3).
    ok('SSC-R8: blocked assignments also warn on the console (channel 3)',
      shortcutWarns().some((w) => w.indexOf('blocked (reserved)') > -1));

    B.dom.window.close();
  }

  // =======================================================================
  section('DISPATCH LAYER — Case B protection (§7)');
  // =======================================================================
  {
    // Reserved identities in STORED data (Phase 1 session / hand-edited file)
    // never dispatch: the accelerator / app function wins.
    const B = boot({});
    const { win, doc, stub } = B;
    await sleep(300);
    loadSessionFixture(B, [
      { label: 'Legacy Reload', key: 'r', mods: ['ctrl'] },     // Phase 1 allowed this!
      { label: 'Legacy ZoomIn', key: '+', mods: ['ctrl', 'shift'] },
      { label: 'Legacy Space', key: ' ' },
      { label: 'Pass', key: '3' }
    ]);
    await sleep(100);
    ok('SSC-RP1a: reserved identities in stored data render (non-mutating) with warn-dots',
      !!tagBtn(doc, 'Legacy Reload') && !!tagBtn(doc, 'Legacy Reload').querySelector('.tag-warn-dot') &&
      !!tagBtn(doc, 'Legacy ZoomIn').querySelector('.tag-warn-dot') &&
      !!tagBtn(doc, 'Legacy Space').querySelector('.tag-warn-dot'));
    pressKey(win, 'r', { ctrlKey: true }); await sleep(20);
    pressKey(win, '+', { ctrlKey: true, shiftKey: true }); await sleep(20);
    pressKey(win, ' '); await sleep(20);
    pressKey(win, '3'); await sleep(20); // control: the free bare key still fires
    const evs = captureEvents(win, doc, stub) || [];
    ok('SSC-RP1b: reserved identities NEVER dispatch (ctrl+r / ctrl+shift+"+" / space fire nothing)',
      evs.filter((e) => e.label === 'Legacy Reload' || e.label === 'Legacy ZoomIn' || e.label === 'Legacy Space').length === 0,
      'labels=' + JSON.stringify(evs.map((e) => e.label)));
    ok('SSC-RP1c: control — the free bare key on the same boot still dispatches (Pass on 3)',
      evs.filter((e) => e.label === 'Pass').length === 1);
    // The z-family dispatch protection: a stored ctrl+z tag never fires; undo wins.
    const B2 = boot({});
    loadSessionFixture(B2, [
      { label: 'Legacy Undo', key: 'z', mods: ['ctrl'] },
      { label: 'Shot', key: '2' }
    ]);
    await sleep(100);
    pressKey(B2.win, '2'); await sleep(20);       // one Shot event
    pressKey(B2.win, 'z', { ctrlKey: true }); await sleep(20); // undo (NOT the Legacy Undo tag)
    const evs2 = captureEvents(B2.win, B2.doc, B2.stub) || [];
    ok('SSC-RP2: a stored ctrl+z tag never fires — the §13 undo wins (Shot logged then undone: 0 events)',
      evs2.length === 0, 'count=' + evs2.length);
    // Stored data preserved (non-mutating protection).
    click(B2.doc.getElementById('btnSaveSession'));
    const saved = lastSave(B2.stub);
    ok('SSC-RP3: protected stored definitions are preserved verbatim (no mutation)',
      defOf(saved, 'Legacy Undo') && defOf(saved, 'Legacy Undo').key === 'z' &&
      JSON.stringify(defOf(saved, 'Legacy Undo').mods) === '["ctrl"]');
    B2.dom.window.close();
    B.dom.window.close();
  }

  // =======================================================================
  section('UNDO MATRIX — §13 both assertions');
  // =======================================================================
  {
    const B = boot({});
    const { win, doc, stub } = B;
    await sleep(300);
    click(doc.getElementById('btnAddCustom'));
    fillModal(doc, { name: 'Undo Probe', key: 'u' });
    await sleep(30);

    // (ctrl, z) fires undo.
    pressKey(win, 'u'); await sleep(20);
    pressKey(win, 'z', { ctrlKey: true }); await sleep(20);
    ok('SSC-U1: Ctrl+Z undoes the last event',
      eventCount(win, doc, stub) === 0);
    // (meta, z) fires undo — R5.
    pressKey(win, 'u'); await sleep(20);
    pressKey(win, 'z', { metaKey: true }); await sleep(20);
    ok('SSC-U2: Meta+Z undoes the last event (meta maps to ctrl for undo)',
      eventCount(win, doc, stub) === 0);
    // (ctrl+shift, 'Z' uppercase) fires undo — case-insensitive, no shift exclusion.
    pressKey(win, 'u'); await sleep(20);
    pressKey(win, 'Z', { ctrlKey: true, shiftKey: true }); await sleep(20);
    ok('SSC-U3: Ctrl+Shift+Z (uppercase Z) undoes — no shift exclusion, case-insensitive',
      eventCount(win, doc, stub) === 0);
    // (ctrl+alt, z) fires undo — no alt exclusion.
    pressKey(win, 'u'); await sleep(20);
    pressKey(win, 'z', { ctrlKey: true, altKey: true }); await sleep(20);
    ok('SSC-U4: Ctrl+Alt+Z undoes — no alt exclusion',
      eventCount(win, doc, stub) === 0);
    // A keydown with NO string key: the typeof guard prevents a crash, no undo.
    pressKey(win, 'u'); await sleep(20);
    let bareCrashed = false;
    try { pressBareKeydown(win, { ctrlKey: true }); await sleep(20); } catch (e) { bareCrashed = true; }
    ok('SSC-U5: keydown without a string key does not crash and does not undo (typeof guard)',
      !bareCrashed && eventCount(win, doc, stub) === 1);
    // Modifier assertion: bare z is NOT undo — it dispatches a bare-z tag.
    click(doc.getElementById('btnAddCustom'));
    fillModal(doc, { name: 'Bare Z Tag', key: 'z' });
    await sleep(30);
    pressKey(win, 'z'); await sleep(20);
    const evs = captureEvents(win, doc, stub) || [];
    ok('SSC-U6: bare z is NOT undo — it fires the bare-z tag (modifier assertion)',
      evs.some((e) => e.label === 'Bare Z Tag') && evs.some((e) => e.label === 'Undo Probe'),
      'labels=' + JSON.stringify(evs.map((e) => e.label)));
    // Key assertion: ctrl+y is neither undo nor a tag.
    pressKey(win, 'y', { ctrlKey: true }); await sleep(20);
    ok('SSC-U7: Ctrl+Y is neither undo nor a tag (key assertion)',
      eventCount(win, doc, stub) === 2);
    B.dom.window.close();
  }

  // =======================================================================
  section('CONFLICTS — three categories, fixed order, non-mutating (§10/R1)');
  // =======================================================================
  {
    const B = boot({});
    const { win, doc, stub } = B;
    await sleep(300);

    // duplicate-active on CREATE: T5b silent digit fallback (preserved, create only).
    // NOTE: with mods=['ctrl'] the digit scan runs on (digit, ctrl) combos —
    // ('0', ctrl) is RESERVED (zoom reset) and the R3 skip rule makes the
    // scan pick '1' (the first free NON-reserved digit+ctrl combo).
    click(doc.getElementById('btnAddCustom'));
    fillModal(doc, { name: 'Owner', key: 'm', ctrl: true });
    await sleep(30);
    click(doc.getElementById('btnAddCustom'));
    fillModal(doc, { name: 'Claimer', key: 'm', ctrl: true });
    await sleep(30);
    ok('SSC-C1a: create with a duplicate combo silently falls back (T5b preserved for create) — and the R3 skip rule avoids the reserved Ctrl+0 (Claimer gets Ctrl+1)',
      !modalVisible(doc, 'addTagModal') && !!tagBtn(doc, 'Claimer') &&
      tagBtn(doc, 'Claimer').querySelector('.key').textContent === 'Ctrl+1',
      'badge=' + (tagBtn(doc, 'Claimer') ? tagBtn(doc, 'Claimer').querySelector('.key').textContent : 'none'));

    // duplicate-active on EDIT: blocked, names the conflicting tag.
    click(doc.getElementById('btnAddCustom'));
    fillModal(doc, { name: 'Editor', key: 'e' });
    await sleep(30);
    contextmenu(tagBtn(doc, 'Editor'));
    doc.getElementById('newTagKey').value = 'm';
    doc.getElementById('newTagModCtrl').checked = true;
    click(doc.getElementById('btnConfirmAddTag'));
    await sleep(30);
    ok('SSC-C1b: edit onto a duplicate-active combo is BLOCKED and names the other tag',
      modalVisible(doc, 'addTagModal') && /already used by tag "Owner"/.test(modalError(doc)));
    click(doc.getElementById('btnCancelAddTag'));

    // duplicate-INACTIVE: non-mutating warning only (allowed).
    deleteTagFlow(doc, 'Owner'); // Owner (ctrl+m) becomes inactive
    await sleep(50);
    click(doc.getElementById('btnAddCustom'));
    fillModal(doc, { name: 'Reuse M', key: 'm', ctrl: true });
    await sleep(30);
    ok('SSC-C2a: a combo held only by an INACTIVE tag is assignable (non-mutating duplicate, R1)',
      !modalVisible(doc, 'addTagModal') && !!tagBtn(doc, 'Reuse M'));
    ok('SSC-C2b: the duplicate-inactive case warns on the console (channel 3)',
      shortcutWarns().some((w) => w.indexOf('deleted tag "Owner"') > -1));
    // The inactive definition kept its stored fields (nothing mutated).
    click(doc.getElementById('btnSaveSession'));
    const saved = lastSave(stub);
    ok('SSC-C2c: the inactive tag kept its stored combo verbatim',
      defOf(saved, 'Owner') && defOf(saved, 'Owner').active === false &&
      defOf(saved, 'Owner').key === 'm' && JSON.stringify(defOf(saved, 'Owner').mods) === '["ctrl"]');
    // Reactivating Owner onto ctrl+m now BLOCKS (Reuse M holds it) — REACT-2 below covers the same rule.
    click(doc.getElementById('btnAddCustom'));
    fillModal(doc, { name: 'Owner', key: 'm', ctrl: true });
    await sleep(30);
    ok('SSC-C2d: reactivating onto the now-taken combo is BLOCKED (edit/save-equivalent validation)',
      modalVisible(doc, 'addTagModal') && /already used by tag "Reuse M"/.test(modalError(doc)));
    click(doc.getElementById('btnCancelAddTag'));

    // Validation order: reserved BEFORE duplicate (a combo that is both
    // reserved and held by another active tag reports RESERVED).
    const B2 = boot({});
    loadSessionFixture(B2, [
      { label: 'File Reload', key: 'r', mods: ['ctrl'] }, // active + reserved (Case B data)
      { label: 'Editor', key: 'e' }
    ]);
    await sleep(100);
    contextmenu(tagBtn(B2.doc, 'Editor'));
    B2.doc.getElementById('newTagKey').value = 'r';
    B2.doc.getElementById('newTagModCtrl').checked = true;
    click(B2.doc.getElementById('btnConfirmAddTag'));
    await sleep(30);
    ok('SSC-C3: validation order — a both-reserved-and-duplicate combo reports RESERVED (§7 before §10)',
      modalVisible(B2.doc, 'addTagModal') && /is reserved/.test(modalError(B2.doc)) &&
      !/already used/.test(modalError(B2.doc)));
    click(B2.doc.getElementById('btnCancelAddTag'));

    // NONE never conflicts (already SSC-I1a) — and invalid is checked first:
    // a multi-char key reports invalid, not reserved/duplicate.
    contextmenu(tagBtn(B2.doc, 'Editor'));
    B2.doc.getElementById('newTagKey').value = 'ab'; // jsdom has no maxlength enforcement
    click(B2.doc.getElementById('btnConfirmAddTag'));
    await sleep(30);
    ok('SSC-C4: a malformed candidate reports INVALID first (§6 before §7/§10)',
      modalVisible(B2.doc, 'addTagModal') && /not valid/.test(modalError(B2.doc)));
    click(B2.doc.getElementById('btnCancelAddTag'));

    B2.dom.window.close();
    B.dom.window.close();
  }

  // =======================================================================
  section('REACTIVATION — AMD-2 clause R-1 (REACT-1..6)');
  // =======================================================================
  {
    // REACT-1: valid submitted shortcut reactivates with the submitted values.
    const B = boot({});
    const { win, doc, stub } = B;
    await sleep(300);
    click(doc.getElementById('btnAddCustom'));
    fillModal(doc, { name: 'Reactor', key: 't', color: '#aa44cc' });
    await sleep(30);
    deleteTagFlow(doc, 'Reactor');
    await sleep(50);
    click(doc.getElementById('btnAddCustom'));
    fillModal(doc, { name: 'Reactor', key: 'v', ctrl: true, color: '#aa44cc' });
    await sleep(30);
    click(doc.getElementById('btnSaveSession'));
    const saved = lastSave(stub);
    const defs = saved.tags.filter((tg) => tg.label === 'Reactor');
    ok('REACT-1: reactivation with a valid submitted shortcut applies the SUBMITTED values (single def, active, ctrl+v, colour re-submitted)',
      defs.length === 1 && defs[0].active !== false && defs[0].key === 'v' &&
      JSON.stringify(defs[0].mods) === '["ctrl"]' && defs[0].color === '#aa44cc' &&
      !!tagBtn(doc, 'Reactor') && tagBtn(doc, 'Reactor').querySelector('.key').textContent === 'Ctrl+v',
      'defs=' + JSON.stringify(defs));
    // The reactivated combo dispatches.
    pressKey(win, 'v', { ctrlKey: true }); await sleep(20);
    ok('REACT-1b: the reactivated combo dispatches exactly',
      eventCount(win, doc, stub, 'Reactor') === 1);
    B.dom.window.close();
  }

  {
    // REACT-2: reactivation onto a combo held by another ACTIVE tag is blocked.
    const B = boot({});
    const { doc, stub } = B;
    await sleep(300);
    click(doc.getElementById('btnAddCustom'));
    fillModal(doc, { name: 'Reactor', key: 't' });
    await sleep(30);
    deleteTagFlow(doc, 'Reactor');
    await sleep(50);
    click(doc.getElementById('btnAddCustom'));
    fillModal(doc, { name: 'Taker', key: 't' });
    await sleep(30);
    click(doc.getElementById('btnAddCustom'));
    fillModal(doc, { name: 'Reactor', key: 't' });
    await sleep(30);
    ok('REACT-2: reactivation onto a combo held by an ACTIVE tag is BLOCKED (no T5b fallback)',
      modalVisible(doc, 'addTagModal') && /already used by tag "Taker"/.test(modalError(doc)));
    click(doc.getElementById('btnCancelAddTag'));
    // REACT-5 (same boot): the blocked reactivation mutated NOTHING on the stored def.
    click(doc.getElementById('btnSaveSession'));
    const saved = lastSave(stub);
    const rdef = defOf(saved, 'Reactor');
    ok('REACT-5: a blocked reactivation leaves the stored inactive definition untouched',
      rdef && rdef.active === false && rdef.key === 't' && !('mods' in rdef));
    B.dom.window.close();
  }

  {
    // REACT-3: reactivation onto a RESERVED combo is blocked; REACT-5 immutability.
    const B = boot({});
    const { doc, stub } = B;
    await sleep(300);
    click(doc.getElementById('btnAddCustom'));
    fillModal(doc, { name: 'Reactor', key: 't', color: '#123456', subtypes: 'X, Y' });
    await sleep(30);
    const beforeDelete = clone((() => { click(doc.getElementById('btnSaveSession')); return lastSave(stub); })().tags.find((tg) => tg.label === 'Reactor'));
    deleteTagFlow(doc, 'Reactor');
    await sleep(50);
    click(doc.getElementById('btnAddCustom'));
    fillModal(doc, { name: 'Reactor', key: 'r', ctrl: true });
    await sleep(30);
    ok('REACT-3: reactivation onto a RESERVED combo is BLOCKED with the reserved diagnostic',
      modalVisible(doc, 'addTagModal') && /is reserved/.test(modalError(doc)));
    click(doc.getElementById('btnCancelAddTag'));
    click(doc.getElementById('btnSaveSession'));
    const saved = lastSave(stub);
    const after = defOf(saved, 'Reactor');
    ok('REACT-5b: blocked reactivation — stored fields byte-identical to the pre-delete definition (plus active:false)',
      JSON.stringify(after) === JSON.stringify(Object.assign({}, beforeDelete, { active: false })),
      'after=' + JSON.stringify(after));
    B.dom.window.close();
  }

  {
    // REACT-4: reactivation with an EMPTY key reactivates as keyless (NONE) —
    // the T5b silent digit fallback is prohibited on the reactivation path.
    const B = boot({});
    const { doc, stub } = B;
    await sleep(300);
    click(doc.getElementById('btnAddCustom'));
    fillModal(doc, { name: 'Reactor', key: 't' });
    await sleep(30);
    deleteTagFlow(doc, 'Reactor');
    await sleep(50);
    // Free a digit so a fallback WOULD have a candidate if it (wrongly) ran.
    deleteTagFlow(doc, 'Duel'); // frees '0'
    await sleep(50);
    click(doc.getElementById('btnAddCustom'));
    fillModal(doc, { name: 'Reactor' }); // empty key
    await sleep(30);
    click(doc.getElementById('btnSaveSession'));
    const saved = lastSave(stub);
    const rdef = defOf(saved, 'Reactor');
    ok('REACT-4: reactivation with an empty key reactivates as KEYLESS (no silent digit fallback, even with a digit free)',
      rdef && rdef.active !== false && rdef.key === '' &&
      !!tagBtn(doc, 'Reactor') && tagBtn(doc, 'Reactor').querySelector('.key').textContent === '',
      'def=' + JSON.stringify(rdef));
    B.dom.window.close();
  }

  {
    // REACT-6: inactive tags are inert — their stored key does not dispatch,
    // and they hold no exclusive claim (a new tag may take the same combo:
    // SSC-C2a) — here we pin the dispatch inertness directly.
    const B = boot({});
    const { win, doc, stub } = B;
    await sleep(300);
    click(doc.getElementById('btnAddCustom'));
    fillModal(doc, { name: 'Ghost', key: 'g', ctrl: true });
    await sleep(30);
    deleteTagFlow(doc, 'Ghost');
    await sleep(50);
    pressKey(win, 'g', { ctrlKey: true }); await sleep(20);
    ok('REACT-6: an inactive tag never dispatches (its stored combo is inert)',
      eventCount(win, doc, stub) === 0);
    B.dom.window.close();
  }

  // =======================================================================
  section('UNIFIED DISPATCH — exact identity, B1–B7 binding groups, Case A');
  // =======================================================================
  {
    const B = boot({});
    const { win, doc, stub } = B;
    await sleep(300);

    // Legacy compat: the bare digit still fires (muscle memory preserved).
    pressKey(win, '2'); await sleep(20);
    ok('SSC-D1: legacy bare-key dispatch unchanged (press 2 -> Shot)',
      eventCount(win, doc, stub, 'Shot') === 1);

    // THE FIX: the Phase 1 legacy quirk is closed — Ctrl+digit no longer
    // fires the plain digit tag, on ANY modifier.
    pressKey(win, '3', { ctrlKey: true }); await sleep(20);
    pressKey(win, '3', { metaKey: true }); await sleep(20);
    pressKey(win, '3', { shiftKey: true }); await sleep(20);
    pressKey(win, '3', { altKey: true }); await sleep(20);
    pressKey(win, '9', { ctrlKey: true }); await sleep(20); // Press ('9')
    pressKey(win, '0', { ctrlKey: true }); await sleep(20); // Duel ('0') — also §7 protected
    ok('SSC-D2: the legacy modifier quirk is CLOSED (Ctrl/Meta/Shift/Alt+3, Ctrl+9, Ctrl+0 fire nothing)',
      eventCount(win, doc, stub) === 1);

    // B1–B7 binding groups: all seven modifier combinations dispatch
    // exactly — each on its own key, then the full 8-combo cross-matrix.
    const groups = [
      { name: 'B1 Ctrl', key: 'b', ctrl: true },
      { name: 'B2 Alt', key: 'c', alt: true },
      { name: 'B3 Shift', key: 'd', shift: true },
      { name: 'B4 CtrlAlt', key: 'e', ctrl: true, alt: true },
      { name: 'B5 CtrlShift', key: 'f', ctrl: true, shift: true },
      { name: 'B6 AltShift', key: 'g', alt: true, shift: true },
      { name: 'B7 CtrlAltShift', key: 'h', ctrl: true, alt: true, shift: true }
    ];
    for (const g of groups) {
      click(doc.getElementById('btnAddCustom'));
      fillModal(doc, g);
      await sleep(20);
    }
    const combos = [
      {}, { ctrlKey: true }, { altKey: true }, { shiftKey: true },
      { ctrlKey: true, altKey: true }, { ctrlKey: true, shiftKey: true },
      { altKey: true, shiftKey: true }, { ctrlKey: true, altKey: true, shiftKey: true }
    ];
    let matrixOk = true;
    const matrixDetail = [];
    for (const g of groups) {
      for (const combo of combos) {
        pressKey(win, g.key, combo);
        await sleep(10);
      }
    }
    // Only the 7 exact matches fired (plus the pre-existing Shot event from SSC-D1).
    const evs = captureEvents(win, doc, stub) || [];
    const byLabel = {};
    evs.forEach((e) => { byLabel[e.label] = (byLabel[e.label] || 0) + 1; });
    for (const g of groups) {
      if (byLabel[g.name] !== 1) { matrixOk = false; matrixDetail.push(g.name + '=' + (byLabel[g.name] || 0)); }
    }
    const groupEventCount = evs.filter((e) => groups.some((g) => g.name === e.label)).length;
    ok('SSC-D3: B1–B7 binding groups — every modifier combination fires its tag EXACTLY once (7 keys × 8 combos pressed, only the 7 exact matches fired)',
      matrixOk && groupEventCount === 7, 'groupEvents=' + groupEventCount + ' ' + matrixDetail.join(','));
    // ...and each group's badge shows the R7-ordered effective form.
    const b7 = tagBtn(doc, 'B7 CtrlAltShift');
    ok('SSC-D4: R7 label order — the ctrl+alt+shift tag badges as "Ctrl+Alt+Shift+h"',
      !!b7 && b7.querySelector('.key').textContent === 'Ctrl+Alt+Shift+h');
    const b1 = tagBtn(doc, 'B1 Ctrl');
    ok('SSC-D4b: single-modifier badge form ("Ctrl+b") + title tooltip',
      !!b1 && b1.querySelector('.key').textContent === 'Ctrl+b' &&
      b1.querySelector('.key').getAttribute('title') === 'Ctrl+b');

    // Case A: duplicate identities in stored data — both warn-dotted,
    // first-match-wins, non-mutating. (Fresh boot for the fixture load.)
    const BA = boot({});
    loadSessionFixture(BA, [
      { label: 'Dup First', key: 'm' },
      { label: 'Dup Second', key: 'm' },
      { label: 'Shot', key: '2' }
    ]);
    await sleep(100);
    ok('SSC-D5a: Case A — both duplicate tags render with warn-dots',
      !!tagBtn(BA.doc, 'Dup First').querySelector('.tag-warn-dot') &&
      !!tagBtn(BA.doc, 'Dup Second').querySelector('.tag-warn-dot'));
    pressKey(BA.win, 'm'); await sleep(20);
    const evsA = captureEvents(BA.win, BA.doc, BA.stub) || [];
    ok('SSC-D5b: Case A — first-match-wins dispatch (exactly one event, from the FIRST definition)',
      evsA.filter((e) => e.label === 'Dup First').length === 1 &&
      evsA.filter((e) => e.label === 'Dup Second').length === 0,
      'labels=' + JSON.stringify(evsA.map((e) => e.label)));
    const warnsCaseA = warnCalls.filter((w) => w.indexOf('shares the shortcut') > -1).length;
    ok('SSC-D5c: Case A — console diagnostics flag both duplicates (once per changed set)',
      warnsCaseA >= 2, 'warns=' + warnsCaseA);
    click(BA.doc.getElementById('btnSaveSession'));
    const savedA = lastSave(BA.stub);
    ok('SSC-D5d: Case A — nothing is auto-fixed (both definitions preserved verbatim)',
      defOf(savedA, 'Dup First').key === 'm' && defOf(savedA, 'Dup Second').key === 'm');
    BA.dom.window.close();
    B.dom.window.close();
  }

  // =======================================================================
  section('DIAGNOSTICS — three channels (§15)');
  // =======================================================================
  {
    const B = boot({});
    const { win, doc, stub } = B;
    await sleep(300);
    loadSessionFixture(B, [
      { label: 'Reserved One', key: 'r', mods: ['ctrl'] }
    ]);
    await sleep(100);
    const warnsAfterLoad = shortcutWarns().length;
    ok('SSC-G1a: a reserved stored shortcut warns on the console at render (channel 3)',
      warnsAfterLoad >= 1 && shortcutWarns().some((w) => w.indexOf('Reserved One') > -1 && w.indexOf('reserved') > -1));
    // Spam guard: a re-render with the SAME diagnostic set does not re-warn.
    click(doc.getElementById('btnAddCustom'));
    fillModal(doc, { name: 'Clean Tag', key: 'n' }); // triggers renderTagButtons
    await sleep(30);
    ok('SSC-G1b: re-render with an unchanged diagnostic set does NOT re-warn (spam guard)',
      shortcutWarns().length === warnsAfterLoad,
      'before=' + warnsAfterLoad + ' after=' + shortcutWarns().length);
    // Fixing the tag clears the dot and does not warn again.
    contextmenu(tagBtn(doc, 'Reserved One'));
    doc.getElementById('newTagKey').value = 'o';
    doc.getElementById('newTagModCtrl').checked = false;
    click(doc.getElementById('btnConfirmAddTag'));
    await sleep(30);
    ok('SSC-G2: editing the tag to a free combo clears the warn-dot (state-derived, non-mutating)',
      !!tagBtn(doc, 'Reserved One') && !tagBtn(doc, 'Reserved One').querySelector('.tag-warn-dot') &&
      tagBtn(doc, 'Reserved One').querySelector('.key').textContent === 'o');
    // The inline modal error (channel 1) blocks assignment-time conflicts.
    click(doc.getElementById('btnAddCustom'));
    fillModal(doc, { name: 'Try Reserved', key: 'i', ctrl: true, shift: true });
    await sleep(30);
    ok('SSC-G3: channel 1 — the inline modal error names the reserved combo and reason',
      modalVisible(doc, 'addTagModal') &&
      /Ctrl\+Shift\+i is reserved \(menu accelerator: developer tools\)/.test(modalError(doc)));
    click(doc.getElementById('btnCancelAddTag'));
    B.dom.window.close();
  }

  // =======================================================================
  section('UI — Clear button (R8) and derived views');
  // =======================================================================
  {
    const B = boot({});
    const { doc, stub } = B;
    await sleep(300);
    click(doc.getElementById('btnAddCustom'));
    fillModal(doc, { name: 'Clearable', key: 'k', ctrl: true, alt: true });
    await sleep(30);
    ok('SSC-V1: the tag exists with its Ctrl+Alt+k badge',
      !!tagBtn(doc, 'Clearable') && tagBtn(doc, 'Clearable').querySelector('.key').textContent === 'Ctrl+Alt+k');
    // Edit mode: prefill, then Clear.
    contextmenu(tagBtn(doc, 'Clearable'));
    ok('SSC-V2a: edit modal prefills key + modifier checkboxes',
      doc.getElementById('newTagKey').value === 'k' &&
      doc.getElementById('newTagModCtrl').checked === true &&
      doc.getElementById('newTagModAlt').checked === true);
    click(doc.getElementById('btnClearShortcut'));
    await sleep(20);
    ok('SSC-V2b: Clear empties the key input and unchecks all modifiers',
      doc.getElementById('newTagKey').value === '' &&
      !doc.getElementById('newTagModCtrl').checked &&
      !doc.getElementById('newTagModShift').checked &&
      !doc.getElementById('newTagModAlt').checked);
    click(doc.getElementById('btnConfirmAddTag'));
    await sleep(30);
    click(doc.getElementById('btnSaveSession'));
    const saved = lastSave(stub);
    ok('SSC-V3: saving after Clear yields the NONE identity (keyless, mods field removed)',
      defOf(saved, 'Clearable').key === '' && !('mods' in defOf(saved, 'Clearable')) &&
      tagBtn(doc, 'Clearable').querySelector('.key').textContent === '');
    // Clear in CREATE mode also works (fresh modal).
    click(doc.getElementById('btnAddCustom'));
    doc.getElementById('newTagKey').value = 'z';
    doc.getElementById('newTagModShift').checked = true;
    click(doc.getElementById('btnClearShortcut'));
    await sleep(20);
    fillModal(doc, { name: 'Cleared Create' }); // fillModal resets fields anyway; confirm NONE create
    await sleep(30);
    click(doc.getElementById('btnSaveSession'));
    const saved2 = lastSave(stub);
    ok('SSC-V4: create after Clear (empty submit) falls back per T5b — keyless when no digit is free',
      defOf(saved2, 'Cleared Create').key === '');
    B.dom.window.close();
  }

  // =======================================================================
  section('LEGACY + PERSISTENCE — old files, round-trips, non-mutation');
  // =======================================================================
  {
    // Old v4 file (no R2-E fields at all): loads, bare-key dispatch works.
    const B = boot({});
    const { win, doc, stub } = B;
    await sleep(300);
    loadSessionFixture(B, [
      { label: 'Goal', key: '1' },
      { label: 'Pass', key: '3' },
      { label: 'Old Custom', key: '' }
    ]);
    await sleep(100);
    pressKey(win, '3'); await sleep(20);
    const evs = captureEvents(win, doc, stub) || [];
    ok('SSC-L1: an old v4 session loads and its bare keys still dispatch (Pass on 3)',
      evs.filter((e) => e.label === 'Pass').length === 1);
    // A Phase 1-era file with a reserved combo loads protected + preserved (round-trip).
    // (Fresh boot: the previous load left the session dirty — the load guard
    // would block a second in-place load.)
    const B2 = boot({});
    loadSessionFixture(B2, [
      { label: 'Phase1 Reload', key: 'r', mods: ['ctrl'] },
      { label: 'Goal', key: '1' }
    ]);
    await sleep(100);
    pressKey(B2.win, 'r', { ctrlKey: true }); await sleep(20);
    const evs2 = captureEvents(B2.win, B2.doc, B2.stub) || [];
    click(B2.doc.getElementById('btnSaveSession'));
    const saved = lastSave(B2.stub);
    ok('SSC-L2: a Phase 1 file with ctrl+r loads PROTECTED (no dispatch) and round-trips verbatim (no mutation)',
      evs2.filter((e) => e.label === 'Phase1 Reload').length === 0 &&
      defOf(saved, 'Phase1 Reload').key === 'r' &&
      JSON.stringify(defOf(saved, 'Phase1 Reload').mods) === '["ctrl"]');
    // Session schema still v4 (no bump) — pinned at the source of truth
    // (the renderer payload itself carries no version field; main.js owns it).
    const mainSrc = fs.readFileSync(path.join(srcDir, 'main.js'), 'utf8');
    ok('SSC-L3: session schema remains v4 (additive identity model, no stored shape change)',
      /CURRENT_SCHEMA_VERSION = 4/.test(mainSrc) &&
      // and the identity model added NO stored field: tags still serialize
      // the Phase 1 field set only (label/key/subtypes/…/mods/color/size/active).
      defOf(saved, 'Phase1 Reload') &&
      !('identity' in defOf(saved, 'Phase1 Reload')) &&
      !('shortcut' in defOf(saved, 'Phase1 Reload')));
    B2.dom.window.close();
    B.dom.window.close();
  }

  // =======================================================================
  section('AUTO-ASSIGN — T5b preserved for create, R3 skip rule');
  // =======================================================================
  {
    const B = boot({});
    const { doc, stub } = B;
    await sleep(300);
    // All 10 digits are taken by the 19 defaults -> a taken-key create is keyless.
    click(doc.getElementById('btnAddCustom'));
    fillModal(doc, { name: 'No Free', key: '2' }); // '2' is Shot's key
    await sleep(30);
    ok('SSC-A1: T5b trade-off preserved — taken key + no free digit -> keyless',
      !!tagBtn(doc, 'No Free') && tagBtn(doc, 'No Free').querySelector('.key').textContent === '');
    // Free a digit (delete Duel, key '0') -> the fallback picks '0' (scan order 0..9).
    deleteTagFlow(doc, 'Duel');
    await sleep(50);
    click(doc.getElementById('btnAddCustom'));
    fillModal(doc, { name: 'Free Digit', key: '2' }); // taken -> fallback
    await sleep(30);
    ok('SSC-A2: T5b fallback picks the first FREE digit (0 after Duel is deleted)',
      !!tagBtn(doc, 'Free Digit') && tagBtn(doc, 'Free Digit').querySelector('.key').textContent === '0');
    // The fallback never hands out a reserved identity (digits are never
    // reserved — the R3 skip rule is pinned at source level by SSC-S6; here
    // we pin the invariant behaviorally: the assigned key is a bare digit).
    click(doc.getElementById('btnSaveSession'));
    const saved = lastSave(stub);
    ok('SSC-A3: the fallback result is always a bare digit (never a reserved combo)',
      /^[0-9]$/.test(defOf(saved, 'Free Digit').key) &&
      !('mods' in defOf(saved, 'Free Digit')));
    B.dom.window.close();
  }

  // =======================================================================
  section('RESULTS');
  // =======================================================================
  let pass = 0, fail = 0;
  results.forEach((r) => { if (r.pass) pass++; else fail++; });
  results.forEach((r) => {
    if (!r.pass) console.log('  FAIL [' + r.section + '] ' + r.name + (r.detail ? '  (' + r.detail + ')' : ''));
  });
  console.log('\n---- shortcut system check: ' + pass + ' passed, ' + fail + ' failed ----');
  if (jsdomErrors.length) {
    console.log('jsdom errors (' + jsdomErrors.length + '): ' + jsdomErrors.slice(0, 5).join(' | '));
  }
  if (fail > 0 || jsdomErrors.length > 0) process.exit(1);
})().catch((err) => { console.error('HARNESS CRASH:', err); process.exit(1); });
