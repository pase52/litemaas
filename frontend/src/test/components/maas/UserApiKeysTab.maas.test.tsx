import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import UserApiKeysTab from '../../../components/admin/UserApiKeysTab';
import { usersService } from '../../../services/users.service';
import { modelsService } from '../../../services/models.service';
import { renderWithAuth, mockAdminUser } from '../../test-utils';

vi.mock('../../../contexts/ConfigContext', () => ({
  useConfig: () => ({
    config: { version: '1.0.0-test', usageCacheTTL: 300, environment: 'test' },
    isLoading: false,
    error: null,
  }),
  useCurrency: () => ({
    currencyCode: 'USD',
    currencySymbol: '$',
    currencyName: 'US Dollar',
    formatCurrency: (amount: number) => `$${amount.toFixed(2)}`,
  }),
  ConfigProvider: ({ children }: any) => children,
}));

vi.mock('../../../services/users.service', () => ({
  usersService: {
    getUserApiKeys: vi.fn(),
    revokeUserApiKey: vi.fn(),
    createApiKeyForUser: vi.fn(),
    updateApiKeyForUser: vi.fn(),
  },
}));

vi.mock('../../../services/models.service', () => ({
  modelsService: { getModels: vi.fn() },
}));

const mockUsers = usersService as any;
const mockModels = modelsService as any;

const keysResponse = {
  data: [
    {
      id: 'maas-key',
      name: 'Gateway Key',
      keyPrefix: 'sk-oai',
      models: ['ns/llama'],
      modelDetails: [{ id: 'ns/llama', name: 'Llama MaaS', provider: 'maas' }],
      isActive: true,
      backendType: 'maas',
      tpmLimit: 4000,
      createdAt: '2024-01-01T00:00:00Z',
    },
  ],
  pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
};

const modelsResponse = {
  models: [
    { id: 'gpt-4', name: 'GPT-4', backendType: 'litellm' },
    { id: 'ns/llama', name: 'Llama MaaS', backendType: 'maas' },
  ],
  pagination: { page: 1, limit: 100, total: 2, totalPages: 1 },
};

describe('UserApiKeysTab with MaaS keys', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUsers.getUserApiKeys.mockResolvedValue(keysResponse);
    mockModels.getModels.mockResolvedValue(modelsResponse);
    mockUsers.updateApiKeyForUser.mockResolvedValue({});
  });

  it('does not offer MaaS models when creating a key for a user', async () => {
    const user = userEvent.setup();
    renderWithAuth(<UserApiKeysTab userId="u1" canEdit={true} />, { user: mockAdminUser });

    await screen.findByText('Gateway Key');
    await user.click(screen.getByRole('button', { name: /create api key/i }));
    const dialog = await screen.findByRole('dialog');

    await waitFor(() => expect(within(dialog).getByText('GPT-4')).toBeInTheDocument());
    expect(within(dialog).queryByText('Llama MaaS')).not.toBeInTheDocument();
  });

  it('shows the MaaS badge in the key list', async () => {
    renderWithAuth(<UserApiKeysTab userId="u1" canEdit={true} />, { user: mockAdminUser });
    await screen.findByText('Gateway Key');
    expect(screen.getByTestId('backend-badge-maas')).toBeInTheDocument();
  });

  it('edits a MaaS key with TPM-only fields', async () => {
    const user = userEvent.setup();
    renderWithAuth(<UserApiKeysTab userId="u1" canEdit={true} />, { user: mockAdminUser });

    const row = (await screen.findByText('Gateway Key')).closest('tr') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: /kebab|actions/i }));
    await user.click(await screen.findByText('Edit'));
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByTestId('maas-tpm-only-notice')).toBeInTheDocument();
    expect(dialog.querySelector('#edit-key-tpm')).not.toBeNull();
    expect(dialog.querySelector('#edit-key-budget')).toBeNull();
    expect(dialog.querySelector('#edit-key-rpm')).toBeNull();
    expect(dialog.querySelector('#edit-key-max-parallel')).toBeNull();
    // Only MaaS models can be selected for a MaaS key
    await waitFor(() =>
      expect(within(dialog).getAllByText('Llama MaaS').length).toBeGreaterThan(0),
    );
    expect(within(dialog).queryByText('GPT-4')).not.toBeInTheDocument();
  });
});
