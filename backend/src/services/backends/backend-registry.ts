import { ApplicationError } from '../../utils/errors.js';
import type { BackendProvider, BackendType } from './backend.types.js';

/**
 * Registry of the model backends available in this deployment. The LiteLLM backend is always
 * registered; the MaaS backend only when MAAS_ENABLED=true.
 */
export class BackendRegistry {
  private providers = new Map<BackendType, BackendProvider>();

  register(provider: BackendProvider): void {
    this.providers.set(provider.type, provider);
  }

  has(type: BackendType): boolean {
    return this.providers.has(type);
  }

  /** Throws a validation error when the backend is not enabled/registered */
  get(type: BackendType): BackendProvider {
    const provider = this.providers.get(type);
    if (!provider) {
      throw ApplicationError.validation(
        `Backend '${type}' is not enabled`,
        'backendType',
        type,
        'Enable the backend in the deployment configuration',
      );
    }
    return provider;
  }

  list(): BackendProvider[] {
    return [...this.providers.values()];
  }

  types(): BackendType[] {
    return [...this.providers.keys()];
  }

  get maasEnabled(): boolean {
    return this.providers.has('maas');
  }
}
