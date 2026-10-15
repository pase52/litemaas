import type { FastifyInstance } from 'fastify';
import type { LiteLLMService } from '../litellm.service.js';
import type { LiteLLMDayData } from '../../types/admin-usage.types.js';
import type { LiteLLMKeyGenerationRequest } from '../../types/api-key.types.js';
import type {
  BackendHealth,
  BackendKeyResult,
  BackendModelInfo,
  BackendProvider,
  CreateBackendKeyRequest,
  KeyBackendProvider,
  ModelBackendProvider,
  UpdateBackendKeyRequest,
  UsageSource,
} from './backend.types.js';

/** LiteLLM model catalog: thin wrapper around LiteLLMService */
export class LiteLLMModelBackend implements ModelBackendProvider {
  readonly type = 'litellm' as const;
  constructor(private readonly litellm: LiteLLMService) {}

  private toInfo(
    m: Awaited<ReturnType<LiteLLMService['getModelById']>> & object,
  ): BackendModelInfo {
    return {
      id: m.model_info?.id ?? m.model_name,
      name: m.model_name,
      backendModelName: m.model_name,
      endpoint: m.litellm_params?.api_base,
      available: true,
      raw: m,
    };
  }

  async listModels(options: { refresh?: boolean } = {}): Promise<BackendModelInfo[]> {
    const models = await this.litellm.getModels({ refresh: options.refresh });
    return models.map((m) => this.toInfo(m));
  }

  async getModel(id: string): Promise<BackendModelInfo | null> {
    const m = await this.litellm.getModelById(id);
    return m ? this.toInfo(m) : null;
  }

  async checkHealth(): Promise<BackendHealth> {
    const health = await this.litellm.getHealth();
    return {
      status: health.status === 'unhealthy' ? 'unhealthy' : 'healthy',
      details: { db: health.db },
    };
  }
}

/** LiteLLM key lifecycle: delegates to LiteLLMService generate/update/delete */
export class LiteLLMKeyBackend implements KeyBackendProvider {
  readonly type = 'litellm' as const;
  constructor(private readonly litellm: LiteLLMService) {}

  async createKey(request: CreateBackendKeyRequest): Promise<BackendKeyResult> {
    const body: LiteLLMKeyGenerationRequest = {
      key_alias: request.name,
      user_id: request.userId,
      models: request.modelIds,
      tpm_limit: request.tpmLimit ?? undefined,
      model_tpm_limit: request.modelTpmLimits,
      ...(request.providerOptions as Partial<LiteLLMKeyGenerationRequest>),
    };
    const res = await this.litellm.generateApiKey(body);
    return {
      key: res.key,
      backendKeyId: res.key,
      expiresAt: res.expires ? new Date(res.expires) : null,
      providerData: { key_name: res.key_name },
    };
  }

  async updateKey(ref: string, request: UpdateBackendKeyRequest): Promise<void> {
    const updates: Partial<LiteLLMKeyGenerationRequest> = {
      ...(request.modelIds ? { models: request.modelIds } : {}),
      ...(request.tpmLimit !== undefined ? { tpm_limit: request.tpmLimit ?? undefined } : {}),
      ...(request.modelTpmLimits ? { model_tpm_limit: request.modelTpmLimits } : {}),
      ...(request.providerOptions as Partial<LiteLLMKeyGenerationRequest>),
    };
    await this.litellm.updateKey(ref, updates);
  }

  async revokeKey(ref: string): Promise<void> {
    await this.litellm.deleteKey(ref);
  }
}

/** LiteLLM usage: /user/daily/activity for a single day (all users) */
export class LiteLLMUsageBackend implements UsageSource {
  readonly type = 'litellm' as const;
  constructor(private readonly litellm: LiteLLMService) {}

  async getDayData(date: string): Promise<LiteLLMDayData | null> {
    const response = await this.litellm.getDailyActivity(undefined, date, date);
    const daily = response.daily_metrics?.[0];
    const dayData: LiteLLMDayData = {
      date,
      metrics: {
        api_requests: response.api_requests || 0,
        total_tokens: response.total_tokens || 0,
        prompt_tokens: response.prompt_tokens || 0,
        completion_tokens: response.completion_tokens || 0,
        spend: response.spend || 0,
        successful_requests: 0,
        failed_requests: 0,
      },
      breakdown: { models: {}, api_keys: {}, providers: {} },
    };
    if (daily?.breakdown?.models) {
      for (const [name, m] of Object.entries<any>(daily.breakdown.models)) {
        dayData.breakdown.models[name] = {
          metrics: {
            api_requests: m.metrics?.api_requests || 0,
            total_tokens: m.metrics?.total_tokens || 0,
            prompt_tokens: m.metrics?.prompt_tokens || 0,
            completion_tokens: m.metrics?.completion_tokens || 0,
            spend: m.metrics?.spend || 0,
          },
          api_keys: m.api_key_breakdown || {},
        };
      }
    }
    return dayData.metrics.api_requests > 0 ? dayData : null;
  }
}

export function createLiteLLMBackend(
  _fastify: FastifyInstance,
  litellm: LiteLLMService,
): BackendProvider {
  return {
    type: 'litellm',
    models: new LiteLLMModelBackend(litellm),
    keys: new LiteLLMKeyBackend(litellm),
    usage: new LiteLLMUsageBackend(litellm),
  };
}
