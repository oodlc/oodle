/**
 * The inbox, end to end, with nothing mocked: the real Worker under `wrangler dev` with local D1,
 * the real `oodle sync`, and a person answering through the UI API (as the web app does, with the
 * dev identity header standing in for Cloudflare Access).
 *
 * Needs the inbox's web build (apps/inbox/dist/web), which `pnpm -r build` makes.
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readGaps } from '@oodle/gaps';
import { loadSpec } from '@oodle/spec';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapSql } from '../../../apps/inbox/src/shared/seed.ts';
import { DOGWALK_A, DOGWALK_B, variant } from '../../sim/test/fixtures/variants.ts';
import { git, oodle, project } from './helpers.ts';

const INBOX = join(import.meta.dirname, '../../../apps/inbox');
const WRANGLER = join(INBOX, 'node_modules/.bin/wrangler');
const ready = existsSync(join(INBOX, 'dist/web/app/index.html')) && existsSync(WRANGLER);
const ENV = { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1', NO_COLOR: '1' };

const freePort = () =>
  new Promise<number>((res) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => res(port));
    });
  });

let server: ChildProcess | undefined;
let url = '';
let token = '';

beforeAll(async () => {
  if (!ready) return;
  const persist = mkdtempSync(join(tmpdir(), 'oodle-inbox-'));
  const wrangler = (...args: string[]) => execFileSync(WRANGLER, args, { cwd: INBOX, env: ENV, stdio: 'pipe' });
  wrangler('d1', 'migrations', 'apply', 'oodle-inbox', '--local', '--persist-to', persist);
  const seed = await bootstrapSql({ project: 'dogwalk', name: 'Dog walks', owner: 'ada@example.com' });
  token = seed.token;
  const sql = join(persist, 'seed.sql');
  writeFileSync(sql, seed.statements.join('\n'));
  wrangler('d1', 'execute', 'oodle-inbox', '--local', '--persist-to', persist, '--file', sql);

  const port = await freePort();
  url = `http://127.0.0.1:${port}`;
  server = spawn(
    WRANGLER,
    [
      'dev',
      '--ip',
      '127.0.0.1',
      '--port',
      String(port),
      '--persist-to',
      persist,
      '--var',
      'DEV_AUTH:1',
      '--var',
      'DEV_EMAIL:ada@example.com',
      '--show-interactive-dev-session=false',
    ],
    { cwd: INBOX, env: ENV },
  );
  await new Promise<void>((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`wrangler dev didn't start:\n${out}`)), 60_000);
    const look = (b: Buffer) => {
      out += b.toString();
      if (/Ready on/.test(out)) {
        clearTimeout(timer);
        resolve();
      }
    };
    server?.stdout?.on('data', look);
    server?.stderr?.on('data', look);
  });
}, 120_000);

afterAll(() => {
  server?.kill();
});

const ui = (path: string, init: RequestInit = {}, as = 'ada@example.com') =>
  fetch(`${url}/api/ui/projects/dogwalk${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', 'X-Oodle-Dev-Email': as, ...(init.headers ?? {}) },
  });

describe.skipIf(!ready)('the inbox, end to end', () => {
  it('a person answers in the inbox; oodle sync applies it, commits it and reports it applied; a token cannot answer', async () => {
    const root = project();
    writeFileSync(join(root, 'oodle/oodle.config.yaml'), `remote:\n  url: ${url}\n  project: dogwalk\n`);
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'remote');
    process.env.OODLE_TOKEN = token;
    // No model: questions come from the templates, so the test doesn't depend on a model's wording.
    process.env.OODLE_SCRIPTED_MODEL = join(root, '.oodle-no-answers.json');
    writeFileSync(process.env.OODLE_SCRIPTED_MODEL, '{}');
    try {
      // Gaps from the two hand-written builds; the permission one is for people.
      await oodle(root, 'gaps', '--a', DOGWALK_A, '--b', variant(DOGWALK_B));
      const permission = readGaps(root).find((g) => g.kind === 'permission');
      expect(permission?.route).toBe('human');

      const pushed = await oodle(root, 'sync');
      expect(pushed.code).toBe(0);
      expect(pushed.out.pushed.gaps).toBe(3);

      // The person's inbox shows it.
      const list = (await (await ui('/gaps?status=open&route=human')).json()) as { gaps: { id: string; version: number }[] };
      expect(list.gaps.map((g) => g.id)).toEqual([permission?.id]);

      // A project token can push and pull, never answer for a person.
      const asToken = await fetch(`${url}/api/ui/projects/dogwalk/gaps/${permission?.id}/answer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ option: 'a', version: list.gaps[0]?.version }),
      });
      expect(asToken.status).toBe(403);

      const answered = await ui(`/gaps/${permission?.id}/answer`, { method: 'POST', body: JSON.stringify({ option: 'a', version: list.gaps[0]?.version }) });
      expect(answered.ok).toBe(true);

      // The next sync applies it to the spec, in a commit that says who.
      const pulled = await oodle(root, 'sync');
      expect(pulled.out.applied).toHaveLength(1);
      expect(git(root, 'log', '--format=%s').split('\n').slice(0, 2)).toEqual([
        `oodle: record where ${permission?.id} was applied`,
        `oodle: apply ${permission?.id} (person:ada@example.com)`,
      ]);
      expect(loadSpec(root).spec.personas.owner?.cannot).toEqual(['cancel walks that belong to another owner']);
      const sha = readGaps(root).find((g) => g.id === permission?.id)?.applied_in;

      // And the one after tells the inbox it was applied.
      expect((await oodle(root, 'sync')).out.pushed.applied).toBe(1);
      const detail = (await (await ui(`/gaps/${permission?.id}`)).json()) as { gap: { status: string; answer: { applied_sha: string } } };
      expect(detail.gap.answer.applied_sha).toBe(sha);
    } finally {
      delete process.env.OODLE_TOKEN;
      delete process.env.OODLE_SCRIPTED_MODEL;
    }
  }, 180_000);
});
