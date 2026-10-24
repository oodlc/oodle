/**
 * `oodle sync`: push, pull, apply. Push every gap and intent (the inbox ignores what didn't
 * change), the answers applied since the last sync, and gaps that went away. Pull answers and
 * approvals after the cursor. Apply each answer in seq order, commit, and report it as applied on
 * the next sync. The cursor lives in `.oodle/sync.json`; pulling the same answer twice is harmless
 * because applying is idempotent by answer id.
 *
 * Without a remote, sync does nothing and says so. Nothing else depends on it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { contentHash, type Gap, readGaps } from '@oodle/gaps';
import { type Config, loadSpec, specHash } from '@oodle/spec';
import { AnswerRefused, applyAnswer, recordApplied } from './apply.ts';
import { dirty, headSha } from './git.ts';

export const CLIENT_VERSION = '0.1.0';

export interface SyncState {
  cursor: number;
  /** Applied answers the inbox hasn't heard about yet. */
  pending: { answer_id: string; sha: string; gap: string }[];
  /** Gaps a gaps run removed, to tell the inbox. */
  superseded: string[];
  /** Answers already applied, by inbox answer id. */
  applied: string[];
  last_sync?: string;
}

export const statePath = (root: string) => join(root, '.oodle', 'sync.json');

export function readState(root: string): SyncState {
  const p = statePath(root);
  const s = existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as Partial<SyncState>) : {};
  return {
    cursor: s.cursor ?? 0,
    pending: s.pending ?? [],
    superseded: s.superseded ?? [],
    applied: s.applied ?? [],
    ...(s.last_sync ? { last_sync: s.last_sync } : {}),
  };
}

export function writeState(root: string, s: SyncState) {
  mkdirSync(join(root, '.oodle'), { recursive: true });
  writeFileSync(statePath(root), `${JSON.stringify(s, null, 2)}\n`);
}

/** Notes gaps a run removed, so the next sync tells the inbox. */
export function noteSuperseded(root: string, ids: string[]) {
  if (!ids.length) return;
  const s = readState(root);
  writeState(root, { ...s, superseded: [...new Set([...s.superseded, ...ids])] });
}

export interface IntentForSync {
  id: string;
  content_hash: string;
  body: Record<string, unknown>;
}

export interface Approval {
  intent_id: string;
  content_hash: string;
  decision: 'approve' | 'reject';
  by: string;
  seq: number;
  at?: string;
  note?: string | null;
}

export interface SyncOptions {
  config: Config;
  token?: string;
  fetch?: typeof fetch;
  /** Intents to push, and what to do with approvals pulled for them (phase 9). */
  intents?: IntentForSync[];
  onApproval?: (a: Approval) => void | Promise<void>;
  commit?: boolean;
}

export interface SyncResult {
  skipped?: string;
  pushed: { gaps: number; intents: number; applied: number; superseded: number };
  pulled: { answers: number; approvals: number };
  applied: { gap: string; answer: string; sha?: string }[];
  refused: { gap: string; answer: string; why: string }[];
  cursor: number;
}

/** What blocks applying answers: spec files changed and not committed (gap files and compiled output don't count). */
export function uncommittedSpec(root: string): string[] {
  return dirty(root, 'oodle').filter((l) => !/oodle\/(gaps|compiled)\//.test(l));
}

export async function sync(root: string, opts: SyncOptions): Promise<SyncResult> {
  const empty: SyncResult = {
    pushed: { gaps: 0, intents: 0, applied: 0, superseded: 0 },
    pulled: { answers: 0, approvals: 0 },
    applied: [],
    refused: [],
    cursor: 0,
  };
  const remote = opts.config.remote;
  if (!remote) return { ...empty, skipped: 'No remote in oodle/oodle.config.yaml; nothing to sync.' };
  if (!opts.token) return { ...empty, skipped: 'No token: run `oodle login` or set OODLE_TOKEN.' };

  const state = readState(root);
  const gaps = readGaps(root);
  const body = {
    client: { version: CLIENT_VERSION, spec_hash: specHash(loadSpec(root).spec), ...(headSha(root) ? { git_sha: headSha(root) } : {}) },
    push: {
      gaps: gaps.map((g) => ({ id: g.id, content_hash: contentHash(g), body: g })),
      intents: opts.intents ?? [],
      applied: state.pending.map(({ answer_id, sha }) => ({ answer_id, sha })),
      superseded_gaps: state.superseded,
    },
    cursor: state.cursor,
  };
  const doFetch = opts.fetch ?? fetch;
  const res = await doFetch(new URL(`/api/v1/projects/${encodeURIComponent(remote.project)}/sync`, remote.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`The inbox answered ${res.status}: ${await res.text()}`);
  const pulled = (await res.json()) as {
    answers: { id: string; gap_id: string; answer: Gap['answer']; answered_by: string; seq: number; answered_at?: string }[];
    approvals: Approval[];
    cursor: number;
  };

  const result: SyncResult = {
    pushed: { gaps: body.push.gaps.length, intents: body.push.intents.length, applied: body.push.applied.length, superseded: body.push.superseded_gaps.length },
    pulled: { answers: pulled.answers.length, approvals: pulled.approvals.length },
    applied: [],
    refused: [],
    cursor: state.cursor,
  };
  // What was pushed has been heard.
  const next: SyncState = { ...state, pending: [], superseded: [] };

  const toApply = [...pulled.answers].sort((a, b) => a.seq - b.seq).filter((a) => !state.applied.includes(a.id));
  if (toApply.length) {
    const blocking = uncommittedSpec(root);
    if (blocking.length)
      throw new Error(`Commit or undo your changes under oodle/ first; answers aren't applied over uncommitted edits:\n${blocking.join('\n')}`);
  }
  const shas: { gap: string; sha: string }[] = [];
  let cursor = state.cursor;
  for (const a of toApply) {
    try {
      const out = applyAnswer(root, a.gap_id, { ...(a.answer ?? {}), id: a.id }, a.answered_by, { at: a.answered_at, commit: opts.commit });
      result.applied.push({ gap: a.gap_id, answer: a.id, ...(out.sha ? { sha: out.sha } : {}) });
      if (out.sha) {
        shas.push({ gap: a.gap_id, sha: out.sha });
        next.pending.push({ answer_id: a.id, sha: out.sha, gap: a.gap_id });
      } else if (!out.already) next.pending.push({ answer_id: a.id, sha: headSha(root) ?? 'uncommitted', gap: a.gap_id });
      next.applied.push(a.id);
    } catch (e) {
      if (!(e instanceof AnswerRefused)) throw e;
      result.refused.push({ gap: a.gap_id, answer: a.id, why: e.message });
      next.applied.push(a.id);
    }
    cursor = Math.max(cursor, a.seq);
  }
  recordApplied(root, shas, { commit: opts.commit });
  for (const ap of [...pulled.approvals].sort((x, y) => x.seq - y.seq)) {
    await opts.onApproval?.(ap);
    cursor = Math.max(cursor, ap.seq);
  }
  next.cursor = Math.max(cursor, pulled.cursor);
  next.last_sync = new Date().toISOString();
  writeState(root, next);
  result.cursor = next.cursor;
  return result;
}
