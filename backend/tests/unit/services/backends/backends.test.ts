import { describe, it, expect, vi } from 'vitest';
import { BackendRegistry } from '../../../../src/services/backends/backend-registry';
import { isBackendType } from '../../../../src/services/backends/backend.types';
import {
  createLiteLLMBackend,
  LiteLLMModelBackend,
  LiteLLMKeyBackend,
  LiteLLMUsageBackend,
} from '../../../../src/services/backends/litellm.backend';
import {
  createMaasBackend,
  MaasModelBackend,
} from '../../../../src/services/backends/maas.backend';
import { InMemoryK8sClient } from '../../../../src/services/k8s/k8s-client';
import { MockMaasApiClient } from '../../../../src/services/maas/maas-api.client';
import { MockPrometheusClient } from '../../../../src/services/maas/prometheus.client';
import { seedMockCluster } from '../../../../src/services/maas/maas-clients';
import { getMaasConfig } from '../../../../src/services/maas/maas-config';

function litellmMock() {
  return {
    getModels: vi.fn(),
    getModelById: vi.fn(),
    getHealth: vi.fn(),
    generateApiKey: vi.fn(),
    updateKey: vi.fn(),
    deleteKey: vi.fn(),
    getDailyActivity: vi.fn(),
  } as any;
}

describe('isBackendType', () => {
  it('accepts only litellm and maas', () => {
    expect(isBackendType('litellm')).toBe(true);
    expect(isBackendType('maas')).toBe(true);
    expect(isBackendType('other')).toBe(false);
    expect(isBackendType(undefined)).toBe(false);
  });
});

describe('BackendRegistry', () => {
  it('registers, lists and resolves providers; unknown backend is a validation error', () => {
    const reg = new BackendRegistry();
    expect(reg.maasEnabled).toBe(false);
    reg.register(createLiteLLMBackend({} as any, litellmMock()));
    expect(reg.has('litellm')).toBe(true);
    expect(reg.has('maas')).toBe(false);
    expect(reg.types()).toEqual(['litellm']);
    expect(reg.get('litellm').type).toBe('litellm');
    expect(() => reg.get('maas')).toThrowError(/not enabled/);
    reg.register(createMaasBackend({} as any));
    expect(reg.maasEnabled).toBe(true);
    expect(reg.list()).toHaveLength(2);
  });
});

describe('LiteLLM backend (delegation)', () => {
  it('models: maps and delegates', async () => {
    const l = litellmMock();
    const raw = {
      model_name: 'gpt',
      litellm_params: { api_base: 'http://x' },
      model_info: { id: 'mid' },
    };
    l.getModels.mockResolvedValue([raw]);
    l.getModelById.mockResolvedValue(raw);
    l.getHealth.mockResolvedValue({ status: 'healthy', db: 'connected' });
    const b = new LiteLLMModelBackend(l);
    expect(await b.listModels({ refresh: true })).toEqual([
      {
        id: 'mid',
        name: 'gpt',
        backendModelName: 'gpt',
        endpoint: 'http://x',
        available: true,
        raw,
      },
    ]);
    expect(l.getModels).toHaveBeenCalledWith({ refresh: true });
    expect((await b.getModel('mid'))!.id).toBe('mid');
    l.getModelById.mockResolvedValue(null);
    expect(await b.getModel('zz')).toBeNull();
    expect((await b.checkHealth()).status).toBe('healthy');
    l.getHealth.mockResolvedValue({ status: 'unhealthy', db: 'x' });
    expect((await b.checkHealth()).status).toBe('unhealthy');
  });

  it('keys: create/update/revoke delegate to LiteLLMService', async () => {
    const l = litellmMock();
    l.generateApiKey.mockResolvedValue({
      key: 'sk-1',
      key_name: 'n',
      expires: '2030-01-01T00:00:00Z',
    });
    const b = new LiteLLMKeyBackend(l);
    const res = await b.createKey({
      keyId: 'k',
      userId: 'u',
      username: 'alice',
      name: 'my-key',
      modelIds: ['a', 'b'],
      tpmLimit: 100,
      providerOptions: { max_budget: 5 },
    });
    expect(l.generateApiKey).toHaveBeenCalledWith(
      expect.objectContaining({
        key_alias: 'my-key',
        user_id: 'u',
        models: ['a', 'b'],
        tpm_limit: 100,
        max_budget: 5,
      }),
    );
    expect(res.key).toBe('sk-1');
    expect(res.backendKeyId).toBe('sk-1');
    expect(res.expiresAt).toEqual(new Date('2030-01-01T00:00:00Z'));

    await b.updateKey('sk-1', { modelIds: ['a'], tpmLimit: 5 });
    expect(l.updateKey).toHaveBeenCalledWith('sk-1', { models: ['a'], tpm_limit: 5 });
    await b.revokeKey('sk-1');
    expect(l.deleteKey).toHaveBeenCalledWith('sk-1');
  });

  it('usage: transforms daily activity and returns null for empty days', async () => {
    const l = litellmMock();
    const u = new LiteLLMUsageBackend(l);
    l.getDailyActivity.mockResolvedValue({
      api_requests: 3,
      total_tokens: 30,
      prompt_tokens: 10,
      completion_tokens: 20,
      spend: 1.5,
      daily_metrics: [
        {
          breakdown: {
            models: {
              m1: { metrics: { api_requests: 3, total_tokens: 30 }, api_key_breakdown: { h: {} } },
            },
          },
        },
      ],
    });
    const day = await u.getDayData('2026-01-02');
    expect(l.getDailyActivity).toHaveBeenCalledWith(undefined, '2026-01-02', '2026-01-02');
    expect(day!.metrics).toMatchObject({ api_requests: 3, total_tokens: 30, spend: 1.5 });
    expect(day!.breakdown.models.m1.api_keys).toEqual({ h: {} });
    expect(day!.breakdown.models.m1.metrics.prompt_tokens).toBe(0);

    l.getDailyActivity.mockResolvedValue({ api_requests: 0 });
    expect(await u.getDayData('2026-01-03')).toBeNull();
  });
});

describe('MaaS backend', () => {
  const clients = () => {
    const k8s = new InMemoryK8sClient();
    seedMockCluster(k8s, 'ns1');
    return {
      config: getMaasConfig({ MAAS_ENABLED: 'true' }),
      k8s,
      maasApi: new MockMaasApiClient(),
      prometheus: new MockPrometheusClient(),
    };
  };

  it('lists models from MaaSModelRefs with <namespace>/<name> ids', async () => {
    const b = new MaasModelBackend(clients());
    const models = await b.listModels();
    expect(models.map((m) => m.id).sort()).toEqual([
      'ns1/granite-3-3-8b',
      'ns1/llama-3-2-3b',
      'ns1/qwen3-32b',
    ]);
    const llama = models.find((m) => m.id === 'ns1/llama-3-2-3b')!;
    expect(llama).toMatchObject({
      name: 'Llama 3.2 3B Instruct',
      backendModelName: 'llama-3-2-3b',
      available: true,
    });
    expect(models.find((m) => m.id === 'ns1/qwen3-32b')!.available).toBe(false); // Pending
  });

  it('restricts listing to MAAS_MODEL_NAMESPACES', async () => {
    const c = clients();
    seedMockCluster(c.k8s as InMemoryK8sClient, 'ns2');
    c.config = getMaasConfig({ MAAS_ENABLED: 'true', MAAS_MODEL_NAMESPACES: 'ns2' });
    const models = await new MaasModelBackend(c).listModels();
    expect(models.every((m) => m.id.startsWith('ns2/'))).toBe(true);
    expect(models).toHaveLength(3);
  });

  it('getModel resolves by id and tolerates malformed ids', async () => {
    const b = new MaasModelBackend(clients());
    expect((await b.getModel('ns1/llama-3-2-3b'))!.id).toBe('ns1/llama-3-2-3b');
    expect(await b.getModel('ns1/missing')).toBeNull();
    expect(await b.getModel('no-namespace')).toBeNull();
    expect(await b.getModel('/x')).toBeNull();
  });

  it('health reflects maas-api health', async () => {
    const c = clients();
    expect((await new MaasModelBackend(c).checkHealth()).status).toBe('healthy');
    c.maasApi = {
      ...c.maasApi,
      mock: false,
      health: async () => ({ healthy: false, message: 'down' }),
    } as any;
    expect(await new MaasModelBackend(c).checkHealth()).toMatchObject({
      status: 'unhealthy',
      message: 'down',
    });
  });

  it('key lifecycle and usage are stubs that fail loudly until implemented', async () => {
    const p = createMaasBackend(clients());
    await expect(p.keys.createKey({} as any)).rejects.toThrow(/not implemented/);
    await expect(p.keys.updateKey('x', {})).rejects.toThrow(/not implemented/);
    await expect(p.keys.revokeKey('x')).rejects.toThrow(/not implemented/);
    await expect(p.usage.getDayData('2026-01-01')).rejects.toThrow(/not implemented/);
  });
});
