/**
 * Re-runs the slice-0 baseline measurement against the running build.
 *
 * Same method as slide0-before.json: getBoundingClientRect + getComputedStyle
 * for every non-canvas, non-script child of <body>. No judgement in the output.
 *
 *   node measure-hud.mjs                       # default 3 viewports
 *   node measure-hud.mjs --dismiss             # dismiss first-run guide first
 */
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';

const args = new Map(process.argv.slice(2).filter(a => a.startsWith('--')).map(a => {
  const [k, v = 'true'] = a.replace(/^--/, '').split('=');
  return [k, v];
}));
const BASE = args.get('url') ?? 'http://localhost:5173';
const PATHQ = args.get('q') ?? '';
const DISMISS = args.has('dismiss');
const OUT = args.get('out');

/* The three supported sizes, plus the odd viewport the slice-0 baseline was
   captured at — kept so the headline 49.4% has a like-for-like successor. */
const VIEWPORTS = [[1920, 1080], [1366, 768], [1280, 800], [1237, 604]];

const MEASURE = () => {
  const vw = window.innerWidth, vh = window.innerHeight;
  const panels = [];
  for (const node of Array.from(document.body.children)) {
    if (!(node instanceof HTMLElement)) continue;
    const tag = node.tagName.toLowerCase();
    if (tag === 'canvas' || tag === 'script') continue;
    const r = node.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const cs = getComputedStyle(node);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    panels.push({
      id: node.id || `<${tag}>`,
      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
      z: cs.zIndex, pe: cs.pointerEvents,
      bg: cs.backgroundColor,
      font: cs.fontFamily.split(',')[0].replace(/["']/g, '').trim(),
      buttons: node.querySelectorAll('button, select, input, [onclick]').length,
    });
  }

  const area = panels.reduce((s, p) => s + p.w * p.h, 0);
  const overlaps = [];
  for (let i = 0; i < panels.length; i++) {
    for (let j = i + 1; j < panels.length; j++) {
      const a = panels[i], b = panels[j];
      const ow = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const oh = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (ow > 0 && oh > 0) overlaps.push({ a: a.id, b: b.id, areaPx: ow * oh });
    }
  }

  // A panel that owns controls but refuses pointer events is a dead control.
  const deadPanels = panels.filter(p => p.buttons > 0 && p.pe === 'none').map(p => p.id);

  // The defect that started this: is the research panel's centre actually the
  // research panel, or does the click land on the battlefield?
  const hitTest = {};
  for (const p of panels) {
    if (!p.buttons) continue;
    const hit = document.elementFromPoint(p.x + p.w / 2, p.y + p.h / 2);
    hitTest[p.id] = hit ? (hit.closest('[id]')?.id || hit.tagName.toLowerCase()) : 'null';
  }
  // Every real button, individually: does a click at its centre reach it?
  const buttons = [];
  for (const b of Array.from(document.querySelectorAll('button, select, input'))) {
    const r = b.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    buttons.push({
      label: (b.id || b.textContent || b.tagName).trim().slice(0, 28),
      reachable: hit === b || (hit instanceof Node && b.contains(hit)),
    });
  }

  return {
    viewport: [vw, vh],
    panels: panels.length,
    hudScreenSharePct: +((area / (vw * vh)) * 100).toFixed(1),
    zIndexesDeclared: panels.filter(p => p.z !== 'auto').length,
    distinctBackgrounds: [...new Set(panels.map(p => p.bg))],
    distinctFonts: [...new Set(panels.map(p => p.font))],
    panelsWithButtonsButNoPointerEvents: deadPanels,
    overlappingPairs: overlaps.sort((a, b) => b.areaPx - a.areaPx),
    hitTest,
    unreachableButtons: buttons.filter(b => !b.reachable).map(b => b.label),
    buttonsChecked: buttons.length,
    panelGeometry: panels,
  };
};

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const out = [];
for (const [width, height] of VIEWPORTS) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.goto(`${BASE}/index.html?capture=1${PATHQ}`, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForFunction('window.__greenmantle !== undefined', null, { timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(1200);
  if (DISMISS) {
    await page.evaluate(() => {
      const skip = document.getElementById('tutorial-skip');
      if (skip) skip.click();
    });
    await page.waitForTimeout(200);
  }
  const result = await page.evaluate(MEASURE);
  out.push(result);
  console.log(`\n=== ${width}x${height}${DISMISS ? ' (guide dismissed)' : ''} ===`);
  console.log(`panels ${result.panels} · hud share ${result.hudScreenSharePct}% · z declared ${result.zIndexesDeclared}/${result.panels}`);
  console.log(`backgrounds ${result.distinctBackgrounds.length}: ${result.distinctBackgrounds.join(' | ')}`);
  console.log(`fonts: ${result.distinctFonts.join(' | ')}`);
  console.log(`dead-control panels: ${JSON.stringify(result.panelsWithButtonsButNoPointerEvents)}`);
  console.log(`overlaps: ${result.overlappingPairs.length} ${JSON.stringify(result.overlappingPairs)}`);
  console.log(`hit test: ${JSON.stringify(result.hitTest)}`);
  console.log(`unreachable buttons ${result.unreachableButtons.length}/${result.buttonsChecked}: ${JSON.stringify(result.unreachableButtons)}`);
  await context.close();
}
await browser.close();
if (OUT) await writeFile(OUT, `${JSON.stringify(out, null, 2)}\n`);
