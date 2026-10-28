import { boundedCopy, readPrefix, type ByteSink, type ByteSource } from './byte-io';

function source(
  data: Uint8Array,
  maxChunk = Number.POSITIVE_INFINITY,
): ByteSource & { requested: number[]; read: number } {
  let offset = 0;
  const state = {
    requested: [] as number[],
    read: 0,
    async readBytes(length: number) {
      state.requested.push(length);
      const chunk = data.slice(offset, offset + Math.min(length, maxChunk));
      offset += chunk.length;
      state.read += chunk.length;
      return chunk;
    },
  };
  return state;
}

function sink(): ByteSink & { written: number } {
  const state = {
    written: 0,
    async writeBytes(bytes: Uint8Array) {
      state.written += bytes.length;
    },
  };
  return state;
}

describe('boundedCopy', () => {
  it('copies a file of exactly the limit', async () => {
    const out = sink();
    expect(await boundedCopy(source(new Uint8Array(1000)), out, 1000, 256)).toEqual({
      kind: 'copied',
      bytes: 1000,
    });
    expect(out.written).toBe(1000);
  });

  it('aborts at limit + 1 without writing the overflowing chunk', async () => {
    const src = source(new Uint8Array(1001));
    const out = sink();
    expect(await boundedCopy(src, out, 1000, 256)).toEqual({ kind: 'too_large' });
    expect(src.read).toBe(1001);
    expect(out.written).toBeLessThanOrEqual(1000);
  });

  it('never reads more than limit + 1 bytes of a huge source and never asks for more than a chunk', async () => {
    const src = source(new Uint8Array(10_000));
    expect(await boundedCopy(src, sink(), 1000, 256)).toEqual({ kind: 'too_large' });
    expect(src.read).toBe(1001);
    expect(Math.max(...src.requested)).toBeLessThanOrEqual(256);
  });

  it('handles short reads and an empty source', async () => {
    expect(await boundedCopy(source(new Uint8Array(700), 3), sink(), 1000, 256)).toEqual({
      kind: 'copied',
      bytes: 700,
    });
    expect(await boundedCopy(source(new Uint8Array(0)), sink(), 1000, 256)).toEqual({
      kind: 'copied',
      bytes: 0,
    });
  });

  it('propagates a read error (the adapter maps it and deletes the destination)', async () => {
    const failing: ByteSource = { readBytes: () => Promise.reject(new Error('io')) };
    await expect(boundedCopy(failing, sink(), 10)).rejects.toThrow('io');
  });
});

describe('readPrefix', () => {
  const bytes = new TextEncoder().encode('date,description,amount\nmore');

  it('reads exactly n bytes when available, looping over short reads', async () => {
    expect(await readPrefix(source(bytes, 5), 24)).toEqual(bytes.slice(0, 24));
  });

  it('returns fewer bytes for a short file and nothing for an empty one', async () => {
    expect(await readPrefix(source(bytes.slice(0, 4)), 24)).toEqual(bytes.slice(0, 4));
    expect(await readPrefix(source(new Uint8Array(0)), 24)).toEqual(new Uint8Array(0));
  });

  it('ignores a source that over-delivers', async () => {
    const greedy: ByteSource = { readBytes: async () => bytes };
    expect(await readPrefix(greedy, 5)).toEqual(bytes.slice(0, 5));
  });
});
