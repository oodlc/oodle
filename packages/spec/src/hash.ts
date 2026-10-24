import { createHash } from 'node:crypto';
import type { Spec } from './schema.ts';

/** JSON with object keys sorted, so equal values give equal text. (From v0's src/expect.ts.) */
export function stableStringify(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value as object)
    .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(',')}}`;
}

export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

const normalizeText = (text: string) => text.trim().replace(/\s+/g, ' ').toLowerCase();

/** "d_" and a short hash of the decision's text when it was created. The id stays if the text is edited later. */
export const decisionId = (text: string) => `d_${sha256(normalizeText(text)).slice(0, 8)}`;

export type Tier = 'declared' | 'decided';

/** The declared tier as data: what the tier guard compares and the hash covers. Journeys by id, so file order doesn't count. */
export function declaredOf(spec: Spec) {
  return {
    intent: spec.intent ?? null,
    personas: spec.personas,
    domain: spec.domain,
    journeys: Object.fromEntries(spec.journeys.map((j) => [j.id, { persona: j.persona, steps: j.steps }])),
    constraints: spec.constraints.map((c) => ({ text: c.text, check: c.check })),
  };
}

/** The decided tier as data: what each decision says, not who wrote it or when. */
export function decidedOf(spec: Spec) {
  return spec.decisions.map((d) => ({ text: d.text, about: d.about, status: d.status }));
}

/**
 * A stable hash of what the spec says. Builds, compiled artifacts and gap runs are keyed by it.
 * Layout, formatting, comments, key order and provenance fields don't change it.
 */
export function specHash(spec: Spec, opts: { tiers?: Tier[] } = {}): string {
  const tiers = opts.tiers ?? ['declared', 'decided'];
  const data: Record<string, unknown> = {};
  if (tiers.includes('declared')) data.declared = declaredOf(spec);
  if (tiers.includes('decided')) data.decided = decidedOf(spec);
  return sha256(stableStringify(data));
}
