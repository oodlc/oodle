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

export class CatalogError extends Error {
  constructor(public problems: string[]) {
    super(problems.join('\n'));
  }
}

function formatAjv(file: string, errors: any[] | null | undefined): string[] {
  return (errors ?? []).map((e) => `${file}: ${e.instancePath || '/'} ${e.message}${e.params?.additionalProperty ? ` (${e.params.additionalProperty})` : ''}`);
}

export function loadConfig(projectDir: string): Config {
  const file = join(projectDir, 'oodle.yaml');
  if (!existsSync(file)) throw new CatalogError([`${file}: not found. A project needs an oodle.yaml with "app" and "catalog".`]);
  const config = parse(readFileSync(file, 'utf8'));
  if (!validateConfig(config)) throw new CatalogError(formatAjv('oodle.yaml', validateConfig.errors));
  return config as Config;
}

export function loadCatalog(projectDir: string, config: Config): Catalog {
  const dir = resolve(projectDir, config.catalog);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new CatalogError([`${config.catalog}: catalog directory not found`]);

  const catalog: Catalog = { intents: [], outcomes: [], behaviors: [], conditions: [], constraints: [], sources: {} };
  const problems: string[] = [];
  const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort();

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
