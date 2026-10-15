import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createMaasClients,
  isUnconfiguredClient,
  seedMockCluster,
} from '../../../../src/services/maas/maas-clients';
import { InMemoryK8sClient, K8sClient } from '../../../../src/services/k8s/k8s-client';
import { MaasApiClient, MockMaasApiClient } from '../../../../src/services/maas/maas-api.client';
import {
  PrometheusClient,
  MockPrometheusClient,
} from '../../../../src/services/maas/prometheus.client';
import { MAAS_MODEL_REF } from '../../../../src/services/maas/maas-resources';

const fastifyWith = (config: Record<string, string | undefined>) =>
  ({
    config: { MAAS_ENABLED: 'true', MAAS_NAMESPACE: 'models-as-a-service', ...config },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  }) as any;

describe('createMaasClients', () => {
  const origEnv = process.env.NODE_ENV;
  const origHost = process.env.KUBERNETES_SERVICE_HOST;
  afterEach(() => {
    process.env.NODE_ENV = origEnv;
    if (origHost === undefined) delete process.env.KUBERNETES_SERVICE_HOST;
    else process.env.KUBERNETES_SERVICE_HOST = origHost;
  });

  it('falls back to mocks in dev/test when nothing is configured', async () => {
    delete process.env.KUBERNETES_SERVICE_HOST;
    const c = createMaasClients(fastifyWith({}));
    expect(c.k8s).toBeInstanceOf(InMemoryK8sClient);
    expect(c.maasApi).toBeInstanceOf(MockMaasApiClient);
    expect(c.prometheus).toBeInstanceOf(MockPrometheusClient);
    // mock cluster ships sample MaaSModelRefs
    const refs = await c.k8s.list(MAAS_MODEL_REF);
    expect(refs.length).toBeGreaterThanOrEqual(2);
    expect(refs.some((r) => r.status?.phase === 'Ready')).toBe(true);
  });

  it('builds real clients when endpoints are configured', () => {
    const c = createMaasClients(
      fastifyWith({
        K8S_API_URL: 'https://api.x:6443',
        K8S_TOKEN: 't',
        MAAS_API_URL: 'https://maas.x/maas-api',
        PROMETHEUS_URL: 'https://thanos.x/',
        PROMETHEUS_TOKEN: 'p',
      }),
    );
    expect(c.k8s).toBeInstanceOf(K8sClient);
    expect(c.maasApi).toBeInstanceOf(MaasApiClient);
    expect(c.prometheus).toBeInstanceOf(PrometheusClient);
    expect(c.k8s.mock && c.maasApi.mock && c.prometheus.mock).toBe(false);
  });

  it('gives the Prometheus client a 10 s timeout unless PROMETHEUS_TIMEOUT_MS says otherwise', () => {
    const base = { PROMETHEUS_URL: 'https://thanos.x', PROMETHEUS_TOKEN: 'p' };
    const timeoutOf = (c: ReturnType<typeof createMaasClients>) =>
      (c.prometheus as any).config.timeoutMs;
    expect(timeoutOf(createMaasClients(fastifyWith(base)))).toBe(10_000);
    expect(
      timeoutOf(createMaasClients(fastifyWith({ ...base, PROMETHEUS_TIMEOUT_MS: '2500' }))),
    ).toBe(2500);
    // an invalid value falls back to the default instead of disabling the timeout
    expect(timeoutOf(createMaasClients(fastifyWith({ ...base, PROMETHEUS_TIMEOUT_MS: '0' })))).toBe(
      10_000,
    );
  });

  it('does not inherit K8S_API_SKIP_TLS_VERIFY for maas-api; has its own flag with a warning', () => {
    const insecure = (c: any) => (c.maasApi as any).config.tls?.rejectUnauthorized === false;
    const base = { MAAS_API_URL: 'https://maas.x', K8S_API_URL: 'https://api.x', K8S_TOKEN: 't' };
    const k8sOnly = createMaasClients(fastifyWith({ ...base, K8S_API_SKIP_TLS_VERIFY: 'true' }));
    expect(insecure(k8sOnly)).toBe(false);

    const fastify = fastifyWith({ ...base, MAAS_API_SKIP_TLS_VERIFY: 'true' });
    const own = createMaasClients(fastify);
    expect(insecure(own)).toBe(true);
    expect(fastify.log.warn).toHaveBeenCalledWith(
      expect.stringContaining('MAAS_API_SKIP_TLS_VERIFY'),
    );
  });

  it('mixes real and mock clients independently', () => {
    delete process.env.KUBERNETES_SERVICE_HOST;
    const c = createMaasClients(fastifyWith({ MAAS_API_URL: 'https://maas.x' }));
    expect(c.maasApi).toBeInstanceOf(MaasApiClient);
    expect(c.k8s.mock).toBe(true);
  });

  it('never mocks in production: unconfigured clients fail with 503', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.KUBERNETES_SERVICE_HOST;
    const f = fastifyWith({});
    const c = createMaasClients(f);
    expect(c.k8s.mock).toBe(false);
    await expect(c.k8s.list(MAAS_MODEL_REF)).rejects.toMatchObject({ statusCode: 503 });
    await expect(c.maasApi.health()).rejects.toMatchObject({ statusCode: 503 });
    await expect(c.prometheus.query('x')).rejects.toMatchObject({ statusCode: 503 });
    expect(f.log.error).toHaveBeenCalled();
    // Usage degrades gracefully without Prometheus: callers can detect the placeholder client
    expect(isUnconfiguredClient(c.prometheus)).toBe(true);
    expect(isUnconfiguredClient(c.k8s)).toBe(true);
    expect(f.log.warn).toHaveBeenCalledWith(expect.stringContaining('PROMETHEUS_URL is not set'));
  });

  it('real and mock clients are not flagged as unconfigured', () => {
    delete process.env.KUBERNETES_SERVICE_HOST;
    const c = createMaasClients(fastifyWith({ MAAS_API_URL: 'https://maas.x' }));
    expect(isUnconfiguredClient(c.maasApi)).toBe(false);
    expect(isUnconfiguredClient(c.k8s)).toBe(false);
    expect(isUnconfiguredClient(c.prometheus)).toBe(false);
  });

  it('uses the in-cluster environment when present', () => {
    process.env.KUBERNETES_SERVICE_HOST = '10.1.1.1';
    const c = createMaasClients(fastifyWith({ MAAS_API_URL: 'https://maas.x' }));
    expect(c.k8s).toBeInstanceOf(K8sClient);
  });
});

describe('seedMockCluster', () => {
  it('seeds into a custom namespace', async () => {
    const k = new InMemoryK8sClient();
    seedMockCluster(k, 'my-ns');
    const refs = await k.list(MAAS_MODEL_REF, { namespace: 'my-ns' });
    expect(refs.length).toBeGreaterThan(0);
    expect(refs[0].metadata.annotations?.['openshift.io/display-name']).toBeTruthy();
  });
});
