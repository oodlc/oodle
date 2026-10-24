/**
 * What every command shares: where the project is, its settings, the model, and how to answer.
 * Every command takes `--json` for agents. Exit codes:
 *
 *   0  done
 *   1  failed (a check failed, or something went wrong)
 *   2  wrong usage
 *   3  needs a person: the message says what, and where (the inbox, when there is one)
 */
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { agentModel, type Model } from '@oodle/compile';
import { type Config, loadConfig, SPEC_DIR } from '@oodle/spec';

export const EXIT = { ok: 0, failed: 1, usage: 2, needsPerson: 3 } as const;

export class CliError extends Error {
  constructor(
    message: string,
    readonly code: number = EXIT.failed,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

/** Something only a person may do was asked for without one at the keyboard. */
export class NeedsPerson extends CliError {
  constructor(what: string, config?: Config) {
    const where = config?.remote ? ` Answer it in the inbox: ${config.remote.url}` : ' Run the command yourself, in a terminal.';
    super(`This needs a person: ${what}.${where}`, EXIT.needsPerson, { needs_person: what, inbox: config?.remote?.url ?? null });
  }
}

export interface Ctx {
  root: string;
  json: boolean;
  config: Config;
  /** True when a person is at the keyboard: stdin and stdout are terminals, and OODLE_AGENT isn't set. */
  tty: boolean;
  model(): Model;
  /** The .oodle/ working folder (gitignored). */
  work(...parts: string[]): string;
  print(human: string): void;
}

/** The nearest folder at or above `from` that has an `oodle/` folder. */
export function findRoot(from: string): string | undefined {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, SPEC_DIR))) return dir;
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

export function context(opts: { root?: string; json?: boolean }, needSpec = true): Ctx {
  const found = opts.root ? resolve(opts.root) : findRoot(process.cwd());
  if (!found && needSpec) throw new CliError('No oodle/ folder here or above. Run `oodle init` to start a spec.', EXIT.usage);
  const root = found ?? process.cwd();
  const config = found ? loadConfig(root) : loadConfig('/nonexistent');
  let model: Model | undefined;
  const json = !!opts.json;
  return {
    root,
    json,
    config,
    tty: !!process.stdin.isTTY && !!process.stdout.isTTY && !process.env.OODLE_AGENT,
    model: () => {
      model ??= agentModel({ model: config.model });
      return model;
    },
    work: (...parts) => {
      const p = join(root, '.oodle', ...parts);
      mkdirSync(dirname(p), { recursive: true });
      return p;
    },
    print: (human) => {
      if (!json) process.stdout.write(`${human}\n`);
    },
  };
}

/** Prints a command's result: its JSON for agents, nothing more for people (they got `print`). */
export function done(ctx: Ctx, data: unknown, code: number = EXIT.ok): number {
  if (ctx.json) process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  return code;
}
