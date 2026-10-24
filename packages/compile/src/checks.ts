/**
 * Constraints checked on every build, and pinned decisions, compiled once into checks over what
 * the simulation observes. A check is one of a few kinds, so what it means stays readable in
 * oodle/compiled/checks/:
 *
 * - `scenario`: a short scenario whose expectations must hold ("walks are listed soonest first":
 *   book three walks out of order, look at the list, expect them in order);
 * - `never_shows_field`: no persona of `viewers` ever sees another fixture's `field`, for fixtures
 *   of the `owners` personas ("no one sees another owner's address");
 * - `never_matches`: no screen (seen by `viewers`, if given) matches a pattern;
 * - `unchecked`: the model couldn't make a check, and says why. `oodle verify` warns about these
 *   and `oodle status` lists them; they are never silently skipped.
 */
import type { Scenario } from '@oodle/sim';
import { type Constraint, type Decision, type Spec, sha256, stableStringify } from '@oodle/spec';
import { z } from 'zod';
import { SCENARIO_RULES, SPEC_CONTEXT, SYSTEM } from './journeys.ts';
import { type Model, ModelError } from './llm.ts';
import { ScenarioSchema, scenarioProblems } from './scenario.ts';
import type { Vocabulary } from './vocabulary.ts';

export const CheckSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('scenario'), scenario: ScenarioSchema }),
  z.strictObject({
    kind: z.literal('never_shows_field'),
    field: z.string().describe('a fixture field, like address'),
    viewers: z.array(z.string()).describe('personas who must never see it'),
    owners: z.array(z.string()).describe('personas whose field it is; a viewer may still see their own'),
  }),
  z.strictObject({
    kind: z.literal('never_matches'),
    pattern: z.string().describe('a JavaScript regular expression, case-insensitive'),
    viewers: z.array(z.string()).optional(),
  }),
  z.strictObject({ kind: z.literal('unchecked'), reason: z.string() }),
]);
export type Check = z.infer<typeof CheckSchema>;

export interface CompiledCheck {
  /** What it checks: a constraint (by text) or a decision (by id). */
  for: { constraint: string } | { decision: string };
  text: string;
  hash: string;
  /** The model that compiled it. */
  by: string;
  check: Check;
}

export const checkId = (c: CompiledCheck['for']) => ('decision' in c ? c.decision : `c_${sha256(c.constraint).slice(0, 8)}`);

export function checkHash(spec: Spec, text: string, vocab: Vocabulary): string {
  return sha256(stableStringify({ text, personas: spec.personas, domain: spec.domain, vocab: vocab.hash }));
}

const Answer = z.strictObject({ check: CheckSchema });

export async function compileCheck(
  spec: Spec,
  item: { constraint: Constraint } | { decision: Decision },
  vocab: Vocabulary,
  model: Model,
): Promise<CompiledCheck> {
  const text = 'constraint' in item ? item.constraint.text : item.decision.text;
  const target: CompiledCheck['for'] = 'constraint' in item ? { constraint: text } : { decision: item.decision.id };
  const what = 'constraint' in item ? 'constraint (must always hold)' : 'decision (pinned: every build must keep it)';
  const scenarioId = `check/${checkId(target)}`;
  let prompt = `${SPEC_CONTEXT(spec, vocab)}

${SCENARIO_RULES}

## Kinds of check

- "scenario": a short scenario (id "${scenarioId}") whose expectations must hold. Use it for orders, formats, wording, refusals and anything a few steps can show.
- "never_shows_field": a fixture field (like address) that personas in "viewers" must never see for a fixture of the "owners" personas other than themselves. Checked on every step of every scenario.
- "never_matches": a case-insensitive regular expression no screen may match (optionally only screens seen by "viewers").
- "unchecked": only when nothing above can check it; give the reason in one sentence.

## The ${what} to compile

${text}

Answer with the one check that best shows it holds.`;

  for (let attempt = 0; attempt < 2; attempt++) {
    const { check } = await model.json({ label: `compile check ${checkId(target)}`, system: SYSTEM, prompt, schema: Answer });
    const problems = check.kind === 'scenario' ? scenarioProblems(check.scenario as Scenario, vocab) : [];
    if (check.kind === 'never_matches') {
      try {
        new RegExp(check.pattern, 'i');
      } catch {
        problems.push(`"${check.pattern}" is not a regular expression`);
      }
    }
    if (!problems.length) {
      const final = check.kind === 'scenario' ? { ...check, scenario: { ...(check.scenario as Scenario), id: scenarioId } } : check;
      return { for: target, text, hash: checkHash(spec, text, vocab), by: model.name, check: final as Check };
    }
    prompt += `\n\nYour last answer had these problems; fix them:\n${problems.map((p) => `- ${p}`).join('\n')}`;
  }
  throw new ModelError(`compile check ${checkId(target)}: the model's checks didn't fit the vocabulary`);
}

/** The cases whose words settle them: percentiles and error rates are production, the stack and data residency are for the generator. */
export function classifyByWords(text: string): 'production' | 'generator' | undefined {
  const t = text.toLowerCase();
  if (/\bp(50|90|95|99|999)\b|\buptime\b|\bavailability of\b|\berror rate\b|\blatency\b/.test(t)) return 'production';
  if (
    /^(runs|run|deployed|hosted|written|built) (on|in|with)\b|\bdata (stays|lives|is stored) in\b|\bretain|\bretention\b|\bper (day|month)\b.*\b(users|requests|rows)\b/.test(
      t,
    )
  )
    return 'generator';
  return undefined;
}

const Classification = z.strictObject({ check: z.enum(['build', 'production', 'generator']), reason: z.string() });

/**
 * How a constraint is checked: `build` (in the simulation), `production` (from real traces,
 * reported only) or `generator` (given to the generator, not checked). Obvious cases are settled
 * by their words; the rest by a small model call. The result is written back to the spec, where a
 * person can correct it, so each constraint is classified once.
 */
export async function classifyConstraint(text: string, model: Model): Promise<Constraint['check'] & string> {
  const byWords = classifyByWords(text);
  if (byWords) return byWords;
  const { check } = await model.json({
    label: 'classify constraint',
    system: SYSTEM,
    prompt: `Classify how this constraint on an app is checked:

- build: checkable in a sealed simulation of the app (permissions, privacy, idempotency, limits, what users see, a simulated time budget)
- production: only measurable on real traffic (p95, p99, error rate, availability)
- generator: an instruction for whoever builds it, not checkable (the stack, data volume, retention, where data lives)

Constraint: ${text}`,
    schema: Classification,
  });
  return check;
}
