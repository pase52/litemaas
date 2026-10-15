import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiKeyService } from '../../../src/services/api-key.service.js';
import type { FastifyInstance } from 'fastify';

/**
 * Backend routing at the top of ApiKeyService's public methods: MaaS keys are delegated to
 * MaasKeyService, LiteLLM keys never touch it, and with MaaS disabled no extra queries run.
 */
describe('ApiKeyService - MaaS branching', () => {
  let service: ApiKeyService;
  let fastify: any;
  let db: any;
  let litellm: any;
  let maas: any;

  const maasRow = {
    id: 'k1',
    user_id: 'u1',
    name: 'key',
    key_hash: 'maas:litemaas-key-k1',
    key_prefix: 'sk-oai-abcd',
    is_active: true,
    created_at: new Date(),
    backend_type: 'maas',
    maas_key_id: 'mk1',
    maas_subscription_name: 'litemaas-key-k1',
    maas_sync_state: 'synced',
    lite_llm_key_value: null,
  };

  beforeEach(() => {
    db = { query: vi.fn(), queryOne: vi.fn(), queryMany: vi.fn(), withTransaction: vi.fn() };
    fastify = {
      dbUtils: db,
      pg: { connect: vi.fn() },
      log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      createNotFoundError: vi.fn().mockImplementation((m) => new Error(m)),
      maasClients: { config: { gatewayUrl: 'https://gw' } },
    };
    litellm = {
      generateApiKey: vi.fn(),
      updateKey: vi.fn(),
      deleteKey: vi.fn(),
      getKeyInfo: vi.fn(),
    };
    maas = {
      resolveBackend: vi.fn(),
      findMaasModelIds: vi.fn(),
      createApiKey: vi.fn(),
      updateLimits: vi.fn(),
      updateModels: vi.fn(),
      updateMetadata: vi.fn(),
      getKeyRow: vi.fn(),
      revokeApiKey: vi.fn(),
      deleteApiKey: vi.fn(),
      rotateApiKey: vi.fn(),
      cleanupExpiredKeys: vi.fn().mockResolvedValue(0),
      removeModelFromKey: vi.fn(),
      revokeForArchive: vi.fn(),
      decryptStoredKey: vi.fn(),
      updateExpiration: vi.fn(),
    };
    service = new ApiKeyService(fastify as FastifyInstance, litellm, maas);
    vi.spyOn(service as any, 'shouldUseMockData').mockReturnValue(false);
  });

  describe('resolveCreateBackend', () => {
    it('is litellm without any database access when MaaS is disabled', async () => {
      fastify.maasClients = undefined;
      await expect(service.resolveCreateBackend(['m1'])).resolves.toBe('litellm');
      await expect(service.resolveCreateBackend(['m1'], 'litellm')).resolves.toBe('litellm');
      expect(maas.resolveBackend).not.toHaveBeenCalled();
      expect(db.queryMany).not.toHaveBeenCalled();
    });

    it('rejects an explicit maas backend when MaaS is disabled (400)', async () => {
      fastify.maasClients = undefined;
      await expect(service.resolveCreateBackend(['m1'], 'maas')).rejects.toMatchObject({
        statusCode: 400,
      });
    });

    it('delegates to MaasKeyService when enabled', async () => {
      maas.resolveBackend.mockResolvedValue('maas');
      await expect(service.resolveCreateBackend(['m1'], 'maas')).resolves.toBe('maas');
      expect(maas.resolveBackend).toHaveBeenCalledWith(['m1'], 'maas');
    });
  });

  describe('createApiKey', () => {
    it('hands MaaS requests to MaasKeyService and adds the gateway base URL', async () => {
      maas.resolveBackend.mockResolvedValue('maas');
      maas.createApiKey.mockResolvedValue({ id: 'k1', key: 'sk-oai-x', backendType: 'maas' });
      const result = await service.createApiKey('u1', {
        modelIds: ['ns/a'],
        name: 'n',
        tpmLimit: 10,
      });
      expect(maas.createApiKey).toHaveBeenCalledWith(
        'u1',
        expect.objectContaining({ modelIds: ['ns/a'], tpmLimit: 10 }),
      );
      expect(result).toMatchObject({ id: 'k1', baseUrl: 'https://gw' });
      expect(litellm.generateApiKey).not.toHaveBeenCalled();
    });

    it('rejects legacy subscriptionId requests that resolve to MaaS models', async () => {
      maas.resolveBackend.mockResolvedValue('maas');
      db.queryOne.mockResolvedValueOnce({ model_id: 'ns/a', status: 'active' });
      await expect(
        service.createApiKey('u1', { subscriptionId: 's1' } as any),
      ).rejects.toMatchObject({ statusCode: 400 });
      expect(maas.createApiKey).not.toHaveBeenCalled();
    });

    it('rejects backendType maas when MaaS is disabled before touching LiteLLM', async () => {
      fastify.maasClients = undefined;
      await expect(
        service.createApiKey('u1', { modelIds: ['m'], backendType: 'maas' }),
      ).rejects.toMatchObject({ statusCode: 400 });
      expect(litellm.generateApiKey).not.toHaveBeenCalled();
    });

    it('propagates a mixed-backend rejection', async () => {
      maas.resolveBackend.mockRejectedValue(new Error('cannot mix'));
      await expect(service.createApiKey('u1', { modelIds: ['a', 'b'] })).rejects.toThrow(
        'cannot mix',
      );
      expect(litellm.generateApiKey).not.toHaveBeenCalled();
    });
  });

  describe('per-method delegation for MaaS rows', () => {
    beforeEach(() => {
      // getApiKey: row, then the model association lookup
      db.queryOne.mockResolvedValue(maasRow);
      db.queryMany.mockResolvedValue([{ model_id: 'ns/a' }]);
    });

    it('getApiKey exposes MaaS fields and no LiteLLM key', async () => {
      const key = await service.getApiKey('k1', 'u1');
      expect(key).toMatchObject({
        backendType: 'maas',
        maasKeyId: 'mk1',
        maasSubscriptionName: 'litemaas-key-k1',
        maasSyncState: 'synced',
      });
      expect(key?.liteLLMKey).toBeUndefined();
    });

    it('revokeApiKey -> maas revoke, no LiteLLM delete', async () => {
      await service.revokeApiKey('k1', 'u1', 'why');
      expect(maas.revokeApiKey).toHaveBeenCalledWith('k1', 'u1', 'why');
      expect(litellm.deleteKey).not.toHaveBeenCalled();
    });

    it('deleteApiKey -> maas delete', async () => {
      await service.deleteApiKey('k1', 'u1');
      expect(maas.deleteApiKey).toHaveBeenCalledWith('k1', 'u1');
      expect(litellm.deleteKey).not.toHaveBeenCalled();
    });

    it('rotateApiKey -> maas rotate', async () => {
      maas.rotateApiKey.mockResolvedValue({ id: 'k1', key: 'sk-oai-new', keyPrefix: 'sk-oai-new' });
      await expect(service.rotateApiKey('k1', 'u1')).resolves.toMatchObject({ key: 'sk-oai-new' });
      expect(litellm.generateApiKey).not.toHaveBeenCalled();
    });

    it('updateApiKeyLimits -> maas updateLimits, mapped back', async () => {
      maas.updateLimits.mockResolvedValue({ ...maasRow, tpm_limit: 99, models: ['ns/a'] });
      const res = await service.updateApiKeyLimits('k1', 'u1', { tpmLimit: 99 });
      expect(maas.updateLimits).toHaveBeenCalledWith('k1', 'u1', { tpmLimit: 99 });
      expect(res).toMatchObject({ tpmLimit: 99, backendType: 'maas', models: ['ns/a'] });
      expect(litellm.updateKey).not.toHaveBeenCalled();
    });

    it('updateApiKey routes models and name/metadata separately', async () => {
      maas.updateModels.mockResolvedValue({ ...maasRow, models: ['ns/b'] });
      maas.updateMetadata.mockResolvedValue({ ...maasRow, name: 'new', models: ['ns/b'] });
      const res = await service.updateApiKey('k1', 'u1', { modelIds: ['ns/b'], name: 'new' });
      expect(maas.updateModels).toHaveBeenCalledWith('k1', 'u1', ['ns/b']);
      expect(maas.updateMetadata).toHaveBeenCalledWith('k1', 'u1', {
        name: 'new',
        metadata: undefined,
      });
      expect(res.name).toBe('new');
      expect(litellm.updateKey).not.toHaveBeenCalled();
    });

    it('resetApiKeySpend is rejected (400) for MaaS keys', async () => {
      await expect(service.resetApiKeySpend('k1', 'u1')).rejects.toMatchObject({ statusCode: 400 });
      expect(litellm.updateKey).not.toHaveBeenCalled();
    });

    it('updateMaasExpiration maps the updated row', async () => {
      const when = new Date(Date.now() + 1000);
      maas.updateExpiration.mockResolvedValue({ ...maasRow, expires_at: when });
      const res = await service.updateMaasExpiration('k1', 'u1', when);
      expect(res.expiresAt).toEqual(when);
    });
  });

  describe('LiteLLM rows are untouched', () => {
    const liteRow = {
      ...maasRow,
      backend_type: 'litellm',
      key_hash: 'h',
      lite_llm_key_value: 'sk-lite',
    };

    it('revoke deletes in LiteLLM and never calls MaasKeyService', async () => {
      db.queryOne.mockResolvedValue(liteRow);
      db.queryMany.mockResolvedValue([]);
      await service.revokeApiKey('k1', 'u1');
      expect(litellm.deleteKey).toHaveBeenCalledWith('sk-lite');
      expect(maas.revokeApiKey).not.toHaveBeenCalled();
    });

    it('limits update goes to LiteLLM', async () => {
      db.queryOne.mockResolvedValueOnce(liteRow).mockResolvedValue(liteRow);
      db.queryMany.mockResolvedValue([]);
      await service.updateApiKeyLimits('k1', 'u1', { tpmLimit: 5 });
      expect(litellm.updateKey).toHaveBeenCalled();
      expect(maas.updateLimits).not.toHaveBeenCalled();
    });

    it('a LiteLLM key cannot take MaaS models when MaaS is enabled', async () => {
      db.queryOne.mockResolvedValue(liteRow);
      db.queryMany.mockResolvedValue([]);
      maas.resolveBackend.mockRejectedValue(new Error('selected models are served by maas'));
      await expect(service.updateApiKey('k1', 'u1', { modelIds: ['ns/a'] })).rejects.toThrow(
        /served by maas/,
      );
      expect(maas.resolveBackend).toHaveBeenCalledWith(['ns/a'], 'litellm');
    });
  });

  describe('retrieveFullKey', () => {
    it('decrypts the stored MaaS key', async () => {
      db.queryOne.mockResolvedValue({
        ...maasRow,
        encrypted_key: 'cipher',
        expires_at: null,
        last_used_at: null,
      });
      maas.decryptStoredKey.mockReturnValue('sk-oai-plain');
      db.query.mockResolvedValue({});
      await expect(service.retrieveFullKey('k1', 'u1')).resolves.toBe('sk-oai-plain');
      expect(maas.decryptStoredKey).toHaveBeenCalledWith('cipher', 'k1');
    });

    it('still returns the LiteLLM key for litellm rows', async () => {
      db.queryOne.mockResolvedValue({
        id: 'k1',
        is_active: true,
        expires_at: null,
        lite_llm_key_value: 'sk-lite',
        backend_type: 'litellm',
      });
      db.query.mockResolvedValue({});
      await expect(service.retrieveFullKey('k1', 'u1')).resolves.toBe('sk-lite');
      expect(maas.decryptStoredKey).not.toHaveBeenCalled();
    });
  });

  describe('cleanupExpiredKeys', () => {
    function txReturning(rows: any[]) {
      db.withTransaction.mockImplementation(async (cb: any) =>
        cb({ query: vi.fn().mockResolvedValue({ rows }) }),
      );
    }

    it('cleans MaaS keys first and adds them to the count', async () => {
      maas.cleanupExpiredKeys.mockResolvedValue(2);
      txReturning([]);
      await expect(service.cleanupExpiredKeys()).resolves.toBe(2);
    });

    it('skips the MaaS pass entirely when MaaS is disabled', async () => {
      fastify.maasClients = undefined;
      txReturning([]);
      await expect(service.cleanupExpiredKeys()).resolves.toBe(0);
      expect(maas.cleanupExpiredKeys).not.toHaveBeenCalled();
    });

    it('a failing MaaS pass does not block LiteLLM cleanup', async () => {
      maas.cleanupExpiredKeys.mockRejectedValue(new Error('cluster down'));
      txReturning([]);
      await expect(service.cleanupExpiredKeys()).resolves.toBe(0);
    });
  });

  describe('removeModelFromUserApiKeys', () => {
    it('applies the cluster change first and only then the database for MaaS keys', async () => {
      const order: string[] = [];
      db.queryMany.mockResolvedValue([
        { id: 'k1', lite_llm_key_value: null, backend_type: 'maas', maas_key_id: 'mk1' },
      ]);
      maas.removeModelFromKey.mockImplementation(async () => order.push('cluster'));
      db.withTransaction.mockImplementation(async (cb: any) => {
        order.push('db');
        return cb({ query: vi.fn() });
      });
      await service.removeModelFromUserApiKeys('u1', 'ns/a');
      expect(order).toEqual(['cluster', 'db']);
      expect(maas.removeModelFromKey).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'k1', user_id: 'u1', maas_key_id: 'mk1' }),
        'ns/a',
      );
      expect(litellm.deleteKey).not.toHaveBeenCalled();
    });

    it('leaves the database untouched when the cluster update fails', async () => {
      db.queryMany.mockResolvedValue([
        { id: 'k1', lite_llm_key_value: null, backend_type: 'maas' },
      ]);
      maas.removeModelFromKey.mockRejectedValue(new Error('apiserver down'));
      await service.removeModelFromUserApiKeys('u1', 'ns/a');
      expect(db.withTransaction).not.toHaveBeenCalled();
    });
  });

  describe('archiveApiKey', () => {
    it('revokes MaaS keys on the cluster before archiving and propagates failures', async () => {
      const order: string[] = [];
      db.queryOne
        .mockResolvedValueOnce({
          id: 'k1',
          archived_at: null,
          is_active: true,
          backend_type: 'maas',
          maas_key_id: 'mk1',
          maas_subscription_name: 'litemaas-key-k1',
        })
        .mockImplementationOnce(async () => {
          order.push('db');
          return { archived_at: new Date() };
        });
      maas.revokeForArchive.mockImplementation(async () => order.push('cluster'));
      await service.archiveApiKey('k1', 'u1');
      expect(order).toEqual(['cluster', 'db']);
      expect(litellm.deleteKey).not.toHaveBeenCalled();

      db.queryOne.mockReset();
      db.queryOne.mockResolvedValueOnce({
        id: 'k2',
        archived_at: null,
        is_active: true,
        backend_type: 'maas',
      });
      maas.revokeForArchive.mockRejectedValue(new Error('apiserver down'));
      await expect(service.archiveApiKey('k2', 'u1')).rejects.toThrow('apiserver down');
    });

    it('does not revoke an already inactive MaaS key again', async () => {
      db.queryOne
        .mockResolvedValueOnce({
          id: 'k1',
          archived_at: null,
          is_active: false,
          backend_type: 'maas',
        })
        .mockResolvedValueOnce({ archived_at: new Date() });
      await service.archiveApiKey('k1', 'u1');
      expect(maas.revokeForArchive).not.toHaveBeenCalled();
    });
  });
});
