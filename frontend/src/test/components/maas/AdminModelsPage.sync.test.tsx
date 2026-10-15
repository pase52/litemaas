import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithAuth, mockAdminUser } from '../../test-utils';
import AdminModelsPage from '../../../pages/AdminModelsPage';
import { adminModelsService } from '../../../services/adminModels.service';
import { modelsService } from '../../../services/models.service';
import { useNotifications } from '../../../contexts/NotificationContext';

// These tests run the page with the real react-query client (no useQuery / useMutation stubs) so
// the query function arguments and the mutation callbacks are exercised end to end.

vi.mock('../../../hooks/useMaasEnabled', () => ({
  useMaasEnabled: () => ({ maasEnabled: true }),
}));

vi.mock('../../../services/models.service', () => ({
  modelsService: {
    getModels: vi.fn(),
    refreshModels: vi.fn(() => Promise.resolve()),
  },
}));

vi.mock('../../../services/adminModels.service', () => ({
  adminModelsService: {
    createModel: vi.fn(),
    updateModel: vi.fn(),
    deleteModel: vi.fn(),
    syncMaasModels: vi.fn(),
    getMaasRefs: vi.fn(() => Promise.resolve([])),
    migrateToMaas: vi.fn(),
  },
}));

const litellmModel = {
  id: 'gpt-4',
  name: 'GPT-4',
  provider: 'openai',
  description: 'LiteLLM model',
  apiBase: 'https://api.openai.com/v1',
  backendModelName: 'gpt-4',
  rpm: 500,
  tpm: 10000,
  maxTokens: 8192,
  backendType: 'litellm',
  supportsChat: true,
};

const syncResult = (overrides: Record<string, unknown> = {}) => ({
  success: true,
  totalRefs: 3,
  newModels: 2,
  updatedModels: 1,
  unavailableModels: 0,
  errors: [] as string[],
  syncedAt: '2030-01-01T00:00:00.000Z',
  ...overrides,
});

// Shows the notifications the page raises (the page-level toast group is not part of the page)
const NotificationProbe = () => {
  const { notifications } = useNotifications();
  return (
    <ul data-testid="raised-notifications">
      {notifications.map((n) => (
        <li key={n.id} data-variant={n.variant}>
          <span data-testid="notification-title">{n.title}</span>
          <span data-testid="notification-description">{n.description}</span>
        </li>
      ))}
    </ul>
  );
};

const renderPage = () =>
  renderWithAuth(
    <>
      <AdminModelsPage />
      <NotificationProbe />
    </>,
    { user: mockAdminUser },
  );

describe('AdminModelsPage model list', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(modelsService.getModels).mockResolvedValue({
      models: [litellmModel as never],
      pagination: { page: 1, limit: 1000, total: 1, totalPages: 1 },
    });
  });

  it('asks for the largest page the backend allows: the table has no pagination', async () => {
    renderPage();

    expect(await screen.findByText('GPT-4')).toBeInTheDocument();
    // Page 1 / limit 1000 (GET /models caps the limit at 1000); the default page of 20 would
    // hide, and make impossible to edit or migrate, every model after the 20th
    expect(modelsService.getModels).toHaveBeenCalledWith(1, 1000);
  });
});

describe('AdminModelsPage MaaS synchronization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(modelsService.getModels).mockResolvedValue({
      models: [litellmModel as never],
      pagination: { page: 1, limit: 1000, total: 1, totalPages: 1 },
    });
  });

  /** Clicks "Sync MaaS models" once the table is loaded; returns how often the list was fetched. */
  const clickSync = async (user: ReturnType<typeof userEvent.setup>) => {
    await screen.findByText('GPT-4');
    const fetchedBefore = vi.mocked(modelsService.getModels).mock.calls.length;
    await user.click(screen.getByRole('button', { name: 'Sync MaaS models' }));
    return fetchedBefore;
  };

  it('reports a failed synchronization (HTTP 200 with success:false) as an error', async () => {
    const user = userEvent.setup();
    vi.mocked(adminModelsService.syncMaasModels).mockResolvedValue(
      syncResult({
        success: false,
        totalRefs: 0,
        newModels: 0,
        updatedModels: 0,
        errors: [
          'Failed to list MaaSModelRefs: connect ECONNREFUSED',
          'Synchronization failed: db',
        ],
      }),
    );
    renderPage();
    await clickSync(user);

    await waitFor(() => expect(screen.getByTestId('notification-title')).toBeInTheDocument());
    const notification = screen.getByTestId('notification-title').closest('li') as HTMLElement;
    // Not the green "MaaS models synchronized" notification
    expect(notification).toHaveAttribute('data-variant', 'danger');
    expect(screen.getByTestId('notification-title')).toHaveTextContent(
      'MaaS synchronization failed',
    );
    expect(screen.getByTestId('notification-description')).toHaveTextContent(
      'Failed to list MaaSModelRefs: connect ECONNREFUSED; Synchronization failed: db',
    );
    expect(screen.queryByText('MaaS models synchronized')).not.toBeInTheDocument();
  });

  it('still refreshes the model table after a failed synchronization', async () => {
    const user = userEvent.setup();
    vi.mocked(adminModelsService.syncMaasModels).mockResolvedValue(
      // Some refs were imported before one of them failed
      syncResult({ success: false, newModels: 2, errors: ['Failed to sync a/b: boom'] }),
    );
    renderPage();
    const fetchedBefore = await clickSync(user);

    await waitFor(() =>
      expect(vi.mocked(modelsService.getModels).mock.calls.length).toBe(fetchedBefore + 1),
    );
    expect(modelsService.getModels).toHaveBeenLastCalledWith(1, 1000);
  });

  it('keeps the success notification when the synchronization succeeds', async () => {
    const user = userEvent.setup();
    vi.mocked(adminModelsService.syncMaasModels).mockResolvedValue(syncResult());
    renderPage();
    const fetchedBefore = await clickSync(user);

    await waitFor(() => expect(screen.getByTestId('notification-title')).toBeInTheDocument());
    expect(screen.getByTestId('notification-title')).toHaveTextContent('MaaS models synchronized');
    expect(screen.getByTestId('notification-title').closest('li')).toHaveAttribute(
      'data-variant',
      'success',
    );
    expect(screen.getByTestId('notification-description')).toHaveTextContent(
      '3 model references found: 2 new, 1 updated, 0 unavailable.',
    );
    await waitFor(() =>
      expect(vi.mocked(modelsService.getModels).mock.calls.length).toBe(fetchedBefore + 1),
    );
  });

  it('still reports a request that fails outright', async () => {
    const user = userEvent.setup();
    vi.mocked(adminModelsService.syncMaasModels).mockRejectedValue(new Error('Network down'));
    renderPage();
    await clickSync(user);

    await waitFor(() => expect(screen.getByTestId('notification-title')).toBeInTheDocument());
    expect(screen.getByTestId('notification-title').closest('li')).toHaveAttribute(
      'data-variant',
      'danger',
    );
    expect(screen.getByTestId('notification-title')).toHaveTextContent(
      'MaaS synchronization failed',
    );
    expect(screen.getByTestId('notification-description')).toHaveTextContent('Network down');
  });
});
