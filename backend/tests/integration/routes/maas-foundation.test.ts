/**
 * Integration tests for the MaaS foundation (schema, config exposure, user token capture).
 * Covers MAAS_ENABLED=false (no behaviour change) and MAAS_ENABLED=true with mock clients.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { createApp } from '../../../src/app';
import { generateTestToken, createTestUsers, TEST_USER_IDS } from '../setup';
import { decryptApiKey } from '../../../src/utils/encryption';

const ENV_KEYS = [
  'MAAS_ENABLED',
  'MAAS_GATEWAY_URL',
  'MAAS_API_URL',
  'ENCRYPTION_KEY',
  'K8S_API_URL',
  'PROMETHEUS_URL',
];

async function buildApp(env: Record<string, string | undefined>): Promise<FastifyInstance> {
  process.env.NODE_ENV = 'test';
  process.env.OAUTH_MOCK_ENABLED = 'true';
  for (const k of ENV_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;
  const app = await createApp({ logger: false });
  await app.ready();
  return app;
}

describe('MaaS foundation - disabled (default)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({});
    await createTestUsers(app);
  });
  afterAll(async () => {
    await app?.close();
  });

  it('exposes maasEnabled=false and no gateway URL on the public config', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/config' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.maasEnabled).toBe(false);
    expect(body.maasGatewayUrl).toBeUndefined();
    expect(body.version).toBeDefined();
  });

  it('registers only the LiteLLM backend and no MaaS clients', () => {
    expect(app.backends.types()).toEqual(['litellm']);
    expect(app.backends.maasEnabled).toBe(false);
    expect(app.maasClients).toBeUndefined();
  });

  it('migrations created the MaaS columns with LiteLLM defaults', async () => {
    const models = await app.dbUtils.query(
      `SELECT column_name, column_default, is_nullable FROM information_schema.columns
       WHERE table_name = 'models' AND column_name = ANY($1)`,
      [
        [
          'backend_type',
          'maas_model_ref_name',
          'maas_model_ref_namespace',
          'maas_endpoint',
          'maas_phase',
          'migration_state',
          'migration_grace_until',
          'migrated_from_litellm_id',
        ],
      ],
    );
    expect(models.rows).toHaveLength(8);
    const bt = models.rows.find((r: any) => r.column_name === 'backend_type');
    expect(bt.column_default).toContain('litellm');
    expect(bt.is_nullable).toBe('NO');

    const keys = await app.dbUtils.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'api_keys' AND column_name = ANY($1)`,
      [
        [
          'backend_type',
          'maas_key_id',
          'maas_subscription_name',
          'encrypted_key',
          'maas_sync_state',
          'maas_last_error',
        ],
      ],
    );
    expect(keys.rows).toHaveLength(6);
  });

  it('enforces the backend_type CHECK and the MaaSModelRef unique index', async () => {
    await expect(
      app.dbUtils.query(
        `INSERT INTO models (id, name, provider, backend_type) VALUES ('chk-bad', 'x', 'p', 'bogus')`,
      ),
    ).rejects.toThrow();

    await app.dbUtils.query(`DELETE FROM models WHERE id IN ('maas-uq-1', 'maas-uq-2')`);
    await app.dbUtils.query(
      `INSERT INTO models (id, name, provider, backend_type, maas_model_ref_name, maas_model_ref_namespace)
       VALUES ('maas-uq-1', 'x', 'p', 'maas', 'ref', 'ns')`,
    );
    await expect(
      app.dbUtils.query(
        `INSERT INTO models (id, name, provider, backend_type, maas_model_ref_name, maas_model_ref_namespace)
         VALUES ('maas-uq-2', 'x', 'p', 'maas', 'ref', 'ns')`,
      ),
    ).rejects.toThrow();
    // Non-MaaS models (NULL ref) are unconstrained
    await app.dbUtils.query(
      `INSERT INTO models (id, name, provider) VALUES ('maas-uq-2', 'x', 'p')`,
    );
    await app.dbUtils.query(`DELETE FROM models WHERE id IN ('maas-uq-1', 'maas-uq-2')`);
  });

  it('creates user_oauth_tokens with cascade delete from users', async () => {
    const id = '00000000-0000-4000-8000-0000000000aa';
    await app.dbUtils.query(`DELETE FROM users WHERE id = $1`, [id]);
    await app.dbUtils.query(
      `INSERT INTO users (id, username, email, oauth_provider, oauth_id, roles)
       VALUES ($1, 'cascade-user', 'cascade@example.com', 'mock', 'cascade-oauth', ARRAY['user'])`,
      [id],
    );
    await app.dbUtils.query(
      `INSERT INTO user_oauth_tokens (user_id, encrypted_access_token) VALUES ($1, 'x')`,
      [id],
    );
    await app.dbUtils.query(`DELETE FROM users WHERE id = $1`, [id]);
    const left = await app.dbUtils.query(`SELECT 1 FROM user_oauth_tokens WHERE user_id = $1`, [
      id,
    ]);
    expect(left.rows).toHaveLength(0);
  });

  it('does not store OAuth tokens on login when MaaS is disabled', async () => {
    await app.dbUtils.query('DELETE FROM user_oauth_tokens');
    const login = await app.inject({ method: 'POST', url: '/api/auth/login' });
    const state = new URL(JSON.parse(login.body).authUrl, 'http://x').searchParams.get('state')!;
    const cb = await app.inject({ method: 'GET', url: `/api/auth/callback?code=0&state=${state}` });
    expect(cb.statusCode).toBe(302);
    const rows = await app.dbUtils.query('SELECT 1 FROM user_oauth_tokens');
    expect(rows.rows).toHaveLength(0);
  });
});

describe('MaaS foundation - enabled with mock clients', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({
      MAAS_ENABLED: 'true',
      MAAS_GATEWAY_URL: 'https://maas-gw.example.com/',
      ENCRYPTION_KEY: 'integration-test-encryption-key',
    });
    await createTestUsers(app);
  });
  afterAll(async () => {
    await app?.close();
    for (const k of ENV_KEYS) delete process.env[k];
  });

  it('exposes maasEnabled and the gateway URL (without trailing slash)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/config' });
    const body = JSON.parse(res.body);
    expect(body.maasEnabled).toBe(true);
    expect(body.maasGatewayUrl).toBe('https://maas-gw.example.com');
  });

  it('registers both backends backed by mock clients', async () => {
    expect(app.backends.types().sort()).toEqual(['litellm', 'maas']);
    expect(app.maasClients!.k8s.mock).toBe(true);
    expect(app.maasClients!.maasApi.mock).toBe(true);
    const models = await app.backends.get('maas').models.listModels();
    expect(models.length).toBeGreaterThan(0);
    expect((await app.backends.get('maas').models.checkHealth()).status).toBe('healthy');
  });

  it('captures the encrypted OAuth token on login and clears it on logout', async () => {
    await app.dbUtils.query('DELETE FROM user_oauth_tokens');

    const login = await app.inject({ method: 'POST', url: '/api/auth/login' });
    const state = new URL(JSON.parse(login.body).authUrl, 'http://x').searchParams.get('state')!;
    const cb = await app.inject({ method: 'GET', url: `/api/auth/callback?code=0&state=${state}` });
    expect(cb.statusCode).toBe(302);

    const jwt = /token=([^&]+)/.exec(cb.headers.location as string)![1];
    const me = await app.verifyToken(jwt);

    const row = await app.dbUtils.queryOne<{ encrypted_access_token: string; expires_at: Date }>(
      'SELECT encrypted_access_token, expires_at FROM user_oauth_tokens WHERE user_id = $1',
      [me.userId],
    );
    expect(row).toBeTruthy();
    expect(row!.encrypted_access_token).not.toContain('mock_token_');
    expect(decryptApiKey(row!.encrypted_access_token, 'integration-test-encryption-key')).toMatch(
      /^mock_token_/,
    );
    expect(new Date(row!.expires_at).getTime()).toBeGreaterThan(Date.now());

    const { UserTokenService } = await import('../../../src/services/maas/user-token.service');
    expect(await new UserTokenService(app).getValidToken(me.userId)).toMatch(/^mock_token_/);

    const out = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(out.statusCode).toBe(200);
    const after = await app.dbUtils.query('SELECT 1 FROM user_oauth_tokens WHERE user_id = $1', [
      me.userId,
    ]);
    expect(after.rows).toHaveLength(0);

    await expect(new UserTokenService(app).getValidToken(me.userId)).rejects.toMatchObject({
      code: 'MAAS_REAUTH_REQUIRED',
    });
  });

  it('logout without a stored token still succeeds', async () => {
    const token = generateTestToken(TEST_USER_IDS.USER, ['user']);
    await app.dbUtils.query('DELETE FROM user_oauth_tokens WHERE user_id = $1', [
      TEST_USER_IDS.USER,
    ]);
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
  });
});
