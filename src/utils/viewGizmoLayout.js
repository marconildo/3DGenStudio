// Where the mesh-editor view cube sits, and how much of the canvas it reserves.
//
// The cube is drawn inside the R3F canvas, so its clicks also reach the DOM pointer
// handlers on the canvas shell (R3F's `stopPropagation` is scene-internal, not DOM).
// Left unguarded, a snap-to-face would simultaneously start a paint stroke, a mask
// stroke or a box selection — so those handlers ask `isPointerOverViewGizmo` first.
// Kept out of the component file so both sides import the same numbers.

// Distance from the top / right edge of the canvas to the cube's centre.
export const VIEW_GIZMO_MARGIN = 80

// Half-extent reserved for the cube. GizmoViewcube draws a 60px box, and corner-on
// that reaches 60 * sqrt(3) / 2 ≈ 52px from its centre; rounded up for the hover
// edges and corners, which sit a hair outside the faces.
export const VIEW_GIZMO_HIT_RADIUS = 58

/**
 * True when a canvas-relative point falls in the square the view cube reserves.
 * `rect` is the canvas shell's bounding rect — the gizmo is anchored to its corner.
 */
export function isPointerOverViewGizmo(x, y, rect) {
  if (!rect) {
    return false
  }
  return Math.abs(x - (rect.width - VIEW_GIZMO_MARGIN)) <= VIEW_GIZMO_HIT_RADIUS
    && Math.abs(y - VIEW_GIZMO_MARGIN) <= VIEW_GIZMO_HIT_RADIUS
}
