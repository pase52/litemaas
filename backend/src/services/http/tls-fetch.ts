import https from 'node:https';
import { readFileSync } from 'node:fs';
import { rootCertificates } from 'node:tls';

/**
 * TLS options for outbound HTTPS calls to cluster-internal services (Kubernetes API,
 * maas-api, Prometheus/Thanos) that frequently use private CAs.
 */
export interface TlsOptions {
  /** PEM-encoded CA bundle to trust in addition to / instead of system roots */
  ca?: string | Buffer | Array<string | Buffer>;
  /** false disables certificate verification (development / trusted clusters only) */
  rejectUnauthorized?: boolean;
}

export interface TlsFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/**
 * fetch() wrapper that supports custom TLS settings.
 *
 * Node's global fetch ignores `https.Agent`, so when custom TLS options are required for an
 * https URL we go through `https.request` and wrap the result in a standard `Response`.
 * Without TLS options (or for http URLs) the global `fetch` is used unchanged, which keeps
 * the behaviour identical to the rest of the code base and trivially mockable in tests.
 */
export async function tlsFetch(
  url: string,
  init: TlsFetchInit = {},
  tls?: TlsOptions,
): Promise<Response> {
  const needsCustomTls = !!tls && (tls.ca !== undefined || tls.rejectUnauthorized === false);
  if (!needsCustomTls || !url.startsWith('https:')) {
    return fetch(url, init);
  }

  return new Promise<Response>((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: init.method || 'GET',
        headers: init.headers,
        ca: tls!.ca,
        rejectUnauthorized: tls!.rejectUnauthorized ?? true,
        signal: init.signal,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('error', reject);
        res.on('end', () => {
          const headers = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
            else if (v !== undefined) headers.set(k, v);
          }
          const status = res.statusCode ?? 0;
          const body = NULL_BODY_STATUSES.has(status) ? null : Buffer.concat(chunks);
          resolve(new Response(body, { status, statusText: res.statusMessage, headers }));
        });
      },
    );
    req.on('error', reject);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}

const SA_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';

/**
 * Build a CA bundle for cluster-internal HTTPS endpoints: the in-cluster service account CA
 * (ca.crt) and the OpenShift service CA (service-ca.crt), on top of the system roots (Node's
 * `ca` option replaces the defaults, so they must be re-added to keep public CAs working).
 * The file named by NODE_EXTRA_CA_CERTS (if any) is appended too.
 * Returns undefined when no cluster CA file is readable (not running in-cluster).
 */
export function loadClusterCaBundle(
  readFile: (path: string) => string = (p) => readFileSync(p, 'utf-8'),
  extraCaFile: string | undefined = process.env.NODE_EXTRA_CA_CERTS,
): string[] | undefined {
  const extra: string[] = [];
  for (const file of ['ca.crt', 'service-ca.crt']) {
    try {
      const pem = readFile(`${SA_DIR}/${file}`);
      if (pem) extra.push(pem);
    } catch {
      // not present
    }
  }
  if (!extra.length) return undefined;
  // Passing `ca` replaces Node's default store, which would silently drop NODE_EXTRA_CA_CERTS
  // (e.g. the OpenShift trusted CA bundle holding the ingress CA that signs the maas-api route).
  if (extraCaFile) {
    try {
      const pem = readFile(extraCaFile);
      if (pem) extra.push(pem);
    } catch {
      // not readable: keep the cluster CAs only
    }
  }
  return [...rootCertificates, ...extra];
}
