import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { CatalogError, loadCatalog, loadConfig } from './catalog.ts';
import { lint } from './lint.ts';
import { runProject } from './runner.ts';
import { diffRuns } from './diff.ts';
import { diffMarkdown, runSummary } from './report.ts';
import { hello, say } from './oodle.ts';

const USAGE = `oodle: the OODLC (Open Outcome Delivery Lifecycle) CLI, v0

  oodle lint  [project]                     Validate the catalog and run traceability checks
  oodle run   [project]                     Run every outcome and behavior under every condition
  oodle diff  <base-project> <head-project> Outcome diff between two checkouts
  oodle check [project] --base-ref <ref>    Outcome diff of the working tree against a git ref
  oodle hello                               Meet Oodle

Options:
  --md <file>    Also write the diff as markdown (for PR comments)
  --json         Print machine-readable JSON instead of text

Exit code is 1 when anything is blocking: an outcome broken, removed, redefined
or changed, a constraint violated on any run, or catalog lint errors. Behavior
drift is reported, never blocking.
Set OODLE_QUIET=1 to hush Oodle, OODLE_STILL=1 to stop the animation.`;

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--') && ['md', 'base-ref'].includes(key)) {
        flags[key] = next;
        i++;
      } else flags[key] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function checkoutBase(projectDir: string, ref: string): Promise<{ dir: string; cleanup: () => void }> {
  const root = git(projectDir, 'rev-parse', '--show-toplevel');
  const sha = git(root, 'rev-parse', '--short', ref);
  const tmpRoot = join(root, '.oodle-tmp');
  const tree = join(tmpRoot, `base-${sha}`);
  mkdirSync(tmpRoot, { recursive: true });
  if (existsSync(tree)) {
    try { git(root, 'worktree', 'remove', '--force', tree); } catch { rmSync(tree, { recursive: true, force: true }); }
  }
  git(root, 'worktree', 'add', '--detach', tree, sha);
  // Reuse installed dependencies so the base app can import what the head app imports.
  const modules = join(root, 'node_modules');
  if (existsSync(modules) && !existsSync(join(tree, 'node_modules'))) symlinkSync(modules, join(tree, 'node_modules'), 'dir');
  const dir = join(tree, relative(root, realpathSync(projectDir)));
  return {
    dir,
    cleanup: () => {
      try { git(root, 'worktree', 'remove', '--force', tree); } catch { rmSync(tree, { recursive: true, force: true }); }
    },
  };
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);

  switch (cmd) {
    case 'lint': {
      const dir = resolve(positional[0] ?? '.');
      const result = lint(loadCatalog(dir, loadConfig(dir)));
      if (flags.json) console.log(JSON.stringify(result, null, 2));
      else {
        for (const e of result.errors) console.log(`error: ${e}`);
        for (const w of result.warnings) console.log(`warning: ${w}`);
        console.log(`${result.errors.length} errors, ${result.warnings.length} warnings`);
        if (result.errors.length) await say('worried', `${result.errors.length} catalog error(s) to fix first.`);
        else await say('happy', 'Catalog looks tidy!');
      }
      return result.errors.length ? 1 : 0;
    }
    case 'run': {
      const run = await runProject(resolve(positional[0] ?? '.'));
      if (flags.json) console.log(JSON.stringify({ observations: run.observations, gaps: run.gaps, lint: run.lint }, null, 2));
      const failing =
        run.observations.some((o) => o.violations.length || (o.kind === 'outcome' && o.failures.length)) ||
        run.gaps.some((g) => g.violations.length) ||
        run.lint.errors.length > 0;
      const drifting = run.observations.some((o) => o.kind === 'behavior' && o.failures.length);
      if (!flags.json) {
        console.log(runSummary(run));
        if (failing) await say('worried', 'Something declared is not holding.');
        else if (run.gaps.length) await say('curious', `Every outcome holds. ${run.gaps.length} route(s) nobody has described yet.`);
        else if (drifting) await say('curious', 'Every outcome holds. Some behavior drifted; have a look.');
        else await say('happy', 'Every outcome holds.');
      }
      return failing ? 1 : 0;
    }
    case 'diff':
    case 'check': {
      let baseDir: string;
      let headDir: string;
      let cleanup = () => {};
      if (cmd === 'diff') {
        if (positional.length < 2) throw new Error('oodle diff needs <base-project> <head-project>');
        baseDir = resolve(positional[0]);
        headDir = resolve(positional[1]);
      } else {
        if (typeof flags['base-ref'] !== 'string') throw new Error('oodle check needs --base-ref <ref>');
        headDir = resolve(positional[0] ?? '.');
        const base = await checkoutBase(headDir, flags['base-ref']);
        baseDir = base.dir;
        cleanup = base.cleanup;
      }
      try {
        const report = diffRuns(await runProject(baseDir), await runProject(headDir));
        const md = diffMarkdown(report);
        if (typeof flags.md === 'string') writeFileSync(flags.md, md);
        console.log(flags.json ? JSON.stringify(report, null, 2) : md);
        if (!flags.json) {
          if (report.blocking) await say('worried', `${report.blocking} blocking. A human needs to look.`);
          else if (report.gaps.length) await say('curious', 'Nothing blocking. Some routes are new to me.');
          else await say('happy', 'Nothing blocking. Every outcome intact.');
        }
        return report.blocking ? 1 : 0;
      } finally {
        cleanup();
      }
    }
    case 'hello':
      await hello();
      return 0;
    default:
      await say('hello', 'Hi! You declare outcomes, I watch behaviors.');
      console.log(USAGE);
      return cmd && !['help', '--help', '-h'].includes(cmd) ? 2 : 0;
  }
}

main().then(
  (code) => process.exit(code),
  async (err) => {
    await say('oops', 'I could not finish.');
    if (err instanceof CatalogError) console.error(err.problems.map((p) => `error: ${p}`).join('\n'));
    else console.error(`error: ${err.message}`);
    process.exit(2);
  },
);
