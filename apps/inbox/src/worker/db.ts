import type {
  AnswerBody,
  AnswerRecord,
  ApprovalRecord,
  ConflictRecord,
  EventRecord,
  GapFile,
  GapKind,
  GapRecord,
  GapStatus,
  IntentFile,
  IntentRecord,
  IntentStatus,
  Route,
  Tier,
} from '../shared/protocol.ts';

export const now = () => new Date().toISOString();

/** `prefix` and 16 random hex characters, e.g. `a_3f9c0d1e2b4a5c6d`. */
export const newId = (prefix: string) => `${prefix}${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** An append to the audit log. Every write the API makes comes with one of these, in the same batch. */
export function eventStmt(db: D1Database, project: string, actor: string, type: string, data: Record<string, unknown>, at = now()) {
  return db
    .prepare('INSERT INTO events (id, project_id, at, actor, type, data_json) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(newId('e_'), project, at, actor, type, JSON.stringify(data));
}

/**
 * Statements that record a new answer, in order, for one D1 batch (a transaction).
 * The gap only moves if it is still at `version`; the counter, the answer row and the event
 * are each guarded on the gap now pointing at this answer, so a lost race writes nothing.
 * The caller checks `results[1].meta.changes === 1`.
 */
export function answerStmts(
  db: D1Database,
  a: { project: string; gapId: string; version: number; id: string; answer: AnswerBody; by: string; at: string; event: Record<string, unknown> },
) {
  const status: GapStatus = 'dismiss' in a.answer ? 'dismissed' : 'answered';
  const pointsHere = 'EXISTS (SELECT 1 FROM gaps WHERE project_id = ? AND id = ? AND answer_id = ?)';
  return [
    db.prepare('INSERT OR IGNORE INTO counters (project_id, seq) VALUES (?, 0)').bind(a.project),
    db
      .prepare('UPDATE gaps SET status = ?, answer_id = ?, note = NULL, version = version + 1, updated_at = ? WHERE project_id = ? AND id = ? AND version = ?')
      .bind(status, a.id, a.at, a.project, a.gapId, a.version),
    db.prepare(`UPDATE counters SET seq = seq + 1 WHERE project_id = ? AND ${pointsHere}`).bind(a.project, a.project, a.gapId, a.id),
    db
      .prepare(
        `INSERT INTO answers (id, project_id, gap_id, answer_json, answered_by, answered_at, seq)
         SELECT ?, ?, ?, ?, ?, ?, seq FROM counters WHERE project_id = ? AND ${pointsHere}`,
      )
      .bind(a.id, a.project, a.gapId, JSON.stringify(a.answer), a.by, a.at, a.project, a.project, a.gapId, a.id),
    db
      .prepare(`INSERT INTO events (id, project_id, at, actor, type, data_json) SELECT ?, ?, ?, ?, 'gap.answered', ? WHERE ${pointsHere}`)
      .bind(newId('e_'), a.project, a.at, a.by, JSON.stringify(a.event), a.project, a.gapId, a.id),
  ];
}

// ---------------------------------------------------------------- reading rows

type GapRow = {
  project_id: string;
  id: string;
  content_hash: string;
  status: GapStatus;
  route: Route;
  tier: Tier;
  kind: GapKind;
  question: string;
  body_json: string;
  spec_hash: string;
  intent_id: string | null;
  answer_id: string | null;
  note: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  open_conflicts: number;
  a_id: string | null;
  a_json: string | null;
  a_by: string | null;
  a_at: string | null;
  a_seq: number | null;
  a_sha: string | null;
  a_acked: string | null;
};

const GAP_SELECT = `
  SELECT g.*,
    (SELECT COUNT(*) FROM conflicts c WHERE c.project_id = g.project_id AND c.gap_id = g.id AND c.resolved_at IS NULL) AS open_conflicts,
    a.id AS a_id, a.answer_json AS a_json, a.answered_by AS a_by, a.answered_at AS a_at, a.seq AS a_seq,
    a.applied_sha AS a_sha, a.acked_at AS a_acked
  FROM gaps g LEFT JOIN answers a ON a.id = g.answer_id`;

function toGap(r: GapRow): GapRecord {
  return {
    project_id: r.project_id,
    id: r.id,
    status: r.status,
    route: r.route,
    tier: r.tier,
    kind: r.kind,
    question: r.question,
    intent_id: r.intent_id,
    spec_hash: r.spec_hash,
    content_hash: r.content_hash,
    version: r.version,
    note: r.note,
    created_at: r.created_at,
    updated_at: r.updated_at,
    body: JSON.parse(r.body_json) as GapFile,
    open_conflicts: r.open_conflicts,
    answer:
      r.a_id && r.a_json && r.a_by && r.a_at && r.a_seq !== null
        ? {
            id: r.a_id,
            gap_id: r.id,
            answer: JSON.parse(r.a_json) as AnswerBody,
            answered_by: r.a_by,
            answered_at: r.a_at,
            seq: r.a_seq,
            applied_sha: r.a_sha,
            acked_at: r.a_acked,
          }
        : null,
  };
}

export async function loadGap(db: D1Database, project: string, id: string): Promise<GapRecord | null> {
  const row = await db.prepare(`${GAP_SELECT} WHERE g.project_id = ? AND g.id = ?`).bind(project, id).first<GapRow>();
  return row ? toGap(row) : null;
}

export type GapFilter = { status?: string[]; route?: string; intent?: string; conflicts?: boolean };

export async function listGaps(db: D1Database, project: string, f: GapFilter = {}): Promise<GapRecord[]> {
  const where = ['g.project_id = ?'];
  const params: unknown[] = [project];
  if (f.status?.length) {
    where.push(`g.status IN (${f.status.map(() => '?').join(', ')})`);
    params.push(...f.status);
  }
  if (f.route) {
    where.push('g.route = ?');
    params.push(f.route);
  }
  if (f.intent) {
    where.push('g.intent_id = ?');
    params.push(f.intent);
  }
  if (f.conflicts) where.push('EXISTS (SELECT 1 FROM conflicts c WHERE c.project_id = g.project_id AND c.gap_id = g.id AND c.resolved_at IS NULL)');
  const { results } = await db
    .prepare(`${GAP_SELECT} WHERE ${where.join(' AND ')} ORDER BY g.created_at, g.id`)
    .bind(...params)
    .all<GapRow>();
  return results.map(toGap);
}

type AnswerRow = {
  id: string;
  gap_id: string;
  answer_json: string;
  answered_by: string;
  answered_at: string;
  seq: number;
  applied_sha: string | null;
  acked_at: string | null;
};

export const toAnswer = (r: AnswerRow): AnswerRecord => ({
  id: r.id,
  gap_id: r.gap_id,
  answer: JSON.parse(r.answer_json) as AnswerBody,
  answered_by: r.answered_by,
  answered_at: r.answered_at,
  seq: r.seq,
  applied_sha: r.applied_sha,
  acked_at: r.acked_at,
});

export async function gapAnswers(db: D1Database, project: string, gapId: string): Promise<AnswerRecord[]> {
  const { results } = await db.prepare('SELECT * FROM answers WHERE project_id = ? AND gap_id = ? ORDER BY seq').bind(project, gapId).all<AnswerRow>();
  return results.map(toAnswer);
}

type ConflictRow = Omit<ConflictRecord, 'answer'> & { answer_json: string };

export async function gapConflicts(db: D1Database, project: string, gapId: string): Promise<ConflictRecord[]> {
  const { results } = await db
    .prepare('SELECT * FROM conflicts WHERE project_id = ? AND gap_id = ? ORDER BY answered_at, id')
    .bind(project, gapId)
    .all<ConflictRow>();
  return results.map(({ answer_json, ...r }) => ({
    id: r.id,
    gap_id: r.gap_id,
    answer: JSON.parse(answer_json) as AnswerBody,
    answered_by: r.answered_by,
    answered_at: r.answered_at,
    against_answer_id: r.against_answer_id,
    resolution: r.resolution,
    resolved_by: r.resolved_by,
    resolved_at: r.resolved_at,
  }));
}

type IntentRow = { project_id: string; id: string; status: IntentStatus; body_json: string; content_hash: string; updated_at: string };

const toIntent = (r: IntentRow): IntentRecord => ({
  project_id: r.project_id,
  id: r.id,
  status: r.status,
  content_hash: r.content_hash,
  updated_at: r.updated_at,
  body: JSON.parse(r.body_json) as IntentFile,
});

export async function loadIntent(db: D1Database, project: string, id: string): Promise<IntentRecord | null> {
  const row = await db.prepare('SELECT * FROM intents WHERE project_id = ? AND id = ?').bind(project, id).first<IntentRow>();
  return row ? toIntent(row) : null;
}

export async function listIntents(db: D1Database, project: string, status?: string[]): Promise<IntentRecord[]> {
  const params: unknown[] = [project];
  let sql = 'SELECT * FROM intents WHERE project_id = ?';
  if (status?.length) {
    sql += ` AND status IN (${status.map(() => '?').join(', ')})`;
    params.push(...status);
  }
  const { results } = await db
    .prepare(`${sql} ORDER BY updated_at DESC, id`)
    .bind(...params)
    .all<IntentRow>();
  return results.map(toIntent);
}

type ApprovalRow = Omit<ApprovalRecord, 'current'>;

export async function intentApprovals(db: D1Database, intent: IntentRecord): Promise<ApprovalRecord[]> {
  const { results } = await db
    .prepare('SELECT id, intent_id, content_hash, decision, by_email, at, note, seq FROM approvals WHERE project_id = ? AND intent_id = ? ORDER BY seq')
    .bind(intent.project_id, intent.id)
    .all<ApprovalRow>();
  return results.map((r) => ({ ...r, current: r.content_hash === intent.content_hash }));
}

type EventRow = { id: string; at: string; actor: string; type: string; data_json: string };

export async function listEvents(db: D1Database, project: string, f: { type?: string; actor?: string; limit: number }): Promise<EventRecord[]> {
  const where = ['project_id = ?'];
  const params: unknown[] = [project];
  if (f.type) {
    where.push("(type = ? OR type LIKE ? || '.%')");
    params.push(f.type, f.type);
  }
  if (f.actor) {
    where.push('actor LIKE ?');
    params.push(`%${f.actor}%`);
  }
  params.push(f.limit);
  const { results } = await db
    .prepare(`SELECT id, at, actor, type, data_json FROM events WHERE ${where.join(' AND ')} ORDER BY rowid DESC LIMIT ?`)
    .bind(...params)
    .all<EventRow>();
  return results.map((r) => ({ id: r.id, at: r.at, actor: r.actor, type: r.type, data: JSON.parse(r.data_json) as Record<string, unknown> }));
}
