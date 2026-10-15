import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '../../test-utils';
import userEvent from '@testing-library/user-event';
import ApiKeysPage from '../../../pages/ApiKeysPage';
import { apiKeysService } from '../../../services/apiKeys.service';

let mockMaasEnabled = true;
vi.mock('../../../hooks/useMaasEnabled', () => ({
  useMaasEnabled: () => ({ maasEnabled: mockMaasEnabled }),
}));

const future = new Date(Date.now() + 7 * 86400000).toISOString();

const mockModels = [
  {
    id: 'gpt-4',
    name: 'GPT-4',
    provider: 'openai',
    description: '',
    category: 'Language Model',
    contextLength: 8000,
    pricing: { input: 0, output: 0 },
    features: [],
    availability: 'available',
    version: '4',
    backendType: 'litellm',
    supportsChat: true,
    migrationGraceUntil: future,
    migrationState: 'migrating',
  },
  {
    id: 'maas-demo/llama-3',
    name: 'Llama 3 (MaaS)',
    provider: 'maas',
    description: '',
    category: 'Language Model',
    contextLength: 8000,
    pricing: { input: 0, output: 0 },
    features: [],
    availability: 'available',
    version: '3',
    backendType: 'maas',
    backendModelName: 'llama-3-served',
    supportsChat: true,
  },
];

vi.mock('../../../services/subscriptions.service', () => ({
  subscriptionsService: {
    getSubscriptions: vi.fn(() =>
      Promise.resolve({
        data: [
          { id: 's1', modelId: 'gpt-4', status: 'active' },
          { id: 's2', modelId: 'maas-demo/llama-3', status: 'active' },
        ],
        pagination: { page: 1, limit: 100, total: 2, totalPages: 1 },
      }),
    ),
  },
}));

vi.mock('../../../services/models.service', () => ({
  modelsService: {
    getModels: vi.fn(() =>
      Promise.resolve({
        models: mockModels,
        pagination: { page: 1, limit: 1000, total: 2, totalPages: 1 },
      }),
    ),
  },
}));

vi.mock('../../../services/apiKeys.service', () => ({
  apiKeysService: {
    getApiKeys: vi.fn(),
    createApiKey: vi.fn(),
    updateApiKey: vi.fn(),
    deleteApiKey: vi.fn(),
    retrieveFullKey: vi.fn(),
  },
}));

const litellmKey = {
  id: 'k-litellm',
  name: 'Legacy key',
  keyPreview: 'sk-lit...',
  status: 'active' as const,
  permissions: ['read'],
  usageCount: 0,
  rateLimit: 1000,
  createdAt: '2025-01-01T00:00:00Z',
  models: ['gpt-4'],
  modelDetails: [{ id: 'gpt-4', name: 'GPT-4', provider: 'openai' }],
  backendType: 'litellm' as const,
};

const maasKey = {
  id: 'k-maas',
  name: 'Gateway key',
  keyPreview: 'sk-oai-...',
  status: 'active' as const,
  permissions: ['read'],
  usageCount: 0,
  rateLimit: 1000,
  createdAt: '2025-01-01T00:00:00Z',
  models: ['maas-demo/llama-3'],
  modelDetails: [{ id: 'maas-demo/llama-3', name: 'Llama 3 (MaaS)', provider: 'maas' }],
  backendType: 'maas' as const,
  baseUrl: 'https://maas.example.com/maas',
  tpmLimit: 5000,
};

const findCreateButton = () =>
  screen.getAllByRole('button').find((b) => /createKey|Create API Key/.test(b.textContent || ''))!;

const openCreateModal = async (user: ReturnType<typeof userEvent.setup>) => {
  await waitFor(() => expect(findCreateButton()).toBeDefined());
  await user.click(findCreateButton());
  return screen.findByRole('dialog');
};

describe('ApiKeysPage with the MaaS backend', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMaasEnabled = true;
    vi.mocked(apiKeysService.getApiKeys).mockResolvedValue({
      data: [litellmKey, maasKey],
      pagination: { page: 1, limit: 20, total: 2, totalPages: 1 },
    });
  });

  it('shows the backend toggle and only LiteLLM models by default', async () => {
    const user = userEvent.setup();
    render(<ApiKeysPage />);
    const dialog = await openCreateModal(user);

    expect(within(dialog).getByText('LiteLLM')).toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getByText('GPT-4')).toBeInTheDocument());
    expect(within(dialog).queryByText('Llama 3 (MaaS)')).not.toBeInTheDocument();
    // LiteLLM-only fields are present
    expect(dialog.querySelector('#key-rpm-limit')).not.toBeNull();
    expect(dialog.querySelector('#key-max-budget')).not.toBeNull();
  });

  it('switching to MaaS filters models and hides non-TPM limits', async () => {
    const user = userEvent.setup();
    render(<ApiKeysPage />);
    const dialog = await openCreateModal(user);

    await user.click(dialog.querySelector('#key-backend-maas') as HTMLElement);

    await waitFor(() => expect(within(dialog).getByText('Llama 3 (MaaS)')).toBeInTheDocument());
    expect(within(dialog).queryByText('GPT-4')).not.toBeInTheDocument();
    expect(dialog.querySelector('#key-rpm-limit')).toBeNull();
    expect(dialog.querySelector('#key-max-budget')).toBeNull();
    expect(dialog.querySelector('#key-budget-duration')).toBeNull();
    expect(dialog.querySelector('#key-tpm-limit')).not.toBeNull();
    expect(screen.getByTestId('maas-tpm-only-notice')).toBeInTheDocument();
  });

  it('creates a MaaS key with backendType maas and without budget/RPM', async () => {
    const user = userEvent.setup();
    vi.mocked(apiKeysService.createApiKey).mockResolvedValue({ ...maasKey, fullKey: 'sk-oai-new' });
    render(<ApiKeysPage />);
    const dialog = await openCreateModal(user);

    await user.click(dialog.querySelector('#key-backend-maas') as HTMLElement);
    await user.type(dialog.querySelector('#key-name') as HTMLElement, 'My MaaS key');
    await user.click(await within(dialog).findByText('Llama 3 (MaaS)'));
    await user.type(dialog.querySelector('#key-tpm-limit') as HTMLElement, '2000');
    const submit = within(dialog)
      .getAllByRole('button')
      .find((b) => /createKey|Create API Key/.test(b.textContent || ''))!;
    await user.click(submit);

    await waitFor(() => expect(apiKeysService.createApiKey).toHaveBeenCalledTimes(1));
    const request = vi.mocked(apiKeysService.createApiKey).mock.calls[0][0];
    expect(request.backendType).toBe('maas');
    expect(request.modelIds).toEqual(['maas-demo/llama-3']);
    expect(request.tpmLimit).toBe(2000);
    expect(request.rpmLimit).toBeUndefined();
    expect(request.maxBudget).toBeUndefined();
    expect(request.budgetDuration).toBeUndefined();
  });

  it('does not send backendType when creating a LiteLLM key', async () => {
    const user = userEvent.setup();
    vi.mocked(apiKeysService.createApiKey).mockResolvedValue({ ...litellmKey, fullKey: 'sk-x' });
    render(<ApiKeysPage />);
    const dialog = await openCreateModal(user);

    await user.type(dialog.querySelector('#key-name') as HTMLElement, 'My key');
    await user.click(await within(dialog).findByText('GPT-4'));
    const submit = within(dialog)
      .getAllByRole('button')
      .find((b) => /createKey|Create API Key/.test(b.textContent || ''))!;
    await user.click(submit);

    await waitFor(() => expect(apiKeysService.createApiKey).toHaveBeenCalledTimes(1));
    expect(vi.mocked(apiKeysService.createApiKey).mock.calls[0][0]).not.toHaveProperty(
      'backendType',
    );
  });

  it('shows an inline re-authenticate alert on MAAS_REAUTH_REQUIRED', async () => {
    const user = userEvent.setup();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: true, json: async () => ({ authUrl: '' }) } as Response);
    vi.mocked(apiKeysService.createApiKey).mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 403,
        data: { error: { code: 'MAAS_REAUTH_REQUIRED', message: 'Login again', statusCode: 403 } },
      },
    });
    render(<ApiKeysPage />);
    const dialog = await openCreateModal(user);

    await user.click(dialog.querySelector('#key-backend-maas') as HTMLElement);
    await user.type(dialog.querySelector('#key-name') as HTMLElement, 'k');
    await user.click(await within(dialog).findByText('Llama 3 (MaaS)'));
    const submit = within(dialog)
      .getAllByRole('button')
      .find((b) => /createKey|Create API Key/.test(b.textContent || ''))!;
    await user.click(submit);

    const alert = await screen.findByTestId('maas-reauth-alert');
    expect(alert).toBeInTheDocument();
    // The create dialog stays open so the form is not lost
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await user.click(screen.getByTestId('maas-reauth-button'));
    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(
        '/api/auth/login',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    fetchSpy.mockRestore();
  });

  it('editing a MaaS key hides non-TPM fields and sends only TPM limits', async () => {
    const user = userEvent.setup();
    vi.mocked(apiKeysService.updateApiKey).mockResolvedValue(maasKey);
    render(<ApiKeysPage />);

    await screen.findByText('Gateway key');
    const row = screen.getByText('Gateway key').closest('tr') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: /edit/i }));
    const dialog = await screen.findByRole('dialog');

    expect(dialog.querySelector('#key-rpm-limit')).toBeNull();
    expect(dialog.querySelector('#key-max-budget')).toBeNull();
    expect(dialog.querySelector('#key-tpm-limit')).not.toBeNull();

    const save = within(dialog)
      .getAllByRole('button')
      .find((b) => /updateKey|Update/.test(b.textContent || ''))!;
    await user.click(save);

    await waitFor(() => expect(apiKeysService.updateApiKey).toHaveBeenCalledTimes(1));
    const [, updates] = vi.mocked(apiKeysService.updateApiKey).mock.calls[0];
    expect(updates.tpmLimit).toBe(5000);
    expect(updates.rpmLimit).toBeUndefined();
    expect(updates.maxBudget).toBeUndefined();
    expect(updates.budgetDuration).toBeUndefined();
  });

  it('uses the key base URL and served model name in the curl example', async () => {
    const user = userEvent.setup();
    render(<ApiKeysPage />);

    await screen.findByText('Gateway key');
    const row = screen.getByText('Gateway key').closest('tr') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: /view/i }));
    const dialog = await screen.findByRole('dialog');

    await waitFor(() => {
      const text = dialog.textContent || '';
      expect(text).toContain('https://maas.example.com/maas/v1/chat/completions');
      expect(text).toContain('"model": "llama-3-served"');
    });
  });

  it('shows a banner for LiteLLM keys with models in a migration grace period', async () => {
    render(<ApiKeysPage />);
    const banner = await screen.findByTestId('maas-grace-banner');
    expect(banner).toHaveTextContent('Legacy key');
    expect(banner).toHaveTextContent('GPT-4');
  });

  it('shows the MaaS badge on MaaS keys in the list', async () => {
    render(<ApiKeysPage />);
    await screen.findByText('Gateway key');
    expect(screen.getAllByTestId('backend-badge-maas').length).toBeGreaterThan(0);
  });

  it('changes nothing visible when MaaS is disabled', async () => {
    mockMaasEnabled = false;
    vi.mocked(apiKeysService.getApiKeys).mockResolvedValue({
      data: [litellmKey],
      pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
    });
    const user = userEvent.setup();
    render(<ApiKeysPage />);
    const dialog = await openCreateModal(user);

    expect(dialog.querySelector('#key-backend-maas')).toBeNull();
    expect(screen.queryByTestId('maas-grace-banner')).not.toBeInTheDocument();
    expect(screen.queryByTestId('backend-badge-maas')).not.toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getByText('GPT-4')).toBeInTheDocument());
    expect(dialog.querySelector('#key-rpm-limit')).not.toBeNull();
  });
});
