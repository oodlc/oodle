import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import AjvModule from 'ajv';
import type { Catalog, Config } from './types.ts';

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

/** Everything Oodle needs lives in one visible folder at the project root. See docs/decisions/0003. */
export const FOLDER = 'oodlc';
export const CONFIG_FILE = 'config.yaml';

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

  const catalog: Catalog = { intents: [], outcomes: [], behaviors: [], conditions: [], constraints: [], sources: {} };
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
    for (const section of ['intents', 'outcomes', 'behaviors', 'conditions', 'constraints'] as const) {
      for (const item of doc[section] ?? []) {
        const key = `${section}:${item.id}`;
        if (catalog.sources[key]) problems.push(`${rel}: duplicate ${section.slice(0, -1)} id "${item.id}" (also in ${catalog.sources[key]})`);
        // Outcomes and behaviors share one id space: promoting a behavior means moving it, not copying it.
        const twin = section === 'outcomes' ? `behaviors:${item.id}` : section === 'behaviors' ? `outcomes:${item.id}` : null;
        if (twin && catalog.sources[twin]) problems.push(`${rel}: "${item.id}" is both an outcome and a behavior (also in ${catalog.sources[twin]}). Promoting a behavior moves it.`);
        catalog.sources[key] = rel;
        (catalog[section] as any[]).push(item);
      }
    }
  }

  if (problems.length) throw new CatalogError(problems);
  return catalog;
}
