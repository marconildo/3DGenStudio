// Video-to-motion (MoCapAnything V2) support for the mesh-editor Auto Rig panel.
//
// The service (thirdparty/mocapanything/mocap_server.py) turns a video of a
// moving subject into a BVH clip. What makes this different from Kimodo is WHOSE
// skeleton comes back: MoCapAnything is conditioned on the target rig, so the
// BVH carries the user's OWN joint names, hierarchy and rest offsets. There is
// no cross-skeleton table to write and no mapping for the user to get wrong —
// the bone map is the identity.
//
// It still goes through `retargetAnimationClip` rather than binding the clip
// straight onto the mesh, for one reason: the per-rig bake yaws the character to
// face +Z, so the BVH's rest pose can differ from the mesh's by that yaw.
// Retargeting measures both rest poses and cancels it; direct binding would
// silently rotate the character. Reusing that path also means the preview,
// the frame editor and Save-as-version work unchanged.
//
// Two-step by nature, and the UI has to show it: a video can only drive a rig
// that has been BAKED first (skeleton topology, joint-name embeddings, a
// reference pose, a rendered view). The bake needs Blender, takes minutes, and
// is cached by mesh content hash — once per rig, not once per clip.
import { Group } from 'three'
import { BVHLoader } from 'three/examples/jsm/loaders/BVHLoader.js'
import { API_BASE } from '../config'
import { detectHipBone } from './animationLibrary'
import { readSseStream } from './meshTools'

// MoCap occupies the same single "source rig" slot as a mesh2motion reference or
// Kimodo, so it needs an id that cannot collide with either.
export const MOCAP_SOURCE_ID = 'mocap'

// The model runs one forward pass over the whole clip with no chunking, so VRAM
// scales with length: ~2 GB of weights plus ~16 MiB per frame (measured), and
// the upstream code caps the sequence at 301 frames and silently truncates past
// it. Exposed so the panel can offer a shorter window on a smaller card rather
// than letting a long clip OOM.
export const MOCAP_MAX_FRAMES = 301
export const MOCAP_MIN_FRAMES = 32
export const MOCAP_FRAME_PRESETS = [
  { value: 100, label: 'Short — ~7s (≈6.5 GB VRAM)' },
  { value: 200, label: 'Medium — ~13s (≈9 GB VRAM)' },
  { value: 301, label: 'Full — ~20s (≈10.5 GB VRAM)' },
]

// NOTE: unlike the mesh/rigging/motion services, this one is not yet managed by
// the desktop app (electron/main.cjs provisions a venv per service, and MoCap
// needs its own plus a MoCapAnything checkout). Until that exists the service is
// started by hand, so there is no ensureDesktopService() call here — a missing
// service surfaces as a plain "could not reach" error from the proxy, which is
// accurate, rather than as a failed auto-start.
const MOCAP_BASE = `${API_BASE}/mocap`

// --- BVH -> the shapes the retargeter expects --------------------------------

const bvhLoader = new BVHLoader()

// Same construction as motionGen's Kimodo source, and for the same reason:
// BVHLoader never updates world matrices, so a Skeleton built from its bones
// computes every bind inverse from an identity matrix. That makes Skeleton.pose()
// collapse the rig onto the origin and turns the retarget into garbage.
// Recomputing the inverses once the hierarchy has real world matrices is what
// makes pose() restore the BVH rest pose.
function bvhToSource(bvhText) {
  const { skeleton, clip } = bvhLoader.parse(bvhText)
  const root = skeleton.bones[0]
  if (!root) throw new Error('The generated motion has no skeleton.')

  const scene = new Group()
  scene.name = 'mocap-source'
  scene.add(root)
  scene.updateMatrixWorld(true)
  skeleton.calculateInverses()

  // Unlike Kimodo there is no subset to filter down to: every bone in this BVH
  // is a bone of the user's own rig, and the model drove all of them.
  const boneNames = skeleton.bones.map(b => b.name)

  // No clips. Kimodo's source BVH is a REST POSE, so the clip the loader builds
  // from it is a throwaway; ours is the capture itself, so keeping it here would
  // put the same motion in the gallery twice — once under BVHLoader's default
  // name ("animation") and once under the name we give it.
  void clip
  return {
    scene,
    skinnedMesh: { skeleton },
    boneNames,
    hipName: detectHipBone(boneNames),
    clips: [],
  }
}

function bvhToClip(bvhText, name) {
  const { clip } = bvhLoader.parse(bvhText)
  if (!clip) throw new Error('The motion could not be parsed.')
  clip.name = name || 'mocap'

  // Drop the root's POSITION track. MoCapAnything zeroes root translation
  // (utils/npy2bvh.py writes np.zeros), so BVHLoader produces a track whose
  // value is constant and equal to the source rig's rest offset — no motion at
  // all, just an absolute hip height in the baked rig's units. Retargeting that
  // onto the mesh plants its hips at that height and the character floats above
  // the ground. Removing it leaves the mesh standing at its own rest position,
  // which is exactly what an in-place clip should do.
  clip.tracks = clip.tracks.filter(t => !t.name.endsWith('.position'))
  if (!clip.tracks.length) throw new Error('The capture contains no rotation data.')
  return clip
}

// Bone chains the capture can be limited to.
//
// This exists because of what the model actually does. It regresses joint
// POSITIONS and then solves rotations anchored on the reference pose, over
// every joint at once, trained on animal and object motion where the whole body
// moves together. It has no notion of "this limb is holding still", so filming
// only your arms still produces small leg motion, and global orientation error
// concentrates in the root — which swings the whole body to place a hand.
//
// Which joints are even ALLOWED to move is fixed at Prepare time (a joint whose
// speed never exceeds STATIC_EPS in the reference is marked static and locked),
// so it cannot be changed per capture. Filtering the mapping can: a chain left
// out is simply not driven and holds its rest pose. Cheap, reversible, and it
// applies to captures already taken.
export const MOCAP_BONE_GROUPS = [
  { id: 'root', label: 'Body turn', hint: 'The root bone. Off keeps the character facing forward.' },
  { id: 'spine', label: 'Spine', hint: 'Torso bend and twist.' },
  { id: 'head', label: 'Head & neck', hint: null },
  { id: 'arms', label: 'Arms', hint: null },
  // Always locked by the model in practice, so this switch is a no-op today; it
  // exists because whether a joint MAY move is decided when the rig is prepared,
  // and a different reference could unlock them. Finger POSE comes from the hand
  // curl sliders instead.
  { id: 'hands', label: 'Fingers', hint: 'Not captured — use the Hands sliders below.' },
  { id: 'legs', label: 'Legs', hint: 'Turn off when the subject never moves their legs.' },
  { id: 'feet', label: 'Feet', hint: null },
]

// Order matters, and plain substring tests are used deliberately: rig names are
// concatenated ("mixamorigLeftLeg"), so a word-boundary guard would never fire.
// Fingers must be tested before hands/arms, and feet before legs, or the looser
// test swallows them.
export function mocapBoneGroup(name) {
  const l = String(name || '').toLowerCase()
  if (/index|middle|pinky|ring|thumb|finger/.test(l)) return 'hands'
  if (/toe|ball|ankle|foot/.test(l)) return 'feet'
  if (/upleg|thigh|shin|calf|knee|leg/.test(l)) return 'legs'
  if (/forearm|elbow|shoulder|clavicle|arm|hand|wrist/.test(l)) return 'arms'
  if (/neck|head|skull|jaw|eye/.test(l)) return 'head'
  if (/hips|pelvis|root/.test(l)) return 'root'
  if (/spine|chest|torso|abdomen|belly/.test(l)) return 'spine'
  return 'spine'
}

// The mapping is the identity: the service returned OUR bone names. Anything the
// target does not have is dropped rather than guessed — a bone the bake renamed
// is better left undriven than bound to the wrong joint. `groups`, when given,
// limits it to those chains.
export function mocapIdentityMapping(sourceNames, targetNames, groups = null) {
  const target = new Set(targetNames || [])
  const allowed = groups ? new Set(groups) : null
  const mapping = {}
  for (const name of sourceNames || []) {
    if (!target.has(name)) continue
    if (allowed && !allowed.has(mocapBoneGroup(name))) continue
    mapping[name] = name
  }
  return mapping
}

// A stable identity for "which skeleton is this". The bake is cached against it
// rather than against the GLB bytes: the page re-exports the mesh on every
// check, and glTF export is not guaranteed byte-identical run to run, so a byte
// hash would miss its own cache every time and re-bake a rig already on disk.
// Offsets are rounded because a re-export can differ in the last float bits
// without the skeleton having changed at all.
export function mocapRigKey(skeleton) {
  if (!skeleton?.names?.length) return ''
  const parents = skeleton.parents || []
  const joints = skeleton.joints || null      // flat Float32Array, 3 per bone
  const r = v => (Number(v) || 0).toFixed(3)
  return skeleton.names.map((name, i) => {
    const p = parents[i] ?? -1
    if (!joints) return `${name}:${p}`
    return `${name}:${p}:${r(joints[i * 3])},${r(joints[i * 3 + 1])},${r(joints[i * 3 + 2])}`
  }).join('|')
}

// --- service --------------------------------------------------------------

async function readError(response, fallback) {
  let message = fallback
  try {
    const payload = await response.json()
    message = payload.detail ? `${payload.error}: ${payload.detail}` : (payload.error || message)
  } catch { /* non-JSON body — keep the status message */ }
  return new Error(message)
}

export async function fetchMocapServiceHealth() {
  try {
    const response = await fetch(`${MOCAP_BASE}/health`)
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) return { ok: false, ...payload }
    return { ok: true, ...payload }
  } catch (err) {
    return { ok: false, error: err?.message || 'Could not reach the video-to-motion service.' }
  }
}

// Cheap probe: hashes the mesh bytes server-side and says whether that exact rig
// is already baked. No GPU, no Blender. Lets the panel open in the right state
// instead of making the user press Prepare to find out.
export async function inspectMocapRig(meshBlob, rigKey = '') {
  const form = new FormData()
  form.append('meshFile', meshBlob, 'mesh.glb')
  if (rigKey) form.append('rigKey', rigKey)
  const response = await fetch(`${MOCAP_BASE}/inspect`, { method: 'POST', body: form })
  if (!response.ok) throw await readError(response, `Could not check the rig (${response.status})`)
  return response.json()
}

export async function prepareMocapRig({ meshBlob, rigName = 'rig', rigKey = '', onProgress = null } = {}) {
  if (!meshBlob) throw new Error('No rigged mesh to prepare.')
  const form = new FormData()
  form.append('meshFile', meshBlob, 'mesh.glb')
  form.append('rigName', rigName)
  if (rigKey) form.append('rigKey', rigKey)

  const response = await fetch(`${MOCAP_BASE}/prepare`, { method: 'POST', body: form })
  if (!response.ok) throw await readError(response, `Preparing the rig failed (${response.status})`)

  const data = await readSseStream(response, onProgress)
  if (!data.rig_id) throw new Error('The service finished without preparing the rig.')
  return data
}

export async function generateMocapClip({
  videoFile,
  rigId,
  maxFrames = MOCAP_MAX_FRAMES,
  name,
  onProgress = null,
} = {}) {
  if (!videoFile) throw new Error('Choose a video first.')
  if (!rigId) throw new Error('Prepare this rig before generating motion from a video.')
  const form = new FormData()
  form.append('videoFile', videoFile, videoFile.name || 'clip.mp4')
  form.append('rigId', rigId)
  form.append('maxFrames', String(Math.min(MOCAP_MAX_FRAMES, Math.max(MOCAP_MIN_FRAMES, Number(maxFrames) || MOCAP_MAX_FRAMES))))

  const response = await fetch(`${MOCAP_BASE}/generate`, { method: 'POST', body: form })
  if (!response.ok) throw await readError(response, `Video to motion failed (${response.status})`)

  const data = await readSseStream(response, onProgress)
  if (!data.bvh) throw new Error('The service finished without returning a clip.')

  const label = name || (videoFile.name || 'clip').replace(/\.[^.]+$/, '').slice(0, 40)
  return {
    clip: bvhToClip(data.bvh, label),
    source: bvhToSource(data.bvh),
    bvh: data.bvh,
    stats: data.stats || null,
  }
}

export async function forgetMocapRig(rigId) {
  if (!rigId) return
  await fetch(`${MOCAP_BASE}/rigs/${encodeURIComponent(rigId)}`, { method: 'DELETE' })
}
