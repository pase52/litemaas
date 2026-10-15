import { describe, it, expect, vi } from 'vitest';
import {
  MaasUsageSource,
  dayWindow,
  mergeDayData,
  stripNamespace,
} from '../../../../src/services/maas/maas-usage.source';
import { MockPrometheusClient } from '../../../../src/services/maas/prometheus.client';
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
        if (sql.includes('FROM models')) return MODELS;
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
