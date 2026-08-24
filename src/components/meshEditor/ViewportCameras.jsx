import { useEffect, useRef } from 'react'
import { useThree } from '@react-three/fiber'
import { OrthographicCamera, PerspectiveCamera } from '@react-three/drei'
import * as THREE from 'three'
import { viewWorldHeightAt } from '../../utils/cameraViewport'

// The viewport's two cameras. BOTH stay mounted at all times; `makeDefault` is what
// decides which one R3F hands to CameraRig's OrbitControls, to every raycast, and to
// the projection bakes. Mounting them conditionally instead would drop R3F back to
// its own built-in camera for the commit in between, which loses the framing and
// leaves `cameraRef` pointing at a camera nothing controls.
//
// Switching carries the view across so nothing jumps: same eye position and
// orientation, and a zoom (or, going the other way, a distance) chosen to show the
// same world height at the orbit target.
export default function ViewportCameras({ orthographic }) {
  const perspectiveRef = useRef(null)
  const orthographicRef = useRef(null)
  const size = useThree(state => state.size)
  const controls = useThree(state => state.controls)
  // Which projection the carry-over below last ran for. `null` until the first pass,
  // so the initial mount leaves CameraRig's framing alone.
  const appliedRef = useRef(null)

  useEffect(() => {
    const perspective = perspectiveRef.current
    const ortho = orthographicRef.current
    if (!perspective || !ortho) {
      return
    }
    if (appliedRef.current === orthographic) {
      return
    }
    const first = appliedRef.current === null
    appliedRef.current = orthographic
    if (first) {
      return
    }

    const from = orthographic ? perspective : ortho
    const to = orthographic ? ortho : perspective
    const target = controls?.target ? controls.target.clone() : new THREE.Vector3()

    to.position.copy(from.position)
    to.up.copy(from.up)
    to.near = from.near
    to.far = from.far

    // How much of the world the outgoing camera showed at the orbit target.
    const distance = Math.max(from.position.distanceTo(target), 1e-6)
    const worldHeight = Math.max(viewWorldHeightAt(from, distance), 1e-6)

    if (to.isOrthographicCamera) {
      to.zoom = Math.abs(to.top - to.bottom) / worldHeight
    } else {
      // A perspective camera shows that height at exactly one distance — go there,
      // along the direction it is already looking from.
      const fovRad = THREE.MathUtils.degToRad(to.fov || 50)
      const fitted = worldHeight / (2 * Math.tan(fovRad / 2))
      const direction = new THREE.Vector3().subVectors(to.position, target)
      if (direction.lengthSq() < 1e-12) {
        direction.set(0, 0, 1)
      }
      to.position.copy(target).addScaledVector(direction.normalize(), Math.max(fitted, 1e-4))
    }

    to.lookAt(target)
    to.updateProjectionMatrix()
    to.updateMatrixWorld(true)
    controls?.update?.()
  }, [orthographic, controls, size])

  return (
    <>
      <PerspectiveCamera
        ref={perspectiveRef}
        makeDefault={!orthographic}
        position={[3, 3, 5]}
        near={0.0001}
        far={4000}
      />
      {/* No `zoom` prop on purpose: zoom is set imperatively (here and in CameraRig's
          framing pass), and a declared prop would be re-applied over it. drei sizes
          the frustum in pixels, so zoom ends up as "pixels per world unit". */}
      <OrthographicCamera
        ref={orthographicRef}
        makeDefault={orthographic}
        position={[3, 3, 5]}
        near={0.0001}
        far={4000}
      />
    </>
  )
}
