/**
 * Integration tests for MaaS usage (Prometheus merge into admin usage, per-key usage, user spend),
 * LiteLLM -> MaaS model migration (route, subscription copy, grace job) and the health section.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { FastifyInstance } from 'fastify';
import { createApp } from '../../../src/app';
import { generateTestToken, createTestUsers, TEST_USER_IDS } from '../setup';
import { AdminUsageAggregationService } from '../../../src/services/admin-usage/admin-usage-aggregation.service';
import { UsageStatsService } from '../../../src/services/usage-stats.service';
import { MaasMigrationService } from '../../../src/services/maas/maas-migration.service';
import { MaasReconcilerService } from '../../../src/services/maas/maas-reconciler.service';
import {
  MAAS_AUTH_POLICY,
  MAAS_MODEL_REF,
  MAAS_SUBSCRIPTION,
} from '../../../src/services/maas/maas-resources';
import { MockPrometheusClient } from '../../../src/services/maas/prometheus.client';
import type { InMemoryK8sClient } from '../../../src/services/k8s/k8s-client';

const NS = 'maas-demo-models';
const POLICY_NS = 'models-as-a-service';
const MAAS_MODEL = `${NS}/llama-3-2-3b`;
const OLD_MODEL = 'usage-migr-old-model';
const KEY_ID = '00000000-0000-4000-8000-0000000000aa';
const SUB = `litemaas-key-${KEY_ID}`;

const sample = (subscription: string, model: string, value: number) => ({
  metric: { subscription, model },
  value: [0, String(value)] as [number, string],
});

describe('MaaS usage, migration and health', () => {
  let app: FastifyInstance;
  let k8s: InMemoryK8sClient;
  let originalPrometheus: any;

  const admin = () => `Bearer ${generateTestToken(TEST_USER_IDS.ADMIN, ['admin'])}`;
  const readonly = () =>
    `Bearer ${generateTestToken(TEST_USER_IDS.ADMIN_READONLY, ['admin-readonly'])}`;
  const user = () => `Bearer ${generateTestToken(TEST_USER_IDS.USER, ['user'])}`;

  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

  async function cleanDb() {
    await app.dbUtils.query(`DELETE FROM api_keys WHERE id = $1 OR name LIKE 'migr-test-%'`, [
      KEY_ID,
    ]);
    await app.dbUtils.query(
      `DELETE FROM subscription_status_history WHERE subscription_id IN
         (SELECT id FROM subscriptions WHERE model_id LIKE $1 OR model_id = $2)`,
      [`${NS}/%`, OLD_MODEL],
    );
    await app.dbUtils.query(`DELETE FROM subscriptions WHERE model_id LIKE $1 OR model_id = $2`, [
      `${NS}/%`,
      OLD_MODEL,
    ]);
    await app.dbUtils.query(`DELETE FROM models WHERE id LIKE $1 OR id = $2`, [
      `${NS}/%`,
      OLD_MODEL,
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

  async function insertOldModel(extra: { restricted?: boolean } = {}) {
    await app.dbUtils.query(
      `INSERT INTO models (id, name, provider, description, category, context_length,
         input_cost_per_token, output_cost_per_token, features, availability, restricted_access,
         backend_type, backend_model_name)
       VALUES ($1, 'Old Llama', 'openai', 'old desc', 'Language Model', 8192, 0.000001, 0.000003,
               ARRAY['chat'], 'available', $2, 'litellm', $1)`,
      [OLD_MODEL, extra.restricted === true],
    );
  }

  async function subscribeDirect(userId: string, modelId: string, status = 'active') {
    const r = await app.dbUtils.queryOne<any>(
      `INSERT INTO subscriptions (user_id, model_id, status) VALUES ($1, $2, $3) RETURNING id`,
      [userId, modelId, status],
    );
    return r.id as string;
  }

  async function insertLiteLLMKey(userId: string, modelId: string) {
    const key = await app.dbUtils.queryOne<any>(
      `INSERT INTO api_keys (user_id, name, key_hash, key_prefix, is_active)
       VALUES ($1, 'migr-test-key', $2, 'sk-test', true) RETURNING id`,
      [userId, `hash-${Math.random()}`],
    );
    await app.dbUtils.query('INSERT INTO api_key_models (api_key_id, model_id) VALUES ($1, $2)', [
      key.id,
      modelId,
    ]);
    return key.id as string;
  }

  function migrate(modelId: string, body: object, auth = admin()) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/admin/models/${encodeURIComponent(modelId)}/migrate-to-maas`,
      headers: { authorization: auth, 'content-type': 'application/json' },
      payload: body,
    });
  }

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.OAUTH_MOCK_ENABLED = 'true';
    process.env.MAAS_ENABLED = 'true';
    process.env.ENCRYPTION_KEY = 'integration-test-encryption-key';
    process.env.RATE_LIMIT_MAX = '100000';
    delete process.env.K8S_API_URL;
    delete process.env.MAAS_API_URL;
    delete process.env.PROMETHEUS_URL;
    app = await createApp({ logger: false });
    await app.ready();
    await createTestUsers(app);
    k8s = app.maasClients!.k8s as InMemoryK8sClient;
    originalPrometheus = app.maasClients!.prometheus;
  });

  afterAll(async () => {
    if (app) {
      app.maasClients!.prometheus = originalPrometheus;
      await cleanDb();
      await app.close();
    }
    delete process.env.MAAS_ENABLED;
    delete process.env.ENCRYPTION_KEY;
    delete process.env.RATE_LIMIT_MAX;
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    app.maasClients!.prometheus = originalPrometheus;
    (app.backends.get('maas').usage as any).clearCache();
    await cleanDb();
    await seedCluster();
  });

  // ------------------------------------------------------------------ usage

  describe('usage', () => {
    async function seedMaasUsageModelAndKey() {
      await app.dbUtils.query(
        `INSERT INTO models (id, name, provider, category, features, availability,
           backend_type, backend_model_name, maas_model_ref_name, maas_model_ref_namespace,
           input_cost_per_token, output_cost_per_token)
         VALUES ($1, 'Llama', 'maas', 'Language Model', ARRAY['chat'], 'available', 'maas',
                 'llama-3-2-3b', 'llama-3-2-3b', $2, 0.000002, 0.000002)`,
        [MAAS_MODEL, NS],
      );
      await app.dbUtils.query(
        `INSERT INTO api_keys (id, user_id, name, key_hash, key_prefix, is_active, backend_type,
           maas_subscription_name, maas_sync_state)
         VALUES ($1, $2, 'migr-test-maas-key', $3, 'sk-oai-', true, 'maas', $4, 'synced')`,
        [KEY_ID, TEST_USER_IDS.USER, `maas:${SUB}`, SUB],
      );
    }

    const promWith = (hits: number, calls: number) =>
      new MockPrometheusClient({
        query: (q) =>
          q.includes('authorized_hits')
            ? [sample(SUB, 'llama-3-2-3b', hits)]
            : [sample(SUB, 'llama-3-2-3b', calls)],
      });

    const liteLLM = (requests: number, throws = false) =>
      ({
        getDailyActivity: vi.fn(async () => {
          if (throws) throw new Error('litellm down');
          return { api_requests: requests, total_tokens: 0, spend: 0, daily_metrics: [] };
        }),
      }) as any;

    it('keeps a MaaS-only day when LiteLLM returned no requests (merge before the zero-request check)', async () => {
      await seedMaasUsageModelAndKey();
      app.maasClients!.prometheus = promWith(1000, 7);
      const service = new AdminUsageAggregationService(app, liteLLM(0));

      const days = await service.collectDateRangeData(yesterday, yesterday);

      expect(days).toHaveLength(1);
      const day = days[0];
      expect(day.metrics.api_requests).toBe(7);
      expect(day.metrics.total_tokens).toBe(1000);
      expect(day.metrics.spend).toBeCloseTo(1000 * 2e-6, 10);
      // enrichment maps the synthetic key hash to the owner
      expect(day.breakdown.users[TEST_USER_IDS.USER].username).toBe('testuser');
      expect(day.breakdown.models[MAAS_MODEL].users[TEST_USER_IDS.USER].metrics.total_tokens).toBe(
        1000,
      );
      expect(
        day.breakdown.users[TEST_USER_IDS.USER].models[MAAS_MODEL].api_keys![SUB].keyName,
      ).toBe('migr-test-maas-key');
      expect((day.rawData as any).sources.maas.tokenSplitAvailable).toBe(false);
    });

    it('merges with LiteLLM usage on the same day', async () => {
      await seedMaasUsageModelAndKey();
      app.maasClients!.prometheus = promWith(500, 3);
      const lite = {
        getDailyActivity: vi.fn(async () => ({
          api_requests: 2,
          total_tokens: 40,
          prompt_tokens: 30,
          completion_tokens: 10,
          spend: 0.5,
          daily_metrics: [
            {
              breakdown: {
                models: {
                  'litellm-model': {
                    metrics: { api_requests: 2, total_tokens: 40, spend: 0.5 },
                    api_key_breakdown: {},
                  },
                },
              },
            },
          ],
        })),
      } as any;
      const service = new AdminUsageAggregationService(app, lite);
      const [day] = await service.collectDateRangeData(yesterday, yesterday);
      expect(day.metrics.api_requests).toBe(5);
      // totals are re-derived from per-key prompt+completion; the LiteLLM stub has no per-key rows
      expect(day.metrics.total_tokens).toBe(500);
      expect(Object.keys(day.breakdown.models).sort()).toEqual(
        ['litellm-model', MAAS_MODEL].sort(),
      );
    });

    it('does not block on MaaS errors and does not cache the incomplete day', async () => {
      await seedMaasUsageModelAndKey();
      app.maasClients!.prometheus = new MockPrometheusClient({
        query: () => {
          throw new Error('thanos down');
        },
      });
      const cache = {
        getCachedDailyData: vi.fn().mockResolvedValue(null),
        saveToDailyCache: vi.fn().mockResolvedValue(undefined),
      } as any;
      const service = new AdminUsageAggregationService(app, liteLLM(4), cache);

      const days = await service.collectDateRangeData(yesterday, yesterday);

      expect(days).toHaveLength(1);
      expect(days[0].metrics.api_requests).toBe(4);
      expect(cache.saveToDailyCache).not.toHaveBeenCalled();
    });

    it('still surfaces LiteLLM errors (only MaaS is non-blocking)', async () => {
      await seedMaasUsageModelAndKey();
      app.maasClients!.prometheus = promWith(10, 1);
      const service = new AdminUsageAggregationService(app, liteLLM(0, true));
      // collectDateRangeData swallows per-day errors, refreshSingleDay does not
      await expect(service.refreshSingleDay(yesterday)).rejects.toThrow();
    });

    it('caches the merged day when MaaS succeeded', async () => {
      await seedMaasUsageModelAndKey();
      app.maasClients!.prometheus = promWith(10, 1);
      const cache = {
        getCachedDailyData: vi.fn().mockResolvedValue(null),
        saveToDailyCache: vi.fn().mockResolvedValue(undefined),
      } as any;
      const service = new AdminUsageAggregationService(app, liteLLM(0), cache);
      await service.collectDateRangeData(yesterday, yesterday);
      expect(cache.saveToDailyCache).toHaveBeenCalledTimes(1);
    });

    it('reports per-key usage for a MaaS key via UsageStatsService', async () => {
      await seedMaasUsageModelAndKey();
      app.maasClients!.prometheus = promWith(2000, 20);
      const stats = await new UsageStatsService(app).getUsageStats({
        apiKeyId: KEY_ID,
        startDate: new Date(`${yesterday}T00:00:00Z`),
        endDate: new Date(`${yesterday}T00:00:00Z`),
        aggregateBy: 'model',
      });
      expect(stats.totalMetrics.totalRequests).toBe(20);
      expect(stats.totalMetrics.totalTokens).toBe(2000);
      expect(stats.totalMetrics.totalCost).toBeCloseTo(0.004, 8);
      expect(stats.modelBreakdown?.[0]).toMatchObject({ modelId: MAAS_MODEL, totalTokens: 2000 });
    });

    it('degrades to zeroed per-key metrics when Prometheus fails', async () => {
      await seedMaasUsageModelAndKey();
      app.maasClients!.prometheus = new MockPrometheusClient({
        query: () => {
          throw new Error('boom');
        },
      });
      const stats = await new UsageStatsService(app).getUsageStats({
        apiKeyId: KEY_ID,
        startDate: new Date(`${yesterday}T00:00:00Z`),
        endDate: new Date(`${yesterday}T00:00:00Z`),
        aggregateBy: 'time',
      });
      expect(stats.totalMetrics.totalTokens).toBe(0);
      expect(stats.timeSeriesData).toEqual([]);
    });

    it('adds estimated MaaS spend to GET /usage/budget', async () => {
      await seedMaasUsageModelAndKey();
      app.maasClients!.prometheus = promWith(1_000_000, 10);
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/usage/budget',
        headers: { authorization: user() },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      // at least today (day 1 of month => 1 day queried); each queried day returns the same mock
      expect(body.maasTokens).toBeGreaterThanOrEqual(1_000_000);
      expect(body.maasSpend).toBeGreaterThan(0);
      expect(typeof body.currentSpend).toBe('number');
    });

    it('omits MaaS spend for users without MaaS keys and survives Prometheus errors', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/usage/budget',
        headers: { authorization: user() },
      });
      expect(JSON.parse(res.body).maasSpend).toBeUndefined();

      await seedMaasUsageModelAndKey();
      app.maasClients!.prometheus = new MockPrometheusClient({
        query: () => {
          throw new Error('boom');
        },
      });
      const failing = await app.inject({
        method: 'GET',
        url: '/api/v1/usage/budget',
        headers: { authorization: user() },
      });
      expect(failing.statusCode).toBe(200);
      expect(JSON.parse(failing.body).maasSpend).toBeUndefined();
    });
  });

  // -------------------------------------------------------------- migration

  describe('migrate-to-maas', () => {
    it('copies the model and active subscriptions, marks the old model migrating and applies policies', async () => {
      await insertOldModel({ restricted: true });
      await subscribeDirect(TEST_USER_IDS.USER, OLD_MODEL, 'active');
      await subscribeDirect(TEST_USER_IDS.ADMIN, OLD_MODEL, 'pending'); // not copied

      const res = await migrate(OLD_MODEL, {
        maasModelRef: { name: 'llama-3-2-3b', namespace: NS },
        graceDays: 7,
      });
      expect(res.statusCode).toBe(200);
      const { data } = JSON.parse(res.body);
      expect(data).toMatchObject({
        oldModelId: OLD_MODEL,
        newModelId: MAAS_MODEL,
        created: true,
        subscriptionsCopied: 1,
        policyFailures: 0,
      });
      const graceMs = new Date(data.graceUntil).getTime() - Date.now();
      expect(graceMs).toBeGreaterThan(6.9 * 86_400_000);
      expect(graceMs).toBeLessThan(7.1 * 86_400_000);

      const old = await app.dbUtils.queryOne<any>('SELECT * FROM models WHERE id = $1', [
        OLD_MODEL,
      ]);
      expect(old).toMatchObject({ migration_state: 'migrating', availability: 'available' });

      const fresh = await app.dbUtils.queryOne<any>('SELECT * FROM models WHERE id = $1', [
        MAAS_MODEL,
      ]);
      expect(fresh).toMatchObject({
        backend_type: 'maas',
        name: 'Old Llama',
        migrated_from_litellm_id: OLD_MODEL,
        restricted_access: true,
        context_length: 8192,
        maas_model_ref_name: 'llama-3-2-3b',
        maas_model_ref_namespace: NS,
        availability: 'available',
      });
      expect(Number(fresh.input_cost_per_token)).toBeCloseTo(1e-6, 12);

      const subs = await app.dbUtils.queryMany<any>(
        'SELECT user_id, status FROM subscriptions WHERE model_id = $1',
        [MAAS_MODEL],
      );
      expect(subs).toEqual([{ user_id: TEST_USER_IDS.USER, status: 'active' }]);
      const history = await app.dbUtils.queryMany<any>(
        `SELECT h.reason FROM subscription_status_history h
           JOIN subscriptions s ON s.id = h.subscription_id WHERE s.model_id = $1`,
        [MAAS_MODEL],
      );
      expect(history[0].reason).toContain(OLD_MODEL);

      const policy = await k8s.get(MAAS_AUTH_POLICY, 'litemaas-testuser', POLICY_NS);
      expect(policy?.spec.modelRefs).toEqual([{ name: 'llama-3-2-3b', namespace: NS }]);

      const audit = await app.dbUtils.queryOne<any>(
        `SELECT metadata FROM audit_logs WHERE action = 'MODEL_MIGRATE_TO_MAAS' AND resource_id = $1`,
        [OLD_MODEL],
      );
      expect(audit.metadata.newModelId).toBe(MAAS_MODEL);
    });

    it('blocks new subscriptions on the migrating model and points at the MaaS model', async () => {
      await insertOldModel();
      await migrate(OLD_MODEL, { maasModelRef: { name: 'llama-3-2-3b', namespace: NS } });

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/subscriptions',
        headers: { authorization: user() },
        payload: { modelId: OLD_MODEL },
      });
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain(MAAS_MODEL);
    });

    it('reuses a synced MaaS row, filling only empty fields and never lowering restrictions', async () => {
      await insertOldModel();
      await app.dbUtils.query(
        `INSERT INTO models (id, name, provider, description, category, features, availability,
           backend_type, backend_model_name, maas_model_ref_name, maas_model_ref_namespace,
           restricted_access, input_cost_per_token)
         VALUES ($1, 'Admin Name', 'maas', 'admin desc', 'Language Model', ARRAY['chat'],
                 'available', 'maas', 'llama-3-2-3b', 'llama-3-2-3b', $2, true, 0.5)`,
        [MAAS_MODEL, NS],
      );
      const res = await migrate(OLD_MODEL, {
        maasModelRef: { name: 'llama-3-2-3b', namespace: NS },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).data.created).toBe(false);
      const row = await app.dbUtils.queryOne<any>('SELECT * FROM models WHERE id = $1', [
        MAAS_MODEL,
      ]);
      expect(row).toMatchObject({
        name: 'Admin Name',
        description: 'admin desc',
        restricted_access: true,
        context_length: 8192,
        migrated_from_litellm_id: OLD_MODEL,
      });
      expect(Number(row.input_cost_per_token)).toBe(0.5);
      expect(Number(row.output_cost_per_token)).toBeCloseTo(3e-6, 12);
    });

    it('reactivates an inactive MaaS subscription and keeps an existing active one', async () => {
      await insertOldModel();
      await subscribeDirect(TEST_USER_IDS.USER, OLD_MODEL, 'active');
      await subscribeDirect(TEST_USER_IDS.ADMIN, OLD_MODEL, 'active');
      await app.dbUtils.query(
        `INSERT INTO models (id, name, provider, category, features, availability, backend_type,
           maas_model_ref_name, maas_model_ref_namespace)
         VALUES ($1, 'x', 'maas', 'Language Model', ARRAY['chat'], 'available', 'maas',
                 'llama-3-2-3b', $2)`,
        [MAAS_MODEL, NS],
      );
      await subscribeDirect(TEST_USER_IDS.USER, MAAS_MODEL, 'inactive');
      await subscribeDirect(TEST_USER_IDS.ADMIN, MAAS_MODEL, 'active');

      const res = await migrate(OLD_MODEL, {
        maasModelRef: { name: 'llama-3-2-3b', namespace: NS },
      });
      expect(JSON.parse(res.body).data.subscriptionsCopied).toBe(2);
      const subs = await app.dbUtils.queryMany<any>(
        'SELECT status FROM subscriptions WHERE model_id = $1',
        [MAAS_MODEL],
      );
      expect(subs.map((s) => s.status)).toEqual(['active', 'active']);
    });

    it('validates input and state', async () => {
      // unknown model
      expect(
        (await migrate('nope-model', { maasModelRef: { name: 'llama-3-2-3b', namespace: NS } }))
          .statusCode,
      ).toBe(404);

      await insertOldModel();
      // unknown ref
      expect(
        (await migrate(OLD_MODEL, { maasModelRef: { name: 'missing', namespace: NS } })).statusCode,
      ).toBe(404);
      // bad grace
      expect(
        (
          await migrate(OLD_MODEL, {
            maasModelRef: { name: 'llama-3-2-3b', namespace: NS },
            graceDays: 0,
          })
        ).statusCode,
      ).toBe(400);
      // missing body fields
      expect((await migrate(OLD_MODEL, {})).statusCode).toBe(400);

      // success, then repeat -> conflict
      expect(
        (await migrate(OLD_MODEL, { maasModelRef: { name: 'llama-3-2-3b', namespace: NS } }))
          .statusCode,
      ).toBe(200);
      expect(
        (await migrate(OLD_MODEL, { maasModelRef: { name: 'granite-3-3-8b', namespace: NS } }))
          .statusCode,
      ).toBe(409);
    });

    it('refuses to migrate a MaaS model and a target that is already a migration target', async () => {
      await insertOldModel();
      await migrate(OLD_MODEL, { maasModelRef: { name: 'llama-3-2-3b', namespace: NS } });

      // the MaaS row itself is not a LiteLLM model
      const res = await migrate(MAAS_MODEL, {
        maasModelRef: { name: 'granite-3-3-8b', namespace: NS },
      });
      expect(res.statusCode).toBe(400);

      // another LiteLLM model cannot reuse the same target
      await app.dbUtils.query(
        `INSERT INTO models (id, name, provider, category, features, availability, backend_type)
         VALUES ('usage-migr-other', 'o', 'openai', 'Language Model', ARRAY['chat'], 'available', 'litellm')`,
      );
      try {
        const dup = await migrate('usage-migr-other', {
          maasModelRef: { name: 'llama-3-2-3b', namespace: NS },
        });
        expect(dup.statusCode).toBe(409);
      } finally {
        await app.dbUtils.query(`DELETE FROM models WHERE id = 'usage-migr-other'`);
      }
    });

    it('enforces RBAC: admin only', async () => {
      await insertOldModel();
      const body = { maasModelRef: { name: 'llama-3-2-3b', namespace: NS } };
      expect((await migrate(OLD_MODEL, body, user())).statusCode).toBe(403);
      expect((await migrate(OLD_MODEL, body, readonly())).statusCode).toBe(403);
    });
  });

  // ------------------------------------------------------------- grace job

  describe('grace job', () => {
    async function startMigration(graceUntilPast: boolean) {
      await insertOldModel();
      await subscribeDirect(TEST_USER_IDS.USER, OLD_MODEL, 'active');
      await migrate(OLD_MODEL, { maasModelRef: { name: 'llama-3-2-3b', namespace: NS } });
      if (graceUntilPast) {
        await app.dbUtils.query(
          `UPDATE models SET migration_grace_until = now() - interval '1 minute' WHERE id = $1`,
          [OLD_MODEL],
        );
      }
    }

    it('does nothing before the grace period ends', async () => {
      await startMigration(false);
      const keyId = await insertLiteLLMKey(TEST_USER_IDS.USER, OLD_MODEL);
      const res = await new MaasMigrationService(app).processExpiredGrace();
      expect(res).toEqual({ completed: 0, pending: 0, errors: [] });
      const keyModels = await app.dbUtils.queryMany<any>(
        'SELECT model_id FROM api_key_models WHERE api_key_id = $1',
        [keyId],
      );
      expect(keyModels).toHaveLength(1);
    });

    it('after grace removes the model from LiteLLM keys, deactivates old subscriptions and completes', async () => {
      await startMigration(true);
      const keyId = await insertLiteLLMKey(TEST_USER_IDS.USER, OLD_MODEL);

      const res = await new MaasMigrationService(app).processExpiredGrace();
      expect(res).toEqual({ completed: 1, pending: 0, errors: [] });

      const old = await app.dbUtils.queryOne<any>('SELECT * FROM models WHERE id = $1', [
        OLD_MODEL,
      ]);
      expect(old).toMatchObject({ migration_state: 'completed', availability: 'unavailable' });
      const remaining = await app.dbUtils.queryMany(
        'SELECT 1 FROM api_key_models WHERE model_id = $1',
        [OLD_MODEL],
      );
      expect(remaining).toHaveLength(0);
      const key = await app.dbUtils.queryOne<any>('SELECT is_active FROM api_keys WHERE id = $1', [
        keyId,
      ]);
      expect(key.is_active).toBe(false); // zero models left => archived
      const oldSub = await app.dbUtils.queryOne<any>(
        'SELECT status FROM subscriptions WHERE model_id = $1',
        [OLD_MODEL],
      );
      expect(oldSub.status).toBe('inactive');
      // the MaaS subscription copy stays active
      const newSub = await app.dbUtils.queryOne<any>(
        'SELECT status FROM subscriptions WHERE model_id = $1',
        [MAAS_MODEL],
      );
      expect(newSub.status).toBe('active');
      const audit = await app.dbUtils.queryOne<any>(
        `SELECT id FROM audit_logs WHERE action = 'MODEL_MIGRATION_COMPLETED' AND resource_id = $1`,
        [OLD_MODEL],
      );
      expect(audit).toBeTruthy();

      // idempotent
      expect(await new MaasMigrationService(app).processExpiredGrace()).toEqual({
        completed: 0,
        pending: 0,
        errors: [],
      });
    });

    it('stays pending (retried) when LiteLLM keys could not be updated', async () => {
      await startMigration(true);
      await insertLiteLLMKey(TEST_USER_IDS.USER, OLD_MODEL);
      // removeModelFromUserApiKeys swallows per-key failures and leaves the association
      const { ApiKeyService } = await import('../../../src/services/api-key.service');
      vi.spyOn(ApiKeyService.prototype, 'removeModelFromUserApiKeys').mockResolvedValue(undefined);

      const res = await new MaasMigrationService(app).processExpiredGrace();
      expect(res).toMatchObject({ completed: 0, pending: 1 });
      const old = await app.dbUtils.queryOne<any>('SELECT * FROM models WHERE id = $1', [
        OLD_MODEL,
      ]);
      expect(old).toMatchObject({ migration_state: 'migrating', availability: 'available' });
    });

    it('records an error and stays migrating when the key cleanup throws', async () => {
      await startMigration(true);
      await insertLiteLLMKey(TEST_USER_IDS.USER, OLD_MODEL);
      const { ApiKeyService } = await import('../../../src/services/api-key.service');
      vi.spyOn(ApiKeyService.prototype, 'removeModelFromUserApiKeys').mockRejectedValue(
        new Error('db down'),
      );
      const res = await new MaasMigrationService(app).processExpiredGrace();
      expect(res.pending).toBe(1);
      expect(res.errors[0]).toContain('db down');
    });

    it('runs as part of the reconciler pass', async () => {
      await startMigration(true);
      const result = await new MaasReconcilerService(app).reconcile();
      expect(result.ran).toBe(true);
      expect(result.migrationsCompleted).toBe(1);
      const old = await app.dbUtils.queryOne<any>(
        'SELECT migration_state FROM models WHERE id = $1',
        [OLD_MODEL],
      );
      expect(old.migration_state).toBe('completed');
    });

    it('LiteLLM sync does not revive a completed migration', async () => {
      await startMigration(true);
      await new MaasMigrationService(app).processExpiredGrace();
      const { ModelSyncService } = await import('../../../src/services/model-sync.service');
      const svc = new ModelSyncService(app) as any;
      vi.spyOn(svc, 'getExistingModels').mockResolvedValue([
        { id: OLD_MODEL, migration_state: 'completed', availability: 'unavailable' },
      ]);
      const update = vi.spyOn(svc, 'updateModel');
      const insert = vi.spyOn(svc, 'insertModel');
      svc.litellmService = {
        getModels: vi.fn().mockResolvedValue([{ model_name: OLD_MODEL }]),
        getModelsFromDatabase: vi.fn().mockResolvedValue([OLD_MODEL]),
      };
      await svc.syncModels({ markUnavailable: false }).catch(() => undefined);
      expect(update).not.toHaveBeenCalled();
      expect(insert).not.toHaveBeenCalled();
    });
  });

  // ------------------------------------------------------------------ health

  describe('health', () => {
    it('reports a non-blocking maas section when MaaS is enabled', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/health' });
      const body = JSON.parse(res.body);
      expect(body.maas).toEqual({
        enabled: true,
        maasApi: 'healthy',
        kubernetes: 'healthy',
        prometheus: 'healthy',
        mock: true,
      });
    });

    it('MaaS failures never change the overall status or HTTP code', async () => {
      const before = await app.inject({ method: 'GET', url: '/api/v1/health' });
      app.maasClients!.prometheus = new MockPrometheusClient();
      vi.spyOn(app.maasClients!.prometheus, 'health').mockResolvedValue({
        healthy: false,
        message: 'down',
      });
      vi.spyOn(app.maasClients!.maasApi, 'health').mockRejectedValue(new Error('x'));
      const res = await app.inject({ method: 'GET', url: '/api/v1/health' });
      const body = JSON.parse(res.body);
      expect(body.maas).toMatchObject({
        maasApi: 'unhealthy',
        prometheus: 'unhealthy',
        kubernetes: 'healthy',
      });
      expect(res.statusCode).toBe(before.statusCode);
      expect(body.status).toBe(JSON.parse(before.body).status);
      expect(body.checks).toEqual(JSON.parse(before.body).checks);
    });
  });
});
