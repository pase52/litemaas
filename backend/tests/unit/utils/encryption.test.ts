import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { encryptApiKey, decryptApiKey, getEncryptionKey } from '../../../src/utils/encryption';

describe('getEncryptionKey', () => {
  it('prefers ENCRYPTION_KEY over LiteLLM keys', () => {
    expect(
      getEncryptionKey({ ENCRYPTION_KEY: 'e', LITELLM_MASTER_KEY: 'm', LITELLM_API_KEY: 'a' }),
    ).toBe('e');
  });

  it('falls back to LITELLM_MASTER_KEY then LITELLM_API_KEY (legacy behaviour)', () => {
    expect(getEncryptionKey({ LITELLM_MASTER_KEY: 'm', LITELLM_API_KEY: 'a' })).toBe('m');
    expect(getEncryptionKey({ LITELLM_API_KEY: 'a' })).toBe('a');
  });

  it('returns undefined when nothing is configured (including empty strings)', () => {
    expect(getEncryptionKey({})).toBeUndefined();
    expect(getEncryptionKey({ ENCRYPTION_KEY: '', LITELLM_MASTER_KEY: '' })).toBeUndefined();
  });

  it('keeps existing ciphertext readable when ENCRYPTION_KEY is unset', () => {
    // Data encrypted the legacy way (LITELLM_MASTER_KEY || LITELLM_API_KEY directly)
    const legacy = encryptApiKey('provider-secret', 'master-key');
    const key = getEncryptionKey({ LITELLM_MASTER_KEY: 'master-key', LITELLM_API_KEY: 'api' })!;
    expect(decryptApiKey(legacy, key)).toBe('provider-secret');
  });

  it('derives the AES key as sha256(secret) (format unchanged)', () => {
    const ct = encryptApiKey('x', 's');
    const data = Buffer.from(ct, 'base64');
    const iv = data.subarray(0, 12);
    const tag = data.subarray(data.length - 16);
    const body = data.subarray(12, data.length - 16);
    const d = crypto.createDecipheriv(
      'aes-256-gcm',
      crypto.createHash('sha256').update('s').digest(),
      iv,
    );
    d.setAuthTag(tag);
    expect(d.update(body) + d.final('utf8')).toBe('x');
  });
});
