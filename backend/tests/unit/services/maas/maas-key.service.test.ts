import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  MaasKeyService,
  maasKeyHash,
  revokeInMaasApi,
} from '../../../../src/services/maas/maas-key.service';
import { InMemoryK8sClient } from '../../../../src/services/k8s/k8s-client';
import { MockMaasApiClient } from '../../../../src/services/maas/maas-api.client';
import { MAAS_SUBSCRIPTION } from '../../../../src/services/maas/maas-resources';
import { createMaasBackend } from '../../../../src/services/backends/maas.backend';
import { encryptApiKey } from '../../../../src/utils/encryption';
import { ApplicationError } from '../../../../src/utils/errors';

const NS = 'models-as-a-service';
const modelRow = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: id,
  provider: 'maas',
  context_length: 4096,
  backend_type: 'maas',
  availability: 'available',
  maas_model_ref_name: id.split('/')[1],
  maas_model_ref_namespace: id.split('/')[0],
  ...over,
});

function setup() {
  const k8s = new InMemoryK8sClient();
  const maasApi = new MockMaasApiClient();
  const models = new Map<string, any>([
    ['ns/a', modelRow('ns/a')],
    ['ns/b', modelRow('ns/b')],
    ['lite/x', modelRow('lite/x', { backend_type: 'litellm', maas_model_ref_name: null })],
    ['ns/down', modelRow('ns/down', { availability: 'unavailable' })],
  ]);
  const db: any = {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    queryOne: vi.fn().mockResolvedValue(null),
    queryMany: vi.fn().mockImplementation(async (sql: string, params: any[]) => {
      if (sql.includes('FROM models m WHERE m.id = ANY')) {
        return (params[0] as string[]).filter((id) => models.has(id)).map((id) => models.get(id));
      }
      return [];
    }),
    withTransaction: vi
      .fn()
      .mockImplementation(async (cb: any) =>
        cb({ query: vi.fn().mockResolvedValue({ rows: [{ id: 'k', user_id: 'u1' }] }) }),
      ),
  };
  const tokens: any = {
    getValidToken: vi.fn().mockResolvedValue('user-token'),
    getEncryptionSecret: vi.fn().mockReturnValue('secret'),
  };
  const serviceToken = vi.fn().mockReturnValue('sa-token');
  const clients: any = {
    config: { namespace: NS, gatewayUrl: 'https://gw' },
    k8s,
    maasApi,
    prometheus: {},
    serviceToken,
  };
  const fastify: any = {
    dbUtils: db,
    maasClients: clients,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
  const service = new MaasKeyService(fastify, clients, tokens);
  return { k8s, maasApi, db, tokens, clients, fastify, service, models, serviceToken };
}

describe('maasKeyHash', () => {
  it('prefixes the subscription name', () => {
    expect(maasKeyHash('litemaas-key-1')).toBe('maas:litemaas-key-1');
  });
});

describe('MaasKeyService', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
    ctx.db.queryOne.mockImplementation(async (sql: string) =>
      sql.includes('FROM users') ? { username: 'alice' } : null,
    );
  });

  it('refuses to operate when MaaS is disabled', async () => {
    const svc = new MaasKeyService(
      { ...ctx.fastify, maasClients: undefined } as any,
      undefined,
      ctx.tokens,
    );
    await expect(svc.createApiKey('u1', { modelIds: ['ns/a'] })).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(svc.baseUrl).toBeUndefined();
  });

  describe('resolveBackend', () => {
    it('infers the backend and rejects mixes / contradictions', async () => {
      await expect(ctx.service.resolveBackend(['ns/a', 'ns/b'])).resolves.toBe('maas');
      await expect(ctx.service.resolveBackend(['lite/x'])).resolves.toBe('litellm');
      await expect(ctx.service.resolveBackend(['unknown'])).resolves.toBe('litellm');
      await expect(ctx.service.resolveBackend(['ns/a', 'lite/x'])).rejects.toThrow(/cannot mix/);
      await expect(ctx.service.resolveBackend(['ns/a'], 'litellm')).rejects.toThrow(
        /served by the maas/,
      );
      await expect(ctx.service.resolveBackend(['lite/x'], 'maas')).rejects.toThrow(
        /served by the litellm/,
      );
      await expect(ctx.service.resolveBackend(['unknown'], 'maas')).rejects.toThrow(
        /None of the selected/,
      );
    });

    it('findMaasModelIds returns only MaaS ids', async () => {
      await expect(ctx.service.findMaasModelIds(['ns/a', 'lite/x'])).resolves.toEqual(['ns/a']);
      await expect(ctx.service.findMaasModelIds([])).resolves.toEqual([]);
    });
  });

  describe('KeyBackendProvider.createKey', () => {
    const req = (over: Record<string, unknown> = {}) => ({
      keyId: 'key-1',
      userId: 'u1',
      username: 'alice',
      name: 'my key',
      modelIds: ['ns/a', 'ns/b'],
      tpmLimit: 600,
      modelTpmLimits: { 'ns/b': 100 },
      ...over,
    });

    it('creates the subscription BEFORE the maas-api key, with the user token and expiresIn', async () => {
      const order: string[] = [];
      const realCreate = ctx.k8s.create.bind(ctx.k8s);
      const create = vi.spyOn(ctx.k8s, 'create').mockImplementation(async (...a: any[]) => {
        order.push('subscription');
        return (realCreate as any)(...a);
      });
      const apiCreate = vi.spyOn(ctx.maasApi, 'createKey').mockImplementation(async () => {
        order.push('maas-api');
        return { id: 'mk1', key: 'sk-oai-1', keyPrefix: 'sk-oai-1', expiresAt: null };
      });
      const exp = new Date(Date.now() + 3 * 86_400_000 - 1000);
      const out = await ctx.service.createKey(req({ expiresAt: exp }) as any);
      expect(order).toEqual(['subscription', 'maas-api']);
      expect(create).toHaveBeenCalledTimes(1);
      expect(apiCreate).toHaveBeenCalledWith(
        'user-token',
        expect.objectContaining({ subscription: 'litemaas-key-key-1', expiresInDays: 3 }),
      );
      expect(out).toMatchObject({ key: 'sk-oai-1', backendKeyId: 'mk1' });
      expect(out.expiresAt).toEqual(exp);
      const sub = await ctx.k8s.get(MAAS_SUBSCRIPTION, 'litemaas-key-key-1', NS);
      expect(sub?.spec.owner.users).toEqual(['alice']);
      expect(sub?.spec.modelRefs).toEqual([
        { name: 'a', namespace: 'ns', tokenRateLimits: [{ limit: 600, window: '1m' }] },
        { name: 'b', namespace: 'ns', tokenRateLimits: [{ limit: 100, window: '1m' }] },
      ]);
    });

    it('uses providerOptions.userToken instead of reading the stored token', async () => {
      const spy = vi.spyOn(ctx.maasApi, 'createKey');
      await ctx.service.createKey(req({ providerOptions: { userToken: 'passed' } }) as any);
      expect(spy.mock.calls[0][0]).toBe('passed');
      expect(ctx.tokens.getValidToken).not.toHaveBeenCalled();
    });

    it('deletes the subscription and rethrows when maas-api fails', async () => {
      vi.spyOn(ctx.maasApi, 'createKey').mockRejectedValue(ApplicationError.maasError('boom', 503));
      await expect(ctx.service.createKey(req() as any)).rejects.toMatchObject({
        code: 'MAAS_ERROR',
      });
      expect(await ctx.k8s.get(MAAS_SUBSCRIPTION, 'litemaas-key-key-1', NS)).toBeNull();
    });

    it('still rethrows the original error if the cleanup delete also fails', async () => {
      vi.spyOn(ctx.maasApi, 'createKey').mockRejectedValue(new Error('maas-api failed'));
      vi.spyOn(ctx.k8s, 'delete').mockRejectedValue(new Error('cleanup failed'));
      await expect(ctx.service.createKey(req() as any)).rejects.toThrow('maas-api failed');
      expect(ctx.fastify.log.error).toHaveBeenCalled();
    });

    it('fails before any cluster call when the user token is unavailable', async () => {
      ctx.tokens.getValidToken.mockRejectedValue(ApplicationError.maasReauthRequired('no_token'));
      const create = vi.spyOn(ctx.k8s, 'create');
      await expect(ctx.service.createKey(req() as any)).rejects.toMatchObject({
        code: 'MAAS_REAUTH_REQUIRED',
      });
      expect(create).not.toHaveBeenCalled();
    });

    it('rejects unknown / non-MaaS models', async () => {
      await expect(
        ctx.service.createKey(req({ modelIds: ['ns/a', 'lite/x'] }) as any),
      ).rejects.toThrow(/known MaaS models/);
      await expect(ctx.service.createKey(req({ modelIds: ['nope/z'] }) as any)).rejects.toThrow();
    });
  });

  describe('createApiKey validation', () => {
    it('rejects unsupported limits before touching anything', async () => {
      for (const extra of [
        { maxBudget: 1 },
        { rpmLimit: 1 },
        { modelMaxBudget: { a: 1 } },
        { guardrails: ['x'] },
      ]) {
        await expect(
          ctx.service.createApiKey('u1', { modelIds: ['ns/a'], ...extra }),
        ).rejects.toThrow(/tokens-per-minute/);
      }
      expect(ctx.db.queryMany).not.toHaveBeenCalled();
    });

    it('accepts null / empty values for unsupported fields (UI sends defaults)', async () => {
      ctx.db.queryMany.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM models m WHERE m.id = ANY')) return [modelRow('ns/a')];
        if (sql.includes('FROM subscriptions s')) return [{ model_id: 'ns/a' }];
        return [];
      });
      ctx.db.queryOne.mockImplementation(async (sql: string) => {
        if (sql.includes('COUNT(*)')) return { count: '0' };
        if (sql.includes('FROM users')) return { username: 'alice' };
        return null;
      });
      ctx.db.withTransaction.mockImplementation(async (cb: any) =>
        cb({
          query: vi.fn().mockResolvedValue({
            rows: [
              {
                id: 'k',
                user_id: 'u1',
                key_prefix: 'sk-oai-mock-',
                created_at: new Date(),
                is_active: true,
                name: 'n',
              },
            ],
          }),
        }),
      );
      const res = await ctx.service.createApiKey('u1', {
        modelIds: ['ns/a'],
        name: 'n',
        maxBudget: undefined,
        rpmLimit: null as any,
        modelRpmLimit: {},
        tags: ['ignored'],
      });
      expect(res.backendType).toBe('maas');
      expect(res.key).toMatch(/^sk-oai-mock-/);
    });

    it('requires the encryption secret', async () => {
      ctx.db.queryMany.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM models m WHERE m.id = ANY')) return [modelRow('ns/a')];
        if (sql.includes('FROM subscriptions s')) return [{ model_id: 'ns/a' }];
        return [];
      });
      ctx.db.queryOne.mockImplementation(async (sql: string) =>
        sql.includes('COUNT(*)') ? { count: '0' } : null,
      );
      ctx.tokens.getEncryptionSecret.mockReturnValue(undefined);
      await expect(ctx.service.createApiKey('u1', { modelIds: ['ns/a'] })).rejects.toMatchObject({
        statusCode: 503,
      });
    });

    it('rejects unavailable models and broken refs', async () => {
      ctx.db.queryMany.mockImplementation(async (sql: string, params: any[]) =>
        sql.includes('FROM models m WHERE m.id = ANY')
          ? (params[0] as string[]).map((id) => ctx.models.get(id)).filter(Boolean)
          : [],
      );
      await expect(ctx.service.createApiKey('u1', { modelIds: ['ns/down'] })).rejects.toThrow(
        /unavailable/,
      );
      ctx.models.set('ns/broken', modelRow('ns/broken', { maas_model_ref_name: null }));
      await expect(ctx.service.createApiKey('u1', { modelIds: ['ns/broken'] })).rejects.toThrow(
        /model reference/,
      );
    });
  });

  describe('updateExpiration', () => {
    const row = (expires: Date | null) => ({
      id: 'k1',
      user_id: 'u1',
      is_active: true,
      expires_at: expires,
      models: [],
      backend_type: 'maas',
    });
    function load(expires: Date | null) {
      ctx.db.queryOne.mockResolvedValue(row(expires));
    }

    it('only shortens', async () => {
      const current = new Date(Date.now() + 10 * 86_400_000);
      load(current);
      await expect(ctx.service.updateExpiration('k1', 'u1', null)).rejects.toThrow(/shortened/);
      await expect(
        ctx.service.updateExpiration('k1', 'u1', new Date(current.getTime() + 1000)),
      ).rejects.toThrow(/shortened/);
      const sooner = new Date(current.getTime() - 86_400_000);
      await ctx.service.updateExpiration('k1', 'u1', sooner);
      const update = ctx.db.query.mock.calls.find(([sql]: any) =>
        String(sql).includes('SET expires_at'),
      );
      expect(update[1]).toEqual(['k1', sooner]);
    });

    it('a key without expiry can get one, but cannot be set to never', async () => {
      load(null);
      await expect(ctx.service.updateExpiration('k1', 'u1', null)).rejects.toThrow();
      await expect(
        ctx.service.updateExpiration('k1', 'u1', new Date(Date.now() + 1000)),
      ).resolves.toBeDefined();
    });
  });

  describe('decryptStoredKey', () => {
    it('round-trips and reports problems clearly', () => {
      const enc = encryptApiKey('sk-oai-secret', 'secret');
      expect(ctx.service.decryptStoredKey(enc, 'k1')).toBe('sk-oai-secret');
      expect(() => ctx.service.decryptStoredKey(null, 'k1')).toThrow(/not found/);
      expect(() => ctx.service.decryptStoredKey('garbage', 'k1')).toThrow(/cannot be decrypted/);
      ctx.tokens.getEncryptionSecret.mockReturnValue(undefined);
      expect(() => ctx.service.decryptStoredKey(enc, 'k1')).toThrow(/ENCRYPTION_KEY/);
    });
  });

  describe('clusterRevoke', () => {
    const row = { id: 'k1', user_id: 'u1', maas_key_id: 'mk1', maas_subscription_name: null };
    const seedSub = () =>
      ctx.k8s.seed(
        MAAS_SUBSCRIPTION,
        { metadata: { name: 'litemaas-key-k1', namespace: NS }, spec: {} },
        NS,
      );

    it('deletes the subscription, then revokes in maas-api with the user token', async () => {
      await seedSub();
      const order: string[] = [];
      const del = ctx.k8s.delete.bind(ctx.k8s);
      vi.spyOn(ctx.k8s, 'delete').mockImplementation(async (...a: any[]) => {
        order.push('k8s');
        return (del as any)(...a);
      });
      vi.spyOn(ctx.maasApi, 'revokeKey').mockImplementation(async () => {
        order.push('maas');
      });
      const res = await ctx.service.clusterRevoke(row);
      expect(order).toEqual(['k8s', 'maas']);
      expect(res).toEqual({ subscriptionDeleted: true, maasApiRevoked: true });
    });

    it('reports (but does not throw) a subscription failure unless asked to', async () => {
      vi.spyOn(ctx.k8s, 'delete').mockRejectedValue(new Error('apiserver down'));
      const res = await ctx.service.clusterRevoke(row);
      expect(res.subscriptionDeleted).toBe(false);
      expect(res.error).toBe('apiserver down');
      await expect(
        ctx.service.clusterRevoke(row, { throwOnSubscriptionError: true }),
      ).rejects.toThrow('apiserver down');
    });

    it('skips maas-api when the key has no maas id', async () => {
      const spy = vi.spyOn(ctx.maasApi, 'revokeKey');
      const res = await ctx.service.clusterRevoke({ ...row, maas_key_id: null });
      expect(res.maasApiRevoked).toBeNull();
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('provider revokeKey / updateKey', () => {
    it('revokeKey is a no-op for unknown keys and never throws on cluster errors', async () => {
      await expect(ctx.service.revokeKey('missing')).resolves.toBeUndefined();
      ctx.db.queryOne.mockResolvedValue({
        id: 'k1',
        user_id: 'u1',
        maas_key_id: 'mk',
        maas_subscription_name: null,
      });
      vi.spyOn(ctx.k8s, 'delete').mockRejectedValue(new Error('down'));
      await expect(ctx.service.revokeKey('k1')).resolves.toBeUndefined();
    });

    it('updateKey on an unknown key is a 404', async () => {
      await expect(ctx.service.updateKey('missing', { tpmLimit: 1 })).rejects.toMatchObject({
        statusCode: 404,
      });
    });
  });

  describe('createMaasBackend wiring', () => {
    it('exposes MaasKeyService as the key provider when a Fastify instance is given', () => {
      const backend = createMaasBackend(ctx.clients, ctx.fastify);
      expect(backend.keys).toBeInstanceOf(MaasKeyService);
      expect(backend.keys.type).toBe('maas');
    });
  });
});

describe('revokeInMaasApi', () => {
  function env(over: { userToken?: string | Error; sa?: string | undefined; revoke?: any } = {}) {
    const calls: string[] = [];
    const maasApi: any = {
      mock: false,
      revokeKey:
        over.revoke ??
        vi.fn().mockImplementation(async (t: string) => {
          calls.push(t);
        }),
    };
    const clients: any = { maasApi, serviceToken: () => over.sa };
    const tokens: any = {
      getValidToken: vi.fn().mockImplementation(async () => {
        if (over.userToken instanceof Error) throw over.userToken;
        return over.userToken;
      }),
    };
    const fastify: any = { log: { debug: vi.fn() } };
    return { clients, tokens, fastify, maasApi, calls };
  }

  it('prefers the user token', async () => {
    const e = env({ userToken: 'u', sa: 's' });
    expect(await revokeInMaasApi(e.fastify, e.clients, 'u1', 'mk', e.tokens)).toBe(true);
    expect(e.calls).toEqual(['u']);
  });

  it('falls back to the service account token', async () => {
    const e = env({ userToken: new Error('expired'), sa: 's' });
    expect(await revokeInMaasApi(e.fastify, e.clients, 'u1', 'mk', e.tokens)).toBe(true);
    expect(e.calls).toEqual(['s']);
  });

  it('tries the service account when the user token is rejected by maas-api', async () => {
    const revoke = vi
      .fn()
      .mockRejectedValueOnce(ApplicationError.maasReauthRequired('401'))
      .mockResolvedValueOnce(undefined);
    const e = env({ userToken: 'u', sa: 's', revoke });
    expect(await revokeInMaasApi(e.fastify, e.clients, 'u1', 'mk', e.tokens)).toBe(true);
    expect(revoke.mock.calls.map((c: any) => c[0])).toEqual(['u', 's']);
  });

  it('returns false without throwing when nothing works', async () => {
    const none = env({ userToken: new Error('x'), sa: undefined });
    expect(await revokeInMaasApi(none.fastify, none.clients, 'u1', 'mk', none.tokens)).toBe(false);
    expect(none.maasApi.revokeKey).not.toHaveBeenCalled();

    const failing = env({
      userToken: 'u',
      sa: 's',
      revoke: vi.fn().mockRejectedValue(new Error('down')),
    });
    expect(
      await revokeInMaasApi(failing.fastify, failing.clients, 'u1', 'mk', failing.tokens),
    ).toBe(false);
    expect(failing.maasApi.revokeKey).toHaveBeenCalledTimes(2);
  });
});
