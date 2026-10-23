/**
 * Discovery: the first draft of the inventory, from what Oodle can already see.
 * Every route becomes part of a capability candidate, grouped by the resource it
 * acts on and what it does to it (`POST /orders/:id/refund` -> `orders.refund`).
 * Each candidate carries its evidence: the outcomes and behaviors that describe
 * it, the external calls and table writes seen when it ran, and how a probe
 * answered. What the code can't say (who it is for, why it exists) becomes an
 * unknown for a person to answer.
 *
 * Everything is written through `propose`, so it lands as a proposal: it never
 * blocks, and a person confirms a capability by deleting its status line.
 * See docs/decisions/0010.
 *
 * Each piece of evidence is graded by where it came from (0014): what Oodle saw
 * (a route the app serves, a probe, a recorded call or table write, a request in
 * a capture) is observed; what someone wrote (a spec's summary, the outcomes that
 * describe a route) is inferred. Only observed traffic orders the capabilities, and
 * a capture's silence about a route is a question that says what the capture covered.
 */
import { propose, type ProposeResult } from './propose.ts';
import { reaches, runProject } from './runner.ts';
import { notSeenIn, readEvidence, routesFrom, type Evidence, type Scope } from './evidence.ts';
import { OodleError } from './errors.ts';
import type { Capability, EffectRecord, EvidenceItem, Experience, RunResult, Unknown } from './types.ts';

/** Path segments that say where an API lives, not what it acts on. */
const PREFIX = /^(api|v\d+)$/;
const ACTION: Record<string, string> = { GET: 'read', POST: 'create', PUT: 'update', PATCH: 'update', DELETE: 'delete' };

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'root';

/**
 * The capability a route is part of: what it acts on, and what it does to it.
 * A route ending in a fixed segment names its action (`POST /orders/:id/refund`
 * refunds orders); otherwise the method does, so `GET /orders` and
 * `GET /orders/:id` both read orders, and `DELETE /carts/:id/items/:item` deletes cart items.
 */
export function capabilityId(route: string): string {
  const [method, path] = route.split(' ');
  const segments = path.split('?')[0].split('/').filter(Boolean);
  const param = (s: string) => s.startsWith(':') || s.startsWith('[');
  const fixed = segments.filter((s) => !param(s));
  while (fixed.length > 1 && PREFIX.test(fixed[0])) fixed.shift();
  const named = fixed.length > 1 && !param(segments.at(-1)!);
  const parts = [...(fixed.length ? fixed : ['root']), ...(named ? [] : [ACTION[method] ?? method.toLowerCase()])];
  return parts.map(slug).join('.');
}

const seen = (text: string): EvidenceItem => ({ text, grade: 'observed' });
const said = (text: string): EvidenceItem => ({ text, grade: 'inferred' });

/** "calls payment.capture, email.sent" / "writes orders": what crossed the boundary, in words. */
function effectWords(effects: EffectRecord[]): string[] {
  const calls = new Set<string>();
  const writes = new Set<string>();
  for (const e of effects) {
    if (e.error) continue;
    if (e.boundary === 'external') calls.add(e.kind);
    const table = e.boundary === 'data' ? /^db\.(.+)\.(inserted|updated|deleted)$/.exec(e.kind)?.[1] : undefined;
    if (table) writes.add(table);
  }
  return [...(calls.size ? [`calls ${[...calls].sort().join(', ')}`] : []), ...(writes.size ? [`writes ${[...writes].sort().join(', ')}`] : [])];
}

export interface Link {
  /** An outcome or behavior that could name the capability it belongs to. */
  id: string;
  kind: 'outcome' | 'behavior';
  capability: string;
}

export interface Inventory {
  capabilities: Capability[];
  /** Journeys seen in traffic: capabilities callers went through in that order, more than once. */
  experiences: Experience[];
  unknowns: Unknown[];
  /** Existing outcomes and behaviors with no `capability`, and the one their trigger reaches. A person adds it. */
  links: Link[];
  /** Routes already listed by a capability's surfaces. */
  known: string[];
}

/** File types a browser fetches that are no API: a capture is full of them. */
const ASSET = /\.(js|mjs|css|map|png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|eot|html?|txt|json)$/i;
const MAX_STEPS = 6;
const MAX_JOURNEYS = 3;

/**
 * The inventory a run implies, minus what the catalog already has. Evidence from
 * outside the code (src/evidence.ts) adds people's own words from a spec, real
 * use from traffic (which also orders the capabilities, most used first), the
 * journeys callers take, and questions about what the code and the evidence disagree on.
 */
export function inventoryFrom(run: RunResult, evidence: Evidence[] = []): Inventory {
  const { catalog } = run;
  const subjects = [...catalog.outcomes.map((item) => ({ kind: 'outcome' as const, item })), ...catalog.behaviors.map((item) => ({ kind: 'behavior' as const, item }))];
  const existing = new Map(catalog.capabilities.map((c) => [c.id, c]));
  const owner = (route: string) => catalog.capabilities.find((c) => (c.surfaces ?? []).some((s) => reaches(s, route)));
  const routeFor = (method: string, path: string) => run.routes.find((r) => reaches(`${method} ${path}`, r));

  // Traffic to other sites, and to the files a page loads, says nothing about this service.
  const hosts = new Set(evidence.flatMap((e) => e.seen.filter((s) => s.host && routeFor(s.method, s.path)).map((s) => s.host!)));
  const relevant = (s: { host?: string; path: string }) => !ASSET.test(s.path) && (!s.host || !hosts.size || hosts.has(s.host));
  const traffic = evidence.filter((e) => e.kind !== 'openapi');
  const usage = new Map<string, number>();
  for (const e of traffic) for (const s of e.seen) {
    const r = relevant(s) ? routeFor(s.method, s.path) : undefined;
    if (r) usage.set(r, (usage.get(r) ?? 0) + (s.count ?? 0));
  }

  const known: string[] = [];
  const drafts = new Map<string, Capability>();
  const words = new Map<string, string>();
  const routeOf = new Map<string, string>();
  for (const route of run.routes) {
    const listed = owner(route);
    if (listed) {
      known.push(route);
      routeOf.set(route, listed.id);
      continue;
    }
    const id = capabilityId(route);
    // A capability by that name exists but doesn't list this route: say so rather than invent a second one.
    if (existing.has(id)) {
      routeOf.set(route, id);
      continue;
    }
    routeOf.set(route, id);
    const describing = subjects.filter((s) => reaches(s.item.trigger.http, route));
    const recorded = run.observations.filter((o) => describing.some((s) => s.item.id === o.id)).flatMap((o) => o.effects);
    const gap = run.gaps.find((g) => g.route === route);
    const named = (kind: string) => describing.filter((s) => s.kind === kind).map((s) => s.item.id);
    const specs = evidence.filter((e) => e.kind === 'openapi').flatMap((e) => e.seen.filter((s) => routeFor(s.method, s.path) === route).map((s) => ({ e, s })));
    for (const { s } of specs) if (s.summary && !words.has(id)) words.set(id, s.summary);
    const evidenceLines = [
      // With an app, the route list is the app's own; without one, routes come from the evidence below (0011).
      ...(run.config.app ? [seen(`${route}: served by the app`)] : []),
      ...(['outcome', 'behavior'] as const).filter((k) => named(k).length).map((k) => said(`${route}: described by ${k}${named(k).length > 1 ? 's' : ''} ${named(k).join(', ')}`)),
      ...specs.map(({ e, s }) => said(`${route}: ${e.name} says ${s.summary ? `"${s.summary}"` : 'nothing about it'}${s.operationId ? ` (${s.operationId})` : ''}${s.tags?.length ? `, tagged ${s.tags.join(', ')}` : ''}`)),
      // A capture that never reached the route says nothing about it here; the question below cites what it covered.
      ...traffic.flatMap((e) => {
        const n = e.seen.filter((s) => relevant(s) && routeFor(s.method, s.path) === route).reduce((sum, s) => sum + (s.count ?? 0), 0);
        return n ? [seen(`${route}: ${n} request${n === 1 ? '' : 's'} in ${e.name}`)] : [];
      }),
      ...(gap && gap.probe.status !== null ? [seen(`${route}: answered ${gap.probe.status} when probed`)] : []),
      ...effectWords([...recorded, ...(gap?.probe.effects ?? [])]).map((w) => seen(`${route}: ${w}`)),
    ];
    const draft = drafts.get(id) ?? { id, statement: '', surfaces: [], evidence: [], status: 'proposed' as const };
    draft.surfaces!.push(route);
    draft.evidence!.push(...evidenceLines);
    drafts.set(id, draft);
  }

  // A capability serves an intent when every approved outcome on its routes says so.
  // Only observed traffic ranks: a spec's operations or a capability nobody has seen used come last (0014).
  const used = (surfaces: string[]) => run.routes.filter((r) => surfaces.some((s) => reaches(s, r))).reduce((n, r) => n + (usage.get(r) ?? 0), 0);
  const ordered = [...drafts.values()].sort((a, b) => used(b.surfaces!) - used(a.surfaces!));
  drafts.clear();
  for (const d of ordered) {
    const intents = new Set(catalog.outcomes.filter((o) => o.status !== 'proposed' && d.surfaces!.some((r) => reaches(o.trigger.http, r))).map((o) => o.intent).filter(Boolean));
    const spec = words.get(d.id);
    drafts.set(d.id, {
      id: d.id,
      statement: `TODO: who can do what through ${d.surfaces!.join(', ')}? ${spec ? `The spec says "${spec}". ` : ''}Say it as "<actor> can <verb> <object>".`,
      ...(intents.size === 1 ? { intent: [...intents][0] } : {}),
      surfaces: d.surfaces,
      ...(d.evidence!.length ? { evidence: d.evidence } : {}),
      status: 'proposed',
    });
  }

  const links: Link[] = [];
  for (const s of subjects) {
    if (s.item.capability) continue;
    const route = run.routes.find((r) => reaches(s.item.trigger.http, r));
    const capability = route && routeOf.get(route);
    if (capability) links.push({ id: s.item.id, kind: s.kind, capability });
  }

  // Journeys: the capabilities one caller went through, in order. A sequence seen more than once is worth naming.
  const journeys = new Map<string, { steps: string[]; count: number; from: Set<string> }>();
  for (const e of traffic) for (const seq of e.sequences) {
    const steps: string[] = [];
    for (const r of seq) {
      const route = relevant(r) ? routeFor(r.method, r.path) : undefined;
      const cap = route && routeOf.get(route);
      if (cap && steps.at(-1) !== cap) steps.push(cap);
    }
    if (steps.length < 2) continue;
    const key = steps.slice(0, MAX_STEPS).join(' ');
    const j = journeys.get(key) ?? { steps: steps.slice(0, MAX_STEPS), count: 0, from: new Set<string>() };
    j.count++;
    j.from.add(e.name);
    journeys.set(key, j);
  }
  const knownJourneys = new Set(catalog.experiences.map((x) => (x.steps ?? []).join(' ')));
  const experiences: Experience[] = [...journeys.values()]
    .filter((j) => j.count > 1 && !knownJourneys.has(j.steps.join(' ')))
    .sort((a, b) => b.count - a.count || b.steps.length - a.steps.length)
    .slice(0, MAX_JOURNEYS)
    .map((j) => ({
      id: `journey.${slugOf(j.steps[0])}-then-${slugOf(j.steps.at(-1)!)}`,
      statement: `TODO: who goes through ${j.steps.join(' then ')}, and what are they trying to get done?`,
      steps: j.steps,
      evidence: [seen(`seen ${j.count} times in ${[...j.from].join(', ')}`)],
      status: 'proposed' as const,
    }))
    .filter((x, i, all) => all.findIndex((y) => y.id === x.id) === i && !catalog.experiences.some((y) => y.id === x.id));

  // What the code can't answer: why a capability exists, and whether an intent nothing serves is still wanted.
  const asked = new Set(catalog.unknowns.flatMap((u) => u.about ?? []));
  const taken = new Set(catalog.unknowns.map((u) => u.id));
  const unknowns: Unknown[] = [];
  const ask = (u: Unknown) => {
    if (taken.has(u.id) || (u.about ?? []).some((id) => asked.has(id))) return;
    taken.add(u.id);
    unknowns.push(u);
  };
  for (const d of drafts.values()) {
    if (!d.intent) ask({ id: `why.${d.id}`, question: `Who uses ${d.surfaces!.join(', ')}, and which intent does it serve?`, ask: 'product owner', about: [d.id] });
  }
  const served = new Set([...catalog.outcomes.map((o) => o.intent), ...catalog.capabilities.map((c) => c.intent), ...[...drafts.values()].map((d) => d.intent)].filter(Boolean));
  for (const i of catalog.intents) {
    if (!served.has(i.id)) ask({ id: `unserved.${i.id}`, question: `No outcome or capability traces to "${i.statement}" yet. Is it built somewhere the catalog doesn't describe, planned, or no longer wanted?`, ask: 'product owner', about: [i.id] });
  }
  // Where the evidence and the code disagree.
  for (const e of evidence) {
    const missing = e.seen.filter((s) => relevant(s) && !routeFor(s.method, s.path)).map((s) => `${s.method} ${s.path}${s.count ? ` (${s.count})` : ''}`);
    if (missing.length) {
      const list = `${missing.slice(0, 5).join(', ')}${missing.length > 5 ? `, and ${missing.length - 5} more` : ''}`;
      ask(e.kind === 'openapi'
        ? { id: `spec-only.${slugOf(e.name)}`, question: `${e.name} lists ${list}, which the app doesn't serve. Is the spec ahead of the code, or out of date?`, ask: 'API owner' }
        : { id: `unrouted.${slugOf(e.name)}`, question: `${e.name} has requests no route serves: ${list}. Another service, an old client, or a missing route?`, ask: 'API owner' });
    }
  }
  // Coverage is not absence: a capability no captured request reached was not seen in that window, on those hosts.
  // Asked of every capability with surfaces, new or not, once each (`unused.` is how 0.11 to 0.13 named it).
  if (traffic.length) {
    const scopes: Scope[] = traffic.map((e) => e.scope);
    for (const c of [...drafts.values(), ...catalog.capabilities]) {
      if (!c.surfaces?.length || used(c.surfaces) || taken.has(`unseen.${c.id}`) || taken.has(`unused.${c.id}`)) continue;
      taken.add(`unseen.${c.id}`);
      unknowns.push({ id: `unseen.${c.id}`, question: `${c.surfaces.join(', ')}: ${notSeenIn(scopes)} Who calls it, and how often?`, ask: 'product owner', about: [c.id] });
    }
  }

  return { capabilities: [...drafts.values()], experiences, unknowns, links, known };
}

const slugOf = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

export interface DiscoverResult extends ProposeResult {
  /** What was proposed, in full, so a caller can show it without reading the file. */
  capabilities: Capability[];
  experiences: Experience[];
  unknowns: Unknown[];
  links: Link[];
  known: string[];
  /** Routes no outcome or behavior describes: `oodle propose --routes` drafts outcomes for them. */
  undescribed: number;
  /** The evidence files read, what each held, and what it covered. */
  evidence: { file: string; kind: Evidence['kind']; requests: number; scope: Scope }[];
}

/** Runs the project and proposes the inventory it implies. Adds, never changes: see src/propose.ts. */
export async function discover(projectDir: string, files: string[] = []): Promise<DiscoverResult> {
  const evidence = files.map(readEvidence);
  const run = await runProject(projectDir);
  // With no app to ask, the routes are the ones the evidence names (0011).
  if (!run.config.app) {
    if (!evidence.length) throw new OodleError('evidence', 'Nothing to discover from: this project has no app to run', { hint: 'Pass evidence with --from: an OpenAPI spec, a HAR capture or an OTLP JSON trace export.' });
    run.routes = routesFrom(evidence, reaches, ASSET);
  }
  const inv = inventoryFrom(run, evidence);
  const fragment = {
    ...(inv.capabilities.length ? { capabilities: inv.capabilities } : {}),
    ...(inv.experiences.length ? { experiences: inv.experiences } : {}),
    ...(inv.unknowns.length ? { unknowns: inv.unknowns } : {}),
  };
  // Oodle graded this evidence itself, from where each piece came from, so the grades stand (0014).
  const result = Object.keys(fragment).length ? propose(projectDir, fragment, { graded: true }) : { file: '', added: [], warnings: [] };
  return {
    ...result,
    capabilities: inv.capabilities,
    experiences: inv.experiences,
    unknowns: inv.unknowns,
    links: inv.links,
    known: inv.known,
    undescribed: run.gaps.length,
    evidence: evidence.map((e, i) => ({ file: files[i], kind: e.kind, requests: e.seen.reduce((n, s) => n + (s.count ?? 1), 0), scope: e.scope })),
  };
}
