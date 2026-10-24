/**
 * The exploration plan: scenarios that reach what journeys don't, made from the spec without a
 * model, so the same spec always gives the same plan. Sample inputs (who books whom, when, for how
 * long) come from the compiled journeys. In order of priority, up to a cap:
 *
 * - collections: each entity's list, as each persona involved, with 0, 1, 7 and 60 items, created
 *   out of order (empty states, sort order, pagination);
 * - permissions: every action on an entity by every fixture, including the ones who don't own it;
 * - states: every pair of actions on an entity, one after the other (allowed and refused transitions);
 * - rules: just inside, at and just outside each "N hours before <field>" rule;
 * - fields: each input of a create action empty, at its allowed min and max, just outside, and of the wrong type.
 */
import type { Fixture, Scenario, Step } from '@oodle/sim';
import { DEFAULT_START } from '@oodle/sim';
import { type Spec, sha256, stableStringify } from '@oodle/spec';
import type { CompiledJourney } from './journeys.ts';
import { type ActionDef, plural, type Vocabulary } from './vocabulary.ts';

export interface ExplorePlan {
  hash: string;
  cap: number;
  /** How many scenarios each kind would have had before the cap. */
  planned: Record<string, number>;
  scenarios: Scenario[];
}

export const DEFAULT_CAP = 200;
const SIZES = [0, 1, 7, 60];
const NAMES = ['Bea', 'Cal', 'Dee', 'Eli', 'Fay', 'Gus', 'Hal', 'Ivy'];
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const UNITS: Record<string, number> = { minute: MINUTE, hour: 60 * MINUTE, day: DAY, week: 7 * DAY };

type Input = Record<string, unknown>;

const isTime = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v) && !Number.isNaN(Date.parse(v));
const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');
const personaOf = (key: string) => key.slice(0, key.indexOf(':'));

export function explorationPlan(spec: Spec, vocab: Vocabulary, journeys: CompiledJourney[], opts: { cap?: number } = {}): ExplorePlan {
  const cap = opts.cap ?? DEFAULT_CAP;
  const fixtures = fixturesFor(spec, journeys);
  const first = (persona: string) => Object.keys(fixtures).find((k) => personaOf(k) === persona);

  const samples = new Map<string, Input>();
  let start = DEFAULT_START;
  for (const j of journeys) {
    const at = j.scenario.steps.find((s) => s.at)?.at;
    if (at && j === journeys[0]) start = at;
    for (const s of j.scenario.steps) if (s.do && !samples.has(s.do)) samples.set(s.do, s.input ?? {});
  }

  const creators = new Map<string, ActionDef>();
  for (const a of vocab.actions) if (a.creates && a.entity && samples.has(a.id) && !creators.has(a.entity)) creators.set(a.entity, a);

  const scenario = (id: string, steps: Step[]): Scenario => ({ id, start, fixtures, steps });
  /** Who naturally does an action on a record `create` made: its creator, or the person the create named. */
  const actorFor = (a: ActionDef, create: ActionDef) => {
    if (a.persona === create.persona) return first(create.persona);
    const named = Object.values(samples.get(create.id) ?? {}).find((v): v is string => typeof v === 'string' && v.startsWith(`${a.persona}:`) && !!fixtures[v]);
    return named ?? first(a.persona);
  };
  const createStep = (create: ActionDef, shiftDays = 0, input?: Input): Step => ({
    as: first(create.persona) as string,
    do: create.id,
    input: input ?? shift(samples.get(create.id) ?? {}, shiftDays),
  });
  const onRecord = (a: ActionDef, entity: string): Input => ({ ...(samples.get(a.id) ?? {}), [entity]: `$${entity}_1` });

  const kinds: Record<string, Scenario[]> = { collections: [], permissions: [], states: [], rules: [], fields: [] };

  for (const [entity, create] of creators) {
    const involved = [
      ...new Set([
        create.persona,
        ...Object.values(samples.get(create.id) ?? {})
          .filter((v): v is string => typeof v === 'string' && !!fixtures[v])
          .map(personaOf),
      ]),
    ];
    for (const n of SIZES) {
      const steps: Step[] = Array.from({ length: n }, (_, i) => createStep(create, n > 1 ? ((i * 5) % n) + 1 : 1));
      for (const p of involved) steps.push({ as: actorFor({ persona: p } as ActionDef, create) as string, look: { screen: plural(entity) } });
      kinds.collections?.push(scenario(`explore/collections/${plural(entity)}-${n}`, steps));
    }

    const onIt = vocab.actions.filter((a) => a.entity === entity && !a.creates);
    for (const a of [create, ...onIt]) {
      for (const actor of Object.keys(fixtures)) {
        if (a === create && personaOf(actor) === create.persona && actor === first(create.persona)) continue;
        const steps = a === create ? [{ ...createStep(create), as: actor }] : [createStep(create), { as: actor, do: a.id, input: onRecord(a, entity) }];
        kinds.permissions?.push(scenario(`explore/permissions/${a.id}/${actor}`, steps));
      }
    }

    for (const a1 of onIt) {
      for (const a2 of onIt) {
        kinds.states?.push(
          scenario(`explore/states/${a1.id}-then-${a2.id}`, [
            createStep(create),
            { as: actorFor(a1, create) as string, do: a1.id, input: onRecord(a1, entity) },
            { as: actorFor(a2, create) as string, do: a2.id, input: onRecord(a2, entity) },
          ]),
        );
      }
    }

    for (const [r, rule] of (spec.domain[entity]?.rules ?? []).entries()) {
      const m = /(\d+)\s*(minute|hour|day|week)s?\s+(before|after)\s+(\w+)/i.exec(rule);
      if (!m) continue;
      const field = m[4] as string;
      const when = (samples.get(create.id) ?? {})[field];
      const action = onIt.find((a) => rule.toLowerCase().includes(a.verb));
      if (!isTime(when) || !action) continue;
      const span = Number(m[1]) * (UNITS[(m[2] as string).toLowerCase()] ?? MINUTE) * (m[3]?.toLowerCase() === 'before' ? -1 : 1);
      const edge = Date.parse(when) + span;
      for (const [name, at] of [
        ['inside', edge - MINUTE],
        ['at', edge],
        ['outside', edge + MINUTE],
      ] as const) {
        // "Inside" is the side where the rule still applies: earlier for "before", later for "after".
        const atTime = m[3]?.toLowerCase() === 'before' ? at : edge * 2 - at;
        kinds.rules?.push(
          scenario(`explore/rules/${entity}-${r}-${name}`, [
            createStep(create),
            { at: iso(atTime), as: actorFor(action, create) as string, do: action.id, input: onRecord(action, entity) },
          ]),
        );
      }
    }

    const sample = samples.get(create.id) ?? {};
    for (const [key, value] of Object.entries(sample)) {
      if (typeof value === 'string' && (fixtures[value] || value.startsWith('$'))) continue;
      const allowed = spec.domain[entity]?.fields[key];
      const variants: [string, unknown][] = [['empty', '']];
      if (Array.isArray(allowed) && allowed.every((v) => typeof v === 'number')) {
        const nums = allowed as number[];
        const lo = Math.min(...nums);
        const hi = Math.max(...nums);
        variants.push(['min', lo], ['max', hi], ['below', lo - 1], ['above', hi + 1]);
      } else if (Array.isArray(allowed)) variants.push(['other', 'something-else']);
      if (isTime(value)) variants.push(['past', iso(Date.parse(start) - DAY)]);
      variants.push(['wrong-type', typeof value === 'number' ? 'abc' : 12345]);
      for (const [name, v] of variants)
        kinds.fields?.push(scenario(`explore/fields/${entity}-${key}-${name}`, [createStep(create, 0, { ...sample, [key]: v })]));
    }
  }

  const planned = Object.fromEntries(Object.entries(kinds).map(([k, v]) => [k, v.length]));
  const scenarios = Object.values(kinds).flat().slice(0, cap);
  const hash = sha256(stableStringify({ domain: spec.domain, personas: spec.personas, vocab: vocab.actions, journeys: journeys.map((j) => j.hash), cap }));
  return { hash, cap, planned, scenarios };
}

/** Moves every time in an input by whole days. */
function shift(input: Input, days: number): Input {
  return Object.fromEntries(Object.entries(input).map(([k, v]) => [k, isTime(v) ? iso(Date.parse(v) + days * DAY) : v]));
}

/**
 * Everyone the journeys name, plus a second fixture for every persona, so each scenario has
 * someone who doesn't own the record. A made-up fixture copies the first one's fields with
 * different values.
 */
function fixturesFor(spec: Spec, journeys: CompiledJourney[]): Record<string, Fixture> {
  const out: Record<string, Fixture> = {};
  for (const j of journeys) for (const [k, f] of Object.entries(j.scenario.fixtures)) out[k] ??= f;
  let n = 0;
  for (const persona of Object.keys(spec.personas)) {
    const mine = Object.keys(out).filter((k) => personaOf(k) === persona);
    const need = Math.max(0, 2 - mine.length);
    const model = mine[0] ? out[mine[0]] : undefined;
    for (let i = 0; i < need; i++) {
      let name = NAMES[n++ % NAMES.length] as string;
      while (out[`${persona}:${name.toLowerCase()}`]) name = NAMES[n++ % NAMES.length] as string;
      const f: Fixture = { name };
      for (const [k, v] of Object.entries(model ?? {}))
        if (k !== 'name' && k !== 'email' && typeof v === 'string') f[k] = /\d+/.test(v) ? v.replace(/\d+/, (d) => String(Number(d) + 16)) : `${v}, ${name}`;
      out[`${persona}:${name.toLowerCase()}`] = f;
    }
  }
  return out;
}
