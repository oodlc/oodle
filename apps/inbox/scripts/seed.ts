/**
 * Sets up a project without the UI: the project, its first owner, and a first project token,
 * through `wrangler d1 execute`. Prints the token once.
 *
 *   node scripts/seed.ts --project dogwalk --name "Dog walks" --owner you@example.com --remote
 *   node scripts/seed.ts --local --demo        # local dev: dogwalk, DEV_EMAIL as owner, demo gaps
 *   node scripts/seed.ts ... --print           # only print the SQL
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { DemoFixture } from '../src/shared/seed.ts';
import { bootstrapSql, demoSql } from '../src/shared/seed.ts';
import fixture from '../test/fixtures/dogwalk-gaps.json' with { type: 'json' };

const root = new URL('..', import.meta.url).pathname;

const { values } = parseArgs({
  options: {
    project: { type: 'string', default: 'dogwalk' },
    name: { type: 'string' },
    owner: { type: 'string' },
    repo: { type: 'string' },
    label: { type: 'string', default: 'seed' },
    db: { type: 'string', default: 'oodle-inbox' },
    local: { type: 'boolean', default: false },
    remote: { type: 'boolean', default: false },
    demo: { type: 'boolean', default: false },
    print: { type: 'boolean', default: false },
  },
});

/** DEV_EMAIL from .dev.vars, so local seeding matches who `wrangler dev` says you are. */
function devEmail(): string | undefined {
  const file = join(root, '.dev.vars');
  if (!existsSync(file)) return undefined;
  return /^DEV_EMAIL=(.+)$/m.exec(readFileSync(file, 'utf8'))?.[1]?.trim();
}

const owner = values.owner ?? (values.local ? (devEmail() ?? 'you@example.com') : undefined);
if (!owner) {
  console.error('Pass --owner <email> (the first owner, as Cloudflare Access will name them).');
  process.exit(2);
}
if (!values.print && values.local === values.remote) {
  console.error('Pass exactly one of --local or --remote (or --print to only print the SQL).');
  process.exit(2);
}

const { statements, token } = await bootstrapSql({
  project: values.project,
  name: values.name ?? values.project,
  owner,
  ...(values.repo ? { repoUrl: values.repo } : {}),
  tokenLabel: values.label,
});
if (values.demo) statements.push(...demoSql(values.project, fixture as unknown as DemoFixture));
const sql = `${statements.join('\n')}\n`;

if (values.print) {
  process.stdout.write(sql);
} else {
  const where = values.local ? '--local' : '--remote';
  const wrangler = join(root, 'node_modules', '.bin', 'wrangler');
  const run = (...args: string[]) => execFileSync(wrangler, args, { cwd: root, stdio: 'inherit' });
  run('d1', 'migrations', 'apply', values.db, where);
  const file = join(mkdtempSync(join(tmpdir(), 'oodle-seed-')), 'seed.sql');
  writeFileSync(file, sql);
  run('d1', 'execute', values.db, where, `--file=${file}`);
}

console.error(`
Project "${values.project}" with owner ${owner}.
Project token (shown once, stored only as a hash):

  ${token}

Give it to the CLI as OODLE_TOKEN, or run \`oodle login <inbox-url>\`.`);
