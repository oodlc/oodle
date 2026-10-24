import { beforeAll, describe, expect, it } from 'vitest';
import type { AnswerResponse, ErrorResponse, GapDetailResponse, GapsResponse } from '../src/shared/protocol.ts';
import { as, CANCEL_RULE, gapById, mockAccessJwks, PERMISSION, rows, SORT, seedDemo, setupProject, sync, WORDING } from './helpers.ts';

beforeAll(mockAccessJwks);

const ADA = 'ada@x.test';
const BEA = 'bea@x.test';

describe('answering a gap', () => {
  it('records the answer with an id, the person, a seq, and moves the gap to answered', async () => {
    const { project } = await setupProject({ [ADA]: 'answerer' });
    await seedDemo(project);
    const res = await as(ADA).post(`/projects/${project}/gaps/${PERMISSION}/answer`, { option: 'b', version: 1 });
    expect(res.status).toBe(201);
    const { answer, gap } = (await res.json()) as AnswerResponse;
    expect(answer.id).toMatch(/^a_[0-9a-f]{16}$/);
    expect(answer).toMatchObject({ gap_id: PERMISSION, answer: { option: 'b' }, answered_by: `person:${ADA}`, seq: 1, applied_sha: null });
    expect(gap).toMatchObject({ status: 'answered', version: 2 });
    const [event] = await rows<{ type: string; actor: string }>("SELECT type, actor FROM events WHERE project_id = ? AND type = 'gap.answered'", project);
    expect(event?.actor).toBe(`person:${ADA}`);
  });

  it('accepts each answer form and refuses bad ones', async () => {
    const { project } = await setupProject({ [ADA]: 'answerer' });
    await seedDemo(project);
    const post = (id: string, body: unknown) => as(ADA).post(`/projects/${project}/gaps/${id}/answer`, body);
    expect((await post(PERMISSION, { option: 'zz', version: 1 })).status).toBe(400);
    expect((await post(PERMISSION, { option: 'a', dismiss: true, version: 1 })).status).toBe(400);
    expect((await post(PERMISSION, { text: 'Walkers never cancel', target: 'law', version: 1 })).status).toBe(400);
    expect((await post(PERMISSION, { option: 'a' })).status).toBe(400);
    expect((await post(PERMISSION, { text: 'Only owners cancel walks', target: 'domain_rule', version: 1 })).status).toBe(201);
    expect((await post(WORDING, { dont_care: true, version: 1 })).status).toBe(201);
    const dismissed = (await (await post(CANCEL_RULE, { dismiss: true, version: 1 })).json()) as AnswerResponse;
    expect(dismissed.gap.status).toBe('dismissed');
  });

  it('returns 409 with the current gap when the version is stale', async () => {
    const { project, token } = await setupProject({ [ADA]: 'answerer' });
    await sync(project, token, { push: { gaps: [gapById(PERMISSION)] } });
    const next = gapById(PERMISSION);
    next.content_hash = 'ch_2c81d0e5_2';
    await sync(project, token, { push: { gaps: [next] } });
    const res = await as(ADA).post(`/projects/${project}/gaps/${PERMISSION}/answer`, { option: 'b', version: 1 });
    expect(res.status).toBe(409);
    const body = (await res.json()) as ErrorResponse;
    expect(body.error).toBe('version_mismatch');
    expect(body.gap?.version).toBe(2);
    expect(body.gap?.content_hash).toBe('ch_2c81d0e5_2');
    expect(await rows('SELECT id FROM answers WHERE project_id = ?', project)).toEqual([]);
  });

  it('lets a person override an answer an agent settled locally', async () => {
    const { project } = await setupProject({ [ADA]: 'answerer' });
    await seedDemo(project);
    const res = await as(ADA).post(`/projects/${project}/gaps/${SORT}/answer`, { option: 'a', version: 1 });
    expect(res.status).toBe(201);
    expect(((await res.json()) as AnswerResponse).gap.status).toBe('answered');
  });

  it('lets the same person change their answer, with a new seq', async () => {
    const { project } = await setupProject({ [ADA]: 'answerer' });
    await seedDemo(project);
    const first = await as(ADA).json<AnswerResponse>('POST', `/projects/${project}/gaps/${PERMISSION}/answer`, { option: 'b', version: 1 });
    const same = await as(ADA).json<AnswerResponse>('POST', `/projects/${project}/gaps/${PERMISSION}/answer`, { option: 'b', version: 2 });
    expect(same.answer.id).toBe(first.answer.id);
    const second = await as(ADA).json<AnswerResponse>('POST', `/projects/${project}/gaps/${PERMISSION}/answer`, { option: 'a', version: 2 });
    expect(second.answer.seq).toBe(2);
    expect(second.gap.answer?.id).toBe(second.answer.id);
  });
});

describe('two people answering the same gap (8.5)', () => {
  it('keeps the first answer, records the second as a conflict, and shows it on the gap', async () => {
    const { project } = await setupProject({ [ADA]: 'answerer', [BEA]: 'answerer' });
    await seedDemo(project);
    // Both opened the gap at version 1.
    const ada = await as(ADA).post(`/projects/${project}/gaps/${PERMISSION}/answer`, { option: 'b', version: 1 });
    expect(ada.status).toBe(201);
    const bea = await as(BEA).post(`/projects/${project}/gaps/${PERMISSION}/answer`, { option: 'a', version: 1 });
    expect(bea.status).toBe(409);
    const body = (await bea.json()) as ErrorResponse & { conflict: string };
    expect(body.error).toBe('conflict');
    expect(body.gap?.answer?.answered_by).toBe(`person:${ADA}`);
    expect(body.gap?.open_conflicts).toBe(1);

    const detail = await as(ADA).json<GapDetailResponse>('GET', `/projects/${project}/gaps/${PERMISSION}`);
    expect(detail.conflicts).toHaveLength(1);
    expect(detail.conflicts[0]).toMatchObject({ answered_by: `person:${BEA}`, answer: { option: 'a' }, resolution: null });
    const flagged = await as(ADA).json<GapsResponse>('GET', `/projects/${project}/gaps?conflicts=open`);
    expect(flagged.gaps.map((g) => g.id)).toEqual([PERMISSION]);
    expect(await rows("SELECT id FROM events WHERE project_id = ? AND type = 'gap.answer_conflict'", project)).toHaveLength(1);
    // Only one answer counts, and only it is pulled.
    expect(await rows('SELECT id FROM answers WHERE project_id = ?', project)).toHaveLength(1);
  });

  it('lets the first answerer take the other answer, which becomes a new answer with a new seq', async () => {
    const { project, token } = await setupProject({ [ADA]: 'answerer', [BEA]: 'answerer' });
    await seedDemo(project);
    await as(ADA).post(`/projects/${project}/gaps/${PERMISSION}/answer`, { option: 'b', version: 1 });
    const { conflict } = (await (await as(BEA).post(`/projects/${project}/gaps/${PERMISSION}/answer`, { option: 'a', version: 2 })).json()) as {
      conflict: string;
    };
    expect(conflict).toMatch(/^c_/);
    expect((await as(BEA).post(`/projects/${project}/gaps/${PERMISSION}/conflicts/${conflict}/resolve`, { resolution: 'take' })).status).toBe(403);
    const res = await as(ADA).post(`/projects/${project}/gaps/${PERMISSION}/conflicts/${conflict}/resolve`, { resolution: 'take' });
    expect(res.status).toBe(200);
    const pulled = await sync(project, token, { cursor: 0 });
    expect(pulled.answers.map((a) => [a.seq, a.answered_by, a.answer])).toEqual([
      [1, `person:${ADA}`, { option: 'b' }],
      [2, `person:${BEA}`, { option: 'a' }],
    ]);
    const detail = await as(ADA).json<GapDetailResponse>('GET', `/projects/${project}/gaps/${PERMISSION}`);
    expect(detail.gap.open_conflicts).toBe(0);
    expect(detail.conflicts[0]?.resolution).toBe('taken');
  });

  it('lets the first answerer keep their answer', async () => {
    const { project } = await setupProject({ [ADA]: 'answerer', [BEA]: 'answerer' });
    await seedDemo(project);
    await as(ADA).post(`/projects/${project}/gaps/${PERMISSION}/answer`, { option: 'b', version: 1 });
    const { conflict } = (await (await as(BEA).post(`/projects/${project}/gaps/${PERMISSION}/answer`, { option: 'a', version: 1 })).json()) as {
      conflict: string;
    };
    await as(ADA).post(`/projects/${project}/gaps/${PERMISSION}/conflicts/${conflict}/resolve`, { resolution: 'keep' });
    const detail = await as(ADA).json<GapDetailResponse>('GET', `/projects/${project}/gaps/${PERMISSION}`);
    expect(detail.gap.answer?.answered_by).toBe(`person:${ADA}`);
    expect(detail.gap.open_conflicts).toBe(0);
    expect(detail.conflicts[0]?.resolution).toBe('kept');
  });

  it('is not a conflict when the second person gives the same answer', async () => {
    const { project } = await setupProject({ [ADA]: 'answerer', [BEA]: 'answerer' });
    await seedDemo(project);
    await as(ADA).post(`/projects/${project}/gaps/${PERMISSION}/answer`, { option: 'b', version: 1 });
    const res = await as(BEA).post(`/projects/${project}/gaps/${PERMISSION}/answer`, { option: 'b', version: 2 });
    expect(res.status).toBe(200);
    expect(await rows('SELECT id FROM conflicts WHERE project_id = ?', project)).toEqual([]);
  });
});

describe('seq', () => {
  it('stays one gapless per-project order under concurrent answers', async () => {
    const { project, token } = await setupProject({ [ADA]: 'answerer', [BEA]: 'answerer' });
    const ids = Array.from({ length: 12 }, (_, i) => `g_conc${String(i).padStart(4, '0')}`);
    await sync(project, token, {
      push: {
        gaps: ids.map((id) => {
          const g = gapById(PERMISSION);
          g.id = id;
          g.body.id = id;
          g.content_hash = `ch_${id}`;
          return g;
        }),
      },
    });
    const results = await Promise.all(
      ids.map((id, i) => as(i % 2 ? ADA : BEA).post(`/projects/${project}/gaps/${id}/answer`, { option: i % 3 ? 'a' : 'b', version: 1 })),
    );
    expect(results.map((r) => r.status)).toEqual(ids.map(() => 201));
    const seqs = (await rows<{ seq: number }>('SELECT seq FROM answers WHERE project_id = ? ORDER BY seq', project)).map((r) => r.seq);
    expect(seqs).toEqual(ids.map((_, i) => i + 1));
    const pulled = await sync(project, token, { cursor: 0 });
    expect(pulled.answers.map((a) => a.seq)).toEqual(seqs);
    expect(pulled.cursor).toBe(12);
    // Another project's counter is its own.
    const other = await setupProject({ [ADA]: 'answerer' });
    await seedDemo(other.project);
    expect((await as(ADA).json<AnswerResponse>('POST', `/projects/${other.project}/gaps/${PERMISSION}/answer`, { option: 'a', version: 1 })).answer.seq).toBe(
      1,
    );
  });

  it('lets exactly one of several concurrent answers to one gap win', async () => {
    const { project } = await setupProject({ [ADA]: 'answerer', [BEA]: 'answerer' });
    await seedDemo(project);
    const results = await Promise.all([
      as(ADA).post(`/projects/${project}/gaps/${PERMISSION}/answer`, { option: 'a', version: 1 }),
      as(BEA).post(`/projects/${project}/gaps/${PERMISSION}/answer`, { option: 'b', version: 1 }),
      as(ADA).post(`/projects/${project}/gaps/${PERMISSION}/answer`, { option: 'a', version: 1 }),
    ]);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await rows('SELECT id FROM answers WHERE project_id = ?', project)).toHaveLength(1);
  });
});
