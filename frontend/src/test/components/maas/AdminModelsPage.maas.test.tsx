import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithAuth, mockAdminUser } from '../../test-utils';
import AdminModelsPage from '../../../pages/AdminModelsPage';
import { adminModelsService } from '../../../services/adminModels.service';

let mockMaasEnabled = true;
vi.mock('../../../hooks/useMaasEnabled', () => ({
  useMaasEnabled: () => ({ maasEnabled: mockMaasEnabled }),
}));

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, opts?: unknown) =>
        typeof opts === 'string'
          ? opts
          : ((opts as { defaultValue?: string } | undefined)?.defaultValue ?? key),
    }),
  };
});

vi.mock('../../../services/models.service', () => ({
  modelsService: {
    getModels: vi.fn(),
    refreshModels: vi.fn(() => Promise.resolve()),
  },
}));

vi.mock('../../../services/adminModels.service', () => ({
  adminModelsService: {
    createModel: vi.fn(),
    updateModel: vi.fn(() => Promise.resolve({ success: true, message: 'Updated' })),
    deleteModel: vi.fn(),
    syncMaasModels: vi.fn(() => Promise.resolve({ success: true, totalRefs: 1, errors: [] })),
    getMaasRefs: vi.fn(),
    migrateToMaas: vi.fn(() =>
      Promise.resolve({
        oldModelId: 'gpt-4',
        newModelId: 'ns/x',
        created: true,
        subscriptionsCopied: 2,
        pendingRequestsCopied: 0,
        pendingRequestsClosed: 0,
        usersToNotify: 2,
        policiesScheduled: 2,
        graceUntil: '2030-01-01',
      }),
    ),
  },
}));

const mockUseQuery = vi.fn();
const mockUseMutation = vi.fn();
vi.mock('react-query', async () => {
  const actual = await vi.importActual('react-query');
  return {
    ...actual,
    useQuery: (...args: unknown[]) => mockUseQuery(...args),
    useMutation: (...args: unknown[]) => mockUseMutation(...args),
    useQueryClient: () => ({ refetchQueries: vi.fn() }),
  };
});

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

const maasModel = {
  id: 'maas-demo/llama-3',
  name: 'Llama 3',
  provider: 'maas',
  description: 'MaaS model',
  backendModelName: 'llama-3',
  maxTokens: 8192,
  backendType: 'maas',
  maasEndpoint: 'https://maas.example.com/llama-3',
  supportsChat: true,
};

const refs = [
  { id: 'a/imported', name: 'imported', namespace: 'a', phase: 'Ready', imported: true },
  {
    id: 'maas-demo/new-ref',
    name: 'new-ref',
    namespace: 'maas-demo',
    phase: 'Ready',
    imported: false,
  },
];

describe('AdminModelsPage with the MaaS backend', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMaasEnabled = true;
    mockUseQuery.mockImplementation((key: unknown[]) => {
      if (Array.isArray(key) && key[0] === 'admin-maas-refs') {
        return { data: refs, isLoading: false, error: null };
      }
      return { data: { models: [litellmModel, maasModel] }, isLoading: false, error: null };
    });
    // Run mutation functions directly so service calls can be asserted
    mockUseMutation.mockImplementation((fn: (v: unknown) => unknown) => ({
      mutate: (v: unknown) => fn(v),
      isLoading: false,
    }));
  });

  it('shows the sync button and calls the sync endpoint', async () => {
    const user = userEvent.setup();
    renderWithAuth(<AdminModelsPage />, { user: mockAdminUser });

    await user.click(screen.getByRole('button', { name: 'Sync MaaS models' }));
    expect(adminModelsService.syncMaasModels).toHaveBeenCalledWith(false);
  });

  it('offers "sync and restore removed models" from the sync options menu', async () => {
    const user = userEvent.setup();
    renderWithAuth(<AdminModelsPage />, { user: mockAdminUser });

    await user.click(screen.getByRole('button', { name: 'More MaaS sync options' }));
    await user.click(await screen.findByText('Sync and restore removed models'));
    expect(adminModelsService.syncMaasModels).toHaveBeenCalledWith(true);
  });

  it('shows a backend column with a label per model', () => {
    renderWithAuth(<AdminModelsPage />, { user: mockAdminUser });
    expect(screen.getByRole('columnheader', { name: 'Backend' })).toBeInTheDocument();
    expect(screen.getByTestId('backend-badge-maas')).toBeInTheDocument();
    expect(screen.getByTestId('backend-badge-litellm')).toBeInTheDocument();
    expect(screen.getByText('https://maas.example.com/llama-3')).toBeInTheDocument();
  });

  it('hides LiteLLM-only fields when editing a MaaS model', async () => {
    const user = userEvent.setup();
    renderWithAuth(<AdminModelsPage />, { user: mockAdminUser });

    await user.click(screen.getByText('Llama 3'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('maas-managed-alert')).toBeInTheDocument();
    expect(dialog.querySelector('#api-base')).toBeNull();
    expect(dialog.querySelector('#api-key')).toBeNull();
    expect(dialog.querySelector('#rpm')).toBeNull();
    expect(dialog.querySelector('#tpm')).toBeNull();
    expect(within(dialog).queryByText('models.admin.testConfiguration')).not.toBeInTheDocument();
    // Metadata stays editable
    expect(dialog.querySelector('#model-name')).not.toBeNull();
    expect(dialog.querySelector('#description')).not.toBeNull();
  });

  it('sends only metadata when saving a MaaS model', async () => {
    const user = userEvent.setup();
    renderWithAuth(<AdminModelsPage />, { user: mockAdminUser });

    await user.click(screen.getByText('Llama 3'));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'common.update' }));

    await waitFor(() => expect(adminModelsService.updateModel).toHaveBeenCalledTimes(1));
    const [id, payload] = vi.mocked(adminModelsService.updateModel).mock.calls[0];
    expect(id).toBe('maas-demo/llama-3');
    expect(payload).not.toHaveProperty('api_base');
    expect(payload).not.toHaveProperty('api_key');
    expect(payload).not.toHaveProperty('tpm');
    expect(payload).not.toHaveProperty('rpm');
    expect(payload.model_name).toBe('Llama 3');
  });

  it('keeps the LiteLLM edit form unchanged', async () => {
    const user = userEvent.setup();
    renderWithAuth(<AdminModelsPage />, { user: mockAdminUser });

    await user.click(screen.getByText('GPT-4'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByTestId('maas-managed-alert')).not.toBeInTheDocument();
    expect(dialog.querySelector('#api-base')).not.toBeNull();
    expect(dialog.querySelector('#api-key')).not.toBeNull();
  });

  it('migrates a LiteLLM model to a MaaS model reference', async () => {
    const user = userEvent.setup();
    renderWithAuth(<AdminModelsPage />, { user: mockAdminUser });

    const row = screen.getByText('GPT-4').closest('tr') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: /kebab|actions/i }));
    await user.click(await screen.findByText('Migrate to MaaS'));

    const dialog = await screen.findByRole('dialog');
    const select = dialog.querySelector('#migrate-ref') as HTMLSelectElement;
    // Already imported references stay selectable (startup sync imports every ref)
    expect(within(select).getByText(/a\/imported/)).toBeInTheDocument();
    await user.selectOptions(select, 'maas-demo/new-ref');
    await user.click(within(dialog).getByRole('button', { name: 'Migrate' }));

    await waitFor(() => expect(adminModelsService.migrateToMaas).toHaveBeenCalledTimes(1));
    expect(adminModelsService.migrateToMaas).toHaveBeenCalledWith('gpt-4', {
      maasModelRef: { name: 'new-ref', namespace: 'maas-demo' },
      graceDays: 14,
    });
  });

  it('shows no MaaS UI when MaaS is disabled and no MaaS models exist', () => {
    mockMaasEnabled = false;
    mockUseQuery.mockImplementation(() => ({
      data: { models: [litellmModel] },
      isLoading: false,
      error: null,
    }));
    renderWithAuth(<AdminModelsPage />, { user: mockAdminUser });

    expect(screen.queryByRole('button', { name: 'Sync MaaS models' })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Backend' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('backend-badge-litellm')).not.toBeInTheDocument();
  });
});
