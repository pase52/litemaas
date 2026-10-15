import type { FastifyInstance } from 'fastify';
import { BaseService } from '../base.service.js';
import { withAdvisoryLock } from '../../utils/advisory-lock.utils.js';
import { upsertK8sObject, type K8sObject } from '../k8s/k8s-client.js';
import type { MaasClients } from './maas-clients.js';
import { revokeInMaasApi } from './maas-key.service.js';
import { MaasMigrationService } from './maas-migration.service.js';
import {
  LABEL_API_KEY_ID,
  MANAGED_SELECTOR,
  MAAS_AUTH_POLICY,
  MAAS_SUBSCRIPTION,
  buildAuthPolicy,
  buildSubscription,
  sanitizeLabelValue,
  subscriptionName,
  type MaasModelLimit,
  type MaasModelRefTarget,
} from './maas-resources.js';

/** pg advisory lock key shared by all LiteMaaS replicas ("MAAS" in ASCII) */
export const MAAS_RECONCILER_LOCK_ID = 0x4d414153;

/** Objects younger than this are never deleted as orphans (a key may still be mid-creation) */
export const ORPHAN_GRACE_MS = 120_000;

export interface ReconcileResult {
  /** False when another replica holds the lock */
  ran: boolean;
  policiesApplied: number;
  policiesDeleted: number;
  subscriptionsApplied: number;
  subscriptionsDeleted: number;
  keysMarkedSynced: number;
  keysFailed: number;
  /** Active keys past their expiration that were deactivated on this pass */
  keysExpired: number;
  /** Revoked / expired keys whose maas-api key could not be revoked yet (retried next pass) */
  maasApiRevokePending: number;
  /** LiteLLM -> MaaS migrations finished (grace elapsed) / still waiting on this pass */
  migrationsCompleted: number;
  migrationsPending: number;
  errors: string[];
  durationMs: number;
}

interface PolicyRow {
  user_id: string;
  username: string;
  maas_model_ref_name: string;
  maas_model_ref_namespace: string;
}

interface KeyRow {
  id: string;
  user_id: string;
  username: string;
  tpm_limit: number | null;
  model_tpm_limit: Record<string, number> | null;
  maas_key_id: string | null;
  maas_subscription_name: string | null;
  maas_sync_state: string | null;
  is_active: boolean;
  revoked_at: Date | null;
  archived_at: Date | null;
  expires_at: Date | null;
}

interface KeyModelRow {
  api_key_id: string;
  model_id: string;
  maas_model_ref_name: string;
  maas_model_ref_namespace: string;
}

function emptyResult(): ReconcileResult {
  return {
    ran: false,
    policiesApplied: 0,
    policiesDeleted: 0,
    subscriptionsApplied: 0,
    subscriptionsDeleted: 0,
    keysMarkedSynced: 0,
    keysFailed: 0,
    keysExpired: 0,
    maasApiRevokePending: 0,
    migrationsCompleted: 0,
    migrationsPending: 0,
    errors: [],
    durationMs: 0,
  };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function createdLongAgo(obj: K8sObject, now: number): boolean {
  const ts = obj.metadata.creationTimestamp;
  if (!ts) return true;
  const t = Date.parse(ts);
  return Number.isNaN(t) || now - t > ORPHAN_GRACE_MS;
}

/**
 * Converges the cluster to the database:
 *  - recomputes every user's MaaSAuthPolicy from active MaaS subscriptions
 *  - recomputes every active MaaS key's MaaSSubscription (models + TPM token limits)
 *  - deletes labeled (managed-by=litemaas) policies/subscriptions that have no desired state
 *  - retries keys flagged maas_sync_state pending/error
 *
 * Runs on an interval and on demand (POST /admin/maas/reconcile). A pg advisory lock makes
 * concurrent replicas safe: only one reconciles at a time.
 */
export class MaasReconcilerService extends BaseService {
  private readonly clients: MaasClients;
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(fastify: FastifyInstance, clients?: MaasClients) {
    super(fastify);
    const c = clients ?? fastify.maasClients;
    if (!c) throw new Error('MaasReconcilerService requires MaaS to be enabled');
    this.clients = c;
  }

  /** Start the periodic reconcile loop (idempotent) */
  start(): void {
    if (this.timer) return;
    const interval = this.clients.config.reconcileIntervalMs;
    const run = () =>
      this.reconcile().catch((error) =>
        this.fastify.log.error({ error }, 'MaaS reconcile loop failed'),
      );
    // First pass shortly after startup (lets the initial model sync land first)
    setTimeout(run, 30_000).unref?.();
    this.timer = setInterval(run, interval);
    this.timer.unref?.();
    this.fastify.log.info({ intervalMs: interval }, 'MaaS reconciler started');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Run one reconcile pass; `ran=false` when skipped (lock held elsewhere or already running) */
  async reconcile(): Promise<ReconcileResult> {
    if (this.running) return emptyResult();
    this.running = true;
    const started = Date.now();
    try {
      const outcome = await withAdvisoryLock(
        this.fastify.pg.pool,
        MAAS_RECONCILER_LOCK_ID,
        async () => this.runPass(),
        { blocking: false },
      );
      if (!outcome) {
        this.fastify.log.debug('MaaS reconcile skipped: lock held by another replica');
        return emptyResult();
      }
      outcome.durationMs = Date.now() - started;
      this.fastify.log.info({ result: outcome }, 'MaaS reconcile finished');
      return outcome;
    } finally {
      this.running = false;
    }
  }

  private async runPass(): Promise<ReconcileResult> {
    const result = emptyResult();
    result.ran = true;
    await this.reconcilePolicies(result);
    await this.reconcileSubscriptions(result);
    await this.reconcileMigrations(result);
    return result;
  }

  // ---------------------------------------------------------------- migrations

  /** Grace job: finish LiteLLM -> MaaS migrations whose grace period has elapsed */
  private async reconcileMigrations(result: ReconcileResult): Promise<void> {
    try {
      const grace = await new MaasMigrationService(
        this.fastify,
        this.clients,
      ).processExpiredGrace();
      result.migrationsCompleted = grace.completed;
      result.migrationsPending = grace.pending;
      result.errors.push(...grace.errors);
    } catch (error) {
      result.errors.push(`migrations: ${errMsg(error)}`);
      this.fastify.log.error({ error }, 'MaaS reconcile: migration grace pass failed');
    }
  }

  // ------------------------------------------------------------------ policies

  private async reconcilePolicies(result: ReconcileResult): Promise<void> {
    const { k8s, config } = this.clients;
    try {
      const rows = await this.fastify.dbUtils.queryMany<PolicyRow>(
        `SELECT DISTINCT u.id AS user_id, u.username,
                m.maas_model_ref_name, m.maas_model_ref_namespace
           FROM subscriptions s
           JOIN users u ON u.id = s.user_id
           JOIN models m ON m.id = s.model_id
          WHERE s.status = 'active'
            AND m.backend_type = 'maas'
            AND m.maas_model_ref_name IS NOT NULL
            AND m.maas_model_ref_namespace IS NOT NULL`,
      );

      const byUser = new Map<string, { username: string; models: MaasModelRefTarget[] }>();
      for (const r of rows) {
        const entry = byUser.get(r.user_id) ?? { username: r.username, models: [] };
        entry.models.push({ name: r.maas_model_ref_name, namespace: r.maas_model_ref_namespace });
        byUser.set(r.user_id, entry);
      }

      const existing = await k8s.list(MAAS_AUTH_POLICY, {
        namespace: config.namespace,
        labelSelector: MANAGED_SELECTOR,
      });
      const existingByName = new Map(existing.map((o) => [o.metadata.name, o]));
      const desiredNames = new Set<string>();

      for (const [userId, { username, models }] of byUser) {
        const desired = buildAuthPolicy({
          username,
          userId,
          namespace: config.namespace,
          models,
        });
        desiredNames.add(desired.metadata.name);
        try {
          const current = existingByName.get(desired.metadata.name);
          if (current && JSON.stringify(current.spec) === JSON.stringify(desired.spec)) continue;
          await upsertK8sObject(k8s, MAAS_AUTH_POLICY, desired, config.namespace);
          result.policiesApplied++;
        } catch (error) {
          result.errors.push(`policy ${desired.metadata.name}: ${errMsg(error)}`);
        }
      }

      for (const [name] of existingByName) {
        if (desiredNames.has(name)) continue;
        try {
          await k8s.delete(MAAS_AUTH_POLICY, name, config.namespace);
          result.policiesDeleted++;
        } catch (error) {
          result.errors.push(`policy ${name} delete: ${errMsg(error)}`);
        }
      }
    } catch (error) {
      result.errors.push(`policies: ${errMsg(error)}`);
      this.fastify.log.error({ error }, 'MaaS reconcile: policy pass failed');
    }
  }

  // ------------------------------------------------------------- subscriptions

  private async reconcileSubscriptions(result: ReconcileResult): Promise<void> {
    const { k8s, config } = this.clients;
    try {
      const keys = await this.fastify.dbUtils.queryMany<KeyRow>(
        `SELECT ak.id, ak.user_id, u.username, ak.tpm_limit, ak.model_tpm_limit, ak.maas_key_id,
                ak.maas_subscription_name, ak.maas_sync_state, ak.is_active, ak.revoked_at,
                ak.archived_at, ak.expires_at
           FROM api_keys ak
           JOIN users u ON u.id = ak.user_id
          WHERE ak.backend_type = 'maas'`,
      );
      const keyModels = await this.fastify.dbUtils.queryMany<KeyModelRow>(
        `SELECT akm.api_key_id, akm.model_id, m.maas_model_ref_name, m.maas_model_ref_namespace
           FROM api_key_models akm
           JOIN api_keys ak ON ak.id = akm.api_key_id AND ak.backend_type = 'maas'
           JOIN models m ON m.id = akm.model_id
          WHERE m.backend_type = 'maas'
            AND m.maas_model_ref_name IS NOT NULL
            AND m.maas_model_ref_namespace IS NOT NULL`,
      );
      const modelsByKey = new Map<string, KeyModelRow[]>();
      for (const km of keyModels) {
        const list = modelsByKey.get(km.api_key_id) ?? [];
        list.push(km);
        modelsByKey.set(km.api_key_id, list);
      }

      const existing = await k8s.list(MAAS_SUBSCRIPTION, {
        namespace: config.namespace,
        labelSelector: MANAGED_SELECTOR,
      });
      const existingByName = new Map(existing.map((o) => [o.metadata.name, o]));
      const desiredNames = new Set<string>();
      const now = Date.now();

      for (const key of keys) {
        const name = key.maas_subscription_name || subscriptionName(key.id);
        const models = modelsByKey.get(key.id) ?? [];

        // Expired but still flagged active (cleanup job did not run): deactivate, then fall
        // through as a not-live key so the subscription and the maas-api key are removed
        if (key.is_active && key.expires_at && new Date(key.expires_at).getTime() <= now) {
          try {
            await this.fastify.dbUtils.query(
              `UPDATE api_keys
                  SET is_active = false, updated_at = CURRENT_TIMESTAMP,
                      maas_sync_state = CASE WHEN maas_key_id IS NOT NULL THEN 'pending' ELSE maas_sync_state END
                WHERE id = $1 AND is_active = true`,
              [key.id],
            );
            key.is_active = false;
            if (key.maas_key_id) key.maas_sync_state = 'pending';
            result.keysExpired++;
          } catch (error) {
            result.errors.push(`key ${key.id} expiry: ${errMsg(error)}`);
          }
        }
        const live =
          key.is_active &&
          !key.revoked_at &&
          !key.archived_at &&
          (!key.expires_at || new Date(key.expires_at).getTime() > now) &&
          models.length > 0;

        try {
          if (live) {
            const limits: MaasModelLimit[] = models.map((m) => ({
              name: m.maas_model_ref_name,
              namespace: m.maas_model_ref_namespace,
              tpm: key.model_tpm_limit?.[m.model_id] ?? null,
            }));
            const desired = buildSubscription({
              apiKeyId: key.id,
              userId: key.user_id,
              username: key.username,
              namespace: config.namespace,
              models: limits,
              globalTpm: key.tpm_limit,
            });
            // Honour a name recorded at creation time
            desired.metadata.name = name;
            desiredNames.add(name);
            const current = existingByName.get(name);
            if (!current || JSON.stringify(current.spec) !== JSON.stringify(desired.spec)) {
              await upsertK8sObject(k8s, MAAS_SUBSCRIPTION, desired, config.namespace);
              result.subscriptionsApplied++;
            }
          } else if (existingByName.has(name)) {
            await k8s.delete(MAAS_SUBSCRIPTION, name, config.namespace);
            result.subscriptionsDeleted++;
          }

          if (
            key.maas_key_id &&
            (key.maas_sync_state === 'pending' || key.maas_sync_state === 'error')
          ) {
            if (!live && !(await this.revokeInMaasApi(key))) {
              // Subscription is gone (the key cannot authorize requests); keep retrying the
              // maas-api revoke on later passes, e.g. after the owner logs in again
              result.maasApiRevokePending++;
              await this.fastify.dbUtils.query(
                `UPDATE api_keys SET maas_sync_state = 'pending', maas_last_error = $2,
                        updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
                [key.id, 'maas-api key not revoked yet (no usable token)'],
              );
              continue;
            }
            await this.fastify.dbUtils.query(
              `UPDATE api_keys SET maas_sync_state = 'synced', maas_last_error = NULL,
                      updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
              [key.id],
            );
            result.keysMarkedSynced++;
          }
        } catch (error) {
          result.keysFailed++;
          result.errors.push(`subscription ${name}: ${errMsg(error)}`);
          await this.fastify.dbUtils
            .query(
              `UPDATE api_keys SET maas_sync_state = 'error', maas_last_error = $2,
                      updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
              [key.id, errMsg(error).slice(0, 500)],
            )
            .catch(() => undefined);
        }
      }

      // Orphans: labeled subscriptions that no LiteMaaS key maps to
      const knownKeyIds = new Set(keys.map((k) => sanitizeLabelValue(k.id)));
      for (const [name, obj] of existingByName) {
        if (desiredNames.has(name)) continue;
        const labelKeyId = obj.metadata.labels?.[LABEL_API_KEY_ID];
        const dbKnown = labelKeyId ? knownKeyIds.has(labelKeyId) : false;
        // Known-but-not-live keys were handled (and deleted) in the loop above
        if (dbKnown) continue;
        if (!createdLongAgo(obj, now)) continue;
        try {
          await k8s.delete(MAAS_SUBSCRIPTION, name, config.namespace);
          result.subscriptionsDeleted++;
        } catch (error) {
          result.errors.push(`subscription ${name} delete: ${errMsg(error)}`);
        }
      }
    } catch (error) {
      result.errors.push(`subscriptions: ${errMsg(error)}`);
      this.fastify.log.error({ error }, 'MaaS reconcile: subscription pass failed');
    }
  }

  /**
   * Revoke the maas-api key of a no-longer-live key: the owner's stored token first, then the
   * service account token. Returns false when neither worked (retried on the next pass).
   */
  private async revokeInMaasApi(key: KeyRow): Promise<boolean> {
    if (!key.maas_key_id) return true;
    return revokeInMaasApi(this.fastify, this.clients, key.user_id, key.maas_key_id);
  }
}
