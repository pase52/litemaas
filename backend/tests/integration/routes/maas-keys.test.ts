/**
 * Integration tests for MaaS API keys (MAAS_ENABLED=true with the in-memory mock cluster and
 * mock maas-api): creation + rollback, listing, reveal, limit/model edits, rotation, revoke,
 * expiry cleanup, model removal, admin user routes and the reconciler extension.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { FastifyInstance } from 'fastify';
import { createApp } from '../../../src/app';
import { generateTestToken, createTestUsers, TEST_USER_IDS } from '../setup';
import { ApiKeyService } from '../../../src/services/api-key.service';
import { LiteLLMService } from '../../../src/services/litellm.service';
import { UserTokenService } from '../../../src/services/maas/user-token.service';
import { MaasReconcilerService } from '../../../src/services/maas/maas-reconciler.service';
import {
  MAAS_AUTH_POLICY,
  MAAS_MODEL_REF,
  MAAS_SUBSCRIPTION,
} from '../../../src/services/maas/maas-resources';
import { ApplicationError } from '../../../src/utils/errors';
import type { InMemoryK8sClient } from '../../../src/services/k8s/k8s-client';
import type { MockMaasApiClient } from '../../../src/services/maas/maas-api.client';

const NS = 'maas-demo-models';
const POLICY_NS = 'models-as-a-service';
const LLAMA = `${NS}/llama-3-2-3b`;
const GRANITE = `${NS}/granite-3-3-8b`;
const QWEN = `${NS}/qwen3-32b`;
const LITELLM_MODEL = 'test-litellm-model-for-maas-keys';
const USER_TOKEN = 'openshift-user-token-abc';

describe('MaaS API keys (MAAS_ENABLED=true)', () => {
  let app: FastifyInstance;
  let k8s: InMemoryK8sClient;
  let maasApi: MockMaasApiClient;
  let apiKeyService: ApiKeyService;
  let tokens: UserTokenService;

  const user = () => `Bearer ${generateTestToken(TEST_USER_IDS.USER, ['user'])}`;
  const admin = () => `Bearer ${generateTestToken(TEST_USER_IDS.ADMIN, ['admin'])}`;
  const readonly = () =>
    `Bearer ${generateTestToken(TEST_USER_IDS.ADMIN_READONLY, ['admin-readonly'])}`;

  const getSub = (keyId: string) => k8s.get(MAAS_SUBSCRIPTION, `litemaas-key-${keyId}`, POLICY_NS);
  const dbKey = (id: string) =>
    app.dbUtils.queryOne<any>('SELECT * FROM api_keys WHERE id = $1', [id]);
  const tpmByModel = (sub: any) =>
    Object.fromEntries(
      (sub?.spec?.modelRefs ?? []).map((m: any) => [m.name, m.tokenRateLimits?.[0]?.limit]),
    );

  async function cleanDb() {
    await app.dbUtils.query(`DELETE FROM api_keys WHERE key_hash LIKE 'maas:%'`);
    await app.dbUtils.query(
      `DELETE FROM subscription_status_history WHERE subscription_id IN
         (SELECT id FROM subscriptions WHERE model_id LIKE $1 OR model_id = $2)`,
      [`${NS}/%`, LITELLM_MODEL],
    );
    await app.dbUtils.query(`DELETE FROM subscriptions WHERE model_id LIKE $1 OR model_id = $2`, [
      `${NS}/%`,
      LITELLM_MODEL,
    ]);
    await app.dbUtils.query(`DELETE FROM models WHERE id LIKE $1 OR id = $2`, [
      `${NS}/%`,
      LITELLM_MODEL,
    ]);
    await app.dbUtils.query(`DELETE FROM user_oauth_tokens WHERE user_id = $1`, [
      TEST_USER_IDS.USER,
    ]);
  }

  async function seedCluster() {
    for (const ref of [MAAS_AUTH_POLICY, MAAS_SUBSCRIPTION, MAAS_MODEL_REF]) {
      for (const o of await k8s.list(ref)) {
        await k8s.delete(ref, o.metadata.name, o.metadata.namespace);
      }
    }
    const { seedMockCluster } = await import('../../../src/services/maas/maas-clients');
    seedMockCluster(k8s);
  }

  async function subscribe(modelId: string) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/subscriptions',
      headers: { authorization: user() },
      payload: { modelId },
    });
    expect([200, 201]).toContain(res.statusCode);
    return JSON.parse(res.body);
  }

  async function createKey(payload: object, auth = user()) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/api-keys',
      headers: { authorization: auth },
      payload,
    });
  }

  async function createMaasKey(extra: object = {}) {
    const res = await createKey({
      name: 'maas key',
      modelIds: [LLAMA, GRANITE],
      tpmLimit: 1000,
      modelTpmLimit: { [GRANITE]: 250 },
      ...extra,
    });
    expect(res.statusCode).toBe(201);
    return JSON.parse(res.body);
  }

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.OAUTH_MOCK_ENABLED = 'true';
    process.env.MAAS_ENABLED = 'true';
    process.env.MAAS_GATEWAY_URL = 'https://maas-gw.example.com/';
    process.env.ENCRYPTION_KEY = 'integration-test-encryption-key';
    process.env.RATE_LIMIT_MAX = '100000'; // many requests per user in one minute
    delete process.env.K8S_API_URL;
    delete process.env.MAAS_API_URL;
    app = await createApp({ logger: false });
    await app.ready();
    await createTestUsers(app);
    k8s = app.maasClients!.k8s as InMemoryK8sClient;
    maasApi = app.maasClients!.maasApi as MockMaasApiClient;
    apiKeyService = new ApiKeyService(app, new LiteLLMService(app));
    tokens = new UserTokenService(app);
  });

  afterAll(async () => {
    if (app) {
      await cleanDb();
      await app.close();
    }
    delete process.env.MAAS_ENABLED;
    delete process.env.MAAS_GATEWAY_URL;
    delete process.env.ENCRYPTION_KEY;
    delete process.env.RATE_LIMIT_MAX;
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    await cleanDb();
    await seedCluster();
    const sync = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/models/maas/sync',
      headers: { authorization: admin(), 'content-type': 'application/json' },
      payload: {},
    });
    expect(sync.statusCode).toBe(200);
    await tokens.storeToken(TEST_USER_IDS.USER, USER_TOKEN, 3600);
    await subscribe(LLAMA);
    await subscribe(GRANITE);
  });

  // ---------------------------------------------------------------- create

  describe('create', () => {
    it('creates a MaaS key: subscription, maas-api key, encrypted plaintext, synthetic hash', async () => {
      const createSpy = vi.spyOn(maasApi, 'createKey');
      const body = await createMaasKey({
        expiresAt: new Date(Date.now() + 10 * 86_400_000).toISOString(),
      });

      expect(body).toMatchObject({
        backendType: 'maas',
        baseUrl: 'https://maas-gw.example.com',
        models: [LLAMA, GRANITE],
        isActive: true,
      });
      expect(body.key).toMatch(/^sk-oai-/);
      expect(body.maasKeyId).toMatch(/^mock-maas-key-/);
      expect(body.keyPrefix).toBe(body.key.slice(0, 12));

      // maas-api was called with the user's own token, the per-key subscription and expiresIn
      expect(createSpy).toHaveBeenCalledTimes(1);
      const [tokenArg, reqArg] = createSpy.mock.calls[0];
      expect(tokenArg).toBe(USER_TOKEN);
      expect(reqArg).toMatchObject({
        name: 'maas key',
        subscription: `litemaas-key-${body.id}`,
        expiresInDays: 10,
      });

      const row = await dbKey(body.id);
      expect(row).toMatchObject({
        backend_type: 'maas',
        key_hash: `maas:litemaas-key-${body.id}`,
        maas_key_id: body.maasKeyId,
        maas_subscription_name: `litemaas-key-${body.id}`,
        maas_sync_state: 'synced',
        lite_llm_key_value: null,
        tpm_limit: 1000,
        is_active: true,
      });
      expect(row.encrypted_key).toBeTruthy();
      expect(row.encrypted_key).not.toContain(body.key);
      const junction = await app.dbUtils.queryMany<any>(
        'SELECT model_id FROM api_key_models WHERE api_key_id = $1 ORDER BY model_id',
        [body.id],
      );
      expect(junction.map((j) => j.model_id).sort()).toEqual([GRANITE, LLAMA].sort());

      const sub = await getSub(body.id);
      expect(sub?.spec.owner.users).toEqual(['testuser']);
      expect(sub?.metadata.labels['litemaas.io/api-key-id']).toBe(body.id);
      expect(tpmByModel(sub)).toEqual({ 'llama-3-2-3b': 1000, 'granite-3-3-8b': 250 });

      const audit = await app.dbUtils.queryOne<any>(
        `SELECT metadata FROM audit_logs WHERE action = 'API_KEY_CREATE' AND resource_id = $1`,
        [body.id],
      );
      expect(audit.metadata.backendType).toBe('maas');
    });

    it('infers the backend from the models when backendType is omitted and honours an explicit one', async () => {
      const res = await createKey({ name: 'a', modelIds: [LLAMA], backendType: 'maas' });
      expect(res.statusCode).toBe(201);
      expect(JSON.parse(res.body).backendType).toBe('maas');
    });

    it('does not apply LiteLLM budget / RPM defaults to MaaS keys', async () => {
      await app.dbUtils.query(
        `INSERT INTO system_settings (key, value)
           VALUES ('api_key_defaults', $1)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [
          JSON.stringify({
            defaults: { maxBudget: 50, rpmLimit: 10, tpmLimit: 777 },
            maximums: { maxBudget: 100, rpmLimit: 20 },
          }),
        ],
      );
      try {
        const res = await createKey({ name: 'd', modelIds: [LLAMA] });
        expect(res.statusCode).toBe(201);
        const body = JSON.parse(res.body);
        const row = await dbKey(body.id);
        expect(row.tpm_limit).toBe(777); // TPM default applies
        expect(row.max_budget).toBeNull();
        expect(row.rpm_limit).toBeNull();
      } finally {
        await app.dbUtils.query(`DELETE FROM system_settings WHERE key = 'api_key_defaults'`);
      }
    });

    it('returns 403 MAAS_REAUTH_REQUIRED and creates nothing when the user token is missing', async () => {
      await tokens.clearToken(TEST_USER_IDS.USER);
      const createSpy = vi.spyOn(maasApi, 'createKey');
      const res = await createKey({ name: 'x', modelIds: [LLAMA] });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).error.code).toBe('MAAS_REAUTH_REQUIRED');
      expect(createSpy).not.toHaveBeenCalled();
      expect(await k8s.list(MAAS_SUBSCRIPTION)).toHaveLength(0);
      const rows = await app.dbUtils.queryMany(`SELECT id FROM api_keys WHERE backend_type='maas'`);
      expect(rows).toHaveLength(0);
    });

    it('returns MAAS_REAUTH_REQUIRED when maas-api rejects the token, and rolls everything back', async () => {
      vi.spyOn(maasApi, 'createKey').mockRejectedValue(
        ApplicationError.maasReauthRequired('maas-api responded 401'),
      );
      const res = await createKey({ name: 'x', modelIds: [LLAMA] });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).error.code).toBe('MAAS_REAUTH_REQUIRED');
      expect(await k8s.list(MAAS_SUBSCRIPTION)).toHaveLength(0);
      expect(
        await app.dbUtils.queryMany(`SELECT id FROM api_keys WHERE backend_type='maas'`),
      ).toHaveLength(0);
    });

    it('rolls back the row when the MaaSSubscription cannot be created (maas-api never called)', async () => {
      vi.spyOn(k8s, 'create').mockRejectedValue(new Error('apiserver down'));
      const createSpy = vi.spyOn(maasApi, 'createKey');
      const res = await createKey({ name: 'x', modelIds: [LLAMA] });
      expect(res.statusCode).toBeGreaterThanOrEqual(500);
      expect(createSpy).not.toHaveBeenCalled();
      expect(
        await app.dbUtils.queryMany(`SELECT id FROM api_keys WHERE backend_type='maas'`),
      ).toHaveLength(0);
      expect(
        await app.dbUtils.queryMany(`SELECT * FROM api_key_models WHERE model_id = $1`, [LLAMA]),
      ).toHaveLength(0);
    });

    it('deletes the subscription and the row when maas-api fails', async () => {
      vi.spyOn(maasApi, 'createKey').mockRejectedValue(
        ApplicationError.maasError('maas-api down', 503),
      );
      const res = await createKey({ name: 'x', modelIds: [LLAMA] });
      expect(res.statusCode).toBe(502);
      expect(await k8s.list(MAAS_SUBSCRIPTION)).toHaveLength(0);
      expect(
        await app.dbUtils.queryMany(`SELECT id FROM api_keys WHERE backend_type='maas'`),
      ).toHaveLength(0);
    });

    it('revokes the maas-api key, deletes the subscription and the row when finalizing fails', async () => {
      const revokeSpy = vi.spyOn(maasApi, 'revokeKey');
      const original = app.dbUtils.withTransaction.bind(app.dbUtils);
      let calls = 0;
      vi.spyOn(app.dbUtils, 'withTransaction').mockImplementation(async (cb: any) => {
        calls++;
        if (calls === 2) throw new Error('db exploded while finalizing');
        return original(cb);
      });
      const res = await createKey({ name: 'x', modelIds: [LLAMA] });
      expect(res.statusCode).toBeGreaterThanOrEqual(500);
      expect(revokeSpy).toHaveBeenCalledTimes(1);
      expect(revokeSpy.mock.calls[0][0]).toBe(USER_TOKEN);
      expect(await k8s.list(MAAS_SUBSCRIPTION)).toHaveLength(0);
      expect(
        await app.dbUtils.queryMany(`SELECT id FROM api_keys WHERE backend_type='maas'`),
      ).toHaveLength(0);
    });

    it('rejects mixed-backend model sets and contradicting backendType (400)', async () => {
      await app.dbUtils.query(
        `INSERT INTO models (id, name, provider, backend_type, availability)
         VALUES ($1, 'LL', 'openai', 'litellm', 'available')`,
        [LITELLM_MODEL],
      );
      await subscribe(LITELLM_MODEL);

      const mixed = await createKey({ name: 'm', modelIds: [LLAMA, LITELLM_MODEL] });
      expect(mixed.statusCode).toBe(400);
      expect(mixed.body).toMatch(/cannot mix/i);

      const wrong = await createKey({ name: 'w', modelIds: [LITELLM_MODEL], backendType: 'maas' });
      expect(wrong.statusCode).toBe(400);
      const wrong2 = await createKey({ name: 'w', modelIds: [LLAMA], backendType: 'litellm' });
      expect(wrong2.statusCode).toBe(400);
      expect(await k8s.list(MAAS_SUBSCRIPTION)).toHaveLength(0);
    });

    it('rejects non-TPM limits for MaaS keys (400)', async () => {
      for (const extra of [
        { maxBudget: 10 },
        { rpmLimit: 5 },
        { budgetDuration: 'monthly' },
        { modelRpmLimit: { [LLAMA]: 1 } },
        { teamId: 'team-1' },
      ]) {
        const res = await createKey({ name: 'x', modelIds: [LLAMA], ...extra });
        expect(res.statusCode).toBe(400);
        expect(res.body).toMatch(/tokens-per-minute/);
      }
      expect(await k8s.list(MAAS_SUBSCRIPTION)).toHaveLength(0);
    });

    it('requires active subscriptions, available models and consistent per-model TPM', async () => {
      await app.dbUtils.query(`UPDATE models SET availability = 'available' WHERE id = $1`, [QWEN]);
      const noSub = await createKey({ name: 'x', modelIds: [QWEN] });
      expect(noSub.statusCode).toBe(400);
      expect(noSub.body).toMatch(/active subscriptions/);

      await app.dbUtils.query(`UPDATE models SET availability = 'unavailable' WHERE id = $1`, [
        GRANITE,
      ]);
      const unavailable = await createKey({ name: 'x', modelIds: [GRANITE] });
      expect(unavailable.statusCode).toBe(400);
      expect(unavailable.body).toMatch(/unavailable/);
      await app.dbUtils.query(`UPDATE models SET availability = 'available' WHERE id = $1`, [
        GRANITE,
      ]);

      const badTpm = await createKey({
        name: 'x',
        modelIds: [LLAMA],
        modelTpmLimit: { [GRANITE]: 10 },
      });
      expect(badTpm.statusCode).toBe(400);

      const past = await createKey({
        name: 'x',
        modelIds: [LLAMA],
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      });
      expect(past.statusCode).toBe(400);
    });

    it('enforces the active key limit per user across backends', async () => {
      for (let i = 0; i < 10; i++) {
        await app.dbUtils.query(
          `INSERT INTO api_keys (user_id, name, key_hash, key_prefix, is_active)
           VALUES ($1, 'f', $2, 'sk-x', true)`,
          [TEST_USER_IDS.USER, `maas:filler-${i}`],
        );
      }
      const res = await createKey({ name: 'x', modelIds: [LLAMA] });
      expect(res.statusCode).toBe(400);
      expect(res.body).toMatch(/Maximum 10/);
    });
  });

  // -------------------------------------------------- list / get / reveal

  describe('read', () => {
    it('lists MaaS keys with backendType, baseUrl and maasKeyId and never leaks the secret', async () => {
      const created = await createMaasKey();
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/api-keys',
        headers: { authorization: user() },
      });
      expect(res.statusCode).toBe(200);
      const item = JSON.parse(res.body).data.find((k: any) => k.id === created.id);
      expect(item).toMatchObject({
        backendType: 'maas',
        baseUrl: 'https://maas-gw.example.com',
        maasKeyId: created.maasKeyId,
        maasSyncState: 'synced',
        tpmLimit: 1000,
        modelTpmLimit: { [GRANITE]: 250 },
      });
      expect(res.body).not.toContain(created.key);
      expect(res.body).not.toContain('encrypted');

      const one = await app.inject({
        method: 'GET',
        url: `/api/v1/api-keys/${created.id}`,
        headers: { authorization: user() },
      });
      expect(JSON.parse(one.body)).toMatchObject({
        backendType: 'maas',
        maasKeyId: created.maasKeyId,
      });
    });

    it('reports backendType litellm for ordinary keys', async () => {
      await app.dbUtils.query(
        `INSERT INTO api_keys (id, user_id, name, key_hash, key_prefix, is_active)
         VALUES ('00000000-0000-4000-8000-0000000000a1', $1, 'legacy', 'maas:legacy-plain', 'sk-ab', true)`,
        [TEST_USER_IDS.USER],
      );
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/api-keys',
        headers: { authorization: user() },
      });
      const item = JSON.parse(res.body).data.find(
        (k: any) => k.id === '00000000-0000-4000-8000-0000000000a1',
      );
      expect(item.backendType).toBe('litellm');
      expect(item.baseUrl).toBeUndefined();
    });

    it('reveals the decrypted plaintext (View Key / playground)', async () => {
      const created = await createMaasKey();
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/api-keys/${created.id}/reveal`,
        headers: { authorization: user() },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({
        key: created.key,
        keyType: 'maas',
        baseUrl: 'https://maas-gw.example.com',
      });
    });

    it('reveal fails cleanly when the stored ciphertext is unreadable', async () => {
      const created = await createMaasKey();
      await app.dbUtils.query(`UPDATE api_keys SET encrypted_key = 'garbage' WHERE id = $1`, [
        created.id,
      ]);
      await expect(apiKeyService.retrieveFullKey(created.id, TEST_USER_IDS.USER)).rejects.toThrow(
        /cannot be decrypted/,
      );
    });
  });

  // ------------------------------------------------------------- updates

  describe('update', () => {
    it('PATCH tpm/model tpm patches the MaaSSubscription and the row', async () => {
      const created = await createMaasKey();
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/api-keys/${created.id}`,
        headers: { authorization: user() },
        payload: { tpmLimit: 5000, modelTpmLimit: { [LLAMA]: 100 } },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({
        backendType: 'maas',
        maasKeyId: created.maasKeyId,
      });
      expect((await dbKey(created.id)).model_tpm_limit).toEqual({ [LLAMA]: 100 });
      expect(tpmByModel(await getSub(created.id))).toEqual({
        'llama-3-2-3b': 100,
        'granite-3-3-8b': 5000,
      });
      expect((await dbKey(created.id)).tpm_limit).toBe(5000);
    });

    it('clearing the TPM limit removes tokenRateLimits', async () => {
      const created = await createMaasKey({ modelTpmLimit: undefined });
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/api-keys/${created.id}`,
        headers: { authorization: user() },
        payload: { tpmLimit: null },
      });
      expect(res.statusCode).toBe(200);
      expect(tpmByModel(await getSub(created.id))).toEqual({
        'llama-3-2-3b': undefined,
        'granite-3-3-8b': undefined,
      });
    });

    it('rejects non-TPM limit edits with 400 and leaves everything untouched', async () => {
      const created = await createMaasKey();
      const before = await getSub(created.id);
      for (const payload of [
        { maxBudget: 5 },
        { rpmLimit: 3 },
        { modelMaxBudget: { [LLAMA]: { budgetLimit: 1, timePeriod: '1d' } } },
      ]) {
        const res = await app.inject({
          method: 'PATCH',
          url: `/api/v1/api-keys/${created.id}`,
          headers: { authorization: user() },
          payload,
        });
        expect(res.statusCode).toBe(400);
      }
      expect((await getSub(created.id))?.spec).toEqual(before?.spec);
    });

    it('leaves the database unchanged when the cluster patch fails', async () => {
      const created = await createMaasKey();
      vi.spyOn(k8s, 'replace').mockRejectedValue(new Error('apiserver down'));
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/api-keys/${created.id}`,
        headers: { authorization: user() },
        payload: { tpmLimit: 9 },
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(500);
      expect((await dbKey(created.id)).tpm_limit).toBe(1000);
    });

    it('changing models re-applies the subscription; mixing backends is rejected', async () => {
      const created = await createMaasKey();
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/api-keys/${created.id}`,
        headers: { authorization: user() },
        payload: { modelIds: [LLAMA] },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).models).toEqual([LLAMA]);
      const sub = await getSub(created.id);
      expect(sub!.spec.modelRefs.map((m: any) => m.name)).toEqual(['llama-3-2-3b']);
      // per-model entry of the removed model is dropped
      expect((await dbKey(created.id)).model_tpm_limit).toBeNull();

      await app.dbUtils.query(
        `INSERT INTO models (id, name, provider, backend_type, availability)
         VALUES ($1, 'LL', 'openai', 'litellm', 'available')`,
        [LITELLM_MODEL],
      );
      await subscribe(LITELLM_MODEL);
      const mixed = await app.inject({
        method: 'PATCH',
        url: `/api/v1/api-keys/${created.id}`,
        headers: { authorization: user() },
        payload: { modelIds: [LLAMA, LITELLM_MODEL] },
      });
      expect(mixed.statusCode).toBe(400);
      const empty = await app.inject({
        method: 'PATCH',
        url: `/api/v1/api-keys/${created.id}`,
        headers: { authorization: user() },
        payload: { modelIds: [] },
      });
      expect(empty.statusCode).toBe(400);
    });

    it('renames a key without touching the cluster', async () => {
      const created = await createMaasKey();
      const replaceSpy = vi.spyOn(k8s, 'replace');
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/api-keys/${created.id}`,
        headers: { authorization: user() },
        payload: { name: 'renamed' },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).name).toBe('renamed');
      expect(replaceSpy).not.toHaveBeenCalled();
    });

    it('only allows shortening the expiration', async () => {
      const created = await createMaasKey({
        expiresAt: new Date(Date.now() + 10 * 86_400_000).toISOString(),
      });
      const later = await app.inject({
        method: 'PATCH',
        url: `/api/v1/api-keys/${created.id}`,
        headers: { authorization: user() },
        payload: { expiresAt: new Date(Date.now() + 20 * 86_400_000).toISOString() },
      });
      expect(later.statusCode).toBe(400);
      const never = await app.inject({
        method: 'PATCH',
        url: `/api/v1/api-keys/${created.id}`,
        headers: { authorization: user() },
        payload: { expiresAt: null },
      });
      expect(never.statusCode).toBe(400);
      const sooner = new Date(Date.now() + 2 * 86_400_000);
      const ok = await app.inject({
        method: 'PATCH',
        url: `/api/v1/api-keys/${created.id}`,
        headers: { authorization: user() },
        payload: { expiresAt: sooner.toISOString() },
      });
      expect(ok.statusCode).toBe(200);
      expect(new Date((await dbKey(created.id)).expires_at).getTime()).toBe(sooner.getTime());
    });

    it('reset-spend is not supported for MaaS keys', async () => {
      const created = await createMaasKey();
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/api-keys/${created.id}/reset-spend`,
        headers: { authorization: user() },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ---------------------------------------------------------------- rotate

  describe('rotate', () => {
    it('issues a new key on the same subscription and revokes the old one', async () => {
      const created = await createMaasKey();
      const revokeSpy = vi.spyOn(maasApi, 'revokeKey');
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/api-keys/${created.id}/rotate`,
        headers: { authorization: user() },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.key).toMatch(/^sk-oai-/);
      expect(body.key).not.toBe(created.key);

      const row = await dbKey(created.id);
      expect(row.maas_key_id).not.toBe(created.maasKeyId);
      expect(row.key_prefix).toBe(body.keyPrefix);
      expect(row.key_hash).toBe(`maas:litemaas-key-${created.id}`);
      expect(revokeSpy).toHaveBeenCalledWith(USER_TOKEN, created.maasKeyId);
      expect(await getSub(created.id)).not.toBeNull();

      const reveal = await apiKeyService.retrieveFullKey(created.id, TEST_USER_IDS.USER);
      expect(reveal).toBe(body.key);
    });

    it('keeps the old key when maas-api fails to issue a new one', async () => {
      const created = await createMaasKey();
      vi.spyOn(maasApi, 'createKey').mockRejectedValue(ApplicationError.maasError('down', 503));
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/api-keys/${created.id}/rotate`,
        headers: { authorization: user() },
      });
      expect(res.statusCode).toBe(502);
      expect((await dbKey(created.id)).maas_key_id).toBe(created.maasKeyId);
    });
  });

  // ---------------------------------------------------------------- revoke

  describe('revoke / delete / archive', () => {
    it('revoke deletes the subscription first and best-effort revokes the maas-api key', async () => {
      const created = await createMaasKey();
      const order: string[] = [];
      const origDelete = k8s.delete.bind(k8s);
      vi.spyOn(k8s, 'delete').mockImplementation(async (...args: any[]) => {
        order.push('k8s.delete');
        return (origDelete as any)(...args);
      });
      vi.spyOn(maasApi, 'revokeKey').mockImplementation(async () => {
        order.push('maas.revoke');
      });

      await apiKeyService.revokeApiKey(created.id, TEST_USER_IDS.USER, 'leaked');
      expect(order).toEqual(['k8s.delete', 'maas.revoke']);
      expect(await getSub(created.id)).toBeNull();
      const row = await dbKey(created.id);
      expect(row).toMatchObject({ is_active: false, maas_sync_state: 'synced' });
      expect(row.revoked_at).not.toBeNull();
      await expect(apiKeyService.revokeApiKey(created.id, TEST_USER_IDS.USER)).rejects.toThrow(
        /already inactive/,
      );
    });

    it('marks the key pending when the maas-api revoke fails and the reconciler retries it', async () => {
      const created = await createMaasKey();
      const revoke = vi.spyOn(maasApi, 'revokeKey').mockRejectedValue(new Error('maas-api down'));
      await apiKeyService.revokeApiKey(created.id, TEST_USER_IDS.USER);
      expect(await getSub(created.id)).toBeNull();
      expect(await dbKey(created.id)).toMatchObject({
        is_active: false,
        maas_sync_state: 'pending',
      });

      // Still failing: stays pending and is reported
      const reconciler = new MaasReconcilerService(app);
      let res = await reconciler.reconcile();
      expect(res.maasApiRevokePending).toBe(1);
      expect((await dbKey(created.id)).maas_sync_state).toBe('pending');

      // maas-api recovers
      revoke.mockReset();
      revoke.mockResolvedValue(undefined);
      res = await reconciler.reconcile();
      expect(res.maasApiRevokePending).toBe(0);
      expect(res.keysMarkedSynced).toBe(1);
      expect((await dbKey(created.id)).maas_sync_state).toBe('synced');
      expect(revoke).toHaveBeenCalledWith(USER_TOKEN, created.maasKeyId);
    });

    it('falls back to the service account token when the user token is gone', async () => {
      const created = await createMaasKey();
      await tokens.clearToken(TEST_USER_IDS.USER);
      app.maasClients!.serviceToken = () => 'sa-token';
      const revoke = vi.spyOn(maasApi, 'revokeKey');
      try {
        await apiKeyService.revokeApiKey(created.id, TEST_USER_IDS.USER);
        expect(revoke).toHaveBeenCalledWith('sa-token', created.maasKeyId);
        expect((await dbKey(created.id)).maas_sync_state).toBe('synced');
      } finally {
        app.maasClients!.serviceToken = undefined;
      }
    });

    it('still revokes (pending) when no token is available at all', async () => {
      const created = await createMaasKey();
      await tokens.clearToken(TEST_USER_IDS.USER);
      const revoke = vi.spyOn(maasApi, 'revokeKey');
      await apiKeyService.revokeApiKey(created.id, TEST_USER_IDS.USER);
      expect(revoke).not.toHaveBeenCalled();
      expect(await getSub(created.id)).toBeNull();
      expect(await dbKey(created.id)).toMatchObject({
        is_active: false,
        maas_sync_state: 'pending',
      });
    });

    it('records pending when the subscription deletion fails (reconciler removes it later)', async () => {
      const created = await createMaasKey();
      const orig = k8s.delete.bind(k8s);
      const spy = vi.spyOn(k8s, 'delete').mockRejectedValueOnce(new Error('apiserver down'));
      await apiKeyService.revokeApiKey(created.id, TEST_USER_IDS.USER);
      expect(await dbKey(created.id)).toMatchObject({
        is_active: false,
        maas_sync_state: 'pending',
      });
      expect(await getSub(created.id)).not.toBeNull();
      spy.mockImplementation(orig as any);
      const res = await new MaasReconcilerService(app).reconcile();
      expect(res.subscriptionsDeleted).toBe(1);
      expect(await getSub(created.id)).toBeNull();
    });

    it('DELETE /api-keys/:id archives: subscription gone, row kept inactive', async () => {
      const created = await createMaasKey();
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/api-keys/${created.id}`,
        headers: { authorization: user() },
      });
      expect(res.statusCode).toBe(200);
      expect(await getSub(created.id)).toBeNull();
      const row = await dbKey(created.id);
      expect(row).toMatchObject({ is_active: false, key_hash: `maas:litemaas-key-${created.id}` });
      expect(row.archived_at).not.toBeNull();
    });

    it('archive keeps the key visible (and active) when the subscription cannot be deleted', async () => {
      const created = await createMaasKey();
      vi.spyOn(k8s, 'delete').mockRejectedValue(new Error('apiserver down'));
      await expect(apiKeyService.archiveApiKey(created.id, TEST_USER_IDS.USER)).rejects.toThrow();
      const row = await dbKey(created.id);
      expect(row.archived_at).toBeNull();
      expect(row.is_active).toBe(true);
    });

    it('permanent delete removes cluster access and the row', async () => {
      const created = await createMaasKey();
      await apiKeyService.deleteApiKey(created.id, TEST_USER_IDS.USER);
      expect(await getSub(created.id)).toBeNull();
      expect(await dbKey(created.id)).toBeNull();
    });
  });

  // --------------------------------------------------------------- expiry

  describe('expiry', () => {
    it('cleanup-expired deactivates expired MaaS keys and revokes their access', async () => {
      const created = await createMaasKey({
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      });
      await app.dbUtils.query(
        `UPDATE api_keys SET expires_at = NOW() - INTERVAL '1 hour' WHERE id = $1`,
        [created.id],
      );
      const revoke = vi.spyOn(maasApi, 'revokeKey');

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/api-keys/admin/cleanup-expired',
        headers: { authorization: admin() },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).cleanedCount).toBeGreaterThanOrEqual(1);
      expect(await getSub(created.id)).toBeNull();
      expect(revoke).toHaveBeenCalledWith(USER_TOKEN, created.maasKeyId);
      expect(await dbKey(created.id)).toMatchObject({
        is_active: false,
        maas_sync_state: 'synced',
      });
      const audit = await app.dbUtils.queryOne<any>(
        `SELECT 1 FROM audit_logs WHERE action = 'API_KEY_EXPIRED' AND resource_id = $1`,
        [created.id],
      );
      expect(audit).not.toBeNull();
    });

    it('the reconciler deactivates expired-but-active keys and removes their subscription', async () => {
      const created = await createMaasKey({
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      });
      await app.dbUtils.query(
        `UPDATE api_keys SET expires_at = NOW() - INTERVAL '1 hour' WHERE id = $1`,
        [created.id],
      );
      const revoke = vi.spyOn(maasApi, 'revokeKey');
      const res = await new MaasReconcilerService(app).reconcile();
      expect(res.keysExpired).toBe(1);
      expect(res.subscriptionsDeleted).toBe(1);
      expect(revoke).toHaveBeenCalledWith(USER_TOKEN, created.maasKeyId);
      expect(await dbKey(created.id)).toMatchObject({
        is_active: false,
        maas_sync_state: 'synced',
      });
      expect(await getSub(created.id)).toBeNull();
    });
  });

  // -------------------------------------------------- model removal hooks

  describe('removeModelFromUserApiKeys', () => {
    it('re-applies the remaining models; revokes the key when the last model goes', async () => {
      const created = await createMaasKey();
      await apiKeyService.removeModelFromUserApiKeys(TEST_USER_IDS.USER, GRANITE);
      let sub = await getSub(created.id);
      expect(sub!.spec.modelRefs.map((m: any) => m.name)).toEqual(['llama-3-2-3b']);
      expect(
        (
          await app.dbUtils.queryMany<any>(
            'SELECT model_id FROM api_key_models WHERE api_key_id = $1',
            [created.id],
          )
        ).map((r) => r.model_id),
      ).toEqual([LLAMA]);
      expect((await dbKey(created.id)).is_active).toBe(true);

      const revoke = vi.spyOn(maasApi, 'revokeKey');
      await apiKeyService.removeModelFromUserApiKeys(TEST_USER_IDS.USER, LLAMA);
      sub = await getSub(created.id);
      expect(sub).toBeNull();
      expect(revoke).toHaveBeenCalledWith(USER_TOKEN, created.maasKeyId);
      const row = await dbKey(created.id);
      expect(row).toMatchObject({ is_active: false });
      expect(row.archived_at).not.toBeNull();
      expect(row.revoked_at).not.toBeNull();
    });

    it('leaves the database unchanged for a key whose cluster update fails', async () => {
      const created = await createMaasKey();
      vi.spyOn(k8s, 'replace').mockRejectedValue(new Error('apiserver down'));
      vi.spyOn(k8s, 'create').mockRejectedValue(new Error('apiserver down'));
      await apiKeyService.removeModelFromUserApiKeys(TEST_USER_IDS.USER, GRANITE);
      expect(
        (
          await app.dbUtils.queryMany<any>(
            'SELECT model_id FROM api_key_models WHERE api_key_id = $1',
            [created.id],
          )
        )
          .map((r) => r.model_id)
          .sort(),
      ).toEqual([GRANITE, LLAMA].sort());
    });

    it('cancelling a subscription through the API strips the model from the key', async () => {
      const created = await createMaasKey();
      const subs = await app.dbUtils.queryMany<any>(
        'SELECT id FROM subscriptions WHERE user_id = $1 AND model_id = $2',
        [TEST_USER_IDS.USER, GRANITE],
      );
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/subscriptions/${subs[0].id}/cancel`,
        headers: { authorization: user() },
      });
      expect(res.statusCode).toBeLessThan(300);
      const sub = await getSub(created.id);
      expect(sub!.spec.modelRefs.map((m: any) => m.name)).toEqual(['llama-3-2-3b']);
    });
  });

  // ------------------------------------------------------------ admin users

  describe('admin user routes', () => {
    const adminUrl = (suffix = '') => `/api/v1/admin/users/${TEST_USER_IDS.USER}/api-keys${suffix}`;

    it('lists MaaS keys with backendType (admin and adminReadonly)', async () => {
      const created = await createMaasKey();
      for (const auth of [admin(), readonly()]) {
        const res = await app.inject({
          method: 'GET',
          url: adminUrl(),
          headers: { authorization: auth },
        });
        expect(res.statusCode).toBe(200);
        const item = JSON.parse(res.body).data.find((k: any) => k.id === created.id);
        expect(item).toMatchObject({
          backendType: 'maas',
          maasKeyId: created.maasKeyId,
          tpmLimit: 1000,
        });
      }
    });

    it('refuses to create keys with MaaS models and creates no subscription', async () => {
      await app.dbUtils.query(`DELETE FROM subscriptions WHERE user_id = $1 AND model_id = $2`, [
        TEST_USER_IDS.USER,
        QWEN,
      ]);
      const before = await app.dbUtils.queryMany(
        `SELECT id FROM subscriptions WHERE model_id = $1`,
        [QWEN],
      );
      const res = await app.inject({
        method: 'POST',
        url: adminUrl(),
        headers: { authorization: admin(), 'content-type': 'application/json' },
        payload: { name: 'admin made', modelIds: [LLAMA] },
      });
      expect(res.statusCode).toBe(400);
      expect(res.body).toMatch(/administrator/);
      expect(
        await app.dbUtils.queryMany(`SELECT id FROM subscriptions WHERE model_id = $1`, [QWEN]),
      ).toHaveLength(before.length);
      expect(await k8s.list(MAAS_SUBSCRIPTION)).toHaveLength(0);
    });

    it('allows TPM edits and revoke, rejects model and non-TPM edits', async () => {
      const created = await createMaasKey({
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      });

      const tpm = await app.inject({
        method: 'PATCH',
        url: adminUrl(`/${created.id}`),
        headers: { authorization: admin(), 'content-type': 'application/json' },
        payload: { tpmLimit: 42 },
      });
      expect(tpm.statusCode).toBe(200);
      expect(tpmByModel(await getSub(created.id))['llama-3-2-3b']).toBe(42);

      const models = await app.inject({
        method: 'PATCH',
        url: adminUrl(`/${created.id}`),
        headers: { authorization: admin(), 'content-type': 'application/json' },
        payload: { modelIds: [LLAMA] },
      });
      expect(models.statusCode).toBe(400);

      const budget = await app.inject({
        method: 'PATCH',
        url: adminUrl(`/${created.id}`),
        headers: { authorization: admin(), 'content-type': 'application/json' },
        payload: { maxBudget: 10 },
      });
      expect(budget.statusCode).toBe(400);

      const later = await app.inject({
        method: 'PATCH',
        url: adminUrl(`/${created.id}`),
        headers: { authorization: admin(), 'content-type': 'application/json' },
        payload: { expiresAt: new Date(Date.now() + 5 * 86_400_000).toISOString() },
      });
      expect(later.statusCode).toBe(400);

      const reset = await app.inject({
        method: 'POST',
        url: adminUrl(`/${created.id}/reset-spend`),
        headers: { authorization: admin() },
      });
      expect(reset.statusCode).toBe(400);

      const revoke = await app.inject({
        method: 'DELETE',
        url: adminUrl(`/${created.id}`),
        headers: { authorization: admin(), 'content-type': 'application/json' },
        payload: { reason: 'admin revoke' },
      });
      expect(revoke.statusCode).toBe(200);
      expect(await getSub(created.id)).toBeNull();
      expect((await dbKey(created.id)).is_active).toBe(false);
    });

    it('adminReadonly cannot modify MaaS keys', async () => {
      const created = await createMaasKey();
      const res = await app.inject({
        method: 'PATCH',
        url: adminUrl(`/${created.id}`),
        headers: { authorization: readonly(), 'content-type': 'application/json' },
        payload: { tpmLimit: 1 },
      });
      expect(res.statusCode).toBe(403);
    });

    it('does not let admins add MaaS models to a LiteLLM key', async () => {
      await app.dbUtils.query(
        `INSERT INTO api_keys (id, user_id, name, key_hash, key_prefix, is_active)
         VALUES ('00000000-0000-4000-8000-0000000000a2', $1, 'plain', 'maas:plain-litellm', 'sk-ab', true)`,
        [TEST_USER_IDS.USER],
      );
      const res = await app.inject({
        method: 'PATCH',
        url: adminUrl('/00000000-0000-4000-8000-0000000000a2'),
        headers: { authorization: admin(), 'content-type': 'application/json' },
        payload: { modelIds: [LLAMA] },
      });
      expect(res.statusCode).toBe(400);
      expect(res.body).toMatch(/LiteLLM API key/);
    });
  });
});
