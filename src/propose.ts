/**
 * Propose-only writes to the catalog, for agents and the drafter. A proposal can
 * add entries, never change or remove one: every new intent, outcome and
 * constraint is marked `status: proposed` (it runs and is reported, but never
 * blocks), and any id that already exists is refused. Proposals land in
 * oodlc/proposed.yaml, where a human approves one by deleting its status line
 * and, if they like, moving it next to its neighbours. See docs/decisions/0006.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse, stringify } from 'yaml';
import { CatalogError, loadCatalog, loadConfig, validateCatalogDoc } from './catalog.ts';
import { lint } from './lint.ts';
import { OodleError } from './errors.ts';

export const PROPOSALS_FILE = 'proposed.yaml';
const SECTIONS = ['intents', 'outcomes', 'behaviors', 'conditions', 'constraints'] as const;
type Section = (typeof SECTIONS)[number];
/** Sections a human approves. Behaviors are observed and conditions only add runs, so they need no approval. */
const APPROVED: Section[] = ['intents', 'outcomes', 'constraints'];

const HEADER = `# Proposed by an agent or \`oodle draft\`, waiting for a human.
# Proposed entries run and are reported, but never block. To approve one, delete
# its "status: proposed" line (and move it next to its neighbours if you like).
# To reject one, delete it. See docs/decisions/0006.
`;

export interface ProposeResult {
  file: string;
  added: { section: Section; id: string }[];
  warnings: string[];
}

/** Accepts a parsed fragment or YAML text with any of the five catalog sections. */
export function propose(projectDir: string, input: unknown): ProposeResult {
  let fragment: any = input;
  if (typeof input === 'string') {
    try {
      // Models like to fence YAML even when asked not to.
      fragment = parse(input.replace(/^\s*```[a-z]*\n([\s\S]*?)\n```\s*$/, '$1'));
    } catch (err) {
      throw new OodleError('proposal', 'The proposal is not valid YAML', { problems: [(err as Error).message], hint: 'Send a mapping with any of: intents, outcomes, behaviors, conditions, constraints.' });
    }
  }
  if (!fragment || typeof fragment !== 'object' || Array.isArray(fragment)) {
    throw new OodleError('proposal', 'A proposal is a mapping of catalog sections', { hint: 'For example: { outcomes: [ { id, intent, statement, boundary, trigger, expect } ] }' });
  }
  const unknown = Object.keys(fragment).filter((k) => k !== 'version' && !SECTIONS.includes(k as Section));
  if (unknown.length) throw new OodleError('proposal', `Unknown section${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`, { hint: `Sections are ${SECTIONS.join(', ')}.` });

  const config = loadConfig(projectDir);
  const before = loadCatalog(projectDir, config);
  const lintBefore = new Set(lint(before, config).errors);

  // Everything approvable arrives as a proposal, whatever the input said.
  const incoming: Record<Section, any[]> = Object.fromEntries(SECTIONS.map((s) => [s, (fragment[s] ?? []).map((item: any) => (APPROVED.includes(s) && item && typeof item === 'object' ? { ...item, status: 'proposed' } : item))])) as any;
  const problems = validateCatalogDoc({ version: 0, ...Object.fromEntries(SECTIONS.filter((s) => incoming[s].length).map((s) => [s, incoming[s]])) }, 'proposal');
  if (problems.length) throw new OodleError('proposal', 'The proposal does not match the catalog schema', { problems, hint: 'See spec/catalog.schema.json for every field.' });

  const taken: string[] = [];
  for (const s of SECTIONS) {
    for (const item of incoming[s]) {
      const twin = s === 'outcomes' ? 'behaviors' : s === 'behaviors' ? 'outcomes' : null;
      const where = before.sources[`${s}:${item.id}`] ?? (twin && before.sources[`${twin}:${item.id}`]);
      if (where) taken.push(`${s.slice(0, -1)} ${item.id} already exists in ${where}`);
    }
  }
  if (taken.length) {
    throw new OodleError('proposal-exists', 'A proposal can only add entries, never change one', {
      problems: taken,
      hint: 'Pick a new id. Changing an existing outcome or constraint is a human decision: say what you would change and why.',
    });
  }

  const dir = join(projectDir, config.catalog);
  const file = join(dir, PROPOSALS_FILE);
  const original = existsSync(file) ? readFileSync(file, 'utf8') : null;
  const doc: any = original ? parse(original) ?? {} : {};
  doc.version = 0;
  for (const s of SECTIONS) if (incoming[s].length) doc[s] = [...(doc[s] ?? []), ...incoming[s]];
  const ordered = Object.fromEntries([['version', 0], ...SECTIONS.filter((s) => doc[s]?.length).map((s) => [s, doc[s]])]);
  writeFileSync(file, `${HEADER}${stringify(ordered, { lineWidth: 0 })}`);

  // The whole catalog must still load, and the proposal must not add lint errors (an unknown intent, say).
  try {
    const after = loadCatalog(projectDir, config);
    const fresh = lint(after, config).errors.filter((e) => !lintBefore.has(e));
    if (fresh.length) throw new OodleError('proposal', 'The proposal leaves the catalog with errors', { problems: fresh, hint: 'Propose the intent or condition it refers to in the same proposal, or use an existing id.' });
    return {
      file: relative(projectDir, file),
      added: SECTIONS.flatMap((s) => incoming[s].map((i: any) => ({ section: s, id: i.id }))),
      warnings: lint(after, config).warnings.filter((w) => w.startsWith(relative(projectDir, file))),
    };
  } catch (err) {
    if (original === null) rmSync(file, { force: true });
    else writeFileSync(file, original);
    if (err instanceof CatalogError) throw new OodleError('proposal', 'The proposal would break the catalog', { problems: err.problems });
    throw err;
  }
}

