/**
 * Running the coding agent: Claude Code, headless, through the Agent SDK. It works in the build's
 * `app/` folder and nowhere else. It may read inside it, write inside it except under `oodle/`
 * (where only `decisions.proposed.yaml` and `blocked.yaml` are its to write), and run a short list
 * of commands: install, typecheck, apply migrations locally, and `pnpm check`. Everything else is
 * refused. The tier guard after the run is what enforces the spec; this keeps the agent in its lane.
 */
import { appendFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { type CanUseTool, query } from '@anthropic-ai/claude-agent-sdk';

export interface AgentRun {
  cwd: string;
  prompt: string;
  /** Where to append the transcript, one message per line. */
  transcript: string;
  model?: string;
}

export interface AgentOutcome {
  ok: boolean;
  error?: string;
  turns: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

/** What runs the agent. Tests pass a fake that writes files the way an agent would. */
export type AgentRunner = (run: AgentRun) => Promise<AgentOutcome>;

const COMMANDS = [
  /^pnpm (install|i)( --[a-z-]+)*$/,
  /^pnpm (run )?(typecheck|check)$/,
  /^(pnpm exec |npx )?tsc( --noEmit)?( -p \S+)?$/,
  /^(pnpm exec |npx )?wrangler d1 migrations apply \S+ --local$/,
  /^(ls|pwd)( -[a-zA-Z]+)?( [\w./-]+)?$/,
];
const WRITES = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const READS = new Set(['Read', 'Glob', 'Grep', 'LS']);
const OODLE_WRITABLE = new Set(['oodle/decisions.proposed.yaml', 'oodle/blocked.yaml']);

/** Whether the agent may use a tool with this input, working in `cwd`. */
export function permit(cwd: string, tool: string, input: Record<string, unknown>): { ok: true } | { ok: false; why: string } {
  const inside = (p: unknown) => {
    if (typeof p !== 'string' || !p) return undefined;
    const rel = relative(cwd, isAbsolute(p) ? p : resolve(cwd, p));
    return rel.startsWith('..') || isAbsolute(rel) ? undefined : rel;
  };
  if (READS.has(tool)) {
    const p = input.file_path ?? input.path ?? input.notebook_path;
    if (p !== undefined && inside(p) === undefined) return { ok: false, why: 'work only inside the app folder' };
    return { ok: true };
  }
  if (WRITES.has(tool)) {
    const rel = inside(input.file_path ?? input.notebook_path);
    if (rel === undefined) return { ok: false, why: 'write only inside the app folder' };
    if ((rel === 'oodle' || rel.startsWith('oodle/')) && !OODLE_WRITABLE.has(rel))
      return { ok: false, why: 'the spec is read-only: only people change it. Propose decisions in oodle/decisions.proposed.yaml' };
    if (rel === 'AGENTS.md') return { ok: false, why: 'AGENTS.md is written from the spec' };
    return { ok: true };
  }
  if (tool === 'Bash') {
    const cmd = String(input.command ?? '').trim();
    if (COMMANDS.some((re) => re.test(cmd))) return { ok: true };
    return {
      ok: false,
      why: `only these commands are allowed: pnpm install, pnpm typecheck, pnpm check, tsc, wrangler d1 migrations apply <db> --local, ls. Use the file tools for everything else.`,
    };
  }
  if (tool === 'TodoWrite') return { ok: true };
  return { ok: false, why: `${tool} isn't available here` };
}

export function claudeAgent(opts: { model?: string; maxTurns?: number } = {}): AgentRunner {
  return async (run) => {
    const canUseTool: CanUseTool = async (tool, input) => {
      const verdict = permit(run.cwd, tool, input);
      return verdict.ok ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: verdict.why };
    };
    const outcome: AgentOutcome = { ok: false, turns: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 };
    try {
      for await (const message of query({
        prompt: run.prompt,
        options: {
          cwd: run.cwd,
          model: run.model ?? opts.model,
          tools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'TodoWrite'],
          canUseTool,
          permissionMode: 'default',
          settingSources: [],
          maxTurns: opts.maxTurns ?? 300,
          systemPrompt: {
            type: 'preset',
            preset: 'claude_code',
            append: 'You are building an app for Oodle. AGENTS.md in your working folder is your brief; follow it exactly.',
          },
          env: { ...process.env, OODLE_AGENT: '1' },
        },
      })) {
        appendFileSync(run.transcript, `${JSON.stringify(message)}\n`);
        if (message.type === 'result') {
          outcome.turns = message.num_turns ?? 0;
          outcome.costUsd = message.total_cost_usd ?? 0;
          outcome.inputTokens = message.usage?.input_tokens ?? 0;
          outcome.outputTokens = message.usage?.output_tokens ?? 0;
          outcome.ok = message.subtype === 'success';
          if (!outcome.ok) outcome.error = message.subtype;
        }
      }
    } catch (e) {
      outcome.error = (e as Error).message;
    }
    return outcome;
  };
}
