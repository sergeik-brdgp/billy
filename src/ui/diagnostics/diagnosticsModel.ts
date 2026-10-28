// Pure formatting for the dev diagnostics panel. Never includes file names,
// results (merchants / amounts) or keys: only ids, statuses, revisions and byte counts.

import {
  formatSize,
  type DiagnosticsSnapshot,
  type IgnoredView,
  type MockStats,
  type RawView,
} from '../../core';
import { DIAGNOSTICS_COPY, IGNORE_REASON_COPY, VIEW_SOURCE_COPY } from '../copy';

/** `GET: job-demo-001 ready r3`. */
export function rawViewText(raw: RawView | null): string {
  if (raw === null) return DIAGNOSTICS_COPY.noValue;
  return `${VIEW_SOURCE_COPY[raw.source]}: ${raw.view.jobId} ${raw.view.status} r${raw.view.revision}`;
}

/** `discarded: processing r2 ≤ r3 (stale revision, GET)`. */
export function ignoredViewText(ignored: IgnoredView): string {
  const versus = ignored.reason === 'stale_revision' ? ` ≤ r${ignored.currentRevision}` : '';
  return `discarded: ${ignored.status} r${ignored.revision}${versus} (${IGNORE_REASON_COPY[ignored.reason]}, ${VIEW_SOURCE_COPY[ignored.source]})`;
}

export function ignoredSummary(ignored: DiagnosticsSnapshot['ignoredViews']): string {
  if (ignored.count === 0 || ignored.last === null) return `${ignored.count}`;
  return `${ignored.count}; last — ${ignoredViewText(ignored.last)}`;
}

export const COUNTER_KEYS = [
  'createRequests',
  'newJobs',
  'duplicateHits',
  'acceptedBytes',
  'deleteRequests',
] as const satisfies readonly (keyof MockStats)[];

export function counterLines(stats: MockStats): readonly string[] {
  return COUNTER_KEYS.map((key) => `${key}: ${stats[key]}`);
}

/** `34095 B (33.3 KiB)` — raw bytes to compare with the server's `bytes`, plus the friendly size. */
export function localSizeText(size: number | null): string {
  if (size === null) return DIAGNOSTICS_COPY.noValue;
  const friendly = formatSize(size);
  return friendly === `${size} B` ? friendly : `${size} B (${friendly})`;
}

export function localStateLines(diagnostics: DiagnosticsSnapshot): readonly string[] {
  const none = DIAGNOSTICS_COPY.noValue;
  return [
    `opId: ${diagnostics.opId ?? none}`,
    `jobId: ${diagnostics.jobId ?? none}`,
    `revision: ${diagnostics.revision ?? none}`,
  ];
}
