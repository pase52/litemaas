import type { FastifyInstance } from 'fastify';
import { BaseService } from '../base.service.js';
import { withAdvisoryLock } from '../../utils/advisory-lock.utils.js';
import { applyK8sObject, k8sObjectMatches, type K8sObject } from '../k8s/k8s-client.js';
import type { MaasClients } from './maas-clients.js';
import { MaasAccessService } from './maas-access.service.js';
import { revokeInMaasApi } from './maas-key.service.js';
import { MaasMigrationService } from './maas-migration.service.js';
import {
  LABEL_API_KEY_ID,
  LABEL_USER_ID,
  managedSelector,
  foreignObjectReason,
  MAAS_AUTH_POLICY,
  MAAS_SUBSCRIPTION,
  authPolicyName,
  buildAuthPolicy,
  buildSubscription,
  sanitizeLabelValue,
  subscriptionName,
  type MaasModelRefTarget,
} from './maas-resources.js';

/** pg advisory lock key shared by all LiteMaaS replicas ("MAAS" in ASCII) */
export const MAAS_RECONCILER_LOCK_ID = 0x4d414153;

/** Objects younger than this are never deleted as orphans (a key may still be mid-creation) */
export const ORPHAN_GRACE_MS = 120_000;
/** A pending key row without maas_key_id older than this is an abandoned creation (crash) */
export const ABANDONED_CREATE_GRACE_MS = 10 * 60_000;

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
  maas_pending_revoke_ids: string[] | null;
  is_active: boolean;
  revoked_at: Date | null;
  archived_at: Date | null;
  expires_at: Date | null;
  created_at?: Date | string | null;
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
  private initialTimer?: NodeJS.Timeout;
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
    this.initialTimer = setTimeout(run, 30_000);
    this.initialTimer.unref?.();
    this.timer = setInterval(run, interval);
    this.timer.unref?.();
    this.fastify.log.info({ intervalMs: interval }, 'MaaS reconciler started');
  }

  stop(): void {
    if (this.initialTimer) clearTimeout(this.initialTimer);
    if (this.timer) clearInterval(this.timer);
    this.initialTimer = undefined;
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

  /** Active MaaS (user, model) pairs; optionally for a single user */
  private async loadPolicyRows(userId?: string): Promise<PolicyRow[]> {
    return this.fastify.dbUtils.queryMany<PolicyRow>(
      `SELECT DISTINCT u.id AS user_id, u.username,
              m.maas_model_ref_name, m.maas_model_ref_namespace
         FROM subscriptions s
         JOIN users u ON u.id = s.user_id
         JOIN models m ON m.id = s.model_id
        WHERE s.status = 'active'
          AND m.backend_type = 'maas'
          AND m.maas_model_ref_name IS NOT NULL
          AND m.maas_model_ref_namespace IS NOT NULL
          ${userId ? 'AND s.user_id = $1' : ''}`,
      userId ? [userId] : [],
    );
  }

  /**
   * Re-check before deleting an apparently orphaned policy: true when the labeled user still
   * has active MaaS subscriptions AND the policy carries that user's current name (a renamed
   * user leaves an old-name policy behind, which must still go).
   */
  private async policyStillDesired(userId: string, policyName: string): Promise<boolean> {
    const fresh = await this.loadPolicyRows(userId);
    return fresh.length > 0 && authPolicyName(fresh[0].username) === policyName;
  }

  /**
   * The pass works on a snapshot taken before slow cluster calls, while users and admins keep
   * changing keys. Right before writing a subscription the key is re-read: null when it is no
   * longer live (or has no entitled model left), otherwise the fresh row and its models, so
   * the object written reflects the current TPM limits, model set, expiry and owner name
   * rather than the stale snapshot.
   */
  private async loadLiveKey(keyId: string): Promise<{ key: KeyRow; models: KeyModelRow[] } | null> {
    const key = await this.fastify.dbUtils.queryOne<KeyRow & { live: boolean }>(
      `SELECT ak.id, ak.user_id, u.username, ak.tpm_limit, ak.model_tpm_limit, ak.maas_key_id,
              ak.maas_subscription_name, ak.maas_sync_state, ak.maas_pending_revoke_ids,
              ak.is_active, ak.revoked_at, ak.archived_at, ak.expires_at, ak.created_at,
              (ak.is_active AND ak.revoked_at IS NULL AND ak.archived_at IS NULL
               AND (ak.expires_at IS NULL OR ak.expires_at > CURRENT_TIMESTAMP)) AS live
         FROM api_keys ak
         JOIN users u ON u.id = ak.user_id
        WHERE ak.id = $1 AND ak.backend_type = 'maas'`,
      [keyId],
    );
    if (!key?.live) return null;
    const models = await this.fastify.dbUtils.queryMany<KeyModelRow>(
      `SELECT akm.api_key_id, akm.model_id, m.maas_model_ref_name, m.maas_model_ref_namespace
         FROM api_key_models akm
         JOIN models m ON m.id = akm.model_id
        WHERE akm.api_key_id = $1
          AND m.backend_type = 'maas'
          AND m.maas_model_ref_name IS NOT NULL
          AND m.maas_model_ref_namespace IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM subscriptions s
             WHERE s.user_id = $2 AND s.model_id = akm.model_id AND s.status = 'active'
          )`,
      [keyId, key.user_id],
    );
    if (models.length === 0) return null;
    return { key, models };
  }

  /** Desired MaaSSubscription of a key (models + TPM token limits), under the recorded name */
  private buildKeySubscription(key: KeyRow, models: KeyModelRow[], name: string): K8sObject {
    const desired = buildSubscription({
      apiKeyId: key.id,
      userId: key.user_id,
      username: key.username,
      namespace: this.clients.config.namespace,
      models: models.map((m) => ({
        name: m.maas_model_ref_name,
        namespace: m.maas_model_ref_namespace,
        tpm: key.model_tpm_limit?.[m.model_id] ?? null,
      })),
      globalTpm: key.tpm_limit,
    });
    // Honour a name recorded at creation time
    desired.metadata.name = name;
    return desired;
  }

  // ------------------------------------------------------------------ policies

  private async reconcilePolicies(result: ReconcileResult): Promise<void> {
    const { k8s, config } = this.clients;
    try {
      const rows = await this.loadPolicyRows();

      const byUser = new Map<string, { username: string; models: MaasModelRefTarget[] }>();
      for (const r of rows) {
        const entry = byUser.get(r.user_id) ?? { username: r.username, models: [] };
        entry.models.push({ name: r.maas_model_ref_name, namespace: r.maas_model_ref_namespace });
        byUser.set(r.user_id, entry);
      }

      const existing = await k8s.list(MAAS_AUTH_POLICY, {
        namespace: config.namespace,
        labelSelector: managedSelector(),
      });
      const existingByName = new Map(existing.map((o) => [o.metadata.name, o]));
      const desiredNames = new Set<string>();
      const now = Date.now();
      const access = new MaasAccessService(this.fastify, this.clients);

      for (const [userId, { username, models }] of byUser) {
        const snapshot = buildAuthPolicy({
          username,
          userId,
          namespace: config.namespace,
          models,
        });
        desiredNames.add(snapshot.metadata.name);
        try {
          const current = existingByName.get(snapshot.metadata.name);
          if (current && k8sObjectMatches(snapshot, current)) continue;
          // Snapshot and cluster differ: recompute from the database right now (under the
          // per-user mutex), so a grant, revocation or rename that landed after the snapshot
          // is applied rather than undone by stale data
          const applied = await access.syncUserAuthPolicy(userId);
          if (applied.action === 'upserted') result.policiesApplied++;
          else if (applied.action === 'deleted') result.policiesDeleted++;
        } catch (error) {
          result.errors.push(`policy ${snapshot.metadata.name}: ${errMsg(error)}`);
        }
      }

      // Orphans: labeled policies with no desired state. A policy may have been created by a
      // grant that landed after the DB snapshot above, so (as for subscriptions) a fresh object
      // is never deleted, and the owner's desired state is re-read right before deleting.
      for (const [name, obj] of existingByName) {
        if (desiredNames.has(name)) continue;
        if (!createdLongAgo(obj, now)) continue;
        try {
          const labelUserId = obj.metadata.labels?.[LABEL_USER_ID];
          if (labelUserId && (await this.policyStillDesired(labelUserId, name))) {
            this.fastify.log.info(
              { policy: name },
              'MaaS reconcile: policy granted during the pass - skipping stale orphan delete',
            );
            continue;
          }
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
                ak.maas_subscription_name, ak.maas_sync_state, ak.maas_pending_revoke_ids, ak.is_active, ak.revoked_at,
                ak.archived_at, ak.expires_at, ak.created_at
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
            AND m.maas_model_ref_namespace IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM subscriptions s
               WHERE s.user_id = ak.user_id AND s.model_id = akm.model_id AND s.status = 'active'
            )`,
      );
      const modelsByKey = new Map<string, KeyModelRow[]>();
      for (const km of keyModels) {
        const list = modelsByKey.get(km.api_key_id) ?? [];
        list.push(km);
        modelsByKey.set(km.api_key_id, list);
      }

      const existing = await k8s.list(MAAS_SUBSCRIPTION, {
        namespace: config.namespace,
        labelSelector: managedSelector(),
      });
      const existingByName = new Map(existing.map((o) => [o.metadata.name, o]));
      const desiredNames = new Set<string>();
      const now = Date.now();

      for (const key of keys) {
        const name = key.maas_subscription_name || subscriptionName(key.id);
        const models = modelsByKey.get(key.id) ?? [];

        // Abandoned creation (process died between the row commit and finalize): the user never
        // received a key, so remove the row and its subscription (same cleanup as rollbackCreate)
        if (
          !key.maas_key_id &&
          key.maas_sync_state === 'pending' &&
          !key.revoked_at &&
          !key.archived_at &&
          key.created_at &&
          now - new Date(key.created_at).getTime() > ABANDONED_CREATE_GRACE_MS
        ) {
          try {
            if (existingByName.has(name)) {
              await k8s.delete(MAAS_SUBSCRIPTION, name, config.namespace);
              result.subscriptionsDeleted++;
            }
            await this.fastify.dbUtils.query(
              `DELETE FROM api_key_models WHERE api_key_id = $1
                 AND EXISTS (SELECT 1 FROM api_keys WHERE id = $1 AND maas_key_id IS NULL AND maas_sync_state = 'pending')`,
              [key.id],
            );
            await this.fastify.dbUtils.query(
              `DELETE FROM api_keys WHERE id = $1 AND maas_key_id IS NULL AND maas_sync_state = 'pending'`,
              [key.id],
            );
            this.fastify.log.warn(
              { keyId: key.id },
              'MaaS reconcile: removed abandoned key creation',
            );
          } catch (error) {
            result.errors.push(`abandoned key ${key.id}: ${errMsg(error)}`);
          }
          continue;
        }

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
            const snapshot = this.buildKeySubscription(key, models, name);
            desiredNames.add(name);
            const current = existingByName.get(name);
            if (!current || !k8sObjectMatches(snapshot, current)) {
              // Re-read right before writing so a TPM, model or expiry change made after the
              // snapshot wins over the stale snapshot
              const fresh = await this.loadLiveKey(key.id);
              if (!fresh) {
                this.fastify.log.info(
                  { keyId: key.id },
                  'MaaS reconcile: key changed during the pass - skipping stale subscription upsert',
                );
                continue;
              }
              const desired = this.buildKeySubscription(fresh.key, fresh.models, name);
              const applied = await applyK8sObject(
                k8s,
                MAAS_SUBSCRIPTION,
                desired,
                config.namespace,
                (e) => foreignObjectReason(e, key.user_id),
                { skipIfUnchanged: true },
              );
              if (applied.action !== 'unchanged') result.subscriptionsApplied++;
            }
          } else if (existingByName.has(name)) {
            await k8s.delete(MAAS_SUBSCRIPTION, name, config.namespace);
            result.subscriptionsDeleted++;
          }

          // Old keys replaced by a rotation whose revoke failed: they still authorize requests
          // through the live subscription, so retry until maas-api confirms
          const pendingIds = key.maas_pending_revoke_ids ?? [];
          if (pendingIds.length > 0) {
            const stillPending: string[] = [];
            for (const oldId of pendingIds) {
              const ok = await revokeInMaasApi(this.fastify, this.clients, key.user_id, oldId);
              if (!ok) stillPending.push(oldId);
            }
            if (stillPending.length !== pendingIds.length) {
              await this.fastify.dbUtils.query(
                `UPDATE api_keys SET maas_pending_revoke_ids = $2::text[] WHERE id = $1`,
                [key.id, stillPending],
              );
            }
            if (stillPending.length > 0) {
              result.maasApiRevokePending++;
              await this.fastify.dbUtils.query(
                `UPDATE api_keys SET maas_sync_state = 'pending', maas_last_error = $2,
                        updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
                [key.id, 'previous maas-api key not revoked yet (no usable token)'],
              );
              continue;
            }
            key.maas_sync_state = key.maas_key_id ? 'pending' : key.maas_sync_state;
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
