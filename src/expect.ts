import type { EffectRecord, Expect } from './types.ts';

const MATCHER_KEYS = new Set(['exists', 'type', 'matches', 'gte', 'lte', 'contains']);

export function getPath(obj: unknown, path: string): unknown {
  let cur: any = obj;
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[part];
  }
  return cur;
}

export function stableStringify(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value as object).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as any)[k])}`).join(',')}}`;
}

function isMatcher(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0 && Object.keys(v).every((k) => MATCHER_KEYS.has(k));
}

/** Returns null when the value matches, or a short reason when it does not. */
export function matchValue(actual: unknown, expected: unknown): string | null {
  if (isMatcher(expected)) {
    if ('exists' in expected) {
      const exists = actual !== undefined && actual !== null;
      if (exists !== expected.exists) return expected.exists ? 'missing' : `should be absent, got ${JSON.stringify(actual)}`;
    }
    if ('type' in expected) {
      const t = Array.isArray(actual) ? 'array' : actual === null ? 'null' : typeof actual;
      if (t !== expected.type) return `expected type ${expected.type}, got ${t}`;
    }
    if ('matches' in expected && !(typeof actual === 'string' && new RegExp(String(expected.matches)).test(actual))) {
      return `expected to match /${expected.matches}/, got ${JSON.stringify(actual)}`;
    }
    if ('gte' in expected && !(typeof actual === 'number' && actual >= (expected.gte as number))) return `expected >= ${expected.gte}, got ${JSON.stringify(actual)}`;
    if ('lte' in expected && !(typeof actual === 'number' && actual <= (expected.lte as number))) return `expected <= ${expected.lte}, got ${JSON.stringify(actual)}`;
    if ('contains' in expected && !(typeof actual === 'string' && actual.includes(String(expected.contains)))) {
      return `expected to contain "${expected.contains}", got ${JSON.stringify(actual)}`;
    }
    return null;
  }
  return stableStringify(actual) === stableStringify(expected) ? null : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
}

function effectMatches(e: EffectRecord, match: Record<string, unknown> | undefined): boolean {
  if (!match) return true;
  return Object.entries(match).every(([path, want]) => {
    const actual = path.startsWith('result.') ? getPath(e.result, path.slice(7)) : getPath(e.payload, path);
    return matchValue(actual, want) === null;
  });
}

export interface Observed {
  status: number | null;
  body: unknown;
  effects: EffectRecord[];
  latency_ms: number;
}

export function evaluate(expect: Expect, obs: Observed): string[] {
  const failures: string[] = [];
  if (expect.status !== undefined && obs.status !== expect.status) failures.push(`status: expected ${expect.status}, got ${obs.status}`);
  for (const [path, want] of Object.entries(expect.body ?? {})) {
    const reason = matchValue(getPath(obs.body, path), want);
    if (reason) failures.push(`body.${path}: ${reason}`);
  }
  for (const e of expect.effects ?? []) {
    const n = obs.effects.filter((r) => r.kind === e.kind && !r.error && effectMatches(r, e.match)).length;
    if (n !== e.count) {
      const what = e.match ? `${e.kind} ${JSON.stringify(e.match)}` : e.kind;
      failures.push(`effect ${what}: expected ${e.count}, got ${n}`);
    }
  }
  if (expect.latency_ms_max !== undefined && obs.latency_ms > expect.latency_ms_max) {
    failures.push(`latency: ${obs.latency_ms}ms exceeds ${expect.latency_ms_max}ms`);
  }
  return failures;
}

/** Up to `limit` paths where two JSON values differ, for human-readable diffs. */
export function jsonDiff(a: unknown, b: unknown, prefix = '', out: string[] = [], limit = 6): string[] {
  if (out.length >= limit) return out;
  const isObj = (v: unknown) => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (isObj(a) && isObj(b)) {
    const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
    for (const k of [...keys].sort()) {
      const p = prefix ? `${prefix}.${k}` : k;
      const inA = k in (a as object);
      const inB = k in (b as object);
      if (inA && !inB) out.push(`${p} removed`);
      else if (!inA && inB) out.push(`${p} added`);
      else jsonDiff((a as any)[k], (b as any)[k], p, out, limit);
      if (out.length >= limit) break;
    }
    return out;
  }
  if (stableStringify(a) !== stableStringify(b)) out.push(`${prefix || 'value'}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`);
  return out;
}
