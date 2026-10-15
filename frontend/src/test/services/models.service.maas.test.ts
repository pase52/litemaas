import { describe, it, expect, vi, beforeEach } from 'vitest';
import { modelsService } from '../../services/models.service';
import { apiClient } from '../../services/api';

vi.mock('../../services/api', () => ({
  apiClient: { get: vi.fn(), post: vi.fn() },
}));

const backendModel = (overrides: Record<string, unknown>) => ({
  id: 'm1',
  name: 'Model 1',
  provider: 'p',
  description: '',
  capabilities: ['chat'],
  contextLength: 1000,
  pricing: { input: 0, output: 0, unit: 'token' },
  isActive: true,
  createdAt: '',
  updatedAt: '',
  ...overrides,
});

describe('modelsService backend mapping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('maps MaaS backend fields', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({
      data: [
        backendModel({
          id: 'ns/llama',
          backendType: 'maas',
          maasEndpoint: 'https://maas/x',
          migrationState: 'migrated',
          migrationGraceUntil: '2030-01-01T00:00:00Z',
        }),
      ],
      pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
    });
    const { models } = await modelsService.getModels();
    expect(models[0].backendType).toBe('maas');
    expect(models[0].maasEndpoint).toBe('https://maas/x');
    expect(models[0].migrationState).toBe('migrated');
    expect(models[0].migrationGraceUntil).toBe('2030-01-01T00:00:00Z');
  });

  it('defaults to litellm when the backend does not send backendType', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({
      data: [backendModel({})],
      pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
    });
    const { models } = await modelsService.getModels();
    expect(models[0].backendType).toBe('litellm');
    expect(models[0].maasEndpoint).toBeUndefined();
  });

  it('URL-encodes ids containing a slash', async () => {
    vi.mocked(apiClient.get).mockResolvedValue(
      backendModel({ id: 'ns/llama', backendType: 'maas' }),
    );
    await modelsService.getModel('ns/llama');
    expect(apiClient.get).toHaveBeenCalledWith('/models/ns%2Fllama');
  });
});
