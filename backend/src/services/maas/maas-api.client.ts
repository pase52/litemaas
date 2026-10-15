import type { FastifyBaseLogger } from 'fastify';
import { ApplicationError, ErrorCode } from '../../utils/errors.js';
import { tlsFetch, type TlsOptions } from '../http/tls-fetch.js';

const DEFAULT_TIMEOUT_MS = 15_000;

export interface MaasApiKeyCreateRequest {
  name: string;
  description?: string;
  /** Name of the MaaSSubscription the key is bound to */
  subscription: string;
  /** Lifetime in days, e.g. 30 -> sent as "30d". Omit for maas-api default. */
  expiresInDays?: number;
}

export interface MaasApiKeyCreateResponse {
  id: string;
  /** Plaintext key (sk-oai-...), only returned once */
  key: string;
  keyPrefix?: string;
  createdAt?: string;
  expiresAt?: string | null;
  subscription?: string;
}

export interface MaasApiKeySearchResult {
  id: string;
  name?: string;
  keyPrefix?: string;
  subscription?: string;
  status?: string;
  createdAt?: string;
  expiresAt?: string | null;
  [key: string]: unknown;
}

export interface MaasApiKeySearchRequest {
  subscription?: string;
  name?: string;
  [key: string]: unknown;
}

/**
 * Contract of the maas-api client. All key operations are performed with the caller's own
 * OpenShift bearer token (maas-api has no on-behalf-of mechanism).
 */
export interface IMaasApiClient {
  readonly mock: boolean;
  createKey(userToken: string, request: MaasApiKeyCreateRequest): Promise<MaasApiKeyCreateResponse>;
  revokeKey(userToken: string, keyId: string): Promise<void>;
  searchKeys(
    userToken: string,
    request?: MaasApiKeySearchRequest,
  ): Promise<MaasApiKeySearchResult[]>;
  health(): Promise<{ healthy: boolean; status?: number; message?: string }>;
}

export interface MaasApiClientConfig {
  baseUrl: string;
  tls?: TlsOptions;
  timeoutMs?: number;
}

/** "30" days -> "30d" */
export function formatExpiresIn(days: number): string {
  return `${Math.max(1, Math.ceil(days))}d`;
}

/**
 * Fetch-based maas-api client.
 * 401/403 from maas-api means the user's OpenShift token is expired/rejected and is surfaced
 * as MAAS_REAUTH_REQUIRED so the UI can prompt the user to log in again.
 */
export class MaasApiClient implements IMaasApiClient {
  readonly mock = false;

  constructor(
    private readonly config: MaasApiClientConfig,
    private readonly log?: Pick<FastifyBaseLogger, 'debug' | 'warn'>,
  ) {}

  private async request<T>(
    method: string,
    path: string,
    opts: { token?: string; body?: unknown } = {},
  ): Promise<{ status: number; data: T | undefined }> {
    const url = `${this.config.baseUrl}${path}`;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    let body: string | undefined;
    if (opts.body !== undefined) {
      body = JSON.stringify(opts.body);
      headers['Content-Type'] = 'application/json';
    }

    let response: Response;
    try {
      response = await tlsFetch(
        url,
        {
          method,
          headers,
          body,
          signal: AbortSignal.timeout(this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        },
        this.config.tls,
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.log?.warn({ method, path, error: msg }, 'maas-api request failed');
      throw ApplicationError.maasError('Failed to reach maas-api', undefined, msg, true);
    }

    const text = await response.text();
    let data: any;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = undefined;
      }
    }

    if (response.status === 401 || response.status === 403) {
      this.log?.warn({ method, path, status: response.status }, 'maas-api rejected the user token');
      throw ApplicationError.maasReauthRequired(`maas-api responded ${response.status}`);
    }

    if (!response.ok) {
      const upstream: string | undefined =
        (typeof data?.error === 'string' ? data.error : data?.error?.message) ||
        data?.message ||
        text ||
        undefined;
      this.log?.warn({ method, path, status: response.status, upstream }, 'maas-api error');
      // maas-api rejected the request itself (e.g. expiry above the tenant maximum): that is a
      // 400 for the caller, with the upstream reason, not a gateway failure
      if (response.status === 400 || response.status === 422) {
        throw new ApplicationError({
          code: ErrorCode.VALIDATION_ERROR,
          statusCode: 400,
          message: `maas-api rejected the request${upstream ? `: ${upstream}` : ''}`,
          details: {
            service: 'maas',
            upstreamStatus: response.status,
            upstreamMessage: upstream,
            suggestion: 'Adjust the request (for example the expiration) and retry',
          },
        });
      }
      throw ApplicationError.maasError(
        `maas-api request failed with status ${response.status}`,
        response.status,
        upstream,
        response.status >= 500 || response.status === 429,
      );
    }

    return { status: response.status, data };
  }

  async createKey(
    userToken: string,
    request: MaasApiKeyCreateRequest,
  ): Promise<MaasApiKeyCreateResponse> {
    const body: Record<string, unknown> = {
      name: request.name,
      description: request.description ?? '',
      subscription: request.subscription,
    };
    if (request.expiresInDays !== undefined)
      body.expiresIn = formatExpiresIn(request.expiresInDays);

    const { data } = await this.request<any>('POST', '/v1/api-keys', { token: userToken, body });
    if (!data?.id || !data?.key) {
      throw ApplicationError.maasError(
        'maas-api returned an unexpected key creation response',
        200,
        undefined,
        false,
      );
    }
    return {
      id: String(data.id),
      key: String(data.key),
      keyPrefix: data.keyPrefix,
      createdAt: data.createdAt,
      expiresAt: data.expiresAt ?? null,
      subscription: data.subscription,
    };
  }

  /** Revoke (delete) a key. A 404 is treated as already revoked. */
  async revokeKey(userToken: string, keyId: string): Promise<void> {
    try {
      await this.request('DELETE', `/v1/api-keys/${encodeURIComponent(keyId)}`, {
        token: userToken,
      });
    } catch (error) {
      if (error instanceof ApplicationError && error.details?.upstreamStatus === 404) return;
      throw error;
    }
  }

  async searchKeys(
    userToken: string,
    request: MaasApiKeySearchRequest = {},
  ): Promise<MaasApiKeySearchResult[]> {
    const { data } = await this.request<any>('POST', '/v1/api-keys/search', {
      token: userToken,
      body: request,
    });
    // Defensive: accept {items|keys|data: []} or a bare array
    const list = Array.isArray(data) ? data : (data?.items ?? data?.keys ?? data?.data ?? []);
    return Array.isArray(list) ? list : [];
  }

  async health() {
    try {
      const { status } = await this.request('GET', '/health');
      return { healthy: true, status };
    } catch (error) {
      return {
        healthy: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

/** In-memory maas-api for mock mode: issues deterministic-looking sk-oai-* keys. */
export class MockMaasApiClient implements IMaasApiClient {
  readonly mock = true;
  private keys = new Map<string, MaasApiKeySearchResult & { owner: string }>();
  private seq = 1;

  async createKey(
    userToken: string,
    request: MaasApiKeyCreateRequest,
  ): Promise<MaasApiKeyCreateResponse> {
    const id = `mock-maas-key-${this.seq++}`;
    const rand = Math.random().toString(36).slice(2, 14).padEnd(12, '0');
    const key = `sk-oai-mock-${rand}${Math.random().toString(36).slice(2, 14)}`;
    const createdAt = new Date().toISOString();
    const expiresAt = request.expiresInDays
      ? new Date(Date.now() + request.expiresInDays * 86_400_000).toISOString()
      : null;
    const keyPrefix = key.slice(0, 12);
    this.keys.set(id, {
      id,
      name: request.name,
      keyPrefix,
      subscription: request.subscription,
      status: 'active',
      createdAt,
      expiresAt,
      owner: userToken,
    });
    return { id, key, keyPrefix, createdAt, expiresAt, subscription: request.subscription };
  }

  async revokeKey(_userToken: string, keyId: string): Promise<void> {
    this.keys.delete(keyId);
  }

  async searchKeys(userToken: string, request: MaasApiKeySearchRequest = {}) {
    return [...this.keys.values()]
      .filter((k) => k.owner === userToken)
      .filter((k) => !request.subscription || k.subscription === request.subscription)
      .map(({ owner: _o, ...rest }) => rest);
  }

  async health() {
    return { healthy: true, status: 200, message: 'mock' };
  }
}
