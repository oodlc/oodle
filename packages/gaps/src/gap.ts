/**
 * The gap file, `oodle/gaps/<id>.yaml`: one question about something two builds did differently.
 * The shape is the inbox's wire format too (apps/inbox/src/shared/protocol.ts).
 */
import { z } from 'zod';

export const KINDS = ['sort_order', 'format', 'permission', 'rule', 'extra_element', 'wording', 'pagination', 'decision_moved', 'other'] as const;
export const STATUSES = ['open', 'answered', 'dismissed', 'applied'] as const;

/** What choosing an option writes to the spec. Only a person's answer may write the declared tier. */
export const Becomes = z.strictObject({
  decision: z.string().optional(),
  constraint: z.string().optional(),
  rule: z.strictObject({ entity: z.string(), text: z.string() }).optional(),
  cannot: z.strictObject({ persona: z.string(), text: z.string() }).optional(),
  /** The decision this one replaces, by id. */
  replaces: z.string().optional(),
});
export type Becomes = z.infer<typeof Becomes>;

export const Option = z.strictObject({ id: z.string(), label: z.string(), becomes: Becomes.optional() });
export type Option = z.infer<typeof Option>;

export const Side = z.strictObject({ summary: z.string(), sample: z.array(z.string()) });

export const Answer = z.strictObject({
  option: z.string().optional(),
  text: z.string().optional(),
  target: z.enum(['decision', 'domain_rule', 'constraint']).optional(),
  dont_care: z.boolean().optional(),
  dismiss: z.boolean().optional(),
  /** Why, in one sentence. Required from an agent. */
  reason: z.string().optional(),
  /** The inbox's answer id, when it came from there. Applying is idempotent by it. */
  id: z.string().optional(),
});
export type Answer = z.infer<typeof Answer>;

export const Gap = z.looseObject({
  id: z.string().regex(/^g_[0-9a-f]+$/),
  status: z.enum(STATUSES),
  kind: z.enum(KINDS),
  tier: z.enum(['decided', 'declared']),
  tier_reason: z.string().optional(),
  route: z.enum(['agent', 'human']),
  spec_hash: z.string(),
  found_in: z.array(z.string()),
  about: z.array(z.string()),
  question: z.string(),
  evidence: z.looseObject({
    scenario: z.string(),
    scenario_text: z.string().optional(),
    a: Side,
    b: Side,
  }),
  options: z.array(Option),
  intent_id: z.string().optional(),
  answer: Answer.nullable().default(null),
  answered_by: z.string().nullable().default(null),
  answered_at: z.string().nullable().default(null),
  applied_in: z.string().nullable().default(null),
  /** Earlier answers this one replaced (a person's answer over an agent's). */
  history: z.array(z.looseObject({ answer: Answer, answered_by: z.string(), answered_at: z.string().nullable(), replaced_at: z.string() })).optional(),
});
export type Gap = z.infer<typeof Gap>;

/** The fields a gap file is written with, in this order. */
export const GAP_KEYS = [
  'id',
  'status',
  'kind',
  'tier',
  'tier_reason',
  'route',
  'spec_hash',
  'found_in',
  'about',
  'intent_id',
  'question',
  'evidence',
  'options',
  'answer',
  'answered_by',
  'answered_at',
  'applied_in',
  'history',
] as const;
