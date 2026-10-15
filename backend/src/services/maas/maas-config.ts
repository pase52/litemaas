import type { FastifyInstance } from 'fastify';

/**
 * Normalised view over the MaaS-related environment configuration.
 * Built from `fastify.config` so it can be unit-tested without a Fastify instance.
 */
export interface MaasConfig {
  enabled: boolean;
  apiUrl?: string;
  gatewayUrl?: string;
  /** Namespace holding MaaSAuthPolicy / MaaSSubscription objects */
  namespace: string;
  /**
   * Identifies this deployment on the objects it creates (label litemaas.io/instance), so two
   * LiteMaaS instances sharing a MaaS namespace never reconcile each other's objects.
   * Undefined = derive it from the in-cluster namespace (or "default").
   */
  instanceId?: string;
  /** Namespaces scanned for MaaSModelRef objects; empty = all namespaces */
  modelNamespaces: string[];
  syncIntervalMs: number;
  reconcileIntervalMs: number;
  migrationGraceDays: number;
  /** Limitador counter metric names / extra PromQL label matchers used by the usage source */
  usageHitsMetric: string;
  usageCallsMetric: string;
  usageLabelMatchers?: string;
  /**
   * How many days of history Prometheus / Thanos keeps (platform Prometheus: about 15). Days
   * older than this are never queried by the usage resync: querying them returns an empty vector
   * without an error, so their cached MaaS usage is carried forward instead.
   */
  usageRetentionDays: number;
  /** HTTP timeout of a single Prometheus request */
  prometheusTimeoutMs: number;
}

type ConfigSource = Partial<FastifyInstance['config']> | Record<string, string | undefined>;

function toInt(value: string | undefined, fallback: number): number {
  const n = parseInt(value ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function stripTrailingSlash(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const trimmed = url.trim().replace(/\/+$/, '');
  return trimmed || undefined;
}

export function getMaasConfig(config: ConfigSource): MaasConfig {
  const c = config as Record<string, string | undefined>;
  return {
    enabled: (c.MAAS_ENABLED || '').toLowerCase() === 'true',
    apiUrl: stripTrailingSlash(c.MAAS_API_URL),
    gatewayUrl: stripTrailingSlash(c.MAAS_GATEWAY_URL),
    namespace: c.MAAS_NAMESPACE?.trim() || 'models-as-a-service',
    instanceId: c.MAAS_INSTANCE_ID?.trim() || undefined,
    modelNamespaces: (c.MAAS_MODEL_NAMESPACES || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    syncIntervalMs: toInt(c.MAAS_SYNC_INTERVAL_MS, 300_000),
    reconcileIntervalMs: toInt(c.MAAS_RECONCILE_INTERVAL_MS, 300_000),
    migrationGraceDays: toInt(c.MAAS_MIGRATION_GRACE_DAYS, 14),
    usageHitsMetric: c.MAAS_USAGE_HITS_METRIC?.trim() || 'authorized_hits',
    usageCallsMetric: c.MAAS_USAGE_CALLS_METRIC?.trim() || 'authorized_calls',
    usageLabelMatchers: c.MAAS_USAGE_LABEL_MATCHERS?.trim() || undefined,
    usageRetentionDays: toInt(c.MAAS_USAGE_RETENTION_DAYS, 15),
    prometheusTimeoutMs: toInt(c.PROMETHEUS_TIMEOUT_MS, 10_000),
  };
}

/** Mock mode is only ever active in development/test and only when the real endpoint is unset. */
export function isDevOrTest(): boolean {
  return process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';
}
