// Route classification for the two run modes.
//
// 'local'  — a desktop install: every route is mounted (today's behaviour).
// 'server' — the Docker deployment: only the shared *data* routes exist. It has
//            no GPU, no ComfyUI, no Python sidecars and no per-user secrets, so
//            the compute and machine-local routes are not merely unused there,
//            they are meaningless and must not answer.
//
// A local install that is pointed at a remote server uses BOTH lists: the
// local-only routes it serves itself, and the remote-data routes it forwards
// (see gateway.js). The two sets are disjoint and between them cover every
// route, which is what makes a single origin work for the frontend.
//
// This is expressed as path tests rather than by moving the 129 route
// registrations out of server.js. Those registrations are interleaved with
// ~9000 lines of helpers; relocating them is the highest-risk change available
// and buys nothing that a path test does not.

// Whole subtrees that belong to the local machine.
const LOCAL_ONLY_PREFIXES = [
  '/api/comfyui',       // workflow execution (WebSocket to a local ComfyUI)
  '/api/image-edits',   // ComfyUI + vendor-API image editing
  '/api/meshes',        // every mesh op: generate, edit, texture, rig, bake, LODs...
  '/api/mocap',         // video-to-motion sidecar (:8401)
  '/api/setup',         // first-run wizard; downloads models onto the local disk
  '/api/filesystem',    // browses the *server's* disk — nonsense when remote
  '/api/logs',          // tails log files the desktop shell owns
  '/api/remote',        // this install's own remote-server connection settings
  '/mcp',               // MCP clients drive a user's own app, not the shared server
  '/resources'          // bundled reference animation library (mesh editor only)
];

// Individual routes, where a sibling under the same prefix IS shared data.
// /api/motions/library* is the shared motion catalogue and must stay reachable,
// so /api/motions cannot be blanket-listed above.
const LOCAL_ONLY_EXACT = new Set([
  '/api/images/generate',
  '/api/motions/generate',
  '/api/motions/skeleton',
  '/api/motions/health',
  '/api/settings',      // ComfyUI URL, service ports and third-party API keys
  '/api/system/stats',  // reports the container's hardware, not the user's
  '/api/export/mesh'    // writes files to a path on the local filesystem
]);

// Everything the shared server owns. Forwarded verbatim by the gateway when a
// remote is configured. /api/health is deliberately absent: a local install
// answers for its own liveness, not the remote's.
const REMOTE_DATA_PREFIXES = [
  '/api/events',                  // SSE mutation bus
  '/api/projects',
  '/api/assets',
  '/api/cards',
  '/api/card-attributes',
  '/api/graph',
  '/api/boards',
  '/api/wiki',
  '/api/tasks',
  '/api/motions/library',         // the shared clip catalogue (not /generate)
  '/api/library/comfy-workflows', // workflow DEFINITIONS are shared; execution is local
  '/api/auth',                    // login/logout/me on the shared server
  '/api/users',
  '/wiki-media',

  // Asset bytes, listed as individual subdirectories rather than a blanket
  // '/assets'. The URL prefix is shared by two completely different things:
  //
  //   /assets/images/1787-42.png   -> data/assets/images/...  (a user asset)
  //   /assets/index-DJ9Bu3Jb.js    -> dist/assets/...         (the app's own bundle)
  //
  // Vite emits its build output flat under dist/assets, and express.static
  // serves it on the same prefix. Forwarding the whole prefix sent the
  // frontend's own JavaScript to the shared server, which has a different
  // build and answered 404 — a blank app window. User assets always sit in one
  // of these subdirectories (see storage.js), and Vite's output never does, so
  // the split is unambiguous.
  '/assets/images',
  '/assets/meshes',
  '/assets/thumbnails',
  '/assets/workflows',
  '/assets/brushes',
  '/assets/paintdocs',
  '/assets/wiki',
  '/assets/motions'
];

function matchesPrefix(pathname, prefixes) {
  return prefixes.some(prefix => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function normalize(pathname) {
  return String(pathname || '').replace(/\/+$/, '') || '/';
}

export function isLocalOnlyPath(pathname) {
  const normalized = normalize(pathname);
  if (LOCAL_ONLY_EXACT.has(normalized)) return true;
  return matchesPrefix(normalized, LOCAL_ONLY_PREFIXES);
}

export function isRemoteDataPath(pathname) {
  const normalized = normalize(pathname);
  // A local-only route always wins, so /api/motions/generate cannot be dragged
  // remote by the /api/motions/library prefix and /api/settings stays local.
  if (isLocalOnlyPath(normalized)) return false;
  return matchesPrefix(normalized, REMOTE_DATA_PREFIXES);
}

// Mount as early as possible — before the body parsers, the auth gate and the
// static mounts. A local-only path should read as absent regardless of whether
// the caller is authenticated, so this deliberately runs ahead of the gate.
export function mountLocalOnlyGuard(app, { mode }) {
  if (mode !== 'server') return;

  app.use((req, res, next) => {
    if (!isLocalOnlyPath(req.path)) return next();
    res.status(404).json({
      error: 'This endpoint runs on your local 3D Gen Studio installation, not on the shared server.',
      path: req.path,
      mode: 'server'
    });
  });
}
