import { describe, it, expect, vi, beforeEach } from 'vitest';
import { apiKeysService } from '../../services/apiKeys.service';
import { apiClient } from '../../services/api';
import { isMaasReauthError, MAAS_REAUTH_REQUIRED } from '../../utils/modelBackend';

vi.mock('../../services/api', () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

const backendKey = (overrides: Record<string, unknown> = {}) => ({
  id: 'key-1',
  userId: 'user-1',
  name: 'Gateway key',
  keyPrefix: 'sk-oai-abc',
  isActive: true,
  createdAt: '2025-01-01T00:00:00Z',
  ...overrides,
});

describe('apiKeysService MaaS mapping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('maps backendType, baseUrl and maasKeyId of a MaaS key', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({
      data: [
        backendKey({
          backendType: 'maas',
          baseUrl: 'https://maas.example.com/maas',
          maasKeyId: 'maas-key-42',
          tpmLimit: 5000,
        }),
      ],
      total: 1,
    });

    const { data } = await apiKeysService.getApiKeys();

    expect(data[0].backendType).toBe('maas');
    expect(data[0].baseUrl).toBe('https://maas.example.com/maas');
    expect(data[0].maasKeyId).toBe('maas-key-42');
    expect(data[0].tpmLimit).toBe(5000);
  });

  it('defaults to litellm and leaves the MaaS-only fields empty for a LiteLLM key', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({
      data: [backendKey(), backendKey({ id: 'key-2', baseUrl: '', maasKeyId: '' })],
      total: 2,
    });

    const { data } = await apiKeysService.getApiKeys();

    for (const key of data) {
      expect(key.backendType).toBe('litellm');
      expect(key.baseUrl).toBeUndefined();
      expect(key.maasKeyId).toBeUndefined();
    }
  });

  it('maps the backend fields of every model of a key', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({
      data: [
        backendKey({
          backendType: 'maas',
          models: ['ns/llama', 'gpt-4', 'ns/done'],
          modelDetails: [
            {
              id: 'ns/llama',
              name: 'Llama',
              provider: 'maas',
              backendType: 'maas',
              backendModelName: 'llama-3-served',
              migrationState: 'migrating',
              migrationGraceUntil: '2030-01-01T00:00:00Z',
            },
            {
              id: 'gpt-4',
              name: 'GPT-4',
              provider: 'openai',
              backendType: 'litellm',
              backendModelName: null,
              migrationState: null,
              migrationGraceUntil: null,
            },
            {
              id: 'ns/done',
              name: 'Done',
              provider: 'maas',
              backendType: 'maas',
              migrationState: 'completed',
            },
          ],
        }),
      ],
      total: 1,
    });

    const { data } = await apiKeysService.getApiKeys();
    const [llama, gpt, done] = data[0].modelDetails!;

    expect(llama).toMatchObject({
      id: 'ns/llama',
      backendType: 'maas',
      backendModelName: 'llama-3-served',
      migrationState: 'migrating',
      migrationGraceUntil: '2030-01-01T00:00:00Z',
    });
    // null from the API becomes undefined, never a "null" string or an empty value
    expect(gpt.backendType).toBe('litellm');
    expect(gpt.backendModelName).toBeUndefined();
    expect(gpt.migrationState).toBeUndefined();
    expect(gpt.migrationGraceUntil).toBeUndefined();
    expect(done.migrationState).toBe('completed');
    expect(done.migrationGraceUntil).toBeUndefined();
  });

  it('applies the same mapping to a single key and to a created key', async () => {
    const maasResponse = backendKey({
      backendType: 'maas',
      baseUrl: 'https://maas.example.com/maas',
      maasKeyId: 'maas-key-42',
      modelDetails: [{ id: 'ns/llama', name: 'Llama', provider: 'maas', backendType: 'maas' }],
    });
    vi.mocked(apiClient.get).mockResolvedValue(maasResponse);
    vi.mocked(apiClient.post).mockResolvedValue({ ...maasResponse, key: 'sk-oai-secret' });

    const fetched = await apiKeysService.getApiKey('key-1');
    const created = await apiKeysService.createApiKey({
      backendType: 'maas',
      modelIds: ['ns/llama'],
      name: 'Gateway key',
    });

    for (const key of [fetched, created]) {
      expect(key.backendType).toBe('maas');
      expect(key.baseUrl).toBe('https://maas.example.com/maas');
      expect(key.maasKeyId).toBe('maas-key-42');
      expect(key.modelDetails?.[0].backendType).toBe('maas');
    }
    expect(created.fullKey).toBe('sk-oai-secret');
    expect(apiClient.post).toHaveBeenCalledWith('/api-keys', {
      backendType: 'maas',
      modelIds: ['ns/llama'],
      name: 'Gateway key',
    });
  });
});

describe('apiKeysService.retrieveFullKey', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The service logs the backend error body; keep the test output clean
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('returns the key on success', async () => {
    const reveal = { key: 'sk-oai-secret', keyType: 'maas', retrievedAt: '2025-01-01T00:00:00Z' };
    vi.mocked(apiClient.post).mockResolvedValue(reveal);

    await expect(apiKeysService.retrieveFullKey('key-1')).resolves.toEqual(reveal);
    expect(apiClient.post).toHaveBeenCalledWith('/api-keys/key-1/reveal');
  });

  it('surfaces MAAS_REAUTH_REQUIRED (error envelope) as an error carrying the code', async () => {
    vi.mocked(apiClient.post).mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 403,
        data: {
          error: {
            code: 'MAAS_REAUTH_REQUIRED',
            message: 'Your OpenShift login expired, please sign in again',
            statusCode: 403,
          },
        },
      },
    });

    const error = await apiKeysService.retrieveFullKey('key-1').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error & { code?: string }).code).toBe(MAAS_REAUTH_REQUIRED);
    expect((error as Error).message).toBe('Your OpenShift login expired, please sign in again');
    // The pages detect it through the shared helper, never through the HTTP status
    expect(isMaasReauthError(error)).toBe(true);
  });

  it('also recognises a code sent at the top level of the response body', async () => {
    vi.mocked(apiClient.post).mockRejectedValue({
      response: { status: 403, data: { code: 'MAAS_REAUTH_REQUIRED', message: 'Sign in again' } },
    });

    const error = await apiKeysService.retrieveFullKey('key-1').catch((e: unknown) => e);

    expect((error as Error & { code?: string }).code).toBe(MAAS_REAUTH_REQUIRED);
    expect((error as Error).message).toBe('Sign in again');
    expect(isMaasReauthError(error)).toBe(true);
  });

  it('falls back to a default message when the backend sends none', async () => {
    vi.mocked(apiClient.post).mockRejectedValue({
      response: { status: 401, data: { error: { code: 'MAAS_REAUTH_REQUIRED' } } },
    });

    const error = await apiKeysService.retrieveFullKey('key-1').catch((e: unknown) => e);

    expect((error as Error & { code?: string }).code).toBe(MAAS_REAUTH_REQUIRED);
    expect((error as Error).message).toMatch(/log in again/i);
  });

  it('does not mistake other 403 errors for a re-authentication request', async () => {
    vi.mocked(apiClient.post).mockRejectedValue({
      response: {
        status: 403,
        data: { message: 'Recent authentication required', code: 'TOKEN_TOO_OLD' },
      },
    });

    const error = await apiKeysService.retrieveFullKey('key-1').catch((e: unknown) => e);

    expect((error as Error).message).toBe('Recent authentication required');
    expect((error as Error & { code?: string }).code).toBeUndefined();
    expect(isMaasReauthError(error)).toBe(false);
  });
});
