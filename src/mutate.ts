/**
 * Mutation testing in simulation. Oodle makes small, plausible bugs in the app
 * (a flipped comparison, a dropped effect, a changed literal), runs the catalog
 * against each one, and reports which bugs the declared outcomes and constraints
 * catch. A bug nothing catches points at an outcome that is too loose or a
 * condition that is missing. With `--tests`, the same bugs run through an
 * existing test suite too, so tests that catch nothing the catalog doesn't can be
 * deleted.
 *
 * Each mutant runs in its own mirror of the repository (the project copied,
 * everything else symlinked) and in its own `oodle run --json` child process
 * with a timeout, since a mutant can loop forever.
 */
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './catalog.ts';
import { nextSourceFiles } from './next-routes.ts';
import { stableStringify } from './expect.ts';
import { OodleError } from './errors.ts';
import type { EffectRecord, Gap, Observation } from './types.ts';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'oodle.js');

// ── Mutants ─────────────────────────────────────────────────────────────────

export interface Mutant {
  id: number;
  /** Relative to the project. */
  file: string;
  line: number;
  column: number;
  operator: string;
  from: string;
  to: string;
  start: number;
  end: number;
}

type Range = [start: number, end: number];

/** Splits source into code, string-literal and skipped (comment, template, regex) ranges. Good enough for app code, not a parser. */
export function scan(src: string): { code: Range[]; strings: Range[] } {
  const code: Range[] = [];
  const strings: Range[] = [];
  let i = 0;
  let codeStart = 0;
  let lastSignificant = '';
  const flush = (end: number) => {
    if (end > codeStart) code.push([codeStart, end]);
  };

  const skipString = (q: string, at: number): number => {
    let j = at + 1;
    while (j < src.length && src[j] !== q && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
    return j + 1;
  };
  // Templates may nest code in ${...}, which may hold more templates and strings.
  const skipTemplate = (at: number): number => {
    let j = at + 1;
    while (j < src.length) {
      if (src[j] === '\\') j += 2;
      else if (src[j] === '`') return j + 1;
      else if (src[j] === '$' && src[j + 1] === '{') {
        j += 2;
        let depth = 1;
        while (j < src.length && depth) {
          const ch = src[j];
          if (ch === '{') depth++;
          else if (ch === '}') depth--;
          if (ch === '`') j = skipTemplate(j);
          else if (ch === '"' || ch === "'") j = skipString(ch, j);
          else j++;
        }
      } else j++;
    }
    return j;
  };
  const regexAllowed = () => !lastSignificant || /[(,=:[!&|?{};+\-*%<>~^]$/.test(lastSignificant) || /\b(return|typeof|case|in|of|void|delete|throw)$/.test(lastSignificant);

  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    let end = -1;
    let isString = false;
    if (ch === '/' && next === '/') end = src.indexOf('\n', i) === -1 ? src.length : src.indexOf('\n', i);
    else if (ch === '/' && next === '*') end = src.indexOf('*/', i + 2) === -1 ? src.length : src.indexOf('*/', i + 2) + 2;
    else if (ch === '"' || ch === "'") {
      end = skipString(ch, i);
      isString = true;
    } else if (ch === '`') end = skipTemplate(i);
    else if (ch === '/' && regexAllowed()) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length && src[j] !== '\n' && (inClass || src[j] !== '/')) {
        if (src[j] === '\\') j++;
        else if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        j++;
      }
      j++;
      while (/[a-z]/.test(src[j] ?? '')) j++;
      end = j;
    }
    if (end === -1) {
      if (!/\s/.test(ch)) {
        // Remember the last token-ish text, for telling a regex from a division.
        const word = /^[A-Za-z_$][\w$]*/.exec(src.slice(i));
        lastSignificant = word ? word[0] : ch;
        i += word ? word[0].length : 1;
      } else i++;
      continue;
    }
    flush(i);
    if (isString) strings.push([i, end]);
    lastSignificant = 'x'; // a literal behaves like an operand
    i = end;
    codeStart = end;
  }
  flush(src.length);
  return { code, strings };
}

const SWAPS: Record<string, string> = {
  '===': '!==', '!==': '===', '==': '!=', '!=': '==',
  '<=': '<', '>=': '>', '<': '<=', '>': '>=',
  '&&': '||', '||': '&&',
  '+': '-', '-': '+', '*': '/', '/': '*',
};
const OPERATOR_NAME: Record<string, string> = {
  '===': 'equality', '!==': 'equality', '==': 'equality', '!=': 'equality',
  '<=': 'boundary', '>=': 'boundary', '<': 'boundary', '>': 'boundary',
  '&&': 'logic', '||': 'logic', '+': 'arithmetic', '-': 'arithmetic', '*': 'arithmetic', '/': 'arithmetic',
};
/**
 * Lines no simulated run reaches or should judge: starting a server for real (Oodle drives the app in
 * process and never listens) and logging. A bug planted there survives every catalog, and says nothing.
 */
const BOILERPLATE = /\.listen\(|process\.argv\b|require\.main\b|import\.meta\.main\b|process\.env\.PORT\b|^\s*console\.\w+\(/;
/** These read as generics, arrows or unary signs when they touch their neighbours, so only spaced ones are comparisons or arithmetic. */
const NEEDS_SPACES = new Set(['<', '>', '<=', '>=', '+', '-', '*', '/']);
const KEYWORD_LINE = /^\s*(if|for|while|switch|return|throw|const|let|var|else|case|do|try|catch|import|export|type|interface|function|class)\b/;

/** Line ranges that hold only types: interface bodies and type aliases. Literals there are not behavior. */
function typeOnlyLines(lines: string[]): Set<number> {
  const skip = new Set<number>();
  let depth = 0;
  let inType = false;
  lines.forEach((l, n) => {
    if (!inType && /^\s*(export\s+)?(declare\s+)?(interface|type)\s+\w/.test(l)) {
      inType = true;
      depth = 0;
    }
    if (inType) {
      skip.add(n);
      depth += (l.match(/[{(<[]/g) ?? []).length - (l.match(/[})>\]]/g) ?? []).length;
      if (depth <= 0 && /[;}]\s*$|^\s*(export\s+)?type\s+\w+\s*=\s*[^{]*$/.test(l)) inType = false;
    }
  });
  return skip;
}

export function mutantsOf(src: string, file: string): Omit<Mutant, 'id'>[] {
  const { code, strings } = scan(src);
  const lines = src.split('\n');
  const lineStarts: number[] = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') lineStarts.push(i + 1);
  const where = (pos: number) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: pos - lineStarts[lo] + 1 };
  };
  const typeLines = typeOnlyLines(lines);
  const skipLine = (n: number) => typeLines.has(n - 1) || /^\s*(import|export\s+[^=]*\bfrom\b|export\s*\{)/.test(lines[n - 1]) || /\brequire\(|import\(/.test(lines[n - 1]) || BOILERPLATE.test(lines[n - 1]);
  const out: Omit<Mutant, 'id'>[] = [];
  const add = (start: number, end: number, operator: string, to: string) => {
    const at = where(start);
    if (skipLine(at.line)) return;
    out.push({ file, ...at, operator, from: src.slice(start, end), to, start, end });
  };

  for (const [s, e] of code) {
    const text = src.slice(s, e);
    for (const m of text.matchAll(/===|!==|==|!=|<=|>=|=>|&&|\|\||\+\+|--|\+=|-=|\*=|\/=|\*\*|[<>+\-*/!]/g)) {
      const op = m[0];
      const at = s + m.index!;
      const before = src[at - 1] ?? '';
      const after = src[at + op.length] ?? '';
      if (op === '!') {
        // Unary negation of a name or a parenthesised expression: drop it.
        // `x!` is a TypeScript non-null assertion, not a negation.
        if (/[\w$)\]]/.test(before) || !/[\w$(!]/.test(after)) continue;
        add(at, at + 1, 'negation', '');
        continue;
      }
      if (!(op in SWAPS)) continue;
      if (NEEDS_SPACES.has(op) && !(before === ' ' && after === ' ')) continue;
      add(at, at + op.length, OPERATOR_NAME[op], SWAPS[op]);
    }
    for (const m of text.matchAll(/(?<![\w$.])(\d+(?:\.\d+)?)(?![\w$.])/g)) {
      const n = Number(m[1]);
      add(s + m.index!, s + m.index! + m[1].length, 'literal', String(n === 0 ? 1 : n === 1 ? 0 : n + 1));
    }
    for (const m of text.matchAll(/(?<![\w$.])(true|false)(?![\w$])/g)) {
      add(s + m.index!, s + m.index! + m[1].length, 'literal', m[1] === 'true' ? 'false' : 'true');
    }
  }
  for (const [s, e] of strings) {
    const inner = src.slice(s + 1, e - 1);
    if (!inner || inner === 'use strict') continue;
    // Object keys written as strings are shape, not behavior.
    if (/^\s*:/.test(src.slice(e, e + 3))) continue;
    add(s, e, 'string', `${src[s]}${src[s]}`);
  }

  // Whole statements: an effect, a call or an assignment on one line, removed.
  const balanced = (l: string) => [['(', ')'], ['{', '}'], ['[', ']']].every(([a, b]) => l.split(a).length === l.split(b).length);
  let offset = 0;
  for (const [n, l] of lines.entries()) {
    const start = offset + (l.length - l.trimStart().length);
    offset += l.length + 1;
    if (KEYWORD_LINE.test(l) || !balanced(l) || !code.some(([s, e]) => start >= s && start < e)) continue;
    const call = /^\s*(await\s+)?[\w$.]+\(.*\);\s*$/.test(l);
    const assign = /^\s*[\w$.[\]'"]+\s*(=|\+=|-=)\s*[^=].*;\s*$/.test(l);
    if (!call && !assign) continue;
    if (skipLine(n + 1)) continue;
    const text = l.trim();
    out.push({ file, line: n + 1, column: l.length - l.trimStart().length + 1, operator: /effects\.(emit|call)\(/.test(l) ? 'remove-effect' : 'remove-statement', from: text, to: '', start, end: start + text.length });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Simple globs over project-relative paths: `**` any depth, `*` within a segment. */
const globRe = (g: string) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '(.*/)?')}$`);

const SOURCE = /\.(m|c)?(t|j)sx?$/;
const NOT_APP = /(^|\/)(node_modules|\.git|oodlc|test|tests|__tests__|spec)(\/|$)|\.(test|spec)\.[cm]?[tj]sx?$|\.d\.ts$/;

function walk(dir: string, root: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, root, out);
    else out.push(relative(root, p).split(sep).join('/'));
  }
  return out;
}

const EXTENSIONS = ['', '.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.jsx', '/index.ts', '/index.js'];

/** Project files the app entry imports, directly or not, following relative imports only. */
function importGraph(projectDir: string, entry: string): string[] {
  const seen = new Set<string>();
  const visit = (abs: string, isEntry = false) => {
    const rel = relative(projectDir, abs).split(sep).join('/');
    if (seen.has(rel) || rel.startsWith('..') || (!isEntry && NOT_APP.test(rel))) return;
    let src: string;
    try { src = readFileSync(abs, 'utf8'); } catch { return; }
    seen.add(rel);
    for (const m of src.matchAll(/(?:^|[^\w$.])(?:import|export)\s[^'"]*?from\s*['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)|require\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
      // `import type` is erased at runtime: there is no behavior to mutate behind it.
      if (/^(?:^|[^\w$.])import\s+type\b/.test(m[0])) continue;
      const spec = m[1] ?? m[2] ?? m[3];
      const base = resolve(dirname(abs), spec);
      const candidates = [...EXTENSIONS.map((e) => base + e), base.replace(/\.js$/, '.ts'), base.replace(/\.mjs$/, '.mts')];
      const hit = candidates.find((c) => { try { return readFileSync(c) && SOURCE.test(c); } catch { return false; } });
      if (hit) visit(hit);
    }
  };
  visit(resolve(projectDir, entry), true);
  return [...seen].sort();
}

/** An @oodlc/oodle/adapter module only wires the app into the simulation. Mutating it tests Oodle, not the app. */
const isAdapter = (projectDir: string, file: string) => /\bfrom\s*['"]@oodlc\/oodle\/(adapter|next)['"]/.test(readFileSync(join(projectDir, file), 'utf8'));

/** Files to mutate: the given globs, or every project file the app imports, minus tests and adapters. */
export function sourceFiles(projectDir: string, globs?: string[]): string[] {
  if (globs?.length) {
    const res = globs.map(globRe);
    return walk(projectDir, projectDir).filter((f) => SOURCE.test(f) && res.some((r) => r.test(f)));
  }
  const app = loadConfig(projectDir).app;
  // A Next.js app loads its route handlers at run time, so nothing imports them: start from each one too.
  const entries = /\bfrom\s*['"]@oodlc\/oodle\/next['"]/.test(readFileSync(join(projectDir, app), 'utf8'))
    ? [app, ...nextSourceFiles(dirname(resolve(projectDir, app))).map((f) => relative(projectDir, f))]
    : [app];
  return [...new Set(entries.flatMap((e) => importGraph(projectDir, e)))].sort().filter((f) => !isAdapter(projectDir, f));
}

// ── Workspaces ──────────────────────────────────────────────────────────────

function gitRoot(dir: string): { root: string; common: string } | null {
  try {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    // --git-common-dir is relative to the directory git runs in, so ask from the root.
    const common = resolve(root, execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
    return { root, common };
  } catch {
    return null;
  }
}

/**
 * A copy of the project at the same relative place in a mirror of the repository, with every
 * other entry symlinked, so relative imports and node_modules resolve as they do in place.
 */
function mirror(root: string, projectDir: string, dest: string): string {
  mkdirSync(dest, { recursive: true });
  const chain = relative(root, projectDir).split(sep).filter(Boolean);
  let src = root;
  let dst = dest;
  for (const seg of chain) {
    for (const e of readdirSync(src)) if (e !== seg && e !== '.git') symlinkSync(join(src, e), join(dst, e));
    src = join(src, seg);
    dst = join(dst, seg);
    mkdirSync(dst);
  }
  for (const e of readdirSync(projectDir)) {
    if (e === '.git') continue;
    if (e === 'node_modules') symlinkSync(join(projectDir, e), join(dst, e));
    else cpSync(join(projectDir, e), join(dst, e), { recursive: true, filter: (p) => !p.split(sep).includes('node_modules') && !p.split(sep).includes('.git') });
  }
  return dst;
}

// ── Running ─────────────────────────────────────────────────────────────────

interface Proc {
  code: number | null;
  stdout: string;
  timedOut: boolean;
  ms: number;
}

function exec(cmd: string, args: string[], opts: { cwd: string; timeout: number; shell?: boolean }): Promise<Proc> {
  return new Promise((done) => {
    const env: NodeJS.ProcessEnv = { ...process.env, OODLE_QUIET: '1', NO_COLOR: '1' };
    // NODE_TEST_CONTEXT would make a nested `node --test` report to a parent runner instead of printing.
    for (const k of ['CI', 'GITHUB_ACTIONS', 'FORCE_COLOR', 'OODLE_FORMAT', 'OODLE_WATCH_REPORT', 'GITHUB_STEP_SUMMARY', 'NODE_TEST_CONTEXT']) delete env[k];
    const t0 = performance.now();
    const child = spawn(cmd, args, { cwd: opts.cwd, env, shell: opts.shell, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let stdout = '';
    let timedOut = false;
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stdout += opts.shell ? d : ''));
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }, opts.timeout);
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ code, stdout, timedOut, ms: performance.now() - t0 });
    });
  });
}

interface RunDoc {
  ok: boolean;
  observations?: Observation[];
  gaps?: Gap[];
  lint?: { errors: string[] };
  error?: { code: string; message: string };
}

const runOodle = (dir: string, only: string[] | undefined, timeout: number) =>
  exec(process.execPath, [BIN, 'run', dir, '--json', ...(only ?? []).flatMap((g) => ['--only', g])], { cwd: dir, timeout });

/** Every test name in TAP (`ok 1 - name`) or spec-style (`✔ name (1.2ms)`) output. */
export function allTests(output: string): string[] {
  const names = new Set<string>();
  for (const m of output.matchAll(/^\s*(?:not )?ok \d+ - (.+?)(?:\s+#.*)?$/gm)) names.add(m[1].trim());
  for (const m of output.matchAll(/^\s*[✔✓✖✕×] (.+?) \([\d.]+\s*m?s\)\s*$/gm)) names.add(m[1].trim());
  return [...names];
}

/** Failing test names from TAP (`not ok 3 - name`) or spec-style (`✖ name (1.2ms)`) output. */
export function failingTests(output: string): string[] {
  const names = new Set<string>();
  for (const m of output.matchAll(/^\s*not ok \d+ - (.+?)(?:\s+#.*)?$/gm)) names.add(m[1].trim());
  for (const m of output.matchAll(/^\s*[✖✕×] (.+?) \([\d.]+\s*m?s\)\s*$/gm)) names.add(m[1].trim());
  return [...names];
}

// Rows written count: a mutant that changes what is stored is a real change, even though the diff only reports it.
const boundary = (effects: EffectRecord[]) => effects.filter((e) => e.boundary !== 'internal').map(({ kind, payload, result, error }) => ({ kind, payload, result, error }));
const keyOf = (o: Observation) => `${o.kind}:${o.id}:${o.condition}`;
const blocking = (o: Observation) => o.violations.length > 0 || (o.kind === 'outcome' && !o.proposed && o.failures.length > 0);
const killers = (o: Observation) => [
  ...(o.kind === 'outcome' && !o.proposed && o.failures.length ? [o.id] : []),
  ...o.violations.map((v) => /^constraint (\S+)/.exec(v)?.[1]).filter((c): c is string => !!c).map((c) => `constraint:${c}`),
];

// ── The report ──────────────────────────────────────────────────────────────

/**
 * killed: an outcome or constraint failed. noticed: customer-visible output changed but every expectation
 * passed, so only a reviewer reading `oodle check` would catch it. internal: only internal effects changed,
 * which outcomes deliberately allow. survived: nothing changed that anyone checks.
 */
export type MutantStatus = 'killed' | 'noticed' | 'internal' | 'survived' | 'timeout' | 'invalid';

export interface MutantResult extends Omit<Mutant, 'start' | 'end'> {
  status: MutantStatus;
  /** Outcome ids and `constraint:<id>` that caught it. */
  killed_by: string[];
  /** For `noticed`: outcomes and behaviors whose observable output changed although every expectation passed. */
  changed: string[];
  /** Tests that failed on this mutant, with `--tests`. */
  tests_failed?: string[];
  reason?: string;
}

export interface Killer {
  id: string;
  kills: number;
  /** Mutants nothing else in the catalog catches. */
  unique: number;
}

export interface MutateReport {
  project: string;
  files: string[];
  /** killed / (mutants - invalid - internal), 0..1. Timeouts count as killed. */
  score: number;
  summary: Record<MutantStatus, number> & { mutants: number; generated: number };
  mutants: MutantResult[];
  killers: Killer[];
  /** Outcomes and constraints that ran and caught no mutant at all, or none that a smaller set doesn't catch too. */
  redundant: string[];
  tests?: {
    command: string;
    /** Failing before any mutation; ignored. */
    baseline_failing: string[];
    killers: (Killer & { beyond_catalog: number })[];
    /**
     * Tests that caught at least one planted bug, and only bugs the catalog caught too. Evidence the
     * outcomes cover them on these bugs, not proof: a test may still guard inputs no outcome sends.
     */
    redundant: string[];
    /** Tests that caught no planted bug at all. That says nothing either way: the sample may not reach them. */
    no_kills: string[];
    /** Mutants the tests catch and the catalog misses: each is an outcome or condition worth writing. */
    catalog_misses: number[];
  };
  elapsed_ms: number;
}

export interface MutateOptions {
  files?: string[];
  only?: string[];
  max?: number;
  jobs?: number;
  tests?: string;
  onProgress?: (done: number, total: number) => void;
  /** Registers cleanup for Ctrl-C; returns a function that unregisters it. */
  track?: (cleanup: () => void) => () => void;
}

/** Greedy set cover: the smallest-ish set of killers that still catches every killed mutant. The rest add nothing. */
function cover(kills: Map<string, Set<number>>): Set<string> {
  const left = new Set([...kills.values()].flatMap((s) => [...s]));
  const chosen = new Set<string>();
  while (left.size) {
    let best = '';
    let gain = 0;
    for (const [id, s] of [...kills].sort((a, b) => a[0].localeCompare(b[0]))) {
      const g = [...s].filter((m) => left.has(m)).length;
      if (g > gain) [best, gain] = [id, g];
    }
    if (!gain) break;
    chosen.add(best);
    for (const m of kills.get(best)!) left.delete(m);
  }
  return chosen;
}

function tally(kills: Map<string, Set<number>>, others: (id: string) => Set<number>): Killer[] {
  return [...kills].map(([id, s]) => {
    const rest = others(id);
    return { id, kills: s.size, unique: [...s].filter((m) => !rest.has(m)).length };
  }).sort((a, b) => b.kills - a.kills || a.id.localeCompare(b.id));
}

export async function mutate(projectDir: string, opts: MutateOptions = {}): Promise<MutateReport> {
  const t0 = performance.now();
  const files = sourceFiles(projectDir, opts.files);
  if (!files.length) {
    throw new OodleError('no-files', opts.files?.length ? `No source files match ${opts.files.map((f) => `"${f}"`).join(', ')}` : 'No source files to mutate next to the app', {
      hint: 'Name them with --files, e.g. --files "src/**/*.ts". Paths are relative to the project.',
    });
  }

  let all: Mutant[] = files.flatMap((f) => mutantsOf(readFileSync(join(projectDir, f), 'utf8'), f)).map((m, i) => ({ ...m, id: i + 1 }));
  const generated = all.length;
  const max = opts.max ?? 200;
  if (all.length > max) {
    // Spread the sample evenly over every file, deterministically.
    const step = all.length / max;
    all = Array.from({ length: max }, (_, i) => all[Math.floor(i * step)]);
  }

  const git = gitRoot(projectDir);
  const root = git?.root ?? projectDir;
  const base = git ? join(git.common, 'oodle', 'mutants') : tmpdir();
  mkdirSync(base, { recursive: true });
  const workRoot = mkdtempSync(join(base, 'run-'));
  const cleanup = () => rmSync(workRoot, { recursive: true, force: true });
  const untrack = opts.track?.(cleanup) ?? (() => {});

  try {
    // Baseline, in a mirror too, so base and mutants run the same way.
    const baseDir = mirror(root, projectDir, join(workRoot, 'base'));
    const baseline = await runOodle(baseDir, opts.only, 600_000);
    let baseDoc: RunDoc;
    try { baseDoc = JSON.parse(baseline.stdout); } catch { baseDoc = { ok: false, error: { code: 'internal', message: baseline.stdout.slice(0, 400) } }; }
    if (baseDoc.error) throw new OodleError('baseline', `The project does not run unmutated: ${baseDoc.error.message}`, { hint: 'Fix it first: `oodle run`.' });
    if (!baseDoc.ok) {
      throw new OodleError('not-holding', 'Something declared does not hold before any mutation', {
        exitCode: 1,
        hint: 'Mutation testing measures a green catalog. Run `oodle run`, fix what blocks, then mutate.',
      });
    }
    const baseObs = new Map((baseDoc.observations ?? []).map((o) => [keyOf(o), o]));
    const timeout = Math.max(10_000, baseline.ms * 5);

    let testBaseline: string[] = [];
    let testNames: string[] = [];
    let testTimeout = 0;
    if (opts.tests) {
      const t = await exec(opts.tests, [], { cwd: baseDir, timeout: 1_800_000, shell: true });
      testBaseline = t.code === 0 ? [] : failingTests(t.stdout);
      testNames = allTests(t.stdout).filter((n) => !testBaseline.includes(n));
      testTimeout = Math.max(30_000, t.ms * 5);
    }
    rmSync(join(workRoot, 'base'), { recursive: true, force: true });

    const results: MutantResult[] = new Array(all.length);
    let done = 0;
    const jobs = Math.max(1, Math.min(opts.jobs ?? Math.max(1, availableParallelism() - 1), all.length));
    let next = 0;
    const worker = async () => {
      while (next < all.length) {
        const i = next++;
        const m = all[i];
        const dir = mirror(root, projectDir, join(workRoot, `m${m.id}`));
        const path = join(dir, m.file);
        const src = readFileSync(path, 'utf8');
        writeFileSync(path, src.slice(0, m.start) + m.to + src.slice(m.end));
        const { start: _s, end: _e, ...where } = m;
        const r: MutantResult = { ...where, status: 'survived', killed_by: [], changed: [] };
        const proc = await runOodle(dir, opts.only, timeout);
        let doc: RunDoc | undefined;
        try { doc = JSON.parse(proc.stdout); } catch { /* handled below */ }
        if (proc.timedOut) {
          r.status = 'timeout';
          r.killed_by = ['timeout'];
        } else if (!doc || doc.error) {
          // Could not run: a crash in createApp is caught (CI fails); a mutant that doesn't compile tells us nothing.
          const code = doc?.error?.code;
          r.status = code === 'app-crash' || code === 'sealed' ? 'killed' : 'invalid';
          r.reason = doc?.error?.message ?? 'no output';
          if (r.status === 'killed') r.killed_by = [code === 'sealed' ? 'constraint:oodle.sealed' : 'app-crash'];
        } else {
          const obs = doc.observations ?? [];
          const killed = [...new Set([...obs.filter(blocking).flatMap(killers), ...(doc.gaps ?? []).flatMap((g) => g.violations.map((v) => /constraint (\S+)/.exec(v)?.[1]).filter(Boolean).map((c) => `constraint:${c}`))])];
          if (killed.length || (doc.lint?.errors.length ?? 0)) {
            r.status = 'killed';
            r.killed_by = killed.sort();
          } else {
            const changed = obs.filter((o) => {
              const b = baseObs.get(keyOf(o));
              return !b || stableStringify([o.status, o.body, boundary(o.effects)]) !== stableStringify([b.status, b.body, boundary(b.effects)]);
            });
            r.changed = [...new Set(changed.map((o) => o.id))].sort();
            const internal = (o: Observation) => stableStringify(o.effects.filter((e) => e.boundary === 'internal').map(({ kind, payload }) => ({ kind, payload })));
            if (r.changed.length || (doc.gaps?.length ?? 0) !== (baseDoc.gaps?.length ?? 0)) r.status = 'noticed';
            else if (obs.some((o) => { const b = baseObs.get(keyOf(o)); return b && internal(o) !== internal(b); })) r.status = 'internal';
          }
        }
        if (opts.tests && r.status !== 'invalid') {
          const t = await exec(opts.tests, [], { cwd: dir, timeout: testTimeout, shell: true });
          const failed = t.timedOut ? ['(timeout)'] : t.code === 0 ? [] : failingTests(t.stdout).filter((n) => !testBaseline.includes(n));
          r.tests_failed = failed.length || t.code === 0 || t.timedOut ? failed : ['(suite)'];
        }
        rmSync(join(workRoot, `m${m.id}`), { recursive: true, force: true });
        results[i] = r;
        opts.onProgress?.(++done, all.length);
      }
    };
    await Promise.all(Array.from({ length: jobs }, worker));

    const count = (s: MutantStatus) => results.filter((r) => r.status === s).length;
    // Invalid mutants say nothing, and internal-only ones change nothing an outcome promises.
    const valid = results.length - count('invalid') - count('internal');
    const caught = count('killed') + count('timeout');

    const kills = new Map<string, Set<number>>();
    for (const r of results) for (const k of r.killed_by) if (k !== 'timeout' && k !== 'app-crash') (kills.get(k) ?? kills.set(k, new Set()).get(k)!).add(r.id);
    const union = (except: string) => new Set([...kills].filter(([k]) => k !== except).flatMap(([, s]) => [...s]));
    const killersList = tally(kills, union);
    const ran = new Set((baseDoc.observations ?? []).filter((o) => o.kind === 'outcome' && !o.proposed).map((o) => o.id));
    const needed = cover(kills);
    const redundant = [...new Set([...ran].filter((id) => !needed.has(id)))].sort();

    const report: MutateReport = {
      project: projectDir,
      files,
      score: valid ? caught / valid : 0,
      summary: { generated, mutants: results.length, killed: count('killed'), noticed: count('noticed'), internal: count('internal'), survived: count('survived'), timeout: count('timeout'), invalid: count('invalid') },
      mutants: results,
      killers: killersList,
      redundant,
      elapsed_ms: Math.round(performance.now() - t0),
    };

    if (opts.tests) {
      const catalogKilled = new Set(results.filter((r) => r.status === 'killed' || r.status === 'timeout').map((r) => r.id));
      const testKills = new Map<string, Set<number>>(testNames.map((n) => [n, new Set<number>()]));
      for (const r of results) for (const t of r.tests_failed ?? []) (testKills.get(t) ?? testKills.set(t, new Set()).get(t)!).add(r.id);
      const testUnion = (except: string) => new Set([...testKills].filter(([k]) => k !== except).flatMap(([, s]) => [...s]));
      report.tests = {
        command: opts.tests,
        baseline_failing: testBaseline,
        killers: tally(testKills, testUnion).map((k) => ({ ...k, beyond_catalog: [...testKills.get(k.id)!].filter((m) => !catalogKilled.has(m)).length })),
        redundant: [...testKills].filter(([, s]) => s.size && [...s].every((m) => catalogKilled.has(m))).map(([k]) => k).sort(),
        no_kills: [...testKills].filter(([, s]) => !s.size).map(([k]) => k).sort(),
        catalog_misses: results.filter((r) => r.tests_failed?.length && !catalogKilled.has(r.id)).map((r) => r.id),
      };
    }
    return report;
  } finally {
    cleanup();
    untrack();
  }
}
