#!/usr/bin/env node
// npm run matrix — runs every acceptance-matrix scenario through the real core with Node adapters
// against a fresh in-process copy of the unchanged mock, and prints mock counter deltas
// (GET /__test/state before/after) and the final UI state per row.
//
// The scenarios live in tests/support/scenarios.ts (shared with tests/integration); Vite's module
// runner loads the TypeScript sources directly, no build step.
//
// Usage: node scripts/matrix.mjs [--json]

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const asJson = process.argv.includes('--json');

const { module: scenarios } = await runnerImport(resolve(root, 'tests/support/scenarios.ts'), {
  root,
  configFile: false,
  logLevel: 'error',
});

const rows = [];
let failures = 0;
for (const scenario of scenarios.MATRIX) {
  try {
    const result = await scenario();
    rows.push({
      id: result.id,
      title: result.title,
      deltas: result.deltas,
      finalView: result.finalView,
      note: scenarios.noteFor(result),
    });
  } catch (error) {
    failures += 1;
    rows.push({
      id: 'error',
      title: String(error instanceof Error ? error.message : error),
      deltas: null,
      finalView: 'ERROR',
      note: '',
    });
  }
}
const differential = await scenarios.differentialValidator();

if (asJson) {
  console.log(JSON.stringify({ rows, differential: differential.checks }, null, 2));
} else {
  const header = [
    'scenario',
    'createRequests',
    'newJobs',
    'duplicateHits',
    'acceptedBytes',
    'deleteRequests',
    'final UI state',
  ];
  const lines = rows.map((row) => [
    row.id,
    ...(row.deltas
      ? [
          `+${row.deltas.createRequests}`,
          `+${row.deltas.newJobs}`,
          `+${row.deltas.duplicateHits}`,
          `+${row.deltas.acceptedBytes}`,
          `+${row.deltas.deleteRequests}`,
        ]
      : ['-', '-', '-', '-', '-']),
    row.finalView,
  ]);
  const table = (head, body) => [
    `| ${head.join(' | ')} |`,
    `|${head.map(() => '---').join('|')}|`,
    ...body.map((cells) => `| ${cells.join(' | ')} |`),
  ];
  console.log('Counter deltas per matrix row (fresh in-process mock per row):\n');
  console.log(table(header, lines).join('\n'));
  console.log('\nScenarios:\n');
  for (const row of rows) console.log(`- ${row.id}: ${row.title}\n  → ${row.note}`);
  console.log('\nDifferential validator (client verdict vs mock POST status):\n');
  console.log(
    table(
      ['case', 'client', 'mock'],
      differential.checks.map((row) => [row.name, row.client, String(row.server)]),
    ).join('\n'),
  );
}
process.exitCode = failures > 0 ? 1 : 0;
