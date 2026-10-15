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

/** UTC calendar day (YYYY-MM-DD) of a date, timestamp or ISO string. */
export const toUtcDay = (value: string | number | Date): string =>
  new Date(value).toISOString().split('T')[0];

/**
 * Calendar day (YYYY-MM-DD) a date-picker date refers to. PatternFly's DatePicker parses a typed
 * or picked day as local midnight, so the local components are the ones the user chose.
 */
export const toLocalDay = (date: Date): string => {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

/**
 * maas-api cannot extend a key, so the expiration of a MaaS key can only be shortened. The backend
 * compares expirations by UTC calendar day: a later day is rejected, the same day is a no-op.
 * Returns true when `candidateDay` (YYYY-MM-DD) falls after the key's current expiry. A key that
 * never expires accepts any day, and a value that is not a complete YYYY-MM-DD day is not judged
 * here (the form's own date validation reports it).
 */
export const isAfterMaasExpiry = (
  candidateDay: string,
  currentExpiresAt?: string | null,
): boolean =>
  !!currentExpiresAt &&
  /^\d{4}-\d{2}-\d{2}$/.test(candidateDay) &&
  candidateDay > toUtcDay(currentExpiresAt);

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
