import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import AjvModule from 'ajv';
import type { Catalog, Config, EvidenceItem } from './types.ts';

const Ajv: any = (AjvModule as any).default ?? AjvModule;
const specDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'spec');
const ajv = new Ajv({ allErrors: true });
const validateCatalogFile = ajv.compile(JSON.parse(readFileSync(join(specDir, 'catalog.schema.json'), 'utf8')));
const validateConfig = ajv.compile(JSON.parse(readFileSync(join(specDir, 'config.schema.json'), 'utf8')));

/** Schema problems in one catalog document, as "file: /path message" lines. */
export const validateCatalogDoc = (doc: unknown, file: string): string[] => (validateCatalogFile(doc) ? [] : formatAjv(file, validateCatalogFile.errors));

export class CatalogError extends Error {
  constructor(public problems: string[]) {
    super(problems.join('\n'));
  }
}

function formatAjv(file: string, errors: any[] | null | undefined): string[] {
  return (errors ?? []).map((e) => `${file}: ${e.instancePath || '/'} ${e.message}${e.params?.additionalProperty ? ` (${e.params.additionalProperty})` : ''}`);
}

/** Every section a catalog file may hold. The last four are the inventory, which never blocks. See docs/decisions/0010. */
export const SECTIONS = ['intents', 'outcomes', 'behaviors', 'conditions', 'constraints', 'actors', 'capabilities', 'experiences', 'unknowns', 'terms'] as const;
export type Section = (typeof SECTIONS)[number];
/** "capabilities" -> "capability", "outcomes" -> "outcome". */
export const singular = (section: Section) => section.replace(/ies$/, 'y').replace(/s$/, '');
export const emptyCatalog = (): Catalog => ({ ...(Object.fromEntries(SECTIONS.map((s) => [s, []])) as Record<Section, []>), changes: [], sources: {} });

/**
 * Evidence as Oodle reads it: free text, or an item with no grade, is inferred. Only Oodle grades
 * what it saw as observed, so anything it can't vouch for fails closed. See docs/decisions/0014.
 */
export const gradeEvidence = (raw: unknown[] | undefined): EvidenceItem[] | undefined =>
  raw?.map((e: any) => (typeof e === 'string' ? { text: e, grade: 'inferred' } : { text: String(e.text), grade: e.grade === 'observed' ? 'observed' : 'inferred' }));

/** Where changes wait for their code, and where they go once folded in. See docs/decisions/0012. */
export const CHANGES_DIR = 'changes';
export const ARCHIVE_DIR = 'archive';

/** Everything Oodle needs lives in one visible folder at the project root. See docs/decisions/0003. */
export const FOLDER = 'oodlc';
export const CONFIG_FILE = 'config.yaml';
/** First line of every YAML file Oodle writes, so editors with the YAML language server validate and complete it. */
export const schemaLine = (name: 'catalog' | 'config') => `# yaml-language-server: $schema=https://oodlc.com/schema/v0/${name}.json\n`;

/**
 * Where a project's config lives: oodlc/config.yaml, or the v0 layout
 * (oodle.yaml plus a separate catalog directory), still read so older
 * projects keep working until they run `oodle init --migrate`.
 */
export function configFile(projectDir: string): { path: string; legacy: boolean } | null {
  const current = join(projectDir, FOLDER, CONFIG_FILE);
  if (existsSync(current)) return { path: current, legacy: false };
  const legacy = join(projectDir, 'oodle.yaml');
  if (existsSync(legacy)) return { path: legacy, legacy: true };
  return null;
}

export const isProject = (dir: string) => configFile(dir) !== null;

export function loadConfig(projectDir: string): Config {
  const where = configFile(projectDir);
  if (!where) throw new CatalogError([`${join(FOLDER, CONFIG_FILE)}: not found. A project keeps its config and catalog in ${FOLDER}/.`]);
  const rel = relative(projectDir, where.path);
  let config: any;
  try {
    config = parse(readFileSync(where.path, 'utf8')) ?? {};
  } catch (err) {
    throw new CatalogError([`${rel}: invalid YAML: ${(err as Error).message}`]);
  }
  if (!validateConfig(config)) throw new CatalogError(formatAjv(rel, validateConfig.errors));
  if (where.legacy && !config.catalog) throw new CatalogError([`${rel}: "catalog" is required in the old layout. Run \`oodle init --migrate\` to move to ${FOLDER}/.`]);
  return { ...config, catalog: config.catalog ?? FOLDER } as Config;
}

export function loadCatalog(projectDir: string, config: Config): Catalog {
  const dir = resolve(projectDir, config.catalog);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new CatalogError([`${config.catalog}: catalog directory not found`]);
  // In oodlc/, config.yaml sits beside the catalog files; it is not one of them.
  const configPath = configFile(projectDir)?.path;

  const catalog = emptyCatalog();
  const problems: string[] = [];
  const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f) && join(dir, f) !== configPath).sort();

  for (const f of files) {
    const rel = relative(projectDir, join(dir, f));
    let doc: any;
    try {
      doc = parse(readFileSync(join(dir, f), 'utf8')) ?? {};
    } catch (err) {
      problems.push(`${rel}: invalid YAML: ${(err as Error).message}`);
      continue;
    }
    if (!validateCatalogFile(doc)) {
      problems.push(...formatAjv(rel, validateCatalogFile.errors));
      continue;
    }
    if (doc.changes) problems.push(`${rel}: changes go in ${relative(projectDir, join(dir, CHANGES_DIR))}/, one file each, so each can be reviewed and archived on its own`);
    for (const section of SECTIONS) {
      for (const item of doc[section] ?? []) {
        const key = `${section}:${item.id}`;
        if (catalog.sources[key]) problems.push(`${rel}: duplicate ${singular(section)} id "${item.id}" (also in ${catalog.sources[key]})`);
        // Outcomes and behaviors share one id space: promoting a behavior means moving it, not copying it.
        const twin = section === 'outcomes' ? `behaviors:${item.id}` : section === 'behaviors' ? `outcomes:${item.id}` : null;
        if (twin && catalog.sources[twin]) problems.push(`${rel}: "${item.id}" is both an outcome and a behavior (also in ${catalog.sources[twin]}). Promoting a behavior moves it.`);
        catalog.sources[key] = rel;
        (catalog[section] as any[]).push(item.evidence ? { ...item, evidence: gradeEvidence(item.evidence) } : item);
      }
    }
  }

  // Changes: one file each in oodlc/changes/. Folded ones move to changes/archive/ and stop counting.
  const changesDir = join(dir, CHANGES_DIR);
  if (existsSync(changesDir) && statSync(changesDir).isDirectory()) {
    for (const f of readdirSync(changesDir).filter((n) => /\.ya?ml$/.test(n)).sort()) {
      const rel = relative(projectDir, join(changesDir, f));
      let doc: any;
      try {
        doc = parse(readFileSync(join(changesDir, f), 'utf8')) ?? {};
      } catch (err) {
        problems.push(`${rel}: invalid YAML: ${(err as Error).message}`);
        continue;
      }
      if (!validateCatalogFile(doc)) {
        problems.push(...formatAjv(rel, validateCatalogFile.errors));
        continue;
      }
      const other = SECTIONS.filter((s) => doc[s]);
      if (other.length) problems.push(`${rel}: a change file holds changes only, not ${other.join(', ')}`);
      for (const change of doc.changes ?? []) {
        const key = `changes:${change.id}`;
        if (catalog.sources[key]) problems.push(`${rel}: duplicate change id "${change.id}" (also in ${catalog.sources[key]})`);
        catalog.sources[key] = rel;
        catalog.changes.push(change);
      }
    }
  }

  if (problems.length) throw new CatalogError(problems);
  return catalog;
}
