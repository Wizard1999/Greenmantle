import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const [progressMarkdown, roadmapMarkdown, worklogMarkdown, publicData] = await Promise.all([
  readFile(resolve(root, 'docs/PROGRESS.md'), 'utf8'),
  readFile(resolve(root, 'docs/ROADMAP.md'), 'utf8'),
  readFile(resolve(root, 'docs/WORKLOG.md'), 'utf8'),
  readFile(resolve(root, 'public/data/progress.json'), 'utf8'),
]);

const data = JSON.parse(publicData);
const expectedOverall = Number(progressMarkdown.match(/Current overall completion:\*\* \*\*(\d+)%/)?.[1] ?? -1);
if (data.overall !== expectedOverall) {
  throw new Error(`Public progress is stale: expected ${expectedOverall}%, found ${data.overall}%`);
}

if (typeof data.roadmapHtml !== 'string' || data.roadmapHtml.length < 1000) {
  throw new Error('Public roadmap is missing or unexpectedly short. Run npm run sync:site.');
}

const headings = [...roadmapMarkdown.matchAll(/^#{1,3}\s+(.+)$/gm)]
  .map((match) => match[1].replace(/[\*`]/g, ''));
const missing = headings.filter((heading) => {
  const escaped = heading
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
  return !data.roadmapHtml.includes(escaped);
});
if (missing.length) {
  throw new Error(`Public roadmap omitted canonical headings: ${missing.join(', ')}`);
}

/**
 * The work log is parsed by heading name, so a rename does not error — the
 * section just quietly stops publishing and the page keeps showing whatever it
 * showed last. Assert each section arrived with content, so the failure is a
 * build break rather than a page that silently goes stale.
 */
const worklog = data.worklog;
if (!worklog) throw new Error('Public work log is missing. Run npm run sync:site.');

const requiredSections = [
  'What finishing means', 'Pieces', 'Every round', 'Never', 'Held back', 'Rounds',
];
const absent = requiredSections.filter((heading) => !worklogMarkdown.includes(`## ${heading}`));
if (absent.length) {
  throw new Error(
    `docs/WORKLOG.md is missing required section(s): ${absent.join(', ')}. `
    + 'sync-site-progress.mjs parses these by name — see the format note in that file.',
  );
}

if (!worklog.round || !worklog.state) {
  throw new Error('Work log published without a Round or State. Both are `**Label:** value` lines near the top.');
}
if (!worklog.scope) throw new Error('Work log published no scope statement under "What finishing means".');
for (const [name, list] of [['pieces', worklog.pieces], ['rounds', worklog.rounds],
  ['heldBack', worklog.heldBack], ['everyRound', worklog.everyRound], ['never', worklog.never]]) {
  if (!list.length) throw new Error(`Work log published an empty "${name}" list.`);
}

/*
 * A block that publishes its heading but loses its body renders as a titled
 * empty card — visibly wrong, but not wrong enough for anyone to notice on a
 * page they skim. That exact bug shipped once, caused by `$` under the `m` flag
 * matching a line end rather than the end of the string. Assert bodies arrived.
 */
const hollowPieces = worklog.pieces.filter((piece) => !piece.detail.length || !piece.bar || !piece.status);
if (hollowPieces.length) {
  throw new Error(
    `Work log published ${hollowPieces.length} piece(s) with no bar, status or prose: `
    + `${hollowPieces.map((piece) => `"${piece.title}"`).join(', ')}. `
    + 'Each piece needs `- **Bar:**`, `- **Status:**`, and at least one paragraph.',
  );
}
const hollowRounds = worklog.rounds.filter((round) => !round.paragraphs.length || !round.label);
if (hollowRounds.length) {
  throw new Error(
    `Work log published ${hollowRounds.length} round(s) with no body: `
    + `${hollowRounds.map((round) => `"${round.label}"`).join(', ')}.`,
  );
}

const evidence = data.verification
  ? `${data.verification.tests} tests (${data.verification.green ? 'green' : 'RED'})`
  : 'no test evidence yet';
console.log(
  `Site data is synchronized: ${data.overall}%, ${headings.length} roadmap headings, `
  + `gauntlet round ${worklog.round} (${worklog.state}) with ${worklog.pieces.length} pieces `
  + `and ${worklog.heldBack.length} held back, ${evidence}.`,
);
