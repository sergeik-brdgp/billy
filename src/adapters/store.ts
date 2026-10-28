// StorePort on expo-sqlite: one table, one atomic upsert per persist.
// The database is opened lazily on first use; an open failure is a StoreError (the core shows
// `storage_unavailable` and retries through `retryStorage`, which reaches a fresh open attempt).

import { openDatabaseAsync, type SQLiteBindParams } from 'expo-sqlite';

import { err, ok, type Result, type StoredRow, type StoreError, type StorePort } from '../core';

export const JOURNAL_DB_NAME = 'imports.db';

/** The subset of expo-sqlite's `SQLiteDatabase` used here. */
export interface JournalDb {
  execAsync(source: string): Promise<void>;
  runAsync(source: string, params: SQLiteBindParams): Promise<unknown>;
  getAllAsync<T>(source: string, params: SQLiteBindParams): Promise<T[]>;
  closeAsync(): Promise<void>;
}

// WAL + synchronous=FULL: a committed upsert survives a process kill and a power loss.
// secure_delete (per connection, so set on every open): overwritten / deleted row bodies are
// zeroed in the page instead of lingering in freed space — the journal file is in the backup and
// an earlier body may still hold the file name (before the server has the job) or, written by an
// older build, the report.
export const SCHEMA_SQL = `
PRAGMA secure_delete = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
CREATE TABLE IF NOT EXISTS operations (
  op_id TEXT PRIMARY KEY NOT NULL,
  body TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);`;

export const UPSERT_SQL =
  'INSERT INTO operations (op_id, body, updated_at) VALUES (?, ?, ?) ' +
  'ON CONFLICT(op_id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at';
export const LOAD_ALL_SQL = 'SELECT op_id, body FROM operations ORDER BY updated_at ASC, op_id ASC';
export const REMOVE_SQL = 'DELETE FROM operations WHERE op_id = ?';
/**
 * After every write: move the WAL into the database file and truncate the WAL to zero bytes, so
 * old page images (earlier bodies) do not stay in `imports.db-wal`. Best effort: a failure here
 * never fails the (already committed) write.
 */
export const CHECKPOINT_SQL = 'PRAGMA wal_checkpoint(TRUNCATE);';

export interface SqliteStoreDeps {
  /** Defaults to `openDatabaseAsync('imports.db')`. */
  readonly open?: () => Promise<JournalDb>;
  /** Defaults to `Date.now`. */
  readonly now?: () => number;
}

const ioError: StoreError = { kind: 'io' };

export function createSqliteStore(deps: SqliteStoreDeps = {}): StorePort {
  const open = deps.open ?? (() => openDatabaseAsync(JOURNAL_DB_NAME));
  const now = deps.now ?? Date.now;
  let pending: Promise<JournalDb> | null = null;
  let lastStamp = 0;

  /** Opens (once) and migrates; a failed attempt is forgotten so the next call retries. */
  function database(): Promise<JournalDb> {
    if (pending === null) {
      const attempt = (async () => {
        const db = await open();
        try {
          await db.execAsync(SCHEMA_SQL);
        } catch (error) {
          await db.closeAsync().catch(() => undefined);
          throw error;
        }
        return db;
      })();
      pending = attempt;
      attempt.catch(() => {
        if (pending === attempt) pending = null;
      });
    }
    return pending;
  }

  async function checkpoint(db: JournalDb): Promise<void> {
    try {
      await db.execAsync(CHECKPOINT_SQL);
    } catch {
      // Best effort (see CHECKPOINT_SQL); the next write checkpoints again.
    }
  }

  /** Strictly increasing write stamp (wall clock, bumped on ties / clock steps back). */
  function stamp(): number {
    lastStamp = Math.max(now(), lastStamp + 1);
    return lastStamp;
  }

  return {
    async loadAll(): Promise<Result<readonly StoredRow[], StoreError>> {
      try {
        const db = await database();
        const rows = await db.getAllAsync<{ op_id: unknown; body: unknown }>(LOAD_ALL_SQL, []);
        const out: StoredRow[] = [];
        for (const row of rows) {
          // A row of the wrong shape is skipped; the core logs undecodable bodies itself.
          if (typeof row.op_id === 'string' && typeof row.body === 'string') {
            out.push({ opId: row.op_id, body: row.body });
          }
        }
        return ok(out);
      } catch {
        return err(ioError);
      }
    },

    async upsert(row): Promise<Result<void, StoreError>> {
      try {
        const db = await database();
        await db.runAsync(UPSERT_SQL, [row.opId, row.body, stamp()]);
        await checkpoint(db);
        return ok(undefined);
      } catch {
        return err(ioError);
      }
    },

    async remove(opId): Promise<Result<void, StoreError>> {
      try {
        const db = await database();
        await db.runAsync(REMOVE_SQL, [opId]);
        await checkpoint(db);
        return ok(undefined);
      } catch {
        return err(ioError);
      }
    },
  };
}
