// Blender-style view cube in the top-right of the mesh-editor viewport. Clicking a
// face, edge or corner tweens the camera onto that axis — drei drives the tween
// through the `makeDefault` OrbitControls that CameraRig owns, so no extra wiring.
// Double-clicking does that AND fits the mesh to the viewport (see handleDoubleClick).
//
// GizmoHelper renders through drei's Hud, which takes over the render loop at
// priority 1: it draws the main scene, clears depth, then draws the cube on top. All
// the editor's own useFrame work (the animation mixer, the skeleton overlay) runs at
// the default priority 0 and so still runs first, in the order it always did.
//
// Its pointer footprint is guarded on the DOM side — see utils/viewGizmoLayout.
import { useCallback, useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { GizmoHelper, GizmoViewcube } from '@react-three/drei'
import * as THREE from 'three'
import { VIEW_GIZMO_MARGIN, isPointerOverViewGizmo } from '../../utils/viewGizmoLayout'
import { fitCameraToSphere, meshFittingSphere } from '../../utils/cameraFraming'

// GizmoHelper measures the orbit radius for a snap from the WORLD ORIGIN, not from
// the controls' target — it distances against a Vector3 that is never assigned. Our
// meshes are framed on their bounding-sphere centre (a character sits around y ≈ 1)
// and the user can pan anywhere, so an uncorrected snap silently rescales the view by
// however far the target has drifted from (0,0,0).
//
// The fix has two halves. This one samples the REAL radius every frame; being
// rendered ahead of GizmoHelper, its useFrame is subscribed first and so runs before
// the helper touches the camera, which means mid-tween it still reads the radius the
// tween is supposed to preserve.
function SnapRadiusKeeper({ radiusRef }) {
  const camera = useThree(state => state.camera)
  const controls = useThree(state => state.controls)
  useFrame(() => {
    if (!controls?.target) {
      return
    }
    radiusRef.current = camera.position.distanceTo(controls.target)
  })
  return null
}

export default function ViewGizmo({ geometry }) {
  const camera = useThree(state => state.camera)
  const controls = useThree(state => state.controls)
  const gl = useThree(state => state.gl)
  const invalidate = useThree(state => state.invalidate)
  const radiusRef = useRef(0)
  const offsetRef = useRef(new THREE.Vector3())

  // The other half: GizmoHelper calls this instead of `controls.update()` on every
  // tween step, once it has written the (mis-scaled) position. Re-seat the camera at
  // the sampled radius along the direction the tween just chose, then let the controls
  // resync from there.
  const handleTweenUpdate = useCallback(() => {
    const target = controls?.target
    if (target && radiusRef.current > 1e-6) {
      const offset = offsetRef.current.subVectors(camera.position, target)
      if (offset.lengthSq() > 1e-12) {
        camera.position.copy(target).addScaledVector(offset.normalize(), radiusRef.current)
      }
    }
    controls?.update?.()
  }, [camera, controls])

  // A double-click is "snap to this axis AND fill the viewport with the mesh". The two
  // clicks underneath it have already started the snap tween, so this only has to put
  // the orbit target back on the mesh and pull the eye in to the fitted distance.
  //
  // It listens on the canvas rather than overriding GizmoViewcube's `onClick`, because
  // that prop replaces the built-in handler on every face, edge and corner at once —
  // the snap itself would have to be reimplemented to keep it. The hit test is the
  // same square MeshEditorPage uses to keep gizmo clicks out of its brush handlers.
  const handleDoubleClick = useCallback(event => {
    const rect = gl.domElement?.getBoundingClientRect()
    if (!rect || !isPointerOverViewGizmo(event.clientX - rect.left, event.clientY - rect.top, rect)) {
      return
    }
    const sphere = meshFittingSphere(geometry)
    if (!sphere) {
      return
    }
    // An in-flight tween re-reads the orbit target every step (drei holds the very
    // same Vector3), and `radiusRef` is what our onUpdate re-seats the eye at — so
    // writing both here lands the tween on the fitted view instead of fighting it.
    radiusRef.current = fitCameraToSphere(camera, controls, sphere)
    invalidate()
  }, [camera, controls, geometry, gl, invalidate])

  useEffect(() => {
    const canvas = gl.domElement
    if (!canvas) {
      return undefined
    }
    canvas.addEventListener('dblclick', handleDoubleClick)
    return () => canvas.removeEventListener('dblclick', handleDoubleClick)
  }, [gl, handleDoubleClick])

  return (
    <>
      <SnapRadiusKeeper radiusRef={radiusRef} />
      <GizmoHelper
        alignment="top-right"
        margin={[VIEW_GIZMO_MARGIN, VIEW_GIZMO_MARGIN]}
        onUpdate={handleTweenUpdate}
      >
        <GizmoViewcube
          // `color` fills the per-face label canvas; the material tints it white until
          // the face is hovered, at which point `hoverColor` multiplies through.
          color="#1b1e27"
          hoverColor="#8ff5ff"
          textColor="#e6ebf5"
          strokeColor="#ac89ff"
          opacity={0.92}
          font="600 22px Inter, Segoe UI, Arial, sans-serif"
        />
      </GizmoHelper>
    </>
  )
}
