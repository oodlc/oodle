import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configFile, loadCatalog, loadConfig, CatalogError } from './catalog.ts';
import { jsonDiff } from './expect.ts';
import { STARTER_MARK, detectService } from './init.ts';
import { installOodle, packageManager } from './invocation.ts';
import { SEALED_ID } from './seal.ts';
import { declaredEffects } from './scan.ts';
import type { Observation } from './types.ts';
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
const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'oodle.js');

function problemText(err: unknown, dir = '.'): { detail: string; hint?: string } {
  if (err instanceof CatalogError) return { detail: err.problems.join('; '), hint: 'Fix the catalog files listed, then run `oodle lint`.' };
  if (err instanceof OodleError && err.problems.some((p) => /Cannot find (package|module) '@oodlc\/oodle'/.test(p))) {
    return { detail: `${err.message}: the @oodlc/oodle package isn't installed here`, hint: `Install it so the app can import @oodlc/oodle/adapter: \`${installOodle(packageManager(dir))}\`.` };
  }
  if (err instanceof OodleError) return { detail: [err.message, ...err.problems].join(': '), hint: err.hint };
  return { detail: (err as Error).message };
}

/** What someone outside the system sees, as in the outcome diff. */
const outside = (o: Pick<Observation, 'status' | 'body' | 'effects'>) => ({
  status: o.status,
  body: o.body,
  effects: o.effects.filter((e) => e.boundary !== 'internal').map(({ kind, payload, result, error }) => ({ kind, payload, result, error })),
});

/**
 * Runs the catalog a second time in a fresh process and compares what an outside caller sees.
 * Any difference comes from wall-clock time, randomness or state leaking between runs, and would
 * show up as a `changed` outcome on every pull request.
 */
function unstable(dir: string, first: Observation[]): string[] {
  const res = spawnSync(process.execPath, [BIN, 'run', dir, '--json'], { encoding: 'utf8', timeout: 300_000, env: { ...process.env, OODLE_QUIET: '1', GITHUB_ACTIONS: '' } });
  let second: Observation[] = [];
  try { second = JSON.parse(res.stdout).observations ?? []; } catch { return []; }
  const out: string[] = [];
  for (const a of first) {
    const b = second.find((x) => x.kind === a.kind && x.id === a.id && x.condition === a.condition);
    if (!b) continue;
    for (const d of jsonDiff(JSON.parse(JSON.stringify(outside(a))), outside(b))) out.push(`${a.id} [${a.condition}] ${d}`);
  }
  return out;
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
    dir = findProject(arg, 'doctor');
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
    const where = configFile(dir)!;
    checks.push(where.legacy
      ? { name: 'config', status: 'warn', detail: `oodle.yaml (old layout): app ${config.app}, catalog ${config.catalog}/`, hint: 'Move it into oodlc/ with `oodle init --migrate`.' }
      : { name: 'config', status: 'ok', detail: `oodlc/config.yaml: app ${config.app}` });
    const catalog = loadCatalog(dir, config);
    const approved = catalog.outcomes.filter((o) => o.status !== 'proposed').length;
    const counts = `${plural(catalog.outcomes.length, 'outcome')}, ${plural(catalog.behaviors.length, 'behavior')}, ${plural(catalog.intents.length, 'intent')}`;
    checks.push(approved
      ? { name: 'catalog', status: 'ok', detail: counts }
      : { name: 'catalog', status: 'warn', detail: `${counts}: no approved outcome, so nothing blocks a merge yet`, hint: 'Declare the promise that would hurt most to break in oodlc/, e.g. oodlc/outcomes.yaml.' });
    const result = lint(catalog, config);
    checks.push(result.errors.length
      ? { name: 'lint', status: 'fail', detail: plural(result.errors.length, 'error'), hint: 'Run `oodle lint` for details.' }
      : result.warnings.length
        ? { name: 'lint', status: 'warn', detail: plural(result.warnings.length, 'warning'), hint: 'Run `oodle lint` for details.' }
        : { name: 'lint', status: 'ok', detail: 'no findings' });
  } catch (err) {
    checks.push({ name: 'catalog', status: 'fail', ...problemText(err) });
    return checks;
  }

  // A starter app passes every check while protecting none of your code.
  const config = loadConfig(dir);
  const appPath = resolve(dir, config.app);

  // Read, not run: every effect the app module names needs a stub, or the first outcome that reaches it fails.
  const named = declaredEffects(appPath);
  if (named.length) {
    const catalog = loadCatalog(dir, config);
    const defaults = new Set(Object.keys(config.defaults?.given?.stubs ?? {}));
    const elsewhere = new Set([...catalog.outcomes, ...catalog.behaviors].map((x) => x.trigger.given).concat(catalog.conditions.map((c) => c.given)).flatMap((g) => Object.keys(g?.stubs ?? {})));
    const missing = named.filter((k) => !defaults.has(k) && !elsewhere.has(k));
    const partly = named.filter((k) => !defaults.has(k) && elsewhere.has(k));
    checks.push(missing.length
      ? { name: 'stubs', status: 'fail', detail: `no stub for ${missing.join(', ')}, named in ${config.app}`, hint: `Add each under defaults.given.stubs in oodlc/config.yaml, e.g. ${missing[0]}: { result: {} }, with what the API answers.` }
      : partly.length
        ? { name: 'stubs', status: 'warn', detail: `${partly.join(', ')} ${partly.length === 1 ? 'is' : 'are'} stubbed only in some outcomes or conditions`, hint: 'Any other run that makes the call fails. Add a default under defaults.given.stubs in oodlc/config.yaml.' }
        : { name: 'stubs', status: 'ok', detail: `${plural(named.length, 'effect')} in ${config.app}, each stubbed` });
  }
  if (existsSync(appPath) && readFileSync(appPath, 'utf8').includes(STARTER_MARK)) {
    const service = detectService(dir);
    if (service) {
      checks.push({ name: 'app', status: 'fail', detail: `Oodle is running the starter app in ${config.app}, not your service in ${service.entry}`, hint: `Wrap the service instead: delete ${config.app} and oodlc/config.yaml, then run \`oodle init\`. It writes oodle.app.ts around ${service.entry} and keeps your other catalog files.` });
      return checks;
    }
    checks.push({ name: 'starter', status: 'warn', detail: `${config.app} is still the starter app from \`oodle init\``, hint: 'Build your app there, or point app in oodlc/config.yaml at your own.' });
  }

  try {
    const run = await runProject(dir);
    const threw = run.observations.filter((o) => o.error);
    const unstubbed = [...new Set(run.observations.flatMap((o) => o.effects.filter((e) => e.error?.startsWith('no stub')).map((e) => e.kind)))];
    const escaped = [...new Set([...run.observations.flatMap((o) => o.violations), ...run.gaps.flatMap((g) => g.violations)]
      .filter((v) => v.includes(SEALED_ID)).map((v) => /\(([^)]+)\)/.exec(v)?.[1] ?? v))];
    if (unstubbed.length) {
      checks.push({ name: 'app', status: 'fail', detail: `external calls with no stub: ${unstubbed.join(', ')}`, hint: 'Add each one under defaults.given.stubs in oodlc/config.yaml, or in a condition.' });
    } else if (escaped.length) {
      checks.push({ name: 'app', status: 'fail', detail: `reaches the real network: ${escaped.join(', ')}`, hint: `Name each host under effects in ${config.app} (@oodlc/oodle/adapter), or route the call through ctx.effects.call. Then stub the effect in oodlc/config.yaml.` });
    } else if (threw.length) {
      checks.push({ name: 'app', status: 'fail', detail: `${plural(threw.length, 'run')} threw, e.g. ${threw[0].id}: ${threw[0].error}`, hint: 'Run `oodle run` to see each failure.' });
    } else {
      checks.push({ name: 'app', status: 'ok', detail: `loads, ${plural(run.routes.length, 'route')}, ${plural(run.observations.length, 'run')} completed` });
    }
    if (!run.routes.length) {
      checks.push({ name: 'routes', status: 'warn', detail: 'the app lists no routes, so Oodle can\'t find routes nothing describes', hint: `List them, e.g. routes: ['GET /health', 'POST /orders'] in httpApp(), or routes in createApp.` });
    }
    if (run.observations.length) {
      const drift = unstable(dir, run.observations);
      checks.push(drift.length
        ? { name: 'stable', status: 'warn', detail: `output differs between two identical runs: ${drift.slice(0, 3).join('; ')}${drift.length > 3 ? `; and ${drift.length - 3} more` : ''}`, hint: 'Every pull request would show these as changed. Take time and ids from ctx.now() and ctx.id(), use @oodlc/oodle/adapter (deterministic by default), or reset module state in setup(ctx).' }
        : { name: 'stable', status: 'ok', detail: 'two runs give the same output' });
    }
  } catch (err) {
    checks.push({ name: 'app', status: 'fail', ...problemText(err, dir) });
  }
  return checks;
}
