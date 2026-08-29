// Renders a skeleton as an overlay inside the mesh-editor <Canvas>: orange bone
// segments (parent→child) plus a dot at each joint, drawn on top of the mesh so
// the rig is visible through the surface (like a DCC armature view). Fed by the
// plain data from utils/meshEditor.js `extractSkeletonFromObject`.
//
// When a bone is selected (from the Skeleton tree or by clicking it on the mesh)
// it is highlighted with a bright marker and a small floating name label that
// tracks the joint as the camera orbits. `showNames` labels EVERY joint the same
// way (Auto Rig -> "Show bone names"), for reading a whole naming convention at a
// glance instead of clicking bones one by one.
import { useEffect, useMemo } from 'react'
import { Html } from '@react-three/drei'
import * as THREE from 'three'

// Exported so the animated overlay (AnimatedSkeletonOverlay) reads identically —
// the two draw the same rig, one at rest and one per frame.
export const BONE_COLOR = '#f0913c'
export const JOINT_COLOR = '#ffd9a0'
export const SELECTED_COLOR = '#8ff5ff'

export default function SkeletonOverlay({ skeleton, visible = true, selectedBone = null, showNames = false }) {
  const lineGeometry = useMemo(() => {
    if (!skeleton?.segments?.length) return null
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(skeleton.segments, 3))
    return geo
  }, [skeleton])

  const jointGeometry = useMemo(() => {
    if (!skeleton?.joints?.length) return null
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(skeleton.joints, 3))
    return geo
  }, [skeleton])

  // Size joint dots relative to the skeleton's extent so they read on any scale.
  const jointSize = useMemo(() => Math.max((skeleton?.size || 1) * 0.02, 1e-4), [skeleton])
  // The selection marker only has to read as a highlight. At the joint dots' own
  // size it swallowed its neighbours — a problem on dense chains like fingers,
  // where the bone you want to pick next is the one hidden underneath — and in
  // edit mode it engulfed the gizmo that lands on the same spot.
  const markerRadius = useMemo(() => Math.max((skeleton?.size || 1) * 0.007, 1e-4), [skeleton])

  // World position + name of the highlighted joint (if any).
  const selected = useMemo(() => {
    if (selectedBone == null || !skeleton?.joints) return null
    const i = selectedBone
    if (i < 0 || i * 3 + 2 >= skeleton.joints.length) return null
    return {
      position: [skeleton.joints[i * 3], skeleton.joints[i * 3 + 1], skeleton.joints[i * 3 + 2]],
      name: skeleton.names?.[i] || `bone_${i}`,
    }
  }, [selectedBone, skeleton])

  // Every other joint's label. The selected one is skipped — it already gets the
  // brighter label under its marker, and two labels on one joint just overlap.
  const labels = useMemo(() => {
    if (!showNames || !skeleton?.joints?.length) return null
    const out = []
    const count = Math.floor(skeleton.joints.length / 3)
    for (let i = 0; i < count; i++) {
      if (i === selectedBone) continue
      out.push({
        index: i,
        position: [skeleton.joints[i * 3], skeleton.joints[i * 3 + 1], skeleton.joints[i * 3 + 2]],
        name: skeleton.names?.[i] || `bone_${i}`,
      })
    }
    return out
  }, [showNames, skeleton, selectedBone])

  useEffect(() => () => {
    lineGeometry?.dispose()
    jointGeometry?.dispose()
  }, [lineGeometry, jointGeometry])

  if (!visible || (!lineGeometry && !jointGeometry)) return null

  return (
    <group renderOrder={40}>
      {lineGeometry && (
        <lineSegments geometry={lineGeometry} renderOrder={40}>
          <lineBasicMaterial
            color={BONE_COLOR}
            transparent
            opacity={0.95}
            depthTest={false}
            depthWrite={false}
          />
        </lineSegments>
      )}
      {jointGeometry && (
        <points geometry={jointGeometry} renderOrder={41}>
          <pointsMaterial
            color={JOINT_COLOR}
            size={jointSize}
            sizeAttenuation
            transparent
            opacity={1}
            depthTest={false}
            depthWrite={false}
          />
        </points>
      )}
      {labels?.map(label => (
        <Html
          key={label.index}
          position={label.position}
          center
          zIndexRange={[19, 0]}
          className="mesh-editor-bone-label__anchor"
        >
          <div className="mesh-editor-bone-label mesh-editor-bone-label--muted">{label.name}</div>
        </Html>
      ))}
      {selected && (
        <group position={selected.position} renderOrder={42}>
          <mesh renderOrder={42}>
            <sphereGeometry args={[markerRadius, 16, 16]} />
            <meshBasicMaterial
              color={SELECTED_COLOR}
              transparent
              opacity={0.95}
              depthTest={false}
              depthWrite={false}
            />
          </mesh>
          <Html center zIndexRange={[20, 0]} className="mesh-editor-bone-label__anchor">
            <div className="mesh-editor-bone-label">{selected.name}</div>
          </Html>
        </group>
      )}
    </group>
  )
}
