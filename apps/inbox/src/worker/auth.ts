import type { MiddlewareHandler } from 'hono';
import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from 'jose';
import type { Role } from '../shared/protocol.ts';
import { sha256Hex } from './db.ts';
import { ApiError, type AppEnv, type Env } from './env.ts';

const bearer = (header: string | undefined) => /^Bearer\s+(\S+)$/i.exec(header ?? '')?.[1];

/**
 * /api/v1: a project token in `Authorization: Bearer`. Tokens are stored as SHA-256 hashes,
 * so the lookup hashes what was sent. A token only works for its own project.
 */
export const tokenAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = bearer(c.req.header('Authorization'));
  if (!token) throw new ApiError(401, 'unauthorized', 'Send a project token as "Authorization: Bearer <token>".');
  const row = await c.env.DB.prepare('SELECT id FROM tokens WHERE hash = ? AND project_id = ? AND revoked_at IS NULL')
    .bind(await sha256Hex(token), c.req.param('project'))
    .first<{ id: string }>();
  if (!row) throw new ApiError(401, 'unauthorized', 'This token is unknown, revoked, or for another project.');
  c.set('tokenId', row.id);
  await next();
};

/** One remote key set per Access team, kept for the isolate's life. jose caches the keys and refetches on an unknown `kid`. */
const jwksByTeam = new Map<string, JWTVerifyGetKey>();

function teamKeys(team: string): JWTVerifyGetKey {
  let keys = jwksByTeam.get(team);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`https://${team}/cdn-cgi/access/certs`));
    jwksByTeam.set(team, keys);
  }
  return keys;
}

/** The person behind a request, from Cloudflare Access (or the dev override). Throws 401 when there is none. */
export async function personEmail(env: Env, headers: Headers): Promise<string> {
  if (env.DEV_AUTH === '1') {
    const dev = headers.get('X-Oodle-Dev-Email') ?? env.DEV_EMAIL;
    if (dev) return dev.trim().toLowerCase();
  }
  const jwt = headers.get('Cf-Access-Jwt-Assertion');
  if (!jwt) throw new ApiError(401, 'unauthorized', 'No Cloudflare Access identity on this request.');
  try {
    const { payload } = await jwtVerify(jwt, teamKeys(env.ACCESS_TEAM_DOMAIN), {
      audience: env.ACCESS_AUD,
      issuer: `https://${env.ACCESS_TEAM_DOMAIN}`,
    });
    if (typeof payload.email !== 'string' || !payload.email) throw new Error('no email claim');
    return payload.email.trim().toLowerCase();
  } catch {
    throw new ApiError(401, 'unauthorized', 'The Cloudflare Access token is not valid for this inbox.');
  }
}

/**
 * /api/ui: people only. A request carrying a project token is refused outright with 403,
 * whatever else it carries: tokens can push and pull, never answer or approve for people.
 */
export const accessAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (bearer(c.req.header('Authorization'))) {
    throw new ApiError(403, 'token_not_allowed', 'Project tokens cannot use the people API: they cannot answer gaps or review intents.');
  }
  c.set('email', await personEmail(c.env, c.req.raw.headers));
  await next();
};

const RANK: Record<Role, number> = { viewer: 0, answerer: 1, owner: 2 };

/** The caller's role on a project, at least `min`. 404 for non-members, so project names don't leak. */
export async function requireRole(db: D1Database, project: string, email: string, min: Role): Promise<Role> {
  const row = await db.prepare('SELECT role FROM members WHERE project_id = ? AND email = ?').bind(project, email).first<{ role: Role }>();
  if (!row) throw new ApiError(404, 'not_found', `No project "${project}" for ${email}.`);
  if (RANK[row.role] < RANK[min]) throw new ApiError(403, 'forbidden', `This needs the ${min} role; ${email} is ${row.role} on "${project}".`);
  return row.role;
}
