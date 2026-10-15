import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import UserApiKeysTab from '../../../components/admin/UserApiKeysTab';
import { usersService } from '../../../services/users.service';
import { modelsService } from '../../../services/models.service';
import { renderWithAuth, mockAdminUser } from '../../test-utils';
import { useNotifications } from '../../../contexts/NotificationContext';

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
    updateUserApiKey: vi.fn(),
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

const inDays = (days: number) => new Date(Date.now() + days * 86400000).toISOString();
const utcDay = (iso: string) => iso.split('T')[0];

const maasKeyExpiring = {
  ...keysResponse.data[0],
  id: 'maas-key-exp',
  name: 'Expiring Gateway Key',
  expiresAt: inDays(45),
};

const litellmKey = {
  id: 'litellm-key',
  name: 'Legacy Key',
  keyPrefix: 'sk-lit',
  models: ['gpt-4'],
  modelDetails: [{ id: 'gpt-4', name: 'GPT-4', provider: 'openai' }],
  isActive: true,
  backendType: 'litellm',
  maxBudget: 100,
  currentSpend: 25,
  expiresAt: inDays(45),
  createdAt: '2024-01-01T00:00:00Z',
};

const keysOf = (...data: unknown[]) => ({
  data,
  pagination: { page: 1, limit: 20, total: data.length, totalPages: 1 },
});

// Shows the notifications the tab raises (the page-level toast group is not part of the tab)
const NotificationProbe = () => {
  const { notifications } = useNotifications();
  return (
    <ul data-testid="raised-notifications">
      {notifications.map((n) => (
        <li key={n.id}>{`${n.title}: ${n.description}`}</li>
      ))}
    </ul>
  );
};

const openEditModal = async (user: ReturnType<typeof userEvent.setup>, keyName: string) => {
  const row = (await screen.findByText(keyName)).closest('tr') as HTMLElement;
  await user.click(within(row).getByRole('button', { name: /kebab|actions/i }));
  await user.click(await screen.findByText('Edit'));
  return screen.findByRole('dialog');
};

const optionOf = (select: HTMLElement, value: string) =>
  select.querySelector(`option[value="${value}"]`) as HTMLOptionElement;

describe('UserApiKeysTab with MaaS keys', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUsers.getUserApiKeys.mockResolvedValue(keysResponse);
    mockModels.getModels.mockResolvedValue(modelsResponse);
    mockUsers.updateApiKeyForUser.mockResolvedValue({});
    mockUsers.updateUserApiKey.mockResolvedValue({});
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
    // MaaS keys have no budget, so the "Current Spend / Unlimited" block is hidden too
    expect(dialog.querySelector('#edit-current-spend')).toBeNull();
    expect(within(dialog).queryByText('Current Spend')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('Unlimited')).not.toBeInTheDocument();
    // Only MaaS models can be selected for a MaaS key
    await waitFor(() =>
      expect(within(dialog).getAllByText('Llama MaaS').length).toBeGreaterThan(0),
    );
    expect(within(dialog).queryByText('GPT-4')).not.toBeInTheDocument();
  });

  it('saves a MaaS key edit without modelIds and without an untouched expiration', async () => {
    const user = userEvent.setup();
    renderWithAuth(<UserApiKeysTab userId="u1" canEdit={true} />, { user: mockAdminUser });

    const row = (await screen.findByText('Gateway Key')).closest('tr') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: /kebab|actions/i }));
    await user.click(await screen.findByText('Edit'));
    const dialog = await screen.findByRole('dialog');

    const tpm = dialog.querySelector('#edit-key-tpm') as HTMLInputElement;
    await user.clear(tpm);
    await user.type(tpm, '5000');
    await user.click(within(dialog).getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(mockUsers.updateUserApiKey).toHaveBeenCalled());
    const [userId, keyId, payload] = mockUsers.updateUserApiKey.mock.calls[0];
    expect(userId).toBe('u1');
    expect(keyId).toBe('maas-key');
    expect(payload).not.toHaveProperty('modelIds');
    expect(payload).not.toHaveProperty('expiresAt');
    expect(payload.tpmLimit).toBe(5000);
  });

  it('still shows the spend block when editing a LiteLLM key', async () => {
    const user = userEvent.setup();
    mockUsers.getUserApiKeys.mockResolvedValue(keysOf(litellmKey));
    renderWithAuth(<UserApiKeysTab userId="u1" canEdit={true} />, { user: mockAdminUser });

    const dialog = await openEditModal(user, 'Legacy Key');

    expect(within(dialog).getByText('Current Spend')).toBeInTheDocument();
    expect(within(dialog).getByText('$25.00 / $100.00')).toBeInTheDocument();
    expect(dialog.querySelector('#edit-key-budget')).not.toBeNull();
  });

  describe('expiration of a MaaS key', () => {
    it('only offers expirations that shorten a key that expires, and explains why', async () => {
      const user = userEvent.setup();
      mockUsers.getUserApiKeys.mockResolvedValue(keysOf(maasKeyExpiring));
      renderWithAuth(<UserApiKeysTab userId="u1" canEdit={true} />, { user: mockAdminUser });

      const dialog = await openEditModal(user, 'Expiring Gateway Key');

      const select = dialog.querySelector('#edit-key-expiration') as HTMLSelectElement;
      expect(optionOf(select, 'never').disabled).toBe(true);
      expect(optionOf(select, '30').disabled).toBe(false);
      for (const days of ['60', '90', '180', '365']) {
        expect(optionOf(select, days).disabled).toBe(true);
      }
      expect(optionOf(select, 'custom').disabled).toBe(false);
      expect(within(dialog).getByTestId('maas-expiry-shorten-only')).toHaveTextContent(
        'MaaS API keys can only have their expiration shortened.',
      );
      expect(select).toHaveAttribute('aria-describedby', 'edit-key-expiration-maas-help');
    });

    it('offers every expiration for a MaaS key that does not expire yet', async () => {
      const user = userEvent.setup();
      renderWithAuth(<UserApiKeysTab userId="u1" canEdit={true} />, { user: mockAdminUser });

      const dialog = await openEditModal(user, 'Gateway Key');

      const select = dialog.querySelector('#edit-key-expiration') as HTMLSelectElement;
      for (const value of ['never', '30', '60', '90', '180', '365', 'custom']) {
        expect(optionOf(select, value).disabled).toBe(false);
      }
      expect(within(dialog).getByTestId('maas-expiry-shorten-only')).toBeInTheDocument();
    });

    it('leaves the expiration of a LiteLLM key as it was', async () => {
      const user = userEvent.setup();
      mockUsers.getUserApiKeys.mockResolvedValue(keysOf(litellmKey));
      renderWithAuth(<UserApiKeysTab userId="u1" canEdit={true} />, { user: mockAdminUser });

      const dialog = await openEditModal(user, 'Legacy Key');

      const select = dialog.querySelector('#edit-key-expiration') as HTMLSelectElement;
      for (const value of ['never', '30', '60', '90', '180', '365', 'custom']) {
        expect(optionOf(select, value).disabled).toBe(false);
      }
      expect(within(dialog).queryByTestId('maas-expiry-shorten-only')).not.toBeInTheDocument();
      expect(select).not.toHaveAttribute('aria-describedby');
    });

    it('flags a date after the current expiry in the date picker', async () => {
      const user = userEvent.setup();
      mockUsers.getUserApiKeys.mockResolvedValue(keysOf(maasKeyExpiring));
      renderWithAuth(<UserApiKeysTab userId="u1" canEdit={true} />, { user: mockAdminUser });

      const dialog = await openEditModal(user, 'Expiring Gateway Key');
      const dateInput = dialog.querySelector('input[placeholder="YYYY-MM-DD"]') as HTMLInputElement;
      expect(dateInput.value).toBe(utcDay(maasKeyExpiring.expiresAt));
      fireEvent.change(dateInput, { target: { value: utcDay(inDays(60)) } });
      fireEvent.blur(dateInput);

      expect(
        await within(dialog).findByText(/The new expiration cannot be later than the current one/),
      ).toBeInTheDocument();
    });

    it('refuses to save a date after the current expiry', async () => {
      const user = userEvent.setup();
      mockUsers.getUserApiKeys.mockResolvedValue(keysOf(maasKeyExpiring));
      renderWithAuth(
        <>
          <UserApiKeysTab userId="u1" canEdit={true} />
          <NotificationProbe />
        </>,
        { user: mockAdminUser },
      );

      const dialog = await openEditModal(user, 'Expiring Gateway Key');
      const dateInput = dialog.querySelector('input[placeholder="YYYY-MM-DD"]') as HTMLInputElement;
      fireEvent.change(dateInput, { target: { value: utcDay(inDays(60)) } });
      await user.click(within(dialog).getByRole('button', { name: /save changes/i }));

      // (the open modal hides the rest of the page from the accessibility tree: query by test id)
      const raised = await screen.findByTestId('raised-notifications');
      await waitFor(() =>
        expect(raised).toHaveTextContent(
          `The new expiration cannot be later than the current one (${utcDay(maasKeyExpiring.expiresAt)}).`,
        ),
      );
      expect(mockUsers.updateUserApiKey).not.toHaveBeenCalled();
    });

    it('saves a shorter date', async () => {
      const user = userEvent.setup();
      mockUsers.getUserApiKeys.mockResolvedValue(keysOf(maasKeyExpiring));
      renderWithAuth(<UserApiKeysTab userId="u1" canEdit={true} />, { user: mockAdminUser });

      const dialog = await openEditModal(user, 'Expiring Gateway Key');
      const shorter = utcDay(inDays(10));
      const dateInput = dialog.querySelector('input[placeholder="YYYY-MM-DD"]') as HTMLInputElement;
      fireEvent.change(dateInput, { target: { value: shorter } });
      await user.click(within(dialog).getByRole('button', { name: /save changes/i }));

      await waitFor(() => expect(mockUsers.updateUserApiKey).toHaveBeenCalledTimes(1));
      const [, keyId, payload] = mockUsers.updateUserApiKey.mock.calls[0];
      expect(keyId).toBe('maas-key-exp');
      expect(payload.expiresAt).toBe(new Date(shorter).toISOString());
      expect(payload).not.toHaveProperty('modelIds');
    });

    it('does not resend an expiration that was not touched', async () => {
      const user = userEvent.setup();
      mockUsers.getUserApiKeys.mockResolvedValue(keysOf(maasKeyExpiring));
      renderWithAuth(<UserApiKeysTab userId="u1" canEdit={true} />, { user: mockAdminUser });

      const dialog = await openEditModal(user, 'Expiring Gateway Key');
      await user.click(within(dialog).getByRole('button', { name: /save changes/i }));

      await waitFor(() => expect(mockUsers.updateUserApiKey).toHaveBeenCalledTimes(1));
      expect(mockUsers.updateUserApiKey.mock.calls[0][2]).not.toHaveProperty('expiresAt');
    });
  });
});
