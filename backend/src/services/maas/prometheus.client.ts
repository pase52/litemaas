import type { FastifyBaseLogger } from 'fastify';
import { ApplicationError } from '../../utils/errors.js';
import { tlsFetch, type TlsOptions } from '../http/tls-fetch.js';

/**
 * Per-request timeout when none is configured (PROMETHEUS_TIMEOUT_MS). Kept short: a black-holed
 * Thanos would otherwise stall every analytics request for the full timeout.
 */
export const DEFAULT_PROMETHEUS_TIMEOUT_MS = 10_000;

export interface PromSample {
  metric: Record<string, string>;
  /** [unixSeconds, "value"] */
  value: [number, string];
}

export interface PromSeries {
  metric: Record<string, string>;
  values: Array<[number, string]>;
}

export interface IPrometheusClient {
  readonly mock: boolean;
  /** Instant query (vector result) */
  query(promql: string, time?: Date | number): Promise<PromSample[]>;
  /** Range query (matrix result). step in seconds or a Prometheus duration string. */
  queryRange(
    promql: string,
    start: Date | number,
    end: Date | number,
    step: number | string,
  ): Promise<PromSeries[]>;
  health(): Promise<{ healthy: boolean; message?: string }>;
}

export interface PrometheusClientConfig {
  baseUrl: string;
  token?: string;
  tokenProvider?: () => string | undefined;
  tls?: TlsOptions;
  /** Per-request timeout in ms (default {@link DEFAULT_PROMETHEUS_TIMEOUT_MS}) */
  timeoutMs?: number;
}

function toUnixSeconds(t: Date | number): number {
  return t instanceof Date ? t.getTime() / 1000 : t;
}

/** Fetch-based Prometheus / Thanos Querier HTTP API client. */
export class PrometheusClient implements IPrometheusClient {
  readonly mock = false;

  constructor(
    private readonly config: PrometheusClientConfig,
    private readonly log?: Pick<FastifyBaseLogger, 'debug' | 'warn'>,
  ) {}

  /**
   * POST with an `application/x-www-form-urlencoded` body, which the Prometheus and Thanos HTTP
   * APIs accept in place of GET. The all-time subscription regex of a user with many keys can
   * exceed the URL length limits of the proxies in front of Thanos; a body has no such limit.
   *
   * `partial_response=false` (a URL parameter, ignored by plain Prometheus) makes Thanos fail the
   * query instead of answering from the stores that are up; a `warnings` array in a successful
   * answer is treated as a failure too (see below).
   */
  private async post(path: string, params: Record<string, string>): Promise<any> {
    const url = `${this.config.baseUrl}${path}?partial_response=false`;
    const requestBody = new URLSearchParams(params).toString();
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      // explicit so the custom-TLS path (https.request) sends a sized body, not chunked
      'Content-Length': String(Buffer.byteLength(requestBody)),
    };
    const token = this.config.token ?? this.config.tokenProvider?.();
    if (token) headers.Authorization = `Bearer ${token}`;

    let response: Response;
    let text: string;
    try {
      response = await tlsFetch(
        url,
        {
          method: 'POST',
          headers,
          body: requestBody,
          signal: AbortSignal.timeout(this.config.timeoutMs ?? DEFAULT_PROMETHEUS_TIMEOUT_MS),
        },
        this.config.tls,
      );
      // The timeout also covers the body: reading it can fail (abort) after the headers arrived
      text = await response.text();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.log?.warn({ path, error: msg }, 'Prometheus request failed');
      throw ApplicationError.maasError('Failed to reach Prometheus', undefined, msg, true);
    }

    let body: any;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }

    if (!response.ok || body?.status === 'error') {
      const upstream: string | undefined = body?.error || text || undefined;
      this.log?.warn({ path, status: response.status, upstream }, 'Prometheus error');
      throw ApplicationError.maasError(
        `Prometheus query failed with status ${response.status}`,
        response.status,
        upstream,
        response.status >= 500 || response.status === 429,
      );
    }
    if (!body || body.status !== 'success') {
      throw ApplicationError.maasError(
        'Prometheus returned an unexpected response',
        response.status,
        undefined,
        false,
      );
    }
    // Thanos answers `success` + `warnings` when a store is down and partial responses are
    // allowed: the data is then incomplete (an undercount that would be cached for good)
    const warnings: string[] = Array.isArray(body.warnings) ? body.warnings.map(String) : [];
    if (warnings.length > 0) {
      this.log?.warn({ path, warnings }, 'Prometheus returned warnings - result treated as failed');
      throw ApplicationError.maasError(
        'Prometheus returned a partial or degraded response',
        response.status,
        warnings.join('; ').slice(0, 500),
        true,
      );
    }
    return body.data;
  }

  async query(promql: string, time?: Date | number): Promise<PromSample[]> {
    const params: Record<string, string> = { query: promql };
    if (time !== undefined) params.time = String(toUnixSeconds(time));
    const data = await this.post('/api/v1/query', params);
    if (data?.resultType === 'vector') return data.result as PromSample[];
    if (data?.resultType === 'scalar') {
      return [{ metric: {}, value: data.result as [number, string] }];
    }
    return [];
  }

  async queryRange(
    promql: string,
    start: Date | number,
    end: Date | number,
    step: number | string,
  ): Promise<PromSeries[]> {
    const data = await this.post('/api/v1/query_range', {
      query: promql,
      start: String(toUnixSeconds(start)),
      end: String(toUnixSeconds(end)),
      step: String(step),
    });
    return data?.resultType === 'matrix' ? (data.result as PromSeries[]) : [];
  }

  async health() {
    try {
      await this.query('vector(1)');
      return { healthy: true };
    } catch (error) {
      return { healthy: false, message: error instanceof Error ? error.message : String(error) };
    }
  }
}

/** Mock Prometheus: returns canned results (empty by default). */
export class MockPrometheusClient implements IPrometheusClient {
  readonly mock = true;
  constructor(
    private readonly responder: {
      query?: (promql: string) => PromSample[];
      queryRange?: (promql: string) => PromSeries[];
    } = {},
  ) {}

  async query(promql: string): Promise<PromSample[]> {
    return this.responder.query?.(promql) ?? [];
  }
  async queryRange(promql: string): Promise<PromSeries[]> {
    return this.responder.queryRange?.(promql) ?? [];
  }
  async health() {
    return { healthy: true, message: 'mock' };
  }
}
