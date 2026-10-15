export type ModelBackendType = 'litellm' | 'maas';

/** True when the model is served through RHOAI MaaS rather than LiteLLM. */
export const isMaasModel = (model?: { backendType?: ModelBackendType | string } | null): boolean =>
  model?.backendType === 'maas';

/**
 * Name to send as the `model` field of OpenAI-compatible requests.
 * LiteLLM models use their id; MaaS models use the served name
 * (backend model name, falling back to the MaaSModelRef name taken from the "<ns>/<name>" id).
 */
export const getServedModelName = (model: {
  id: string;
  backendType?: ModelBackendType | string;
  backendModelName?: string;
}): string => {
  if (model.backendType !== 'maas') return model.id;
  if (model.backendModelName) return model.backendModelName;
  const slash = model.id.indexOf('/');
  return slash >= 0 ? model.id.slice(slash + 1) : model.id;
};

/** Whether a migration grace period is still running for the model. */
export const getMigrationGraceUntil = (model?: {
  migrationState?: string | null;
  migrationGraceUntil?: string | null;
}): Date | null => {
  if (!model?.migrationGraceUntil) return null;
  const d = new Date(model.migrationGraceUntil);
  return isNaN(d.getTime()) ? null : d;
};

/** Error code returned by the backend when the user must log in again to use MaaS. */
export const MAAS_REAUTH_REQUIRED = 'MAAS_REAUTH_REQUIRED';

/** Detects the MAAS_REAUTH_REQUIRED error (HTTP 403 or 401) from an axios or wrapped error. */
export const isMaasReauthError = (err: unknown): boolean => {
  const e = err as any;
  const code =
    e?.response?.data?.error?.code ??
    e?.response?.data?.code ??
    e?.enhancedDetails?.error ??
    e?.enhancedDetails?.details?.code ??
    e?.code;
  return code === MAAS_REAUTH_REQUIRED;
};

/**
 * Base URL (without a trailing "/v1") for OpenAI-compatible calls with a given key and model.
 * MaaS models expose their own route (MaaSModelRef status endpoint) which takes precedence over
 * the key-level gateway URL; LiteLLM models always use the key / LiteLLM URL.
 */
export const getModelBaseUrl = (
  model: { backendType?: ModelBackendType | string; maasEndpoint?: string } | undefined,
  keyBaseUrl: string | undefined,
  fallbackUrl: string,
): string => {
  const raw =
    model?.backendType === 'maas' && model.maasEndpoint
      ? model.maasEndpoint
      : keyBaseUrl || fallbackUrl;
  return raw.replace(/\/+$/, '').replace(/\/v1$/, '');
};
