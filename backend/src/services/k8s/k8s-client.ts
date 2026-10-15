import { readFileSync } from 'node:fs';
import type { FastifyBaseLogger } from 'fastify';
import { tlsFetch, loadClusterCaBundle, type TlsOptions } from '../http/tls-fetch.js';

const SA_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';
const DEFAULT_TIMEOUT_MS = 15_000;
const LIST_PAGE_SIZE = 500;

/** Identifies a Kubernetes resource type (GVR). `group: ''` is the core API group. */
export interface K8sResourceRef {
  group: string;
  version: string;
  plural: string;
  /** Defaults to true. Set false for cluster-scoped resources. */
  namespaced?: boolean;
}

export interface K8sObject {
  apiVersion?: string;
  kind?: string;
  metadata: {
    name: string;
    namespace?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    resourceVersion?: string;
    uid?: string;
    creationTimestamp?: string;
    [key: string]: unknown;
  };
  spec?: Record<string, any>;
  status?: Record<string, any>;
  [key: string]: unknown;
}

export interface K8sListOptions {
  /** Omit to list across all namespaces (or cluster-scoped resources) */
  namespace?: string;
  labelSelector?: string;
  fieldSelector?: string;
}

export interface K8sDeleteOptions {
  propagationPolicy?: 'Foreground' | 'Background' | 'Orphan';
}

/** Error returned by the Kubernetes API (or raised on transport failure with status 0). */
export class K8sApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly reason?: string,
    public readonly method?: string,
    public readonly path?: string,
  ) {
    super(message);
    this.name = 'K8sApiError';
  }
  get isNotFound(): boolean {
    return this.status === 404;
  }
  get isConflict(): boolean {
    return this.status === 409;
  }
  get isUnauthorized(): boolean {
    return this.status === 401;
  }
  get isForbidden(): boolean {
    return this.status === 403;
  }
  /** Transport failure or 5xx / 429: worth retrying later */
  get isTransient(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

/**
 * Minimal contract of a Kubernetes client used by the MaaS services. Implemented by the
 * fetch-based {@link K8sClient} and by {@link InMemoryK8sClient} (mock mode / tests).
 *
 * Semantics:
 * - get: resolves null when the object does not exist (404)
 * - delete: resolves false when the object was already gone (404), true when deleted
 * - create/replace/mergePatch: throw K8sApiError on any failure (409 for conflict, 404 for missing)
 */
export interface IK8sClient {
  readonly mock: boolean;
  get<T extends K8sObject = K8sObject>(
    ref: K8sResourceRef,
    name: string,
    namespace?: string,
  ): Promise<T | null>;
  list<T extends K8sObject = K8sObject>(
    ref: K8sResourceRef,
    options?: K8sListOptions,
  ): Promise<T[]>;
  create<T extends K8sObject = K8sObject>(
    ref: K8sResourceRef,
    object: K8sObject,
    namespace?: string,
  ): Promise<T>;
  replace<T extends K8sObject = K8sObject>(
    ref: K8sResourceRef,
    name: string,
    object: K8sObject,
    namespace?: string,
  ): Promise<T>;
  mergePatch<T extends K8sObject = K8sObject>(
    ref: K8sResourceRef,
    name: string,
    patch: Record<string, unknown>,
    namespace?: string,
  ): Promise<T>;
  delete(
    ref: K8sResourceRef,
    name: string,
    namespace?: string,
    options?: K8sDeleteOptions,
  ): Promise<boolean>;
}

export interface K8sClientConfig {
  /** API server base URL, e.g. https://kubernetes.default.svc:443 */
  apiUrl: string;
  /** Static token override. When absent the in-cluster SA token file is (re)read per request. */
  token?: string;
  /** Reads the bearer token lazily (in-cluster tokens rotate) */
  tokenProvider?: () => string | undefined;
  tls?: TlsOptions;
  timeoutMs?: number;
}

/**
 * Resolve client configuration from env overrides or the in-cluster environment.
 * Returns null when neither is available (caller should use mock mode or fail).
 *
 * Precedence: K8S_API_URL / K8S_TOKEN override the in-cluster values.
 * K8S_API_SKIP_TLS_VERIFY=true disables cert verification; otherwise the in-cluster CA is trusted.
 */
export function resolveK8sClientConfig(
  config: { K8S_API_URL?: string; K8S_TOKEN?: string; K8S_API_SKIP_TLS_VERIFY?: string },
  env: NodeJS.ProcessEnv = process.env,
  readFile: (path: string) => string = (p) => readFileSync(p, 'utf-8'),
): K8sClientConfig | null {
  const host = env.KUBERNETES_SERVICE_HOST;
  const port = env.KUBERNETES_SERVICE_PORT || '443';
  const inCluster = !!host;

  let apiUrl = config.K8S_API_URL?.trim().replace(/\/+$/, '');
  if (!apiUrl && inCluster) {
    const h = host!.includes(':') && !host!.startsWith('[') ? `[${host}]` : host!;
    apiUrl = `https://${h}:${port}`;
  }
  if (!apiUrl) return null;

  const tls: TlsOptions = {};
  if (config.K8S_API_SKIP_TLS_VERIFY === 'true') {
    tls.rejectUnauthorized = false;
  } else if (inCluster) {
    tls.ca = loadClusterCaBundle(readFile);
  }

  const staticToken = config.K8S_TOKEN?.trim() || undefined;
  const tokenProvider = staticToken
    ? undefined
    : () => {
        try {
          return readFile(`${SA_DIR}/token`).trim() || undefined;
        } catch {
          return undefined;
        }
      };

  return { apiUrl, token: staticToken, tokenProvider, tls };
}

export function buildResourcePath(ref: K8sResourceRef, namespace?: string, name?: string): string {
  const base = ref.group ? `/apis/${ref.group}/${ref.version}` : `/api/${ref.version}`;
  const ns =
    ref.namespaced !== false && namespace ? `/namespaces/${encodeURIComponent(namespace)}` : '';
  const n = name ? `/${encodeURIComponent(name)}` : '';
  return `${base}${ns}/${ref.plural}${n}`;
}

/** Fetch-based Kubernetes API client (no external dependencies). */
export class K8sClient implements IK8sClient {
  readonly mock = false;

  constructor(
    private readonly config: K8sClientConfig,
    private readonly log?: Pick<FastifyBaseLogger, 'debug' | 'warn'>,
  ) {}

  private getToken(): string | undefined {
    return this.config.token ?? this.config.tokenProvider?.();
  }

  private async request<T>(
    method: string,
    path: string,
    opts: {
      query?: Record<string, string | undefined>;
      body?: unknown;
      contentType?: string;
      allow404?: boolean;
    } = {},
  ): Promise<T | null> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== '') qs.set(k, v);
    }
    const url = `${this.config.apiUrl}${path}${qs.toString() ? `?${qs.toString()}` : ''}`;

    const headers: Record<string, string> = { Accept: 'application/json' };
    const token = this.getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    let body: string | undefined;
    if (opts.body !== undefined) {
      body = JSON.stringify(opts.body);
      headers['Content-Type'] = opts.contentType || 'application/json';
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
      throw new K8sApiError(
        `Kubernetes API request failed: ${msg}`,
        0,
        'TransportError',
        method,
        path,
      );
    }

    if (response.status === 404 && opts.allow404) return null;

    const text = await response.text();
    let parsed: any;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
    }

    if (!response.ok) {
      const reason: string | undefined = parsed?.reason;
      const message: string =
        parsed?.message || text || response.statusText || 'Kubernetes API error';
      this.log?.debug({ method, path, status: response.status, reason }, 'Kubernetes API error');
      throw new K8sApiError(message, response.status, reason, method, path);
    }

    return (parsed ?? {}) as T;
  }

  async get<T extends K8sObject = K8sObject>(
    ref: K8sResourceRef,
    name: string,
    namespace?: string,
  ) {
    return this.request<T>('GET', buildResourcePath(ref, namespace, name), { allow404: true });
  }

  async list<T extends K8sObject = K8sObject>(ref: K8sResourceRef, options: K8sListOptions = {}) {
    const items: T[] = [];
    let cont: string | undefined;
    do {
      const page = await this.request<{ items?: T[]; metadata?: { continue?: string } }>(
        'GET',
        buildResourcePath(ref, options.namespace),
        {
          query: {
            labelSelector: options.labelSelector,
            fieldSelector: options.fieldSelector,
            limit: String(LIST_PAGE_SIZE),
            continue: cont,
          },
        },
      );
      items.push(...(page?.items ?? []));
      cont = page?.metadata?.continue || undefined;
    } while (cont);
    return items;
  }

  async create<T extends K8sObject = K8sObject>(
    ref: K8sResourceRef,
    object: K8sObject,
    namespace?: string,
  ) {
    const ns = namespace ?? object.metadata.namespace;
    return (await this.request<T>('POST', buildResourcePath(ref, ns), { body: object }))!;
  }

  async replace<T extends K8sObject = K8sObject>(
    ref: K8sResourceRef,
    name: string,
    object: K8sObject,
    namespace?: string,
  ) {
    const ns = namespace ?? object.metadata.namespace;
    return (await this.request<T>('PUT', buildResourcePath(ref, ns, name), { body: object }))!;
  }

  async mergePatch<T extends K8sObject = K8sObject>(
    ref: K8sResourceRef,
    name: string,
    patch: Record<string, unknown>,
    namespace?: string,
  ) {
    return (await this.request<T>('PATCH', buildResourcePath(ref, namespace, name), {
      body: patch,
      contentType: 'application/merge-patch+json',
    }))!;
  }

  async delete(
    ref: K8sResourceRef,
    name: string,
    namespace?: string,
    options: K8sDeleteOptions = {},
  ) {
    const result = await this.request<unknown>('DELETE', buildResourcePath(ref, namespace, name), {
      query: { propagationPolicy: options.propagationPolicy },
      allow404: true,
    });
    return result !== null;
  }
}

/**
 * Create the object if absent, otherwise replace it (carrying over resourceVersion).
 * Retries once when a concurrent writer wins the create/replace race.
 */
export async function upsertK8sObject<T extends K8sObject = K8sObject>(
  client: IK8sClient,
  ref: K8sResourceRef,
  object: K8sObject,
  namespace?: string,
): Promise<T> {
  const ns = namespace ?? object.metadata.namespace;
  for (let attempt = 0; ; attempt++) {
    try {
      const existing = await client.get(ref, object.metadata.name, ns);
      if (!existing) {
        return await client.create<T>(ref, object, ns);
      }
      const next: K8sObject = {
        ...object,
        metadata: { ...object.metadata, resourceVersion: existing.metadata.resourceVersion },
      };
      return await client.replace<T>(ref, object.metadata.name, next, ns);
    } catch (error) {
      if (attempt === 0 && error instanceof K8sApiError && error.isConflict) continue;
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Label selector matching (subset of Kubernetes syntax) used by the in-memory client
// ---------------------------------------------------------------------------------------------

export function matchesLabelSelector(
  labels: Record<string, string> | undefined,
  selector?: string,
): boolean {
  if (!selector || !selector.trim()) return true;
  const l = labels ?? {};
  // split on commas that are not inside parentheses (set-based requirements)
  const parts = selector
    .split(/,(?![^()]*\))/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.every((req) => {
    let m: RegExpMatchArray | null;
    if ((m = req.match(/^(\S+)\s+notin\s*\(([^)]*)\)$/))) {
      const vals = m[2].split(',').map((v) => v.trim());
      return !(m[1] in l) || !vals.includes(l[m[1]]);
    }
    if ((m = req.match(/^(\S+)\s+in\s*\(([^)]*)\)$/))) {
      const vals = m[2].split(',').map((v) => v.trim());
      return m[1] in l && vals.includes(l[m[1]]);
    }
    if ((m = req.match(/^([^=!\s]+)\s*!=\s*(.*)$/))) return l[m[1]] !== m[2];
    if ((m = req.match(/^([^=!\s]+)\s*==?\s*(.*)$/))) return l[m[1]] === m[2];
    if (req.startsWith('!')) return !(req.slice(1) in l);
    return req in l;
  });
}

/**
 * In-memory Kubernetes client for mock mode (development / tests without a cluster).
 * Mimics API-server semantics for resourceVersion, 404 and 409.
 */
export class InMemoryK8sClient implements IK8sClient {
  readonly mock = true;
  private store = new Map<string, K8sObject>();
  private counter = 1;

  private key(ref: K8sResourceRef, name: string, ns?: string): string {
    return [
      ref.group,
      ref.version,
      ref.plural,
      ref.namespaced === false ? '' : ns || '',
      name,
    ].join('|');
  }

  private clone<T>(o: T): T {
    return JSON.parse(JSON.stringify(o));
  }

  /** Test/mock helper: insert an object, overwriting any existing one. */
  seed(ref: K8sResourceRef, object: K8sObject, namespace?: string): void {
    const ns = namespace ?? object.metadata.namespace;
    const stored = this.clone(object);
    if (ref.namespaced !== false && ns) stored.metadata.namespace = ns;
    stored.metadata.resourceVersion = String(this.counter++);
    this.store.set(this.key(ref, object.metadata.name, ns), stored);
  }

  async get<T extends K8sObject = K8sObject>(
    ref: K8sResourceRef,
    name: string,
    namespace?: string,
  ) {
    const o = this.store.get(this.key(ref, name, namespace));
    return o ? (this.clone(o) as T) : null;
  }

  async list<T extends K8sObject = K8sObject>(ref: K8sResourceRef, options: K8sListOptions = {}) {
    const out: T[] = [];
    for (const [k, o] of this.store) {
      const [g, v, p] = k.split('|');
      if (g !== ref.group || v !== ref.version || p !== ref.plural) continue;
      if (
        options.namespace &&
        ref.namespaced !== false &&
        o.metadata.namespace !== options.namespace
      )
        continue;
      if (!matchesLabelSelector(o.metadata.labels, options.labelSelector)) continue;
      out.push(this.clone(o) as T);
    }
    return out;
  }

  async create<T extends K8sObject = K8sObject>(
    ref: K8sResourceRef,
    object: K8sObject,
    namespace?: string,
  ) {
    const ns = namespace ?? object.metadata.namespace;
    const k = this.key(ref, object.metadata.name, ns);
    if (this.store.has(k)) {
      throw new K8sApiError(
        `${ref.plural} "${object.metadata.name}" already exists`,
        409,
        'AlreadyExists',
        'POST',
      );
    }
    this.seed(ref, object, ns);
    return (await this.get<T>(ref, object.metadata.name, ns))!;
  }

  async replace<T extends K8sObject = K8sObject>(
    ref: K8sResourceRef,
    name: string,
    object: K8sObject,
    namespace?: string,
  ) {
    const ns = namespace ?? object.metadata.namespace;
    const existing = this.store.get(this.key(ref, name, ns));
    if (!existing)
      throw new K8sApiError(`${ref.plural} "${name}" not found`, 404, 'NotFound', 'PUT');
    const rv = object.metadata.resourceVersion;
    if (rv && rv !== existing.metadata.resourceVersion) {
      throw new K8sApiError(
        `Operation cannot be fulfilled on ${ref.plural} "${name}": the object has been modified`,
        409,
        'Conflict',
        'PUT',
      );
    }
    this.seed(ref, { ...object, metadata: { ...object.metadata, name } }, ns);
    return (await this.get<T>(ref, name, ns))!;
  }

  async mergePatch<T extends K8sObject = K8sObject>(
    ref: K8sResourceRef,
    name: string,
    patch: Record<string, unknown>,
    namespace?: string,
  ) {
    const existing = this.store.get(this.key(ref, name, namespace));
    if (!existing)
      throw new K8sApiError(`${ref.plural} "${name}" not found`, 404, 'NotFound', 'PATCH');
    const merged = applyMergePatch(this.clone(existing), patch) as K8sObject;
    this.seed(ref, merged, namespace);
    return (await this.get<T>(ref, name, namespace))!;
  }

  async delete(ref: K8sResourceRef, name: string, namespace?: string) {
    return this.store.delete(this.key(ref, name, namespace));
  }
}

/** RFC 7386 JSON merge patch */
export function applyMergePatch(target: any, patch: any): any {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const base =
    target !== null && typeof target === 'object' && !Array.isArray(target) ? target : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete base[k];
    else base[k] = applyMergePatch(base[k], v);
  }
  return base;
}
