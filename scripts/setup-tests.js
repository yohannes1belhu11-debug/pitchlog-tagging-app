#!/usr/bin/env node
// =============================================================================
// MatchTag — deterministic test-environment setup (DEV-ENV-1)
//
// Fresh-clone workflow:
//     npm run setup-tests   # one-time: installs the jsdom test environment
//     npm test              # runs the full regression battery
//
// Why a scratch folder (original design, preserved): jsdom is test-only
// tooling and is deliberately NOT an app dependency. It lives in
// tests/.jsdom-scratch/ with its own package.json + package-lock.json
// (both committed), so:
//   - the Electron app manifest stays free of test tooling,
//   - running the tests never installs Electron / electron-builder,
//   - the test dependency tree is pinned exactly by the committed lockfile.
//
// This script installs the scratch from its committed lockfile with
// `npm ci` (exact reproduction, no version drift) and verifies that the
// installed jsdom matches the pinned version.
// =============================================================================
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const scratch = path.join(root, 'tests', '.jsdom-scratch');

function fail(msg) {
  console.error('setup-tests: FAILED — ' + msg);
  process.exit(1);
}

// jsdom 30.x requires Node >= 18.
const major = Number(process.versions.node.split('.')[0]);
if (major < 18) {
  fail('Node ' + process.versions.node + ' found; jsdom 30.x requires Node >= 18.');
}

for (const name of ['package.json', 'package-lock.json']) {
  if (!fs.existsSync(path.join(scratch, name))) {
    fail('tests/.jsdom-scratch/' + name + ' is missing — it is part of the repository; re-clone or restore it with git checkout.');
  }
}

let locked;
try {
  const lock = JSON.parse(fs.readFileSync(path.join(scratch, 'package-lock.json'), 'utf8'));
  const entry = lock.packages && lock.packages['node_modules/jsdom'];
  locked = entry && entry.version;
} catch (e) {
  locked = undefined;
}

console.log('setup-tests: installing the jsdom test environment (npm ci in tests/.jsdom-scratch)…');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const res = spawnSync(npm, ['ci', '--no-fund', '--no-audit'], { cwd: scratch, stdio: 'inherit' });
if (res.error) {
  fail('could not launch npm: ' + res.error.message);
}
if (res.status !== 0) {
  fail('npm ci exited with ' + res.status + '.');
}

let installed;
try {
  installed = JSON.parse(fs.readFileSync(path.join(scratch, 'node_modules', 'jsdom', 'package.json'), 'utf8')).version;
} catch (e) {
  fail('jsdom did not install correctly: ' + e.message);
}
if (locked && installed !== locked) {
  fail('installed jsdom ' + installed + ' does not match the lockfile pin ' + locked + '.');
}
console.log('setup-tests: jsdom ' + installed + ' ready (lockfile pin: ' + (locked || 'unknown') + ').');
console.log('setup-tests: done — run the battery with:  npm test');
