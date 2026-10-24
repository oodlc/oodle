/**
 * Applying an answer: the only way an answer reaches the spec.
 *
 * - An option writes what it `becomes`: a decision (added, or replacing the one it names or the one
 *   this gap wrote before), or for declared-tier gaps a constraint, a domain rule or a persona's
 *   cannot. A declared-tier write needs a person's answer (`person:…`); an agent's is refused.
 * - Free text from a person goes where its `target` says: a decision with status `rule`, a domain
 *   rule, or a constraint.
 * - "Either is fine" is a decision with status `dont_care`: verify skips it, and the gaps check
 *   doesn't raise its gap again.
 * - "Not a real difference" adds the gap to the ignore list.
 *
 * Then the gap is marked applied (or dismissed) and, in a git repository, committed as
 * `oodle: apply g_… (<who>)`. A person's answer always wins over an agent's; the answer it
 * replaces goes in the gap's history. Applying the same inbox answer twice does nothing.
 */
import { type Answer, addIgnore, type Gap, gapPath, readGap, writeGap } from '@oodle/gaps';
import { appendToList, type Decision, decisionId, loadSpec, writeConstraints, writeDecisions } from '@oodle/spec';
import { commit } from './git.ts';

export class AnswerRefused extends Error {}

export interface Applied {
  gap: Gap;
  /** Files changed, relative to the project. */
  changed: string[];
  /** The commit, when the project is in a git repository and `commit` wasn't turned off. */
  sha?: string;
  /** True when this answer was already applied. */
  already?: boolean;
}

export interface ApplyOptions {
  at?: string;
  /** Commit the change. Default true (a no-op outside git). */
  commit?: boolean;
}

const isPerson = (who: string) => who.startsWith('person:');

export function applyAnswer(root: string, gapId: string, answer: Answer, answeredBy: string, opts: ApplyOptions = {}): Applied {
  const gap = readGap(root, gapId);
  if (!gap) throw new AnswerRefused(`No gap ${gapId} in oodle/gaps/.`);
  if (answer.id && gap.answer?.id === answer.id && (gap.status === 'applied' || gap.status === 'dismissed')) return { gap, changed: [], already: true };
  if (gap.route === 'human' && !isPerson(answeredBy))
    throw new AnswerRefused(`${gapId} needs a person's answer (route: human); ${answeredBy} can't answer it.`);
  if (gap.answered_by && (gap.status === 'applied' || gap.status === 'answered') && isPerson(gap.answered_by) && !isPerson(answeredBy)) {
    throw new AnswerRefused(`${gapId} was answered by ${gap.answered_by}; a person's answer always wins over an agent's.`);
  }
  const at = opts.at ?? new Date().toISOString();
  const loaded = loadSpec(root);
  const changed: string[] = [];
  const note = `from ${gap.id}, answered by ${answeredBy}`;
  const rel = (p: string) => p.slice(root.length + 1);
  const option = answer.option ? gap.options.find((o) => o.id === answer.option) : undefined;
  if (answer.option && !option) throw new AnswerRefused(`${gapId} has no option "${answer.option}" (${gap.options.map((o) => o.id).join(', ')}).`);

  const declared = (what: string) => {
    if (!isPerson(answeredBy)) throw new AnswerRefused(`${what} changes the declared tier, which only a person may do; ${answeredBy} is not a person.`);
  };
  const entity = () => gap.about.find((a) => a.startsWith('entity:'))?.slice(7) ?? Object.keys(loaded.spec.domain)[0];

  /** Adds a decision, or replaces the one this gap (or `replaces`) points at, keeping its id. */
  const upsertDecision = (text: string, status: Decision['status'], replaces?: string) => {
    const decisions = [...loaded.spec.decisions];
    const i = decisions.findIndex((d) => d.from_gap === gap.id || (replaces !== undefined && (d.id === replaces || d.text === replaces)));
    const d: Decision = {
      id: i >= 0 ? (decisions[i] as Decision).id : decisionId(text),
      text,
      about: gap.about.filter((a) => a.startsWith('entity:') || a.startsWith('screen:') || a.startsWith('journey:') || a.startsWith('action:')),
      source: isPerson(answeredBy) ? 'person' : 'generator',
      status,
      ...(isPerson(answeredBy) ? { answered_by: answeredBy } : {}),
      from_gap: gap.id,
    };
    if (i >= 0) decisions[i] = d;
    else decisions.push(d);
    changed.push(rel(writeDecisions(loaded, decisions)));
  };

  let status: Gap['status'] = 'applied';
  const dontCare = answer.dont_care || answer.option === 'dont_care';
  if (answer.dismiss) {
    addIgnore(root, { id: gap.id, reason: answer.reason ?? 'not a real difference', by: answeredBy });
    changed.push('oodle/gaps/.ignore.yaml');
    status = 'dismissed';
  } else if (dontCare) {
    upsertDecision(`Either is fine: ${gap.evidence.a.summary} or ${gap.evidence.b.summary} (${gap.question})`, 'dont_care');
  } else if (option?.becomes) {
    const b = option.becomes;
    if (b.decision) upsertDecision(b.decision, 'pinned', b.replaces);
    if (b.constraint) {
      declared('A constraint');
      const text = b.constraint;
      if (!loaded.spec.constraints.some((c) => c.text === text))
        changed.push(rel(writeConstraints(loaded, [...loaded.spec.constraints, { text }], { [text]: note })));
    }
    if (b.rule) {
      declared('A domain rule');
      changed.push(
        rel(appendToList(loaded, 'domain', [b.rule.entity in loaded.spec.domain ? b.rule.entity : (entity() as string), 'rules'], b.rule.text, note)),
      );
    }
    if (b.cannot) {
      declared("A persona's cannot");
      changed.push(rel(appendToList(loaded, 'personas', [b.cannot.persona, 'cannot'], b.cannot.text, note)));
    }
  } else if (answer.text) {
    const target = answer.target ?? 'decision';
    if (target === 'decision') upsertDecision(answer.text, isPerson(answeredBy) ? 'rule' : 'pinned');
    else if (target === 'constraint') {
      declared('A constraint');
      changed.push(rel(writeConstraints(loaded, [...loaded.spec.constraints, { text: answer.text }], { [answer.text]: note })));
    } else {
      declared('A domain rule');
      changed.push(rel(appendToList(loaded, 'domain', [entity() as string, 'rules'], answer.text, note)));
    }
  } else if (option && !option.becomes) {
    throw new AnswerRefused(`option "${option.id}" of ${gapId} doesn't say what it writes.`);
  } else {
    throw new AnswerRefused('An answer is an option, a text, dont_care or dismiss.');
  }

  const history = [...(gap.history ?? [])];
  if (gap.answer && gap.answered_by && (gap.status === 'applied' || gap.status === 'answered')) {
    history.push({ answer: gap.answer, answered_by: gap.answered_by, answered_at: gap.answered_at, replaced_at: at });
  }
  const updated: Gap = { ...gap, status, answer, answered_by: answeredBy, answered_at: at, applied_in: null, ...(history.length ? { history } : {}) };
  writeGap(root, updated);
  changed.push(rel(gapPath(root, gap.id)));

  const sha = opts.commit === false ? undefined : commit(root, ['oodle'], `oodle: apply ${gap.id} (${answeredBy})`);
  return { gap: updated, changed: [...new Set(changed)], ...(sha ? { sha } : {}) };
}

/** Writes where each gap was applied, in one commit. */
export function recordApplied(root: string, applied: { gap: string; sha: string }[], opts: { commit?: boolean } = {}): string | undefined {
  if (!applied.length) return undefined;
  for (const { gap: id, sha } of applied) {
    const gap = readGap(root, id);
    if (gap) writeGap(root, { ...gap, applied_in: sha });
  }
  return opts.commit === false
    ? undefined
    : commit(root, ['oodle/gaps'], `oodle: record where ${applied.map((a) => a.gap).join(', ')} ${applied.length === 1 ? 'was' : 'were'} applied`);
}
