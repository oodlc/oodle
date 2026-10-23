import type { Catalog, Config, LintResult } from './types.ts';
import { allConditions } from './security.ts';

/**
 * Traceability checks from the spec:
 * - outcome tracing to neither an intent nor a capability -> error (unjustified lock-in, 0001 as revised by 0010)
 * - approved outcome tracing only to a proposed capability -> error (confirm the capability first)
 * - reference to an unknown id            -> error
 * - intent with no outcomes               -> warning (backlog)
 * - confirmed capability with no outcomes -> warning (explained, not yet protected)
 * - capability statement that says nothing (TODO, vague verbs) -> warning
 * - behavior across a boundary            -> warning (needs a promotion decision)
 * - outcome on the internal boundary      -> warning (internals should stay replaceable)
 * - `when` for a condition the outcome does not run under -> error (it would never apply)
 * - approved outcome tracing to a proposed intent -> error (approve the intent first)
 * - proposed entries                      -> warning (waiting for a human)
 * - given.db with no `database` in config -> error (there is no database to seed)
 */
/** Verbs that name no action anyone could check: "handles orders" says nothing about what a customer gets. */
const VAGUE = /\b(handles?|manages?|process(es)?|supports?|deals? with)\b/i;

/** Why a capability statement says nothing yet, or null when it says something. */
export function saysNothing(statement: string): string | null {
  if (/\bTODO\b/.test(statement)) return 'statement is still a TODO.';
  const m = VAGUE.exec(statement);
  return m ? `"${m[0]}" doesn't say what the actor can do.` : null;
}

/** A given.db that names at least one table. An empty one seeds nothing, so it needs no database. */
const seeds = (db: object | undefined) => !!db && Object.keys(db).length > 0;

export function lint(catalog: Catalog, config?: Config): LintResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const intents = new Set(catalog.intents.map((i) => i.id));
  const proposedIntents = new Set(catalog.intents.filter((i) => i.status === 'proposed').map((i) => i.id));
  const conditions = new Set(allConditions(catalog).keys());
  const constraints = new Set(catalog.constraints.map((c) => c.id));
  const actors = new Set(catalog.actors.map((a) => a.id));
  const capabilities = new Map(catalog.capabilities.map((c) => [c.id, c]));
  const used = new Set<string>();
  const protectedCapabilities = new Set<string>();

  for (const o of catalog.outcomes) {
    const where = `${catalog.sources[`outcomes:${o.id}`]}: ${o.id}`;
    const capability = o.capability ? capabilities.get(o.capability) : undefined;
    if (!o.intent && !o.capability) errors.push(`${where}: outcome traces to nothing. Link it to an intent or a capability, or demote it to a behavior.`);
    if (o.intent) {
      if (!intents.has(o.intent)) errors.push(`${where}: unknown intent "${o.intent}"`);
      else if (proposedIntents.has(o.intent) && o.status !== 'proposed') errors.push(`${where}: traces to the proposed intent "${o.intent}". Approve the intent first.`);
      used.add(o.intent);
    }
    if (o.capability) {
      if (!capability) errors.push(`${where}: unknown capability "${o.capability}"`);
      else {
        // A capability justifies an outcome only once a person has confirmed it. With an intent beside it, the intent does.
        if (!o.intent && capability.status === 'proposed' && o.status !== 'proposed') errors.push(`${where}: traces only to the proposed capability "${o.capability}". Confirm the capability first, or link an intent.`);
        if (capability.intent) used.add(capability.intent);
        // A proposal never blocks, so it doesn't protect anything yet.
        if (o.status !== 'proposed') protectedCapabilities.add(capability.id);
      }
    }
    for (const c of o.conditions ?? []) if (!conditions.has(c)) errors.push(`${where}: unknown condition "${c}"`);
    for (const c of Object.keys(o.when ?? {})) {
      if (!(o.conditions ?? []).includes(c)) errors.push(`${where}: "when" names ${c}, which is not in this outcome's conditions, so it would never apply`);
    }
    if (o.status === 'proposed') warnings.push(`${where}: proposed outcome, waiting for a human. Approve it by deleting "status: proposed".`);
    for (const c of o.constraints ?? []) if (!constraints.has(c)) errors.push(`${where}: unknown constraint "${c}"`);
    if (o.boundary === 'internal') warnings.push(`${where}: outcome on the internal boundary. Internals should stay replaceable.`);
  }

  for (const b of catalog.behaviors) {
    const where = `${catalog.sources[`behaviors:${b.id}`]}: ${b.id}`;
    if (b.capability && !capabilities.has(b.capability)) errors.push(`${where}: unknown capability "${b.capability}"`);
    for (const c of b.conditions ?? []) if (!conditions.has(c)) errors.push(`${where}: unknown condition "${c}"`);
    if (b.boundary !== 'internal') {
      warnings.push(`${where}: behavior crosses the ${b.boundary} boundary. Promote it to an outcome, or move it inside.`);
    }
  }

  // The inventory explains the system and never blocks; it can only be wrong about its own references.
  const refs = (where: string, x: { actor?: string; intent?: string }) => {
    if (x.actor && !actors.has(x.actor)) errors.push(`${where}: unknown actor "${x.actor}"`);
    if (x.intent && !intents.has(x.intent)) errors.push(`${where}: unknown intent "${x.intent}"`);
  };
  for (const c of catalog.capabilities) {
    const where = `${catalog.sources[`capabilities:${c.id}`]}: ${c.id}`;
    refs(where, c);
    const vague = saysNothing(c.statement);
    if (vague) warnings.push(`${where}: ${vague} Say it as "<actor> can <verb> <object>", e.g. "a shopper can pay for a cart".`);
    if (c.status === 'proposed') warnings.push(`${where}: proposed capability, waiting for a person. Confirm it by deleting "status: proposed".`);
    else if (!protectedCapabilities.has(c.id)) warnings.push(`${where}: capability has no outcomes yet. It is explained, not protected.`);
  }
  for (const e of catalog.experiences) {
    const where = `${catalog.sources[`experiences:${e.id}`]}: ${e.id}`;
    refs(where, e);
    for (const step of e.steps ?? []) if (!capabilities.has(step)) errors.push(`${where}: unknown capability "${step}" in steps`);
    if (e.status === 'proposed') warnings.push(`${where}: proposed experience, waiting for a person. Confirm it by deleting "status: proposed".`);
  }
  for (const a of catalog.actors) {
    if (a.status === 'proposed') warnings.push(`${catalog.sources[`actors:${a.id}`]}: ${a.id}: proposed actor, waiting for a person. Confirm it by deleting "status: proposed".`);
  }
  const known = new Set(Object.keys(catalog.sources).map((k) => k.slice(k.indexOf(':') + 1)));
  for (const u of catalog.unknowns) {
    const where = `${catalog.sources[`unknowns:${u.id}`]}: ${u.id}`;
    for (const id of u.about ?? []) if (!known.has(id)) errors.push(`${where}: "about" names "${id}", which is not in the catalog`);
    if (!u.answer) warnings.push(`${where}: open question${u.ask ? ` for the ${u.ask}` : ''}: ${u.question}`);
  }

  for (const i of catalog.intents) {
    if (!used.has(i.id)) warnings.push(`${catalog.sources[`intents:${i.id}`]}: ${i.id}: intent has no outcomes yet (backlog)`);
  }

  if (config && !config.database) {
    const seeding = [
      ...(seeds(config.defaults?.given?.db) ? ['oodlc/config.yaml: defaults.given'] : []),
      ...[...catalog.outcomes, ...catalog.behaviors].filter((x) => seeds(x.trigger.given?.db)).map((x) => `${catalog.sources[`${'expect' in x ? 'outcomes' : 'behaviors'}:${x.id}`]}: ${x.id}`),
      ...catalog.conditions.filter((c) => seeds(c.given.db)).map((c) => `${catalog.sources[`conditions:${c.id}`]}: ${c.id}`),
    ];
    for (const where of seeding) errors.push(`${where}: given.db seeds a database, but oodlc/config.yaml has no "database". Add database: { schema: <a .sql file or migrations folder> }.`);
  }

  // With no app nothing runs, so a promise here would read as protection that nobody checks (0011).
  if (config && !config.app) {
    for (const section of ['outcomes', 'behaviors', 'conditions', 'constraints'] as const) {
      const n = catalog[section].length;
      if (n) errors.push(`oodlc/config.yaml: ${n} ${n === 1 ? section.replace(/s$/, '') : section} declared, but nothing runs ${n === 1 ? 'it' : 'them'}: there is no app. Point app at your service to protect it, or keep this project to intents and the inventory.`);
    }
  }

  for (const id of config?.probe?.conditions ?? []) {
    if (!conditions.has(id)) errors.push(`oodlc/config.yaml: probe.conditions: unknown condition "${id}"`);
  }
  for (const i of catalog.intents) {
    if (i.status === 'proposed') warnings.push(`${catalog.sources[`intents:${i.id}`]}: ${i.id}: proposed intent, waiting for a human. Approve it by deleting "status: proposed".`);
  }

  for (const c of catalog.constraints) {
    if (c.status === 'proposed') warnings.push(`${catalog.sources[`constraints:${c.id}`]}: ${c.id}: proposed constraint, checked and reported but not blocking. Approve it by deleting "status: proposed".`);
    try {
      new Function('effects', 'state', 'response', 'request', 'db', `return (${c.check});`);
    } catch (err) {
      errors.push(`${catalog.sources[`constraints:${c.id}`]}: ${c.id}: check does not parse: ${(err as Error).message}`);
    }
  }

  return { errors, warnings };
}
