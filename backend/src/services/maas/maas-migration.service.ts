import type { FastifyInstance } from 'fastify';
import { BaseService } from '../base.service.js';
import { ApplicationError } from '../../utils/errors.js';
import { ApiKeyService } from '../api-key.service.js';
import { LiteLLMService } from '../litellm.service.js';
import { ModelSyncService } from '../model-sync.service.js';
import { NotificationService } from '../notification.service.js';
import type { MaasClients } from './maas-clients.js';
import { MaasAccessService } from './maas-access.service.js';
import { MAAS_MODEL_REF, parseModelRef, type ParsedModelRef } from './maas-resources.js';
import type { DatabaseClient } from '../../types/common.types.js';
import { MAAS_PROVIDER } from './maas-model-sync.service.js';

/** models.migration_state values */
export type MigrationState = 'migrating' | 'completed';

export interface MigrateToMaasRequest {
  /** LiteLLM model being migrated */
  modelId: string;
  /** MaaSModelRef that now serves the model */
  maasModelRef: { name: string; namespace: string };
  /** Days of grace before LiteLLM access is removed (default MAAS_MIGRATION_GRACE_DAYS) */
  graceDays?: number;
  /** Admin performing the migration (audit / status history) */
  adminUserId: string;
}

export interface MigrateToMaasResult {
  oldModelId: string;
  newModelId: string;
  /** True when a new MaaS model row was created, false when an existing (synced) row was reused */
  created: boolean;
  graceUntil: string;
  subscriptionsCopied: number;
  usersNotified: number;
  /** Users whose MaaSAuthPolicy could not be applied now (reconciler converges them) */
  policyFailures: number;
}

export interface GraceJobResult {
  /** Models whose grace period elapsed and are now completed */
  completed: number;
  /** Models still waiting (LiteLLM keys could not be updated yet) */
  pending: number;
  errors: string[];
}

export const MAX_GRACE_DAYS = 365;

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Per-model migration LiteLLM -> MaaS.
 *
 *  1. migrate(): copies the LiteLLM model row to a MaaS model row (or reuses the synced one),
 *     copies active subscriptions, blocks NEW subscriptions on the old model
 *     (migration_state='migrating'), applies MaaSAuthPolicies and notifies affected users.
 *     LiteLLM access keeps working until migration_grace_until.
 *  2. processExpiredGrace(): run by the reconciler. After the grace period it removes the model
 *     from users' LiteLLM keys (LiteLLM first), deactivates the old subscriptions and marks the
 *     old row unavailable with migration_state='completed'. A model whose keys could not all be
 *     updated stays 'migrating' and is retried on the next pass.
 */
export class MaasMigrationService extends BaseService {
  private readonly clients: MaasClients;
  private access?: MaasAccessService;
  private apiKeys?: ApiKeyService;
  private notifications?: NotificationService;

  constructor(fastify: FastifyInstance, clients?: MaasClients) {
    super(fastify);
    const c = clients ?? fastify.maasClients;
    if (!c) throw new Error('MaasMigrationService requires MaaS to be enabled');
    this.clients = c;
  }

  private getAccess(): MaasAccessService {
    return (this.access ??= new MaasAccessService(this.fastify, this.clients));
  }
  private getApiKeys(): ApiKeyService {
    return (this.apiKeys ??= new ApiKeyService(this.fastify, new LiteLLMService(this.fastify)));
  }
  private getNotifications(): NotificationService {
    return (this.notifications ??= new NotificationService(this.fastify));
  }

  // ---------------------------------------------------------------- migrate

  async migrate(request: MigrateToMaasRequest): Promise<MigrateToMaasResult> {
    const { modelId, adminUserId } = request;
    const graceDays = request.graceDays ?? this.clients.config.migrationGraceDays;
    if (!Number.isInteger(graceDays) || graceDays < 1 || graceDays > MAX_GRACE_DAYS) {
      throw ApplicationError.validation(
        'Invalid grace period',
        'graceDays',
        graceDays,
        `graceDays must be an integer between 1 and ${MAX_GRACE_DAYS}`,
      );
    }

    // The ref must exist on the cluster (also yields the endpoint / phase)
    const ref = await this.loadRef(request.maasModelRef.name, request.maasModelRef.namespace);
    const graceUntil = new Date(Date.now() + graceDays * 24 * 60 * 60 * 1000);

    const outcome = await this.fastify.dbUtils.withTransaction(async (client) => {
      const oldRes = await client.query<any>('SELECT * FROM models WHERE id = $1 FOR UPDATE', [
        modelId,
      ]);
      const old = oldRes.rows[0];
      if (!old) throw ApplicationError.notFound('Model', modelId);
      if (old.backend_type !== 'litellm') {
        throw ApplicationError.validation(
          'Only LiteLLM models can be migrated to MaaS',
          'modelId',
          modelId,
          'This model is already served by MaaS',
        );
      }
      if (old.migration_state) {
        throw ApplicationError.alreadyExists(
          'Model migration',
          'modelId',
          modelId,
          `Migration is already ${old.migration_state}`,
        );
      }

      const targetRes = await client.query<any>('SELECT * FROM models WHERE id = $1 FOR UPDATE', [
        ref.id,
      ]);
      const existing = targetRes.rows[0];
      if (existing) {
        if (existing.backend_type !== 'maas') {
          throw ApplicationError.validation(
            'Target model id collides with a non-MaaS model',
            'maasModelRef',
            ref.id,
          );
        }
        if (existing.migrated_from_litellm_id && existing.migrated_from_litellm_id !== old.id) {
          throw ApplicationError.alreadyExists(
            'MaaS model migration source',
            'maasModelRef',
            ref.id,
            `Already the migration target of ${existing.migrated_from_litellm_id}`,
          );
        }
      }

      const created = !existing;
      if (created) {
        await this.insertTarget(client, old, ref);
      } else {
        await this.fillTarget(client, old, existing);
      }

      // Copy active subscriptions to the new model
      const subs = await client.query<any>(
        `SELECT id, user_id, team_id, quota_requests, quota_tokens, expires_at
           FROM subscriptions WHERE model_id = $1 AND status = 'active'`,
        [old.id],
      );
      const userIds: string[] = [];
      for (const s of subs.rows) {
        const reason = `Migrated from LiteLLM model ${old.id}`;
        const prev = await client.query<any>(
          'SELECT id, status FROM subscriptions WHERE user_id = $1 AND model_id = $2',
          [s.user_id, ref.id],
        );
        let subscriptionId: string;
        let oldStatus: string | null = null;
        if (prev.rows[0]) {
          if (prev.rows[0].status === 'active') {
            userIds.push(s.user_id);
            continue;
          }
          subscriptionId = prev.rows[0].id;
          oldStatus = prev.rows[0].status;
          await client.query<any>(
            `UPDATE subscriptions
                SET status = 'active', status_reason = $2, status_changed_at = CURRENT_TIMESTAMP,
                    status_changed_by = $3, updated_at = CURRENT_TIMESTAMP
              WHERE id = $1`,
            [subscriptionId, reason, adminUserId],
          );
        } else {
          const ins = await client.query<any>(
            `INSERT INTO subscriptions (
               user_id, model_id, team_id, status, quota_requests, quota_tokens, expires_at,
               status_reason, status_changed_at, status_changed_by
             ) VALUES ($1, $2, $3, 'active', $4, $5, $6, $7, CURRENT_TIMESTAMP, $8)
             RETURNING id`,
            [
              s.user_id,
              ref.id,
              s.team_id,
              s.quota_requests,
              s.quota_tokens,
              s.expires_at,
              reason,
              adminUserId,
            ],
          );
          subscriptionId = ins.rows[0].id;
        }
        await client.query<any>(
          `INSERT INTO subscription_status_history
             (subscription_id, old_status, new_status, reason, changed_by)
           VALUES ($1, $2, 'active', $3, $4)`,
          [subscriptionId, oldStatus, reason, adminUserId],
        );
        userIds.push(s.user_id);
      }

      await client.query<any>(
        `UPDATE models
            SET migration_state = 'migrating', migration_grace_until = $2,
                updated_at = CURRENT_TIMESTAMP
          WHERE id = $1`,
        [old.id, graceUntil],
      );

      await client.query<any>(
        `INSERT INTO audit_logs (user_id, action, resource_type, resource_id, metadata, success)
         VALUES ($1, 'MODEL_MIGRATE_TO_MAAS', 'MODEL', $2, $3, true)`,
        [
          adminUserId,
          old.id,
          JSON.stringify({
            newModelId: ref.id,
            graceUntil: graceUntil.toISOString(),
            subscriptionsCopied: userIds.length,
            created,
          }),
        ],
      );

      return { created, userIds };
    });

    // Cluster + notification work happens after the commit and never fails the migration
    let policyFailures = 0;
    for (const userId of outcome.userIds) {
      const res = await this.getAccess().grantModelToUser(userId, ref.id);
      if (!res) policyFailures++;
    }
    try {
      await this.getNotifications().notifyUsersModelMigration(
        modelId,
        ref.id,
        outcome.userIds,
        graceUntil,
      );
    } catch (error) {
      this.fastify.log.warn({ error: errMsg(error), modelId }, 'Migration notification failed');
    }

    this.fastify.log.info(
      { oldModelId: modelId, newModelId: ref.id, users: outcome.userIds.length },
      'Model migration to MaaS started',
    );

    return {
      oldModelId: modelId,
      newModelId: ref.id,
      created: outcome.created,
      graceUntil: graceUntil.toISOString(),
      subscriptionsCopied: outcome.userIds.length,
      usersNotified: outcome.userIds.length,
      policyFailures,
    };
  }

  private async loadRef(name: string, namespace: string): Promise<ParsedModelRef> {
    let obj;
    try {
      obj = await this.clients.k8s.get(MAAS_MODEL_REF, name, namespace);
    } catch (error) {
      throw ApplicationError.maasError(
        'Failed to read MaaSModelRef',
        (error as { status?: number }).status,
        errMsg(error),
      );
    }
    if (!obj) {
      throw ApplicationError.notFound(
        'MaaSModelRef',
        `${namespace}/${name}`,
        'Check the namespace/name or run a MaaS model sync',
      );
    }
    return parseModelRef(obj);
  }

  /** Copy the LiteLLM row into a new MaaS row (keeps the display name, pricing and flags) */
  private async insertTarget(
    client: DatabaseClient,
    old: Record<string, any>,
    ref: ParsedModelRef,
  ): Promise<void> {
    const available = ref.phase === 'Ready';
    await client.query<any>(
      `INSERT INTO models (
         id, name, provider, description, category, context_length,
         input_cost_per_token, output_cost_per_token,
         supports_vision, supports_function_calling, supports_tool_choice,
         supports_parallel_function_calling, supports_streaming, features,
         availability, version, metadata, max_tokens, restricted_access,
         backend_model_name, backend_type, maas_model_ref_name, maas_model_ref_namespace,
         maas_endpoint, maas_phase, migrated_from_litellm_id
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19,
         $20, 'maas', $21, $22, $23, $24, $25
       )`,
      [
        ref.id,
        old.name,
        MAAS_PROVIDER,
        old.description ?? ref.description ?? null,
        old.category ?? 'Language Model',
        old.context_length ?? null,
        old.input_cost_per_token ?? null,
        old.output_cost_per_token ?? null,
        old.supports_vision ?? false,
        old.supports_function_calling ?? false,
        old.supports_tool_choice ?? false,
        old.supports_parallel_function_calling ?? false,
        old.supports_streaming ?? true,
        old.features ?? ['chat'],
        available ? 'available' : 'unavailable',
        old.version ?? '1.0',
        JSON.stringify({ maas_model_ref: ref, migrated_from: old.id }),
        old.max_tokens ?? null,
        old.restricted_access ?? false,
        ref.name,
        ref.name,
        ref.namespace,
        ref.endpoint ?? null,
        ref.phase,
        old.id,
      ],
    );
  }

  /** Reuse a synced MaaS row: only fill what the admin has not set; never lower restrictions */
  private async fillTarget(
    client: DatabaseClient,
    old: Record<string, any>,
    existing: Record<string, any>,
  ): Promise<void> {
    await client.query<any>(
      `UPDATE models SET
         migrated_from_litellm_id = $2,
         description = COALESCE(NULLIF(description, ''), $3),
         context_length = COALESCE(context_length, $4),
         input_cost_per_token = COALESCE(input_cost_per_token, $5),
         output_cost_per_token = COALESCE(output_cost_per_token, $6),
         max_tokens = COALESCE(max_tokens, $7),
         restricted_access = (COALESCE(restricted_access, false) OR $8),
         metadata = COALESCE(metadata, '{}'::jsonb) || $9::jsonb,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [
        existing.id,
        old.id,
        old.description ?? null,
        old.context_length ?? null,
        old.input_cost_per_token ?? null,
        old.output_cost_per_token ?? null,
        old.max_tokens ?? null,
        old.restricted_access === true,
        JSON.stringify({ migrated_from: old.id }),
      ],
    );
  }

  // ---------------------------------------------------------------- grace job

  /** Finish migrations whose grace period has elapsed (reconciler hook; safe to re-run) */
  async processExpiredGrace(now: Date = new Date()): Promise<GraceJobResult> {
    const result: GraceJobResult = { completed: 0, pending: 0, errors: [] };
    const due = await this.fastify.dbUtils.queryMany<{ id: string }>(
      `SELECT id FROM models
        WHERE backend_type = 'litellm' AND migration_state = 'migrating'
          AND migration_grace_until IS NOT NULL AND migration_grace_until <= $1`,
      [now],
    );

    for (const { id } of due) {
      try {
        const done = await this.completeMigration(id);
        if (done) result.completed++;
        else result.pending++;
      } catch (error) {
        result.pending++;
        result.errors.push(`migration ${id}: ${errMsg(error)}`);
        this.fastify.log.error({ error, modelId: id }, 'Model migration completion failed');
      }
    }
    return result;
  }

  /** Returns false when LiteLLM keys could not all be updated (retried later) */
  private async completeMigration(modelId: string): Promise<boolean> {
    const holders = await this.fastify.dbUtils.queryMany<{ user_id: string }>(
      `SELECT DISTINCT ak.user_id
         FROM api_keys ak
         JOIN api_key_models akm ON akm.api_key_id = ak.id
        WHERE akm.model_id = $1 AND ak.is_active = true
          AND COALESCE(ak.backend_type, 'litellm') = 'litellm'`,
      [modelId],
    );

    // LiteLLM first: removeModelFromUserApiKeys updates LiteLLM before touching the database
    // and swallows per-key failures, so verify afterwards that nothing is left.
    for (const { user_id } of holders) {
      await this.getApiKeys().removeModelFromUserApiKeys(user_id, modelId);
    }
    const remaining = await this.fastify.dbUtils.queryOne<{ count: string }>(
      `SELECT COUNT(*) AS count
         FROM api_key_models akm
         JOIN api_keys ak ON ak.id = akm.api_key_id
        WHERE akm.model_id = $1 AND ak.is_active = true
          AND COALESCE(ak.backend_type, 'litellm') = 'litellm'`,
      [modelId],
    );
    if (parseInt(remaining?.count ?? '0', 10) > 0) {
      this.fastify.log.warn(
        { modelId, remaining: remaining?.count },
        'Migration grace elapsed but LiteLLM keys still reference the model - will retry',
      );
      return false;
    }

    // Marks the row unavailable and cascades (subscriptions inactive, associations removed)
    const cascade = await new ModelSyncService(this.fastify).markModelUnavailable(modelId);
    await this.fastify.dbUtils.query(
      `UPDATE subscriptions SET status = 'inactive', updated_at = CURRENT_TIMESTAMP
        WHERE model_id = $1 AND status = 'active'`,
      [modelId],
    );
    await this.fastify.dbUtils.query(
      `UPDATE models
          SET availability = 'unavailable', migration_state = 'completed',
              updated_at = CURRENT_TIMESTAMP
        WHERE id = $1`,
      [modelId],
    );
    await this.fastify.dbUtils.query(
      `INSERT INTO audit_logs (action, resource_type, resource_id, metadata, success)
       VALUES ('MODEL_MIGRATION_COMPLETED', 'MODEL', $1, $2, true)`,
      [modelId, JSON.stringify({ cascade, usersUpdated: holders.length })],
    );
    this.fastify.log.info({ modelId, cascade }, 'Model migration to MaaS completed');
    return true;
  }
}
