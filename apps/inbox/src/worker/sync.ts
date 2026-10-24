import { Hono } from 'hono';
import type { AnswerBody, GapFile, GapStatus, PulledAnswer, PulledApproval, SyncResponse } from '../shared/protocol.ts';
import { tokenAuth } from './auth.ts';
import { eventStmt, newId, now } from './db.ts';
import { ApiError, type AppEnv } from './env.ts';
import { checkGapFile, checkIntentFile, readJson } from './validate.ts';

export const REOPEN_NOTE = 'The evidence changed after this was answered. Check the answer still holds, then answer again.';

type Existing = { content_hash: string; status: GapStatus; answer_id: string | null; version: number; dismissed: number; acked: number };

/** The status a pushed gap gets when its file already carries an answer (settled locally). */
function settledStatus(body: GapFile): GapStatus {
  if (body.route === 'agent' || body.applied_in) return 'applied';
  return body.status === 'dismissed' ? 'dismissed' : 'answered';
}

/** What a gap with a standing remote answer is, on its own. */
const statusFromAnswer = (e: Existing): GapStatus => (e.acked ? 'applied' : e.dismissed ? 'dismissed' : 'answered');

/**
 * POST /api/v1/projects/:project/sync (10.3). Push, then pull. The push is validated as a whole
 * before anything is written, and written in one D1 batch. Tokens never create answers or approvals.
 */
export const sync = new Hono<AppEnv>().post('/projects/:project/sync', tokenAuth, async (c) => {
  const project = c.req.param('project');
  const db = c.env.DB;
  const actor = `token:${c.get('tokenId')}`;
  const req = await readJson(c.req.raw);

  const cursor = req.cursor ?? 0;
  if (typeof cursor !== 'number' || !Number.isInteger(cursor) || cursor < 0) throw new ApiError(400, 'bad_request', 'cursor must be a whole number.');
  const push = (req.push ?? {}) as Record<string, unknown>;
  const list = (key: string): unknown[] => {
    const v = push[key] ?? [];
    if (!Array.isArray(v)) throw new ApiError(400, 'bad_request', `push.${key} must be a list.`);
    return v;
  };
  const item = (v: unknown, key: string) => {
    if (typeof v !== 'object' || v === null) throw new ApiError(400, 'bad_request', `push.${key} entries must be objects.`);
    const o = v as Record<string, unknown>;
    if (typeof o.id !== 'string' || typeof o.content_hash !== 'string') throw new ApiError(400, 'bad_request', `push.${key} entries need id and content_hash.`);
    return { id: o.id, content_hash: o.content_hash, body: o.body };
  };

  const gaps = list('gaps').map((g) => {
    const it = item(g, 'gaps');
    const body = checkGapFile(it.id, it.body);
    if (body.route === 'human' && body.answer != null && !body.answered_by?.startsWith('person:')) {
      throw new ApiError(403, 'token_cannot_answer', `Gap ${it.id} is for people; a token cannot carry an answer by ${body.answered_by ?? 'nobody'}.`);
    }
    return { ...it, body };
  });
  const intents = list('intents').map((i) => {
    const it = item(i, 'intents');
    return { ...it, body: checkIntentFile(it.id, it.body) };
  });
  const applied = list('applied').map((a) => {
    const o = a as Record<string, unknown>;
    if (typeof o?.answer_id !== 'string' || typeof o.sha !== 'string') throw new ApiError(400, 'bad_request', 'push.applied entries need answer_id and sha.');
    return { answer_id: o.answer_id, sha: o.sha };
  });
  const superseded = list('superseded_gaps').map((s) => {
    if (typeof s !== 'string') throw new ApiError(400, 'bad_request', 'push.superseded_gaps must be gap ids.');
    return s;
  });

  const at = now();
  const stmts: D1PreparedStatement[] = [];

  if (gaps.length) {
    const { results } = await db
      .prepare(
        `SELECT g.id, g.content_hash, g.status, g.answer_id, g.version,
           json_extract(a.answer_json, '$.dismiss') IS NOT NULL AS dismissed, a.acked_at IS NOT NULL AS acked
         FROM gaps g LEFT JOIN answers a ON a.id = g.answer_id WHERE g.project_id = ?`,
      )
      .bind(project)
      .all<Existing & { id: string }>();
    const existing = new Map(results.map((r) => [r.id, r]));

    for (const { id, content_hash, body } of gaps) {
      const prev = existing.get(id);
      const settled = body.answer != null;
      const intentId = body.intent_id ?? (body as { intent?: string }).intent ?? null;
      const fields = [body.route, body.tier, body.kind, body.question, JSON.stringify(body), body.spec_hash, intentId] as const;

      if (!prev) {
        const status = settled ? settledStatus(body) : 'open';
        stmts.push(
          db
            .prepare(
              `INSERT INTO gaps (project_id, id, content_hash, status, route, tier, kind, question, body_json, spec_hash, intent_id, version, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
            )
            .bind(project, id, content_hash, status, ...fields, at, at),
          eventStmt(db, project, actor, settled ? 'gap.settled_locally' : 'gap.created', settledData(id, body, status), at),
        );
        continue;
      }

      const update = (status: GapStatus, note: string | null, type: string) =>
        stmts.push(
          db
            .prepare(
              `UPDATE gaps SET content_hash = ?, status = ?, route = ?, tier = ?, kind = ?, question = ?, body_json = ?, spec_hash = ?, intent_id = ?,
                 note = ?, version = version + 1, updated_at = ?
               WHERE project_id = ? AND id = ? AND version = ?`,
            )
            .bind(content_hash, status, ...fields, note, at, project, id, prev.version),
          eventStmt(db, project, actor, type, { gap: id, status, ...(settled ? settledData(id, body, status) : {}) }, at),
        );

      if (prev.content_hash === content_hash) {
        if (prev.status === 'superseded') update(settled ? settledStatus(body) : prev.answer_id ? statusFromAnswer(prev) : 'open', null, 'gap.raised_again');
        // Same content, now settled locally, and nobody answered it here: record the settlement.
        else if (settled && prev.status === 'open' && !prev.answer_id) update(settledStatus(body), null, 'gap.settled_locally');
        continue;
      }
      // The evidence changed. A person's answer here stays, but they should confirm it (10.3);
      // an agent gap that arrives settled again is just recorded.
      if (prev.answer_id && !(settled && body.route === 'agent')) update('open', REOPEN_NOTE, 'gap.reopened');
      else if (settled) update(settledStatus(body), null, 'gap.settled_locally');
      else update('open', null, 'gap.updated');
    }
  }

  for (const { id, content_hash, body } of intents) {
    const prev = await db.prepare('SELECT content_hash FROM intents WHERE project_id = ? AND id = ?').bind(project, id).first<{ content_hash: string }>();
    if (prev?.content_hash === content_hash) continue;
    stmts.push(
      prev
        ? db
            .prepare('UPDATE intents SET status = ?, body_json = ?, content_hash = ?, updated_at = ? WHERE project_id = ? AND id = ?')
            .bind(body.status, JSON.stringify(body), content_hash, at, project, id)
        : db
            .prepare('INSERT INTO intents (project_id, id, status, body_json, content_hash, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
            .bind(project, id, body.status, JSON.stringify(body), content_hash, at),
      eventStmt(db, project, actor, prev ? 'intent.updated' : 'intent.created', { intent: id, status: body.status, content_hash }, at),
    );
  }

  for (const { answer_id, sha } of applied) {
    stmts.push(
      db.prepare('UPDATE answers SET applied_sha = ?, acked_at = ? WHERE project_id = ? AND id = ? AND acked_at IS NULL').bind(sha, at, project, answer_id),
      db
        .prepare(
          "UPDATE gaps SET status = 'applied', version = version + 1, updated_at = ? WHERE project_id = ? AND answer_id = ? AND status IN ('answered', 'dismissed')",
        )
        .bind(at, project, answer_id),
      db
        .prepare(
          `INSERT INTO events (id, project_id, at, actor, type, data_json)
           SELECT ?, ?, ?, ?, 'answer.applied', json_object('answer', id, 'gap', gap_id, 'sha', applied_sha)
           FROM answers WHERE project_id = ? AND id = ? AND acked_at = ?`,
        )
        .bind(newId('e_'), project, at, actor, project, answer_id, at),
    );
  }

  for (const id of superseded) {
    stmts.push(
      db
        .prepare(
          "UPDATE gaps SET status = 'superseded', version = version + 1, updated_at = ? WHERE project_id = ? AND id = ? AND status IN ('open', 'answered', 'dismissed')",
        )
        .bind(at, project, id),
      db
        .prepare(
          `INSERT INTO events (id, project_id, at, actor, type, data_json)
           SELECT ?, ?, ?, ?, 'gap.superseded', json_object('gap', id) FROM gaps
           WHERE project_id = ? AND id = ? AND status = 'superseded' AND updated_at = ?`,
        )
        .bind(newId('e_'), project, at, actor, project, id, at),
    );
  }

  if (stmts.length) await db.batch(stmts);

  const [answers, approvals] = await db.batch<Record<string, unknown>>([
    db
      .prepare('SELECT id, gap_id, answer_json, answered_by, answered_at, seq FROM answers WHERE project_id = ? AND seq > ? ORDER BY seq')
      .bind(project, cursor),
    db
      .prepare('SELECT id, intent_id, content_hash, decision, by_email, at, note, seq FROM approvals WHERE project_id = ? AND seq > ? ORDER BY seq')
      .bind(project, cursor),
  ]);
  const res: SyncResponse = {
    answers: (answers?.results ?? []).map(
      (r): PulledAnswer => ({
        id: r.id as string,
        gap_id: r.gap_id as string,
        answer: JSON.parse(r.answer_json as string) as AnswerBody,
        answered_by: r.answered_by as string,
        seq: r.seq as number,
        answered_at: r.answered_at as string,
      }),
    ),
    approvals: (approvals?.results ?? []).map(
      (r): PulledApproval => ({
        intent_id: r.intent_id as string,
        content_hash: r.content_hash as string,
        decision: r.decision as 'approve' | 'reject',
        by: r.by_email as string,
        seq: r.seq as number,
        id: r.id as string,
        at: r.at as string,
        note: r.note as string | null,
      }),
    ),
    cursor,
  };
  res.cursor = Math.max(cursor, ...res.answers.map((a) => a.seq), ...res.approvals.map((a) => a.seq));
  return c.json(res);
});

function settledData(id: string, body: GapFile, status: GapStatus): Record<string, unknown> {
  return body.answer != null ? { gap: id, status, answer: body.answer, answered_by: body.answered_by, applied_in: body.applied_in } : { gap: id, status };
}
