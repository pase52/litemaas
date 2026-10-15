/**
 * MaaS-specific behavior of the admin usage pipeline that does not need a database:
 *  - usage resync must not wipe MaaS usage that Prometheus can no longer provide
 *  - refreshSingleDay never freezes a day whose MaaS query failed as a complete historical row
 *  - UTC-day completeness for MaaS (server timezone must not decide it)
 *  - MaaS model ids are reported under the `maas` provider
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { AdminUsageStatsService } from '../../../src/services/admin-usage-stats.service';
import { AdminUsageAggregationService } from '../../../src/services/admin-usage/admin-usage-aggregation.service';
import { setMaasModelIds } from '../../../src/services/admin-usage/admin-usage.utils';
import { ApplicationError } from '../../../src/utils/errors';
import type { EnrichedDayData, LiteLLMDayData } from '../../../src/types/admin-usage.types';
import { initTestConfig } from '../../helpers/test-config';

const MAAS_MODEL = 'ns/llama';
const KEY_HASH = 'maas:litemaas-key-a';

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

const metrics = (requests: number, tokens: number, spend = 0) => ({
  api_requests: requests,
  total_tokens: tokens,
  prompt_tokens: tokens,
  completion_tokens: 0,
  spend,
});

/** A day as MaasUsageSource.getDayData produces it */
function maasDay(date: string, tokens = 1000, calls = 10): LiteLLMDayData {
  const keyMetrics = {
    ...metrics(calls, tokens, tokens * 2e-6),
    successful_requests: calls,
    failed_requests: 0,
  };
  return {
    date,
    metrics: { ...keyMetrics },
    breakdown: {
      models: {
        [MAAS_MODEL]: {
          metrics: metrics(calls, tokens, tokens * 2e-6),
          api_keys: {
            [KEY_HASH]: { metadata: { key_alias: 'litemaas-key-a' }, metrics: keyMetrics },
          },
        },
      },
      api_keys: {},
      providers: { maas: { metrics: metrics(calls, tokens, tokens * 2e-6) } },
    },
    sources: { maas: { tokenSplitAvailable: false, costEstimated: true } },
  };
}

/** LiteLLM's /user/daily/activity answer for `requests` requests on one model */
const liteLLMResponse = (requests: number) => ({
  api_requests: requests,
  total_tokens: requests * 10,
  prompt_tokens: requests * 6,
  completion_tokens: requests * 4,
  spend: requests * 0.01,
  daily_metrics: [
    {
      breakdown: {
        models: {
          'gpt-4': {
            metrics: {
              api_requests: requests,
              total_tokens: requests * 10,
              prompt_tokens: requests * 6,
              completion_tokens: requests * 4,
              spend: requests * 0.01,
            },
            api_key_breakdown: {},
          },
        },
      },
    },
  ],
});

interface Harness {
  fastify: any;
  liteLLM: any;
  cache: any;
  usage: {
    getDayData: ReturnType<typeof vi.fn>;
    clearCache: ReturnType<typeof vi.fn>;
    syncModelProviders: ReturnType<typeof vi.fn>;
  };
  /** raw_data of the rows currently "in" daily_usage_cache, by date */
  cachedRaw: Record<string, LiteLLMDayData>;
  snapshotQueries: () => Array<[string, unknown[]]>;
  stats: AdminUsageStatsService;
  aggregation: AdminUsageAggregationService;
  saved: () => Array<{ date: string; data: EnrichedDayData; isCurrentDay: boolean }>;
}

function harness(
  options: { maas?: boolean; liteLLMRequests?: number; retentionDays?: number } = {},
): Harness {
  const { maas = true, liteLLMRequests = 5, retentionDays = 15 } = options;
  const cachedRaw: Record<string, LiteLLMDayData> = {};
  const usage = {
    getDayData: vi.fn(async (_date: string): Promise<LiteLLMDayData | null> => null),
    clearCache: vi.fn(),
    syncModelProviders: vi.fn(async () => undefined),
  };
  const fastify: any = {
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    pg: {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        if (sql.includes('FROM daily_usage_cache')) {
          // the real query only returns rows whose raw_data carries the sources.maas flag
          const raw = cachedRaw[params[0] as string];
          return { rows: raw?.sources?.maas ? [{ raw_data: raw }] : [] };
        }
        return { rows: [] }; // API key -> user mapping: nothing is mapped
      }),
    },
  };
  if (maas) {
    // a plain object is not the "unconfigured Prometheus" placeholder
    fastify.maasClients = { config: { usageRetentionDays: retentionDays }, prometheus: {} };
    fastify.backends = { has: (type: string) => type === 'maas', get: () => ({ usage }) };
  }
  const liteLLM: any = {
    getDailyActivity: vi.fn(async () => liteLLMResponse(liteLLMRequests)),
    clearActivityCache: vi.fn(),
  };
  const cache: any = {
    getCachedDailyData: vi.fn().mockResolvedValue(null),
    saveToDailyCache: vi.fn().mockResolvedValue(undefined),
    invalidateTodayCache: vi.fn().mockResolvedValue(undefined),
    deleteDateRange: vi.fn().mockResolvedValue(0),
    getDateRangeData: vi.fn(),
    cleanupOldCache: vi.fn(),
  };
  return {
    fastify,
    liteLLM,
    cache,
    usage,
    cachedRaw,
    snapshotQueries: () =>
      fastify.pg.query.mock.calls.filter((c: unknown[]) =>
        String(c[0]).includes('FROM daily_usage_cache'),
      ),
    stats: new AdminUsageStatsService(fastify, liteLLM, cache),
    aggregation: new AdminUsageAggregationService(fastify, liteLLM, cache),
    saved: () =>
      cache.saveToDailyCache.mock.calls.map((c: [string, EnrichedDayData, boolean]) => ({
        date: c[0],
        data: c[1],
        isCurrentDay: c[2],
      })),
  };
}

const maasKey = (data: EnrichedDayData, model = MAAS_MODEL) =>
  (data.rawData as LiteLLMDayData).breakdown.models[model]?.api_keys[KEY_HASH];

describe('MaaS usage in the admin usage pipeline', () => {
  let configCleanup: () => void;
  beforeAll(() => {
    configCleanup = initTestConfig().cleanup;
  });
  afterAll(() => configCleanup());
  afterEach(() => {
    vi.useRealTimers();
    setMaasModelIds([]);
  });

  describe('resyncDateRange', () => {
    it('carries the cached MaaS usage of a day older than the Prometheus retention forward without asking Prometheus', async () => {
      const h = harness();
      const old = daysAgo(40);
      h.cachedRaw[old] = maasDay(old, 4000, 40);

      const result = await h.stats.resyncDateRange(old, old);

      expect(result).toMatchObject({ daysProcessed: 1, daysTotal: 1 });
      expect(h.usage.getDayData).not.toHaveBeenCalled();
      const [row] = h.saved();
      // LiteLLM was re-imported ...
      expect(
        (row.data.rawData as LiteLLMDayData).breakdown.models['gpt-4'].metrics.api_requests,
      ).toBe(5);
      // ... and the MaaS usage that only the cache still had survives
      expect(maasKey(row.data)?.metrics).toMatchObject({ api_requests: 40, total_tokens: 4000 });
      expect((row.data.rawData as LiteLLMDayData).sources?.maas).toEqual({
        tokenSplitAvailable: false,
        costEstimated: true,
      });
      expect(row.data.breakdown.providers.maas.metrics.total_tokens).toBe(4000);
      // nothing failed, so the row is a normal complete historical day
      expect(row.isCurrentDay).toBe(false);
    });

    it('reads the cached rows BEFORE it deletes them', async () => {
      const h = harness();
      const old = daysAgo(40);
      h.cachedRaw[old] = maasDay(old);

      await h.stats.resyncDateRange(old, old);

      const queries = h.snapshotQueries();
      expect(queries).toHaveLength(1);
      expect(queries[0][0]).toContain(`'sources' ? 'maas'`);
      expect(queries[0][1]).toEqual([old]);
      const readOrder =
        h.fastify.pg.query.mock.invocationCallOrder[
          h.fastify.pg.query.mock.calls.findIndex((c: unknown[]) =>
            String(c[0]).includes('FROM daily_usage_cache'),
          )
        ];
      expect(readOrder).toBeLessThan(h.cache.deleteDateRange.mock.invocationCallOrder[0]);
      expect(h.cache.deleteDateRange).toHaveBeenCalledWith(old, old);
    });

    it('uses the fresh MaaS usage of a day Prometheus still has and ignores the cached slice', async () => {
      const h = harness();
      const recent = daysAgo(3);
      h.cachedRaw[recent] = maasDay(recent, 1000, 10);
      h.usage.getDayData.mockResolvedValue(maasDay(recent, 2500, 25));

      await h.stats.resyncDateRange(recent, recent);

      expect(h.usage.getDayData).toHaveBeenCalledWith(recent);
      const [row] = h.saved();
      expect(maasKey(row.data)?.metrics).toMatchObject({ api_requests: 25, total_tokens: 2500 }); // not 3500
      expect(row.isCurrentDay).toBe(false);
    });

    it('carries the cached slice forward when Prometheus has the day but returns nothing for it', async () => {
      const h = harness();
      const recent = daysAgo(3);
      h.cachedRaw[recent] = maasDay(recent, 1000, 10);
      h.usage.getDayData.mockResolvedValue(null);

      await h.stats.resyncDateRange(recent, recent);

      const [row] = h.saved();
      expect(maasKey(row.data)?.metrics).toMatchObject({ api_requests: 10, total_tokens: 1000 });
      expect(row.isCurrentDay).toBe(false);
    });

    it('carries the slice forward when the MaaS query fails, but stores the day as incomplete', async () => {
      const h = harness();
      const recent = daysAgo(3);
      h.cachedRaw[recent] = maasDay(recent, 1000, 10);
      h.usage.getDayData.mockRejectedValue(
        ApplicationError.maasError('down', undefined, 'x', true),
      );

      const result = await h.stats.resyncDateRange(recent, recent);

      expect(result.daysProcessed).toBe(1);
      const [row] = h.saved();
      expect(maasKey(row.data)?.metrics.total_tokens).toBe(1000);
      // not frozen as a permanent historical row: re-fetched after the cache TTL
      expect(row.isCurrentDay).toBe(true);
    });

    it('keeps a MaaS-only day that LiteLLM has no requests for', async () => {
      const h = harness({ liteLLMRequests: 0 });
      const old = daysAgo(40);
      h.cachedRaw[old] = maasDay(old, 4000, 40);

      const result = await h.stats.resyncDateRange(old, old);

      expect(result.daysProcessed).toBe(1);
      const [row] = h.saved();
      expect(maasKey(row.data)?.metrics.total_tokens).toBe(4000);
    });

    it('handles a mixed range: old days carried forward, recent days re-queried, uncached days left alone', async () => {
      const h = harness();
      const old = daysAgo(40);
      const oldNoMaas = daysAgo(41);
      const recent = daysAgo(2);
      h.cachedRaw[old] = maasDay(old, 4000, 40);
      h.usage.getDayData.mockImplementation(async (date: string) =>
        date === recent ? maasDay(recent, 700, 7) : null,
      );

      // three separate single-day resyncs keep the date arithmetic independent of the timezone
      for (const d of [oldNoMaas, old, recent]) await h.stats.resyncDateRange(d, d);

      const byDate = Object.fromEntries(h.saved().map((r) => [r.date, r.data]));
      expect(maasKey(byDate[old])?.metrics.total_tokens).toBe(4000);
      expect(maasKey(byDate[oldNoMaas])).toBeUndefined(); // nothing cached, nothing invented
      expect(maasKey(byDate[recent])?.metrics.total_tokens).toBe(700);
      expect(h.usage.getDayData.mock.calls.map((c) => c[0])).toEqual([recent]);
    });

    it('does not touch the cache table or MaaS at all when MaaS is disabled', async () => {
      const h = harness({ maas: false });
      const old = daysAgo(40);

      const result = await h.stats.resyncDateRange(old, old);

      expect(result.daysProcessed).toBe(1);
      expect(h.snapshotQueries()).toHaveLength(0);
      const [row] = h.saved();
      expect(row.isCurrentDay).toBe(false);
      expect(maasKey(row.data)).toBeUndefined();
    });

    it('clears the MaaS usage source cache (and breaker) like refreshTodayData does', async () => {
      const h = harness();
      const old = daysAgo(40);

      await h.stats.resyncDateRange(old, old);
      expect(h.usage.clearCache).toHaveBeenCalledTimes(1);
      expect(h.liteLLM.clearActivityCache).toHaveBeenCalledTimes(1);

      await h.stats.refreshTodayData();
      expect(h.usage.clearCache).toHaveBeenCalledTimes(2);
    });

    it('aborts before deleting anything when the cached MaaS usage cannot be read', async () => {
      const h = harness();
      const old = daysAgo(40);
      h.fastify.pg.query.mockRejectedValue(new Error('connection lost'));

      await expect(h.stats.resyncDateRange(old, old)).rejects.toBeTruthy();

      expect(h.cache.deleteDateRange).not.toHaveBeenCalled();
      expect(h.cache.saveToDailyCache).not.toHaveBeenCalled();
    });
  });

  describe('refreshSingleDay when the MaaS query fails', () => {
    const failing = () =>
      ApplicationError.maasError('Failed to reach Prometheus', undefined, 'x', true);

    it('does not store a past day as complete', async () => {
      const h = harness();
      const past = daysAgo(3);
      h.usage.getDayData.mockRejectedValue(failing());

      const data = await h.aggregation.refreshSingleDay(past);

      expect((data.rawData as LiteLLMDayData).sources).toBeUndefined(); // LiteLLM data only
      const [row] = h.saved();
      expect(row.isCurrentDay).toBe(true); // is_complete = false: retried after the TTL
      expect(h.fastify.log.warn).toHaveBeenCalledWith(
        { date: past },
        expect.stringContaining('stored as incomplete'),
      );
    });

    it('stores a past day as complete when MaaS succeeded or returned nothing', async () => {
      const h = harness();
      const past = daysAgo(3);

      h.usage.getDayData.mockResolvedValue(maasDay(past));
      await h.aggregation.refreshSingleDay(past);
      h.usage.getDayData.mockResolvedValue(null);
      await h.aggregation.refreshSingleDay(past);

      expect(h.saved().map((r) => r.isCurrentDay)).toEqual([false, false]);
    });

    it('keeps today incomplete either way, and LiteLLM-only behavior unchanged without MaaS', async () => {
      const h = harness();
      await h.aggregation.refreshSingleDay(daysAgo(0));
      expect(h.saved()[0].isCurrentDay).toBe(true);

      const plain = harness({ maas: false });
      await plain.aggregation.refreshSingleDay(daysAgo(3));
      await plain.aggregation.refreshSingleDay(daysAgo(0));
      expect(plain.saved().map((r) => r.isCurrentDay)).toEqual([false, true]);
    });

    it('still throws LiteLLM errors (only MaaS is best-effort)', async () => {
      const h = harness();
      h.liteLLM.getDailyActivity.mockRejectedValue(new Error('litellm down'));
      await expect(h.aggregation.refreshSingleDay(daysAgo(3))).rejects.toBeTruthy();
      expect(h.cache.saveToDailyCache).not.toHaveBeenCalled();
    });
  });

  describe('completeness of a MaaS day follows UTC, not the server timezone', () => {
    const originalTz = process.env.TZ;
    afterEach(() => {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    });

    it('stores a UTC day that is still running as incomplete even when the server timezone is already one day ahead', async () => {
      // 2025-03-09T22:00Z is still March 9 in UTC but already March 10 in Sydney
      process.env.TZ = 'Australia/Sydney';
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2025-03-09T22:00:00Z'));
      const day = '2025-03-09';

      const withMaas = harness();
      withMaas.usage.getDayData.mockResolvedValue(maasDay(day));
      await withMaas.aggregation.collectDateRangeData(day, day); // getCachedOrFetch
      await withMaas.aggregation.refreshSingleDay(day);
      expect(withMaas.saved().map((r) => r.isCurrentDay)).toEqual([true, true]);

      // LiteLLM-only: exactly as before (the server-timezone isToday decides)
      const litellmOnly = harness({ maas: false });
      await litellmOnly.aggregation.collectDateRangeData(day, day);
      await litellmOnly.aggregation.refreshSingleDay(day);
      expect(litellmOnly.saved().map((r) => r.isCurrentDay)).toEqual([false, false]);
    });

    it('serves a fresh cached row of the UTC day even when the server timezone is still on the previous date', async () => {
      // 2025-03-10T04:00Z is March 10 in UTC but still the evening of March 9 in Los Angeles
      process.env.TZ = 'America/Los_Angeles';
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2025-03-10T04:00:00Z'));
      const day = '2025-03-10';
      const cached = {
        date: day,
        metrics: metrics(3, 30),
        breakdown: { models: {}, providers: {}, users: {} },
        rawData: {},
      };

      const withMaas = harness();
      withMaas.cache.getCachedDailyData.mockResolvedValue(cached);
      const days = await withMaas.aggregation.collectDateRangeData(day, day);
      expect(days).toEqual([cached]);
      expect(withMaas.liteLLM.getDailyActivity).not.toHaveBeenCalled();

      // LiteLLM-only: unchanged, the cached row is not trusted for a "future" local date
      const litellmOnly = harness({ maas: false });
      litellmOnly.cache.getCachedDailyData.mockResolvedValue(cached);
      await litellmOnly.aggregation.collectDateRangeData(day, day);
      expect(litellmOnly.liteLLM.getDailyActivity).toHaveBeenCalled();
    });
  });

  describe('provider attribution', () => {
    it('reports MaaS model ids under the maas provider once the models are loaded, LiteLLM names untouched', async () => {
      const h = harness();
      const day = daysAgo(3);
      const merged = (
        await (async () => {
          h.usage.getDayData.mockResolvedValue(maasDay(day, 900, 9));
          return h.aggregation.collectDateRangeData(day, day);
        })()
      )[0];
      expect(merged.breakdown.models[MAAS_MODEL]).toBeDefined();
      expect(merged.breakdown.models['gpt-4']).toBeDefined();

      // as the usage source does when it loads the MaaS models
      h.usage.syncModelProviders.mockImplementation(async () => setMaasModelIds([MAAS_MODEL]));

      const models = (await h.stats.getModelBreakdown({ startDate: day, endDate: day })).data;
      const byId = Object.fromEntries(models.map((m) => [m.modelId, m]));
      expect(byId[MAAS_MODEL].provider).toBe('maas');
      expect(byId['gpt-4'].provider).toBe('openai');
      expect(h.usage.syncModelProviders).toHaveBeenCalled();

      const providers = (await h.stats.getProviderBreakdown({ startDate: day, endDate: day })).data;
      const maasProvider = providers.find((p) => p.provider === 'maas');
      expect(maasProvider?.metrics.models).toBe(1);
      expect(maasProvider?.topModels.map((m) => m.modelId)).toEqual([MAAS_MODEL]);

      const options = await h.stats.getFilterOptions({ startDate: day, endDate: day });
      expect(options.models.find((m) => m.id === MAAS_MODEL)?.provider).toBe('maas');
    });

    it('falls back to the id prefix, without failing the request, when the models cannot be loaded', async () => {
      const h = harness();
      const day = daysAgo(3);
      h.usage.getDayData.mockResolvedValue(maasDay(day, 900, 9));
      h.usage.syncModelProviders.mockRejectedValue(new Error('db down'));

      const models = (await h.stats.getModelBreakdown({ startDate: day, endDate: day })).data;
      expect(models.find((m) => m.modelId === MAAS_MODEL)?.provider).toBe('ns');
      expect(h.fastify.log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'db down' }),
        expect.stringContaining('provider attribution'),
      );
    });

    it('does not look for MaaS models when MaaS is disabled', async () => {
      const h = harness({ maas: false });
      const day = daysAgo(3);
      const models = (await h.stats.getModelBreakdown({ startDate: day, endDate: day })).data;
      expect(models.map((m) => m.provider)).toEqual(['openai']);
      expect(h.usage.syncModelProviders).not.toHaveBeenCalled();
    });
  });

  beforeEach(() => setMaasModelIds([]));
});
