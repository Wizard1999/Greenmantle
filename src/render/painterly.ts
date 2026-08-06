import * as THREE from 'three';
import type { HuePath } from './palette';
import { LIGHT } from './palette';

/**
 * The painterly light model.
 *
 * Adapted from the shading core of the designer's Ghibli reference scene. The
 * expensive parts of that scene (per-blade grass, planar reflections, a full
 * post chain) are deliberately not here — at a far, top-down RTS camera they
 * buy little and they are exactly what breaks the "runs on any machine"
 * requirement. What *does* carry the look is this shader, and it is cheap:
 *
 *   - a three-colour hue path rather than one colour lit and darkened
 *   - half-lambert wrap, so a low sun doesn't dump the world into shade
 *   - soft-but-visible bands, jittered so they don't read as machined
 *   - shadows that shift hue instead of going black
 *   - hemispheric ambient normalised to unit luminance, so it tints and never
 *     bleaches
 *   - a backlight rim, which is what stops silhouettes reading as flat
 *
 * It is built on Three's own lighting/shadow/fog chunks so shadow maps, fog and
 * tone mapping all keep working normally.
 */

const VERT = /* glsl */`
#include <common>
#include <shadowmap_pars_vertex>
#include <fog_pars_vertex>

varying vec3 vWPos;
varying vec3 vWNormal;

void main() {
  #include <beginnormal_vertex>
  #include <begin_vertex>
  #include <defaultnormal_vertex>
  #include <project_vertex>
  #include <worldpos_vertex>
  #include <shadowmap_vertex>
  #include <fog_vertex>

  vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
  vWNormal = normalize(mat3(modelMatrix) * objectNormal);
}
`;

const FRAG = /* glsl */`
#include <common>
#include <packing>
#include <fog_pars_fragment>
#include <bsdfs>
#include <lights_pars_begin>
#include <shadowmap_pars_fragment>
#include <shadowmask_pars_fragment>

uniform vec3  uShade, uMid, uLit;
uniform vec3  uSunDir, uSunColor, uSkyColor, uGroundColor;
uniform float uSoft, uRim, uJitter, uAmbient;
uniform float uCloudAmount, uCloudScale, uCloudSoft;
uniform vec2  uCloudOffset;
uniform float uOpacity;

varying vec3 vWPos;
varying vec3 vWNormal;

// Three-colour hue path. Transitions are soft but deliberately still visible —
// that banding is most of what separates "painted" from "rendered".
vec3 ramp3(float t, vec3 shade, vec3 mid, vec3 lit, float soft, float jit) {
  float a = smoothstep(0.17 - soft + jit, 0.17 + soft + jit, t);
  float b = smoothstep(0.58 - soft + jit, 0.58 + soft + jit, t);
  return mix(mix(shade, mid, a), lit, b);
}

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

// Value noise, two octaves. Only ever used for slow drifting cloud cover, so
// cheapness matters far more than quality here.
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i), b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0)), d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float cloudShadow(vec2 world) {
  if (uCloudAmount <= 0.001) return 1.0;
  vec2 p = world * uCloudScale + uCloudOffset;
  float n = vnoise(p) * 0.65 + vnoise(p * 2.13 + 7.1) * 0.35;
  float s = smoothstep(0.5 - uCloudSoft, 0.5 + uCloudSoft, n);
  return mix(1.0, s, uCloudAmount);
}

void main() {
  vec3 N = normalize(vWNormal);
  vec3 V = normalize(cameraPosition - vWPos);

  float shadow = getShadowMask() * cloudShadow(vWPos.xz);

  float ndl = dot(N, uSunDir);
  // Half-lambert. A low sun grazes flat ground; plain Lambert would drop the
  // whole map into the shade band and golden hour would read as dusk.
  float wrap = clamp(ndl * 0.62 + 0.46, 0.0, 1.0);

  // Wobble the band edges so they follow the surface rather than the maths.
  float jit = (hash21(floor(vWPos.xz * 7.0)) - 0.5) * uJitter;

  float t = wrap * mix(0.34, 1.0, shadow);
  vec3 col = ramp3(t, uShade, uMid, uLit, uSoft, jit);

  float litAmt = smoothstep(0.34, 0.86, t);
  col *= mix(vec3(0.94), uSunColor * 1.28, litAmt * 0.62);

  // Shadows change hue; they never go black.
  col = mix(col * 0.82 + uSkyColor * 0.045, col, shadow * 0.82 + 0.18);

  // Ambient TINTS rather than washes: normalising to unit luminance lets it
  // rotate hue (cool from sky, warm from ground bounce) without bleaching.
  vec3 hemi = mix(uGroundColor, uSkyColor, N.y * 0.5 + 0.5);
  float lum = max(dot(hemi, vec3(0.2126, 0.7152, 0.0722)), 1e-3);
  col *= mix(vec3(1.0), hemi / lum, 0.24 * uAmbient * (1.0 - litAmt * 0.55));
  col += hemi * 0.055 * uAmbient * (1.0 - litAmt * 0.85);

  // Backlight rim — the connective tissue of the whole image.
  float back = smoothstep(0.05, 0.85, dot(V, -uSunDir));
  float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 4.2);
  col += uSunColor * (fres * back * uRim * shadow);

  gl_FragColor = vec4(col, uOpacity);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

export interface PainterlyOptions {
  /** Band softness. Higher is smoother/more BOTW, lower is more cel. */
  soft?: number;
  /** Backlight rim strength. */
  rim?: number;
  /** Band-edge wobble. */
  jitter?: number;
  ambient?: number;
  opacity?: number;
  transparent?: boolean;
  side?: THREE.Side;
}

/**
 * Facet a geometry so each triangle shades flat.
 *
 * Deliberately geometry-level rather than `material.flatShading`. Three
 * implements that flag by recomputing the normal per-fragment with dFdx/dFdy
 * inside `<normal_fragment_begin>` — a chunk this shader does not include,
 * because it carries its own world-space normal through a varying. Setting the
 * flag on a painterly material is therefore a silent no-op. Splitting the
 * vertices works regardless of shader.
 */
export function facet(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const out = geo.index ? geo.toNonIndexed() : geo;
  out.computeVertexNormals();
  return out;
}

/** Every painterly material made so far, so per-frame globals (cloud drift)
 *  can be pushed to all of them in one pass. */
const registry: THREE.ShaderMaterial[] = [];

export function createPainterlyMaterial(
  path: HuePath, opts: PainterlyOptions = {},
): THREE.ShaderMaterial {
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    lights: true,
    fog: true,
    transparent: opts.transparent ?? false,
    side: opts.side ?? THREE.FrontSide,
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib['lights'],
      THREE.UniformsLib['fog'],
      {
        uShade: { value: path.shade.clone() },
        uMid: { value: path.mid.clone() },
        uLit: { value: path.lit.clone() },
        uSunDir: { value: LIGHT.sunDir.clone() },
        uSunColor: { value: LIGHT.sun.clone() },
        uSkyColor: { value: LIGHT.sky.clone() },
        uGroundColor: { value: LIGHT.ground.clone() },
        uSoft: { value: opts.soft ?? 0.14 },
        uRim: { value: opts.rim ?? 0.55 },
        uJitter: { value: opts.jitter ?? 0.05 },
        uAmbient: { value: opts.ambient ?? 1 },
        uOpacity: { value: opts.opacity ?? 1 },
        uCloudAmount: { value: 0 },
        uCloudScale: { value: 0.012 },
        uCloudSoft: { value: 0.14 },
        uCloudOffset: { value: new THREE.Vector2() },
      },
    ]),
  });
  registry.push(mat);
  return mat;
}

/** Recolour an existing painterly material (team swaps, paused build sites). */
export function setHuePath(mat: THREE.ShaderMaterial, path: HuePath): void {
  (mat.uniforms['uShade']?.value as THREE.Color).copy(path.shade);
  (mat.uniforms['uMid']?.value as THREE.Color).copy(path.mid);
  (mat.uniforms['uLit']?.value as THREE.Color).copy(path.lit);
}

export function setOpacity(mat: THREE.ShaderMaterial, value: number): void {
  const u = mat.uniforms['uOpacity'];
  if (u) u.value = value;
}

const CLOUD_DRIFT_X = 0.0065;
const CLOUD_DRIFT_Z = 0.0032;

/**
 * Where the cloud-shadow field has drifted to after `elapsedSeconds`.
 *
 * Bounded on purpose. `hash21` opens with `fract(p * vec2(123.34, 456.21))`,
 * and a float32 carries roughly seven significant digits — so once the offset
 * reaches the thousands, that multiply lands near 1e6 and `fract()` has almost
 * no fractional bits left to return. The hash then yields quantised noise that
 * reshuffles every frame, and the whole ground flickers.
 *
 * That is not hypothetical: this was called with `performance.now()` in
 * *milliseconds* while the drift constants assume *seconds*, so the offset
 * passed 1e2 within seconds of page load and the ground pulsed continuously.
 * Seconds keep an hour-long match under 25; the wrap keeps a tab left open
 * overnight from ever reaching the precision cliff.
 */
export function cloudOffset(elapsedSeconds: number): { x: number; z: number } {
  const wrap = 4096;
  return {
    x: (elapsedSeconds * CLOUD_DRIFT_X) % wrap,
    z: (elapsedSeconds * CLOUD_DRIFT_Z) % wrap,
  };
}

/** Cloud shadows drifting across the ground: one of the strongest Ghibli
 *  signals available, and it costs two noise lookups.
 *
 *  `elapsedSeconds` is **seconds**, not milliseconds — see `cloudOffset`. */
export function updatePainterlyGlobals(
  elapsedSeconds: number, cloudAmount: number, sky?: SkyGlobals,
): void {
  const drift = cloudOffset(elapsedSeconds);
  for (const mat of registry) {
    const amt = mat.uniforms['uCloudAmount'];
    const off = mat.uniforms['uCloudOffset'];
    if (amt) amt.value = cloudAmount;
    if (off) (off.value as THREE.Vector2).set(drift.x, drift.z);
    if (!sky) continue;
    // Every painterly surface reads the same sun, so the whole world turns
    // over together rather than each material drifting on its own schedule.
    (mat.uniforms['uSunDir']?.value as THREE.Vector3 | undefined)?.copy(sky.sunDir);
    (mat.uniforms['uSunColor']?.value as THREE.Color | undefined)?.copy(sky.sunColor);
    (mat.uniforms['uSkyColor']?.value as THREE.Color | undefined)?.copy(sky.skyColor);
    (mat.uniforms['uGroundColor']?.value as THREE.Color | undefined)?.copy(sky.groundColor);
  }
}

/** The subset of the sky cycle the shading model needs. */
export interface SkyGlobals {
  sunDir: THREE.Vector3;
  sunColor: THREE.Color;
  skyColor: THREE.Color;
  groundColor: THREE.Color;
}
