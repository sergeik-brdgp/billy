#!/usr/bin/env node
// Verifies that mock-kit/ is byte-for-byte the candidate kit.
// The manifest scripts/kit.sha256 (`<sha256>  <path relative to mock-kit/>`, one per line) was produced
// from the original zip. Mock runtime files are ignored; anything else that differs fails with a diff.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXPECTED_ENTRIES = 9;
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const kitDir = join(repoRoot, 'mock-kit');
const manifestPath = join(repoRoot, 'scripts', 'kit.sha256');

/** Files the mock (or its npm scripts) create at runtime; never part of the kit. */
const isRuntimeFile = (rel) =>
  rel === 'fixtures/oversize.csv' ||
  /^\.mock-state\.json/.test(rel) ||
  posix.basename(rel) === '.DS_Store';

function fail(lines) {
  console.error(
    ['verify:kit FAILED — mock-kit/ differs from scripts/kit.sha256', ...lines].join('\n'),
  );
  console.error(
    'mock-kit/ must stay the unchanged candidate kit. Restore it from the original zip / git.',
  );
  process.exit(1);
}

function parseManifest() {
  const entries = new Map();
  const problems = [];
  const lines = readFileSync(manifestPath, 'utf8').split('\n');
  lines.forEach((line, index) => {
    if (line.trim() === '') return;
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
    if (!match) {
      problems.push(`  manifest line ${index + 1}: unparseable: ${JSON.stringify(line)}`);
      return;
    }
    const [, hash, rawPath] = match;
    const rel = posix.normalize(rawPath);
    if (rel.startsWith('../') || rel.startsWith('/') || rel === '..') {
      problems.push(`  manifest line ${index + 1}: path escapes mock-kit/: ${rawPath}`);
      return;
    }
    if (entries.has(rel)) problems.push(`  manifest line ${index + 1}: duplicate entry ${rel}`);
    entries.set(rel, hash);
  });
  if (entries.size !== EXPECTED_ENTRIES) {
    problems.push(`  manifest lists ${entries.size} files, expected exactly ${EXPECTED_ENTRIES}`);
  }
  return { entries, problems };
}

function listKitFiles(dir) {
  const out = [];
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, dirent.name);
    if (dirent.isDirectory()) out.push(...listKitFiles(abs));
    else out.push(relative(kitDir, abs).split(sep).join('/'));
  }
  return out;
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

if (!existsSync(manifestPath)) fail([`  missing manifest ${relative(repoRoot, manifestPath)}`]);
if (!existsSync(kitDir) || !statSync(kitDir).isDirectory()) fail(['  missing directory mock-kit/']);

const { entries, problems } = parseManifest();
const diff = [...problems];

for (const [rel, expected] of entries) {
  const abs = join(kitDir, ...rel.split('/'));
  if (!existsSync(abs)) {
    diff.push(`  - missing   ${rel}`);
    continue;
  }
  const actual = sha256(abs);
  if (actual !== expected) {
    diff.push(`  ~ modified  ${rel}`, `      expected ${expected}`, `      actual   ${actual}`);
  }
}

const extras = listKitFiles(kitDir)
  .filter((rel) => !entries.has(rel) && !isRuntimeFile(rel))
  .sort();
for (const rel of extras) diff.push(`  + unexpected ${rel}`);

if (diff.length > 0) fail(diff);

console.log(`verify:kit OK — ${entries.size} mock-kit files match scripts/kit.sha256`);
