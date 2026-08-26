// Camera framing for the mesh-editor viewport. Two framings live here, and they are
// deliberately NOT the same one:
//
//   * the LOAD framing (CameraRig) — a three-quarter overview from a fixed offset,
//     with room around the mesh to work in;
//   * the FIT (the view cube's double-click) — "put the mesh back in the middle and
//     as large as it goes", which is a real fov/frustum fit, not a fixed distance.
//
// Sharing the file is what keeps the two readable side by side; sharing the numbers
// would make the double-click a no-op, which is the opposite of what it is for.
import * as THREE from 'three'

// LOAD FRAMING ---------------------------------------------------------------

// Where the eye sits relative to the bounding-sphere centre, in radii: front-right
// and a little above. Its length (≈ 4.05r) is the orbit radius it implies.
export const FRAME_EYE_OFFSET = /* @__PURE__ */ Object.freeze([2.6, 1.69, 2.6])

// World height the load framing shows, in bounding-sphere radii — how the
// orthographic side of it is expressed, since it has no distance to frame by.
// Matched to what the perspective offset produces so a mesh loads looking the same
// under either projection: the eye lands 4.05r from the centre and a 50° vertical
// fov spans 2*tan(25°)*4.05r ≈ 3.8r.
export const FRAMED_SPHERE_SPAN = 3.8

/** The zoom an orthographic camera needs to span FRAMED_SPHERE_SPAN radii. */
export function framedOrthoZoom(camera, radius) {
  return Math.abs(camera.top - camera.bottom) / Math.max(radius * FRAMED_SPHERE_SPAN, 1e-6)
}

// FIT ------------------------------------------------------------------------

// A hair of padding on the tightest fit, so the result reads as framed rather than
// cropped. Small on purpose: the bounding sphere already stands off the silhouette.
export const FIT_MARGIN = 1.04

// Nominal fov used to pick an orthographic camera's eye DISTANCE. Ortho fits by zoom,
// so the distance only sets the orbit radius — but it still has to be sane, and this
// keeps it the same as the perspective one so toggling projection doesn't lurch.
const ORTHO_ORBIT_FOV = 50

const offsetScratch = /* @__PURE__ */ new THREE.Vector3()

/**
 * The sphere a fit is computed from — `null` when there is nothing to frame.
 *
 * Note the floor is an epsilon, not the one world unit the load framing clamps to:
 * a fit has to actually fit, so a sub-unit mesh must be allowed to pull the camera
 * all the way in.
 */
export function meshFittingSphere(geometry) {
  if (!geometry) {
    return null
  }
  geometry.computeBoundingSphere()
  const sphere = geometry.boundingSphere
  if (!sphere || !(sphere.radius > 0)) {
    return null
  }
  return { center: sphere.center.clone(), radius: Math.max(sphere.radius, 1e-4) }
}

/**
 * Fill the viewport with `sphere` WITHOUT changing which way the camera looks: the eye
 * slides along its current direction from the centre to the distance where the sphere
 * is inscribed in the frustum, the orbit target moves onto the centre, and an
 * orthographic camera's zoom is refitted instead (its frustum is fixed).
 *
 * Fitting the bounding SPHERE rather than the box is what makes this safe to apply
 * mid-snap: the answer does not depend on the view direction, so a tween that is still
 * rotating cannot invalidate it. Returns the orbit radius it settled at — the view
 * cube needs that to keep the tween honest.
 */
export function fitCameraToSphere(camera, controls, sphere, margin = FIT_MARGIN) {
  const { center, radius } = sphere
  const needed = radius * margin
  let distance

  if (camera.isOrthographicCamera) {
    // drei sizes the ortho frustum in pixels, so zoom is "pixels per world unit": fit
    // the shorter screen axis and the longer one follows.
    const shortAxisPixels = Math.min(
      Math.abs(camera.right - camera.left),
      Math.abs(camera.top - camera.bottom)
    )
    camera.zoom = shortAxisPixels / Math.max(2 * needed, 1e-6)
    distance = needed / Math.sin(THREE.MathUtils.degToRad(ORTHO_ORBIT_FOV) / 2)
  } else {
    const vFov = THREE.MathUtils.degToRad(camera.fov || 50)
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * Math.max(camera.aspect || 1, 1e-6))
    // The tighter of the two half-angles is the one that clips, so it sets the distance.
    distance = needed / Math.sin(Math.min(vFov, hFov) / 2)
  }

  const offset = offsetScratch.subVectors(camera.position, center)
  if (offset.lengthSq() < 1e-12) {
    offset.fromArray(FRAME_EYE_OFFSET)
  }
  camera.position.copy(center).addScaledVector(offset.normalize(), distance)
  camera.updateProjectionMatrix()

  if (controls?.target) {
    controls.target.copy(center)
    controls.update?.()
  } else {
    camera.lookAt(center)
  }
  return distance
}
