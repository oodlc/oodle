import { execFileSync } from 'node:child_process';
import { loadCatalog, loadConfig, CatalogError } from './catalog.ts';
import { lint } from './lint.ts';
import { runProject } from './runner.ts';
import { findProject, display } from './project.ts';
import { OodleError } from './errors.ts';
import { plural } from './term.ts';

export interface Check {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
  hint?: string;
}

const MIN_NODE = 20;

function problemText(err: unknown): { detail: string; hint?: string } {
  if (err instanceof CatalogError) return { detail: err.problems.join('; '), hint: 'Fix the catalog files listed, then run `oodle lint`.' };
  if (err instanceof OodleError) return { detail: [err.message, ...err.problems].join(': '), hint: err.hint };
  return { detail: (err as Error).message };
}

/** Environment and project checks, each with a fix. Stops at the first project check that fails, since later ones depend on it. */
export async function doctor(arg?: string): Promise<Check[]> {
  const checks: Check[] = [];
  const major = Number(process.versions.node.split('.')[0]);
  checks.push(major >= MIN_NODE
    ? { name: 'node', status: 'ok', detail: `Node ${process.versions.node}` }
    : { name: 'node', status: 'fail', detail: `Node ${process.versions.node} is too old`, hint: `Install Node ${MIN_NODE} or newer.` });

  let git = '';
  try {
    git = execFileSync('git', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    checks.push({ name: 'git', status: 'ok', detail: git });
  } catch {
    checks.push({ name: 'git', status: 'warn', detail: 'git not found', hint: '`oodle check` needs git to compare against a base ref.' });
  }

  let dir: string;
  try {
    dir = findProject(arg);
    checks.push({ name: 'project', status: 'ok', detail: display(dir) });
  } catch (err) {
    checks.push({ name: 'project', status: 'fail', ...problemText(err) });
    return checks;
  }

  if (git) {
    try {
      execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, stdio: 'ignore' });
      checks.push({ name: 'repository', status: 'ok', detail: 'inside a git work tree' });
    } catch {
      checks.push({ name: 'repository', status: 'warn', detail: 'not inside a git repository', hint: '`oodle check` compares against git refs. Use `oodle diff <base> <head>` otherwise.' });
    }
  }

  try {
    const config = loadConfig(dir);
    checks.push({ name: 'config', status: 'ok', detail: `oodle.yaml: app ${config.app}, catalog ${config.catalog}/` });
    const catalog = loadCatalog(dir, config);
    checks.push({ name: 'catalog', status: 'ok', detail: `${plural(catalog.outcomes.length, 'outcome')}, ${plural(catalog.behaviors.length, 'behavior')}, ${plural(catalog.intents.length, 'intent')}` });
    const result = lint(catalog);
    checks.push(result.errors.length
      ? { name: 'lint', status: 'fail', detail: plural(result.errors.length, 'error'), hint: 'Run `oodle lint` for details.' }
      : result.warnings.length
        ? { name: 'lint', status: 'warn', detail: plural(result.warnings.length, 'warning'), hint: 'Run `oodle lint` for details.' }
        : { name: 'lint', status: 'ok', detail: 'no findings' });
  } catch (err) {
    checks.push({ name: 'catalog', status: 'fail', ...problemText(err) });
    return checks;
  }

  try {
    const run = await runProject(dir);
    const threw = run.observations.filter((o) => o.error);
    const unstubbed = [...new Set(run.observations.flatMap((o) => o.effects.filter((e) => e.error?.startsWith('no stub')).map((e) => e.kind)))];
    if (unstubbed.length) {
      checks.push({ name: 'app', status: 'fail', detail: `external calls with no stub: ${unstubbed.join(', ')}`, hint: 'Add each one under defaults.given.stubs in oodle.yaml, or in a condition.' });
    } else if (threw.length) {
      checks.push({ name: 'app', status: 'fail', detail: `${plural(threw.length, 'run')} threw, e.g. ${threw[0].id}: ${threw[0].error}`, hint: 'Run `oodle run` to see each failure.' });
    } else {
      checks.push({ name: 'app', status: 'ok', detail: `loads, ${plural(run.routes.length, 'route')}, ${plural(run.observations.length, 'run')} completed` });
    }
  } catch (err) {
    checks.push({ name: 'app', status: 'fail', ...problemText(err) });
  }
  return checks;
}
