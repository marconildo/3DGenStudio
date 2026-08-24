// Camera-agnostic viewport metrics.
//
// The editor's brushes are sized in SCREEN pixels but applied in WORLD units, so
// every one of them needs "how many world units does one screen pixel cover here".
// For a perspective camera that is `2 * tan(fov/2) * distance`; for an orthographic
// camera the frustum height is fixed and the distance is irrelevant. Reading `.fov`
// off an orthographic camera silently falls back to 50° and produces brushes that
// grow with distance, so go through these helpers instead of inlining the trig.

/**
 * World-space height of the view frustum at `distance` from the camera.
 * `distance` is ignored for orthographic cameras (that is the point of ortho).
 */
export function viewWorldHeightAt(camera, distance) {
  if (!camera) {
    return 0
  }
  if (camera.isOrthographicCamera) {
    return Math.abs(camera.top - camera.bottom) / Math.max(camera.zoom || 1, 1e-6)
  }
  const fovRad = (camera.fov || 50) * Math.PI / 180
  return 2 * Math.tan(fovRad / 2) * Math.max(0, distance || 0)
}

/**
 * World units covered by one vertical screen pixel at `distance`.
 */
export function worldUnitsPerPixel(camera, distance, canvasHeight) {
  return viewWorldHeightAt(camera, distance) / Math.max(1, canvasHeight || 0)
}
