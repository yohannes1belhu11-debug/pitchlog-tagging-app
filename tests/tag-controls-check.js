#!/usr/bin/env node
// PitchLog / MatchTag — R2-E Phase 1: Tag Customization Foundation harness.
// =====================================================================
// Verification-only harness. It does NOT modify any app source file.
//
// Covers ONLY the Phase 1 foundation (per the R2-E Phase 1 task book):
//
//   MODEL      optional per-tag fields (color / size / mods / active) are
//              default-safe: old v4 sessions without them load unchanged,
//              new fields survive create/edit -> save -> reload, malformed
//              optional fields are sanitized instead of crashing the load.
//   CREATION   the existing Add Tag flow, extended with shortcut modifiers,
//              colour and size; existing tag properties preserved.
//   EDITING    the Add Tag modal in edit mode (right-click a tag button):
//              name / key / modifiers / colour / size editing with subtype,
//              qualifier-group, interval and substitution config preserved.
//   RENAME     controlled historical relink: affected-event count shown,
//              all matching events relinked, unrelated events and all other
//              event fields untouched, canonical (default) labels protected,
//              duplicate labels blocked.
//   DELETE     soft delete: the tag leaves every active surface (button
//              grid, keyboard dispatch, type filter, Touchline quick tags —
//              no auto-create resurrection) while its events, its label in
//              filters and its full definition (active:false) are preserved;
//              re-creating the same label reactivates the definition.
//   DISPATCH   legacy plain-key dispatch byte-identical for tags without
//              mods; tags WITH mods require exactly those modifiers.
//   AUTOSAVE   in-place customization (no length change) is recognized as
//              autosavable work via the default-set signature.
//
// NOT covered here (out of Phase 1 scope): the complete shortcut system
// (conflict matrix UX, reassignment flows), the complete appearance system
// (grid-wide scaling, text-size controls), Touchline customization beyond
// the delete-safety guard. Canonical CSV contracts and analytics contracts
// are pinned by the existing battery (r2a / r2b / season-csv / analytics
// suites) which must stay green alongside this suite.
//
// HONEST SCOPE: jsdom boots verify DOM wiring and data flow only. Real
// right-click context menus, native colour pickers, live keyboard input and
// the visual colour/size rendering in Electron require manual verification.
//
// Run:  node tests/tag-controls-check.js   (from the project root)
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
const mainSrc = fs.readFileSync(path.join(srcDir, 'main.js'), 'utf8');

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
// jsdom boot (same architecture as tag-set-completeness-check.js)
// ---------------------------------------------------------------------------
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
function pressKey(win, key, opts) {
  win.dispatchEvent(new win.KeyboardEvent('keydown', Object.assign({ key, bubbles: true, cancelable: true }, opts || {})));
}
function tagBtn(doc, label) {
  return Array.from(doc.querySelectorAll('#tagButtons .tag-btn')).find((b) => b.textContent.replace(/⏱/g, '').trim().indexOf(label) === 0) || null;
}
function eventRows(doc) { return Array.from(doc.querySelectorAll('#eventList .event-row')); }
function modalVisible(doc, id) { const m = doc.getElementById(id); return !!m && m.style.display === 'flex'; }

// Fill the Add/Edit modal and click confirm. opts: { name, key, ctrl, shift,
// alt, color, size, subtypes, qualifiers, interval }
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
function captureSession(win, doc, stub) { click(doc.getElementById('btnSaveSession')); return lastSave(stub); }

(async () => {

  // =======================================================================
  section('STATIC — model foundation (source-level)');
  // =======================================================================
  {
    ok('TC-S1: DEFAULT_TAG_LABELS captured at startup (canonical rename protection basis)',
      /const DEFAULT_TAG_LABELS = new Set\(tags\.map\(\(t\) => t\.label\)\);/.test(rendererSrc));
    ok('TC-S2: DEFAULT_TAGS_SIGNATURE captured at startup (in-place autosave detection basis)',
      /const DEFAULT_TAGS_SIGNATURE = JSON\.stringify\(tags\);/.test(rendererSrc));
    ok('TC-S3: hasAutosavableWork compares the serialized tag set (in-place edits count)',
      /if \(JSON\.stringify\(tags\) !== DEFAULT_TAGS_SIGNATURE\) return true;/.test(rendererSrc));
    ok('TC-S4: DEFAULT_TAGS_LENGTH capture unchanged (TS-S6 pin intact)',
      /const DEFAULT_TAGS_LENGTH = tags\.length;/.test(rendererSrc));
    ok('TC-S5: session schema version NOT bumped (additive fields only, v4 stands)',
      /CURRENT_SCHEMA_VERSION = 4/.test(mainSrc));
    ok('TC-S6: default tag literals untouched (19 defaults, keys 1-8/9/0 pinned shapes intact)',
      /label: 'Possession', key: '8', interval: true,/.test(rendererSrc) &&
      /label: 'Press', key: '9'/.test(rendererSrc) &&
      /label: 'Duel', key: '0'/.test(rendererSrc));
    ok('TC-S7: soft-delete flag is default-safe (active !== false checks, not truthiness)',
      /function isActiveTag\(tag\) \{\s*return !!tag && tag\.active !== false;\s*\}/.test(rendererSrc));
  }

  // =======================================================================
  section('BOOT — legacy defaults render with zero visual delta');
  // =======================================================================
  {
    const B = boot({});
    const { win, doc } = B;
    await sleep(300);

    const btns = Array.from(doc.querySelectorAll('#tagButtons .tag-btn'));
    ok('TC-B1: fresh boot renders the 19 default tag buttons',
      btns.length === 19, 'buttons=' + btns.length);

    const plain = tagBtn(doc, 'Corner');
    ok('TC-B2: default tag has no size class and no colour custom property (pre-R2-E appearance)',
      !!plain && !/tag-btn-[sl]/.test(plain.className) &&
      !plain.style.getPropertyValue('--tag-color-bg'),
      'class="' + (plain && plain.className) + '"');

    ok('TC-B3: no jsdom errors during boot', jsdomErrors.length === 0, jsdomErrors.slice(0, 3).join(' | '));
    B.dom.window.close();
  }

  // =======================================================================
  section('CREATION — new properties on the existing Add flow');
  // =======================================================================
  {
    const B = boot({});
    const { win, doc, stub } = B;
    await sleep(300);

    // Create a fully-featured custom tag: letter key + ctrl, colour, large.
    click(doc.getElementById('btnAddCustom'));
    ok('TC-C1a: create mode shows "Add custom tag" title and hides the delete button',
      doc.getElementById('addTagModalTitle').textContent === 'Add custom tag' &&
      doc.getElementById('btnDeleteTag').style.display === 'none');
    fillModal(doc, {
      name: 'Tackle', key: 'q', ctrl: true,
      color: '#ff5500', size: 'l',
      subtypes: 'Won, Lost',
      qualifiers: 'Zone: Left, Right',
      interval: false
    });
    await sleep(30);

    const btn = tagBtn(doc, 'Tackle');
    // R2-E Phase 2A (R4/R7): the badge now shows the DERIVED effective form
    // ("Ctrl+q") instead of the bare key character.
    ok('TC-C1b: custom tag created with effective-form key badge (Ctrl+q)',
      !!btn && btn.querySelector('.key').textContent === 'Ctrl+q' &&
      btn.querySelector('.key').getAttribute('title') === 'Ctrl+q');
    ok('TC-C1c: size class applied (tag-btn-l)',
      !!btn && /tag-btn-l/.test(btn.className), 'class="' + (btn && btn.className) + '"');
    ok('TC-C1d: colour applied via CSS custom property',
      !!btn && btn.style.getPropertyValue('--tag-color-bg') === '#ff550026',
      'prop=' + (btn && btn.style.getPropertyValue('--tag-color-bg')));
    ok('TC-C1e: modal closed after create', !modalVisible(doc, 'addTagModal'));

    // New fields survive the session payload (persistence substrate).
    const saved = captureSession(win, doc, stub);
    const savedTag = saved && saved.tags.find((t) => t.label === 'Tackle');
    ok('TC-C1f: created tag carries mods/color/size in the session payload',
      !!savedTag && JSON.stringify(savedTag.mods) === '["ctrl"]' &&
      savedTag.color === '#ff5500' && savedTag.size === 'l',
      'tag=' + JSON.stringify(savedTag));

    // Defaults untouched by the create.
    const savedShot = saved && saved.tags.find((t) => t.label === 'Shot');
    ok('TC-C2: existing default tags keep their configuration (Shot subtypes intact)',
      !!savedShot && JSON.stringify(savedShot.subtypes) === '["On target","Off target","Blocked"]' &&
      savedShot.key === '2');

    // Duplicate ACTIVE label is blocked with an inline error.
    click(doc.getElementById('btnAddCustom'));
    fillModal(doc, { name: 'Tackle' });
    await sleep(30);
    ok('TC-C3: duplicate active label blocked with inline error, no second button',
      doc.getElementById('addTagError').style.display === 'block' &&
      /already exists/.test(doc.getElementById('addTagError').textContent) &&
      Array.from(doc.querySelectorAll('#tagButtons .tag-btn'))
        .filter((b) => b.textContent.replace(/⏱/g, '').trim().indexOf('Tackle') === 0).length === 1);
    click(doc.getElementById('btnCancelAddTag'));

    B.dom.window.close();
  }

  // =======================================================================
  section('EDITING — prefill, apply, preservation, conflicts');
  // =======================================================================
  {
    const B = boot({});
    const { win, doc, stub } = B;
    await sleep(300);

    // Create a detailed custom tag, then edit only its colour.
    click(doc.getElementById('btnAddCustom'));
    fillModal(doc, {
      name: 'Press Trigger', key: 'w',
      subtypes: 'High, Mid',
      qualifiers: 'Outcome: Won, Lost\nPressure: High, Low',
      interval: true
    });
    await sleep(30);

    contextmenu(tagBtn(doc, 'Press Trigger'));
    await sleep(30);
    ok('TC-E1a: contextmenu opens the modal in EDIT mode (title, delete button visible)',
      modalVisible(doc, 'addTagModal') &&
      doc.getElementById('addTagModalTitle').textContent === 'Edit tag' &&
      doc.getElementById('btnConfirmAddTag').textContent === 'Save changes' &&
      doc.getElementById('btnDeleteTag').style.display !== 'none');
    ok('TC-E1b: edit mode prefills name, key, subtypes, qualifiers, interval',
      doc.getElementById('newTagName').value === 'Press Trigger' &&
      doc.getElementById('newTagKey').value === 'w' &&
      doc.getElementById('newTagSubtypes').value === 'High, Mid' &&
      /Outcome: Won, Lost/.test(doc.getElementById('newTagQualifiers').value) &&
      doc.getElementById('newTagIsInterval').checked === true);

    // Change ONLY the colour and size; save.
    doc.getElementById('newTagUseColor').checked = true;
    doc.getElementById('newTagColor').value = '#3ba8a0';
    doc.getElementById('newTagSize').value = 's';
    click(doc.getElementById('btnConfirmAddTag'));
    await sleep(30);

    const saved = captureSession(win, doc, stub);
    const tag = saved && saved.tags.find((t) => t.label === 'Press Trigger');
    ok('TC-E2: colour + size edit applied to the button',
      /tag-btn-s/.test(tagBtn(doc, 'Press Trigger').className) &&
      tagBtn(doc, 'Press Trigger').style.getPropertyValue('--tag-color-bg') === '#3ba8a026');
    ok('TC-E3: subtype, qualifier-group and interval configuration preserved through the edit',
      !!tag && JSON.stringify(tag.subtypes) === '["High","Mid"]' &&
      tag.qualifierGroups.length === 2 && tag.qualifierGroups[0].name === 'Outcome' &&
      tag.interval === true,
      'tag=' + JSON.stringify(tag));

    B.dom.window.close();
  }

  {
    // Editing a DEFAULT tag: colour-only edit must preserve the hidden
    // substitution flag (a property the modal does not expose).
    const B = boot({});
    const { win, doc, stub } = B;
    await sleep(300);

    contextmenu(tagBtn(doc, 'Sub'));
    await sleep(30);
    doc.getElementById('newTagUseColor').checked = true;
    doc.getElementById('newTagColor').value = '#d84b4b';
    click(doc.getElementById('btnConfirmAddTag'));
    await sleep(30);

    const saved = captureSession(win, doc, stub);
    const sub = saved && saved.tags.find((t) => t.label === 'Sub');
    ok('TC-E4: editing a default tag preserves unexposed properties (Sub keeps substitution:true + key 7)',
      !!sub && sub.substitution === true && sub.key === '7' && sub.color === '#d84b4b',
      'sub=' + JSON.stringify(sub));

    // Shortcut conflict on edit: letters are free (only digits are taken by
    // defaults), so two custom tags can hold distinct letter keys.
    click(doc.getElementById('btnAddCustom'));
    fillModal(doc, { name: 'Alpha Tag', key: 'z' });
    await sleep(30);
    click(doc.getElementById('btnAddCustom'));
    fillModal(doc, { name: 'Beta Tag', key: 'z' });
    await sleep(30);
    ok('TC-E5a: creation auto-resolves a plain-key conflict (all 10 digits taken by defaults -> keyless, the T5b trade-off)',
      tagBtn(doc, 'Beta Tag') && tagBtn(doc, 'Beta Tag').querySelector('.key').textContent === '' &&
      tagBtn(doc, 'Alpha Tag').querySelector('.key').textContent === 'z');

    // (z, alt) vs plain z: NOT a conflict — different combos.
    // R2-E Phase 2A: the original variant used z+ctrl, which is now a
    // RESERVED identity (the §13 undo z-family) and correctly BLOCKED —
    // the different-combo semantics are re-pinned on the free z+alt combo.
    contextmenu(tagBtn(doc, 'Alpha Tag'));
    await sleep(30);
    doc.getElementById('newTagKey').value = 'z';
    doc.getElementById('newTagModCtrl').checked = false;
    doc.getElementById('newTagModAlt').checked = true;
    click(doc.getElementById('btnConfirmAddTag'));
    await sleep(30);
    ok('TC-E5b: different modifier combo is NOT a conflict (z+alt accepted alongside plain z)',
      !modalVisible(doc, 'addTagModal'), 'modal still open');

    // Exact conflict: a third tag holds plain 'y'; editing Alpha onto plain
    // 'y' must be blocked with the inline error.
    click(doc.getElementById('btnAddCustom'));
    fillModal(doc, { name: 'Gamma Tag', key: 'y' });
    await sleep(30);
    contextmenu(tagBtn(doc, 'Alpha Tag'));
    await sleep(30);
    doc.getElementById('newTagKey').value = 'y';
    doc.getElementById('newTagModCtrl').checked = false;
    doc.getElementById('newTagModAlt').checked = false;
    click(doc.getElementById('btnConfirmAddTag'));
    await sleep(30);
    ok('TC-E5c: exact (key, mods) conflict on edit is blocked with an inline error',
      modalVisible(doc, 'addTagModal') &&
      /already used/.test(doc.getElementById('addTagError').textContent));
    click(doc.getElementById('btnCancelAddTag'));

    B.dom.window.close();
  }

  // =======================================================================
  section('RENAME SAFETY — controlled historical relink');
  // =======================================================================
  {
    // Canonical rename is blocked outright.
    const B = boot({});
    const { win, doc } = B;
    await sleep(300);

    contextmenu(tagBtn(doc, 'Shot'));
    await sleep(30);
    doc.getElementById('newTagName').value = 'Big Shot';
    click(doc.getElementById('btnConfirmAddTag'));
    await sleep(30);
    ok('TC-R1: canonical (default) label rename is BLOCKED with an explanation',
      modalVisible(doc, 'addTagModal') &&
      /cannot be renamed/.test(doc.getElementById('addTagError').textContent) &&
      !!tagBtn(doc, 'Shot') && !tagBtn(doc, 'Big Shot') &&
      !modalVisible(doc, 'tagConfirmModal'));
    click(doc.getElementById('btnCancelAddTag'));
    B.dom.window.close();
  }

  {
    // Custom rename with ZERO matching events: immediate, no confirm.
    const B = boot({});
    const { win, doc } = B;
    await sleep(300);
    click(doc.getElementById('btnAddCustom'));
    fillModal(doc, { name: 'Warmup Drill' });
    await sleep(30);

    contextmenu(tagBtn(doc, 'Warmup Drill'));
    await sleep(30);
    doc.getElementById('newTagName').value = 'Warm-up Drill';
    click(doc.getElementById('btnConfirmAddTag'));
    await sleep(30);
    ok('TC-R2: rename with zero matching events applies immediately (no confirm dialog)',
      !tagBtn(doc, 'Warmup Drill') && !!tagBtn(doc, 'Warm-up Drill') &&
      !modalVisible(doc, 'tagConfirmModal') && !modalVisible(doc, 'addTagModal'));
    B.dom.window.close();
  }

  {
    // Custom rename with matching events: count shown, relink on confirm.
    const B = boot({});
    const { win, doc, stub } = B;
    await sleep(300);

    // Create the custom tag and log 3 events with it (plus one unrelated).
    click(doc.getElementById('btnAddCustom'));
    fillModal(doc, { name: 'Tackle', key: 't', subtypes: 'Won, Lost', qualifiers: 'Zone: Left, Right' });
    await sleep(30);
    const tackleBtn = () => tagBtn(doc, 'Tackle');
    for (let i = 0; i < 3; i++) {
      click(tackleBtn());
      await sleep(30);
      click(doc.getElementById('detailPanelDone'));
      await sleep(30);
    }
    click(tagBtn(doc, 'Shot'));
    await sleep(30);
    click(doc.getElementById('detailPanelDone'));
    await sleep(30);

    // Give the 2nd tackle event a subtype so field preservation is provable.
    // (Detail chips: select the subtype on the second event via the detail
    // panel is heavy; instead prove field preservation on qualifiers set at
    // the event level via the payload — events logged via the button carry
    // subtype:null/qualifiers:{} unless set in the panel. Field
    // preservation is asserted structurally: every field except label is
    // deep-equal before/after.)

    const before = captureSession(win, doc, stub);
    const beforeTackles = before.events.filter((e) => e.label === 'Tackle');
    const beforeShot = before.events.find((e) => e.label === 'Shot');
    ok('TC-R3a: three Tackle events + one unrelated Shot logged',
      beforeTackles.length === 3 && !!beforeShot, 't=' + beforeTackles.length);

    contextmenu(tagBtn(doc, 'Tackle'));
    await sleep(30);
    doc.getElementById('newTagName').value = 'Defensive Duel';
    click(doc.getElementById('btnConfirmAddTag'));
    await sleep(30);

    ok('TC-R3b: confirm dialog shown with the affected-event count (3)',
      modalVisible(doc, 'tagConfirmModal') &&
      /3 stored events/.test(doc.getElementById('tagConfirmText').textContent) &&
      /Tackle/.test(doc.getElementById('tagConfirmText').textContent) &&
      /Defensive Duel/.test(doc.getElementById('tagConfirmText').textContent),
      'text="' + doc.getElementById('tagConfirmText').textContent + '"');

    click(doc.getElementById('btnTagConfirmYes'));
    await sleep(50);

    const after = captureSession(win, doc, stub);
    const afterTackles = after.events.filter((e) => e.label === 'Defensive Duel');
    const leftovers = after.events.filter((e) => e.label === 'Tackle');
    const afterShot = after.events.find((e) => e.label === 'Shot');
    ok('TC-R3c: all 3 events relinked to the new label',
      afterTackles.length === 3 && leftovers.length === 0,
      'new=' + afterTackles.length + ' old=' + leftovers.length);
    ok('TC-R4: unrelated events untouched (Shot event deep-equal, ids preserved)',
      JSON.stringify(afterShot) === JSON.stringify(beforeShot));
    ok('TC-R5: relinked events keep every other field (deep-diff on the first tackle event)',
      (function () {
        const b = beforeTackles[0]; const a = afterTackles.find((e) => e.id === b.id);
        if (!a) return false;
        const bClone = Object.assign({}, b, { label: null });
        const aClone = Object.assign({}, a, { label: null });
        return JSON.stringify(bClone) === JSON.stringify(aClone);
      })());
    ok('TC-R6: event list re-renders with the new label',
      eventRows(doc).some((r) => r.textContent.indexOf('Defensive Duel') > -1) &&
      !eventRows(doc).some((r) => r.textContent.indexOf('Tackle') > -1 && r.textContent.indexOf('Defensive Duel') === -1));
    ok('TC-R7: tag definition renamed in the payload (button + session consistent)',
      !!after.tags.find((t) => t.label === 'Defensive Duel') &&
      !after.tags.some((t) => t.label === 'Tackle') &&
      !!tagBtn(doc, 'Defensive Duel'));

    // Duplicate target label blocked.
    click(doc.getElementById('btnAddCustom'));
    fillModal(doc, { name: 'Other Tag' });
    await sleep(30);
    contextmenu(tagBtn(doc, 'Other Tag'));
    await sleep(30);
    doc.getElementById('newTagName').value = 'Defensive Duel';
    click(doc.getElementById('btnConfirmAddTag'));
    await sleep(30);
    ok('TC-R8: renaming ONTO an existing label is blocked',
      modalVisible(doc, 'addTagModal') &&
      /already exists/.test(doc.getElementById('addTagError').textContent));
    click(doc.getElementById('btnCancelAddTag'));
    B.dom.window.close();
  }

  {
    // Rename CANCELLED at the confirm dialog: nothing changes.
    const B = boot({});
    const { win, doc, stub } = B;
    await sleep(300);
    click(doc.getElementById('btnAddCustom'));
    fillModal(doc, { name: 'Tackle' });
    await sleep(30);
    click(tagBtn(doc, 'Tackle'));
    await sleep(30);
    click(doc.getElementById('detailPanelDone'));
    await sleep(30);

    contextmenu(tagBtn(doc, 'Tackle'));
    await sleep(30);
    doc.getElementById('newTagName').value = 'New Name';
    click(doc.getElementById('btnConfirmAddTag'));
    await sleep(30);
    click(doc.getElementById('btnTagConfirmNo'));
    await sleep(50);
    const saved = captureSession(win, doc, stub);
    ok('TC-R9: cancelling the relink confirm leaves tag AND events unchanged',
      !!saved.tags.find((t) => t.label === 'Tackle') &&
      saved.events.filter((e) => e.label === 'Tackle').length === 1 &&
      !saved.tags.some((t) => t.label === 'New Name'));
    B.dom.window.close();
  }

  // =======================================================================
  section('DELETE SAFETY — soft delete, no resurrection, reactivate');
  // =======================================================================
  {
    const B = boot({});
    const { win, doc, stub } = B;
    await sleep(300);

    // Unused custom tag: delete → gone from the grid, kept in the payload.
    click(doc.getElementById('btnAddCustom'));
    fillModal(doc, { name: 'Unused Tag', key: 'u' });
    await sleep(30);
    contextmenu(tagBtn(doc, 'Unused Tag'));
    await sleep(30);
    click(doc.getElementById('btnDeleteTag'));
    await sleep(30);
    ok('TC-D1a: delete confirm shown (zero-events wording)',
      modalVisible(doc, 'tagConfirmModal') &&
      /No stored events/.test(doc.getElementById('tagConfirmText').textContent));
    click(doc.getElementById('btnTagConfirmYes'));
    await sleep(50);
    ok('TC-D1b: unused tag removed from the active grid but retained (active:false) in the session payload',
      !tagBtn(doc, 'Unused Tag') &&
      (function () {
        const saved = captureSession(win, doc, stub);
        const t = saved.tags.find((x) => x.label === 'Unused Tag');
        return !!t && t.active === false;
      })());
    ok('TC-D2a: a deleted tag\'s key no longer dispatches (press u -> no event)',
      (function () {
        const before = captureSession(win, doc, stub);
        pressKey(win, 'u');
        const after = captureSession(win, doc, stub);
        return before.events.length === 0 && after.events.length === 0;
      })());

    // Used tag: delete → events preserved with the original label.
    click(doc.getElementById('btnAddCustom'));
    fillModal(doc, { name: 'Tackle' });
    await sleep(30);
    click(tagBtn(doc, 'Tackle'));
    await sleep(30);
    click(doc.getElementById('detailPanelDone'));
    await sleep(30);
    contextmenu(tagBtn(doc, 'Tackle'));
    await sleep(30);
    click(doc.getElementById('btnDeleteTag'));
    await sleep(30);
    ok('TC-D2b: delete confirm shows the used-event count (1)',
      modalVisible(doc, 'tagConfirmModal') &&
      /1 stored event/.test(doc.getElementById('tagConfirmText').textContent) &&
      /kept unchanged/.test(doc.getElementById('tagConfirmText').textContent));
    click(doc.getElementById('btnTagConfirmYes'));
    await sleep(50);

    const saved = captureSession(win, doc, stub);
    const deleted = saved.tags.find((t) => t.label === 'Tackle');
    ok('TC-D2c: deleted tag\'s events are preserved with the original label',
      saved.events.filter((e) => e.label === 'Tackle').length === 1);
    ok('TC-D2d: deleted tag definition retained (active:false) — sessions stay interpretable',
      !!deleted && deleted.active === false);
    ok('TC-D2e: the deleted tag\'s label remains filterable (event-history union)',
      Array.from(doc.getElementById('eventTypeFilter').options).some((o) => o.value === 'Tackle'));
    ok('TC-D2f: event rows for the deleted tag still render',
      eventRows(doc).some((r) => r.textContent.indexOf('Tackle') > -1));

    // Reactivation: re-creating the same label revives the definition.
    click(doc.getElementById('btnAddCustom'));
    fillModal(doc, { name: 'Tackle', color: '#6fcf6f' });
    await sleep(30);
    const saved2 = captureSession(win, doc, stub);
    const defs = saved2.tags.filter((t) => t.label === 'Tackle');
    ok('TC-D3: re-creating a deleted label REACTIVATES the definition (no duplicate, active:true)',
      defs.length === 1 && defs[0].active !== false && defs[0].color === '#6fcf6f' &&
      !!tagBtn(doc, 'Tackle'),
      'defs=' + JSON.stringify(defs));

    B.dom.window.close();
  }

  {
    // Touchline: a deleted canonical quick tag leaves the Touchline grid and
    // cannot be resurrected by the auto-create path.
    const B = boot({});
    const { win, doc, stub } = B;
    await sleep(300);

    const enterTouchline = doc.getElementById('btnTouchlineToggle');
    if (!enterTouchline) {
      ok('TC-D4: touchline entry button found', false, 'no touchline button id');
    } else {
      // Delete the canonical 'Press' tag (soft delete allowed; rename is
      // what is protected).
      contextmenu(tagBtn(doc, 'Press'));
      await sleep(30);
      click(doc.getElementById('btnDeleteTag'));
      await sleep(30);
      click(doc.getElementById('btnTagConfirmYes'));
      await sleep(50);

      click(enterTouchline);
      await sleep(100);
      const quickBtns = Array.from(doc.querySelectorAll('#touchlineQuickTags .touchline-tag-btn'));
      const quickTexts = quickBtns.map((b) => b.textContent);
      ok('TC-D4: deleted canonical quick tag renders NO Touchline button (no resurrection surface)',
        // Exact match: 'Press Win' shares the 'Press' prefix, so equality
        // (label + optional ⏱ suffix) is the correct check.
        !quickTexts.some((t) => t === 'Press' || t === 'Press ⏱') &&
        quickTexts.some((t) => t === 'Duel') && quickBtns.length === 15,
        'quick count=' + quickBtns.length + ' labels=' + quickTexts.slice(0, 6).join(','));
    }
    B.dom.window.close();
  }

  // =======================================================================
  section('DISPATCH — legacy rule byte-identical, mods exact-match');
  // =======================================================================
  {
    const B = boot({});
    const { win, doc, stub } = B;
    await sleep(300);

    // Legacy: plain digit fires the default tag.
    pressKey(win, '2');
    await sleep(30);
    click(doc.getElementById('detailPanelDone'));
    await sleep(30);
    let saved = captureSession(win, doc, stub);
    ok('TC-K1: legacy plain-key dispatch unchanged (press 2 -> Shot event)',
      saved.events.length === 1 && saved.events[0].label === 'Shot');

    // Mods tag: Ctrl+Q fires, plain q does not, Ctrl+Shift+Q does not.
    click(doc.getElementById('btnAddCustom'));
    fillModal(doc, { name: 'Mod Tag', key: 'q', ctrl: true });
    await sleep(30);
    pressKey(win, 'q');
    await sleep(30);
    saved = captureSession(win, doc, stub);
    ok('TC-K2a: plain key does NOT fire a modifier shortcut',
      saved.events.length === 1, 'events=' + saved.events.length);
    pressKey(win, 'q', { ctrlKey: true, shiftKey: true });
    await sleep(30);
    saved = captureSession(win, doc, stub);
    ok('TC-K2b: extra modifier does NOT fire a modifier shortcut (exact combo only)',
      saved.events.length === 1, 'events=' + saved.events.length);
    pressKey(win, 'q', { ctrlKey: true });
    await sleep(30);
    click(doc.getElementById('detailPanelDone'));
    await sleep(30);
    saved = captureSession(win, doc, stub);
    ok('TC-K2c: the exact modifier combo fires the tag',
      saved.events.length === 2 && saved.events[1].label === 'Mod Tag');

    B.dom.window.close();
  }

  // =======================================================================
  section('PERSISTENCE — v4 back-compat, malformed fields, round-trip');
  // =======================================================================
  {
    // Old v4 session (tags without any new fields) loads normally.
    const B = boot({});
    const { win, doc } = B;
    await sleep(300);
    B.stub._setLoadSession({
      __schemaVersion: 4,
      videoPath: null,
      events: [{ id: 1, time: 10, label: 'Foul', subtype: null, qualifiers: {}, location: null, playerId: null, playerOffId: null, playerOnId: null, side: null, isInterval: false, outcome: null }],
      tags: [
        { label: 'Goal', key: '1' },
        { label: 'My Old Custom', key: '' }
      ],
      squad: [],
      matchInfo: {},
      matchClock: null
    });
    click(doc.getElementById('btnLoadSession'));
    await sleep(100);
    ok('TC-P1: old v4 tags (no new fields) load and render normally',
      !!tagBtn(doc, 'My Old Custom') && !!tagBtn(doc, 'Goal') &&
      Array.from(doc.querySelectorAll('#tagButtons .tag-btn')).length === 2);
    B.dom.window.close();
  }

  {
    // Malformed optional fields are sanitized, not fatal.
    const B = boot({});
    const { win, doc } = B;
    await sleep(300);
    B.stub._setLoadSession({
      __schemaVersion: 4,
      videoPath: null,
      events: [],
      tags: [
        { label: 'Bad Mods', key: 'b', mods: 'ctrl' },
        { label: 'Bad Color', key: '', color: 'red' },
        { label: 'Bad Size', key: '', size: 'xxl' },
        { label: 'Bad Active', key: '', active: 'yes' }
      ],
      squad: [],
      matchInfo: {},
      matchClock: null
    });
    click(doc.getElementById('btnLoadSession'));
    await sleep(100);
    ok('TC-P2: malformed optional fields do not crash the load (all four tags render)',
      !!tagBtn(doc, 'Bad Mods') && !!tagBtn(doc, 'Bad Color') &&
      !!tagBtn(doc, 'Bad Size') && !!tagBtn(doc, 'Bad Active'));

    // R2-E Phase 2A (no-silent-mutation): malformed SHORTCUT fields are
    // preserved as loaded (inert + warn-dotted), never coerced. The
    // appearance/lifecycle fields (color/size/active) keep the Phase 1
    // safe coercion.
    const badModsBtn = tagBtn(doc, 'Bad Mods');
    ok('TC-P2b: malformed shortcut fields get the warn-dot (diagnostics channel 2)',
      !!badModsBtn && !!badModsBtn.querySelector('.tag-warn-dot'));

    // The malformed tag is dispatch-inert: pressing its stored key 'b'
    // fires nothing (no inference — Phase 1 coerced mods:'ctrl' to [] and
    // fired the plain 'b'; Phase 2A preserves and diagnoses instead).
    pressKey(win, 'b');
    await sleep(30);
    click(doc.getElementById('btnSaveSession'));
    const savedInert = lastSave(B.stub);
    ok('TC-P2c: malformed stored shortcut is dispatch-inert (press b -> no event)',
      savedInert.events.length === 0, 'events=' + savedInert.events.length);

    click(doc.getElementById('btnSaveSession'));
    const saved = lastSave(B.stub);
    const bm = saved.tags.find((t) => t.label === 'Bad Mods');
    const bc = saved.tags.find((t) => t.label === 'Bad Color');
    const bs = saved.tags.find((t) => t.label === 'Bad Size');
    const ba = saved.tags.find((t) => t.label === 'Bad Active');
    ok('TC-P3: shortcut fields PRESERVED as stored (mods:\'ctrl\' intact); appearance/lifecycle fields still coerced (color->\'\', size->\'\', active->true)',
      bm.mods === 'ctrl' && bc.color === '' && bs.size === '' && ba.active === true,
      JSON.stringify({ bm: bm.mods, bc: bc.color, bs: bs.size, ba: ba.active }));
    B.dom.window.close();
  }

  {
    // Full round-trip: create with new properties -> save -> fresh boot
    // load -> properties restored (incl. render + dispatch).
    const B1 = boot({});
    await sleep(300);
    click(B1.doc.getElementById('btnAddCustom'));
    // R2-E Phase 2A: this Phase 1 test originally used key 'r' + Ctrl — a
    // RESERVED identity (menu reload accelerator) that Phase 2A now
    // correctly blocks at assignment. Re-pinned on the free ctrl+j combo.
    fillModal(B1.doc, { name: 'Round Trip', key: 'j', ctrl: true, color: '#4f8fdb', size: 'l', subtypes: 'A, B' });
    await sleep(30);
    click(B1.doc.getElementById('btnSaveSession'));
    const payload = lastSave(B1.stub);
    B1.dom.window.close();

    const B2 = boot({});
    await sleep(300);
    B2.stub._setLoadSession(payload);
    click(B2.doc.getElementById('btnLoadSession'));
    await sleep(100);
    const rt = payload.tags.find((t) => t.label === 'Round Trip');
    const btn = tagBtn(B2.doc, 'Round Trip');
    ok('TC-P4: new fields survive create -> save -> load (button restored with colour + size)',
      !!btn && /tag-btn-l/.test(btn.className) &&
      btn.style.getPropertyValue('--tag-color-bg') === '#4f8fdb26' &&
      btn.querySelector('.key').textContent === 'Ctrl+j');

    // And the restored modifier shortcut still dispatches exactly.
    pressKey(B2.win, 'j');
    await sleep(30);
    pressKey(B2.win, 'j', { ctrlKey: true });
    await sleep(30);
    click(B2.doc.getElementById('detailPanelDone'));
    await sleep(30);
    click(B2.doc.getElementById('btnSaveSession'));
    const saved2 = lastSave(B2.stub);
    ok('TC-P5: restored modifier shortcut dispatches exactly (plain j: 0 events, Ctrl+J: 1)',
      saved2.events.filter((e) => e.label === 'Round Trip').length === 1 &&
      saved2.events.length === 1,
      'events=' + JSON.stringify(saved2.events.map((e) => e.label)));

    // Inactive tag survives the round-trip too (soft delete persisted).
    ok('TC-P6: round-trip payload preserved the subtypes config',
      rt && JSON.stringify(rt.subtypes) === '["A","B"]');
    B2.dom.window.close();
  }

  // =======================================================================
  section('AUTOSAVE ELIGIBILITY — in-place customization is autosavable');
  // =======================================================================
  {
    const B = boot({});
    const { win, doc, stub } = B;
    await sleep(300);

    // A fresh boot with no work has no autosave writes yet.
    const writesBefore = stub._calls.autosaveWrite.length;

    // In-place edit of a DEFAULT tag (colour only) — no length change, no
    // events, no video, no matchInfo. Pre-R2-E this was NOT autosavable;
    // Phase 1 must recognize it.
    contextmenu(tagBtn(doc, 'Corner'));
    await sleep(30);
    doc.getElementById('newTagUseColor').checked = true;
    doc.getElementById('newTagColor').value = '#e8b93b';
    click(doc.getElementById('btnConfirmAddTag'));
    await sleep(30);

    // The debounced autosave (1500ms trailing) fires with the customized tags.
    await sleep(1900);
    const writes = stub._calls.autosaveWrite.slice(writesBefore);
    ok('TC-A1: in-place default-tag edit triggers the debounced autosave',
      writes.length >= 1, 'writes=' + writes.length);
    ok('TC-A2: the autosave payload carries the customized tags (Corner colour persisted)',
      writes.length >= 1 && (() => {
        const c = writes[writes.length - 1].tags.find((t) => t.label === 'Corner');
        return !!c && c.color === '#e8b93b';
      })(), 'payload tags Corner=' + JSON.stringify(writes.length ? writes[writes.length - 1].tags.find((t) => t.label === 'Corner') : null));

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
  console.log('\n---- tag controls check: ' + pass + ' passed, ' + fail + ' failed ----');
  if (jsdomErrors.length) {
    console.log('jsdom errors (' + jsdomErrors.length + '): ' + jsdomErrors.slice(0, 5).join(' | '));
  }
  if (fail > 0 || jsdomErrors.length > 0) process.exit(1);
})().catch((err) => { console.error('HARNESS CRASH:', err); process.exit(1); });
