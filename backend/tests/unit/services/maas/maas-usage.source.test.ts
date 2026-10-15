import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  MaasUsageSource,
  PROMETHEUS_BREAKER_COOLDOWN_MS,
  dayWindow,
  extractMaasSlice,
  isWithinUsageRetention,
  mergeDayData,
  stripNamespace,
} from '../../../../src/services/maas/maas-usage.source';
import { MockPrometheusClient } from '../../../../src/services/maas/prometheus.client';
import {
  extractProviderFromModel,
  setMaasModelIds,
} from '../../../../src/services/admin-usage/admin-usage.utils';
import { ApplicationError } from '../../../../src/utils/errors';
import type { LiteLLMDayData } from '../../../../src/types/admin-usage.types';

const MODELS = [
  {
    id: 'ns/llama',
    name: 'Llama',
    backend_model_name: 'llama',
    maas_model_ref_name: 'llama',
    maas_model_ref_namespace: 'ns',
    input_cost_per_token: '0.000001',
    output_cost_per_token: '0.000003',
  },
  {
    id: 'ns/granite',
    name: 'Granite',
    backend_model_name: 'granite-served',
    maas_model_ref_name: 'granite',
    maas_model_ref_namespace: 'ns',
    input_cost_per_token: null,
    output_cost_per_token: '0.000004',
  },
];

function sample(subscription: string, model: string | undefined, value: number) {
  return {
    metric: { subscription, ...(model ? { model } : {}) },
    value: [0, String(value)] as [number, string],
  };
}

function setup(
  responder: (promql: string, time?: unknown) => ReturnType<typeof sample>[],
  config: Record<string, unknown> = {},
  models: typeof MODELS = MODELS,
) {
  const queries: Array<{ promql: string; time?: unknown }> = [];
  const prometheus = new MockPrometheusClient();
  prometheus.query = vi.fn(async (promql: string, time?: Date | number) => {
    queries.push({ promql, time });
    return responder(promql, time);
  });
  const fastify: any = {
    dbUtils: {
      queryMany: vi.fn().mockImplementation(async (sql: string) => {
        if (sql.includes('FROM models')) return models;
        return [{ maas_subscription_name: 'litemaas-key-1' }];
      }),
    },
    log: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
  };
  const clients: any = {
    prometheus,
    config: {
      usageHitsMetric: 'authorized_hits',
      usageCallsMetric: 'authorized_calls',
      ...config,
    },
  };
  return { source: new MaasUsageSource(fastify, clients), queries, fastify, prometheus };
}

describe('dayWindow', () => {
  const now = new Date('2025-03-10T15:30:00Z');

  it('uses end-of-day evaluation and a 24h window for past days', () => {
    const w = dayWindow('2025-03-09', now)!;
    expect(w.evalTime.toISOString()).toBe('2025-03-10T00:00:00.000Z');
    expect(w.windowSeconds).toBe(86_400);
    expect(w.partial).toBe(false);
  });

  it('evaluates today now with the elapsed seconds since 00:00Z', () => {
    const w = dayWindow('2025-03-10', now)!;
    expect(w.evalTime.getTime()).toBe(now.getTime());
    expect(w.windowSeconds).toBe(15 * 3600 + 30 * 60);
    expect(w.partial).toBe(true);
  });

  it('keeps at least 60s right after midnight and rejects future / invalid days', () => {
    const w = dayWindow('2025-03-10', new Date('2025-03-10T00:00:05Z'))!;
    expect(w.windowSeconds).toBe(60);
    expect(dayWindow('2025-03-11', now)).toBeNull();
    expect(dayWindow('garbage', now)).toBeNull();
  });
});

describe('MaasUsageSource.getDayData', () => {
  const now = () => new Date();
  const pastDay = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);

  it('issues one increase() query per metric at end of day, grouped by subscription and model', async () => {
    const { source, queries } = setup(() => []);
    await source.getDayData(pastDay);
    expect(queries).toHaveLength(2);
    expect(queries[0].promql).toBe(
      'sum by (subscription, model) (increase(authorized_hits{subscription=~"(.*/)?litemaas-key-.+"}[86400s]))',
    );
    expect(queries[1].promql).toContain('increase(authorized_calls{');
    const end = Date.parse(`${pastDay}T00:00:00Z`) + 86_400_000;
    expect((queries[0].time as Date).getTime()).toBe(end);
  });

  it('applies configured metric names and extra label matchers', async () => {
    const { source, queries } = setup(() => [], {
      usageHitsMetric: 'limitador_authorized_hits',
      usageCallsMetric: 'limitador_authorized_calls',
      usageLabelMatchers: 'namespace="kuadrant-system"',
    });
    await source.getDayData(pastDay);
    expect(queries[0].promql).toContain('limitador_authorized_hits{');
    expect(queries[0].promql).toContain(',namespace="kuadrant-system"}');
    expect(queries[1].promql).toContain('limitador_authorized_calls{');
  });

  it('returns null when nothing was recorded and for future days (no query)', async () => {
    const { source, queries } = setup(() => []);
    expect(await source.getDayData(pastDay)).toBeNull();
    queries.length = 0;
    const future = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    expect(await source.getDayData(future)).toBeNull();
    expect(queries).toHaveLength(0);
  });

  it('maps subscription -> synthetic key hash, model label -> LiteMaaS id, tokens x blended price', async () => {
    const { source } = setup((promql) =>
      promql.includes('authorized_hits')
        ? [
            sample('litemaas-key-a', 'llama', 1000),
            sample('models-as-a-service/litemaas-key-b', 'ns/llama', 500.4),
            sample('litemaas-key-a', 'granite-served', 200),
            sample('litemaas-key-a', 'mystery', 50),
          ]
        : [
            sample('litemaas-key-a', 'llama', 10),
            sample('models-as-a-service/litemaas-key-b', 'ns/llama', 5),
            sample('litemaas-key-a', 'granite-served', 2),
            sample('litemaas-key-a', 'mystery', 1),
          ],
    );
    const day = (await source.getDayData(pastDay))!;

    // blended llama = (1e-6 + 3e-6) / 2 = 2e-6 ; granite only has output price 4e-6
    expect(day.breakdown.models['ns/llama'].metrics).toMatchObject({
      api_requests: 15,
      total_tokens: 1500,
      // total-only source: tokens are carried in prompt_tokens, completion stays 0
      prompt_tokens: 1500,
      completion_tokens: 0,
    });
    expect(day.breakdown.models['ns/llama'].metrics.spend).toBeCloseTo(1500 * 2e-6, 10);
    expect(day.breakdown.models['ns/granite'].metrics.spend).toBeCloseTo(200 * 4e-6, 10);
    // unresolved labels are kept and cost nothing
    expect(day.breakdown.models['mystery'].metrics).toMatchObject({
      total_tokens: 50,
      spend: 0,
    });

    const keys = day.breakdown.models['ns/llama'].api_keys;
    expect(Object.keys(keys).sort()).toEqual(['maas:litemaas-key-a', 'maas:litemaas-key-b']);
    expect(keys['maas:litemaas-key-b'].metrics.total_tokens).toBe(500);
    expect(keys['maas:litemaas-key-a'].metadata?.key_alias).toBe('litemaas-key-a');
    expect(keys['maas:litemaas-key-a'].metrics.successful_requests).toBe(10);

    expect(day.metrics.api_requests).toBe(18);
    expect(day.metrics.total_tokens).toBe(1750);
    expect(day.metrics.successful_requests).toBe(18);
    expect(day.metrics.failed_requests).toBe(0);
    expect(day.sources?.maas).toEqual({ tokenSplitAvailable: false, costEstimated: true });
  });

  it('propagates Prometheus errors to the caller', async () => {
    const { source } = setup(() => {
      throw new Error('thanos down');
    });
    await expect(source.getDayData(pastDay)).rejects.toThrow('thanos down');
  });

  it('caches completed days between calls', async () => {
    const { source, queries } = setup(() => [sample('litemaas-key-a', 'llama', 5)]);
    await source.getDayData(pastDay);
    await source.getDayData(pastDay);
    expect(queries).toHaveLength(2); // second call served from cache
    expect(now()).toBeInstanceOf(Date);
  });
});

describe('MaasUsageSource.unitPrice / resolver', () => {
  it('blends prices, falls back to the only configured one, else 0', () => {
    expect(
      MaasUsageSource.unitPrice({
        input_cost_per_token: '0.000002',
        output_cost_per_token: '0.000006',
      }),
    ).toBeCloseTo(4e-6, 12);
    expect(
      MaasUsageSource.unitPrice({ input_cost_per_token: 0.5, output_cost_per_token: null }),
    ).toBe(0.5);
    expect(
      MaasUsageSource.unitPrice({ input_cost_per_token: null, output_cost_per_token: null }),
    ).toBe(0);
  });

  it('resolves case-insensitively by id, ns/ref, ref name and served name', () => {
    const resolve = MaasUsageSource.buildResolver(MODELS);
    expect(resolve('NS/LLAMA').id).toBe('ns/llama');
    expect(resolve('llama').id).toBe('ns/llama');
    expect(resolve('Granite-Served').id).toBe('ns/granite');
    expect(resolve('other-ns/granite').id).toBe('ns/granite');
    expect(resolve('nope')).toEqual({ id: 'nope', unitPrice: 0, resolved: false });
  });
});

describe('MaasUsageSource.getUsageSummary', () => {
  it('filters by subscription names, sums per model and per day, caps nothing for small ranges', async () => {
    const { source, queries } = setup((promql) =>
      promql.includes('authorized_hits')
        ? [sample('litemaas-key-1', 'llama', 100)]
        : [sample('litemaas-key-1', 'llama', 4)],
    );
    const start = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
    const end = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
    const summary = await source.getUsageSummary(['litemaas-key-1'], start, end);

    expect(queries[0].promql).toContain('subscription=~"(.*/)?(litemaas-key-1)"');
    expect(summary.daily.map((d) => d.date)).toEqual([start, end]);
    expect(summary.totalRequests).toBe(8);
    expect(summary.totalTokens).toBe(200);
    expect(summary.totalCost).toBeCloseTo(200 * 2e-6, 10);
    expect(summary.byModel).toEqual([
      expect.objectContaining({ modelId: 'ns/llama', requests: 8, tokens: 200 }),
    ]);
    expect(summary.tokenSplitAvailable).toBe(false);
  });

  it('returns an empty summary without querying when there are no subscriptions', async () => {
    const { source, queries } = setup(() => []);
    const summary = await source.getUsageSummary([], '2025-01-01', '2025-01-02');
    expect(summary.totalTokens).toBe(0);
    expect(queries).toHaveLength(0);
  });

  it('caps ranges at the most recent 120 days', () => {
    const dates = MaasUsageSource.listDates('2024-01-01', '2025-01-01');
    expect(dates).toHaveLength(120);
    expect(dates[dates.length - 1]).toBe('2025-01-01');
    expect(MaasUsageSource.listDates('2025-01-02', '2025-01-01')).toEqual([]);
  });

  it('reports a single maas provider whose totals equal the day totals', async () => {
    const { source } = setup((promql) =>
      promql.includes('authorized_hits')
        ? [sample('ns/litemaas-key-1', 'llama', 500), sample('ns/litemaas-key-2', 'granite', 100)]
        : [sample('ns/litemaas-key-1', 'llama', 5), sample('ns/litemaas-key-2', 'granite', 2)],
    );
    const pastDay = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
    const day = await source.getDayData(pastDay);
    const prov = day!.breakdown.providers['maas'].metrics;
    expect(prov.api_requests).toBe(day!.metrics.api_requests);
    expect(prov.total_tokens).toBe(day!.metrics.total_tokens);
    expect(prov.spend).toBeCloseTo(day!.metrics.spend);
  });

  it('looks up the subscriptions of a user', async () => {
    const { source } = setup(() => []);
    expect(await source.subscriptionsForUser('u1')).toEqual(['litemaas-key-1']);
  });
});

describe('mergeDayData / stripNamespace', () => {
  const metrics = (r: number, t: number, s: number) => ({
    api_requests: r,
    total_tokens: t,
    prompt_tokens: 0,
    completion_tokens: 0,
    spend: s,
  });
  const day = (models: LiteLLMDayData['breakdown']['models']): LiteLLMDayData => ({
    date: '2025-01-01',
    metrics: { ...metrics(0, 0, 0), successful_requests: 0, failed_requests: 0 },
    breakdown: { models, api_keys: {}, providers: {} },
  });

  it('sums providers present on both sides and keeps the others', () => {
    const a = day({});
    a.breakdown.providers = {
      maas: { metrics: metrics(1, 10, 1) },
      openai: { metrics: metrics(2, 20, 2) },
    };
    const b = day({});
    b.breakdown.providers = { maas: { metrics: metrics(3, 30, 3) } };
    const merged = mergeDayData(a, b)!;
    expect(merged.breakdown.providers.maas.metrics).toMatchObject({
      api_requests: 4,
      total_tokens: 40,
      spend: 4,
    });
    expect(merged.breakdown.providers.openai.metrics.api_requests).toBe(2);
  });

  it('passes through when either side is null', () => {
    const d = day({});
    expect(mergeDayData(null, null)).toBeNull();
    expect(mergeDayData(d, null)).toBe(d);
    expect(mergeDayData(null, d)).toBe(d);
  });

  it('sums totals and models, combines api_keys and keeps the maas data-quality flag', () => {
    const a = day({
      m: { metrics: metrics(2, 20, 1), api_keys: { h1: { metrics: metrics(2, 20, 1) } } },
    });
    a.metrics = {
      ...metrics(2, 20, 1),
      prompt_tokens: 12,
      completion_tokens: 8,
      successful_requests: 2,
      failed_requests: 0,
    };
    const b = day({
      m: { metrics: metrics(1, 10, 2), api_keys: { h2: { metrics: metrics(1, 10, 2) } } },
      n: { metrics: metrics(3, 30, 0), api_keys: {} },
    });
    b.metrics = { ...metrics(4, 40, 2), successful_requests: 4, failed_requests: 0 };
    b.sources = { maas: { tokenSplitAvailable: false, costEstimated: true } };

    const merged = mergeDayData(a, b)!;
    expect(merged.metrics).toMatchObject({
      api_requests: 6,
      total_tokens: 60,
      prompt_tokens: 12,
      spend: 3,
      successful_requests: 6,
    });
    expect(merged.breakdown.models.m.metrics.total_tokens).toBe(30);
    expect(Object.keys(merged.breakdown.models.m.api_keys).sort()).toEqual(['h1', 'h2']);
    expect(merged.breakdown.models.n.metrics.api_requests).toBe(3);
    expect(merged.sources?.maas?.tokenSplitAvailable).toBe(false);
    // inputs are not mutated
    expect(a.breakdown.models.m.metrics.total_tokens).toBe(20);
  });

  it('strips namespace prefixes', () => {
    expect(stripNamespace('ns/litemaas-key-1')).toBe('litemaas-key-1');
    expect(stripNamespace('litemaas-key-1')).toBe('litemaas-key-1');
  });
});

describe('MaasUsageSource Prometheus breaker', () => {
  const pastDay = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
  const otherDay = new Date(Date.now() - 4 * 86_400_000).toISOString().slice(0, 10);
  const outage = () =>
    ApplicationError.maasError('Failed to reach Prometheus', undefined, 'timeout', true);

  afterEach(() => vi.useRealTimers());

  it('opens after a transport failure: later calls rethrow the same error without reaching Prometheus', async () => {
    const failure = outage();
    const { source, prometheus, fastify } = setup(() => {
      throw failure;
    });
    await expect(source.getDayData(pastDay)).rejects.toBe(failure);
    const attempts = vi.mocked(prometheus.query).mock.calls.length;
    expect(attempts).toBe(2);

    // another day, a range summary and a per-user query all fail at once
    await expect(source.getDayData(otherDay)).rejects.toBe(failure);
    await expect(source.getUsageSummary(['litemaas-key-1'], otherDay, pastDay)).rejects.toBe(
      failure,
    );
    expect(prometheus.query).toHaveBeenCalledTimes(attempts);
    // opening is announced once, not for every skipped call
    expect(fastify.log.warn).toHaveBeenCalledTimes(1);
  });

  it('probes Prometheus again once the cooldown is over and closes after a success', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-03-10T12:00:00Z'));
    let down = true;
    const { source, queries } = setup(() => {
      if (down) throw outage();
      return [sample('litemaas-key-1', 'llama', 5)];
    });

    await expect(source.getDayData('2026-03-07')).rejects.toBeTruthy();
    expect(queries).toHaveLength(2);

    vi.setSystemTime(Date.now() + PROMETHEUS_BREAKER_COOLDOWN_MS - 1000);
    await expect(source.getDayData('2026-03-06')).rejects.toBeTruthy();
    expect(queries).toHaveLength(2); // still skipped

    vi.setSystemTime(Date.now() + 2000);
    down = false;
    expect(await source.getDayData('2026-03-06')).not.toBeNull();
    expect(queries).toHaveLength(4); // probed and succeeded

    // closed again: the next day goes straight through
    expect(await source.getDayData('2026-03-05')).not.toBeNull();
    expect(queries).toHaveLength(6);
  });

  it('re-opens for another cooldown when the probe fails', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-03-10T12:00:00Z'));
    const { source, queries } = setup(() => {
      throw outage();
    });
    await expect(source.getDayData('2026-03-07')).rejects.toBeTruthy();

    vi.setSystemTime(Date.now() + PROMETHEUS_BREAKER_COOLDOWN_MS + 1);
    await expect(source.getDayData('2026-03-06')).rejects.toBeTruthy();
    expect(queries).toHaveLength(4); // the probe reached Prometheus

    await expect(source.getDayData('2026-03-05')).rejects.toBeTruthy();
    expect(queries).toHaveLength(4); // and the breaker is open again
  });

  it.each([
    ['a plain error (unknown failure)', () => new Error('socket hang up')],
    ['a 5xx', () => ApplicationError.maasError('Prometheus query failed', 503, 'x', true)],
    ['a 429', () => ApplicationError.maasError('Prometheus query failed', 429, 'x', true)],
  ])('opens for %s', async (_label, makeError) => {
    const { source, prometheus } = setup(() => {
      throw makeError();
    });
    await expect(source.getDayData(pastDay)).rejects.toBeTruthy();
    await expect(source.getDayData(otherDay)).rejects.toBeTruthy();
    expect(prometheus.query).toHaveBeenCalledTimes(2);
  });

  it('does not open for a request error (4xx): the next call is still sent', async () => {
    const { source, prometheus } = setup(() => {
      throw ApplicationError.maasError('Prometheus query failed', 422, 'parse error', false);
    });
    await expect(source.getDayData(pastDay)).rejects.toBeTruthy();
    await expect(source.getDayData(otherDay)).rejects.toBeTruthy();
    expect(prometheus.query).toHaveBeenCalledTimes(4);
  });

  it('keeps serving results that are already cached while it is open', async () => {
    let fail = false;
    const { source, prometheus } = setup(() => {
      if (fail) throw outage();
      return [sample('litemaas-key-1', 'llama', 7)];
    });
    expect(await source.getDayData(pastDay)).not.toBeNull();
    fail = true;
    await expect(source.getDayData(otherDay)).rejects.toBeTruthy(); // opens the breaker
    const calls = vi.mocked(prometheus.query).mock.calls.length;

    expect(await source.getDayData(pastDay)).not.toBeNull(); // served from the row cache
    expect(prometheus.query).toHaveBeenCalledTimes(calls);
  });

  it('is closed by clearCache(): an explicit refresh asks Prometheus again right away', async () => {
    const { source, prometheus } = setup(() => {
      throw outage();
    });
    await expect(source.getDayData(pastDay)).rejects.toBeTruthy();
    await expect(source.getDayData(otherDay)).rejects.toBeTruthy();
    expect(prometheus.query).toHaveBeenCalledTimes(2);

    source.clearCache();
    await expect(source.getDayData(otherDay)).rejects.toBeTruthy();
    expect(prometheus.query).toHaveBeenCalledTimes(4);
  });

  it('does not count future days (no query) as a failure or a probe', async () => {
    const { source, prometheus } = setup(() => []);
    const future = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    expect(await source.getDayData(future)).toBeNull();
    expect(prometheus.query).not.toHaveBeenCalled();
  });
});

describe('MaasUsageSource.queryDayRows cache and midnight UTC', () => {
  const rowsFor = (tokens: () => number) => (promql: string) =>
    promql.includes('authorized_hits')
      ? [sample('litemaas-key-a', 'llama', tokens())]
      : [sample('litemaas-key-a', 'llama', 5)];

  it('does not reuse a partial-window result once the day is complete', async () => {
    let tokens = 1000;
    const { source, queries } = setup(rowsFor(() => tokens));
    const day = '2025-03-10';

    // 23:58Z: the window is still partial
    const before = await source.queryDayRows(day, undefined, new Date('2025-03-10T23:58:00Z'));
    expect(before[0].tokens).toBe(1000);
    expect(queries).toHaveLength(2);

    // 500 more tokens were produced before midnight; at 00:02Z the day is complete and its
    // result must be re-queried (the cache entry is only 4 minutes old)
    tokens = 1500;
    const after = await source.queryDayRows(day, undefined, new Date('2025-03-11T00:02:00Z'));
    expect(after[0].tokens).toBe(1500);
    expect(queries).toHaveLength(4);

    // the complete result is cached normally
    tokens = 9999;
    const again = await source.queryDayRows(day, undefined, new Date('2025-03-11T00:03:00Z'));
    expect(again[0].tokens).toBe(1500);
    expect(queries).toHaveLength(4);
  });

  it('still reuses a partial result while the day is running (short TTL)', async () => {
    const { source, queries } = setup(rowsFor(() => 1000));
    const day = '2025-03-10';
    await source.queryDayRows(day, undefined, new Date('2025-03-10T12:00:00Z'));
    await source.queryDayRows(day, undefined, new Date('2025-03-10T12:03:00Z'));
    expect(queries).toHaveLength(2);
    // ... but only for the TTL
    await source.queryDayRows(day, undefined, new Date('2025-03-10T12:06:00Z'));
    expect(queries).toHaveLength(4);
  });
});

describe('MaasUsageSource model resolution', () => {
  const model = (ns: string, ref: string, served: string = ref, price = '0.000001') => ({
    id: `${ns}/${ref}`,
    name: ref,
    backend_model_name: served,
    maas_model_ref_name: ref,
    maas_model_ref_namespace: ns,
    input_cost_per_token: price,
    output_cost_per_token: price,
  });
  const pastDay = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);

  it('loads the models in a deterministic order', async () => {
    const { source, fastify } = setup(() => []);
    await source.syncModelProviders();
    const sql = vi
      .mocked(fastify.dbUtils.queryMany)
      .mock.calls.map((c: unknown[]) => String(c[0]))
      .find((q: string) => q.includes('FROM models'));
    expect(sql).toMatch(/ORDER BY id\s*$/);
  });

  it('leaves a label claimed by several models unresolved, whatever the row order', () => {
    const a = model('team-a', 'granite');
    const b = model('team-b', 'granite', 'granite', '0.00001');
    for (const order of [
      [a, b],
      [b, a],
    ]) {
      const onAmbiguous = vi.fn();
      const resolve = MaasUsageSource.buildResolver(order, onAmbiguous);

      expect(resolve('granite')).toEqual({ id: 'granite', unitPrice: 0, resolved: false });
      // the namespace-less fallback must not pick one either
      expect(resolve('other-ns/granite').resolved).toBe(false);
      // unambiguous names keep working
      expect(resolve('team-a/granite')).toMatchObject({ id: 'team-a/granite', resolved: true });
      expect(resolve('TEAM-B/granite')).toMatchObject({ id: 'team-b/granite', resolved: true });
      expect(onAmbiguous).toHaveBeenCalledTimes(1);
      expect(onAmbiguous).toHaveBeenCalledWith('granite', ['team-a/granite', 'team-b/granite']);
    }
  });

  it('treats two models that share a served name as ambiguous only for that name', () => {
    const a = model('ns', 'llama-a', 'shared');
    const b = model('ns', 'llama-b', 'shared');
    const onAmbiguous = vi.fn();
    const resolve = MaasUsageSource.buildResolver([b, a], onAmbiguous);
    expect(resolve('shared').resolved).toBe(false);
    expect(resolve('llama-a')).toMatchObject({ id: 'ns/llama-a', resolved: true });
    expect(resolve('llama-b')).toMatchObject({ id: 'ns/llama-b', resolved: true });
    expect(onAmbiguous).toHaveBeenCalledWith('shared', ['ns/llama-a', 'ns/llama-b']);
  });

  it('does not resolve an ambiguous namespaced label through its namespace-less tail', () => {
    // two models serve the same "org/shared" name; a third model is called "shared"
    const a = model('ns', 'one', 'org/shared');
    const b = model('ns', 'two', 'org/shared');
    const tail = model('ns', 'shared');
    const resolve = MaasUsageSource.buildResolver([tail, b, a]);

    expect(resolve('org/shared')).toEqual({ id: 'org/shared', unitPrice: 0, resolved: false });
    // the unrelated lookup of the tail itself still works
    expect(resolve('shared').id).toBe('ns/shared');
    // and a namespaced label that is not claimed at all still falls back to its tail
    expect(resolve('other/shared').id).toBe('ns/shared');
  });

  it('lets a stronger match win over a looser one without calling it ambiguous', () => {
    const byRef = model('ns', 'foo');
    const byServedName = model('ns', 'bar', 'foo');
    const onAmbiguous = vi.fn();
    const resolve = MaasUsageSource.buildResolver([byServedName, byRef], onAmbiguous);
    expect(resolve('foo').id).toBe('ns/foo');
    expect(onAmbiguous).not.toHaveBeenCalled();
  });

  it('prices usage of an ambiguous label at 0 and warns once, not on every model reload', async () => {
    const models = [model('team-a', 'granite'), model('team-b', 'granite', 'granite', '0.00001')];
    const { source, fastify } = setup(
      (promql) =>
        promql.includes('authorized_hits')
          ? [sample('litemaas-key-1', 'granite', 1000)]
          : [sample('litemaas-key-1', 'granite', 2)],
      {},
      models,
    );

    const day = (await source.getDayData(pastDay))!;
    expect(day.breakdown.models['granite'].metrics).toMatchObject({ total_tokens: 1000, spend: 0 });

    // the model cache is rebuilt (admin refresh): the same ambiguity must not warn again
    source.clearCache();
    await source.getDayData(pastDay);
    const ambiguityWarnings = vi
      .mocked(fastify.log.warn)
      .mock.calls.filter((c: unknown[]) => String(c[1]).includes('several MaaS models'));
    expect(ambiguityWarnings).toHaveLength(1);
    expect(ambiguityWarnings[0][0]).toMatchObject({
      label: 'granite',
      modelIds: ['team-a/granite', 'team-b/granite'],
    });
  });
});

describe('MaasUsageSource range truncation', () => {
  it('warns when a range is cut to the most recent 120 days', async () => {
    const { source, fastify, queries } = setup(() => []);
    const start = '2024-01-01';
    const end = '2025-03-01';
    expect(MaasUsageSource.countDays(start, end)).toBe(426);

    await source.getUsageSummary(['litemaas-key-1'], start, end);

    expect(fastify.log.warn).toHaveBeenCalledTimes(1);
    expect(fastify.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        startDate: start,
        endDate: end,
        requestedDays: 426,
        maxDays: 120,
        effectiveStartDate: '2024-11-02',
      }),
      expect.stringContaining('truncated to the most recent 120 days'),
    );
    expect(queries.length).toBe(2 * 120); // only the retained days were queried
  });

  it('does not warn for a range within the cap', async () => {
    const { source, fastify } = setup(() => []);
    await source.getUsageSummary(['litemaas-key-1'], '2025-02-01', '2025-03-01');
    expect(fastify.log.warn).not.toHaveBeenCalled();
    expect(MaasUsageSource.countDays('2025-03-02', '2025-03-01')).toBe(0);
  });
});

describe('isWithinUsageRetention', () => {
  const now = new Date('2025-03-10T12:00:00Z');

  it('requires the whole day window to be inside the retention', () => {
    // 15 days back from 2025-03-10T12:00Z is 2025-02-23T12:00Z
    expect(isWithinUsageRetention('2025-03-10', 15, now)).toBe(true);
    expect(isWithinUsageRetention('2025-02-24', 15, now)).toBe(true);
    expect(isWithinUsageRetention('2025-02-23', 15, now)).toBe(false); // starts before the cutoff
    expect(isWithinUsageRetention('2024-12-01', 15, now)).toBe(false);
    expect(isWithinUsageRetention('2024-12-01', 365, now)).toBe(true);
  });

  it('does not exclude a date it cannot parse', () => {
    expect(isWithinUsageRetention('garbage', 15, now)).toBe(true);
  });
});

describe('extractMaasSlice', () => {
  const pastDay = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
  const metrics = (r: number, t: number, s: number) => ({
    api_requests: r,
    total_tokens: t,
    prompt_tokens: t,
    completion_tokens: 0,
    spend: s,
  });

  async function maasDay() {
    const { source } = setup((promql) =>
      promql.includes('authorized_hits')
        ? [
            sample('litemaas-key-a', 'llama', 1000),
            sample('litemaas-key-b', 'llama', 500),
            sample('litemaas-key-a', 'granite-served', 200),
          ]
        : [
            sample('litemaas-key-a', 'llama', 10),
            sample('litemaas-key-b', 'llama', 5),
            sample('litemaas-key-a', 'granite-served', 2),
          ],
    );
    return (await source.getDayData(pastDay))!;
  }

  it('is the exact inverse of getDayData for a MaaS-only day (also after the JSON cache round trip)', async () => {
    const day = await maasDay();
    expect(extractMaasSlice(day)).toEqual(day);
    expect(extractMaasSlice(JSON.parse(JSON.stringify(day)))).toEqual(day);
  });

  it('keeps only the maas: entries of a merged day and re-derives every total from them', async () => {
    const maas = await maasDay();
    const litellm: LiteLLMDayData = {
      date: pastDay,
      metrics: {
        ...metrics(7, 70, 3),
        prompt_tokens: 40,
        completion_tokens: 30,
        successful_requests: 6,
        failed_requests: 1,
      },
      breakdown: {
        models: {
          'gpt-4': {
            metrics: metrics(3, 30, 1),
            api_keys: { 'sha-1': { metrics: metrics(3, 30, 1) } },
          },
          // same model name as a MaaS model: the entry mixes both backends
          'ns/llama': {
            metrics: metrics(4, 40, 2),
            api_keys: { 'sha-2': { metrics: metrics(4, 40, 2) } },
          },
        },
        api_keys: {},
        providers: { openai: { metrics: metrics(7, 70, 3) } },
      },
    };
    const merged = mergeDayData(litellm, maas)!;
    expect(merged.breakdown.models['ns/llama'].metrics.api_requests).toBe(4 + 15);

    const slice = extractMaasSlice(merged)!;

    expect(slice).toEqual(maas);
    expect(Object.keys(slice.breakdown.models['ns/llama'].api_keys).sort()).toEqual([
      'maas:litemaas-key-a',
      'maas:litemaas-key-b',
    ]);
    expect(slice.breakdown.providers).toEqual({ maas: expect.anything() });
    expect(slice.breakdown.providers.openai).toBeUndefined();
    // carrying it forward onto fresh LiteLLM data reproduces the original merged day
    expect(mergeDayData(litellm, slice)!.metrics).toEqual(merged.metrics);
  });

  it('returns null when the day holds no MaaS usage or there is nothing to read', async () => {
    const litellm: LiteLLMDayData = {
      date: pastDay,
      metrics: { ...metrics(3, 30, 1), successful_requests: 3, failed_requests: 0 },
      breakdown: {
        models: {
          'gpt-4': {
            metrics: metrics(3, 30, 1),
            api_keys: { 'sha-1': { metrics: metrics(3, 30, 1) } },
          },
        },
        api_keys: {},
        providers: {},
      },
    };
    expect(extractMaasSlice(litellm)).toBeNull();
    expect(extractMaasSlice(null)).toBeNull();
    expect(extractMaasSlice(undefined)).toBeNull();
    expect(extractMaasSlice({} as LiteLLMDayData)).toBeNull();
  });
});

describe('MaasUsageSource.syncModelProviders', () => {
  // the registry is process-wide: earlier tests in this file load models too
  beforeEach(() => setMaasModelIds([]));
  afterEach(() => setMaasModelIds([]));

  it('registers the MaaS model ids so admin usage reports them under the maas provider', async () => {
    const { source } = setup(() => []);
    // without the registration the namespace of the id reads as a provider
    expect(extractProviderFromModel('ns/llama')).toBe('ns');

    await source.syncModelProviders();

    expect(extractProviderFromModel('ns/llama')).toBe('maas');
    expect(extractProviderFromModel('ns/granite')).toBe('maas');
    // LiteLLM names are untouched
    expect(extractProviderFromModel('openai/gpt-4')).toBe('openai');
    expect(extractProviderFromModel('gpt-4')).toBe('openai');
  });
});
