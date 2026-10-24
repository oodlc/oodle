import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readGap } from '@oodle/gaps';
import { loadConfig, loadSpec } from '@oodle/spec';
import { describe, expect, it } from 'vitest';
import { readState, sync } from '../src/index.ts';
import { log, PERMISSION, repo, WORDING, withGaps } from './helpers.ts';

const config = (root: string) => ({ ...loadConfig(root), remote: { url: 'https://inbox.test', project: 'dogwalk' } });

/** A fake inbox: records what was pushed, answers with what `pull` says. */
function inbox(pull: (cursor: number) => unknown) {
  const pushed: {
    url: string;
    auth: string | null;
    body: { push: { gaps: { id: string }[]; applied: unknown[]; superseded_gaps: string[] }; cursor: number };
  }[] = [];
  const fetch = (async (url: URL, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    pushed.push({ url: String(url), auth: new Headers(init.headers).get('authorization'), body });
    return new Response(JSON.stringify(pull(body.cursor)), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  return { fetch, pushed };
}

describe('oodle sync', () => {
  it('does nothing without a remote or a token', async () => {
    const root = repo();
    expect((await sync(root, { config: loadConfig(root) })).skipped).toMatch(/No remote/);
    expect((await sync(root, { config: config(root) })).skipped).toMatch(/No token/);
  });

  it('pushes gaps, applies pulled answers in seq order, and reports them as applied next time', async () => {
    const root = repo();
    withGaps(root, WORDING, PERMISSION);
    const answers = [
      { id: 'a_2', gap_id: PERMISSION.id, answer: { option: 'a' }, answered_by: 'person:ada@example.com', seq: 2 },
      { id: 'a_1', gap_id: WORDING.id, answer: { option: 'b' }, answered_by: 'person:bea@example.com', seq: 1 },
    ];
    const fake = inbox((cursor) => ({ answers: answers.filter((a) => a.seq > cursor), approvals: [], cursor: Math.max(cursor, 2) }));
    const first = await sync(root, { config: config(root), token: 'tok', fetch: fake.fetch });
    expect(fake.pushed[0]?.url).toBe('https://inbox.test/api/v1/projects/dogwalk/sync');
    expect(fake.pushed[0]?.auth).toBe('Bearer tok');
    expect(fake.pushed[0]?.body.push.gaps.map((g) => g.id).sort()).toEqual([PERMISSION.id, WORDING.id]);
    expect(first.applied.map((a) => a.answer)).toEqual(['a_1', 'a_2']);
    expect(log(root).slice(0, 3)).toEqual([
      `oodle: record where ${WORDING.id}, ${PERMISSION.id} were applied`,
      `oodle: apply ${PERMISSION.id} (person:ada@example.com)`,
      `oodle: apply ${WORDING.id} (person:bea@example.com)`,
    ]);
    expect(loadSpec(root).spec.personas.owner?.cannot).toEqual(['cancel walks that belong to another owner']);
    expect(readGap(root, WORDING.id)?.applied_in).toMatch(/^[0-9a-f]{40}$/);
    expect(readState(root).cursor).toBe(2);

    const second = await sync(root, { config: config(root), token: 'tok', fetch: fake.fetch });
    expect(fake.pushed[1]?.body.cursor).toBe(2);
    expect(fake.pushed[1]?.body.push.applied).toEqual([
      { answer_id: 'a_1', sha: readGap(root, WORDING.id)?.applied_in },
      { answer_id: 'a_2', sha: readGap(root, PERMISSION.id)?.applied_in },
    ]);
    expect(second.applied).toEqual([]);
    expect(fake.pushed[2]).toBeUndefined();
  });

  it('applies nothing over uncommitted changes to the spec', async () => {
    const root = repo();
    withGaps(root, WORDING);
    writeFileSync(join(root, 'oodle/intent.yaml'), 'intent: Something else\n');
    const fake = inbox(() => ({
      answers: [{ id: 'a_1', gap_id: WORDING.id, answer: { option: 'a' }, answered_by: 'person:ada@example.com', seq: 1 }],
      approvals: [],
      cursor: 1,
    }));
    await expect(sync(root, { config: config(root), token: 'tok', fetch: fake.fetch })).rejects.toThrow(/Commit or undo your changes under oodle\/ first/);
    expect(readState(root).cursor).toBe(0);
  });

  it('records an answer it may not apply, and moves on', async () => {
    const root = repo();
    withGaps(root, PERMISSION);
    const fake = inbox(() => ({
      answers: [{ id: 'a_9', gap_id: PERMISSION.id, answer: { option: 'a' }, answered_by: 'agent:rogue', seq: 9 }],
      approvals: [],
      cursor: 9,
    }));
    const out = await sync(root, { config: config(root), token: 'tok', fetch: fake.fetch });
    expect(out.refused).toEqual([
      { gap: PERMISSION.id, answer: 'a_9', why: `${PERMISSION.id} needs a person's answer (route: human); agent:rogue can't answer it.` },
    ]);
    expect(readState(root).cursor).toBe(9);
  });
});
