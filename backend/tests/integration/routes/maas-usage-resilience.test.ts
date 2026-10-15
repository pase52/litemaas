/**
 * Integration tests for the MaaS usage resilience and key-identity fixes (MAAS_ENABLED=true with
 * the mock cluster / mock Prometheus):
 *  - GET /usage/budget never waits on a slow or failing Prometheus
 *  - MaaS keys are identified by their subscription name in the usage key filters
 *  - MaaS models are reported under the `maas` provider
 *  - the usage resync keeps the cached MaaS usage Prometheus can no longer provide
 *    (against the real daily_usage_cache table)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { FastifyInstance } from 'fastify';
import { createApp } from '../../../src/app';
import { generateTestToken, createTestUsers, TEST_USER_IDS } from '../setup';
import { AdminUsageStatsService } from '../../../src/services/admin-usage-stats.service';
import { DailyUsageCacheManager } from '../../../src/services/daily-usage-cache-manager';
import { setMaasModelIds } from '../../../src/services/admin-usage/admin-usage.utils';
import { MockPrometheusClient } from '../../../src/services/maas/prometheus.client';
import { ApplicationError } from '../../../src/utils/errors';
import type { LiteLLMDayData } from '../../../src/types/admin-usage.types';

const MODEL_NS = 'usage-res-ns';
const MAAS_MODEL = `${MODEL_NS}/llama`;
const KEY_ID = '00000000-0000-4000-8000-0000000000b1';
const OTHER_KEY_ID = '00000000-0000-4000-8000-0000000000b2';
const SUB = `litemaas-key-${KEY_ID}`;
const OTHER_SUB = `litemaas-key-${OTHER_KEY_ID}`;
/** Far older than any Prometheus retention, and not a date other test files use */
const OLD_DAY = '2001-03-04';

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const yesterday = daysAgo(1);
const RECENT_DAY = daysAgo(6);

const sample = (subscription: string, model: string, value: number) => ({
  metric: { subscription, model },
  value: [0, String(value)] as [number, string],
});

const metrics = (requests: number, tokens: number, spend: number) => ({
  api_requests: requests,
  total_tokens: tokens,
  prompt_tokens: tokens,
  completion_tokens: 0,
  spend,
});

/** A day as MaasUsageSource.getDayData would have cached it for the seeded key */
function cachedMaasDay(date: string, tokens: number, calls: number): LiteLLMDayData {
  const key = {
    metadata: { key_alias: SUB },
    metrics: {
      ...metrics(calls, tokens, tokens * 2e-6),
      successful_requests: calls,
      failed_requests: 0,
    },
  };
  return {
    date,
    metrics: { ...key.metrics },
    breakdown: {
      models: {
        [MAAS_MODEL]: {
          metrics: metrics(calls, tokens, tokens * 2e-6),
          api_keys: { [`maas:${SUB}`]: key },
        },
      },
      api_keys: {},
      providers: { maas: { metrics: metrics(calls, tokens, tokens * 2e-6) } },
    },
    sources: { maas: { tokenSplitAvailable: false, costEstimated: true } },
  };
}

describe('MaaS usage resilience and key identity', () => {
  let app: FastifyInstance;
  let originalPrometheus: any;

  const user = () => `Bearer ${generateTestToken(TEST_USER_IDS.USER, ['user'])}`;
  const admin = () => `Bearer ${generateTestToken(TEST_USER_IDS.ADMIN, ['admin'])}`;

  const liteLLM = (requests: number) =>
    ({
      getDailyActivity: vi.fn(async () => ({
        api_requests: requests,
        total_tokens: 0,
        spend: 0,
        daily_metrics: [],
      })),
      clearActivityCache: vi.fn(),
    }) as any;

  async function cleanDb() {
    await app.dbUtils.query(`DELETE FROM api_keys WHERE id = ANY($1)`, [[KEY_ID, OTHER_KEY_ID]]);
    await app.dbUtils.query(`DELETE FROM models WHERE id LIKE $1`, [`${MODEL_NS}/%`]);
    await app.dbUtils.query(`DELETE FROM daily_usage_cache WHERE date = ANY($1)`, [
      [OLD_DAY, RECENT_DAY],
    ]);
  }

  async function seedMaasModelAndKeys() {
    await app.dbUtils.query(
      `INSERT INTO models (id, name, provider, category, features, availability,
         backend_type, backend_model_name, maas_model_ref_name, maas_model_ref_namespace,
         input_cost_per_token, output_cost_per_token)
       VALUES ($1, 'Llama', 'maas', 'Language Model', ARRAY['chat'], 'available', 'maas',
               'llama', 'llama', $2, 0.000002, 0.000002)`,
      [MAAS_MODEL, MODEL_NS],
    );
    for (const [id, userId, sub, name] of [
      [KEY_ID, TEST_USER_IDS.USER, SUB, 'res-test-maas-key'],
      [OTHER_KEY_ID, TEST_USER_IDS.ADMIN, OTHER_SUB, 'res-test-maas-key-other'],
    ]) {
      await app.dbUtils.query(
        `INSERT INTO api_keys (id, user_id, name, key_hash, key_prefix, is_active, backend_type,
           maas_subscription_name, maas_sync_state)
         VALUES ($1, $2, $3, $4, 'sk-oai-', true, 'maas', $5, 'synced')`,
        [id, userId, name, `maas:${sub}`, sub],
      );
    }
  }

  const promWith = (hits: number, calls: number) =>
    new MockPrometheusClient({
      query: (q) =>
        q.includes('authorized_hits')
          ? [sample(SUB, 'llama', hits)]
          : [sample(SUB, 'llama', calls)],
    });

  const outage = () =>
    ApplicationError.maasError('Failed to reach Prometheus', undefined, 'timeout', true);

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
    await seedMaasModelAndKeys();
  });

  afterEach(() => {
    setMaasModelIds([]);
  });

  // ------------------------------------------------------------ budget endpoint

  describe('GET /usage/budget', () => {
    const budget = () =>
      app.inject({
        method: 'GET',
        url: '/api/v1/usage/budget',
        headers: { authorization: user() },
      });

    it('stops waiting for a slow Prometheus after about 2 s and omits the MaaS fields', async () => {
      const slow = new MockPrometheusClient();
      vi.spyOn(slow, 'query').mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve([]), 8000).unref();
          }),
      );
      app.maasClients!.prometheus = slow;

      const started = Date.now();
      const res = await budget();
      const elapsed = Date.now() - started;

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(typeof body.currentSpend).toBe('number');
      expect(body.maasSpend).toBeUndefined();
      expect(body.maasTokens).toBeUndefined();
      // it waited for the 2 s budget, not for the (8 s) Prometheus answer
      expect(elapsed).toBeGreaterThanOrEqual(1500);
      expect(elapsed).toBeLessThan(6000);
    });

    it('does not query a failing Prometheus again while the breaker is open', async () => {
      const failing = new MockPrometheusClient();
      const query = vi.spyOn(failing, 'query').mockRejectedValue(outage());
      app.maasClients!.prometheus = failing;

      const first = await budget();
      expect(first.statusCode).toBe(200);
      expect(JSON.parse(first.body).maasSpend).toBeUndefined();
      const calls = query.mock.calls.length;
      expect(calls).toBeGreaterThan(0);

      const second = await budget();
      expect(second.statusCode).toBe(200);
      expect(JSON.parse(second.body).maasSpend).toBeUndefined();
      expect(query.mock.calls.length).toBe(calls); // answered by the breaker
    });

    it('still reports the MaaS estimate when Prometheus answers in time', async () => {
      app.maasClients!.prometheus = promWith(1_000_000, 10);
      const body = JSON.parse((await budget()).body);
      expect(body.maasTokens).toBeGreaterThanOrEqual(1_000_000);
      expect(body.maasSpend).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------- key filters

  describe('MaaS keys in the usage API key filters', () => {
    beforeEach(() => {
      // no daily_usage_cache reads or writes: the days are rebuilt from the mocks
      vi.spyOn(DailyUsageCacheManager.prototype, 'getCachedDailyData').mockResolvedValue(null);
      vi.spyOn(DailyUsageCacheManager.prototype, 'saveToDailyCache').mockResolvedValue(undefined);
      app.maasClients!.prometheus = promWith(2000, 20);
    });

    const post = (url: string, payload: object, auth = user()) =>
      app.inject({
        method: 'POST',
        url,
        headers: { authorization: auth, 'content-type': 'application/json' },
        payload,
      });

    it('lets a user filter their analytics by a MaaS key, identified by its subscription name', async () => {
      const res = await post('/api/v1/usage/analytics', {
        startDate: yesterday,
        endDate: yesterday,
        apiKeyIds: [SUB],
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.totalRequests).toBe(20);
      expect(body.totalTokens.total).toBe(2000);
    });

    it("refuses another user's MaaS key and unknown ids", async () => {
      for (const apiKeyIds of [[OTHER_SUB], [SUB, OTHER_SUB], ['no-such-key']]) {
        const res = await post('/api/v1/usage/analytics', {
          startDate: yesterday,
          endDate: yesterday,
          apiKeyIds,
        });
        expect(res.statusCode).toBe(403);
        expect(JSON.parse(res.body).code).toBe('FORBIDDEN_API_KEYS');
      }
    });

    it('applies the same ownership rule to the export', async () => {
      const ok = await post('/api/v1/usage/export', {
        startDate: yesterday,
        endDate: yesterday,
        format: 'json',
        apiKeyIds: [SUB],
      });
      expect(ok.statusCode).toBe(200);

      const denied = await post('/api/v1/usage/export', {
        startDate: yesterday,
        endDate: yesterday,
        format: 'json',
        apiKeyIds: [OTHER_SUB],
      });
      expect(denied.statusCode).toBe(403);
    });

    it('lists MaaS keys with their subscription name as key alias in the admin filter options', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/api-keys?userIds=${TEST_USER_IDS.USER}`,
        headers: { authorization: admin() },
      });
      expect(res.statusCode).toBe(200);
      const { apiKeys } = JSON.parse(res.body);
      expect(apiKeys).toHaveLength(1);
      // used to be the string "null"
      expect(apiKeys[0]).toMatchObject({ id: KEY_ID, keyAlias: SUB });
    });

    it('exposes the subscription name as the key alias of a MaaS key in the key list', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/api-keys',
        headers: { authorization: user() },
      });
      expect(res.statusCode).toBe(200);
      const key = JSON.parse(res.body).data.find((k: any) => k.id === KEY_ID);
      expect(key).toBeDefined();
      expect(key.liteLLMKeyAlias).toBe(SUB);
    });
  });

  // ------------------------------------------------------------ provider names

  describe('provider attribution', () => {
    it('reports MaaS models under the maas provider in the model and provider breakdowns', async () => {
      app.maasClients!.prometheus = promWith(1000, 7);
      const stats = new AdminUsageStatsService(app, liteLLM(0), {
        getCachedDailyData: vi.fn().mockResolvedValue(null),
        saveToDailyCache: vi.fn().mockResolvedValue(undefined),
      } as any);
      const range = { startDate: yesterday, endDate: yesterday };

      const models = (await stats.getModelBreakdown(range)).data;
      expect(models.find((m) => m.modelId === MAAS_MODEL)?.provider).toBe('maas');

      const providers = (await stats.getProviderBreakdown(range)).data;
      const maas = providers.find((p) => p.provider === 'maas');
      expect(maas?.metrics.models).toBe(1);
      expect(maas?.topModels[0]?.modelId).toBe(MAAS_MODEL);

      const options = await stats.getFilterOptions(range);
      expect(options.models.find((m) => m.id === MAAS_MODEL)?.provider).toBe('maas');
    });
  });

  // -------------------------------------------------------------------- resync

  describe('usage resync against the real cache table', () => {
    async function seedCachedRow(date: string, raw: LiteLLMDayData) {
      await app.dbUtils.query(
        `INSERT INTO daily_usage_cache (date, raw_data, aggregated_by_user, aggregated_by_model,
           aggregated_by_provider, total_metrics, is_complete)
         VALUES ($1, $2, '{}', '{}', '{}', '{}', true)
         ON CONFLICT (date) DO UPDATE SET raw_data = EXCLUDED.raw_data, is_complete = true`,
        [date, JSON.stringify(raw)],
      );
    }

    const cachedRow = (date: string) =>
      app.dbUtils.queryOne<any>(
        `SELECT raw_data, aggregated_by_user, aggregated_by_provider, is_complete
           FROM daily_usage_cache WHERE date = $1`,
        [date],
      );

    it('keeps the MaaS usage of a day older than the Prometheus retention, attributed to its owner', async () => {
      await seedCachedRow(OLD_DAY, cachedMaasDay(OLD_DAY, 4000, 40));
      const query = vi.fn(() => {
        throw new Error('Prometheus must not be asked about a day it no longer holds');
      });
      app.maasClients!.prometheus = new MockPrometheusClient({ query });
      const stats = new AdminUsageStatsService(app, liteLLM(3), new DailyUsageCacheManager(app));

      const result = await stats.resyncDateRange(OLD_DAY, OLD_DAY);

      expect(result).toMatchObject({ daysProcessed: 1, daysTotal: 1 });
      expect(query).not.toHaveBeenCalled();
      const row = await cachedRow(OLD_DAY);
      expect(row.is_complete).toBe(true);
      const key = row.raw_data.breakdown.models[MAAS_MODEL].api_keys[`maas:${SUB}`];
      expect(key.metrics).toMatchObject({ api_requests: 40, total_tokens: 4000 });
      expect(row.raw_data.sources.maas.tokenSplitAvailable).toBe(false);
      expect(row.aggregated_by_provider.maas.metrics.total_tokens).toBe(4000);
      expect(row.aggregated_by_user[TEST_USER_IDS.USER].metrics.total_tokens).toBe(4000);
    });

    it('re-queries a day Prometheus still holds, replacing the cached MaaS usage', async () => {
      await seedCachedRow(RECENT_DAY, cachedMaasDay(RECENT_DAY, 1000, 10));
      app.maasClients!.prometheus = promWith(2500, 25);
      const stats = new AdminUsageStatsService(app, liteLLM(3), new DailyUsageCacheManager(app));

      await stats.resyncDateRange(RECENT_DAY, RECENT_DAY);

      const row = await cachedRow(RECENT_DAY);
      expect(row.is_complete).toBe(true);
      expect(
        row.raw_data.breakdown.models[MAAS_MODEL].api_keys[`maas:${SUB}`].metrics.total_tokens,
      ).toBe(2500); // fresh value, not 3500
    });

    it('stores a day as incomplete when Prometheus is down, so it is retried instead of frozen', async () => {
      await seedCachedRow(RECENT_DAY, cachedMaasDay(RECENT_DAY, 1000, 10));
      app.maasClients!.prometheus = new MockPrometheusClient({
        query: () => {
          throw outage();
        },
      });
      const stats = new AdminUsageStatsService(app, liteLLM(3), new DailyUsageCacheManager(app));

      const result = await stats.resyncDateRange(RECENT_DAY, RECENT_DAY);

      expect(result.daysProcessed).toBe(1);
      const row = await cachedRow(RECENT_DAY);
      expect(row.is_complete).toBe(false);
      // the usage the row had is not lost meanwhile
      expect(
        row.raw_data.breakdown.models[MAAS_MODEL].api_keys[`maas:${SUB}`].metrics.total_tokens,
      ).toBe(1000);
    });
  });
});
