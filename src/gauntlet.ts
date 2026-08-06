import './gauntlet.css';

/**
 * The live gauntlet page.
 *
 * Deliberately a document rather than a dashboard. Meters and percentages
 * flatter — a bar at 82% reads as progress whether or not anything works. The
 * things worth publishing here are what a piece is being judged against, and
 * what the critic actually found, so the page is built to carry prose and gets
 * out of its way.
 *
 * Reads the same `public/data/progress.json` the development page does, so
 * there is exactly one publication path (`npm run sync:site`) and the two pages
 * cannot disagree about the state of the build.
 */

type Piece = { title: string; bar: string; status: string; detail: string[] };
type Round = { label: string; paragraphs: string[] };
type HeldBack = { id: string; reason: string };

type Worklog = {
  round: string;
  state: string;
  scope: string;
  pieces: Piece[];
  everyRound: string[];
  never: string[];
  heldBack: HeldBack[];
  rounds: Round[];
};

const el = <T extends HTMLElement>(selector: string): T | null =>
  document.querySelector<T>(selector);

/** Status words map to a small fixed set of states so the chip cannot drift
 *  into an unstyled colour every time a new phrase is written in the markdown. */
function stateOf(status: string): string {
  const value = status.toLowerCase();
  if (value.includes('sent back')) return 'sent-back';
  if (value.includes('critique') || value.includes('review')) return 'critique';
  if (value.includes('build')) return 'building';
  if (value.includes('pass') || value.includes('won')) return 'passed';
  if (value.includes('block')) return 'blocked';
  return 'queued';
}

function renderPieces(pieces: Piece[]): void {
  const host = el('[data-pieces]');
  if (!host) return;
  host.replaceChildren(...pieces.map((piece) => {
    const article = document.createElement('article');
    article.className = 'piece';
    article.dataset['state'] = stateOf(piece.status);
    article.innerHTML = `
      <div class="piece-head">
        <div>
          <h3>${escapeHtml(piece.title)}</h3>
          <p class="piece-bar">Bar — ${piece.bar}</p>
        </div>
        <span class="piece-status">${escapeHtml(piece.status.toLowerCase())}</span>
      </div>
      ${piece.detail.map((text) => `<p>${text}</p>`).join('')}`;
    return article;
  }));
}

function renderList(selector: string, items: string[]): void {
  const host = el(selector);
  if (!host) return;
  host.replaceChildren(...items.map((item) => {
    const li = document.createElement('li');
    li.innerHTML = item;
    return li;
  }));
}

function renderHeldBack(items: HeldBack[]): void {
  const host = el('[data-held-back]');
  if (!host) return;
  const nodes: HTMLElement[] = [];
  for (const item of items) {
    const term = document.createElement('dt');
    term.textContent = item.id;
    const detail = document.createElement('dd');
    detail.innerHTML = item.reason;
    nodes.push(term, detail);
  }
  host.replaceChildren(...nodes);
}

function renderRounds(rounds: Round[]): void {
  const host = el('[data-rounds]');
  if (!host) return;
  host.replaceChildren(...rounds.map((round) => {
    const article = document.createElement('article');
    article.className = 'round';
    article.innerHTML = `
      <p class="round-label">${escapeHtml(round.label)}</p>
      <div class="round-body">${round.paragraphs.map((text) => `<p>${text}</p>`).join('')}</div>`;
    return article;
  }));
}

function render(worklog: Worklog): void {
  const state = el('[data-state]');
  if (state) state.textContent = `Round ${worklog.round} · ${worklog.state}`;

  const scope = el('[data-scope]');
  if (scope) scope.innerHTML = worklog.scope;

  renderPieces(worklog.pieces);
  renderList('[data-every-round]', worklog.everyRound);
  renderList('[data-never]', worklog.never);
  renderHeldBack(worklog.heldBack);
  renderRounds(worklog.rounds);
}

function escapeHtml(value: string): string {
  const holder = document.createElement('div');
  holder.textContent = value;
  return holder.innerHTML;
}

function fail(message: string): void {
  const state = el('[data-state]');
  if (state) {
    state.textContent = message;
    state.classList.add('is-error');
  }
}

fetch('./data/progress.json')
  .then((response) => {
    if (!response.ok) throw new Error(String(response.status));
    return response.json() as Promise<{ worklog: Worklog | null }>;
  })
  .then((data) => {
    // Say so rather than rendering an empty page that looks like "no work
    // happening" — an absent file and an idle loop are very different facts.
    if (!data.worklog) throw new Error('no work log in progress.json');
    render(data.worklog);
  })
  .catch((error: unknown) => {
    fail(`Could not load the work log (${String(error)}). Run npm run sync:site.`);
  });
