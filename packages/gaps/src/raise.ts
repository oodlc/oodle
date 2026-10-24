/**
 * Tier, route, and writing the gap files after a gaps run.
 *
 * A gap is declared-tier when any answer would change intent, personas, domain, journeys or
 * constraints. In order:
 *   - permission and rule gaps are declared (permissions and domain rules are);
 *   - a gap where one side breaks a journey expectation or a constraint is declared (one build is
 *     wrong, and a person confirms which);
 *   - a moved decision always goes to a person;
 *   - anything the patterns couldn't name is declared unless a model says otherwise;
 *   - the rest is decided.
 * Declared gaps always go to a person; decided ones go where `routing.decided` says.
 */
import type { Model, Vocabulary } from '@oodle/compile';
import type { GapSignature } from '@oodle/diff';
import type { Scenario } from '@oodle/sim';
import type { Config, Spec } from '@oodle/spec';
import { z } from 'zod';
import type { Gap } from './gap.ts';
import { describeScenario, writeQuestion } from './questions.ts';
import { readGaps, readIgnore, removeGap, writeGap } from './store.ts';

export interface Tiering {
  tier: Gap['tier'];
  reason: string;
}

export async function classifyTier(kind: Gap['kind'], contradiction: string | undefined, model?: Model, context?: string): Promise<Tiering> {
  if (kind === 'permission') return { tier: 'declared', reason: 'who may do what is declared in personas' };
  if (kind === 'rule') return { tier: 'declared', reason: 'domain rules are declared' };
  if (contradiction) return { tier: 'declared', reason: `one build breaks the spec: ${contradiction}` };
  if (kind === 'decision_moved') return { tier: 'decided', reason: 'it moves a pinned decision, so a person decides' };
  if (kind === 'other') {
    if (!model) return { tier: 'declared', reason: 'the difference has no known pattern, so a person decides' };
    const r = await model
      .json({
        label: 'classify gap tier',
        system:
          'You decide whether settling a difference between two builds of an app needs a change to what people declared (intent, personas, domain, journeys, constraints), or only a decision the builder may make. When in doubt, answer declared. JSON only.',
        prompt: context ?? '',
        schema: z.strictObject({ tier: z.enum(['decided', 'declared']), reason: z.string() }),
      })
      .catch(() => ({ tier: 'declared' as const, reason: 'the model could not say, so a person decides' }));
    return r;
  }
  return { tier: 'decided', reason: 'the spec is silent and any answer is a decision' };
}

export function routeOf(gap: Pick<Gap, 'tier' | 'kind'>, config: Config): Gap['route'] {
  if (gap.tier === 'declared' || gap.kind === 'decision_moved') return 'human';
  return config.routing.decided;
}

export interface RaiseOptions {
  spec: Spec;
  vocab: Vocabulary;
  scenarios: Scenario[];
  specHash: string;
  /** The two builds compared, as `build:<id>`. */
  foundIn: string[];
  config: Config;
  model?: Model;
  /** Gap id → how one side breaks a journey expectation or a constraint. */
  contradictions?: Map<string, string>;
  /** Only gaps raised for this intent are replaced by this run. */
  intentId?: string;
}

export interface Raised {
  /** New gaps, and open ones with fresh evidence. */
  open: Gap[];
  /** Found again, already answered: left as they were. */
  settled: Gap[];
  /** Open gaps from an earlier run that this one didn't find: removed. */
  superseded: string[];
}

export async function raiseGaps(root: string, signatures: GapSignature[], opts: RaiseOptions): Promise<Raised> {
  const existing = new Map(readGaps(root).map((g) => [g.id, g]));
  const ignored = new Set(readIgnore(root).map((i) => i.id));
  const result: Raised = { open: [], settled: [], superseded: [] };
  const found = new Set<string>();

  for (const sig of signatures) {
    if (ignored.has(sig.id)) continue;
    found.add(sig.id);
    const before = existing.get(sig.id);
    if (before && before.status !== 'open') {
      result.settled.push(before);
      continue;
    }
    const scenario = opts.scenarios.find((s) => s.id === sig.evidence.scenario);
    const scenarioText = scenario ? describeScenario(scenario, sig.evidence.step, opts.vocab) : sig.evidence.scenario;
    const kind = sig.pattern as Gap['kind'];
    const tiering = await classifyTier(
      kind,
      opts.contradictions?.get(sig.id),
      opts.model,
      `${scenarioText}\nA: ${sig.evidence.a.sample.join(', ')}\nB: ${sig.evidence.b.sample.join(', ')}`,
    );
    const q = await writeQuestion(sig, { spec: opts.spec, vocab: opts.vocab, scenarioText }, opts.model);
    const gap: Gap = {
      id: sig.id,
      status: 'open',
      kind,
      tier: tiering.tier,
      tier_reason: tiering.reason,
      route: routeOf({ tier: tiering.tier, kind }, opts.config),
      spec_hash: opts.specHash,
      found_in: opts.foundIn,
      about: sig.about,
      ...(opts.intentId ? { intent_id: opts.intentId } : {}),
      question: q.question,
      evidence: {
        scenario: sig.evidence.scenario,
        scenario_text: scenarioText,
        seen_by: sig.evidence.as,
        a: { summary: q.a, sample: sig.evidence.a.sample },
        b: { summary: q.b, sample: sig.evidence.b.sample },
      },
      options: q.options,
      answer: null,
      answered_by: null,
      answered_at: null,
      applied_in: null,
    };
    writeGap(root, gap);
    result.open.push(gap);
  }

  for (const g of existing.values()) {
    if (g.status === 'open' && !found.has(g.id) && (g.intent_id ?? null) === (opts.intentId ?? null)) {
      removeGap(root, g.id);
      result.superseded.push(g.id);
    }
  }
  return result;
}
