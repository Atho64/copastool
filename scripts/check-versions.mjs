#!/usr/bin/env node
/**
 * Verifies that every version marker in the repository agrees with package.json.
 *
 * package.json is the single source of truth: the Tauri config, the Rust crate,
 * the README badge and the frontend (which receives the version at build time via
 * vite.config.ts -> `define: { __APP_VERSION__ }`) must all match it.
 *
 * Usage: `npm run version:check` — also enforced in CI before every build.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(root, rel), 'utf-8');

const pkg = JSON.parse(read('package.json'));
const expected = pkg.version;
const problems = [];

// package.json
if (typeof expected !== 'string' || !/^\d+\.\d+\.\d+/.test(expected)) {
  problems.push(`package.json: "version" is not a valid semver: ${JSON.stringify(expected)}`);
}

// src-tauri/tauri.conf.json
const tauriConf = JSON.parse(read('src-tauri/tauri.conf.json'));
if (tauriConf.version !== expected) {
  problems.push(`src-tauri/tauri.conf.json: version "${tauriConf.version}" != "${expected}"`);
}

// src-tauri/Cargo.toml (package section only)
const cargoToml = read('src-tauri/Cargo.toml');
const packageSection = cargoToml.split(/^\[/m).find((section) => section.startsWith('package]')) || '';
const cargoVersion = /^\s*version\s*=\s*"([^"]+)"/m.exec(packageSection)?.[1];
if (cargoVersion !== expected) {
  problems.push(`src-tauri/Cargo.toml: version "${cargoVersion}" != "${expected}"`);
}

// src-tauri/Cargo.lock (entry for the app crate)
const cargoLock = read('src-tauri/Cargo.lock');
const lockVersion = /name = "copas-tool"\r?\nversion = "([^"]+)"/.exec(cargoLock)?.[1];
if (lockVersion !== expected) {
  problems.push(`src-tauri/Cargo.lock: copas-tool version "${lockVersion}" != "${expected}"`);
}

// README.md version badge
const readmeBadge = /Version-v(\d+\.\d+\.\d+)/.exec(read('README.md'))?.[1];
if (readmeBadge !== expected) {
  problems.push(`README.md: version badge "v${readmeBadge}" != "v${expected}"`);
}

// Frontend must use the injected placeholder instead of a hard-coded version
if (!read('index.html').includes('__APP_VERSION__')) {
  problems.push('index.html: the hero badge must use the __APP_VERSION__ placeholder');
}
if (!read('src/constants.ts').includes('__APP_VERSION__')) {
  problems.push('src/constants.ts: APP_VERSION must come from the injected __APP_VERSION__');
}
const hardCoded = /export const APP_VERSION = 'v?[0-9]/m.exec(read('src/constants.ts'));
if (hardCoded) {
  problems.push(`src/constants.ts: hard-coded version found (${hardCoded[0]})`);
}

if (problems.length > 0) {
  console.error('✖ Version mismatch detected:\n');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error('\nFix: make every marker match package.json ("version": ' + expected + ').');
  process.exit(1);
}

console.log(`✔ All version markers agree with package.json: v${expected}`);
