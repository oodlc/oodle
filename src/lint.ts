import type { Catalog, LintResult } from './types.ts';

/**
 * Traceability checks from the spec:
 * - outcome with no intent                -> error (unjustified lock-in)
 * - reference to an unknown id            -> error
 * - intent with no outcomes               -> warning (backlog)
 * - behavior across a boundary            -> warning (needs a promotion decision)
 * - outcome on the internal boundary      -> warning (internals should stay replaceable)
 */
export function lint(catalog: Catalog): LintResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const intents = new Set(catalog.intents.map((i) => i.id));
  const conditions = new Set(catalog.conditions.map((c) => c.id));
  const constraints = new Set(catalog.constraints.map((c) => c.id));
  const used = new Set<string>();

  for (const o of catalog.outcomes) {
    const where = `${catalog.sources[`outcomes:${o.id}`]}: ${o.id}`;
    if (!o.intent) errors.push(`${where}: outcome has no intent. Link it to an intent, or demote it to a behavior.`);
    else {
      if (!intents.has(o.intent)) errors.push(`${where}: unknown intent "${o.intent}"`);
      used.add(o.intent);
    }
    for (const c of o.conditions ?? []) if (!conditions.has(c)) errors.push(`${where}: unknown condition "${c}"`);
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

  for (const c of catalog.constraints) {
    try {
      new Function('effects', 'state', 'response', `return (${c.check});`);
    } catch (err) {
      errors.push(`${catalog.sources[`constraints:${c.id}`]}: ${c.id}: check does not parse: ${(err as Error).message}`);
    }
  }

  return { errors, warnings };
}
