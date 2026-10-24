/**
 * Journeys are prose. Each is compiled once, by a model, into a scenario the simulation runs: who
 * acts, which action with which inputs, when, and what they should see. The result is committed
 * under oodle/compiled/journeys/, so every build runs the same requests and a person can read
 * them, and it is compiled again only when the journey, the personas or the domain change.
 */
import type { Scenario } from '@oodle/sim';
import { type Journey, type Spec, sha256, stableStringify } from '@oodle/spec';
import { z } from 'zod';
import { type Model, ModelError } from './llm.ts';
import { ScenarioSchema, scenarioProblems } from './scenario.ts';
import type { Vocabulary } from './vocabulary.ts';

export interface CompiledJourney {
  journey: string;
  /** Of the journey, the personas, the domain and the vocabulary it was compiled against. */
  hash: string;
  /** The model that compiled it (`recorded` for answers written down by hand). */
  by: string;
  prose: string[];
  scenario: Scenario;
}

export function journeyHash(spec: Spec, journey: Journey, vocab: Vocabulary): string {
  return sha256(stableStringify({ journey, personas: spec.personas, domain: spec.domain, vocab: vocab.hash }));
}

export const SPEC_CONTEXT = (spec: Spec, vocab: Vocabulary) => `## The app

Intent: ${spec.intent ?? '(none yet)'}

Personas:
${Object.entries(spec.personas)
  .map(([p, v]) => `- ${p}: can ${v.can.join('; ')}${v.cannot?.length ? `; cannot ${v.cannot.join('; ')}` : ''}`)
  .join('\n')}

Domain:
${Object.entries(spec.domain)
  .map(
    ([e, v]) =>
      `- ${e}: fields ${Object.entries(v.fields)
        .map(([f, allowed]) => (Array.isArray(allowed) ? `${f} (${allowed.join(' or ')})` : f))
        .join(', ')}${v.states ? `; states ${v.states}` : ''}${v.rules.length ? `; rules: ${v.rules.join('; ')}` : ''}`,
  )
  .join('\n')}

Constraints:
${spec.constraints.map((c) => `- ${c.text}`).join('\n') || '(none)'}

## The vocabulary

Actions (id: capability, by whom, inputs so far):
${vocab.actions.map((a) => `- ${a.id}: "${a.capability}", by ${a.persona}${a.inputs.length ? `, inputs ${a.inputs.join(', ')}` : ''}${a.creates ? ` (creates a ${a.entity})` : ''}`).join('\n')}

Screens (name(params): what it shows):
${vocab.screens.map((s) => `- ${s.name}(${s.params.join(', ')}): ${s.shows}`).join('\n')}`;

const SCENARIO_RULES = `## How a scenario is written

- fixtures: one per person, keyed "<persona>:<lowercase first name>" (owner:ada, walker:sam), each with a "name". Give a fixture any field the spec could show or must hide (an owner's address, for example), with a realistic value. Never two fixtures with the same values.
- Each step has "as" (the fixture who acts) and usually "do" (an action id from the vocabulary, nothing else) with "input".
- Inputs that name a person use their fixture key ("walker:sam"). Inputs that name a record created earlier use "$<entity>_<n>": the first walk created in the scenario is "$walk_1".
- Times are ISO 8601 in UTC. Set "at" on the first step, and on any later step the prose times. Pick concrete dates whose weekdays match the prose.
- A step observes the screen its action lands on. To observe something else, or as someone else, add "look": { "as": fixture, "screen": a screen name, "params": { param: value } }.
- "expect" holds what the prose says the user sees: quoted texts go in screen_contains, exactly as quoted; "gets an email" is mail_to; "is refused" or "can't" is outcome "blocked"; "in this order" is screen_order.
- Never invent expectations the prose doesn't state.
- Expect only what the spec or the fixtures fix: names, quoted texts, numbers. Never a format the spec leaves open (how a date or a time is written, punctuation, capitalisation): two good builds may differ there, and that is for the gaps check, not a failure. To check an order, give the records something fixed that tells them apart, like different people.`;

const System = `You compile parts of an app's spec into scenarios for Oodle's simulation. You answer with JSON only, matching the schema you are given exactly.`;

const Answer = z.strictObject({ scenario: ScenarioSchema });

export async function compileJourney(spec: Spec, journey: Journey, vocab: Vocabulary, model: Model): Promise<CompiledJourney> {
  const hash = journeyHash(spec, journey, vocab);
  const id = `journey/${journey.id}`;
  let prompt = `${SPEC_CONTEXT(spec, vocab)}

${SCENARIO_RULES}

## The journey to compile

Journey "${journey.id}", persona ${journey.persona}. Its lines, by index:
${journey.steps.map((s, i) => `${i}. ${s}`).join('\n')}

Compile it into one scenario with id "${id}". Every line becomes one or more steps, each with "line" set to the line's index and "prose" to the line.`;

  for (let attempt = 0; attempt < 2; attempt++) {
    const { scenario } = await model.json({ label: `compile journey ${journey.id}`, system: System, prompt, schema: Answer });
    const problems = scenarioProblems(scenario as Scenario, vocab);
    const lines = new Set(scenario.steps.map((s) => s.line));
    for (let i = 0; i < journey.steps.length; i++) if (!lines.has(i)) problems.push(`line ${i} has no step`);
    if (!problems.length) return { journey: journey.id, hash, by: model.name, prose: journey.steps, scenario: { ...(scenario as Scenario), id } };
    prompt += `\n\nYour last answer had these problems; fix them:\n${problems.map((p) => `- ${p}`).join('\n')}`;
    if (attempt === 1) throw new ModelError(`compile journey ${journey.id}: ${problems.join('; ')}`);
  }
  throw new ModelError(`compile journey ${journey.id}: no answer`);
}

export { SCENARIO_RULES, System as SYSTEM };
