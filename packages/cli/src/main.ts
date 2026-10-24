/**
 * `oodle`: you manage the spec, the code is generated and checked against it.
 */
import { SpecError, TierViolation } from '@oodle/spec';
import { Command, CommanderError } from 'commander';
import { compileCommand, init, verifyCommand } from './commands/basics.ts';
import { CliError, context, EXIT } from './context.ts';

type Opts = { root?: string; json?: boolean };

export function program(): Command {
  const p = new Command('oodle')
    .description('People manage the spec; the code is generated from it and checked against it.')
    .option('--root <dir>', 'the project folder (default: the nearest one with an oodle/ folder)')
    .option('--json', 'answer in JSON, for agents')
    .exitOverride()
    .configureOutput({ outputError: (s, write) => write(s) });

  const g = () => p.opts<Opts>();

  p.command('init')
    .description('start a spec in oodle/ (empty, or the dog-walking example)')
    .option('--example', "start from the README's dog-walking example")
    .action(async (o) => run(() => init(context(g(), false), o)));

  p.command('compile')
    .description('compile journeys, constraints and decisions into what the simulation runs')
    .option('--check', 'change nothing: show each journey next to what it compiled to, and fail if anything is stale')
    .action(async (o) => run(() => compileCommand(context(g()), o)));

  p.command('verify [build]')
    .description('check a build (an id, or a folder) against the spec')
    .option('--no-explore', 'run journeys and checks only, not the exploration plan')
    .option('--no-typecheck', "skip the build's own typecheck")
    .action(async (build, o) => run(() => verifyCommand(context(g()), build, o)));

  return p;
}

let exitCode: number = EXIT.ok;

async function run(fn: () => number | Promise<number>) {
  exitCode = await fn();
}

export async function main(argv = process.argv): Promise<number> {
  const json = argv.includes('--json');
  try {
    await program().parseAsync(argv);
    return exitCode;
  } catch (e) {
    if (e instanceof CommanderError) return e.exitCode === 0 ? EXIT.ok : EXIT.usage;
    const err = e as Error;
    const code = e instanceof CliError ? e.code : EXIT.failed;
    const problems = e instanceof SpecError ? e.problems : e instanceof TierViolation ? e.changes : undefined;
    if (json)
      process.stdout.write(
        `${JSON.stringify({ error: err.message, ...(problems ? { problems } : {}), ...(e instanceof CliError && e.data ? (e.data as object) : {}) }, null, 2)}\n`,
      );
    else process.stderr.write(`oodle: ${err.message}\n`);
    if (!(e instanceof CliError) && !(e instanceof SpecError) && process.env.OODLE_DEBUG) process.stderr.write(`${err.stack}\n`);
    return code;
  }
}
