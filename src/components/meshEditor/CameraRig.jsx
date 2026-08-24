import { useEffect, useRef } from 'react'
import { useThree } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import * as THREE from 'three'

// World height the framed view shows, in bounding-sphere radii — how the
// orthographic fit below is expressed, since it has no distance to frame by.
// Matched to what the perspective framing produces so a mesh loads looking the same
// under either projection: the eye lands at (d, 0.65d, d) from the centre with
// d = 2.6r, i.e. 4.05r away, and a 50° vertical fov spans 2*tan(25°)*4.05r ≈ 3.8r.
const FRAMED_SPHERE_SPAN = 3.8

// R3F scene helper extracted from MeshEditorPage.jsx (behaviour-preserving move).
export default function CameraRig({ geometry, frameKey, onCameraReady, controlsEnabled = true, allowPan = true, lockToCenter = false }) {
  const { camera } = useThree()
  const size = useThree(state => state.size)
  const controlsRef = useRef(null)
  const lastFramedKeyRef = useRef(null)

  useEffect(() => {
    onCameraReady?.(camera)
  }, [camera, onCameraReady])

  useEffect(() => {
    if (!geometry) {
      return
    }
    // Re-frame only when the frameKey changes (i.e. a new mesh was loaded).
    // Topology edits (delete / merge / subdivide / fill / undo) keep the same
    // frameKey so the camera doesn't snap back to its initial framing.
    if (lastFramedKeyRef.current === frameKey) {
      return
    }
    lastFramedKeyRef.current = frameKey

    geometry.computeBoundingSphere()
    const sphere = geometry.boundingSphere
    const radius = Math.max(sphere?.radius || 1, 1)
    const center = sphere?.center || new THREE.Vector3()
    const distance = radius * 2.6
    const minDistance = Math.max(radius * 0.0025, 0.0005)
    const maxDistance = Math.max(radius * 24, 24)

    camera.position.set(center.x + distance, center.y + distance * 0.65, center.z + distance)

    Object.assign(camera, {
      near: Math.max(radius * 0.00005, 0.0001),
      far: Math.max(radius * 80, 4000),
      // An orthographic camera does not frame by distance — its frustum is fixed, so
      // the fit lives in `zoom` (pixels per world unit, given drei's pixel frustum).
      // The position above still matters: it is the eye the view direction and the
      // orbit radius come from.
      ...(camera.isOrthographicCamera
        ? { zoom: Math.abs(camera.top - camera.bottom) / Math.max(radius * FRAMED_SPHERE_SPAN, 1e-6) }
        : null)
    })
    camera.lookAt(center)
    camera.updateProjectionMatrix()

    if (controlsRef.current) {
      controlsRef.current.minDistance = minDistance
      controlsRef.current.maxDistance = maxDistance
      controlsRef.current.target.copy(center)
      controlsRef.current.update()
    }
  }, [camera, geometry, frameKey])

  // OrbitControls dollies an orthographic camera by changing `zoom`, never its
  // position, so the min/maxDistance clamps above do nothing there. Bound the zoom to
  // the same span of framings instead — otherwise a scroll runs to zoom 0 (an
  // infinitely wide view) or into the numeric weeds.
  useEffect(() => {
    const controls = controlsRef.current
    if (!controls) {
      return
    }
    if (!camera.isOrthographicCamera) {
      controls.minZoom = 0
      controls.maxZoom = Infinity
      return
    }
    geometry?.computeBoundingSphere?.()
    const radius = Math.max(geometry?.boundingSphere?.radius || 1, 1e-3)
    // Span chosen to cover the same range the perspective min/maxDistance clamps
    // allow (24 radii out to a fraction of one), so toggling projection at either
    // extreme of the dolly does not get clamped into a jump.
    const framed = Math.abs(camera.top - camera.bottom) / Math.max(radius * FRAMED_SPHERE_SPAN, 1e-6)
    controls.minZoom = framed / 16
    controls.maxZoom = framed * 2000
  }, [camera, geometry, size])

  useEffect(() => {
    if (!lockToCenter || !geometry || !controlsRef.current) {
      return
    }

    geometry.computeBoundingSphere()
    const center = geometry.boundingSphere?.center || new THREE.Vector3()
    controlsRef.current.target.copy(center)
    camera.lookAt(center)
    controlsRef.current.update()
  }, [camera, geometry, lockToCenter])

  return (
    <OrbitControls
      ref={controlsRef}
      makeDefault
      enabled={controlsEnabled}
      enableDamping
      enablePan={allowPan}
      minDistance={0.001}
      maxDistance={100}
      mouseButtons={{
        LEFT: null,
        MIDDLE: THREE.MOUSE.ROTATE,
        RIGHT: allowPan ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE
      }}
    />
  )
}
