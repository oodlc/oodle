import type { AnswerBody, GapFile, IntentFile, RuleTarget } from '../shared/protocol.ts';
import { ApiError } from './env.ts';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const bad = (message: string) => new ApiError(400, 'bad_request', message);

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw bad('The body is not JSON.');
  }
  if (!isObj(body)) throw bad('The body must be a JSON object.');
  return body;
}

const GAP_KINDS = new Set(['sort_order', 'format', 'permission', 'rule', 'extra_element', 'wording', 'pagination', 'decision_moved', 'other']);
const GAP_STATUSES = new Set(['open', 'answered', 'dismissed', 'applied']);
const INTENT_STATUSES = new Set(['draft', 'in_review', 'approved', 'merged', 'rejected']);
const TARGETS = new Set<RuleTarget>(['decision', 'domain_rule', 'constraint']);

/** Structure only: the CLI owns the file format, the inbox checks what it relies on. */
export function checkGapFile(id: string, body: unknown): GapFile {
  const where = `gap ${id}`;
  if (!isObj(body)) throw bad(`${where}: body must be an object.`);
  if (body.id !== id) throw bad(`${where}: body.id must equal the pushed id.`);
  if (typeof body.status !== 'string' || !GAP_STATUSES.has(body.status)) throw bad(`${where}: unknown status.`);
  if (typeof body.kind !== 'string' || !GAP_KINDS.has(body.kind)) throw bad(`${where}: unknown kind.`);
  if (body.tier !== 'decided' && body.tier !== 'declared') throw bad(`${where}: tier must be decided or declared.`);
  if (body.route !== 'agent' && body.route !== 'human') throw bad(`${where}: route must be agent or human.`);
  if (typeof body.question !== 'string' || !body.question) throw bad(`${where}: question is required.`);
  if (typeof body.spec_hash !== 'string') throw bad(`${where}: spec_hash is required.`);
  if (!isObj(body.evidence) || !isObj(body.evidence.a) || !isObj(body.evidence.b)) throw bad(`${where}: evidence needs sides a and b.`);
  if (!Array.isArray(body.options) || !body.options.every((o) => isObj(o) && typeof o.id === 'string' && typeof o.label === 'string')) {
    throw bad(`${where}: options must be a list of { id, label }.`);
  }
  return body as unknown as GapFile;
}

export function checkIntentFile(id: string, body: unknown): IntentFile {
  const where = `intent ${id}`;
  if (!isObj(body)) throw bad(`${where}: body must be an object.`);
  if (body.id !== id) throw bad(`${where}: body.id must equal the pushed id.`);
  if (typeof body.status !== 'string' || !INTENT_STATUSES.has(body.status)) throw bad(`${where}: unknown status.`);
  if (typeof body.title !== 'string') throw bad(`${where}: title is required.`);
  if (!Array.isArray(body.changes) || !body.changes.every((ch) => isObj(ch) && typeof ch.op === 'string')) {
    throw bad(`${where}: changes must be a list of { op, ... }.`);
  }
  return body as unknown as IntentFile;
}

/** Exactly one answer form from 10.4. */
export function checkAnswer(body: Record<string, unknown>, optionIds: string[]): AnswerBody {
  const forms = ['option', 'text', 'dont_care', 'dismiss'].filter((k) => body[k] !== undefined);
  if (forms.length !== 1) throw bad('Send exactly one of: option, text (with target), dont_care, dismiss.');
  if (body.option !== undefined) {
    if (typeof body.option !== 'string' || !optionIds.includes(body.option)) throw bad(`option must be one of: ${optionIds.join(', ')}.`);
    return { option: body.option };
  }
  if (body.text !== undefined) {
    if (typeof body.text !== 'string' || !body.text.trim()) throw bad('text must be a rule in plain words.');
    if (typeof body.target !== 'string' || !TARGETS.has(body.target as RuleTarget)) throw bad('target must be decision, domain_rule or constraint.');
    return { text: body.text.trim(), target: body.target as RuleTarget };
  }
  if (body.dont_care !== undefined) {
    if (body.dont_care !== true) throw bad('dont_care must be true.');
    return { dont_care: true };
  }
  if (body.dismiss !== true) throw bad('dismiss must be true.');
  return { dismiss: true };
}

export function checkVersion(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw bad('version (the gap version you saw) is required.');
  return v;
}

export const sameAnswer = (a: AnswerBody, b: AnswerBody) => JSON.stringify(a) === JSON.stringify(b);
