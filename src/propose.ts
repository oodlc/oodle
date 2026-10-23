/**
 * Propose-only writes to the catalog, for agents, the drafter and `oodle init`. A proposal can
 * add entries, never change or remove one: every new intent, outcome and
 * constraint is marked `status: proposed` (it runs and is reported, but never
 * blocks), and any id that already exists is refused. Proposals land in
 * oodlc/proposed.yaml, where a human approves one by deleting its status line
 * and, if they like, moving it next to its neighbours. See docs/decisions/0006.
 *
 * Evidence that arrives here was written by whoever proposed it, so it is inferred,
 * whatever grade it claims. Only Oodle's own discovery grades what it saw (0014).
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse, stringify } from 'yaml';
import { CatalogError, SECTIONS, type Section, loadCatalog, loadConfig, schemaLine, singular, validateCatalogDoc } from './catalog.ts';
import { lint, saysNothing } from './lint.ts';
import { OodleError } from './errors.ts';
import { reaches, routeSlug, runProject } from './runner.ts';
import { capabilityOf } from './explain.ts';
import { readEvidence, type Evidence } from './evidence.ts';
import type { Capability, EffectRecord, Gap, RunResult, Trigger } from './types.ts';

export const PROPOSALS_FILE = 'proposed.yaml';
/**
 * Sections a human approves. Behaviors are observed and conditions only add runs, so they need no approval.
 * Unknowns are questions, so there is nothing to confirm. See docs/decisions/0006 and 0010.
 */
const APPROVED: Section[] = ['intents', 'outcomes', 'constraints', 'actors', 'capabilities', 'experiences', 'terms'];

const HEADER = `${schemaLine('catalog')}# Proposed by \`oodle init\`, an agent or \`oodle draft\`, waiting for a human.
# Proposed entries run and are reported, but never block. To approve one, delete
# its "status: proposed" line (and move it next to its neighbours if you like).
# To reject one, delete it. See docs/decisions/0006.
`;

export interface ProposeResult {
  file: string;
  added: { section: Section; id: string }[];
  warnings: string[];
}

export interface ProposeOptions {
  /**
   * The evidence was graded by Oodle from where it came from (src/discover.ts), so its grades stand.
   * No CLI flag or MCP argument sets this: whatever an agent or a file proposes is inferred.
   */
  graded?: boolean;
}

/** Evidence as a proposal may carry it: every item inferred, unless Oodle graded it itself. */
const inferred = (evidence: unknown, opts: ProposeOptions) =>
  Array.isArray(evidence) ? evidence.map((e: any) => (typeof e === 'string' ? { text: e, grade: 'inferred' } : e && typeof e === 'object' ? { ...e, grade: opts.graded && e.grade === 'observed' ? 'observed' : 'inferred' } : e)) : evidence;

/** Accepts a parsed fragment or YAML text with any of the catalog sections. */
export function propose(projectDir: string, input: unknown, opts: ProposeOptions = {}): ProposeResult {
  let fragment: any = input;
  if (typeof input === 'string') {
    try {
      // Models like to fence YAML even when asked not to.
      fragment = parse(input.replace(/^\s*```[a-z]*\n([\s\S]*?)\n```\s*$/, '$1'));
    } catch (err) {
      throw new OodleError('proposal', 'The proposal is not valid YAML', { problems: [(err as Error).message], hint: `Send a mapping with any of: ${SECTIONS.join(', ')}.` });
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

  // Everything approvable arrives as a proposal, and all evidence as inferred, whatever the input said.
  const incoming: Record<Section, any[]> = Object.fromEntries(SECTIONS.map((s) => [s, (fragment[s] ?? []).map((item: any) => {
    if (!item || typeof item !== 'object') return item;
    const graded = 'evidence' in item ? { ...item, evidence: inferred(item.evidence, opts) } : item;
    return APPROVED.includes(s) ? { ...graded, status: 'proposed' } : graded;
  })])) as any;
  const problems = validateCatalogDoc({ version: 0, ...Object.fromEntries(SECTIONS.filter((s) => incoming[s].length).map((s) => [s, incoming[s]])) }, 'proposal');
  if (problems.length) throw new OodleError('proposal', 'The proposal does not match the catalog schema', { problems, hint: 'See spec/catalog.schema.json for every field.' });

  const taken: string[] = [];
  for (const s of SECTIONS) {
    for (const item of incoming[s]) {
      const twin = s === 'outcomes' ? 'behaviors' : s === 'behaviors' ? 'outcomes' : null;
      const where = before.sources[`${s}:${item.id}`] ?? (twin && before.sources[`${twin}:${item.id}`]);
      if (where) taken.push(`${singular(s)} ${item.id} already exists in ${where}`);
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


// ── Outcomes drafted from what Oodle saw ────────────────────────────────────

/** Body fields worth pinning exactly: flags and the codes callers branch on. Everything else just has to be there. */
const EXACT_FIELDS = /^(ok|error|code|status|state|type|kind)$/;

function expectedBody(body: unknown): Record<string, unknown> | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const fields = Object.entries(body as Record<string, unknown>).slice(0, 6);
  if (!fields.length) return undefined;
  return Object.fromEntries(fields.map(([k, v]) => [k, typeof v === 'boolean' || v === null || (EXACT_FIELDS.test(k) && typeof v !== 'object') ? v : { exists: true }]));
}

/** What Oodle saw one route do: from probing it, or from a behavior or outcome that already runs it. */
interface Sighting {
  /** "METHOD /pattern", as the app declares it. */
  route: string;
  trigger: Trigger;
  status: number;
  body: unknown;
  effects: EffectRecord[];
  /** What was sent, when Oodle made the request up itself: "Asked for a made-up id". */
  sent?: string;
}

/** The request a probe makes: a made-up id for each path parameter, and for anything but GET an empty body, or one seen in a capture. */
function probeWords(route: string, from?: string): string | undefined {
  const [method, path] = route.split(' ');
  const params = /(^|\/)(:|\[)/.test(path);
  const body = from ? `a body seen in ${from}` : 'an empty body';
  if (params && method !== 'GET') return `With a made-up id and ${body}`;
  if (params) return 'Asked for a made-up id';
  if (method !== 'GET') return `Sent ${body}`;
  return undefined;
}

/**
 * The statement a person starts from. Under a confirmed capability that says what it does, it is
 * the capability's own words and what Oodle saw: "A shopper can pay for a cart. Sent an empty body,
 * POST /orders answers 400 (empty_cart), with no outside call or write." Anywhere else it stays a
 * TODO, and names the capability whose confirmation would make it better. Either way it is a proposal.
 */
export function draftStatement(capability: Capability | undefined, s: Sighting): string {
  const title = typeof s.body === 'string' ? /<title[^>]*>([^<]*)<\/title>/i.exec(s.body)?.[1]?.trim() : undefined;
  const todo = `TODO: say what a caller can count on. Observed: ${s.route} answered ${s.status}${title ? `, a page titled "${title}"` : ''}`;
  if (!capability) return todo;
  if (capability.status === 'proposed') return `${todo}. Confirm the capability ${capability.id} first, and the draft starts from what it says.`;
  if (saysNothing(capability.statement)) return `${todo}. Say what the capability ${capability.id} does first, and the draft starts from it.`;
  const calls = [...new Set(s.effects.filter((e) => e.boundary === 'external' && !e.error).map((e) => e.kind))].sort();
  const writes = [...new Set(s.effects.flatMap((e) => (e.boundary === 'data' && !e.error ? [/^db\.(.+)\.(inserted|updated|deleted)$/.exec(e.kind)?.[1]] : [])).filter((x): x is string => !!x))].sort();
  const code = s.body && typeof s.body === 'object' && !Array.isArray(s.body) ? ['error', 'code'].map((k) => (s.body as Record<string, unknown>)[k]).find((v) => typeof v === 'string') : undefined;
  const crossed = [...(calls.length ? [`calls ${calls.join(', ')}`] : []), ...(writes.length ? [`writes ${writes.join(', ')}`] : [])];
  return `${capability.statement.trim().replace(/[.!]+$/, '')}. ${s.sent ? `${s.sent}, ` : ''}${s.route} answers ${s.status}${code ? ` (${code})` : ''}${crossed.length ? `, ${crossed.join(' and ')}` : ', with no outside call or write'}.`;
}

/** A proposed outcome, from what Oodle saw a route do. A starting point for a person to sharpen, never a promise on its own. */
function outcomeFrom(id: string, capability: Capability | undefined, s: Sighting, intent?: string) {
  const counts = new Map<string, number>();
  for (const e of s.effects) if (e.boundary !== 'internal' && !e.error) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
  const effects = [...counts].map(([kind, count]) => ({ kind, count }));
  const body = expectedBody(s.body);
  return {
    id,
    ...(capability ? { ...(capability.intent ? { intent: capability.intent } : {}), capability: capability.id } : { intent }),
    statement: draftStatement(capability, s),
    boundary: 'external',
    trigger: s.trigger,
    expect: { status: s.status, ...(body ? { body } : {}), ...(effects.length ? { effects } : {}) },
  };
}

/** The route a probe saw, as a sighting, or why there is none. */
function probed(g: Gap): Sighting | string {
  if (g.probe.status === null) return `${g.route}: ${g.probe.error ?? 'no response'}`;
  const [method] = g.route.split(' ');
  const sent = probeWords(g.route, g.sent?.from);
  return { route: g.route, trigger: { http: g.proposal.trigger.http, ...(method === 'GET' ? {} : { given: { body: g.sent?.body ?? {} } }) }, status: g.probe.status, body: g.probe.body, effects: g.probe.effects ?? [], ...(sent ? { sent } : {}) };
}

/**
 * A proposed outcome for each route nothing describes, from what probing it in
 * the simulation showed: the status, the top-level body fields, and the external
 * calls it made. A route a capability lists gets that capability, and its intent if it has one (0010).
 */
export function routeOutcomes(run: RunResult): { fragment: { intents?: unknown[]; outcomes: unknown[] }; skipped: string[] } {
  const intent = run.catalog.intents.find((i) => i.status !== 'proposed') ?? run.catalog.intents[0];
  const taken = new Set([...run.catalog.outcomes, ...run.catalog.behaviors].map((x) => x.id));
  const outcomes: unknown[] = [];
  const skipped: string[] = [];
  let generic = false;
  for (const g of run.gaps) {
    const s = probed(g);
    if (typeof s === 'string') {
      skipped.push(s);
      continue;
    }
    const id = g.proposal.id.replace(/^observed\./, '');
    if (taken.has(id)) continue;
    const capability = run.catalog.capabilities.find((c) => (c.surfaces ?? []).some((x) => reaches(x, g.route)));
    if (!capability) generic = true;
    outcomes.push(outcomeFrom(id, capability, s, intent?.id ?? 'service-available'));
  }
  const intents = intent || !generic ? undefined : [{ id: 'service-available', statement: 'Callers can rely on the service being there when they need it.' }];
  return { fragment: { ...(intents ? { intents } : {}), outcomes }, skipped };
}

/**
 * A proposed outcome for each surface of each confirmed capability that no outcome protects yet,
 * proposals included, so running it again adds nothing. Drafted from a probe of a route nothing
 * describes, or else from the behavior or outcome that already runs the route.
 */
export function capabilityOutcomes(run: RunResult): { fragment: { outcomes: unknown[] }; skipped: string[] } {
  const { catalog } = run;
  const taken = new Set([...catalog.outcomes, ...catalog.behaviors].map((x) => x.id));
  const outcomes: unknown[] = [];
  const skipped: string[] = [];
  for (const c of catalog.capabilities) {
    if (c.status === 'proposed' || catalog.outcomes.some((o) => capabilityOf(catalog, o)?.id === c.id)) continue;
    for (const surface of c.surfaces ?? []) {
      const route = run.routes.find((r) => reaches(surface, r));
      if (!route) {
        skipped.push(`${c.id}: no route serves ${surface}`);
        continue;
      }
      const gap = run.gaps.find((g) => g.route === route);
      let s: Sighting | string;
      if (gap) s = probed(gap);
      else {
        // Behaviors first: an outcome on this route already promises something for another capability.
        const item = [...catalog.behaviors, ...catalog.outcomes].find((x) => reaches(x.trigger.http, route));
        const obs = item && run.observations.find((o) => o.id === item.id && o.condition === 'default');
        s = item && obs && obs.status !== null ? { route, trigger: item.trigger, status: obs.status, body: obs.body, effects: obs.effects } : `${c.id}: ${surface} didn't answer when it ran`;
      }
      if (typeof s === 'string') {
        skipped.push(s);
        continue;
      }
      const slug = routeSlug(route.split(' ')[0], route.split(' ')[1]);
      const id = taken.has(slug) ? `${c.id}.${slug}` : slug;
      if (taken.has(id)) continue;
      taken.add(id);
      outcomes.push(outcomeFrom(id, c, s));
    }
  }
  return { fragment: { outcomes }, skipped };
}

/** The body a caller sent to a route, scrubbed: from the first request that succeeded, or else the first seen (0015). */
export function bodyFinder(evidence: Evidence[]): (route: string) => { body: unknown; from: string } | undefined {
  return (route) => {
    const sent = evidence.flatMap((e) => e.calls.filter((c) => !c.outbound && c.request !== undefined && reaches(`${c.method} ${c.path}`, route)).map((call) => ({ call, from: e.name })));
    const pick = sent.find(({ call }) => call.status !== undefined && call.status >= 200 && call.status < 300) ?? sent[0];
    return pick ? { body: pick.call.request, from: pick.from } : undefined;
  };
}

/**
 * Probes every route nothing describes and adds a proposed outcome for each to oodlc/proposed.yaml.
 * With evidence files, a route a caller sent a body to is probed with that body, scrubbed, instead of an empty one.
 */
export async function proposeRoutes(projectDir: string, files: string[] = []): Promise<ProposeResult & { skipped: string[] }> {
  if (!loadConfig(projectDir).app) throw new OodleError('no-app', 'There are no routes to probe: this project has no app', { hint: 'Draft capabilities from evidence instead: `oodle discover --from <openapi, har or otlp file>`.' });
  const evidence = files.map(readEvidence);
  const run = await runProject(projectDir, evidence.length ? { probeBody: bodyFinder(evidence) } : {});
  const { fragment, skipped } = routeOutcomes(run);
  if (!fragment.outcomes.length) return { file: join(run.config.catalog, PROPOSALS_FILE), added: [], warnings: [], skipped };
  return { ...propose(projectDir, fragment), skipped };
}

/** Adds a proposed outcome for each surface of each confirmed capability with none. */
export async function proposeCapabilities(projectDir: string): Promise<ProposeResult & { skipped: string[] }> {
  if (!loadConfig(projectDir).app) throw new OodleError('no-app', 'There is nothing to run the capabilities against: this project has no app', { hint: 'Point app in oodlc/config.yaml at a Node service to protect its capabilities with outcomes.' });
  const run = await runProject(projectDir);
  const { fragment, skipped } = capabilityOutcomes(run);
  if (!fragment.outcomes.length) return { file: join(run.config.catalog, PROPOSALS_FILE), added: [], warnings: [], skipped };
  return { ...propose(projectDir, fragment), skipped };
}
