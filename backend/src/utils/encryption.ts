import crypto from 'crypto';

const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const ALGORITHM = 'aes-256-gcm';

/**
 * Resolve the secret used to encrypt/decrypt stored credentials (model provider keys,
 * MaaS API keys, user OAuth tokens).
 *
 * Precedence: ENCRYPTION_KEY, then LITELLM_MASTER_KEY, then LITELLM_API_KEY. When
 * ENCRYPTION_KEY is not set the result is identical to the value historically used by
 * admin-models, so existing encrypted data stays readable.
 */
export function getEncryptionKey(config: {
  ENCRYPTION_KEY?: string;
  LITELLM_MASTER_KEY?: string;
  LITELLM_API_KEY?: string;
}): string | undefined {
  return config.ENCRYPTION_KEY || config.LITELLM_MASTER_KEY || config.LITELLM_API_KEY || undefined;
}

/**
 * Derive a 256-bit AES key from an encryption key string using SHA-256.
 */
function deriveKey(encryptionKey: string): Buffer {
  return crypto.createHash('sha256').update(encryptionKey).digest();
}

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * Returns a base64-encoded string containing: IV (12 bytes) + ciphertext + auth tag (16 bytes).
 */
export function encryptApiKey(plaintext: string, encryptionKey: string): string {
  const key = deriveKey(encryptionKey);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([iv, encrypted, authTag]).toString('base64');
}

/**
 * Decrypt a base64-encoded AES-256-GCM ciphertext.
 * Expects format: IV (12 bytes) + ciphertext + auth tag (16 bytes).
 */
export function decryptApiKey(ciphertext: string, encryptionKey: string): string {
  const key = deriveKey(encryptionKey);
  const data = Buffer.from(ciphertext, 'base64');

  const iv = data.subarray(0, IV_LENGTH);
  const authTag = data.subarray(data.length - AUTH_TAG_LENGTH);
  const encrypted = data.subarray(IV_LENGTH, data.length - AUTH_TAG_LENGTH);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  return decipher.update(encrypted) + decipher.final('utf8');
}
