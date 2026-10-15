/**
 * The MaaS section of GET /health. Hermetic: the route plugin is registered on a bare Fastify
 * instance with fake clients (no database, no cluster), so each test gets its own 30 s result cache.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import healthRoutes from '../../../src/routes/health';
import { K8sApiError, matchesLabelSelector } from '../../../src/services/k8s/k8s-client';
import { MAAS_AUTH_POLICY } from '../../../src/services/maas/maas-resources';

const NAMESPACE = 'models-as-a-service';

function fakeK8s(overrides: Record<string, unknown> = {}) {
  return {
    mock: false,
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

let app: FastifyInstance | undefined;

async function buildApp(k8s: ReturnType<typeof fakeK8s>) {
  const instance = Fastify({ logger: false });
  // fakes for what the app's plugins normally provide (decorator types are strict)
  const decorate = instance.decorate.bind(instance) as (name: string, value: unknown) => void;
  decorate('dbUtils', { queryOne: async () => ({ test: 1 }) });
  decorate('rbac', {});
  decorate('oauth', {});
  decorate('sessionService', {});
  decorate('authenticate', async () => undefined);
  decorate('requirePermission', () => async () => undefined);
  decorate('maasClients', {
    k8s,
    maasApi: { mock: false, health: async () => ({ healthy: true }) },
    prometheus: { mock: false, health: async () => ({ healthy: true }) },
    config: { namespace: NAMESPACE },
  });
  await instance.register(healthRoutes);
  await instance.ready();
  app = instance;
  return instance;
}

async function getMaas(instance: FastifyInstance) {
  const res = await instance.inject({ method: 'GET', url: '/' });
  return JSON.parse(res.body).maas as Record<string, unknown>;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await app?.close();
  app = undefined;
});

describe('GET /health maas.kubernetes', () => {
  it('lists policies in the MaaS namespace with a selector that matches nothing', async () => {
    const k8s = fakeK8s();
    const maas = await getMaas(await buildApp(k8s));

    expect(maas).toMatchObject({ enabled: true, kubernetes: 'healthy' });
    expect(k8s.list).toHaveBeenCalledTimes(1);
    const [ref, options] = k8s.list.mock.calls[0] as [typeof MAAS_AUTH_POLICY, any];
    expect(ref).toBe(MAAS_AUTH_POLICY);
    expect(options.namespace).toBe(NAMESPACE);
    // no LiteMaaS object may ever match the probe selector
    expect(matchesLabelSelector({}, options.labelSelector)).toBe(false);
    expect(
      matchesLabelSelector(
        { 'app.kubernetes.io/managed-by': 'litemaas', 'litemaas.io/user-id': 'u' },
        options.labelSelector,
      ),
    ).toBe(false);
  });

  it('is unhealthy when the MaaSAuthPolicy CRD is missing (404) and says so in the log', async () => {
    // A get() of a non-existent object resolves null on a missing CRD as well: only list() tells
    const k8s = fakeK8s({
      list: vi
        .fn()
        .mockRejectedValue(
          new K8sApiError('the server could not find the requested resource', 404, 'NotFound'),
        ),
    });
    const instance = await buildApp(k8s);
    const warn = vi.spyOn(instance.log, 'warn');

    const maas = await getMaas(instance);

    expect(maas).toMatchObject({
      kubernetes: 'unhealthy',
      maasApi: 'healthy',
      prometheus: 'healthy',
    });
    expect(k8s.get).not.toHaveBeenCalled();
    const entry = warn.mock.calls.find(
      ([obj, msg]) => msg === 'MaaS health check failed' && (obj as any).check === 'kubernetes',
    );
    expect(entry).toBeTruthy();
    const logged = (entry![0] as any).error as string;
    expect(logged).toContain('maasauthpolicies.maas.opendatahub.io');
    expect(logged).toMatch(/operator installed/i);
  });

  it('is unhealthy when RBAC forbids listing policies (403), keeping the cluster message', async () => {
    const k8s = fakeK8s({
      list: vi
        .fn()
        .mockRejectedValue(
          new K8sApiError('maasauthpolicies is forbidden: cannot list resource', 403, 'Forbidden'),
        ),
    });
    const instance = await buildApp(k8s);
    const warn = vi.spyOn(instance.log, 'warn');

    const maas = await getMaas(instance);

    expect(maas.kubernetes).toBe('unhealthy');
    const entry = warn.mock.calls.find(([, msg]) => msg === 'MaaS health check failed');
    expect(((entry![0] as any).error as string).toLowerCase()).toContain('forbidden');
  });

  it('is unhealthy on a transport failure', async () => {
    const k8s = fakeK8s({
      list: vi.fn().mockRejectedValue(new K8sApiError('connect ECONNREFUSED', 0, 'TransportError')),
    });
    expect((await getMaas(await buildApp(k8s))).kubernetes).toBe('unhealthy');
  });

  it('reports an unconfigured client as unconfigured, not unhealthy', async () => {
    const k8s = fakeK8s({
      list: vi.fn().mockRejectedValue(new Error('Kubernetes client is not configured')),
    });
    expect((await getMaas(await buildApp(k8s))).kubernetes).toBe('unconfigured');
  });

  it('never changes the overall status or HTTP code', async () => {
    const healthy = await buildApp(fakeK8s());
    const before = await healthy.inject({ method: 'GET', url: '/' });
    await healthy.close();

    const broken = await buildApp(
      fakeK8s({ list: vi.fn().mockRejectedValue(new K8sApiError('nope', 404, 'NotFound')) }),
    );
    const after = await broken.inject({ method: 'GET', url: '/' });

    expect(JSON.parse(after.body).maas.kubernetes).toBe('unhealthy');
    expect(after.statusCode).toBe(before.statusCode);
    expect(JSON.parse(after.body).status).toBe(JSON.parse(before.body).status);
    expect(JSON.parse(after.body).checks).toEqual(JSON.parse(before.body).checks);
  });
});
