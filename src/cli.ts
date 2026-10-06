import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { CatalogError, FOLDER, configFile, isProject, loadCatalog, loadConfig } from './catalog.ts';
import { lint } from './lint.ts';
import { runProject } from './runner.ts';
import { diffRuns, parseApproval, type Approval } from './diff.ts';
import { approvalTokens, diffMarkdown } from './report.ts';
import { renderDiff, renderLint, renderMutate, renderRun, wrap } from './render.ts';
import { annotateDiff, annotateLint, annotateRun } from './ci.ts';
import { init, migrate } from './init.ts';
import { installOodle, oodleCommand, packageManager, runnable } from './invocation.ts';
import { doctor } from './doctor.ts';
import { mutate, type MutateReport } from './mutate.ts';
import { propose } from './propose.ts';
import { draftPrompt } from './draft.ts';
import { serveMcp } from './mcp.ts';
import { runHook, HOOKS } from './hooks.ts';
import { completion, SHELLS, type Shell } from './completion.ts';
import { findProject, display } from './project.ts';
import { EXIT, OodleError, suggest, usageError } from './errors.ts';
import { clearSpinner, columns, err as e, hints, ms, note, plural, out as o, settings, spinner, sym, type ColorMode } from './term.ts';
import { hello, say } from './oodle.ts';
import type { RunResult } from './types.ts';

const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'));
const VERSION: string = pkg.version;
const DOCS = 'https://github.com/oodlc/oodle#readme';
const ISSUES = 'https://github.com/oodlc/oodle/issues/new';

// ── Command registry ────────────────────────────────────────────────────────

type Format = 'text' | 'json' | 'md';

interface Flag {
  name: string;
  short?: string;
  type: 'boolean' | 'string';
  multiple?: boolean;
  /** Placeholder shown in help, e.g. <ref>. */
  value?: string;
  choices?: string[];
  /** What a shell should offer for the value. Default: files. */
  complete?: 'files' | 'refs' | 'none';
  description: string;
}

interface Ctx {
  args: string[];
  flags: Record<string, any>;
  format: Format;
}

interface Command {
  name: string;
  summary: string;
  description: string;
  args: { name: string; required?: boolean; description: string }[];
  flags: Flag[];
  formats: Format[];
  /** Format when none is asked for. Defaults to text. */
  defaultFormat?: () => Format;
  examples: [string, string][];
  positional?: 'dirs' | 'files' | string[];
  run(ctx: Ctx): Promise<number>;
}

const GLOBAL_FLAGS: Flag[] = [
  { name: 'json', type: 'boolean', description: 'Print exactly one JSON document on stdout (same as --format json)' },
  { name: 'format', type: 'string', value: 'fmt', description: 'Output format; choices depend on the command' },
  { name: 'color', type: 'string', value: 'when', choices: ['auto', 'always', 'never'], description: 'Colour output: auto (default), always or never' },
  { name: 'no-color', type: 'boolean', description: 'Same as --color never' },
  { name: 'quiet', short: 'q', type: 'boolean', description: 'Hush Oodle, hints and progress; results still print' },
  { name: 'debug', type: 'boolean', description: 'Show stack traces and internal detail on errors' },
  { name: 'help', short: 'h', type: 'boolean', description: 'Show help for the command' },
];

const MD_FLAG: Flag = { name: 'md', type: 'string', value: 'file', description: 'Also write the diff as markdown, for a PR comment' };
const APPROVE_FLAGS: Flag[] = [
  { name: 'approve', type: 'string', multiple: true, value: 'id@fingerprint', complete: 'none', description: 'Approve one blocking change to a promise, as printed in the diff (repeatable)' },
  { name: 'approvals', type: 'string', value: 'file', description: 'Read approvals from a JSON file: [{ "id", "fingerprint", "by" }]. The GitHub Action writes this from pull request reviews' },
];
const VERBOSE: Flag = { name: 'verbose', short: 'v', type: 'boolean', description: 'Show statements, held outcomes and proposed catalog entries' };
const WATCH: Flag = { name: 'watch', short: 'w', type: 'boolean', description: 'Re-run whenever a file in the project changes' };

const PROJECT_ARG = { name: 'project', description: 'Directory that holds oodlc/. Default: the nearest one at or above the current directory' };

const COMMANDS: Command[] = [
  {
    name: 'run',
    summary: 'Run every outcome and behavior under every condition',
    description:
      'Runs the app in a simulated world: every outcome and behavior, under each of its conditions, with every external call stubbed and every side effect recorded. Outcomes and constraints block; behavior drift is reported only. Routes nothing describes are probed and listed as unknown.',
    args: [PROJECT_ARG],
    flags: [
      { name: 'only', short: 'o', type: 'string', multiple: true, value: 'glob', complete: 'none', description: 'Run only ids matching the glob, e.g. "checkout.*" (repeatable)' },
      VERBOSE,
      WATCH,
    ],
    formats: ['text', 'json'],
    examples: [
      ['oodle run', 'Run the project in or above the current directory'],
      ['oodle run examples/checkout --only "checkout.*"', 'Run a subset'],
      ['oodle run --watch', 'Re-run on every save'],
      ['oodle run --json | jq .summary', 'Machine-readable results'],
    ],
    run: cmdRun,
  },
  {
    name: 'check',
    summary: 'Outcome diff of the working tree against a git ref',
    description:
      'Checks out the base ref in a temporary worktree, runs base and head, and reports what changed outcome by outcome. Exit code 1 means something blocks: an outcome broke, or a promise changed (an outcome changed, was redefined or removed, or a constraint was touched) and nobody has approved it yet, or a constraint was violated. A change to a promise is approved with --approve id@fingerprint; a broken outcome is never approvable.',
    args: [PROJECT_ARG],
    flags: [
      { name: 'base-ref', short: 'b', type: 'string', value: 'ref', complete: 'refs', description: 'Git ref to compare against. Default: origin/HEAD, then main, then master' },
      ...APPROVE_FLAGS,
      MD_FLAG,
      VERBOSE,
    ],
    formats: ['text', 'md', 'json'],
    defaultFormat: () => (process.stdout.isTTY ? 'text' : 'md'),
    examples: [
      ['oodle check', 'Compare the working tree with the default branch'],
      ['oodle check --base-ref HEAD~1', 'What did the last commit change?'],
      ['oodle check --md diff.md', 'Also write a PR comment'],
      ['oodle check --approve orders.paid@1a2b3c4d', 'A human approves one intended change'],
    ],
    run: cmdCheck,
  },
  {
    name: 'diff',
    summary: 'Outcome diff between two project checkouts',
    description: 'Runs two copies of a project and reports the outcome diff from <base> to <head>. Use `oodle check` to compare against a git ref instead.',
    args: [
      { name: 'base', required: true, description: 'Project directory before the change' },
      { name: 'head', required: true, description: 'Project directory after the change' },
    ],
    flags: [...APPROVE_FLAGS, MD_FLAG, VERBOSE],
    formats: ['text', 'md', 'json'],
    defaultFormat: () => (process.stdout.isTTY ? 'text' : 'md'),
    examples: [['oodle diff ../before ./app --md diff.md', 'Diff two checkouts and write a PR comment']],
    run: cmdDiff,
  },
  {
    name: 'lint',
    summary: 'Validate the catalog and its traceability',
    description: 'Validates oodlc/config.yaml and every catalog file against the schema, then checks traceability: every outcome traces to an intent, every reference resolves, every constraint parses.',
    args: [PROJECT_ARG],
    flags: [WATCH],
    formats: ['text', 'json'],
    examples: [
      ['oodle lint', 'Lint the nearest project'],
      ['oodle lint --watch', 'Lint on every save while editing the catalog'],
    ],
    run: cmdLint,
  },
  {
    name: 'init',
    summary: 'Start a project: an oodlc/ folder with config, a starter catalog and app',
    description: 'Creates oodlc/ with config.yaml and a starter catalog. In a repository that already has an HTTP service (Next.js, Express, Fastify, Koa, Hono or node:http), it writes oodle.app.ts, which runs that service through @oodlc/oodle/adapter (or /next), instead of a starter app. Otherwise it writes a starter app that passes `oodle run` straight away. Your own files are never overwritten. With --ci, also writes a GitHub workflow that posts the outcome diff and takes approvals from reviews. With --migrate, moves a project from the old layout (oodle.yaml plus a catalog directory) into oodlc/, keeping git history.',
    args: [{ name: 'dir', description: 'Where to create the project. Default: the current directory' }],
    flags: [
      { name: 'app', type: 'string', value: 'path', description: 'Use an existing app module instead of the starter (relative to dir)' },
      { name: 'force', short: 'f', type: 'boolean', description: 'Overwrite an existing oodlc/config.yaml and starter catalog' },
      { name: 'ci', type: 'boolean', description: 'Also write .github/workflows/oodle.yml: the outcome diff on every pull request, approvals from reviews' },
      { name: 'migrate', type: 'boolean', description: 'Move an old-layout project (oodle.yaml + catalog/) into oodlc/' },
    ],
    formats: ['text', 'json'],
    examples: [
      ['oodle init', 'Scaffold in the current directory, wrapping the service already there'],
      ['oodle init --ci', 'Also add the GitHub workflow'],
      ['oodle init services/api --app src/server.ts', 'Point Oodle at an existing app'],
      ['oodle init --migrate', 'Move an oodle.yaml project into oodlc/'],
    ],
    run: cmdInit,
  },
  {
    name: 'doctor',
    summary: 'Check your environment and project setup',
    description: 'Checks Node, git, the project config, the catalog, lint, and that the app loads and every external call it makes has a stub. Each problem comes with a fix.',
    args: [PROJECT_ARG],
    flags: [],
    formats: ['text', 'json'],
    examples: [['oodle doctor', 'Is everything wired up?']],
    run: cmdDoctor,
  },
  {
    name: 'mutate',
    summary: 'Plant small bugs in the app and see which ones the catalog catches',
    description:
      'Makes small, plausible bugs in the app (a flipped comparison, a dropped effect, a changed literal), runs every outcome against each one in its own sealed simulation, and reports which bugs an outcome or constraint catches. A bug nothing catches points at an outcome that is too loose or a missing condition. Outcomes that catch nothing a smaller set does not are listed as redundant. With --tests, each bug also runs through your test suite. Tests whose every caught bug an outcome caught too are listed as covered by the catalog: candidates to delete after a read, since a test can guard inputs no outcome sends. Entry-point boilerplate (listen, process.argv, logging) and @oodlc/oodle/adapter modules are never mutated.',
    args: [PROJECT_ARG],
    flags: [
      { name: 'files', type: 'string', multiple: true, value: 'glob', complete: 'none', description: 'Mutate these files, relative to the project, e.g. "src/**/*.ts" (repeatable). Default: the app\'s directory, minus tests' },
      { name: 'only', short: 'o', type: 'string', multiple: true, value: 'glob', complete: 'none', description: 'Run only outcomes and behaviors whose id matches (repeatable)' },
      { name: 'max', type: 'string', value: 'n', complete: 'none', description: 'At most this many mutants, sampled evenly across files. Default: 200' },
      { name: 'jobs', short: 'j', type: 'string', value: 'n', complete: 'none', description: 'Mutants to run in parallel. Default: CPU cores minus one' },
      { name: 'tests', type: 'string', value: 'cmd', complete: 'none', description: 'Also run this test command on every mutant, e.g. "npm test", to find tests the catalog makes redundant' },
      { name: 'min-score', type: 'string', value: 'pct', complete: 'none', description: 'Exit 1 when fewer than this percentage of mutants are caught, e.g. 80' },
      VERBOSE,
    ],
    formats: ['text', 'json'],
    examples: [
      ['oodle mutate', 'How many planted bugs does the catalog catch?'],
      ['oodle mutate --files "src/checkout.ts" --only "checkout.*"', 'Focus on one file and its outcomes'],
      ['oodle mutate --tests "npm test"', 'Which unit tests catch nothing the outcomes miss?'],
      ['oodle mutate --min-score 80 --json', 'Gate CI on mutation score'],
    ],
    run: cmdMutate,
  },
  {
    name: 'propose',
    summary: 'Add drafted catalog entries as proposals, never changing an existing one',
    description:
      'Reads a YAML catalog fragment (from a file, or - for stdin) and adds it to oodlc/proposed.yaml. Every intent, outcome and constraint is marked status: proposed, so it runs and is reported but never blocks until a human approves it by deleting that line. An id that already exists is refused: a proposal can add, never change or remove. This is how agents and the drafter write to the catalog.',
    args: [
      { name: 'file', required: true, description: 'YAML with any of intents, outcomes, behaviors, conditions, constraints; - reads stdin' },
      PROJECT_ARG,
    ],
    flags: [],
    formats: ['text', 'json'],
    positional: 'files',
    examples: [
      ['oodle propose draft.yaml', 'Add a drafted outcome as a proposal'],
      ['oodle draft brief.md | claude -p | oodle propose -', 'Draft from a brief with an agent, straight into proposals'],
    ],
    run: cmdPropose,
  },
  {
    name: 'draft',
    summary: 'Print the prompt that drafts catalog entries from a brief',
    description:
      'Writes a prompt for any coding agent or model: the rules of a good catalog, this project\'s intents, outcomes, conditions, constraints and stubs, and your brief. The answer is a YAML fragment for `oodle propose`. Oodle never calls a model itself. With `oodle mcp`, agents get the same prompt as the `draft` MCP prompt.',
    args: [
      { name: 'brief', required: true, description: 'A file with the brief (PRD, ticket, a few sentences); - reads stdin' },
      PROJECT_ARG,
    ],
    flags: [],
    formats: ['text'],
    positional: 'files',
    examples: [
      ['oodle draft brief.md > prompt.md', 'Write the drafting prompt'],
      ['oodle draft brief.md | claude -p | oodle propose -', 'Draft and propose in one go'],
    ],
    run: cmdDraft,
  },
  {
    name: 'mcp',
    summary: 'Serve Oodle to coding agents over the Model Context Protocol',
    description:
      'Runs an MCP server on stdio. Agents get tools to run, check, lint, explain and mutate, to read the catalog, and to propose new entries, plus a `draft` prompt. There is no tool that edits or removes an outcome, a constraint or an intent: those stay human decisions. Add it to Claude Code with `claude mcp add oodle -- npx --no-install oodle mcp`.',
    args: [PROJECT_ARG],
    flags: [],
    formats: ['text'],
    examples: [
      ['claude mcp add oodle -- npx --no-install oodle mcp', 'Give Claude Code the Oodle tools'],
      ['oodle mcp services/checkout', 'Serve one project'],
    ],
    run: cmdMcp,
  },
  {
    name: 'hook',
    summary: 'Answer a coding agent\'s lifecycle hook (Claude Code)',
    description:
      'Reads a hook event as JSON on stdin and answers it on stdout. session-start tells the agent how the project is guarded. pre-tool-use asks before any edit that would change or remove an approved outcome, constraint or intent. stop keeps the agent working while an outcome it broke is still broken, and tells the person what needs their approval. The Claude Code plugin in integrations/claude-code wires these up.',
    args: [{ name: 'event', required: true, description: HOOKS.join(', ') }],
    flags: [],
    formats: ['text'],
    positional: [...HOOKS],
    examples: [
      ['echo \'{"cwd":"."}\' | oodle hook session-start', 'What the agent is told at the start of a session'],
      ['claude plugin install oodle@oodlc', 'Install the hooks in Claude Code'],
    ],
    run: async (ctx) => runHook(ctx.args[0], VERSION),
  },
  {
    name: 'completion',
    summary: 'Print a shell completion script',
    description: 'Prints a completion script for bash, zsh or fish, generated from the same registry as this help, so it never goes stale.',
    args: [{ name: 'shell', required: true, description: SHELLS.join(', ') }],
    flags: [],
    formats: ['text'],
    positional: [...SHELLS],
    examples: [
      ['oodle completion zsh > "${fpath[1]}/_oodle"', 'zsh'],
      ['oodle completion bash >> ~/.bashrc', 'bash'],
      ['oodle completion fish > ~/.config/fish/completions/oodle.fish', 'fish'],
    ],
    run: cmdCompletion,
  },
  {
    name: 'hello',
    summary: 'Meet Oodle',
    description: 'Oodle waves and explains the deal.',
    args: [],
    flags: [],
    formats: ['text'],
    examples: [['oodle hello', 'Say hi']],
    run: async () => (await hello(), EXIT.ok),
  },
  {
    name: 'help',
    summary: 'Show help for oodle or a command',
    description: 'Shows help. With --json, describes every command, flag, exit code and environment variable, for scripts and agents.',
    args: [{ name: 'command', description: 'Command to describe' }],
    flags: [],
    formats: ['text', 'json'],
    examples: [
      ['oodle help check', 'Help for one command'],
      ['oodle help --json', 'The whole CLI as JSON'],
    ],
    run: async (ctx) => {
      if (ctx.format === 'json') return printJson(cliSpec()), EXIT.ok;
      const name = ctx.args[0];
      if (!name) return console.log(topHelp()), EXIT.ok;
      return console.log(commandHelp(commandNamed(name))), EXIT.ok;
    },
  },
];

const ENV: [string, string][] = [
  ['NO_COLOR', 'Disable colour (any non-empty value)'],
  ['FORCE_COLOR', 'Force colour on, even when piped (0 forces it off)'],
  ['OODLE_FORMAT', 'Default output format, e.g. json for agents and scripts'],
  ['OODLE_QUIET', 'Same as --quiet'],
  ['OODLE_STILL', 'Draw Oodle without animation'],
  ['OODLE_ASCII', 'Use ASCII symbols instead of unicode'],
  ['OODLE_DEBUG', 'Same as --debug'],
  ['GITHUB_ACTIONS', 'When "true", findings become annotations and diffs go to the job summary'],
  ['OODLE_HOOK_STRICT', '`oodle hook pre-tool-use` refuses edits to approved catalog entries instead of asking'],
];

const EXIT_DOCS: [number, string][] = [
  [EXIT.ok, 'Success. Nothing a human declared is broken'],
  [EXIT.blocking, 'Blocking: an outcome or constraint is not holding, or the catalog has lint errors'],
  [EXIT.usage, 'Could not run: bad usage, no project, invalid config, or the app failed to load'],
  [EXIT.interrupted, 'Interrupted with Ctrl-C'],
];

function commandNamed(name: string): Command {
  const cmd = COMMANDS.find((c) => c.name === name);
  if (cmd) return cmd;
  const guess = suggest(name, COMMANDS.map((c) => c.name));
  throw usageError(`Unknown command "${name}"`, guess ? `Did you mean \`oodle ${guess}\`?` : 'Run `oodle help` to see every command.');
}

// ── Help ────────────────────────────────────────────────────────────────────

const H = (t: string) => o.bold(t.toUpperCase());

function flagLabel(f: Flag): string {
  return `${f.short ? `-${f.short}, ` : '    '}--${f.name}${f.value ? ` <${f.value}>` : ''}`;
}

function flagRows(flags: Flag[]): string[] {
  const width = Math.max(...flags.map((f) => flagLabel(f).length)) + 3;
  return flags.map((f) => `  ${o.cyan(flagLabel(f))}${' '.repeat(width - flagLabel(f).length)}${wrap(f.description, columns() - width - 4, width + 2)}`);
}

function exampleRows(examples: [string, string][]): string[] {
  return examples.flatMap(([cmd, what]) => [`  ${o.dim(`# ${what}`)}`, `  ${o.dim('$')} ${runnable(cmd)}`]);
}

function topHelp(): string {
  const width = Math.max(...COMMANDS.map((c) => c.name.length)) + 4;
  return [
    `${o.bold('oodle')} ${o.dim(VERSION)}  CI that protects outcomes and watches behavior. ${o.dim('Part of OODLC.')}`,
    '',
    H('Usage'),
    runnable(`  oodle ${o.cyan('<command>')} [project] [flags]`),
    '',
    H('Commands'),
    ...COMMANDS.map((c) => `  ${o.cyan(c.name.padEnd(width))}${c.summary}`),
    '',
    H('Examples'),
    ...exampleRows([
      ['oodle init', 'Start a project in this directory'],
      ['oodle run --watch', 'Run every outcome, again on every save'],
      ['oodle check --base-ref main --md diff.md', 'What this branch changes, outcome by outcome'],
    ]),
    '',
    H('Flags'),
    ...flagRows([...GLOBAL_FLAGS, { name: 'version', short: 'V', type: 'boolean', description: 'Print the version' }]),
    '',
    H('Exit codes'),
    ...EXIT_DOCS.map(([c, d]) => `  ${o.cyan(String(c).padEnd(5))}${d}`),
    '',
    H('Learn more'),
    `  ${o.cyan(runnable('oodle help <command>'))}   details and examples for one command`,
    `  ${o.cyan(runnable('oodle help --json'))}      the whole CLI as JSON, for scripts and agents`,
    `  ${o.link(DOCS, DOCS)}`,
  ].join('\n');
}

/** --json and --format only apply to commands with more than one format. */
const globalsFor = (c: Command) => GLOBAL_FLAGS.filter((g) => c.formats.length > 1 || !['json', 'format'].includes(g.name));

function commandHelp(c: Command): string {
  const usageArgs = c.args.map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`)).join(' ');
  const flags = c.flags.length + GLOBAL_FLAGS.length;
  const lines = [
    `${o.bold(`oodle ${c.name}`)}  ${c.summary}`,
    '',
    H('Usage'),
    runnable(`  oodle ${c.name}${usageArgs ? ` ${usageArgs}` : ''}${flags ? ' [flags]' : ''}`),
    '',
    wrap(c.description, Math.min(columns(), 100) - 2).split('\n').map((l) => `  ${l}`).join('\n'),
    '',
  ];
  if (c.args.length) {
    const w = Math.max(...c.args.map((a) => a.name.length)) + 4;
    lines.push(H('Arguments'), ...c.args.map((a) => `  ${o.cyan(a.name.padEnd(w))}${wrap(a.description, columns() - w - 4, w + 2)}`), '');
  }
  lines.push(H('Examples'), ...exampleRows(c.examples), '');
  const globals = globalsFor(c);
  if (c.flags.length) lines.push(H('Flags'), ...flagRows(c.flags), '');
  lines.push(H('Global flags'), ...flagRows(globals));
  if (c.formats.length > 1) lines.push('', `  ${o.dim(`Formats: ${c.formats.join(', ')}${c.defaultFormat ? ' (text on a terminal, md when piped)' : ''}`)}`);
  return lines.join('\n');
}

function cliSpec() {
  const flag = (f: Flag) => ({ name: f.name, short: f.short ?? null, type: f.type, multiple: !!f.multiple, value: f.value ?? null, choices: f.choices ?? null, description: f.description });
  return {
    name: 'oodle',
    version: VERSION,
    docs: DOCS,
    usage: 'oodle <command> [args] [flags]',
    commands: COMMANDS.map((c) => ({
      name: c.name,
      summary: c.summary,
      description: c.description,
      arguments: c.args.map((a) => ({ name: a.name, required: !!a.required, description: a.description })),
      flags: c.flags.map(flag),
      formats: c.formats,
      examples: c.examples.map(([command, description]) => ({ command, description })),
    })),
    global_flags: GLOBAL_FLAGS.map(flag),
    exit_codes: EXIT_DOCS.map(([code, description]) => ({ code, description })),
    environment: ENV.map(([name, description]) => ({ name, description })),
  };
}

// ── Output helpers ──────────────────────────────────────────────────────────

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function heading(title: string, dir: string): void {
  if (settings.quiet) return;
  note(`${e.bold(e.cyan(`oodle ${title}`))} ${e.dim(display(dir))}\n`);
  if (configFile(dir)?.legacy) {
    note(`${e.yellow(sym.warn)} This project uses the old layout (oodle.yaml). Move it into ${FOLDER}/ with ${e.cyan(runnable(`oodle init --migrate${display(dir) === '.' ? '' : ` ${display(dir)}`}`))}\n`);
  }
}

// ── Interrupts ──────────────────────────────────────────────────────────────

const cleanups = new Set<() => void>();
let interrupted = false;
function onSignal(signal: NodeJS.Signals) {
  clearSpinner();
  if (interrupted) {
    process.stderr.write(`\n${e.red('Forced exit.')} Run \`git worktree prune\` if a temporary worktree is left behind in .git/oodle.\n`);
    process.exit(EXIT.interrupted);
  }
  interrupted = true;
  if (cleanups.size) process.stderr.write(`\n${e.yellow(sym.warn)} Interrupted. Cleaning up ${e.dim('(Ctrl-C again to force)')}\n`);
  else process.stderr.write('\n');
  for (const c of cleanups) {
    try { c(); } catch { /* best effort on the way out */ }
  }
  process.exit(signal === 'SIGTERM' ? 143 : EXIT.interrupted);
}
process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);

// ── Commands ────────────────────────────────────────────────────────────────

async function runWithProgress(dir: string, label: string, only?: string[]): Promise<RunResult> {
  const spin = spinner(`${label} ${e.dim(display(dir))}`);
  try {
    return await runProject(dir, {
      only,
      onProgress: (what, done, total) => spin.update(`${label} ${e.dim(`${done + 1}/${total}`)} ${what}`),
    });
  } finally {
    spin.stop();
  }
}

/** An observation that blocks: an approved outcome not holding, or a constraint violated anywhere. */
export const blocks = (x: RunResult['observations'][number]) => x.violations.length > 0 || (x.kind === 'outcome' && !x.proposed && x.failures.length > 0);

function runSummaryJson(run: RunResult, elapsed: number) {
  const outcomes = new Set(run.observations.filter((x) => x.kind === 'outcome' && !x.proposed).map((x) => x.id));
  const broken = new Set(run.observations.filter((x) => x.kind === 'outcome' && !x.proposed && (x.failures.length || x.violations.length)).map((x) => x.id));
  const proposed = new Set(run.observations.filter((x) => x.proposed).map((x) => x.id));
  const behaviors = new Set(run.observations.filter((x) => x.kind === 'behavior').map((x) => x.id));
  const drifted = new Set(run.observations.filter((x) => x.kind === 'behavior' && x.failures.length).map((x) => x.id));
  return {
    outcomes: outcomes.size,
    held: outcomes.size - broken.size,
    broken: broken.size,
    proposed: proposed.size,
    behaviors: behaviors.size,
    drifted: drifted.size,
    unknown_routes: run.gaps.length,
    constraint_violations: run.observations.reduce((n, x) => n + x.violations.length, 0) + run.gaps.reduce((n, g) => n + g.violations.length, 0),
    proposed_constraint_notices: run.observations.reduce((n, x) => n + x.notices.length, 0) + run.gaps.reduce((n, g) => n + g.notices.length, 0),
    lint_errors: run.lint.errors.length,
    lint_warnings: run.lint.warnings.length,
    runs: run.observations.length,
    elapsed_ms: Math.round(elapsed),
  };
}

async function cmdRun(ctx: Ctx): Promise<number> {
  if (ctx.flags.watch) return watchLoop(ctx);
  const dir = findProject(ctx.args[0], 'run');
  const t0 = performance.now();
  if (ctx.format === 'text') heading('run', dir);
  const run = await runWithProgress(dir, 'Running', ctx.flags.only);
  const elapsed = performance.now() - t0;
  const failing =
    run.observations.some(blocks) ||
    run.gaps.some((g) => g.violations.length) ||
    run.lint.errors.length > 0;
  const drifting = run.observations.some((x) => x.kind === 'behavior' && x.failures.length);
  annotateRun(run);

  if (ctx.format === 'json') {
    printJson({ ok: !failing, oodle: VERSION, project: dir, summary: runSummaryJson(run, elapsed), observations: run.observations, gaps: run.gaps, lint: run.lint });
    return failing ? EXIT.blocking : EXIT.ok;
  }

  console.log(renderRun(run, { verbose: ctx.flags.verbose, elapsed, only: ctx.flags.only }));
  const summary = runSummaryJson(run, elapsed);
  const notHolding = [...new Set(run.observations.filter(blocks).map((x) => x.id))];
  reportToWatcher({
    ok: !failing,
    headline: failing
      ? summary.broken ? `${summary.broken} of ${plural(summary.outcomes, 'outcome')} not holding` : 'blocking problems'
      : `${summary.outcomes === 1 ? 'the outcome holds' : `all ${summary.outcomes} outcomes hold`}`,
    facts: [summary.drifted && `${summary.drifted} drifted`, summary.unknown_routes && plural(summary.unknown_routes, 'unknown route'), summary.lint_errors && plural(summary.lint_errors, 'lint error')].filter(Boolean),
    failing: notHolding,
    elapsed_ms: summary.elapsed_ms,
  });
  if (failing) await say('worried', 'Something declared is not holding.');
  else if (run.gaps.length) await say('curious', `Every outcome holds. ${run.gaps.length} route(s) nobody has described yet.`);
  else if (drifting) await say('curious', 'Every outcome holds. Some behavior drifted; have a look.');
  else await say('happy', 'Every outcome holds.');

  const next: string[] = [];
  const first = run.observations.find((x) => x.kind === 'outcome' && blocks(x));
  if (first && !ctx.flags.only) next.push(`Focus on one: ${e.cyan(`oodle run --only ${first.id}`)}`);
  if (run.lint.errors.length) next.push(`Catalog details: ${e.cyan('oodle lint')}`);
  if (run.gaps.length && !ctx.flags.verbose) next.push(`See proposed catalog entries for unknown routes: ${e.cyan('oodle run --verbose')}`);
  if (!failing && inGitRepo(dir)) next.push(`Compare with your default branch: ${e.cyan('oodle check')}`);
  if (!process.env.OODLE_WATCH_REPORT) hints(next);
  return failing ? EXIT.blocking : EXIT.ok;
}

function numberFlag(ctx: Ctx, name: string, min: number, max = Infinity): number | undefined {
  const raw = ctx.flags[name];
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) throw usageError(`--${name} must be a number from ${min}${max === Infinity ? ' up' : ` to ${max}`}, not "${raw}"`);
  return n;
}

async function cmdMutate(ctx: Ctx): Promise<number> {
  const dir = findProject(ctx.args[0], 'mutate');
  const max = numberFlag(ctx, 'max', 1);
  const jobs = numberFlag(ctx, 'jobs', 1);
  const minScore = numberFlag(ctx, 'min-score', 0, 100);
  if (ctx.format === 'text') heading('mutate', dir);
  const spin = spinner('Planting bugs');
  let report: MutateReport;
  try {
    report = await mutate(dir, {
      files: ctx.flags.files,
      only: ctx.flags.only,
      max,
      jobs,
      tests: ctx.flags.tests,
      onProgress: (done, total) => spin.update(`Running mutants ${e.dim(`${done}/${total}`)}`),
      track: (cleanup) => (cleanups.add(cleanup), () => cleanups.delete(cleanup)),
    });
  } finally {
    spin.stop();
  }
  const pct = Math.round(report.score * 100);
  const below = minScore !== undefined && pct < minScore;
  if (ctx.format === 'json') {
    printJson({ ok: !below, oodle: VERSION, ...report, score: pct, ...(minScore !== undefined ? { min_score: minScore } : {}) });
    return below ? EXIT.blocking : EXIT.ok;
  }
  console.log(renderMutate(report, { verbose: ctx.flags.verbose, minScore }));
  if (below) await say('worried', `Only ${pct}% of planted bugs were caught.`);
  else if (report.summary.survived) await say('curious', `${report.summary.survived} planted bug(s) went unnoticed. Worth a look.`);
  else await say('happy', 'Every planted bug was caught.');
  const next: string[] = [];
  const first = report.mutants.find((m) => m.status === 'survived');
  if (first) next.push(`Tighten the outcome that runs through ${e.cyan(`${first.file}:${first.line}`)}, or add a condition that reaches it`);
  if (report.redundant.length) next.push(`Outcomes that catch nothing extra may be merged or dropped: ${report.redundant.slice(0, 3).join(', ')}`);
  if (!ctx.flags.tests) next.push(`Find redundant unit tests: ${e.cyan('oodle mutate --tests "npm test"')}`);
  hints(next);
  return below ? EXIT.blocking : EXIT.ok;
}

function readInput(path: string, what: string): string {
  if (path === '-') return readFileSync(0, 'utf8');
  if (!existsSync(path)) throw usageError(`${what} ${path} does not exist`, `Pass a file, or - to read stdin.`);
  return readFileSync(path, 'utf8');
}

async function cmdPropose(ctx: Ctx): Promise<number> {
  const dir = findProject(ctx.args[1], 'propose');
  const result = propose(dir, readInput(ctx.args[0], 'Proposal'));
  if (ctx.format === 'json') return printJson({ ok: true, ...result }), EXIT.ok;
  heading('propose', dir);
  for (const a of result.added) console.log(`  ${o.green('+')} ${a.section.slice(0, -1).padEnd(10)} ${a.id}`);
  console.log(`\n${o.green(o.bold(`${sym.ok} Proposed`))}  ${o.dim(`${plural(result.added.length, 'entry', 'entries')} in ${result.file} · reported, not blocking`)}`);
  await say('curious', 'Proposals noted. A human gets the final say.');
  hints([`See how they do: ${e.cyan('oodle run')}`, `Approve one by deleting its ${e.cyan('status: proposed')} line in ${result.file}`]);
  return EXIT.ok;
}

async function cmdDraft(ctx: Ctx): Promise<number> {
  const dir = findProject(ctx.args[1], 'draft');
  process.stdout.write(draftPrompt(dir, readInput(ctx.args[0], 'Brief')));
  return EXIT.ok;
}

async function cmdMcp(ctx: Ctx): Promise<number> {
  const dir = findProject(ctx.args[0], 'mcp');
  settings.quiet = true;
  await serveMcp(dir, VERSION);
  return EXIT.ok;
}

async function cmdLint(ctx: Ctx): Promise<number> {
  if (ctx.flags.watch) return watchLoop(ctx);
  const dir = findProject(ctx.args[0], 'lint');
  const config = loadConfig(dir);
  const catalog = loadCatalog(dir, config);
  const result = lint(catalog, config);
  annotateLint(dir, result);
  if (ctx.format === 'json') {
    printJson({ ok: !result.errors.length, ...result });
    return result.errors.length ? EXIT.blocking : EXIT.ok;
  }
  heading('lint', dir);
  console.log(renderLint(result, catalog));
  reportToWatcher({
    ok: !result.errors.length,
    headline: result.errors.length ? plural(result.errors.length, 'lint error') : 'catalog is valid',
    facts: [result.warnings.length && plural(result.warnings.length, 'warning')].filter(Boolean),
    failing: [],
  });
  if (result.errors.length) await say('worried', `${result.errors.length} catalog error(s) to fix first.`);
  else await say('happy', 'Catalog looks tidy!');
  if (!result.errors.length && !process.env.OODLE_WATCH_REPORT) hints([`Run every outcome: ${e.cyan('oodle run')}`]);
  return result.errors.length ? EXIT.blocking : EXIT.ok;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function inGitRepo(dir: string): boolean {
  try { return git(dir, 'rev-parse', '--is-inside-work-tree') === 'true'; } catch { return false; }
}

function defaultBaseRef(dir: string): string {
  for (const candidate of ['origin/HEAD', 'main', 'master']) {
    try {
      git(dir, 'rev-parse', '--verify', '--quiet', `${candidate}^{commit}`);
      return candidate === 'origin/HEAD' ? git(dir, 'rev-parse', '--abbrev-ref', 'origin/HEAD') : candidate;
    } catch { /* try the next one */ }
  }
  throw usageError('Could not work out which ref to compare against', 'Pass one: `oodle check --base-ref <branch|tag|sha>`.');
}

function checkoutBase(projectDir: string, ref: string): { dir: string | null; sha: string; cleanup: () => void } {
  let root: string;
  try {
    root = git(projectDir, 'rev-parse', '--show-toplevel');
  } catch {
    throw usageError(`${display(projectDir)} is not inside a git repository`, 'Use `oodle diff <base> <head>` to compare two directories.');
  }
  let sha: string;
  try {
    sha = git(root, 'rev-parse', '--short', '--verify', `${ref}^{commit}`);
  } catch {
    throw usageError(`Unknown git ref "${ref}"`, 'Check the name with `git branch -a` or `git log --oneline`.');
  }
  // Worktrees live inside .git, so nothing appears in the repository and nothing needs ignoring.
  const tmpRoot = join(resolve(root, git(root, 'rev-parse', '--git-common-dir')), 'oodle', 'worktrees');
  const tree = join(tmpRoot, `base-${sha}`);
  mkdirSync(tmpRoot, { recursive: true });
  const remove = () => {
    try { git(root, 'worktree', 'remove', '--force', tree); } catch { rmSync(tree, { recursive: true, force: true }); }
  };
  if (existsSync(tree)) remove();
  git(root, 'worktree', 'add', '--detach', tree, sha);
  // Reuse installed dependencies so the base app can import what the head app imports.
  const modules = join(root, 'node_modules');
  if (existsSync(modules) && !existsSync(join(tree, 'node_modules'))) symlinkSync(modules, join(tree, 'node_modules'), 'dir');
  const dir = join(tree, relative(root, realpathSync(projectDir)));
  // Oodle arrives in this very change: the base promised nothing yet, so every outcome is new.
  if (!isProject(dir)) return { dir: null, sha, cleanup: remove };
  return { dir, sha, cleanup: remove };
}

/** The run of a base that has no Oodle project: nothing declared, nothing observed. */
function emptyRun(head: string): RunResult {
  return {
    projectDir: head,
    config: { app: '', catalog: FOLDER },
    catalog: { intents: [], outcomes: [], behaviors: [], conditions: [], constraints: [], sources: {} },
    lint: { errors: [], warnings: [] },
    routes: [],
    observations: [],
    gaps: [],
  };
}

async function diffAndReport(ctx: Ctx, baseDir: string | null, headDir: string, labels: { base: string; head: string }, t0: number): Promise<number> {
  const side = async (dir: string, which: 'base' | 'head', label: string) => {
    try {
      return await runWithProgress(dir, `Running ${which} ${e.dim(label)}`);
    } catch (error) {
      // Say which side failed: a broken base needs a different fix from a broken head.
      const known = asOodleError(error);
      if (known) known.message = `${known.message} (in the ${which}: ${label})`;
      throw known ?? error;
    }
  };
  const base = baseDir ? await side(baseDir, 'base', labels.base) : emptyRun(headDir);
  const head = await side(headDir, 'head', labels.head);
  const report = diffRuns(base, head, approvalsFrom(ctx));
  const md = diffMarkdown(report);
  if (typeof ctx.flags.md === 'string') writeFileSync(ctx.flags.md, md);
  annotateDiff(report, headDir, md);

  if (ctx.format === 'json') printJson({ ok: !report.blocking, oodle: VERSION, base: labels.base, head: labels.head, ...report });
  else if (ctx.format === 'md') console.log(md);
  else {
    console.log(renderDiff(report, { verbose: ctx.flags.verbose, base: labels.base, head: labels.head, elapsed: performance.now() - t0 }));
    if (report.blocking) await say('worried', `${report.blocking} blocking. A human needs to look.`);
    else if (report.gaps.length) await say('curious', 'Nothing blocking. Some routes are new to me.');
    else await say('happy', 'Nothing blocking. Every outcome intact.');
    const next: string[] = [];
    if (typeof ctx.flags.md === 'string') next.push(`PR comment written to ${e.cyan(ctx.flags.md)}`);
    else next.push(`Write a PR comment: ${e.cyan(`oodle ${withoutFormat(process.argv.slice(2)).join(' ')} --md diff.md`)}`);
    if (report.gaps.length) next.push(`See a proposed catalog entry for each unknown route: ${e.cyan(`oodle run ${display(headDir)} --verbose`)}`);
    const tokens = approvalTokens(report);
    if (tokens.length) next.push(`Intended? A human approves with: ${e.cyan(`--approve ${tokens.join(' --approve ')}`)}`);
    if (report.blocking > tokens.length) next.push('A broken outcome or a violated constraint is never approvable: fix the code, or redefine the outcome and get that approved.');
    hints(next);
  }
  return report.blocking ? EXIT.blocking : EXIT.ok;
}

/** Approvals from --approve tokens and an --approvals file. */
function approvalsFrom(ctx: Ctx): Approval[] {
  const out: Approval[] = [];
  for (const token of ctx.flags.approve ?? []) {
    const a = parseApproval(token);
    if (!a) throw usageError(`--approve expects id@fingerprint, not "${token}"`, 'Copy the token from the outcome diff, e.g. --approve checkout.payment-confirmed@1a2b3c4d.');
    out.push(a);
  }
  const file: string | undefined = ctx.flags.approvals;
  if (file) {
    let list: unknown;
    try {
      list = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      throw usageError(`Could not read approvals from ${file}: ${(err as Error).message}`, 'Pass a JSON array of { "id", "fingerprint", "by" }.');
    }
    if (!Array.isArray(list)) throw usageError(`${file} must hold a JSON array of approvals`, 'Pass a JSON array of { "id", "fingerprint", "by" }.');
    for (const item of list) {
      const a = parseApproval(`${item?.id}@${item?.fingerprint}`, typeof item?.by === 'string' ? item.by : undefined);
      if (!a) throw usageError(`${file} has an approval without a valid id and fingerprint: ${JSON.stringify(item)}`, 'Each entry needs "id" and an 8-character hex "fingerprint".');
      out.push(a);
    }
  }
  return out;
}

/** The user's own command line, minus output-format flags, for suggesting a variant of it. */
function withoutFormat(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json' || argv[i].startsWith('--format=')) continue;
    if (argv[i] === '--format') { i++; continue; }
    out.push(/[\s*?"'$]/.test(argv[i]) ? `"${argv[i]}"` : argv[i]);
  }
  return out;
}

async function cmdCheck(ctx: Ctx): Promise<number> {
  const t0 = performance.now();
  const headDir = findProject(ctx.args[0], 'check');
  const ref: string = ctx.flags['base-ref']?.trim() || defaultBaseRef(headDir);
  if (ctx.format === 'text') heading('check', headDir);
  const spin = spinner(`Checking out ${ref}`);
  let base: ReturnType<typeof checkoutBase>;
  try {
    base = checkoutBase(headDir, ref);
  } finally {
    spin.stop();
  }
  cleanups.add(base.cleanup);
  try {
    return await diffAndReport(ctx, base.dir, headDir, { base: `${ref} (${base.sha}${base.dir ? '' : ', before Oodle'})`, head: 'working tree' }, t0);
  } finally {
    base.cleanup();
    cleanups.delete(base.cleanup);
  }
}

async function cmdDiff(ctx: Ctx): Promise<number> {
  const t0 = performance.now();
  const baseDir = findProject(ctx.args[0]);
  const headDir = findProject(ctx.args[1]);
  if (ctx.format === 'text') heading('diff', headDir);
  return diffAndReport(ctx, baseDir, headDir, { base: display(baseDir), head: display(headDir) }, t0);
}

async function cmdInit(ctx: Ctx): Promise<number> {
  if (ctx.flags.migrate) {
    const result = migrate(ctx.args[0] ?? '.');
    if (ctx.format === 'json') return printJson({ ok: true, ...result }), EXIT.ok;
    heading('init --migrate', result.dir);
    for (const [from, to] of result.moved ?? []) console.log(`  ${o.cyan(sym.arrow)} ${from} ${o.dim(sym.arrow)} ${to}`);
    console.log(`\n${o.green(o.bold(`${sym.ok} Moved into ${FOLDER}/`))}  ${o.dim('git history follows each file')}`);
    hints([`Check nothing changed: ${e.cyan(`oodle run${display(result.dir) === '.' ? '' : ` ${display(result.dir)}`}`)}`, 'Commit the move on its own, so the history stays easy to read.']);
    return EXIT.ok;
  }
  const result = init(ctx.args[0] ?? '.', { app: ctx.flags.app, force: ctx.flags.force, ci: ctx.flags.ci });
  if (ctx.format === 'json') return printJson({ ok: true, ...result }), EXIT.ok;
  heading('init', result.dir);
  for (const f of result.created) console.log(`  ${o.green('+')} ${f}`);
  for (const f of result.kept) console.log(`  ${o.dim(`${sym.dot} ${f} (kept)`)}`);
  const where = display(result.dir) === '.' ? '' : ` ${display(result.dir)}`;
  const svc = result.service;
  if (svc) {
    const app = loadConfig(result.dir).app;
    const what = svc.framework === 'next' ? `Next.js route handlers in ${svc.entry}/` : `${svc.framework} app in ${svc.entry}`;
    console.log(`\n${o.green(o.bold(`${sym.ok} Wrapped your service`))}  ${o.dim(`${what}, run through ${app}`)}`);
    await say('curious', 'Found your service. Show me what it promises.');
    hints([
      ...(svc.listensOnImport ? [`${svc.entry} calls listen() on import. Guard it, e.g. ${e.cyan('if (import.meta.main) app.listen(port)')}`] : []),
      ...(svc.exportName ? [] : [`Export the app from ${svc.entry}, then fix the import in ${app}`]),
      ...(existsSync(join(result.dir, 'node_modules', '@oodlc', 'oodle')) ? [] : [`Install Oodle so ${app} can import it: ${e.cyan(installOodle(packageManager(result.dir)))}`]),
      ...(svc.framework === 'next' && !['.env.test', '.env'].some((f) => existsSync(join(result.dir, f))) ? [`Commit a ${e.cyan('.env.test')} with placeholder values your modules need to load. Oodle never reads .env.local`] : []),
      `Name outbound calls under effects in ${e.cyan(app)}, and stub each one in ${e.cyan('oodlc/config.yaml')}`,
      `Declare what customers must experience in ${e.cyan(join(display(result.dir), 'oodlc/outcomes.yaml'))}`,
      `Then check the wiring: ${e.cyan(`oodle doctor${where}`)}`,
    ]);
    return EXIT.ok;
  }
  console.log(`\n${o.green(o.bold(`${sym.ok} Project ready`))}  ${o.dim(display(result.dir))}`);
  await say('happy', 'A fresh catalog! Tell me what matters.');
  hints([
    `Run it: ${e.cyan(`oodle run${where}`)}`,
    `Declare what customers must experience in ${e.cyan(join(display(result.dir), 'oodlc/outcomes.yaml'))}`,
    // Completion only helps a shell that can find `oodle` itself.
    ...(oodleCommand() === 'oodle' ? [`Shell completion: ${e.cyan('oodle completion --help')}`] : []),
  ]);
  return EXIT.ok;
}

async function cmdDoctor(ctx: Ctx): Promise<number> {
  if (ctx.format === 'text') heading('doctor', ctx.args[0] ? resolve(ctx.args[0]) : process.cwd());
  const spin = spinner('Checking');
  const checks = await doctor(ctx.args[0]).finally(() => spin.stop());
  const failed = checks.some((c) => c.status === 'fail');
  if (ctx.format === 'json') return printJson({ ok: !failed, checks }), failed ? EXIT.blocking : EXIT.ok;
  const width = Math.max(...checks.map((c) => c.name.length)) + 2;
  for (const c of checks) {
    const mark = c.status === 'ok' ? o.green(sym.ok) : c.status === 'warn' ? o.yellow(sym.warn) : o.red(sym.fail);
    console.log(`  ${mark} ${c.name.padEnd(width)}${c.status === 'ok' ? o.dim(c.detail) : c.detail}`);
    if (c.hint && c.status !== 'ok') console.log(`    ${' '.repeat(width)}${o.dim(`${sym.arrow} ${runnable(c.hint)}`)}`);
  }
  const warns = checks.filter((c) => c.status === 'warn').length;
  console.log(`\n${failed ? o.red(o.bold(`${sym.fail} Not ready`)) : o.green(o.bold(`${sym.ok} Ready`))}${warns ? `  ${o.yellow(`${warns} to look at`)}` : ''}`);
  return failed ? EXIT.blocking : EXIT.ok;
}

async function cmdCompletion(ctx: Ctx): Promise<number> {
  const shell = ctx.args[0] as Shell;
  if (!SHELLS.includes(shell)) {
    const guess = shell ? suggest(shell, [...SHELLS]) : undefined;
    throw usageError(shell ? `Unsupported shell "${shell}"` : 'Which shell?', guess ? `Did you mean \`oodle completion ${guess}\`?` : `Choose one of: ${SHELLS.join(', ')}.`);
  }
  const specs = COMMANDS.map((c) => ({ name: c.name, summary: c.summary, positional: c.positional ?? (c.name === 'help' ? COMMANDS.map((x) => x.name) : 'dirs'), flags: [...c.flags, ...globalsFor(c)].map((f) => ({ ...f, choices: f.name === 'format' ? c.formats : f.choices })) }));
  process.stdout.write(completion(shell, specs));
  return EXIT.ok;
}

interface WatchReport {
  ok: boolean;
  headline: string;
  facts: (string | number | false)[];
  failing: string[];
  elapsed_ms?: number;
}

/** In a watch child, tells the watcher how the run went, so it can describe changes in status. */
function reportToWatcher(report: WatchReport): void {
  if (process.env.OODLE_WATCH_REPORT) writeFileSync(process.env.OODLE_WATCH_REPORT, JSON.stringify(report));
}

/**
 * Re-runs the command in a child process on every change, so the app is always
 * freshly imported. Says what changed, whether the status moved, and keeps a short
 * history, like a test runner's watch mode. r re-runs, q quits.
 */
async function watchLoop(ctx: Ctx): Promise<number> {
  const dir = findProject(ctx.args[0], process.argv[2]);
  const argv = process.argv.slice(2).filter((a) => a !== '--watch' && a !== '-w');
  const reportFile = join(mkdtempSync(join(tmpdir(), 'oodle-watch-')), 'report.json');
  const history: boolean[] = [];
  let previous: WatchReport | undefined;
  let child: ChildProcess | undefined;
  let timer: NodeJS.Timeout | undefined;
  let changed = new Set<string>();
  let run = 0;
  const tty = !!process.stdout.isTTY;
  const keys = !!process.stdin.isTTY;
  const time = () => new Date().toLocaleTimeString();
  const badge = (ok: boolean) => (ok ? e.inverse(e.green(e.bold(' PASS '))) : e.inverse(e.red(e.bold(' FAIL '))));

  const start = (reason: string) => {
    child?.kill();
    run++;
    if (tty) process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
    process.stderr.write(`${e.inverse(e.cyan(e.bold(run === 1 ? ' WATCH ' : ' RERUN ')))} ${reason} ${e.dim(`${sym.dot} run #${run} ${sym.dot} ${time()}`)}\n\n`);
    rmSync(reportFile, { force: true });
    const t0 = performance.now();
    const me = spawn(process.execPath, [...process.execArgv, process.argv[1], ...argv], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...process.env, OODLE_STILL: '1', OODLE_WATCH_REPORT: reportFile, ...(e.enabled ? { FORCE_COLOR: '1' } : {}) },
    });
    child = me;
    me.on('exit', (code, signal) => {
      if (signal || child !== me) return;
      let report: WatchReport;
      try {
        report = JSON.parse(readFileSync(reportFile, 'utf8'));
      } catch {
        report = { ok: false, headline: code === 2 ? 'could not run' : 'failed', facts: [], failing: [] };
      }
      const ms_ = report.elapsed_ms ?? Math.round(performance.now() - t0);
      let transition = '';
      if (previous && previous.ok !== report.ok) {
        transition = report.ok ? e.green(e.bold(`${sym.arrow} fixed, was failing`)) : e.red(e.bold(`${sym.arrow} now failing, was passing`));
      } else if (previous && !report.ok) {
        const fresh = report.failing.filter((id) => !previous!.failing.includes(id));
        const fixed = previous.failing.filter((id) => !report.failing.includes(id));
        transition = [fresh.length && e.red(`newly failing: ${fresh.join(', ')}`), fixed.length && e.green(`fixed: ${fixed.join(', ')}`)].filter(Boolean).join('  ') || e.dim('still failing');
      } else if (previous) transition = e.dim('still passing');
      history.push(report.ok);
      previous = report;

      const rule = e.dim('─'.repeat(Math.min(columns(process.stderr), 72)));
      const facts = report.facts.filter(Boolean).join(` ${sym.dot} `);
      const trail = history.slice(-12).map((ok) => (ok ? e.green(sym.ok) : e.red(sym.fail))).join(' ');
      const lines = [
        '',
        rule,
        `${badge(report.ok)} ${e.bold(report.headline)}${facts ? e.dim(` ${sym.dot} ${facts}`) : ''}  ${transition}`,
        e.dim(`run #${run} ${sym.dot} ${time()} ${sym.dot} ${ms(ms_)}`) + (history.length > 1 ? `   ${e.dim('history')} ${trail}` : ''),
        e.dim(`watching ${display(dir)} for changes ${sym.dot} ${keys ? 'r re-run · q quit' : 'Ctrl-C to stop'}`),
      ];
      process.stderr.write(`${lines.join('\n')}\n`);
      // A bell when the status flips, so a watcher in another pane gets noticed.
      if (history.length > 1 && history[history.length - 2] !== report.ok && tty) process.stderr.write('\x07');
    });
  };

  const ignored = /(^|\/)(node_modules|\.git|\.oodle-tmp)(\/|$)/;
  watch(dir, { recursive: true }, (_event, file) => {
    if (file && ignored.test(String(file))) return;
    // Editors and sed write temp files (.swp, ~, .!123!name) next to the real one; name only real files.
    if (file && !/(^|\/)\.|~$|\.sw[px]$|^\d+$/.test(String(file)) && existsSync(join(dir, String(file)))) changed.add(String(file));
    clearTimeout(timer);
    timer = setTimeout(() => {
      const files = [...changed];
      changed = new Set();
      start(files.length ? `${e.bold(files.slice(0, 3).join(', '))}${files.length > 3 ? e.dim(` +${files.length - 3} more`) : ''} changed` : 'a file changed');
    }, 120);
  });

  if (keys) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', (buf) => {
      const k = buf.toString();
      if (k === '\x03') onSignal('SIGINT');
      else if (k === 'q') {
        for (const c of cleanups) { try { c(); } catch { /* leaving anyway */ } }
        process.stderr.write('\n');
        process.exit(EXIT.ok);
      }
      else if (k === 'r' || k === '\r') start('re-run requested');
    });
    cleanups.add(() => process.stdin.isTTY && process.stdin.setRawMode(false));
  }
  cleanups.add(() => child?.kill());
  cleanups.add(() => rmSync(dirname(reportFile), { recursive: true, force: true }));
  start(`${e.bold(`oodle ${argv.join(' ')}`)}`);
  return new Promise(() => {});
}

// ── Main ────────────────────────────────────────────────────────────────────

function parse(cmd: Command, argv: string[]) {
  const flags = [...cmd.flags, ...GLOBAL_FLAGS];
  const options = Object.fromEntries(flags.map((f) => [f.name, { type: f.type, ...(f.multiple ? { multiple: true } : {}), ...(f.short ? { short: f.short } : {}) }]));
  try {
    return parseArgs({ args: argv, options: options as any, allowPositionals: true, strict: true });
  } catch (error) {
    const msg = (error as Error).message;
    const m = /'(-{1,2}[^' ]+)/.exec(msg);
    const bad = m?.[1] ?? '';
    if ((error as any).code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
      const names = flags.flatMap((f) => [`--${f.name}`, ...(f.short ? [`-${f.short}`] : [])]);
      const guess = suggest(bad, names);
      throw usageError(`Unknown flag ${bad} for \`oodle ${cmd.name}\``, guess ? `Did you mean ${guess}?` : `See \`oodle ${cmd.name} --help\` for its flags.`);
    }
    if ((error as any).code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') {
      const flag = flags.find((f) => msg.includes(`--${f.name}`));
      throw usageError(flag?.type === 'string' ? `--${flag.name} needs a value` : msg, flag ? `Usage: ${flagLabel(flag).trim()}  ${flag.description}` : undefined);
    }
    if (String((error as any).code).startsWith('ERR_PARSE_ARGS')) throw usageError(msg, `See \`oodle ${cmd.name} --help\`.`);
    throw error;
  }
}

function resolveFormat(cmd: Command, flags: Record<string, any>): Format {
  if (flags.json && flags.format && flags.format !== 'json') throw usageError('--json and --format disagree', 'Pick one.');
  const asked = flags.json ? 'json' : (flags.format as string | undefined);
  if (asked) {
    if (!cmd.formats.includes(asked as Format)) {
      throw usageError(`\`oodle ${cmd.name}\` cannot print ${asked}`, `Formats for this command: ${cmd.formats.join(', ')}.`);
    }
    return asked as Format;
  }
  const fromEnv = process.env.OODLE_FORMAT as Format | undefined;
  if (fromEnv && cmd.formats.includes(fromEnv)) return fromEnv;
  return cmd.defaultFormat?.() ?? 'text';
}

let jsonMode = false;

async function main(argv: string[]): Promise<number> {
  if (process.env.OODLE_QUIET) settings.quiet = true;
  if (process.env.OODLE_DEBUG) settings.debug = true;
  // Honour colour and json flags even when the command line is otherwise wrong.
  if (argv.includes('--no-color')) settings.color = 'never';
  jsonMode = argv.includes('--json') || argv.includes('--format=json');

  const [first, ...rest] = argv;
  if (first === undefined) {
    console.log(topHelp());
    return EXIT.ok;
  }
  if (first === '--version' || first === '-V') {
    if (jsonMode || rest.includes('--json')) printJson({ name: 'oodle', version: VERSION, node: process.versions.node, platform: `${process.platform}-${process.arch}` });
    else console.log(`oodle ${VERSION}`);
    return EXIT.ok;
  }
  if (first === '--help' || first === '-h') return commandNamed('help').run({ args: [], flags: {}, format: jsonMode ? 'json' : 'text' });
  if (first.startsWith('-')) {
    const guess = suggest(first, ['--help', '--version']);
    throw usageError(`Expected a command before ${first}`, guess ? `Did you mean \`oodle ${guess}\`?` : 'Usage: oodle <command> [flags]. Run `oodle help` for commands.');
  }

  const cmd = commandNamed(first);
  const { values, positionals } = parse(cmd, rest);
  const flags = values as Record<string, any>;
  if (flags.color) {
    if (!['auto', 'always', 'never'].includes(flags.color)) throw usageError(`--color must be auto, always or never, not "${flags.color}"`);
    settings.color = flags.color as ColorMode;
  }
  if (flags['no-color']) settings.color = 'never';
  if (flags.quiet) settings.quiet = true;
  if (flags.debug) settings.debug = true;
  if (flags.help) {
    console.log(cmd.name === 'help' ? topHelp() : commandHelp(cmd));
    return EXIT.ok;
  }

  const format = resolveFormat(cmd, flags);
  jsonMode = format === 'json';
  // In JSON mode stdout holds one document and stderr stays silent, for scripts and agents.
  if (jsonMode) settings.quiet = true;

  const required = cmd.args.filter((a) => a.required).length;
  if (positionals.length < required) {
    const missing = cmd.args.slice(positionals.length).filter((a) => a.required).map((a) => `<${a.name}>`).join(' ');
    throw usageError(`\`oodle ${cmd.name}\` needs ${missing}`, `Usage: oodle ${cmd.name} ${cmd.args.map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`)).join(' ')}. See \`oodle ${cmd.name} --help\`.`);
  }
  if (positionals.length > cmd.args.length) {
    const extra = positionals.slice(cmd.args.length);
    throw usageError(`Unexpected argument${extra.length > 1 ? 's' : ''}: ${extra.join(' ')}`, `\`oodle ${cmd.name}\` takes ${cmd.args.length ? cmd.args.map((a) => `[${a.name}]`).join(' ') : 'no arguments'}. Quote globs, e.g. --only "checkout.*".`);
  }
  return cmd.run({ args: positionals, flags, format });
}

function asOodleError(error: unknown): OodleError | null {
  if (error instanceof OodleError) return error;
  if (error instanceof CatalogError) {
    return new OodleError('catalog', `The catalog has ${error.problems.length === 1 ? 'a problem' : `${error.problems.length} problems`}`, {
      problems: error.problems,
      hint: 'Fix the files listed above, then run `oodle lint` to confirm.',
    });
  }
  return null;
}

async function fail(error: unknown): Promise<number> {
  clearSpinner();
  const known = asOodleError(error);
  if (jsonMode) {
    printJson({
      ok: false,
      error: known
        ? { code: known.code, message: known.message, hint: known.hint ? runnable(known.hint) : null, problems: known.problems }
        : { code: 'internal', message: (error as Error)?.message ?? String(error), hint: `Please report this: ${ISSUES}`, problems: [] },
    });
    return known?.exitCode ?? EXIT.usage;
  }
  if (known) {
    // Oodle reacts to real failures, not to "wrong directory" or a typo the hint already fixes.
    if (!['usage', 'no-project', 'no-match', 'exists'].includes(known.code)) await say('oops', 'I could not finish.');
    process.stderr.write(`\n${e.red(e.bold(`${sym.fail} ${known.message}`))}\n`);
    // Multi-line problems (YAML and compiler errors carry a code frame) stay inside the gutter.
    for (const p of known.problems) for (const l of p.split('\n').filter((x) => x.trim())) process.stderr.write(`  ${e.dim(sym.bar)} ${l}\n`);
    if (known.hint) process.stderr.write(`  ${e.dim(sym.arrow)} ${runnable(known.hint)}\n`);
    if (settings.debug) {
      const cause = (known as Error & { cause?: Error }).cause;
      process.stderr.write(`\n${e.dim(known.stack ?? '')}\n`);
      if (cause?.stack) process.stderr.write(`\n${e.dim(`Caused by: ${cause.stack}`)}\n`);
    }
    return known.exitCode;
  }
  // Not ours to explain: this is a bug, so make reporting it effortless.
  await say('oops', 'That was not supposed to happen.');
  const err = error as Error;
  const body = encodeURIComponent(`**Command**\n\`oodle ${process.argv.slice(2).join(' ')}\`\n\n**Error**\n\`\`\`\n${err?.stack ?? err}\n\`\`\`\n\noodle ${VERSION} · node ${process.versions.node} · ${process.platform}-${process.arch}`);
  const url = `${ISSUES}?title=${encodeURIComponent(`Crash: ${err?.message ?? err}`.slice(0, 120))}&body=${body}`;
  process.stderr.write(`\n${e.red(e.bold(`${sym.fail} Unexpected error: ${err?.message ?? err}`))}\n`);
  process.stderr.write(`  ${e.dim(sym.arrow)} This is a bug in Oodle. Report it: ${e.linkable() ? e.link('open a prefilled issue', url) : ISSUES}\n`);
  if (settings.debug) process.stderr.write(`\n${e.dim(err?.stack ?? String(err))}\n`);
  else process.stderr.write(`  ${e.dim(sym.arrow)} Run again with --debug for the stack trace.\n`);
  return EXIT.usage;
}

/** Exit only once stdout has drained: on a pipe, process.exit() can cut a large --json document short. */
const exit = (code: number) => process.stdout.write('', () => process.exit(code));

main(process.argv.slice(2)).then(exit, async (error) => exit(await fail(error)));
