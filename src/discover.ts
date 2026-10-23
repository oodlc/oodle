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
 */
import { propose, type ProposeResult } from './propose.ts';
import { reaches, runProject } from './runner.ts';
import type { Capability, EffectRecord, RunResult, Unknown } from './types.ts';

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
  unknowns: Unknown[];
  /** Existing outcomes and behaviors with no `capability`, and the one their trigger reaches. A person adds it. */
  links: Link[];
  /** Routes already listed by a capability's surfaces. */
  known: string[];
}

/** The inventory a run implies, minus what the catalog already has. */
export function inventoryFrom(run: RunResult): Inventory {
  const { catalog } = run;
  const subjects = [...catalog.outcomes.map((item) => ({ kind: 'outcome' as const, item })), ...catalog.behaviors.map((item) => ({ kind: 'behavior' as const, item }))];
  const existing = new Map(catalog.capabilities.map((c) => [c.id, c]));
  const owner = (route: string) => catalog.capabilities.find((c) => (c.surfaces ?? []).some((s) => reaches(s, route)));

  const known: string[] = [];
  const drafts = new Map<string, Capability>();
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
    const seen = run.observations.filter((o) => describing.some((s) => s.item.id === o.id)).flatMap((o) => o.effects);
    const gap = run.gaps.find((g) => g.route === route);
    const named = (kind: string) => describing.filter((s) => s.kind === kind).map((s) => s.item.id);
    const evidence = [
      ...(['outcome', 'behavior'] as const).filter((k) => named(k).length).map((k) => `${route}: described by ${k}${named(k).length > 1 ? 's' : ''} ${named(k).join(', ')}`),
      ...(gap && gap.probe.status !== null ? [`${route}: answered ${gap.probe.status} when probed`] : []),
      ...effectWords([...seen, ...(gap?.probe.effects ?? [])]).map((w) => `${route}: ${w}`),
    ];
    const draft = drafts.get(id) ?? { id, statement: '', surfaces: [], evidence: [], status: 'proposed' as const };
    draft.surfaces!.push(route);
    draft.evidence!.push(...evidence);
    drafts.set(id, draft);
  }

  // A capability serves an intent when every approved outcome on its routes says so.
  for (const [id, d] of drafts) {
    const intents = new Set(catalog.outcomes.filter((o) => o.status !== 'proposed' && d.surfaces!.some((r) => reaches(o.trigger.http, r))).map((o) => o.intent).filter(Boolean));
    drafts.set(id, {
      id,
      statement: `TODO: who can do what through ${d.surfaces!.join(', ')}? Say it as "<actor> can <verb> <object>".`,
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

  return { capabilities: [...drafts.values()], unknowns, links, known };
}

export interface DiscoverResult extends ProposeResult {
  /** What was proposed, in full, so a caller can show it without reading the file. */
  capabilities: Capability[];
  unknowns: Unknown[];
  links: Link[];
  known: string[];
  /** Routes no outcome or behavior describes: `oodle propose --routes` drafts outcomes for them. */
  undescribed: number;
}

/** Runs the project and proposes the inventory it implies. Adds, never changes: see src/propose.ts. */
export async function discover(projectDir: string): Promise<DiscoverResult> {
  const run = await runProject(projectDir);
  const inv = inventoryFrom(run);
  const fragment = { ...(inv.capabilities.length ? { capabilities: inv.capabilities } : {}), ...(inv.unknowns.length ? { unknowns: inv.unknowns } : {}) };
  const result = Object.keys(fragment).length ? propose(projectDir, fragment) : { file: '', added: [], warnings: [] };
  return { ...result, capabilities: inv.capabilities, unknowns: inv.unknowns, links: inv.links, known: inv.known, undescribed: run.gaps.length };
}
