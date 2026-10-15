import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  MaasReconcilerService,
  MAAS_RECONCILER_LOCK_ID,
} from '../../../../src/services/maas/maas-reconciler.service';
import { InMemoryK8sClient } from '../../../../src/services/k8s/k8s-client';

function setup(lockAcquired = true) {
  const k8s = new InMemoryK8sClient();
  const dbUtils = { queryOne: vi.fn(), queryMany: vi.fn().mockResolvedValue([]), query: vi.fn() };
  const client = {
    query: vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('pg_try_advisory_lock'))
        return { rows: [{ pg_try_advisory_lock: lockAcquired }] };
      return { rows: [{ pg_advisory_unlock: true }] };
    }),
    release: vi.fn(),
  };
  const clients: any = {
    config: { namespace: 'models-as-a-service', reconcileIntervalMs: 1000 },
    k8s,
    maasApi: { mock: true },
    prometheus: { mock: true },
  };
  const fastify: any = {
    dbUtils,
    maasClients: clients,
    pg: { pool: { connect: vi.fn().mockResolvedValue(client) } },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
  return { k8s, dbUtils, client, fastify, service: new MaasReconcilerService(fastify, clients) };
}

describe('MaasReconcilerService', () => {
  afterEach(() => vi.useRealTimers());

  it('skips (ran=false) without touching the cluster when another replica holds the lock', async () => {
    const ctx = setup(false);
    const list = vi.spyOn(ctx.k8s, 'list');
    const res = await ctx.service.reconcile();
    expect(res.ran).toBe(false);
    expect(list).not.toHaveBeenCalled();
    expect(ctx.client.query.mock.calls[0]).toEqual([
      'SELECT pg_try_advisory_lock($1)',
      [MAAS_RECONCILER_LOCK_ID],
    ]);
    expect(ctx.client.release).toHaveBeenCalled();
  });

  it('acquires and releases the advisory lock around a pass', async () => {
    const ctx = setup(true);
    const res = await ctx.service.reconcile();
    expect(res.ran).toBe(true);
    const sqls = ctx.client.query.mock.calls.map((c) => c[0]);
    expect(sqls).toContain('SELECT pg_advisory_unlock($1)');
  });

  it('does not run two passes concurrently in one process', async () => {
    const ctx = setup(true);
    const [a, b] = await Promise.all([ctx.service.reconcile(), ctx.service.reconcile()]);
    expect([a.ran, b.ran].sort()).toEqual([false, true]);
  });

  it('collects errors per object and keeps going', async () => {
    const ctx = setup(true);
    ctx.dbUtils.queryMany.mockImplementation(async (sql: string) =>
      sql.includes('FROM subscriptions s')
        ? [
            {
              user_id: 'u1',
              username: 'one',
              maas_model_ref_name: 'm',
              maas_model_ref_namespace: 'ns',
            },
            {
              user_id: 'u2',
              username: 'two',
              maas_model_ref_name: 'm',
              maas_model_ref_namespace: 'ns',
            },
          ]
        : [],
    );
    const create = vi.spyOn(ctx.k8s, 'create');
    create.mockRejectedValueOnce(new Error('quota')).mockImplementation(async (_r, o) => o as any);
    const res = await ctx.service.reconcile();
    expect(res.policiesApplied).toBe(1);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toContain('quota');
  });

  it('marks a key as error when its subscription cannot be applied', async () => {
    const ctx = setup(true);
    ctx.dbUtils.query.mockResolvedValue({});
    ctx.dbUtils.queryOne.mockResolvedValue({ ok: true });
    ctx.dbUtils.queryMany.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM api_keys ak'))
        return [
          {
            id: 'k1',
            user_id: 'u1',
            username: 'one',
            tpm_limit: null,
            model_tpm_limit: null,
            maas_key_id: 'mk',
            maas_subscription_name: null,
            maas_sync_state: 'pending',
            is_active: true,
            revoked_at: null,
            archived_at: null,
            expires_at: null,
          },
        ];
      if (sql.includes('FROM api_key_models'))
        return [
          {
            api_key_id: 'k1',
            model_id: 'ns/m',
            maas_model_ref_name: 'm',
            maas_model_ref_namespace: 'ns',
          },
        ];
      return [];
    });
    vi.spyOn(ctx.k8s, 'create').mockRejectedValue(new Error('apiserver down'));
    const res = await ctx.service.reconcile();
    expect(res.keysFailed).toBe(1);
    const update = ctx.dbUtils.query.mock.calls.find(([sql]) =>
      String(sql).includes("maas_sync_state = 'error'"),
    );
    expect(update?.[1]).toEqual(['k1', 'apiserver down']);
  });

  it('expired keys are treated as not live (subscription removed)', async () => {
    const ctx = setup(true);
    ctx.dbUtils.query.mockResolvedValue({});
    ctx.k8s.seed(
      { group: 'maas.opendatahub.io', version: 'v1alpha1', plural: 'maassubscriptions' },
      {
        metadata: {
          name: 'litemaas-key-k1',
          namespace: 'models-as-a-service',
          labels: { 'app.kubernetes.io/managed-by': 'litemaas', 'litemaas.io/api-key-id': 'k1' },
        },
        spec: {},
      },
      'models-as-a-service',
    );
    ctx.dbUtils.queryMany.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM api_keys ak'))
        return [
          {
            id: 'k1',
            user_id: 'u1',
            username: 'one',
            tpm_limit: null,
            model_tpm_limit: null,
            maas_key_id: null,
            maas_subscription_name: null,
            maas_sync_state: null,
            is_active: true,
            revoked_at: null,
            archived_at: null,
            expires_at: new Date(Date.now() - 1000),
          },
        ];
      if (sql.includes('FROM api_key_models'))
        return [
          {
            api_key_id: 'k1',
            model_id: 'ns/m',
            maas_model_ref_name: 'm',
            maas_model_ref_namespace: 'ns',
          },
        ];
      return [];
    });
    const res = await ctx.service.reconcile();
    expect(res.subscriptionsDeleted).toBe(1);
  });

  describe('start/stop', () => {
    it('runs on the configured interval and stops cleanly', async () => {
      vi.useFakeTimers();
      const ctx = setup(true);
      const spy = vi.spyOn(ctx.service, 'reconcile').mockResolvedValue({} as any);
      ctx.service.start();
      ctx.service.start(); // idempotent
      await vi.advanceTimersByTimeAsync(1000);
      expect(spy).toHaveBeenCalledTimes(1);
      ctx.service.stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(spy.mock.calls.length).toBeLessThanOrEqual(2); // + the one-off startup run
    });
  });

  describe('revocation race and pending revokes', () => {
    const keyRow = (over: Record<string, unknown> = {}) => ({
      id: 'k1',
      user_id: 'u1',
      username: 'one',
      tpm_limit: null,
      model_tpm_limit: null,
      maas_key_id: 'mk',
      maas_subscription_name: null,
      maas_sync_state: 'synced',
      maas_pending_revoke_ids: [],
      is_active: true,
      revoked_at: null,
      archived_at: null,
      expires_at: null,
      ...over,
    });
    const modelRow = {
      api_key_id: 'k1',
      model_id: 'ns/m',
      maas_model_ref_name: 'm',
      maas_model_ref_namespace: 'ns',
    };

    function wire(ctx: ReturnType<typeof setup>, key: Record<string, unknown>) {
      ctx.dbUtils.query.mockResolvedValue({});
      ctx.dbUtils.queryMany.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM api_keys ak')) return [key];
        if (sql.includes('FROM api_key_models')) return [modelRow];
        return [];
      });
    }

    it('only considers models with an active subscription of the key owner', async () => {
      const ctx = setup(true);
      wire(ctx, keyRow());
      ctx.dbUtils.queryOne.mockResolvedValue({ ok: true });
      await ctx.service.reconcile();
      const sql = String(
        ctx.dbUtils.queryMany.mock.calls.find(([q]) => String(q).includes('JOIN api_keys ak'))?.[0],
      );
      expect(sql).toContain("s.status = 'active'");
    });

    it('skips the upsert when the key was revoked after the snapshot was read', async () => {
      const ctx = setup(true);
      wire(ctx, keyRow());
      ctx.dbUtils.queryOne.mockResolvedValue({ ok: false });
      const create = vi.spyOn(ctx.k8s, 'create');
      const res = await ctx.service.reconcile();
      expect(create).not.toHaveBeenCalled();
      expect(res.subscriptionsApplied).toBe(0);
    });

    it('retries revoking old keys left over from a rotation, even for live keys', async () => {
      const ctx = setup(true);
      wire(ctx, keyRow({ maas_sync_state: 'pending', maas_pending_revoke_ids: ['old-1'] }));
      ctx.dbUtils.queryOne.mockResolvedValue({ ok: true });
      const res = await ctx.service.reconcile();
      const clear = ctx.dbUtils.query.mock.calls.find(([q]) =>
        String(q).includes('SET maas_pending_revoke_ids'),
      );
      // no token available in the test double -> stays pending and is counted
      expect(clear).toBeUndefined();
      expect(res.maasApiRevokePending).toBe(1);
    });
  });

  describe('abandoned key creation', () => {
    const keyRow = (createdMsAgo: number) => ({
      id: 'k1',
      user_id: 'u1',
      username: 'one',
      tpm_limit: null,
      model_tpm_limit: null,
      maas_key_id: null,
      maas_subscription_name: null,
      maas_sync_state: 'pending',
      maas_pending_revoke_ids: null,
      is_active: true,
      revoked_at: null,
      archived_at: null,
      expires_at: null,
      created_at: new Date(Date.now() - createdMsAgo),
    });
    const run = async (createdMsAgo: number) => {
      const ctx = setup(true);
      ctx.dbUtils.query.mockResolvedValue({});
      ctx.dbUtils.queryOne.mockResolvedValue({ ok: true });
      ctx.dbUtils.queryMany.mockImplementation(async (sql: string) =>
        sql.includes('FROM api_keys ak') ? [keyRow(createdMsAgo)] : [],
      );
      await ctx.service.reconcile();
      return ctx.dbUtils.query.mock.calls.map((c: any[]) => String(c[0]));
    };

    it('removes a stale pending row without maas_key_id', async () => {
      const sqls = await run(60 * 60_000);
      expect(sqls.some((q: string) => q.includes('DELETE FROM api_keys'))).toBe(true);
    });

    it('leaves a fresh pending row alone', async () => {
      const sqls = await run(30_000);
      expect(sqls.some((q: string) => q.includes('DELETE FROM api_keys'))).toBe(false);
    });
  });
});
