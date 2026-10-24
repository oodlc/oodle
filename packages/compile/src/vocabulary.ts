/**
 * The action and screen vocabulary: what the simulation can do in an app and look at, whatever
 * routes a build chose. Derived from the spec without a model, so it never drifts:
 *
 * - each persona capability is an action: `book walks` is `owner.book_walk`, and `accept or
 *   decline walks` is two, `walker.accept_walk` and `walker.decline_walk`;
 * - each entity has a list screen (`walks`) and a detail screen (`walk`, with a `walk` param), and
 *   every app has `home`.
 *
 * Inputs start from what the phrase names (an action on an existing walk takes `walk`) and grow
 * with what compiled journeys pass.
 */
import { type Spec, sha256, stableStringify } from '@oodle/spec';

export interface ActionDef {
  id: string;
  persona: string;
  /** The capability phrase it comes from. */
  capability: string;
  verb: string;
  /** The entity it acts on, when the phrase names one. */
  entity?: string;
  /** It creates the entity (book, create, add…) rather than acting on one. */
  creates?: boolean;
  inputs: string[];
}

export interface ScreenDef {
  name: string;
  params: string[];
  /** In words, for the generator. */
  shows: string;
}

export interface Vocabulary {
  hash: string;
  actions: ActionDef[];
  screens: ScreenDef[];
}

const FILLER = new Set(['a', 'an', 'the', 'their', 'own', 'his', 'her', 'its', 'my', 'your', 'our', 'all', 'any', 'some', 'other', 'others']);
const CREATES = new Set([
  'book',
  'create',
  'add',
  'request',
  'make',
  'post',
  'open',
  'start',
  'schedule',
  'submit',
  'write',
  'order',
  'invite',
  'register',
  'place',
]);

export const plural = (word: string) => (/(s|x|z|ch|sh)$/.test(word) ? `${word}es` : /[^aeiou]y$/.test(word) ? `${word.slice(0, -1)}ies` : `${word}s`);

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');

/** `accept or decline walks` is `accept walks` and `decline walks`. */
export function splitCapability(phrase: string): string[] {
  const m = /^\s*(\w+)\s+(?:or|and|and\/or)\s+(\w+)\s+(.+)$/i.exec(phrase);
  return m ? [`${m[1]} ${m[3]}`, `${m[2]} ${m[3]}`] : [phrase.trim()];
}

export function actionOf(persona: string, phrase: string, entities: string[]): Omit<ActionDef, 'inputs'> & { inputs: string[] } {
  const words = phrase
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !FILLER.has(w));
  const [verb = 'do', ...object] = words;
  const singular = object.map((w) => entities.find((e) => w === e || w === plural(e)) ?? w);
  const entity = singular.find((w) => entities.includes(w));
  const creates = !!entity && CREATES.has(verb);
  return {
    id: `${slug(persona)}.${slug([verb, ...singular].join(' '))}`,
    persona,
    capability: phrase,
    verb,
    ...(entity ? { entity } : {}),
    ...(creates ? { creates } : {}),
    inputs: entity && !creates ? [entity] : [],
  };
}

export function vocabularyOf(spec: Spec): Vocabulary {
  const entities = Object.keys(spec.domain);
  const actions: ActionDef[] = [];
  for (const [persona, p] of Object.entries(spec.personas)) {
    for (const capability of p.can) for (const phrase of splitCapability(capability)) actions.push({ ...actionOf(persona, phrase, entities), capability });
  }
  const screens: ScreenDef[] = [
    { name: 'home', params: [], shows: 'the first screen a signed-in persona sees' },
    ...entities.flatMap((e) => [
      { name: plural(e), params: [], shows: `the list of ${plural(e)} the signed-in persona can see` },
      { name: e, params: [e], shows: `one ${e}, by id` },
    ]),
  ];
  const hash = sha256(stableStringify({ personas: spec.personas, entities }));
  return { hash, actions, screens };
}

/** Adds the input names compiled scenarios pass to each action. */
export function withInputs(vocab: Vocabulary, used: Map<string, Set<string>>): Vocabulary {
  return {
    ...vocab,
    actions: vocab.actions.map((a) => ({ ...a, inputs: [...new Set([...a.inputs, ...(used.get(a.id) ?? [])])].sort() })),
  };
}
