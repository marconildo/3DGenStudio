// Slow-query logging, shared by both drivers.
//
// On SQLite every query in the process shares one connection, so a single
// pathological statement delays everything queued behind it — which is exactly
// the symptom a shared server reports as "the app is slow". On PostgreSQL the
// pool hides that, which makes the log *more* useful, not less: it is the only
// thing that distinguishes a slow query from a saturated pool.
//
// Threshold in milliseconds; GENSTUDIO_SLOW_QUERY_MS=0 turns it off. It writes
// to stdout, which the desktop shell and run.bat/run.sh already pipe into the
// backend log that the Logs panel reads, so there is nothing extra to wire up.
import process from 'node:process';

export const SLOW_QUERY_MS = (() => {
  const raw = process.env.GENSTUDIO_SLOW_QUERY_MS;
  if (raw === undefined || raw === '') return 500;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
})();

export function reportSlowQuery(sql, startedAt) {
  if (!SLOW_QUERY_MS) return;
  const elapsed = Date.now() - startedAt;
  if (elapsed < SLOW_QUERY_MS) return;
  const oneLine = String(sql).replace(/\s+/g, ' ').trim().slice(0, 240);
  console.warn(`[db] slow query ${elapsed}ms: ${oneLine}`);
}
