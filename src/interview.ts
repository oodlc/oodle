/**
 * The interview: where people find the words for their own system. Discovery
 * (src/discover.ts) can see routes, calls and tables; it can't see who a
 * capability is for or why it exists. The interview asks, one capability at a
 * time, showing the evidence, and writes the answers into the catalog.
 *
 * Two kinds of writer, with different rights (docs/decisions/0010):
 * - A person, at a terminal: may confirm a capability, and what they add is theirs.
 * - An agent, through the MCP `answer` tool: may fill in proposals for a person,
 *   but never confirms, never edits a confirmed capability, and anything new it
 *   adds (an actor, an intent) arrives as a proposal.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument, isMap, isSeq, type Document, type YAMLMap, type YAMLSeq } from 'yaml';
import { CatalogError, loadCatalog, loadConfig } from './catalog.ts';
import { lint, saysNothing } from './lint.ts';
import { OodleError } from './errors.ts';
import type { Catalog, Unknown } from './types.ts';

export interface Question {
  /** `statement`: say what it does. `why`: which intent it serves. `confirm`: a person's yes. `open`: any other question. */
  kind: 'statement' | 'why' | 'confirm' | 'open';
  /** The capability or unknown it is about. */
  target: string;
  ask: string;
  evidence: string[];
  file: string;
}

/** A `why.<capability>` question from discovery is the capability's own `why`, asked with it. */
const folded = (u: Unknown, catalog: Catalog) => u.id.startsWith('why.') && (u.about ?? []).length === 1 && catalog.capabilities.some((c) => c.id === u.about![0]);

/** What the catalog still needs a person to say, capability by capability, then the other open questions. */
export function questions(catalog: Catalog): Question[] {
  const out: Question[] = [];
  // The capabilities with the most evidence first: more outcomes and calls usually means it matters more.
  const weight = (c: (typeof catalog.capabilities)[number]) => (c.evidence?.length ?? 0) + (c.surfaces?.length ?? 0);
  for (const c of [...catalog.capabilities].sort((a, b) => weight(b) - weight(a))) {
    const file = catalog.sources[`capabilities:${c.id}`];
    const evidence = [...(c.surfaces ?? []).map((s) => `reached by ${s}`), ...(c.evidence ?? [])];
    const where = c.surfaces?.length ? ` through ${c.surfaces.join(', ')}` : '';
    if (saysNothing(c.statement)) out.push({ kind: 'statement', target: c.id, ask: `What can someone do${where}? Say it as "<actor> can <verb> <object>".`, evidence, file });
    if (!c.intent) out.push({ kind: 'why', target: c.id, ask: `Why does ${c.id} exist? Which intent does it serve?`, evidence, file });
    if (c.status === 'proposed') out.push({ kind: 'confirm', target: c.id, ask: `Is ${c.id} right as it stands? Confirming it lets it justify outcomes.`, evidence, file });
  }
  for (const u of catalog.unknowns) {
    if (u.answer || folded(u, catalog)) continue;
    out.push({ kind: 'open', target: u.id, ask: u.question, evidence: (u.about ?? []).map((id) => `about ${id}`), file: catalog.sources[`unknowns:${u.id}`] });
  }
  return out;
}

/** A new actor or intent, named by a person (or proposed by an agent). */
export interface NewEntry {
  id: string;
  statement: string;
}

export type Answer =
  | { kind: 'capability'; id: string; statement?: string; actor?: string | NewEntry; intent?: string | NewEntry; confirm?: boolean }
  | { kind: 'unknown'; id: string; answer: string };

export interface AnswerOptions {
  /** A person at a terminal. Otherwise an agent: no confirming, no editing confirmed capabilities, new entries are proposals. */
  byPerson: boolean;
}

/** Words an id shouldn't end on: "keep-the-store-up-for" reads as cut off. */
const DANGLING = new Set(['a', 'an', 'and', 'at', 'by', 'for', 'from', 'in', 'of', 'on', 'or', 'the', 'to', 'with']);

/** "Keep the store up for everyone" -> "keep-the-store-up", made unique. */
export function idFor(text: string, taken: Set<string>): string {
  const words = text.toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().split(/\s+/).filter(Boolean).slice(0, 5);
  while (words.length > 1 && DANGLING.has(words.at(-1)!)) words.pop();
  const base = words.join('-') || 'entry';
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

function itemIn(doc: Document, section: string, id: string): YAMLMap | undefined {
  const seq = doc.get(section);
  if (!isSeq(seq)) return undefined;
  return (seq as YAMLSeq).items.find((i): i is YAMLMap => isMap(i) && (i as YAMLMap).get('id') === id);
}

function append(doc: Document, section: string, value: Record<string, unknown>) {
  const seq = doc.get(section);
  if (isSeq(seq)) (seq as YAMLSeq).add(doc.createNode(value));
  else doc.set(section, doc.createNode([value]));
}

function remove(doc: Document, section: string, id: string) {
  const seq = doc.get(section);
  if (!isSeq(seq)) return;
  const items = (seq as YAMLSeq).items;
  const i = items.findIndex((x) => isMap(x) && (x as YAMLMap).get('id') === id);
  if (i >= 0) items.splice(i, 1);
  if (!items.length) doc.delete(section);
}

export interface AnswerResult {
  /** "capability checkout.create: statement, actor, confirmed" and the like. */
  changed: string[];
}

/**
 * Writes answers into the files that hold their entries, keeping comments and
 * layout. All or nothing: if the catalog would no longer load, or would gain a
 * lint error, every file goes back as it was.
 */
export function applyAnswers(projectDir: string, answers: Answer[], opts: AnswerOptions): AnswerResult {
  const config = loadConfig(projectDir);
  const before = loadCatalog(projectDir, config);
  const lintBefore = new Set(lint(before, config).errors);
  const docs = new Map<string, { text: string; doc: Document }>();
  const open = (rel: string) => {
    if (!docs.has(rel)) {
      const text = readFileSync(join(projectDir, rel), 'utf8');
      docs.set(rel, { text, doc: parseDocument(text) });
    }
    return docs.get(rel)!.doc;
  };
  const taken = (section: 'actors' | 'intents') => new Set(before[section].map((x) => x.id));
  const changed: string[] = [];

  for (const a of answers) {
    if (a.kind === 'unknown') {
      const rel = before.sources[`unknowns:${a.id}`];
      if (!rel) throw new OodleError('no-match', `No open question "${a.id}"`, { hint: 'The questions are listed by `oodle interview --json`.' });
      const item = itemIn(open(rel), 'unknowns', a.id)!;
      item.set('answer', open(rel).createNode(a.answer.trim()));
      changed.push(`question ${a.id}: answered`);
      continue;
    }
    const rel = before.sources[`capabilities:${a.id}`];
    const cap = before.capabilities.find((c) => c.id === a.id);
    if (!rel || !cap) throw new OodleError('no-match', `No capability "${a.id}"`, { hint: 'The capabilities are listed by `oodle interview --json` and the catalog tool.' });
    if (!opts.byPerson && cap.status !== 'proposed') throw new OodleError('approved', `${a.id} is confirmed; only a person changes it`, { hint: 'Say what you would change and why, and let the person edit it.' });
    if (!opts.byPerson && a.confirm) throw new OodleError('approved', 'Confirming a capability is a person\'s call', { hint: `The person confirms it in \`oodle interview\`, or by deleting the "status: proposed" line of ${a.id} in ${rel}.` });
    const doc = open(rel);
    const item = itemIn(doc, 'capabilities', a.id)!;
    const what: string[] = [];
    if (a.statement?.trim()) {
      item.set('statement', doc.createNode(a.statement.trim()));
      what.push('statement');
    }
    for (const [field, section] of [['actor', 'actors'], ['intent', 'intents']] as const) {
      const value = a[field];
      if (!value) continue;
      let id = typeof value === 'string' ? value : value.id;
      if (typeof value !== 'string') {
        // A new actor or intent goes beside the capability that needed it.
        if (!value.id) id = idFor(value.statement, taken(section));
        append(doc, section, { id, statement: value.statement.trim(), ...(opts.byPerson ? {} : { status: 'proposed' }) });
        what.push(`new ${field} ${id}`);
      } else what.push(field);
      item.set(field, id);
    }
    if (a.confirm) {
      item.delete('status');
      what.push('confirmed');
    }
    // Saying why answers discovery's `why.<capability>` question.
    if (a.intent) for (const u of before.unknowns) if (folded(u, before) && u.about![0] === a.id) remove(open(before.sources[`unknowns:${u.id}`]), 'unknowns', u.id);
    if (what.length) changed.push(`capability ${a.id}: ${what.join(', ')}`);
  }

  for (const [rel, { doc }] of docs) writeFileSync(join(projectDir, rel), doc.toString({ lineWidth: 0 }));
  try {
    const after = loadCatalog(projectDir, config);
    const fresh = lint(after, config).errors.filter((e) => !lintBefore.has(e));
    if (fresh.length) throw new OodleError('answer', 'Those answers leave the catalog with errors', { problems: fresh, hint: 'Use an id the catalog has, or describe a new one.' });
  } catch (err) {
    for (const [rel, { text }] of docs) writeFileSync(join(projectDir, rel), text);
    if (err instanceof CatalogError) throw new OodleError('answer', 'Those answers would break the catalog', { problems: err.problems });
    throw err;
  }
  return { changed };
}

// ── Asking ──────────────────────────────────────────────────────────────────

export interface InterviewIO {
  /** Ask one thing. null means the person has stopped (end of input, or q). */
  ask(prompt: string): Promise<string | null>;
  say(line: string): void;
}

export interface InterviewSummary {
  changed: string[];
  /** Questions still waiting when the interview ended. */
  remaining: number;
}

/**
 * Walks a person through the queue: each capability with its evidence, then the
 * other open questions. Enter skips; q (or the end of input) stops. Each answer
 * is written as soon as it is given, so stopping halfway keeps what was said.
 * `canConfirm` is false when answers are piped in: confirming needs someone there.
 */
export async function runInterview(projectDir: string, io: InterviewIO, opts: { canConfirm: boolean }): Promise<InterviewSummary> {
  const changed: string[] = [];
  const load = () => loadCatalog(projectDir, loadConfig(projectDir));
  const queue = questions(load());
  const targets = [...new Set(queue.map((q) => `${q.kind === 'open' ? 'unknown' : 'capability'}:${q.target}`))];
  const ask = async (prompt: string) => {
    const a = await io.ask(prompt);
    return a === null || a.trim().toLowerCase() === 'q' ? null : a.trim();
  };
  const write = (answer: Answer) => {
    const r = applyAnswers(projectDir, [answer], { byPerson: true });
    changed.push(...r.changed);
  };

  for (const [n, target] of targets.entries()) {
    const [kind, id] = target.split(/:(.*)/s);
    const mine = queue.filter((q) => q.target === id && (kind === 'unknown') === (q.kind === 'open'));
    io.say('');
    io.say(`${n + 1}/${targets.length}  ${kind === 'capability' ? `capability ${id}` : `question ${id}`}`);
    for (const e of mine[0].evidence) io.say(`    ${e}`);

    if (kind === 'unknown') {
      const answer = await ask(`${mine[0].ask}\n  Your answer (enter to skip, q to stop): `);
      if (answer === null) return { changed, remaining: questions(load()).length };
      if (answer) write({ kind: 'unknown', id, answer });
      continue;
    }

    const catalog = load();
    const cap = catalog.capabilities.find((c) => c.id === id)!;
    io.say(`    now: ${cap.statement}`);
    const answer: Extract<Answer, { kind: 'capability' }> = { kind: 'capability', id };
    if (mine.some((q) => q.kind === 'statement')) {
      let statement = await ask(`${mine.find((q) => q.kind === 'statement')!.ask}\n  > `);
      if (statement === null) return { changed, remaining: questions(load()).length };
      const vague = statement && saysNothing(statement);
      if (vague) {
        io.say(`    ${vague} Try naming what the actor gets.`);
        const again = await ask('  > ');
        if (again === null) return { changed, remaining: questions(load()).length };
        if (again) statement = again;
      }
      if (statement) answer.statement = statement;
      if (statement && !cap.actor) {
        const known = catalog.actors.map((a) => a.id);
        const who = await ask(`Who is that actor?${known.length ? ` Known: ${known.join(', ')}.` : ''} A name is enough (enter to skip).\n  > `);
        if (who === null) return { changed, remaining: questions(load()).length };
        if (who && known.includes(who)) answer.actor = who;
        else if (who) {
          const description = await ask(`Describe ${who} in a few words (enter to use the name).\n  > `);
          if (description === null) return { changed, remaining: questions(load()).length };
          const actorId = idFor(who, new Set(known));
          answer.actor = { id: actorId, statement: description || who };
        }
      }
    }
    if (mine.some((q) => q.kind === 'why')) {
      const intents = catalog.intents;
      const menu = intents.map((i, k) => `    ${k + 1}) ${i.statement}`).join('\n');
      const why = await ask(`${mine.find((q) => q.kind === 'why')!.ask}\n${menu}${menu ? '\n' : ''}  Pick a number, or say the reason in a sentence (enter to skip).\n  > `);
      if (why === null) return { changed, remaining: questions(load()).length };
      const pick = /^\d+$/.test(why) ? intents.at(Number(why) - 1) : undefined;
      if (pick) answer.intent = pick.id;
      else if (why) answer.intent = { id: '', statement: why };
    }
    if (answer.statement || answer.actor || answer.intent) write(answer);

    const now = load().capabilities.find((c) => c.id === id)!;
    if (now.status === 'proposed' && !saysNothing(now.statement)) {
      if (!opts.canConfirm) io.say(`    To confirm it, delete its "status: proposed" line in ${catalog.sources[`capabilities:${id}`]}.`);
      else {
        const yes = await ask(`Confirm "${now.statement}"? It can then justify outcomes. [y/N]\n  > `);
        if (yes === null) return { changed, remaining: questions(load()).length };
        if (/^y(es)?$/i.test(yes)) write({ kind: 'capability', id, confirm: true });
      }
    }
  }
  return { changed, remaining: questions(load()).length };
}


// ── For agents ──────────────────────────────────────────────────────────────

/**
 * The `interview` MCP prompt: the same queue, for an agent to put to the person.
 * The agent may read the code and offer a draft, but the words are the person's,
 * and confirming stays with them.
 */
export function interviewPrompt(projectDir: string): string {
  const catalog = loadCatalog(projectDir, loadConfig(projectDir));
  const queue = questions(catalog);
  const intents = catalog.intents.map((i) => `- \`${i.id}\`: ${i.statement}`).join('\n') || '- (none yet)';
  const actors = catalog.actors.map((a) => `- \`${a.id}\`: ${a.statement}`).join('\n') || '- (none yet)';
  const items = queue.map((q, n) => `${n + 1}. [${q.kind}] \`${q.target}\` (${q.file}): ${q.ask}${q.evidence.length ? `\n${q.evidence.map((e) => `   - ${e}`).join('\n')}` : ''}`).join('\n');
  return `You are interviewing a person about their own system, so the OODLC catalog can say what it does, for whom, and why. Only they know the answers. Your job is to ask well and write down what they say.

# How to interview

- Ask one question at a time, in the order below. Show the evidence in a line or two so they know what you mean.
- For a \`statement\` question, first read the code that handles the routes it lists, then offer your best draft as "<actor> can <verb> <object>" (for example "a shopper can pay for a cart and get one receipt") and ask whether it is right. Use their words if they change it. Avoid verbs that say nothing: handles, manages, processes, supports.
- Never guess who a capability is for, or why it exists. Ask.
- For a \`why\` question, offer the intents below by their statements, or let them say a new reason in a sentence.
- Record each answer straight away with the \`answer\` tool. Skip anything they don't know, and move on.
- You can't confirm a capability (\`confirm\` questions). When they are happy with one, tell them how: run \`oodle interview\` in a terminal, or delete its \`status: proposed\` line.
- Stop when they want to. What you recorded is kept.

# Intents

${intents}

# Actors

${actors}

# Questions

${items || 'Nothing to ask: every capability says what it does, and no question is open. If the system has routes no capability lists, call the discover tool first.'}
`;
}
