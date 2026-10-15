import { FastifyInstance } from 'fastify';
import { BaseService } from '../base.service.js';
import { ApplicationError } from '../../utils/errors.js';
import { decryptApiKey, encryptApiKey, getEncryptionKey } from '../../utils/encryption.js';
import { isDevOrTest } from './maas-config.js';

/** Tokens expiring within this window are treated as already expired */
const EXPIRY_SKEW_MS = 30_000;

/** Used only when maas-api is mocked in dev/test and no encryption secret is configured */
const DEV_MOCK_ENCRYPTION_KEY = 'litemaas-dev-mock-user-token-key';

/**
 * Stores the user's own OpenShift access token (captured at login) encrypted at rest, so MaaS
 * API keys can be created with the user's identity. Tokens are only captured when
 * MAAS_ENABLED=true.
 */
export class UserTokenService extends BaseService {
  constructor(
    fastify: FastifyInstance,
    private readonly options: { allowDevFallbackKey?: boolean } = {},
  ) {
    super(fastify);
  }

  private resolveKey(): string | undefined {
    const key = getEncryptionKey(this.fastify.config);
    if (key) return key;
    const mockMaas =
      this.options.allowDevFallbackKey ?? this.fastify.maasClients?.maasApi.mock === true;
    return mockMaas && isDevOrTest() ? DEV_MOCK_ENCRYPTION_KEY : undefined;
  }

  /** True when a secret is available to encrypt tokens */
  canStoreTokens(): boolean {
    return !!this.resolveKey();
  }

  /**
   * Persist (upsert) the user's access token encrypted.
   * @returns false when no encryption key is configured (token is NOT stored)
   */
  async storeToken(
    userId: string,
    accessToken: string,
    expiresInSeconds?: number | null,
    scope?: string | null,
  ): Promise<boolean> {
    const key = this.resolveKey();
    if (!key) {
      this.fastify.log.warn(
        'No ENCRYPTION_KEY / LITELLM_MASTER_KEY configured - user OAuth token not stored, MaaS key management will require re-login',
      );
      return false;
    }
    const encrypted = encryptApiKey(accessToken, key);
    const expiresAt =
      expiresInSeconds && expiresInSeconds > 0
        ? new Date(Date.now() + expiresInSeconds * 1000)
        : null;

    await this.executeQuery(
      `INSERT INTO user_oauth_tokens (user_id, encrypted_access_token, expires_at, scope)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE SET
         encrypted_access_token = EXCLUDED.encrypted_access_token,
         expires_at = EXCLUDED.expires_at,
         scope = EXCLUDED.scope,
         updated_at = CURRENT_TIMESTAMP`,
      [userId, encrypted, expiresAt, scope ?? null],
      'storing user OAuth token',
    );
    return true;
  }

  /**
   * Return the user's decrypted access token if present and unexpired.
   * @throws ApplicationError MAAS_REAUTH_REQUIRED when missing, expired, or undecryptable
   */
  async getValidToken(userId: string): Promise<string> {
    const result = await this.executeQuery<{
      rows: Array<{ encrypted_access_token: string; expires_at: Date | string | null }>;
    }>(
      'SELECT encrypted_access_token, expires_at FROM user_oauth_tokens WHERE user_id = $1',
      [userId],
      'reading user OAuth token',
    );
    const row = result.rows[0];
    if (!row) throw ApplicationError.maasReauthRequired('no_token');

    if (row.expires_at && new Date(row.expires_at).getTime() - EXPIRY_SKEW_MS <= Date.now()) {
      throw ApplicationError.maasReauthRequired('token_expired');
    }

    const key = this.resolveKey();
    if (!key) throw ApplicationError.maasReauthRequired('no_encryption_key');
    try {
      return decryptApiKey(row.encrypted_access_token, key);
    } catch (error) {
      // Encryption key rotated or data corrupted: the user has to log in again
      this.fastify.log.warn(
        { userId, error: (error as Error).message },
        'Failed to decrypt stored user token',
      );
      throw ApplicationError.maasReauthRequired('token_unreadable');
    }
  }

  /** Non-throwing check used for UI hints */
  async hasValidToken(userId: string): Promise<boolean> {
    try {
      await this.getValidToken(userId);
      return true;
    } catch (error) {
      if (error instanceof ApplicationError && error.code === 'MAAS_REAUTH_REQUIRED') return false;
      throw error;
    }
  }

  async clearToken(userId: string): Promise<void> {
    await this.executeQuery(
      'DELETE FROM user_oauth_tokens WHERE user_id = $1',
      [userId],
      'clearing user OAuth token',
    );
  }

  /** Delete tokens that expired before `before` (housekeeping) */
  async purgeExpired(before: Date = new Date()): Promise<number> {
    const res = await this.executeQuery<{ rowCount: number }>(
      'DELETE FROM user_oauth_tokens WHERE expires_at IS NOT NULL AND expires_at < $1',
      [before],
      'purging expired user OAuth tokens',
    );
    return res.rowCount ?? 0;
  }
}
