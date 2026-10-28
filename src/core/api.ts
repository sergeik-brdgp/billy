// Typed client for the mock HTTP contract. Every response body goes through a zod
// schema; nothing here throws. Only the exact body {"error":"job not found"} means "not found":
// any other 404 / 400 (route not found, invalid request, bad key) is a configuration error.

import { z } from 'zod';

import {
  asJobId,
  type DeleteKey,
  type FileFormat,
  type IdempotencyKey,
  type JobId,
  type MockMode,
  type ServerJobView,
  type TransportCause,
} from './domain';
import type { HttpPort, HttpResponse, TransportError, UploadPort, UploadProgress } from './ports';
import { err, ok, type Result } from './result';

// ---------------------------------------------------------------------------------------------
// Schemas

const jobIdSchema = z.string().min(1).max(256);
const revisionSchema = z.number().int().nonnegative();

const readyItemSchema = z.object({
  id: z.string(),
  merchant: z.string(),
  amountMinor: z.number().int(),
  cadence: z.string(),
  lastSeen: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const plainViewSchema = z.object({
  jobId: jobIdSchema,
  status: z.enum(['queued', 'processing', 'deleting', 'deleted']),
  revision: revisionSchema,
});

const readyViewSchema = z.object({
  jobId: jobIdSchema,
  status: z.literal('ready'),
  revision: revisionSchema,
  currency: z.string().regex(/^[A-Z]{3}$/),
  items: z.array(readyItemSchema),
});

/** Job view as served by GET /imports/{id}, GET /imports/by-key/{key} and DELETE 202. */
export const jobViewSchema = z.discriminatedUnion('status', [plainViewSchema, readyViewSchema]);

/** POST 202 body: `{jobId, status: "queued", revision: 1}`. */
export const createdSchema = z.object({
  jobId: jobIdSchema,
  status: z.literal('queued'),
  revision: revisionSchema,
});

export const errorBodySchema = z.object({ error: z.string() });
const jobNotFoundSchema = z.strictObject({ error: z.literal('job not found') });

const mockJobSchema = z.object({
  jobId: jobIdSchema,
  status: z.enum(['queued', 'processing', 'ready', 'deleting', 'deleted']),
  revision: revisionSchema,
  bytes: z.number().int().nonnegative(),
  sha256: z.string(),
});

export const mockStateSchema = z.object({
  mode: z.enum(['happy', 'lost_ack', 'stale_status', 'delete_failure']),
  stats: z.object({
    createRequests: z.number().int(),
    newJobs: z.number().int(),
    duplicateHits: z.number().int(),
    acceptedBytes: z.number().int(),
    deleteRequests: z.number().int(),
  }),
  jobs: z.array(mockJobSchema),
});
export type MockState = z.infer<typeof mockStateSchema>;
export type MockStats = MockState['stats'];

function toView(raw: z.infer<typeof jobViewSchema>): ServerJobView {
  if (raw.status === 'ready') {
    return {
      jobId: asJobId(raw.jobId),
      status: 'ready',
      revision: raw.revision,
      result: { currency: raw.currency, items: raw.items },
    };
  }
  return { jobId: asJobId(raw.jobId), status: raw.status, revision: raw.revision };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Parses a job view body; null when it does not match the contract. */
export function parseJobView(bodyText: string): ServerJobView | null {
  const parsed = jobViewSchema.safeParse(parseJson(bodyText));
  return parsed.success ? toView(parsed.data) : null;
}

export function isJobNotFoundBody(bodyText: string): boolean {
  return jobNotFoundSchema.safeParse(parseJson(bodyText)).success;
}

function errorText(bodyText: string): string {
  const parsed = errorBodySchema.safeParse(parseJson(bodyText));
  return parsed.success ? parsed.data.error.slice(0, 200) : '';
}

// ---------------------------------------------------------------------------------------------
// Outcomes

export type ApiError =
  | { readonly kind: 'transport'; readonly cause: TransportCause; readonly code?: string }
  /** Wrong base URL / route / request shape: retryable, never terminal (UI: config error). */
  | { readonly kind: 'config'; readonly httpStatus: number }
  | { readonly kind: 'server'; readonly httpStatus: number }
  /** The server answered with a body that does not match the contract. */
  | { readonly kind: 'protocol'; readonly httpStatus: number };

export type ReadOutcome =
  | { readonly tag: 'found'; readonly view: ServerJobView }
  | { readonly tag: 'not_found' }
  | { readonly tag: 'failed'; readonly error: ApiError };

export type DeleteOutcome =
  /** 202: deletion accepted. The body is informational only and never changes state. */
  | { readonly tag: 'accepted'; readonly view: ServerJobView | null }
  | { readonly tag: 'not_found' }
  /** 400 / 409 etc.: our request was refused (logged as a client bug). */
  | { readonly tag: 'client_error'; readonly httpStatus: number }
  | { readonly tag: 'failed'; readonly error: ApiError };

export type PostOutcome =
  | { readonly tag: 'accepted'; readonly jobId: JobId; readonly revision: number }
  /** 409 / 413 / 415: terminal for this op. */
  | { readonly tag: 'rejected'; readonly httpStatus: number; readonly error: string }
  /** 400 header validation: nothing was created; a client bug. */
  | { readonly tag: 'client_error'; readonly httpStatus: number }
  /** The private copy disappeared before sending (cache purge). */
  | { readonly tag: 'file_missing' }
  | { readonly tag: 'failed'; readonly error: ApiError };

function transportError(error: TransportError): ApiError {
  return error.code === undefined
    ? { kind: 'transport', cause: error.cause }
    : { kind: 'transport', cause: error.cause, code: error.code };
}

function classifyOther(status: number): ApiError {
  if (status >= 500) return { kind: 'server', httpStatus: status };
  if (status >= 400) return { kind: 'config', httpStatus: status };
  return { kind: 'protocol', httpStatus: status };
}

export function classifyRead(response: Result<HttpResponse, TransportError>): ReadOutcome {
  if (!response.ok) return { tag: 'failed', error: transportError(response.error) };
  const { status, bodyText } = response.value;
  if (status === 200) {
    const view = parseJobView(bodyText);
    return view
      ? { tag: 'found', view }
      : { tag: 'failed', error: { kind: 'protocol', httpStatus: status } };
  }
  if (status === 404 && isJobNotFoundBody(bodyText)) return { tag: 'not_found' };
  return { tag: 'failed', error: classifyOther(status) };
}

export function classifyDelete(response: Result<HttpResponse, TransportError>): DeleteOutcome {
  if (!response.ok) return { tag: 'failed', error: transportError(response.error) };
  const { status, bodyText } = response.value;
  if (status === 202) return { tag: 'accepted', view: parseJobView(bodyText) };
  if (status === 404) {
    return isJobNotFoundBody(bodyText)
      ? { tag: 'not_found' }
      : { tag: 'failed', error: { kind: 'config', httpStatus: status } };
  }
  if (status >= 400 && status < 500) return { tag: 'client_error', httpStatus: status };
  return { tag: 'failed', error: classifyOther(status) };
}

export function classifyPost(response: Result<HttpResponse, TransportError>): PostOutcome {
  if (!response.ok) return { tag: 'failed', error: transportError(response.error) };
  const { status, bodyText } = response.value;
  if (status === 202) {
    const parsed = createdSchema.safeParse(parseJson(bodyText));
    return parsed.success
      ? { tag: 'accepted', jobId: asJobId(parsed.data.jobId), revision: parsed.data.revision }
      : { tag: 'failed', error: { kind: 'protocol', httpStatus: status } };
  }
  if (status === 409 || status === 413 || status === 415) {
    return { tag: 'rejected', httpStatus: status, error: errorText(bodyText) };
  }
  if (status === 400) return { tag: 'client_error', httpStatus: status };
  return { tag: 'failed', error: classifyOther(status) };
}

// ---------------------------------------------------------------------------------------------
// X-File-Name

/** Header values the mock accepts: 1–255 characters. */
export const MAX_FILE_NAME_HEADER = 255;
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;
const MAX_EXTENSION = 16;

/**
 * `X-File-Name` value: the name as-is when it is printable ASCII, else `encodeURIComponent(name)`;
 * truncated on code-point boundaries so the encoded value is 1–255 chars, keeping the extension;
 * fallback `statement.<format>`. Never throws (a lone surrogate falls back too).
 */
export function buildFileNameHeader(name: string, format: FileFormat): string {
  const fallback = `statement.${format}`;
  try {
    const trimmed = name.trim();
    if (trimmed.length === 0) return fallback;
    const ascii = PRINTABLE_ASCII.test(trimmed);
    const encode = (part: string): string => (ascii ? part : encodeURIComponent(part));
    const whole = encode(trimmed);
    if (whole.length <= MAX_FILE_NAME_HEADER) return whole;

    const dot = trimmed.lastIndexOf('.');
    const hasExt = dot > 0 && trimmed.length - dot <= MAX_EXTENSION;
    const ext = hasExt ? encode(trimmed.slice(dot)) : '';
    const base = hasExt ? trimmed.slice(0, dot) : trimmed;
    const budget = MAX_FILE_NAME_HEADER - ext.length;
    let out = '';
    for (const codePoint of base) {
      const piece = encode(codePoint);
      if (out.length + piece.length > budget) break;
      out += piece;
    }
    return out.length === 0 ? fallback : out + ext;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------------------------
// Requests

export interface ApiConfig {
  readonly baseUrl: string;
  readonly http: HttpPort;
  readonly upload: UploadPort;
  /** GET / DELETE timeout (10 s). */
  readonly requestTimeoutMs: number;
  /** Upload timeout (60 s). */
  readonly uploadTimeoutMs: number;
}

function url(config: ApiConfig, path: string): string {
  return `${config.baseUrl.replace(/\/+$/, '')}${path}`;
}

export interface CreateImportArgs {
  readonly key: IdempotencyKey;
  readonly filePath: string;
  readonly fileName: string;
  readonly format: FileFormat;
  readonly signal: AbortSignal;
  readonly onProgress?: (progress: UploadProgress) => void;
}

export async function createImport(
  config: ApiConfig,
  args: CreateImportArgs,
): Promise<PostOutcome> {
  const headers = {
    'Content-Type': 'application/octet-stream',
    'Idempotency-Key': args.key,
    'X-File-Name': buildFileNameHeader(args.fileName, args.format),
  };
  const response = await config.upload.upload({
    url: url(config, '/imports'),
    filePath: args.filePath,
    headers,
    timeoutMs: config.uploadTimeoutMs,
    signal: args.signal,
    ...(args.onProgress ? { onProgress: args.onProgress } : {}),
  });
  return classifyPost(response);
}

export async function lookupByKey(config: ApiConfig, key: IdempotencyKey): Promise<ReadOutcome> {
  return classifyRead(
    await config.http.request({
      method: 'GET',
      url: url(config, `/imports/by-key/${encodeURIComponent(key)}`),
      timeoutMs: config.requestTimeoutMs,
    }),
  );
}

export async function getJob(config: ApiConfig, jobId: JobId): Promise<ReadOutcome> {
  return classifyRead(
    await config.http.request({
      method: 'GET',
      url: url(config, `/imports/${encodeURIComponent(jobId)}`),
      timeoutMs: config.requestTimeoutMs,
    }),
  );
}

export async function deleteJob(
  config: ApiConfig,
  jobId: JobId,
  deleteKey: DeleteKey,
): Promise<DeleteOutcome> {
  return classifyDelete(
    await config.http.request({
      method: 'DELETE',
      url: url(config, `/imports/${encodeURIComponent(jobId)}`),
      headers: { 'Idempotency-Key': deleteKey },
      timeoutMs: config.requestTimeoutMs,
    }),
  );
}

// Test-control routes (diagnostics only; not production architecture).

export async function fetchMockState(config: ApiConfig): Promise<Result<MockState, ApiError>> {
  const response = await config.http.request({
    method: 'GET',
    url: url(config, '/__test/state'),
    timeoutMs: config.requestTimeoutMs,
  });
  if (!response.ok) return err(transportError(response.error));
  if (response.value.status !== 200) return err(classifyOther(response.value.status));
  const parsed = mockStateSchema.safeParse(parseJson(response.value.bodyText));
  return parsed.success ? ok(parsed.data) : err({ kind: 'protocol', httpStatus: 200 });
}

export async function setMockScenario(
  config: ApiConfig,
  mode: MockMode,
): Promise<Result<{ readonly mode: MockMode }, ApiError>> {
  const response = await config.http.request({
    method: 'POST',
    url: url(config, '/__test/scenario'),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode }),
    timeoutMs: config.requestTimeoutMs,
  });
  if (!response.ok) return err(transportError(response.error));
  if (response.value.status !== 200) return err(classifyOther(response.value.status));
  const parsed = z
    .object({ mode: z.enum(['happy', 'lost_ack', 'stale_status', 'delete_failure']) })
    .safeParse(parseJson(response.value.bodyText));
  return parsed.success
    ? ok({ mode: parsed.data.mode })
    : err({ kind: 'protocol', httpStatus: 200 });
}

export async function resetMock(config: ApiConfig): Promise<Result<void, ApiError>> {
  const response = await config.http.request({
    method: 'POST',
    url: url(config, '/__test/reset'),
    timeoutMs: config.requestTimeoutMs,
  });
  if (!response.ok) return err(transportError(response.error));
  return response.value.status === 200 ? ok(undefined) : err(classifyOther(response.value.status));
}
