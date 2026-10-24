import { beforeAll, describe, expect, it } from 'vitest';
import type { ErrorResponse, IntentDetailResponse, IntentsResponse, ReviewResponse } from '../src/shared/protocol.ts';
import { as, CANCEL_FEE, CANCEL_RULE, dogwalk, mockAccessJwks, rows, setupProject, sync } from './helpers.ts';

beforeAll(mockAccessJwks);

const JO = 'jo@x.test';

async function project() {
  const p = await setupProject({ [JO]: 'answerer' });
  await sync(p.project, p.token, { push: dogwalk() });
  return p;
}
const review = (p: string, body: unknown) => as(JO).post(`/projects/${p}/intents/${CANCEL_FEE}/review`, body);

describe('intent review', () => {
  it('shows the intent with its raised gaps', async () => {
    const { project: p } = await project();
    const list = await as(JO).json<IntentsResponse>('GET', `/projects/${p}/intents?status=in_review`);
    expect(list.intents.map((i) => i.id)).toEqual([CANCEL_FEE]);
    const detail = await as(JO).json<IntentDetailResponse>('GET', `/projects/${p}/intents/${CANCEL_FEE}`);
    expect(detail.intent.body.title).toBe('Charge half price for late cancellations');
    expect(detail.gaps.map((g) => g.id)).toEqual([CANCEL_RULE]);
    expect(detail.approvals).toEqual([]);
  });

  it('refuses approval while a gap the intent raised is open, then approves once it is answered', async () => {
    const { project: p, token } = await project();
    const blocked = await review(p, { decision: 'approve', content_hash: 'ih_cancel_fee_1' });
    expect(blocked.status).toBe(409);
    expect(((await blocked.json()) as ErrorResponse).error).toBe('open_gaps');

    await as(JO).post(`/projects/${p}/gaps/${CANCEL_RULE}/answer`, { option: 'a', version: 1 });
    const ok = await review(p, { decision: 'approve', content_hash: 'ih_cancel_fee_1', note: 'Fair to walkers.' });
    expect(ok.status).toBe(201);
    const { approval, intent } = (await ok.json()) as ReviewResponse;
    expect(approval).toMatchObject({ decision: 'approve', by_email: JO, content_hash: 'ih_cancel_fee_1', note: 'Fair to walkers.', seq: 2, current: true });
    expect(intent.status).toBe('approved');

    const pulled = await sync(p, token, { cursor: 0 });
    expect(pulled.answers.map((a) => a.seq)).toEqual([1]);
    expect(pulled.approvals).toEqual([
      expect.objectContaining({ intent_id: CANCEL_FEE, content_hash: 'ih_cancel_fee_1', decision: 'approve', by: JO, seq: 2 }),
    ]);
    expect(pulled.cursor).toBe(2);
    expect(await rows("SELECT id FROM events WHERE project_id = ? AND type = 'intent.reviewed'", p)).toHaveLength(1);
  });

  it('allows rejecting with open gaps', async () => {
    const { project: p } = await project();
    const res = await review(p, { decision: 'reject', content_hash: 'ih_cancel_fee_1', note: 'Not this quarter.' });
    expect(res.status).toBe(201);
    expect(((await res.json()) as ReviewResponse).intent.status).toBe('rejected');
  });

  it('refuses a review of content that has since changed', async () => {
    const { project: p } = await project();
    const res = await review(p, { decision: 'reject', content_hash: 'ih_cancel_fee_0' });
    expect(res.status).toBe(409);
    const body = (await res.json()) as ErrorResponse;
    expect(body.error).toBe('stale');
    expect(body.intent?.content_hash).toBe('ih_cancel_fee_1');
    expect(await rows('SELECT id FROM approvals WHERE project_id = ?', p)).toEqual([]);
  });

  it('marks an approval stale when the intent changes after it', async () => {
    const { project: p, token } = await project();
    await as(JO).post(`/projects/${p}/gaps/${CANCEL_RULE}/answer`, { option: 'a', version: 1 });
    await review(p, { decision: 'approve', content_hash: 'ih_cancel_fee_1' });

    const edited = dogwalk().intents[0];
    if (!edited) throw new Error('fixture has no intent');
    edited.content_hash = 'ih_cancel_fee_2';
    edited.body.changes = [{ op: 'replace_rule', entity: 'walk', from: 'An owner can cancel for free until 2 hours before starts_at', to: 'They pay 100%' }];
    await sync(p, token, { push: { intents: [edited] } });

    const detail = await as(JO).json<IntentDetailResponse>('GET', `/projects/${p}/intents/${CANCEL_FEE}`);
    expect(detail.intent.status).toBe('in_review');
    expect(detail.approvals).toHaveLength(1);
    expect(detail.approvals[0]?.current).toBe(false);
    // The pulled approval names the old hash, so the CLI can tell it no longer counts.
    const pulled = await sync(p, token, { cursor: 0 });
    expect(pulled.approvals[0]?.content_hash).toBe('ih_cancel_fee_1');
    // Approving the new content works and binds to the new hash.
    const again = await review(p, { decision: 'approve', content_hash: 'ih_cancel_fee_2' });
    expect(((await again.json()) as ReviewResponse).approval.content_hash).toBe('ih_cancel_fee_2');
  });
});
