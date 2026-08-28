// Where a compute result gets written.
//
// Generation and mesh work always run on the user's own machine, but the asset
// it produces belongs to whichever database owns the project — this install's
// own SQLite, or a shared server. Every compute path in server.js goes through
// the functions here instead of calling storage.js directly, so the destination
// is decided in one place.
//
// The local implementation calls storage.js exactly as the code did before, so a
// single-user desktop install behaves identically and pays nothing for this.
// The remote implementation posts to the ingest endpoints in server.js.
//
// Bytes in, asset view out: callers hand over a Buffer and never touch the
// filesystem or a URL, because "write the file" means two different things
// depending on which side owns the data.
import fs from 'node:fs/promises';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import {
  createAssetEditRecord,
  createAssetVersion,
  createProjectAsset,
  clearCardProcessingState,
  deleteLibraryAssetByFilePath,
  listWorkflowRecords,
  findAssetByFilePath,
  getAssetRecordById,
  resolveProjectImageSource,
  resolveProjectMeshSource,
  replaceAssetFileById,
  setCardProcessingState,
  toAbsoluteStoragePath,
  toStoredAssetPath,
  toStoredThumbnailPath,
  updateAssetThumbnail
} from './storage.js';
import { getRemoteTarget, readCachedAssetBytes } from './gateway.js';
import { enqueueUpload, startUploadQueue } from './uploadQueue.js';

// --- local helpers ---------------------------------------------------------

function generatedFilename(extension) {
  const safeExtension = String(extension || 'bin').replace(/^\./, '') || 'bin';
  return `${Date.now()}-${Math.round(Math.random() * 1e9)}.${safeExtension}`;
}

async function writeLocalAssetBytes(type, bytes, extension, relativePath = null) {
  // relativePath lets a caller keep an existing layout convention (image edits
  // live under images/<source>/<editId>/ and are looked up by that path).
  const storedPath = toStoredAssetPath(type, relativePath || generatedFilename(extension));
  const absolutePath = toAbsoluteStoragePath(storedPath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, bytes);
  return storedPath;
}

async function writeLocalThumbnailBytes(bytes, filename) {
  if (!bytes?.length) return null;
  const name = filename || `thumb-${randomUUID().slice(0, 8)}.png`;
  const absolutePath = toAbsoluteStoragePath(toStoredThumbnailPath(name));
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, bytes);
  return name;
}

// --- remote helpers --------------------------------------------------------

function asBlob(bytes, contentType = 'application/octet-stream') {
  return new Blob([bytes], { type: contentType });
}

// A result upload that fails because the server is unreachable is spooled to
// disk and retried, rather than losing minutes of GPU work. A rejection (4xx)
// is NOT queued: the server understood the request and said no, so retrying it
// would fail identically forever.
function isTransientUploadFailure(err) {
  return !/rejected the (result|generated asset|workflow) \(4\d\d\)/.test(String(err?.message || ''));
}

async function postIngestWithRetry(remote, endpoint, args, kind) {
  try {
    return await postIngest(remote, endpoint, args);
  } catch (err) {
    if (!isTransientUploadFailure(err)) throw err;
    await enqueueUpload(kind, { endpoint, payload: args.payload, extension: args.extension, thumbnailFilename: args.thumbnailFilename },
      args.bytes, args.thumbnailBytes);
    // Surfaced to the caller as a placeholder so the run reports honestly: the
    // work succeeded, the save is pending.
    return { pendingUpload: true, queued: true, name: args.payload?.name || null };
  }
}

async function postIngest(remote, endpoint, { bytes, extension, thumbnailBytes, thumbnailFilename, payload }) {
  const form = new FormData();
  if (bytes) {
    form.append('file', asBlob(bytes), generatedFilename(extension));
  }
  if (thumbnailBytes?.length) {
    form.append('thumbnail', asBlob(thumbnailBytes, 'image/png'), thumbnailFilename || 'thumbnail.png');
  }
  form.append('payload', JSON.stringify(payload || {}));

  const response = await fetch(new URL(endpoint, remote.url), {
    method: 'POST',
    headers: { authorization: `Bearer ${remote.token}`, 'x-genstudio-gateway': '1' },
    body: form
  });

  const text = await response.text();
  if (!response.ok) {
    let detail = text;
    try {
      detail = JSON.parse(text).error || text;
    } catch { /* not JSON — use the raw body */ }
    throw new Error(`The shared server rejected the result (${response.status}): ${detail}`);
  }
  return JSON.parse(text);
}

async function putRemoteJson(remote, endpoint, body) {
  const response = await fetch(new URL(endpoint, remote.url), {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${remote.token}`,
      'x-genstudio-gateway': '1',
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(`The shared server rejected the update (${response.status})`);
  }
  return await response.json().catch(() => null);
}

// --- the interface ---------------------------------------------------------

// A new root asset: a generation with no source to hang off.
export async function saveRootAsset({
  projectId, type = 'image', name, bytes, extension,
  thumbnailBytes = null, thumbnailFilename = null,
  width = 0, height = 0, metadata = {}, createdAt = Date.now(), detached = false
}) {
  const remote = getRemoteTarget();
  if (!remote) {
    return await createProjectAsset({
      projectId,
      type,
      name,
      filePath: await writeLocalAssetBytes(type, bytes, extension),
      thumbnailPath: await writeLocalThumbnailBytes(thumbnailBytes, thumbnailFilename),
      width, height, metadata, createdAt, detached
    });
  }

  // Reuses the existing upload route, which already creates a project asset.
  const form = new FormData();
  form.append('file', asBlob(bytes), generatedFilename(extension));
  form.append('projectId', String(projectId));
  form.append('type', type);
  if (name) form.append('name', name);
  form.append('metadata', JSON.stringify(metadata || {}));

  const response = await fetch(new URL('/api/assets/upload', remote.url), {
    method: 'POST',
    headers: { authorization: `Bearer ${remote.token}`, 'x-genstudio-gateway': '1' },
    body: form
  });
  if (!response.ok) {
    throw new Error(`The shared server rejected the generated asset (${response.status})`);
  }
  const saved = await response.json();

  // The upload route takes no thumbnail, so attach one in a second call.
  if (thumbnailBytes?.length && saved?.id) {
    const thumbForm = new FormData();
    thumbForm.append('thumbnail', asBlob(thumbnailBytes, 'image/png'), thumbnailFilename || 'thumbnail.png');
    const thumbResponse = await fetch(new URL(`/api/assets/${saved.id}/thumbnail`, remote.url), {
      method: 'POST',
      headers: { authorization: `Bearer ${remote.token}`, 'x-genstudio-gateway': '1' },
      body: thumbForm
    });
    if (thumbResponse.ok) return await thumbResponse.json();
    // A missing thumbnail is cosmetic; never lose the asset over it.
    console.warn('Saved the asset but could not attach its thumbnail remotely');
  }
  return saved;
}

// A new version of an existing mesh asset.
export async function saveAssetVersion({
  parentAssetId, projectId = null, type = 'mesh', name, bytes, extension,
  thumbnailBytes = null, thumbnailFilename = null,
  width = 0, height = 0, metadata = {}, createdAt = Date.now(), inheritThumbnail = false, relativePath = null
}) {
  const remote = getRemoteTarget();
  if (!remote) {
    return await createAssetVersion({
      assetId: parentAssetId,
      type,
      name,
      filePath: await writeLocalAssetBytes(type, bytes, extension, relativePath),
      thumbnailPath: await writeLocalThumbnailBytes(thumbnailBytes, thumbnailFilename),
      width, height, metadata, createdAt, inheritThumbnail, projectId
    });
  }
  return await postIngestWithRetry(remote, `/api/assets/${parentAssetId}/versions`, {
    bytes, extension, thumbnailBytes, thumbnailFilename,
    payload: { type, name, projectId, width, height, metadata, createdAt, inheritThumbnail, relativePath }
  }, 'mesh version');
}

// A new edit of an existing image asset.
export async function saveAssetEdit({
  parentAssetId, editId = null, projectId = null, name = '', bytes, extension = 'png',
  thumbnailBytes = null, thumbnailFilename = null,
  width = 0, height = 0, createdAt = Date.now(), relativePath = null
}) {
  const remote = getRemoteTarget();
  if (!remote) {
    const saved = await createAssetEditRecord({
      assetId: parentAssetId,
      editId: editId || randomUUID(),
      name,
      filePath: await writeLocalAssetBytes('image', bytes, extension, relativePath),
      width, height, createdAt, projectId
    });
    const thumbnailPath = await writeLocalThumbnailBytes(thumbnailBytes, thumbnailFilename);
    return thumbnailPath && saved?.id ? await updateAssetThumbnail(saved.id, thumbnailPath) : saved;
  }
  return await postIngestWithRetry(remote, `/api/assets/${parentAssetId}/edits`, {
    bytes, extension, thumbnailBytes, thumbnailFilename,
    payload: { editId: editId || randomUUID(), name, projectId, width, height, createdAt, relativePath }
  }, 'image edit');
}

// Swap an existing asset's file, keeping its id and every link to it.
export async function replaceAssetFile({
  assetId, type = 'mesh', name, bytes, extension,
  thumbnailBytes = null, thumbnailFilename = null,
  width = 0, height = 0, metadata = {}, relativePath = null
}) {
  const remote = getRemoteTarget();
  if (!remote) {
    return await replaceAssetFileById(assetId, {
      name,
      type,
      filePath: await writeLocalAssetBytes(type, bytes, extension, relativePath),
      thumbnailPath: await writeLocalThumbnailBytes(thumbnailBytes, thumbnailFilename),
      width, height, metadata
    });
  }
  return await postIngestWithRetry(remote, `/api/assets/${assetId}/replace`, {
    bytes, extension, thumbnailBytes, thumbnailFilename,
    payload: { type, name, width, height, metadata, relativePath }
  }, 'asset replacement');
}

// --- card processing snapshots --------------------------------------------
// These are what keep a card showing "processing" across a page reload, so a
// job running locally has to record them wherever the card actually lives.

export async function setCardProcessing(projectId, cardKey, state = {}) {
  const remote = getRemoteTarget();
  if (!remote) {
    return await setCardProcessingState(Number(projectId), cardKey, state);
  }
  return await putRemoteJson(remote, `/api/cards/${encodeURIComponent(cardKey)}/processing`, {
    projectId: Number(projectId),
    state
  });
}

export async function clearCardProcessing(projectId, cardKey, options = {}) {
  const remote = getRemoteTarget();
  if (!remote) {
    return await clearCardProcessingState(Number(projectId), cardKey, options);
  }
  return await putRemoteJson(remote, `/api/cards/${encodeURIComponent(cardKey)}/processing`, {
    projectId: Number(projectId),
    clear: true,
    ...options
  });
}

// --- reads ----------------------------------------------------------------
// A compute route runs locally but its input asset's RECORD lives wherever the
// project does. Without these, a remote-connected install looks up ids in its
// own empty database and reports "asset not found".

async function getRemoteJson(remote, endpoint) {
  let response;
  try {
    response = await fetch(new URL(endpoint, remote.url), {
      headers: { authorization: `Bearer ${remote.token}`, 'x-genstudio-gateway': '1' }
    });
  } catch (err) {
    // undici reports every transport failure as a bare "fetch failed", which
    // surfaces to the user as a meaningless error on an otherwise ordinary
    // action. Say what actually went wrong and what still works.
    const cause = err?.cause?.code ? ` (${err.cause.code})` : '';
    throw new Error(
      `The shared server at ${remote.url} is unreachable${cause}, so this asset could not be looked up. Local tools still work; try again once it is back.`
    );
  }
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`The shared server could not answer ${endpoint} (${response.status})`);
  }
  return await response.json();
}

// Mirrors resolveEditableMeshAsset: an id wins, otherwise look up by file path.
export async function getAssetRecord({ assetId = null, type = 'mesh', filePath = null }) {
  const numericAssetId = Number(assetId);
  const hasId = Number.isFinite(numericAssetId) && numericAssetId > 0;

  const remote = getRemoteTarget();
  if (!remote) {
    if (hasId) return await getAssetRecordById(numericAssetId);
    return filePath ? await findAssetByFilePath(type, filePath) : null;
  }

  const query = hasId
    ? `assetId=${numericAssetId}`
    : `type=${encodeURIComponent(type)}&filePath=${encodeURIComponent(filePath || '')}`;
  if (!hasId && !filePath) return null;
  return await getRemoteJson(remote, `/api/assets/record?${query}`);
}

// Resolve an "asset:<id>" / "edit:<path>" / bare-id reference within a project.
export async function resolveProjectSource(projectId, type, reference) {
  const remote = getRemoteTarget();
  if (!remote) {
    return String(type).toLowerCase() === 'mesh'
      ? await resolveProjectMeshSource(Number(projectId), reference)
      : await resolveProjectImageSource(Number(projectId), reference);
  }
  const serialized = typeof reference === 'object' && reference !== null
    ? JSON.stringify(reference)
    : String(reference ?? '');
  return await getRemoteJson(
    remote,
    `/api/assets/project-source?projectId=${Number(projectId)}&type=${encodeURIComponent(type)}&reference=${encodeURIComponent(serialized)}`
  );
}

// A ComfyUI workflow definition, graph JSON included.
//
// Definitions are shared (so a card's workflowId resolves identically for every
// teammate) but execution is always local, which makes this the one read a run
// cannot do without. `buildLocal` is injected because building the response
// needs parseComfyWorkflow and the workflow-file loader, both of which live in
// server.js — importing them here would be a cycle.
export async function getWorkflowDefinition(workflowId, buildLocal) {
  const remote = getRemoteTarget();
  if (!remote) return await buildLocal(Number(workflowId));
  return await getRemoteJson(remote, `/api/library/comfy-workflows/${Number(workflowId)}`);
}

// The workflow library, for the setup wizard's bundled-template install. When
// connected to a shared server the templates belong there: installed locally
// their ids would be meaningless to teammates, which is the very problem shared
// definitions exist to solve.
export async function listWorkflows() {
  const remote = getRemoteTarget();
  if (!remote) return await listWorkflowRecords();
  const workflows = await getRemoteJson(remote, '/api/library/comfy-workflows');
  // The remote returns built definitions; normalise to the record shape callers
  // here expect (name + filePath + id).
  return (workflows || []).map(w => ({ id: w.id, name: w.name, filePath: w.filePath }));
}

// `createLocal` is injected for the same reason as in getWorkflowDefinition:
// saveWorkflowFile and parseComfyWorkflow live in server.js.
export async function createWorkflow({ name, workflowJson, parameters = [], outputs = [] }, createLocal) {
  const remote = getRemoteTarget();
  if (!remote) return await createLocal();

  const response = await fetch(new URL('/api/library/comfy-workflows', remote.url), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${remote.token}`,
      'x-genstudio-gateway': '1',
      'content-type': 'application/json'
    },
    body: JSON.stringify({ name, workflowJson, parameters, outputs })
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`The shared server rejected the workflow "${name}" (${response.status}): ${detail.slice(0, 200)}`);
  }
  return await response.json();
}

export async function deleteWorkflowByFilePath(filePath) {
  const remote = getRemoteTarget();
  if (!remote) return await deleteLibraryAssetByFilePath('workflow', filePath, { force: true });

  const url = new URL('/api/assets/library', remote.url);
  url.searchParams.set('type', 'workflow');
  url.searchParams.set('filename', filePath);
  url.searchParams.set('force', 'true');
  const response = await fetch(url, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${remote.token}`, 'x-genstudio-gateway': '1' }
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`The shared server refused to delete the workflow (${response.status})`);
  }
  return { status: response.status === 404 ? 'not-found' : 'deleted' };
}

// Read an input asset's bytes regardless of which side stores them. Compute
// paths need the actual buffer to feed ComfyUI or a Python sidecar.
export async function readAssetBytes(storedFilePath) {
  const remote = getRemoteTarget();
  if (!remote) {
    return await fs.readFile(toAbsoluteStoragePath(storedFilePath));
  }
  try {
    // Via the gateway's disk cache: a mesh pipeline reads the same source
    // several times, and each read would otherwise be a fresh download.
    return await readCachedAssetBytes(storedFilePath);
  } catch (err) {
    throw new Error(
      `Could not read ${storedFilePath} from the shared server at ${remote.url}: ${err.message}`
    );
  }
}

// --- retry spool -----------------------------------------------------------

// Replays a queued upload once the server is reachable again. The job carries
// the endpoint it was originally bound for, so a version stays a version.
startUploadQueue(async (kind, job, bytes, thumbnailBytes) => {
  const remote = getRemoteTarget();
  if (!remote) {
    throw new Error('Not signed in to a shared server yet');
  }
  await postIngest(remote, job.endpoint, {
    bytes,
    extension: job.extension,
    thumbnailBytes,
    thumbnailFilename: job.thumbnailFilename,
    payload: job.payload
  });
});
