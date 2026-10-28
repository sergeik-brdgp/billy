import { asOpId } from '../core/domain';
import { CACHE, CONTAINER, fakeFs } from './__tests__/fake-file-system';
import { createExpoFiles } from './files';

jest.mock('expo-file-system', () => jest.requireActual('./__tests__/fake-file-system'));

const LIMIT = 10_485_760;
const OP = asOpId('0b5a2b7e-6f43-4a8e-9a63-1f6b1d3c2e10');
const INBOX = `file:///private/var/mobile/Containers/Data/Application/APP/tmp/dev.narhi.statementimport-Inbox`;
const CSV = new TextEncoder().encode('date,description,amount\n2026-10-01,StreamBeam,-19.99\n');

const bytes = (n: number, fill = 0x41): Uint8Array => new Uint8Array(n).fill(fill);
const contentUri = 'content://com.android.providers.downloads.documents/document/42';

beforeEach(() => fakeFs.reset());

describe('pathFor / listPrivate', () => {
  it('puts the private copy at <cache>/imports/<opId>.bin and lists it with the same spelling', async () => {
    const files = createExpoFiles({ platform: 'ios' });
    const dest = files.pathFor(OP);
    expect(dest).toBe(`${CACHE}imports/${OP}.bin`);
    expect(
      (await files.copyIn({ uri: contentUri, name: 'a.csv', declaredSize: null }, dest, LIMIT)).ok,
    ).toBe(false);
    fakeFs.putFile(contentUri, CSV);
    expect(
      await files.copyIn({ uri: contentUri, name: 'a.csv', declaredSize: null }, dest, LIMIT),
    ).toEqual({
      ok: true,
      value: { bytes: CSV.length },
    });
    expect(await files.listPrivate()).toEqual({ ok: true, value: [dest] });
  });

  it('lists nothing when the directory does not exist yet', async () => {
    expect(await createExpoFiles({ platform: 'android' }).listPrivate()).toEqual({
      ok: true,
      value: [],
    });
  });
});

describe('copyIn: Android content:// bounded streaming copy', () => {
  const files = () => createExpoFiles({ platform: 'android' });
  const picked = (declaredSize: number | null = null) => ({
    uri: contentUri,
    name: 'x.csv',
    declaredSize,
  });

  it('accepts a file of exactly the limit', async () => {
    fakeFs.putFile(contentUri, bytes(LIMIT));
    const port = files();
    const dest = port.pathFor(OP);
    expect(await port.copyIn(picked(), dest, LIMIT)).toEqual({ ok: true, value: { bytes: LIMIT } });
    expect(fakeFs.data(dest)?.length).toBe(LIMIT);
    expect(fakeFs.openHandles).toBe(0);
    expect(fakeFs.maxReadRequest).toBeLessThanOrEqual(256 * 1024);
  });

  it('aborts at limit + 1, deletes the partial destination and leaves the source alone', async () => {
    fakeFs.putFile(contentUri, bytes(LIMIT + 1));
    const port = files();
    const dest = port.pathFor(OP);
    expect(await port.copyIn(picked(), dest, LIMIT)).toEqual({
      ok: false,
      error: { kind: 'too_large' },
    });
    expect(fakeFs.has(dest)).toBe(false);
    expect(fakeFs.has(contentUri)).toBe(true);
    expect(fakeFs.openHandles).toBe(0);
  });

  it('stops reading right after the limit even for a much larger source', async () => {
    fakeFs.putFile(contentUri, bytes(LIMIT * 3));
    const port = files();
    const dest = port.pathFor(OP);
    expect(await port.copyIn(picked(), dest, LIMIT)).toEqual({
      ok: false,
      error: { kind: 'too_large' },
    });
    expect(fakeFs.has(dest)).toBe(false);
  });

  it('falls back to a native copy when the descriptor yields 0 bytes, then checks the size', async () => {
    fakeFs.putFile(contentUri, CSV, { zeroReads: true });
    const port = files();
    const dest = port.pathFor(OP);
    expect(await port.copyIn(picked(), dest, LIMIT)).toEqual({
      ok: true,
      value: { bytes: CSV.length },
    });
    expect(fakeFs.copies).toBe(1);
  });

  it('falls back to a native copy when the first read throws (pipe-backed provider)', async () => {
    fakeFs.putFile(contentUri, CSV, { pipe: true });
    const port = files();
    const dest = port.pathFor(OP);
    expect(await port.copyIn(picked(), dest, LIMIT)).toEqual({
      ok: true,
      value: { bytes: CSV.length },
    });
    expect(fakeFs.copies).toBe(1);
    expect(fakeFs.openHandles).toBe(0);
  });

  it('does not fall back after a read failed mid-copy (bytes were already written)', async () => {
    fakeFs.putFile(contentUri, bytes(600 * 1024), { failAfter: 256 * 1024 });
    const port = files();
    expect(await port.copyIn(picked(), port.pathFor(OP), LIMIT)).toEqual({
      ok: false,
      error: { kind: 'unreadable' },
    });
    expect(fakeFs.copies).toBe(0);
  });

  it('rejects an oversize file found by the fallback copy and deletes it', async () => {
    fakeFs.putFile(contentUri, bytes(LIMIT + 5), { pipe: true });
    const port = files();
    const dest = port.pathFor(OP);
    expect(await port.copyIn(picked(), dest, LIMIT)).toEqual({
      ok: false,
      error: { kind: 'too_large' },
    });
    expect(fakeFs.has(dest)).toBe(false);
  });

  it('falls back to a native copy when the provider cannot open a descriptor', async () => {
    fakeFs.putFile(contentUri, CSV, { unopenable: true });
    const port = files();
    expect(await port.copyIn(picked(), port.pathFor(OP), LIMIT)).toEqual({
      ok: true,
      value: { bytes: CSV.length },
    });
  });

  it('keeps an empty file empty (the content check rejects it later)', async () => {
    fakeFs.putFile(contentUri, new Uint8Array(0));
    const port = files();
    expect(await port.copyIn(picked(), port.pathFor(OP), LIMIT)).toEqual({
      ok: true,
      value: { bytes: 0 },
    });
  });

  it('maps a read failure to unreadable and removes the partial copy', async () => {
    fakeFs.putFile(contentUri, bytes(600 * 1024), { failAfter: 256 * 1024 });
    const port = files();
    const dest = port.pathFor(OP);
    expect(await port.copyIn(picked(), dest, LIMIT)).toEqual({
      ok: false,
      error: { kind: 'unreadable' },
    });
    expect(fakeFs.has(dest)).toBe(false);
    expect(fakeFs.openHandles).toBe(0);
  });

  it('refuses a destination outside the private directory', async () => {
    fakeFs.putFile(contentUri, CSV);
    const port = files();
    const outside = `${CONTAINER}/Documents/x.bin`;
    expect(await port.copyIn(picked(), outside, LIMIT)).toEqual({
      ok: false,
      error: { kind: 'unreadable' },
    });
    expect(fakeFs.has(outside)).toBe(false);
  });

  it('rejects unknown schemes', async () => {
    const port = files();
    expect(
      await port.copyIn(
        { uri: 'https://example.invalid/x.csv', name: 'x', declaredSize: null },
        port.pathFor(OP),
        LIMIT,
      ),
    ).toEqual({ ok: false, error: { kind: 'unreadable' } });
  });
});

describe('copyIn: iOS Inbox copy', () => {
  const inboxFile = `${INBOX}/statement.csv`;

  it('moves the owned Inbox copy into the private directory', async () => {
    fakeFs.putFile(inboxFile, CSV);
    const port = createExpoFiles({ platform: 'ios' });
    const dest = port.pathFor(OP);
    expect(
      await port.copyIn(
        { uri: inboxFile, name: 'statement.csv', declaredSize: CSV.length },
        dest,
        LIMIT,
      ),
    ).toEqual({
      ok: true,
      value: { bytes: CSV.length },
    });
    expect(fakeFs.moves).toBe(1);
    expect(fakeFs.has(inboxFile)).toBe(false);
    expect(fakeFs.data(dest)).toEqual(CSV);
  });

  it('does not move an oversize Inbox copy; releasePicked then deletes it', async () => {
    fakeFs.putFile(inboxFile, bytes(LIMIT + 1));
    const port = createExpoFiles({ platform: 'ios' });
    const source = { uri: inboxFile, name: 'big.csv', declaredSize: null };
    const dest = port.pathFor(OP);
    expect(await port.copyIn(source, dest, LIMIT)).toEqual({
      ok: false,
      error: { kind: 'too_large' },
    });
    expect(fakeFs.has(dest)).toBe(false);
    await port.releasePicked(source);
    expect(fakeFs.has(inboxFile)).toBe(false);
  });

  it('copies (never moves) a file:// it does not own', async () => {
    const foreign = `${CONTAINER}/Documents/statement.csv`;
    fakeFs.putFile(foreign, CSV);
    const port = createExpoFiles({ platform: 'ios' });
    const source = { uri: foreign, name: 'statement.csv', declaredSize: null };
    expect((await port.copyIn(source, port.pathFor(OP), LIMIT)).ok).toBe(true);
    await port.releasePicked(source);
    expect(fakeFs.has(foreign)).toBe(true);
    expect(fakeFs.moves).toBe(0);
  });
});

describe('releasePicked', () => {
  it('is a no-op for an Android content:// source', async () => {
    fakeFs.putFile(contentUri, CSV);
    const port = createExpoFiles({ platform: 'android' });
    await port.releasePicked({ uri: contentUri, name: 'x.csv', declaredSize: null });
    expect(fakeFs.has(contentUri)).toBe(true);
    expect(fakeFs.deletes).toEqual([]);
  });

  it('is idempotent and silent when the Inbox copy is already gone', async () => {
    const port = createExpoFiles({ platform: 'ios' });
    const source = { uri: `${INBOX}/gone.pdf`, name: 'gone.pdf', declaredSize: 3 };
    await expect(port.releasePicked(source)).resolves.toBeUndefined();
    await expect(port.releasePicked(source)).resolves.toBeUndefined();
  });

  it('never deletes a file:// path outside the Inbox / picker cache, even with .. segments', async () => {
    const target = `${CONTAINER}/Documents/keep.csv`;
    fakeFs.putFile(target, CSV);
    const port = createExpoFiles({ platform: 'ios' });
    await port.releasePicked({
      uri: `${INBOX}/../../Documents/keep.csv`,
      name: 'k',
      declaredSize: 1,
    });
    expect(fakeFs.has(target)).toBe(true);
  });
});

describe('readHeader / size / exists / delete', () => {
  it('reads at most n bytes and returns short reads as-is', async () => {
    const port = createExpoFiles({ platform: 'ios' });
    const path = port.pathFor(OP);
    fakeFs.putFile(path, new TextEncoder().encode('%PDF'));
    expect(await port.readHeader(path, 24)).toEqual({
      ok: true,
      value: new TextEncoder().encode('%PDF'),
    });
    fakeFs.putFile(path, CSV);
    const header = await port.readHeader(path, 24);
    expect(header.ok && header.value.length).toBe(24);
    expect(fakeFs.openHandles).toBe(0);
  });

  it('reports a missing file as not_found', async () => {
    const port = createExpoFiles({ platform: 'ios' });
    const path = port.pathFor(OP);
    expect(await port.readHeader(path, 24)).toEqual({ ok: false, error: { kind: 'not_found' } });
    expect(await port.size(path)).toEqual({ ok: false, error: { kind: 'not_found' } });
    expect(await port.exists(path)).toBe(false);
  });

  it('deletes private files (missing is ok) and refuses anything else', async () => {
    const port = createExpoFiles({ platform: 'android' });
    const path = port.pathFor(OP);
    fakeFs.putFile(path, CSV);
    expect(await port.size(path)).toEqual({ ok: true, value: CSV.length });
    expect(await port.delete(path)).toEqual({ ok: true, value: undefined });
    expect(await port.delete(path)).toEqual({ ok: true, value: undefined });
    fakeFs.putFile(contentUri, CSV);
    expect(await port.delete(contentUri)).toEqual({ ok: false, error: { kind: 'io' } });
    expect(fakeFs.has(contentUri)).toBe(true);
  });
});

describe('sweepPlatformCaches', () => {
  it('iOS: empties tmp/*-Inbox and the picker cache, leaves other tmp content and the private dir', async () => {
    const port = createExpoFiles({ platform: 'ios' });
    fakeFs.putDir(`${CONTAINER}/tmp`);
    fakeFs.putDir(INBOX);
    fakeFs.putFile(`${INBOX}/old.pdf`, CSV);
    fakeFs.putDir(`${CONTAINER}/tmp/WebKit`);
    fakeFs.putFile(`${CONTAINER}/tmp/WebKit/keep`, CSV);
    fakeFs.putDir(`${CACHE}DocumentPicker`);
    fakeFs.putFile(`${CACHE}DocumentPicker/copy.csv`, CSV);
    const live = port.pathFor(OP);
    fakeFs.putDir(`${CACHE}imports`);
    fakeFs.putFile(live, CSV);

    await port.sweepPlatformCaches();

    expect(fakeFs.has(`${INBOX}/old.pdf`)).toBe(false);
    expect(fakeFs.has(`${CACHE}DocumentPicker/copy.csv`)).toBe(false);
    expect(fakeFs.has(`${CONTAINER}/tmp/WebKit/keep`)).toBe(true);
    expect(fakeFs.has(live)).toBe(true);
  });

  it('Android: empties the picker cache only; a missing cache dir is fine', async () => {
    const port = createExpoFiles({ platform: 'android' });
    await expect(port.sweepPlatformCaches()).resolves.toBeUndefined();
    fakeFs.putDir(`${CACHE}DocumentPicker`);
    fakeFs.putFile(`${CACHE}DocumentPicker/copy.csv`, CSV);
    await port.sweepPlatformCaches();
    expect(fakeFs.has(`${CACHE}DocumentPicker/copy.csv`)).toBe(false);
  });
});
