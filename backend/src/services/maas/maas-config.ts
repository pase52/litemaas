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
  /** Namespaces scanned for MaaSModelRef objects; empty = all namespaces */
  modelNamespaces: string[];
  syncIntervalMs: number;
  reconcileIntervalMs: number;
  migrationGraceDays: number;
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
    modelNamespaces: (c.MAAS_MODEL_NAMESPACES || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    syncIntervalMs: toInt(c.MAAS_SYNC_INTERVAL_MS, 300_000),
    reconcileIntervalMs: toInt(c.MAAS_RECONCILE_INTERVAL_MS, 300_000),
    migrationGraceDays: toInt(c.MAAS_MIGRATION_GRACE_DAYS, 14),
  };
}

/** Mock mode is only ever active in development/test and only when the real endpoint is unset. */
export function isDevOrTest(): boolean {
  return process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';
}
