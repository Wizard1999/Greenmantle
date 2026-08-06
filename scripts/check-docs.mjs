/**
 * Fails if any src/ module is missing from docs/ARCHITECTURE.md.
 *
 * The project's working model is that any coding agent can clone the repo and
 * resume with no outside instruction. That only holds if the module map stays
 * complete, and a map silently drifts the moment someone adds a file without a
 * row. Cheap to check, so check it rather than trusting discipline.
 */
import { readFile, readdir } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';

// resolve(import.meta.dirname) rather than new URL(..).pathname: on Windows the
// latter yields "/O:/..." and joining it produces "O:\O:\...".
const root = resolve(import.meta.dirname, '..');
const doc = await readFile(join(root, 'docs/ARCHITECTURE.md'), 'utf8');

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(full));
    else if (e.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

const files = await walk(join(root, 'src'));
const missing = files.filter(f => !doc.includes(basename(f)));

if (missing.length) {
  console.error(`docs/ARCHITECTURE.md is missing ${missing.length} module(s):`);
  for (const m of missing) console.error(`  ${relative(root, m)}`);
  console.error('\nAdd a row describing what each does. See CLAUDE.md > Important Rules.');
  process.exit(1);
}
console.log(`Module map complete: ${files.length} modules documented.`);
