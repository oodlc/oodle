import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';
import { CONFIG_FILE, FOLDER, configFile } from './catalog.ts';
import { OodleError } from './errors.ts';
import { display } from './project.ts';

const CONFIG = (app: string) => `# Oodle project config. Every other .yaml file in this folder is catalog.
# Docs: https://github.com/oodlc/oodle#writing-a-catalog
app: ${app}            # default export createApp(ctx), relative to the project root
defaults:
  given:
    state: {}
    stubs: {}               # every external call the app makes needs a stub, e.g. payment.capture
`;

const INTENTS = `version: 0
# Intents say why the product exists. Every outcome traces to one.
intents:
  - id: service-available
    statement: Callers can rely on the service being there when they need it.
`;

const OUTCOMES = `version: 0
# Outcomes are what someone outside the system must experience. They block a merge when they break.
outcomes:
  - id: service.reachable
    intent: service-available
    statement: A caller asking for health gets a quick, positive answer
    boundary: external
    trigger:
      http: GET /health
    expect:
      status: 200
      body:
        ok: true
`;

const APP = `/**
 * The OODLC app contract: createApp(ctx) returns { routes, handle }.
 * Send every external call through ctx.effects.call and every side effect through
 * ctx.effects.emit, and take ids and time from ctx, so Oodle can simulate the
 * world around the app and record what it does.
 */
export default function createApp(ctx: any) {
  const routes = [{ method: 'GET', path: '/health' }];
  return {
    routes,
    async handle(req: { method: string; path: string; body?: unknown }) {
      if (req.method === 'GET' && req.path === '/health') return { status: 200, body: { ok: true } };
      return { status: 404, body: { error: 'not_found' } };
    },
  };
}
`;

export interface InitResult {
  dir: string;
  created: string[];
  kept: string[];
  /** Files moved by --migrate, as [from, to]. */
  moved?: [string, string][];
}

export function init(target: string, opts: { app?: string; force?: boolean }): InitResult {
  const dir = resolve(target);
  const existing = configFile(dir);
  if (existing?.legacy) {
    throw new OodleError('exists', `${display(existing.path)} is a project in the old layout`, {
      hint: `Move it into ${FOLDER}/ with \`oodle init --migrate${target === '.' ? '' : ` ${target}`}\`.`,
    });
  }
  if (existing && !opts.force) {
    throw new OodleError('exists', `${display(existing.path)} already exists`, {
      hint: 'Pass --force to overwrite the scaffold files. Your app is never overwritten.',
    });
  }
  const app = opts.app ?? 'src/app.ts';
  const files: [string, string, boolean][] = [
    [`${FOLDER}/${CONFIG_FILE}`, CONFIG(app), true],
    [`${FOLDER}/intents.yaml`, INTENTS, true],
    [`${FOLDER}/outcomes.yaml`, OUTCOMES, true],
    // The starter app only fills a gap; an existing app is always left alone.
    [app, APP, false],
  ];
  const created: string[] = [];
  const kept: string[] = [];
  for (const [rel, body, overwrite] of files) {
    const path = join(dir, rel);
    if ((existsSync(path) && (!overwrite || !opts.force)) || (opts.app && rel === app)) {
      kept.push(rel);
      continue;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
    created.push(rel);
  }
  return { dir, created, kept };
}

/** Moves a file with `git mv` when git tracks it, so history follows; otherwise renames it. */
function move(dir: string, from: string, to: string): void {
  mkdirSync(dirname(join(dir, to)), { recursive: true });
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', from], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['mv', from, to], { cwd: dir, stdio: 'ignore' });
  } catch {
    renameSync(join(dir, from), join(dir, to));
  }
}

/** Moves a v0 project (oodle.yaml plus a catalog directory) into oodlc/. See docs/decisions/0003. */
export function migrate(target: string): InitResult {
  const dir = resolve(target);
  const where = configFile(dir);
  if (!where) throw new OodleError('no-project', `No project in ${display(dir)} to migrate`, { hint: 'Start one with `oodle init`.' });
  if (!where.legacy) throw new OodleError('exists', `${display(dir)} already uses ${FOLDER}/`, { hint: 'Nothing to migrate.' });

  const text = readFileSync(where.path, 'utf8');
  const catalogDir = String(parse(text)?.catalog ?? 'catalog');
  const files = existsSync(join(dir, catalogDir)) ? readdirSync(join(dir, catalogDir)).filter((f) => /\.ya?ml$/.test(f)).sort() : [];
  if (files.includes(CONFIG_FILE)) {
    throw new OodleError('migrate-conflict', `${catalogDir}/${CONFIG_FILE} would collide with the config file`, { hint: 'Rename that catalog file, then migrate again.' });
  }

  const moved: [string, string][] = [];
  for (const f of files) {
    const from = join(catalogDir, f);
    const to = join(FOLDER, f);
    if (from === to) continue;
    move(dir, from, to);
    moved.push([from, to]);
  }
  // The config keeps its comments and settings; only the catalog key goes, since oodlc/ is the catalog now.
  move(dir, 'oodle.yaml', join(FOLDER, CONFIG_FILE));
  writeFileSync(join(dir, FOLDER, CONFIG_FILE), text.replace(/^catalog:.*\r?\n/m, ''));
  moved.push(['oodle.yaml', join(FOLDER, CONFIG_FILE)]);
  try {
    if (catalogDir !== FOLDER) rmdirSync(join(dir, catalogDir));
  } catch { /* not empty: other files stay where they were */ }
  return { dir, created: [], kept: [], moved };
}
