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
// Semver with optional prerelease/build suffix (e.g. 0.1.14-beta.1), so a
// pre-release tag can be cut without editing this script.
if (typeof expected !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(expected)) {
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

// package-lock.json — npm rewrites both markers from package.json on install,
// so a stale value here means someone edited package.json by hand.
const pkgLock = JSON.parse(read('package-lock.json'));
if (pkgLock.version !== expected) {
  problems.push(`package-lock.json: version "${pkgLock.version}" != "${expected}"`);
}
const pkgLockRoot = pkgLock.packages?.['']?.version;
if (pkgLockRoot !== expected) {
  problems.push(`package-lock.json: packages[""] version "${pkgLockRoot}" != "${expected}"`);
}

// README.md version badge
// shields.io renders a literal '-' as '--' inside a static badge path, so
// "v0.1.14-beta.1" is written as "Version-v0.1.14--beta.1" in the URL. Decode
// that before comparing, otherwise every pre-release fails this gate.
const readmeBadgeRaw = /Version-v([0-9][0-9A-Za-z.-]*?)-(?:purple|blue|green|red|orange|grey|gray|yellow|brightgreen|black)(?:\?|\b)/.exec(read('README.md'))?.[1];
const readmeBadge = readmeBadgeRaw?.replace(/--/g, '-');
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
