/**
 * The local agent's answer to a decided-tier gap: the option most consistent with the intent and
 * the decisions already made, and why, in one sentence. Only for gaps routed to agents.
 */
import { type Model, SPEC_CONTEXT, type Vocabulary } from '@oodle/compile';
import type { Spec } from '@oodle/spec';
import { z } from 'zod';
import type { Answer, Gap } from './gap.ts';

export async function agentAnswer(gap: Gap, ctx: { spec: Spec; vocab: Vocabulary }, model: Model): Promise<Answer> {
  if (gap.route !== 'agent') throw new Error(`${gap.id} is routed to people`);
  const choices = gap.options.filter((o) => o.id !== 'dont_care');
  const { option, reason } = await model.json({
    label: `answer gap ${gap.id}`,
    system:
      'You settle a question about an app the spec left open, as its builder would: pick the option most consistent with the intent and the decisions already made, and say why in one sentence. JSON only.',
    prompt: `${SPEC_CONTEXT(ctx.spec, ctx.vocab)}

Decisions already made:
${ctx.spec.decisions.map((d) => `- ${d.text}`).join('\n') || '- (none)'}

## The question

${gap.question}
Scenario: ${gap.evidence.scenario_text ?? gap.evidence.scenario}
Build A: ${gap.evidence.a.summary}
Build B: ${gap.evidence.b.summary}
Options:
${choices.map((o) => `- ${o.id}: ${o.label}${o.becomes?.decision ? ` (becomes: "${o.becomes.decision}")` : ''}`).join('\n')}`,
    schema: z.strictObject({ option: z.enum(choices.map((o) => o.id) as [string, ...string[]]), reason: z.string().min(1) }),
  });
  return { option, reason };
}
