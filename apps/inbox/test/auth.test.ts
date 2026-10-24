import { generateKeyPair } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import type { CreateTokenResponse, ProjectsResponse } from '../src/shared/protocol.ts';
import { accessJwt, as, call, jwksFetches, mockAccessJwks, PERMISSION, rows, seedDemo, setupProject, syncRaw } from './helpers.ts';

beforeAll(mockAccessJwks);

describe('project tokens on /api/v1', () => {
  it('accepts a valid token and stores only its hash', async () => {
    const { project, token } = await setupProject();
    expect((await syncRaw(project, token, {})).status).toBe(200);
    const stored = await rows<{ hash: string }>('SELECT hash FROM tokens WHERE project_id = ?', project);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored[0]?.hash).not.toContain(token);
  });

  it('refuses a missing, unknown, revoked or other-project token', async () => {
    const a = await setupProject();
    const b = await setupProject();
    expect((await call('POST', `/api/v1/projects/${a.project}/sync`, { body: { cursor: 0 } })).status).toBe(401);
    expect((await syncRaw(a.project, 'oodle_nope', {})).status).toBe(401);
    expect((await syncRaw(a.project, b.token, {})).status).toBe(401);
    await rows('UPDATE tokens SET revoked_at = ? WHERE id = ?', new Date().toISOString(), a.tokenId);
    expect((await syncRaw(a.project, a.token, {})).status).toBe(401);
  });
});

describe('Cloudflare Access on /api/ui', () => {
  it('reads the email from a valid Access JWT', async () => {
    const { project, owner } = await setupProject();
    const res = await as(owner).json<ProjectsResponse>('GET', '/projects');
    expect(res.me).toBe(owner);
    expect(res.projects.map((p) => p.id)).toEqual([project]);
    expect(res.projects[0]?.role).toBe('owner');
  });

  it('caches the JWKS instead of fetching it per request', async () => {
    const { owner } = await setupProject();
    for (let i = 0; i < 3; i++) await as(owner).get('/projects');
    expect(jwksFetches.length).toBe(1);
  });

  it('refuses a missing header, wrong audience, wrong issuer, expired token, unknown key or no email', async () => {
    const { owner } = await setupProject();
    const other = await generateKeyPair('RS256');
    const bad = [
      undefined,
      await accessJwt(owner, { aud: 'someone-else' }),
      await accessJwt(owner, { iss: 'https://evil.cloudflareaccess.com' }),
      await accessJwt(owner, { exp: Math.floor(Date.now() / 1000) - 60 }),
      await accessJwt(owner, { key: other.privateKey }),
      await accessJwt(undefined),
    ];
    for (const jwt of bad) {
      const res = await call('GET', '/api/ui/projects', { headers: jwt ? { 'Cf-Access-Jwt-Assertion': jwt } : {} });
      expect(res.status).toBe(401);
    }
  });

  it('honours X-Oodle-Dev-Email only when DEV_AUTH is "1"', async () => {
    const { owner } = await setupProject();
    const headers = { 'X-Oodle-Dev-Email': owner };
    expect((await call('GET', '/api/ui/projects', { headers })).status).toBe(401);
    expect((await call('GET', '/api/ui/projects', { headers, env: { DEV_AUTH: 'true' } })).status).toBe(401);
    const res = await call('GET', '/api/ui/projects', { headers, env: { DEV_AUTH: '1' } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as ProjectsResponse).me).toBe(owner);
  });

  it('refuses any request carrying a project token with 403, even with a valid Access JWT', async () => {
    const { project, token, owner } = await setupProject();
    await seedDemo(project);
    const bearer = { Authorization: `Bearer ${token}` };
    const answer = await call('POST', `/api/ui/projects/${project}/gaps/${PERMISSION}/answer`, { headers: bearer, body: { option: 'b', version: 1 } });
    expect(answer.status).toBe(403);
    expect(((await answer.json()) as { error: string }).error).toBe('token_not_allowed');
    const review = await call('POST', `/api/ui/projects/${project}/intents/i_cancel_fee/review`, {
      headers: { ...bearer, 'Cf-Access-Jwt-Assertion': await accessJwt(owner) },
      body: { decision: 'approve', content_hash: 'ih_cancel_fee_1' },
    });
    expect(review.status).toBe(403);
    expect(await rows('SELECT * FROM answers WHERE project_id = ?', project)).toEqual([]);
    expect(await rows('SELECT * FROM approvals WHERE project_id = ?', project)).toEqual([]);
  });
});

describe('roles', () => {
  it('hides projects from non-members, stops viewers answering, and lets only owners make tokens', async () => {
    const { project, owner } = await setupProject({ 'val@x.test': 'viewer', 'ann@x.test': 'answerer' });
    await seedDemo(project);
    expect((await as('stranger@x.test').get(`/projects/${project}/gaps`)).status).toBe(404);
    expect((await as('val@x.test').get(`/projects/${project}/gaps`)).status).toBe(200);
    expect((await as('val@x.test').post(`/projects/${project}/gaps/${PERMISSION}/answer`, { option: 'b', version: 1 })).status).toBe(403);
    expect(
      (await as('val@x.test').post(`/projects/${project}/intents/i_cancel_fee/review`, { decision: 'reject', content_hash: 'ih_cancel_fee_1' })).status,
    ).toBe(403);
    expect((await as('ann@x.test').post(`/projects/${project}/tokens`, { label: 'ci' })).status).toBe(403);

    const made = await as(owner).post(`/projects/${project}/tokens`, { label: 'ci' });
    expect(made.status).toBe(201);
    const { token, id } = (await made.json()) as CreateTokenResponse;
    expect(token).toMatch(/^oodle_[0-9a-f]{64}$/);
    expect((await syncRaw(project, token, {})).status).toBe(200);
    expect((await as(owner).del(`/projects/${project}/tokens/${id}`)).status).toBe(200);
    expect((await syncRaw(project, token, {})).status).toBe(401);
    const types = (await rows<{ type: string }>('SELECT type FROM events WHERE project_id = ? ORDER BY rowid', project)).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['token.created', 'token.revoked']));
  });
});
