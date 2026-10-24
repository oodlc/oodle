import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose';
import { vi } from 'vitest';
import type { GapFile, IntentFile, PushedGap, PushedIntent, Role, SyncRequest, SyncResponse } from '../src/shared/protocol.ts';
import { bootstrapSql, demoSql } from '../src/shared/seed.ts';
import type { Env } from '../src/worker/env.ts';
import { app } from '../src/worker/index.ts';
import fixture from './fixtures/dogwalk-gaps.json';

/** The dogwalk fixture, fresh each call so tests can change it. */
export function dogwalk(): { gaps: PushedGap[]; intents: PushedIntent[] } {
  return structuredClone(fixture) as unknown as { gaps: PushedGap[]; intents: PushedIntent[] };
}
export const gapById = (id: string): PushedGap => {
  const g = dogwalk().gaps.find((x) => x.id === id);
  if (!g) throw new Error(`no fixture gap ${id}`);
  return g;
};
export const SORT = 'g_7f3a91c2';
export const PERMISSION = 'g_2c81d0e5';
export const WORDING = 'g_9d04b7aa';
export const CANCEL_RULE = 'g_51e6c3f0';
export const CANCEL_FEE = 'i_cancel_fee';

let n = 0;
/** A fresh project per test, so tests never see each other's rows whatever the storage isolation. */
export async function setupProject(members: Record<string, Role> = {}): Promise<{ project: string; token: string; tokenId: string; owner: string }> {
  const project = `p${++n}-${crypto.randomUUID().slice(0, 8)}`;
  const owner = `owner@${project}.test`;
  const { statements, token, tokenId } = await bootstrapSql({ project, name: `Project ${project}`, owner });
  const extra = Object.entries(members).map(([email, role]) => `INSERT INTO members (project_id, email, role) VALUES ('${project}', '${email}', '${role}');`);
  await env.DB.batch([...statements, ...extra].map((s) => env.DB.prepare(s)));
  return { project, token, tokenId, owner };
}

export async function seedDemo(project: string) {
  await env.DB.batch(demoSql(project, dogwalk()).map((s) => env.DB.prepare(s)));
}

// ---------------------------------------------------------------- Cloudflare Access, locally

const KID = 'oodle-test-key';
const keys = await generateKeyPair('RS256', { extractable: true });
const publicJwk: JWK = { ...(await exportJWK(keys.publicKey)), kid: KID, alg: 'RS256', use: 'sig' };
const certsUrl = () => `https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`;

/** Every fetch to the team's certs URL. The Worker should fetch the JWKS once and cache it. */
export const jwksFetches: string[] = [];

/** Answers the Access certs URL with the test key; any other outbound fetch fails the test. */
export function mockAccessJwks() {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === certsUrl()) {
      jwksFetches.push(url);
      return Response.json({ keys: [publicJwk], public_cert: { kid: KID }, public_certs: [] });
    }
    throw new Error(`unexpected outbound fetch in a test: ${url}`);
  });
}

export async function accessJwt(
  email: string | undefined,
  o: { aud?: string; iss?: string; exp?: string | number; key?: CryptoKey; kid?: string } = {},
): Promise<string> {
  return new SignJWT(email === undefined ? {} : { email })
    .setProtectedHeader({ alg: 'RS256', kid: o.kid ?? KID })
    .setIssuer(o.iss ?? `https://${env.ACCESS_TEAM_DOMAIN}`)
    .setAudience([o.aud ?? env.ACCESS_AUD])
    .setSubject('test-user')
    .setIssuedAt()
    .setExpirationTime(o.exp ?? '5m')
    .sign(o.key ?? keys.privateKey);
}

// ---------------------------------------------------------------- calling the Worker

type CallOpts = { headers?: Record<string, string>; body?: unknown; env?: Partial<Env> };

export async function call(method: string, path: string, o: CallOpts = {}): Promise<Response> {
  const init: RequestInit = { method, headers: { ...(o.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...o.headers } };
  if (o.body !== undefined) init.body = JSON.stringify(o.body);
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(`https://inbox.test${path}`, init), { ...(env as unknown as Env), ...o.env }, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

/** A person through Cloudflare Access. */
export function as(email: string) {
  const headers = async () => ({ 'Cf-Access-Jwt-Assertion': await accessJwt(email) });
  return {
    get: async (path: string) => call('GET', `/api/ui${path}`, { headers: await headers() }),
    post: async (path: string, body: unknown) => call('POST', `/api/ui${path}`, { headers: await headers(), body }),
    del: async (path: string) => call('DELETE', `/api/ui${path}`, { headers: await headers() }),
    json: async <T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> => {
      const res = await call(method, `/api/ui${path}`, { headers: await headers(), body });
      if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
      return (await res.json()) as T;
    },
  };
}

export async function syncRaw(project: string, token: string, req: Partial<SyncRequest>): Promise<Response> {
  return call('POST', `/api/v1/projects/${project}/sync`, {
    headers: { Authorization: `Bearer ${token}` },
    body: { client: { version: '0.1.0', spec_hash: '9c1e44ab0d2f', git_sha: 'abc123' }, cursor: 0, ...req },
  });
}

export async function sync(project: string, token: string, req: Partial<SyncRequest>): Promise<SyncResponse> {
  const res = await syncRaw(project, token, req);
  if (res.status !== 200) throw new Error(`sync: ${res.status} ${await res.text()}`);
  return (await res.json()) as SyncResponse;
}

export async function rows<T>(sql: string, ...params: unknown[]): Promise<T[]> {
  return (
    await env.DB.prepare(sql)
      .bind(...params)
      .all<T>()
  ).results;
}

export type { GapFile, IntentFile };
