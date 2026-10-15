import { ApplicationError } from '../../utils/errors.js';
import type { MaasClients } from '../maas/maas-clients.js';
import { MAAS_MODEL_REF, parseModelRef } from '../maas/maas-resources.js';
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
import type { LiteLLMDayData } from '../../types/admin-usage.types.js';

function notImplemented(what: string): never {
  throw ApplicationError.internal(`MaaS ${what} is not implemented yet`);
}

/**
 * MaaS model catalog backed by MaaSModelRef objects. Listing is functional; key lifecycle and
 * usage are filled in by later phases (stubs throw).
 */
export class MaasModelBackend implements ModelBackendProvider {
  readonly type = 'maas' as const;
  constructor(private readonly clients: MaasClients) {}

  private async listRefs() {
    const { k8s, config } = this.clients;
    if (config.modelNamespaces.length === 0) return k8s.list(MAAS_MODEL_REF);
    const lists = await Promise.all(
      config.modelNamespaces.map((namespace) => k8s.list(MAAS_MODEL_REF, { namespace })),
    );
    return lists.flat();
  }

  private toInfo(obj: Parameters<typeof parseModelRef>[0]): BackendModelInfo {
    const ref = parseModelRef(obj);
    return {
      id: ref.id,
      name: ref.displayName || ref.name,
      backendModelName: ref.name,
      description: ref.description,
      endpoint: ref.endpoint,
      available: ref.phase === 'Ready',
      raw: ref,
    };
  }

  async listModels(): Promise<BackendModelInfo[]> {
    return (await this.listRefs()).map((o) => this.toInfo(o));
  }

  async getModel(id: string): Promise<BackendModelInfo | null> {
    const idx = id.indexOf('/');
    if (idx <= 0) return null;
    const obj = await this.clients.k8s.get(MAAS_MODEL_REF, id.slice(idx + 1), id.slice(0, idx));
    return obj ? this.toInfo(obj) : null;
  }

  async checkHealth(): Promise<BackendHealth> {
    const api = await this.clients.maasApi.health();
    return {
      status: api.healthy ? 'healthy' : 'unhealthy',
      message: api.message,
      details: { maasApi: api.healthy, mock: this.clients.maasApi.mock },
    };
  }
}

export class MaasKeyBackend implements KeyBackendProvider {
  readonly type = 'maas' as const;
  constructor(protected readonly clients: MaasClients) {}
  async createKey(_request: CreateBackendKeyRequest): Promise<BackendKeyResult> {
    return notImplemented('key creation');
  }
  async updateKey(_ref: string, _request: UpdateBackendKeyRequest): Promise<void> {
    return notImplemented('key update');
  }
  async revokeKey(_ref: string): Promise<void> {
    return notImplemented('key revocation');
  }
}

export class MaasUsageBackend implements UsageSource {
  readonly type = 'maas' as const;
  constructor(protected readonly clients: MaasClients) {}
  async getDayData(_date: string): Promise<LiteLLMDayData | null> {
    return notImplemented('usage');
  }
}

export function createMaasBackend(clients: MaasClients): BackendProvider {
  return {
    type: 'maas',
    models: new MaasModelBackend(clients),
    keys: new MaasKeyBackend(clients),
    usage: new MaasUsageBackend(clients),
  };
}
