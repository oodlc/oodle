import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { OodleError } from './errors.ts';

/** Path as the user would type it from where they are. */
export function display(path: string): string {
  const rel = relative(process.cwd(), path);
  if (!rel) return '.';
  return rel.startsWith('..') && rel.split('/').filter((s) => s === '..').length > 2 ? path : rel;
}

/** oodle.yaml files up to two levels below `dir`, for "did you mean". */
function nearby(dir: string, depth = 2): string[] {
  if (depth < 0 || !existsSync(dir) || !statSync(dir).isDirectory()) return [];
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const child = join(dir, entry.name);
    if (existsSync(join(child, 'oodle.yaml'))) found.push(child);
    else found.push(...nearby(child, depth - 1));
  }
  return found;
}

/**
 * Resolves the project directory. With an explicit path, uses it (or the directory
 * of an oodle.yaml passed directly). Without one, walks up from the current
 * directory like git does, so `oodle run` works from anywhere inside a project.
 */
export function findProject(arg?: string, command = '<cmd>'): string {
  if (arg) {
    const path = resolve(arg);
    if (basename(path) === 'oodle.yaml' && existsSync(path)) return dirname(path);
    if (existsSync(join(path, 'oodle.yaml'))) return path;
    const candidates = nearby(existsSync(path) ? path : dirname(path));
    throw new OodleError('no-project', existsSync(path) ? `No oodle.yaml in ${display(path)}` : `${display(path)} does not exist`, {
      hint: candidates.length
        ? `Did you mean ${candidates.slice(0, 3).map((c) => `\`${display(c)}\``).join(' or ')}?`
        : 'Create one with `oodle init`, or pass the directory that holds oodle.yaml.',
    });
  }
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'oodle.yaml'))) return dir;
    if (existsSync(join(dir, '.git')) || dirname(dir) === dir) break;
  }
  const candidates = nearby(process.cwd());
  throw new OodleError('no-project', 'No oodle.yaml here or in any parent directory', {
    hint: candidates.length
      ? `Found ${candidates.length === 1 ? 'a project' : 'projects'} below: ${candidates.slice(0, 3).map((c) => `\`oodle ${command} ${display(c)}\``).join(', ')}`
      : 'Run `oodle init` to start one.',
  });
}
