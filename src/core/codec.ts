// Journal codec: Operation <-> JSON text, validated with zod on load (schemaVersion 1).
//
// Journal minimisation: the iOS journal lives in Documents/SQLite, which is in iCloud /
// Finder backups. So the persisted body never holds the ready result (it lives in memory only and
// is re-fetched by key → GET after a cold start), and holds the original file name only while a
// resend may still need it for `X-File-Name` (before the server has the job). The shape is
// unchanged (schemaVersion 1): `result` is null and `file.name` is '' in the stored body, so rows
// written by older builds (with name and result) still decode and are rewritten minimised.

import { z } from 'zod';

import {
  asDeleteKey,
  asIdempotencyKey,
  asJobId,
  asOpId,
  type Operation,
  type Phase,
} from './domain';
import { err, ok, type Result } from './result';

const jobId = z.string().min(1).transform(asJobId);
const transportCause = z.enum([
  'not_sent',
  'unreachable',
  'timeout',
  'reset_after_send',
  'interrupted',
]);

const phaseSchema: z.ZodType<Phase> = z.discriminatedUnion('tag', [
  z.object({ tag: z.literal('pending_send') }),
  z.object({ tag: z.literal('sending'), attempt: z.number().int().positive() }),
  z.object({
    tag: z.literal('outcome_unknown'),
    cause: z.union([transportCause, z.literal('server_error')]),
    lookup: z.enum(['pending', 'not_found', 'unreachable', 'skipped', 'settling']),
    attempt: z.number().int().nonnegative(),
    abandon: z.boolean(),
  }),
  z.object({ tag: z.literal('server'), jobId, status: z.enum(['queued', 'processing', 'ready']) }),
  z.object({
    tag: z.literal('rejected_by_server'),
    httpStatus: z.number().int(),
    error: z.string(),
  }),
  z.object({ tag: z.literal('delete_requested'), jobId }),
  z.object({
    tag: z.literal('delete_failed'),
    jobId,
    cause: z.union([z.enum(['http_5xx', 'client_error']), transportCause]),
  }),
  z.object({ tag: z.literal('deleting'), jobId }),
  z.object({ tag: z.literal('deleted'), jobId }),
  z.object({ tag: z.literal('lost'), jobId: jobId.nullable() }),
  z.object({ tag: z.literal('cancelled') }),
]);

const operationSchema: z.ZodType<Operation> = z.object({
  schemaVersion: z.literal(1),
  opId: z.string().min(1).transform(asOpId),
  createdAt: z.number(),
  key: z.string().min(8).max(128).transform(asIdempotencyKey),
  deleteKey: z.string().min(8).max(128).transform(asDeleteKey).nullable(),
  file: z.object({
    format: z.enum(['pdf', 'csv']),
    size: z.number().int().nonnegative(),
    name: z.string(),
    tempPath: z.string().nullable(),
  }),
  revision: z.number().int().nonnegative(),
  result: z
    .object({
      currency: z.string(),
      items: z.array(
        z.object({
          id: z.string(),
          merchant: z.string(),
          amountMinor: z.number().int(),
          cadence: z.string(),
          lastSeen: z.string(),
        }),
      ),
    })
    .nullable(),
  recoveredByKey: z.boolean(),
  phase: phaseSchema,
});

/**
 * Whether a resend may still need the original file name (`X-File-Name`): only before the server
 * is known to have the job. From the persist that records the job (202 accepted or found by key)
 * on, the journal keeps no name.
 */
export function journalKeepsFileName(phase: Phase): boolean {
  return phase.tag === 'pending_send' || phase.tag === 'sending' || phase.tag === 'outcome_unknown';
}

/**
 * The op as the journal stores it: never the ready result; no file name once the server has the
 * job. Returns `op` itself (same reference) when there is nothing to drop.
 */
export function journalForm(op: Operation): Operation {
  const dropName = op.file.name !== '' && !journalKeepsFileName(op.phase);
  if (op.result === null && !dropName) return op;
  return {
    ...op,
    result: null,
    file: dropName ? { ...op.file, name: '' } : op.file,
  };
}

/** JSON body of the journal row: always the minimised `journalForm`. */
export function encodeOperation(op: Operation): string {
  return JSON.stringify(journalForm(op));
}

export function decodeOperation(body: string): Result<Operation, 'invalid'> {
  let json: unknown;
  try {
    json = JSON.parse(body) as unknown;
  } catch {
    return err('invalid');
  }
  const parsed = operationSchema.safeParse(json);
  return parsed.success ? ok(parsed.data) : err('invalid');
}
