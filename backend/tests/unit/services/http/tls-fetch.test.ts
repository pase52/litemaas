import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

const requestMock = vi.hoisted(() => vi.fn());
vi.mock('node:https', () => ({ default: { request: requestMock }, request: requestMock }));

import { tlsFetch, loadClusterCaBundle } from '../../../../src/services/http/tls-fetch';

function fakeRequest(
  status: number,
  body: string,
  headers: Record<string, string | string[]> = {},
) {
  requestMock.mockImplementation((_url: string, _opts: unknown, cb: (res: any) => void) => {
    const req: any = new EventEmitter();
    req.written = '';
    req.write = (d: string) => {
      req.written += d;
    };
    req.end = () => {
      const res: any = new EventEmitter();
      res.statusCode = status;
      res.statusMessage = 'X';
      res.headers = headers;
      cb(res);
      if (body) res.emit('data', Buffer.from(body));
      res.emit('end');
    };
    fakeRequest.last = req;
    return req;
  });
}
fakeRequest.last = null as any;

describe('tlsFetch', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    requestMock.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('uses global fetch without TLS options', async () => {
    await tlsFetch('https://a/b', { method: 'GET' });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('uses global fetch for http URLs even with TLS options', async () => {
    await tlsFetch('http://a/b', {}, { rejectUnauthorized: false });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('uses global fetch when TLS options are defaults', async () => {
    await tlsFetch('https://a/b', {}, { rejectUnauthorized: true });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('uses https.request with custom CA / skip verify and wraps the response', async () => {
    fakeRequest(201, '{"ok":true}', {
      'content-type': 'application/json',
      'set-cookie': ['a=1', 'b=2'],
    });
    const res = await tlsFetch(
      'https://a/b?x=1',
      { method: 'POST', headers: { H: 'v' }, body: 'payload' },
      { rejectUnauthorized: false, ca: 'PEM' },
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get('content-type')).toBe('application/json');
    const [url, opts] = requestMock.mock.calls[0];
    expect(url).toBe('https://a/b?x=1');
    expect(opts).toMatchObject({
      method: 'POST',
      headers: { H: 'v' },
      rejectUnauthorized: false,
      ca: 'PEM',
    });
    expect(fakeRequest.last.written).toBe('payload');
  });

  it('handles null-body statuses (204)', async () => {
    fakeRequest(204, '');
    const res = await tlsFetch('https://a/b', { method: 'DELETE' }, { ca: 'PEM' });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });

  it('rejects on transport errors', async () => {
    requestMock.mockImplementation(() => {
      const req: any = new EventEmitter();
      req.write = () => {};
      req.end = () => req.emit('error', new Error('self signed certificate'));
      return req;
    });
    await expect(tlsFetch('https://a/b', {}, { ca: 'PEM' })).rejects.toThrow('self signed');
  });
});

describe('loadClusterCaBundle', () => {
  it('returns undefined when no CA file is readable', () => {
    expect(
      loadClusterCaBundle(() => {
        throw new Error('ENOENT');
      }),
    ).toBeUndefined();
  });

  it('appends ca.crt and service-ca.crt to the system roots', () => {
    const bundle = loadClusterCaBundle((p) => `PEM:${p.split('/').pop()}`, undefined)!;
    expect(bundle.length).toBeGreaterThan(2);
    expect(bundle.slice(-2)).toEqual(['PEM:ca.crt', 'PEM:service-ca.crt']);
  });

  it('also appends the NODE_EXTRA_CA_CERTS file (ingress / trusted CA bundle)', () => {
    const bundle = loadClusterCaBundle(
      (p) => `PEM:${p.split('/').pop()}`,
      '/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem',
    )!;
    expect(bundle.slice(-3)).toEqual(['PEM:ca.crt', 'PEM:service-ca.crt', 'PEM:tls-ca-bundle.pem']);
  });

  it('ignores an unreadable NODE_EXTRA_CA_CERTS file', () => {
    const bundle = loadClusterCaBundle((p) => {
      if (p.startsWith('/missing')) throw new Error('ENOENT');
      return 'PEM';
    }, '/missing/ca.pem')!;
    expect(bundle.slice(-2)).toEqual(['PEM', 'PEM']);
  });

  it('works with only one of the files', () => {
    const bundle = loadClusterCaBundle((p) => {
      if (p.endsWith('service-ca.crt')) throw new Error('ENOENT');
      return 'ONLY';
    })!;
    expect(bundle[bundle.length - 1]).toBe('ONLY');
  });
});
