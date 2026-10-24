/**
 * The tier guard: only people change the declared tier. The generator workflow calls it after
 * every agent run, and the CLI before committing anything an agent produced, so the rule is
 * enforced by comparing specs, not by asking the agent nicely.
 */
import { TierViolation } from './errors.ts';
import { declaredOf, stableStringify } from './hash.ts';
import type { Spec } from './schema.ts';

/** Every place the declared tier differs between two specs, as readable paths. Empty when it didn't change. */
export function declaredDiff(before: Spec, after: Spec): string[] {
  return jsonDiff(declaredOf(before), declaredOf(after));
}

export function assertDeclaredUnchanged(before: Spec, after: Spec): void {
  const changes = declaredDiff(before, after);
  if (changes.length) throw new TierViolation(changes);
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const short = (v: unknown) => {
  const s = JSON.stringify(v) ?? 'nothing';
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
};

/** Paths where two JSON values differ. (From v0's src/expect.ts, without effect lists or a limit: the guard reports everything.) */
export function jsonDiff(a: unknown, b: unknown, prefix = '', out: string[] = []): string[] {
  if (isObj(a) && isObj(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)].filter((k) => a[k] !== undefined || b[k] !== undefined));
    for (const k of [...keys].sort()) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (b[k] === undefined) out.push(`${p} removed`);
      else if (a[k] === undefined) out.push(`${p} added`);
      else jsonDiff(a[k], b[k], p, out);
    }
    return out;
  }
  if (stableStringify(a) === stableStringify(b)) return out;
  if (Array.isArray(a) && Array.isArray(b)) {
    const p = prefix || 'value';
    for (let i = 0; i < Math.min(a.length, b.length); i++) jsonDiff(a[i], b[i], `${p}[${i}]`, out);
    if (a.length > b.length) out.push(`${p}: ${a.length - b.length} removed, ${a.slice(b.length).map(short).join(', ')}`);
    if (b.length > a.length) out.push(`${p}: ${b.length - a.length} added, ${b.slice(a.length).map(short).join(', ')}`);
    return out;
  }
  out.push(`${prefix || 'value'}: ${short(a)} → ${short(b)}`);
  return out;
}
