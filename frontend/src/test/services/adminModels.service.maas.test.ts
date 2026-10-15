import { describe, it, expect, vi, beforeEach } from 'vitest';
import { adminModelsService } from '../../services/adminModels.service';
import { apiClient } from '../../services/api';

vi.mock('../../services/api', () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

describe('adminModelsService MaaS endpoints', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('migrateToMaas URL-encodes the id and unwraps the { data } envelope', async () => {
    const data = {
      oldModelId: 'openai/gpt-4',
      newModelId: 'ns/gpt-4',
      created: true,
      graceUntil: '2030-01-01T00:00:00.000Z',
      subscriptionsCopied: 3,
      usersNotified: 3,
      policyFailures: 0,
    };
    vi.mocked(apiClient.post).mockResolvedValue({
      data,
      message: 'Model migration to MaaS started',
    });

    const result = await adminModelsService.migrateToMaas('openai/gpt-4', {
      maasModelRef: { name: 'gpt-4', namespace: 'ns' },
      graceDays: 14,
    });

    expect(apiClient.post).toHaveBeenCalledWith('/admin/models/openai%2Fgpt-4/migrate-to-maas', {
      maasModelRef: { name: 'gpt-4', namespace: 'ns' },
      graceDays: 14,
    });
    expect(result).toEqual(data);
  });

  it('getMaasRefs unwraps the data array and syncMaasModels returns the flat result', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [{ id: 'ns/a', name: 'a' }] });
    expect(await adminModelsService.getMaasRefs()).toEqual([{ id: 'ns/a', name: 'a' }]);
    expect(apiClient.get).toHaveBeenCalledWith('/admin/models/maas/refs');

    vi.mocked(apiClient.post).mockResolvedValue({ success: true, totalRefs: 2 });
    expect(await adminModelsService.syncMaasModels(true)).toEqual({ success: true, totalRefs: 2 });
    expect(apiClient.post).toHaveBeenCalledWith('/admin/models/maas/sync', {
      restoreRemoved: true,
    });
  });
});
