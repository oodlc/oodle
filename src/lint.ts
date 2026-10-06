import type { Catalog, Config, LintResult } from './types.ts';
import { allConditions } from './security.ts';

/**
 * Traceability checks from the spec:
 * - outcome with no intent                -> error (unjustified lock-in)
 * - reference to an unknown id            -> error
 * - intent with no outcomes               -> warning (backlog)
 * - behavior across a boundary            -> warning (needs a promotion decision)
 * - outcome on the internal boundary      -> warning (internals should stay replaceable)
 * - `when` for a condition the outcome does not run under -> error (it would never apply)
 * - approved outcome tracing to a proposed intent -> error (approve the intent first)
 * - proposed entries                      -> warning (waiting for a human)
 * - given.db with no `database` in config -> error (there is no database to seed)
 */
/** A given.db that names at least one table. An empty one seeds nothing, so it needs no database. */
const seeds = (db: object | undefined) => !!db && Object.keys(db).length > 0;

export function lint(catalog: Catalog, config?: Config): LintResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const intents = new Set(catalog.intents.map((i) => i.id));
  const proposedIntents = new Set(catalog.intents.filter((i) => i.status === 'proposed').map((i) => i.id));
  const conditions = new Set(allConditions(catalog).keys());
  const constraints = new Set(catalog.constraints.map((c) => c.id));
  const used = new Set<string>();

  for (const o of catalog.outcomes) {
    const where = `${catalog.sources[`outcomes:${o.id}`]}: ${o.id}`;
    if (!o.intent) errors.push(`${where}: outcome has no intent. Link it to an intent, or demote it to a behavior.`);
    else {
      if (!intents.has(o.intent)) errors.push(`${where}: unknown intent "${o.intent}"`);
      else if (proposedIntents.has(o.intent) && o.status !== 'proposed') errors.push(`${where}: traces to the proposed intent "${o.intent}". Approve the intent first.`);
      used.add(o.intent);
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
    for (const c of b.conditions ?? []) if (!conditions.has(c)) errors.push(`${where}: unknown condition "${c}"`);
    if (b.boundary !== 'internal') {
      warnings.push(`${where}: behavior crosses the ${b.boundary} boundary. Promote it to an outcome, or move it inside.`);
    }
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
