import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { CONFIG_FILE, FOLDER, isProject } from './catalog.ts';
import { OodleError } from './errors.ts';

/** Path as the user would type it from where they are. */
export function display(path: string): string {
  const rel = relative(process.cwd(), path);
  if (!rel) return '.';
  return rel.startsWith('..') && rel.split('/').filter((s) => s === '..').length > 2 ? path : rel;
}

/** Projects up to two levels below `dir`, for "did you mean". */
function nearby(dir: string, depth = 2): string[] {
  if (depth < 0 || !existsSync(dir) || !statSync(dir).isDirectory()) return [];
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === FOLDER) continue;
    const child = join(dir, entry.name);
    if (isProject(child)) found.push(child);
    else found.push(...nearby(child, depth - 1));
  }
  return found;
}

/**
 * Resolves the project directory: the one that holds oodlc/. An explicit path may
 * name the project, its oodlc/ folder, or a config file inside it. Without one,
 * walks up from the current directory like git does, so `oodle run` works from
 * anywhere inside a project, including from inside oodlc/.
 */
export function findProject(arg?: string, command = '<cmd>'): string {
  if (arg) {
    let path = resolve(arg);
    if ((basename(path) === CONFIG_FILE || basename(path) === 'oodle.yaml') && existsSync(path)) path = dirname(path);
    if (basename(path) === FOLDER && isProject(dirname(path))) path = dirname(path);
    if (isProject(path)) return path;
    const candidates = nearby(existsSync(path) ? path : dirname(path));
    throw new OodleError('no-project', existsSync(path) ? `No ${FOLDER}/ folder in ${display(path)}` : `${display(path)} does not exist`, {
      hint: candidates.length
        ? `Did you mean ${candidates.slice(0, 3).map((c) => `\`${display(c)}\``).join(' or ')}?`
        : `Create one with \`oodle init\`, or pass the directory that holds ${FOLDER}/.`,
    });
  }
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    if (isProject(dir)) return dir;
    if (existsSync(join(dir, '.git')) || dirname(dir) === dir) break;
  }
  const candidates = nearby(process.cwd());
  throw new OodleError('no-project', `No ${FOLDER}/ folder here or in any parent directory`, {
    hint: candidates.length
      ? `Found ${candidates.length === 1 ? 'a project' : 'projects'} below: ${candidates.slice(0, 3).map((c) => `\`oodle ${command} ${display(c)}\``).join(', ')}`
      : 'Run `oodle init` to start one.',
  });
}
