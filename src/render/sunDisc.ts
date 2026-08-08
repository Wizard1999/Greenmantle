import * as THREE from 'three';
import type { SkyGlobals } from './painterly';

export interface SunDisc {
  update: (sky: SkyGlobals & { light: number }, camera: THREE.Camera) => void;
  dispose: () => void;
}

/**
 * The light source, made visible.
 *
 * The terrain casts shadows and the whole painterly model is built around a
 * warm key light, but nothing on screen ever said where that light was. Look up
 * and there was only void. This puts the sun where the light actually comes
 * from, so the shadows have a visible cause.
 *
 * **It cannot make anything harder to see, by construction.** Three properties
 * guarantee it rather than merely intending it:
 *
 * - `AdditiveBlending` only ever *adds* light to the framebuffer. There is no
 *   parameter here that can darken a pixel, so no unit, marker or panel can be
 *   dimmed or occluded by it.
 * - `depthWrite: false` with `depthTest: true` means it never writes into the
 *   depth buffer — nothing behind it is culled — while terrain in front of it
 *   still hides it correctly.
 * - It sits at a fixed offset from the camera along the sun direction, so it is
 *   always at effective infinity, never between the viewer and the board, and
 *   never inside the play area at any zoom.
 *
 * The glow is deliberately tight. A broad bloom would wash the battlefield at
 * the exact camera angles where the sun is behind the board, which is where
 * readability matters most.
 */
export function createSunDisc(scene: THREE.Scene): SunDisc {
  const texture = radialGlowTexture();
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    opacity: 0,
  });
  const sprite = new THREE.Sprite(material);
  // Behind everything else in the transparent queue, so it can never be the
  // thing drawn on top of a unit.
  sprite.renderOrder = -10;
  sprite.frustumCulled = false;
  scene.add(sprite);

  // Far enough to read as infinitely distant, comfortably inside the camera's
  // far plane (10000).
  const DISTANCE = 3600;
  const ANGULAR_SIZE = 0.055;
  const offset = new THREE.Vector3();

  return {
    update(sky, camera) {
      offset.copy(sky.sunDir).normalize().multiplyScalar(DISTANCE);
      sprite.position.copy(camera.position).add(offset);
      sprite.scale.setScalar(DISTANCE * ANGULAR_SIZE);
      material.color.copy(sky.sunColor);
      // Fades out with the light level, so it sets rather than blinking off,
      // and never glares at night when the board is already hardest to read.
      material.opacity = Math.max(0, Math.min(1, sky.light)) * 0.85;
      sprite.visible = material.opacity > 0.01;
    },
    dispose() {
      scene.remove(sprite);
      material.dispose();
      texture.dispose();
    },
  };
}

/**
 * A soft radial falloff, generated rather than loaded — an image file for this
 * would be a network request on the critical path of a browser game whose whole
 * premise is loading straight from a page (D-006).
 */
function radialGlowTexture(): THREE.Texture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const half = size / 2;
    const gradient = ctx.createRadialGradient(half, half, 0, half, half, half);
    // A small solid core with a quick falloff: the disc should read as a body
    // in the sky, not as a lens flare smeared across the board.
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.18, 'rgba(255,255,255,0.92)');
    gradient.addColorStop(0.34, 'rgba(255,255,255,0.30)');
    gradient.addColorStop(0.62, 'rgba(255,255,255,0.06)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}
