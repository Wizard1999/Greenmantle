import * as THREE from 'three';
import {
  cameraOffset, clampCameraState, distanceToFrameBoard, panDelta, smoothedFocusHeight,
  type CameraState,
} from './cameraMath';
import { terrainHeightAt } from '../sim/terrain';
import type { MapBoundary } from '../sim/mapBoundary';

export interface RtsCamera {
  camera: THREE.PerspectiveCamera;
  target: THREE.Vector3;
  state: Readonly<CameraState>;
  /** Vertical FOV in radians plus viewport aspect. Exposed so views that need
   *  the camera's ground coverage — the minimap viewport rectangle — can compute
   *  it from plain numbers rather than reaching into the Three camera. */
  lens: Readonly<{ fov: number; aspect: number }>;
  pan: (realDt: number, keys: Record<string, boolean>, mouseX: number, mouseY: number) => void;
  zoom: (deltaY: number, clientX?: number, clientY?: number) => void;
  orbit: (deltaX: number, deltaY: number) => void;
  frameBoard: () => void;
  focusAt: (x: number, z: number) => void;
  update: () => void;
  onResize: () => void;
}

export function createCamera(terrain?: THREE.Object3D, boundary?: MapBoundary): RtsCamera {
  // The table exists in a black void, so there is no atmospheric render cutoff.
  // A large far plane keeps the complete board and eventual World Turtle visible
  // even when the viewer pulls far outside the authored play surface.
  const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.05, 10000);
  const target = new THREE.Vector3();
  let state: CameraState = {
    focusX: -12,
    focusZ: 7,
    yaw: 0,
    pitch: THREE.MathUtils.degToRad(52),
    distance: 40,
  };
  let panVelocityX = 0;
  let panVelocityZ = 0;
  let zoomVelocity = 0;
  let zoomAnchor: { ndc: THREE.Vector2; world: THREE.Vector3 } | null = null;
  const raycaster = new THREE.Raycaster();
  const fallbackGroundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  function syncCamera(): void {
    // A single static near plane either clips miniature-level inspection or
    // wastes depth precision at cosmological zoom. Scale it conservatively with
    // distance while always preserving close tabletop inspection.
    const desiredNear = THREE.MathUtils.clamp(state.distance / 1800, 0.025, 0.35);
    if (Math.abs(camera.near - desiredNear) > 0.002) {
      camera.near = desiredNear;
      camera.updateProjectionMatrix();
    }
    // Smoothed, not raw: the raw ground height under the focus makes the camera
    // bob over terrain ripple. See `smoothedFocusHeight`.
    target.set(
      state.focusX,
      smoothedFocusHeight(terrainHeightAt, state.focusX, state.focusZ, state.distance),
      state.focusZ,
    );
    const offset = cameraOffset(state);
    // All three axes relative to the target. `offset.y` was previously used as
    // an absolute world height while x and z were relative, so any change in the
    // target's height re-aimed the camera instead of moving it — the horizon
    // rocked rather than the view rising.
    camera.position.set(target.x + offset.x, target.y + offset.y, target.z + offset.z);
    camera.lookAt(target);
    camera.updateMatrixWorld();
  }

  function groundAt(ndc: THREE.Vector2): THREE.Vector3 | null {
    raycaster.setFromCamera(ndc, camera);
    if (terrain) {
      const hit = raycaster.intersectObject(terrain, false)[0];
      if (hit) return hit.point.clone();
    }
    return raycaster.ray.intersectPlane(fallbackGroundPlane, new THREE.Vector3());
  }

  function update(): void {
    if (Math.abs(zoomVelocity) > 0.001) {
      state.distance += zoomVelocity;
      zoomVelocity *= 0.72;
    } else {
      zoomVelocity = 0;
      zoomAnchor = null;
    }
    state = clampCameraState(state);
    syncCamera();

    // Preserve the ground point beneath the cursor while the smooth zoom settles.
    if (zoomAnchor) {
      const current = groundAt(zoomAnchor.ndc);
      if (current) {
        state.focusX += zoomAnchor.world.x - current.x;
        state.focusZ += zoomAnchor.world.z - current.z;
        state = clampCameraState(state);
        syncCamera();
      }
    }
  }

  function frameBoard(): void {
    const desired = distanceToFrameBoard(
      boundary?.bounds.width ?? 80,
      boundary?.bounds.depth ?? 80,
      THREE.MathUtils.degToRad(camera.fov),
      camera.aspect,
    );
    state = clampCameraState({
      focusX: 0,
      focusZ: 0,
      yaw: THREE.MathUtils.degToRad(45),
      pitch: THREE.MathUtils.degToRad(78),
      distance: desired,
    });
    panVelocityX = 0;
    panVelocityZ = 0;
    zoomVelocity = 0;
    zoomAnchor = null;
    syncCamera();
  }

  function pan(realDt: number, keys: Record<string, boolean>, mouseX: number, mouseY: number): void {
    let right = 0;
    let forward = 0;
    if (keys['w']) forward += 1;
    if (keys['s']) forward -= 1;
    if (keys['a']) right -= 1;
    if (keys['d']) right += 1;

    const edge = 18;
    if (mouseX < edge) right -= 1;
    if (mouseX > window.innerWidth - edge) right += 1;
    if (mouseY < edge) forward += 1;
    if (mouseY > window.innerHeight - edge) forward -= 1;

    const desired = panDelta(state.yaw, right, forward, state.distance);
    const acceleration = Math.min(1, realDt * 14);
    panVelocityX += (desired.x * 15 - panVelocityX) * acceleration;
    panVelocityZ += (desired.z * 15 - panVelocityZ) * acceleration;
    if (!right && !forward) {
      const damping = Math.max(0, 1 - realDt * 10);
      panVelocityX *= damping;
      panVelocityZ *= damping;
    }
    state.focusX += panVelocityX * realDt;
    state.focusZ += panVelocityZ * realDt;
    state = clampCameraState(state);
  }

  return {
    camera,
    target,
    get state() { return state; },
    get lens() {
      return { fov: THREE.MathUtils.degToRad(camera.fov), aspect: camera.aspect };
    },
    pan,
    zoom: (deltaY: number, clientX?: number, clientY?: number) => {
      if (clientX !== undefined && clientY !== undefined) {
        syncCamera();
        const ndc = new THREE.Vector2(
          (clientX / window.innerWidth) * 2 - 1,
          -(clientY / window.innerHeight) * 2 + 1,
        );
        const world = groundAt(ndc);
        if (world) zoomAnchor = { ndc, world };
      }
      zoomVelocity += deltaY * Math.max(0.006, state.distance * 0.00065);
      zoomVelocity = THREE.MathUtils.clamp(zoomVelocity, -18, 18);
    },
    frameBoard,
    focusAt: (x: number, z: number) => {
      state.focusX = x;
      state.focusZ = z;
      panVelocityX = 0;
      panVelocityZ = 0;
      zoomAnchor = null;
      state = clampCameraState(state);
      syncCamera();
    },
    orbit: (deltaX: number, deltaY: number) => {
      state.yaw -= deltaX * 0.006;
      state.pitch += deltaY * 0.004;
      state = clampCameraState(state);
    },
    update,
    onResize: () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
    },
  };
}
