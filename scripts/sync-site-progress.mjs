import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const progressSource = resolve(root, 'docs/PROGRESS.md');
const roadmapSource = resolve(root, 'docs/ROADMAP.md');
const worklogSource = resolve(root, 'docs/WORKLOG.md');
const destination = resolve(root, 'public/data/progress.json');
const [markdown, roadmapMarkdown, worklogMarkdown] = await Promise.all([
  readFile(progressSource, 'utf8'),
  readFile(roadmapSource, 'utf8'),
  readFile(worklogSource, 'utf8'),
]);

const overall = Number(markdown.match(/Current overall completion:\*\* \*\*(\d+)%/)?.[1] ?? 0);
const updated = markdown.match(/Last updated:\*\* ([0-9-]+)/)?.[1] ?? new Date().toISOString().slice(0, 10);

const phases = [];
for (const line of markdown.split('\n')) {
  const match = line.match(/^\|\s*\d+\.\s*([^|]+)\|\s*\d+%\s*\|\s*([^|]+)\|\s*(\d+)%\s*\|\s*([^|]+)\|/);
  if (!match) continue;
  phases.push({
    name: match[1].trim(),
    status: match[2].trim(),
    completion: Number(match[3]),
    benchmark: match[4].trim(),
  });
}

/** The body of a `## heading` section, up to the next `## ` of the same level. */
function sectionOf(source, heading) {
  const start = source.indexOf(`## ${heading}`);
  if (start < 0) return '';
  const rest = source.slice(start + heading.length + 3);
  const end = rest.search(/\n## /);
  return end >= 0 ? rest.slice(0, end) : rest;
}

function sectionItems(heading, ordered = false) {
  const section = sectionOf(markdown, heading);
  const pattern = ordered ? /^\d+\.\s+(.+)$/gm : /^- \[x\]\s+(.+)$/gm;
  return [...section.matchAll(pattern)].map((match) => match[1].trim());
}

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function inlineMarkdown(value) {
  let html = escapeHtml(value);
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return html;
}

function isTableSeparator(line) {
  const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function parseTable(lines, start) {
  const rows = [];
  let index = start;
  while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index])) {
    rows.push(lines[index].trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim()));
    index += 1;
  }
  const hasHeader = rows.length > 1 && isTableSeparator(lines[start + 1] ?? '');
  const header = hasHeader ? rows[0] : null;
  const body = hasHeader ? rows.slice(2) : rows;
  let html = '<div class="roadmap-table-wrap"><table class="roadmap-table">';
  if (header) html += `<thead><tr>${header.map((cell) => `<th>${inlineMarkdown(cell)}</th>`).join('')}</tr></thead>`;
  html += `<tbody>${body.map((row) => `<tr>${row.map((cell) => `<td>${inlineMarkdown(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  return { html, next: index };
}

function roadmapToHtml(source) {
  const lines = source.replace(/\r/g, '').split('\n');
  const html = [];
  let paragraph = [];
  let listType = null;
  let listItems = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    html.push(`<p>${inlineMarkdown(paragraph.join(' '))}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!listItems.length || !listType) return;
    html.push(`<${listType}>${listItems.map((item) => `<li>${inlineMarkdown(item)}</li>`).join('')}</${listType}>`);
    listItems = [];
    listType = null;
  };
  const flush = () => { flushParagraph(); flushList(); };

  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (!line.trim()) { flush(); index += 1; continue; }
    if (/^---+$/.test(line.trim())) { flush(); html.push('<hr />'); index += 1; continue; }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flush();
      const parsed = parseTable(lines, index);
      html.push(parsed.html);
      index = parsed.next;
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flush();
      const level = Math.min(heading[1].length + 1, 4);
      const title = inlineMarkdown(heading[2]);
      const slug = heading[2].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      html.push(`<h${level} id="roadmap-${slug}">${title}</h${level}>`);
      index += 1;
      continue;
    }
    const ordered = line.match(/^\s*\d+\.\s+(.+)$/);
    const unordered = line.match(/^\s*-\s+(.+)$/);
    if (ordered || unordered) {
      flushParagraph();
      const nextType = ordered ? 'ol' : 'ul';
      if (listType && listType !== nextType) flushList();
      listType = nextType;
      listItems.push((ordered ?? unordered)[1]);
      index += 1;
      continue;
    }
    if (listItems.length) flushList();
    paragraph.push(line.trim());
    index += 1;
  }
  flush();
  return html.join('\n');
}

// ---- work log -------------------------------------------------------------
// The gauntlet ledger: the slice in flight, what it must prove, and the
// strongest objection still standing. Parsed by heading name — see the format
// note at the top of docs/WORKLOG.md, and the assertions in check-site-sync.mjs
// that fail the build when a rename silently drops a section.

/** `- **Label:** value` inside a section, keyed by lowercased label. */
function labelledFields(section) {
  const fields = {};
  for (const [, label, value] of section.matchAll(/^-\s+\*\*([^:*]+):\*\*\s*(.+)$/gm)) {
    fields[label.trim().toLowerCase()] = value.trim();
  }
  return fields;
}

/**
 * `### ` blocks inside a section, as `{ heading, body }`.
 *
 * Written as a split rather than one regex on purpose. The obvious pattern —
 * `/^### (.+)$\n([\s\S]*?)(?=\n### |\n## |$)/gm` — is quietly broken: under the
 * `m` flag the `$` in that lookahead matches the end of the *first line*, not
 * the end of the string, so the lazy body matched empty and every block
 * published with no content. It failed silently, which is the worst way for a
 * publication path to fail; check-site-sync.mjs now asserts bodies arrived.
 */
function subsections(section) {
  return section.split(/^### /m).slice(1).map((chunk) => {
    const breakAt = chunk.indexOf('\n');
    return {
      heading: (breakAt < 0 ? chunk : chunk.slice(0, breakAt)).trim(),
      body: breakAt < 0 ? '' : chunk.slice(breakAt + 1),
    };
  });
}

/** Blank-line-separated paragraphs, as inline HTML. Bullet lines are dropped —
 *  those are read separately as labelled fields. */
function paragraphs(body) {
  return body
    .split(/\n\s*\n/)
    .map((block) => block.split('\n').filter((line) => !/^\s*-\s+\*\*/.test(line)).join(' ').trim())
    .filter(Boolean)
    .map(inlineMarkdown);
}

function bullets(section) {
  return [...section.matchAll(/^-\s+(.+)$/gm)].map((match) => inlineMarkdown(match[1].trim()));
}

function parseWorklog(source) {
  return {
    round: source.match(/^\*\*Round:\*\*\s*(.+)$/m)?.[1].trim() ?? '',
    state: source.match(/^\*\*State:\*\*\s*(.+)$/m)?.[1].trim() ?? '',
    scope: paragraphs(sectionOf(source, 'What finishing means')).join(' '),

    pieces: subsections(sectionOf(source, 'Pieces')).map(({ heading, body }) => {
      const fields = labelledFields(body);
      return {
        title: heading,
        bar: inlineMarkdown(fields.bar ?? ''),
        status: fields.status ?? '',
        detail: paragraphs(body),
      };
    }),

    everyRound: bullets(sectionOf(source, 'Every round')),
    never: bullets(sectionOf(source, 'Never')),

    // `- **id** — reason`, so the page can set the id as a handle and the
    // reason as prose beside it.
    heldBack: [...sectionOf(source, 'Held back').matchAll(/^-\s+\*\*([^*]+)\*\*\s*—\s*(.+)$/gm)]
      .map((match) => ({ id: match[1].trim(), reason: inlineMarkdown(match[2].trim()) })),

    rounds: subsections(sectionOf(source, 'Rounds')).map(({ heading, body }) => ({
      label: heading,
      paragraphs: paragraphs(body),
    })),
  };
}

/**
 * Verification evidence, written by `npm test` and never by hand.
 *
 * The public page claims this section "cannot flatter the build". A test count
 * typed into markup makes that claim false the first time the suite grows — the
 * page shipped 269 while the suite was at 340. Read the machine's own report or
 * publish nothing; a stale number is worse than an absent one.
 */
async function readVerification() {
  try {
    const report = JSON.parse(await readFile(resolve(root, '.verify/tests.json'), 'utf8'));
    const suites = report.testResults ?? [];
    const tests = report.numTotalTests ?? 0;
    if (!tests) return null;
    return {
      tests,
      passed: report.numPassedTests ?? 0,
      files: report.numTotalTestSuites ?? suites.length,
      green: report.success === true,
    };
  } catch {
    return null; // never run, or run before this feature existed
  }
}

const payload = {
  overall,
  updated,
  currentWork: sectionItems('Current work', true),
  phases,
  milestones: sectionItems('Most recent completed benchmarks'),
  worklog: parseWorklog(worklogMarkdown),
  verification: await readVerification(),
  roadmapHtml: roadmapToHtml(roadmapMarkdown),
};

await mkdir(dirname(destination), { recursive: true });
await writeFile(destination, `${JSON.stringify(payload, null, 2)}\n`);
const evidence = payload.verification
  ? `${payload.verification.tests} tests` : 'no test evidence yet';
console.log(
  `Synchronized public progress data: ${overall}% (${phases.length} summary phases; `
  + `full roadmap embedded; gauntlet round ${payload.worklog.round} — `
  + `${payload.worklog.pieces.length} pieces, ${payload.worklog.rounds.length} rounds, `
  + `${payload.worklog.heldBack.length} held back; ${evidence})`,
);
