// Retry spool for compute results that could not reach the shared server.
//
// A generation can cost minutes of GPU time. If the server happens to be down
// when it finishes, throwing the bytes away is the one genuinely unacceptable
// failure in this system — far worse than a slow save. So a failed ingest is
// written to disk and retried until it lands.
//
// Deliberately narrow: only the result-upload path uses this. Reads are not
// queued (a caller needs the answer now) and neither are card processing
// snapshots (they are progress hints; a stale one is noise, not data loss).
import fsp from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';

const QUEUE_DIR = path.join(process.cwd(), 'data', 'pending-uploads');

// Backoff between sweeps. Long enough not to hammer a server that is down,
// short enough that a brief restart clears within a minute.
const RETRY_INTERVAL_MS = 30000;

// A job that keeps failing is almost certainly malformed rather than unlucky
// (a deleted parent asset, say). Park it instead of retrying forever.
const MAX_ATTEMPTS = 20;

let sweepTimer = null;
let sweeping = false;
let uploadFn = null;

function jobPath(id, extension = 'json') {
  return path.join(QUEUE_DIR, `${id}.${extension}`);
}

// Bytes live beside the descriptor rather than inside it: a base64 mesh in JSON
// would be a third larger and have to be parsed into memory to inspect.
export async function enqueueUpload(kind, payload, bytes, thumbnailBytes = null) {
  const id = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  await fsp.mkdir(QUEUE_DIR, { recursive: true });

  if (bytes?.length) await fsp.writeFile(jobPath(id, 'bin'), bytes);
  if (thumbnailBytes?.length) await fsp.writeFile(jobPath(id, 'thumb'), thumbnailBytes);

  const descriptor = {
    id,
    kind,
    payload,
    hasBytes: Boolean(bytes?.length),
    hasThumbnail: Boolean(thumbnailBytes?.length),
    attempts: 0,
    lastError: '',
    queuedAt: Date.now()
  };
  // Written last: a descriptor is the only thing the sweep looks for, so a
  // crash mid-write can never leave a job pointing at bytes that are not there.
  await fsp.writeFile(jobPath(id), `${JSON.stringify(descriptor, null, 2)}\n`, 'utf8');

  console.warn(`📥 Queued a ${kind} result for retry (${id}) — the shared server did not accept it`);
  return id;
}

async function readJob(file) {
  try {
    return JSON.parse(await fsp.readFile(path.join(QUEUE_DIR, file), 'utf8'));
  } catch {
    return null;
  }
}

async function discardJob(job) {
  for (const extension of ['json', 'bin', 'thumb']) {
    await fsp.rm(jobPath(job.id, extension), { force: true }).catch(() => {});
  }
}

async function attemptJob(job) {
  const bytes = job.hasBytes ? await fsp.readFile(jobPath(job.id, 'bin')) : null;
  const thumbnailBytes = job.hasThumbnail ? await fsp.readFile(jobPath(job.id, 'thumb')) : null;
  await uploadFn(job.kind, job.payload, bytes, thumbnailBytes);
}

// One pass over the spool. Stops at the first failure: if the server is down,
// every remaining job will fail the same way, and there is no point walking the
// whole queue to prove it.
async function sweep() {
  if (sweeping || !uploadFn || !existsSync(QUEUE_DIR)) return;
  sweeping = true;
  try {
    const files = (await fsp.readdir(QUEUE_DIR)).filter(f => f.endsWith('.json')).sort();
    for (const file of files) {
      const job = await readJob(file);
      if (!job) continue;
      if (job.attempts >= MAX_ATTEMPTS) continue;

      try {
        await attemptJob(job);
        await discardJob(job);
        console.log(`📤 Delivered a queued ${job.kind} result to the shared server (${job.id})`);
      } catch (err) {
        job.attempts += 1;
        job.lastError = err?.message || String(err);
        await fsp.writeFile(jobPath(job.id), `${JSON.stringify(job, null, 2)}\n`, 'utf8').catch(() => {});
        if (job.attempts >= MAX_ATTEMPTS) {
          console.error(`⚠️  Giving up on queued ${job.kind} result ${job.id} after ${MAX_ATTEMPTS} attempts: ${job.lastError}. The file is kept in data/pending-uploads.`);
          continue;
        }
        // Server still unavailable — leave the rest for the next sweep.
        break;
      }
    }
  } catch (err) {
    console.warn('Upload retry sweep failed:', err.message);
  } finally {
    sweeping = false;
  }
}

export function pendingUploadCount() {
  try {
    if (!existsSync(QUEUE_DIR)) return 0;
    // Sync on purpose: a status endpoint reads this, and the directory holds a
    // handful of entries at most.
    return readdirSync(QUEUE_DIR).filter(file => file.endsWith('.json')).length;
  } catch {
    return 0;
  }
}

export function startUploadQueue(upload) {
  uploadFn = upload;
  if (sweepTimer) return;
  sweepTimer = setInterval(sweep, RETRY_INTERVAL_MS);
  // Anything left from a previous run should go out as soon as the server is
  // reachable, not on the next interval.
  const firstSweep = setTimeout(sweep, 5000);
  // unref'd so the spool never by itself keeps the process alive: importing
  // this module must not stop `node script.js` from exiting, and the backend
  // must still shut down promptly.
  sweepTimer.unref?.();
  firstSweep.unref?.();
}

export function stopUploadQueue() {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
}
