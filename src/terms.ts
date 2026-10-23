/**
 * The vocabulary. Ambiguity between people and agents lives in the nouns:
 * "order", "paid", "customer". The words worth defining are the ones the system
 * itself is built around: what its routes act on, and who its actors are. Each
 * of those that a statement uses and no term defines is a question for a person.
 * See docs/decisions/0013.
 */
import type { Catalog } from './types.ts';

/** "orders" -> "order", "categories" -> "category", "addresses" -> "address". Close enough for matching words. */
export function singular(word: string): string {
  const w = word.toLowerCase();
  if (/(us|is|ss)$/.test(w)) return w; // status, analysis, address
  if (/ies$/.test(w) && w.length > 4) return w.replace(/ies$/, 'y');
  if (/(ss|sh|ch|x)es$/.test(w)) return w.replace(/es$/, '');
  if (/s$/.test(w) && !/ss$/.test(w) && w.length > 3) return w.replace(/s$/, '');
  return w;
}

/** Route segments that name where an API lives or what it is, not a thing in the domain. */
const NOT_NOUNS = new Set(['api', 'health', 'healthz', 'status', 'ping', 'metrics', 'root', 'internal', 'admin', 'v1', 'v2', 'v3', 'auth', 'login', 'logout', 'search']);

/** The words a system is built around: the resources its routes act on, and its actors. */
export function vocabulary(catalog: Catalog): string[] {
  const words = new Set<string>();
  const resource = (route: string) => {
    const seg = route.split(' ')[1]?.split('?')[0].split('/').filter((s) => s && !s.startsWith(':') && !s.startsWith('[') && !/^v\d+$/.test(s) && s !== 'api')[0];
    if (seg && /^[a-z][a-z-]*$/i.test(seg) && !NOT_NOUNS.has(seg.toLowerCase())) words.add(singular(seg));
  };
  for (const c of catalog.capabilities) for (const s of c.surfaces ?? []) resource(s);
  for (const x of [...catalog.outcomes, ...catalog.behaviors]) resource(x.trigger.http);
  for (const a of catalog.actors) if (/^[a-z][a-z-]*$/.test(a.id)) words.add(singular(a.id));
  return [...words].sort();
}

/** Every statement in the catalog that people read, with where it is. */
function statements(catalog: Catalog): { where: string; text: string }[] {
  return [
    ...catalog.intents.map((x) => ({ where: `intent ${x.id}`, text: x.statement })),
    ...catalog.capabilities.map((x) => ({ where: `capability ${x.id}`, text: x.statement })),
    ...catalog.experiences.map((x) => ({ where: `experience ${x.id}`, text: x.statement })),
    ...catalog.outcomes.map((x) => ({ where: `outcome ${x.id}`, text: x.statement })),
    ...catalog.constraints.map((x) => ({ where: `constraint ${x.id}`, text: x.statement })),
  ].filter((s) => !/\bTODO\b/.test(s.text));
}

/** Words a term defines, by its id and the other words people use for it. */
export function defined(catalog: Catalog): Set<string> {
  return new Set(catalog.terms.flatMap((t) => [t.id, ...(t.aka ?? [])].map(singular)));
}

/** The vocabulary's words that statements use and no term defines, with the statements that use them. */
export function undefinedWords(catalog: Catalog): { word: string; usedIn: string[] }[] {
  const known = defined(catalog);
  const said = statements(catalog).map((s) => ({ ...s, words: new Set((s.text.toLowerCase().match(/[a-z][a-z-]*/g) ?? []).map(singular)) }));
  return vocabulary(catalog)
    .filter((w) => !known.has(w))
    .map((word) => ({ word, usedIn: said.filter((s) => s.words.has(word)).map((s) => s.where) }))
    .filter((w) => w.usedIn.length > 0);
}
