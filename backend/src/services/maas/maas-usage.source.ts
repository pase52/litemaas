import type { FastifyInstance } from 'fastify';
import type { LiteLLMDayData } from '../../types/admin-usage.types.js';
import type { UsageSource } from '../backends/backend.types.js';
import type { MaasClients } from './maas-clients.js';
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
 */

export const SECONDS_PER_DAY = 86_400;
const SUBSCRIPTION_PREFIX = 'litemaas-key-';
const CACHE_TTL_MS = 5 * 60 * 1000;
const DAY_QUERY_CONCURRENCY = 6;
/** Hard cap on days per range request (protects Thanos) */
export const MAX_RANGE_DAYS = 120;

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

export class MaasUsageSource implements UsageSource {
  readonly type = 'maas' as const;
  private modelCache?: { at: number; rows: MaasModelInfoRow[] };
  private rowCache = new Map<string, { at: number; rows: MaasUsageRow[] }>();

  constructor(
    private readonly fastify: FastifyInstance,
    private readonly clients: MaasClients,
  ) {}

  /** Drop cached query results (tests, admin resync) */
  clearCache(): void {
    this.rowCache.clear();
    this.modelCache = undefined;
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

  /** Per (subscription, model) tokens + calls for one UTC day. Future days yield []. */
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
    // per-day cache lives in the admin usage pipeline
    if (cached && now.getTime() - cached.at < CACHE_TTL_MS) {
      return cached.rows;
    }

    const { prometheus, config } = this.clients;
    const [hits, calls] = await Promise.all([
      prometheus.query(
        this.promql(config.usageHitsMetric, win.windowSeconds, subscriptions),
        win.evalTime,
      ),
      prometheus.query(
        this.promql(config.usageCallsMetric, win.windowSeconds, subscriptions),
        win.evalTime,
      ),
    ]);

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
    this.rowCache.set(cacheKey, { at: now.getTime(), rows });
    if (this.rowCache.size > 500) {
      const oldest = this.rowCache.keys().next().value;
      if (oldest !== undefined) this.rowCache.delete(oldest);
    }
    return rows;
  }

  // ---------------------------------------------------------------- models

  private async loadModels(): Promise<MaasModelInfoRow[]> {
    const now = Date.now();
    if (this.modelCache && now - this.modelCache.at < 60_000) return this.modelCache.rows;
    const rows = await this.fastify.dbUtils.queryMany<MaasModelInfoRow>(
      `SELECT id, name, backend_model_name, maas_model_ref_name, maas_model_ref_namespace,
              input_cost_per_token, output_cost_per_token
         FROM models WHERE backend_type = 'maas'`,
    );
    this.modelCache = { at: now, rows };
    return rows;
  }

  /** Blended price per token (see file header); 0 when no price is configured */
  static unitPrice(row: Pick<MaasModelInfoRow, 'input_cost_per_token' | 'output_cost_per_token'>) {
    const input = row.input_cost_per_token == null ? null : toNumber(row.input_cost_per_token);
    const output = row.output_cost_per_token == null ? null : toNumber(row.output_cost_per_token);
    if (input != null && output != null) return (input + output) / 2;
    return input ?? output ?? 0;
  }

  /** Build a resolver from Limitador `model` label to LiteMaaS model + price */
  static buildResolver(models: MaasModelInfoRow[]): (label: string) => ResolvedMaasModel {
    const byKey = new Map<string, MaasModelInfoRow>();
    const put = (k: string | null | undefined, m: MaasModelInfoRow) => {
      if (k && !byKey.has(k.toLowerCase())) byKey.set(k.toLowerCase(), m);
    };
    // id and `<ns>/<ref>` first so they win over looser name matches
    for (const m of models) put(m.id, m);
    for (const m of models) {
      if (m.maas_model_ref_namespace && m.maas_model_ref_name) {
        put(`${m.maas_model_ref_namespace}/${m.maas_model_ref_name}`, m);
      }
    }
    for (const m of models) put(m.maas_model_ref_name, m);
    for (const m of models) put(m.backend_model_name, m);
    return (label: string) => {
      const lower = label.toLowerCase();
      const hit = byKey.get(lower) ?? byKey.get(lower.slice(lower.lastIndexOf('/') + 1));
      return hit
        ? { id: hit.id, unitPrice: MaasUsageSource.unitPrice(hit), resolved: true }
        : { id: label, unitPrice: 0, resolved: false };
    };
  }

  private async resolver() {
    return MaasUsageSource.buildResolver(await this.loadModels());
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
      const keyHash = `maas:${row.subscription}`;

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

      const prov = (day.breakdown.providers['maas'] ??= { metrics: emptyMetrics() });
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
   * how to degrade.
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
