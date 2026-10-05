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
  if (typeof expect.status === 'number' && obs.status !== expect.status) failures.push(`status: expected ${expect.status}, got ${obs.status}`);
  else if (expect.status !== undefined && typeof expect.status === 'object') {
    const reason = matchValue(obs.status, expect.status);
    if (reason) failures.push(`status: ${reason}`);
  }
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

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isEffectList = (v: unknown): v is { kind: string }[] => Array.isArray(v) && v.every((e) => isObj(e) && typeof e.kind === 'string');
const short = (v: unknown) => {
  const s = JSON.stringify(v);
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
};

/**
 * Effect lists are compared by kind, not by position, so a change reads the way
 * a reviewer thinks about it: an effect added, removed, renamed, emitted more or
 * fewer times, or its payload changed at one path.
 */
function effectDiff(a: { kind: string }[], b: { kind: string }[], prefix: string, out: string[], limit: number): void {
  const byKind = (list: { kind: string }[]) => {
    const m = new Map<string, { kind: string }[]>();
    for (const e of list) m.set(e.kind, [...(m.get(e.kind) ?? []), e]);
    return m;
  };
  const before = byKind(a);
  const after = byKind(b);
  const rest = (e: { kind: string }) => stableStringify({ ...e, kind: undefined });
  const removed = [...before.keys()].filter((k) => !after.has(k));
  const added = [...after.keys()].filter((k) => !before.has(k));

  // A kind that disappeared while another appeared with the same payloads is a rename.
  for (const r of [...removed]) {
    const twin = added.find((k) => before.get(r)!.length === after.get(k)!.length && before.get(r)!.every((e, i) => rest(e) === rest(after.get(k)![i])));
    if (!twin) continue;
    out.push(`${prefix}: ${r} renamed to ${twin}`);
    removed.splice(removed.indexOf(r), 1);
    added.splice(added.indexOf(twin), 1);
  }
  for (const k of removed) out.push(`${prefix}: ${k} no longer emitted${before.get(k)!.length > 1 ? ` (was ×${before.get(k)!.length})` : ''}`);
  for (const k of added) out.push(`${prefix}: ${k} now emitted${after.get(k)!.length > 1 ? ` ×${after.get(k)!.length}` : ''}`);
  for (const [k, was] of before) {
    const now = after.get(k);
    if (!now) continue;
    if (was.length !== now.length) out.push(`${prefix}: ${k} emitted ×${was.length} → ×${now.length}`);
    for (let i = 0; i < Math.min(was.length, now.length) && out.length < limit; i++) {
      const at = was.length > 1 || now.length > 1 ? `${prefix}[${k}#${i + 1}]` : `${prefix}[${k}]`;
      jsonDiff({ ...was[i], kind: undefined }, { ...now[i], kind: undefined }, at, out, limit);
    }
  }
}

/** Up to `limit` paths where two JSON values differ, for human-readable diffs. */
export function jsonDiff(a: unknown, b: unknown, prefix = '', out: string[] = [], limit = 6): string[] {
  if (out.length >= limit) return out;
  if (isObj(a) && isObj(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)].filter((k) => a[k] !== undefined || b[k] !== undefined));
    for (const k of [...keys].sort()) {
      const p = prefix ? `${prefix}.${k}` : k;
      const inA = a[k] !== undefined;
      const inB = b[k] !== undefined;
      if (inA && !inB) out.push(`${p} removed`);
      else if (!inA && inB) out.push(`${p} added`);
      else jsonDiff(a[k], b[k], p, out, limit);
      if (out.length >= limit) break;
    }
    return out;
  }
  if (stableStringify(a) === stableStringify(b)) return out;
  if (isEffectList(a) && isEffectList(b) && (a.length || b.length)) {
    effectDiff(a, b, prefix || 'effects', out, limit);
    return out.slice(0, limit);
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const p = prefix || 'value';
    for (let i = 0; i < Math.min(a.length, b.length) && out.length < limit; i++) jsonDiff(a[i], b[i], `${p}[${i}]`, out, limit);
    if (a.length !== b.length && out.length < limit) {
      out.push(a.length > b.length
        ? `${p}: ${a.length - b.length} item(s) removed, ${a.slice(b.length).map(short).join(', ')}`
        : `${p}: ${b.length - a.length} item(s) added, ${b.slice(a.length).map(short).join(', ')}`);
    }
    return out;
  }
  out.push(`${prefix || 'value'}: ${short(a)} → ${short(b)}`);
  return out;
}
