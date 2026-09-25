#!/usr/bin/env node
// PitchLog / MatchTag — R2-E Phase 3A: Add New Tag control + tag-panel
// scrolling, focused harness (ADD-1..ADD-8, SCROLL-1..SCROLL-5).
// ============================================================================
// Verification-only harness. It does NOT modify any app source file.
//
// Phase 3A scope under test:
//
//   ADD     a VISIBLE "+ Add New Tag" control immediately associated with
//           the TAG EVENTS section (between the header and the grid — not
//           below the grid where the cutoff used to hide it), opening the
//           EXISTING Add/Edit Tag modal in CREATE mode; created tags appear
//           immediately, keep every configuration field, persist to the
//           persistent tag library (tags.json contract) and survive a
//           restart; duplicate/conflicting configurations are rejected by
//           the existing Phase 2A/3 validation (nothing weakened).
//
//   SCROLL  the tag grid itself is a bounded vertical scroll container:
//           the app shell never page-scrolls (html/body overflow:hidden
//           unchanged); the TAG EVENTS area consumes the remaining vertical
//           space; header + Add button stay visible; the cd48114 per-tag
//           size behaviour (align-items:start + min-height floors) is
//           untouched and stays effective, including mixed sizes.
//
// HONEST SCOPE: jsdom does not compute layout — the real bounded-height
// geometry (scrollHeight/clientHeight, actual scrolling, window sizes) is
// verified by the real-Electron QA probe. What jsdom can prove: the control
// exists in the right place, opens create mode, the create flow works end
// to end, validation holds, and every tag (any count) renders inside the
// grid container. The static CSS checks pin the source-level layout
// contract the geometry depends on.
//
// Run:  node tests/tag-add-scroll-check.js   (from the project root)
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
function ok(id, cond, detail) {
  results.push({ section: SECTION, id, pass: !!cond, detail: detail === undefined ? '' : String(detail) });
  console.log((cond ? '[PASS] ' : '[FAIL] ') + id + (detail === undefined ? '' : '  | ' + detail));
  if (!cond) process.exitCode = 1;
}

const jsdomErrors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function clone(x) { return x == null ? x : JSON.parse(JSON.stringify(x)); }

// ---------------------------------------------------------------------------
// static CSS parsing (same approach as tag-size-render-check.js)
// ---------------------------------------------------------------------------
const CSS = stylesSrc.replace(/\/\*[\s\S]*?\*\//g, ''); // strip comments
function ruleBlocks(selectorToken) {
  const out = [];
  const re = /([^{}]+)\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(CSS))) {
    const sels = m[1].split(',').map((s) => s.trim()).filter(Boolean);
    if (sels.indexOf(selectorToken) !== -1) out.push({ selector: m[1].trim(), body: m[2] });
  }
  return out;
}
function mergedRules(selectorToken) {
  return ruleBlocks(selectorToken).map((b) => b.body).join('\n');
}
function decl(block, prop) {
  if (!block) return null;
  const m = block.match(new RegExp('(^|[^-])' + prop.replace(/-/g, '\\-') + '\\s*:\\s*([^;]+);'));
  return m ? m[2].trim() : null;
}

// ---------------------------------------------------------------------------
// jsdom boot with the tag-library-aware matchtag stub (same architecture as
// tag-library-renderer-check.js)
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
function eventRows(doc) { return doc.querySelectorAll('#eventList .event-row').length; }

function fillModal(doc, opts) {
  doc.getElementById('newTagName').value = opts.name;
  doc.getElementById('newTagKey').value = opts.key === undefined ? '' : opts.key;
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

(async () => {

  // =======================================================================
  section('SCROLL (static CSS) — bounded, scrollable grid; shell never scrolls');
  // =======================================================================
  {
    const bodyRule = ruleBlocks('body').map((b) => b.body).join('\n');
    const layoutRule = ruleBlocks('.layout').map((b) => b.body).join('\n');
    const tagpanelRule = ruleBlocks('.tagpanel').map((b) => b.body).join('\n');
    const headerRule = ruleBlocks('.tagpanel-header').map((b) => b.body).join('\n');
    const addBtnRule = ruleBlocks('.btn-add-custom').map((b) => b.body).join('\n');
    const gridRules = mergedRules('.tag-grid');
    const gridBlocks = ruleBlocks('.tag-grid');

    // --- SCROLL-1: the tag area is BOUNDED (height comes from flexing
    // inside the fixed shell, never from content overflow) ----------------
    ok('SCROLL-1a: html,body keep overflow: hidden (the app NEVER page-scrolls)',
      /html\s*,\s*body\s*\{[^}]*overflow\s*:\s*hidden/.test(CSS), 'ok');
    ok('SCROLL-1b: body is a flex column (bars stack, .layout fills the remainder)',
      decl(bodyRule, 'display') === 'flex' && decl(bodyRule, 'flex-direction') === 'column',
      'display=' + decl(bodyRule, 'display') + ' dir=' + decl(bodyRule, 'flex-direction'));
    ok('SCROLL-1c: .layout fills the REMAINING space (flex, min-height: 0 — no fixed calc(100% - 52px) that ignored the matchday/clock bars)',
      decl(layoutRule, 'flex') === '1 1 auto' && decl(layoutRule, 'min-height') === '0' &&
      !/height\s*:\s*calc/.test(layoutRule),
      'flex=' + decl(layoutRule, 'flex') + ' min-height=' + decl(layoutRule, 'min-height'));
    ok('SCROLL-1d: the fixed chrome never shrinks (topbar / matchday bar / clock bar / timeline / transport)',
      decl(mergedRules('.topbar'), 'flex-shrink') === '0' &&
      decl(mergedRules('.matchday-bar'), 'flex-shrink') === '0' &&
      decl(mergedRules('.match-clock-bar'), 'flex-shrink') === '0' &&
      decl(mergedRules('.timeline-strip-wrapper'), 'flex-shrink') === '0' &&
      decl(mergedRules('.transport'), 'flex-shrink') === '0', 'all flex-shrink: 0');
    ok('SCROLL-1e: .tagpanel is a bounded flex column (shrinkable, min-height: 0 — the TAG EVENTS area consumes the remaining vertical space)',
      decl(tagpanelRule, 'display') === 'flex' && decl(tagpanelRule, 'flex-direction') === 'column' &&
      decl(tagpanelRule, 'min-height') === '0' && decl(tagpanelRule, 'flex') === '0 1 auto',
      'display=' + decl(tagpanelRule, 'display') + ' flex=' + decl(tagpanelRule, 'flex') + ' min-height=' + decl(tagpanelRule, 'min-height'));
    ok('SCROLL-1f: tag grid container declares min-height: 0 (can shrink below its content — the scroll precondition)',
      decl(gridRules, 'min-height') === '0', 'min-height=' + decl(gridRules, 'min-height'));
    ok('SCROLL-1g: the TAG EVENTS header and the Add New Tag button are pinned (flex-shrink: 0 — always fully visible)',
      decl(headerRule, 'flex-shrink') === '0' && decl(addBtnRule, 'flex-shrink') === '0',
      'header=' + decl(headerRule, 'flex-shrink') + ' addBtn=' + decl(addBtnRule, 'flex-shrink'));

    // --- SCROLL-2: overflow produces a scrollable, visible scrollbar ------
    ok('SCROLL-2a: the tag grid itself scrolls vertically (overflow-y: auto on .tag-grid)',
      decl(gridRules, 'overflow-y') === 'auto', 'overflow-y=' + decl(gridRules, 'overflow-y'));
    ok('SCROLL-2b: wheel scrolling is contained (overscroll-behavior: contain — never chains to the app shell)',
      decl(gridRules, 'overscroll-behavior') === 'contain', 'value=' + decl(gridRules, 'overscroll-behavior'));
    ok('SCROLL-2c: a visible styled scrollbar is defined for the grid (::-webkit-scrollbar width + thumb)',
      /\.tag-grid::-webkit-scrollbar\s*\{[^}]*width\s*:\s*10px/.test(CSS) &&
      /\.tag-grid::-webkit-scrollbar-thumb\s*\{[^}]*background/.test(CSS), 'ok');

    // --- SCROLL-4: the cd48114 size behaviour remains effective -----------
    const badAlign = [];
    gridBlocks.forEach((b) => {
      (b.body.match(/align-items\s*:\s*[^;]+;/g) || []).forEach((d) => {
        if (!/align-items\s*:\s*start/.test(d)) badAlign.push(d.trim());
      });
    });
    const bh = decl(mergedRules('.tag-btn'), 'min-height');
    const sh = decl(mergedRules('.tag-btn-s'), 'min-height');
    const lh = decl(mergedRules('.tag-btn-l'), 'min-height');
    ok('SCROLL-4a: every .tag-grid align-items declaration is still start (cd48114 — no row re-stretching)',
      badAlign.length === 0 && decl(gridRules, 'align-items') === 'start', badAlign.join(' ;; ') || 'align-items=start');
    ok('SCROLL-4b: the three per-size min-height floors are intact and ordered (cd48114)',
      !!sh && !!bh && !!lh && parseFloat(sh) < parseFloat(bh) && parseFloat(bh) < parseFloat(lh),
      'small=' + sh + ' default=' + bh + ' large=' + lh);
    ok('SCROLL-4c: the grid column definition is unchanged (repeat(auto-fill, minmax(110px, 1fr)); gap 8px)',
      decl(gridRules, 'grid-template-columns') === 'repeat(auto-fill, minmax(110px, 1fr))' &&
      decl(gridRules, 'gap') === '8px',
      'cols=' + decl(gridRules, 'grid-template-columns') + ' gap=' + decl(gridRules, 'gap'));
  }

  // =======================================================================
  section('ADD-1 / ADD-2 — the visible control, in the right place, create mode');
  // =======================================================================
  {
    const B = boot({ tagLibrary: null });
    const { doc } = B;
    await sleep(300);

    const btn = doc.getElementById('btnAddCustom');
    const header = doc.querySelector('.tagpanel-header');
    const grid = doc.getElementById('tagButtons');
    ok('ADD-1a: the Add control exists as a <button id="btnAddCustom">',
      !!btn && btn.tagName === 'BUTTON', 'found=' + !!btn);
    ok('ADD-1b: labelled "+ Add New Tag" (visible text, no icon-only mystery button)',
      !!btn && btn.textContent.trim() === '+ Add New Tag', JSON.stringify(btn && btn.textContent.trim()));
    ok('ADD-1c: lives INSIDE the TAG EVENTS panel, BETWEEN the header and the grid (never scrolled away below the grid)',
      !!btn && btn.parentElement === header.parentElement &&
      btn.parentElement.classList.contains('tagpanel') &&
      btn.nextElementSibling === grid &&
      !!(header.compareDocumentPosition(btn) & doc.defaultView.Node.DOCUMENT_POSITION_FOLLOWING),
      'parent=.tagpanel next=#' + (btn && btn.nextElementSibling && btn.nextElementSibling.id));
    ok('ADD-1d: not hidden (no display:none / hidden attribute; no .btn-add-custom display:none rule in CSS)',
      !!btn && btn.style.display !== 'none' && !btn.hasAttribute('hidden') &&
      !/\.btn-add-custom\s*\{[^}]*display\s*:\s*none/.test(CSS), 'ok');
    ok('ADD-1e: the grid container is the SAME #tagButtons element (no parallel UI) and is an accessible region',
      !!grid && grid.getAttribute('role') === 'region' && !!grid.getAttribute('aria-label'),
      'role=' + (grid && grid.getAttribute('role')));

    // ADD-2: opens the EXISTING modal in CREATE mode.
    click(btn);
    await sleep(30);
    ok('ADD-2a: clicking opens the existing Add/Edit Tag modal',
      modalVisible(doc, 'addTagModal'), 'display=' + doc.getElementById('addTagModal').style.display);
    ok('ADD-2b: CREATE mode (title "Add custom tag", confirm reads "Add tag", Delete hidden)',
      doc.getElementById('addTagModalTitle').textContent === 'Add custom tag' &&
      doc.getElementById('btnConfirmAddTag').textContent.trim() === 'Add tag' &&
      doc.getElementById('btnDeleteTag').style.display === 'none', 'ok');
    ok('ADD-2c: create mode starts EMPTY (name/key/size reset, colour unchecked)',
      doc.getElementById('newTagName').value === '' &&
      doc.getElementById('newTagKey').value === '' &&
      doc.getElementById('newTagSize').value === '' &&
      doc.getElementById('newTagUseColor').checked === false, 'ok');
    ok('ADD-2d: the full configuration surface is offered (shortcut key + modifiers + Clear, subtypes, qualifier groups, interval, colour, size)',
      !!doc.getElementById('newTagKey') && !!doc.getElementById('newTagModCtrl') &&
      !!doc.getElementById('btnClearShortcut') && !!doc.getElementById('newTagSubtypes') &&
      !!doc.getElementById('newTagQualifiers') && !!doc.getElementById('newTagIsInterval') &&
      !!doc.getElementById('newTagUseColor') && !!doc.getElementById('newTagColor') &&
      !!doc.getElementById('newTagSize'), 'ok');
    // Cancel for a clean slate.
    click(doc.getElementById('btnCancelAddTag'));
    await sleep(30);
    B.dom.window.close();
  }

  // =======================================================================
  section('ADD-3..ADD-6 — create, render, configure, persist');
  // =======================================================================
  {
    const B = boot({ tagLibrary: null });
    const { doc, stub } = B;
    await sleep(300);

    const before = tagBtns(doc).length;
    // A fully-configured new tag: name, shortcut+modifier, colour, size,
    // subtypes, qualifier groups. (Interval behaviour gets its own tag
    // below — an interval tag's FIRST click starts the phase instead of
    // logging an event, so the click test needs a flat tag.)
    click(doc.getElementById('btnAddCustom'));
    await sleep(30);
    fillModal(doc, {
      name: 'Test Transition', key: 'v', ctrl: true, color: '#e91e63', size: 'l',
      subtypes: 'Vertical, Horizontal',
      qualifiers: 'Zone: Defensive third, Middle third\nTrigger: Press, Throw-in'
    });
    await sleep(50);

    ok('ADD-3: the new tag is CREATED and appears immediately in TAG EVENTS (19 → 20 buttons)',
      tagBtns(doc).length === before + 1 && !!tagBtn(doc, 'Test Transition'),
      'count=' + tagBtns(doc).length);

    const btn = tagBtn(doc, 'Test Transition');
    ok('ADD-4a: the new tag renders in the working tag set (button inside #tagButtons with its label)',
      !!btn && btn.closest('#tagButtons') === doc.getElementById('tagButtons'), 'ok');
    ok('ADD-4b: the new tag is usable — clicking it logs an event with its label',
      (click(btn), true) && (await sleep(30), eventRows(doc) === 1 &&
        /Test Transition/.test(doc.getElementById('eventList').textContent)),
      'rows=' + eventRows(doc));
    ok('ADD-4c: the new tag joins the event-type filter (renderer tag set fully updated)',
      Array.from(doc.getElementById('eventTypeFilter').options).some((o) => o.textContent === 'Test Transition'), 'ok');

    // A second tag configured as an interval phase — the ⏱ behaviour.
    click(doc.getElementById('btnAddCustom'));
    await sleep(30);
    fillModal(doc, { name: 'Phase Probe', key: '', interval: true });
    await sleep(50);
    const phaseBtn = tagBtn(doc, 'Phase Probe');

    ok('ADD-5a: configuration preserved — size Large (tag-btn-l) with the custom colour applied',
      /tag-btn-l/.test(btn.className) &&
      btn.style.getPropertyValue('--tag-color-bg') === '#e91e6326', 'cls=' + btn.className + ' bg=' + btn.style.getPropertyValue('--tag-color-bg'));
    ok('ADD-5b: configuration preserved — interval behaviour (⏱ marker on the Phase Probe button)',
      !!phaseBtn && /⏱/.test(phaseBtn.textContent), JSON.stringify(phaseBtn && phaseBtn.textContent.trim()));
    ok('ADD-5c: configuration preserved — shortcut hint renders Ctrl+V on the button',
      !!btn.querySelector('.key') && /Ctrl\+V/i.test(btn.querySelector('.key').textContent),
      'key=' + (btn.querySelector('.key') && btn.querySelector('.key').textContent));

    const payload = lastLibrarySave(stub);
    const saved = payload && payload.find((t) => t.label === 'Test Transition');
    const savedPhase = payload && payload.find((t) => t.label === 'Phase Probe');
    ok('ADD-6a: the create persists to the tag library (tags.json write captured)',
      stub._calls.saveTagLibrary.length >= 1 && !!saved && !!savedPhase, 'saves=' + stub._calls.saveTagLibrary.length);
    ok('ADD-6b: the library entry carries the FULL configuration (key v + mods ctrl, colour, size l, subtypes, qualifier groups) and the interval flag on the phase tag',
      !!saved && saved.key === 'v' && JSON.stringify(saved.mods) === JSON.stringify(['ctrl']) &&
      saved.color === '#e91e63' && saved.size === 'l' &&
      JSON.stringify(saved.subtypes) === JSON.stringify(['Vertical', 'Horizontal']) &&
      JSON.stringify(saved.qualifierGroups) === JSON.stringify([
        { name: 'Zone', options: ['Defensive third', 'Middle third'] },
        { name: 'Trigger', options: ['Press', 'Throw-in'] }
      ]) &&
      !!savedPhase && savedPhase.interval === true,
      saved ? JSON.stringify({ key: saved.key, mods: saved.mods, color: saved.color, size: saved.size, subtypes: saved.subtypes, qualifierGroups: saved.qualifierGroups, interval: savedPhase && savedPhase.interval }) : 'missing');
    ok('ADD-6c: the library write keeps every pre-existing entry (defaults intact alongside the new tags)',
      !!payload && payload.length === 21 && payload.some((t) => t.label === 'Goal' && t.key === '1'),
      'entries=' + (payload && payload.length));
    B.dom.window.close();
  }

  // =======================================================================
  section('ADD-7 — the new tag survives an application restart');
  // =======================================================================
  {
    // Boot 1: create the fully-configured tag.
    const B1 = boot({ tagLibrary: null });
    const d1 = B1.doc, s1 = B1.stub;
    await sleep(300);
    click(d1.getElementById('btnAddCustom'));
    await sleep(30);
    fillModal(d1, { name: 'Test Transition', key: 'v', ctrl: true, color: '#e91e63', size: 'l' });
    await sleep(50);
    const saved = clone(lastLibrarySave(s1));
    B1.dom.window.close();

    // Boot 2 ("restart"): tags.json returns exactly what boot 1 saved.
    const B2 = boot({ tagLibrary: { tags: saved } });
    const d2 = B2.doc, s2 = B2.stub;
    await sleep(300);
    const rb = tagBtn(d2, 'Test Transition');
    ok('ADD-7a: the tag still exists after close + reopen (rendered from tags.json)',
      !!rb, 'found=' + !!rb);
    ok('ADD-7b: the full configuration survived the restart (Large + colour + Ctrl+V hint)',
      !!rb && /tag-btn-l/.test(rb.className) &&
      rb.style.getPropertyValue('--tag-color-bg') === '#e91e6326' &&
      !!rb.querySelector('.key') && /Ctrl\+V/i.test(rb.querySelector('.key').textContent),
      'cls=' + (rb && rb.className));
    ok('ADD-7c: the persisted shortcut still FIRES after the restart (Ctrl+V dispatch logs the event)',
      (d2.defaultView.dispatchEvent(new d2.defaultView.KeyboardEvent('keydown', { key: 'v', ctrlKey: true, bubbles: true })),
        await sleep(50), eventRows(d2) === 1 && /Test Transition/.test(d2.getElementById('eventList').textContent)),
      'rows=' + eventRows(d2));
    ok('ADD-7d: the restart booted from the library without writing it back (no spurious save)',
      s2._calls.saveTagLibrary.length === 0, 'saves=' + s2._calls.saveTagLibrary.length);
    B2.dom.window.close();
  }

  // =======================================================================
  section('ADD-8 — duplicate / conflicting configurations rejected (validation intact)');
  // =======================================================================
  {
    const B = boot({ tagLibrary: null });
    const { doc, stub } = B;
    await sleep(300);
    const count0 = tagBtns(doc).length;
    const saves0 = stub._calls.saveTagLibrary.length;
    let err;

    // (a) duplicate tag NAME → clear validation error, nothing created.
    click(doc.getElementById('btnAddCustom'));
    await sleep(30);
    fillModal(doc, { name: 'Goal', key: 'x' });
    await sleep(30);
    err = doc.getElementById('addTagError');
    ok('ADD-8a: duplicate tag NAME rejected with a clear error (no silent replace)',
      err.style.display === 'block' && /already exists/i.test(err.textContent) &&
      tagBtns(doc).length === count0 && stub._calls.saveTagLibrary.length === saves0,
      JSON.stringify(err.textContent));
    click(doc.getElementById('btnCancelAddTag'));
    await sleep(30);

    // (b) RESERVED shortcut (Ctrl+R = menu reload) → blocked by the
    // existing reserved-key validation.
    click(doc.getElementById('btnAddCustom'));
    await sleep(30);
    fillModal(doc, { name: 'Reserve Probe', key: 'r', ctrl: true });
    await sleep(30);
    err = doc.getElementById('addTagError');
    ok('ADD-8b: RESERVED shortcut rejected (existing reserved-key validation)',
      err.style.display === 'block' && /reserved/i.test(err.textContent) &&
      !tagBtn(doc, 'Reserve Probe') && stub._calls.saveTagLibrary.length === saves0,
      JSON.stringify(err.textContent));
    click(doc.getElementById('btnCancelAddTag'));
    await sleep(30);

    // (c) MALFORMED shortcut → blocked by the existing §6 validity rule.
    // The real modal input has maxlength=1, so a multi-character key cannot
    // be typed — injected here PAST the attribute to prove the validation
    // layer itself still rejects a malformed candidate (defense in depth).
    click(doc.getElementById('btnAddCustom'));
    await sleep(30);
    doc.getElementById('newTagName').value = 'Malformed Probe';
    doc.getElementById('newTagKey').value = 'ab'; // 2 chars — malformed
    click(doc.getElementById('btnConfirmAddTag'));
    await sleep(30);
    err = doc.getElementById('addTagError');
    ok('ADD-8c: MALFORMED shortcut rejected (existing validity validation)',
      err.style.display === 'block' && /not valid/i.test(err.textContent) &&
      !tagBtn(doc, 'Malformed Probe') &&
      stub._calls.saveTagLibrary.length === saves0,
      JSON.stringify(err.textContent));
    click(doc.getElementById('btnCancelAddTag'));
    await sleep(30);

    // (d) KEYLESS creation is permitted where the existing system permits
    // it: all ten plain digits are held by the 19 defaults, so an empty key
    // + no modifiers has no free digit → the tag is created keyless (the
    // documented T5b trade-off, unchanged).
    click(doc.getElementById('btnAddCustom'));
    await sleep(30);
    fillModal(doc, { name: 'Keyless Probe', key: '' });
    await sleep(30);
    const kl = tagBtn(doc, 'Keyless Probe');
    const klSaved = lastLibrarySave(stub) && lastLibrarySave(stub).find((t) => t.label === 'Keyless Probe');
    ok('ADD-8d: keyless creation permitted (created with NO key when no digit is free — existing T5b behavior, not weakened)',
      !!kl && !!klSaved && klSaved.key === '' &&
      kl.querySelector('.key') && kl.querySelector('.key').textContent.trim() === '',
      'key=' + (klSaved && JSON.stringify(klSaved.key)) +
      ' badge=' + JSON.stringify(kl && kl.querySelector('.key') && kl.querySelector('.key').textContent));
    click(kl);
    await sleep(30);
    ok('ADD-8e: a blocked create never mutated anything (counts back to sane: +1 keyless tag only, no stray entries)',
      tagBtns(doc).length === count0 + 1 && stub._calls.saveTagLibrary.length === saves0 + 1,
      'buttons=' + tagBtns(doc).length + ' saves=' + stub._calls.saveTagLibrary.length);
    B.dom.window.close();
  }

  // =======================================================================
  section('SCROLL-3 / SCROLL-5 (jsdom) — every tag renders; mixed sizes correct');
  // =======================================================================
  {
    // 19 defaults + 25 customs (mixed sizes) — far beyond any visible area.
    // Created through the REAL modal flow (the same code path a user drives),
    // so the render + persist assertions cover exactly what the UI produces.
    const B3 = boot({ tagLibrary: null });
    const d3 = B3.doc, s3 = B3.stub;
    await sleep(300);
    for (let i = 1; i <= 25; i++) {
      click(d3.getElementById('btnAddCustom'));
      await sleep(10);
      fillModal(d3, {
        name: 'Bulk Tag ' + i, key: '',
        size: i % 3 === 0 ? 's' : (i % 3 === 1 ? 'l' : '')
      });
      await sleep(10);
    }
    const btns = tagBtns(d3);
    ok('SCROLL-3a: with 44 tags every one of them renders inside the grid container (all reachable — nothing cropped from the DOM)',
      btns.length === 44 && btns.every((b) => b.closest('#tagButtons') === d3.getElementById('tagButtons')),
      'count=' + btns.length);
    ok('SCROLL-3b: first, middle and last tags all present (Bulk Tag 1 / 13 / 25 + Goal)',
      !!tagBtn(d3, 'Goal') && !!tagBtn(d3, 'Bulk Tag 1') && !!tagBtn(d3, 'Bulk Tag 13') && !!tagBtn(d3, 'Bulk Tag 25'), 'ok');
    const l1 = tagBtn(d3, 'Bulk Tag 1');   // i=1 → l
    const s3b = tagBtn(d3, 'Bulk Tag 3');  // i=3 → s
    const def = tagBtn(d3, 'Bulk Tag 2');  // i=2 → default
    ok('SCROLL-5: mixed Small/Default/Large tags keep their own size classes in one grid (cd48114 behavior)',
      /tag-btn-l/.test(l1.className) && /tag-btn-s/.test(s3b.className) &&
      !/tag-btn-[sl]/.test(def.className),
      'l=' + l1.className + ' s=' + s3b.className + ' def=' + def.className);
    ok('SCROLL-3c: the whole 44-tag set persists to the library in one consistent write',
      (await sleep(50), lastLibrarySave(s3) && lastLibrarySave(s3).length === 44),
      'entries=' + (lastLibrarySave(s3) && lastLibrarySave(s3).length));
    ok('SCROLL-3d: no jsdom errors during the bulk-create sequence', jsdomErrors.length === 0,
      jsdomErrors.slice(0, 3).join(' | '));
    B3.dom.window.close();
  }

  const pass = results.filter((r) => r.pass).length;
  const fail = results.length - pass;
  console.log('\n---- tag-add-scroll-check: ' + pass + ' passed, ' + fail + ' failed ----');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('[harness fatal] ' + (e && e.stack || e));
  process.exit(2);
});
