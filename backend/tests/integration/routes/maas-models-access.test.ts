/**
 * Integration tests for MaaS model sync, admin model routes, subscription -> MaaSAuthPolicy
 * hooks and the reconciler (MAAS_ENABLED=true with the in-memory mock cluster).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { FastifyInstance } from 'fastify';
import { createApp } from '../../../src/app';
import { generateTestToken, createTestUsers, TEST_USER_IDS } from '../setup';
import { LiteLLMService } from '../../../src/services/litellm.service';
import { ModelSyncService } from '../../../src/services/model-sync.service';
import {
  MaasModelSyncService,
  MAAS_SYNC_LOCK_ID,
} from '../../../src/services/maas/maas-model-sync.service';
import { MAAS_RECONCILER_LOCK_ID } from '../../../src/services/maas/maas-reconciler.service';
import { MaasAccessService } from '../../../src/services/maas/maas-access.service';
import {
  MAAS_AUTH_POLICY,
  MAAS_MODEL_REF,
  MAAS_SUBSCRIPTION,
  LABEL_INSTANCE,
  getManagedInstance,
} from '../../../src/services/maas/maas-resources';
import type { InMemoryK8sClient } from '../../../src/services/k8s/k8s-client';

const NS = 'maas-demo-models';
const POLICY_NS = 'models-as-a-service';
const LLAMA = `${NS}/llama-3-2-3b`;
const GRANITE = `${NS}/granite-3-3-8b`;
const QWEN = `${NS}/qwen3-32b`;
const enc = encodeURIComponent;

describe('MaaS models, access hooks and reconciler (MAAS_ENABLED=true)', () => {
  let app: FastifyInstance;
  let k8s: InMemoryK8sClient;
  const admin = () => `Bearer ${generateTestToken(TEST_USER_IDS.ADMIN, ['admin'])}`;
  const readonly = () =>
    `Bearer ${generateTestToken(TEST_USER_IDS.ADMIN_READONLY, ['admin-readonly'])}`;
  const user = () => `Bearer ${generateTestToken(TEST_USER_IDS.USER, ['user'])}`;

  const policy = () => k8s.get(MAAS_AUTH_POLICY, 'litemaas-testuser', POLICY_NS);
  const policyModels = async () =>
    ((await policy())?.spec?.modelRefs ?? []).map((r: any) => `${r.namespace}/${r.name}`).sort();

  async function cleanDb() {
    await app.dbUtils.query(
      `DELETE FROM subscription_status_history WHERE subscription_id IN
         (SELECT id FROM subscriptions WHERE model_id LIKE $1)`,
      [`${NS}/%`],
    );
    await app.dbUtils.query(`DELETE FROM subscriptions WHERE model_id LIKE $1`, [`${NS}/%`]);
    await app.dbUtils.query(`DELETE FROM api_keys WHERE key_hash LIKE 'maas:test-%'`);
    await app.dbUtils.query(`DELETE FROM models WHERE id LIKE $1`, [`${NS}/%`]);
  }

  async function seedCluster() {
    // Reset the mock cluster to its seeded state
    for (const o of await k8s.list(MAAS_AUTH_POLICY)) {
      await k8s.delete(MAAS_AUTH_POLICY, o.metadata.name, o.metadata.namespace);
    }
    for (const o of await k8s.list(MAAS_SUBSCRIPTION)) {
      await k8s.delete(MAAS_SUBSCRIPTION, o.metadata.name, o.metadata.namespace);
    }
    for (const o of await k8s.list(MAAS_MODEL_REF)) {
      await k8s.delete(MAAS_MODEL_REF, o.metadata.name, o.metadata.namespace);
    }
    const { seedMockCluster } = await import('../../../src/services/maas/maas-clients');
    seedMockCluster(k8s);
  }

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.OAUTH_MOCK_ENABLED = 'true';
    process.env.MAAS_ENABLED = 'true';
    process.env.ENCRYPTION_KEY = 'integration-test-encryption-key';
    delete process.env.K8S_API_URL;
    app = await createApp({ logger: false });
    await app.ready();
    await createTestUsers(app);
    k8s = app.maasClients!.k8s as InMemoryK8sClient;
  });

  afterAll(async () => {
    if (app) {
      await cleanDb();
      await app.close();
    }
    delete process.env.MAAS_ENABLED;
    delete process.env.ENCRYPTION_KEY;
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    await cleanDb();
    await seedCluster();
  });

  async function syncAsAdmin(body?: object) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/admin/models/maas/sync',
      headers: { authorization: admin(), 'content-type': 'application/json' },
      payload: body ?? {},
    });
  }

  async function subscribe(modelId: string, auth = user()) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/subscriptions',
      headers: { authorization: auth },
      payload: { modelId },
    });
  }

  describe('model sync + admin routes', () => {
    it('imports MaaSModelRefs as backend_type=maas models with ns/name ids', async () => {
      const res = await syncAsAdmin();
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toMatchObject({ success: true, totalRefs: 3, newModels: 3, updatedModels: 0 });

      const llama = await app.dbUtils.queryOne<any>('SELECT * FROM models WHERE id = $1', [LLAMA]);
      expect(llama).toMatchObject({
        backend_type: 'maas',
        maas_model_ref_name: 'llama-3-2-3b',
        maas_model_ref_namespace: NS,
        maas_phase: 'Ready',
        availability: 'available',
        backend_model_name: 'llama-3-2-3b',
        name: 'Llama 3.2 3B Instruct',
      });
      expect(llama.maas_endpoint).toContain('maas.mock.local');
      const qwen = await app.dbUtils.queryOne<any>('SELECT * FROM models WHERE id = $1', [QWEN]);
      expect(qwen.availability).toBe('unavailable');
      expect(qwen.maas_phase).toBe('Pending');
    });

    it('is idempotent and preserves admin overrides', async () => {
      await syncAsAdmin();
      const put = await app.inject({
        method: 'PUT',
        url: `/api/v1/admin/models/${enc(LLAMA)}`,
        headers: { authorization: admin() },
        payload: {
          model_name: 'Custom Llama',
          description: 'Admin description',
          input_cost_per_token: 0.5,
          supports_vision: true,
        },
      });
      expect(put.statusCode).toBe(200);

      const again = JSON.parse((await syncAsAdmin()).body);
      expect(again).toMatchObject({ newModels: 0, updatedModels: 0, success: true });
      const row = await app.dbUtils.queryOne<any>('SELECT * FROM models WHERE id = $1', [LLAMA]);
      expect(row.name).toBe('Custom Llama');
      expect(row.description).toBe('Admin description');
      expect(Number(row.input_cost_per_token)).toBe(0.5);
      expect(row.features).toContain('vision');
    });

    it('updates only cluster-owned fields when the ref changes', async () => {
      await syncAsAdmin();
      await app.dbUtils.query(`UPDATE models SET name = 'Renamed' WHERE id = $1`, [QWEN]);
      const ref = (await k8s.get(MAAS_MODEL_REF, 'qwen3-32b', NS))!;
      ref.status = { phase: 'Ready', endpoint: 'https://new.endpoint/qwen' };
      await k8s.replace(MAAS_MODEL_REF, 'qwen3-32b', ref, NS);

      const body = JSON.parse((await syncAsAdmin()).body);
      expect(body.updatedModels).toBe(1);
      const row = await app.dbUtils.queryOne<any>('SELECT * FROM models WHERE id = $1', [QWEN]);
      expect(row).toMatchObject({
        name: 'Renamed',
        availability: 'available',
        maas_phase: 'Ready',
        maas_endpoint: 'https://new.endpoint/qwen',
      });
    });

    it('lists cluster refs with the imported flag', async () => {
      await syncAsAdmin();
      await k8s.seed(
        MAAS_MODEL_REF,
        {
          metadata: { name: 'new-ref', namespace: NS },
          spec: { modelRef: { kind: 'LLMInferenceService', name: 'new-ref' } },
          status: { phase: 'Ready' },
        },
        NS,
      );
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/models/maas/refs',
        headers: { authorization: admin() },
      });
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body).data;
      expect(data).toHaveLength(4);
      expect(data.find((r: any) => r.id === `${NS}/new-ref`).imported).toBe(false);
      expect(data.find((r: any) => r.id === LLAMA).imported).toBe(true);
    });

    it('requires admin:models permission', async () => {
      const r1 = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/models/maas/sync',
        headers: { authorization: user() },
        payload: {},
      });
      expect(r1.statusCode).toBe(403);
      const r2 = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/models/maas/refs',
        headers: { authorization: readonly() },
      });
      expect(r2.statusCode).toBe(403);
    });

    it('PUT on a MaaS model never calls LiteLLM and ignores cluster-owned fields', async () => {
      await syncAsAdmin();
      const update = vi.spyOn(LiteLLMService.prototype, 'updateModel');
      const res = await app.inject({
        method: 'PUT',
        url: `/api/v1/admin/models/${enc(GRANITE)}`,
        headers: { authorization: admin() },
        payload: { description: 'd', api_base: 'http://evil', api_key: 'k', tpm: 5, rpm: 5 },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).message).toContain('cluster-managed fields ignored');
      expect(update).not.toHaveBeenCalled();
      const row = await app.dbUtils.queryOne<any>('SELECT * FROM models WHERE id = $1', [GRANITE]);
      expect(row.api_base).toBeNull();
      expect(row.encrypted_api_key).toBeNull();
      expect(row.tpm).toBeNull();
      expect(row.description).toBe('d');
    });

    it('exposes backend fields on the models API (ids with slashes work in :id routes)', async () => {
      await syncAsAdmin();
      const list = await app.inject({
        method: 'GET',
        url: '/api/v1/models?limit=1000',
        headers: { authorization: user() },
      });
      expect(list.statusCode).toBe(200);
      const items = JSON.parse(list.body).data;
      const llama = items.find((m: any) => m.id === LLAMA);
      expect(llama.backendType).toBe('maas');
      expect(llama.maasEndpoint).toContain('maas.mock.local');
      // Unavailable (Pending) models are not listed
      expect(items.find((m: any) => m.id === QWEN)).toBeUndefined();

      const detail = await app.inject({
        method: 'GET',
        url: `/api/v1/models/${enc(LLAMA)}`,
        headers: { authorization: user() },
      });
      expect(detail.statusCode).toBe(200);
      expect(JSON.parse(detail.body)).toMatchObject({ id: LLAMA, backendType: 'maas' });
    });

    it('DELETE soft-deletes with cascade, never calls LiteLLM, and survives later syncs', async () => {
      await syncAsAdmin();
      const sub = JSON.parse((await subscribe(GRANITE)).body);
      expect(sub.status).toBe('active');
      expect(await policyModels()).toEqual([GRANITE]);

      const del = vi.spyOn(LiteLLMService.prototype, 'deleteModel');
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/admin/models/${enc(GRANITE)}`,
        headers: { authorization: admin() },
      });
      expect(res.statusCode).toBe(200);
      expect(del).not.toHaveBeenCalled();

      const row = await app.dbUtils.queryOne<any>('SELECT * FROM models WHERE id = $1', [GRANITE]);
      expect(row.availability).toBe('unavailable'); // row kept
      const s = await app.dbUtils.queryOne<any>('SELECT status FROM subscriptions WHERE id = $1', [
        sub.id,
      ]);
      expect(s.status).toBe('inactive');
      expect(await policy()).toBeNull();

      // Ref still exists on the cluster but admin removal is sticky
      await syncAsAdmin();
      const after = await app.dbUtils.queryOne<any>(
        'SELECT availability FROM models WHERE id = $1',
        [GRANITE],
      );
      expect(after.availability).toBe('unavailable');

      // ...until explicitly restored
      await syncAsAdmin({ restoreRemoved: true });
      const restored = await app.dbUtils.queryOne<any>(
        'SELECT availability FROM models WHERE id = $1',
        [GRANITE],
      );
      expect(restored.availability).toBe('available');
    });

    it('marks models whose ref vanished unavailable and cascades access', async () => {
      await syncAsAdmin();
      await subscribe(LLAMA);
      expect(await policyModels()).toEqual([LLAMA]);

      await k8s.delete(MAAS_MODEL_REF, 'llama-3-2-3b', NS);
      const body = JSON.parse((await syncAsAdmin()).body);
      expect(body.unavailableModels).toBe(1);
      expect(body.cascadeStatistics.subscriptionsDeactivated).toBe(1);
      expect(await policy()).toBeNull();

      // Next sync does not count it again
      const next = JSON.parse((await syncAsAdmin()).body);
      expect(next.unavailableModels).toBe(0);
    });

    it('a failing cluster list never marks anything unavailable', async () => {
      await syncAsAdmin();
      const spy = vi.spyOn(k8s, 'list').mockRejectedValueOnce(new Error('api down'));
      const result = await new MaasModelSyncService(app).syncModels();
      expect(result.success).toBe(false);
      expect(result.errors[0]).toContain('api down');
      spy.mockRestore();
      const row = await app.dbUtils.queryOne<any>('SELECT availability FROM models WHERE id = $1', [
        LLAMA,
      ]);
      expect(row.availability).toBe('available');
    });

    it('the manual sync takes the shared sync lock: 409 while another sync holds it, nothing imported or audited', async () => {
      const syncAudits = async () =>
        Number(
          (
            await app.dbUtils.queryOne<any>(
              `SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'MAAS_MODEL_SYNC'`,
            )
          ).n,
        );
      const before = await syncAudits();

      const holder = await app.pg.pool.connect();
      try {
        // what the periodic sync (any replica) holds while it runs
        await holder.query('SELECT pg_advisory_lock($1)', [MAAS_SYNC_LOCK_ID]);
        const blocked = await syncAsAdmin();
        expect(blocked.statusCode).toBe(409);
        const { error } = JSON.parse(blocked.body);
        expect(error).toMatchObject({ code: 'RESOURCE_LOCKED', statusCode: 409 });
        expect(error.message).toContain('already running');
        expect(
          await app.dbUtils.queryMany(`SELECT id FROM models WHERE id LIKE $1`, [`${NS}/%`]),
        ).toHaveLength(0);
        expect(await syncAudits()).toBe(before);
      } finally {
        await holder.query('SELECT pg_advisory_unlock($1)', [MAAS_SYNC_LOCK_ID]);
        holder.release();
      }

      // once the other sync is done the manual one runs, and releases the lock again
      const ok = await syncAsAdmin();
      expect(ok.statusCode).toBe(200);
      expect(JSON.parse(ok.body)).toMatchObject({ success: true, newModels: 3 });
      expect(await syncAudits()).toBe(before + 1);
      expect((await syncAsAdmin()).statusCode).toBe(200);
    });

    it('concurrent manual syncs never race into duplicate inserts', async () => {
      const results = await Promise.all([syncAsAdmin(), syncAsAdmin(), syncAsAdmin()]);
      const codes = results.map((r) => r.statusCode);
      expect(codes.every((c) => c === 200 || c === 409)).toBe(true);
      expect(codes).toContain(200);
      for (const r of results.filter((x) => x.statusCode === 200)) {
        expect(JSON.parse(r.body)).toMatchObject({ success: true, errors: [] });
      }
      expect(
        await app.dbUtils.queryMany(`SELECT id FROM models WHERE id LIKE $1`, [`${NS}/%`]),
      ).toHaveLength(3);
    });

    it('a failing cascade leaves a parked (Pending) model unavailable instead of flipping it visible', async () => {
      await syncAsAdmin(); // QWEN is Pending on the cluster: parked as unavailable
      await app.dbUtils.query(
        `INSERT INTO subscriptions (user_id, model_id, status) VALUES ($1, $2, 'active')`,
        [TEST_USER_IDS.USER, QWEN],
      );
      const availability = async () =>
        (await app.dbUtils.queryOne<any>('SELECT availability FROM models WHERE id = $1', [QWEN]))
          .availability;
      expect(await availability()).toBe('unavailable');

      vi.spyOn(ModelSyncService.prototype, 'markModelUnavailable').mockRejectedValueOnce(
        new Error('cascade boom'),
      );
      await expect(new MaasModelSyncService(app).markUnavailableWithCascade(QWEN)).rejects.toThrow(
        'cascade boom',
      );
      expect(await availability()).toBe('unavailable'); // never left available / subscribable
      const stillActive = await app.dbUtils.queryOne<any>(
        'SELECT status FROM subscriptions WHERE model_id = $1',
        [QWEN],
      );
      expect(stillActive.status).toBe('active'); // the rolled-back cascade changed nothing

      // a retry cascades the parked model's subscription and keeps it unavailable
      vi.restoreAllMocks();
      const stats = await new MaasModelSyncService(app).markUnavailableWithCascade(QWEN);
      expect(stats.subscriptionsDeactivated).toBe(1);
      expect(await availability()).toBe('unavailable');
      await MaasModelSyncService.waitForBackground();
    });

    it('LiteLLM sync ignores MaaS models (regression: no unavailable cascade)', async () => {
      await syncAsAdmin();
      await subscribe(LLAMA);
      const result = await new ModelSyncService(app).syncModels({ markUnavailable: true });
      expect(result).toBeDefined();
      const row = await app.dbUtils.queryOne<any>('SELECT availability FROM models WHERE id = $1', [
        LLAMA,
      ]);
      expect(row.availability).toBe('available');
      const sub = await app.dbUtils.queryOne<any>(
        'SELECT status FROM subscriptions WHERE model_id = $1',
        [LLAMA],
      );
      expect(sub.status).toBe('active');
      expect(await policyModels()).toEqual([LLAMA]);
    });
  });

  describe('subscription hooks -> MaaSAuthPolicy', () => {
    beforeEach(async () => {
      await syncAsAdmin();
    });

    it('creates the policy on an active subscription without touching LiteLLM', async () => {
      const getModel = vi.spyOn(LiteLLMService.prototype, 'getModelById');
      const res = await subscribe(LLAMA);
      expect(res.statusCode).toBe(201);
      expect(JSON.parse(res.body).status).toBe('active');
      expect(getModel).not.toHaveBeenCalled();

      const p = await policy();
      expect(p?.spec?.subjects).toEqual({ users: ['testuser'], groups: [] });
      expect(p?.spec?.modelRefs).toEqual([{ name: 'llama-3-2-3b', namespace: NS }]);
      expect(p?.metadata.labels?.['app.kubernetes.io/managed-by']).toBe('litemaas');
    });

    it('rejects subscribing to an unavailable MaaS model', async () => {
      const res = await subscribe(QWEN);
      expect(res.statusCode).toBe(400);
      expect(await policy()).toBeNull();
    });

    it('accumulates models and removes them on cancel; deletes the empty policy', async () => {
      const a = JSON.parse((await subscribe(LLAMA)).body);
      const b = JSON.parse((await subscribe(GRANITE)).body);
      expect(await policyModels()).toEqual([GRANITE, LLAMA].sort());

      const c1 = await app.inject({
        method: 'POST',
        url: `/api/v1/subscriptions/${a.id}/cancel`,
        headers: { authorization: user() },
      });
      expect(c1.statusCode).toBe(200);
      expect(await policyModels()).toEqual([GRANITE]);

      await app.inject({
        method: 'POST',
        url: `/api/v1/subscriptions/${b.id}/cancel`,
        headers: { authorization: user() },
      });
      expect(await policy()).toBeNull();
    });

    it('restricted model: pending grants nothing, approve grants, deny/revert revoke', async () => {
      await app.dbUtils.query(`UPDATE models SET restricted_access = true WHERE id = $1`, [LLAMA]);
      const sub = JSON.parse((await subscribe(LLAMA)).body);
      expect(sub.status).toBe('pending');
      expect(await policy()).toBeNull();

      const approve = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/subscriptions/approve',
        headers: { authorization: admin() },
        payload: { subscriptionIds: [sub.id] },
      });
      expect(JSON.parse(approve.body).successful).toBe(1);
      expect(await policyModels()).toEqual([LLAMA]);

      const revert = await app.inject({
        method: 'POST',
        url: `/api/v1/admin/subscriptions/${sub.id}/revert`,
        headers: { authorization: admin() },
        payload: { newStatus: 'denied', reason: 'no' },
      });
      expect(revert.statusCode).toBe(200);
      expect(await policy()).toBeNull();

      await app.inject({
        method: 'POST',
        url: `/api/v1/admin/subscriptions/${sub.id}/revert`,
        headers: { authorization: admin() },
        payload: { newStatus: 'active' },
      });
      expect(await policyModels()).toEqual([LLAMA]);

      const deny = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/subscriptions/deny',
        headers: { authorization: admin() },
        payload: { subscriptionIds: [sub.id], reason: 'policy' },
      });
      expect(JSON.parse(deny.body).successful).toBe(1);
      expect(await policy()).toBeNull();
    });

    it('marking a model restricted revokes access; un-restricting grants pending users', async () => {
      const sub = JSON.parse((await subscribe(LLAMA)).body);
      expect(await policyModels()).toEqual([LLAMA]);

      const restrict = await app.inject({
        method: 'PUT',
        url: `/api/v1/admin/models/${enc(LLAMA)}`,
        headers: { authorization: admin() },
        payload: { restrictedAccess: true },
      });
      expect(restrict.statusCode).toBe(200);
      expect(await policy()).toBeNull();
      const pending = await app.dbUtils.queryOne<any>(
        'SELECT status FROM subscriptions WHERE id = $1',
        [sub.id],
      );
      expect(pending.status).toBe('pending');

      await app.inject({
        method: 'PUT',
        url: `/api/v1/admin/models/${enc(LLAMA)}`,
        headers: { authorization: admin() },
        payload: { restrictedAccess: false },
      });
      expect(await policyModels()).toEqual([LLAMA]);
    });

    it('the owner cannot re-activate a pending / denied subscription by PATCH (no policy is granted); cancel still revokes', async () => {
      await app.dbUtils.query(`UPDATE models SET restricted_access = true WHERE id = $1`, [LLAMA]);
      const sub = JSON.parse((await subscribe(LLAMA)).body);
      expect(sub.status).toBe('pending');
      const patch = (status: string) =>
        app.inject({
          method: 'PATCH',
          url: `/api/v1/subscriptions/${sub.id}`,
          headers: { authorization: user() },
          payload: { status },
        });
      const dbStatus = async () =>
        (
          await app.dbUtils.queryOne<any>('SELECT status FROM subscriptions WHERE id = $1', [
            sub.id,
          ])
        ).status;

      // pending: the approval an admin has not given
      const pending = await patch('active');
      expect(pending.statusCode).toBe(403);
      expect(JSON.parse(pending.body).error.code).toBe('FORBIDDEN');
      expect(await dbStatus()).toBe('pending');
      expect(await policy()).toBeNull();

      // denied by an admin: still not the owner's call
      await app.inject({
        method: 'POST',
        url: '/api/v1/admin/subscriptions/deny',
        headers: { authorization: admin() },
        payload: { subscriptionIds: [sub.id], reason: 'no' },
      });
      expect((await patch('active')).statusCode).toBe(403);
      expect(await dbStatus()).toBe('denied');
      expect(await policy()).toBeNull();

      // the admin decision path is unchanged: revert grants access, the owner may then cancel
      const revert = await app.inject({
        method: 'POST',
        url: `/api/v1/admin/subscriptions/${sub.id}/revert`,
        headers: { authorization: admin() },
        payload: { newStatus: 'active' },
      });
      expect(revert.statusCode).toBe(200);
      expect(await policyModels()).toEqual([LLAMA]);

      const cancel = await patch('cancelled');
      expect(cancel.statusCode).toBe(200);
      expect(JSON.parse(cancel.body).status).toBe('cancelled');
      expect(await policy()).toBeNull();
    });

    it('admin delete of a subscription revokes access first', async () => {
      const sub = JSON.parse((await subscribe(LLAMA)).body);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/admin/subscriptions/${sub.id}`,
        headers: { authorization: admin() },
        payload: { reason: 'cleanup' },
      });
      expect(res.statusCode).toBe(200);
      expect(await policy()).toBeNull();
    });

    it('cluster failure on revoke does not block the DB change and marks keys pending', async () => {
      const sub = JSON.parse((await subscribe(LLAMA)).body);
      const keyId = '00000000-0000-4000-8000-00000000f001';
      await app.dbUtils.query(`DELETE FROM api_keys WHERE id = $1`, [keyId]);
      await app.dbUtils.query(
        `INSERT INTO api_keys (id, user_id, name, key_hash, key_prefix, backend_type, maas_sync_state)
         VALUES ($1, $2, 'k', 'maas:test-revoke', 'sk-oai-', 'maas', 'synced')`,
        [keyId, TEST_USER_IDS.USER],
      );

      vi.spyOn(k8s, 'delete').mockRejectedValue(new Error('cluster unreachable'));
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/subscriptions/${sub.id}/cancel`,
        headers: { authorization: user() },
      });
      expect(res.statusCode).toBe(200);
      const s = await app.dbUtils.queryOne<any>('SELECT status FROM subscriptions WHERE id = $1', [
        sub.id,
      ]);
      expect(s.status).toBe('inactive');
      const key = await app.dbUtils.queryOne<any>('SELECT * FROM api_keys WHERE id = $1', [keyId]);
      expect(key.maas_sync_state).toBe('pending');
      expect(key.maas_last_error).toContain('cluster unreachable');
    });

    it('revocation happens before the database row changes', async () => {
      const sub = JSON.parse((await subscribe(LLAMA)).body);
      let statusDuringRevoke: string | undefined;
      const original = MaasAccessService.prototype.removeModelForUser;
      vi.spyOn(MaasAccessService.prototype, 'removeModelForUser').mockImplementation(
        async function (this: MaasAccessService, userId: string, modelId: string) {
          const row = await app.dbUtils.queryOne<any>(
            'SELECT status FROM subscriptions WHERE id = $1',
            [sub.id],
          );
          statusDuringRevoke = row.status;
          return original.call(this, userId, modelId);
        },
      );
      await app.inject({
        method: 'POST',
        url: `/api/v1/subscriptions/${sub.id}/cancel`,
        headers: { authorization: user() },
      });
      expect(statusDuringRevoke).toBe('active');
    });
  });

  describe('reconciler + POST /admin/maas/reconcile', () => {
    beforeEach(async () => {
      await syncAsAdmin();
    });

    const reconcile = (auth: string) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/admin/maas/reconcile',
        headers: { authorization: auth },
      });

    it('enforces RBAC (admin only)', async () => {
      expect((await reconcile(user())).statusCode).toBe(403);
      expect((await reconcile(readonly())).statusCode).toBe(403);
      expect((await reconcile(admin())).statusCode).toBe(200);
    });

    it('recreates a drifted policy from the database', async () => {
      await subscribe(LLAMA);
      await k8s.delete(MAAS_AUTH_POLICY, 'litemaas-testuser', POLICY_NS);
      const res = await reconcile(admin());
      const data = JSON.parse(res.body).data;
      expect(data).toMatchObject({ ran: true, policiesApplied: 1, errors: [] });
      expect(await policyModels()).toEqual([LLAMA]);

      // Second pass is a no-op
      const again = JSON.parse((await reconcile(admin())).body).data;
      expect(again).toMatchObject({ policiesApplied: 0, policiesDeleted: 0 });
    });

    it('deletes labeled orphan policies but leaves foreign objects alone', async () => {
      await k8s.seed(
        MAAS_AUTH_POLICY,
        {
          metadata: {
            name: 'litemaas-ghost',
            namespace: POLICY_NS,
            labels: {
              'app.kubernetes.io/managed-by': 'litemaas',
              [LABEL_INSTANCE]: getManagedInstance()!,
            },
          },
          spec: { subjects: { users: ['ghost'] }, modelRefs: [] },
        },
        POLICY_NS,
      );
      // Same label set but another LiteMaaS instance sharing the namespace: never ours to delete
      await k8s.seed(
        MAAS_AUTH_POLICY,
        {
          metadata: {
            name: 'litemaas-other-instance',
            namespace: POLICY_NS,
            labels: { 'app.kubernetes.io/managed-by': 'litemaas', [LABEL_INSTANCE]: 'staging' },
          },
          spec: { subjects: { users: ['ghost'] }, modelRefs: [] },
        },
        POLICY_NS,
      );
      await k8s.seed(
        MAAS_AUTH_POLICY,
        {
          metadata: { name: 'hand-made', namespace: POLICY_NS },
          spec: { subjects: { users: ['x'] }, modelRefs: [] },
        },
        POLICY_NS,
      );
      const data = JSON.parse((await reconcile(admin())).body).data;
      expect(data.policiesDeleted).toBe(1);
      expect(await k8s.get(MAAS_AUTH_POLICY, 'litemaas-ghost', POLICY_NS)).toBeNull();
      expect(await k8s.get(MAAS_AUTH_POLICY, 'hand-made', POLICY_NS)).not.toBeNull();
      expect(await k8s.get(MAAS_AUTH_POLICY, 'litemaas-other-instance', POLICY_NS)).not.toBeNull();
    });

    it('applies MaaSSubscriptions for live MaaS keys with TPM limits and removes them when revoked', async () => {
      const keyId = '00000000-0000-4000-8000-00000000f002';
      await app.dbUtils.query(`DELETE FROM api_keys WHERE id = $1`, [keyId]);
      await app.dbUtils.query(
        `INSERT INTO api_keys (id, user_id, name, key_hash, key_prefix, backend_type, tpm_limit,
                               model_tpm_limit, maas_key_id, maas_sync_state)
         VALUES ($1, $2, 'k', 'maas:test-sub', 'sk-oai-', 'maas', 1000, $3, 'maas-api-key-1', 'pending')`,
        [keyId, TEST_USER_IDS.USER, JSON.stringify({ [GRANITE]: 250 })],
      );
      await app.dbUtils.query(
        `INSERT INTO api_key_models (api_key_id, model_id) VALUES ($1, $2), ($1, $3)`,
        [keyId, LLAMA, GRANITE],
      );
      // The reconciler only keeps models the owner still has an active subscription for
      for (const modelId of [LLAMA, GRANITE]) {
        await app.dbUtils.query(
          `INSERT INTO subscriptions (user_id, model_id, status) VALUES ($1, $2, 'active')
           ON CONFLICT (user_id, model_id) DO UPDATE SET status = 'active'`,
          [TEST_USER_IDS.USER, modelId],
        );
      }

      const data = JSON.parse((await reconcile(admin())).body).data;
      expect(data.subscriptionsApplied).toBe(1);
      expect(data.keysMarkedSynced).toBe(1);
      const sub = await k8s.get(MAAS_SUBSCRIPTION, `litemaas-key-${keyId}`, POLICY_NS);
      expect(sub?.spec?.owner.users).toEqual(['testuser']);
      const byName = Object.fromEntries(sub!.spec!.modelRefs.map((m: any) => [m.name, m]));
      expect(byName['llama-3-2-3b'].tokenRateLimits).toEqual([{ limit: 1000, window: '1m' }]);
      expect(byName['granite-3-3-8b'].tokenRateLimits).toEqual([{ limit: 250, window: '1m' }]);
      const row = await app.dbUtils.queryOne<any>(
        'SELECT maas_sync_state FROM api_keys WHERE id = $1',
        [keyId],
      );
      expect(row.maas_sync_state).toBe('synced');

      await app.dbUtils.query(
        `UPDATE api_keys SET is_active = false, revoked_at = NOW() WHERE id = $1`,
        [keyId],
      );
      const data2 = JSON.parse((await reconcile(admin())).body).data;
      expect(data2.subscriptionsDeleted).toBe(1);
      expect(await k8s.get(MAAS_SUBSCRIPTION, `litemaas-key-${keyId}`, POLICY_NS)).toBeNull();
    });

    it('deletes orphan subscriptions but spares recently created ones', async () => {
      const mk = (name: string, created?: string) => ({
        metadata: {
          name,
          namespace: POLICY_NS,
          labels: {
            'app.kubernetes.io/managed-by': 'litemaas',
            [LABEL_INSTANCE]: getManagedInstance()!,
            'litemaas.io/api-key-id': name,
          },
          creationTimestamp: created,
        },
        spec: { owner: { users: ['x'] }, modelRefs: [] },
      });
      await k8s.seed(
        MAAS_SUBSCRIPTION,
        mk('old-orphan', new Date(Date.now() - 3600_000).toISOString()),
        POLICY_NS,
      );
      await k8s.seed(MAAS_SUBSCRIPTION, mk('fresh-orphan', new Date().toISOString()), POLICY_NS);
      const data = JSON.parse((await reconcile(admin())).body).data;
      expect(data.subscriptionsDeleted).toBe(1);
      expect(await k8s.get(MAAS_SUBSCRIPTION, 'old-orphan', POLICY_NS)).toBeNull();
      expect(await k8s.get(MAAS_SUBSCRIPTION, 'fresh-orphan', POLICY_NS)).not.toBeNull();
    });

    it('records an audit log entry', async () => {
      await reconcile(admin());
      const row = await app.dbUtils.queryOne<any>(
        `SELECT action FROM audit_logs WHERE action = 'MAAS_RECONCILE' ORDER BY created_at DESC LIMIT 1`,
      );
      expect(row?.action).toBe('MAAS_RECONCILE');
    });

    it('audits a normal pass as successful and a skipped pass (lock held elsewhere) as unsuccessful', async () => {
      const lastAudit = () =>
        app.dbUtils.queryOne<any>(
          `SELECT success, metadata FROM audit_logs
            WHERE action = 'MAAS_RECONCILE' ORDER BY created_at DESC LIMIT 1`,
        );

      expect(JSON.parse((await reconcile(admin())).body).data.ran).toBe(true);
      expect((await lastAudit()).success).toBe(true);

      const holder = await app.pg.pool.connect();
      try {
        await holder.query('SELECT pg_advisory_lock($1)', [MAAS_RECONCILER_LOCK_ID]);
        const skipped = await reconcile(admin());
        expect(skipped.statusCode).toBe(200);
        expect(JSON.parse(skipped.body).data).toMatchObject({ ran: false, errors: [] });
        const row = await lastAudit();
        expect(row.metadata.ran).toBe(false);
        expect(row.success).toBe(false); // nothing was reconciled: not a success
      } finally {
        await holder.query('SELECT pg_advisory_unlock($1)', [MAAS_RECONCILER_LOCK_ID]);
        holder.release();
      }
    });
  });

  describe('low-severity review fixes', () => {
    it('admin-added subscription for a MaaS model grants the policy immediately', async () => {
      await syncAsAdmin();
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/admin/users/${TEST_USER_IDS.USER}/subscriptions`,
        headers: { authorization: admin() },
        payload: { modelIds: [LLAMA] },
      });
      expect(res.statusCode).toBeLessThan(300);
      expect(await policyModels()).toContain(LLAMA);
    });

    it('admin user routes refuse to activate a subscription on a migrating LiteLLM model', async () => {
      const LEGACY = `${NS}/legacy-litellm`;
      await app.dbUtils.query(
        `INSERT INTO models (id, name, provider, category, features, availability, backend_type,
                             migration_state, migration_grace_until)
         VALUES ($1, 'Legacy', 'openai', 'Language Model', ARRAY['chat'], 'available', 'litellm',
                 'migrating', NOW() + interval '7 days')`,
        [LEGACY],
      );
      const sub = await app.inject({
        method: 'POST',
        url: `/api/v1/admin/users/${TEST_USER_IDS.USER}/subscriptions`,
        headers: { authorization: admin() },
        payload: { modelIds: [LEGACY] },
      });
      expect(sub.statusCode).toBe(400);
      expect(sub.body).toMatch(/migrat/i);
      const key = await app.inject({
        method: 'POST',
        url: `/api/v1/admin/users/${TEST_USER_IDS.USER}/api-keys`,
        headers: { authorization: admin() },
        payload: { name: 'legacy key', modelIds: [LEGACY] },
      });
      expect(key.statusCode).toBe(400);
      const rows = await app.dbUtils.queryMany(
        `SELECT id FROM subscriptions WHERE user_id = $1 AND model_id = $2`,
        [TEST_USER_IDS.USER, LEGACY],
      );
      expect(rows).toHaveLength(0);
    });

    it('migrate-to-maas rejects dot-segment and malformed names with 400', async () => {
      await syncAsAdmin();
      for (const ref of [
        { name: '..', namespace: NS },
        { name: 'ok', namespace: '..' },
        { name: 'Bad/Name', namespace: NS },
      ]) {
        const res = await app.inject({
          method: 'POST',
          url: `/api/v1/admin/models/${enc(LLAMA)}/migrate-to-maas`,
          headers: { authorization: admin() },
          payload: { maasModelRef: ref },
        });
        expect(res.statusCode).toBe(400);
      }
    });

    it('Test configuration returns missing_stored_key when the stored key cannot be decrypted', async () => {
      const { encryptApiKey } = await import('../../../src/utils/encryption');
      const id = `${NS}/enc-test`;
      await app.dbUtils.query(
        `INSERT INTO models (id, name, provider, backend_type, encrypted_api_key)
         VALUES ($1, 'enc-test', 'openai', 'litellm', $2)`,
        [id, encryptApiKey('sk-old', 'a-different-old-key')],
      );
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/models/test',
        headers: { authorization: admin() },
        payload: { api_base: 'https://example.invalid/v1', backend_model_name: 'x', model_id: id },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({ success: false, result: 'missing_stored_key' });
    });

    it('GET /health caches the MaaS checks between requests', async () => {
      const clients = app.maasClients!;
      const apiSpy = vi.spyOn(clients.maasApi, 'health');
      const k8sSpy = vi.spyOn(clients.k8s, 'list');
      const promSpy = vi.spyOn(clients.prometheus, 'health');
      await app.inject({ method: 'GET', url: '/api/v1/health' });
      await app.inject({ method: 'GET', url: '/api/v1/health' });
      expect(apiSpy).toHaveBeenCalledTimes(1);
      expect(k8sSpy).toHaveBeenCalledTimes(1);
      expect(promSpy).toHaveBeenCalledTimes(1);
    });
  });
});
