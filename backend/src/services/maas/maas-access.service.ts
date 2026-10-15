import type { FastifyInstance } from 'fastify';
import { BaseService } from '../base.service.js';
import { applyK8sObject, type K8sObject } from '../k8s/k8s-client.js';
import type { MaasClients } from './maas-clients.js';
import {
  LABEL_USER_ID,
  managedSelector,
  foreignObjectReason,
  MAAS_AUTH_POLICY,
  MAAS_SUBSCRIPTION,
  authPolicyName,
  buildAuthPolicy,
  sanitizeLabelValue,
  type MaasModelRefTarget,
} from './maas-resources.js';

export interface SyncPolicyResult {
  /** `unchanged`: the cluster already held the desired policy, nothing was written */
  action: 'upserted' | 'unchanged' | 'deleted' | 'noop';
  models: number;
  policyName?: string;
}

export interface RevokeResult {
  /** False when the model is not a MaaS model (nothing to do) */
  applicable: boolean;
  /** True when the cluster no longer grants the model to the user */
  revoked: boolean;
  error?: string;
}

interface DesiredModelRow {
  maas_model_ref_name: string;
  maas_model_ref_namespace: string;
}

/**
 * Serialises async work per key inside this process (the DB-derived desired state is
 * recomputed inside each task, so the last task always wins with the freshest data).
 */
class KeyedMutex {
  private tails = new Map<string, Promise<unknown>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.tails.set(key, tail);
    try {
      return await next;
    } finally {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

/**
 * Keeps the per-user MaaSAuthPolicy `litemaas-<username>` in sync with the user's active
 * MaaS subscriptions.
 *
 * The policy is always recomputed from the database (full desired state), never patched
 * incrementally, so repeated or out-of-order calls converge. Access is revoked on the
 * cluster BEFORE the database row changes (see removeModelForUser); grants happen after the
 * database commit. Cluster failures never roll back the database; the reconciler converges.
 */
export class MaasAccessService extends BaseService {
  private readonly clients: MaasClients;
  private static readonly mutex = new KeyedMutex();

  constructor(fastify: FastifyInstance, clients?: MaasClients) {
    super(fastify);
    const c = clients ?? fastify.maasClients;
    if (!c) throw new Error('MaasAccessService requires MaaS to be enabled');
    this.clients = c;
  }

  /** True when the model row exists and is served by MaaS */
  async isMaasModel(modelId: string): Promise<boolean> {
    const row = await this.fastify.dbUtils.queryOne<{ backend_type: string }>(
      'SELECT backend_type FROM models WHERE id = $1',
      [modelId],
    );
    return row?.backend_type === 'maas';
  }

  /** Active MaaS models of a user (optionally excluding one that is being revoked) */
  async getDesiredModels(userId: string, excludeModelId?: string): Promise<MaasModelRefTarget[]> {
    const rows = await this.fastify.dbUtils.queryMany<DesiredModelRow>(
      `SELECT DISTINCT m.maas_model_ref_name, m.maas_model_ref_namespace
         FROM subscriptions s
         JOIN models m ON m.id = s.model_id
        WHERE s.user_id = $1
          AND s.status = 'active'
          AND m.backend_type = 'maas'
          AND m.maas_model_ref_name IS NOT NULL
          AND m.maas_model_ref_namespace IS NOT NULL
          AND ($2::text IS NULL OR m.id <> $2)`,
      [userId, excludeModelId ?? null],
    );
    return rows.map((r) => ({
      name: r.maas_model_ref_name,
      namespace: r.maas_model_ref_namespace,
    }));
  }

  private async getUsername(userId: string): Promise<string | null> {
    const row = await this.fastify.dbUtils.queryOne<{ username: string }>(
      'SELECT username FROM users WHERE id = $1',
      [userId],
    );
    return row?.username ?? null;
  }

  /**
   * Recompute the full desired MaaSAuthPolicy for a user from the database and apply it.
   * No active MaaS subscription means the policy is deleted.
   * Throws on cluster errors; callers decide whether that is fatal.
   */
  async syncUserAuthPolicy(
    userId: string,
    options: { excludeModelId?: string } = {},
  ): Promise<SyncPolicyResult> {
    return MaasAccessService.mutex.run(userId, async () => {
      const username = await this.getUsername(userId);
      if (!username) {
        this.fastify.log.warn({ userId }, 'MaaS: cannot sync auth policy, user not found');
        return { action: 'noop' as const, models: 0 };
      }

      const { k8s, config } = this.clients;
      const models = await this.getDesiredModels(userId, options.excludeModelId);
      const name = authPolicyName(username);

      if (models.length === 0) {
        const existing = await k8s.get(MAAS_AUTH_POLICY, name, config.namespace);
        const refusal = existing ? foreignObjectReason(existing, userId) : null;
        if (refusal) {
          this.fastify.log.error(
            { userId, policy: name, refusal },
            'MaaS: auth policy is not managed by LiteMaaS - not deleting',
          );
          return { action: 'noop' as const, models: 0 };
        }
        const deleted = existing
          ? await k8s.delete(MAAS_AUTH_POLICY, name, config.namespace)
          : false;
        this.fastify.log.info({ userId, policy: name, deleted }, 'MaaS auth policy removed');
        return { action: deleted ? ('deleted' as const) : ('noop' as const), models: 0 };
      }

      const policy = buildAuthPolicy({
        username,
        userId,
        namespace: config.namespace,
        models,
      });
      const applied = await applyK8sObject(
        k8s,
        MAAS_AUTH_POLICY,
        policy,
        config.namespace,
        (existing) => foreignObjectReason(existing, userId),
        { skipIfUnchanged: true },
      );
      if (applied.action === 'unchanged') {
        return { action: 'unchanged' as const, models: models.length, policyName: name };
      }
      this.fastify.log.info(
        { userId, policy: name, models: models.length },
        'MaaS auth policy applied',
      );
      return { action: 'upserted' as const, models: models.length, policyName: name };
    });
  }

  /**
   * Grant hook: call after the subscription became (or may have become) active.
   * Only acts for MaaS models. Never throws: failures are logged and left to the reconciler.
   */
  async grantModelToUser(userId: string, modelId: string): Promise<SyncPolicyResult | null> {
    try {
      if (!(await this.isMaasModel(modelId))) return null;
      return await this.syncUserAuthPolicy(userId);
    } catch (error) {
      this.fastify.log.error(
        { error, userId, modelId },
        'MaaS: failed to apply auth policy after grant - reconciler will retry',
      );
      return null;
    }
  }

  /**
   * Revocation-first hook: call BEFORE the subscription row stops being active.
   *
   * 1. Rewrites the user's MaaSAuthPolicy without the model.
   * 2. Removes the model from every MaaSSubscription labeled with the user (per-key
   *    subscriptions); a subscription left without models is deleted.
   *
   * Never throws. On a cluster failure the user's MaaS keys are marked
   * maas_sync_state='pending' so the reconciler retries, and the result reports revoked=false.
   */
  async removeModelForUser(userId: string, modelId: string): Promise<RevokeResult> {
    let applicable: boolean;
    try {
      applicable = await this.isMaasModel(modelId);
    } catch (error) {
      this.fastify.log.error({ error, userId, modelId }, 'MaaS: could not resolve model backend');
      return { applicable: false, revoked: false, error: String(error) };
    }
    if (!applicable) return { applicable: false, revoked: true };

    try {
      await this.syncUserAuthPolicy(userId, { excludeModelId: modelId });
      await this.removeModelFromUserSubscriptions(userId, modelId);
      return { applicable: true, revoked: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.fastify.log.error(
        { error, userId, modelId },
        'MaaS: revocation failed on the cluster - marking keys pending for reconciler retry',
      );
      try {
        await this.fastify.dbUtils.query(
          `UPDATE api_keys
              SET maas_sync_state = 'pending', maas_last_error = $2, updated_at = CURRENT_TIMESTAMP
            WHERE user_id = $1 AND backend_type = 'maas' AND is_active = true`,
          [userId, message.slice(0, 500)],
        );
      } catch (dbError) {
        this.fastify.log.error({ dbError, userId }, 'MaaS: could not mark keys pending');
      }
      return { applicable: true, revoked: false, error: message };
    }
  }

  /** Drop a model from all per-key MaaSSubscriptions owned by the user */
  private async removeModelFromUserSubscriptions(userId: string, modelId: string): Promise<void> {
    const row = await this.fastify.dbUtils.queryOne<DesiredModelRow>(
      'SELECT maas_model_ref_name, maas_model_ref_namespace FROM models WHERE id = $1',
      [modelId],
    );
    if (!row?.maas_model_ref_name) return;

    const { k8s, config } = this.clients;
    const subs = await k8s.list(MAAS_SUBSCRIPTION, {
      namespace: config.namespace,
      labelSelector: `${managedSelector()},${LABEL_USER_ID}=${sanitizeLabelValue(userId)}`,
    });

    for (const sub of subs) {
      const refs: Array<Record<string, unknown>> = sub.spec?.modelRefs ?? [];
      const kept = refs.filter(
        (r) =>
          !(
            r.name === row.maas_model_ref_name &&
            (r.namespace ?? config.namespace) === row.maas_model_ref_namespace
          ),
      );
      if (kept.length === refs.length) continue;

      if (kept.length === 0) {
        await k8s.delete(MAAS_SUBSCRIPTION, sub.metadata.name, config.namespace);
        this.fastify.log.info(
          { subscription: sub.metadata.name, modelId },
          'MaaS subscription deleted (last model revoked)',
        );
      } else {
        const next: K8sObject = {
          ...sub,
          spec: { ...sub.spec, modelRefs: kept },
        };
        await k8s.replace(MAAS_SUBSCRIPTION, sub.metadata.name, next, config.namespace);
        this.fastify.log.info(
          { subscription: sub.metadata.name, modelId },
          'MaaS subscription model revoked',
        );
      }
    }
  }
}
