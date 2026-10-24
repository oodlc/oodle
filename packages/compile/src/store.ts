/**
 * What `oodle compile` writes under oodle/compiled/, committed with the spec:
 *
 *   actions.json            the action and screen vocabulary every build implements
 *   journeys/<id>.json      each journey as a scenario
 *   explore.json            the exploration plan
 *   checks/<id>.json        each build-checked constraint and pinned decision as a check
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { specDir } from '@oodle/spec';
import type { CompiledCheck } from './checks.ts';
import type { ExplorePlan } from './explore.ts';
import type { CompiledJourney } from './journeys.ts';
import type { Vocabulary } from './vocabulary.ts';

export const compiledDir = (root: string) => join(specDir(root), 'compiled');

const readJson = <T>(path: string): T | undefined => (existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : undefined);

function writeJson(path: string, value: unknown): boolean {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (existsSync(path) && readFileSync(path, 'utf8') === text) return false;
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
  return true;
}

export interface Compiled {
  vocabulary?: Vocabulary;
  journeys: CompiledJourney[];
  explore?: ExplorePlan;
  checks: CompiledCheck[];
}

function readDir<T>(dir: string): T[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => readJson<T>(join(dir, f)) as T);
}

export function readCompiled(root: string): Compiled {
  const dir = compiledDir(root);
  return {
    vocabulary: readJson<Vocabulary>(join(dir, 'actions.json')),
    journeys: readDir<CompiledJourney>(join(dir, 'journeys')),
    explore: readJson<ExplorePlan>(join(dir, 'explore.json')),
    checks: readDir<CompiledCheck>(join(dir, 'checks')),
  };
}

/** Writes what changed and removes files nothing in the spec compiles to any more. Returns the paths written or removed. */
export function writeCompiled(root: string, c: Required<Compiled>, checkIdOf: (c: CompiledCheck) => string): string[] {
  const dir = compiledDir(root);
  const touched: string[] = [];
  const put = (path: string, value: unknown) => writeJson(path, value) && touched.push(path);
  put(join(dir, 'actions.json'), c.vocabulary);
  put(join(dir, 'explore.json'), c.explore);
  const sync = (sub: string, items: [string, unknown][]) => {
    const keep = new Set(items.map(([id]) => `${id}.json`));
    for (const [id, v] of items) put(join(dir, sub, `${id}.json`), v);
    if (existsSync(join(dir, sub))) {
      for (const f of readdirSync(join(dir, sub))) {
        if (f.endsWith('.json') && !keep.has(f)) {
          rmSync(join(dir, sub, f));
          touched.push(join(dir, sub, f));
        }
      }
    }
  };
  sync(
    'journeys',
    c.journeys.map((j) => [j.journey, j]),
  );
  sync(
    'checks',
    c.checks.map((k) => [checkIdOf(k), k]),
  );
  return touched;
}
