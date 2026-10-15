import { describe, it, expect, vi, beforeEach } from 'vitest';
import { subscriptionsService } from '../../services/subscriptions.service';
import { apiClient } from '../../services/api';

vi.mock('../../services/api', () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
}));

const backendSubscription = (overrides: Record<string, unknown> = {}) => ({
  id: 'sub-1',
  userId: 'user-1',
  modelId: 'gpt-4',
  status: 'active',
  quotaRequests: 1000,
  quotaTokens: 100000,
  usedRequests: 10,
  usedTokens: 1000,
  remainingRequests: 990,
  remainingTokens: 99000,
  utilizationPercent: { requests: 1, tokens: 1 },
  createdAt: '2025-01-01T00:00:00Z',
  updatedAt: '2025-01-01T00:00:00Z',
  ...overrides,
});

describe('subscriptionsService MaaS mapping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('maps modelBackendType, modelMigrationState and modelMigrationGraceUntil', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({
      data: [
        backendSubscription({
          modelId: 'gpt-4',
          modelBackendType: 'litellm',
          modelMigrationState: 'migrating',
          modelMigrationGraceUntil: '2030-01-01T00:00:00Z',
        }),
        backendSubscription({
          id: 'sub-2',
          modelId: 'maas-demo/llama-3',
          modelBackendType: 'maas',
        }),
      ],
      total: 2,
    });

    const { data } = await subscriptionsService.getSubscriptions();

    expect(data[0]).toMatchObject({
      backendType: 'litellm',
      migrationState: 'migrating',
      migrationGraceUntil: '2030-01-01T00:00:00Z',
    });
    expect(data[1].backendType).toBe('maas');
    expect(data[1].migrationState).toBeUndefined();
    expect(data[1].migrationGraceUntil).toBeUndefined();
  });

  it('never infers the backend from a "/" in the model id', async () => {
    // LiteLLM model names such as "openai/gpt-4" contain a slash too
    vi.mocked(apiClient.get).mockResolvedValue({
      data: [backendSubscription({ modelId: 'openai/gpt-4' })],
      total: 1,
    });

    const { data } = await subscriptionsService.getSubscriptions();

    expect(data[0].modelId).toBe('openai/gpt-4');
    expect(data[0].backendType).toBeUndefined();
  });

  it('applies the same mapping to a single subscription and to a created one', async () => {
    const response = backendSubscription({
      modelId: 'maas-demo/llama-3',
      modelBackendType: 'maas',
      modelMigrationState: 'completed',
      modelMigrationGraceUntil: '2030-01-01T00:00:00Z',
    });
    vi.mocked(apiClient.get).mockResolvedValue(response);
    vi.mocked(apiClient.post).mockResolvedValue(response);

    const fetched = await subscriptionsService.getSubscription('sub-1');
    const created = await subscriptionsService.createSubscription({
      modelId: 'maas-demo/llama-3',
    });

    for (const subscription of [fetched, created]) {
      expect(subscription).toMatchObject({
        modelId: 'maas-demo/llama-3',
        backendType: 'maas',
        migrationState: 'completed',
        migrationGraceUntil: '2030-01-01T00:00:00Z',
      });
    }
  });
});
