/**
 * Intents: every change to the app after the first build, agreed before any code exists.
 * `oodle/intents/<name>.yaml` says what should change (structured edits to the declared tier), why,
 * what has to stay true, what it rules out, and how we'll know it worked.
 *
 * Only merged intents count: what a build checks comes from the intents on the base ref (`main`),
 * never the working tree, so a change can't approve itself by adding its own intent.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, parseDocument, stringify } from 'yaml';
import { z } from 'zod';
import { sha256, stableStringify } from './hash.ts';
import { type LoadedSpec, loadSpec, specDir } from './load.ts';
import type { Spec } from './schema.ts';
import { appendToList, editInList, writeConstraints } from './write.ts';

export const RULES_OUT = ['new_dependencies', 'new_outbound_hosts', 'new_routes'] as const;

export const Change = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('replace_rule'), entity: z.string(), from: z.string(), to: z.string() }),
  z.strictObject({ op: z.literal('add_rule'), entity: z.string(), rule: z.string() }),
  z.strictObject({ op: z.literal('remove_rule'), entity: z.string(), rule: z.string() }),
  z.strictObject({ op: z.literal('add_constraint'), text: z.string() }),
  z.strictObject({ op: z.literal('remove_constraint'), text: z.string() }),
  z.strictObject({ op: z.literal('replace_constraint'), from: z.string(), to: z.string() }),
  z.strictObject({ op: z.literal('add_journey'), journey: z.string(), persona: z.string(), steps: z.array(z.string()).min(1) }),
  z.strictObject({ op: z.literal('add_step'), journey: z.string(), step: z.string() }),
  z.strictObject({ op: z.literal('replace_step'), journey: z.string(), from: z.string(), to: z.string() }),
  z.strictObject({ op: z.literal('add_persona_capability'), persona: z.string(), can: z.string() }),
]);
export type Change = z.infer<typeof Change>;

export const IntentApproval = z.strictObject({
  by: z.string(),
  at: z.string(),
  via: z.enum(['inbox', 'cli']),
  decision: z.enum(['approve', 'reject']).default('approve'),
  /** The intent's content when it was approved. If the intent changes, the approval no longer counts. */
  content_hash: z.string(),
  note: z.string().optional(),
});
export type IntentApproval = z.infer<typeof IntentApproval>;

export const Intent = z.strictObject({
  id: z.string().regex(/^i_[a-z0-9_]+$/),
  title: z.string(),
  status: z.enum(['draft', 'in_review', 'approved', 'merged', 'rejected']),
  why: z.string(),
  changes: z.array(Change).default([]),
  keeps: z.strictObject({ journeys: z.array(z.string()).default([]), constraints: z.array(z.string()).default([]) }).default({ journeys: [], constraints: [] }),
  rules_out: z.array(z.enum(RULES_OUT)).default([]),
  done_when: z.strictObject({ journeys: z.array(z.string()).default([]), evals: z.array(z.string()).default([]) }).default({ journeys: [], evals: [] }),
  approvals: z.array(IntentApproval).default([]),
  /** When it merged, and in which commit. */
  merged_at: z.string().optional(),
  merged_in: z.string().optional(),
});
export type Intent = z.infer<typeof Intent>;

export const intentsDir = (root: string) => join(specDir(root), 'intents');

export function parseIntent(text: string, where: string): Intent {
  const r = Intent.safeParse(parse(text));
  if (!r.success) throw new Error(`${where}: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return r.data;
}

/** Intents in the working tree, with their file names. */
export function readIntents(root: string): { file: string; intent: Intent }[] {
  const dir = intentsDir(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .sort()
    .map((f) => ({ file: f, intent: parseIntent(readFileSync(join(dir, f), 'utf8'), `oodle/intents/${f}`) }));
}

export function writeIntent(root: string, file: string, intent: Intent): string {
  mkdirSync(intentsDir(root), { recursive: true });
  const path = join(intentsDir(root), file);
  writeFileSync(path, stringify(intent, { lineWidth: 0 }));
  return path;
}

/** What an approval binds to: everything but status, approvals and merge bookkeeping. */
export function intentContentHash(intent: Intent): string {
  const { status: _s, approvals: _a, merged_at: _m, merged_in: _i, ...content } = intent;
  return sha256(stableStringify(content));
}

/** The latest review that still counts (its content hash matches), if any. */
export function currentApproval(intent: Intent): IntentApproval | undefined {
  const hash = intentContentHash(intent);
  return [...intent.approvals].reverse().find((a) => a.content_hash === hash);
}

/** Entities a change reaches, for scoping an intent's gaps check. */
export function changedEntities(spec: Spec, changes: Change[]): string[] {
  const out = new Set<string>();
  const entities = Object.keys(spec.domain);
  const mentions = (text: string) => entities.filter((e) => new RegExp(`\\b${e}s?\\b`, 'i').test(text));
  for (const c of changes) {
    if ('entity' in c) out.add(c.entity);
    for (const v of Object.values(c)) if (typeof v === 'string') for (const e of mentions(v)) out.add(e);
    if (c.op === 'add_journey') for (const s of c.steps) for (const e of mentions(s)) out.add(e);
  }
  return [...out];
}

/** The spec with an intent's changes applied, in memory. Throws when a change doesn't fit the spec. */
export function applyChanges(spec: Spec, changes: Change[]): Spec {
  const s: Spec = structuredClone(spec);
  const entity = (name: string) => {
    const e = s.domain[name];
    if (!e) throw new Error(`no entity "${name}"`);
    return e;
  };
  const journey = (id: string) => {
    const j = s.journeys.find((x) => x.id === id);
    if (!j) throw new Error(`no journey "${id}"`);
    return j;
  };
  const replaceIn = (list: string[], from: string, to: string | null, what: string) => {
    const i = list.indexOf(from);
    if (i < 0) throw new Error(`${what} "${from}" isn't in the spec`);
    if (to === null) list.splice(i, 1);
    else list[i] = to;
  };
  for (const c of changes) {
    switch (c.op) {
      case 'replace_rule':
        replaceIn(entity(c.entity).rules, c.from, c.to, 'the rule');
        break;
      case 'add_rule':
        entity(c.entity).rules.push(c.rule);
        break;
      case 'remove_rule':
        replaceIn(entity(c.entity).rules, c.rule, null, 'the rule');
        break;
      case 'add_constraint':
        s.constraints.push({ text: c.text });
        break;
      case 'remove_constraint':
      case 'replace_constraint': {
        const from = c.op === 'remove_constraint' ? c.text : c.from;
        const i = s.constraints.findIndex((x) => x.text === from);
        if (i < 0) throw new Error(`the constraint "${from}" isn't in the spec`);
        if (c.op === 'remove_constraint') s.constraints.splice(i, 1);
        else s.constraints[i] = { text: c.to };
        break;
      }
      case 'add_journey':
        if (s.journeys.some((j) => j.id === c.journey)) throw new Error(`the journey "${c.journey}" already exists`);
        s.journeys.push({ id: c.journey, persona: c.persona, steps: c.steps });
        break;
      case 'add_step':
        journey(c.journey).steps.push(c.step);
        break;
      case 'replace_step':
        replaceIn(journey(c.journey).steps, c.from, c.to, 'the step');
        break;
      case 'add_persona_capability': {
        const p = s.personas[c.persona];
        if (!p) throw new Error(`no persona "${c.persona}"`);
        p.can.push(c.can);
        break;
      }
    }
  }
  return s;
}

/**
 * Writes an intent's changes into the spec files, changing only the lines they name. Checked in
 * memory first, so a change that doesn't fit writes nothing.
 */
export function writeChanges(root: string, changes: Change[], note: string): string[] {
  const loaded: LoadedSpec = loadSpec(root);
  applyChanges(loaded.spec, changes);
  const written = new Set<string>();
  for (const c of changes) {
    switch (c.op) {
      case 'replace_rule':
        written.add(editInList(loaded, 'domain', [c.entity, 'rules'], c.from, c.to));
        break;
      case 'add_rule':
        written.add(appendToList(loaded, 'domain', [c.entity, 'rules'], c.rule, note));
        break;
      case 'remove_rule':
        written.add(editInList(loaded, 'domain', [c.entity, 'rules'], c.rule, null));
        break;
      case 'add_constraint':
        written.add(writeConstraints(loaded, [...loaded.spec.constraints, { text: c.text }], { [c.text]: note }));
        break;
      case 'remove_constraint':
        written.add(
          writeConstraints(
            loaded,
            loaded.spec.constraints.filter((x) => x.text !== c.text),
          ),
        );
        break;
      case 'replace_constraint':
        written.add(
          writeConstraints(
            loaded,
            loaded.spec.constraints.map((x) => (x.text === c.from ? { text: c.to } : x)),
            { [c.to]: note },
          ),
        );
        break;
      case 'add_journey': {
        if (loaded.layout === 'split') {
          const path = join(specDir(root), 'journeys', `${c.journey}.yaml`);
          const out = `# ${note}\n${stringify({ persona: c.persona, steps: c.steps }, { lineWidth: 0 })}`;
          writeFileSync(path, out);
          loaded.files.set(path, { text: out, doc: parseDocument(out) });
          loaded.spec.journeys.push({ id: c.journey, persona: c.persona, steps: c.steps });
          written.add(path);
        } else {
          const file = loaded.files.get(join(specDir(root), 'spec.yaml'));
          const doc = file?.doc;
          if (!doc) throw new Error('oodle/spec.yaml was not read');
          (doc.get('journeys', true) as { add(v: unknown): void } | undefined)?.add(doc.createNode({ id: c.journey, persona: c.persona, steps: c.steps }));
          const path = join(specDir(root), 'spec.yaml');
          const out = doc.toString({ lineWidth: 0 });
          writeFileSync(path, out);
          loaded.files.set(path, { text: out, doc: parseDocument(out) });
          loaded.spec.journeys.push({ id: c.journey, persona: c.persona, steps: c.steps });
          written.add(path);
        }
        break;
      }
      case 'add_step':
        written.add(appendToList(loaded, 'journeys', [c.journey, 'steps'], c.step));
        break;
      case 'replace_step':
        written.add(editInList(loaded, 'journeys', [c.journey, 'steps'], c.from, c.to));
        break;
      case 'add_persona_capability':
        written.add(appendToList(loaded, 'personas', [c.persona, 'can'], c.can, note));
        break;
    }
  }
  return [...written];
}
