// A PostgreSQL server that 3D Gen Studio installs and runs itself.
//
// WHY
// ---
// A team needs PostgreSQL, because SQLite funnels every request through one
// writer. Docker Compose already provides that with nothing to install (see
// docker-compose.yml), but the other documented way to run a shared server is
// bare metal — `run_server.bat`, or the Windows Server + NSSM route in the wiki.
// This is that path: the app downloads a pinned PostgreSQL build, creates its
// own cluster under the data directory, and runs it as a child process for as
// long as the server is up. Nothing to install, nothing to administer.
//
// It follows the same shape as the managed ComfyUI install in
// electron/comfysetup.cjs: pinned prebuilt binaries over plain HTTPS, extracted
// in pure Node, with a tag-based readiness marker so an unchanged install
// short-circuits. Unlike that one this is a plain Node module, not an Electron
// one — the bare-metal server has no Electron process to ask.
//
// PLATFORMS
// ---------
// Windows and macOS only. EnterpriseDB publishes self-contained binary archives
// for both; it does not for Linux, and the alternatives ship their payload as
// .txz, which Node cannot decompress without pulling in an xz dependency for a
// feature most installs never use. On Linux the answer is Docker Compose, or the
// distribution's own postgresql package — isAvailableHere() reports which, and
// the caller is expected to say so rather than fail obscurely.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import zlib from 'node:zlib';

// Bumped only when the STEPS change, so an existing install is not re-provisioned
// for a comment. A different PostgreSQL version changes the marker on its own,
// because the version is part of it.
const SETUP_TAG = 'pgembedded-1';

// Pinned. An install that silently follows "latest" is an install that changes
// under a running deployment.
const PG_VERSION = '17.6-1';

const BUILDS = {
  win32: {
    url: `https://get.enterprisedb.com/postgresql/postgresql-${PG_VERSION}-windows-x64-binaries.zip`,
    exe: '.exe'
  },
  darwin: {
    url: `https://get.enterprisedb.com/postgresql/postgresql-${PG_VERSION}-osx-binaries.zip`,
    exe: ''
  }
};

export function isAvailableHere() {
  return Boolean(BUILDS[process.platform]);
}

export function unavailableReason() {
  if (isAvailableHere()) return null;
  return (
    `A self-contained PostgreSQL build is not available for ${process.platform}.\n` +
    '   Use Docker Compose (docker-compose.yml brings its own database), or install\n' +
    '   PostgreSQL from your package manager and point GENSTUDIO_DATABASE_URL at it.'
  );
}

// --------------------------------------------------------------------------
// Download
// --------------------------------------------------------------------------

// Streams to <target>.part and renames on success, so an interrupted download
// can never be mistaken for a complete one — and a retry cannot append to it.
function download(url, target, onProgress, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) {
      reject(new Error(`Too many redirects fetching ${url}`));
      return;
    }

    https.get(url, { headers: { 'User-Agent': '3DGenStudio' } }, response => {
      const { statusCode, headers } = response;

      if (statusCode >= 300 && statusCode < 400 && headers.location) {
        response.resume();
        resolve(download(new URL(headers.location, url).toString(), target, onProgress, redirects + 1));
        return;
      }

      if (statusCode !== 200) {
        response.resume();
        reject(new Error(`HTTP ${statusCode} fetching ${url}`));
        return;
      }

      const total = Number(headers['content-length']) || 0;
      let received = 0;
      let lastReported = 0;

      const partial = `${target}.part`;
      const file = createWriteStream(partial);

      response.on('data', chunk => {
        received += chunk.length;
        // Roughly every 5%, so a 300 MB download reports progress without
        // flooding the log.
        if (total && received - lastReported > total / 20) {
          lastReported = received;
          onProgress?.(Math.round((received / total) * 100));
        }
      });

      response.pipe(file);
      file.on('error', reject);
      file.on('finish', () => {
        file.close(async err => {
          if (err) {
            reject(err);
            return;
          }
          try {
            await fs.rename(partial, target);
            resolve();
          } catch (renameErr) {
            reject(renameErr);
          }
        });
      });
    }).on('error', reject);
  });
}

// --------------------------------------------------------------------------
// ZIP extraction, in pure Node
// --------------------------------------------------------------------------
//
// zlib gives us raw DEFLATE, which is all a ZIP entry actually needs; the rest
// is header parsing. Reading the central directory rather than walking local
// headers is what makes the file modes available — Unix permissions live in the
// external attributes, and on macOS an extracted `postgres` without its execute
// bit is a very confusing failure.

const EOCD_SIGNATURE = 0x06054b50;
const EOCD64_LOCATOR_SIGNATURE = 0x07064b50;
const EOCD64_SIGNATURE = 0x06064b50;
const CENTRAL_SIGNATURE = 0x02014b50;

function findEndOfCentralDirectory(buffer) {
  // The comment field is variable-length, so the record has to be searched for
  // from the end. 64 KB is its maximum size.
  const start = Math.max(0, buffer.length - 0x10000 - 22);
  for (let i = buffer.length - 22; i >= start; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  throw new Error('Not a ZIP archive: no end-of-central-directory record');
}

function readCentralDirectory(buffer) {
  const eocd = findEndOfCentralDirectory(buffer);
  let entryCount = buffer.readUInt16LE(eocd + 10);
  let directoryOffset = buffer.readUInt32LE(eocd + 16);

  // ZIP64: the 32-bit fields saturate and the real values live in a separate
  // record. Only reachable for very large archives, but silently truncating
  // there would be worse than the few lines it takes to handle.
  if (entryCount === 0xffff || directoryOffset === 0xffffffff) {
    const locator = eocd - 20;
    if (locator >= 0 && buffer.readUInt32LE(locator) === EOCD64_LOCATOR_SIGNATURE) {
      const eocd64 = Number(buffer.readBigUInt64LE(locator + 8));
      if (buffer.readUInt32LE(eocd64) !== EOCD64_SIGNATURE) {
        throw new Error('Corrupt ZIP: bad ZIP64 end-of-central-directory record');
      }
      entryCount = Number(buffer.readBigUInt64LE(eocd64 + 32));
      directoryOffset = Number(buffer.readBigUInt64LE(eocd64 + 48));
    }
  }

  const entries = [];
  let offset = directoryOffset;

  for (let i = 0; i < entryCount; i += 1) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new Error(`Corrupt ZIP: bad central directory entry at ${offset}`);
    }

    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const externalAttributes = buffer.readUInt32LE(offset + 38);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);

    entries.push({
      name,
      method,
      compressedSize,
      localHeaderOffset,
      // High 16 bits are the Unix mode when the archive was made on Unix.
      mode: (externalAttributes >>> 16) & 0xfff
    });

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

function readEntryData(buffer, entry) {
  const header = entry.localHeaderOffset;
  // The local header repeats the name and extra fields, and its extra field
  // length often differs from the central one — so it must be read from here,
  // not assumed.
  const nameLength = buffer.readUInt16LE(header + 26);
  const extraLength = buffer.readUInt16LE(header + 28);
  const start = header + 30 + nameLength + extraLength;
  const raw = buffer.subarray(start, start + entry.compressedSize);

  if (entry.method === 0) return raw;                    // stored
  if (entry.method === 8) return zlib.inflateRawSync(raw); // deflate
  throw new Error(`Unsupported ZIP compression method ${entry.method} for ${entry.name}`);
}

async function extractZip(archivePath, targetDir, { strip = 0 } = {}) {
  const buffer = await fs.readFile(archivePath);
  const entries = readCentralDirectory(buffer);

  for (const entry of entries) {
    const parts = entry.name.split('/').slice(strip);
    if (!parts.length || parts[parts.length - 1] === '') {
      // A directory entry, or one entirely consumed by the strip.
      if (parts.length) await fs.mkdir(path.join(targetDir, ...parts), { recursive: true });
      continue;
    }

    // Never let an archive write outside the target. A malicious or malformed
    // entry is the classic way an extractor becomes an arbitrary file write.
    const destination = path.resolve(targetDir, ...parts);
    if (destination !== targetDir && !destination.startsWith(targetDir + path.sep)) {
      throw new Error(`Refusing to extract outside the target: ${entry.name}`);
    }

    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, readEntryData(buffer, entry));

    // Executables need their bit back on macOS. Windows ignores the mode.
    if (entry.mode && process.platform !== 'win32') {
      await fs.chmod(destination, entry.mode).catch(() => {});
    }
  }
}

// --------------------------------------------------------------------------
// Install
// --------------------------------------------------------------------------

const exists = async (target) => fs.access(target).then(() => true).catch(() => false);

function markerPath(installDir) {
  return path.join(installDir, '.genstudio-pg');
}

async function isInstalled(installDir) {
  const marker = await fs.readFile(markerPath(installDir), 'utf8').catch(() => '');
  if (!marker.startsWith(`${SETUP_TAG}:${PG_VERSION}`)) return false;
  // Trust the marker only as far as the binary it claims is there.
  return exists(binary(installDir, 'postgres'));
}

function binary(installDir, name) {
  const build = BUILDS[process.platform];
  return path.join(installDir, 'bin', `${name}${build?.exe ?? ''}`);
}

export async function install(installDir, cacheDir, onStatus = () => {}) {
  if (!isAvailableHere()) throw new Error(unavailableReason());
  if (await isInstalled(installDir)) return;

  const build = BUILDS[process.platform];
  await fs.mkdir(cacheDir, { recursive: true });
  const archive = path.join(cacheDir, path.basename(new URL(build.url).pathname));

  if (!(await exists(archive))) {
    onStatus(`Downloading PostgreSQL ${PG_VERSION} (about 330 MB, once)`);
    await download(build.url, archive, percent => onStatus(`Downloading PostgreSQL — ${percent}%`));
  }

  // Extract to a scratch directory and swap it in, so an interrupted extraction
  // never leaves a half-populated install that the marker check would have to
  // guess about.
  const staging = `${installDir}.incoming`;
  await fs.rm(staging, { recursive: true, force: true });
  await fs.mkdir(staging, { recursive: true });

  onStatus('Extracting PostgreSQL');
  // Both archives contain a single top-level pgsql/ directory.
  await extractZip(archive, staging, { strip: 1 });

  await fs.rm(installDir, { recursive: true, force: true });
  await fs.rename(staging, installDir);

  if (!(await exists(binary(installDir, 'postgres')))) {
    throw new Error('PostgreSQL extracted but bin/postgres is missing — the archive layout changed');
  }

  await fs.writeFile(markerPath(installDir), `${SETUP_TAG}:${PG_VERSION}:${new Date().toISOString()}\n`);
  onStatus('PostgreSQL installed');
}

// --------------------------------------------------------------------------
// Cluster
// --------------------------------------------------------------------------

function runTool(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) resolve(output);
      else reject(new Error(`${path.basename(command)} exited ${code}:\n${output.trim()}`));
    });
  });
}

const CREDENTIALS_FILE = 'pg-credentials.json';

async function loadOrCreateCredentials(dataRoot) {
  const file = path.join(dataRoot, CREDENTIALS_FILE);
  const existing = await fs.readFile(file, 'utf8').then(JSON.parse).catch(() => null);
  if (existing?.password) return existing;

  const credentials = {
    user: 'genstudio',
    database: 'genstudio',
    // Generated per install. The cluster only ever listens on loopback, but a
    // shared default password would still be a shared default password.
    password: crypto.randomBytes(24).toString('base64url')
  };
  await fs.writeFile(file, JSON.stringify(credentials, null, 2), { mode: 0o600 });
  return credentials;
}

async function initCluster(installDir, clusterDir, credentials, onStatus) {
  if (await exists(path.join(clusterDir, 'PG_VERSION'))) return;

  onStatus('Creating the PostgreSQL cluster');
  await fs.mkdir(path.dirname(clusterDir), { recursive: true });

  // initdb reads the superuser password from a file rather than an argument, so
  // it never appears in the process list.
  const passwordFile = path.join(os.tmpdir(), `genstudio-pgpw-${crypto.randomBytes(8).toString('hex')}`);
  await fs.writeFile(passwordFile, credentials.password, { mode: 0o600 });

  try {
    await runTool(binary(installDir, 'initdb'), [
      '-D', clusterDir,
      '-U', credentials.user,
      '--auth-local=scram-sha-256',
      '--auth-host=scram-sha-256',
      '--pwfile', passwordFile,
      '--encoding=UTF8',
      // Locale-independent, so the cluster behaves the same on every machine it
      // is created on. Collation only affects ORDER BY on text, and storage.js
      // sorts by lower(login) and by numeric columns.
      '--locale=C'
    ]);
  } finally {
    await fs.rm(passwordFile, { force: true });
  }
}

async function pickFreePort(preferred) {
  const tryPort = port => new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });

  for (let port = preferred; port < preferred + 50; port += 1) {
    if (await tryPort(port)) return port;
  }
  throw new Error(`No free port for the embedded PostgreSQL near ${preferred}`);
}

function buildUrl(credentials, port) {
  return (
    `postgres://${credentials.user}:${encodeURIComponent(credentials.password)}` +
    `@127.0.0.1:${port}/${credentials.database}`
  );
}

// Returns the port of a cluster that is already up, or null. pg_ctl status exits
// non-zero when nothing is running, which is the check — the port then comes from
// postmaster.pid, whose fourth line is the port PostgreSQL actually bound.
async function adoptRunningCluster(installDir, clusterDir) {
  const alive = await runTool(binary(installDir, 'pg_ctl'), ['-D', clusterDir, 'status'])
    .then(() => true)
    .catch(() => false);
  if (!alive) return null;

  const pidFile = await fs.readFile(path.join(clusterDir, 'postmaster.pid'), 'utf8').catch(() => '');
  const port = Number(pidFile.split('\n')[3]?.trim());
  return Number.isFinite(port) && port > 0 ? port : null;
}

let running = null;

/**
 * Installs if needed, starts the server, and returns a connection URL.
 * Safe to call more than once: the second call returns the running instance.
 */
export async function start({ dataRoot, port = 55432, onStatus = () => {} } = {}) {
  if (running) return running.url;
  if (!isAvailableHere()) throw new Error(unavailableReason());

  const installDir = path.join(dataRoot, 'pgsql');
  const clusterDir = path.join(dataRoot, 'pgdata');
  const cacheDir = path.join(dataRoot, 'cache', 'downloads');

  await install(installDir, cacheDir, onStatus);
  const credentials = await loadOrCreateCredentials(dataRoot);
  await initCluster(installDir, clusterDir, credentials, onStatus);

  // A cluster left running by a previous process — the app was killed rather
  // than shut down, so pg_ctl never got its stop. Starting a second server on
  // the same directory is refused by PostgreSQL anyway; adopting the live one is
  // both correct and what the user expects, and its port is recorded in
  // postmaster.pid (line 4).
  const adopted = await adoptRunningCluster(installDir, clusterDir);
  if (adopted) {
    onStatus(`Reusing the PostgreSQL already running on 127.0.0.1:${adopted}`);
    const reusedUrl = buildUrl(credentials, adopted);
    running = { installDir, clusterDir, port: adopted, url: reusedUrl, adopted: true };
    return reusedUrl;
  }

  const chosenPort = await pickFreePort(port);
  onStatus(`Starting PostgreSQL on 127.0.0.1:${chosenPort}`);

  // pg_ctl rather than spawning postgres directly: it waits for the server to
  // actually accept connections and reports a real error if it does not, which
  // a bare spawn would leave us to guess at.
  const logFile = path.join(dataRoot, 'logs', 'postgres.log');
  await fs.mkdir(path.dirname(logFile), { recursive: true });

  await runTool(binary(installDir, 'pg_ctl'), [
    '-D', clusterDir,
    '-l', logFile,
    // listen_addresses is pinned to loopback: this database exists for the
    // app on this machine, and nothing else should be able to reach it.
    '-o', `-p ${chosenPort} -c listen_addresses=127.0.0.1`,
    '-w',
    '-t', '60',
    'start'
  ]);

  // createdb is idempotent only in the sense that a second call errors; the
  // catch is deliberate and narrow.
  await runTool(binary(installDir, 'createdb'), [
    '-h', '127.0.0.1', '-p', String(chosenPort), '-U', credentials.user, credentials.database
  ], { env: { ...process.env, PGPASSWORD: credentials.password } }).catch(err => {
    if (!/already exists/i.test(err.message)) throw err;
  });

  const url = buildUrl(credentials, chosenPort);

  running = { installDir, clusterDir, port: chosenPort, url, adopted: false };
  onStatus(`PostgreSQL ready on 127.0.0.1:${chosenPort}`);
  return url;
}

/** Stops the server. A no-op if it was never started. */
export async function stop() {
  if (!running) return;
  const { installDir, clusterDir } = running;
  running = null;
  // -m fast: roll back open transactions and shut down now, rather than waiting
  // for clients that are never coming back.
  await runTool(binary(installDir, 'pg_ctl'), ['-D', clusterDir, '-m', 'fast', '-w', '-t', '30', 'stop'])
    .catch(err => console.warn('[pg] shutdown failed:', err.message));
}

export function isRunning() {
  return Boolean(running);
}
