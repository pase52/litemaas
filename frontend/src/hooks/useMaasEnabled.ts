import { useConfig } from '../contexts/ConfigContext';

/**
 * Whether the RHOAI MaaS backend is enabled on the server.
 * When false, the UI behaves exactly as a LiteLLM-only deployment.
 */
export function useMaasEnabled(): { maasEnabled: boolean; maasGatewayUrl?: string } {
  const { config } = useConfig();
  return {
    maasEnabled: config?.maasEnabled === true,
    maasGatewayUrl: config?.maasGatewayUrl,
  };
}
