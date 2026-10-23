/**
 * Changes: the intent merges before the code does. A change says why, which
 * capabilities it may reach, how it amends outcomes and constraints, and what it
 * rules out. People argue about it in its own pull request. Once it is merged, a
 * code pull request that does exactly that passes on its own, and anything
 * outside it blocks as outside intent. See docs/decisions/0012.
 *
 * Only changes on the base count, so a pull request can never approve itself by
 * adding one.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { parseDocument, isMap, isSeq, type Document, type YAMLMap, type YAMLSeq } from 'yaml';
import { ARCHIVE_DIR, CatalogError, loadCatalog, loadConfig } from './catalog.ts';
import { evaluate, stableStringify } from './expect.ts';
import { expectFor, reaches } from './runner.ts';
import { lint } from './lint.ts';
import { OodleError } from './errors.ts';
import { capabilityOf } from './explain.ts';
import type { Amendment, Catalog, Change, Constraint, Expect, Outcome, RunResult } from './types.ts';

// ── Amendments ──────────────────────────────────────────────────────────────

/** Body fields merge by key, effects by kind; anything else the amendment names replaces the outcome's. */
export function amendExpect(base: Expect, amend: Expect = {}): Expect {
  const out: Expect = { ...base };
  if (amend.status !== undefined) out.status = amend.status;
  if (amend.latency_ms_max !== undefined) out.latency_ms_max = amend.latency_ms_max;
  if (amend.body) out.body = mergeBody(base.body ?? {}, amend.body);
  if (amend.effects) {
    const kinds = new Set(amend.effects.map((e) => e.kind));
    out.effects = [...(base.effects ?? []).filter((e) => !kinds.has(e.kind)), ...amend.effects];
  }
  return out;
}

const plainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const MATCHERS = new Set(['exists', 'type', 'matches', 'contains', 'gte', 'lte']);
const isMatcher = (v: Record<string, unknown>) => Object.keys(v).length > 0 && Object.keys(v).every((k) => MATCHERS.has(k));

function mergeBody(base: Record<string, unknown>, amend: Record<string, unknown>): Record<string, unknown> {
  const out = { ...base };
  for (const [k, v] of Object.entries(amend)) {
    const was = out[k];
    out[k] = plainObject(v) && plainObject(was) && !isMatcher(v) && !isMatcher(was) ? mergeBody(was, v) : v;
  }
  return out;
}

/** The outcome as it will be once the amendment is folded in. */
export function amendOutcome(o: Outcome, a: Amendment): Outcome {
  const when = a.when ? { ...(o.when ?? {}), ...Object.fromEntries(Object.entries(a.when).map(([c, e]) => [c, amendExpect(o.when?.[c] ?? {}, e)])) } : o.when;
  return { ...o, ...(a.statement ? { statement: a.statement } : {}), expect: amendExpect(o.expect, a.expect), ...(when ? { when } : {}) };
}

export function amendConstraint(c: Constraint, a: Amendment): Constraint {
  return { ...c, ...(a.statement ? { statement: a.statement } : {}), ...(a.check ? { check: a.check } : {}) };
}

/** What a reviewer compares: everything about an outcome that decides what it promises. */
const promiseOf = (o: Outcome) => stableStringify({ statement: o.statement, trigger: o.trigger, conditions: o.conditions ?? [], expect: o.expect, when: o.when ?? {}, constraints: o.constraints ?? [] });

// ── Where a change came from ────────────────────────────────────────────────

/** The commit that added a change file, as "1a2b3c4 Intent: show currency (#12)". Unknown outside git. */
export function originOf(projectDir: string, file: string): string | undefined {
  try {
    const out = execFileSync('git', ['log', '--diff-filter=A', '--format=%h %s', '-1', '--', file], { cwd: projectDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

// ── Coverage and scope, for the outcome diff ────────────────────────────────

export interface CoverageItem {
  kind: 'outcome' | 'constraint';
  id: string;
  status: string;
}

export interface UsedChange {
  id: string;
  because: string;
  origin?: string;
  /** Outcomes and constraints this pull request changed exactly as the change said. */
  covers: string[];
}

export interface ChangeReport {
  /** Merged changes this pull request relies on. Using one binds it to that change's scope. */
  used: UsedChange[];
  /** What moved outside the changes it uses: blocking. */
  outside: string[];
  /** Changes this pull request adds. They count once merged, never in the pull request that adds them. */
  proposed: { id: string; because: string }[];
  /** Why a change didn't cover an item it amends, by item id. */
  unmet: Record<string, string[]>;
}

/** Does a merged change cover this blocking item? Returns the change id, or why not. */
export function coverage(base: RunResult, head: RunResult, item: CoverageItem): { by?: string; unmet: string[] } {
  const unmet: string[] = [];
  for (const change of base.catalog.changes) {
    const kind = item.kind;
    const a = (change.amends ?? []).find((x) => x[kind] === item.id);
    if (!a) continue;
    if (item.status === 'removed') {
      if (a.remove) return { by: change.id, unmet };
      unmet.push(`change ${change.id} amends ${item.id} but doesn't remove it`);
      continue;
    }
    if (a.remove) {
      unmet.push(`change ${change.id} removes ${item.id}, but it is still in the catalog`);
      continue;
    }
    if (kind === 'constraint') {
      const prev = base.catalog.constraints.find((c) => c.id === item.id)!;
      const now = head.catalog.constraints.find((c) => c.id === item.id);
      if (now && stableStringify(amendConstraint(prev, a)) === stableStringify({ ...now })) return { by: change.id, unmet };
      unmet.push(`change ${change.id} amends ${item.id} differently`);
      continue;
    }
    const prev = base.catalog.outcomes.find((o) => o.id === item.id)!;
    const now = head.catalog.outcomes.find((o) => o.id === item.id)!;
    const amended = amendOutcome(prev, a);
    if (item.status === 'redefined') {
      if (promiseOf(amended) === promiseOf(now)) return { by: change.id, unmet };
      unmet.push(`the catalog now says something change ${change.id} doesn't: fold it with \`oodle changes fold ${change.id}\` instead of editing by hand`);
      continue;
    }
    if (item.status === 'changed') {
      // The catalog still says the old thing; the code must already do what the amendment says.
      const failures = head.observations.filter((o) => o.kind === 'outcome' && o.id === item.id).flatMap((o) => evaluate(expectFor(amended, o.condition === 'default' ? undefined : o.condition), o).map((f) => (o.condition === 'default' ? f : `[${o.condition}] ${f}`)));
      if (!failures.length) return { by: change.id, unmet };
      unmet.push(...failures.map((f) => `not yet what change ${change.id} says: ${f}`));
    }
  }
  return { unmet };
}

const kindsOf = (run: RunResult) => new Set(run.observations.flatMap((o) => o.effects).filter((e) => e.boundary !== 'internal' && !e.error).map((e) => e.kind));
const allowOf = (run: RunResult) => new Set(typeof run.config.sealed === 'object' ? run.config.sealed.allow ?? [] : []);

/**
 * What moved outside the changes a pull request uses. `moved` lists every
 * outcome, behavior and route that isn't held, with the capability it belongs to.
 */
export function outsideIntent(base: RunResult, head: RunResult, used: Change[], moved: { what: string; capability?: string; id?: string }[]): string[] {
  if (!used.length) return [];
  const names = used.map((c) => c.id).join(', ');
  const amended = new Set(used.flatMap((c) => (c.amends ?? []).map((a) => a.outcome ?? a.constraint)));
  const reaches = new Set(used.flatMap((c) => c.reaches ?? []));
  const scoped = used.some((c) => c.reaches);
  const out: string[] = [];
  for (const m of moved) {
    if (m.id && amended.has(m.id)) continue;
    if (scoped ? m.capability && reaches.has(m.capability) : false) continue;
    out.push(`${m.what}${m.capability ? `, in ${m.capability},` : ''} is outside ${names}, which ${scoped ? `reaches ${[...reaches].join(', ') || 'nothing'}` : `amends only ${[...amended].join(', ')}`}`);
  }
  const ruled = new Set(used.flatMap((c) => c.rules_out ?? []));
  const expected = new Set(used.flatMap((c) => (c.amends ?? []).flatMap((a) => (a.expect?.effects ?? []).map((e) => e.kind))));
  const fresh = [...kindsOf(head)].filter((k) => !kindsOf(base).has(k) && !expected.has(k));
  if (ruled.has('new effects')) for (const k of fresh) out.push(`a new effect, ${k}, which ${names} rules out`);
  if (ruled.has('new hosts')) {
    const services = new Set([...kindsOf(base)].map((k) => k.split('.')[0]));
    for (const k of fresh) if (!services.has(k.split('.')[0])) out.push(`a call to a new service, ${k.split('.')[0]} (${k}), which ${names} rules out`);
    for (const h of allowOf(head)) if (!allowOf(base).has(h)) out.push(`a new host let through the seal, ${h}, which ${names} rules out`);
  }
  if (ruled.has('new routes')) for (const r of head.routes) if (!base.routes.includes(r)) out.push(`a new route, ${r}, which ${names} rules out`);
  if (ruled.has('new dependencies')) {
    const had = new Set(base.dependencies ?? []);
    for (const d of head.dependencies ?? []) if (!had.has(d)) out.push(`a new dependency, ${d}, which ${names} rules out`);
  }
  return out;
}

/** Every outcome, behavior and route a diff says moved, with its capability. */
export function movedOf(head: RunResult, base: RunResult, outcomes: { id: string; status: string; behavior: string[] }[], behaviors: { id: string; status: string }[]) {
  const owner = (kind: 'outcomes' | 'behaviors', id: string) => {
    for (const run of [head, base]) {
      const item = (run.catalog[kind] as Outcome[]).find((x) => x.id === id);
      if (item) return capabilityOf(run.catalog, item)?.id;
    }
    return undefined;
  };
  return [
    ...outcomes.filter((o) => o.status !== 'held' && o.status !== 'proposed' || o.behavior.length).map((o) => ({ id: o.id, what: `outcome ${o.id} (${o.status === 'held' ? 'behavior changed' : o.status})`, capability: owner('outcomes', o.id) })),
    ...behaviors.filter((b) => b.status !== 'held').map((b) => ({ id: b.id, what: `behavior ${b.id} (${b.status})`, capability: owner('behaviors', b.id) })),
    ...head.gaps.filter((g) => !base.gaps.some((x) => x.route === g.route)).map((g) => ({ what: `route ${g.route} (described by nothing)`, capability: head.catalog.capabilities.find((c) => (c.surfaces ?? []).some((s) => reaches(s, g.route)))?.id })),
  ];
}

// ── For people and agents ───────────────────────────────────────────────────

export function findChange(catalog: Catalog, id: string): Change {
  const change = catalog.changes.find((c) => c.id === id);
  if (!change) {
    throw new OodleError('no-match', `No change "${id}"`, { hint: catalog.changes.length ? `Changes: ${catalog.changes.map((c) => c.id).join(', ')}.` : 'There are no changes in oodlc/changes/ yet.' });
  }
  return change;
}

/** The brief a coding agent builds from: why, where it may go, what must hold after, and what it must not do. */
export function changeBrief(projectDir: string, id: string): string {
  const catalog = loadCatalog(projectDir, loadConfig(projectDir));
  const change = findChange(catalog, id);
  const caps = (change.reaches ?? []).map((c) => catalog.capabilities.find((x) => x.id === c)).filter(Boolean);
  const amendments = (change.amends ?? []).map((a) => {
    if (a.constraint) {
      const c = catalog.constraints.find((x) => x.id === a.constraint);
      return `- Constraint \`${a.constraint}\`${a.remove ? ': retired.' : `: ${c?.statement ?? ''}\n  Check becomes: \`${a.check ?? c?.check}\``}`;
    }
    const o = catalog.outcomes.find((x) => x.id === a.outcome);
    if (!o) return `- Outcome \`${a.outcome}\`: not in the catalog.`;
    if (a.remove) return `- Outcome \`${o.id}\` (${o.statement}): retired. The behavior it promised may go.`;
    const after = amendOutcome(o, a);
    return `- Outcome \`${o.id}\`, ${o.trigger.http}: ${after.statement}\n  Must hold after: \`${stableStringify(after.expect)}\`${after.when ? `\n  Under conditions: \`${stableStringify(after.when)}\`` : ''}`;
  });
  return `You are implementing an agreed change to this system. Its intent is already approved; your job is to make the code do exactly this, and nothing else.

# The change: \`${change.id}\`

Why: ${change.because}

# Where you may go

${caps.length ? caps.map((c) => `- \`${c!.id}\`: ${c!.statement}${c!.surfaces?.length ? ` (${c!.surfaces.join(', ')})` : ''}`).join('\n') : change.reaches?.length ? change.reaches.map((c) => `- \`${c}\``).join('\n') : '- Only what the amendments below touch.'}

Anything you change outside this blocks the pull request as outside intent, behavior included.

# What must hold when you are done

${amendments.join('\n') || '- (no amendments)'}

# Ruled out

${(change.rules_out ?? []).map((r) => `- ${r}`).join('\n') || '- Nothing beyond the scope above.'}

# How to know you are done

- Don't edit the catalog: the change carries the new expectations. \`npx --no-install oodle check --json\` compares your code with the base and says, for each amended outcome, whether the change covers it, and lists anything outside intent.
- Stop when every amended outcome is covered by \`${change.id}\` and nothing is outside intent.
`;
}

function itemIn(doc: Document, section: string, id: string): { seq: YAMLSeq; index: number; item: YAMLMap } | undefined {
  const seq = doc.get(section);
  if (!isSeq(seq)) return undefined;
  const index = (seq as YAMLSeq).items.findIndex((i) => isMap(i) && (i as YAMLMap).get('id') === id);
  return index < 0 ? undefined : { seq: seq as YAMLSeq, index, item: (seq as YAMLSeq).items[index] as YAMLMap };
}

/** Moves a file with `git mv` when git tracks it, so the change keeps its history in the archive. */
function moveFile(projectDir: string, from: string, to: string) {
  mkdirSync(dirname(join(projectDir, to)), { recursive: true });
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', from], { cwd: projectDir, stdio: 'ignore' });
    execFileSync('git', ['mv', from, to], { cwd: projectDir, stdio: 'ignore' });
  } catch {
    renameSync(join(projectDir, from), join(projectDir, to));
  }
}

/**
 * Folds a shipped change into the catalog: each amendment written into its
 * outcome or constraint, in place, then the change file moved to
 * oodlc/changes/archive/. In the pull request that does this, the change is still
 * on the base, so the redefinitions it makes are covered by it.
 */
export function foldChange(projectDir: string, id: string): { changed: string[]; archived: string } {
  const config = loadConfig(projectDir);
  const catalog = loadCatalog(projectDir, config);
  const change = findChange(catalog, id);
  const docs = new Map<string, { text: string; doc: Document }>();
  const open = (rel: string) => {
    if (!docs.has(rel)) {
      const text = readFileSync(join(projectDir, rel), 'utf8');
      docs.set(rel, { text, doc: parseDocument(text) });
    }
    return docs.get(rel)!.doc;
  };
  const changed: string[] = [];
  for (const a of change.amends ?? []) {
    const section = a.outcome ? 'outcomes' : 'constraints';
    const target = (a.outcome ?? a.constraint)!;
    const rel = catalog.sources[`${section}:${target}`];
    if (!rel) throw new OodleError('no-match', `${change.id} amends ${target}, which is not in the catalog`, { hint: 'Fix the change, or fold it by hand.' });
    const doc = open(rel);
    const found = itemIn(doc, section, target)!;
    if (a.remove) {
      found.seq.items.splice(found.index, 1);
      changed.push(`${section.slice(0, -1)} ${target}: removed`);
      continue;
    }
    const now = a.outcome ? amendOutcome(catalog.outcomes.find((o) => o.id === target)!, a) : amendConstraint(catalog.constraints.find((c) => c.id === target)!, a);
    for (const field of ['statement', 'expect', 'when', 'check'] as const) {
      if ((now as any)[field] !== undefined && stableStringify((now as any)[field]) !== stableStringify(found.item.toJSON()[field])) found.item.set(field, doc.createNode((now as any)[field]));
    }
    changed.push(`${section.slice(0, -1)} ${target}: amended`);
  }
  for (const [rel, { doc }] of docs) writeFileSync(join(projectDir, rel), doc.toString({ lineWidth: 0 }));
  const from = catalog.sources[`changes:${change.id}`];
  const to = join(dirname(from), ARCHIVE_DIR, basename(from));
  try {
    const after = loadCatalog(projectDir, config);
    const errors = lint(after, config).errors.filter((e) => !lint(catalog, config).errors.includes(e));
    if (errors.length) throw new OodleError('fold', `Folding ${change.id} leaves the catalog with errors`, { problems: errors });
  } catch (err) {
    for (const [rel, { text }] of docs) writeFileSync(join(projectDir, rel), text);
    if (err instanceof CatalogError) throw new OodleError('fold', `Folding ${change.id} would break the catalog`, { problems: err.problems });
    throw err;
  }
  if (existsSync(join(projectDir, to))) throw new OodleError('fold', `${to} already exists`, { hint: 'Rename the archived file, then fold again.' });
  moveFile(projectDir, from, to);
  return { changed, archived: relative(projectDir, join(projectDir, to)) };
}

