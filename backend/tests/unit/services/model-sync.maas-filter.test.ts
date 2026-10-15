import { describe, it, expect, vi } from 'vitest';
import { ModelSyncService } from '../../../src/services/model-sync.service';

/**
 * Regression: the LiteLLM sync must only consider backend_type='litellm' rows. MaaS models are
 * absent from LiteLLM's model table and would otherwise be marked unavailable (with cascade)
 * on every sync.
 */
describe('ModelSyncService - MaaS isolation', () => {
  function build(rows: Array<{ id: string }>) {
    const query = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('FROM models')) {
        // Emulate the DB honouring the backend_type filter
        const filtered = sql.includes("backend_type = 'litellm'")
          ? rows
          : [...rows, { id: 'ns/maas' }];
        return { rows: filtered };
      }
      return { rows: [] };
    });
    const fastify: any = {
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      dbUtils: { query, queryOne: vi.fn(), queryMany: vi.fn() },
      pg: { connect: vi.fn() },
      config: {},
    };
    const service = new ModelSyncService(fastify);
    (service as any).litellmService = { getModels: vi.fn().mockResolvedValue([]) };
    return { service, query, fastify };
  }

  it('selects existing models restricted to backend_type = litellm', async () => {
    const { service, query } = build([]);
    await service.syncModels();
    const sql = query.mock.calls.map((c) => String(c[0])).find((s) => s.includes('FROM models'))!;
    expect(sql).toContain("backend_type = 'litellm'");
  });

  it('never marks a MaaS model unavailable', async () => {
    const { service } = build([{ id: 'gone-litellm-model' }]);
    const mark = vi.spyOn(service, 'markModelUnavailable').mockResolvedValue({
      subscriptionsDeactivated: 0,
      apiKeyModelAssociationsRemoved: 0,
      orphanedApiKeysDeactivated: 0,
    });
    delete process.env.LITELLM_DATABASE_URL;
    await service.syncModels({ markUnavailable: true });
    const marked = mark.mock.calls.map((c) => c[0]);
    expect(marked).toEqual(['gone-litellm-model']);
    expect(marked).not.toContain('ns/maas');
  });
});
