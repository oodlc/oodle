/** Zod schemas for what the simulation runs, so a model's output is checked before it is cached. */
import type { Scenario } from '@oodle/sim';
import { z } from 'zod';
import type { Vocabulary } from './vocabulary.ts';

export const ExpectSchema = z.strictObject({
  screen_contains: z.array(z.string()).optional(),
  screen_not_contains: z.array(z.string()).optional(),
  screen_order: z.array(z.string()).optional().describe('texts that appear on the screen in this order'),
  outcome: z.enum(['ok', 'blocked']).optional(),
  mail_to: z.string().optional().describe('a fixture key that receives mail during the step'),
  no_mail: z.boolean().optional(),
});

export const StepSchema = z.strictObject({
  prose: z.string().optional(),
  line: z.number().int().min(0).optional(),
  at: z.string().optional().describe('ISO 8601 UTC: the simulated time from this step on'),
  as: z.string().describe('a fixture key, like owner:ada'),
  do: z.string().optional().describe('an action id from the vocabulary'),
  input: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  look: z
    .strictObject({
      as: z.string().optional(),
      screen: z.string().optional(),
      params: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
  expect: ExpectSchema.optional(),
});

export const FixtureSchema = z.looseObject({ name: z.string(), email: z.string().optional() });

export const ScenarioSchema = z.strictObject({
  id: z.string(),
  start: z.string().optional(),
  fixtures: z.record(z.string().regex(/^[a-z_]+:[a-z0-9_-]+$/), FixtureSchema),
  steps: z.array(StepSchema).min(1),
});

/** What is wrong with a scenario against the vocabulary and its own fixtures. Empty when it can run. */
export function scenarioProblems(s: Scenario, vocab: Vocabulary): string[] {
  const problems: string[] = [];
  const actions = new Set(vocab.actions.map((a) => a.id));
  const screens = new Map(vocab.screens.map((sc) => [sc.name, sc]));
  const fixture = (key: string | undefined, where: string) => {
    if (key !== undefined && !s.fixtures[key]) problems.push(`${where}: "${key}" is not a fixture (${Object.keys(s.fixtures).join(', ')})`);
  };
  for (const [i, step] of s.steps.entries()) {
    const where = `step ${i}`;
    fixture(step.as, where);
    fixture(step.look?.as, `${where} look`);
    fixture(step.expect?.mail_to, `${where} mail_to`);
    if (step.do && !actions.has(step.do)) problems.push(`${where}: no action "${step.do}" (the actions are ${[...actions].join(', ')})`);
    if (step.look?.screen && !screens.has(step.look.screen))
      problems.push(`${where}: no screen "${step.look.screen}" (the screens are ${[...screens.keys()].join(', ')})`);
    const screen = step.look?.screen ? screens.get(step.look.screen) : undefined;
    for (const p of screen?.params ?? []) if (!step.look?.params?.[p]) problems.push(`${where}: screen "${screen?.name}" needs param "${p}"`);
    if (step.at && Number.isNaN(Date.parse(step.at))) problems.push(`${where}: "${step.at}" is not a time`);
  }
  return problems;
}

/** Action inputs each scenario passes, for the vocabulary. */
export function inputsUsed(scenarios: Scenario[]): Map<string, Set<string>> {
  const used = new Map<string, Set<string>>();
  for (const s of scenarios)
    for (const step of s.steps) if (step.do) for (const k of Object.keys(step.input ?? {})) used.set(step.do, (used.get(step.do) ?? new Set()).add(k));
  return used;
}
