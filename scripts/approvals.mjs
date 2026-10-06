#!/usr/bin/env node
// Collects `/oodle approve <id@fingerprint> ...` lines from a pull request's reviews
// and comments, for `oodle check --approvals`. Only people with write access to the
// repository count, never bots, and never the pull request's author unless the
// workflow allows self-approval. See docs/decisions/0007.
//
// GitHub labels a member whose org membership is private as CONTRIBUTOR to anyone outside
// the org, the workflow's token included. So someone with an approve line and no trusted
// label is looked up: their permission on the repository decides.
//
// Usage: approvals.mjs <reviews.json> <comments.json> <pr-author> <allow-self: true|false> [permissions.json]
//        approvals.mjs --lookup <reviews.json> <comments.json>   (logins whose permission to look up)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const WRITE = new Set(['admin', 'maintain', 'write']);
const LINE = /^[ \t>]*\/oodle approve[ \t]+(.+)$/gim;
const TOKEN = /^[^\s@`]+@[0-9a-f]{8}$/;

/**
 * @param {Array<{ body?: string, user?: { login?: string, type?: string }, author_association?: string, state?: string }>} items
 * @param {{ author: string, allowSelf: boolean, permissions?: Record<string, string> }} opts
 *   permissions: each looked-up login (lowercase) to its permission on the repository
 */
export function collect(items, { author, allowSelf, permissions = {} }) {
  const out = [];
  const seen = new Set();
  for (const item of items) {
    const login = item.user?.login;
    if (!login || !item.body || item.state === 'DISMISSED' || item.state === 'PENDING') continue;
    if (item.user?.type === 'Bot') continue;
    if (!TRUSTED.has(item.author_association ?? '') && !WRITE.has(permissions[login.toLowerCase()] ?? '')) continue;
    if (!allowSelf && login.toLowerCase() === author.toLowerCase()) continue;
    for (const m of item.body.matchAll(LINE)) {
      for (const raw of m[1].trim().split(/\s+/)) {
        const token = raw.replace(/^`+|`+$/g, '');
        if (!TOKEN.test(token)) continue;
        const [id, fingerprint] = token.split('@');
        const key = `${id}@${fingerprint}@${login}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ id, fingerprint, by: login });
      }
    }
  }
  return out;
}

/** People with an approve line whose label doesn't show write access, so the Action asks GitHub. */
export function toLookUp(items) {
  const logins = new Set();
  for (const item of items) {
    const login = item.user?.login;
    if (!login || item.user?.type === 'Bot' || TRUSTED.has(item.author_association ?? '')) continue;
    if (item.body && new RegExp(LINE.source, LINE.flags).test(item.body)) logins.add(login);
  }
  return [...logins];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const lookup = process.argv[2] === '--lookup';
  const [reviews, comments, author = '', allowSelf = 'false', permissions] = process.argv.slice(lookup ? 3 : 2);
  const read = (f) => {
    try {
      // `gh api --paginate` prints one JSON array per page.
      return JSON.parse(`[${readFileSync(f, 'utf8').trim().replace(/\]\s*\[/g, '],[')}]`).flat();
    } catch {
      return [];
    }
  };
  const items = [...read(reviews), ...read(comments)];
  if (lookup) {
    process.stdout.write(toLookUp(items).map((l) => `${l}\n`).join(''));
  } else {
    let perms = {};
    try {
      perms = permissions ? JSON.parse(readFileSync(permissions, 'utf8')) : {};
    } catch { /* no lookups: labels alone decide */ }
    process.stdout.write(JSON.stringify(collect(items, { author, allowSelf: allowSelf === 'true', permissions: perms })));
  }
}
