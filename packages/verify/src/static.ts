/**
 * Checks on a build's source, before anything runs. The determinism check reads the syntax tree
 * (oxc), not the text, so a comment or a string that mentions Date.now doesn't trip it and an
 * aliased call doesn't slip past a regex.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Vocabulary } from '@oodle/compile';
import type { Driver } from '@oodle/runtime';
import { parseSync } from 'oxc-parser';

export interface SourceViolation {
  file: string;
  line: number;
  what: string;
}

const SOURCE = /\.(ts|tsx|js|jsx|mjs|mts)$/;
/** The driver runs in the harness, not in the app, and only has `s.fetch`. */
const NOT_APP = /(^|\/)oodle\.driver\.tsx?$/;

function sources(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (SOURCE.test(name) && !name.endsWith('.d.ts')) out.push(p);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out.sort();
}

type AstNode = { type: string; start: number; [k: string]: unknown };
const isNode = (v: unknown): v is AstNode => !!v && typeof v === 'object' && typeof (v as AstNode).type === 'string';
const name = (n: unknown) => (isNode(n) && n.type === 'Identifier' ? (n.name as string) : undefined);
const isGlobalObject = (n: unknown) => ['globalThis', 'self', 'window'].includes(name(n) ?? '');

/** `x.y` (or `globalThis.x.y`) as "x.y", when it isn't computed. */
function memberPath(n: AstNode): string | undefined {
  if (n.type !== 'MemberExpression' || n.computed) return undefined;
  const prop = name(n.property);
  const obj = n.object as AstNode;
  if (isNode(obj) && obj.type === 'MemberExpression' && isGlobalObject(obj.object)) {
    const inner = name(obj.property);
    return inner && prop ? `${inner}.${prop}` : undefined;
  }
  const o = name(obj);
  return o && prop ? (isGlobalObject(obj) ? prop : `${o}.${prop}`) : undefined;
}

const FORBIDDEN = new Map([
  ['Date.now', 'Date.now() — use rt(c).now()'],
  ['Math.random', 'Math.random() — use rt(c).random()'],
  ['crypto.randomUUID', 'crypto.randomUUID() — use rt(c).id(kind)'],
  ['crypto.getRandomValues', 'crypto.getRandomValues() — use rt(c).random()'],
  ['performance.now', 'performance.now() — use rt(c).now()'],
  ['fetch', 'the global fetch — use rt(c).fetch()'],
]);

/** Names a file declares itself (variables, functions, imports, parameters), so a local `fetch` isn't the global one. */
function declared(program: AstNode): Set<string> {
  const names = new Set<string>();
  const visit = (n: unknown) => {
    if (Array.isArray(n)) return n.forEach(visit);
    if (!isNode(n)) return;
    if (n.type === 'VariableDeclarator' || n.type === 'FunctionDeclaration' || n.type === 'ClassDeclaration') {
      const id = name(n.id);
      if (id) names.add(id);
    }
    if (n.type.startsWith('Import') && n.type.endsWith('Specifier')) {
      const local = name(n.local);
      if (local) names.add(local);
    }
    if (Array.isArray(n.params)) for (const p of n.params) if (name(p)) names.add(name(p) as string);
    for (const v of Object.values(n)) if (v && typeof v === 'object') visit(v);
  };
  visit(program);
  return names;
}

/** Uses of time, randomness and the network that bypass @oodle/runtime. */
export function determinismViolations(dir: string): SourceViolation[] {
  const out: SourceViolation[] = [];
  for (const file of sources(join(dir, 'src'))) {
    const rel = relative(dir, file);
    if (NOT_APP.test(rel)) continue;
    const text = readFileSync(file, 'utf8');
    const { program, errors } = parseSync(file, text);
    if (errors.length) {
      out.push({ file: rel, line: 1, what: `doesn't parse: ${errors[0]?.message}` });
      continue;
    }
    const local = declared(program as unknown as AstNode);
    const lineOf = (at: number) => text.slice(0, at).split('\n').length;
    const report = (n: AstNode, what: string) => out.push({ file: rel, line: lineOf(n.start), what });
    const visit = (n: unknown) => {
      if (Array.isArray(n)) return n.forEach(visit);
      if (!isNode(n)) return;
      if (n.type === 'MemberExpression') {
        const path = memberPath(n);
        if (path && path !== 'fetch' && FORBIDDEN.has(path)) report(n, FORBIDDEN.get(path) as string);
        if (path === 'fetch' && isGlobalObject(n.object)) report(n, FORBIDDEN.get('fetch') as string);
      }
      if (n.type === 'NewExpression' && name(n.callee) === 'Date' && Array.isArray(n.arguments) && n.arguments.length === 0 && !local.has('Date')) {
        report(n, 'new Date() with no argument — use rt(c).now()');
      }
      if (n.type === 'CallExpression') {
        const callee = name(n.callee);
        if (callee === 'Date' && !local.has('Date')) report(n, 'Date() — use rt(c).now()');
        if (callee === 'fetch' && !local.has('fetch')) report(n, FORBIDDEN.get('fetch') as string);
      }
      for (const [k, v] of Object.entries(n)) if (k !== 'type' && v && typeof v === 'object') visit(v);
    };
    visit(program);
  }
  return out;
}

/** Actions and screens the vocabulary has and the driver doesn't. */
export function driverGaps(driver: Driver, vocab: Vocabulary): string[] {
  const missing: string[] = [];
  for (const a of vocab.actions) if (typeof driver.actions?.[a.id] !== 'function') missing.push(`action ${a.id}`);
  for (const s of vocab.screens) if (typeof driver.screens?.[s.name] !== 'function') missing.push(`screen ${s.name}`);
  return missing;
}

/** Runs the build's own typecheck when its dependencies are installed. Returns errors, or null when it couldn't run. */
export function typecheck(dir: string): string[] | null {
  const tsc = join(dir, 'node_modules', '.bin', 'tsc');
  if (!existsSync(tsc)) return null;
  try {
    execFileSync(tsc, ['--noEmit', '-p', dir], { cwd: dir, stdio: 'pipe', encoding: 'utf8' });
    return [];
  } catch (e) {
    const out = `${(e as { stdout?: string }).stdout ?? ''}${(e as { stderr?: string }).stderr ?? ''}`;
    return out
      .split('\n')
      .filter((l) => l.includes('error TS'))
      .slice(0, 20);
  }
}
