/**
 * @oodle/compile: turns the spec's prose into what the simulation runs. The vocabulary and the
 * exploration plan are derived without a model; journeys, build-checked constraints and pinned
 * decisions are compiled by one, once, and cached by hash in oodle/compiled/.
 */
import type { Scenario } from '@oodle/sim';
import { type Constraint, loadSpec, writeConstraints } from '@oodle/spec';
import { type CompiledCheck, checkHash, checkId, classifyByWords, classifyConstraint, compileCheck } from './checks.ts';
import { DEFAULT_CAP, explorationPlan } from './explore.ts';
import { type CompiledJourney, compileJourney, journeyHash } from './journeys.ts';
import type { Model } from './llm.ts';
import { inputsUsed } from './scenario.ts';
import { compiledDir, readCompiled, writeCompiled } from './store.ts';
import { vocabularyOf, withInputs } from './vocabulary.ts';

export * from './checks.ts';
export * from './explore.ts';
export * from './journeys.ts';
export * from './llm.ts';
export * from './scenario.ts';
export * from './store.ts';
export * from './vocabulary.ts';

export interface CompileOptions {
  /** Needed only when something has to be compiled or classified; without one, that is an error. */
  model?: Model;
  /** The exploration plan's cap. */
  cap?: number;
  /** Don't write anything; fail if anything is stale. */
  check?: boolean;
}

export interface CompileResult {
  /** What a model compiled or classified in this run. */
  compiled: string[];
  /** Files written or removed. */
  written: string[];
  /** Constraints and decisions the model couldn't turn into a check. */
  unchecked: { text: string; reason: string }[];
  /** With `check`: what is out of date. */
  stale: string[];
}

export class NeedsModel extends Error {}

export async function compile(root: string, opts: CompileOptions = {}): Promise<CompileResult> {
  const loaded = loadSpec(root);
  const { spec } = loaded;
  const result: CompileResult = { compiled: [], written: [], unchecked: [], stale: [] };
  const model = (what: string) => {
    if (opts.check) {
      result.stale.push(what);
      return undefined;
    }
    if (!opts.model) throw new NeedsModel(`${what} needs a model, and none is configured`);
    result.compiled.push(what);
    return opts.model;
  };

  // Constraints without a check are classified once and written back, where a person can correct them.
  if (spec.constraints.some((c) => !c.check)) {
    const classified: Constraint[] = [];
    for (const c of spec.constraints) {
      const byWords = c.check ? undefined : classifyByWords(c.text);
      if (c.check) classified.push(c);
      else if (byWords) classified.push({ ...c, check: byWords });
      else {
        const m = model(`classify constraint "${c.text}"`);
        classified.push(m ? { ...c, check: await classifyConstraint(c.text, m) } : c);
      }
    }
    if (!opts.check) result.written.push(writeConstraints(loaded, classified));
  }

  const cached = readCompiled(root);
  const base = vocabularyOf(spec);

  const journeys: CompiledJourney[] = [];
  for (const j of spec.journeys) {
    const hash = journeyHash(spec, j, base);
    const hit = cached.journeys.find((c) => c.journey === j.id && c.hash === hash);
    if (hit) journeys.push(hit);
    else {
      const m = model(`journey ${j.id}`);
      if (m) journeys.push(await compileJourney(spec, j, base, m));
    }
  }

  const vocabulary = withInputs(base, inputsUsed(journeys.map((j) => j.scenario as Scenario)));
  const explore = explorationPlan(spec, vocabulary, journeys, { cap: opts.cap ?? cached.explore?.cap ?? DEFAULT_CAP });

  const checks: CompiledCheck[] = [];
  const items = [
    ...spec.constraints.filter((c) => c.check === 'build').map((c) => ({ constraint: c })),
    ...spec.decisions.filter((d) => d.status === 'pinned' || d.status === 'rule').map((d) => ({ decision: d })),
  ];
  for (const item of items) {
    const text = 'constraint' in item ? item.constraint.text : item.decision.text;
    const target = 'constraint' in item ? { constraint: text } : { decision: item.decision.id };
    const hash = checkHash(spec, text, base);
    const hit = cached.checks.find((c) => checkId(c.for) === checkId(target) && c.hash === hash);
    let compiledCheck = hit;
    if (!compiledCheck) {
      const m = model(`check "${text}"`);
      if (m) compiledCheck = await compileCheck(spec, item, base, m);
    }
    if (compiledCheck) {
      checks.push(compiledCheck);
      if (compiledCheck.check.kind === 'unchecked') result.unchecked.push({ text, reason: compiledCheck.check.reason });
    }
  }

  if (opts.check) {
    if (JSON.stringify(cached.vocabulary) !== JSON.stringify(vocabulary)) result.stale.push('actions.json');
    if (JSON.stringify(cached.explore) !== JSON.stringify(explore)) result.stale.push('explore.json');
    return result;
  }
  result.written.push(...writeCompiled(root, { vocabulary, journeys, explore, checks }, (c) => checkId(c.for)));
  return result;
}

export { compiledDir };
