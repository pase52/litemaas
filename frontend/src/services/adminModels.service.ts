import { apiClient } from './api';
import type {
  LiteLLMModelCreate,
  LiteLLMModelUpdate,
  AdminModelResponse,
  AdminModelError,
  TestModelConfigRequest,
  TestModelConfigResponse,
  MaasModelRefInfo,
  MaasSyncResult,
  MigrateToMaasRequest,
  MigrateToMaasResponse,
} from '../types/admin';

export class AdminModelsService {
  private readonly basePath = '/admin/models';

  async createModel(modelData: LiteLLMModelCreate): Promise<AdminModelResponse> {
    try {
      const response = await apiClient.post<AdminModelResponse>(this.basePath, modelData);
      return response;
    } catch (error: any) {
      if (error.response?.data) {
        throw error.response.data as AdminModelError;
      }
      throw {
        error: 'NETWORK_ERROR',
        message: 'Failed to create model. Please check your connection and try again.',
        statusCode: error.response?.status || 500,
      } as AdminModelError;
    }
  }

  async updateModel(modelId: string, modelData: LiteLLMModelUpdate): Promise<AdminModelResponse> {
    try {
      const response = await apiClient.put<AdminModelResponse>(
        `${this.basePath}/${encodeURIComponent(modelId)}`,
        modelData,
      );
      return response;
    } catch (error: any) {
      if (error.response?.data) {
        throw error.response.data as AdminModelError;
      }
      throw {
        error: 'NETWORK_ERROR',
        message: 'Failed to update model. Please check your connection and try again.',
        statusCode: error.response?.status || 500,
      } as AdminModelError;
    }
  }

  async testConfiguration(data: TestModelConfigRequest): Promise<TestModelConfigResponse> {
    try {
      const response = await apiClient.post<TestModelConfigResponse>(`${this.basePath}/test`, data);
      return response;
    } catch (error: any) {
      if (error.response?.data) {
        throw error.response.data as AdminModelError;
      }
      throw {
        error: 'NETWORK_ERROR',
        message: 'Failed to test configuration. Please check your connection and try again.',
        statusCode: error.response?.status || 500,
      } as AdminModelError;
    }
  }

  async deleteModel(modelId: string): Promise<AdminModelResponse> {
    try {
      const response = await apiClient.delete<AdminModelResponse>(
        `${this.basePath}/${encodeURIComponent(modelId)}`,
      );
      return response;
    } catch (error: any) {
      if (error.response?.data) {
        throw error.response.data as AdminModelError;
      }
      throw {
        error: 'NETWORK_ERROR',
        message: 'Failed to delete model. Please check your connection and try again.',
        statusCode: error.response?.status || 500,
      } as AdminModelError;
    }
  }

  /** Import/refresh models from MaaSModelRef objects on the cluster. */
  async syncMaasModels(restoreRemoved = false): Promise<MaasSyncResult> {
    return apiClient.post<MaasSyncResult>(`${this.basePath}/maas/sync`, { restoreRemoved });
  }

  /** List MaaSModelRefs available on the cluster (for the migrate picker). */
  async getMaasRefs(): Promise<MaasModelRefInfo[]> {
    const response = await apiClient.get<{ data: MaasModelRefInfo[] }>(
      `${this.basePath}/maas/refs`,
    );
    return response.data ?? [];
  }

  /** Migrate a LiteLLM model to a MaaS model reference, with a grace period. */
  async migrateToMaas(
    modelId: string,
    request: MigrateToMaasRequest,
  ): Promise<MigrateToMaasResponse> {
    return apiClient.post<MigrateToMaasResponse>(
      `${this.basePath}/${encodeURIComponent(modelId)}/migrate-to-maas`,
      request,
    );
  }
}

// Export a singleton instance
export const adminModelsService = new AdminModelsService();
