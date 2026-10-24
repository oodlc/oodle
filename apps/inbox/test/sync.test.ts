import { beforeAll, describe, expect, it } from 'vitest';
import type { AnswerResponse, GapDetailResponse, PushedGap } from '../src/shared/protocol.ts';
import { REOPEN_NOTE } from '../src/worker/sync.ts';
import { as, CANCEL_FEE, CANCEL_RULE, dogwalk, gapById, mockAccessJwks, PERMISSION, rows, SORT, setupProject, sync, syncRaw, WORDING } from './helpers.ts';

beforeAll(mockAccessJwks);

type GapRow = { id: string; status: string; version: number; content_hash: string; body_json: string; note: string | null; intent_id: string | null };
const gapRow = async (project: string, id: string) => (await rows<GapRow>('SELECT * FROM gaps WHERE project_id = ? AND id = ?', project, id))[0];
const eventTypes = async (project: string) =>
  (await rows<{ type: string }>('SELECT type FROM events WHERE project_id = ? ORDER BY rowid', project)).map((e) => e.type);

/** The same gap with different evidence, as a new gaps run would push it. */
function changed(g: PushedGap, n = 2): PushedGap {
  const next = structuredClone(g);
  next.content_hash = `${g.content_hash.replace(/_\d+$/, '')}_${n}`;
  next.body.evidence.b.sample = ['Something else entirely'];
  return next;
}

describe('sync: pushing gaps', () => {
  it('inserts new gaps; human ones are open, settled agent ones are stored applied', async () => {
    const { project, token } = await setupProject();
    const res = await sync(project, token, { push: dogwalk() });
    expect(res).toEqual({ answers: [], approvals: [], cursor: 0 });
    expect((await gapRow(project, PERMISSION))?.status).toBe('open');
    expect((await gapRow(project, WORDING))?.status).toBe('open');
    expect((await gapRow(project, SORT))?.status).toBe('applied');
    expect((await gapRow(project, CANCEL_RULE))?.intent_id).toBe(CANCEL_FEE);
    expect(await eventTypes(project)).toEqual(expect.arrayContaining(['gap.created', 'gap.settled_locally', 'intent.created']));
  });

  it('touches nothing when the content hash is unchanged', async () => {
    const { project, token } = await setupProject();
    await sync(project, token, { push: dogwalk() });
    const before = await gapRow(project, PERMISSION);
    const events = (await eventTypes(project)).length;
    const same = gapById(PERMISSION);
    same.body.question = 'A reworded question with the same hash';
    await sync(project, token, { push: { gaps: [same] } });
    expect(await gapRow(project, PERMISSION)).toEqual(before);
    expect((await eventTypes(project)).length).toBe(events);
  });

  it('updates the body of an open gap whose content changed', async () => {
    const { project, token } = await setupProject();
    await sync(project, token, { push: { gaps: [gapById(PERMISSION)] } });
    await sync(project, token, { push: { gaps: [changed(gapById(PERMISSION))] } });
    const row = await gapRow(project, PERMISSION);
    expect(row?.status).toBe('open');
    expect(row?.version).toBe(2);
    expect(row?.content_hash).toBe('ch_2c81d0e5_2');
    expect(JSON.parse(row?.body_json ?? '{}').evidence.b.sample).toEqual(['Something else entirely']);
    expect(row?.note).toBeNull();
    expect(await eventTypes(project)).toContain('gap.updated');
  });

  it('reopens an answered gap whose content changed, keeping the answer and saying why', async () => {
    const { project, token, owner } = await setupProject();
    await sync(project, token, { push: { gaps: [gapById(PERMISSION)] } });
    const { answer } = await as(owner).json<AnswerResponse>('POST', `/projects/${project}/gaps/${PERMISSION}/answer`, { option: 'b', version: 1 });
    await sync(project, token, { push: { gaps: [changed(gapById(PERMISSION))] } });
    const detail = await as(owner).json<GapDetailResponse>('GET', `/projects/${project}/gaps/${PERMISSION}`);
    expect(detail.gap.status).toBe('open');
    expect(detail.gap.note).toBe(REOPEN_NOTE);
    expect(detail.gap.answer?.id).toBe(answer.id);
    expect(detail.answers.map((a) => a.id)).toEqual([answer.id]);
    expect(await eventTypes(project)).toContain('gap.reopened');
    // Answering again clears the note.
    const again = await as(owner).json<AnswerResponse>('POST', `/projects/${project}/gaps/${PERMISSION}/answer`, { option: 'b', version: detail.gap.version });
    expect(again.gap.note).toBeNull();
    expect(again.gap.status).toBe('answered');
  });

  it('records an agent gap that was pushed open and is later settled locally', async () => {
    const { project, token } = await setupProject();
    const open = gapById(SORT);
    Object.assign(open.body, { status: 'open', answer: null, answered_by: null, answered_at: null, applied_in: null });
    await sync(project, token, { push: { gaps: [open] } });
    expect((await gapRow(project, SORT))?.status).toBe('open');
    await sync(project, token, { push: { gaps: [gapById(SORT)] } });
    expect((await gapRow(project, SORT))?.status).toBe('applied');
  });

  it('refuses, with 403 and no writes, a human gap carrying an answer not given by a person', async () => {
    const { project, token } = await setupProject();
    const forged = gapById(PERMISSION);
    Object.assign(forged.body, { status: 'answered', answer: { option: 'a' }, answered_by: 'agent:claude@local', answered_at: '2026-11-02T10:00:00Z' });
    const res = await syncRaw(project, token, { push: { gaps: [gapById(WORDING), forged] } });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('token_cannot_answer');
    expect(await rows('SELECT id FROM gaps WHERE project_id = ?', project)).toEqual([]);
    expect(await rows('SELECT id FROM answers WHERE project_id = ?', project)).toEqual([]);
  });

  it('stores a human gap answered by a person at their terminal as the file says, without making an answer', async () => {
    const { project, token } = await setupProject();
    const local = gapById(PERMISSION);
    Object.assign(local.body, {
      status: 'applied',
      answer: { option: 'b' },
      answered_by: 'person:ada@x.test',
      answered_at: '2026-11-02T10:00:00Z',
      applied_in: 'f00d',
    });
    await sync(project, token, { push: { gaps: [local] } });
    expect((await gapRow(project, PERMISSION))?.status).toBe('applied');
    expect(await rows('SELECT id FROM answers WHERE project_id = ?', project)).toEqual([]);
  });

  it('marks superseded gaps, leaves applied ones alone, and brings a gap back if it is raised again', async () => {
    const { project, token } = await setupProject();
    await sync(project, token, { push: dogwalk() });
    await sync(project, token, { push: { superseded_gaps: [WORDING, SORT, 'g_unknown'] } });
    expect((await gapRow(project, WORDING))?.status).toBe('superseded');
    expect((await gapRow(project, SORT))?.status).toBe('applied');
    expect((await eventTypes(project)).filter((t) => t === 'gap.superseded')).toHaveLength(1);
    await sync(project, token, { push: { gaps: [gapById(WORDING)] } });
    expect((await gapRow(project, WORDING))?.status).toBe('open');
  });

  it('rejects malformed pushes with 400 and writes nothing', async () => {
    const { project, token } = await setupProject();
    const broken = gapById(PERMISSION);
    (broken.body as unknown as Record<string, unknown>).route = 'robot';
    const res = await syncRaw(project, token, { push: { gaps: [gapById(WORDING), broken] } });
    expect(res.status).toBe(400);
    expect(await rows('SELECT id FROM gaps WHERE project_id = ?', project)).toEqual([]);
    expect((await syncRaw(project, token, { cursor: -1 })).status).toBe(400);
  });
});

describe('sync: pulling answers and acknowledging them', () => {
  it('returns answers after the cursor, in seq order, and the new cursor', async () => {
    const { project, token, owner } = await setupProject();
    await sync(project, token, { push: dogwalk() });
    const a1 = await as(owner).json<AnswerResponse>('POST', `/projects/${project}/gaps/${PERMISSION}/answer`, { option: 'b', version: 1 });
    const a2 = await as(owner).json<AnswerResponse>('POST', `/projects/${project}/gaps/${WORDING}/answer`, {
      text: 'Show the walker and the time',
      target: 'decision',
      version: 1,
    });

    const first = await sync(project, token, { cursor: 0 });
    expect(first.answers.map((a) => [a.id, a.seq])).toEqual([
      [a1.answer.id, 1],
      [a2.answer.id, 2],
    ]);
    expect(first.answers[0]).toMatchObject({ gap_id: PERMISSION, answer: { option: 'b' }, answered_by: `person:${owner}` });
    expect(first.answers[1]?.answer).toEqual({ text: 'Show the walker and the time', target: 'decision' });
    expect(first.cursor).toBe(2);

    const later = await sync(project, token, { cursor: 1 });
    expect(later.answers.map((a) => a.seq)).toEqual([2]);
    const none = await sync(project, token, { cursor: 2 });
    expect(none).toEqual({ answers: [], approvals: [], cursor: 2 });
  });

  it('records applied acks once: sha and acked_at on the answer, the gap applied', async () => {
    const { project, token, owner } = await setupProject();
    await sync(project, token, { push: { gaps: [gapById(PERMISSION)] } });
    const { answer } = await as(owner).json<AnswerResponse>('POST', `/projects/${project}/gaps/${PERMISSION}/answer`, { option: 'b', version: 1 });
    await sync(project, token, { push: { applied: [{ answer_id: answer.id, sha: 'def456' }] }, cursor: 1 });
    await sync(project, token, { push: { applied: [{ answer_id: answer.id, sha: 'zzz999' }] }, cursor: 1 });
    const [row] = await rows<{ applied_sha: string; acked_at: string }>('SELECT applied_sha, acked_at FROM answers WHERE id = ?', answer.id);
    expect(row?.applied_sha).toBe('def456');
    expect(row?.acked_at).toBeTruthy();
    expect((await gapRow(project, PERMISSION))?.status).toBe('applied');
    expect((await eventTypes(project)).filter((t) => t === 'answer.applied')).toHaveLength(1);
  });

  it('keeps pulling the same answers until the cursor moves (re-pulling is harmless)', async () => {
    const { project, token, owner } = await setupProject();
    await sync(project, token, { push: { gaps: [gapById(PERMISSION)] } });
    await as(owner).post(`/projects/${project}/gaps/${PERMISSION}/answer`, { dismiss: true, version: 1 });
    const a = await sync(project, token, { cursor: 0 });
    const b = await sync(project, token, { cursor: 0 });
    expect(b).toEqual(a);
    expect((await gapRow(project, PERMISSION))?.status).toBe('dismissed');
  });
});

describe('sync: intents', () => {
  it('inserts, ignores same-hash pushes, and updates on change', async () => {
    const { project, token } = await setupProject();
    await sync(project, token, { push: { intents: dogwalk().intents } });
    const intent = dogwalk().intents[0];
    if (!intent) throw new Error('fixture has no intent');
    intent.body.why = 'Changed without a new hash';
    await sync(project, token, { push: { intents: [intent] } });
    let [row] = await rows<{ body_json: string; content_hash: string }>('SELECT * FROM intents WHERE project_id = ?', project);
    expect(JSON.parse(row?.body_json ?? '{}').why).toBe('Walkers lose income on late cancellations.');
    intent.content_hash = 'ih_cancel_fee_2';
    await sync(project, token, { push: { intents: [intent] } });
    [row] = await rows('SELECT * FROM intents WHERE project_id = ?', project);
    expect(row?.content_hash).toBe('ih_cancel_fee_2');
    expect(await eventTypes(project)).toEqual(['project.seeded', 'intent.created', 'intent.updated']);
  });
});
