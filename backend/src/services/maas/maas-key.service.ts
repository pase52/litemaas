import { randomUUID } from 'crypto';
import type { FastifyInstance } from 'fastify';
import { BaseService } from '../base.service.js';
import { ApplicationError } from '../../utils/errors.js';
import { decryptApiKey, encryptApiKey } from '../../utils/encryption.js';
import { upsertK8sObject } from '../k8s/k8s-client.js';
import type {
  BackendKeyResult,
  CreateBackendKeyRequest,
  KeyBackendProvider,
  UpdateBackendKeyRequest,
} from '../backends/backend.types.js';
import type { MaasClients } from './maas-clients.js';
import { UserTokenService } from './user-token.service.js';
import {
  MAAS_SUBSCRIPTION,
  buildSubscription,
  subscriptionName,
  type MaasModelLimit,
} from './maas-resources.js';

/** Synthetic key_hash of a MaaS key; the suffix equals the Limitador `subscription` label */
export const MAAS_KEY_HASH_PREFIX = 'maas:';

export function maasKeyHash(subName: string): string {
  return `${MAAS_KEY_HASH_PREFIX}${subName}`;
}

/** Limit / LiteLLM-only fields a MaaS key cannot carry (only TPM is supported) */
const UNSUPPORTED_LIMIT_FIELDS = [
  'maxBudget',
  'rpmLimit',
  'budgetDuration',
  'softBudget',
  'maxParallelRequests',
  'modelMaxBudget',
  'modelRpmLimit',
  'teamId',
  'guardrails',
  'permissions',
] as const;

const MAX_ACTIVE_KEYS_PER_USER = 10;
const DAY_MS = 86_400_000;

export interface MaasKeyModelRow {
  id: string;
  name: string;
  provider: string;
  context_length: number | null;
  backend_type: string;
  availability: string | null;
  maas_model_ref_name: string | null;
  maas_model_ref_namespace: string | null;
  supports_embeddings?: boolean;
  supports_convert?: boolean;
}

/** api_keys row (SELECT *) for a MaaS key */
export interface MaasApiKeyRow {
  id: string;
  user_id: string;
  name: string | null;
  key_prefix: string;
  key_hash: string;
  expires_at: Date | string | null;
  is_active: boolean;
  revoked_at: Date | string | null;
  archived_at: Date | string | null;
  tpm_limit: number | null;
  model_tpm_limit: Record<string, number> | null;
  backend_type: string;
  maas_key_id: string | null;
  maas_subscription_name: string | null;
  encrypted_key: string | null;
  maas_sync_state: string | null;
  models?: string[];
  [column: string]: unknown;
}

export interface MaasCreateRequest {
  name?: string;
  modelIds: string[];
  expiresAt?: Date;
  tpmLimit?: number | null;
  modelTpmLimit?: Record<string, number>;
  metadata?: Record<string, unknown>;
  [unsupported: string]: unknown;
}

export interface MaasCreatedKey {
  id: string;
  userId: string;
  name?: string;
  keyPrefix: string;
  lastUsedAt?: Date;
  expiresAt?: Date;
  isActive: boolean;
  createdAt: Date;
  key: string;
  models: string[];
  modelDetails: Array<{
    id: string;
    name: string;
    provider: string;
    context_length?: number;
    supports_embeddings?: boolean;
    supports_convert?: boolean;
  }>;
  backendType: 'maas';
  maasKeyId: string;
}

export interface ClusterRevokeResult {
  subscriptionDeleted: boolean;
  /** null when the key has no maas-api id (nothing to revoke) */
  maasApiRevoked: boolean | null;
  error?: string;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function daysUntil(date: Date): number {
  return Math.max(1, Math.ceil((date.getTime() - Date.now()) / DAY_MS));
}

/**
 * Best-effort revoke of a key in maas-api. maas-api authenticates the caller, so the owner's
 * stored token is tried first and the service account token second. Never throws.
 * A key whose MaaSSubscription is deleted cannot authorize requests anyway, so a failure here
 * only leaves a dangling record in maas-api (the reconciler retries).
 */
export async function revokeInMaasApi(
  fastify: FastifyInstance,
  clients: MaasClients,
  userId: string,
  maasKeyId: string,
  tokens: UserTokenService = new UserTokenService(fastify),
): Promise<boolean> {
  const candidates: Array<() => Promise<string | undefined>> = [
    async () => {
      try {
        return await tokens.getValidToken(userId);
      } catch {
        return undefined;
      }
    },
    async () => clients.serviceToken?.(),
  ];
  for (const getToken of candidates) {
    const token = await getToken();
    if (!token) continue;
    try {
      await clients.maasApi.revokeKey(token, maasKeyId);
      return true;
    } catch (error) {
      fastify.log.debug(
        { userId, maasKeyId, error: errMsg(error) },
        'maas-api revoke attempt failed',
      );
    }
  }
  return false;
}

/**
 * MaaS API key lifecycle. One LiteMaaS key = one per-key MaaSSubscription
 * `litemaas-key-<id>` (models + TPM token rate limits) + one maas-api key created with the
 * user's own OpenShift token. The plaintext key is stored encrypted so View Key keeps working.
 *
 * As a KeyBackendProvider, `ref` is the LiteMaaS api_keys.id (the subscription name and the
 * maas-api key id are resolved from it).
 *
 * Ordering rules:
 *  - create: row -> MaaSSubscription -> maas-api -> finalize, with full rollback on any failure
 *  - revoke / model removal: cluster first (access removal), then the database
 *  - limit / model edits: cluster first; a cluster failure leaves the database unchanged
 */
export class MaasKeyService extends BaseService implements KeyBackendProvider {
  readonly type = 'maas' as const;
  private readonly clientsOpt?: MaasClients;
  private readonly tokens: UserTokenService;

  constructor(fastify: FastifyInstance, clients?: MaasClients, tokens?: UserTokenService) {
    super(fastify);
    this.clientsOpt = clients ?? fastify.maasClients;
    this.tokens = tokens ?? new UserTokenService(fastify);
  }

  private get clients(): MaasClients {
    if (!this.clientsOpt) {
      throw this.createValidationError(
        'The MaaS backend is not enabled',
        'backendType',
        'maas',
        'Set MAAS_ENABLED=true to manage MaaS API keys',
      );
    }
    return this.clientsOpt;
  }

  /** Gateway base URL clients call with a MaaS key (undefined when not configured) */
  get baseUrl(): string | undefined {
    return this.clientsOpt?.config.gatewayUrl;
  }

  // ------------------------------------------------------------------ helpers

  subscriptionNameFor(row: Pick<MaasApiKeyRow, 'id' | 'maas_subscription_name'>): string {
    return row.maas_subscription_name || subscriptionName(row.id);
  }

  async loadModels(modelIds: string[]): Promise<MaasKeyModelRow[]> {
    if (modelIds.length === 0) return [];
    return this.fastify.dbUtils.queryMany<MaasKeyModelRow>(
      `SELECT m.id, m.name, m.provider, m.context_length, m.backend_type, m.availability,
              m.maas_model_ref_name, m.maas_model_ref_namespace,
              COALESCE('embeddings' = ANY(m.features), false) AS supports_embeddings,
              COALESCE('convert' = ANY(m.features), false) AS supports_convert
         FROM models m WHERE m.id = ANY($1::text[])`,
      [modelIds],
    );
  }

  /**
   * Decide which backend a key over `modelIds` belongs to. A key is bound to ONE backend:
   * mixed model sets are rejected (400), as is an explicit backendType that contradicts the
   * models. Unknown model ids default to LiteLLM (its own validation reports them).
   */
  async resolveBackend(
    modelIds: string[],
    requested?: 'litellm' | 'maas',
  ): Promise<'litellm' | 'maas'> {
    const rows = await this.loadModels(modelIds);
    const types = new Set(rows.map((r) => r.backend_type));
    if (types.size > 1) {
      throw this.createValidationError(
        'An API key cannot mix MaaS and LiteLLM models',
        'modelIds',
        modelIds,
        'Create one API key per backend',
      );
    }
    const actual: 'litellm' | 'maas' = types.has('maas') ? 'maas' : 'litellm';
    if (requested && rows.length > 0 && requested !== actual) {
      throw this.createValidationError(
        `The selected models are served by the ${actual} backend, not ${requested}`,
        'backendType',
        requested,
        'Select models of the chosen backend or change the backend type',
      );
    }
    if (requested === 'maas' && rows.length === 0) {
      throw this.createValidationError(
        'None of the selected models is a MaaS model',
        'modelIds',
        modelIds,
      );
    }
    return requested === 'maas' ? 'maas' : actual;
  }

  /** Ids of the given models that are MaaS models (empty when none / unknown) */
  async findMaasModelIds(modelIds: string[]): Promise<string[]> {
    const rows = await this.loadModels(modelIds);
    return rows.filter((r) => r.backend_type === 'maas').map((r) => r.id);
  }

  private assertSupportedFields(request: Record<string, unknown>): void {
    const offending = UNSUPPORTED_LIMIT_FIELDS.filter((f) => {
      const v = request[f];
      if (v == null) return false;
      if (Array.isArray(v)) return v.length > 0;
      if (typeof v === 'object') return Object.keys(v as object).length > 0;
      return true;
    });
    if (offending.length > 0) {
      throw this.createValidationError(
        `MaaS API keys only support tokens-per-minute limits; unsupported: ${offending.join(', ')}`,
        offending[0],
        undefined,
        'Remove budget, request-rate and team settings, or use a LiteLLM key',
      );
    }
  }

  /** Models must be MaaS, available, and (for end users) actively subscribed */
  private async validateModels(userId: string, modelIds: string[]): Promise<MaasKeyModelRow[]> {
    if (!modelIds || modelIds.length === 0) {
      throw this.createValidationError(
        'At least one model must be selected',
        'modelIds',
        modelIds,
        'Please select at least one model for the API key',
      );
    }
    const unique = [...new Set(modelIds)];
    const rows = await this.loadModels(unique);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const missing = unique.filter((id) => !byId.has(id));
    if (missing.length > 0) {
      throw this.createValidationError(
        `Unknown models: ${missing.join(', ')}`,
        'modelIds',
        missing,
        'Select models from the catalog',
      );
    }
    const nonMaas = rows.filter((r) => r.backend_type !== 'maas').map((r) => r.id);
    if (nonMaas.length > 0) {
      throw this.createValidationError(
        'An API key cannot mix MaaS and LiteLLM models',
        'modelIds',
        nonMaas,
        'Create one API key per backend',
      );
    }
    const unavailable = rows
      .filter((r) => r.availability && r.availability !== 'available')
      .map((r) => r.id);
    if (unavailable.length > 0) {
      throw this.createValidationError(
        `Models are currently unavailable: ${unavailable.join(', ')}`,
        'modelIds',
        unavailable,
        'Wait until the models are Ready or remove them from the key',
      );
    }
    const broken = rows.filter((r) => !r.maas_model_ref_name || !r.maas_model_ref_namespace);
    if (broken.length > 0) {
      throw this.createValidationError(
        `MaaS models without a model reference: ${broken.map((r) => r.id).join(', ')}`,
        'modelIds',
        broken.map((r) => r.id),
        'Run a MaaS model sync and retry',
      );
    }
    const subs = await this.fastify.dbUtils.queryMany<{ model_id: string }>(
      `SELECT DISTINCT s.model_id FROM subscriptions s
        WHERE s.user_id = $1 AND s.status = 'active' AND s.model_id = ANY($2::text[])`,
      [userId, unique],
    );
    const subscribed = new Set(subs.map((s) => s.model_id));
    const invalid = unique.filter((id) => !subscribed.has(id));
    if (invalid.length > 0) {
      throw this.createValidationError(
        `You do not have active subscriptions for the following models: ${invalid.join(', ')}`,
        'modelIds',
        invalid,
        'Please ensure you have active subscriptions for all selected models',
      );
    }
    return unique.map((id) => byId.get(id)!);
  }

  private validateTpm(tpm: unknown, modelTpm: unknown, modelIds: string[]): void {
    if (tpm != null && (!Number.isInteger(tpm) || (tpm as number) < 0)) {
      throw this.createValidationError('tpmLimit must be a non-negative integer', 'tpmLimit', tpm);
    }
    if (modelTpm != null) {
      for (const [modelId, limit] of Object.entries(modelTpm as Record<string, unknown>)) {
        if (!modelIds.includes(modelId)) {
          throw this.createValidationError(
            `modelTpmLimit references a model that is not part of the key: ${modelId}`,
            'modelTpmLimit',
            modelId,
          );
        }
        if (!Number.isInteger(limit) || (limit as number) < 0) {
          throw this.createValidationError(
            'modelTpmLimit values must be non-negative integers',
            'modelTpmLimit',
            limit,
          );
        }
      }
    }
  }

  private buildLimits(
    models: MaasKeyModelRow[],
    modelTpm?: Record<string, number> | null,
  ): MaasModelLimit[] {
    return models.map((m) => ({
      name: m.maas_model_ref_name!,
      namespace: m.maas_model_ref_namespace!,
      tpm: modelTpm?.[m.id] ?? null,
    }));
  }

  private async getUsername(userId: string): Promise<string> {
    const row = await this.fastify.dbUtils.queryOne<{ username: string }>(
      'SELECT username FROM users WHERE id = $1',
      [userId],
    );
    if (!row) throw this.createNotFoundError('User', userId);
    return row.username;
  }

  /** Create or replace the per-key MaaSSubscription */
  private async applySubscription(input: {
    keyId: string;
    userId: string;
    subName: string;
    models: MaasKeyModelRow[];
    tpm?: number | null;
    modelTpm?: Record<string, number> | null;
  }): Promise<void> {
    const { k8s, config } = this.clients;
    const username = await this.getUsername(input.userId);
    const desired = buildSubscription({
      apiKeyId: input.keyId,
      userId: input.userId,
      username,
      namespace: config.namespace,
      models: this.buildLimits(input.models, input.modelTpm),
      globalTpm: input.tpm,
    });
    desired.metadata.name = input.subName;
    await upsertK8sObject(k8s, MAAS_SUBSCRIPTION, desired, config.namespace);
  }

  private async deleteSubscription(subName: string): Promise<void> {
    const { k8s, config } = this.clients;
    await k8s.delete(MAAS_SUBSCRIPTION, subName, config.namespace);
  }

  private async loadKeyModels(keyId: string): Promise<MaasKeyModelRow[]> {
    return this.fastify.dbUtils.queryMany<MaasKeyModelRow>(
      `SELECT m.id, m.name, m.provider, m.context_length, m.backend_type, m.availability,
              m.maas_model_ref_name, m.maas_model_ref_namespace
         FROM api_key_models akm JOIN models m ON m.id = akm.model_id
        WHERE akm.api_key_id = $1 AND m.backend_type = 'maas'
        ORDER BY m.id`,
      [keyId],
    );
  }

  /** Load a MaaS key owned by `userId`, with its model ids; null when absent / not MaaS */
  async getKeyRow(keyId: string, userId: string): Promise<MaasApiKeyRow | null> {
    const row = await this.fastify.dbUtils.queryOne<MaasApiKeyRow>(
      `SELECT * FROM api_keys WHERE id = $1 AND user_id = $2 AND backend_type = 'maas'`,
      [keyId, userId],
    );
    if (!row) return null;
    const models = await this.fastify.dbUtils.queryMany<{ model_id: string }>(
      'SELECT model_id FROM api_key_models WHERE api_key_id = $1 ORDER BY model_id',
      [keyId],
    );
    row.models = models.map((m) => m.model_id);
    return row;
  }

  private async requireActiveKey(keyId: string, userId: string): Promise<MaasApiKeyRow> {
    const row = await this.getKeyRow(keyId, userId);
    if (!row) {
      throw this.createNotFoundError(
        'API key',
        keyId,
        'API key not found or you do not have permission to access it',
      );
    }
    if (!row.is_active) {
      throw this.createValidationError(
        'Cannot update inactive API key',
        'isActive',
        false,
        'Reactivate the API key before making updates',
      );
    }
    return row;
  }

  private async audit(
    userId: string,
    action: string,
    keyId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.fastify.dbUtils.query(
      `INSERT INTO audit_logs (user_id, action, resource_type, resource_id, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, action, 'API_KEY', keyId, JSON.stringify({ backendType: 'maas', ...metadata })],
    );
  }

  // --------------------------------------------------- KeyBackendProvider

  /**
   * Cluster part of creation: MaaSSubscription + maas-api key. The api_keys row must already
   * exist (request.keyId). Rolls back its own cluster changes when maas-api fails.
   * `providerOptions.userToken` may carry an already resolved user token.
   */
  async createKey(request: CreateBackendKeyRequest): Promise<BackendKeyResult> {
    const { maasApi } = this.clients;
    const userToken =
      (request.providerOptions?.userToken as string | undefined) ??
      (await this.tokens.getValidToken(request.userId));
    const models = await this.validateModelsForProvider(request.modelIds);
    const subName = subscriptionName(request.keyId);

    await this.applySubscription({
      keyId: request.keyId,
      userId: request.userId,
      subName,
      models,
      tpm: request.tpmLimit,
      modelTpm: request.modelTpmLimits,
    });

    try {
      const created = await maasApi.createKey(userToken, {
        name: request.name,
        description: `LiteMaaS API key ${request.keyId}`,
        subscription: subName,
        expiresInDays: request.expiresAt ? daysUntil(request.expiresAt) : undefined,
      });
      return {
        key: created.key,
        backendKeyId: created.id,
        keyPrefix: created.keyPrefix,
        expiresAt: created.expiresAt ? new Date(created.expiresAt) : (request.expiresAt ?? null),
        providerData: { subscriptionName: subName, createdAt: created.createdAt },
      };
    } catch (error) {
      try {
        await this.deleteSubscription(subName);
      } catch (cleanupError) {
        this.fastify.log.error(
          { subName, cleanupError: errMsg(cleanupError) },
          'MaaS: failed to remove subscription after maas-api failure - reconciler will clean up',
        );
      }
      throw error;
    }
  }

  private async validateModelsForProvider(modelIds: string[]): Promise<MaasKeyModelRow[]> {
    const rows = await this.loadModels([...new Set(modelIds)]);
    const bad = rows.filter(
      (r) => r.backend_type !== 'maas' || !r.maas_model_ref_name || !r.maas_model_ref_namespace,
    );
    if (rows.length === 0 || rows.length !== new Set(modelIds).size || bad.length > 0) {
      throw this.createValidationError(
        'All models of a MaaS key must be known MaaS models',
        'modelIds',
        modelIds,
      );
    }
    return rows;
  }

  /** `ref` = api_keys.id. Supports modelIds and TPM limits (cluster first, then database). */
  async updateKey(ref: string, request: UpdateBackendKeyRequest): Promise<void> {
    const row = await this.fastify.dbUtils.queryOne<MaasApiKeyRow>(
      `SELECT * FROM api_keys WHERE id = $1 AND backend_type = 'maas'`,
      [ref],
    );
    if (!row) throw this.createNotFoundError('API key', ref);
    if (request.modelIds) {
      await this.updateModels(ref, row.user_id, request.modelIds, { skipSubscriptionCheck: true });
    }
    if (request.tpmLimit !== undefined || request.modelTpmLimits !== undefined) {
      await this.updateLimits(ref, row.user_id, {
        ...(request.tpmLimit !== undefined && { tpmLimit: request.tpmLimit }),
        ...(request.modelTpmLimits !== undefined && { modelTpmLimit: request.modelTpmLimits }),
      });
    }
  }

  /** `ref` = api_keys.id. Removes cluster access (subscription + maas-api key). Never throws. */
  async revokeKey(ref: string): Promise<void> {
    const row = await this.fastify.dbUtils.queryOne<MaasApiKeyRow>(
      `SELECT * FROM api_keys WHERE id = $1 AND backend_type = 'maas'`,
      [ref],
    );
    if (!row) return;
    await this.clusterRevoke(row);
  }

  // ------------------------------------------------------------ orchestration

  /**
   * Create a MaaS key end to end.
   * Order: validate -> user token -> row (+models) -> MaaSSubscription -> maas-api ->
   * finalize (maas_key_id, encrypted key, expiry). Any failure rolls back everything created
   * so far (maas-api key, subscription, row) and rethrows.
   */
  async createApiKey(userId: string, request: MaasCreateRequest): Promise<MaasCreatedKey> {
    void this.clients; // fail fast when MaaS is disabled
    this.assertSupportedFields(request);

    const modelIds = [...new Set(request.modelIds ?? [])];
    const models = await this.validateModels(userId, modelIds);
    this.validateTpm(request.tpmLimit, request.modelTpmLimit, modelIds);
    if (request.expiresAt && request.expiresAt.getTime() <= Date.now()) {
      throw this.createValidationError(
        'Expiration must be in the future',
        'expiresAt',
        request.expiresAt,
      );
    }

    const count = await this.fastify.dbUtils.queryOne<{ count: string }>(
      `SELECT COUNT(*) FROM api_keys WHERE user_id = $1 AND is_active = true`,
      [userId],
    );
    if (count && parseInt(String(count.count), 10) >= MAX_ACTIVE_KEYS_PER_USER) {
      throw this.createValidationError(
        `Maximum ${MAX_ACTIVE_KEYS_PER_USER} active API keys allowed per user`,
        'activeKeysCount',
        count.count,
        `Please revoke some existing API keys before creating new ones. Current limit: ${MAX_ACTIVE_KEYS_PER_USER}`,
      );
    }

    const secret = this.tokens.getEncryptionSecret();
    if (!secret) {
      throw ApplicationError.serviceUnavailable('MaaS key storage (ENCRYPTION_KEY is not set)');
    }
    // Fail with MAAS_REAUTH_REQUIRED before anything is created
    const userToken = await this.tokens.getValidToken(userId);

    const keyId = randomUUID();
    const subName = subscriptionName(keyId);
    const name = request.name || 'MaaS API key';
    const modelTpm = request.modelTpmLimit ?? null;

    // 1. Row (+ model associations) so the reconciler never sees a subscription without a key
    await this.fastify.dbUtils.withTransaction(async (client) => {
      await client.query(
        `INSERT INTO api_keys (
           id, user_id, name, key_hash, key_prefix, expires_at, is_active, current_spend,
           tpm_limit, model_tpm_limit, sync_status, last_sync_at, metadata,
           backend_type, maas_subscription_name, maas_sync_state
         ) VALUES ($1, $2, $3, $4, $5, $6, true, 0, $7, $8, 'pending', CURRENT_TIMESTAMP, $9,
                   'maas', $10, 'pending')`,
        [
          keyId,
          userId,
          name,
          maasKeyHash(subName),
          'sk-oai-',
          request.expiresAt ?? null,
          request.tpmLimit ?? null,
          modelTpm ? JSON.stringify(modelTpm) : null,
          JSON.stringify(request.metadata ?? {}),
          subName,
        ],
      );
      for (const modelId of modelIds) {
        await client.query('INSERT INTO api_key_models (api_key_id, model_id) VALUES ($1, $2)', [
          keyId,
          modelId,
        ]);
      }
    });

    let created: BackendKeyResult | undefined;
    try {
      // 2 + 3. MaaSSubscription, then the maas-api key (provider rolls back its own cluster work)
      created = await this.createKey({
        keyId,
        userId,
        username: '',
        name,
        modelIds,
        expiresAt: request.expiresAt,
        tpmLimit: request.tpmLimit,
        modelTpmLimits: request.modelTpmLimit,
        providerOptions: { userToken },
      });

      // 4. Finalize
      const prefix = (created.keyPrefix || created.key.slice(0, 12)).slice(0, 20);
      const expiresAt = created.expiresAt ?? null;
      const row = await this.fastify.dbUtils.withTransaction(async (client) => {
        const res = await client.query(
          `UPDATE api_keys
              SET maas_key_id = $2, key_prefix = $3, encrypted_key = $4, expires_at = $5,
                  maas_sync_state = 'synced', maas_last_error = NULL, sync_status = 'synced',
                  last_sync_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
            WHERE id = $1 RETURNING *`,
          [keyId, created!.backendKeyId, prefix, encryptApiKey(created!.key, secret), expiresAt],
        );
        await client.query(
          `INSERT INTO audit_logs (user_id, action, resource_type, resource_id, metadata)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            userId,
            'API_KEY_CREATE',
            'API_KEY',
            keyId,
            JSON.stringify({
              backendType: 'maas',
              name,
              keyPrefix: prefix,
              models: modelIds,
              modelCount: modelIds.length,
              subscription: subName,
            }),
          ],
        );
        return res.rows[0] as MaasApiKeyRow;
      });

      this.fastify.log.info(
        { userId, apiKeyId: keyId, subscription: subName, models: modelIds },
        'MaaS API key created',
      );

      return {
        id: row.id,
        userId: row.user_id,
        name: row.name ?? undefined,
        keyPrefix: row.key_prefix,
        expiresAt: row.expires_at ? new Date(row.expires_at) : undefined,
        isActive: row.is_active,
        createdAt: new Date(row.created_at as string),
        key: created.key,
        models: modelIds,
        modelDetails: models.map((m) => ({
          id: m.id,
          name: m.name,
          provider: m.provider,
          context_length: m.context_length ?? undefined,
          supports_embeddings: Boolean(m.supports_embeddings),
          supports_convert: Boolean(m.supports_convert),
        })),
        backendType: 'maas',
        maasKeyId: created.backendKeyId,
      };
    } catch (error) {
      await this.rollbackCreate(keyId, userId, subName, created?.backendKeyId, userToken);
      throw error;
    }
  }

  /** Undo a partially created key: maas-api key, subscription, then the row */
  private async rollbackCreate(
    keyId: string,
    userId: string,
    subName: string,
    maasKeyId: string | undefined,
    userToken: string,
  ): Promise<void> {
    if (maasKeyId) {
      try {
        await this.clients.maasApi.revokeKey(userToken, maasKeyId);
      } catch (error) {
        this.fastify.log.error(
          { keyId, maasKeyId, error: errMsg(error) },
          'MaaS: failed to revoke maas-api key while rolling back creation',
        );
      }
    }
    try {
      await this.deleteSubscription(subName);
    } catch (error) {
      this.fastify.log.error(
        { keyId, subName, error: errMsg(error) },
        'MaaS: failed to delete subscription while rolling back creation - reconciler will clean up',
      );
    }
    try {
      await this.fastify.dbUtils.query('DELETE FROM api_key_models WHERE api_key_id = $1', [keyId]);
      await this.fastify.dbUtils.query('DELETE FROM api_keys WHERE id = $1', [keyId]);
    } catch (error) {
      this.fastify.log.error(
        { keyId, userId, error: errMsg(error) },
        'MaaS: failed to delete api_keys row while rolling back creation',
      );
    }
  }

  /**
   * Remove cluster access of a key: delete its MaaSSubscription (the key can no longer
   * authorize requests) and best-effort revoke the maas-api key. A subscription deletion
   * error is rethrown only when `throwOnSubscriptionError` is set; otherwise it is returned
   * so the caller can flag the key for the reconciler.
   */
  async clusterRevoke(
    row: Pick<MaasApiKeyRow, 'id' | 'user_id' | 'maas_key_id' | 'maas_subscription_name'>,
    options: { throwOnSubscriptionError?: boolean } = {},
  ): Promise<ClusterRevokeResult> {
    const result: ClusterRevokeResult = { subscriptionDeleted: false, maasApiRevoked: null };
    try {
      await this.deleteSubscription(this.subscriptionNameFor(row));
      result.subscriptionDeleted = true;
    } catch (error) {
      result.error = errMsg(error);
      this.fastify.log.error(
        { keyId: row.id, error: result.error },
        'MaaS: failed to delete subscription during revocation',
      );
      if (options.throwOnSubscriptionError) throw error;
    }

    if (row.maas_key_id) {
      result.maasApiRevoked = await revokeInMaasApi(
        this.fastify,
        this.clients,
        row.user_id,
        row.maas_key_id,
        this.tokens,
      );
      if (!result.maasApiRevoked) {
        result.error = result.error ?? 'maas-api key could not be revoked (no usable token)';
      }
    }
    return result;
  }

  private syncStateOf(r: ClusterRevokeResult): 'synced' | 'pending' {
    return r.subscriptionDeleted && r.maasApiRevoked !== false ? 'synced' : 'pending';
  }

  /** Soft revoke (is_active=false). Cluster failures are recorded for the reconciler. */
  async revokeApiKey(keyId: string, userId: string, reason?: string): Promise<void> {
    const row = await this.getKeyRow(keyId, userId);
    if (!row) {
      throw this.createNotFoundError(
        'API key',
        keyId,
        'API key not found or you do not have permission to access it',
      );
    }
    if (!row.is_active) {
      throw this.createValidationError(
        'API key is already inactive',
        'isActive',
        false,
        'This API key has already been revoked or deactivated',
      );
    }

    const result = await this.clusterRevoke(row);
    await this.fastify.dbUtils.query(
      `UPDATE api_keys
          SET is_active = false, revoked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP,
              maas_sync_state = $2, maas_last_error = $3
        WHERE id = $1`,
      [keyId, this.syncStateOf(result), result.error?.slice(0, 500) ?? null],
    );
    await this.audit(userId, 'API_KEY_REVOKE', keyId, {
      models: row.models,
      keyName: row.name,
      keyPrefix: row.key_prefix,
      reason: reason || 'Revoked',
      clusterRevoked: result.subscriptionDeleted,
      maasApiRevoked: result.maasApiRevoked,
    });
    this.fastify.log.info({ userId, apiKeyId: keyId, reason }, 'MaaS API key revoked');
  }

  /** Permanent delete: cluster access removed first, then the row */
  async deleteApiKey(keyId: string, userId: string): Promise<void> {
    const row = await this.getKeyRow(keyId, userId);
    if (!row) {
      throw this.createNotFoundError(
        'API key',
        keyId,
        'API key not found or you do not have permission to access it',
      );
    }
    const result = await this.clusterRevoke(row);
    await this.fastify.dbUtils.query('DELETE FROM api_keys WHERE id = $1', [keyId]);
    await this.audit(userId, 'API_KEY_DELETE', keyId, {
      models: row.models,
      keyName: row.name,
      keyPrefix: row.key_prefix,
      clusterRevoked: result.subscriptionDeleted,
    });
    this.fastify.log.info({ userId, apiKeyId: keyId }, 'MaaS API key deleted');
  }

  /**
   * Cluster part of archiving: errors deleting the subscription propagate (the key stays
   * visible rather than being archived while still active remotely).
   */
  async revokeForArchive(
    row: Pick<MaasApiKeyRow, 'id' | 'user_id' | 'maas_key_id' | 'maas_subscription_name'>,
  ): Promise<void> {
    const result = await this.clusterRevoke(row, { throwOnSubscriptionError: true });
    await this.fastify.dbUtils.query(
      `UPDATE api_keys SET maas_sync_state = $2, maas_last_error = $3 WHERE id = $1`,
      [row.id, this.syncStateOf(result), result.error?.slice(0, 500) ?? null],
    );
  }

  /** Decrypt the stored plaintext key (View Key / playground) */
  decryptStoredKey(encrypted: string | null | undefined, keyId: string): string {
    if (!encrypted) {
      throw this.createNotFoundError(
        'MaaS key',
        keyId,
        'The key value is not stored. Create a new API key',
      );
    }
    const secret = this.tokens.getEncryptionSecret();
    if (!secret) {
      throw ApplicationError.serviceUnavailable('MaaS key storage (ENCRYPTION_KEY is not set)');
    }
    try {
      return decryptApiKey(encrypted, secret);
    } catch (error) {
      this.fastify.log.error({ keyId, error: errMsg(error) }, 'MaaS: stored key is unreadable');
      throw ApplicationError.internal(
        'The stored API key cannot be decrypted (the encryption key may have changed). Rotate or recreate the key',
      );
    }
  }

  /**
   * Update TPM limits. Only tokens-per-minute is supported: any other limit with a value is
   * rejected (400). The MaaSSubscription is patched first; a cluster failure leaves the
   * database unchanged.
   */
  async updateLimits(
    keyId: string,
    userId: string,
    updates: Record<string, unknown>,
  ): Promise<MaasApiKeyRow> {
    const row = await this.requireActiveKey(keyId, userId);
    const unsupported = [
      'maxBudget',
      'rpmLimit',
      'budgetDuration',
      'softBudget',
      'maxParallelRequests',
      'modelMaxBudget',
      'modelRpmLimit',
      'allowedModels',
    ].filter((f) => f in updates && updates[f] != null);
    if (unsupported.length > 0) {
      throw this.createValidationError(
        `MaaS API keys only support tokens-per-minute limits; unsupported: ${unsupported.join(', ')}`,
        unsupported[0],
        undefined,
        'Only tpmLimit and modelTpmLimit can be changed',
      );
    }

    const modelIds = row.models ?? [];
    const tpm =
      'tpmLimit' in updates ? ((updates.tpmLimit as number | null) ?? null) : row.tpm_limit;
    const modelTpm =
      'modelTpmLimit' in updates
        ? ((updates.modelTpmLimit as Record<string, number> | null) ?? null)
        : (row.model_tpm_limit ?? null);
    this.validateTpm(tpm, modelTpm, modelIds);

    const models = await this.loadKeyModels(keyId);
    await this.applySubscription({
      keyId,
      userId,
      subName: this.subscriptionNameFor(row),
      models,
      tpm,
      modelTpm,
    });

    const updated = await this.fastify.dbUtils.queryOne<MaasApiKeyRow>(
      `UPDATE api_keys
          SET tpm_limit = $2, model_tpm_limit = $3, last_sync_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP, maas_sync_state = 'synced', maas_last_error = NULL
        WHERE id = $1 RETURNING *`,
      [keyId, tpm, modelTpm && Object.keys(modelTpm).length > 0 ? JSON.stringify(modelTpm) : null],
    );
    await this.audit(userId, 'API_KEY_UPDATE', keyId, { updates });
    updated!.models = modelIds;
    return updated!;
  }

  /**
   * Replace the model set of a key. Cluster first (a removed model loses access
   * immediately), then the junction table. Per-model TPM entries of removed models are dropped.
   */
  async updateModels(
    keyId: string,
    userId: string,
    modelIds: string[],
    options: { skipSubscriptionCheck?: boolean } = {},
  ): Promise<MaasApiKeyRow> {
    const row = await this.requireActiveKey(keyId, userId);
    const unique = [...new Set(modelIds)];
    if (unique.length === 0) {
      throw this.createValidationError(
        'At least one model must remain on the key',
        'modelIds',
        modelIds,
        'Revoke the key instead of removing all of its models',
      );
    }
    const models = options.skipSubscriptionCheck
      ? await this.validateModelsForProvider(unique)
      : await this.validateModels(userId, unique);

    const modelTpm = row.model_tpm_limit
      ? Object.fromEntries(
          Object.entries(row.model_tpm_limit).filter(([id]) => unique.includes(id)),
        )
      : null;

    await this.applySubscription({
      keyId,
      userId,
      subName: this.subscriptionNameFor(row),
      models,
      tpm: row.tpm_limit,
      modelTpm,
    });

    await this.fastify.dbUtils.withTransaction(async (client) => {
      await client.query('DELETE FROM api_key_models WHERE api_key_id = $1', [keyId]);
      for (const modelId of unique) {
        await client.query('INSERT INTO api_key_models (api_key_id, model_id) VALUES ($1, $2)', [
          keyId,
          modelId,
        ]);
      }
      await client.query(
        `UPDATE api_keys SET model_tpm_limit = $2, last_sync_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP, maas_sync_state = 'synced', maas_last_error = NULL
          WHERE id = $1`,
        [keyId, modelTpm && Object.keys(modelTpm).length > 0 ? JSON.stringify(modelTpm) : null],
      );
    });
    await this.audit(userId, 'API_KEY_UPDATE', keyId, { modelIds: unique });
    const fresh = (await this.getKeyRow(keyId, userId))!;
    return fresh;
  }

  /** Name / metadata edits (database only: maas-api keys cannot be renamed) */
  async updateMetadata(
    keyId: string,
    userId: string,
    updates: { name?: string; metadata?: Record<string, unknown> },
  ): Promise<MaasApiKeyRow> {
    await this.requireActiveKey(keyId, userId);
    const sets: string[] = ['updated_at = CURRENT_TIMESTAMP'];
    const params: unknown[] = [];
    if (updates.name !== undefined) {
      params.push(updates.name);
      sets.push(`name = $${params.length}`);
    }
    if (updates.metadata !== undefined) {
      params.push(JSON.stringify(updates.metadata));
      sets.push(`metadata = COALESCE(metadata, '{}'::jsonb) || $${params.length}`);
    }
    params.push(keyId);
    await this.fastify.dbUtils.query(
      `UPDATE api_keys SET ${sets.join(', ')} WHERE id = $${params.length}`,
      params as never[],
    );
    await this.audit(userId, 'API_KEY_UPDATE', keyId, { updates });
    return (await this.getKeyRow(keyId, userId))!;
  }

  /**
   * Change the expiration. maas-api offers no way to extend a key, so only a date that is
   * not later than the current one is accepted; the expiry cleanup enforces it.
   */
  async updateExpiration(
    keyId: string,
    userId: string,
    expiresAt: Date | null,
  ): Promise<MaasApiKeyRow> {
    const row = await this.requireActiveKey(keyId, userId);
    const current = row.expires_at ? new Date(row.expires_at) : null;
    if (!expiresAt || (current && expiresAt.getTime() > current.getTime())) {
      throw this.createValidationError(
        'The expiration of a MaaS API key can only be shortened',
        'expiresAt',
        expiresAt,
        'Rotate the key or create a new one to get a longer lifetime',
      );
    }
    await this.fastify.dbUtils.query(
      'UPDATE api_keys SET expires_at = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
      [keyId, expiresAt],
    );
    await this.audit(userId, 'API_KEY_UPDATE', keyId, { expiresAt });
    return (await this.getKeyRow(keyId, userId))!;
  }

  /**
   * Rotate: issue a new maas-api key on the same subscription, swap it in, then revoke the
   * old one. If anything fails before the swap the old key keeps working.
   */
  async rotateApiKey(
    keyId: string,
    userId: string,
  ): Promise<{ id: string; key: string; keyPrefix: string }> {
    const row = await this.requireActiveKey(keyId, userId);
    const secret = this.tokens.getEncryptionSecret();
    if (!secret) {
      throw ApplicationError.serviceUnavailable('MaaS key storage (ENCRYPTION_KEY is not set)');
    }
    const userToken = await this.tokens.getValidToken(userId);
    const { maasApi } = this.clients;
    const subName = this.subscriptionNameFor(row);
    const expires = row.expires_at ? new Date(row.expires_at) : null;
    if (expires && expires.getTime() <= Date.now()) {
      throw this.createValidationError('API key has expired', 'expiresAt', row.expires_at);
    }

    const created = await maasApi.createKey(userToken, {
      name: row.name || 'MaaS API key',
      description: `LiteMaaS API key ${keyId} (rotated)`,
      subscription: subName,
      expiresInDays: expires ? daysUntil(expires) : undefined,
    });
    const prefix = (created.keyPrefix || created.key.slice(0, 12)).slice(0, 20);

    try {
      await this.fastify.dbUtils.withTransaction(async (client) => {
        await client.query(
          `UPDATE api_keys
              SET maas_key_id = $2, key_prefix = $3, encrypted_key = $4,
                  expires_at = COALESCE($5, expires_at), updated_at = CURRENT_TIMESTAMP,
                  maas_sync_state = 'synced', maas_last_error = NULL
            WHERE id = $1`,
          [
            keyId,
            created.id,
            prefix,
            encryptApiKey(created.key, secret),
            created.expiresAt ? new Date(created.expiresAt) : null,
          ],
        );
        await client.query(
          `INSERT INTO audit_logs (user_id, action, resource_type, resource_id, metadata)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            userId,
            'API_KEY_ROTATE',
            'API_KEY',
            keyId,
            JSON.stringify({
              backendType: 'maas',
              models: row.models,
              keyName: row.name,
              oldPrefix: row.key_prefix,
              newPrefix: prefix,
            }),
          ],
        );
      });
    } catch (error) {
      try {
        await maasApi.revokeKey(userToken, created.id);
      } catch (cleanupError) {
        this.fastify.log.error(
          { keyId, error: errMsg(cleanupError) },
          'MaaS: failed to revoke the new maas-api key after a failed rotation',
        );
      }
      throw error;
    }

    if (row.maas_key_id) {
      const revoked = await revokeInMaasApi(
        this.fastify,
        this.clients,
        userId,
        row.maas_key_id,
        this.tokens,
      );
      if (!revoked) {
        this.fastify.log.warn(
          { keyId, oldMaasKeyId: row.maas_key_id },
          'MaaS: previous maas-api key could not be revoked after rotation',
        );
      }
    }
    return { id: keyId, key: created.key, keyPrefix: prefix };
  }

  /**
   * Deactivate active MaaS keys past their expiration (subscription removed, maas-api key
   * revoked best-effort). Returns the number of keys cleaned.
   */
  async cleanupExpiredKeys(): Promise<number> {
    const expired = await this.fastify.dbUtils.queryMany<MaasApiKeyRow>(
      `SELECT * FROM api_keys
        WHERE backend_type = 'maas' AND is_active = true
          AND expires_at IS NOT NULL AND expires_at <= NOW()`,
    );
    let cleaned = 0;
    for (const row of expired) {
      try {
        const result = await this.clusterRevoke(row);
        await this.fastify.dbUtils.query(
          `UPDATE api_keys
              SET is_active = false, updated_at = CURRENT_TIMESTAMP,
                  maas_sync_state = $2, maas_last_error = $3
            WHERE id = $1`,
          [row.id, this.syncStateOf(result), result.error?.slice(0, 500) ?? null],
        );
        await this.audit(row.user_id, 'API_KEY_EXPIRED', row.id, {
          keyName: row.name,
          keyPrefix: row.key_prefix,
          cleanupReason: 'expired',
        });
        cleaned++;
      } catch (error) {
        this.fastify.log.error(
          { keyId: row.id, error: errMsg(error) },
          'MaaS: failed to clean up expired key',
        );
      }
    }
    return cleaned;
  }

  /**
   * A model was removed from a user's access. Cluster side for one key: the remaining models
   * are re-applied, or the whole key is revoked when none remain. Throws on cluster errors so
   * the caller leaves the database unchanged for that key.
   * @returns true when the key lost its last model (caller archives it)
   */
  async removeModelFromKey(
    row: Pick<MaasApiKeyRow, 'id' | 'user_id' | 'maas_key_id' | 'maas_subscription_name'>,
    modelId: string,
  ): Promise<boolean> {
    const remaining = (await this.loadKeyModels(row.id)).filter((m) => m.id !== modelId);
    if (remaining.length === 0) {
      await this.clusterRevoke(row, { throwOnSubscriptionError: true });
      await this.fastify.dbUtils.query(
        `UPDATE api_keys SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP),
                maas_sync_state = 'synced', maas_last_error = NULL WHERE id = $1`,
        [row.id],
      );
      return true;
    }
    const full = await this.fastify.dbUtils.queryOne<MaasApiKeyRow>(
      'SELECT * FROM api_keys WHERE id = $1',
      [row.id],
    );
    const modelTpm = full?.model_tpm_limit
      ? Object.fromEntries(Object.entries(full.model_tpm_limit).filter(([id]) => id !== modelId))
      : null;
    await this.applySubscription({
      keyId: row.id,
      userId: row.user_id,
      subName: this.subscriptionNameFor(row),
      models: remaining,
      tpm: full?.tpm_limit,
      modelTpm,
    });
    return false;
  }
}
