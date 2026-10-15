import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  MaasModelSyncService,
  MAAS_POLICY_CONCURRENCY,
  MAAS_SYNC_LOCK_ID,
  runBounded,
  runInBackground,
  waitForMaasBackground,
} from '../../../../src/services/maas/maas-model-sync.service';
import { MaasAccessService } from '../../../../src/services/maas/maas-access.service';
import { ModelSyncService } from '../../../../src/services/model-sync.service';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Tracks how many calls of a mocked async function are in flight at once */
function concurrencyProbe(delayMs = 5) {
  const state = { inFlight: 0, max: 0, calls: 0 };
  const fn = async () => {
    state.calls++;
    state.inFlight++;
    state.max = Math.max(state.max, state.inFlight);
    await sleep(delayMs);
    state.inFlight--;
  };
  return { state, fn };
}

describe('runBounded', () => {
  it('never runs more than `limit` calls at once and processes every item', async () => {
    const probe = concurrencyProbe();
    const items = Array.from({ length: 14 }, (_, i) => i);
    const failures = await runBounded(items, 3, probe.fn);
    expect(failures).toEqual([]);
    expect(probe.state.calls).toBe(14);
    expect(probe.state.max).toBe(3);
  });

  it('collects failures without stopping the remaining items', async () => {
    const seen: number[] = [];
    const failures = await runBounded([1, 2, 3, 4], 2, async (n) => {
      if (n === 2) throw new Error('boom');
      seen.push(n);
    });
    expect(seen.sort()).toEqual([1, 3, 4]);
    expect(failures).toHaveLength(1);
    expect(failures[0].item).toBe(2);
    expect((failures[0].error as Error).message).toBe('boom');
  });

  it('resolves immediately for an empty list', async () => {
    const fn = vi.fn();
    expect(await runBounded([], 5, fn)).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('runInBackground / waitForMaasBackground', () => {
  const log = () => ({ error: vi.fn() }) as any;

  it('does not make the caller wait, and waitForMaasBackground waits for the job', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let finished = false;
    runInBackground(log(), 'test job', async () => {
      await gate;
      finished = true;
    });
    expect(finished).toBe(false);
    const waiting = waitForMaasBackground();
    release();
    await waiting;
    expect(finished).toBe(true);
  });

  it('logs a failing job instead of throwing and still lets waiters finish', async () => {
    const l = log();
    runInBackground(l, 'exploding job', async () => {
      throw new Error('cluster down');
    });
    await expect(waitForMaasBackground()).resolves.toBeUndefined();
    expect(l.error).toHaveBeenCalledTimes(1);
    expect(l.error.mock.calls[0][1]).toContain('exploding job failed');
  });

  it('also waits for jobs started by other jobs', async () => {
    const order: string[] = [];
    runInBackground(log(), 'outer', async () => {
      await sleep(5);
      runInBackground(log(), 'inner', async () => {
        await sleep(5);
        order.push('inner');
      });
      order.push('outer');
    });
    await waitForMaasBackground();
    expect(order).toEqual(['outer', 'inner']);
  });
});

function setup(rows: { users?: string[]; availability?: string | null } = {}) {
  const users = (rows.users ?? []).map((user_id) => ({ user_id }));
  const events: string[] = [];
  const dbUtils = {
    queryMany: vi.fn().mockResolvedValue(users),
    queryOne: vi
      .fn()
      .mockResolvedValue(
        rows.availability === null ? null : { availability: rows.availability ?? 'available' },
      ),
    query: vi.fn(async (sql: string) => {
      if (sql.includes("SET availability = 'available'")) events.push('flip-available');
      if (sql.includes("SET availability = 'unavailable'")) events.push('restore-unavailable');
      return {};
    }),
  };
  const client = {
    query: vi
      .fn()
      .mockResolvedValue({ rows: [{ pg_try_advisory_lock: true, pg_advisory_unlock: true }] }),
    release: vi.fn(),
  };
  const fastify: any = {
    dbUtils,
    maasClients: undefined,
    pg: { pool: { connect: vi.fn().mockResolvedValue(client) } },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
  const clients: any = {
    config: { namespace: 'models-as-a-service', modelNamespaces: [], syncIntervalMs: 1000 },
    k8s: { mock: true },
    maasApi: { mock: true },
    prometheus: { mock: true },
  };
  return { dbUtils, client, fastify, events, service: new MaasModelSyncService(fastify, clients) };
}

const CASCADE = {
  subscriptionsDeactivated: 2,
  apiKeyModelAssociationsRemoved: 1,
  orphanedApiKeysDeactivated: 0,
};

describe('MaasModelSyncService.markUnavailableWithCascade', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(async () => {
    await waitForMaasBackground();
  });

  it('revokes on the cluster BEFORE the DB cascade, with bounded concurrency', async () => {
    const ctx = setup({ users: Array.from({ length: 12 }, (_, i) => `u${i}`) });
    const probe = concurrencyProbe();
    vi.spyOn(MaasAccessService.prototype, 'removeModelForUser').mockImplementation(async () => {
      ctx.events.push('revoke');
      await probe.fn();
      return { applicable: true, revoked: true };
    });
    vi.spyOn(MaasAccessService.prototype, 'syncUserAuthPolicy').mockResolvedValue({
      action: 'noop',
      models: 0,
    });
    vi.spyOn(ModelSyncService.prototype, 'markModelUnavailable').mockImplementation(async () => {
      ctx.events.push('cascade');
      return CASCADE;
    });

    const result = await ctx.service.markUnavailableWithCascade('ns/model');

    expect(result).toEqual(CASCADE);
    expect(probe.state.calls).toBe(12);
    expect(probe.state.max).toBeGreaterThan(1);
    expect(probe.state.max).toBeLessThanOrEqual(MAAS_POLICY_CONCURRENCY);
    const cascadeAt = ctx.events.indexOf('cascade');
    expect(ctx.events.filter((e) => e === 'revoke')).toHaveLength(12);
    expect(ctx.events.lastIndexOf('revoke')).toBeLessThan(cascadeAt);
  });

  it('re-asserts the policies in the background, not on the caller path', async () => {
    const ctx = setup({ users: ['u1', 'u2', 'u3'] });
    vi.spyOn(MaasAccessService.prototype, 'removeModelForUser').mockResolvedValue({
      applicable: true,
      revoked: true,
    });
    vi.spyOn(ModelSyncService.prototype, 'markModelUnavailable').mockResolvedValue(CASCADE);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const resync = vi
      .spyOn(MaasAccessService.prototype, 'syncUserAuthPolicy')
      .mockImplementation(async () => {
        await gate;
        return { action: 'noop', models: 0 };
      });

    // resolves although the (blocked) resync has not finished: it is off the request path
    await ctx.service.markUnavailableWithCascade('ns/model');
    expect(resync.mock.calls.length).toBeLessThanOrEqual(3);

    release();
    await MaasModelSyncService.waitForBackground();
    expect(resync).toHaveBeenCalledTimes(3);
    expect(resync.mock.calls.map((c) => c[0]).sort()).toEqual(['u1', 'u2', 'u3']);
  });

  it('logs failed resyncs per user without failing the cascade', async () => {
    const ctx = setup({ users: ['u1', 'u2'] });
    vi.spyOn(MaasAccessService.prototype, 'removeModelForUser').mockResolvedValue({
      applicable: true,
      revoked: true,
    });
    vi.spyOn(ModelSyncService.prototype, 'markModelUnavailable').mockResolvedValue(CASCADE);
    vi.spyOn(MaasAccessService.prototype, 'syncUserAuthPolicy').mockImplementation(async (id) => {
      if (id === 'u1') throw new Error('apiserver 500');
      return { action: 'noop', models: 0 };
    });

    await expect(ctx.service.markUnavailableWithCascade('ns/model')).resolves.toEqual(CASCADE);
    await MaasModelSyncService.waitForBackground();
    expect(ctx.fastify.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1' }),
      'MaaS policy resync failed',
    );
  });

  it('flips a parked model to available only around the cascade and keeps it unavailable on success', async () => {
    const ctx = setup({ users: ['u1'], availability: 'unavailable' });
    vi.spyOn(MaasAccessService.prototype, 'removeModelForUser').mockResolvedValue({
      applicable: true,
      revoked: true,
    });
    vi.spyOn(MaasAccessService.prototype, 'syncUserAuthPolicy').mockResolvedValue({
      action: 'noop',
      models: 0,
    });
    vi.spyOn(ModelSyncService.prototype, 'markModelUnavailable').mockImplementation(async () => {
      ctx.events.push('cascade');
      return CASCADE;
    });

    await ctx.service.markUnavailableWithCascade('ns/parked');

    // markModelUnavailable ends with availability='unavailable' itself: nothing to restore
    expect(ctx.events).toEqual(['flip-available', 'cascade']);
  });

  it('puts a parked model back to unavailable when the cascade throws (never left visible)', async () => {
    const ctx = setup({ users: ['u1'], availability: 'unavailable' });
    vi.spyOn(MaasAccessService.prototype, 'removeModelForUser').mockResolvedValue({
      applicable: true,
      revoked: true,
    });
    const resync = vi.spyOn(MaasAccessService.prototype, 'syncUserAuthPolicy');
    vi.spyOn(ModelSyncService.prototype, 'markModelUnavailable').mockImplementation(async () => {
      ctx.events.push('cascade');
      throw new Error('deadlock detected');
    });

    await expect(ctx.service.markUnavailableWithCascade('ns/parked')).rejects.toThrow(
      'deadlock detected',
    );

    expect(ctx.events).toEqual(['flip-available', 'cascade', 'restore-unavailable']);
    await MaasModelSyncService.waitForBackground();
    expect(resync).not.toHaveBeenCalled(); // no resync after a failed cascade
  });

  it('does not touch availability when an available model cascade fails', async () => {
    const ctx = setup({ users: ['u1'], availability: 'available' });
    vi.spyOn(MaasAccessService.prototype, 'removeModelForUser').mockResolvedValue({
      applicable: true,
      revoked: true,
    });
    vi.spyOn(ModelSyncService.prototype, 'markModelUnavailable').mockRejectedValue(
      new Error('cascade failed'),
    );
    await expect(ctx.service.markUnavailableWithCascade('ns/live')).rejects.toThrow(
      'cascade failed',
    );
    expect(ctx.events).toEqual([]); // no flip, no restore
  });

  it('keeps the original error when the restore itself fails', async () => {
    const ctx = setup({ users: ['u1'], availability: 'unavailable' });
    vi.spyOn(MaasAccessService.prototype, 'removeModelForUser').mockResolvedValue({
      applicable: true,
      revoked: true,
    });
    vi.spyOn(ModelSyncService.prototype, 'markModelUnavailable').mockRejectedValue(
      new Error('cascade failed'),
    );
    ctx.dbUtils.query.mockImplementation(async (sql: string) => {
      if (sql.includes("SET availability = 'unavailable'")) throw new Error('db gone');
      return {};
    });
    await expect(ctx.service.markUnavailableWithCascade('ns/parked')).rejects.toThrow(
      'cascade failed',
    );
    expect(ctx.fastify.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: 'ns/parked' }),
      expect.stringContaining('could not be parked as unavailable again'),
    );
  });

  it('skips everything for a parked model with no active subscriptions', async () => {
    const ctx = setup({ users: [], availability: 'unavailable' });
    const revoke = vi.spyOn(MaasAccessService.prototype, 'removeModelForUser');
    const cascade = vi.spyOn(ModelSyncService.prototype, 'markModelUnavailable');
    const result = await ctx.service.markUnavailableWithCascade('ns/parked');
    expect(result).toEqual({
      subscriptionsDeactivated: 0,
      apiKeyModelAssociationsRemoved: 0,
      orphanedApiKeysDeactivated: 0,
    });
    expect(revoke).not.toHaveBeenCalled();
    expect(cascade).not.toHaveBeenCalled();
    expect(ctx.events).toEqual([]);
  });
});

describe('MaasModelSyncService.syncWithLock', () => {
  it('takes the shared advisory lock and forwards the sync options', async () => {
    const ctx = setup();
    const sync = vi.spyOn(ctx.service, 'syncModels').mockResolvedValue({ success: true } as any);

    const result = await ctx.service.syncWithLock({ restoreRemoved: true });

    expect(result).toEqual({ success: true });
    expect(sync).toHaveBeenCalledWith({ restoreRemoved: true });
    expect(ctx.client.query).toHaveBeenCalledWith('SELECT pg_try_advisory_lock($1)', [
      MAAS_SYNC_LOCK_ID,
    ]);
    expect(ctx.client.query).toHaveBeenCalledWith('SELECT pg_advisory_unlock($1)', [
      MAAS_SYNC_LOCK_ID,
    ]);
    expect(ctx.client.release).toHaveBeenCalled();
  });

  it('returns null without syncing while another sync holds the lock', async () => {
    const ctx = setup();
    ctx.client.query.mockResolvedValue({ rows: [{ pg_try_advisory_lock: false }] });
    const sync = vi.spyOn(ctx.service, 'syncModels');

    expect(await ctx.service.syncWithLock()).toBeNull();
    expect(sync).not.toHaveBeenCalled();
    // never unlocks a lock it does not hold
    expect(ctx.client.query).not.toHaveBeenCalledWith('SELECT pg_advisory_unlock($1)', [
      MAAS_SYNC_LOCK_ID,
    ]);
  });
});
