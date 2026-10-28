// Pure byte-moving helpers written against a tiny handle interface, so the bounded copy and the
// header read are unit-tested without native modules. `expo-file-system`'s FileHandle satisfies
// both interfaces (`readBytes(n)` returns fewer bytes at EOF and an empty array past it).

/** 256 KiB per read: bounded memory regardless of the source size. */
export const COPY_CHUNK_BYTES = 256 * 1024;

export interface ByteSource {
  readBytes(length: number): Promise<Uint8Array>;
}

export interface ByteSink {
  writeBytes(bytes: Uint8Array): Promise<void>;
}

export type BoundedCopyResult =
  | { readonly kind: 'copied'; readonly bytes: number }
  /** More than `limitBytes` were available; the copy stopped after reading `limitBytes + 1`. */
  | { readonly kind: 'too_large' };

/**
 * Streams `source` into `sink` in chunks of at most `chunkBytes`, never reading more than
 * `limitBytes + 1` bytes in total: the first byte past the limit aborts the copy (that chunk is
 * not written). A file of exactly `limitBytes` is accepted. The caller deletes the partial
 * destination on `too_large`.
 */
export async function boundedCopy(
  source: ByteSource,
  sink: ByteSink,
  limitBytes: number,
  chunkBytes: number = COPY_CHUNK_BYTES,
): Promise<BoundedCopyResult> {
  let total = 0;
  for (;;) {
    // total ≤ limitBytes here, so we always ask for at least one byte.
    const want = Math.min(chunkBytes, limitBytes + 1 - total);
    const chunk = await source.readBytes(want);
    if (chunk.length === 0) return { kind: 'copied', bytes: total };
    total += chunk.length;
    if (total > limitBytes) return { kind: 'too_large' };
    await sink.writeBytes(chunk);
  }
}

/** Reads up to `n` bytes from the start of `source`; short reads are normal (looped until EOF). */
export async function readPrefix(source: ByteSource, n: number): Promise<Uint8Array> {
  const out = new Uint8Array(Math.max(0, n));
  let filled = 0;
  while (filled < out.length) {
    const chunk = await source.readBytes(out.length - filled);
    if (chunk.length === 0) break;
    const take = Math.min(chunk.length, out.length - filled);
    out.set(chunk.subarray(0, take), filled);
    filled += take;
  }
  return out.slice(0, filled);
}
