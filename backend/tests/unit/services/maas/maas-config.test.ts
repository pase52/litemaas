import { describe, it, expect } from 'vitest';
import { getMaasConfig } from '../../../../src/services/maas/maas-config';

describe('getMaasConfig', () => {
  it('is disabled with sane defaults for an empty config', () => {
    expect(getMaasConfig({})).toEqual({
      enabled: false,
      apiUrl: undefined,
      gatewayUrl: undefined,
      namespace: 'models-as-a-service',
      modelNamespaces: [],
      syncIntervalMs: 300000,
      reconcileIntervalMs: 300000,
      migrationGraceDays: 14,
      usageHitsMetric: 'authorized_hits',
      usageCallsMetric: 'authorized_calls',
      usageLabelMatchers: undefined,
      usageRetentionDays: 15,
      prometheusTimeoutMs: 10000,
    });
  });

  it('parses explicit values, trims slashes/spaces and splits namespaces', () => {
    const c = getMaasConfig({
      MAAS_ENABLED: 'TRUE',
      MAAS_API_URL: 'https://maas.apps.x/maas-api/',
      MAAS_GATEWAY_URL: ' https://gw.apps.x ',
      MAAS_NAMESPACE: 'custom-ns',
      MAAS_MODEL_NAMESPACES: 'a, b ,,c',
      MAAS_SYNC_INTERVAL_MS: '1000',
      MAAS_RECONCILE_INTERVAL_MS: '2000',
      MAAS_MIGRATION_GRACE_DAYS: '3',
    });
    expect(c).toMatchObject({
      enabled: true,
      apiUrl: 'https://maas.apps.x/maas-api',
      gatewayUrl: 'https://gw.apps.x',
      namespace: 'custom-ns',
      modelNamespaces: ['a', 'b', 'c'],
      syncIntervalMs: 1000,
      reconcileIntervalMs: 2000,
      migrationGraceDays: 3,
    });
  });

  it('reads Limitador metric names and extra matchers', () => {
    const c = getMaasConfig({
      MAAS_USAGE_HITS_METRIC: ' my_hits ',
      MAAS_USAGE_CALLS_METRIC: 'my_calls',
      MAAS_USAGE_LABEL_MATCHERS: ' namespace="kuadrant-system" ',
    });
    expect(c).toMatchObject({
      usageHitsMetric: 'my_hits',
      usageCallsMetric: 'my_calls',
      usageLabelMatchers: 'namespace="kuadrant-system"',
    });
  });

  it('reads the usage retention and the Prometheus timeout', () => {
    const c = getMaasConfig({ MAAS_USAGE_RETENTION_DAYS: '30', PROMETHEUS_TIMEOUT_MS: '2500' });
    expect(c.usageRetentionDays).toBe(30);
    expect(c.prometheusTimeoutMs).toBe(2500);
  });

  it('falls back to 15 days / 10 s for missing, zero, negative or non-numeric values', () => {
    for (const bad of ['', '0', '-3', 'abc']) {
      const c = getMaasConfig({ MAAS_USAGE_RETENTION_DAYS: bad, PROMETHEUS_TIMEOUT_MS: bad });
      expect(c.usageRetentionDays).toBe(15);
      expect(c.prometheusTimeoutMs).toBe(10000);
    }
  });

  it('only "true" enables, and invalid numbers fall back to defaults', () => {
    expect(getMaasConfig({ MAAS_ENABLED: 'yes' }).enabled).toBe(false);
    expect(getMaasConfig({ MAAS_ENABLED: 'false' }).enabled).toBe(false);
    const c = getMaasConfig({ MAAS_SYNC_INTERVAL_MS: 'abc', MAAS_MIGRATION_GRACE_DAYS: '-5' });
    expect(c.syncIntervalMs).toBe(300000);
    expect(c.migrationGraceDays).toBe(14);
  });
});
