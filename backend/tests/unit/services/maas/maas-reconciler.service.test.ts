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
    ctx.dbUtils.queryOne.mockImplementation(async (sql: string, params?: unknown[]) =>
      sql.includes('SELECT username')
        ? { username: params?.[0] === 'u1' ? 'one' : 'two' }
        : undefined,
    );
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
    ctx.dbUtils.queryOne.mockResolvedValue({
      id: 'k1',
      user_id: 'u1',
      username: 'one',
      tpm_limit: null,
      model_tpm_limit: null,
      maas_subscription_name: null,
      live: true,
    });
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

    /** `fresh` = what the pre-write re-read of the key returns (null: not live any more) */
    function wire(
      ctx: ReturnType<typeof setup>,
      key: Record<string, unknown>,
      fresh: Record<string, unknown> | null = { ...key, live: true },
    ) {
      ctx.dbUtils.query.mockResolvedValue({});
      ctx.dbUtils.queryOne.mockResolvedValue(fresh ?? { live: false });
      ctx.dbUtils.queryMany.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM api_keys ak')) return [key];
        if (sql.includes('FROM api_key_models')) return [modelRow];
        return [];
      });
    }

    it('only considers models with an active subscription of the key owner', async () => {
      const ctx = setup(true);
      wire(ctx, keyRow());
      await ctx.service.reconcile();
      const sql = String(
        ctx.dbUtils.queryMany.mock.calls.find(([q]) => String(q).includes('JOIN api_keys ak'))?.[0],
      );
      expect(sql).toContain("s.status = 'active'");
    });

    it('skips the upsert when the key was revoked after the snapshot was read', async () => {
      const ctx = setup(true);
      wire(ctx, keyRow(), null);
      const create = vi.spyOn(ctx.k8s, 'create');
      const res = await ctx.service.reconcile();
      expect(create).not.toHaveBeenCalled();
      expect(res.subscriptionsApplied).toBe(0);
    });

    it('writes the fresh key state (not the snapshot) when the key changed during the pass', async () => {
      const ctx = setup(true);
      // snapshot says 100 TPM, the key was tightened to 50 before the write
      wire(ctx, keyRow({ tpm_limit: 100 }), { ...keyRow({ tpm_limit: 50 }), live: true });
      const res = await ctx.service.reconcile();
      expect(res.subscriptionsApplied).toBe(1);
      const sub = await ctx.k8s.get(
        { group: 'maas.opendatahub.io', version: 'v1alpha1', plural: 'maassubscriptions' },
        'litemaas-key-k1',
        'models-as-a-service',
      );
      expect(sub!.spec!.modelRefs[0].tokenRateLimits).toEqual([{ limit: 50, window: '1m' }]);
    });

    it('retries revoking old keys left over from a rotation, even for live keys', async () => {
      const ctx = setup(true);
      wire(ctx, keyRow({ maas_sync_state: 'pending', maas_pending_revoke_ids: ['old-1'] }));
      const res = await ctx.service.reconcile();
      const clear = ctx.dbUtils.query.mock.calls.find(([q]) =>
        String(q).includes('SET maas_pending_revoke_ids'),
      );
      // no token available in the test double -> stays pending and is counted
      expect(clear).toBeUndefined();
      expect(res.maasApiRevokePending).toBe(1);
    });
  });

  describe('convergence against a real API server', () => {
    const SUB_REF = {
      group: 'maas.opendatahub.io',
      version: 'v1alpha1',
      plural: 'maassubscriptions',
    };
    const POLICY_REF = {
      group: 'maas.opendatahub.io',
      version: 'v1alpha1',
      plural: 'maasauthpolicies',
    };
    /** kube-apiserver re-serialises objects with sorted keys */
    const sortKeys = (v: any): any =>
      Array.isArray(v)
        ? v.map(sortKeys)
        : v && typeof v === 'object'
          ? Object.fromEntries(
              Object.keys(v)
                .sort()
                .map((k) => [k, sortKeys(v[k])]),
            )
          : v;

    function wireClusterState(ctx: ReturnType<typeof setup>) {
      const realGet = ctx.k8s.get.bind(ctx.k8s);
      const realList = ctx.k8s.list.bind(ctx.k8s);
      ctx.k8s.get = (async (...a: Parameters<typeof realGet>) =>
        sortKeys(await realGet(...a))) as typeof ctx.k8s.get;
      ctx.k8s.list = (async (...a: Parameters<typeof realList>) =>
        (await realList(...a)).map(sortKeys)) as typeof ctx.k8s.list;

      const policyRow = {
        user_id: 'u1',
        username: 'one',
        maas_model_ref_name: 'm',
        maas_model_ref_namespace: 'ns',
      };
      const keyRow = {
        id: 'k1',
        user_id: 'u1',
        username: 'one',
        tpm_limit: 100,
        model_tpm_limit: null,
        maas_key_id: 'mk',
        maas_subscription_name: null,
        maas_sync_state: 'synced',
        maas_pending_revoke_ids: [],
        is_active: true,
        revoked_at: null,
        archived_at: null,
        expires_at: null,
      };
      ctx.dbUtils.query.mockResolvedValue({});
      ctx.dbUtils.queryOne.mockImplementation(async (sql: string) => {
        if (sql.includes('SELECT username')) return { username: 'one' };
        if (sql.includes('AS live')) return { ...keyRow, live: true };
        return undefined;
      });
      ctx.dbUtils.queryMany.mockImplementation(async (sql: string) => {
        // key-model queries embed an EXISTS (... FROM subscriptions s ...) clause: match them first
        if (sql.includes('FROM api_key_models'))
          return [
            {
              api_key_id: 'k1',
              model_id: 'ns/m',
              maas_model_ref_name: 'm',
              maas_model_ref_namespace: 'ns',
            },
          ];
        if (sql.includes('FROM api_keys ak')) return [keyRow];
        if (sql.includes('FROM subscriptions s')) return [policyRow];
        return [];
      });
    }

    it('writes once, then reports a converged cluster despite key re-ordering', async () => {
      const ctx = setup(true);
      wireClusterState(ctx);
      const first = await ctx.service.reconcile();
      expect(first.policiesApplied).toBe(1);
      expect(first.subscriptionsApplied).toBe(1);

      const replace = vi.spyOn(ctx.k8s, 'replace');
      const second = await ctx.service.reconcile();
      expect(second.policiesApplied).toBe(0);
      expect(second.subscriptionsApplied).toBe(0);
      expect(second.policiesDeleted + second.subscriptionsDeleted).toBe(0);
      expect(replace).not.toHaveBeenCalled();
      expect(await ctx.k8s.list(POLICY_REF)).toHaveLength(1);
      expect(await ctx.k8s.list(SUB_REF)).toHaveLength(1);
    });

    it('recomputes a policy from the database when the snapshot is stale', async () => {
      const ctx = setup(true);
      wireClusterState(ctx);
      // The snapshot (no params) knows one model; the fresh per-user read knows two
      ctx.dbUtils.queryMany.mockImplementation(async (sql: string, params?: unknown[]) => {
        if (sql.includes('FROM subscriptions s')) {
          const a = {
            user_id: 'u1',
            username: 'one',
            maas_model_ref_name: 'a',
            maas_model_ref_namespace: 'ns',
          };
          return params?.length ? [a, { ...a, maas_model_ref_name: 'b' }] : [a];
        }
        return [];
      });
      await ctx.service.reconcile();
      const policy = await ctx.k8s.get(POLICY_REF, 'litemaas-one', 'models-as-a-service');
      expect(policy!.spec!.modelRefs.map((m: any) => m.name)).toEqual(['a', 'b']);
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

  describe('orphaned auth policies', () => {
    const policy = (name: string, ageMs: number, userId = 'u1') => ({
      apiVersion: 'maas.opendatahub.io/v1alpha1',
      kind: 'MaaSAuthPolicy',
      metadata: {
        name,
        namespace: 'models-as-a-service',
        labels: { 'app.kubernetes.io/managed-by': 'litemaas', 'litemaas.io/user-id': userId },
        creationTimestamp: new Date(Date.now() - ageMs).toISOString(),
      },
      spec: { subjects: { users: ['one'], groups: [] }, modelRefs: [] },
    });
    const row = (username: string) => ({
      user_id: 'u1',
      username,
      maas_model_ref_name: 'm',
      maas_model_ref_namespace: 'ns',
    });

    /** snapshot (no user filter) is empty; the per-user re-check returns `fresh` */
    const run = async (obj: ReturnType<typeof policy>, fresh: ReturnType<typeof row>[]) => {
      const ctx = setup(true);
      ctx.k8s.seed(
        { group: 'maas.opendatahub.io', version: 'v1alpha1', plural: 'maasauthpolicies' },
        obj as any,
      );
      ctx.dbUtils.query.mockResolvedValue({});
      ctx.dbUtils.queryMany.mockImplementation(async (sql: string, params?: unknown[]) => {
        if (sql.includes('FROM subscriptions s')) return params?.length ? fresh : [];
        return [];
      });
      const res = await ctx.service.reconcile();
      const stillThere = await ctx.k8s.get(
        { group: 'maas.opendatahub.io', version: 'v1alpha1', plural: 'maasauthpolicies' },
        obj.metadata.name,
        'models-as-a-service',
      );
      return { res, stillThere };
    };

    it('deletes a stale labeled policy whose user has no active MaaS subscription', async () => {
      const { res, stillThere } = await run(policy('litemaas-one', 60 * 60_000), []);
      expect(res.policiesDeleted).toBe(1);
      expect(stillThere).toBeNull();
    });

    it('never deletes a policy created moments ago (grant may have landed mid-pass)', async () => {
      const { res, stillThere } = await run(policy('litemaas-one', 5_000), []);
      expect(res.policiesDeleted).toBe(0);
      expect(stillThere).not.toBeNull();
    });

    it('keeps a policy whose user regained an active subscription after the snapshot', async () => {
      const { res, stillThere } = await run(policy('litemaas-one', 60 * 60_000), [row('one')]);
      expect(res.policiesDeleted).toBe(0);
      expect(stillThere).not.toBeNull();
    });

    it('still deletes the old-name policy of a renamed user', async () => {
      const { res, stillThere } = await run(policy('litemaas-one', 60 * 60_000), [row('one-new')]);
      expect(res.policiesDeleted).toBe(1);
      expect(stillThere).toBeNull();
    });
  });
});
