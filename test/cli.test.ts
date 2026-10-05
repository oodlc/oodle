import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '..');
const BIN = join(ROOT, 'bin', 'oodle.js');
const EXAMPLE = join(ROOT, 'examples', 'checkout');

/** Runs the real binary, piped (not a TTY), with colour unset so output is plain. */
function oodle(args: string[], env: Record<string, string> = {}, cwd = ROOT) {
  const clean = { ...process.env };
  for (const k of ['FORCE_COLOR', 'NO_COLOR', 'OODLE_FORMAT', 'GITHUB_ACTIONS', 'CI']) delete clean[k];
  const res = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env: { ...clean, ...env } });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

const json = (s: string) => JSON.parse(s);

test('--version prints the package version', () => {
  const { version } = json(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(oodle(['--version']), { code: 0, stdout: `oodle ${version}\n`, stderr: '' });
  assert.equal(json(oodle(['-V', '--json']).stdout).version, version);
});

test('help: top level, per command, and every spelling of it', () => {
  const top = oodle([]);
  assert.equal(top.code, 0);
  for (const section of ['USAGE', 'COMMANDS', 'EXAMPLES', 'EXIT CODES']) assert.match(top.stdout, new RegExp(section));
  for (const args of [['help', 'check'], ['check', '--help'], ['check', '-h']]) {
    const r = oodle(args);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /--base-ref <ref>/);
  }
});

test('help --json describes every command, flag and exit code', () => {
  const spec = json(oodle(['help', '--json']).stdout);
  assert.deepEqual(spec.commands.map((c: any) => c.name), ['run', 'check', 'diff', 'lint', 'init', 'doctor', 'mutate', 'propose', 'draft', 'mcp', 'hook', 'completion', 'hello', 'help']);
  assert.ok(spec.commands.find((c: any) => c.name === 'run').flags.some((f: any) => f.name === 'only' && f.multiple));
  assert.deepEqual(spec.exit_codes.map((e: any) => e.code), [0, 1, 2, 130]);
});

test('typos get a suggestion and exit 2', () => {
  const cmd = oodle(['rnu']);
  assert.equal(cmd.code, 2);
  assert.match(cmd.stderr, /Did you mean `oodle run`/);
  const flag = oodle(['run', EXAMPLE, '--onyl', 'x']);
  assert.equal(flag.code, 2);
  assert.match(flag.stderr, /Did you mean --only/);
});

test('a wrong project path suggests the real one', () => {
  const r = oodle(['run', 'examples']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /No oodlc\/ folder in examples/);
  assert.match(r.stderr, /examples\/checkout/);
});

test('the project is found by walking up from a subdirectory', () => {
  const r = oodle(['lint', '--json'], {}, join(EXAMPLE, 'src'));
  assert.equal(r.code, 0);
  assert.equal(json(r.stdout).ok, true);
});

test('--json: one document on stdout, nothing on stderr, even for errors', () => {
  const ok = oodle(['run', EXAMPLE, '--json']);
  assert.equal(ok.code, 0);
  assert.equal(ok.stderr, '');
  const doc = json(ok.stdout);
  assert.equal(doc.ok, true);
  assert.equal(doc.summary.outcomes, 4);
  assert.equal(doc.summary.broken, 0);
  assert.equal(doc.observations.length, 7);

  const bad = oodle(['run', 'nope', '--json']);
  assert.equal(bad.code, 2);
  assert.equal(bad.stderr, '');
  assert.equal(json(bad.stdout).error.code, 'no-project');
});

test('OODLE_FORMAT=json makes json the default for agents', () => {
  const r = oodle(['lint', EXAMPLE], { OODLE_FORMAT: 'json' });
  assert.equal(json(r.stdout).ok, true);
});

test('--only filters runs, and an unmatched filter says what ids exist', () => {
  const r = json(oodle(['run', EXAMPLE, '--only', 'checkout.payment-*', '--json']).stdout);
  assert.deepEqual([...new Set(r.observations.map((o: any) => o.id))], ['checkout.payment-confirmed', 'checkout.payment-declined', 'checkout.payment-provider-down']);
  const none = oodle(['run', EXAMPLE, '--only', 'zzz']);
  assert.equal(none.code, 2);
  assert.match(none.stderr, /Ids in this catalog: checkout\.payment-confirmed/);
});

test('piped output carries no colour codes; --color always forces them', () => {
  const plain = oodle(['run', EXAMPLE]);
  assert.doesNotMatch(plain.stdout + plain.stderr, /\x1b\[/);
  assert.match(plain.stdout, /All 4 outcomes hold/);
  assert.match(oodle(['run', EXAMPLE, '--color', 'always']).stdout, /\x1b\[/);
  assert.doesNotMatch(oodle(['run', EXAMPLE], { FORCE_COLOR: '1', NO_COLOR: '1' }).stdout, /\x1b\[/);
});

test('init scaffolds a project that passes run straight away', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'oodle-init-')), 'svc');
  const made = json(oodle(['init', dir, '--json']).stdout);
  assert.deepEqual(made.created, ['oodlc/config.yaml', 'oodlc/intents.yaml', 'oodlc/outcomes.yaml', 'src/app.ts']);
  const run = oodle(['run', dir, '--json']);
  assert.equal(run.code, 0, run.stdout);
  assert.equal(json(run.stdout).summary.held, 1);
  const again = oodle(['init', dir]);
  assert.equal(again.code, 2);
  assert.match(again.stderr, /--force/);
});

test('doctor reports each check', () => {
  const r = json(oodle(['doctor', EXAMPLE, '--json']).stdout);
  assert.equal(r.ok, true);
  assert.deepEqual(r.checks.map((c: any) => c.name), ['node', 'git', 'project', 'repository', 'config', 'catalog', 'lint', 'app', 'stable']);
});

/** An Express service as a team would have it before Oodle: no oodlc/, an app that listens on import. */
function existingService(): string {
  const dir = mkdtempSync(join(tmpdir(), 'oodle-svc-'));
  cpSync(join(ROOT, 'examples', 'express-orders', 'src'), join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module', dependencies: { express: '^5' }, scripts: { start: 'node src/server.ts' } }));
  const server = join(dir, 'src', 'server.ts');
  writeFileSync(server, readFileSync(server, 'utf8').replace('if (import.meta.main) app.listen', 'app.listen'));
  return dir;
}

test('init on an existing service wraps it in an adapter instead of writing a starter app', () => {
  const dir = existingService();
  const made = json(oodle(['init', dir, '--json']).stdout);
  assert.deepEqual(made.created, ['oodlc/config.yaml', 'oodlc/intents.yaml', 'oodlc/outcomes.yaml', 'oodle.app.ts']);
  assert.deepEqual(made.service, { entry: 'src/server.ts', framework: 'express', exportName: 'app', listensOnImport: true });
  const adapter = readFileSync(join(dir, 'oodle.app.ts'), 'utf8');
  assert.match(adapter, /import \{ httpApp \} from '@oodlc\/oodle\/adapter';/);
  assert.match(adapter, /import \{ app \} from '\.\/src\/server\.ts';/);
  assert.match(adapter, /calls listen\(\) when it is imported/);
  assert.equal(existsSync(join(dir, 'src', 'app.ts')), false);
  assert.match(readFileSync(join(dir, 'oodlc', 'config.yaml'), 'utf8'), /^app: oodle\.app\.ts/m);
  // The service has a /health route, so the starter outcome describes it.
  assert.match(readFileSync(join(dir, 'oodlc', 'outcomes.yaml'), 'utf8'), /GET \/health/);
  const text = oodle(['init', existingService()]);
  assert.match(text.stderr, /Guard it, e\.g\. if \(import\.meta\.main\) app\.listen\(port\)/);
});

test('init --ci writes the GitHub workflow at the repository root, pointing at the project', () => {
  const repo = mkdtempSync(join(tmpdir(), 'oodle-ci-'));
  spawnSync('git', ['init', '-q'], { cwd: repo });
  const made = json(oodle(['init', join(repo, 'services', 'api'), '--ci', '--json']).stdout);
  assert.ok(made.created.includes('../../.github/workflows/oodle.yml'), made.created.join(', '));
  const wf = readFileSync(join(repo, '.github', 'workflows', 'oodle.yml'), 'utf8');
  assert.match(wf, /pull_request_review:\n\s+types: \[submitted\]/);
  assert.match(wf, /uses: oodlc\/oodle@v0\n\s+with:\n\s+project: services\/api/);
  assert.match(wf, /\$\{\{ github\.event\.pull_request\.number \|\| github\.ref \}\}/);
});

test('doctor fails when Oodle runs the starter app instead of the service beside it', () => {
  const dir = existingService();
  const starter = mkdtempSync(join(tmpdir(), 'oodle-starter-'));
  oodle(['init', starter]);
  cpSync(join(starter, 'oodlc'), join(dir, 'oodlc'), { recursive: true });
  cpSync(join(starter, 'src', 'app.ts'), join(dir, 'src', 'app.ts'));
  const r = json(oodle(['doctor', dir, '--json']).stdout);
  assert.equal(r.ok, false);
  const app = r.checks.find((c: any) => c.name === 'app');
  assert.equal(app.status, 'fail');
  assert.match(app.detail, /running the starter app in src\/app\.ts, not your service in src\/server\.ts/);
  // Greenfield: the starter is fine to start from, but doctor still says so.
  assert.equal(json(oodle(['doctor', starter, '--json']).stdout).checks.find((c: any) => c.name === 'starter').status, 'warn');
});

test('doctor warns when nothing is declared, and when output differs between identical runs', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'oodle-')), 'checkout');
  cpSync(EXAMPLE, dir, { recursive: true });
  const checkout = join(dir, 'src', 'checkout.ts');
  writeFileSync(checkout, readFileSync(checkout, 'utf8').replace("status: 'confirmed', total_cents }", "status: 'confirmed', total_cents, at: Date.now() + Math.random() }"));
  const r = json(oodle(['doctor', dir, '--json']).stdout);
  const stable = r.checks.find((c: any) => c.name === 'stable');
  assert.equal(stable.status, 'warn');
  assert.match(stable.detail, /checkout\.payment-confirmed \[first_purchase\] body\.at: /);

  const empty = mkdtempSync(join(tmpdir(), 'oodle-empty-'));
  oodle(['init', empty]);
  writeFileSync(join(empty, 'oodlc', 'outcomes.yaml'), 'version: 0\noutcomes: []\n');
  const catalog = json(oodle(['doctor', empty, '--json']).stdout).checks.find((c: any) => c.name === 'catalog');
  assert.equal(catalog.status, 'warn');
  assert.match(catalog.detail, /nothing blocks a merge yet/);
});

test('completion scripts are generated for each shell', () => {
  for (const shell of ['bash', 'zsh', 'fish']) {
    const r = oodle(['completion', shell]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /base-ref/);
  }
  assert.match(oodle(['completion', 'zhs']).stderr, /Did you mean `oodle completion zsh`/);
});

test('GitHub Actions: blocking findings become annotations on stderr', () => {
  const r = oodle(['lint', EXAMPLE], { GITHUB_ACTIONS: 'true' });
  assert.match(r.stderr, /::warning title=Oodle catalog warning,file=examples\/checkout\/oodlc\/intents\.yaml::/);
});

test('a compile error in the app shows file:line:col, not just the first line', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'oodle-syntax-')), 'svc');
  oodle(['init', dir, '--json']);
  writeFileSync(join(dir, 'src', 'app.ts'), 'export const = ;\n');
  const r = json(oodle(['run', dir, '--json']).stdout);
  assert.equal(r.error.code, 'app-load');
  assert.ok(r.error.problems.some((p: string) => /src\/app\.ts:1:\d+: ERROR/.test(p)), JSON.stringify(r.error.problems));
});

test('the same finding under several conditions is shown once', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'oodle-group-')), 'checkout');
  cpSync(EXAMPLE, dir, { recursive: true });
  const file = join(dir, 'src', 'checkout.ts');
  writeFileSync(file, readFileSync(file, 'utf8').replace('{ order_id: order.id,', '{ orderId: order.id,').replaceAll("'../../../src/", `'${ROOT}/src/`));
  for (const f of ['app.ts', 'pricing.ts', 'server.ts']) {
    const p = join(dir, 'src', f);
    writeFileSync(p, readFileSync(p, 'utf8').replaceAll("'../../../src/", `'${ROOT}/src/`));
  }
  const r = oodle(['run', dir]);
  assert.equal(r.code, 1);
  assert.equal(r.stdout.match(/body\.order_id: missing/g)?.length, 1, r.stdout);
  assert.match(r.stdout, /3 conditions\s+body\.order_id: missing/);
  assert.match(r.stdout, /warnings only · not blocking/);
});

test('the old layout (oodle.yaml + catalog/) still runs, with a nudge, and --migrate moves it into oodlc/', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'oodle-legacy-')), 'checkout');
  cpSync(EXAMPLE, dir, { recursive: true });
  // Rebuild the v0 layout from the current one.
  cpSync(join(dir, 'oodlc'), join(dir, 'catalog'), { recursive: true });
  writeFileSync(join(dir, 'oodle.yaml'), `catalog: catalog\n${readFileSync(join(dir, 'oodlc', 'config.yaml'), 'utf8')}`);
  rmSync(join(dir, 'oodlc'), { recursive: true });
  rmSync(join(dir, 'catalog', 'config.yaml'));

  const old = oodle(['run', dir]);
  assert.equal(old.code, 0, old.stderr);
  assert.match(old.stdout, /All 4 outcomes hold/);
  assert.match(old.stderr, /old layout \(oodle\.yaml\)\. Move it into oodlc\/ with oodle init --migrate/);

  const moved = json(oodle(['init', '--migrate', dir, '--json']).stdout);
  assert.equal(moved.ok, true);
  assert.deepEqual(moved.moved.at(-1), ['oodle.yaml', 'oodlc/config.yaml']);
  assert.equal(existsSync(join(dir, 'oodle.yaml')), false);
  assert.equal(existsSync(join(dir, 'catalog')), false);
  assert.doesNotMatch(readFileSync(join(dir, 'oodlc', 'config.yaml'), 'utf8'), /^catalog:/m);
  const after = json(oodle(['run', dir, '--json']).stdout);
  assert.equal(after.summary.held, 4);
});

test('a project is found from inside its oodlc/ folder, and oodlc/ itself is accepted as the argument', () => {
  assert.equal(json(oodle(['lint', '--json'], {}, join(EXAMPLE, 'oodlc')).stdout).ok, true);
  assert.equal(json(oodle(['lint', join(EXAMPLE, 'oodlc'), '--json']).stdout).ok, true);
});
