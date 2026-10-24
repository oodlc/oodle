/**
 * The spec's six kinds of entry, as zod schemas: permissive on prose, strict on
 * structure. Two tiers: intent, personas, domain, journeys and constraints are
 * declared (people write them, only people change them); decisions are decided
 * (the generator writes them where the spec is silent).
 */
import { z } from 'zod';

export const Persona = z.strictObject({
  /** Capability phrases. They become the action vocabulary (`owner.book_walk`). */
  can: z.array(z.string().min(1)),
  cannot: z.array(z.string().min(1)).optional(),
});
export type Persona = z.infer<typeof Persona>;

/** `{ owner, minutes: [30, 60] }`: a bare field name is null, a list is its allowed values. */
const FieldValue = z.union([z.string(), z.array(z.union([z.string(), z.number()])), z.null()]);

export const Entity = z.strictObject({
  fields: z.record(z.string(), FieldValue).default({}),
  /** "requested -> accepted -> done | declined | cancelled" */
  states: z.string().optional(),
  rules: z.array(z.string().min(1)).default([]),
});
export type Entity = z.infer<typeof Entity>;

/**
 * A step is prose, compiled later. In YAML, `- Sam accepts: Ada sees "Accepted"` is a one-key map,
 * not a string, and the README's own example is written that way. Such a step is read back as the
 * line it was: `Sam accepts: Ada sees "Accepted"`.
 */
export const JourneyStep = z.preprocess(
  (v) => (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 1 ? Object.entries(v).map(([k, x]) => `${k}: ${x}`)[0] : v),
  z.string({ error: 'a step is one line of prose; quote it if it contains ": "' }).min(1),
);

export const Journey = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'a journey id is lowercase words joined by dashes'),
  persona: z.string().min(1),
  steps: z.array(JourneyStep).min(1),
});
export type Journey = z.infer<typeof Journey>;

export const CHECKS = ['build', 'production', 'generator'] as const;
export type Check = (typeof CHECKS)[number];

export const ConstraintLong = z.strictObject({
  text: z.string().min(1),
  /** How it is checked. Classified once (and written back) when absent. */
  check: z.enum(CHECKS).optional(),
});
/** A bare string is a constraint whose check is not classified yet. */
export const Constraint = z.union([
  z
    .string()
    .min(1)
    .transform((text) => ({ text })),
  ConstraintLong,
]);
export type Constraint = z.infer<typeof ConstraintLong>;

const Ref = z.string().regex(/^[a-z_]+:\S/, 'a ref is kind:name, like entity:walk or journey:first-booking');

export const DecisionLong = z.strictObject({
  id: z.string().regex(/^d_[a-z0-9_]+$/),
  text: z.string().min(1),
  about: z.array(Ref).default([]),
  source: z.enum(['generator', 'person']),
  status: z.enum(['pinned', 'rule', 'dont_care']),
  created_by_build: z.string().optional(),
  answered_by: z.string().optional(),
  from_gap: z.string().optional(),
});
export type Decision = z.infer<typeof DecisionLong>;

export interface Spec {
  intent?: string;
  personas: Record<string, Persona>;
  domain: Record<string, Entity>;
  journeys: Journey[];
  constraints: Constraint[];
  decisions: Decision[];
}

export const DECLARED = ['intent', 'personas', 'domain', 'journeys', 'constraints'] as const;
export const SECTIONS = [...DECLARED, 'decisions'] as const;
export type Section = (typeof SECTIONS)[number];
