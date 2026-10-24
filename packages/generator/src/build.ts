/**
 * `oodle build`: one build of the app from the spec.
 *
 *   1. load the spec and its hash; buildId = hash[:8]-seed (a passing build with the same id is reused)
 *   2. .oodle/builds/<buildId>/app/ from the template, or from a previous build with `from`
 *   3. AGENTS.md, a copy of oodle/ (spec and compiled vocabulary), dependencies installed
 *   4. the agent runs in app/
 *   5. after the run, in order: the spec copy is unchanged (the tier guard, plus every other file
 *      under oodle/), no blocked.yaml, the determinism check, proposed decisions read and sorted
 *   6. manifest.json
 *
 * Verify, and appending new decisions to the spec once it passes, are the caller's next steps.
 * Independent builds share nothing but the spec and the template.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Model, Vocabulary } from '@oodle/compile';
import { declaredDiff, loadSpec, SPEC_DIR, type Spec, specHash } from '@oodle/spec';
import { copyTemplate } from '@oodle/template';
import { determinismViolations } from '@oodle/verify';
import { parse } from 'yaml';
import type { AgentOutcome, AgentRunner } from './agent.ts';
import { agentsMd } from './agents-md.ts';
import { PROPOSED, readProposals, type Sorted, sortProposals } from './decisions.ts';

export type BuildStatus = 'built' | 'blocked' | 'failed';

export interface Manifest {
  buildId: string;
  specHash: string;
  seed: number;
  from?: string;
  startedAt: string;
  endedAt: string;
  status: BuildStatus;
  problems: string[];
  blocked?: string;
  agentTranscriptPath: string;
  agent: AgentOutcome;
  proposedDecisions: Sorted;
  /** Set by the caller after verify. */
  verified?: boolean;
  /** Seconds the whole build took. */
  seconds: number;
}

export interface BuildOptions {
  seed?: number;
  /** A previous build to start from, for an incremental change. Never for the gaps check. */
  from?: string;
  runner: AgentRunner;
  vocab: Vocabulary;
  /** Judges near-duplicate decisions. */
  model?: Model;
  /** Rebuild even when a passing build with the same id exists. */
  force?: boolean;
  /** Skip installing dependencies (tests, offline). */
  install?: boolean;
  ruledOut?: string[];
  agentModel?: string;
  /** Builds directory; default <root>/.oodle/builds. */
  dir?: string;
}

export interface BuildResult {
  buildId: string;
  dir: string;
  app: string;
  manifest: Manifest;
  reused: boolean;
}

export const buildIdOf = (spec: Spec, seed: number) => `${specHash(spec).slice(0, 8)}-${seed}`;

const PROMPT =
  'Build the app that AGENTS.md describes, in this folder. Read AGENTS.md first, then oodle/compiled/journeys/ and oodle/compiled/actions.json. Finish only when `pnpm typecheck` and `pnpm check` pass, every action and screen is in src/oodle.driver.ts, and every choice a user could notice is in oodle/decisions.proposed.yaml.';

export async function build(root: string, opts: BuildOptions): Promise<BuildResult> {
  const started = Date.now();
  const { spec } = loadSpec(root);
  const seed = opts.seed ?? 1;
  const buildId = buildIdOf(spec, seed);
  const dir = join(opts.dir ?? join(root, '.oodle', 'builds'), buildId);
  const app = join(dir, 'app');
  const manifestPath = join(dir, 'manifest.json');

  if (!opts.force && existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
    if (manifest.status === 'built' && manifest.verified !== false && manifest.specHash === specHash(spec))
      return { buildId, dir, app, manifest, reused: true };
  }

  rmSync(dir, { recursive: true, force: true });
  mkdirSync(app, { recursive: true });
  if (opts.from)
    cpSync(join(dirname(dir), opts.from, 'app'), app, { recursive: true, filter: (src) => !/[/\\](node_modules|\.oodle|\.wrangler)([/\\]|$)/.test(src) });
  else copyTemplate(app);
  prepare(root, app, spec, opts);

  const before = snapshot(join(app, SPEC_DIR));
  const transcript = join(dir, 'transcript.jsonl');
  writeFileSync(transcript, '');
  const agent = await opts.runner({ cwd: app, prompt: PROMPT, transcript, model: opts.agentModel });

  const problems: string[] = [];
  if (!agent.ok) problems.push(`the agent stopped: ${agent.error ?? 'unknown'}`);
  const after = loadSpecSafe(app, problems);
  if (after) for (const c of declaredDiff(spec, after)) problems.push(`the agent changed the declared tier: ${c}`);
  for (const f of changedFiles(before, snapshot(join(app, SPEC_DIR)))) problems.push(`the agent changed oodle/${f}, which only people change`);

  let blocked: string | undefined;
  const blockedPath = join(app, SPEC_DIR, 'blocked.yaml');
  if (existsSync(blockedPath)) {
    const b = parse(readFileSync(blockedPath, 'utf8')) as { reason?: string } | string | null;
    blocked = (typeof b === 'string' ? b : b?.reason) ?? 'the agent stopped without saying why';
  }
  for (const v of determinismViolations(app)) problems.push(`${v.file}:${v.line}: ${v.what}`);

  const read = readProposals(app);
  if (read.problem) problems.push(read.problem);
  const proposedDecisions = await sortProposals(read.proposals, spec.decisions, { buildId, model: opts.model });
  for (const m of proposedDecisions.moved) problems.push(`the build would move a pinned decision: "${m.pinned.text}" → "${m.proposal.text}"`);

  const status: BuildStatus = blocked ? 'blocked' : problems.length ? 'failed' : 'built';
  const manifest: Manifest = {
    buildId,
    specHash: specHash(spec),
    seed,
    ...(opts.from ? { from: opts.from } : {}),
    startedAt: new Date(started).toISOString(),
    endedAt: new Date().toISOString(),
    status,
    problems,
    ...(blocked ? { blocked } : {}),
    agentTranscriptPath: relative(dir, transcript),
    agent,
    proposedDecisions,
    seconds: Math.round((Date.now() - started) / 1000),
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { buildId, dir, app, manifest, reused: false };
}

export function saveManifest(result: BuildResult) {
  writeFileSync(join(result.dir, 'manifest.json'), `${JSON.stringify(result.manifest, null, 2)}\n`);
}

const here = dirname(fileURLToPath(import.meta.url));
/** The folder of an Oodle package, for linking it into a build. */
function packageDir(name: string): string {
  return join(here, '..', '..', name === 'oodle' ? 'cli' : name.replace('@oodle/', ''));
}

/** AGENTS.md, the spec copy, package.json wired to this Oodle, dependencies installed. */
function prepare(root: string, app: string, spec: Spec, opts: BuildOptions) {
  const specCopy = join(app, SPEC_DIR);
  rmSync(specCopy, { recursive: true, force: true });
  cpSync(join(root, SPEC_DIR), specCopy, {
    recursive: true,
    filter: (src) => {
      const rel = relative(join(root, SPEC_DIR), src);
      return !rel.startsWith('gaps') && !rel.startsWith('intents');
    },
  });
  writeFileSync(join(specCopy, 'decisions.proposed.yaml'), '# Decisions you made where the spec is silent. See AGENTS.md.\n');
  writeFileSync(join(app, 'AGENTS.md'), agentsMd(spec, opts.vocab, { ruledOut: opts.ruledOut }));

  const pkg = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'));
  pkg.dependencies['@oodle/runtime'] = `link:${packageDir('@oodle/runtime')}`;
  pkg.scripts = {
    ...pkg.scripts,
    typecheck: 'tsc --noEmit',
    check: `node ${join(packageDir('oodle'), 'dist', 'bin.js')} --root . verify . --no-typecheck --no-compile`,
  };
  pkg.devDependencies = { '@cloudflare/workers-types': '5.20261022.1', typescript: '5.9.3' };
  writeFileSync(join(app, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  writeFileSync(join(app, 'pnpm-workspace.yaml'), 'packages: []\n');
  writeFileSync(join(app, '.gitignore'), 'node_modules/\n.oodle/\n.wrangler/\n');
  if (opts.install !== false) execFileSync('pnpm', ['install', '--prefer-offline', '--silent'], { cwd: app, stdio: 'pipe' });
}

function loadSpecSafe(app: string, problems: string[]): Spec | undefined {
  try {
    return loadSpec(app).spec;
  } catch (e) {
    problems.push(`the spec copy no longer loads: ${(e as Error).message}`);
    return undefined;
  }
}

/** Every file under a folder, by relative path, with a hash of its content. */
function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    if (!existsSync(d)) return;
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.set(relative(dir, p), createHash('sha256').update(readFileSync(p)).digest('hex'));
    }
  };
  walk(dir);
  return out;
}

const AGENT_FILES = new Set(['decisions.proposed.yaml', 'blocked.yaml']);

function changedFiles(before: Map<string, string>, after: Map<string, string>): string[] {
  const out: string[] = [];
  for (const [f, h] of before) if (!AGENT_FILES.has(f) && after.get(f) !== h) out.push(f);
  for (const f of after.keys()) if (!AGENT_FILES.has(f) && !before.has(f)) out.push(f);
  return out.sort();
}

export { PROPOSED };
