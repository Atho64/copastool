#!/usr/bin/env node
/**
 * Prints a WiX-safe numeric version for the Windows MSI bundle.
 *
 * WiX encodes the version into MSI's fixed 4-field numeric format, where the
 * fourth field must be an integer <= 65535. A text prerelease such as
 * "0.1.14-beta.1" therefore cannot be bundled as an MSI; only NSIS accepts it.
 *
 * Stable versions are printed unchanged (0.1.14). A prerelease collapses its
 * final numeric component into the fourth field:
 *   0.1.14-beta.1 -> 0.1.14.1
 *
 * Callers should use this only for the MSI bundle; package.json remains the
 * single source of truth for every other version marker.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf-8'));

const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(version);
if (!match) {
  console.error(`msi-version: cannot parse "${version}"`);
  process.exit(1);
}

const [, major, minor, patch, prerelease] = match;
if (!prerelease) {
  process.stdout.write(`${major}.${minor}.${patch}`);
  process.exit(0);
}

// The fourth MSI field: take the last run of digits in the prerelease
// ("beta.1" -> 1, "rc2" -> 2) so successive betas sort in order. A prerelease
// with no digits at all falls back to 0, which WiX accepts.
const digits = prerelease.match(/\d+/g);
const numeric = digits ? Number(digits[digits.length - 1]) : 0;

if (numeric > 65535) {
  console.error(`msi-version: prerelease field ${numeric} exceeds the MSI limit of 65535`);
  process.exit(1);
}

process.stdout.write(`${major}.${minor}.${patch}.${numeric}`);
