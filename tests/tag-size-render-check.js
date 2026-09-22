#!/usr/bin/env node
// PitchLog / MatchTag — NAT-4 tag-size render regression check.
// =====================================================================
// Verification-only harness. It does NOT modify any app source file.
//
// Pins the NAT-4 "tag resizing did not work" defect fix (Windows NAT-4 QA
// finding, R2-E Phase 2A follow-up):
//
//   DEFECT  The per-tag Size control (Default / Small / Large) was fully
//           wired end-to-end (modal -> tag.size -> class -> autosave ->
//           reload — pinned by tag-controls-check.js), but the size classes
//           only tweaked font-size + padding INSIDE a uniform grid
//           (.tag-grid { repeat(auto-fill, minmax(110px,1fr)) } with the
//           default grid-item stretch). The grid fixed every button's width
//           to the track width and stretched every button to the shared row
//           height, so Small rendered a byte-identical box and Large only
//           made the whole row taller — per-button resizing was visually
//           non-functional. (Measured on real Electron at adb2d4d: Default
//           116.4x51, Small 116.4x51 — identical, Large 116.4x61 with all
//           8 row-mates stretched to 61 together.)
//
//   FIX     src/styles.css only: .tag-grid { align-items: start } plus
//           min-height floors on the three size classes (Small 38px /
//           Default 48px / Large 60px -> rendered ~39/50/61). Font/padding
//           behaviour unchanged; renderer/data layers untouched.
//
// This check pins the fix as source-level invariants verifiable without a
// layout engine (jsdom does no layout — that gap is why the original defect
// reached manual QA). The real-geometry gate lives in the Electron QA
// harness (real app under Xvfb, getBoundingClientRect measurements) and the
// Windows manual QA checklist.
//
// Validated both ways during the fix: against the PRE-FIX tree TSR-1/2/3
// FAIL (defect detected), TSR-4..7 PASS; against the fixed tree 7/7 PASS.
//
// Run:  node tests/tag-size-render-check.js   (from the project root)
'use strict';

const fs = require('fs');
const path = require('path');

const CSS = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf-8')
  .replace(/\/\*[\s\S]*?\*\//g, ''); // strip comments before parsing rules
const RENDERER = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf-8');

let pass = 0, fail = 0;
function ok(id, cond, detail) {
  console.log((cond ? '[PASS] ' : '[FAIL] ') + id + (detail ? '  | ' + detail : ''));
  cond ? pass++ : fail++;
  if (!cond) process.exitCode = 1;
}

// --- helpers -----------------------------------------------------------------
// Parse top-level rule blocks; return those whose comma-separated selector
// list contains the EXACT token (so '.tag-btn' never matches
// '.touchline-tag-btn' or '.tag-btn-s').
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
function rule(selectorToken) {
  const b = ruleBlocks(selectorToken)[0];
  return b ? b.body : null;
}
function decl(block, prop) {
  if (!block) return null;
  const m = block.match(new RegExp('(^|[^-])' + prop.replace(/-/g, '\\-') + '\\s*:\\s*([^;]+);'));
  return m ? m[2].trim() : null;
}

// --- 1. the grid must NOT force-stretch buttons to equal row heights --------
// (Pre-fix state: no align-items declaration -> 'normal' -> grid items
//  stretch -> per-tag sizes invisible. Post-fix: align-items: start.)
{
  const g = rule('.tag-grid');
  ok('TSR-1: .tag-grid declares align-items: start (buttons keep their own height)',
    !!g && decl(g, 'align-items') === 'start',
    'align-items=' + (g ? decl(g, 'align-items') : 'RULE MISSING'));
}

// --- 2. size classes must declare explicit height floors that differ ---------
{
  const bh = decl(rule('.tag-btn'), 'min-height');
  const sh = decl(rule('.tag-btn-s'), 'min-height');
  const lh = decl(rule('.tag-btn-l'), 'min-height');
  ok('TSR-2: .tag-btn, .tag-btn-s, .tag-btn-l each declare a min-height floor, all distinct',
    !!sh && !!lh && !!bh && sh !== bh && lh !== bh && sh !== lh,
    `default=${bh} small=${sh} large=${lh}`);
  const num = (v) => parseFloat(v);
  ok('TSR-3: size floors are ordered small < default < large',
    !!sh && !!lh && !!bh && num(sh) < num(bh) && num(bh) < num(lh),
    `small=${sh} default=${bh} large=${lh}`);
}

// --- 3. the renderer still maps tag.size -> class (wiring unchanged) --------
{
  ok('TSR-4: renderTagButtons still derives tag-btn-s / tag-btn-l from tag.size',
    /tag\.size === 's' \? ' tag-btn-s' : \(tag\.size === 'l' \? ' tag-btn-l' : ''\)/.test(RENDERER));
  ok('TSR-5: edit path still writes/deletes tag.size (applyTagEdit)',
    /if \(size\) tag\.size = size; else delete tag\.size;/.test(RENDERER));
}

// --- 4. anti-regression guards (all occurrences of the guarded selectors) ---
{
  // (a) No .tag-grid rule may (re)introduce stretch/center/end/normal ITEM
  //     alignment. Note: align-items INSIDE .tag-btn* rules is flex content
  //     centering (children), unrelated to grid sizing — only .tag-grid is
  //     the grid container.
  const badGrid = [];
  ruleBlocks('.tag-grid').forEach((b) => {
    (b.body.match(/align-items\s*:\s*[^;]+;/g) || []).forEach((d) => {
      if (!/align-items\s*:\s*start/.test(d)) badGrid.push(d.trim());
    });
  });
  ok('TSR-6: every .tag-grid align-items declaration is start (no stretch/center/end/normal)',
    badGrid.length === 0, badGrid.join(' ;; ') || 'none');

  // (b) No desktop tag-button rule may force a fixed height or override the
  //     grid alignment with align-self (min-height floors are the contract).
  const btnTokens = ['.tag-btn', '.tag-btn-s', '.tag-btn-l'];
  const badBtn = [];
  btnTokens.forEach((tok) => {
    ruleBlocks(tok).forEach((b) => {
      (b.body.match(/align-self\s*:\s*[^;]+;/g) || []).forEach((d) => {
        if (!/align-self\s*:\s*start/.test(d)) badBtn.push(tok + ' ' + d.trim());
      });
      (b.body.match(/(^|[^-])height\s*:\s*[^;]+;/g) || []).forEach((d) => {
        badBtn.push(tok + ' ' + d.trim());
      });
    });
  });
  ok('TSR-7: no .tag-btn/.tag-btn-s/.tag-btn-l rule forces fixed height or align-self overrides',
    badBtn.length === 0, badBtn.join(' ;; ') || 'none');
}

console.log('---- tag-size-render-check: ' + pass + ' passed, ' + fail + ' failed ----');
process.exit(fail ? 1 : 0);
