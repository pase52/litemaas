import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ChatbotPage from '../../../pages/ChatbotPage';
import { renderWithAuth, mockUser } from '../../test-utils';
import { apiKeysService } from '../../../services/apiKeys.service';
import { modelsService } from '../../../services/models.service';
import { chatService } from '../../../services/chat.service';
import { configService } from '../../../services/config.service';

vi.mock('../../../services/apiKeys.service', () => ({
  apiKeysService: { getApiKeys: vi.fn(), retrieveFullKey: vi.fn() },
}));
vi.mock('../../../services/models.service', () => ({
  modelsService: { getModels: vi.fn() },
}));
vi.mock('../../../services/chat.service', () => ({
  chatService: {
    sendMessage: vi.fn(),
    sendStreamingMessage: vi.fn(),
    createMessage: vi.fn((role: string, content: string) => ({
      id: `m-${role}`,
      role,
      content,
      timestamp: new Date(),
    })),
  },
}));
vi.mock('../../../services/config.service', () => ({
  configService: { getConfig: vi.fn() },
}));

vi.mock('@patternfly/chatbot/dist/dynamic/Chatbot', () => ({
  default: ({ children }: any) => <div data-testid="chatbot">{children}</div>,
  ChatbotDisplayMode: {},
}));
vi.mock('@patternfly/chatbot/dist/dynamic/ChatbotContent', () => ({
  default: ({ children }: any) => <div>{children}</div>,
}));
vi.mock('@patternfly/chatbot/dist/dynamic/ChatbotFooter', () => ({
  default: ({ children }: any) => <div>{children}</div>,
}));
vi.mock('@patternfly/chatbot/dist/dynamic/ChatbotHeader', () => ({
  default: ({ children }: any) => <div>{children}</div>,
  ChatbotHeaderActions: ({ children }: any) => <div>{children}</div>,
  ChatbotHeaderMain: ({ children }: any) => <div>{children}</div>,
  ChatbotHeaderTitle: ({ children }: any) => <div>{children}</div>,
}));
vi.mock('@patternfly/chatbot/dist/dynamic/ChatbotWelcomePrompt', () => ({
  default: ({ children }: any) => <div>{children}</div>,
}));
vi.mock('@patternfly/chatbot/dist/dynamic/Message', () => ({
  default: ({ children }: any) => <div>{children}</div>,
}));
vi.mock('@patternfly/chatbot/dist/dynamic/MessageBar', () => ({
  default: ({ onSendMessage, isDisabled }: any) => (
    <button data-testid="send" disabled={isDisabled} onClick={() => onSendMessage('hello')}>
      send
    </button>
  ),
}));
vi.mock('@patternfly/chatbot/dist/dynamic/MessageBox', () => ({
  default: ({ children }: any) => <div>{children}</div>,
}));

const baseKey = {
  status: 'active' as const,
  permissions: [],
  usageCount: 0,
  rateLimit: 100,
  createdAt: '2025-01-01T00:00:00Z',
};

const models = [
  {
    id: 'gpt-4',
    name: 'GPT-4',
    provider: 'openai',
    description: '',
    category: 'Language Model',
    contextLength: 8000,
    pricing: { input: 0, output: 0 },
    features: [],
    availability: 'available' as const,
    version: '4',
    backendType: 'litellm' as const,
    supportsChat: true,
  },
  {
    id: 'maas-demo/llama-3',
    name: 'Llama 3',
    provider: 'maas',
    description: '',
    category: 'Language Model',
    contextLength: 8000,
    pricing: { input: 0, output: 0 },
    features: [],
    availability: 'available' as const,
    version: '3',
    backendType: 'maas' as const,
    backendModelName: 'llama-3-served',
    supportsChat: true,
  },
];

const setup = async (key: Record<string, unknown>) => {
  vi.mocked(apiKeysService.getApiKeys).mockResolvedValue({
    data: [{ ...baseKey, ...key }] as never,
    pagination: { page: 1, limit: 100, total: 1, totalPages: 1 },
  });
  const user = userEvent.setup();
  renderWithAuth(<ChatbotPage />, { user: mockUser });
  const send = await screen.findByTestId('send');
  await waitFor(() => expect(send).not.toBeDisabled());
  await user.click(screen.getByTestId('send'));
};

describe('ChatbotPage with the MaaS backend', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(modelsService.getModels).mockResolvedValue({
      models,
      pagination: { page: 1, limit: 100, total: 2, totalPages: 1 },
    } as never);
    vi.mocked(configService.getConfig).mockResolvedValue({} as never);
    vi.mocked(apiKeysService.retrieveFullKey).mockResolvedValue({
      key: 'sk-secret',
      keyType: 'x',
      retrievedAt: new Date().toISOString(),
    });
    vi.mocked(chatService.sendStreamingMessage).mockResolvedValue(undefined);
  });

  it('uses the MaaS key base URL and the served model name', async () => {
    await setup({
      id: 'k1',
      name: 'MaaS key',
      keyPreview: 'sk-oai',
      models: ['maas-demo/llama-3'],
      backendType: 'maas',
      baseUrl: 'https://maas.example.com/maas',
    });

    await waitFor(() => expect(chatService.sendStreamingMessage).toHaveBeenCalled());
    const [url, key, request] = vi.mocked(chatService.sendStreamingMessage).mock.calls[0];
    expect(url).toBe('https://maas.example.com/maas');
    expect(key).toBe('sk-secret');
    expect(request.model).toBe('llama-3-served');
  });

  it('keeps using the LiteLLM URL and model id for LiteLLM keys', async () => {
    await setup({
      id: 'k2',
      name: 'LiteLLM key',
      keyPreview: 'sk-lit',
      models: ['gpt-4'],
      backendType: 'litellm',
    });

    await waitFor(() => expect(chatService.sendStreamingMessage).toHaveBeenCalled());
    const [url, , request] = vi.mocked(chatService.sendStreamingMessage).mock.calls[0];
    // falls back to the LiteLLM URL, never the MaaS gateway
    expect(url).toMatch(/^https:\/\//);
    expect(url).not.toContain('maas.example.com');
    expect(request.model).toBe('gpt-4');
  });

  it('prefers the MaaS model endpoint over the key base URL', async () => {
    vi.mocked(modelsService.getModels).mockResolvedValue({
      models: [
        models[0],
        { ...models[1], maasEndpoint: 'https://maas.example.com/maas-demo/llama-3/v1' },
      ],
      pagination: { page: 1, limit: 100, total: 2, totalPages: 1 },
    } as never);
    await setup({
      id: 'k3',
      name: 'MaaS key',
      keyPreview: 'sk-oai',
      models: ['maas-demo/llama-3'],
      backendType: 'maas',
      baseUrl: 'https://maas.example.com/maas',
    });

    await waitFor(() => expect(chatService.sendStreamingMessage).toHaveBeenCalled());
    expect(vi.mocked(chatService.sendStreamingMessage).mock.calls[0][0]).toBe(
      'https://maas.example.com/maas-demo/llama-3',
    );
  });
});
