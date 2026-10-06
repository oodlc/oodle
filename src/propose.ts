/**
 * Propose-only writes to the catalog, for agents, the drafter and `oodle init`. A proposal can
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
import { runProject } from './runner.ts';
import type { RunResult } from './types.ts';

export const PROPOSALS_FILE = 'proposed.yaml';
const SECTIONS = ['intents', 'outcomes', 'behaviors', 'conditions', 'constraints'] as const;
type Section = (typeof SECTIONS)[number];
/** Sections a human approves. Behaviors are observed and conditions only add runs, so they need no approval. */
const APPROVED: Section[] = ['intents', 'outcomes', 'constraints'];

const HEADER = `# Proposed by \`oodle init\`, an agent or \`oodle draft\`, waiting for a human.
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


// ── Routes nothing describes ────────────────────────────────────────────────

/** Body fields worth pinning exactly: flags and the codes callers branch on. Everything else just has to be there. */
const EXACT_FIELDS = /^(ok|error|code|status|state|type|kind)$/;

function expectedBody(body: unknown): Record<string, unknown> | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const fields = Object.entries(body as Record<string, unknown>).slice(0, 6);
  if (!fields.length) return undefined;
  return Object.fromEntries(fields.map(([k, v]) => [k, typeof v === 'boolean' || v === null || (EXACT_FIELDS.test(k) && typeof v !== 'object') ? v : { exists: true }]));
}

/**
 * A proposed outcome for each route nothing describes, from what probing it in
 * the simulation showed: the status, the top-level body fields, and the external
 * calls it made. A starting point for a human to sharpen, never a promise on its own.
 */
export function routeOutcomes(run: RunResult): { fragment: { intents?: unknown[]; outcomes: unknown[] }; skipped: string[] } {
  const intent = run.catalog.intents.find((i) => i.status !== 'proposed') ?? run.catalog.intents[0];
  const taken = new Set([...run.catalog.outcomes, ...run.catalog.behaviors].map((x) => x.id));
  const outcomes: unknown[] = [];
  const skipped: string[] = [];
  for (const g of run.gaps) {
    if (g.probe.status === null) {
      skipped.push(`${g.route}: ${g.probe.error ?? 'no response'}`);
      continue;
    }
    const [method] = g.route.split(' ');
    const id = g.proposal.id.replace(/^observed\./, '');
    if (taken.has(id)) continue;
    const counts = new Map<string, number>();
    for (const e of g.probe.effects ?? []) if (e.boundary !== 'internal' && !e.error) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
    const effects = [...counts].map(([kind, count]) => ({ kind, count }));
    const body = expectedBody(g.probe.body);
    outcomes.push({
      id,
      intent: intent?.id ?? 'service-available',
      statement: `TODO: say what a caller can count on. Observed: ${g.route} answered ${g.probe.status}`,
      boundary: 'external',
      trigger: { http: g.proposal.trigger.http, ...(method === 'GET' ? {} : { given: { body: {} } }) },
      expect: { status: g.probe.status, ...(body ? { body } : {}), ...(effects.length ? { effects } : {}) },
    });
  }
  const intents = intent ? undefined : [{ id: 'service-available', statement: 'Callers can rely on the service being there when they need it.' }];
  return { fragment: { ...(intents ? { intents } : {}), outcomes }, skipped };
}

/** Probes every route nothing describes and adds a proposed outcome for each to oodlc/proposed.yaml. */
export async function proposeRoutes(projectDir: string): Promise<ProposeResult & { skipped: string[] }> {
  const run = await runProject(projectDir);
  const { fragment, skipped } = routeOutcomes(run);
  if (!fragment.outcomes.length) return { file: join(run.config.catalog, PROPOSALS_FILE), added: [], warnings: [], skipped };
  return { ...propose(projectDir, fragment), skipped };
}
