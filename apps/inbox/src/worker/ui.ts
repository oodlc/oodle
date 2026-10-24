import { Hono } from 'hono';
import type {
  ActivityResponse,
  AnswerBody,
  AnswerResponse,
  ApprovalRecord,
  CreateTokenResponse,
  GapDetailResponse,
  GapRecord,
  GapsResponse,
  IntentDetailResponse,
  IntentsResponse,
  ProjectSummary,
  ProjectsResponse,
  ReviewResponse,
  Role,
  TokenRecord,
} from '../shared/protocol.ts';
import { accessAuth, requireRole } from './auth.ts';
import {
  answerStmts,
  eventStmt,
  gapAnswers,
  gapConflicts,
  intentApprovals,
  listEvents,
  listGaps,
  listIntents,
  loadGap,
  loadIntent,
  newId,
  now,
  sha256Hex,
} from './db.ts';
import { ApiError, type AppEnv } from './env.ts';
import { checkAnswer, checkVersion, readJson, sameAnswer } from './validate.ts';

const csv = (v: string | undefined) => (v ? v.split(',').filter(Boolean) : undefined);
const person = (email: string) => `person:${email}`;

async function mustGap(db: D1Database, project: string, id: string): Promise<GapRecord> {
  const gap = await loadGap(db, project, id);
  if (!gap) throw new ApiError(404, 'not_found', `No gap ${id} in "${project}".`);
  return gap;
}

/**
 * A person answered a gap someone else's answer already settles (8.5). The first answer stands;
 * this one is kept as a conflict, shown on the gap, for the first answerer to keep or take.
 */
async function recordConflict(db: D1Database, gap: GapRecord, answer: AnswerBody, by: string) {
  const standing = gap.answer;
  if (!standing) return null;
  const id = newId('c_');
  const at = now();
  await db.batch([
    db
      .prepare('INSERT INTO conflicts (id, project_id, gap_id, answer_json, answered_by, answered_at, against_answer_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(id, gap.project_id, gap.id, JSON.stringify(answer), by, at, standing.id),
    eventStmt(
      db,
      gap.project_id,
      by,
      'gap.answer_conflict',
      { gap: gap.id, conflict: id, answer, against: standing.id, standing_by: standing.answered_by },
      at,
    ),
  ]);
  return id;
}

/** Does `by` answering now clash with an answer another person already gave? */
const clashes = (gap: GapRecord, answer: AnswerBody, by: string) =>
  gap.status !== 'open' &&
  gap.answer !== null &&
  gap.answer.answered_by.startsWith('person:') &&
  gap.answer.answered_by !== by &&
  !sameAnswer(gap.answer.answer, answer);

export const ui = new Hono<AppEnv>()
  .use('*', accessAuth)

  .get('/projects', async (c) => {
    const email = c.get('email');
    const { results } = await c.env.DB.prepare(
      `SELECT p.id, p.name, p.repo_url, m.role,
         (SELECT COUNT(*) FROM gaps g WHERE g.project_id = p.id AND g.status = 'open' AND g.route = 'human') AS open_human_gaps,
         (SELECT COUNT(*) FROM intents i WHERE i.project_id = p.id AND i.status = 'in_review') AS intents_in_review
       FROM members m JOIN projects p ON p.id = m.project_id WHERE m.email = ? ORDER BY p.name`,
    )
      .bind(email)
      .all<ProjectSummary>();
    return c.json({ me: email, projects: results } satisfies ProjectsResponse);
  })

  .get('/projects/:p/gaps', async (c) => {
    const p = c.req.param('p');
    await requireRole(c.env.DB, p, c.get('email'), 'viewer');
    const gaps = await listGaps(c.env.DB, p, {
      status: csv(c.req.query('status')),
      route: c.req.query('route'),
      intent: c.req.query('intent'),
      conflicts: c.req.query('conflicts') === 'open',
    });
    return c.json({ gaps } satisfies GapsResponse);
  })

  .get('/projects/:p/gaps/:id', async (c) => {
    const p = c.req.param('p');
    const role = await requireRole(c.env.DB, p, c.get('email'), 'viewer');
    const gap = await mustGap(c.env.DB, p, c.req.param('id'));
    const [answers, conflicts] = await Promise.all([gapAnswers(c.env.DB, p, gap.id), gapConflicts(c.env.DB, p, gap.id)]);
    return c.json({ gap, answers, conflicts, role } satisfies GapDetailResponse);
  })

  .post('/projects/:p/gaps/:id/answer', async (c) => {
    const db = c.env.DB;
    const p = c.req.param('p');
    const email = c.get('email');
    await requireRole(db, p, email, 'answerer');
    const body = await readJson(c.req.raw);
    const version = checkVersion(body.version);
    let gap = await mustGap(db, p, c.req.param('id'));
    const answer = checkAnswer(
      body,
      gap.body.options.map((o) => o.id),
    );
    const by = person(email);
    if (gap.status === 'superseded') throw new ApiError(410, 'superseded', 'A later gaps run no longer raises this gap.', { gap });

    const refuse = async (current: GapRecord): Promise<never> => {
      const conflict = clashes(current, answer, by) ? await recordConflict(db, current, answer, by) : null;
      const fresh = conflict ? await mustGap(db, p, current.id) : current;
      throw new ApiError(
        409,
        conflict ? 'conflict' : 'version_mismatch',
        conflict
          ? `${current.answer?.answered_by.slice(7)} already answered this. Your answer is kept as a conflict for them to look at.`
          : 'This gap changed since you opened it. Here is the current version.',
        { gap: fresh, ...(conflict ? { conflict } : {}) },
      );
    };

    if (gap.version !== version) return refuse(gap);
    if (gap.status !== 'open' && gap.answer && sameAnswer(gap.answer.answer, answer)) {
      return c.json({ answer: gap.answer, gap } satisfies AnswerResponse);
    }
    if (clashes(gap, answer, by)) return refuse(gap);

    const id = newId('a_');
    const at = now();
    const results = await db.batch(
      answerStmts(db, {
        project: p,
        gapId: gap.id,
        version,
        id,
        answer,
        by,
        at,
        event: { gap: gap.id, answer_id: id, answer, ...(gap.answer ? { replaces: gap.answer.id } : {}) },
      }),
    );
    gap = await mustGap(db, p, gap.id);
    if (results[1]?.meta.changes !== 1) return refuse(gap);
    if (!gap.answer) throw new Error(`answer ${id} was not recorded`);
    return c.json({ answer: gap.answer, gap } satisfies AnswerResponse, 201);
  })

  .post('/projects/:p/gaps/:id/conflicts/:cid/resolve', async (c) => {
    const db = c.env.DB;
    const p = c.req.param('p');
    const email = c.get('email');
    const role = await requireRole(db, p, email, 'answerer');
    const body = await readJson(c.req.raw);
    if (body.resolution !== 'keep' && body.resolution !== 'take') throw new ApiError(400, 'bad_request', 'resolution must be keep or take.');
    const gap = await mustGap(db, p, c.req.param('id'));
    const conflict = (await gapConflicts(db, p, gap.id)).find((x) => x.id === c.req.param('cid'));
    if (!conflict) throw new ApiError(404, 'not_found', 'No such conflict on this gap.');
    if (conflict.resolved_at) throw new ApiError(409, 'resolved', 'This conflict was already resolved.', { gap });
    const by = person(email);
    if (role !== 'owner' && gap.answer?.answered_by !== by) {
      throw new ApiError(403, 'forbidden', 'Only the person whose answer stands, or a project owner, can resolve this.');
    }
    const at = now();
    const resolution = body.resolution === 'take' ? 'taken' : 'kept';
    const close = [
      db
        .prepare('UPDATE conflicts SET resolution = ?, resolved_by = ?, resolved_at = ? WHERE id = ? AND resolved_at IS NULL')
        .bind(resolution, by, at, conflict.id),
      eventStmt(db, p, by, 'conflict.resolved', { gap: gap.id, conflict: conflict.id, resolution }, at),
    ];
    if (resolution === 'kept') {
      await db.batch(close);
    } else {
      // The conflicting answer becomes the standing one, in its author's name, with a new seq.
      const id = newId('a_');
      const stmts = answerStmts(db, {
        project: p,
        gapId: gap.id,
        version: gap.version,
        id,
        answer: conflict.answer,
        by: conflict.answered_by,
        at,
        event: { gap: gap.id, answer_id: id, answer: conflict.answer, replaces: gap.answer?.id, from_conflict: conflict.id, accepted_by: by },
      });
      const results = await db.batch([...stmts, ...close]);
      if (results[1]?.meta.changes !== 1) throw new ApiError(409, 'version_mismatch', 'The gap changed meanwhile.', { gap: await mustGap(db, p, gap.id) });
    }
    return c.json({ gap: await mustGap(db, p, gap.id), conflicts: await gapConflicts(db, p, gap.id) });
  })

  .get('/projects/:p/intents', async (c) => {
    const p = c.req.param('p');
    await requireRole(c.env.DB, p, c.get('email'), 'viewer');
    return c.json({ intents: await listIntents(c.env.DB, p, csv(c.req.query('status'))) } satisfies IntentsResponse);
  })

  .get('/projects/:p/intents/:id', async (c) => {
    const p = c.req.param('p');
    const role = await requireRole(c.env.DB, p, c.get('email'), 'viewer');
    const intent = await loadIntent(c.env.DB, p, c.req.param('id'));
    if (!intent) throw new ApiError(404, 'not_found', `No intent ${c.req.param('id')} in "${p}".`);
    const [approvals, gaps] = await Promise.all([intentApprovals(c.env.DB, intent), listGaps(c.env.DB, p, { intent: intent.id })]);
    return c.json({ intent, approvals, gaps, role } satisfies IntentDetailResponse);
  })

  .post('/projects/:p/intents/:id/review', async (c) => {
    const db = c.env.DB;
    const p = c.req.param('p');
    const email = c.get('email');
    await requireRole(db, p, email, 'answerer');
    const body = await readJson(c.req.raw);
    const decision = body.decision;
    if (decision !== 'approve' && decision !== 'reject') throw new ApiError(400, 'bad_request', 'decision must be approve or reject.');
    if (typeof body.content_hash !== 'string') throw new ApiError(400, 'bad_request', 'content_hash (of the intent you reviewed) is required.');
    const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim() : null;
    const intentId = c.req.param('id');
    const intent = await loadIntent(db, p, intentId);
    if (!intent) throw new ApiError(404, 'not_found', `No intent ${intentId} in "${p}".`);

    const stale = () => new ApiError(409, 'stale', 'The intent changed since you read it. Review the current version.', { intent });
    if (intent.content_hash !== body.content_hash) throw stale();
    const openGaps = async () =>
      (await db.prepare("SELECT COUNT(*) AS n FROM gaps WHERE project_id = ? AND intent_id = ? AND status = 'open'").bind(p, intentId).first<{ n: number }>())
        ?.n ?? 0;
    const blocked = (n: number) =>
      new ApiError(409, 'open_gaps', `${n} question(s) this intent raised are still open. Answer them before approving.`, { intent });
    if (decision === 'approve') {
      const n = await openGaps();
      if (n > 0) throw blocked(n);
    }

    // Guarded so the content check (and, for approve, the open-gaps check) holds inside the transaction.
    const guard = `EXISTS (SELECT 1 FROM intents WHERE project_id = ? AND id = ? AND content_hash = ?)${
      decision === 'approve' ? " AND NOT EXISTS (SELECT 1 FROM gaps WHERE project_id = ? AND intent_id = ? AND status = 'open')" : ''
    }`;
    const g = decision === 'approve' ? [p, intentId, body.content_hash, p, intentId] : [p, intentId, body.content_hash];
    const id = newId('r_');
    const at = now();
    const by = person(email);
    const results = await db.batch([
      db.prepare('INSERT OR IGNORE INTO counters (project_id, seq) VALUES (?, 0)').bind(p),
      db.prepare(`UPDATE counters SET seq = seq + 1 WHERE project_id = ? AND ${guard}`).bind(p, ...g),
      db
        .prepare(
          `INSERT INTO approvals (id, project_id, intent_id, content_hash, decision, by_email, at, note, seq)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, seq FROM counters WHERE project_id = ? AND ${guard}`,
        )
        .bind(id, p, intentId, body.content_hash, decision, email, at, note, p, ...g),
      db
        .prepare(`UPDATE intents SET status = ?, updated_at = ? WHERE project_id = ? AND id = ? AND EXISTS (SELECT 1 FROM approvals WHERE id = ?)`)
        .bind(decision === 'approve' ? 'approved' : 'rejected', at, p, intentId, id),
      db
        .prepare(
          `INSERT INTO events (id, project_id, at, actor, type, data_json)
           SELECT ?, ?, ?, ?, 'intent.reviewed', ? WHERE EXISTS (SELECT 1 FROM approvals WHERE id = ?)`,
        )
        .bind(newId('e_'), p, at, by, JSON.stringify({ intent: intentId, decision, content_hash: body.content_hash, note, approval: id }), id),
    ]);
    if (results[2]?.meta.changes !== 1) {
      const current = await loadIntent(db, p, intentId);
      if (current && current.content_hash !== body.content_hash)
        throw new ApiError(409, 'stale', 'The intent changed while you reviewed it.', { intent: current });
      throw blocked(await openGaps());
    }
    const updated = await loadIntent(db, p, intentId);
    if (!updated) throw new Error(`intent ${intentId} vanished`);
    const approval = (await intentApprovals(db, updated)).find((a) => a.id === id) as ApprovalRecord;
    return c.json({ approval, intent: updated } satisfies ReviewResponse, 201);
  })

  .get('/projects/:p/activity', async (c) => {
    const p = c.req.param('p');
    await requireRole(c.env.DB, p, c.get('email'), 'viewer');
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 200) || 200, 1), 1000);
    const events = await listEvents(c.env.DB, p, { type: c.req.query('type') || undefined, actor: c.req.query('actor') || undefined, limit });
    return c.json({ events } satisfies ActivityResponse);
  })

  .get('/projects/:p/tokens', async (c) => {
    const p = c.req.param('p');
    await requireRole(c.env.DB, p, c.get('email'), 'owner');
    const { results } = await c.env.DB.prepare('SELECT id, label, created_by, created_at, revoked_at FROM tokens WHERE project_id = ? ORDER BY created_at')
      .bind(p)
      .all<TokenRecord>();
    return c.json({ tokens: results });
  })

  .post('/projects/:p/tokens', async (c) => {
    const db = c.env.DB;
    const p = c.req.param('p');
    const email = c.get('email');
    await requireRole(db, p, email, 'owner');
    const body = await readJson(c.req.raw);
    const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim() : null;
    const token = newToken();
    const id = newId('t_');
    const at = now();
    await db.batch([
      db
        .prepare('INSERT INTO tokens (id, project_id, hash, label, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(id, p, await sha256Hex(token), label, person(email), at),
      eventStmt(db, p, person(email), 'token.created', { token: id, label }, at),
    ]);
    return c.json({ id, token, label } satisfies CreateTokenResponse, 201);
  })

  .delete('/projects/:p/tokens/:tid', async (c) => {
    const db = c.env.DB;
    const p = c.req.param('p');
    const email = c.get('email');
    await requireRole(db, p, email, 'owner');
    const at = now();
    const [res] = await db.batch([
      db.prepare('UPDATE tokens SET revoked_at = ? WHERE project_id = ? AND id = ? AND revoked_at IS NULL').bind(at, p, c.req.param('tid')),
      eventStmt(db, p, person(email), 'token.revoked', { token: c.req.param('tid') }, at),
    ]);
    if (res?.meta.changes !== 1) throw new ApiError(404, 'not_found', 'No such active token.');
    return c.json({ revoked: c.req.param('tid') });
  })

  .get('/projects/:p/members', async (c) => {
    const p = c.req.param('p');
    await requireRole(c.env.DB, p, c.get('email'), 'viewer');
    const { results } = await c.env.DB.prepare('SELECT email, role FROM members WHERE project_id = ? ORDER BY email')
      .bind(p)
      .all<{ email: string; role: Role }>();
    return c.json({ members: results });
  })

  .post('/projects/:p/members', async (c) => {
    const db = c.env.DB;
    const p = c.req.param('p');
    const email = c.get('email');
    await requireRole(db, p, email, 'owner');
    const body = await readJson(c.req.raw);
    const who = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!who.includes('@')) throw new ApiError(400, 'bad_request', 'email is required.');
    if (body.role !== 'owner' && body.role !== 'answerer' && body.role !== 'viewer')
      throw new ApiError(400, 'bad_request', 'role must be owner, answerer or viewer.');
    await db.batch([
      db
        .prepare('INSERT INTO members (project_id, email, role) VALUES (?, ?, ?) ON CONFLICT (project_id, email) DO UPDATE SET role = excluded.role')
        .bind(p, who, body.role),
      eventStmt(db, p, person(email), 'member.set', { email: who, role: body.role }),
    ]);
    return c.json({ email: who, role: body.role }, 201);
  });

/** `oodle_` and 32 random bytes as hex. Shown once; only its hash is stored. */
export function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `oodle_${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}
