import type { SQLiteBindParams } from 'expo-sqlite';

import {
  CHECKPOINT_SQL,
  createSqliteStore,
  LOAD_ALL_SQL,
  REMOVE_SQL,
  SCHEMA_SQL,
  UPSERT_SQL,
  type JournalDb,
} from './store';

jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));

/** Tiny in-memory interpretation of the three statements the store issues. */
function fakeDb(options: { failExec?: boolean; failRun?: boolean; failCheckpoint?: boolean } = {}) {
  const rows = new Map<string, { body: string; updated_at: number }>();
  const sql: string[] = [];
  let closed = false;
  const db: JournalDb = {
    async execAsync(source) {
      sql.push(source);
      if (options.failExec) throw new Error('disk I/O error');
      if (options.failCheckpoint && source === CHECKPOINT_SQL) throw new Error('database is busy');
    },
    async runAsync(source, params: SQLiteBindParams) {
      sql.push(source);
      if (options.failRun) throw new Error('database is locked');
      const values = params as unknown[];
      if (source === UPSERT_SQL) {
        rows.set(values[0] as string, {
          body: values[1] as string,
          updated_at: values[2] as number,
        });
      } else if (source === REMOVE_SQL) {
        rows.delete(values[0] as string);
      } else {
        throw new Error(`unexpected SQL: ${source}`);
      }
      return { changes: 1, lastInsertRowId: 0 };
    },
    async getAllAsync<T>(source: string) {
      sql.push(source);
      if (source !== LOAD_ALL_SQL) throw new Error(`unexpected SQL: ${source}`);
      return [...rows.entries()]
        .sort((a, b) => a[1].updated_at - b[1].updated_at || a[0].localeCompare(b[0]))
        .map(([op_id, row]) => ({ op_id, body: row.body })) as T[];
    },
    async closeAsync() {
      closed = true;
    },
  };
  return { db, rows, sql, isClosed: () => closed };
}

describe('sqlite StorePort', () => {
  it('creates the table on first use and upserts atomically with ON CONFLICT DO UPDATE', async () => {
    const fake = fakeDb();
    const open = jest.fn(async () => fake.db);
    const store = createSqliteStore({ open, now: () => 1000 });
    expect(await store.upsert({ opId: 'a', body: '{"v":1}' })).toEqual({
      ok: true,
      value: undefined,
    });
    expect(await store.upsert({ opId: 'a', body: '{"v":2}' })).toEqual({
      ok: true,
      value: undefined,
    });
    expect(open).toHaveBeenCalledTimes(1);
    expect(fake.sql[0]).toMatch(
      /CREATE TABLE IF NOT EXISTS operations \(\s*op_id TEXT PRIMARY KEY NOT NULL,\s*body TEXT NOT NULL,\s*updated_at INTEGER NOT NULL/,
    );
    expect(UPSERT_SQL).toMatch(/^INSERT INTO operations .* ON CONFLICT\(op_id\) DO UPDATE SET/);
    expect(fake.rows.get('a')?.body).toBe('{"v":2}');
  });

  it('zeroes freed row bodies and truncates the WAL after every write (journal is in the backup)', async () => {
    expect(SCHEMA_SQL).toMatch(/PRAGMA secure_delete = ON;/);
    const fake = fakeDb();
    const store = createSqliteStore({ open: async () => fake.db });
    await store.upsert({ opId: 'a', body: '1' });
    await store.remove('a');
    expect(fake.sql.slice(1)).toEqual([UPSERT_SQL, CHECKPOINT_SQL, REMOVE_SQL, CHECKPOINT_SQL]);
    expect(CHECKPOINT_SQL).toBe('PRAGMA wal_checkpoint(TRUNCATE);');
  });

  it('a failed checkpoint never fails the committed write', async () => {
    const fake = fakeDb({ failCheckpoint: true });
    const store = createSqliteStore({ open: async () => fake.db });
    expect(await store.upsert({ opId: 'a', body: '1' })).toEqual({ ok: true, value: undefined });
    expect(await store.remove('a')).toEqual({ ok: true, value: undefined });
  });

  it('loads rows ordered by updated_at (strictly increasing even within one millisecond)', async () => {
    const fake = fakeDb();
    const store = createSqliteStore({ open: async () => fake.db, now: () => 5 });
    await store.upsert({ opId: 'z', body: '1' });
    await store.upsert({ opId: 'a', body: '2' });
    await store.upsert({ opId: 'z', body: '3' });
    expect(await store.loadAll()).toEqual({
      ok: true,
      value: [
        { opId: 'a', body: '2' },
        { opId: 'z', body: '3' },
      ],
    });
  });

  it('removes rows', async () => {
    const fake = fakeDb();
    const store = createSqliteStore({ open: async () => fake.db });
    await store.upsert({ opId: 'a', body: '1' });
    expect(await store.remove('a')).toEqual({ ok: true, value: undefined });
    expect(await store.loadAll()).toEqual({ ok: true, value: [] });
  });

  it('turns an open failure into a StoreError and retries the open on the next call', async () => {
    const fake = fakeDb();
    const open = jest
      .fn<Promise<JournalDb>, []>()
      .mockRejectedValueOnce(new Error('unable to open'))
      .mockResolvedValue(fake.db);
    const store = createSqliteStore({ open });
    expect(await store.loadAll()).toEqual({ ok: false, error: { kind: 'io' } });
    expect(await store.loadAll()).toEqual({ ok: true, value: [] });
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('closes and forgets a database whose schema step failed', async () => {
    const broken = fakeDb({ failExec: true });
    const store = createSqliteStore({ open: async () => broken.db });
    expect(await store.upsert({ opId: 'a', body: '1' })).toEqual({
      ok: false,
      error: { kind: 'io' },
    });
    expect(broken.isClosed()).toBe(true);
  });

  it('maps write failures to StoreError without throwing', async () => {
    const fake = fakeDb({ failRun: true });
    const store = createSqliteStore({ open: async () => fake.db });
    expect(await store.upsert({ opId: 'a', body: '1' })).toEqual({
      ok: false,
      error: { kind: 'io' },
    });
    expect(await store.remove('a')).toEqual({ ok: false, error: { kind: 'io' } });
  });

  it('opens imports.db by default', async () => {
    const { openDatabaseAsync } = jest.requireMock<{ openDatabaseAsync: jest.Mock }>('expo-sqlite');
    openDatabaseAsync.mockResolvedValue(fakeDb().db);
    await createSqliteStore().loadAll();
    expect(openDatabaseAsync).toHaveBeenCalledWith('imports.db');
  });
});
