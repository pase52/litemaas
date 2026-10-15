import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  K8sClient,
  K8sApiError,
  InMemoryK8sClient,
  resolveK8sClientConfig,
  buildResourcePath,
  matchesLabelSelector,
  applyMergePatch,
  upsertK8sObject,
  type K8sResourceRef,
} from '../../../../src/services/k8s/k8s-client';

const REF: K8sResourceRef = {
  group: 'maas.opendatahub.io',
  version: 'v1alpha1',
  plural: 'maassubscriptions',
};
const CORE: K8sResourceRef = { group: '', version: 'v1', plural: 'configmaps' };
const CLUSTER: K8sResourceRef = {
  group: 'x.io',
  version: 'v1',
  plural: 'things',
  namespaced: false,
};

function jsonResponse(status: number, body: unknown) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status });
}

describe('buildResourcePath', () => {
  it('builds core, group, cluster-scoped and all-namespace paths', () => {
    expect(buildResourcePath(CORE, 'ns', 'cm')).toBe('/api/v1/namespaces/ns/configmaps/cm');
    expect(buildResourcePath(REF, 'ns')).toBe(
      '/apis/maas.opendatahub.io/v1alpha1/namespaces/ns/maassubscriptions',
    );
    expect(buildResourcePath(REF)).toBe('/apis/maas.opendatahub.io/v1alpha1/maassubscriptions');
    expect(buildResourcePath(CLUSTER, 'ignored', 'n')).toBe('/apis/x.io/v1/things/n');
    expect(buildResourcePath(CORE, 'ns', 'a/b c')).toBe(
      '/api/v1/namespaces/ns/configmaps/a%2Fb%20c',
    );
  });
});

describe('resolveK8sClientConfig', () => {
  const files: Record<string, string> = {
    '/var/run/secrets/kubernetes.io/serviceaccount/token': 'sa-token\n',
    '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt': 'CA-PEM',
  };
  const readFile = (p: string) => {
    if (p in files) return files[p];
    throw new Error('ENOENT');
  };

  it('returns null when neither override nor in-cluster env exist', () => {
    expect(resolveK8sClientConfig({}, {}, readFile)).toBeNull();
  });

  it('uses in-cluster host/port, SA token (lazy) and CA', () => {
    const cfg = resolveK8sClientConfig(
      {},
      { KUBERNETES_SERVICE_HOST: '10.0.0.1', KUBERNETES_SERVICE_PORT: '6443' },
      readFile,
    )!;
    expect(cfg.apiUrl).toBe('https://10.0.0.1:6443');
    expect(cfg.token).toBeUndefined();
    expect(cfg.tokenProvider!()).toBe('sa-token');
    expect(cfg.tls?.ca).toBeDefined();
    expect(JSON.stringify(cfg.tls?.ca)).toContain('CA-PEM');
  });

  it('brackets IPv6 hosts and defaults the port to 443', () => {
    const cfg = resolveK8sClientConfig({}, { KUBERNETES_SERVICE_HOST: 'fd00::1' }, readFile)!;
    expect(cfg.apiUrl).toBe('https://[fd00::1]:443');
  });

  it('K8S_API_URL and K8S_TOKEN override in-cluster values', () => {
    const cfg = resolveK8sClientConfig(
      { K8S_API_URL: 'https://api.example:6443/', K8S_TOKEN: ' tok ' },
      { KUBERNETES_SERVICE_HOST: '10.0.0.1' },
      readFile,
    )!;
    expect(cfg.apiUrl).toBe('https://api.example:6443');
    expect(cfg.token).toBe('tok');
    expect(cfg.tokenProvider).toBeUndefined();
  });

  it('K8S_API_SKIP_TLS_VERIFY disables verification and skips the CA', () => {
    const cfg = resolveK8sClientConfig(
      { K8S_API_URL: 'https://a', K8S_API_SKIP_TLS_VERIFY: 'true' },
      { KUBERNETES_SERVICE_HOST: '10.0.0.1' },
      readFile,
    )!;
    expect(cfg.tls).toEqual({ rejectUnauthorized: false });
  });

  it('tolerates a missing SA token file', () => {
    const cfg = resolveK8sClientConfig({}, { KUBERNETES_SERVICE_HOST: 'h' }, () => {
      throw new Error('ENOENT');
    })!;
    expect(cfg.tokenProvider!()).toBeUndefined();
  });
});

describe('K8sClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const client = () => new K8sClient({ apiUrl: 'https://k8s.test', token: 'T' });

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('get sends bearer auth and returns the object', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { metadata: { name: 'a' } }));
    const obj = await client().get(REF, 'a', 'ns');
    expect(obj).toEqual({ metadata: { name: 'a' } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://k8s.test/apis/maas.opendatahub.io/v1alpha1/namespaces/ns/maassubscriptions/a',
    );
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe('Bearer T');
  });

  it('get resolves null on 404', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(404, { reason: 'NotFound', message: 'nope' }));
    expect(await client().get(REF, 'a', 'ns')).toBeNull();
  });

  it('get throws typed errors on 403 / 500', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(403, { reason: 'Forbidden', message: 'denied' }));
    const err = await client()
      .get(REF, 'a', 'ns')
      .catch((e) => e);
    expect(err).toBeInstanceOf(K8sApiError);
    expect(err).toMatchObject({
      status: 403,
      reason: 'Forbidden',
      message: 'denied',
      isForbidden: true,
      isTransient: false,
    });

    fetchMock.mockResolvedValueOnce(new Response('boom', { status: 500 }));
    const err2 = await client()
      .get(REF, 'a', 'ns')
      .catch((e) => e);
    expect(err2).toMatchObject({ status: 500, message: 'boom', isTransient: true });
  });

  it('wraps transport failures as status 0 errors', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const err = await client()
      .get(REF, 'a', 'ns')
      .catch((e) => e);
    expect(err).toBeInstanceOf(K8sApiError);
    expect(err.status).toBe(0);
    expect(err.isTransient).toBe(true);
    expect(err.message).toContain('ECONNREFUSED');
  });

  it('list passes labelSelector and follows continue tokens', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, { items: [{ metadata: { name: 'a' } }], metadata: { continue: 'C1' } }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, { items: [{ metadata: { name: 'b' } }], metadata: {} }),
      );
    const items = await client().list(REF, {
      namespace: 'ns',
      labelSelector: 'app.kubernetes.io/managed-by=litemaas',
    });
    expect(items.map((i) => i.metadata.name)).toEqual(['a', 'b']);
    const u1 = new URL(fetchMock.mock.calls[0][0]);
    expect(u1.pathname).toBe('/apis/maas.opendatahub.io/v1alpha1/namespaces/ns/maassubscriptions');
    expect(u1.searchParams.get('labelSelector')).toBe('app.kubernetes.io/managed-by=litemaas');
    expect(u1.searchParams.get('continue')).toBeNull();
    expect(new URL(fetchMock.mock.calls[1][0]).searchParams.get('continue')).toBe('C1');
  });

  it('list across all namespaces omits the namespace segment; empty result ok', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));
    expect(await client().list(REF)).toEqual([]);
    expect(new URL(fetchMock.mock.calls[0][0]).pathname).toBe(
      '/apis/maas.opendatahub.io/v1alpha1/maassubscriptions',
    );
  });

  it('create POSTs JSON to the object namespace and surfaces 409', async () => {
    const obj = { metadata: { name: 'a', namespace: 'ns' }, spec: { x: 1 } };
    fetchMock.mockResolvedValueOnce(jsonResponse(201, obj));
    await client().create(REF, obj);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://k8s.test/apis/maas.opendatahub.io/v1alpha1/namespaces/ns/maassubscriptions',
    );
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual(obj);

    fetchMock.mockResolvedValueOnce(
      jsonResponse(409, { reason: 'AlreadyExists', message: 'exists' }),
    );
    await expect(client().create(REF, obj)).rejects.toMatchObject({
      status: 409,
      isConflict: true,
    });
  });

  it('replace PUTs; mergePatch uses merge-patch content type', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(200, { metadata: { name: 'a' } }));
    await client().replace(REF, 'a', { metadata: { name: 'a' } }, 'ns');
    expect(fetchMock.mock.calls[0][1].method).toBe('PUT');
    expect(fetchMock.mock.calls[0][0]).toContain('/namespaces/ns/maassubscriptions/a');

    await client().mergePatch(REF, 'a', { spec: { priority: 2 } }, 'ns');
    const init = fetchMock.mock.calls[1][1];
    expect(init.method).toBe('PATCH');
    expect(init.headers['Content-Type']).toBe('application/merge-patch+json');
    expect(JSON.parse(init.body)).toEqual({ spec: { priority: 2 } });
  });

  it('mergePatch/replace throw on 404', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse(404, { reason: 'NotFound', message: 'gone' }),
    );
    await expect(client().mergePatch(REF, 'a', {}, 'ns')).rejects.toMatchObject({
      isNotFound: true,
    });
    await expect(
      client().replace(REF, 'a', { metadata: { name: 'a' } }, 'ns'),
    ).rejects.toMatchObject({ isNotFound: true });
  });

  it('delete returns true when deleted, false on 404, passes propagationPolicy', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { status: 'Success' }));
    expect(await client().delete(REF, 'a', 'ns', { propagationPolicy: 'Background' })).toBe(true);
    expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get('propagationPolicy')).toBe(
      'Background',
    );
    expect(fetchMock.mock.calls[0][1].method).toBe('DELETE');

    fetchMock.mockResolvedValueOnce(jsonResponse(404, { reason: 'NotFound' }));
    expect(await client().delete(REF, 'a', 'ns')).toBe(false);

    fetchMock.mockResolvedValueOnce(jsonResponse(403, { reason: 'Forbidden', message: 'no' }));
    await expect(client().delete(REF, 'a', 'ns')).rejects.toMatchObject({ isForbidden: true });
  });

  it('reads the token lazily from tokenProvider on every request', async () => {
    let t = 'one';
    const c = new K8sClient({ apiUrl: 'https://k8s.test', tokenProvider: () => t });
    fetchMock.mockImplementation(async () => jsonResponse(200, { metadata: { name: 'a' } }));
    await c.get(CORE, 'a', 'ns');
    t = 'two';
    await c.get(CORE, 'a', 'ns');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer one');
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer two');
  });

  it('omits Authorization without a token', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { metadata: { name: 'a' } }));
    await new K8sClient({ apiUrl: 'https://k8s.test' }).get(CORE, 'a', 'ns');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });
});

describe('matchesLabelSelector', () => {
  const labels = { app: 'x', tier: 'be' };
  it.each([
    ['', true],
    ['app=x', true],
    ['app==x', true],
    ['app=y', false],
    ['app!=y', true],
    ['app!=x', false],
    ['app', true],
    ['nope', false],
    ['!nope', true],
    ['!app', false],
    ['app in (x,y)', true],
    ['app in (y,z)', false],
    ['app notin (y,z)', true],
    ['app notin (x)', false],
    ['app=x,tier=be', true],
    ['app=x,tier=fe', false],
    ['app in (x,y),tier=be', true],
  ])('%j -> %s', (sel, expected) => {
    expect(matchesLabelSelector(labels, sel)).toBe(expected);
  });
  it('treats missing labels as empty', () => {
    expect(matchesLabelSelector(undefined, 'a=b')).toBe(false);
    expect(matchesLabelSelector(undefined, '!a')).toBe(true);
  });
});

describe('applyMergePatch', () => {
  it('merges recursively, deletes on null, replaces arrays', () => {
    expect(
      applyMergePatch({ a: 1, b: { c: 2, d: 3 }, e: [1, 2] }, { b: { c: null, x: 9 }, e: [3] }),
    ).toEqual({ a: 1, b: { d: 3, x: 9 }, e: [3] });
  });
});

describe('InMemoryK8sClient', () => {
  const obj = (name: string, labels: Record<string, string> = {}) => ({
    metadata: { name, namespace: 'ns', labels },
    spec: { v: 1 },
  });

  it('supports CRUD with resourceVersion and conflict semantics', async () => {
    const c = new InMemoryK8sClient();
    expect(c.mock).toBe(true);
    expect(await c.get(REF, 'a', 'ns')).toBeNull();

    const created = await c.create(REF, obj('a'));
    expect(created.metadata.resourceVersion).toBeDefined();
    await expect(c.create(REF, obj('a'))).rejects.toMatchObject({ status: 409 });

    const replaced = await c.replace(REF, 'a', {
      ...obj('a'),
      spec: { v: 2 },
      metadata: { ...obj('a').metadata, resourceVersion: created.metadata.resourceVersion },
    });
    expect(replaced.spec).toEqual({ v: 2 });
    // stale resourceVersion -> conflict
    await expect(
      c.replace(REF, 'a', {
        ...obj('a'),
        metadata: { ...obj('a').metadata, resourceVersion: created.metadata.resourceVersion },
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(c.replace(REF, 'zzz', obj('zzz'), 'ns')).rejects.toMatchObject({ status: 404 });

    const patched = await c.mergePatch(REF, 'a', { spec: { w: 3 } }, 'ns');
    expect(patched.spec).toEqual({ v: 2, w: 3 });
    await expect(c.mergePatch(REF, 'nope', {}, 'ns')).rejects.toMatchObject({ status: 404 });

    expect(await c.delete(REF, 'a', 'ns')).toBe(true);
    expect(await c.delete(REF, 'a', 'ns')).toBe(false);
  });

  it('lists by namespace and label selector, isolates resource types', async () => {
    const c = new InMemoryK8sClient();
    await c.create(REF, obj('a', { team: 'x' }));
    await c.create(REF, { metadata: { name: 'b', namespace: 'other', labels: { team: 'y' } } });
    await c.create(CORE, obj('cm'));
    expect((await c.list(REF)).map((o) => o.metadata.name).sort()).toEqual(['a', 'b']);
    expect((await c.list(REF, { namespace: 'ns' })).map((o) => o.metadata.name)).toEqual(['a']);
    expect((await c.list(REF, { labelSelector: 'team=y' })).map((o) => o.metadata.name)).toEqual([
      'b',
    ]);
    expect((await c.list(CORE)).map((o) => o.metadata.name)).toEqual(['cm']);
  });

  it('returns copies (mutating a result does not alter the store)', async () => {
    const c = new InMemoryK8sClient();
    await c.create(REF, obj('a'));
    const got = (await c.get(REF, 'a', 'ns'))!;
    got.spec!.v = 99;
    expect((await c.get(REF, 'a', 'ns'))!.spec!.v).toBe(1);
  });
});

describe('upsertK8sObject', () => {
  it('creates when absent and replaces (with resourceVersion) when present', async () => {
    const c = new InMemoryK8sClient();
    const o = { metadata: { name: 'a', namespace: 'ns' }, spec: { v: 1 } };
    const first = await upsertK8sObject(c, REF, o);
    expect(first.spec).toEqual({ v: 1 });
    const second = await upsertK8sObject(c, REF, { ...o, spec: { v: 2 } });
    expect(second.spec).toEqual({ v: 2 });
    expect(await c.list(REF)).toHaveLength(1);
  });

  it('retries once on conflict', async () => {
    const c = new InMemoryK8sClient();
    const o = { metadata: { name: 'a', namespace: 'ns' }, spec: { v: 1 } };
    const realCreate = c.create.bind(c);
    let calls = 0;
    c.create = (async (...args: Parameters<typeof c.create>) => {
      if (calls++ === 0) {
        await realCreate(REF, { ...o, spec: { v: 0 } }); // concurrent writer wins
        throw new K8sApiError('exists', 409, 'AlreadyExists');
      }
      return realCreate(...args);
    }) as typeof c.create;
    const res = await upsertK8sObject(c, REF, o);
    expect(res.spec).toEqual({ v: 1 });
  });

  it('does not swallow non-conflict errors', async () => {
    const c = new InMemoryK8sClient();
    c.get = async () => {
      throw new K8sApiError('forbidden', 403, 'Forbidden');
    };
    await expect(
      upsertK8sObject(c, REF, { metadata: { name: 'a', namespace: 'ns' } }),
    ).rejects.toMatchObject({ status: 403 });
  });
});
