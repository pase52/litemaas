import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  PrometheusClient,
  MockPrometheusClient,
  DEFAULT_PROMETHEUS_TIMEOUT_MS,
} from '../../../../src/services/maas/prometheus.client';

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status });

const ok = (data: unknown, extra: Record<string, unknown> = {}) =>
  json(200, { status: 'success', data, ...extra });

describe('PrometheusClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const client = (extra = {}) =>
    new PrometheusClient({ baseUrl: 'https://thanos.test', token: 'PT', ...extra });
  /** URL-encoded form body of the n-th request */
  const form = (n = 0) => new URLSearchParams(fetchMock.mock.calls[n][1].body as string);

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('instant query POSTs a form-encoded body with query/time and the bearer token', async () => {
    const result = [{ metric: { subscription: 's' }, value: [1700000000, '42'] }];
    fetchMock.mockResolvedValueOnce(ok({ resultType: 'vector', result }));
    const res = await client().query('sum(authorized_hits)', new Date(1700000000_000));
    expect(res).toEqual(result);
    const [url, init] = fetchMock.mock.calls[0];
    const u = new URL(url);
    expect(u.pathname).toBe('/api/v1/query');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(init.headers.Authorization).toBe('Bearer PT');
    expect(form().get('query')).toBe('sum(authorized_hits)');
    expect(form().get('time')).toBe('1700000000');
    // the query never travels in the URL
    expect(u.searchParams.has('query')).toBe(false);
    expect(init.headers['Content-Length']).toBe(String(Buffer.byteLength(init.body)));
  });

  it('instant query omits time when not given and wraps scalar results', async () => {
    fetchMock.mockResolvedValueOnce(ok({ resultType: 'scalar', result: [1, '2'] }));
    const res = await client().query('1+1');
    expect(res).toEqual([{ metric: {}, value: [1, '2'] }]);
    expect(form().has('time')).toBe(false);
  });

  it('range query sends start/end/step in the body and returns the matrix', async () => {
    const result = [
      {
        metric: { model: 'm' },
        values: [
          [1, '1'],
          [2, '2'],
        ],
      },
    ];
    fetchMock.mockResolvedValueOnce(ok({ resultType: 'matrix', result }));
    const res = await client().queryRange('rate(x[5m])', new Date(1000_000), 2000, '5m');
    expect(res).toEqual(result);
    expect(new URL(fetchMock.mock.calls[0][0]).pathname).toBe('/api/v1/query_range');
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
    expect(form().get('query')).toBe('rate(x[5m])');
    expect(form().get('start')).toBe('1000');
    expect(form().get('end')).toBe('2000');
    expect(form().get('step')).toBe('5m');
  });

  it('keeps an oversized selector out of the URL (the subscription regex of a user with many keys)', async () => {
    fetchMock.mockResolvedValueOnce(ok({ resultType: 'vector', result: [] }));
    const regex = Array.from(
      { length: 2000 },
      (_, i) => `litemaas-key-${i}-${'x'.repeat(30)}`,
    ).join('|');
    const promql = `sum by (subscription, model) (increase(authorized_hits{subscription=~"(.*/)?(${regex})"}[86400s]))`;
    expect(promql.length).toBeGreaterThan(80_000);

    await client().query(promql, 1700000000);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url.length).toBeLessThan(200);
    expect(form().get('query')).toBe(promql);
    expect(init.headers['Content-Length']).toBe(String(Buffer.byteLength(init.body)));
  });

  it('asks Thanos for strict (non-partial) answers with partial_response=false on both endpoints', async () => {
    fetchMock.mockImplementation(async () => ok({ resultType: 'vector', result: [] }));
    await client().query('x');
    await client().queryRange('x', 1, 2, 60);
    for (const [url] of fetchMock.mock.calls) {
      expect(new URL(url).searchParams.get('partial_response')).toBe('false');
    }
  });

  it('returns [] for unexpected result types', async () => {
    fetchMock.mockResolvedValueOnce(ok({ resultType: 'string', result: [] }));
    expect(await client().query('x')).toEqual([]);
  });

  it('uses the token provider when no static token is set', async () => {
    fetchMock.mockImplementation(async () => ok({ resultType: 'vector', result: [] }));
    await new PrometheusClient({ baseUrl: 'https://p', tokenProvider: () => 'SA' }).query('x');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer SA');
    await new PrometheusClient({ baseUrl: 'https://p' }).query('x');
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBeUndefined();
  });

  it('raises MAAS_ERROR on HTTP and Prometheus-level errors', async () => {
    fetchMock.mockResolvedValueOnce(
      json(422, { status: 'error', errorType: 'bad_data', error: 'parse error' }),
    );
    const e1 = await client()
      .query('(')
      .catch((e) => e);
    expect(e1).toMatchObject({ code: 'MAAS_ERROR' });
    expect(e1.details).toMatchObject({ upstreamStatus: 422, upstreamMessage: 'parse error' });
    expect(e1.retryable).toBe(false);

    fetchMock.mockResolvedValueOnce(json(200, { status: 'error', error: 'boom' }));
    await expect(client().query('x')).rejects.toMatchObject({ code: 'MAAS_ERROR' });

    fetchMock.mockResolvedValueOnce(json(503, {}));
    expect(
      (
        await client()
          .query('x')
          .catch((e) => e)
      ).retryable,
    ).toBe(true);

    fetchMock.mockResolvedValueOnce(json(200, { nope: true }));
    await expect(client().query('x')).rejects.toMatchObject({ code: 'MAAS_ERROR' });

    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect(
      (
        await client()
          .query('x')
          .catch((e) => e)
      ).retryable,
    ).toBe(true);
  });

  describe('warnings (partial responses)', () => {
    it('treats a successful answer that carries warnings as a retryable MAAS_ERROR', async () => {
      const warn = vi.fn();
      const warnings = [
        'receive Addr: a:10901 LabelSets: {replica="0"}: rpc error: code = Unavailable',
        'PromQL warning: something else',
      ];
      fetchMock.mockResolvedValueOnce(
        ok({ resultType: 'vector', result: [{ metric: {}, value: [1, '5'] }] }, { warnings }),
      );

      const err = await new PrometheusClient(
        { baseUrl: 'https://thanos.test' },
        { debug: vi.fn(), warn },
      )
        .query('x')
        .catch((e) => e);

      expect(err).toMatchObject({ code: 'MAAS_ERROR', statusCode: 502, retryable: true });
      expect(err.details.upstreamMessage).toContain('Unavailable');
      expect(err.details.upstreamMessage).toContain('PromQL warning');
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ warnings }), expect.any(String));
    });

    it('applies to range queries too', async () => {
      fetchMock.mockResolvedValueOnce(
        ok({ resultType: 'matrix', result: [] }, { warnings: ['store down'] }),
      );
      await expect(client().queryRange('x', 1, 2, 60)).rejects.toMatchObject({
        code: 'MAAS_ERROR',
      });
    });

    it('accepts an empty warnings array and makes health() report unhealthy on warnings', async () => {
      fetchMock.mockResolvedValueOnce(ok({ resultType: 'vector', result: [] }, { warnings: [] }));
      expect(await client().query('x')).toEqual([]);

      fetchMock.mockResolvedValueOnce(
        ok({ resultType: 'vector', result: [] }, { warnings: ['store down'] }),
      );
      const health = await client().health();
      expect(health.healthy).toBe(false);
      expect(health.message).toContain('partial or degraded');
    });
  });

  describe('timeouts', () => {
    it('defaults to 10 s and honours the configured timeout', async () => {
      const timeout = vi.spyOn(AbortSignal, 'timeout');
      fetchMock.mockImplementation(async () => ok({ resultType: 'vector', result: [] }));

      expect(DEFAULT_PROMETHEUS_TIMEOUT_MS).toBe(10_000);
      await client().query('x');
      expect(timeout).toHaveBeenLastCalledWith(10_000);

      await client({ timeoutMs: 2500 }).query('x');
      expect(timeout).toHaveBeenLastCalledWith(2500);
    });

    it('maps an abort while reading the body to a retryable MAAS_ERROR instead of a raw error', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () =>
          Promise.reject(
            new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
          ),
      });
      const err = await client()
        .query('x')
        .catch((e) => e);
      expect(err).toMatchObject({ code: 'MAAS_ERROR', retryable: true });
      expect(err.details.upstreamMessage).toContain('timeout');
    });
  });

  it('health runs vector(1) and never throws', async () => {
    fetchMock.mockResolvedValueOnce(ok({ resultType: 'vector', result: [] }));
    expect(await client().health()).toEqual({ healthy: true });
    expect(form().get('query')).toBe('vector(1)');
    fetchMock.mockRejectedValueOnce(new Error('down'));
    expect((await client().health()).healthy).toBe(false);
  });
});

describe('MockPrometheusClient', () => {
  it('returns empty results by default and canned results when configured', async () => {
    const empty = new MockPrometheusClient();
    expect(empty.mock).toBe(true);
    expect(await empty.query('x')).toEqual([]);
    expect(await empty.queryRange('x')).toEqual([]);
    const canned = new MockPrometheusClient({ query: () => [{ metric: {}, value: [1, '1'] }] });
    expect(await canned.query('x')).toHaveLength(1);
    expect((await canned.health()).healthy).toBe(true);
  });
});
