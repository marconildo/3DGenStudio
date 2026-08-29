// Which SQL engine the app runs on, and the thin call surface storage.js uses.
//
// SQLite is the default and the only engine a desktop install ever sees: no
// server to run, no configuration, one file under data/. A shared deployment
// sets GENSTUDIO_DATABASE_URL and gets PostgreSQL instead, which is what makes
// a team's requests actually run in parallel — see db/postgres.js.
//
// The engine is chosen once, at startup, from the environment. There is no
// runtime switch and no per-request choice: a half-migrated process serving two
// engines is not a state worth being able to reach.
//
// storage.js calls these as free functions with the handle first — `run(db, sql,
// params)` — which is the shape its ~318 call sites were already written in.
// Each one just forwards to the driver that produced the handle.
import process from 'node:process';

export function databaseUrl() {
  const raw = process.env.GENSTUDIO_DATABASE_URL;
  return raw && raw.trim() ? raw.trim() : null;
}

export function selectedDialect() {
  return databaseUrl() ? 'postgres' : 'sqlite';
}

// Both drivers are imported dynamically so only the selected one is ever loaded.
// That is what keeps the native sqlite3 binding out of a PostgreSQL deployment,
// and `pg` out of a desktop install. NOTE for packaging: tools/check-packaged-
// modules.mjs follows dynamic imports as well as static ones, so both files are
// still required to appear in the Dockerfile, .dockerignore and
// electron-builder.yml allowlists.
export async function openDatabase({ file, poolMax } = {}) {
  if (databaseUrl()) {
    const driver = await import('./postgres.js');
    return driver.open({ url: databaseUrl(), max: poolMax ?? poolSize() });
  }

  const driver = await import('./sqlite.js');
  const handle = await driver.open({ file });
  await driver.applyPragmas(handle);
  return handle;
}

function poolSize() {
  const parsed = Number(process.env.GENSTUDIO_DB_POOL_MAX);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10;
}

export const run = (db, sql, params = []) => db.run(sql, params);
export const get = (db, sql, params = []) => db.get(sql, params);
export const all = (db, sql, params = []) => db.all(sql, params);
export const exec = (db, sql) => db.exec(sql);
export const closeDatabase = db => db.close();
export const tableExists = (db, tableName) => db.tableExists(tableName);
export const columnExists = (db, tableName, columnName) => db.columnExists(tableName, columnName);

// Runs fn inside a transaction, handing it a handle to use in place of the outer
// one. On PostgreSQL that handle owns a pooled client for the duration, because
// BEGIN on the pool would start a transaction on one connection and run the body
// on others. On SQLite there is only ever one connection, so it is the same
// handle back. Callers must use the handle they are given, not close over the
// outer one.
export const withTransaction = (db, fn) => db.withTransaction(fn);

// Runs fn with exclusive access to one logical key, inside a transaction.
//
// This is what the position allocators need. They read MAX(position) + 1 and
// then insert against a UNIQUE constraint, and retrying a conflict is not enough
// on its own: with twenty callers, every retry re-reads the same maximum and
// collides again, so the conflict rate climbs with the number of callers instead
// of settling. Taking turns per column is what actually converges.
//
// On PostgreSQL this is a transaction-scoped advisory lock; on SQLite it is
// already true of every statement and only the transaction is added. The key is
// a plain string — use one that names the contended resource, e.g.
// `card:<projectId>:<columnId>`.
export const withKeyLock = (db, key, fn) => db.withKeyLock(key, fn);

// True for the "someone else inserted the same key first" error, in whichever
// dialect raised it.
//
// This matters more than it looks. Under SQLite every query in the process
// shares one connection, so a read-then-insert pair — pick MAX(position) + 1,
// then insert — could never interleave with another request. A pool removes that
// accidental protection, so the position allocators genuinely have to retry now.
export function isUniqueViolation(err) {
  if (!err) return false;
  if (err.code === '23505') return true; // PostgreSQL unique_violation
  return (
    typeof err.code === 'string' &&
    err.code.startsWith('SQLITE_CONSTRAINT') &&
    /UNIQUE|PRIMARY KEY/i.test(String(err.message ?? ''))
  );
}
