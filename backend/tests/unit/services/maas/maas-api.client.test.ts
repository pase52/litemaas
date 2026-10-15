import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  MaasApiClient,
  MockMaasApiClient,
  formatExpiresIn,
} from '../../../../src/services/maas/maas-api.client';
import { ApplicationError } from '../../../../src/utils/errors';

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status });

describe('formatExpiresIn', () => {
  it('formats days and clamps to at least one day', () => {
    expect(formatExpiresIn(30)).toBe('30d');
    expect(formatExpiresIn(0)).toBe('1d');
    expect(formatExpiresIn(2.2)).toBe('3d');
  });
});

describe('MaasApiClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const client = () => new MaasApiClient({ baseUrl: 'https://maas.test/maas-api' });

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('createKey posts the documented body with the user token', async () => {
    fetchMock.mockResolvedValueOnce(
      json(201, {
        id: 'k1',
        key: 'sk-oai-abc',
        keyPrefix: 'sk-oai-a',
        createdAt: 'c',
        expiresAt: 'e',
        subscription: 'sub',
      }),
    );
    const res = await client().createKey('USER_TOKEN', {
      name: 'my key',
      description: 'd',
      subscription: 'litemaas-key-1',
      expiresInDays: 30,
    });
    expect(res).toEqual({
      id: 'k1',
      key: 'sk-oai-abc',
      keyPrefix: 'sk-oai-a',
      createdAt: 'c',
      expiresAt: 'e',
      subscription: 'sub',
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://maas.test/maas-api/v1/api-keys');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer USER_TOKEN');
    expect(JSON.parse(init.body)).toEqual({
      name: 'my key',
      description: 'd',
      subscription: 'litemaas-key-1',
      expiresIn: '30d',
    });
  });

  it('createKey omits expiresIn when no expiry is requested', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { id: 'k', key: 'sk' }));
    await client().createKey('t', { name: 'n', subscription: 's' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      name: 'n',
      description: '',
      subscription: 's',
    });
  });

  it.each([401, 403])(
    'maps %i to MAAS_REAUTH_REQUIRED (non-401 status for the UI)',
    async (status) => {
      fetchMock.mockResolvedValueOnce(json(status, { error: 'bad token' }));
      const err = await client()
        .createKey('t', { name: 'n', subscription: 's' })
        .catch((e) => e);
      expect(err).toBeInstanceOf(ApplicationError);
      expect(err.code).toBe('MAAS_REAUTH_REQUIRED');
      expect(err.statusCode).toBe(403);
      expect(err.details.reason).toContain(String(status));
    },
  );

  it('maps other failures to MAAS_ERROR with upstream details and retryability', async () => {
    fetchMock.mockResolvedValueOnce(json(400, { error: { message: 'subscription not found' } }));
    const e400 = await client()
      .createKey('t', { name: 'n', subscription: 's' })
      .catch((e) => e);
    expect(e400.code).toBe('MAAS_ERROR');
    expect(e400.details).toMatchObject({
      upstreamStatus: 400,
      upstreamMessage: 'subscription not found',
    });
    expect(e400.retryable).toBe(false);

    fetchMock.mockResolvedValueOnce(json(503, { message: 'down' }));
    const e503 = await client()
      .createKey('t', { name: 'n', subscription: 's' })
      .catch((e) => e);
    expect(e503.retryable).toBe(true);
  });

  it('maps network failures to a retryable MAAS_ERROR', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));
    const err = await client()
      .createKey('t', { name: 'n', subscription: 's' })
      .catch((e) => e);
    expect(err.code).toBe('MAAS_ERROR');
    expect(err.retryable).toBe(true);
  });

  it('rejects a malformed creation response', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { id: 'only-id' }));
    await expect(client().createKey('t', { name: 'n', subscription: 's' })).rejects.toMatchObject({
      code: 'MAAS_ERROR',
    });
  });

  it('revokeKey DELETEs the encoded id and treats 404 as success', async () => {
    fetchMock.mockResolvedValueOnce(json(200, {}));
    await client().revokeKey('tok', 'a/b');
    expect(fetchMock.mock.calls[0][0]).toBe('https://maas.test/maas-api/v1/api-keys/a%2Fb');
    expect(fetchMock.mock.calls[0][1].method).toBe('DELETE');

    fetchMock.mockResolvedValueOnce(json(404, { error: 'not found' }));
    await expect(client().revokeKey('tok', 'x')).resolves.toBeUndefined();

    fetchMock.mockResolvedValueOnce(json(500, { error: 'x' }));
    await expect(client().revokeKey('tok', 'x')).rejects.toMatchObject({ code: 'MAAS_ERROR' });

    fetchMock.mockResolvedValueOnce(json(401));
    await expect(client().revokeKey('tok', 'x')).rejects.toMatchObject({
      code: 'MAAS_REAUTH_REQUIRED',
    });
  });

  it('searchKeys accepts several response shapes', async () => {
    fetchMock.mockResolvedValueOnce(json(200, [{ id: '1' }]));
    expect(await client().searchKeys('t')).toEqual([{ id: '1' }]);
    fetchMock.mockResolvedValueOnce(json(200, { items: [{ id: '2' }] }));
    expect(await client().searchKeys('t', { subscription: 's' })).toEqual([{ id: '2' }]);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ subscription: 's' });
    fetchMock.mockResolvedValueOnce(json(200, { unexpected: true }));
    expect(await client().searchKeys('t')).toEqual([]);
    expect(fetchMock.mock.calls[0][0]).toBe('https://maas.test/maas-api/v1/api-keys/search');
  });

  it('health is unauthenticated and never throws', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { status: 'ok' }));
    expect(await client().health()).toMatchObject({ healthy: true, status: 200 });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
    expect(fetchMock.mock.calls[0][0]).toBe('https://maas.test/maas-api/health');

    fetchMock.mockResolvedValueOnce(json(503, {}));
    expect(await client().health()).toMatchObject({ healthy: false });
    fetchMock.mockRejectedValueOnce(new Error('x'));
    expect(await client().health()).toMatchObject({ healthy: false });
  });
});

describe('MockMaasApiClient', () => {
  it('issues sk-oai keys, scopes search to the caller and revokes', async () => {
    const c = new MockMaasApiClient();
    expect(c.mock).toBe(true);
    const created = await c.createKey('alice-token', {
      name: 'n',
      subscription: 's',
      expiresInDays: 1,
    });
    expect(created.key.startsWith('sk-oai-')).toBe(true);
    expect(created.expiresAt).toBeTruthy();
    expect(await c.searchKeys('alice-token')).toHaveLength(1);
    expect(await c.searchKeys('bob-token')).toHaveLength(0);
    expect(await c.searchKeys('alice-token', { subscription: 'other' })).toHaveLength(0);
    await c.revokeKey('alice-token', created.id);
    expect(await c.searchKeys('alice-token')).toHaveLength(0);
    expect((await c.health()).healthy).toBe(true);
  });
});
