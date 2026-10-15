import type { FastifyInstance } from 'fastify';
import type { LiteLLMDayData } from '../../types/admin-usage.types.js';
import { ApplicationError } from '../../utils/errors.js';
import { MAAS_PROVIDER, setMaasModelIds } from '../admin-usage/admin-usage.utils.js';
import type { UsageSource } from '../backends/backend.types.js';
import type { MaasClients } from './maas-clients.js';
import { MAAS_KEY_HASH_PREFIX } from './maas-key.service.js';
import type { PromSample } from './prometheus.client.js';

/**
 * MaaS usage from Limitador counters in Thanos / Prometheus.
 *
 *  - tokens: `authorized_hits`  (hits_addend of the token rate limit = total tokens)
 *  - calls:  `authorized_calls` (requests that passed rate limiting)
 *
 * One instant query per metric and UTC day:
 *
 *   sum by (subscription, model) (increase(<metric>{<matchers>}[<window>s]))
 *
 * evaluated at the END of the day (D+1 00:00:00Z, window 86400 s). The current day is partial:
 * evaluated now with a window equal to the seconds elapsed since 00:00:00Z.
 *
 * Mapping to the admin usage model (LiteLLMDayData):
 *  - `subscription` label -> synthetic key_hash `maas:<subscription>` (see maas-key.service.ts)
 *  - `model` label -> LiteMaaS model id (`<ns>/<ref>`) via models.id / maas_model_ref_name /
 *    backend_model_name (case-insensitive); unresolved labels are kept as-is (cost 0)
 *  - cost = total tokens x BLENDED price, blended = (input_cost_per_token + output_cost_per_token) / 2
 *    (or the single configured price). Limitador only counts total tokens, so the prompt /
 *    completion split is unavailable. The admin usage enrichment re-derives total_tokens as
 *    prompt_tokens + completion_tokens at every level, so MaaS tokens are carried in
 *    `prompt_tokens` (completion_tokens = 0) to keep the totals correct, and the day is flagged
 *    `sources.maas.tokenSplitAvailable = false`, `costEstimated = true`. Consumers must not
 *    interpret the prompt/completion ratio of MaaS usage.
 *  - api_requests = authorized_calls; successful_requests = authorized_calls (Limitador only sees
 *    authorized calls, failures after authorization are not distinguishable), failed_requests = 0.
 *
 * Failure handling (Prometheus is a best-effort dependency of the usage pages):
 *  - After a transport / timeout / 5xx / 429 / partial-response failure the endpoint is not queried
 *    for {@link PROMETHEUS_BREAKER_COOLDOWN_MS}: calls fail at once with the error that opened the
 *    breaker, so callers take their usual fallback without paying the timeout again.
 *  - Prometheus keeps only a limited history (MAAS_USAGE_RETENTION_DAYS). Older windows are NOT an
 *    error: `increase()` just returns partial or zero values, so the daily cache is the only
 *    long-term store of MaaS usage (see {@link extractMaasSlice}).
 */

export const SECONDS_PER_DAY = 86_400;
const SUBSCRIPTION_PREFIX = 'litemaas-key-';
const CACHE_TTL_MS = 5 * 60 * 1000;
const MODEL_CACHE_TTL_MS = 60_000;
const DAY_QUERY_CONCURRENCY = 6;
/** Hard cap on days per range request (protects Thanos) */
export const MAX_RANGE_DAYS = 120;
/** After a transport / 5xx failure Prometheus is left alone for this long */
export const PROMETHEUS_BREAKER_COOLDOWN_MS = 60_000;

export interface MaasUsageRow {
  /** Limitador `subscription` label with any `<namespace>/` prefix removed */
  subscription: string;
  /** Raw Limitador `model` label */
  model: string;
  tokens: number;
  calls: number;
}

export interface MaasModelInfoRow {
  id: string;
  name: string | null;
  backend_model_name: string | null;
  maas_model_ref_name: string | null;
  maas_model_ref_namespace: string | null;
  input_cost_per_token: string | number | null;
  output_cost_per_token: string | number | null;
}

export interface ResolvedMaasModel {
  /** LiteMaaS model id or the raw label when unresolved */
  id: string;
  /** Price per token used for cost estimation */
  unitPrice: number;
  resolved: boolean;
}

export type MaasModelResolver = (label: string) => ResolvedMaasModel;

export interface MaasUsageSummary {
  totalRequests: number;
  totalTokens: number;
  totalCost: number;
  byModel: Array<{ modelId: string; requests: number; tokens: number; cost: number }>;
  daily: Array<{ date: string; requests: number; tokens: number; cost: number }>;
  /** Always false: Limitador exposes total tokens only */
  tokenSplitAvailable: false;
  costEstimated: true;
}

function toNumber(v: unknown): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : 0;
}

/** Counter increases are extrapolated by Prometheus; round to whole tokens/calls */
function roundCount(v: unknown): number {
  const n = toNumber(v);
  return n > 0 ? Math.round(n) : 0;
}

function utcDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Evaluation time + range window of one UTC day, or null for a future day.
 * Exported for tests.
 */
export function dayWindow(
  date: string,
  now: Date = new Date(),
): { evalTime: Date; windowSeconds: number; partial: boolean } | null {
  const start = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(start)) return null;
  const end = start + SECONDS_PER_DAY * 1000;
  const nowMs = now.getTime();
  if (start > nowMs) return null;
  if (nowMs >= end) {
    return { evalTime: new Date(end), windowSeconds: SECONDS_PER_DAY, partial: false };
  }
  // Today: from 00:00Z until now (at least 60 s so the range selector is valid)
  const windowSeconds = Math.max(60, Math.ceil((nowMs - start) / 1000));
  return { evalTime: new Date(nowMs), windowSeconds, partial: true };
}

/**
 * True when the whole UTC day lies inside the Prometheus / Thanos retention window, i.e. when
 * the day's `increase()` window does not reach back past the oldest retained sample. Beyond that
 * the query silently returns partial or zero values instead of failing. An unparsable date counts
 * as retained (the regular path rejects it).
 */
export function isWithinUsageRetention(
  date: string,
  retentionDays: number,
  now: Date = new Date(),
): boolean {
  const start = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(start)) return true;
  return start >= now.getTime() - retentionDays * SECONDS_PER_DAY * 1000;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Escape for a double-quoted PromQL string literal */
function escapePromString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function stripNamespace(subscription: string): string {
  const idx = subscription.lastIndexOf('/');
  return idx >= 0 ? subscription.slice(idx + 1) : subscription;
}

function emptyMetrics() {
  return {
    api_requests: 0,
    total_tokens: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    spend: 0,
  };
}

/**
 * Whether a failed Prometheus call means the endpoint is down or overloaded (transport error,
 * timeout, 5xx, 429, partial response: all `retryable`) rather than the request being wrong
 * (4xx). Only the former opens the breaker. Errors of unknown kind count as outages.
 */
function isPrometheusOutage(error: unknown): boolean {
  return !(error instanceof ApplicationError) || error.retryable;
}

/**
 * Merge a second backend's day into the first (pure). Either side may be null.
 * Model entries with the same name are summed and their api_keys maps combined.
 */
export function mergeDayData(
  a: LiteLLMDayData | null,
  b: LiteLLMDayData | null,
): LiteLLMDayData | null {
  if (!a) return b;
  if (!b) return a;

  const merged: LiteLLMDayData = {
    date: a.date,
    metrics: {
      api_requests: a.metrics.api_requests + b.metrics.api_requests,
      total_tokens: a.metrics.total_tokens + b.metrics.total_tokens,
      prompt_tokens: a.metrics.prompt_tokens + b.metrics.prompt_tokens,
      completion_tokens: a.metrics.completion_tokens + b.metrics.completion_tokens,
      spend: a.metrics.spend + b.metrics.spend,
      successful_requests: a.metrics.successful_requests + b.metrics.successful_requests,
      failed_requests: a.metrics.failed_requests + b.metrics.failed_requests,
    },
    breakdown: {
      models: { ...a.breakdown.models },
      api_keys: { ...a.breakdown.api_keys, ...b.breakdown.api_keys },
      providers: { ...a.breakdown.providers, ...b.breakdown.providers },
    },
    ...((a.sources || b.sources) && { sources: { ...a.sources, ...b.sources } }),
  };

  // Providers sharing a name are summed (b must not overwrite a)
  for (const [name, p] of Object.entries(b.breakdown.providers ?? {})) {
    const e = a.breakdown.providers?.[name];
    if (!e) {
      merged.breakdown.providers[name] = p;
      continue;
    }
    merged.breakdown.providers[name] = {
      ...e,
      metrics: {
        ...e.metrics,
        api_requests: e.metrics.api_requests + p.metrics.api_requests,
        total_tokens: e.metrics.total_tokens + p.metrics.total_tokens,
        prompt_tokens: (e.metrics.prompt_tokens ?? 0) + (p.metrics.prompt_tokens ?? 0),
        completion_tokens: (e.metrics.completion_tokens ?? 0) + (p.metrics.completion_tokens ?? 0),
        spend: e.metrics.spend + p.metrics.spend,
      },
    };
  }

  for (const [name, model] of Object.entries(b.breakdown.models)) {
    const existing = merged.breakdown.models[name];
    if (!existing) {
      merged.breakdown.models[name] = model;
      continue;
    }
    merged.breakdown.models[name] = {
      metrics: {
        api_requests: existing.metrics.api_requests + model.metrics.api_requests,
        total_tokens: existing.metrics.total_tokens + model.metrics.total_tokens,
        prompt_tokens: existing.metrics.prompt_tokens + model.metrics.prompt_tokens,
        completion_tokens: existing.metrics.completion_tokens + model.metrics.completion_tokens,
        spend: existing.metrics.spend + model.metrics.spend,
      },
      api_keys: { ...existing.api_keys, ...model.api_keys },
    };
  }
  return merged;
}

/**
 * The MaaS part of a (possibly merged) day, in the exact shape {@link MaasUsageSource.getDayData}
 * produces: the entries whose key hash is `maas:<subscription>`, with the model, provider and day
 * totals re-derived from them (LiteLLM usage under the same model name is left out), plus the
 * `sources.maas` data-quality flag. Null when the day holds no MaaS usage.
 *
 * Prometheus only keeps a limited history, so a cached day is the only long-term copy of its
 * MaaS usage: callers that must rebuild a day (usage resync) read this slice first and merge it
 * back when Prometheus can no longer provide it.
 */
export function extractMaasSlice(day: LiteLLMDayData | null | undefined): LiteLLMDayData | null {
  const models = day?.breakdown?.models;
  if (!day || !models) return null;

  const slice: LiteLLMDayData = {
    date: day.date,
    metrics: { ...emptyMetrics(), successful_requests: 0, failed_requests: 0 },
    breakdown: { models: {}, api_keys: {}, providers: {} },
    sources: { maas: day.sources?.maas ?? { tokenSplitAvailable: false, costEstimated: true } },
  };
  const provider = { metrics: emptyMetrics() };

  for (const [modelName, model] of Object.entries(models)) {
    for (const [keyHash, key] of Object.entries(model.api_keys ?? {})) {
      if (!keyHash.startsWith(MAAS_KEY_HASH_PREFIX) || !key?.metrics) continue;
      const m = key.metrics;
      const entry = (slice.breakdown.models[modelName] ??= {
        metrics: emptyMetrics(),
        api_keys: {},
      });
      entry.api_keys[keyHash] = { ...key, metrics: { ...m } };
      for (const target of [entry.metrics, provider.metrics, slice.metrics]) {
        target.api_requests += m.api_requests ?? 0;
        target.total_tokens += m.total_tokens ?? 0;
        target.prompt_tokens += m.prompt_tokens ?? 0;
        target.completion_tokens += m.completion_tokens ?? 0;
        target.spend += m.spend ?? 0;
      }
      slice.metrics.successful_requests += m.successful_requests ?? 0;
      slice.metrics.failed_requests += m.failed_requests ?? 0;
    }
  }

  if (slice.metrics.api_requests <= 0 && slice.metrics.total_tokens <= 0) return null;
  slice.breakdown.providers[MAAS_PROVIDER] = provider;
  return slice;
}

export class MaasUsageSource implements UsageSource {
  readonly type = 'maas' as const;
  private modelCache?: { at: number; rows: MaasModelInfoRow[]; resolve: MaasModelResolver };
  private rowCache = new Map<
    string,
    {
      at: number;
      rows: MaasUsageRow[];
      /** computed for a not yet finished day */ partial: boolean;
    }
  >();
  /** Prometheus is skipped (the stored error is rethrown) until `until` */
  private breaker?: { until: number; error: unknown };
  private readonly warnedAmbiguous = new Set<string>();

  constructor(
    private readonly fastify: FastifyInstance,
    private readonly clients: MaasClients,
  ) {}

  /**
   * Drop cached query results and close the Prometheus breaker (tests, admin refresh / resync:
   * an explicit refresh should talk to Prometheus again right away).
   */
  clearCache(): void {
    this.rowCache.clear();
    this.modelCache = undefined;
    this.breaker = undefined;
  }

  private warn(context: Record<string, unknown>, message: string): void {
    this.fastify.log?.warn?.(context, message);
  }

  // ---------------------------------------------------------------- breaker

  /** Throw the error that opened the breaker while it is open (no Prometheus call is made) */
  private assertPrometheusAvailable(): void {
    if (this.breaker && Date.now() < this.breaker.until) throw this.breaker.error;
    // Cooldown over (or never opened): the next query probes the endpoint
  }

  private recordPrometheusFailure(error: unknown): void {
    if (!isPrometheusOutage(error)) return;
    const wasOpen = !!this.breaker && Date.now() < this.breaker.until;
    this.breaker = { until: Date.now() + PROMETHEUS_BREAKER_COOLDOWN_MS, error };
    if (!wasOpen) {
      this.warn(
        {
          cooldownSeconds: PROMETHEUS_BREAKER_COOLDOWN_MS / 1000,
          error: error instanceof Error ? error.message : String(error),
        },
        'MaaS usage: Prometheus unavailable - not querying it again until the cooldown is over',
      );
    }
  }

  // ---------------------------------------------------------------- queries

  /** PromQL matchers: subscription filter + configured extras */
  private matchers(subscriptions?: string[]): string {
    const parts: string[] = [];
    if (subscriptions && subscriptions.length > 0) {
      const alt = subscriptions.map((s) => escapeRegex(s)).join('|');
      parts.push(`subscription=~"(.*/)?(${escapePromString(alt)})"`);
    } else {
      parts.push(`subscription=~"(.*/)?${escapeRegex(SUBSCRIPTION_PREFIX)}.+"`);
    }
    const extra = this.clients.config.usageLabelMatchers;
    if (extra) parts.push(extra);
    return `{${parts.join(',')}}`;
  }

  private promql(metric: string, windowSeconds: number, subscriptions?: string[]): string {
    return `sum by (subscription, model) (increase(${metric}${this.matchers(subscriptions)}[${windowSeconds}s]))`;
  }

  /**
   * Per (subscription, model) tokens + calls for one UTC day. Future days yield [].
   * Throws when Prometheus fails (callers decide how to degrade) and, while the breaker is open,
   * rethrows the error that opened it without calling Prometheus.
   */
  async queryDayRows(
    date: string,
    subscriptions?: string[],
    now: Date = new Date(),
  ): Promise<MaasUsageRow[]> {
    const win = dayWindow(date, now);
    if (!win) return [];

    const cacheKey = `${date}|${(subscriptions ?? []).join(',')}`;
    const cached = this.rowCache.get(cacheKey);
    // Short in-memory cache (per-key/per-user ranges re-query the same days); the persistent
    // per-day cache lives in the admin usage pipeline. A result computed for the partial window
    // of a day that was still running is not valid once that day is complete.
    if (cached && now.getTime() - cached.at < CACHE_TTL_MS && !(cached.partial && !win.partial)) {
      return cached.rows;
    }

    this.assertPrometheusAvailable();

    const { prometheus, config } = this.clients;
    let hits: PromSample[];
    let calls: PromSample[];
    try {
      [hits, calls] = await Promise.all([
        prometheus.query(
          this.promql(config.usageHitsMetric, win.windowSeconds, subscriptions),
          win.evalTime,
        ),
        prometheus.query(
          this.promql(config.usageCallsMetric, win.windowSeconds, subscriptions),
          win.evalTime,
        ),
      ]);
    } catch (error) {
      this.recordPrometheusFailure(error);
      throw error;
    }

    const map = new Map<string, MaasUsageRow>();
    const add = (samples: PromSample[], field: 'tokens' | 'calls') => {
      for (const s of samples) {
        const value = roundCount(s.value?.[1]);
        const subscription = stripNamespace(s.metric?.subscription ?? '');
        if (!subscription) continue;
        const model = s.metric?.model || 'unknown';
        const key = `${subscription}\u0000${model}`;
        const row = map.get(key) ?? { subscription, model, tokens: 0, calls: 0 };
        row[field] += value;
        map.set(key, row);
      }
    };
    add(hits, 'tokens');
    add(calls, 'calls');

    const rows = [...map.values()].filter((r) => r.tokens > 0 || r.calls > 0);
    this.rowCache.set(cacheKey, { at: now.getTime(), rows, partial: win.partial });
    if (this.rowCache.size > 500) {
      const oldest = this.rowCache.keys().next().value;
      if (oldest !== undefined) this.rowCache.delete(oldest);
    }
    return rows;
  }

  // ---------------------------------------------------------------- models

  private async loadModels(): Promise<{
    rows: MaasModelInfoRow[];
    resolve: MaasModelResolver;
  }> {
    const now = Date.now();
    if (this.modelCache && now - this.modelCache.at < MODEL_CACHE_TTL_MS) return this.modelCache;
    // ORDER BY: the resolver result must not depend on the physical row order
    const rows = await this.fastify.dbUtils.queryMany<MaasModelInfoRow>(
      `SELECT id, name, backend_model_name, maas_model_ref_name, maas_model_ref_namespace,
              input_cost_per_token, output_cost_per_token
         FROM models WHERE backend_type = 'maas' ORDER BY id`,
    );
    const resolve = MaasUsageSource.buildResolver(rows, (label, modelIds) =>
      this.warnAmbiguousLabel(label, modelIds),
    );
    this.modelCache = { at: now, rows, resolve };
    return this.modelCache;
  }

  /** Warn once per label: the resolver is rebuilt every time the model cache expires */
  private warnAmbiguousLabel(label: string, modelIds: string[]): void {
    if (this.warnedAmbiguous.has(label)) return;
    this.warnedAmbiguous.add(label);
    this.warn(
      { label, modelIds },
      'MaaS usage: a Limitador model label matches several MaaS models - treated as unresolved (cost 0); rename the models or ensure the label is the full <namespace>/<name>',
    );
  }

  /**
   * Register the ids of all MaaS models so the admin usage views report them under the `maas`
   * provider (their `<namespace>/` prefix would otherwise read as a LiteLLM provider).
   */
  async syncModelProviders(): Promise<void> {
    const { rows } = await this.loadModels();
    setMaasModelIds(rows.map((m) => m.id));
  }

  /** Blended price per token (see file header); 0 when no price is configured */
  static unitPrice(row: Pick<MaasModelInfoRow, 'input_cost_per_token' | 'output_cost_per_token'>) {
    const input = row.input_cost_per_token == null ? null : toNumber(row.input_cost_per_token);
    const output = row.output_cost_per_token == null ? null : toNumber(row.output_cost_per_token);
    if (input != null && output != null) return (input + output) / 2;
    return input ?? output ?? 0;
  }

  /**
   * Build a resolver from Limitador `model` label to LiteMaaS model + price.
   *
   * A label is matched, case-insensitively, against (in priority order) the model id, the
   * `<namespace>/<ref>` name, the MaaSModelRef name and the served model name; a stronger match
   * wins over a looser one. A label that several models claim at the same priority (two models
   * sharing a served name, the same ref name in two namespaces) is ambiguous: it stays
   * unresolved instead of silently picking whichever model was listed first, and
   * `onAmbiguous` is called once per such label.
   */
  static buildResolver(
    models: MaasModelInfoRow[],
    onAmbiguous?: (label: string, modelIds: string[]) => void,
  ): MaasModelResolver {
    // key -> owning model, or null when several models claim it at its priority tier
    const byKey = new Map<string, MaasModelInfoRow | null>();
    const tierOf = new Map<string, number>();
    const claimants = new Map<string, Set<string>>();
    const put = (tier: number, k: string | null | undefined, m: MaasModelInfoRow) => {
      if (!k) return;
      const key = k.toLowerCase();
      const ownerTier = tierOf.get(key);
      if (ownerTier === undefined) {
        byKey.set(key, m);
        tierOf.set(key, tier);
        return;
      }
      if (ownerTier < tier) return; // an exact match already owns the key
      const owner = byKey.get(key);
      if (owner === null) {
        claimants.get(key)?.add(m.id);
      } else if (owner && owner.id !== m.id) {
        byKey.set(key, null);
        claimants.set(key, new Set([owner.id, m.id]));
      }
    };
    for (const m of models) put(0, m.id, m);
    for (const m of models) {
      if (m.maas_model_ref_namespace && m.maas_model_ref_name) {
        put(1, `${m.maas_model_ref_namespace}/${m.maas_model_ref_name}`, m);
      }
    }
    for (const m of models) put(2, m.maas_model_ref_name, m);
    for (const m of models) put(3, m.backend_model_name, m);
    for (const [key, ids] of claimants) onAmbiguous?.(key, [...ids].sort());

    return (label: string) => {
      const lower = label.toLowerCase();
      const stripped = lower.slice(lower.lastIndexOf('/') + 1);
      // an ambiguous exact key must not fall through to the looser namespace-less lookup
      const hit = byKey.has(lower) ? byKey.get(lower) : byKey.get(stripped);
      return hit
        ? { id: hit.id, unitPrice: MaasUsageSource.unitPrice(hit), resolved: true }
        : { id: label, unitPrice: 0, resolved: false };
    };
  }

  private async resolver() {
    return (await this.loadModels()).resolve;
  }

  // ---------------------------------------------------------------- UsageSource

  /** One UTC day for all LiteMaaS-managed subscriptions, in the LiteLLM daily shape */
  async getDayData(date: string): Promise<LiteLLMDayData | null> {
    const rows = await this.queryDayRows(date);
    if (rows.length === 0) return null;
    const resolve = await this.resolver();

    const day: LiteLLMDayData = {
      date,
      metrics: {
        ...emptyMetrics(),
        successful_requests: 0,
        failed_requests: 0,
      },
      breakdown: { models: {}, api_keys: {}, providers: {} },
      sources: { maas: { tokenSplitAvailable: false, costEstimated: true } },
    };

    for (const row of rows) {
      const model = resolve(row.model);
      const spend = row.tokens * model.unitPrice;
      const keyHash = `${MAAS_KEY_HASH_PREFIX}${row.subscription}`;

      const entry = (day.breakdown.models[model.id] ??= { metrics: emptyMetrics(), api_keys: {} });
      entry.metrics.api_requests += row.calls;
      entry.metrics.total_tokens += row.tokens;
      entry.metrics.prompt_tokens += row.tokens;
      entry.metrics.spend += spend;

      const k = (entry.api_keys[keyHash] ??= {
        metadata: { key_alias: row.subscription },
        metrics: { ...emptyMetrics(), successful_requests: 0, failed_requests: 0 },
      });
      k.metrics.api_requests += row.calls;
      k.metrics.total_tokens += row.tokens;
      k.metrics.prompt_tokens += row.tokens;
      k.metrics.spend += spend;
      k.metrics.successful_requests = (k.metrics.successful_requests ?? 0) + row.calls;

      const prov = (day.breakdown.providers[MAAS_PROVIDER] ??= { metrics: emptyMetrics() });
      prov.metrics.api_requests += row.calls;
      prov.metrics.total_tokens += row.tokens;
      prov.metrics.prompt_tokens += row.tokens;
      prov.metrics.spend += spend;

      day.metrics.api_requests += row.calls;
      day.metrics.total_tokens += row.tokens;
      day.metrics.prompt_tokens += row.tokens;
      day.metrics.spend += spend;
      day.metrics.successful_requests += row.calls;
    }

    return day.metrics.api_requests > 0 || day.metrics.total_tokens > 0 ? day : null;
  }

  // ---------------------------------------------------------------- ranges

  /** Number of UTC days from start to end inclusive (0 for an invalid or inverted range) */
  static countDays(startDate: string, endDate: string): number {
    const start = Date.parse(`${startDate}T00:00:00Z`);
    const end = Date.parse(`${endDate}T00:00:00Z`);
    if (Number.isNaN(start) || Number.isNaN(end) || end < start) return 0;
    return Math.round((end - start) / (SECONDS_PER_DAY * 1000)) + 1;
  }

  /** UTC dates from start to end inclusive, capped at MAX_RANGE_DAYS (most recent days kept) */
  static listDates(startDate: string, endDate: string): string[] {
    const start = Date.parse(`${startDate}T00:00:00Z`);
    const end = Date.parse(`${endDate}T00:00:00Z`);
    if (Number.isNaN(start) || Number.isNaN(end) || end < start) return [];
    const dates: string[] = [];
    for (let t = start; t <= end; t += SECONDS_PER_DAY * 1000) {
      dates.push(utcDateString(new Date(t)));
    }
    return dates.slice(-MAX_RANGE_DAYS);
  }

  /**
   * Usage over a date range for a set of subscriptions (one key, or all keys of a user).
   * Days are queried with limited concurrency. Throws on Prometheus failure so callers decide
   * how to degrade. Ranges longer than MAX_RANGE_DAYS are cut to their most recent days (and a
   * warning is logged): usage before the first returned `daily` date is not part of the totals.
   */
  async getUsageSummary(
    subscriptions: string[],
    startDate: string,
    endDate: string,
  ): Promise<MaasUsageSummary> {
    const summary: MaasUsageSummary = {
      totalRequests: 0,
      totalTokens: 0,
      totalCost: 0,
      byModel: [],
      daily: [],
      tokenSplitAvailable: false,
      costEstimated: true,
    };
    if (subscriptions.length === 0) return summary;

    const dates = MaasUsageSource.listDates(startDate, endDate);
    const requestedDays = MaasUsageSource.countDays(startDate, endDate);
    if (dates.length < requestedDays) {
      this.warn(
        {
          startDate,
          endDate,
          requestedDays,
          maxDays: MAX_RANGE_DAYS,
          effectiveStartDate: dates[0],
        },
        `MaaS usage range truncated to the most recent ${MAX_RANGE_DAYS} days: usage before ${dates[0]} is not included`,
      );
    }
    const resolve = await this.resolver();
    const byModel = new Map<string, { requests: number; tokens: number; cost: number }>();
    const perDay = new Map<string, { requests: number; tokens: number; cost: number }>();

    for (let i = 0; i < dates.length; i += DAY_QUERY_CONCURRENCY) {
      const chunk = dates.slice(i, i + DAY_QUERY_CONCURRENCY);
      const results = await Promise.all(chunk.map((d) => this.queryDayRows(d, subscriptions)));
      chunk.forEach((date, idx) => {
        const day = { requests: 0, tokens: 0, cost: 0 };
        for (const row of results[idx]) {
          const model = resolve(row.model);
          const cost = row.tokens * model.unitPrice;
          day.requests += row.calls;
          day.tokens += row.tokens;
          day.cost += cost;
          const m = byModel.get(model.id) ?? { requests: 0, tokens: 0, cost: 0 };
          m.requests += row.calls;
          m.tokens += row.tokens;
          m.cost += cost;
          byModel.set(model.id, m);
        }
        perDay.set(date, day);
        summary.totalRequests += day.requests;
        summary.totalTokens += day.tokens;
        summary.totalCost += day.cost;
      });
    }

    summary.daily = dates.map((date) => ({ date, ...(perDay.get(date) as object) }) as never);
    summary.byModel = [...byModel.entries()].map(([modelId, v]) => ({ modelId, ...v }));
    return summary;
  }

  /** Subscription names of all MaaS keys of a user (any state: usage history matters) */
  async subscriptionsForUser(userId: string): Promise<string[]> {
    const rows = await this.fastify.dbUtils.queryMany<{ maas_subscription_name: string | null }>(
      `SELECT maas_subscription_name FROM api_keys
        WHERE user_id = $1 AND backend_type = 'maas' AND maas_subscription_name IS NOT NULL`,
      [userId],
    );
    return rows.map((r) => r.maas_subscription_name as string);
  }
}
