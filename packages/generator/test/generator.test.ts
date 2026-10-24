import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCompiled, scriptedModel } from '@oodle/compile';
import { loadSpec } from '@oodle/spec';
import { verify } from '@oodle/verify';
import { describe, expect, it } from 'vitest';
import { DOGWALK_A } from '../../sim/test/fixtures/variants.ts';
import { type AgentRunner, agentsMd, build, permit, sortProposals } from '../src/index.ts';

const EXAMPLE = join(import.meta.dirname, '../../../examples/dogwalk');
const vocab = readCompiled(EXAMPLE).vocabulary!;

function project() {
  const root = mkdtempSync(join(tmpdir(), 'oodle-gen-'));
  cpSync(join(EXAMPLE, 'oodle'), join(root, 'oodle'), { recursive: true });
  return root;
}

/** An "agent" that writes the hand-written app, then does whatever `extra` says. */
const fakeAgent =
  (extra: (app: string) => void = () => {}): AgentRunner =>
  async ({ cwd, transcript }) => {
    cpSync(join(DOGWALK_A, 'src'), join(cwd, 'src'), { recursive: true });
    cpSync(join(DOGWALK_A, 'migrations'), join(cwd, 'migrations'), { recursive: true });
    writeFileSync(
      join(cwd, 'oodle/decisions.proposed.yaml'),
      '- text: Walks are listed by starts_at, soonest first\n  about: [entity:walk, screen:walks]\n- text: An owner with no walks sees "No walks yet."\n  about: [screen:walks]\n',
    );
    writeFileSync(transcript, '{"type":"fake"}\n');
    extra(cwd);
    return { ok: true, turns: 1, costUsd: 0, inputTokens: 0, outputTokens: 0 };
  };

const run = (root: string, runner: AgentRunner, extra = {}) => build(root, { runner, vocab, install: false, ...extra });

describe('oodle build', () => {
  it('builds in .oodle/builds/<id>/app with AGENTS.md and a read-only spec copy, and the result passes verify', async () => {
    const root = project();
    const result = await run(root, fakeAgent());
    expect(result.buildId).toMatch(/^[0-9a-f]{8}-1$/);
    expect(result.manifest).toMatchObject({ status: 'built', problems: [], seed: 1 });
    expect(readFileSync(join(result.app, 'AGENTS.md'), 'utf8')).toContain('- `owner.book_walk` (owner: "book walks") inputs: `minutes`, `starts_at`, `walker`');
    expect(existsSync(join(result.app, 'oodle/compiled/actions.json'))).toBe(true);
    expect(result.manifest.proposedDecisions.duplicates.map((d) => d.proposal.text)).toEqual(['Walks are listed by starts_at, soonest first']);
    expect(result.manifest.proposedDecisions.fresh.map((d) => d.text)).toEqual(['An owner with no walks sees "No walks yet."']);
    const report = await verify(result.app, readCompiled(root), { typecheck: false });
    expect(report.passed).toBe(true);
  });

  it('fails a build whose agent edited the declared tier', async () => {
    const root = project();
    const result = await run(
      root,
      fakeAgent((app) => {
        const p = join(app, 'oodle/personas.yaml');
        writeFileSync(p, readFileSync(p, 'utf8').replace('rate a walker]', 'rate a walker, refund walks]'));
      }),
    );
    expect(result.manifest.status).toBe('failed');
    expect(result.manifest.problems).toEqual([
      'the agent changed the declared tier: personas.owner.can: 1 added, "refund walks"',
      'the agent changed oodle/personas.yaml, which only people change',
    ]);
  });

  it('fails a build whose agent edited decisions.yaml or the compiled vocabulary', async () => {
    const root = project();
    const result = await run(
      root,
      fakeAgent((app) => {
        writeFileSync(join(app, 'oodle/decisions.yaml'), '- Walks are listed newest first\n');
        writeFileSync(join(app, 'oodle/compiled/actions.json'), '{}');
      }),
    );
    expect(result.manifest.problems).toEqual([
      'the agent changed oodle/compiled/actions.json, which only people change',
      'the agent changed oodle/decisions.yaml, which only people change',
    ]);
  });

  it('stops when the agent says the spec is impossible', async () => {
    const root = project();
    const result = await run(
      root,
      fakeAgent((app) =>
        writeFileSync(join(app, 'oodle/blocked.yaml'), 'reason: A walker has at most one walk at any moment, but a journey books two at once\n'),
      ),
    );
    expect(result.manifest).toMatchObject({ status: 'blocked', blocked: 'A walker has at most one walk at any moment, but a journey books two at once' });
  });

  it('fails a build that uses the platform clock', async () => {
    const root = project();
    const result = await run(
      root,
      fakeAgent((app) => {
        const p = join(app, 'src/index.tsx');
        writeFileSync(p, `${readFileSync(p, 'utf8')}\nexport const startedAt = Date.now();\n`);
      }),
    );
    expect(result.manifest.status).toBe('failed');
    expect(result.manifest.problems[0]).toMatch(/^src\/index.tsx:\d+: Date.now\(\)/);
  });

  it('reuses a passing build with the same spec and seed, and builds again for another seed', async () => {
    const root = project();
    const first = await run(root, fakeAgent());
    let ran = false;
    const again = await run(root, async (r) => {
      ran = true;
      return fakeAgent()(r);
    });
    expect(again.reused).toBe(true);
    expect(ran).toBe(false);
    const other = await run(root, fakeAgent(), { seed: 2 });
    expect(other.buildId).not.toBe(first.buildId);
    expect(other.reused).toBe(false);
  });
});

describe('proposed decisions', () => {
  const pinned = loadSpec(EXAMPLE).spec.decisions;

  it('turns a proposal that contradicts a pinned decision into a moved decision', async () => {
    const model = scriptedModel({ 'judge decision': { verdict: 'contradicts', reason: 'newest first is the opposite order' } });
    const sorted = await sortProposals([{ text: 'Walks are listed by created time, newest first', about: ['entity:walk', 'screen:walks'] }], pinned, {
      buildId: 'b',
      model,
    });
    expect(sorted.moved.map((m) => [m.pinned.text, m.proposal.text])).toEqual([
      ['Walks are listed by starts_at, soonest first', 'Walks are listed by created time, newest first'],
    ]);
    expect(sorted.fresh).toEqual([]);
  });

  it('keeps a near match as new when the judge says it is about something else', async () => {
    const model = scriptedModel({ 'judge decision': { verdict: 'different', reason: 'earnings, not the walk list' } });
    const sorted = await sortProposals([{ text: 'Walks in earnings are listed by starts_at, oldest first', about: ['screen:earnings'] }], pinned, {
      buildId: 'b',
      model,
    });
    expect(sorted.fresh.map((d) => d.text)).toEqual(['Walks in earnings are listed by starts_at, oldest first']);
  });
});

describe('the agent tool guard', () => {
  const cwd = '/work/app';
  it.each([
    ['Write', { file_path: '/work/app/src/index.tsx' }, true],
    ['Edit', { file_path: 'src/oodle.driver.ts' }, true],
    ['Write', { file_path: '/work/app/oodle/decisions.proposed.yaml' }, true],
    ['Write', { file_path: '/work/app/oodle/blocked.yaml' }, true],
    ['Edit', { file_path: '/work/app/oodle/personas.yaml' }, false],
    ['Write', { file_path: '/work/app/oodle/compiled/actions.json' }, false],
    ['Write', { file_path: '/work/app/AGENTS.md' }, false],
    ['Write', { file_path: '/work/other/src/index.tsx' }, false],
    ['Read', { file_path: '/work/app/AGENTS.md' }, true],
    ['Read', { file_path: '/work/b-build/app/src/index.tsx' }, false],
    ['Bash', { command: 'pnpm install' }, true],
    ['Bash', { command: 'pnpm typecheck' }, true],
    ['Bash', { command: 'pnpm check' }, true],
    ['Bash', { command: 'npx wrangler d1 migrations apply DB --local' }, true],
    ['Bash', { command: 'ls -la node_modules/@oodle/runtime src migrations' }, true],
    ['Bash', { command: 'ls ../other-build/app' }, false],
    ['Bash', { command: 'ls /Users' }, false],
    ['Bash', { command: 'curl https://example.com' }, false],
    ['Bash', { command: 'pnpm add left-pad' }, false],
    ['Bash', { command: 'pnpm typecheck && rm -rf /' }, false],
    ['WebFetch', { url: 'https://example.com' }, false],
  ])('%s %j → %s', (tool, input, ok) => {
    expect(permit(cwd, tool, input).ok).toBe(ok);
  });
});

describe('AGENTS.md', () => {
  it('says the spec, the decisions to keep, the rules and the vocabulary, in that order', () => {
    const md = agentsMd(loadSpec(EXAMPLE).spec, vocab, { ruledOut: ['new dependencies'] });
    const at = (s: string) => md.indexOf(s);
    expect(at('## The spec')).toBeLessThan(at('## Decisions you must keep exactly'));
    expect(at('## Decisions you must keep exactly')).toBeLessThan(at('## Rules'));
    expect(at('## Rules')).toBeLessThan(at('## The vocabulary'));
    expect(md).toContain('- Walks are listed by starts_at, soonest first');
    expect(md).toContain('- Runs on Cloudflare Workers with D1');
    expect(md).toContain('## Ruled out by merged intents\n\n- new dependencies');
  });
});
