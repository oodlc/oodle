/**
 * Turning a difference into a question a person (or an agent) can answer: what the scenario was,
 * in plain words, what each build showed, and the options, each saying what it writes to the
 * spec. A model words it when there is one; otherwise a plain template does, so the gaps check
 * works offline.
 */
import { type ActionDef, type Model, plural, SPEC_CONTEXT, type Vocabulary } from '@oodle/compile';
import type { GapSignature } from '@oodle/diff';
import type { Scenario } from '@oodle/sim';
import type { Spec } from '@oodle/spec';
import { z } from 'zod';
import { Becomes, type Gap, type Option } from './gap.ts';

const personaOf = (key: string) => key.slice(0, key.indexOf(':'));

/** The scenario up to the step the gap showed at, in plain words. */
export function describeScenario(s: Scenario, upto: number, vocab?: Vocabulary): string {
  const name = (key: string) => (s.fixtures[key]?.name as string | undefined) ?? key;
  const lines: string[] = [];
  for (const step of s.steps.slice(0, upto + 1)) {
    const who = name(step.as);
    let line: string;
    if (step.do) {
      const action = vocab?.actions.find((a) => a.id === step.do);
      const inputs = Object.entries(step.input ?? {})
        .map(([k, v]) => `${k} ${typeof v === 'string' && s.fixtures[v] ? name(v) : String(v)}`)
        .join(', ');
      line = `${who}: ${action?.capability ?? step.do}${inputs ? ` (${inputs})` : ''}`;
    } else line = `${who} looks at ${step.look?.screen ?? 'the home screen'}`;
    if (step.look?.screen && step.do) line += `, then ${name(step.look.as ?? step.as)} looks at ${step.look.screen}`;
    if (step.at) line = `[${step.at.replace('T', ' ').replace(/:00(\.000)?Z$/, '')}] ${line}`;
    const last = lines[lines.length - 1];
    const repeat = last && /^(.*?)(?: ×(\d+))?$/.exec(last);
    const base = (l: string) => l.replace(/ \([^)]*\)$/, '');
    if (repeat && base(repeat[1] as string) === base(line) && step.do) lines[lines.length - 1] = `${base(line)} ×${Number(repeat[2] ?? 1) + 1}`;
    else lines.push(line);
  }
  return lines.join('; ');
}

export interface Question {
  question: string;
  a: string;
  b: string;
  options: Option[];
}

const DONT_CARE: Option = { id: 'dont_care', label: 'Either is fine' };

const an = (word: string) => `${/^[aeiou]/i.test(word) ? 'an' : 'a'} ${word}`;
/** "cancel their own walks" read as what anyone could do: "cancel walks". */
const plainly = (capability: string) => capability.replace(/\b(their|his|her|its|my|your|our)\s+(own\s+)?/gi, '');
const quote = (xs: string[]) => xs.map((x) => `"${x}"`).join(', ');
const cap = (s: string) => `${s[0]?.toUpperCase() ?? ''}${s.slice(1)}`;

/** The plain template, for when there is no model. */
export function templateQuestion(sig: GapSignature, vocab?: Vocabulary): Question {
  const e = sig.evidence;
  const place = e.where.startsWith('screen:') ? `the ${e.where.slice(7)} screen` : `the screen after ${e.action ?? 'that'}`;
  const things = sig.entity ? plural(sig.entity) : 'items';
  const viewer = personaOf(e.as);
  const action: ActionDef | undefined = vocab?.actions.find((a) => a.id === e.action);
  switch (sig.pattern) {
    case 'sort_order':
      return {
        question: `Two builds list ${things} in different orders. Which order should ${plural(viewer)} see?`,
        a: `Starts ${quote(e.a.sample)}`,
        b: `Starts ${quote(e.b.sample)}`,
        options: [
          {
            id: 'a',
            label: `Like this: ${e.a.sample.join(', ')}`,
            becomes: { decision: `${cap(things)} are listed in this order: ${e.a.sample.join(', ')}…` },
          },
          {
            id: 'b',
            label: `Like this: ${e.b.sample.join(', ')}`,
            becomes: { decision: `${cap(things)} are listed in this order: ${e.b.sample.join(', ')}…` },
          },
          DONT_CARE,
        ],
      };
    case 'permission':
    case 'rule': {
      const actor = personaOf(e.actor);
      const what = plainly(action?.capability ?? e.action ?? 'do this');
      const refusedIsA = e.a.summary === 'refused';
      const refuse =
        sig.pattern === 'permission'
          ? { cannot: { persona: actor, text: `${what} that belong to another ${actor}` } }
          : { rule: { entity: sig.entity ?? 'app', text: `${cap(actor)}s can't ${what} in this situation: ${describeLast(e)}` } };
      const allow =
        sig.pattern === 'permission'
          ? { constraint: `Any ${actor} can ${what}, including another ${actor}'s` }
          : { rule: { entity: sig.entity ?? 'app', text: `${cap(actor)}s can ${what} in this situation: ${describeLast(e)}` } };
      const question =
        sig.pattern === 'permission'
          ? `Two builds disagree on whether ${an(actor)} can ${what} that belong to another ${actor}. Which is right?`
          : `Two builds disagree on whether ${an(actor)} can ${what} here. Which is right?`;
      const refusedOpt = { label: `Refuse it`, becomes: refuse };
      const allowedOpt = { label: `Allow it`, becomes: allow };
      return {
        question,
        a: refusedIsA ? 'Refused' : 'Allowed',
        b: refusedIsA ? 'Allowed' : 'Refused',
        options: [
          { id: 'a', ...(refusedIsA ? refusedOpt : allowedOpt) },
          { id: 'b', ...(refusedIsA ? allowedOpt : refusedOpt) },
        ],
      };
    }
    case 'pagination':
      return {
        question: `Two builds show a different number of ${things} at once on ${place}. How many should one screen show?`,
        a: e.a.summary,
        b: e.b.summary,
        options: [
          { id: 'a', label: e.a.summary, becomes: { decision: `${cap(things)} show ${e.a.summary.replace(' items', '')} at a time on ${place}` } },
          { id: 'b', label: e.b.summary, becomes: { decision: `${cap(things)} show ${e.b.summary.replace(' items', '')} at a time on ${place}` } },
          DONT_CARE,
        ],
      };
    case 'extra_element':
      return {
        question: `One build shows something on ${place} that the other doesn't. Should it be there?`,
        a: e.a.sample.length ? `Shows ${quote(e.a.sample)}` : 'Shows nothing extra',
        b: e.b.sample.length ? `Shows ${quote(e.b.sample)}` : 'Shows nothing extra',
        options: [
          {
            id: 'a',
            label: e.a.sample.length ? `Show ${quote(e.a.sample)}` : 'Show nothing extra',
            becomes: { decision: e.a.sample.length ? `${cap(place)} shows ${quote(e.a.sample)}` : `${cap(place)} shows only what the spec names` },
          },
          {
            id: 'b',
            label: e.b.sample.length ? `Show ${quote(e.b.sample)}` : 'Show nothing extra',
            becomes: { decision: e.b.sample.length ? `${cap(place)} shows ${quote(e.b.sample)}` : `${cap(place)} shows only what the spec names` },
          },
          DONT_CARE,
        ],
      };
    default:
      return {
        question: `Two builds ${sig.pattern === 'format' ? 'format this differently' : 'word this differently'} on ${place}. Which should it be?`,
        a: quote(e.a.sample),
        b: quote(e.b.sample),
        options: [
          { id: 'a', label: quote(e.a.sample), becomes: { decision: `${cap(place)} says ${quote(e.a.sample)}` } },
          { id: 'b', label: quote(e.b.sample), becomes: { decision: `${cap(place)} says ${quote(e.b.sample)}` } },
          DONT_CARE,
        ],
      };
  }
}

const describeLast = (e: GapSignature['evidence']) => `${e.scenario.split('/').pop()}`;

const Worded = z.strictObject({
  question: z.string().describe('one question, in the spec’s own words, with real example values'),
  a: z.string().describe('what build A does, in a few words a user would use'),
  b: z.string().describe('what build B does'),
  options: z
    .array(
      z.strictObject({
        id: z.enum(['a', 'b']),
        label: z.string(),
        becomes: Becomes.describe(
          'what the answer writes: a decision (most gaps), or for permissions and domain rules a constraint, a rule, or a persona cannot',
        ),
      }),
    )
    .length(2),
});

/** One model call per gap, given the evidence. Falls back to the template if the answer doesn't fit. */
export async function writeQuestion(sig: GapSignature, ctx: { spec: Spec; vocab: Vocabulary; scenarioText: string }, model?: Model): Promise<Question> {
  const fallback = templateQuestion(sig, ctx.vocab);
  if (!model) return fallback;
  const e = sig.evidence;
  try {
    const worded = await model.json({
      label: `word gap ${sig.id}`,
      system:
        'You write one question for the people who own an app spec, about something two builds of the app did differently. Use the spec’s words and the example values shown, never internal names, routes or code. Answer with JSON only.',
      prompt: `${SPEC_CONTEXT(ctx.spec, ctx.vocab)}

## What happened

Scenario: ${ctx.scenarioText}
Seen by: ${e.as}, on ${e.where}
Kind of difference: ${sig.pattern}
Build A: ${e.a.summary}: ${e.a.sample.map((s) => `"${s}"`).join(', ')}
Build B: ${e.b.summary}: ${e.b.sample.map((s) => `"${s}"`).join(', ')}

Write the question, describe each side in plain words, and give option "a" (what A does) and option "b" (what B does), each with what it becomes in the spec. For a permission or a domain rule, "becomes" is a constraint, a rule ({entity, text}) or a persona's cannot ({persona, text}); otherwise it is a decision, phrased so a non-engineer can agree or disagree with it (for example "Walks are listed by starts_at, soonest first").`,
      schema: Worded,
    });
    const options: Option[] = worded.options.map((o) => ({ id: o.id, label: o.label, becomes: o.becomes }));
    if (fallback.options.some((o) => o.id === 'dont_care')) options.push(DONT_CARE);
    return { question: worded.question, a: worded.a, b: worded.b, options };
  } catch {
    return fallback;
  }
}

export type { Gap };
