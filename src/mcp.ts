/**
 * `oodle mcp`: Oodle as a Model Context Protocol server over stdio, for coding
 * agents. It can read everything and run everything, but it can only *propose*
 * catalog changes: there is no tool that edits or removes an outcome, a
 * constraint or an intent. Those are human decisions. See docs/decisions/0006.
 *
 * Runs happen in a fresh `oodle` child process each time, so the app is always
 * re-imported and an edit the agent just made is what gets run.
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { loadCatalog, loadConfig } from './catalog.ts';
import { draftPrompt } from './draft.ts';
import { propose } from './propose.ts';
import { OodleError } from './errors.ts';
import { BUILTIN_CONDITIONS } from './security.ts';
import type { Gap, Observation } from './types.ts';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'oodle.js');
const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

/** Runs the oodle CLI with --json and returns its one document. */
export function oodleJson(args: string[], cwd: string, timeout = 900_000): Promise<{ code: number | null; doc: any }> {
  return new Promise((done) => {
    const env: NodeJS.ProcessEnv = { ...process.env, OODLE_QUIET: '1', NO_COLOR: '1' };
    for (const k of ['CI', 'GITHUB_ACTIONS', 'OODLE_FORMAT', 'OODLE_WATCH_REPORT', 'NODE_TEST_CONTEXT']) delete env[k];
    const child = spawn(process.execPath, [BIN, ...args, '--json'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.on('close', (code) => {
      clearTimeout(timer);
      let doc: any;
      try { doc = JSON.parse(out); } catch { doc = { ok: false, error: { code: 'internal', message: out.slice(0, 2000) || `oodle exited ${code}` } }; }
      done({ code, doc });
    });
  });
}

const problemsOf = (o: Observation) => [...(o.kind === 'outcome' ? o.failures : []), ...o.violations];

/** A run, cut down to what an agent acts on. */
export function agentRun(doc: any) {
  if (doc.error) return doc;
  const obs: Observation[] = doc.observations ?? [];
  const pick = (f: (o: Observation) => boolean, what: (o: Observation) => string[]) =>
    obs.filter(f).map((o) => ({ id: o.id, condition: o.condition, problems: what(o), status: o.status, body: o.body }));
  return {
    ok: doc.ok,
    summary: doc.summary,
    not_holding: pick((o) => !o.proposed && problemsOf(o).length > 0, problemsOf),
    proposed_not_yet_holding: pick((o) => !!o.proposed && problemsOf(o).length > 0, problemsOf),
    drift: pick((o) => o.kind === 'behavior' && o.failures.length > 0, (o) => o.failures),
    proposed_constraint_notices: obs.filter((o) => o.notices.length).map((o) => ({ id: o.id, condition: o.condition, notices: o.notices })),
    unknown_routes: (doc.gaps as Gap[] ?? []).map((g) => ({ route: g.route, probe: g.probe.status ?? g.probe.error, violations: g.violations, proposal: g.proposal })),
    lint: doc.lint,
  };
}

/** A diff, cut down: only what is not held, and a plain line on what to do about it. */
export function agentDiff(doc: any) {
  if (doc.error) return doc;
  const notHeld = (doc.outcomes ?? []).filter((o: any) => o.status !== 'held');
  return {
    ok: doc.ok,
    blocking: doc.blocking,
    base: doc.base,
    outcomes: notHeld.map((o: any) => ({ id: o.id, status: o.status, blocking: o.blocking, details: o.details })),
    constraints: doc.constraints,
    behavior_changes: [
      ...(doc.outcomes ?? []).filter((o: any) => o.behavior.length).map((o: any) => ({ under: o.id, changes: o.behavior })),
      ...(doc.behaviors ?? []).filter((b: any) => b.status !== 'held' || b.violations.length).map((b: any) => ({ id: b.id, status: b.status, changes: b.details, violations: b.violations })),
    ],
    unknown_routes: (doc.gaps ?? []).map((g: any) => ({ route: g.route, violations: g.violations })),
    lint: doc.lint,
    what_to_do: whatToDo(notHeld, doc),
  };
}

function whatToDo(notHeld: any[], doc: any): string[] {
  const out: string[] = [];
  const by = (s: string) => notHeld.filter((o) => o.status === s).map((o) => o.id);
  if (by('broken').length) out.push(`Fix the code: these outcomes held on the base and now break: ${by('broken').join(', ')}.`);
  if (by('failing').length) out.push(`These outcomes do not hold: ${by('failing').join(', ')}. If they were failing before your change, say so rather than weakening them.`);
  const human = [...by('changed'), ...by('redefined'), ...by('removed')];
  if (human.length) out.push(`A human must approve: ${human.join(', ')}. Explain each change in the PR; do not edit outcomes to make them pass.`);
  if ((doc.constraints ?? []).some((c: any) => c.blocking)) out.push('A constraint was changed or removed: that needs a human. Revert it unless you were asked to change it.');
  if ((doc.behaviors ?? []).some((b: any) => b.violations.length) || (doc.gaps ?? []).some((g: any) => g.violations.length)) out.push('A constraint is violated outside any outcome: fix the code.');
  if ((doc.gaps ?? []).length) out.push('Routes nothing describes: add each as a behavior, or propose an outcome for it with the propose tool.');
  if (!out.length) out.push('Nothing blocking. Mention any behavior changes in the PR.');
  return out;
}

// ── Protocol ────────────────────────────────────────────────────────────────

const str = (description: string) => ({ type: 'string', description });
const strs = (description: string) => ({ type: 'array', items: { type: 'string' }, description });

const TOOLS = [
  {
    name: 'run',
    description: 'Run outcomes, behaviors and constraints in the sealed simulation. Returns only what does not hold, drift, unknown routes and lint. Use `only` to iterate on one outcome.',
    inputSchema: { type: 'object', properties: { only: strs('Ids or globs to run, e.g. ["checkout.*"]') } },
  },
  {
    name: 'check',
    description: 'The outcome diff of the working tree against a git ref: what this change breaks, changes or redefines, and what a human must approve. Run before saying you are done.',
    inputSchema: { type: 'object', properties: { base_ref: str('Ref to compare against. Default: the default branch') } },
  },
  { name: 'lint', description: 'Validate the catalog: schema, traceability, references.', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'catalog',
    description: 'Every intent, outcome, behavior, condition (including the built-in security.* pack) and constraint, with statements and status. Read this before writing code or proposals.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'explain',
    description: 'One outcome or behavior in full: its definition, and what the app did under each condition (status, body, effects) with every failure.',
    inputSchema: { type: 'object', properties: { id: str('Outcome or behavior id') }, required: ['id'] },
  },
  {
    name: 'mutate',
    description: 'Plant small bugs in the app and report which ones the catalog catches. Survivors point at outcomes to tighten or conditions to add. Slow: scope it with files and only.',
    inputSchema: { type: 'object', properties: { files: strs('Globs relative to the project'), only: strs('Outcome ids or globs to run'), max: { type: 'number', description: 'At most this many mutants. Default 60' } } },
  },
  {
    name: 'propose',
    description: 'Add catalog entries as proposals in oodlc/proposed.yaml. Intents, outcomes and constraints are marked status: proposed: they run and are reported but never block until a human approves them. Can only add: existing ids are refused. This is the only way to write to the catalog.',
    inputSchema: {
      type: 'object',
      properties: { yaml: str('A YAML mapping with any of intents, outcomes, behaviors, conditions, constraints, in the oodlc catalog format') },
      required: ['yaml'],
    },
  },
];

const PROMPTS = [
  {
    name: 'draft',
    description: 'Turn a brief (PRD, ticket, a few sentences) into proposed intents, outcomes, conditions and constraints for this project.',
    arguments: [{ name: 'brief', description: 'What should be built, in words', required: true }],
  },
];

const INSTRUCTIONS = `Oodle protects declared outcomes. The catalog in oodlc/ is the spec: outcomes and constraints are human-approved and block merges; behaviors are observed and never block.
- Read the catalog tool first. Build against outcomes with run (use only to stay fast). Before finishing, call check and follow what_to_do.
- Never edit or delete an outcome, constraint or intent to make something pass. Use propose to add new ones; a human approves them.
- Prefer conditions over new outcomes for variants, and when to say what a condition changes. Use the security.* conditions for hostile inputs.
- Use mutate to find outcomes too loose to catch real bugs.`;

async function callTool(projectDir: string, name: string, args: any): Promise<unknown> {
  switch (name) {
    case 'run':
      return agentRun((await oodleJson(['run', projectDir, ...(args?.only ?? []).flatMap((g: string) => ['--only', g])], projectDir)).doc);
    case 'check':
      return agentDiff((await oodleJson(['check', projectDir, ...(args?.base_ref ? ['--base-ref', args.base_ref] : [])], projectDir)).doc);
    case 'lint':
      return (await oodleJson(['lint', projectDir], projectDir)).doc;
    case 'catalog': {
      const config = loadConfig(projectDir);
      const c = loadCatalog(projectDir, config);
      const brief = (x: { id: string; statement?: string; status?: string }) => ({ id: x.id, statement: x.statement, ...(x.status ? { status: x.status } : {}) });
      return {
        app: config.app,
        intents: c.intents.map(brief),
        outcomes: c.outcomes.map((o) => ({ ...brief(o), intent: o.intent, boundary: o.boundary, trigger: o.trigger.http, conditions: o.conditions ?? [] })),
        behaviors: c.behaviors.map((b) => ({ ...brief(b), boundary: b.boundary, trigger: b.trigger.http })),
        conditions: [...c.conditions.map(brief), ...BUILTIN_CONDITIONS.filter((b) => !c.conditions.some((x) => x.id === b.id)).map((b) => ({ ...brief(b), builtin: true }))],
        constraints: c.constraints.map((x) => ({ ...brief(x), check: x.check })),
        stubs: Object.keys(config.defaults?.given?.stubs ?? {}),
        files: c.sources,
      };
    }
    case 'explain': {
      const id = String(args?.id ?? '');
      const c = loadCatalog(projectDir, loadConfig(projectDir));
      const item = c.outcomes.find((o) => o.id === id) ?? c.behaviors.find((b) => b.id === id);
      if (!item) throw new OodleError('no-match', `No outcome or behavior "${id}"`, { hint: 'Call the catalog tool for the ids.' });
      const { doc } = await oodleJson(['run', projectDir, '--only', id], projectDir);
      if (doc.error) return doc;
      return {
        kind: c.outcomes.includes(item as any) ? 'outcome' : 'behavior',
        definition: item,
        file: c.sources[`outcomes:${id}`] ?? c.sources[`behaviors:${id}`],
        runs: (doc.observations as Observation[]).filter((o) => o.id === id).map((o) => ({ condition: o.condition, status: o.status, body: o.body, effects: o.effects, latency_ms: o.latency_ms, failures: o.failures, violations: o.violations, notices: o.notices, error: o.error })),
      };
    }
    case 'mutate': {
      const flags = [...(args?.files ?? []).flatMap((f: string) => ['--files', f]), ...(args?.only ?? []).flatMap((g: string) => ['--only', g]), '--max', String(args?.max ?? 60)];
      const { doc } = await oodleJson(['mutate', projectDir, ...flags], projectDir, 1_800_000);
      if (doc.error) return doc;
      return {
        score: doc.score,
        summary: doc.summary,
        survived: doc.mutants.filter((m: any) => m.status === 'survived').map((m: any) => ({ at: `${m.file}:${m.line}`, change: m.to ? `${m.from} -> ${m.to}` : `removed: ${m.from}` })),
        only_noticed: doc.mutants.filter((m: any) => m.status === 'noticed').map((m: any) => ({ at: `${m.file}:${m.line}`, change: m.to ? `${m.from} -> ${m.to}` : `removed: ${m.from}`, changed: m.changed })),
        killers: doc.killers,
        redundant: doc.redundant,
      };
    }
    case 'propose':
      return propose(projectDir, String(args?.yaml ?? ''));
    default:
      throw new OodleError('usage', `Unknown tool "${name}"`);
  }
}

type Message = { jsonrpc: '2.0'; id?: number | string | null; method?: string; params?: any };

/** Serves MCP over stdio until stdin closes. Logs go to stderr; stdout carries only protocol messages. */
export function serveMcp(projectDir: string, version: string): Promise<void> {
  const send = (msg: object) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
  const reply = (id: Message['id'], result: unknown) => send({ id, result });
  const fail = (id: Message['id'], code: number, message: string) => send({ id, error: { code, message } });

  const handle = async (msg: Message): Promise<unknown> => {
    const { id, method, params } = msg;
    if (method === undefined || id === undefined) return; // a response or a notification: nothing to say
    switch (method) {
      case 'initialize': {
        const asked = params?.protocolVersion;
        return reply(id, {
          protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[1],
          capabilities: { tools: {}, prompts: {} },
          serverInfo: { name: 'oodle', version },
          instructions: INSTRUCTIONS,
        });
      }
      case 'ping':
        return reply(id, {});
      case 'tools/list':
        return reply(id, { tools: TOOLS });
      case 'tools/call':
        try {
          const result = await callTool(projectDir, params?.name, params?.arguments ?? {});
          return reply(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: false });
        } catch (err) {
          const e = err as OodleError;
          const text = JSON.stringify({ error: { code: e.code ?? 'internal', message: e.message, hint: e.hint ?? null, problems: e.problems ?? [] } }, null, 2);
          return reply(id, { content: [{ type: 'text', text }], isError: true });
        }
      case 'prompts/list':
        return reply(id, { prompts: PROMPTS });
      case 'prompts/get': {
        if (params?.name !== 'draft') return fail(id, -32602, `Unknown prompt "${params?.name}"`);
        const text = `${draftPrompt(projectDir, String(params?.arguments?.brief ?? ''))}\nWhen you have the YAML, call the propose tool with it instead of replying with it.`;
        return reply(id, { description: PROMPTS[0].description, messages: [{ role: 'user', content: { type: 'text', text } }] });
      }
      case 'resources/list':
        return reply(id, { resources: [] });
      default:
        return fail(id, -32601, `Method not found: ${method}`);
    }
  };

  return new Promise((done) => {
    const rl = createInterface({ input: process.stdin });
    const pending = new Set<Promise<unknown>>();
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let msg: Message;
      try {
        msg = JSON.parse(line);
      } catch {
        return send({ id: null, error: { code: -32700, message: 'Parse error' } });
      }
      const p = handle(msg).catch((err) => fail(msg.id ?? null, -32603, (err as Error).message));
      pending.add(p);
      p.finally(() => pending.delete(p));
    });
    rl.on('close', () => Promise.all(pending).then(() => done()));
  });
}
