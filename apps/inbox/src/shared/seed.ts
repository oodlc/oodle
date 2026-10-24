import type { PushedGap, PushedIntent } from './protocol.ts';

/**
 * SQL that sets up a project without the UI: the project, its first owner and a first project
 * token. Used by scripts/seed.ts (through `wrangler d1 execute`) and by the tests, so both run
 * the same statements. One statement per entry, each on one line.
 */

const q = (v: string | null | undefined) => (v == null ? 'NULL' : `'${v.replace(/'/g, "''")}'`);

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export type Bootstrap = { project: string; name: string; owner: string; repoUrl?: string; tokenLabel?: string; token?: string; at?: string };

/** Returns the statements and the token in clear text (print it once; only its hash is stored). */
export async function bootstrapSql(b: Bootstrap): Promise<{ statements: string[]; token: string; tokenId: string }> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(b.project)) throw new Error(`project must be a slug (a-z, 0-9, -): ${b.project}`);
  const owner = b.owner.trim().toLowerCase();
  if (!owner.includes('@')) throw new Error(`owner must be an email: ${b.owner}`);
  const at = b.at ?? new Date().toISOString();
  const token = b.token ?? `oodle_${[...crypto.getRandomValues(new Uint8Array(32))].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
  const tokenId = `t_${(await sha256Hex(`${b.project}:${token}`)).slice(0, 16)}`;
  const by = `person:${owner}`;
  const event = (type: string, data: object) =>
    `INSERT INTO events (id, project_id, at, actor, type, data_json) VALUES (${q(`e_seed_${type}_${tokenId}`)}, ${q(b.project)}, ${q(at)}, 'seed', ${q(type)}, ${q(JSON.stringify(data))});`;
  return {
    token,
    tokenId,
    statements: [
      `INSERT INTO projects (id, name, repo_url, created_at) VALUES (${q(b.project)}, ${q(b.name)}, ${q(b.repoUrl)}, ${q(at)}) ON CONFLICT (id) DO NOTHING;`,
      `INSERT INTO members (project_id, email, role) VALUES (${q(b.project)}, ${q(owner)}, 'owner') ON CONFLICT (project_id, email) DO UPDATE SET role = 'owner';`,
      `INSERT OR IGNORE INTO counters (project_id, seq) VALUES (${q(b.project)}, 0);`,
      `INSERT INTO tokens (id, project_id, hash, label, created_by, created_at) VALUES (${q(tokenId)}, ${q(b.project)}, ${q(await sha256Hex(token))}, ${q(b.tokenLabel ?? 'seed')}, ${q(by)}, ${q(at)});`,
      event('project.seeded', { project: b.project, owner, token: tokenId }),
    ],
  };
}

export type DemoFixture = { gaps: PushedGap[]; intents: PushedIntent[] };

/** Demo gaps and intents, as if a CLI had pushed them. Settled agent gaps go in as `applied`, like sync does. */
export function demoSql(project: string, fixture: DemoFixture, at = new Date().toISOString()): string[] {
  const gaps = fixture.gaps.map(({ id, content_hash, body }) => {
    const status = body.answer != null ? 'applied' : 'open';
    return `INSERT INTO gaps (project_id, id, content_hash, status, route, tier, kind, question, body_json, spec_hash, intent_id, version, created_at, updated_at) VALUES (${[
      project,
      id,
      content_hash,
      status,
      body.route,
      body.tier,
      body.kind,
      body.question,
      JSON.stringify(body),
      body.spec_hash,
      body.intent_id ?? null,
    ]
      .map(q)
      .join(', ')}, 1, ${q(at)}, ${q(at)}) ON CONFLICT DO NOTHING;`;
  });
  const intents = fixture.intents.map(
    ({ id, content_hash, body }) =>
      `INSERT INTO intents (project_id, id, status, body_json, content_hash, updated_at) VALUES (${[project, id, body.status, JSON.stringify(body), content_hash, at].map(q).join(', ')}) ON CONFLICT DO NOTHING;`,
  );
  return [...gaps, ...intents];
}
