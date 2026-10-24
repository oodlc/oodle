/**
 * Reads the spec from `oodle/` in either layout, into one in-memory `Spec`:
 *
 * - single file: `oodle/spec.yaml`, with every section as a top-level key (the README's example);
 * - split: `intent.yaml`, `personas.yaml`, `domain.yaml`, `journeys/*.yaml` (one journey each),
 *   `constraints.yaml` and `decisions.yaml`. A section file holds the section itself, or a map
 *   with the section's name as its only key (`intent: …`). A journey's id defaults to its file name.
 *
 * Every section is optional, so a spec being written (by `oodle interview`) loads at every step.
 * The parsed YAML documents are kept, so writers can change them without losing comments.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';
import { type Document, isMap, parseDocument } from 'yaml';
import { z } from 'zod';
import { SpecError } from './errors.ts';
import { decisionId } from './hash.ts';
import { Constraint, type Decision, DecisionLong, Entity, Journey, Persona, SECTIONS, type Section, type Spec } from './schema.ts';

export const SPEC_DIR = 'oodle';
export const SINGLE_FILE = 'spec.yaml';
const SPLIT_FILES: Record<Exclude<Section, 'journeys'>, string> = {
  intent: 'intent.yaml',
  personas: 'personas.yaml',
  domain: 'domain.yaml',
  constraints: 'constraints.yaml',
  decisions: 'decisions.yaml',
};
const JOURNEYS_DIR = 'journeys';

export type Layout = 'single' | 'split';

/** Where a section lives: its file, and whether its value sits under a key named after the section. */
export interface SectionSource {
  path: string;
  keyed: boolean;
}

export interface SpecFile {
  text: string;
  doc: Document;
}

export interface LoadedSpec {
  /** The project folder, the one that contains `oodle/`. */
  root: string;
  layout: Layout;
  spec: Spec;
  /** Every file read, by absolute path: its text and its parsed document, for writers. */
  files: Map<string, SpecFile>;
  /** Section files that exist. A split-layout section with no file has none (journeys: one per journey). */
  sources: Partial<Record<Exclude<Section, 'journeys'>, SectionSource>>;
}

const Intent = z.string().min(1);
/** A bare decision string is one the generator wrote and pinned. It gets its long form the next time the file is written. */
const DecisionEntry = z.union([
  z
    .string()
    .min(1)
    .transform((text): Decision => ({ id: decisionId(text), text, about: [], source: 'generator', status: 'pinned' })),
  DecisionLong,
]);
const SCHEMAS = {
  intent: Intent,
  personas: z.record(z.string(), Persona),
  domain: z.record(z.string(), Entity),
  journeys: z.array(Journey),
  constraints: z.array(Constraint),
  decisions: z.array(DecisionEntry),
};

const isYaml = (f: string) => ['.yaml', '.yml'].includes(extname(f));

export function specDir(root: string) {
  return join(root, SPEC_DIR);
}

export function loadSpec(root: string): LoadedSpec {
  const dir = specDir(root);
  const problems: string[] = [];
  const files = new Map<string, SpecFile>();
  const rel = (p: string) => relative(root, p) || p;

  const read = (path: string): unknown => {
    const text = readFileSync(path, 'utf8');
    const doc = parseDocument(text, { prettyErrors: true });
    files.set(path, { text, doc });
    for (const e of doc.errors) problems.push(`${rel(path)}: ${e.message}`);
    return doc.errors.length ? undefined : doc.toJS();
  };

  const check = <S extends z.ZodType>(schema: S, value: unknown, where: string): z.output<S> | undefined => {
    const r = schema.safeParse(value);
    if (r.success) return r.data;
    for (const issue of r.error.issues) problems.push(`${where}${issue.path.length ? `: ${issue.path.join('.')}` : ''}: ${issue.message}`);
    return undefined;
  };

  if (!existsSync(dir)) throw new SpecError([`No spec: ${rel(dir)}/ does not exist. Run \`oodle init\` to start one.`]);

  const single = join(dir, SINGLE_FILE);
  const splitFiles = [...Object.values(SPLIT_FILES), JOURNEYS_DIR].filter((f) => existsSync(join(dir, f)));
  if (existsSync(single) && splitFiles.length) {
    throw new SpecError([`${rel(dir)}/ has both ${SINGLE_FILE} and ${splitFiles.join(', ')}. Keep one layout.`]);
  }

  const raw: Partial<Record<Section, unknown>> = {};
  const sources: LoadedSpec['sources'] = {};
  let layout: Layout;
  let journeyFiles: { path: string; value: unknown }[] = [];

  if (existsSync(single)) {
    layout = 'single';
    const value = read(single) ?? {};
    if (value !== null && (typeof value !== 'object' || Array.isArray(value))) {
      problems.push(`${rel(single)}: expected a map of sections (${SECTIONS.join(', ')})`);
    } else {
      for (const [key, v] of Object.entries(value ?? {})) {
        if (!(SECTIONS as readonly string[]).includes(key)) problems.push(`${rel(single)}: unknown section "${key}" (the sections are ${SECTIONS.join(', ')})`);
        else raw[key as Section] = v;
      }
      for (const s of SECTIONS) if (s !== 'journeys') sources[s] = { path: single, keyed: true };
    }
  } else {
    layout = 'split';
    for (const [section, file] of Object.entries(SPLIT_FILES) as [Exclude<Section, 'journeys'>, string][]) {
      const path = join(dir, file);
      if (!existsSync(path)) continue;
      let value = read(path);
      const keyed = isMap(files.get(path)?.doc.contents) && isSoleKey(value, section);
      if (keyed) value = (value as Record<string, unknown>)[section];
      sources[section] = { path, keyed };
      if (value !== null && value !== undefined) raw[section] = value;
    }
    const jdir = join(dir, JOURNEYS_DIR);
    if (existsSync(jdir) && statSync(jdir).isDirectory()) {
      journeyFiles = readdirSync(jdir)
        .filter(isYaml)
        .sort()
        .map((f) => ({ path: join(jdir, f), value: read(join(jdir, f)) }));
    }
  }

  const where = (s: Section) => (layout === 'single' ? `${rel(single)}: ${s}` : rel(join(dir, s === 'journeys' ? JOURNEYS_DIR : SPLIT_FILES[s])));

  const spec: Spec = { personas: {}, domain: {}, journeys: [], constraints: [], decisions: [] };
  if (raw.intent !== undefined) spec.intent = check(SCHEMAS.intent, raw.intent, where('intent'));
  const personas = raw.personas === undefined ? {} : check(SCHEMAS.personas, raw.personas, where('personas'));
  spec.personas = personas ?? {};
  if (raw.domain !== undefined) spec.domain = check(SCHEMAS.domain, raw.domain, where('domain')) ?? {};
  if (raw.constraints !== undefined) spec.constraints = check(SCHEMAS.constraints, raw.constraints, where('constraints')) ?? [];
  if (raw.decisions !== undefined) spec.decisions = check(SCHEMAS.decisions, raw.decisions, where('decisions')) ?? [];
  if (layout === 'single') {
    if (raw.journeys !== undefined) spec.journeys = check(SCHEMAS.journeys, raw.journeys, where('journeys')) ?? [];
  } else {
    for (const { path, value } of journeyFiles) {
      if (value === undefined || value === null) continue;
      const id = basename(path, extname(path));
      const given = typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
      if (given && given.id !== undefined && given.id !== id) {
        problems.push(`${rel(path)}: id "${String(given.id)}" doesn't match the file name; a journey's id is its file name`);
        continue;
      }
      const j = check(Journey, given ? { id, ...given } : value, rel(path));
      if (j) spec.journeys.push(j);
    }
  }

  problems.push(...crossCheck(spec, { personas: personas !== undefined }));
  if (problems.length) throw new SpecError(problems);
  return { root, layout, spec, files, sources };
}

function isSoleKey(value: unknown, key: string) {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 && key in value;
}

/** What one entry says about another: journeys name known personas, ids are unique. A section that didn't load isn't checked against. */
function crossCheck(spec: Spec, valid: { personas: boolean }): string[] {
  const problems: string[] = [];
  const personas = Object.keys(spec.personas);
  for (const id of dupes(spec.journeys.map((j) => j.id))) problems.push(`journeys: "${id}" is defined more than once`);
  for (const j of valid.personas ? spec.journeys : []) {
    if (!(j.persona in spec.personas)) {
      problems.push(`journeys: ${j.id}: persona "${j.persona}" isn't one of the personas${personas.length ? ` (${personas.join(', ')})` : ''}`);
    }
  }
  for (const id of dupes(spec.decisions.map((d) => d.id))) problems.push(`decisions: "${id}" is used by more than one decision`);
  return problems;
}

function dupes(xs: string[]) {
  return [...new Set(xs.filter((x, i) => xs.indexOf(x) !== i))];
}
