/**
 * Security regression tests: the OWNER of a subscription must not be able to change its approval
 * state through PATCH /api/v1/subscriptions/:id. Before the fix any authenticated user could send
 * {"status":"active"} for a subscription an admin had denied / left pending / suspended and gain
 * access to the model (and, with MaaS enabled, a MaaSAuthPolicy).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { createApp } from '../../../src/app';
import { generateTestToken, createTestUsers, TEST_USER_IDS } from '../setup';

const MODEL = 'sub-status-test-model';

describe('PATCH /api/v1/subscriptions/:id - owners cannot change their own approval state', () => {
  let app: FastifyInstance;

  const user = () => `Bearer ${generateTestToken(TEST_USER_IDS.USER, ['user'])}`;
  const admin = () => `Bearer ${generateTestToken(TEST_USER_IDS.ADMIN, ['admin'])}`;

  async function cleanDb() {
    await app.dbUtils.query(
      `DELETE FROM subscription_status_history
        WHERE subscription_id IN (SELECT id FROM subscriptions WHERE model_id = $1)`,
      [MODEL],
    );
    await app.dbUtils.query(
      `DELETE FROM audit_logs
        WHERE resource_id IN (SELECT id::text FROM subscriptions WHERE model_id = $1)`,
      [MODEL],
    );
    await app.dbUtils.query('DELETE FROM subscriptions WHERE model_id = $1', [MODEL]);
    await app.dbUtils.query('DELETE FROM models WHERE id = $1', [MODEL]);
  }

  async function seed(status: string): Promise<string> {
    const row = await app.dbUtils.queryOne<{ id: string }>(
      `INSERT INTO subscriptions (user_id, model_id, status, status_reason)
       VALUES ($1, $2, $3, 'set by an admin') RETURNING id`,
      [TEST_USER_IDS.USER, MODEL, status],
    );
    return row!.id;
  }

  const patch = (id: string, payload: object, auth = user()) =>
    app.inject({
      method: 'PATCH',
      url: `/api/v1/subscriptions/${id}`,
      headers: { authorization: auth, 'content-type': 'application/json' },
      payload,
    });

  const dbRow = (id: string) =>
    app.dbUtils.queryOne<any>(
      'SELECT status, status_reason, quota_requests FROM subscriptions WHERE id = $1',
      [id],
    );

  const updateAudits = async (id: string) =>
    Number(
      (
        await app.dbUtils.queryOne<any>(
          `SELECT COUNT(*) AS n FROM audit_logs
            WHERE action = 'SUBSCRIPTION_UPDATE' AND resource_id = $1`,
          [id],
        )
      ).n,
    );

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.OAUTH_MOCK_ENABLED = 'true';
    delete process.env.MAAS_ENABLED;
    app = await createApp({ logger: false });
    await app.ready();
    await createTestUsers(app);
  });

  afterAll(async () => {
    if (app) {
      await cleanDb();
      await app.close();
    }
  });

  beforeEach(async () => {
    await cleanDb();
    await app.dbUtils.query(
      `INSERT INTO models (id, name, provider, category, features, availability, backend_type)
       VALUES ($1, 'Status Test', 'openai', 'Language Model', ARRAY['chat'], 'available', 'litellm')`,
      [MODEL],
    );
  });

  it.each(['denied', 'pending', 'suspended', 'inactive', 'cancelled', 'expired'])(
    'rejects the owner re-activating a %s subscription with 403 and changes nothing',
    async (status) => {
      const id = await seed(status);

      const res = await patch(id, { status: 'active' });

      expect(res.statusCode).toBe(403);
      const { error } = JSON.parse(res.body);
      expect(error.code).toBe('FORBIDDEN');
      expect(error.message).toContain("'active'");
      expect(await dbRow(id)).toMatchObject({ status, status_reason: 'set by an admin' });
      expect(await updateAudits(id)).toBe(0);
    },
  );

  it.each(['pending', 'denied', 'suspended', 'expired'])(
    'rejects the owner moving an active subscription to the admin / system status %s',
    async (status) => {
      const id = await seed('active');
      const res = await patch(id, { status });
      expect(res.statusCode).toBe(403);
      expect((await dbRow(id)).status).toBe('active');
    },
  );

  it('does not let a quota update smuggle a status change through', async () => {
    const id = await seed('denied');
    const before = await dbRow(id);
    const res = await patch(id, { status: 'active', quotaRequests: 99 });
    expect(res.statusCode).toBe(403);
    // rejected as a whole: neither the status nor the quota changed
    expect(await dbRow(id)).toEqual(before);
    expect(before.status).toBe('denied');
  });

  it.each(['cancelled', 'inactive'])('still lets the owner cancel (%s)', async (status) => {
    const id = await seed('active');

    const res = await patch(id, { status });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe(status);
    expect((await dbRow(id)).status).toBe(status);
    expect(await updateAudits(id)).toBe(1);
  });

  it('lets the owner cancel a subscription that is not active either', async () => {
    const id = await seed('denied');
    const res = await patch(id, { status: 'inactive' });
    expect(res.statusCode).toBe(200);
    expect((await dbRow(id)).status).toBe('inactive');
  });

  it('keeps quota updates working, and ignores a status equal to the current one', async () => {
    const id = await seed('pending');

    const res = await patch(id, { status: 'pending', quotaRequests: 4321 });

    expect(res.statusCode).toBe(200);
    expect(await dbRow(id)).toMatchObject({ status: 'pending', quota_requests: 4321 });
  });

  it('rejects unknown statuses at the schema level', async () => {
    const id = await seed('pending');
    const res = await patch(id, { status: 'superuser' });
    expect(res.statusCode).toBe(400);
    expect((await dbRow(id)).status).toBe('pending');
  });

  it("does not touch another user's subscription (404, even for an admin token)", async () => {
    const id = await seed('denied');
    const res = await patch(id, { status: 'active' }, admin());
    expect(res.statusCode).toBe(404);
    expect((await dbRow(id)).status).toBe('denied');
  });

  it('requires authentication', async () => {
    const id = await seed('denied');
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/subscriptions/${id}`,
      payload: { status: 'active' },
    });
    expect(res.statusCode).toBe(401);
    expect((await dbRow(id)).status).toBe('denied');
  });

  it('activation still works through the admin decision paths (approve / revert)', async () => {
    const pending = await seed('pending');
    const approve = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/subscriptions/approve',
      headers: { authorization: admin(), 'content-type': 'application/json' },
      payload: { subscriptionIds: [pending], reason: 'ok' },
    });
    expect(JSON.parse(approve.body)).toMatchObject({ successful: 1, failed: 0 });
    expect((await dbRow(pending)).status).toBe('active');

    await app.dbUtils.query("UPDATE subscriptions SET status = 'denied' WHERE id = $1", [pending]);
    const revert = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/subscriptions/${pending}/revert`,
      headers: { authorization: admin(), 'content-type': 'application/json' },
      payload: { newStatus: 'active' },
    });
    expect(revert.statusCode).toBe(200);
    expect((await dbRow(pending)).status).toBe('active');
  });
});
