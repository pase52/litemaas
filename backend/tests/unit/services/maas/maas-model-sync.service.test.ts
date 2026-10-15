import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MaasModelSyncService } from '../../../../src/services/maas/maas-model-sync.service';
import { InMemoryK8sClient } from '../../../../src/services/k8s/k8s-client';
import { MAAS_MODEL_REF } from '../../../../src/services/maas/maas-resources';

function ref(ns: string, name: string, phase = 'Ready', extra: Record<string, string> = {}) {
  return {
    metadata: { name, namespace: ns, annotations: extra },
    spec: { modelRef: { kind: 'LLMInferenceService', name } },
    status: { phase, endpoint: phase === 'Ready' ? `https://gw/${ns}/${name}` : undefined },
  };
}

function setup(modelNamespaces: string[] = []) {
  const k8s = new InMemoryK8sClient();
  const dbUtils = { queryOne: vi.fn(), queryMany: vi.fn(), query: vi.fn().mockResolvedValue({}) };
  const clients: any = {
    config: { namespace: 'models-as-a-service', modelNamespaces, syncIntervalMs: 1000 },
    k8s,
    maasApi: { mock: true },
    prometheus: { mock: true },
  };
  const fastify: any = {
    dbUtils,
    maasClients: clients,
    pg: { pool: {} },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
  return { k8s, dbUtils, service: new MaasModelSyncService(fastify, clients) };
}

const existing = (over: Record<string, unknown> = {}) => ({
  id: 'ns/a',
  availability: 'available',
  maas_model_ref_namespace: 'ns',
  maas_model_ref_name: 'a',
  maas_phase: 'Ready',
  maas_endpoint: 'https://gw/ns/a',
  backend_model_name: 'a',
  description: 'desc',
  name: 'A',
  metadata: {},
  ...over,
});

describe('MaasModelSyncService', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it('inserts new refs with maas backend, ns/name id, and phase-driven availability', async () => {
    ctx.k8s.seed(
      MAAS_MODEL_REF,
      ref('ns', 'a', 'Ready', {
        'openshift.io/display-name': 'Model A',
        'openshift.io/description': 'About A',
      }),
      'ns',
    );
    ctx.k8s.seed(MAAS_MODEL_REF, ref('ns', 'b', 'Failed'), 'ns');
    ctx.dbUtils.queryMany.mockResolvedValue([]);

    const result = await ctx.service.syncModels();
    expect(result).toMatchObject({ success: true, totalRefs: 2, newModels: 2 });

    const inserts = ctx.dbUtils.query.mock.calls.filter(([sql]) =>
      sql.includes('INSERT INTO models'),
    );
    expect(inserts).toHaveLength(2);
    const [, paramsA] = inserts[0];
    expect(paramsA.slice(0, 4)).toEqual(['ns/a', 'Model A', 'maas', 'About A']);
    expect(paramsA[6]).toBe('available');
    expect(paramsA[8]).toBe('a'); // backend_model_name
    expect(inserts[1][1][6]).toBe('unavailable');
  });

  it('skips the update when nothing cluster-owned changed', async () => {
    ctx.k8s.seed(MAAS_MODEL_REF, ref('ns', 'a'), 'ns');
    ctx.dbUtils.queryMany.mockResolvedValue([existing()]);
    const result = await ctx.service.syncModels();
    expect(result).toMatchObject({ newModels: 0, updatedModels: 0 });
    expect(ctx.dbUtils.query).not.toHaveBeenCalled();
  });

  it('update SQL never overwrites name, description (when set), pricing or limits', async () => {
    ctx.k8s.seed(MAAS_MODEL_REF, ref('ns', 'a', 'Pending'), 'ns');
    ctx.dbUtils.queryMany.mockResolvedValue([existing()]);
    const result = await ctx.service.syncModels();
    expect(result.updatedModels).toBe(1);
    const [sql, params] = ctx.dbUtils.query.mock.calls[0];
    expect(sql).not.toMatch(/\bname\s*=\s*\$/);
    expect(sql).not.toContain('input_cost_per_token');
    expect(sql).not.toContain('restricted_access');
    expect(sql).toContain("CASE WHEN description IS NULL OR description = ''");
    expect(params[1]).toBe('unavailable');
    expect(params[2]).toBe('Pending');
  });

  it('a Pending ref makes the model unavailable WITHOUT cascading', async () => {
    ctx.k8s.seed(MAAS_MODEL_REF, ref('ns', 'a', 'Pending'), 'ns');
    ctx.dbUtils.queryMany.mockResolvedValue([existing()]);
    const spy = vi.spyOn(ctx.service, 'markUnavailableWithCascade');
    const result = await ctx.service.syncModels();
    expect(spy).not.toHaveBeenCalled();
    expect(result.unavailableModels).toBe(0);
  });

  it('cascades for vanished refs, but only within scanned namespaces and not admin-removed ones', async () => {
    ctx = setup(['ns']);
    ctx.dbUtils.queryMany.mockResolvedValue([
      existing({ id: 'ns/gone', maas_model_ref_name: 'gone' }),
      existing({ id: 'other/x', maas_model_ref_namespace: 'other', maas_model_ref_name: 'x' }),
      existing({ id: 'ns/removed', metadata: { admin_removed: true } }),
    ]);
    const spy = vi.spyOn(ctx.service, 'markUnavailableWithCascade').mockResolvedValue({
      subscriptionsDeactivated: 2,
      apiKeyModelAssociationsRemoved: 1,
      orphanedApiKeysDeactivated: 0,
    });
    const result = await ctx.service.syncModels();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('ns/gone');
    expect(result.unavailableModels).toBe(1);
    expect(result.cascadeStatistics.subscriptionsDeactivated).toBe(2);
  });

  it('does not touch the database when listing refs fails', async () => {
    vi.spyOn(ctx.k8s, 'list').mockRejectedValue(new Error('forbidden'));
    const result = await ctx.service.syncModels();
    expect(result.success).toBe(false);
    expect(result.errors[0]).toContain('forbidden');
    expect(ctx.dbUtils.queryMany).not.toHaveBeenCalled();
    expect(ctx.dbUtils.query).not.toHaveBeenCalled();
  });

  it('only lists configured namespaces', async () => {
    ctx = setup(['ns1']);
    ctx.k8s.seed(MAAS_MODEL_REF, ref('ns1', 'a'), 'ns1');
    ctx.k8s.seed(MAAS_MODEL_REF, ref('ns2', 'b'), 'ns2');
    const refs = await ctx.service.listClusterRefs();
    expect(refs.map((r) => r.id)).toEqual(['ns1/a']);
  });

  it('records per-ref failures without aborting the pass', async () => {
    ctx.k8s.seed(MAAS_MODEL_REF, ref('ns', 'a'), 'ns');
    ctx.k8s.seed(MAAS_MODEL_REF, ref('ns', 'b'), 'ns');
    ctx.dbUtils.queryMany.mockResolvedValue([]);
    ctx.dbUtils.query.mockRejectedValueOnce(new Error('dup')).mockResolvedValue({});
    const result = await ctx.service.syncModels();
    expect(result.success).toBe(false);
    expect(result.newModels).toBe(1);
    expect(result.errors).toHaveLength(1);
  });
});
