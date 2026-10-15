import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UserTokenService } from '../../../../src/services/maas/user-token.service';
import { encryptApiKey } from '../../../../src/utils/encryption';

const USER = '00000000-0000-4000-8000-000000000001';

function makeFastify(
  config: Record<string, string | undefined> = { ENCRYPTION_KEY: 'secret' },
  maasClients?: any,
) {
  return {
    config,
    maasClients,
    pg: { query: vi.fn() },
    dbUtils: { queryOne: vi.fn() },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as any;
}

describe('UserTokenService', () => {
  let fastify: ReturnType<typeof makeFastify>;
  let service: UserTokenService;

  beforeEach(() => {
    fastify = makeFastify();
    service = new UserTokenService(fastify);
  });

  describe('storeToken', () => {
    it('upserts an encrypted token with computed expiry', async () => {
      fastify.pg.query.mockResolvedValueOnce({ rows: [] });
      const before = Date.now();
      const stored = await service.storeToken(USER, 'sha256~plaintext', 3600, 'user:full');
      expect(stored).toBe(true);
      const [sql, params] = fastify.pg.query.mock.calls[0];
      expect(sql).toContain('INSERT INTO user_oauth_tokens');
      expect(sql).toContain('ON CONFLICT (user_id) DO UPDATE');
      expect(params[0]).toBe(USER);
      expect(params[1]).not.toContain('plaintext'); // encrypted
      const exp = (params[2] as Date).getTime();
      expect(exp).toBeGreaterThanOrEqual(before + 3_600_000 - 1000);
      expect(exp).toBeLessThanOrEqual(Date.now() + 3_600_000 + 1000);
      expect(params[3]).toBe('user:full');
    });

    it('stores a null expiry when expires_in is unknown', async () => {
      fastify.pg.query.mockResolvedValueOnce({ rows: [] });
      await service.storeToken(USER, 't');
      expect(fastify.pg.query.mock.calls[0][1][2]).toBeNull();
      expect(fastify.pg.query.mock.calls[0][1][3]).toBeNull();
    });

    it('does not store anything without an encryption key', async () => {
      const f = makeFastify({});
      const s = new UserTokenService(f);
      expect(s.canStoreTokens()).toBe(false);
      expect(await s.storeToken(USER, 't', 60)).toBe(false);
      expect(f.pg.query).not.toHaveBeenCalled();
      expect(f.log.warn).toHaveBeenCalled();
    });

    it('falls back to LITELLM_MASTER_KEY (same key as stored model keys)', async () => {
      const f = makeFastify({ LITELLM_MASTER_KEY: 'mk' });
      const s = new UserTokenService(f);
      expect(s.canStoreTokens()).toBe(true);
    });

    it('uses a dev fallback key only when maas-api is mocked in dev/test', async () => {
      const mocked = new UserTokenService(makeFastify({}, { maasApi: { mock: true } }));
      expect(mocked.canStoreTokens()).toBe(true); // NODE_ENV=test under vitest
      const real = new UserTokenService(makeFastify({}, { maasApi: { mock: false } }));
      expect(real.canStoreTokens()).toBe(false);
    });
  });

  describe('getValidToken', () => {
    const encrypted = (t: string, key = 'secret') => encryptApiKey(t, key);

    it('returns the decrypted token', async () => {
      fastify.pg.query.mockResolvedValueOnce({
        rows: [
          {
            encrypted_access_token: encrypted('sha256~abc'),
            expires_at: new Date(Date.now() + 3_600_000),
          },
        ],
      });
      expect(await service.getValidToken(USER)).toBe('sha256~abc');
    });

    it('accepts tokens without an expiry', async () => {
      fastify.pg.query.mockResolvedValueOnce({
        rows: [{ encrypted_access_token: encrypted('t'), expires_at: null }],
      });
      expect(await service.getValidToken(USER)).toBe('t');
    });

    it('throws MAAS_REAUTH_REQUIRED when no token is stored', async () => {
      fastify.pg.query.mockResolvedValueOnce({ rows: [] });
      await expect(service.getValidToken(USER)).rejects.toMatchObject({
        code: 'MAAS_REAUTH_REQUIRED',
        statusCode: 403,
        details: { reason: 'no_token' },
      });
    });

    it('throws MAAS_REAUTH_REQUIRED when expired or about to expire', async () => {
      fastify.pg.query.mockResolvedValueOnce({
        rows: [{ encrypted_access_token: encrypted('t'), expires_at: new Date(Date.now() - 1000) }],
      });
      await expect(service.getValidToken(USER)).rejects.toMatchObject({
        code: 'MAAS_REAUTH_REQUIRED',
        details: { reason: 'token_expired' },
      });
      fastify.pg.query.mockResolvedValueOnce({
        rows: [
          { encrypted_access_token: encrypted('t'), expires_at: new Date(Date.now() + 5_000) },
        ],
      });
      await expect(service.getValidToken(USER)).rejects.toMatchObject({
        code: 'MAAS_REAUTH_REQUIRED',
      });
    });

    it('accepts ISO string expiries (as returned by some drivers)', async () => {
      fastify.pg.query.mockResolvedValueOnce({
        rows: [
          {
            encrypted_access_token: encrypted('t'),
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          },
        ],
      });
      expect(await service.getValidToken(USER)).toBe('t');
    });

    it('asks for re-login when the encryption key changed', async () => {
      fastify.pg.query.mockResolvedValueOnce({
        rows: [{ encrypted_access_token: encrypted('t', 'old-key'), expires_at: null }],
      });
      await expect(service.getValidToken(USER)).rejects.toMatchObject({
        code: 'MAAS_REAUTH_REQUIRED',
        details: { reason: 'token_unreadable' },
      });
    });

    it('asks for re-login when no key is configured', async () => {
      const f = makeFastify({});
      f.pg.query.mockResolvedValueOnce({
        rows: [{ encrypted_access_token: encrypted('t'), expires_at: null }],
      });
      await expect(new UserTokenService(f).getValidToken(USER)).rejects.toMatchObject({
        code: 'MAAS_REAUTH_REQUIRED',
      });
    });

    it('propagates database failures (not a re-auth case)', async () => {
      fastify.pg.query.mockRejectedValueOnce(new Error('connection lost'));
      const err = await service.getValidToken(USER).catch((e) => e);
      expect(err.code).not.toBe('MAAS_REAUTH_REQUIRED');
    });
  });

  describe('hasValidToken / clearToken / purgeExpired', () => {
    it('hasValidToken is a non-throwing boolean for re-auth cases', async () => {
      fastify.pg.query.mockResolvedValueOnce({ rows: [] });
      expect(await service.hasValidToken(USER)).toBe(false);
      fastify.pg.query.mockResolvedValueOnce({
        rows: [{ encrypted_access_token: encryptApiKey('t', 'secret'), expires_at: null }],
      });
      expect(await service.hasValidToken(USER)).toBe(true);
    });

    it('hasValidToken rethrows infrastructure errors', async () => {
      fastify.pg.query.mockRejectedValueOnce(new Error('db down'));
      await expect(service.hasValidToken(USER)).rejects.toBeDefined();
    });

    it('clearToken deletes the row', async () => {
      fastify.pg.query.mockResolvedValueOnce({ rows: [] });
      await service.clearToken(USER);
      expect(fastify.pg.query.mock.calls[0][0]).toContain(
        'DELETE FROM user_oauth_tokens WHERE user_id = $1',
      );
      expect(fastify.pg.query.mock.calls[0][1]).toEqual([USER]);
    });

    it('purgeExpired returns the number of deleted rows', async () => {
      fastify.pg.query.mockResolvedValueOnce({ rowCount: 3 });
      expect(await service.purgeExpired()).toBe(3);
    });
  });
});
