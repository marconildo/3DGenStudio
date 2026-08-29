// Gateway: makes a remote server look local.
//
// When a desktop install is pointed at a shared server, this middleware
// forwards the data routes there and serves asset bytes from a local disk
// cache. The frontend keeps talking to exactly one origin (its own backend), so
// src/config.js, ProjectContext.jsx and every asset-URL helper stay untouched —
// that is the whole reason for doing it here rather than teaching the browser
// about two origins.
//
// Compute stays local: ComfyUI, the Python sidecars and every third-party API
// key never leave the user's machine. serverMode.js owns the split.
import express from 'express';
import fsp from 'node:fs/promises';
import { readFileSync, existsSync, createWriteStream } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isRemoteDataPath } from './serverMode.js';

const DATA_DIR = path.join(process.cwd(), 'data');

// Kept in its own file rather than the Settings table: it is machine-local by
// definition, and it must be readable before anything touches the database.
// (data/machine-settings.json is a dead file from an earlier scheme — left
// alone so nobody mistakes its stale `apis` block for live configuration.)
const REMOTE_CONFIG_FILE = path.join(DATA_DIR, 'remote.json');

// Asset filenames are `<Date.now()>-<rand>.<ext>`, and thumbnails carry a
// randomUUID slice, so a stored file is never rewritten under the same name.
// That makes an unbounded cache safe: an entry can go stale-orphaned when an
// asset is deleted, but it can never serve the wrong bytes.
const ASSET_CACHE_DIR = path.join(DATA_DIR, 'cache', 'assets');

// Dropped when relaying in either direction. content-length/content-encoding
// are in here for a specific reason: undici's fetch transparently decompresses
// the upstream body, so passing the original encoding or length through would
// describe bytes the client is not actually receiving.
// 'expect' is here for a non-obvious reason: curl (and other clients) send
// `Expect: 100-continue` once a body exceeds ~1MB. Node's HTTP server already
// answers that handshake for us, and undici refuses to send the header on an
// outgoing request — relaying it turned every large upload into "fetch failed".
const STRIPPED_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'expect',
  'content-length', 'content-encoding'
]);

// `offlineFallback` is the answer to "the server is down, now what?".
//
// ON (default): a request that cannot reach the server is served from this
// machine's own database instead of failing. The connection is NOT forgotten —
// forwarding resumes by itself the moment the server answers again.
//
// OFF: data work blocks with a 503 until the server is back. Safer in one
// specific way, and it is worth being explicit about which: falling back shows
// this computer's local workspace, which is a DIFFERENT set of projects from the
// server's. Anything created while offline stays on this computer and does not
// appear on the server when it returns.
const EMPTY_REMOTE = { url: '', login: '', token: '', user: null, offlineFallback: true };

// Loaded at module scope, not only in mountGateway(): dataStore.js asks
// getRemoteTarget() where results belong, and it must get the right answer even
// in a process that never mounts the HTTP routes.
let remoteConfig = { ...EMPTY_REMOTE };

function readRemoteConfig() {
  try {
    if (!existsSync(REMOTE_CONFIG_FILE)) return { ...EMPTY_REMOTE };
    const parsed = JSON.parse(readFileSync(REMOTE_CONFIG_FILE, 'utf8'));
    return {
      url: String(parsed?.url || '').replace(/\/+$/, ''),
      login: String(parsed?.login || ''),
      token: String(parsed?.token || ''),
      // Cached from the sign-in response so the UI can show who you are and
      // what you may do without a round trip on every render.
      user: parsed?.user || null,
      // Absent in a file written before this option existed, which must read as
      // ON — that is the behaviour someone upgrading is asking for.
      offlineFallback: parsed?.offlineFallback !== false
    };
  } catch (err) {
    console.warn('Could not read the remote server configuration:', err.message);
    return { ...EMPTY_REMOTE };
  }
}

remoteConfig = readRemoteConfig();

async function writeRemoteConfig(next) {
  remoteConfig = next;
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.writeFile(REMOTE_CONFIG_FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}

export function isGatewayActive() {
  return Boolean(remoteConfig.url && remoteConfig.token);
}

// --------------------------------------------------------------------------
// Reachability
// --------------------------------------------------------------------------
//
// Without this, a server that is switched off costs every single request the
// operating system's TCP connect timeout — about 11 seconds on Windows. A page
// that issues a handful of requests then appears frozen for a minute, which
// reads as "the app is broken", not "the server is down". Measured before this
// existed: GET /api/projects took 10.7s to fail.
//
// So: one cheap TCP probe, cached, shared by everything. A request against a
// server known to be down fails (or falls back) in microseconds.

// Short enough that a down server is noticed almost immediately, long enough
// that a busy LAN server is not declared dead for a stutter.
const PROBE_TIMEOUT_MS = 2500;
// How long a probe result is trusted. Deliberately brief: this is what decides
// how quickly the app notices the server coming BACK.
const PROBE_TTL_MS = 3000;

let probeState = { at: 0, ok: true, inFlight: null };

function remoteHostPort() {
  try {
    const parsed = new URL(remoteConfig.url);
    return {
      host: parsed.hostname,
      port: Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80)
    };
  } catch {
    return null;
  }
}

function tcpProbe({ host, port }) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host, port });
    const settle = (ok) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.once('connect', () => settle(true));
    socket.once('timeout', () => settle(false));
    socket.once('error', () => settle(false));
  });
}

/**
 * Is the shared server accepting connections? Cached for PROBE_TTL_MS, and
 * concurrent callers share one probe rather than opening a socket each.
 */
export async function isRemoteReachable() {
  if (!remoteConfig.url) return false;

  const now = Date.now();
  if (now - probeState.at < PROBE_TTL_MS) return probeState.ok;
  if (probeState.inFlight) return probeState.inFlight;

  const target = remoteHostPort();
  if (!target) return false;

  probeState.inFlight = tcpProbe(target).then(ok => {
    const changed = ok !== probeState.ok;
    probeState = { at: Date.now(), ok, inFlight: null };
    if (changed) {
      console.log(ok
        ? `🔗 ${remoteConfig.url} is reachable again — resuming forwarding.`
        : `🔌 ${remoteConfig.url} is unreachable.${remoteConfig.offlineFallback
          ? ' Serving this computer\'s local data until it returns.'
          : ' Project and asset changes are paused.'}`);
    }
    return ok;
  });

  return probeState.inFlight;
}

// Called whenever a real request proves the server is up or down, so the state
// tracks reality without waiting for the next probe.
function noteReachability(ok) {
  probeState = { at: Date.now(), ok, inFlight: probeState.inFlight };
}

// Where compute results must be sent, or null when this install owns its data.
// dataStore.js is the only consumer: keeping the credentials here means there is
// exactly one place that knows how to talk to the shared server.
export function getRemoteTarget() {
  return isGatewayActive() ? { url: remoteConfig.url, token: remoteConfig.token } : null;
}

export function getRemoteStatus() {
  return {
    configured: Boolean(remoteConfig.url),
    connected: isGatewayActive(),
    url: remoteConfig.url,
    login: remoteConfig.login,
    user: remoteConfig.user || null,
    role: remoteConfig.user?.role || null,
    // Whether this session may write. The server enforces it regardless; this
    // is so the UI can say why an action is unavailable instead of letting the
    // user hit a 403.
    readOnly: isGatewayActive() && remoteConfig.user?.role === 'viewer',
    offlineFallback: remoteConfig.offlineFallback !== false,
    // Last known reachability rather than a fresh probe: this route is polled
    // every 15 seconds by every open window, and a socket per poll per window
    // is a lot of connections to answer a question the probe cache already has.
    // `reachable` is meaningless with no server configured, hence the null.
    reachable: remoteConfig.url ? probeState.ok : null
  };
}

function upstreamHeaders(req) {
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (STRIPPED_HEADERS.has(key.toLowerCase())) continue;
    headers[key] = value;
  }
  headers.authorization = `Bearer ${remoteConfig.token}`;
  // Tells the remote to mint RELATIVE asset URLs. Without this it would embed
  // its own origin in every response, which the browser cannot fetch: it has no
  // token, and the server may not even be routable from the user's network.
  headers['x-genstudio-gateway'] = '1';
  return headers;
}

function relayResponseHeaders(upstream, res) {
  res.status(upstream.status);
  upstream.headers.forEach((value, key) => {
    if (STRIPPED_HEADERS.has(key.toLowerCase())) return;
    res.setHeader(key, value);
  });
}

// The remote is down, unreachable, or the stored token expired. Say so plainly
// rather than failing as a generic 500 — data work is meant to block visibly.
// The server is known to be down and offlineFallback is off, so the user has
// asked to block rather than switch workspaces. No request was attempted.
function offline(res) {
  if (res.headersSent) return res.end();
  res.status(503).json({
    error: `The shared 3D Gen Studio server at ${remoteConfig.url} is unreachable. Local tools still work; project and asset changes are paused.`,
    remote: remoteConfig.url,
    offlineFallback: false
  });
}

function unreachable(res, err) {
  // undici collapses every transport failure into a bare "fetch failed", so the
  // cause chain is the only thing that says what actually happened.
  const cause = err?.cause ? ` (${err.cause.code || ''} ${err.cause.message || err.cause})`.trim() : '';
  console.warn(`Gateway request to ${remoteConfig.url} failed: ${err?.message || err}${cause}`);
  // A request that got as far as failing is better evidence than any probe, so
  // record it: everything queued behind this one then fails fast instead of
  // each paying the connect timeout over again.
  noteReachability(false);
  if (res.headersSent) return res.end();
  res.status(503).json({
    error: `The shared 3D Gen Studio server at ${remoteConfig.url} is unreachable. Local tools still work; project and asset changes are paused.`,
    detail: `${err?.message || String(err)}${cause}`,
    remote: remoteConfig.url
  });
}

async function forwardRequest(req, res) {
  const target = new URL(req.originalUrl, remoteConfig.url);
  const init = {
    method: req.method,
    headers: upstreamHeaders(req),
    redirect: 'manual'
  };

  // Bodies are streamed, never buffered — this middleware runs BEFORE
  // express.json() and multer precisely so a multi-hundred-megabyte mesh upload
  // passes straight through.
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    init.body = Readable.toWeb(req);
    init.duplex = 'half';
  }

  let upstream;
  try {
    upstream = await fetch(target, init);
  } catch (err) {
    return unreachable(res, err);
  }

  if (upstream.status === 401) {
    // The token is no longer good. Drop it so the UI can prompt for a fresh
    // login instead of every request failing opaquely. Deliberately NOT a
    // silent re-login: that would mean storing the user's password.
    await writeRemoteConfig({ ...remoteConfig, token: '' }).catch(() => {});
    return res.status(401).json({
      error: 'The shared server rejected this session. Sign in to it again from Settings.',
      remote: remoteConfig.url
    });
  }

  relayResponseHeaders(upstream, res);

  if (!upstream.body) {
    return res.end();
  }

  // SSE (/api/events) rides this path too: piping forwards each chunk as it
  // arrives, so the mutation stream stays live across the extra hop.
  res.flushHeaders?.();
  const source = Readable.fromWeb(upstream.body);
  // .pipe() does not forward source errors, and an unhandled 'error' here would
  // take the whole process down — the same trap pipeToolSse() documents.
  source.on('error', () => {
    if (!res.headersSent) res.status(502);
    res.end();
  });
  res.on('close', () => {
    if (!source.destroyed) source.destroy();
  });
  return source.pipe(res);
}

function cachePathFor(assetPath) {
  // assetPath is the URL path after /assets/, e.g. "images/1787-42.png".
  const decoded = decodeURIComponent(assetPath);
  const resolved = path.resolve(ASSET_CACHE_DIR, decoded);
  // Traversal guard: a crafted "../../" must not escape the cache directory.
  if (resolved !== ASSET_CACHE_DIR && !resolved.startsWith(ASSET_CACHE_DIR + path.sep)) {
    return null;
  }
  return resolved;
}

// Download an asset from the shared server and put it in the disk cache.
// Returns { cachePath, bytes, contentType }; cachePath is null when the bytes
// could not be cached (the caller still gets them).
//
// Shared by the browser-facing /assets route and by dataStore.readAssetBytes,
// so a mesh a pipeline re-reads several times is fetched over the network once.
async function downloadAssetToCache(relativePath) {
  const cachePath = cachePathFor(relativePath);
  if (!cachePath) throw new Error('Invalid asset path');

  const upstream = await fetch(new URL(`/assets/${encodeURI(relativePath)}`, remoteConfig.url), {
    headers: {
      authorization: `Bearer ${remoteConfig.token}`,
      'x-genstudio-gateway': '1'
    }
  });

  if (!upstream.ok) {
    const error = new Error(`The shared server returned ${upstream.status} for ${relativePath}`);
    error.status = upstream.status;
    throw error;
  }

  const bytes = Buffer.from(await upstream.arrayBuffer());
  const contentType = upstream.headers.get('content-type');

  try {
    await fsp.mkdir(path.dirname(cachePath), { recursive: true });
    // Write to a sibling then rename, so a concurrent reader never sees a
    // half-written file: two requests for the same cold asset are common.
    const partial = `${cachePath}.part-${process.pid}-${Date.now()}`;
    await fsp.writeFile(partial, bytes);
    await fsp.rename(partial, cachePath);
    return { cachePath, bytes, contentType };
  } catch (err) {
    // A cache failure must not fail the read — hand back the bytes we have.
    console.warn('Could not cache asset locally:', err.message);
    return { cachePath: null, bytes, contentType };
  }
}

// Drop one entry, so the next read fetches the file from the shared server
// again.
//
// The unbounded cache above is safe only while a stored file is never rewritten
// under the same name — and there is one deliberate exception: the Mesh Editor's
// "Save mesh" overwrites the source .glb IN PLACE so the asset keeps its id,
// path and every link to it (see /api/meshes/editor/save). Without this call the
// cached copy from before the save wins forever, and the viewport, the thumbnail
// refresh and the mesh service all keep reading the pre-save mesh — which looks
// exactly like the save having done nothing. "Save as version" writes a new
// filename, which is why it never showed the problem.
//
// Takes either form of the path: "data/assets/meshes/x.glb" or "meshes/x.glb".
export async function invalidateCachedAsset(assetPath) {
  const relative = String(assetPath || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/^(?:data\/)?assets\//, '');
  if (!relative) return;

  const cachePath = cachePathFor(relative);
  if (!cachePath) return;

  await fsp.rm(cachePath, { force: true }).catch(() => {});
}

// Asset bytes for a *stored* path ("data/assets/images/x.png"), served from the
// local cache when possible. Used by compute paths, which need the buffer
// itself rather than an HTTP response.
export async function readCachedAssetBytes(storedFilePath) {
  const relative = String(storedFilePath).replace(/^data\/assets\//, '');
  const cachePath = cachePathFor(relative);
  if (cachePath && existsSync(cachePath)) {
    return await fsp.readFile(cachePath);
  }
  const { bytes } = await downloadAssetToCache(relative);
  return bytes;
}

// Stream one asset from the shared server straight into `destinationPath`,
// deliberately bypassing the disk cache.
//
// Used by project export, which copies every asset of a project into a folder
// the user picked. Going through the cache would leave a second full copy of the
// project on disk for a one-shot operation, and the export is a whole-library
// sweep — exactly the access pattern a cache cannot help with.
export async function downloadAssetToPath(storedFilePath, destinationPath) {
  if (!remoteConfig?.url) {
    throw new Error('No shared server is configured');
  }
  const relative = String(storedFilePath).replace(/^data\/assets\//, '');

  const upstream = await fetch(new URL(`/assets/${encodeURI(relative)}`, remoteConfig.url), {
    headers: {
      authorization: `Bearer ${remoteConfig.token}`,
      'x-genstudio-gateway': '1'
    }
  });
  if (!upstream.ok || !upstream.body) {
    const error = new Error(`The shared server returned ${upstream.status} for ${relative}`);
    error.status = upstream.status;
    throw error;
  }

  await fsp.mkdir(path.dirname(destinationPath), { recursive: true });
  await pipeline(Readable.fromWeb(upstream.body), createWriteStream(destinationPath));
}

async function serveAsset(req, res) {
  const relative = req.path.replace(/^\/assets\/?/, '');
  if (!relative) return forwardRequest(req, res);

  const cachePath = cachePathFor(relative);
  if (!cachePath) return res.status(400).json({ error: 'Invalid asset path' });

  // sendFile, not a manual stream: it handles Range requests, ETags and
  // Content-Type, which three.js GLB loading and <video> seeking rely on.
  if (existsSync(cachePath)) {
    return res.sendFile(cachePath);
  }

  let result;
  try {
    result = await downloadAssetToCache(relative);
  } catch (err) {
    if (err.status) return res.status(err.status).end();
    return unreachable(res, err);
  }

  if (!result.cachePath) {
    if (result.contentType) res.setHeader('Content-Type', result.contentType);
    return res.end(result.bytes);
  }
  return res.sendFile(result.cachePath);
}

// Mount AFTER cors() and BEFORE express.json()/multer, so request bodies are
// still unread. Also before the /assets static mount, so cached remote assets
// win over the (empty) local asset directory.
export function mountGateway(app, { mode }) {
  // Re-read so a config written since import (or by another process) is picked
  // up; module scope already loaded it once for dataStore.
  remoteConfig = readRemoteConfig();

  if (mode === 'server') return;

  if (remoteConfig.url) {
    console.log(`🔗 Remote server: ${remoteConfig.url}${remoteConfig.token ? '' : ' (not signed in)'}`);
  }

  // --- local connection management (never forwarded; see serverMode.js) ---
  // Awaits the probe rather than reporting the cached value: this is what the
  // connection banner is drawn from, and a banner that says "connected" about a
  // server that is off is worse than a poll that takes an extra moment. The
  // result is cached, so the cost is at most one probe every few seconds no
  // matter how many windows are open.
  app.get('/api/remote', async (req, res) => {
    if (remoteConfig.url) await isRemoteReachable();
    res.json(getRemoteStatus());
  });

  // Whether an unreachable server means "use this computer's data" or "stop and
  // wait". See EMPTY_REMOTE for why that is a real choice and not a preference.
  app.post('/api/remote/offline-fallback', express.json(), async (req, res) => {
    const enabled = req.body?.enabled !== false;
    await writeRemoteConfig({ ...remoteConfig, offlineFallback: enabled });
    res.json(getRemoteStatus());
  });

  // The browser never handles the shared server's token: it posts credentials
  // here and this process holds the JWT for the lifetime of the install.
  //
  // Its own express.json() is not optional: this whole module mounts ahead of
  // the global body parser (so uploads can stream through untouched), which
  // means req.body would otherwise be undefined here.
  app.post('/api/remote/login', express.json(), async (req, res) => {
    try {
      const url = String(req.body?.url || remoteConfig.url || '').trim().replace(/\/+$/, '');
      const login = String(req.body?.login || '').trim();
      const password = String(req.body?.password || '');
      if (!url || !login || !password) {
        return res.status(400).json({ error: 'url, login and password are required' });
      }

      let upstream;
      try {
        upstream = await fetch(new URL('/api/auth/login', url), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ login, password })
        });
      } catch (err) {
        return res.status(502).json({ error: `Could not reach ${url}: ${err.message}` });
      }

      const payload = await upstream.json().catch(() => null);
      if (!upstream.ok || !payload?.token) {
        return res.status(upstream.status === 401 ? 401 : 502).json({
          error: payload?.error || `The server at ${url} rejected the sign-in`
        });
      }

      await writeRemoteConfig({
        url,
        login,
        token: payload.token,
        user: payload.user || null,
        // Carried across: this is a preference about how outages behave, not
        // part of the session, and rebuilding the object without it would
        // silently reset the choice on every sign-in.
        offlineFallback: remoteConfig.offlineFallback !== false
      });
      // We just spoke to it, so start from "up" rather than whatever a probe
      // last concluded -- typically "down", which is why the user is here.
      noteReachability(true);
      console.log(`🔗 Signed in to the shared server at ${url} as ${login}`);
      res.json({ ...getRemoteStatus(), user: payload.user });
    } catch (err) {
      console.error('Remote sign-in failed:', err);
      res.status(500).json({ error: err.message || 'Remote sign-in failed' });
    }
  });

  app.post('/api/remote/logout', async (req, res) => {
    await writeRemoteConfig({ ...remoteConfig, token: '' });
    res.json(getRemoteStatus());
  });

  // Disconnect entirely and fall back to this machine's own database.
  app.delete('/api/remote', async (req, res) => {
    await writeRemoteConfig({ ...EMPTY_REMOTE });
    res.json(getRemoteStatus());
  });

  // --- the forwarding middleware ---
  app.use(async (req, res, next) => {
    // No remote configured at all: this install owns its own data, as before.
    if (!remoteConfig.url) return next();
    if (!isRemoteDataPath(req.path)) return next();

    // Configured but signed out (typically after the token was rejected). Do
    // NOT fall through to the local database: a rejected session is not the
    // same as an absent server, and silently showing a different workspace
    // instead of asking for a password reads as catastrophic data loss.
    if (!remoteConfig.token) {
      return res.status(401).json({
        error: `Not signed in to the shared server at ${remoteConfig.url}. Sign in from Settings to reach your projects and assets.`,
        remote: remoteConfig.url
      });
    }

    // Server switched off, unplugged, or not on this network. Checked BEFORE
    // forwarding, because otherwise every request pays the TCP connect timeout
    // — around 11 seconds each, which is what made an unreachable server look
    // like a frozen application rather than a missing one.
    if (!(await isRemoteReachable())) {
      if (remoteConfig.offlineFallback) {
        // Serve this machine's own data. The connection is kept, so forwarding
        // resumes on its own as soon as the server answers again.
        return next();
      }
      return offline(res);
    }

    if (req.path.startsWith('/assets') && (req.method === 'GET' || req.method === 'HEAD')) {
      return serveAsset(req, res).catch(err => unreachable(res, err));
    }
    return forwardRequest(req, res).catch(err => unreachable(res, err));
  });
}
