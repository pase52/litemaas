import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '../../test-utils';
import userEvent from '@testing-library/user-event';
import ApiKeysPage from '../../../pages/ApiKeysPage';
import { apiKeysService, type ApiKey } from '../../../services/apiKeys.service';

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
  {
    id: 'maas-demo/mistral',
    name: 'Mistral (MaaS)',
    provider: 'maas',
    description: '',
    category: 'Language Model',
    contextLength: 8000,
    pricing: { input: 0, output: 0 },
    features: [],
    availability: 'available',
    version: '7',
    backendType: 'maas',
    backendModelName: 'mistral-served',
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
          { id: 's3', modelId: 'maas-demo/mistral', status: 'active' },
        ],
        pagination: { page: 1, limit: 100, total: 3, totalPages: 1 },
      }),
    ),
  },
}));

vi.mock('../../../services/models.service', () => ({
  modelsService: {
    getModels: vi.fn(() =>
      Promise.resolve({
        models: mockModels,
        pagination: { page: 1, limit: 1000, total: 3, totalPages: 1 },
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

const inDays = (days: number) => new Date(Date.now() + days * 86400000).toISOString();
const utcDay = (iso: string) => iso.split('T')[0];

const mockKeys = (...keys: ApiKey[]) =>
  vi.mocked(apiKeysService.getApiKeys).mockResolvedValue({
    data: keys,
    pagination: { page: 1, limit: 20, total: keys.length, totalPages: 1 },
  });

const openEditModal = async (user: ReturnType<typeof userEvent.setup>, keyName: string) => {
  const row = (await screen.findByText(keyName)).closest('tr') as HTMLElement;
  await user.click(within(row).getByRole('button', { name: /edit/i }));
  return screen.findByRole('dialog');
};

const clickUpdate = (user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement) =>
  user.click(
    within(dialog)
      .getAllByRole('button')
      .find((b) => /updateKey|Update/.test(b.textContent || ''))!,
  );

// The model chips are buttons; the per-model limits section repeats the model names as text
const chip = (dialog: HTMLElement, name: string) => within(dialog).getByRole('button', { name });
const findChip = (dialog: HTMLElement, name: string) =>
  within(dialog).findByRole('button', { name });

const lastUpdate = () => {
  const [id, updates] = vi.mocked(apiKeysService.updateApiKey).mock.calls[0];
  return { id, updates };
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
    // It is the only feedback in the modal, so it has to be announced
    expect(alert).toHaveAttribute('aria-live', 'polite');
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

describe('ApiKeysPage editing a MaaS key: models payload', () => {
  // The second model of this key is not available (MaaSModelRef Pending/Failed): it is part of the
  // key but GET /models does not list it, so the edit form shows no chip for it
  const keyWithUnavailableModel: ApiKey = {
    ...maasKey,
    id: 'k-maas-pending',
    name: 'Pending model key',
    models: ['maas-demo/llama-3', 'maas-demo/pending-ref'],
    modelDetails: [
      { id: 'maas-demo/llama-3', name: 'Llama 3 (MaaS)', provider: 'maas' },
      { id: 'maas-demo/pending-ref', name: 'Pending ref (MaaS)', provider: 'maas' },
    ],
  };
  const keyWithTwoModels: ApiKey = {
    ...maasKey,
    id: 'k-maas-two',
    name: 'Two model key',
    models: ['maas-demo/llama-3', 'maas-demo/mistral'],
    modelDetails: [
      { id: 'maas-demo/llama-3', name: 'Llama 3 (MaaS)', provider: 'maas' },
      { id: 'maas-demo/mistral', name: 'Mistral (MaaS)', provider: 'maas' },
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockMaasEnabled = true;
    vi.mocked(apiKeysService.updateApiKey).mockResolvedValue(maasKey);
  });

  it('does not resend the models when only the name changes', async () => {
    const user = userEvent.setup();
    mockKeys(maasKey);
    render(<ApiKeysPage />);
    const dialog = await openEditModal(user, 'Gateway key');

    const name = dialog.querySelector('#key-name') as HTMLInputElement;
    await user.clear(name);
    await user.type(name, 'Renamed key');
    await clickUpdate(user, dialog);

    await waitFor(() => expect(apiKeysService.updateApiKey).toHaveBeenCalledTimes(1));
    const { id, updates } = lastUpdate();
    expect(id).toBe('k-maas');
    expect(updates.name).toBe('Renamed key');
    expect(updates).not.toHaveProperty('modelIds');
    // The TPM limit of the key is still sent
    expect(updates.tpmLimit).toBe(5000);
  });

  it('stays editable while one of its models is unavailable', async () => {
    const user = userEvent.setup();
    mockKeys(keyWithUnavailableModel);
    render(<ApiKeysPage />);
    const dialog = await openEditModal(user, 'Pending model key');

    // Only the available models are offered as chips
    await waitFor(() => expect(chip(dialog, 'Llama 3 (MaaS)')).toBeInTheDocument());
    expect(within(dialog).queryByRole('button', { name: 'Pending ref (MaaS)' })).toBeNull();

    const name = dialog.querySelector('#key-name') as HTMLInputElement;
    await user.clear(name);
    await user.type(name, 'Still editable');
    await clickUpdate(user, dialog);

    // Re-sending the unavailable model would be rejected with "Models are currently unavailable"
    await waitFor(() => expect(apiKeysService.updateApiKey).toHaveBeenCalledTimes(1));
    const { updates } = lastUpdate();
    expect(updates.name).toBe('Still editable');
    expect(updates).not.toHaveProperty('modelIds');
  });

  it('sends modelIds when the selected models of a MaaS key change', async () => {
    const user = userEvent.setup();
    mockKeys(maasKey);
    render(<ApiKeysPage />);
    const dialog = await openEditModal(user, 'Gateway key');

    await user.click(await findChip(dialog, 'Mistral (MaaS)'));
    await clickUpdate(user, dialog);

    await waitFor(() => expect(apiKeysService.updateApiKey).toHaveBeenCalledTimes(1));
    expect(lastUpdate().updates.modelIds).toEqual(['maas-demo/llama-3', 'maas-demo/mistral']);
  });

  it('sends modelIds when a model is removed from a MaaS key', async () => {
    const user = userEvent.setup();
    mockKeys(keyWithTwoModels);
    render(<ApiKeysPage />);
    const dialog = await openEditModal(user, 'Two model key');

    await user.click(await findChip(dialog, 'Llama 3 (MaaS)'));
    await clickUpdate(user, dialog);

    await waitFor(() => expect(apiKeysService.updateApiKey).toHaveBeenCalledTimes(1));
    expect(lastUpdate().updates.modelIds).toEqual(['maas-demo/mistral']);
  });

  it('compares the models as a set: re-selecting a model in another order is no change', async () => {
    const user = userEvent.setup();
    mockKeys(keyWithTwoModels);
    render(<ApiKeysPage />);
    const dialog = await openEditModal(user, 'Two model key');

    // Deselect and select again: the selection becomes [mistral, llama-3]
    await user.click(await findChip(dialog, 'Llama 3 (MaaS)'));
    await user.click(chip(dialog, 'Llama 3 (MaaS)'));
    await clickUpdate(user, dialog);

    await waitFor(() => expect(apiKeysService.updateApiKey).toHaveBeenCalledTimes(1));
    expect(lastUpdate().updates).not.toHaveProperty('modelIds');
  });

  it('keeps sending modelIds, with an unchanged payload, when editing a LiteLLM key', async () => {
    const user = userEvent.setup();
    vi.mocked(apiKeysService.updateApiKey).mockResolvedValue(litellmKey);
    mockKeys(litellmKey);
    render(<ApiKeysPage />);
    const dialog = await openEditModal(user, 'Legacy key');

    await clickUpdate(user, dialog);

    await waitFor(() => expect(apiKeysService.updateApiKey).toHaveBeenCalledTimes(1));
    const { id, updates } = lastUpdate();
    expect(id).toBe('k-litellm');
    // Same fields, same order as before the MaaS backend existed
    expect(JSON.stringify(updates)).toBe(
      JSON.stringify({
        name: 'Legacy key',
        modelIds: ['gpt-4'],
        expiresAt: null,
        metadata: { permissions: [], rateLimit: 1000 },
      }),
    );
  });
});

describe('ApiKeysPage editing a MaaS key: expiration', () => {
  const expiringIn = (days: number): ApiKey => ({
    ...maasKey,
    id: 'k-maas-exp',
    name: 'Expiring gateway key',
    expiresAt: inDays(days),
  });
  const optionOf = (select: HTMLElement, value: string) =>
    select.querySelector(`option[value="${value}"]`) as HTMLOptionElement;

  beforeEach(() => {
    vi.clearAllMocks();
    mockMaasEnabled = true;
    vi.mocked(apiKeysService.updateApiKey).mockResolvedValue(maasKey);
  });

  it('only offers expirations that shorten the key and explains why', async () => {
    const user = userEvent.setup();
    mockKeys(expiringIn(45));
    render(<ApiKeysPage />);
    const dialog = await openEditModal(user, 'Expiring gateway key');

    const select = dialog.querySelector('#key-expiration') as HTMLSelectElement;
    // maas-api rejects "Never" and anything later than the current expiry
    expect(optionOf(select, 'never').disabled).toBe(true);
    expect(optionOf(select, '30').disabled).toBe(false);
    for (const days of ['60', '90', '180', '365']) {
      expect(optionOf(select, days).disabled).toBe(true);
    }
    expect(optionOf(select, 'custom').disabled).toBe(false);

    expect(within(dialog).getByTestId('maas-expiry-shorten-only')).toHaveTextContent(
      'MaaS API keys can only have their expiration shortened.',
    );
    expect(select).toHaveAttribute('aria-describedby', 'key-expiration-maas-help');
    expect(dialog.querySelector('#key-expiration-maas-help')).not.toBeNull();
  });

  it('offers every expiration for a MaaS key that does not expire yet, with the same hint', async () => {
    const user = userEvent.setup();
    mockKeys(maasKey);
    render(<ApiKeysPage />);
    const dialog = await openEditModal(user, 'Gateway key');

    const select = dialog.querySelector('#key-expiration') as HTMLSelectElement;
    for (const value of ['never', '30', '60', '90', '180', '365', 'custom']) {
      expect(optionOf(select, value).disabled).toBe(false);
    }
    // Once an expiry is set it can no longer be removed or extended
    expect(within(dialog).getByTestId('maas-expiry-shorten-only')).toBeInTheDocument();
  });

  it('leaves the expiration of a LiteLLM key as it was', async () => {
    const user = userEvent.setup();
    mockKeys({ ...litellmKey, expiresAt: inDays(45) } as ApiKey);
    render(<ApiKeysPage />);
    const dialog = await openEditModal(user, 'Legacy key');

    const select = dialog.querySelector('#key-expiration') as HTMLSelectElement;
    for (const value of ['never', '30', '60', '90', '180', '365', 'custom']) {
      expect(optionOf(select, value).disabled).toBe(false);
    }
    expect(within(dialog).queryByTestId('maas-expiry-shorten-only')).not.toBeInTheDocument();
    expect(select).not.toHaveAttribute('aria-describedby');
  });

  it('does not resend an expiration that was not touched', async () => {
    const user = userEvent.setup();
    mockKeys(expiringIn(45));
    render(<ApiKeysPage />);
    const dialog = await openEditModal(user, 'Expiring gateway key');

    await clickUpdate(user, dialog);

    await waitFor(() => expect(apiKeysService.updateApiKey).toHaveBeenCalledTimes(1));
    expect(lastUpdate().updates).not.toHaveProperty('expiresAt');
  });

  it('rejects a custom date after the current expiry without calling the API', async () => {
    const user = userEvent.setup();
    const key = expiringIn(45);
    mockKeys(key);
    render(<ApiKeysPage />);
    const dialog = await openEditModal(user, 'Expiring gateway key');

    const dateInput = dialog.querySelector('input[placeholder="YYYY-MM-DD"]') as HTMLInputElement;
    // The current expiry is pre-filled
    expect(dateInput.value).toBe(utcDay(key.expiresAt!));
    fireEvent.change(dateInput, { target: { value: utcDay(inDays(60)) } });
    await clickUpdate(user, dialog);

    await waitFor(() => expect(dialog.querySelector('#key-expiration-error')).not.toBeNull());
    expect(dialog.querySelector('#key-expiration-error')).toHaveTextContent(
      `The new expiration cannot be later than the current one (${utcDay(key.expiresAt!)}).`,
    );
    expect(apiKeysService.updateApiKey).not.toHaveBeenCalled();
  });

  it('flags a later date right in the date picker', async () => {
    const user = userEvent.setup();
    const key = expiringIn(45);
    mockKeys(key);
    render(<ApiKeysPage />);
    const dialog = await openEditModal(user, 'Expiring gateway key');

    const dateInput = dialog.querySelector('input[placeholder="YYYY-MM-DD"]') as HTMLInputElement;
    fireEvent.change(dateInput, { target: { value: utcDay(inDays(60)) } });
    fireEvent.blur(dateInput);

    expect(
      await within(dialog).findByText(/The new expiration cannot be later than the current one/),
    ).toBeInTheDocument();
  });

  it('sends a shorter custom date', async () => {
    const user = userEvent.setup();
    mockKeys(expiringIn(45));
    render(<ApiKeysPage />);
    const dialog = await openEditModal(user, 'Expiring gateway key');

    const shorter = utcDay(inDays(10));
    const dateInput = dialog.querySelector('input[placeholder="YYYY-MM-DD"]') as HTMLInputElement;
    fireEvent.change(dateInput, { target: { value: shorter } });
    await clickUpdate(user, dialog);

    await waitFor(() => expect(apiKeysService.updateApiKey).toHaveBeenCalledTimes(1));
    expect(lastUpdate().updates.expiresAt).toBe(new Date(shorter).toISOString());
  });

  it('sends a preset that ends before the current expiry', async () => {
    const user = userEvent.setup();
    mockKeys(expiringIn(45));
    render(<ApiKeysPage />);
    const dialog = await openEditModal(user, 'Expiring gateway key');

    await user.selectOptions(dialog.querySelector('#key-expiration') as HTMLSelectElement, '30');
    await clickUpdate(user, dialog);

    await waitFor(() => expect(apiKeysService.updateApiKey).toHaveBeenCalledTimes(1));
    const sent = new Date(lastUpdate().updates.expiresAt as string).getTime();
    expect(Math.abs(sent - (Date.now() + 30 * 86400000))).toBeLessThan(60_000);
  });
});
