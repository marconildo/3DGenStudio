// SQLite driver — the local desktop engine, and the default everywhere.
//
// This is the original node-sqlite3 code from storage.js, moved behind the
// driver interface in db/index.js and otherwise unchanged. Nothing about the
// single-user experience should differ: no server to install, no configuration,
// one file under data/.
//
// The module is only ever imported when SQLite is the selected engine (see
// db/index.js), which is what keeps the native sqlite3 binding off the
// PostgreSQL path entirely.
import sqlite3 from 'sqlite3';
import { reportSlowQuery } from './slowlog.js';

const sqlite = sqlite3.verbose();

export const dialect = 'sqlite';

function makeHandle(raw) {
  // Guards against a second BEGIN on the one connection this driver owns.
  let inTransaction = false;

  // key -> a promise that resolves when the current holder is done. See
  // withKeyLock below.
  const keyLocks = new Map();

  const handle = {
    dialect,
    raw,

    run(sql, params = []) {
      const startedAt = Date.now();
      return new Promise((resolve, reject) => {
        raw.run(sql, params, function onRun(err) {
          reportSlowQuery(sql, startedAt);
          if (err) {
            reject(err);
            return;
          }

          // `function` rather than an arrow specifically to reach these two:
          // node-sqlite3 exposes them on the statement, not the callback args.
          resolve({ lastID: this.lastID, changes: this.changes });
        });
      });
    },

    get(sql, params = []) {
      const startedAt = Date.now();
      return new Promise((resolve, reject) => {
        raw.get(sql, params, (err, row) => {
          reportSlowQuery(sql, startedAt);
          if (err) {
            reject(err);
            return;
          }

          resolve(row ?? null);
        });
      });
    },

    all(sql, params = []) {
      const startedAt = Date.now();
      return new Promise((resolve, reject) => {
        raw.all(sql, params, (err, rows) => {
          reportSlowQuery(sql, startedAt);
          if (err) {
            reject(err);
            return;
          }

          resolve(rows ?? []);
        });
      });
    },

    exec(sql) {
      return new Promise((resolve, reject) => {
        raw.exec(sql, err => (err ? reject(err) : resolve()));
      });
    },

    close() {
      return new Promise((resolve, reject) => {
        raw.close(err => (err ? reject(err) : resolve()));
      });
    },

    async tableExists(tableName) {
      const row = await handle.get(
        `SELECT name
         FROM sqlite_master
         WHERE type = 'table' AND name = ?`,
        [tableName]
      );

      return Boolean(row);
    },

    async columnExists(tableName, columnName) {
      // PRAGMA does not take a bound parameter for the table name. Every caller
      // passes a literal from this file's own schema, but the identifier check
      // keeps it that way rather than trusting that to stay true.
      if (!/^[A-Za-z_]\w*$/.test(tableName)) {
        throw new Error(`Unsafe table name: ${tableName}`);
      }
      const columns = await handle.all(`PRAGMA table_info(${tableName})`);
      return columns.some(column => column.name === columnName);
    },

    // One connection serialises individual STATEMENTS, but not a sequence of
    // them: two callers that each read MAX(position) and then insert can still
    // interleave at the await between the two, and both write the same position.
    // A shared connection was never the mutual exclusion it looked like.
    //
    // So this is a real in-process mutex, keyed the same way the PostgreSQL
    // advisory lock is. It deliberately does NOT open a transaction: with a
    // single connection, a transaction held across an await would swallow every
    // unrelated statement issued in the meantime.
    async withKeyLock(key, fn) {
      const previous = keyLocks.get(key) ?? Promise.resolve();

      let release;
      const held = new Promise(resolve => { release = resolve; });
      // The queue is the chain itself: each caller waits on the one before it.
      const mine = previous.then(() => held);
      keyLocks.set(key, mine);

      await previous;
      try {
        return await fn(handle);
      } finally {
        release();
        // Drop the entry only if nobody queued behind us, so the map does not
        // grow one entry per card for the life of the process.
        if (keyLocks.get(key) === mine) keyLocks.delete(key);
      }
    },

    // One connection, so a transaction is just BEGIN/COMMIT on the same handle —
    // there is nowhere else the statements could go. The callback still receives
    // a handle so callers read identically across both drivers.
    async withTransaction(fn) {
      // SQLite has no nested transactions: a second BEGIN is an error, not a
      // savepoint. Joining the open one matches what the PostgreSQL driver does
      // with an already-checked-out client.
      if (inTransaction) return fn(handle);

      inTransaction = true;
      await handle.exec('BEGIN');
      try {
        const result = await fn(handle);
        await handle.exec('COMMIT');
        return result;
      } catch (err) {
        // The original error is what the caller needs, so a failing rollback is
        // logged rather than thrown — but it is never silent: it means the
        // connection is in a state worth knowing about.
        await handle.exec('ROLLBACK').catch(rollbackErr => {
          console.error('[db] rollback failed:', rollbackErr);
        });
        throw err;
      } finally {
        inTransaction = false;
      }
    }
  };

  return handle;
}

export function open({ file }) {
  return new Promise((resolve, reject) => {
    const raw = new sqlite.Database(file, err => {
      if (err) {
        reject(err);
        return;
      }

      resolve(makeHandle(raw));
    });
  });
}

// Applied once per connection after open(). journal_mode is persisted in the
// file itself; the rest are per-connection and have to be re-applied every time.
export async function applyPragmas(handle) {
  await handle.exec('PRAGMA foreign_keys = ON');

  // WAL lets readers run concurrently with a writer, and busy_timeout makes a
  // contended write wait instead of failing outright.
  await handle.exec('PRAGMA journal_mode = WAL').catch(() => {});
  await handle.exec('PRAGMA busy_timeout = 5000').catch(() => {});
  await handle.exec('PRAGMA synchronous = NORMAL').catch(() => {});
}
