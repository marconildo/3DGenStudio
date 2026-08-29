// PostgreSQL driver — the shared-server engine.
//
// storage.js is not aware this exists. Its ~318 call sites keep their SQLite
// spelling (`?` placeholders, `result.lastID`, camelCase row keys) and this
// module translates in both directions. Three translations, and nothing else:
//
//   1. `?` -> `$1, $2, ...`   Postgres uses numbered placeholders.
//   2. `result.lastID`        Postgres has no such concept; RETURNING id does it.
//   3. row keys               Postgres folds identifiers to lower case, so every
//                             row comes back keyed `filepath` rather than
//                             `filePath`. See db/names.js for why that matters.
//
// Everything else in storage.js is already portable: all 9 upserts use the
// `ON CONFLICT ... DO UPDATE SET x = excluded.x` form Postgres itself defines,
// timestamps are plain integers rather than date functions, and there is no
// json1, no FTS and no RETURNING anywhere in the original queries.
import pg from 'pg';
import { CANONICAL_KEYS, TABLES_WITH_ID } from './names.js';
import { reportSlowQuery } from './slowlog.js';

export const dialect = 'postgres';

// node-postgres hands back BIGINT (int8) as a *string*, because an int8 can
// exceed Number.MAX_SAFE_INTEGER. Every int8 in this schema is either a row id
// or a Date.now() millisecond stamp — 1.8e12, four orders of magnitude below the
// safe limit — and storage.js compares and arithmetics them as numbers
// throughout. Left as strings, `createdAt` would sort lexicographically and
// every id equality check against a JS number would quietly fail.
pg.types.setTypeParser(pg.types.builtins.INT8, value => (value === null ? null : Number(value)));

// Rewrite `?` placeholders into `$n`, skipping anything inside a string literal
// or a comment. There is no `?` inside any SQL literal in storage.js today, so a
// naive global replace would work — but a single future `LIKE '%?%'` would
// corrupt silently, and that is not a bug worth leaving available.
export function toPositional(sql) {
  let out = '';
  let index = 0;
  let placeholder = 0;
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;

  while (index < sql.length) {
    const ch = sql[index];
    const next = sql[index + 1];

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      out += ch;
      index += 1;
      continue;
    }

    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        out += '*/';
        index += 2;
        continue;
      }
      out += ch;
      index += 1;
      continue;
    }

    if (inString) {
      // '' is an escaped quote inside a literal, not the end of one.
      if (ch === "'" && next === "'") {
        out += "''";
        index += 2;
        continue;
      }
      if (ch === "'") inString = false;
      out += ch;
      index += 1;
      continue;
    }

    if (ch === "'") {
      inString = true;
      out += ch;
      index += 1;
      continue;
    }

    if (ch === '-' && next === '-') {
      inLineComment = true;
      out += '--';
      index += 2;
      continue;
    }

    if (ch === '/' && next === '*') {
      inBlockComment = true;
      out += '/*';
      index += 2;
      continue;
    }

    if (ch === '?') {
      placeholder += 1;
      out += `$${placeholder}`;
      index += 1;
      continue;
    }

    out += ch;
    index += 1;
  }

  return out;
}

// Rename lower-case keys back to the camelCase storage.js reads. Driven off
// result.fields so the map is computed once per statement rather than per row,
// and skipped entirely when nothing in the result needs renaming.
function canonicalizeRows(result) {
  const fields = result.fields ?? [];
  if (!fields.some(field => CANONICAL_KEYS[field.name])) return result.rows;

  return result.rows.map(row => {
    const out = {};
    for (const field of fields) {
      out[CANONICAL_KEYS[field.name] ?? field.name] = row[field.name];
    }
    return out;
  });
}

// A stable signed 64-bit-safe integer for pg_advisory_xact_lock, which takes a
// bigint. FNV-1a over the key, kept inside 32 bits: collisions only ever cause
// two unrelated keys to take turns, which is a performance detail rather than a
// correctness one.
function advisoryKey(key) {
  let hash = 0x811c9dc5;
  const text = String(key);
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash | 0;
}

const INSERT_TARGET = /^\s*INSERT\s+INTO\s+"?([A-Za-z_]\w*)"?/i;

// node-sqlite3 reports the new row id on every run(); Postgres only reports it
// if asked. Appending RETURNING id to a join table keyed (cardId, assetId) is a
// hard error rather than a no-op, so the table has to actually have an id —
// hence TABLES_WITH_ID, generated from the schema rather than guessed.
function withReturningId(sql) {
  const match = sql.match(INSERT_TARGET);
  if (!match) return { sql, returnsId: false };
  if (/\bRETURNING\b/i.test(sql)) return { sql, returnsId: true };
  if (!TABLES_WITH_ID.has(match[1].toLowerCase())) return { sql, returnsId: false };
  return { sql: `${sql.replace(/;\s*$/, '')} RETURNING id`, returnsId: true };
}

function makeHandle(execute, { pool = null } = {}) {
  const handle = {
    dialect,
    pool,

    async run(sql, params = []) {
      const startedAt = Date.now();
      const { sql: text, returnsId } = withReturningId(sql);
      const result = await execute(toPositional(text), params);
      reportSlowQuery(sql, startedAt);
      return {
        // Null rather than undefined when an ON CONFLICT DO NOTHING inserted
        // nothing: there genuinely is no new row, and SQLite's habit of
        // returning the *previous* lastID there is not worth reproducing.
        lastID: returnsId ? (result.rows[0]?.id ?? null) : null,
        changes: result.rowCount ?? 0
      };
    },

    async get(sql, params = []) {
      const startedAt = Date.now();
      const result = await execute(toPositional(sql), params);
      reportSlowQuery(sql, startedAt);
      return canonicalizeRows(result)[0] ?? null;
    },

    async all(sql, params = []) {
      const startedAt = Date.now();
      const result = await execute(toPositional(sql), params);
      reportSlowQuery(sql, startedAt);
      return canonicalizeRows(result);
    },

    // No parameters, deliberately: node-postgres only allows several statements
    // in one round trip over the simple query protocol, which it uses when no
    // values are passed. The schema block relies on that.
    async exec(sql) {
      await execute(sql);
    },

    async tableExists(tableName) {
      const row = await handle.get(
        `SELECT table_name
         FROM information_schema.tables
         WHERE table_schema = current_schema() AND table_name = lower(?)`,
        [tableName]
      );
      return Boolean(row);
    },

    async columnExists(tableName, columnName) {
      const row = await handle.get(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = lower(?)
           AND column_name = lower(?)`,
        [tableName, columnName]
      );
      return Boolean(row);
    },

    // Serialises everything that allocates a position for the same card or
    // column. Retrying a unique violation is not enough on its own: twenty
    // requests all reading MAX(position) + 1 at once keep colliding on the
    // re-read, so the conflict rate grows with the number of callers rather than
    // settling. An advisory lock makes the allocation take turns instead.
    //
    // pg_advisory_xact_lock is released by COMMIT or ROLLBACK, so there is no
    // unlock to leak if the body throws. The key is a hash, so an unlucky
    // collision between two different keys costs a little serialisation and
    // nothing else.
    async withKeyLock(key, fn) {
      // The ::bigint cast is required, not decorative: pg_advisory_xact_lock is
      // overloaded on (bigint) and (int, int), so an untyped parameter is
      // ambiguous and Postgres refuses with "could not determine data type".
      const acquire = tx => tx.run('SELECT pg_advisory_xact_lock(?::bigint)', [advisoryKey(key)]);

      // Already inside a transaction: this handle owns its client, so take the
      // lock on it directly. Opening another transaction would be a no-op and
      // would silently skip the lock.
      if (!pool) {
        await acquire(handle);
        return fn(handle);
      }

      return handle.withTransaction(async tx => {
        await acquire(tx);
        return fn(tx);
      });
    },

    async withTransaction(fn) {
      if (!pool) {
        // Already inside one: this handle is bound to a checked-out client, so
        // BEGIN here would open a nested transaction Postgres does not have.
        return fn(handle);
      }

      // A pooled handle spreads statements across connections, so BEGIN on the
      // pool would start a transaction on one connection and run the body on
      // others. The transaction has to own a client for its whole life.
      const client = await pool.connect();
      const scoped = makeHandle((text, params) => client.query(text, params));
      try {
        await client.query('BEGIN');
        const result = await fn(scoped);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        // The original error is what the caller needs, so a failing rollback is
        // logged rather than thrown — but it is never silent: it means this
        // client is going back to the pool in a state worth knowing about.
        await client.query('ROLLBACK').catch(rollbackErr => {
          console.error('[db] rollback failed:', rollbackErr);
        });
        throw err;
      } finally {
        client.release();
      }
    },

    async close() {
      if (pool) await pool.end();
    }
  };

  return handle;
}

export async function open({ url, max }) {
  const pool = new pg.Pool({
    connectionString: url,
    max: max ?? 10,
    // A connection that cannot be had is a real failure the caller should see,
    // not something to hang a request on indefinitely.
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000
  });

  // An idle client erroring (server restart, network drop) emits on the pool.
  // Without a listener that is an unhandled 'error' event, which takes the whole
  // process down — and the pool recovers from it perfectly well on its own.
  pool.on('error', err => {
    console.warn('[db] idle PostgreSQL client error:', err.message);
  });

  const handle = makeHandle((text, params) => pool.query(text, params), { pool });

  // Fail here rather than on the first request, so a bad URL or an unreachable
  // server is a startup error with a clear cause.
  await handle.get('SELECT 1');

  return handle;
}

// 23505 = unique_violation. Read-then-insert races that SQLite's single
// serialized connection used to make impossible are reachable once a pool runs
// requests genuinely in parallel; see the position allocators in storage.js.
export function isUniqueViolation(err) {
  return err?.code === '23505';
}
