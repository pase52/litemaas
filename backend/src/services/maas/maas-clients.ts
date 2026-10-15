import type { FastifyInstance } from 'fastify';
import { ApplicationError } from '../../utils/errors.js';
import { loadClusterCaBundle, type TlsOptions } from '../http/tls-fetch.js';
import {
  InMemoryK8sClient,
  K8sClient,
  resolveK8sClientConfig,
  type IK8sClient,
  type K8sObject,
} from '../k8s/k8s-client.js';
import { MaasApiClient, MockMaasApiClient, type IMaasApiClient } from './maas-api.client.js';
import { getMaasConfig, isDevOrTest, type MaasConfig } from './maas-config.js';
import {
  MAAS_MODEL_REF,
  ANNOTATION_DESCRIPTION,
  ANNOTATION_DISPLAY_NAME,
} from './maas-resources.js';
import {
  MockPrometheusClient,
  PrometheusClient,
  type IPrometheusClient,
} from './prometheus.client.js';

export interface MaasClients {
  config: MaasConfig;
  k8s: IK8sClient;
  maasApi: IMaasApiClient;
  prometheus: IPrometheusClient;
}

/**
 * A client for a service that is not configured outside dev/test: every call fails with a
 * 503 so misconfiguration is visible instead of silently serving mock data in production.
 */
function unconfigured<T extends object>(service: string): T {
  return new Proxy({} as T, {
    get(_t, prop) {
      if (prop === 'mock') return false;
      if (prop === 'then' || typeof prop === 'symbol') return undefined;
      return async () => {
        throw ApplicationError.serviceUnavailable(`${service} (not configured)`);
      };
    },
  });
}

/** Sample MaaSModelRefs exposed by the in-memory cluster in mock mode */
export function seedMockCluster(
  client: InMemoryK8sClient,
  modelNamespace = 'maas-demo-models',
): void {
  const refs: Array<[string, string, string, string]> = [
    ['llama-3-2-3b', 'Llama 3.2 3B Instruct', 'Compact general purpose chat model', 'Ready'],
    ['granite-3-3-8b', 'Granite 3.3 8B Instruct', 'IBM Granite instruction-tuned model', 'Ready'],
    ['qwen3-32b', 'Qwen3 32B', 'Large reasoning model (still starting)', 'Pending'],
  ];
  for (const [name, display, description, phase] of refs) {
    const obj: K8sObject = {
      apiVersion: 'maas.opendatahub.io/v1alpha1',
      kind: 'MaaSModelRef',
      metadata: {
        name,
        namespace: modelNamespace,
        annotations: { [ANNOTATION_DISPLAY_NAME]: display, [ANNOTATION_DESCRIPTION]: description },
      },
      spec: { modelRef: { kind: 'LLMInferenceService', name } },
      status: {
        phase,
        endpoint:
          phase === 'Ready' ? `https://maas.mock.local/${modelNamespace}/${name}` : undefined,
      },
    };
    client.seed(MAAS_MODEL_REF, obj, modelNamespace);
  }
}

/**
 * Build the K8s / maas-api / Prometheus clients from configuration.
 *
 * Each client independently falls back to an in-memory mock when its endpoint is not
 * configured AND NODE_ENV is development/test (same rule LiteLLMService uses). In other
 * environments an unconfigured endpoint yields a client that fails with 503.
 */
export function createMaasClients(fastify: FastifyInstance): MaasClients {
  const cfg = fastify.config;
  const config = getMaasConfig(cfg);
  const log = fastify.log;
  const mockAllowed = isDevOrTest();

  // Kubernetes API
  let k8s: IK8sClient;
  const k8sCfg = resolveK8sClientConfig(cfg);
  if (k8sCfg) {
    k8s = new K8sClient(k8sCfg, log);
  } else if (mockAllowed) {
    const mock = new InMemoryK8sClient();
    seedMockCluster(mock);
    k8s = mock;
    log.info('MaaS: Kubernetes API not configured - using in-memory mock cluster');
  } else {
    k8s = unconfigured<IK8sClient>('Kubernetes API');
    log.error('MaaS: Kubernetes API not configured (set K8S_API_URL or run in-cluster)');
  }

  // Shared TLS for maas-api / Prometheus: cluster CAs on top of system roots
  const clusterTls = (skip: boolean): TlsOptions | undefined =>
    skip
      ? { rejectUnauthorized: false }
      : loadClusterCaBundle()
        ? { ca: loadClusterCaBundle() }
        : undefined;

  // maas-api
  let maasApi: IMaasApiClient;
  if (config.apiUrl) {
    maasApi = new MaasApiClient(
      { baseUrl: config.apiUrl, tls: clusterTls(cfg.K8S_API_SKIP_TLS_VERIFY === 'true') },
      log,
    );
  } else if (mockAllowed) {
    maasApi = new MockMaasApiClient();
    log.info('MaaS: MAAS_API_URL not set - using mock maas-api');
  } else {
    maasApi = unconfigured<IMaasApiClient>('maas-api');
    log.error('MaaS: MAAS_API_URL is not set');
  }

  // Prometheus / Thanos
  let prometheus: IPrometheusClient;
  if (cfg.PROMETHEUS_URL) {
    prometheus = new PrometheusClient(
      {
        baseUrl: cfg.PROMETHEUS_URL.replace(/\/+$/, ''),
        token: cfg.PROMETHEUS_TOKEN || undefined,
        // Fall back to the k8s credentials (in-cluster SA token / K8S_TOKEN)
        tokenProvider: () => k8sCfg?.token ?? k8sCfg?.tokenProvider?.(),
        tls: clusterTls(cfg.PROMETHEUS_SKIP_TLS_VERIFY === 'true'),
      },
      log,
    );
  } else if (mockAllowed) {
    prometheus = new MockPrometheusClient();
    log.info('MaaS: PROMETHEUS_URL not set - using mock Prometheus');
  } else {
    prometheus = unconfigured<IPrometheusClient>('Prometheus');
    log.error('MaaS: PROMETHEUS_URL is not set');
  }

  return { config, k8s, maasApi, prometheus };
}
