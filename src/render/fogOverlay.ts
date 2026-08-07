import * as THREE from 'three';
import { EXPLORED_CONCEALMENT, type FogOfWarField } from '../ui/fogOfWar';
import type { VisibilityController } from '../ui/visibility';

export interface FogOverlay {
  update: () => void;
  dispose: () => void;
}

/**
 * Battlefield fog, drawn as one surface rather than thousands of tiles.
 *
 * The previous implementation instanced a flat quad per grid cell — up to 2,304
 * of them — each parked at the terrain height sampled at its own centre and
 * scaled 1.04× so neighbours overlapped. Over sloping ground that produced
 * exactly what it sounds like: a staircase of terraces, z-fighting along every
 * seam, and bright slivers of terrain punching through. At the distance the
 * game is actually played from it was the loudest thing on screen and it
 * overwrote the painterly direction entirely (B-004).
 *
 * Three changes, each removing a whole class of artefact:
 *
 * 1. **It shares the terrain's own geometry.** The fog is the same surface as
 *    the ground, lifted a hair, so it cannot step, cannot z-fight, and is
 *    already clipped to the map polygon for free.
 * 2. **The mask is a blurred scalar field sampled with linear filtering**, so
 *    there are no cell edges to see. Raising the grid resolution would not have
 *    fixed this — more, smaller squares are still squares.
 * 3. **Concealment drives colour and alpha together**, so remembered ground
 *    reads as a thin veil and unseen ground as a deep one, with a continuous
 *    gradient between rather than two flat tones meeting at a hard line.
 *
 * Cost went from up to two instanced draws over thousands of matrices rebuilt
 * every frame to one draw and one texture upload.
 */
export function createFogOverlay(
  scene: THREE.Scene,
  fog: FogOfWarField,
  visibility: VisibilityController,
  terrain: THREE.Mesh,
): FogOverlay {
  const { minX, minZ, width, depth } = fog.boundary.bounds;

  const data = new Uint8Array(fog.columns * fog.rows);
  const texture = new THREE.DataTexture(data, fog.columns, fog.rows, THREE.RedFormat);
  // Linear filtering is the whole point: the GPU interpolates between cells, so
  // a 48×48 mask reads as a smooth field instead of a 48×48 checkerboard.
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;

  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    // Shares vertices with the terrain, so bias in depth rather than in space —
    // lifting it in Y would make it float visibly on steep ground.
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    uniforms: {
      uFog: { value: texture },
      uOrigin: { value: new THREE.Vector2(minX, minZ) },
      uSize: { value: new THREE.Vector2(width, depth) },
      // Deep violet-blue, never black: D-005 is explicit that shadow shifts hue
      // rather than going to zero, and pure black reads as a missing texture.
      // Lifted from the previous values because the board now has to stay
      // legible as an object against the void — at war-table zoom an unexplored
      // map that matches the background simply disappears.
      uUnexplored: { value: new THREE.Color(0x232a45) },
      uExplored: { value: new THREE.Color(0x3d3f63) },
      uExploredAt: { value: EXPLORED_CONCEALMENT },
    },
    vertexShader: /* glsl */`
      varying vec2 vFogUv;
      uniform vec2 uOrigin;
      uniform vec2 uSize;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vFogUv = (world.xz - uOrigin) / uSize;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */`
      #include <common>

      varying vec2 vFogUv;
      uniform sampler2D uFog;
      uniform vec3 uUnexplored;
      uniform vec3 uExplored;
      uniform float uExploredAt;
      void main() {
        float concealment = texture2D(uFog, vFogUv).r;
        // Below the remembered level the veil lifts away completely, so ground
        // in sight is never tinted at all.
        float alpha = smoothstep(0.04, 1.0, concealment) * 0.9;
        if (alpha < 0.004) discard;
        float deep = smoothstep(uExploredAt, 1.0, concealment);
        gl_FragColor = vec4(mix(uExplored, uUnexplored, deep), alpha);

        // Without these the fog is written straight to the framebuffer while
        // every other surface goes through tone mapping and the linear-to-sRGB
        // conversion. The uniforms are linear-space (Three converts on Color
        // construction), so skipping this crushed a deep violet-blue to black —
        // which reads as a missing texture, loses the board's silhouette
        // against the void, and breaks D-005's "shadows shift hue, never go
        // to zero".
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });

  const mesh = new THREE.Mesh(terrain.geometry, material);
  mesh.renderOrder = 20;
  mesh.frustumCulled = false;
  scene.add(mesh);

  function update(): void {
    const active = visibility.mode === 'player';
    mesh.visible = active;
    if (!active) return;
    const concealment = fog.concealment();
    for (let i = 0; i < data.length; i++) data[i] = Math.round(concealment[i]! * 255);
    texture.needsUpdate = true;
  }

  return {
    update,
    dispose() {
      scene.remove(mesh);
      // The geometry belongs to the terrain, which is still using it.
      material.dispose();
      texture.dispose();
    },
  };
}
