import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { OodleError } from './errors.ts';
import { display } from './project.ts';

const CONFIG = (app: string) => `# Oodle project config. Docs: https://github.com/oodlc/oodle#writing-a-catalog
app: ${app}            # default export createApp(ctx)
catalog: catalog
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
}

export function init(target: string, opts: { app?: string; force?: boolean }): InitResult {
  const dir = resolve(target);
  if (existsSync(join(dir, 'oodle.yaml')) && !opts.force) {
    throw new OodleError('exists', `${display(join(dir, 'oodle.yaml'))} already exists`, {
      hint: 'Pass --force to overwrite the scaffold files. Your app is never overwritten.',
    });
  }
  const app = opts.app ?? 'src/app.ts';
  const files: [string, string, boolean][] = [
    ['oodle.yaml', CONFIG(app), true],
    ['catalog/intents.yaml', INTENTS, true],
    ['catalog/outcomes.yaml', OUTCOMES, true],
    // The starter app only fills a gap; an existing app is always left alone.
    [app, APP, false],
  ];
  const created: string[] = [];
  const kept: string[] = [];
  for (const [rel, body, overwrite] of files) {
    const path = join(dir, rel);
    if (existsSync(path) && (!overwrite || !opts.force)) {
      kept.push(rel);
      continue;
    }
    if (opts.app && rel === app) {
      kept.push(rel);
      continue;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
    created.push(rel);
  }
  return { dir, created, kept };
}
