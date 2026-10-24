/**
 * `oodle`: people manage the spec; the code is generated from it and checked against it.
 */
import { SpecError, TierViolation } from '@oodle/spec';
import { Command, CommanderError } from 'commander';
import { compileCommand, init, verifyCommand } from './commands/basics.ts';
import { intentApprove, intentList, intentMerge, intentNew, intentReview } from './commands/intents.ts';
import { answerCommand, buildCommand, exportCommand, gapsCommand, statusCommand } from './commands/loop.ts';
import { loginCommand, syncCommand } from './commands/remote.ts';
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

  p.command('build')
    .description('generate the app from the spec, verify it, and keep the decisions it made')
    .option('--seed <n>', 'which independent build (default 1)')
    .option('--from <buildId>', 'start from a previous build, for an incremental change')
    .option('--force', 'build again even if a passing build of this spec exists')
    .action(async (o) => run(() => buildCommand(context(g()), o)));

  p.command('verify [build]')
    .description('check a build (an id, or a folder) against the spec')
    .option('--no-explore', 'run journeys and checks only, not the exploration plan')
    .option('--no-typecheck', "skip the build's own typecheck")
    .action(async (build, o) => run(() => verifyCommand(context(g()), build, o)));

  p.command('gaps')
    .description('build twice, diff what users see, and ask about each difference')
    .option('--journeys-only', 'diff journeys only, not the exploration plan')
    .option('--scope <scope>', 'intent:<id>: raise the gaps for an intent')
    .option('--a <dir>', 'diff this app folder…')
    .option('--b <dir>', '…against this one, instead of building')
    .action(async (o) => run(() => gapsCommand(context(g()), o)));

  p.command('answer [gapId]')
    .description('settle a gap: an option, a rule in plain words, "either is fine" or "not a real difference"')
    .option('--option <id>', 'choose an option')
    .option('--text <rule>', 'write a rule instead, in plain words')
    .option('--target <target>', 'with --text: decision, domain_rule or constraint', 'decision')
    .option('--dont-care', 'either is fine')
    .option('--dismiss', 'not a real difference')
    .option('--reason <why>', 'why, in one sentence (required from an agent)')
    .option('--auto', 'let the local agent settle every open gap routed to agents')
    .action(async (gapId, o) => run(() => answerCommand(context(g()), gapId, o)));

  const intent = p.command('intent').description('change the app: agree on what should change before any code exists');
  intent
    .command('new <name>')
    .description('start an intent in oodle/intents/')
    .option('--title <title>', 'what it changes, in a few words')
    .action(async (name, o) => run(() => intentNew(context(g()), name, o)));
  intent
    .command('list')
    .description('intents, their status and approvals')
    .action(async () => run(() => intentList(context(g()))));
  intent
    .command('review <id>')
    .description('build the change twice and raise the gaps it leaves open')
    .option('--a <dir>', 'use this app folder…')
    .option('--b <dir>', '…and this one, instead of building')
    .action(async (id, o) => run(() => intentReview(context(g()), id, o)));
  intent
    .command('approve <id>')
    .description('approve (or --reject) an intent; people only')
    .option('--reject', 'reject it instead')
    .option('--note <note>', 'a note with the review')
    .action(async (id, o) => run(() => intentApprove(context(g()), id, o)));
  intent
    .command('merge <id>')
    .description("write an approved intent's changes into the spec")
    .action(async (id) => run(() => intentMerge(context(g()), id)));

  p.command('sync')
    .description('push gaps and intents to the inbox, pull answers and reviews, apply them')
    .option('--watch [seconds]', 'keep syncing, every N seconds (default 30)')
    .action(async (o) => run(() => syncCommand(context(g()), o)));

  p.command('status')
    .description('open gaps by route and tier, unchecked decisions, the last spec the builds agreed on')
    .action(async () => run(() => statusCommand(context(g()))));

  p.command('login <remote>')
    .description('store a project token for an inbox in the OS keychain')
    .option('--project <id>', 'also set remote.project in oodle.config.yaml')
    .option('--token <token>', 'the token (otherwise asked for)')
    .action(async (remote, o) => run(() => loginCommand(context(g()), remote, o)));

  p.command('export <buildId> <dir>')
    .description("copy a build's app out of .oodle/builds/")
    .action(async (id, dir) => run(() => exportCommand(context(g()), id, dir)));

  return p;
}

let exitCode: number = EXIT.ok;

async function run(fn: () => number | Promise<number>) {
  exitCode = await fn();
}

export async function main(argv = process.argv): Promise<number> {
  const json = argv.includes('--json');
  exitCode = EXIT.ok;
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
