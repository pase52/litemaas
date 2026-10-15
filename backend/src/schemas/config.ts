import { Type, Static } from '@sinclair/typebox';

/**
 * Public configuration response schema
 * This endpoint provides frontend-facing configuration values that are safe to expose publicly
 */
export const ConfigResponseSchema = Type.Object(
  {
    version: Type.String({
      description: 'Application version from package.json',
      examples: ['0.0.19', '1.0.0'],
    }),
    usageCacheTtlMinutes: Type.Number({
      description: 'Time-to-live for current day usage cache in minutes',
      minimum: 1,
      examples: [5, 10, 15],
    }),
    environment: Type.Union([Type.Literal('development'), Type.Literal('production')], {
      description: 'Current runtime environment',
    }),
    currency: Type.Optional(
      Type.Object(
        {
          code: Type.String(),
          symbol: Type.String(),
          name: Type.String(),
        },
        { description: 'Configured currency for monetary value display' },
      ),
    ),
    // Legacy fields for backwards compatibility
    litellmApiUrl: Type.Optional(
      Type.String({
        description: 'LiteLLM API base URL (legacy field)',
      }),
    ),
    maasEnabled: Type.Optional(
      Type.Boolean({ description: 'Whether the RHOAI MaaS backend is enabled' }),
    ),
    maasGatewayUrl: Type.Optional(
      Type.String({ description: 'Base URL of the MaaS inference gateway (when MaaS is enabled)' }),
    ),
    authMode: Type.Optional(
      Type.Union([Type.Literal('oauth'), Type.Literal('mock')], {
        description: 'Authentication mode (legacy field)',
      }),
    ),
  },
  {
    $id: 'ConfigResponse',
    title: 'Configuration Response',
    description: 'Public configuration values',
  },
);

export type ConfigResponse = Static<typeof ConfigResponseSchema>;
