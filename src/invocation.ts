/**
 * How the person at the keyboard runs Oodle. It's usually a dev dependency,
 * so `oodle` isn't on their PATH: hints say `npx oodle run`, `pnpm exec oodle run`
 * and so on, unless an `oodle` really is on the PATH.
 */
import { existsSync } from 'node:fs';
import { delimiter, dirname, join, resolve, sep } from 'node:path';

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

/** The package manager a directory uses, from the nearest lockfile at or above it (npm when there is none). */
export function packageManager(dir: string): PackageManager {
  for (let d = resolve(dir); ; d = dirname(d)) {
    if (existsSync(join(d, 'pnpm-lock.yaml'))) return 'pnpm';
    if (existsSync(join(d, 'yarn.lock'))) return 'yarn';
    if (existsSync(join(d, 'bun.lock')) || existsSync(join(d, 'bun.lockb'))) return 'bun';
    if (existsSync(join(d, 'package-lock.json')) || dirname(d) === d) return 'npm';
  }
}

/** The command that adds Oodle as a dev dependency. npm can't install into a pnpm node_modules. */
export const installOodle = (pm: PackageManager): string =>
  ({ npm: 'npm i -D', pnpm: 'pnpm add -D', yarn: 'yarn add -D', bun: 'bun add -d' })[pm] + ' @oodlc/oodle';

const RUNNERS: Record<PackageManager, string> = { npm: 'npx oodle', pnpm: 'pnpm exec oodle', yarn: 'yarn oodle', bun: 'bunx oodle' };

let cached: string | undefined;

/** `oodle` when the shell finds one, otherwise the package manager's way to run a local bin. */
export function oodleCommand(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  if (env === process.env && cached) return cached;
  // npx and pnpm exec put node_modules/.bin on the PATH of the process they start, not of the shell.
  const bins = (env.PATH ?? '').split(delimiter).filter((d) => d && !d.endsWith(`node_modules${sep}.bin`));
  const onPath = bins.some((d) => existsSync(join(d, process.platform === 'win32' ? 'oodle.cmd' : 'oodle')));
  const agent = /^(npm|pnpm|yarn|bun)\//.exec(env.npm_config_user_agent ?? '')?.[1] as PackageManager | undefined;
  const command = onPath ? 'oodle' : RUNNERS[agent ?? packageManager(cwd)];
  if (env === process.env) cached = command;
  return command;
}

/** Rewrites `oodle <command>` in a message to the command that works here. Leaves @oodlc/oodle, oodle.app.ts and prose alone. */
export const runnable = (text: string, command = oodleCommand()): string =>
  command === 'oodle' ? text : text.replace(/(?<![\w/.@-])oodle(?= (?:-|[a-z]))/g, command);
