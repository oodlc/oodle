/**
 * The system map: what the system does, for whom and why, and how much of it
 * is protected. Built from a run, so it can say which outcomes hold and which
 * routes no capability claims. It explains; it never blocks. See docs/decisions/0010.
 *
 * Each capability shows the rungs it has (confirmed, an outcome, an intent, an
 * experience) and the next one to add, so a team that starts with capabilities
 * alone can see what each further rung would get them.
 */
import { reaches } from './runner.ts';
import { saysNothing } from './lint.ts';
import { undefinedWords } from './terms.ts';
import type { Behavior, Capability, Catalog, Outcome, RunResult } from './types.ts';

/** The capability an outcome or behavior belongs to: the one it names, or else the one whose surfaces reach its trigger. */
export function capabilityOf(catalog: Catalog, item: Outcome | Behavior): Capability | undefined {
  if (item.capability) return catalog.capabilities.find((c) => c.id === item.capability);
  return catalog.capabilities.find((c) => (c.surfaces ?? []).some((s) => reaches(item.trigger.http, s)));
}

export interface CapabilityView {
  id: string;
  statement: string;
  status: 'confirmed' | 'proposed';
  actor?: { id: string; statement?: string };
  intent?: string;
  surfaces: string[];
  /** Outcomes that protect it. `holds` covers every condition it runs under; a proposed outcome never protects. */
  outcomes: { id: string; state: 'holds' | 'fails' | 'proposed' }[];
  behaviors: string[];
  experiences: string[];
  /** Constraints its outcomes name. Every constraint holds on every run regardless (0002). */
  constraints: string[];
  /** What crossed the boundary while its outcomes and behaviors ran. */
  calls: string[];
  writes: string[];
  evidence: string[];
  rungs: { capability: boolean; outcome: boolean; intent: boolean; experience: boolean };
  /** The next rung worth adding, in words. Absent when every rung is there. */
  next?: string;
}

export interface SystemMap {
  intents: { id: string; statement: string; proposed: boolean; capabilities: string[]; experiences: string[]; outcomes: string[] }[];
  capabilities: CapabilityView[];
  experiences: { id: string; statement: string; actor?: string; intent?: string; steps: string[]; feels_broken_when: string[] }[];
  /** Routes no capability's surfaces reach. */
  unclaimed: string[];
  questions: { id: string; question: string; answer?: string }[];
  /** The vocabulary, and the system's own words no term defines yet (0013). */
  terms: { id: string; statement: string; aka: string[]; proposed: boolean }[];
  undefined_words: string[];
  summary: { capabilities: number; confirmed: number; protected: number; routes: number; claimed: number };
}

function nextRung(v: CapabilityView): string | undefined {
  if (saysNothing(v.statement)) return 'say what it does: oodle interview';
  if (!v.rungs.capability) return 'confirm it: oodle interview, or delete its status line';
  if (!v.rungs.outcome) return 'protect it with an outcome: oodle propose --routes, or draft one';
  if (!v.rungs.intent) return 'say why it exists: oodle interview';
  if (!v.rungs.experience) return 'add an experience: who goes through it, and what would feel broken';
  return undefined;
}

export function systemMap(run: RunResult): SystemMap {
  const { catalog } = run;
  const obsOf = (kind: string, id: string) => run.observations.filter((o) => o.kind === kind && o.id === id);

  const capabilities = catalog.capabilities.map((c): CapabilityView => {
    const outcomes = catalog.outcomes.filter((o) => capabilityOf(catalog, o)?.id === c.id);
    const behaviors = catalog.behaviors.filter((b) => capabilityOf(catalog, b)?.id === c.id);
    const ran = [...outcomes.flatMap((o) => obsOf('outcome', o.id)), ...behaviors.flatMap((b) => obsOf('behavior', b.id))];
    const effects = ran.flatMap((o) => o.effects).filter((e) => !e.error);
    const experiences = catalog.experiences.filter((e) => (e.steps ?? []).includes(c.id)).map((e) => e.id);
    const actor = c.actor ? catalog.actors.find((a) => a.id === c.actor) : undefined;
    const view: CapabilityView = {
      id: c.id,
      statement: c.statement,
      status: c.status === 'proposed' ? 'proposed' : 'confirmed',
      ...(c.actor ? { actor: { id: c.actor, ...(actor ? { statement: actor.statement } : {}) } } : {}),
      ...(c.intent ? { intent: c.intent } : {}),
      surfaces: c.surfaces ?? [],
      outcomes: outcomes.map((o) => {
        const obs = obsOf('outcome', o.id);
        const holds = obs.length > 0 && obs.every((x) => !x.failures.length && !x.violations.length && !x.error);
        return { id: o.id, state: o.status === 'proposed' ? 'proposed' : holds ? 'holds' : 'fails' };
      }),
      behaviors: behaviors.map((b) => b.id),
      experiences,
      constraints: [...new Set(outcomes.flatMap((o) => o.constraints ?? []))],
      calls: [...new Set(effects.filter((e) => e.boundary === 'external').map((e) => e.kind))].sort(),
      writes: [...new Set(effects.flatMap((e) => (e.boundary === 'data' ? [/^db\.(.+)\.(inserted|updated|deleted)$/.exec(e.kind)?.[1]] : [])).filter((t): t is string => !!t))].sort(),
      evidence: c.evidence ?? [],
      rungs: {
        capability: c.status !== 'proposed' && !saysNothing(c.statement),
        outcome: outcomes.some((o) => o.status !== 'proposed'),
        intent: !!c.intent,
        experience: experiences.length > 0,
      },
    };
    const next = nextRung(view);
    return next ? { ...view, next } : view;
  });

  const claimed = run.routes.filter((r) => catalog.capabilities.some((c) => (c.surfaces ?? []).some((s) => reaches(s, r))));
  return {
    intents: catalog.intents.map((i) => ({
      id: i.id,
      statement: i.statement,
      proposed: i.status === 'proposed',
      capabilities: catalog.capabilities.filter((c) => c.intent === i.id).map((c) => c.id),
      experiences: catalog.experiences.filter((e) => e.intent === i.id).map((e) => e.id),
      // Outcomes that serve this intent with no capability to say what they protect.
      outcomes: catalog.outcomes.filter((o) => o.intent === i.id && !capabilityOf(catalog, o)).map((o) => o.id),
    })),
    capabilities,
    experiences: catalog.experiences.map((e) => ({ id: e.id, statement: e.statement, ...(e.actor ? { actor: e.actor } : {}), ...(e.intent ? { intent: e.intent } : {}), steps: e.steps ?? [], feels_broken_when: e.feels_broken_when ?? [] })),
    unclaimed: run.routes.filter((r) => !claimed.includes(r)),
    questions: catalog.unknowns.map((u) => ({ id: u.id, question: u.question, ...(u.answer ? { answer: u.answer } : {}) })),
    terms: catalog.terms.map((t) => ({ id: t.id, statement: t.statement, aka: t.aka ?? [], proposed: t.status === 'proposed' })),
    undefined_words: undefinedWords(catalog).map((u) => u.word),
    summary: {
      capabilities: capabilities.length,
      confirmed: capabilities.filter((c) => c.status === 'confirmed').length,
      protected: capabilities.filter((c) => c.outcomes.some((o) => o.state === 'holds')).length,
      routes: run.routes.length,
      claimed: claimed.length,
    },
  };
}
