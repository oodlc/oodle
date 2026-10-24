import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Compiled, compile, readCompiled } from '@oodle/compile';
import { loadSpec, SPEC_DIR, specHash } from '@oodle/spec';
import { summarize, type VerifyReport, verify } from '@oodle/verify';
import { resolveBuild } from '../builds.ts';
import { CliError, type Ctx, done, EXIT } from '../context.ts';
import { intentChecks } from './intents.ts';

const EXAMPLE = `intent: Owners can book a trusted walker in under a minute, and walkers get paid for every walk they do.

personas:
  owner:  { can: [book walks, cancel their own walks, rate a walker] }
  walker: { can: [set availability, accept or decline walks, see their earnings] }

domain:
  walk:
    fields: { owner, walker, starts_at, minutes: [30, 60], price, status }
    states: requested -> accepted -> done | declined | cancelled
    rules:
      - A walker has at most one walk at any moment
      - An owner can cancel for free until 2 hours before starts_at

journeys:
  - id: first-booking
    persona: owner
    steps:
      - 'Ada opens the app, picks Sam for Tuesday 9:00, 30 minutes: she sees "Requested, $20"'
      - 'Sam accepts: Ada sees "Accepted" and gets an email'
      - 'Ada cancels on Monday at 18:00: she sees "Cancelled, no charge"'

constraints:
  - An owner is never charged for a walk that didn't happen
  - No one sees another owner's address
  - Booking answers within 300 ms at p95 in production   # checked in production, reported only
  - Runs on Cloudflare Workers with D1                   # the stack is a constraint when you care

decisions: []                                            # the generator writes these
`;

const EMPTY = `# Why the app exists, who uses it, what it holds, what they go through, and what must never happen.
# Run \`oodle interview\` to write this in a conversation, or fill it in by hand.
intent:

personas: {}
  # owner: { can: [book walks, cancel their own walks] }

domain: {}

journeys: []

constraints: []

decisions: []
`;

export function init(ctx: Ctx, opts: { example?: boolean }): number {
  const dir = join(ctx.root, SPEC_DIR);
  if (existsSync(dir)) throw new CliError(`${SPEC_DIR}/ already exists here.`, EXIT.usage);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'spec.yaml'), opts.example ? EXAMPLE : EMPTY);
  const gitignore = join(ctx.root, '.gitignore');
  if (!existsSync(gitignore) || !readFileSync(gitignore, 'utf8').split('\n').includes('.oodle/')) appendFileSync(gitignore, '.oodle/\n');
  ctx.print(`Wrote ${SPEC_DIR}/spec.yaml${opts.example ? ' (the dog-walking example)' : ''}. Next: ${opts.example ? '`oodle compile`' : '`oodle interview`'}.`);
  return done(ctx, { created: `${SPEC_DIR}/spec.yaml` });
}

export async function compileCommand(ctx: Ctx, opts: { check?: boolean }): Promise<number> {
  if (opts.check) {
    const result = await compile(ctx.root, { check: true });
    const compiled = readCompiled(ctx.root);
    for (const j of compiled.journeys) {
      ctx.print(`\njourney ${j.journey} (compiled by ${j.by})`);
      for (const [i, line] of j.prose.entries()) {
        ctx.print(`  ${i + 1}. ${line}`);
        for (const s of j.scenario.steps.filter((st) => st.line === i)) {
          const what = s.do ? `${s.as} does ${s.do}${s.input ? ` ${JSON.stringify(s.input)}` : ''}` : `${s.as} looks`;
          const look = s.look
            ? `, then ${s.look.as ?? s.as} looks at ${s.look.screen ?? 'the result'}${s.look.params ? ` ${JSON.stringify(s.look.params)}` : ''}`
            : '';
          ctx.print(`       ${s.at ? `[${s.at}] ` : ''}${what}${look}${s.expect ? ` → expects ${JSON.stringify(s.expect)}` : ''}`);
        }
      }
    }
    for (const c of compiled.checks)
      ctx.print(
        `\n${'decision' in c.for ? 'decision' : 'constraint'}: ${c.text}\n  → ${c.check.kind}${c.check.kind === 'unchecked' ? `: ${c.check.reason}` : ''}`,
      );
    ctx.print(result.stale.length ? `\nOut of date: ${result.stale.join('; ')}. Run \`oodle compile\`.` : '\nUp to date.');
    return done(ctx, { stale: result.stale, compiled }, result.stale.length ? EXIT.failed : EXIT.ok);
  }
  const result = await compile(ctx.root, { model: ctx.model(), cap: ctx.config.explore.cap });
  ctx.print(result.compiled.length ? `Compiled ${result.compiled.join('; ')}.` : 'Nothing to compile: up to date.');
  for (const u of result.unchecked) ctx.print(`  ! unchecked: ${u.text} (${u.reason})`);
  return done(ctx, result);
}

/** Compiles what is stale (a model is asked only then), and returns what verify runs. */
export async function compiled(ctx: Ctx) {
  await compile(ctx.root, { model: ctx.model(), cap: ctx.config.explore.cap });
  return readCompiled(ctx.root);
}

export async function verifyCommand(
  ctx: Ctx,
  buildArg: string | undefined,
  opts: { explore?: boolean; typecheck?: boolean; compile?: boolean },
): Promise<number> {
  const build = resolveBuild(ctx, buildArg);
  let c: Compiled;
  if (opts.compile === false) {
    // As committed: never compile (a build checking itself must not change its spec copy).
    const stale = (await compile(ctx.root, { check: true })).stale;
    if (stale.length) throw new CliError(`oodle/compiled is out of date (${stale.join('; ')}); run \`oodle compile\` first.`);
    c = readCompiled(ctx.root);
  } else c = await compiled(ctx);
  const report = await verify(build.dir, c, { explore: opts.explore, typecheck: opts.typecheck, intents: await intentChecks(ctx, build.dir) });
  saveReport(ctx, build, report);
  ctx.print(summarize(report));
  const { results: _results, ...rest } = report;
  return done(ctx, rest, report.passed ? EXIT.ok : EXIT.failed);
}

export function saveReport(ctx: Ctx, build: { dir: string; id?: string }, report: VerifyReport) {
  const { results, ...rest } = report;
  const base = build.id ? ctx.work('builds', build.id) : ctx.work('verify', build.dir.replace(/[^a-zA-Z0-9]+/g, '_').slice(-60));
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, 'verify.json'), `${JSON.stringify({ ...rest, spec_hash: specHashOf(ctx) }, null, 2)}\n`);
  writeFileSync(join(base, 'observations.json'), `${JSON.stringify(results)}\n`);
}

const specHashOf = (ctx: Ctx) => specHash(loadSpec(ctx.root).spec);
