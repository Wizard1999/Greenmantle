import './site.css';

type Phase = {
  name: string;
  status: string;
  completion: number;
  benchmark: string;
};

/**
 * A summary of the gauntlet from `docs/WORKLOG.md` — the full record lives on
 * `/gauntlet.html`. Only the fields this page shows are declared; the rest of
 * the payload is that page's business. Text fields arrive as inline HTML from
 * the sync script, which escapes before it formats.
 */
type Worklog = {
  round: string;
  state: string;
  scope: string;
  pieces: { title: string; bar: string; status: string }[];
};

type Verification = { tests: number; passed: number; files: number; green: boolean };

type ProgressData = {
  overall: number;
  updated: string;
  currentWork: string[];
  phases: Phase[];
  milestones: string[];
  worklog: Worklog | null;
  verification: Verification | null;
  roadmapHtml: string;
};

const art = {
  'war-table': new URL('../docs/assets/concept-art/war-table-camera-concept.webp', import.meta.url).href,
  contested: new URL('../docs/assets/concept-art/contested-ground.webp', import.meta.url).href,
  cohort: new URL('../docs/assets/concept-art/cohort-legionnaire.webp', import.meta.url).href,
  marksman: new URL('../docs/assets/concept-art/cohort-marksman.webp', import.meta.url).href,
  standard: new URL('../docs/assets/concept-art/cohort-standard-main-base.webp', import.meta.url).href,
  worker: new URL('../docs/assets/concept-art/cohort-worker-recovering-legacy.webp', import.meta.url).href,
  conclave: new URL('../docs/assets/concept-art/conclave-ritual.webp', import.meta.url).href,
  mycora: new URL('../docs/assets/concept-art/mycora-spread-battlefield.webp', import.meta.url).href,
  'mycora-structures': new URL('../docs/assets/concept-art/mycora-spread-structures.webp', import.meta.url).href,
  titanfolk: new URL('../docs/assets/concept-art/titanfolk-creature.webp', import.meta.url).href,
} as const;

/**
 * Stamp every piece of art as concept art, at the one place art is injected.
 *
 * None of these images are in-game footage — they are AI-generated exploration
 * of the design language. A visitor scrolling a hero image has no way to know
 * that unless the page says so, and letting them assume otherwise would
 * misrepresent how far along the game actually is.
 *
 * Done here rather than in the markup deliberately: a caption written by hand
 * is one someone forgets when adding the next image. Labelling at the injection
 * point means unlabelled art is not possible.
 */
for (const image of document.querySelectorAll<HTMLImageElement>('[data-art]')) {
  const key = image.dataset.art as keyof typeof art;
  if (!(key in art)) continue;
  image.src = art[key];

  // Purely decorative backdrops are aria-hidden and carry no alt text; badging
  // them would add visual noise without informing anyone.
  if (image.getAttribute('aria-hidden') === 'true') continue;

  image.title = 'Concept art — not in-game footage';
  if (image.alt && !/concept art/i.test(image.alt)) {
    image.alt = `Concept art: ${image.alt}`;
  }

  const host = image.closest('figure') ?? image.parentElement;
  if (!host || host.querySelector('.concept-badge')) continue;
  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
  const badge = document.createElement('span');
  badge.className = 'concept-badge';
  badge.textContent = 'Concept art';
  host.appendChild(badge);
}

const fallback: ProgressData = {
  overall: 23,
  updated: '2026-07-27',
  currentWork: [
    'Selection reliability at extreme camera angles',
    'Expanded developer sandbox diagnostics',
    'Attack and invalid-command feedback',
  ],
  phases: [],
  milestones: [],
  worklog: null,
  verification: null,
  roadmapHtml: '<p>The full roadmap could not be loaded. Open <code>docs/ROADMAP.md</code> in the repository.</p>',
};

function renderProgress(data: ProgressData): void {
  const overall = Math.max(0, Math.min(100, data.overall));
  // All of them: the figure appears in the hero stats and again in the progress
  // panel, and querySelector would silently update only the first.
  const numbers = document.querySelectorAll<HTMLElement>('[data-progress-number]');
  const fill = document.querySelector<HTMLElement>('[data-progress-fill]');
  const track = document.querySelector<HTMLElement>('[data-progress-track]');
  const date = document.querySelector<HTMLTimeElement>('[data-progress-date]');
  for (const el of numbers) el.textContent = String(overall);
  if (fill) fill.style.width = `${overall}%`;
  if (track) track.setAttribute('aria-valuenow', String(overall));
  if (date) {
    date.textContent = data.updated;
    date.dateTime = data.updated;
  }

  const work = document.querySelector<HTMLOListElement>('[data-current-work]');
  if (work && data.currentWork.length) {
    work.replaceChildren(...data.currentWork.map((item) => {
      const li = document.createElement('li');
      li.textContent = item;
      return li;
    }));
  }

  const phaseList = document.querySelector<HTMLElement>('[data-phase-list]');
  if (phaseList && data.phases.length) {
    phaseList.replaceChildren(...data.phases.map((phase, index) => {
      const item = document.createElement('article');
      item.className = 'phase-row';
      item.innerHTML = `
        <div class="phase-number">${String(index).padStart(2, '0')}</div>
        <div class="phase-name"><h3>${escapeHtml(phase.name)}</h3><p>${escapeHtml(phase.benchmark)}</p></div>
        <div class="phase-status">${escapeHtml(phase.status)}</div>
        <div class="phase-percent">${phase.completion}%</div>
        <div class="phase-meter" aria-hidden="true"><span style="width:${phase.completion}%"></span></div>`;
      return item;
    }));
  }

  const milestoneList = document.querySelector<HTMLElement>('[data-milestone-list]');
  if (milestoneList && data.milestones.length) {
    milestoneList.replaceChildren(...data.milestones.slice(0, 8).map((milestone, index) => {
      const item = document.createElement('article');
      item.innerHTML = `<span>${String(index + 1).padStart(2, '0')}</span><p>${escapeHtml(milestone)}</p>`;
      return item;
    }));
  }


  renderVerification(data.verification);
  renderWorklog(data.worklog);

  const roadmap = document.querySelector<HTMLElement>('[data-full-roadmap]');
  if (roadmap) roadmap.innerHTML = data.roadmapHtml;
}

/**
 * The test count comes from the machine or it does not appear.
 *
 * This page tells the reader it "cannot flatter the build". The figure was
 * previously typed into the markup and drifted to 269 while the suite stood at
 * 340 — the exact flattery the sentence disclaims. `.verify/tests.json` is
 * written by `npm test`; with no run to cite, show an em dash and say so.
 */
function renderVerification(verification: Verification | null): void {
  const count = document.querySelector<HTMLElement>('[data-test-count]');
  if (!count) return;
  if (!verification) {
    count.textContent = '—';
    count.title = 'No test run recorded yet. Run npm test.';
    return;
  }
  count.textContent = String(verification.passed);
  count.title = `${verification.passed} of ${verification.tests} across `
    + `${verification.files} files — ${verification.green ? 'suite green' : 'SUITE RED'}`;
  if (!verification.green) count.classList.add('is-red');
}

/**
 * The headline only: which piece is on the bench, what it is judged against,
 * and what "finishing" means. The full record — every piece, every critic
 * verdict, everything held back — is `/gauntlet.html`, which reads the same
 * payload. Duplicating it here would give the project two accounts of itself
 * that could disagree.
 */
function renderWorklog(worklog: Worklog | null): void {
  if (!worklog) return;
  const set = (selector: string, value: string, asHtml = false): void => {
    const el = document.querySelector<HTMLElement>(selector);
    if (!el) return;
    if (asHtml) el.innerHTML = value; else el.textContent = value;
  };

  // The piece being worked is the first one not queued; failing that, the first.
  const active = worklog.pieces.find((piece) => !/queued/i.test(piece.status)) ?? worklog.pieces[0];

  set('[data-worklog-piece]', active?.title ?? '');
  set('[data-worklog-bar]', active?.bar ? `Bar — ${active.bar}` : '', true);
  set('[data-worklog-status]', active?.status ?? '');
  set('[data-worklog-scope]', worklog.scope, true);
  set('[data-worklog-state]', `Round ${worklog.round} · ${worklog.state}`);

  const status = document.querySelector<HTMLElement>('[data-worklog-status]');
  if (status && active) status.dataset['state'] = active.status.toLowerCase().replace(/\s+/g, '-');
}

function escapeHtml(value: string): string {
  const element = document.createElement('div');
  element.textContent = value;
  return element.innerHTML;
}

fetch('./data/progress.json')
  .then((response) => {
    if (!response.ok) throw new Error(`Progress request failed: ${response.status}`);
    return response.json() as Promise<ProgressData>;
  })
  .then(renderProgress)
  .catch(() => renderProgress(fallback))
  // Sections below the progress panel have just moved. Put the reader back on
  // the anchor they asked for. Declared after renderProgress so the layout is
  // final when it runs.
  .finally(() => requestAnimationFrame(() => honourHash()));

// Scroll reveal ------------------------------------------------------------
// Everything with .reveal starts at opacity 0, so anything this misses is not
// merely un-animated — it is invisible. Two ways that happened:
//
//   1. Reduced-motion users got the animation regardless.
//   2. Deep links landed on a blank screen. The hero art carries no intrinsic
//      size, so the page grows after the browser has already jumped to the
//      hash; /development.html#worklog left the reader at scrollY 3601 with
//      the section at 5393, in a gap between sections where nothing had
//      intersected yet.
//
// Reveal honestly, then re-honour the hash once layout has settled.
const revealTargets = [...document.querySelectorAll('.reveal')];
const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

if (prefersReducedMotion) {
  for (const element of revealTargets) element.classList.add('is-visible');
} else {
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      }
    }
  }, { threshold: 0.12, rootMargin: '0px 0px -4% 0px' });

  for (const element of revealTargets) observer.observe(element);
}

function honourHash(): void {
  if (!window.location.hash) return;
  document.querySelector(window.location.hash)?.scrollIntoView({ block: 'start' });
}

window.addEventListener('hashchange', honourHash);

// The browser jumps to the hash at parse time, but the progress panel *above*
// the work log is empty until the fetch resolves — injecting its phase and
// milestone rows then pushes every later section down, and the reader is left
// somewhere in a gap. Images are not the cause; the CSS already reserves their
// space with aspect-ratio. Re-anchor once the injected content has landed, and
// stop the browser restoring a stale offset over the top of it.
if (window.location.hash && 'scrollRestoration' in history) history.scrollRestoration = 'manual';

const header = document.querySelector<HTMLElement>('[data-header]');
window.addEventListener('scroll', () => header?.classList.toggle('is-scrolled', window.scrollY > 24), { passive: true });


// Concept-art lightbox ------------------------------------------------------
// Gallery images are references worth studying, not decorative thumbnails.
// Keep the viewer dependency-free and keyboard accessible.
const galleryImages = [...document.querySelectorAll<HTMLImageElement>('.gallery-grid img')];
if (galleryImages.length) {
  const dialog = document.createElement('dialog');
  dialog.className = 'art-lightbox';
  dialog.setAttribute('aria-label', 'Concept art viewer');
  dialog.innerHTML = `
    <button class="lightbox-close" type="button" aria-label="Close concept art viewer">×</button>
    <button class="lightbox-nav lightbox-prev" type="button" aria-label="Previous image">‹</button>
    <figure><img alt="" /><figcaption></figcaption></figure>
    <button class="lightbox-nav lightbox-next" type="button" aria-label="Next image">›</button>`;
  document.body.appendChild(dialog);

  const fullImage = dialog.querySelector<HTMLImageElement>('figure img')!;
  const caption = dialog.querySelector<HTMLElement>('figcaption')!;
  let active = 0;

  const show = (index: number): void => {
    active = (index + galleryImages.length) % galleryImages.length;
    const source = galleryImages[active]!;
    fullImage.src = source.currentSrc || source.src;
    fullImage.alt = source.alt;
    caption.textContent = source.closest('figure')?.querySelector('figcaption')?.textContent ?? '';
  };
  const open = (index: number): void => {
    show(index);
    dialog.showModal();
  };

  galleryImages.forEach((image, index) => {
    image.tabIndex = 0;
    image.setAttribute('role', 'button');
    image.setAttribute('aria-label', `${image.alt}. Open full-size image.`);
    image.addEventListener('click', () => open(index));
    image.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        open(index);
      }
    });
  });

  dialog.querySelector('.lightbox-close')?.addEventListener('click', () => dialog.close());
  dialog.querySelector('.lightbox-prev')?.addEventListener('click', () => show(active - 1));
  dialog.querySelector('.lightbox-next')?.addEventListener('click', () => show(active + 1));
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft') show(active - 1);
    if (event.key === 'ArrowRight') show(active + 1);
  });
}
