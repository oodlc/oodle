/**
 * @oodle/diff: what two builds did differently, as a user would notice it, grouped by cause.
 *
 * 1. Normalize. Each side's generated ids become symbols by first appearance (`walk_1` is
 *    `⟨walk#1⟩`), so two builds that number things differently aren't different. Whitespace is
 *    already collapsed by the view model; case is kept, because it is visible.
 * 2. Diff. Observations are paired by scenario and step, and compared field by field: what the
 *    screen shows, whether the action was refused, mail sent, outbound requests made.
 * 3. Cluster. One cause makes many differences (a sort order changes every list), so differences
 *    are named by pattern (sort order, format, permission, rule, an extra element, wording,
 *    pagination) and grouped by where they happen and what they are about. Once an action is
 *    refused on one side only, everything after it in that scenario is a consequence and folds
 *    into that one difference.
 *
 * A gap's id is a hash of its pattern, place, entity and a normalized summary of each side, so
 * running the check again on the same spec gives the same ids.
 */
import type { Observation, Scenario, ScenarioResult, Step } from '@oodle/sim';
import { sha256, stableStringify } from '@oodle/spec';

export type Pattern = 'sort_order' | 'format' | 'permission' | 'rule' | 'extra_element' | 'wording' | 'pagination' | 'other';
export type Field = 'blocked' | 'error' | 'title' | 'headings' | 'text' | 'lists' | 'actions' | 'fields' | 'mail' | 'outbound';

export interface Difference {
  scenario: string;
  step: number;
  /** Who was looking. */
  as: string;
  /** Who acted, and how, when the step has an action. */
  actor: string;
  action?: string;
  field: Field;
  pattern: Pattern;
  /** Where the user sees it: `screen:walks`, or `action:owner.book_walk` for the screen an action lands on. */
  where: string;
  entity?: string;
  a: SideSummary;
  b: SideSummary;
  /**
   * The words only one side shows, with names, dates and numbers blanked: what the difference is,
   * wherever it shows up. "Signed in as Ada" on every screen is one difference, not one per screen.
   */
  delta: { a: string[]; b: string[] };
}

export interface SideSummary {
  summary: string;
  sample: string[];
}

export interface GapSignature {
  id: string;
  pattern: Pattern;
  where: string;
  entity?: string;
  about: string[];
  /** The first difference, in plan order: the evidence a question shows. */
  evidence: Difference;
  /** Every scenario it showed up in. */
  scenarios: string[];
  count: number;
}

export interface DiffContext {
  scenarios: Scenario[];
  /** Entity of each action, from the vocabulary. */
  entityOf?: (action: string) => string | undefined;
  /** Entity names, to read `walks` as `walk`. */
  entities?: string[];
}

// ── Normalizing ─────────────────────────────────────────────────────────────

const ID = /\b([a-z][a-z0-9]*)_(\d+)\b/g;

/** One scenario's observations from one side, with generated ids as symbols by first appearance. */
export function normalize(observations: Observation[]): Observation[] {
  const seen = new Map<string, Map<string, number>>();
  const text = JSON.stringify(observations).replace(ID, (whole, kind: string) => {
    const kinds = seen.get(kind) ?? new Map<string, number>();
    seen.set(kind, kinds);
    if (!kinds.has(whole)) kinds.set(whole, kinds.size + 1);
    return `⟨${kind}#${kinds.get(whole)}⟩`;
  });
  return JSON.parse(text) as Observation[];
}

// ── Diffing ─────────────────────────────────────────────────────────────────

const counts = (xs: string[]) => {
  const m = new Map<string, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return m;
};
const minus = (xs: string[], ys: string[]) => {
  const left = counts(ys);
  return xs.filter((x) => {
    const n = left.get(x) ?? 0;
    if (n > 0) {
      left.set(x, n - 1);
      return false;
    }
    return true;
  });
};
const sameItems = (a: string[], b: string[]) => a.length === b.length && minus(a, b).length === 0;
const take = (xs: string[], n = 3) => xs.slice(0, n);

const DATE_WORDS =
  /^(mon|tue|wed|thu|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday|jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december|am|pm|utc)$/i;
const letterWords = (xs: string[]) =>
  new Set(
    xs
      .join(' ')
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter((w) => w && !DATE_WORDS.test(w)),
  );
/** The same words with numbers in them, written differently: "Wed 4 Nov, 09:00" and "2026-11-04 09:00". A format, not a wording. */
function sameWords(a: string[], b: string[]): boolean {
  if (!/\d/.test(a.join('')) || !/\d/.test(b.join(''))) return false;
  const [x, y] = [letterWords(a), letterWords(b)];
  return x.size === y.size && [...x].every((w) => y.has(w));
}

/** Words only one side has, with names, dates and numbers blanked. */
function deltaOf(a: string[], b: string[], names: RegExp | undefined) {
  const tokens = (xs: string[]) =>
    xs
      .join(' ')
      .replace(names ?? /$^/, '⟨name⟩')
      .split(/\s+/)
      .map((w) => (DATE_WORDS.test(w.replace(/[^a-z]/gi, '')) ? '⟨date⟩' : w.replace(/\d+/g, '#')))
      .filter(Boolean);
  const [ta, tb] = [tokens(a), tokens(b)];
  return { a: [...new Set(minus(ta, tb))].sort(), b: [...new Set(minus(tb, ta))].sort() };
}

/** How two lists of texts differ, as a pattern and a summary of each side. */
function compareTexts(a: string[], b: string[], list: boolean): { pattern: Pattern; a: SideSummary; b: SideSummary } | undefined {
  if (stableStringify(a) === stableStringify(b)) return undefined;
  if (sameItems(a, b))
    return { pattern: list ? 'sort_order' : 'wording', a: { summary: 'this order', sample: take(a) }, b: { summary: 'this order', sample: take(b) } };
  const onlyA = minus(a, b);
  const onlyB = minus(b, a);
  if (list && a.length !== b.length && (onlyA.length === 0 || onlyB.length === 0) && Math.max(a.length, b.length) >= 5) {
    return { pattern: 'pagination', a: { summary: `${a.length} items`, sample: take(a) }, b: { summary: `${b.length} items`, sample: take(b) } };
  }
  if (onlyA.length === 0 || onlyB.length === 0) {
    return {
      pattern: 'extra_element',
      a: { summary: onlyA.length ? 'shows more' : 'shows less', sample: take(onlyA) },
      b: { summary: onlyB.length ? 'shows more' : 'shows less', sample: take(onlyB) },
    };
  }
  const pattern: Pattern = sameWords(onlyA, onlyB) ? 'format' : 'wording';
  return { pattern, a: { summary: pattern, sample: take(onlyA) }, b: { summary: pattern, sample: take(onlyB) } };
}

function stepOf(scenarios: Map<string, Scenario>, id: string, i: number): Step | undefined {
  return scenarios.get(id)?.steps[i];
}

const singular = (word: string, entities: string[]) => entities.find((e) => word === e || word === `${e}s` || word === `${e}es`);

/** Every user-visible difference between two sides' runs of the same scenarios. */
export function diffRuns(ctx: DiffContext, a: ScenarioResult[], b: ScenarioResult[]): Difference[] {
  const scenarios = new Map(ctx.scenarios.map((s) => [s.id, s]));
  const fixtureNames = [...new Set(ctx.scenarios.flatMap((s) => Object.values(s.fixtures).map((f) => String(f.name))))].filter(Boolean);
  const names = fixtureNames.length ? new RegExp(`\\b(${fixtureNames.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'g') : undefined;
  const bById = new Map(b.map((r) => [r.scenario, r]));
  const out: Difference[] = [];
  for (const ra of a) {
    const rb = bById.get(ra.scenario);
    if (!rb) continue;
    const oa = normalize(ra.observations);
    const ob = normalize(rb.observations);
    let refusedAt = Number.POSITIVE_INFINITY;
    for (let i = 0; i < Math.min(oa.length, ob.length); i++) {
      if (i > refusedAt) break;
      const x = oa[i] as Observation;
      const y = ob[i] as Observation;
      const step = stepOf(scenarios, ra.scenario, i);
      const where = step?.look?.screen ? `screen:${step.look.screen}` : step?.do ? `action:${step.do}` : 'screen:home';
      const entity = step?.do && !step.look?.screen ? ctx.entityOf?.(step.do) : singular(where.slice('screen:'.length), ctx.entities ?? []);
      const base = {
        scenario: ra.scenario,
        step: i,
        as: x.as,
        actor: step?.as ?? x.as,
        ...(step?.do ? { action: step.do } : {}),
        where,
        ...(entity ? { entity } : {}),
      };
      const push = (field: Field, d: { pattern: Pattern; a: SideSummary; b: SideSummary } | undefined) =>
        d && out.push({ ...base, field, ...d, delta: deltaOf(d.a.sample, d.b.sample, names) });

      if (!!x.blocked !== !!y.blocked) {
        const pattern: Pattern = ra.scenario.includes('/permissions/') ? 'permission' : 'rule';
        const side = (o: Observation) => ({
          summary: o.blocked ? 'refused' : 'allowed',
          sample: [o.blocked ? `refused (${o.status})` : `allowed (${o.status})`, ...take(o.view.text, 1)],
        });
        push('blocked', { pattern, a: side(x), b: side(y) });
        refusedAt = i;
        continue;
      }
      if ((x.error ?? '') !== (y.error ?? '')) {
        push('error', {
          pattern: 'other',
          a: { summary: x.error ? 'failed' : 'worked', sample: x.error ? [x.error] : [] },
          b: { summary: y.error ? 'failed' : 'worked', sample: y.error ? [y.error] : [] },
        });
        refusedAt = i;
        continue;
      }
      push('title', compareTexts(x.view.title ? [x.view.title] : [], y.view.title ? [y.view.title] : [], false));
      push('headings', compareTexts(x.view.headings, y.view.headings, false));
      push('text', compareTexts(x.view.text, y.view.text, false));
      push('actions', compareTexts(x.view.actions, y.view.actions, false));
      push(
        'fields',
        compareTexts(
          x.view.fields.map((f) => `${f.label}${f.error ? `: ${f.error}` : ''}`),
          y.view.fields.map((f) => `${f.label}${f.error ? `: ${f.error}` : ''}`),
          false,
        ),
      );
      const lists = Math.max(x.view.lists.length, y.view.lists.length);
      for (let l = 0; l < lists; l++) push('lists', compareTexts(x.view.lists[l]?.items ?? [], y.view.lists[l]?.items ?? [], true));
      push(
        'mail',
        compareTexts(
          x.mail.map((m) => `to ${m.to}: ${m.subject} — ${m.text}`),
          y.mail.map((m) => `to ${m.to}: ${m.subject} — ${m.text}`),
          false,
        ),
      );
      push(
        'outbound',
        compareTexts(
          x.outbound.map((o) => `${o.method} ${o.host}`),
          y.outbound.map((o) => `${o.method} ${o.host}`),
          false,
        ),
      );
    }
  }
  return out;
}

// ── Clustering ──────────────────────────────────────────────────────────────

/** Patterns whose one cause shows up with different samples in different scenarios. */
const BY_PLACE = new Set<Pattern>(['sort_order', 'pagination', 'permission', 'rule']);

export function signatureOf(d: Difference): string {
  // A refusal or an order is about one place; a wording, a format or an extra element is the same
  // choice wherever it shows, so it is signed by what differs, not where.
  const key = BY_PLACE.has(d.pattern)
    ? { pattern: d.pattern, where: d.where, entity: d.entity ?? null, actor: d.pattern === 'permission' ? d.actor.slice(0, d.actor.indexOf(':')) : null }
    : { pattern: d.pattern, delta: d.delta };
  return `g_${sha256(stableStringify(key)).slice(0, 8)}`;
}

/** Differences grouped by cause, in the order their first difference appeared. */
export function cluster(diffs: Difference[], ignore: Set<string> = new Set()): GapSignature[] {
  const groups = new Map<string, GapSignature>();
  for (const d of diffs) {
    const id = signatureOf(d);
    if (ignore.has(id)) continue;
    const g = groups.get(id);
    if (g) {
      g.count++;
      if (!g.scenarios.includes(d.scenario)) g.scenarios.push(d.scenario);
      continue;
    }
    const about = [...(d.entity ? [`entity:${d.entity}`] : []), d.where, ...(d.action && !d.where.endsWith(d.action) ? [`action:${d.action}`] : [])];
    groups.set(id, {
      id,
      pattern: d.pattern,
      where: d.where,
      ...(d.entity ? { entity: d.entity } : {}),
      about,
      evidence: d,
      scenarios: [d.scenario],
      count: 1,
    });
  }
  return [...groups.values()];
}
