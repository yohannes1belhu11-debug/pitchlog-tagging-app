#!/usr/bin/env node
// =============================================================================
// MatchTag — full regression battery runner (DEV-ENV-1)
//
//   npm test
//
// Runs every tests/*.js suite sequentially with node, from the repo root
// (the harnesses expect that working directory), prints one line per suite
// plus a summary, and exits non-zero if ANY suite fails. Failed suites
// print the last 30 lines of their captured output.
//
// Requires the jsdom test environment — if it is missing this fails fast
// with setup guidance instead of letting 17 suites die with
// "jsdom not found":
//   npm run setup-tests
// =============================================================================
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const testsDir = path.join(root, 'tests');

function fail(msg) {
  console.error('run-tests: ' + msg);
  process.exit(1);
}

// Pre-flight: the UI-boot suites need the jsdom scratch. Fail fast with
// guidance instead of running 17 suites that all die with "jsdom not found".
if (!fs.existsSync(path.join(testsDir, '.jsdom-scratch', 'node_modules', 'jsdom', 'package.json'))) {
  fail('jsdom test environment not set up (tests/.jsdom-scratch/node_modules/jsdom missing).\n' +
       'run-tests: run this first:  npm run setup-tests');
}

const suites = fs.readdirSync(testsDir)
  .filter((f) => f.endsWith('.js') && !f.startsWith('.'))
  .sort();

if (suites.length === 0) {
  fail('no test suites found in tests/');
}

console.log('run-tests: ' + suites.length + ' suites, running sequentially from the repo root…\n');

let pass = 0;
const failures = [];
const started = Date.now();

for (const suite of suites) {
  const rel = 'tests/' + suite;
  const t0 = Date.now();
  const res = spawnSync(process.execPath, [rel], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 5 * 60 * 1000,
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (res.status === 0) {
    pass += 1;
    const lastLine = String(res.stdout || '').trim().split('\n').filter(Boolean).pop() || '';
    console.log('PASS ' + rel + '  (' + secs + 's)' + (lastLine ? '  — ' + lastLine : ''));
  } else {
    failures.push(rel);
    const how = res.status === null ? 'killed by ' + (res.signal || 'timeout') : 'exit ' + res.status;
    console.log('FAIL ' + rel + '  (' + secs + 's, ' + how + ')');
    const out = String(res.stdout || '') + String(res.stderr || '');
    const tail = out.trim().split('\n').filter(Boolean).slice(-30);
    if (tail.length) {
      console.log(tail.map((l) => '    ' + l).join('\n'));
    }
    console.log('');
  }
}

const total = suites.length;
const elapsed = ((Date.now() - started) / 1000).toFixed(0);
console.log('REGRESSION BATTERY: ' + pass + '/' + total + ' suites GREEN' +
  (failures.length ? ', ' + failures.length + ' FAILED' : '') + '  (' + elapsed + 's total)');
if (failures.length) {
  fail('failing suites: ' + failures.join(', '));
}
