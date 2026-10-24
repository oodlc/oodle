/**
 * `oodle login` and `oodle sync`. The token comes from OODLE_TOKEN or the OS keychain (macOS
 * `security`, Linux `secret-tool`), never from oodle.config.yaml. Where neither keychain exists,
 * it goes in ~/.config/oodle/tokens.json, readable only by you, and login says so.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { CONFIG_FILE, specDir } from '@oodle/spec';
import { sync } from '@oodle/sync';
import { parseDocument } from 'yaml';
import { CliError, type Ctx, done, EXIT } from '../context.ts';
import { intentsForSync, onApproval } from './intents.ts';

const SERVICE = 'oodle';
const has = (cmd: string) => {
  try {
    execFileSync('which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};
const fileStore = () => join(homedir(), '.config', 'oodle', 'tokens.json');

export function storeToken(url: string, token: string): string {
  if (process.platform === 'darwin' && has('security')) {
    execFileSync('security', ['add-generic-password', '-U', '-s', SERVICE, '-a', url, '-w', token], { stdio: 'ignore' });
    return 'the macOS keychain';
  }
  if (has('secret-tool')) {
    execFileSync('secret-tool', ['store', '--label', `oodle ${url}`, 'service', SERVICE, 'account', url], {
      input: token,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    return 'the keyring';
  }
  const path = fileStore();
  mkdirSync(join(path, '..'), { recursive: true });
  const all = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>) : {};
  all[url] = token;
  writeFileSync(path, JSON.stringify(all, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600);
  return `${path} (no keychain found; the file is readable only by you)`;
}

export function readToken(url: string): string | undefined {
  if (process.env.OODLE_TOKEN) return process.env.OODLE_TOKEN;
  try {
    if (process.platform === 'darwin' && has('security'))
      return execFileSync('security', ['find-generic-password', '-s', SERVICE, '-a', url, '-w'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    if (has('secret-tool'))
      return (
        execFileSync('secret-tool', ['lookup', 'service', SERVICE, 'account', url], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() ||
        undefined
      );
  } catch {
    // not stored
  }
  const path = fileStore();
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>)[url] : undefined;
}

export async function loginCommand(ctx: Ctx, url: string, opts: { project?: string; token?: string }): Promise<number> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new CliError(`"${url}" isn't a URL.`, EXIT.usage);
  }
  const remote = parsed.origin;
  let token = opts.token;
  if (!token && ctx.tty) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    token = (await rl.question(`Project token for ${remote} (an owner makes one in the inbox, under People and tokens): `)).trim();
    rl.close();
  }
  if (!token) throw new CliError('Give the token with --token, or run login in a terminal.', EXIT.usage);
  const where = storeToken(remote, token);
  if (opts.project) {
    const path = join(specDir(ctx.root), CONFIG_FILE);
    const doc = parseDocument(existsSync(path) ? readFileSync(path, 'utf8') : '');
    if (!doc.contents) doc.contents = doc.createNode({}) as never;
    doc.set('remote', doc.createNode({ url: remote, project: opts.project }));
    writeFileSync(path, doc.toString());
  }
  ctx.print(`Stored the token for ${remote} in ${where}.${opts.project ? ` oodle/${CONFIG_FILE} now syncs project ${opts.project}.` : ''}`);
  return done(ctx, { remote, stored_in: where, project: opts.project ?? null });
}

export async function syncCommand(ctx: Ctx, opts: { watch?: string }): Promise<number> {
  const once = async () => {
    const remote = ctx.config.remote;
    const result = await sync(ctx.root, {
      config: ctx.config,
      token: remote ? readToken(new URL(remote.url).origin) : undefined,
      intents: await intentsForSync(ctx),
      onApproval: (a) => onApproval(ctx, a),
    });
    if (result.skipped) ctx.print(result.skipped);
    else {
      ctx.print(
        `Pushed ${result.pushed.gaps} gaps, ${result.pushed.intents} intents, ${result.pushed.applied} applied answers; pulled ${result.pulled.answers} answers and ${result.pulled.approvals} reviews.`,
      );
      for (const a of result.applied) ctx.print(`  ✓ applied ${a.answer} to ${a.gap}${a.sha ? ` in ${a.sha.slice(0, 7)}` : ''}`);
      for (const r of result.refused) ctx.print(`  ✗ ${r.answer} on ${r.gap}: ${r.why}`);
    }
    return result;
  };
  if (!opts.watch) return done(ctx, await once());
  const every = Math.max(5, Number(opts.watch) || 30) * 1000;
  for (;;) {
    const r = await once();
    if (r.skipped) return done(ctx, r);
    await new Promise((res) => setTimeout(res, every));
  }
}
