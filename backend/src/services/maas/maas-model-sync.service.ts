import type { FastifyInstance } from 'fastify';
import { BaseService } from '../base.service.js';
import { ModelSyncService } from '../model-sync.service.js';
import type { K8sObject } from '../k8s/k8s-client.js';
import type { MaasClients } from './maas-clients.js';
import { withAdvisoryLock } from '../../utils/advisory-lock.utils.js';
import { MaasAccessService } from './maas-access.service.js';
import { MAAS_MODEL_REF, parseModelRef, type ParsedModelRef } from './maas-resources.js';

export interface MaasSyncResult {
  success: boolean;
  totalRefs: number;
  newModels: number;
  updatedModels: number;
  unavailableModels: number;
  cascadeStatistics: {
    subscriptionsDeactivated: number;
    apiKeyModelAssociationsRemoved: number;
    orphanedApiKeysDeactivated: number;
  };
  errors: string[];
  syncedAt: string;
}

export interface MaasRefInfo extends ParsedModelRef {
  /** True when a LiteMaaS model row exists for this ref */
  imported: boolean;
}

interface ExistingMaasModel {
  id: string;
  availability: string;
  maas_model_ref_namespace: string | null;
  maas_model_ref_name: string | null;
  maas_phase: string | null;
  maas_endpoint: string | null;
  backend_model_name: string | null;
  description: string | null;
  name: string | null;
  metadata: Record<string, unknown> | null;
}

/** metadata flag set when an admin deletes a MaaS model; keeps it unavailable across syncs */
export const ADMIN_REMOVED_FLAG = 'admin_removed';

function isAdminRemoved(row: { metadata: Record<string, unknown> | null }): boolean {
  return row.metadata?.[ADMIN_REMOVED_FLAG] === true;
}

/**
 * pg advisory lock key for the model sync ("MAAT"); keeps replicas, the periodic job and the
 * manual admin endpoint from syncing at the same time
 */
export const MAAS_SYNC_LOCK_ID = 0x4d414154;

/** Provider label stored on MaaS models */
export const MAAS_PROVIDER = 'maas';

/** Per-user cluster calls (policy grants / revocations) run at most this many at a time */
export const MAAS_POLICY_CONCURRENCY = 5;

/**
 * Run `fn` for every item with at most `limit` calls in flight. Never rejects: failures are
 * returned, so callers can count and log them without one bad item stopping the rest.
 */
export async function runBounded<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<unknown>,
): Promise<Array<{ item: T; error: unknown }>> {
  const failures: Array<{ item: T; error: unknown }> = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next++];
      try {
        await fn(item);
      } catch (error) {
        failures.push({ item, error });
      }
    }
  };
  const workers = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return failures;
}

/** In-flight fire-and-forget jobs, tracked so tests (and shutdown code) can wait for them */
const backgroundJobs = new Set<Promise<void>>();

/**
 * Start `job` without making the caller wait for it. Used for cluster work that is safe to
 * finish later because the database is already committed and the reconciler converges whatever
 * the job does not complete. A failing job is logged, never thrown.
 */
export function runInBackground(
  log: FastifyInstance['log'],
  description: string,
  job: () => Promise<void>,
): void {
  const promise: Promise<void> = Promise.resolve()
    .then(job)
    .catch((error) => {
      log.error({ error }, `${description} failed - the reconciler will converge`);
    })
    .finally(() => {
      backgroundJobs.delete(promise);
    });
  backgroundJobs.add(promise);
}

/** Resolves once every background MaaS job started so far (and any it spawned) has finished */
export async function waitForMaasBackground(): Promise<void> {
  while (backgroundJobs.size > 0) {
    await Promise.allSettled([...backgroundJobs]);
  }
}

/**
 * Synchronises MaaSModelRef objects from the cluster into the `models` table
 * (backend_type='maas', id = "<namespace>/<name>").
 *
 * Admin overrides are preserved: on update only the cluster-owned fields are written
 * (phase, endpoint, availability, and backend_model_name/description when still empty).
 * Display name, pricing, limits, restriction etc. are never overwritten after import.
 *
 * Availability rules:
 *  - ref Ready                      -> available
 *  - ref Pending / Failed / Unknown -> unavailable WITHOUT cascade (transient; flips back)
 *  - ref removed from the cluster   -> unavailable WITH cascade (subscriptions deactivated,
 *    key associations removed, MaaS access revoked)
 * A cluster list failure never marks anything unavailable.
 */
export class MaasModelSyncService extends BaseService {
  private readonly clients: MaasClients;

  constructor(fastify: FastifyInstance, clients?: MaasClients) {
    super(fastify);
    const c = clients ?? fastify.maasClients;
    if (!c) throw new Error('MaasModelSyncService requires MaaS to be enabled');
    this.clients = c;
  }

  private timer?: NodeJS.Timeout;

  /**
   * Run a sync under a pg advisory lock (null when another sync is already running, on this
   * replica or another). Used by the startup and interval jobs AND the manual admin endpoint, so
   * a manual sync can never race the periodic one (duplicate inserts).
   */
  async syncWithLock(options: { restoreRemoved?: boolean } = {}): Promise<MaasSyncResult | null> {
    return withAdvisoryLock(
      this.fastify.pg.pool,
      MAAS_SYNC_LOCK_ID,
      () => this.syncModels(options),
      {
        blocking: false,
      },
    );
  }

  /** Wait for the background cluster work started by this service (tests, graceful shutdown) */
  static waitForBackground(): Promise<void> {
    return waitForMaasBackground();
  }

  /** Sync once now (non-blocking for the caller) and then every MAAS_SYNC_INTERVAL_MS */
  startPeriodicSync(): void {
    if (this.timer) return;
    const run = () =>
      this.syncWithLock().catch((error) =>
        this.fastify.log.error({ error }, 'MaaS periodic model sync failed'),
      );
    setImmediate(run);
    this.timer = setInterval(run, this.clients.config.syncIntervalMs);
    this.timer.unref?.();
    this.fastify.log.info(
      { intervalMs: this.clients.config.syncIntervalMs },
      'MaaS periodic model sync started',
    );
  }

  stopPeriodicSync(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private get scannedNamespaces(): string[] {
    return this.clients.config.modelNamespaces;
  }

  /** List MaaSModelRef objects from the configured namespaces (all namespaces when unset) */
  async listClusterRefs(): Promise<ParsedModelRef[]> {
    const { k8s } = this.clients;
    const namespaces = this.scannedNamespaces;
    let objects: K8sObject[];
    if (namespaces.length === 0) {
      objects = await k8s.list(MAAS_MODEL_REF);
    } else {
      objects = (
        await Promise.all(namespaces.map((namespace) => k8s.list(MAAS_MODEL_REF, { namespace })))
      ).flat();
    }
    return objects.map((o) => parseModelRef(o)).sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Cluster refs annotated with whether they were already imported (admin "refs" view) */
  async listRefs(): Promise<MaasRefInfo[]> {
    const refs = await this.listClusterRefs();
    const existing = await this.fastify.dbUtils.queryMany<{ id: string }>(
      `SELECT id FROM models WHERE backend_type = 'maas'`,
    );
    const known = new Set(existing.map((r) => r.id));
    return refs.map((r) => ({ ...r, imported: known.has(r.id) }));
  }

  async syncModels(options: { restoreRemoved?: boolean } = {}): Promise<MaasSyncResult> {
    const result: MaasSyncResult = {
      success: false,
      totalRefs: 0,
      newModels: 0,
      updatedModels: 0,
      unavailableModels: 0,
      cascadeStatistics: {
        subscriptionsDeactivated: 0,
        apiKeyModelAssociationsRemoved: 0,
        orphanedApiKeysDeactivated: 0,
      },
      errors: [],
      syncedAt: new Date().toISOString(),
    };

    let refs: ParsedModelRef[];
    try {
      refs = await this.listClusterRefs();
    } catch (error) {
      // Never touch the DB when the cluster could not be read
      this.fastify.log.error({ error }, 'MaaS model sync: failed to list MaaSModelRefs');
      result.errors.push(
        `Failed to list MaaSModelRefs: ${error instanceof Error ? error.message : String(error)}`,
      );
      return result;
    }
    result.totalRefs = refs.length;

    try {
      const existingRows = await this.fastify.dbUtils.queryMany<ExistingMaasModel>(
        `SELECT id, availability, maas_model_ref_namespace, maas_model_ref_name, maas_phase,
                maas_endpoint, backend_model_name, description, name, metadata
           FROM models WHERE backend_type = 'maas'`,
      );
      if (options.restoreRemoved) {
        for (const r of existingRows) {
          if (isAdminRemoved(r)) {
            await this.fastify.dbUtils.query(
              `UPDATE models SET metadata = COALESCE(metadata, '{}'::jsonb) - $2 WHERE id = $1`,
              [r.id, ADMIN_REMOVED_FLAG],
            );
            r.metadata = { ...(r.metadata ?? {}), [ADMIN_REMOVED_FLAG]: false };
          }
        }
      }
      const existing = new Map(existingRows.map((r) => [r.id, r]));

      for (const ref of refs) {
        try {
          const row = existing.get(ref.id);
          if (!row) {
            await this.insertModel(ref);
            result.newModels++;
          } else if (await this.updateModel(row, ref)) {
            result.updatedModels++;
          }
        } catch (error) {
          this.fastify.log.error({ error, modelId: ref.id }, 'MaaS model sync: ref failed');
          result.errors.push(
            `Failed to sync ${ref.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      // Refs that vanished from the cluster (restricted to the scanned namespaces)
      const present = new Set(refs.map((r) => r.id));
      const scanned = this.scannedNamespaces;
      const removed = existingRows.filter(
        (r) =>
          !present.has(r.id) &&
          !isAdminRemoved(r) &&
          (scanned.length === 0 ||
            (r.maas_model_ref_namespace && scanned.includes(r.maas_model_ref_namespace))),
      );
      for (const row of removed) {
        try {
          const cascade = await this.markUnavailableWithCascade(row.id);
          if (row.availability !== 'unavailable' || cascade.subscriptionsDeactivated > 0) {
            result.unavailableModels++;
          }
          result.cascadeStatistics.subscriptionsDeactivated += cascade.subscriptionsDeactivated;
          result.cascadeStatistics.apiKeyModelAssociationsRemoved +=
            cascade.apiKeyModelAssociationsRemoved;
          result.cascadeStatistics.orphanedApiKeysDeactivated += cascade.orphanedApiKeysDeactivated;
        } catch (error) {
          this.fastify.log.error({ error, modelId: row.id }, 'MaaS model sync: cascade failed');
          result.errors.push(
            `Failed to mark ${row.id} unavailable: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    } catch (error) {
      this.fastify.log.error({ error }, 'MaaS model sync failed');
      result.errors.push(
        `Synchronization failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return result;
    }

    result.success = result.errors.length === 0;
    this.fastify.log.info({ result }, 'MaaS model synchronization completed');
    return result;
  }

  /**
   * Mark a MaaS model unavailable and cascade.
   *
   *  1. Cluster access is revoked FIRST (revoke-before-database-change rule) for every user
   *     holding an active subscription. This stays on the request path, but runs with bounded
   *     concurrency so a popular model does not take a serial round trip per user.
   *  2. The shared DB cascade runs. A model that is already parked as unavailable (Pending
   *     phase) is only flipped to 'available' for the duration of the cascade and is put back
   *     if the cascade fails, so a failed cascade never leaves it visible / subscribable.
   *  3. Policies are re-asserted from the (now updated) database state in the BACKGROUND with
   *     bounded concurrency (a convergence step the reconciler repeats anyway).
   */
  async markUnavailableWithCascade(modelId: string) {
    const users = await this.fastify.dbUtils.queryMany<{ user_id: string }>(
      `SELECT DISTINCT user_id FROM subscriptions WHERE model_id = $1 AND status = 'active'`,
      [modelId],
    );
    const current = await this.fastify.dbUtils.queryOne<{ availability: string }>(
      'SELECT availability FROM models WHERE id = $1',
      [modelId],
    );
    if (current?.availability === 'unavailable' && users.length === 0) {
      // Already parked and nothing left to cascade: avoid flapping the row every cycle
      return {
        subscriptionsDeactivated: 0,
        apiKeyModelAssociationsRemoved: 0,
        orphanedApiKeysDeactivated: 0,
      };
    }
    const access = new MaasAccessService(this.fastify, this.clients);
    // removeModelForUser never throws: a cluster failure marks the user's keys pending instead
    await runBounded(users, MAAS_POLICY_CONCURRENCY, (u) =>
      access.removeModelForUser(u.user_id, modelId),
    );

    // markModelUnavailable only cascades on an available -> unavailable transition; a model
    // parked as unavailable (Pending phase) may still hold active subscriptions.
    const parked = current?.availability === 'unavailable';
    if (parked) {
      await this.fastify.dbUtils.query(
        `UPDATE models SET availability = 'available' WHERE id = $1 AND availability = 'unavailable'`,
        [modelId],
      );
    }
    let dbCascade: Awaited<ReturnType<ModelSyncService['markModelUnavailable']>>;
    try {
      dbCascade = await new ModelSyncService(this.fastify).markModelUnavailable(modelId);
    } catch (error) {
      // The cascade transaction rolled back, so the temporary flip above would otherwise stay
      if (parked) {
        try {
          await this.fastify.dbUtils.query(
            `UPDATE models SET availability = 'unavailable' WHERE id = $1 AND availability = 'available'`,
            [modelId],
          );
        } catch (restoreError) {
          this.fastify.log.error(
            { error: restoreError, modelId },
            'MaaS: cascade failed and the model could not be parked as unavailable again',
          );
        }
      }
      throw error;
    }

    if (users.length > 0) {
      runInBackground(
        this.fastify.log,
        `MaaS policy re-sync after cascading ${modelId}`,
        async () => {
          const failures = await runBounded(users, MAAS_POLICY_CONCURRENCY, (u) =>
            access.syncUserAuthPolicy(u.user_id),
          );
          for (const { item, error } of failures) {
            this.fastify.log.warn({ error, userId: item.user_id }, 'MaaS policy resync failed');
          }
        },
      );
    }
    return dbCascade;
  }

  private async insertModel(ref: ParsedModelRef): Promise<void> {
    const available = ref.phase === 'Ready';
    await this.fastify.dbUtils.query(
      `INSERT INTO models (
         id, name, provider, description, category, supports_streaming, features,
         availability, version, metadata, backend_model_name, backend_type,
         maas_model_ref_name, maas_model_ref_namespace, maas_endpoint, maas_phase
       ) VALUES ($1, $2, $3, $4, $5, true, $6, $7, '1.0', $8, $9, 'maas', $10, $11, $12, $13)`,
      [
        ref.id,
        ref.displayName || ref.name,
        MAAS_PROVIDER,
        ref.description ?? null,
        'Language Model',
        ['chat'],
        available ? 'available' : 'unavailable',
        JSON.stringify({ maas_model_ref: ref }),
        ref.name,
        ref.name,
        ref.namespace,
        ref.endpoint ?? null,
        ref.phase,
      ],
    );
    this.fastify.log.debug({ modelId: ref.id, phase: ref.phase }, 'Imported MaaS model');
  }

  /** Update only cluster-owned fields; returns true when anything changed */
  private async updateModel(row: ExistingMaasModel, ref: ParsedModelRef): Promise<boolean> {
    const available = ref.phase === 'Ready' && !isAdminRemoved(row);
    const nextAvailability = available ? 'available' : 'unavailable';
    const nextEndpoint = ref.endpoint ?? null;
    const fillBackendName = !row.backend_model_name;
    const fillDescription = !row.description && !!ref.description;

    const unchanged =
      row.availability === nextAvailability &&
      row.maas_phase === ref.phase &&
      row.maas_endpoint === nextEndpoint &&
      row.maas_model_ref_name === ref.name &&
      row.maas_model_ref_namespace === ref.namespace &&
      !fillBackendName &&
      !fillDescription;
    if (unchanged) return false;

    await this.fastify.dbUtils.query(
      `UPDATE models SET
         availability = $2,
         maas_phase = $3,
         maas_endpoint = $4,
         maas_model_ref_name = $5,
         maas_model_ref_namespace = $6,
         backend_model_name = COALESCE(NULLIF(backend_model_name, ''), $7),
         description = CASE WHEN description IS NULL OR description = '' THEN $8 ELSE description END,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND backend_type = 'maas'`,
      [
        row.id,
        nextAvailability,
        ref.phase,
        nextEndpoint,
        ref.name,
        ref.namespace,
        ref.name,
        ref.description ?? null,
      ],
    );
    return true;
  }
}
