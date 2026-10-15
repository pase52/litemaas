import type { LiteLLMDayData } from '../../types/admin-usage.types.js';

/** Serving backend of a model / API key */
export type BackendType = 'litellm' | 'maas';

export const BACKEND_TYPES: readonly BackendType[] = ['litellm', 'maas'] as const;

export function isBackendType(value: unknown): value is BackendType {
  return value === 'litellm' || value === 'maas';
}

export interface BackendHealth {
  status: 'healthy' | 'unhealthy' | 'disabled';
  message?: string;
  details?: Record<string, unknown>;
}

/** Backend-neutral description of a model as reported by its backend */
export interface BackendModelInfo {
  /** LiteMaaS model id (litellm model id, or <namespace>/<maasmodelref> for MaaS) */
  id: string;
  name: string;
  /** Served model name to put in inference requests */
  backendModelName?: string;
  description?: string;
  endpoint?: string;
  available: boolean;
  /** Backend specific payload (LiteLLMModel, MaaSModelRef, ...) */
  raw?: unknown;
}

export interface ModelBackendProvider {
  readonly type: BackendType;
  listModels(options?: { refresh?: boolean }): Promise<BackendModelInfo[]>;
  getModel(id: string): Promise<BackendModelInfo | null>;
  checkHealth(): Promise<BackendHealth>;
}

export interface CreateBackendKeyRequest {
  /** LiteMaaS api_keys.id */
  keyId: string;
  userId: string;
  username: string;
  name: string;
  /** LiteMaaS model ids the key may call */
  modelIds: string[];
  expiresAt?: Date | null;
  /** Global tokens-per-minute limit */
  tpmLimit?: number | null;
  /** Per-model tokens-per-minute limits keyed by LiteMaaS model id */
  modelTpmLimits?: Record<string, number>;
  /** Backend specific passthrough (e.g. raw LiteLLMKeyGenerationRequest fields) */
  providerOptions?: Record<string, unknown>;
}

export interface BackendKeyResult {
  /** Plaintext key, only available at creation */
  key: string;
  /** Backend's own identifier for the key (LiteLLM token, maas-api key id) */
  backendKeyId: string;
  keyPrefix?: string;
  expiresAt?: Date | null;
  providerData?: Record<string, unknown>;
}

export interface UpdateBackendKeyRequest {
  expiresAt?: Date | null;
  tpmLimit?: number | null;
  modelIds?: string[];
  modelTpmLimits?: Record<string, number>;
  providerOptions?: Record<string, unknown>;
}

export interface KeyBackendProvider {
  readonly type: BackendType;
  createKey(request: CreateBackendKeyRequest): Promise<BackendKeyResult>;
  /** `ref` is the backend's key identifier (LiteLLM key value / token, MaaS key id) */
  updateKey(ref: string, request: UpdateBackendKeyRequest): Promise<void>;
  revokeKey(ref: string): Promise<void>;
}

export interface UsageSource {
  readonly type: BackendType;
  /**
   * Usage for a single UTC day (YYYY-MM-DD) in the LiteLLM daily-activity shape used by the
   * admin usage aggregation. Resolves null when the backend recorded no requests that day.
   */
  getDayData(date: string): Promise<LiteLLMDayData | null>;
}

/** Everything the platform needs from one backend */
export interface BackendProvider {
  readonly type: BackendType;
  readonly models: ModelBackendProvider;
  readonly keys: KeyBackendProvider;
  readonly usage: UsageSource;
}
