/**
 * Deterministic screenshot harness.
 *
 * The gauntlet requires critics to inspect the real running build, and a critic
 * cannot inspect what nobody can photograph. The in-editor browser surface
 * reports `document.hidden` and fires zero `requestAnimationFrame` callbacks, so
 * the render loop never runs and every capture comes back black — which is
 * indistinguishable, from the outside, from a game that is genuinely broken.
 * This drives a real Chromium instead.
 *
 * Two properties matter more than convenience:
 *
 *   1. **Reproducible.** Every shot names an exact camera state and an exact
 *      tick. Two runs of the same shot are comparable; "fly the camera around
 *      and grab a frame" is not, and `docs/PERFORMANCE_TESTING.md` already
 *      forbids it for the same reason.
 *   2. **The real game.** Shots are driven through `loop.stepOnce()` and the
 *      camera's own public methods — the same paths the sandbox and the mouse
 *      use. There is no capture-only render path that could look better than
 *      what a player gets.
 *
 * Usage:
 *   npm run capture                       # all shots, needs a dev server
 *   npm run capture -- --only=wartable    # one shot
 *   npm run capture -- --out=shots/round2 # somewhere else
 *   npm run capture -- --url=http://localhost:4173
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const args = new Map(
  process.argv.slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const [k, v = 'true'] = a.replace(/^--/, '').split('=');
      return [k, v];
    }),
);

const BASE = args.get('url') ?? 'http://localhost:5173';
const OUT = resolve(root, args.get('out') ?? '.capture');
const ONLY = args.get('only');
const WIDTH = Number(args.get('width') ?? 1920);
const HEIGHT = Number(args.get('height') ?? 1080);

/** 30 ticks per second (D-004). Naming shots in seconds keeps them readable. */
const TICK_HZ = 30;
const seconds = (s) => Math.round(s * TICK_HZ);

/**
 * The four distances the game is actually played at, plus the pages.
 *
 * `pitch`/`distance` are the camera's own units — see `src/render/cameraMath.ts`
 * `DEFAULT_CAMERA_LIMITS`. `atTick` is where the simulation is paused before the
 * shot, so the same shot always photographs the same game state.
 */
const SHOTS = [
  {
    name: 'miniature',
    note: 'Close inspection — unit silhouette, material, weathering.',
    url: `${BASE}/index.html?capture=1`,
    atTick: seconds(45),
    // `onBase` frames the player's Standard. Naming absolute coordinates here
    // silently pointed every shot at empty ground the moment the board grew
    // (D-038) — the pictures still looked like plausible screenshots, which is
    // exactly the failure mode this harness exists to avoid.
    camera: { onBase: true, yaw: 0.7, pitch: 0.36, distance: 9 },
  },
  {
    name: 'tactical',
    note: 'Ordinary play distance. This is the one that has to read.',
    url: `${BASE}/index.html?capture=1`,
    atTick: seconds(45),
    camera: { onBase: true, yaw: 0.4, pitch: 0.9, distance: 42 },
  },
  {
    name: 'overview',
    note: 'Whole-engagement read — formations, fog, threat.',
    url: `${BASE}/index.html?capture=1`,
    atTick: seconds(90),
    camera: { focusX: 0, focusZ: 0, yaw: 0.78, pitch: 1.22, distance: 150 },
  },
  {
    name: 'wartable',
    note: 'Maximum useful zoom — the board as an object, per D-014/D-026.',
    url: `${BASE}/index.html?capture=1`,
    atTick: seconds(90),
    camera: { focusX: 0, focusZ: 0, yaw: 0.78, pitch: 1.36, distance: 430 },
  },
  {
    name: 'hud-cold',
    note: 'What a first-time player sees on load, before touching anything.',
    url: `${BASE}/index.html?capture=1`,
    atTick: 0,
    camera: null,
  },
  { name: 'page-gauntlet', note: 'The live build-loop record.', url: `${BASE}/gauntlet.html`, page: true },
  { name: 'page-development', note: 'The public development page.', url: `${BASE}/development.html`, page: true },
];

async function capture(browser, shot) {
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();

  const problems = [];
  page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(String(e)));

  await page.goto(shot.url, { waitUntil: 'load', timeout: 60_000 });

  if (shot.page) {
    // Let the progress fetch land and the layout settle before shooting.
    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(600);
    const file = resolve(OUT, `${shot.name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    await context.close();
    return { ...shot, file, problems, state: null };
  }

  // The handle only exists with ?capture=1; if it never appears the build is
  // broken in a way worth failing loudly on rather than photographing.
  await page.waitForFunction('window.__greenmantle !== undefined', null, { timeout: 30_000 });

  const state = await page.evaluate(async ({ atTick, camera }) => {
    const g = window.__greenmantle;
    const frame = () => new Promise((done) => requestAnimationFrame(() => done()));

    // Pause first, then queue exact ticks: a paused loop still renders, so the
    // sim cannot drift between setting the camera and taking the picture.
    g.loop.setPaused(true);
    await frame();
    for (let i = g.world.tick; i < atTick; i++) g.loop.stepOnce();
    await frame();

    if (camera) {
      /*
       * Fly the camera the way a player does, then wait for it to arrive.
       *
       * Not a one-shot delta: `zoom()` feeds a damped velocity that is clamped
       * to +/-18 per frame, so a single large nudge silently under-travels — the
       * war-table shot asked for distance 430 and stopped at 104, and the
       * miniature shot overshot into the 2.5 floor. Both looked like plausible
       * screenshots, which is the dangerous part. Steer each frame until the
       * state actually converges, and report where it truly ended up.
       */
      const base = g.world.buildings.find((b) => b.team === 'player' && b.type === 'standard');
      const focusX = camera.onBase ? (base?.x ?? 0) : camera.focusX;
      const focusZ = camera.onBase ? (base?.z ?? 0) : camera.focusZ;
      g.cam.focusAt(focusX, focusZ);
      const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

      for (let i = 0; i < 600; i++) {
        const s = g.cam.state;
        const dDist = camera.distance - s.distance;
        const dYaw = wrap(camera.yaw - s.yaw);
        const dPitch = camera.pitch - s.pitch;
        if (Math.abs(dDist) < 0.4 && Math.abs(dYaw) < 0.004 && Math.abs(dPitch) < 0.004) break;

        // Invert each control's own scaling; the clamps then do the limiting.
        if (Math.abs(dDist) >= 0.4) {
          g.cam.zoom(dDist / Math.max(0.006, s.distance * 0.00065));
        }
        if (Math.abs(dYaw) >= 0.004 || Math.abs(dPitch) >= 0.004) {
          g.cam.orbit(-dYaw / 0.006, dPitch / 0.004);
        }
        await frame();
      }
    }

    // Let residual zoom velocity bleed off so the frame is not mid-glide.
    let previous = -1;
    for (let i = 0; i < 120; i++) {
      await frame();
      const d = g.cam.state.distance;
      if (Math.abs(d - previous) < 0.01) break;
      previous = d;
    }
    for (let i = 0; i < 3; i++) await frame();

    const c = g.cam.state;
    return {
      tick: g.world.tick,
      units: g.world.units.length,
      buildings: g.world.buildings.length,
      camera: {
        focusX: +c.focusX.toFixed(2), focusZ: +c.focusZ.toFixed(2),
        yaw: +c.yaw.toFixed(3), pitch: +c.pitch.toFixed(3), distance: +c.distance.toFixed(1),
      },
      quality: g.quality.tier,
      drawCalls: g.renderer.info.render.calls,
      triangles: g.renderer.info.render.triangles,
    };
  }, { atTick: shot.atTick, camera: shot.camera });

  const file = resolve(OUT, `${shot.name}.png`);
  await page.screenshot({ path: file });
  await context.close();
  return { ...shot, file, problems, state };
}

const wanted = ONLY ? SHOTS.filter((s) => s.name === ONLY) : SHOTS;
if (!wanted.length) {
  console.error(`No shot named "${ONLY}". Available: ${SHOTS.map((s) => s.name).join(', ')}`);
  process.exit(1);
}

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({
  args: [
    // Headless Chromium falls back to SwiftShader for WebGL; these keep it from
    // refusing outright on machines without a usable GPU path.
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--disable-lcd-text',
  ],
});

const results = [];
let failed = 0;
for (const shot of wanted) {
  process.stdout.write(`  ${shot.name} … `);
  try {
    const result = await capture(browser, shot);
    results.push(result);
    const bad = result.problems.length;
    if (bad) failed++;
    console.log(
      result.state
        ? `tick ${result.state.tick}, ${result.state.units} units, `
          + `d=${result.state.camera.distance}, ${result.state.drawCalls} draws`
          + (bad ? ` — ${bad} CONSOLE ERROR(S)` : '')
        : `page${bad ? ` — ${bad} CONSOLE ERROR(S)` : ''}`,
    );
    for (const problem of result.problems.slice(0, 3)) console.log(`      ! ${problem}`);
  } catch (error) {
    failed++;
    console.log(`FAILED — ${String(error).split('\n')[0]}`);
    results.push({ ...shot, file: null, problems: [String(error)], state: null });
  }
}
await browser.close();

// An index beside the images, so a critic reading them later knows exactly what
// each one is and what state produced it rather than inferring from a filename.
await writeFile(
  resolve(OUT, 'index.json'),
  `${JSON.stringify({
    base: BASE,
    viewport: [WIDTH, HEIGHT],
    shots: results.map(({ name, note, file, state, problems }) => ({ name, note, file, state, problems })),
  }, null, 2)}\n`,
);

console.log(`\n${results.length - failed}/${results.length} clean → ${OUT}`);
process.exit(failed ? 1 : 0);
