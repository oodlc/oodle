/**
 * The security condition pack: built-in conditions that make a request hostile
 * without knowing anything about the app. Reference one from an outcome's
 * `conditions` (with a `when` override saying what should happen instead), or
 * list them under `probe.conditions` in oodlc/config.yaml so every unknown route
 * is probed with them and checked against every constraint. A catalog condition
 * with the same id replaces the built-in one. See docs/decisions/0004.
 */
import type { Catalog, Condition, Fuzz } from './types.ts';

export const BUILTIN_CONDITIONS: Condition[] = [
  { id: 'security.no-credentials', statement: 'The request carries no headers at all, so no credentials', given: { headers: null } },
  { id: 'security.injection', statement: 'Every string in the body is an injection payload (SQL, script, template, path traversal)', given: { fuzz: 'injection' } },
  { id: 'security.oversize', statement: 'The body carries an extra 1MB field', given: { fuzz: 'oversize' } },
  { id: 'security.extra-fields', statement: 'Every object in the body gains privileged fields the caller should not control (role: admin, price_cents: 0, __proto__ ...)', given: { fuzz: 'extra-fields' } },
  { id: 'security.replayed', statement: 'The same request is sent twice', given: { repeat: 2 } },
];

/** Catalog conditions win over built-in ones with the same id. */
export function allConditions(catalog: Catalog): Map<string, Condition> {
  return new Map([...BUILTIN_CONDITIONS, ...catalog.conditions].map((c) => [c.id, c]));
}

export const INJECTION = `' OR '1'='1'; DROP TABLE users; -- <script>alert(1)</script> {{7*7}} \${7*7} ../../../etc/passwd`;

/** Set on Object.prototype only if the app merged a hostile `__proto__` into a plain object. */
export const POLLUTION_MARK = 'oodle_polluted';

const EXTRA_FIELDS: Record<string, unknown> = {
  role: 'admin',
  is_admin: true,
  admin: true,
  verified: true,
  price_cents: 0,
  total_cents: 0,
  amount_cents: 0,
  discount_percent: 100,
};

const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function mapStrings(v: unknown, f: (s: string) => string): unknown {
  if (typeof v === 'string') return f(v);
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, f));
  if (isPlain(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapStrings(x, f)]));
  return v;
}

function addFields(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(addFields);
  if (!isPlain(v)) return v;
  const out: Record<string, unknown> = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, addFields(x)]));
  for (const [k, x] of Object.entries(EXTRA_FIELDS)) if (!(k in out)) out[k] = x;
  // An own "__proto__" key, as JSON.parse would produce from a hostile request body.
  Object.defineProperty(out, '__proto__', { value: { [POLLUTION_MARK]: true }, enumerable: true, writable: true, configurable: true });
  return out;
}

/** Returns a new body; the original is never modified. */
export function fuzzBody(body: unknown, fuzz: Fuzz): unknown {
  switch (fuzz) {
    case 'injection':
      return mapStrings(body, () => INJECTION);
    case 'oversize':
      return { ...(isPlain(body) ? body : body === undefined ? {} : { value: body }), oodle_padding: 'x'.repeat(1 << 20) };
    case 'extra-fields':
      return addFields(body === undefined ? {} : body);
  }
}

/** Removes the mark if an app polluted the prototype, and says so. */
export function takePollution(): boolean {
  const proto = Object.prototype as Record<string, unknown>;
  if (!(POLLUTION_MARK in proto)) return false;
  delete proto[POLLUTION_MARK];
  return true;
}
