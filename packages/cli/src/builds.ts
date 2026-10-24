/**
 * Where builds live: `.oodle/builds/<buildId>/`, with the generated app in `app/` (the agent's
 * working folder) and, next to it, `manifest.json`, the agent's transcript and the verify report.
 * `.oodle/builds/latest` names the last build.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CliError, type Ctx, EXIT } from './context.ts';

export interface BuildRef {
  /** The app's folder. */
  dir: string;
  /** Set for builds under .oodle/builds/. */
  id?: string;
}

export const buildsDir = (ctx: Ctx) => join(ctx.root, '.oodle', 'builds');

export function resolveBuild(ctx: Ctx, arg?: string): BuildRef {
  if (arg && existsSync(join(resolve(arg), 'wrangler.jsonc'))) return { dir: resolve(arg) };
  const latest = join(buildsDir(ctx), 'latest');
  const id = arg ?? (existsSync(latest) ? readFileSync(latest, 'utf8').trim() : undefined);
  if (!id) throw new CliError('No build yet. Run `oodle build`, or give a folder with a wrangler.jsonc.', EXIT.usage);
  const dir = join(buildsDir(ctx), id, 'app');
  if (!existsSync(dir)) throw new CliError(`No build "${id}" in .oodle/builds/.`, EXIT.usage);
  return { dir, id };
}
