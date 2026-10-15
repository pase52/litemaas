import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  PrometheusClient,
  MockPrometheusClient,
} from '../../../../src/services/maas/prometheus.client';

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status });

describe('PrometheusClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const client = (extra = {}) =>
    new PrometheusClient({ baseUrl: 'https://thanos.test', token: 'PT', ...extra });

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('instant query sends query/time and bearer token, returns the vector', async () => {
    const result = [{ metric: { subscription: 's' }, value: [1700000000, '42'] }];
    fetchMock.mockResolvedValueOnce(
      json(200, { status: 'success', data: { resultType: 'vector', result } }),
    );
    const res = await client().query('sum(authorized_hits)', new Date(1700000000_000));
    expect(res).toEqual(result);
    const [url, init] = fetchMock.mock.calls[0];
    const u = new URL(url);
    expect(u.pathname).toBe('/api/v1/query');
    expect(u.searchParams.get('query')).toBe('sum(authorized_hits)');
    expect(u.searchParams.get('time')).toBe('1700000000');
    expect(init.headers.Authorization).toBe('Bearer PT');
  });

  it('instant query omits time when not given and wraps scalar results', async () => {
    fetchMock.mockResolvedValueOnce(
      json(200, { status: 'success', data: { resultType: 'scalar', result: [1, '2'] } }),
    );
    const res = await client().query('1+1');
    expect(res).toEqual([{ metric: {}, value: [1, '2'] }]);
    expect(new URL(fetchMock.mock.calls[0][0]).searchParams.has('time')).toBe(false);
  });

  it('range query sends start/end/step and returns the matrix', async () => {
    const result = [
      {
        metric: { model: 'm' },
        values: [
          [1, '1'],
          [2, '2'],
        ],
      },
    ];
    fetchMock.mockResolvedValueOnce(
      json(200, { status: 'success', data: { resultType: 'matrix', result } }),
    );
    const res = await client().queryRange('rate(x[5m])', new Date(1000_000), 2000, '5m');
    expect(res).toEqual(result);
    const u = new URL(fetchMock.mock.calls[0][0]);
    expect(u.pathname).toBe('/api/v1/query_range');
    expect(u.searchParams.get('start')).toBe('1000');
    expect(u.searchParams.get('end')).toBe('2000');
    expect(u.searchParams.get('step')).toBe('5m');
  });

  it('returns [] for unexpected result types', async () => {
    fetchMock.mockResolvedValueOnce(
      json(200, { status: 'success', data: { resultType: 'string', result: [] } }),
    );
    expect(await client().query('x')).toEqual([]);
  });

  it('uses the token provider when no static token is set', async () => {
    fetchMock.mockImplementation(async () =>
      json(200, { status: 'success', data: { resultType: 'vector', result: [] } }),
    );
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

  it('health runs vector(1) and never throws', async () => {
    fetchMock.mockResolvedValueOnce(
      json(200, { status: 'success', data: { resultType: 'vector', result: [] } }),
    );
    expect(await client().health()).toEqual({ healthy: true });
    expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get('query')).toBe('vector(1)');
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
