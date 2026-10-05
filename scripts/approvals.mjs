#!/usr/bin/env node
// Collects `/oodle approve <id@fingerprint> ...` lines from a pull request's reviews
// and comments, for `oodle check --approvals`. Only people with write access to the
// repository count, never bots, and never the pull request's author unless the
// workflow allows self-approval. See docs/decisions/0007.
//
// Usage: approvals.mjs <reviews.json> <comments.json> <pr-author> <allow-self: true|false>
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const LINE = /^[ \t>]*\/oodle approve[ \t]+(.+)$/gim;
const TOKEN = /^[^\s@`]+@[0-9a-f]{8}$/;

/**
 * @param {Array<{ body?: string, user?: { login?: string, type?: string }, author_association?: string, state?: string }>} items
 * @param {{ author: string, allowSelf: boolean }} opts
 */
export function collect(items, { author, allowSelf }) {
  const out = [];
  const seen = new Set();
  for (const item of items) {
    const login = item.user?.login;
    if (!login || !item.body || item.state === 'DISMISSED' || item.state === 'PENDING') continue;
    if (item.user?.type === 'Bot' || !TRUSTED.has(item.author_association ?? '')) continue;
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [reviews, comments, author = '', allowSelf = 'false'] = process.argv.slice(2);
  const read = (f) => {
    try {
      // `gh api --paginate` prints one JSON array per page.
      return JSON.parse(`[${readFileSync(f, 'utf8').trim().replace(/\]\s*\[/g, '],[')}]`).flat();
    } catch {
      return [];
    }
  };
  process.stdout.write(JSON.stringify(collect([...read(reviews), ...read(comments)], { author, allowSelf: allowSelf === 'true' })));
}
