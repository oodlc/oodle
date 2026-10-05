import type { Behavior, Boundary, Gap, LintResult, Observation, Outcome, RunResult } from './types.ts';
import { jsonDiff, stableStringify } from './expect.ts';

export type OutcomeStatus = 'held' | 'changed' | 'broken' | 'failing' | 'new' | 'removed' | 'redefined' | 'proposed';
export type BehaviorStatus = 'held' | 'changed' | 'new' | 'removed';

export interface OutcomeDiff {
  id: string;
  statement: string;
  boundary: Boundary;
  status: OutcomeStatus;
  /** Outcomes are durable: any change to one blocks the merge until a human approves it. */
  blocking: boolean;
  details: string[];
  /** Behavior that changed inside this outcome's runs without touching the outcome, e.g. internal effects. Report only. */
  behavior: string[];
}

export interface BehaviorDiff {
  id: string;
  statement: string;
  boundary: Boundary;
  status: BehaviorStatus;
  details: string[];
  /** Constraint breaches seen while running this behavior. The constraint is durable, so these block. */
  violations: string[];
  /** Breaches of proposed constraints. Reported only. */
  notices: string[];
  blocking: boolean;
}

export interface ConstraintDiff {
  id: string;
  statement: string;
  status: 'new' | 'removed' | 'redefined';
  /** Constraints are durable: loosening or deleting one needs approval, like an outcome. */
  blocking: boolean;
  details: string[];
}

export interface DiffReport {
  outcomes: OutcomeDiff[];
  /** Drift never blocks; a constraint violation seen on a behavior run does. */
  behaviors: BehaviorDiff[];
  /** Only constraints whose definition changed. */
  constraints: ConstraintDiff[];
  gaps: Gap[];
  lint: LintResult;
  blocking: number;
}

/** What someone outside the system can observe. */
function boundaryView(o: Observation) {
  return {
    status: o.status,
    body: o.body,
    effects: o.effects.filter((e) => e.boundary !== 'internal').map(({ kind, payload, result, error }) => ({ kind, payload, result, error })),
  };
}

function internalView(o: Observation) {
  return o.effects.filter((e) => e.boundary === 'internal').map(({ kind, payload }) => ({ kind, payload }));
}

function definition(o: Outcome) {
  return stableStringify({ statement: o.statement, trigger: o.trigger, conditions: o.conditions ?? [], expect: o.expect, when: o.when ?? {}, constraints: o.constraints ?? [], status: o.status ?? null });
}

function failuresOf(obs: Observation[]): string[] {
  return obs.flatMap((o) => o.failures.map((f) => `[${o.condition}] ${f}`));
}

function violationsOf(obs: Observation[]): string[] {
  return obs.flatMap((o) => o.violations.map((v) => `[${o.condition}] ${v}`));
}

/** An outcome is broken by an unmet expectation or a constraint breach. */
function problemsOf(obs: Observation[]): string[] {
  return [...failuresOf(obs), ...violationsOf(obs)];
}

function obsBy(run: RunResult, kind: Observation['kind'], id: string) {
  return run.observations.filter((o) => o.kind === kind && o.id === id);
}

function diffOutcomes(base: RunResult, head: RunResult): OutcomeDiff[] {
  const baseO = new Map(base.catalog.outcomes.map((o) => [o.id, o]));
  const headO = new Map(head.catalog.outcomes.map((o) => [o.id, o]));
  const out: OutcomeDiff[] = [];

  for (const id of new Set([...headO.keys(), ...baseO.keys()])) {
    const o = headO.get(id);
    const prev = baseO.get(id);
    const ref = (o ?? prev)!;
    const d: OutcomeDiff = { id, statement: ref.statement, boundary: ref.boundary, status: 'held', blocking: false, details: [], behavior: [] };

    // A proposal never blocks while it stays a proposal. Approving one (deleting `status: proposed`) makes it
    // a new outcome, which blocks if it does not hold. Marking an approved outcome proposed is a redefinition.
    if (o?.status === 'proposed' && (!prev || prev.status === 'proposed')) {
      const fails = problemsOf(obsBy(head, 'outcome', id));
      d.status = 'proposed';
      d.details = fails.length ? fails.map((f) => f.replace(/^(\[[^\]]+\] )/, '$1not yet: ')) : ['proposed, holding'];
      out.push(d);
      continue;
    }
    if (!prev || (prev.status === 'proposed' && o && !o.status)) {
      if (prev) d.details.push('proposal approved');
      const fails = problemsOf(obsBy(head, 'outcome', id));
      d.status = fails.length ? 'failing' : 'new';
      d.details.push(...(fails.length ? fails : ['new outcome, passing']));
      d.blocking = fails.length > 0;
      out.push(d);
      continue;
    }
    if (!o && prev.status === 'proposed') continue; // withdrawing a proposal changes nothing that was approved
    if (!o) {
      d.status = 'removed';
      d.details = ['outcome removed from the catalog; needs approval'];
      d.blocking = true;
      out.push(d);
      continue;
    }

    const headObs = obsBy(head, 'outcome', id);
    const baseObs = obsBy(base, 'outcome', id);
    const headFails = problemsOf(headObs);
    const baseFails = problemsOf(baseObs);

    if (headFails.length) {
      d.status = baseFails.length ? 'failing' : 'broken';
      d.details = headFails;
      d.blocking = true;
    } else if (definition(prev) !== definition(o)) {
      d.status = 'redefined';
      d.details = ['outcome definition changed in the catalog; needs approval', ...jsonDiff(JSON.parse(JSON.stringify(prev)), JSON.parse(JSON.stringify(o)))];
      d.blocking = true;
    } else {
      for (const h of headObs) {
        const b = baseObs.find((x) => x.condition === h.condition);
        if (!b) continue;
        d.details.push(...jsonDiff(boundaryView(b), boundaryView(h)).map((c) => `[${h.condition}] ${c}`));
        d.behavior.push(...jsonDiff({ effects: internalView(b) }, { effects: internalView(h) }).map((c) => `[${h.condition}] ${c}`));
      }
      if (d.details.length) {
        d.status = 'changed';
        d.details.unshift('observable output changed while expectations still pass; review');
        d.blocking = true;
      }
    }
    d.behavior = [...new Set(d.behavior)];
    out.push(d);
  }

  const order: Record<OutcomeStatus, number> = { broken: 0, failing: 1, removed: 2, redefined: 3, changed: 4, new: 5, proposed: 6, held: 7 };
  return out.sort((a, b) => Number(b.blocking) - Number(a.blocking) || order[a.status] - order[b.status] || a.id.localeCompare(b.id));
}

function diffBehaviors(base: RunResult, head: RunResult): BehaviorDiff[] {
  const baseB = new Map(base.catalog.behaviors.map((b) => [b.id, b]));
  const headB = new Map(head.catalog.behaviors.map((b) => [b.id, b]));
  const promoted = new Set(head.catalog.outcomes.map((o) => o.id));
  const out: BehaviorDiff[] = [];

  for (const id of new Set([...headB.keys(), ...baseB.keys()])) {
    const b = headB.get(id);
    const prev = baseB.get(id);
    const ref: Behavior = (b ?? prev)!;
    const d: BehaviorDiff = { id, statement: ref.statement, boundary: ref.boundary, status: 'held', details: [], violations: [], notices: [], blocking: false };

    if (!prev) {
      d.status = 'new';
      d.details = ['new behavior', ...failuresOf(obsBy(head, 'behavior', id))];
    } else if (!b) {
      d.status = 'removed';
      d.details = [promoted.has(id) ? 'promoted to an outcome' : 'behavior removed from the catalog'];
    } else {
      const headObs = obsBy(head, 'behavior', id);
      const baseObs = obsBy(base, 'behavior', id);
      d.details.push(...failuresOf(headObs).map((f) => `drift: ${f}`));
      for (const h of headObs) {
        const o = baseObs.find((x) => x.condition === h.condition);
        if (!o) continue;
        const before = { ...boundaryView(o), internal: internalView(o) };
        const after = { ...boundaryView(h), internal: internalView(h) };
        d.details.push(...jsonDiff(before, after).map((c) => `[${h.condition}] ${c}`));
      }
      d.details = [...new Set(d.details)];
      if (d.details.length) d.status = 'changed';
    }
    if (b) {
      d.violations = violationsOf(obsBy(head, 'behavior', id));
      d.notices = obsBy(head, 'behavior', id).flatMap((o) => o.notices.map((n) => `[${o.condition}] ${n}`));
      d.blocking = d.violations.length > 0;
    }
    out.push(d);
  }
  return out.sort((a, b) => Number(b.blocking) - Number(a.blocking) || Number(a.status === 'held') - Number(b.status === 'held') || a.id.localeCompare(b.id));
}

function diffConstraints(base: RunResult, head: RunResult): ConstraintDiff[] {
  const baseC = new Map(base.catalog.constraints.map((c) => [c.id, c]));
  const headC = new Map(head.catalog.constraints.map((c) => [c.id, c]));
  const out: ConstraintDiff[] = [];
  for (const id of new Set([...headC.keys(), ...baseC.keys()])) {
    const c = headC.get(id);
    const prev = baseC.get(id);
    const statement = (c ?? prev)!.statement;
    if (!prev) out.push({ id, statement, status: 'new', blocking: false, details: [c!.status === 'proposed' ? 'new proposed constraint, reported only' : 'new constraint'] });
    else if (prev.status === 'proposed' && c && !c.status) out.push({ id, statement, status: 'new', blocking: false, details: ['proposal approved', ...jsonDiff({ ...prev, status: undefined }, c)] });
    else if (prev.status === 'proposed' && c?.status === 'proposed') continue;
    else if (!c) out.push({ id, statement, status: 'removed', blocking: true, details: ['constraint removed from the catalog; needs approval'] });
    else if (stableStringify(prev) !== stableStringify(c)) {
      out.push({ id, statement, status: 'redefined', blocking: true, details: ['constraint changed in the catalog; needs approval', ...jsonDiff(prev, c)] });
    }
  }
  return out.sort((a, b) => Number(b.blocking) - Number(a.blocking) || a.id.localeCompare(b.id));
}

export function diffRuns(base: RunResult, head: RunResult): DiffReport {
  const outcomes = diffOutcomes(base, head);
  const behaviors = diffBehaviors(base, head);
  const constraints = diffConstraints(base, head);
  // Only what a human declared can block: outcomes and constraints. Behavior drift never does.
  const blocking =
    outcomes.filter((d) => d.blocking).length +
    behaviors.filter((d) => d.blocking).length +
    constraints.filter((d) => d.blocking).length +
    head.gaps.filter((g) => g.violations.length).length +
    head.lint.errors.length;
  return { outcomes, behaviors, constraints, gaps: head.gaps, lint: head.lint, blocking };
}
