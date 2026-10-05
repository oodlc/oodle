/**
 * `oodle hook <event>`: Oodle's answers to a coding agent's lifecycle hooks.
 * Claude Code sends the event as JSON on stdin; the answer goes to stdout as
 * Claude Code's hook JSON. Anything Oodle cannot decide is left to the agent's
 * normal flow (no output, exit 0), so a broken setup never wedges a session.
 *
 * - session-start: tell the agent how this project is guarded.
 * - pre-tool-use:  ask the person before an edit that changes, removes or approves
 *                  an outcome, constraint or intent. Agents propose; humans approve.
 * - stop:          keep the agent working while something it can fix blocks the
 *                  merge, and tell the person what needs their approval.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parse } from 'yaml';
import { CONFIG_FILE, configFile, isProject, loadCatalog, loadConfig } from './catalog.ts';
import { stableStringify } from './expect.ts';
import { EXIT } from './errors.ts';
import { agentDiff, agentRun, oodleJson } from './mcp.ts';

export const HOOKS = ['session-start', 'pre-tool-use', 'stop'] as const;
/** Consecutive Stop blocks before Oodle lets the agent stop anyway, so a session can never loop forever. */
const MAX_STOP_BLOCKS = 3;

interface HookInput {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  stop_hook_active?: boolean;
  tool_name?: string;
  tool_input?: Record<string, any>;
}

function readStdin(): HookInput {
  try {
    return JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

const emit = (doc: object) => process.stdout.write(`${JSON.stringify(doc)}\n`);

/** The nearest project at or above `dir`, without throwing. */
function projectAbove(dir: string): string | null {
  for (let d = resolve(dir); ; d = dirname(d)) {
    if (isProject(d)) return d;
    if (existsSync(join(d, '.git')) || dirname(d) === d) return null;
  }
}

export async function runHook(event: string, version: string): Promise<number> {
  const input = readStdin();
  const cwd = input.cwd ?? process.cwd();
  try {
    if (event === 'session-start') sessionStart(cwd, version);
    else if (event === 'pre-tool-use') preToolUse(input, cwd);
    else if (event === 'stop') await stop(input, cwd);
    else {
      process.stderr.write(`Unknown hook "${event}". Hooks: ${HOOKS.join(', ')}\n`);
      return EXIT.usage;
    }
  } catch (err) {
    // A hook that crashes must not block the agent: say so on stderr and step aside.
    process.stderr.write(`oodle hook ${event}: ${(err as Error).message}\n`);
  }
  return EXIT.ok;
}

// ── session-start ───────────────────────────────────────────────────────────

function sessionStart(cwd: string, version: string) {
  const dir = projectAbove(cwd);
  if (!dir) return;
  const config = loadConfig(dir);
  const c = loadCatalog(dir, config);
  const where = relative(cwd, dir) || '.';
  const proposed = [...c.intents, ...c.outcomes, ...c.constraints].filter((x) => x.status === 'proposed').length;
  const context = `This project is guarded by Oodle ${version} (OODLC). The catalog in ${join(where, config.catalog)}/ is the spec: ${c.outcomes.length} outcomes, ${c.constraints.length} constraints, ${c.behaviors.length} behaviors${proposed ? `, ${proposed} proposals waiting for a human` : ''}.
- Outcomes and constraints are human-approved and block merges. Behaviors are observed and never block. Internals (anything not visible at the boundary) are yours to change.
- Work against the outcomes: \`npx --no-install oodle run --only "<id or glob>" --json\` while iterating, \`npx --no-install oodle check --json\` before you finish. A Stop hook runs the check too.
- Never edit, delete or approve an outcome, constraint or intent to make something pass, and never add \`status: proposed\` to an approved one. Never pass \`--approve\` or post \`/oodle approve\`: approving a change to a promise is the person's call. To add one, propose it: \`npx --no-install oodle propose <file.yaml>\` (or the oodle MCP propose tool). Editing approved entries asks the person first.
- For variants use conditions, and \`when\` to say what a condition changes; for hostile input use the built-in security.* conditions. \`npx --no-install oodle mutate --files <glob> --only <glob>\` shows which planted bugs the outcomes miss.
- External calls go through ctx.effects only; the simulation is sealed and real network access is a blocking violation.`;
  emit({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } });
}

// ── pre-tool-use ────────────────────────────────────────────────────────────

const GUARDED = ['intents', 'outcomes', 'constraints'] as const;

function entries(text: string): Map<string, any> | null {
  let doc: any;
  try {
    doc = parse(text) ?? {};
  } catch {
    return null;
  }
  const out = new Map<string, any>();
  if (!doc || typeof doc !== 'object') return out;
  for (const s of GUARDED) for (const item of Array.isArray(doc[s]) ? doc[s] : []) if (item?.id) out.set(`${s.slice(0, -1)} ${item.id}`, item);
  return out;
}

/** What an edit would do to approved entries: change, remove, approve or add one directly. */
export function catalogConcerns(before: string, after: string): string[] {
  const a = entries(before);
  const b = entries(after);
  if (!a || !b) return [];
  const concerns: string[] = [];
  for (const [key, was] of a) {
    if (was.status === 'proposed') continue;
    const now = b.get(key);
    if (!now) concerns.push(`removes the approved ${key}`);
    else if (now.status === 'proposed') concerns.push(`marks the approved ${key} as proposed, which would stop it blocking`);
    else if (stableStringify(now) !== stableStringify(was)) concerns.push(`changes the approved ${key}`);
  }
  for (const [key, now] of b) {
    if (now.status === 'proposed') continue;
    const was = a.get(key);
    if (!was) concerns.push(`adds ${key} as approved; agents propose (status: proposed) and a person approves`);
    else if (was.status === 'proposed') concerns.push(`approves the proposed ${key}`);
  }
  return concerns;
}

function configConcerns(before: string, after: string): string[] {
  let a: any;
  let b: any;
  try {
    a = parse(before) ?? {};
    b = parse(after) ?? {};
  } catch {
    return [];
  }
  const out: string[] = [];
  if (stableStringify(a?.sealed ?? null) !== stableStringify(b?.sealed ?? null)) out.push('changes `sealed`, which decides whether the app may reach the real network');
  if (stableStringify(a?.probe ?? null) !== stableStringify(b?.probe ?? null)) out.push('changes `probe`, which decides which hostile conditions unknown routes are probed with');
  if (stableStringify(a?.app ?? null) !== stableStringify(b?.app ?? null)) out.push('changes `app`, which decides what Oodle runs');
  return out;
}

/** The file content after an Edit, MultiEdit or Write, from Claude Code's tool input. */
function afterEdit(tool: string, input: Record<string, any>, before: string): string | null {
  if (tool === 'Write') return String(input.content ?? '');
  const apply = (text: string, e: Record<string, any>) => (e.replace_all ? text.split(e.old_string).join(e.new_string) : text.replace(e.old_string, () => e.new_string));
  if (tool === 'Edit') return apply(before, input);
  if (tool === 'MultiEdit') return (input.edits ?? []).reduce(apply, before);
  return null;
}

const CATALOG_PATH = /(^|[\s'"/=])(oodlc\/[^\s'"]*\.ya?ml|oodle\.yaml)/;
const WRITES = /\bsed\s+(-[a-zA-Z]*i|--in-place)|\bperl\s+-[a-zA-Z]*i|>>?|\btee\b|\brm\b|\bmv\b|\bcp\b|\bgit\s+(checkout|restore|rm|mv)\b|\bpython3?\b|\bnode\b.*-e|\byq\b.*-i/;

function preToolUse(input: HookInput, cwd: string) {
  const tool = input.tool_name ?? '';
  const ti = input.tool_input ?? {};
  let concerns: string[] = [];
  let what = '';

  if (tool === 'Bash') {
    const cmd = String(ti.command ?? '');
    if (CATALOG_PATH.test(cmd) && WRITES.test(cmd) && !/\boodle\s+propose\b/.test(cmd)) {
      what = 'This shell command';
      concerns = ['may rewrite the Oodle catalog outside the edit tools, where Oodle cannot see what it changes'];
    }
  } else if (['Edit', 'MultiEdit', 'Write'].includes(tool) && ti.file_path) {
    const file = isAbsolute(ti.file_path) ? ti.file_path : resolve(cwd, ti.file_path);
    const project = projectAbove(dirname(file));
    if (!project) return;
    const config = loadConfig(project);
    const catalogDir = resolve(project, config.catalog);
    const isConfig = resolve(file) === configFile(project)?.path || (dirname(file) === catalogDir && basename(file) === CONFIG_FILE);
    if (!/\.ya?ml$/.test(file) || (dirname(file) !== catalogDir && !isConfig)) return;
    const before = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const after = afterEdit(tool, ti, before);
    if (after === null) return;
    concerns = isConfig ? configConcerns(before, after) : catalogConcerns(before, after);
    what = `This edit to ${relative(cwd, file) || file}`;
  }
  if (!concerns.length) return;

  const strict = !!process.env.OODLE_HOOK_STRICT;
  const reason = `Oodle: ${what} ${concerns.join('; ')}. Outcomes, constraints and intents are approved by a person, not an agent. ${strict ? 'Propose a new entry with `oodle propose` instead, or ask the person to make this change.' : 'Approve only if you asked for this change.'}`;
  emit({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: strict ? 'deny' : 'ask', permissionDecisionReason: reason } });
}

// ── stop ────────────────────────────────────────────────────────────────────

function inGit(dir: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: dir, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Counts consecutive blocks per session, so the loop guard survives between hook processes. */
function blockCount(session: string | undefined, update?: number): number {
  const dir = join(tmpdir(), 'oodle-hooks');
  const file = join(dir, `${(session ?? 'default').replace(/[^\w-]/g, '_')}.json`);
  if (update !== undefined) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify({ blocks: update }));
    return update;
  }
  try {
    return JSON.parse(readFileSync(file, 'utf8')).blocks ?? 0;
  } catch {
    return 0;
  }
}

/** Errors the agent can fix by editing code or the catalog it just touched. */
const FIXABLE_ERRORS = new Set(['app-load', 'app-contract', 'app-crash', 'catalog', 'sealed']);

async function stop(input: HookInput, cwd: string) {
  const dir = projectAbove(cwd);
  if (!dir) return;
  const git = inGit(dir);
  const { doc } = await oodleJson(git ? ['check', dir] : ['run', dir], dir);

  const fixable: string[] = [];
  const human: string[] = [];
  const fyi: string[] = [];

  if (doc.error) {
    if (FIXABLE_ERRORS.has(doc.error.code)) fixable.push(`Oodle could not run the app: ${doc.error.message}${doc.error.problems?.length ? `\n  ${doc.error.problems.join('\n  ')}` : ''}`);
    else fyi.push(`Oodle could not check this change: ${doc.error.message}`);
  } else if (git) {
    const d = agentDiff(doc);
    for (const o of d.outcomes) {
      if (o.status === 'broken' || o.status === 'failing') fixable.push(`outcome ${o.id} ${o.status}: ${o.details.slice(0, 4).join('; ')}`);
      else if (['changed', 'redefined', 'removed'].includes(o.status)) human.push(`outcome ${o.id} ${o.status}${o.fingerprint ? ` (approve: ${o.id}@${o.fingerprint})` : ''}`);
      else if (o.status === 'proposed' && !o.details.includes('proposed, holding')) fyi.push(`proposed outcome ${o.id} does not hold yet`);
    }
    for (const c of d.constraints ?? []) if (c.blocking) human.push(`constraint ${c.id} ${c.status}${c.fingerprint ? ` (approve: ${c.id}@${c.fingerprint})` : ''}`);
    for (const b of d.behavior_changes) if (b.violations?.length) fixable.push(`behavior ${b.id} violates: ${b.violations.join('; ')}`);
    for (const g of d.unknown_routes) if (g.violations.length) fixable.push(`route ${g.route} (described by nothing) violates: ${g.violations.join('; ')}`);
    for (const l of d.lint?.errors ?? []) fixable.push(`catalog lint: ${l}`);
    if (d.unknown_routes.length) fyi.push(`${d.unknown_routes.length} route(s) nothing describes: ${d.unknown_routes.map((g: any) => g.route).join(', ')}`);
  } else {
    const r = agentRun(doc);
    for (const o of r.not_holding) fixable.push(`${o.id} [${o.condition}]: ${o.problems.join('; ')}`);
    for (const g of r.unknown_routes) if (g.violations.length) fixable.push(`route ${g.route} violates: ${g.violations.join('; ')}`);
    for (const l of r.lint?.errors ?? []) fixable.push(`catalog lint: ${l}`);
  }

  const message = [
    human.length && `Oodle: needs your approval before merge: ${human.join(', ')}.`,
    fyi.length && `Oodle: ${fyi.join(' · ')}.`,
  ].filter(Boolean).join(' ');

  if (!fixable.length) {
    blockCount(input.session_id, 0);
    if (message) emit({ systemMessage: message });
    return;
  }
  const count = input.stop_hook_active ? blockCount(input.session_id) : 0;
  if (count >= MAX_STOP_BLOCKS) {
    blockCount(input.session_id, 0);
    emit({ systemMessage: `Oodle: still blocking after ${MAX_STOP_BLOCKS} attempts, so the agent stopped: ${fixable.slice(0, 3).join(' | ')}${message ? ` ${message}` : ''}` });
    return;
  }
  blockCount(input.session_id, count + 1);
  const reason = [
    `Oodle ${git ? 'check' : 'run'} is blocking, and this is fixable in code:`,
    ...fixable.map((f) => `- ${f}`),
    '',
    'Fix the code so these hold. Do not edit, remove or weaken outcomes or constraints to make them pass. If one really is wrong, stop and say why: a person decides.',
    human.length ? `Also tell the person these need their approval: ${human.join(', ')}.` : '',
  ].filter(Boolean).join('\n');
  emit({ decision: 'block', reason, ...(message ? { systemMessage: message } : {}) });
}
