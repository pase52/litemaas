import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MaasAccessService } from '../../../../src/services/maas/maas-access.service';
import { InMemoryK8sClient } from '../../../../src/services/k8s/k8s-client';
import { MAAS_AUTH_POLICY, MAAS_SUBSCRIPTION } from '../../../../src/services/maas/maas-resources';

const NS = 'models-as-a-service';
const USER = '00000000-0000-4000-8000-000000000001';

function setup() {
  const k8s = new InMemoryK8sClient();
  const dbUtils = { queryOne: vi.fn(), queryMany: vi.fn(), query: vi.fn().mockResolvedValue({}) };
  const clients: any = {
    config: { namespace: NS },
    k8s,
    maasApi: { mock: true },
    prometheus: { mock: true },
  };
  const fastify: any = {
    dbUtils,
    maasClients: clients,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
  return { k8s, dbUtils, fastify, service: new MaasAccessService(fastify, clients) };
}

const row = (ns: string, name: string) => ({
  maas_model_ref_name: name,
  maas_model_ref_namespace: ns,
});

describe('MaasAccessService', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it('requires MaaS clients', () => {
    expect(() => new MaasAccessService({ log: {} } as any)).toThrow();
  });

  describe('syncUserAuthPolicy', () => {
    it('writes the full desired state (deduped, sorted) with managed labels', async () => {
      ctx.dbUtils.queryOne.mockResolvedValue({ username: 'Jane.Doe' });
      ctx.dbUtils.queryMany.mockResolvedValue([row('b', 'm2'), row('a', 'm1')]);
      const res = await ctx.service.syncUserAuthPolicy(USER);
      expect(res).toMatchObject({ action: 'upserted', models: 2 });

      const [p] = await ctx.k8s.list(MAAS_AUTH_POLICY, { namespace: NS });
      expect(p.metadata.name).toMatch(/^litemaas-jane\.doe-[0-9a-f]{8}$/);
      expect(p.spec?.subjects.users).toEqual(['Jane.Doe']);
      expect(p.spec?.modelRefs).toEqual([
        { name: 'm1', namespace: 'a' },
        { name: 'm2', namespace: 'b' },
      ]);
      expect(p.metadata.labels?.['litemaas.io/user-id']).toBe(USER);
    });

    it('replaces an existing policy rather than merging', async () => {
      ctx.dbUtils.queryOne.mockResolvedValue({ username: 'jane' });
      ctx.dbUtils.queryMany.mockResolvedValueOnce([row('a', 'm1'), row('a', 'm2')]);
      await ctx.service.syncUserAuthPolicy(USER);
      ctx.dbUtils.queryMany.mockResolvedValueOnce([row('a', 'm2')]);
      await ctx.service.syncUserAuthPolicy(USER);
      const [p] = await ctx.k8s.list(MAAS_AUTH_POLICY, { namespace: NS });
      expect(p.spec?.modelRefs).toEqual([{ name: 'm2', namespace: 'a' }]);
    });

    it('deletes the policy when no models remain (and is a no-op when absent)', async () => {
      ctx.dbUtils.queryOne.mockResolvedValue({ username: 'jane' });
      ctx.dbUtils.queryMany.mockResolvedValueOnce([row('a', 'm1')]);
      await ctx.service.syncUserAuthPolicy(USER);
      ctx.dbUtils.queryMany.mockResolvedValue([]);
      expect(await ctx.service.syncUserAuthPolicy(USER)).toMatchObject({ action: 'deleted' });
      expect(await ctx.service.syncUserAuthPolicy(USER)).toMatchObject({ action: 'noop' });
      expect(await ctx.k8s.list(MAAS_AUTH_POLICY)).toHaveLength(0);
    });

    it('passes the excluded model to the desired-state query', async () => {
      ctx.dbUtils.queryOne.mockResolvedValue({ username: 'jane' });
      ctx.dbUtils.queryMany.mockResolvedValue([]);
      await ctx.service.syncUserAuthPolicy(USER, { excludeModelId: 'ns/x' });
      expect(ctx.dbUtils.queryMany.mock.calls[0][1]).toEqual([USER, 'ns/x']);
    });

    it('does nothing for an unknown user', async () => {
      ctx.dbUtils.queryOne.mockResolvedValue(null);
      expect(await ctx.service.syncUserAuthPolicy(USER)).toMatchObject({ action: 'noop' });
    });

    it('serialises concurrent syncs per user (last writer sees freshest state)', async () => {
      ctx.dbUtils.queryOne.mockResolvedValue({ username: 'jane' });
      const order: string[] = [];
      let call = 0;
      ctx.dbUtils.queryMany.mockImplementation(async () => {
        const n = ++call;
        order.push(`start${n}`);
        await new Promise((r) => setTimeout(r, n === 1 ? 20 : 0));
        order.push(`end${n}`);
        return [row('a', n === 1 ? 'old' : 'new')];
      });
      await Promise.all([
        ctx.service.syncUserAuthPolicy(USER),
        ctx.service.syncUserAuthPolicy(USER),
      ]);
      expect(order).toEqual(['start1', 'end1', 'start2', 'end2']);
      const [p] = await ctx.k8s.list(MAAS_AUTH_POLICY, { namespace: NS });
      expect(p.spec?.modelRefs[0].name).toBe('new');
    });
  });

  describe('grantModelToUser', () => {
    it('skips non-MaaS models', async () => {
      ctx.dbUtils.queryOne.mockResolvedValue({ backend_type: 'litellm' });
      expect(await ctx.service.grantModelToUser(USER, 'gpt-4')).toBeNull();
      expect(await ctx.k8s.list(MAAS_AUTH_POLICY)).toHaveLength(0);
    });

    it('swallows cluster errors', async () => {
      ctx.dbUtils.queryOne
        .mockResolvedValueOnce({ backend_type: 'maas' })
        .mockResolvedValueOnce({ username: 'jane' });
      ctx.dbUtils.queryMany.mockResolvedValue([row('a', 'm1')]);
      vi.spyOn(ctx.k8s, 'get').mockRejectedValue(new Error('boom'));
      expect(await ctx.service.grantModelToUser(USER, 'a/m1')).toBeNull();
      expect(ctx.fastify.log.error).toHaveBeenCalled();
    });
  });

  describe('removeModelForUser', () => {
    it('is not applicable to LiteLLM models', async () => {
      ctx.dbUtils.queryOne.mockResolvedValue({ backend_type: 'litellm' });
      expect(await ctx.service.removeModelForUser(USER, 'gpt-4')).toEqual({
        applicable: false,
        revoked: true,
      });
      expect(ctx.dbUtils.query).not.toHaveBeenCalled();
    });

    it('rewrites the policy without the model and strips it from key subscriptions', async () => {
      // isMaasModel, getUsername, model ref row
      ctx.dbUtils.queryOne
        .mockResolvedValueOnce({ backend_type: 'maas' })
        .mockResolvedValueOnce({ username: 'jane' })
        .mockResolvedValueOnce(row('a', 'm1'));
      ctx.dbUtils.queryMany.mockResolvedValue([row('a', 'm2')]); // remaining after exclusion

      const mkSub = (name: string, refs: any[]) => ({
        metadata: {
          name,
          namespace: NS,
          labels: { 'litemaas.io/user-id': USER, 'app.kubernetes.io/managed-by': 'litemaas' },
        },
        spec: { owner: { users: ['jane'] }, modelRefs: refs },
      });
      ctx.k8s.seed(
        MAAS_SUBSCRIPTION,
        mkSub('both', [
          { name: 'm1', namespace: 'a', tokenRateLimits: [{ limit: 5, window: '1m' }] },
          { name: 'm2', namespace: 'a' },
        ]),
        NS,
      );
      ctx.k8s.seed(MAAS_SUBSCRIPTION, mkSub('only-m1', [{ name: 'm1', namespace: 'a' }]), NS);
      ctx.k8s.seed(MAAS_SUBSCRIPTION, mkSub('untouched', [{ name: 'm2', namespace: 'a' }]), NS);

      const res = await ctx.service.removeModelForUser(USER, 'a/m1');
      expect(res).toEqual({ applicable: true, revoked: true });

      const both = await ctx.k8s.get(MAAS_SUBSCRIPTION, 'both', NS);
      expect(both?.spec?.modelRefs).toEqual([{ name: 'm2', namespace: 'a' }]);
      expect(await ctx.k8s.get(MAAS_SUBSCRIPTION, 'only-m1', NS)).toBeNull();
      expect(await ctx.k8s.get(MAAS_SUBSCRIPTION, 'untouched', NS)).not.toBeNull();
      const [p] = await ctx.k8s.list(MAAS_AUTH_POLICY, { namespace: NS });
      expect(p.spec?.modelRefs).toEqual([{ name: 'm2', namespace: 'a' }]);
    });

    it('on cluster failure marks the user MaaS keys pending and reports revoked=false', async () => {
      ctx.dbUtils.queryOne
        .mockResolvedValueOnce({ backend_type: 'maas' })
        .mockResolvedValueOnce({ username: 'jane' });
      ctx.dbUtils.queryMany.mockResolvedValue([]);
      vi.spyOn(ctx.k8s, 'delete').mockRejectedValue(new Error('403 forbidden'));

      const res = await ctx.service.removeModelForUser(USER, 'a/m1');
      expect(res).toMatchObject({ applicable: true, revoked: false });
      expect(res.error).toContain('403 forbidden');
      const [sql, params] = ctx.dbUtils.query.mock.calls[0];
      expect(sql).toContain("maas_sync_state = 'pending'");
      expect(params[0]).toBe(USER);
    });
  });
});
