# RHOAI Models-as-a-Service (MaaS) Backend

LiteMaaS can serve each model through one of two backends:

- **LiteLLM** (default): the existing proxy. LiteMaaS creates LiteLLM users, keys and budgets.
- **MaaS**: the Red Hat OpenShift AI 3.x **Models-as-a-Service** stack (`maas-default-gateway`,
  `maas-api`, `MaaSModelRef` / `MaaSAuthPolicy` / `MaaSSubscription` custom resources), typically in
  front of `LLMInferenceService` (llm-d) deployments.

Users keep the same flow for both: browse the catalog, request a subscription, wait for admin
approval on restricted models, create, view and revoke API keys, and see usage. Models move from
LiteLLM to MaaS one by one with the admin **Migrate to MaaS** action.

The feature is behind `MAAS_ENABLED`. With the flag off (the default), nothing changes: no MaaS
queries run, no MaaS UI is shown, and the public config only adds `maasEnabled: false`.

> **Status.** The integration was built against the documented RHOAI 3.4/3.5 contracts and a mocked
> cluster. Before production use, follow the live validation runbook in
> [`docs/development/maas-backend-live-validation.md`](../development/maas-backend-live-validation.md).

## Architecture

```
                 ┌──────────────────── LiteMaaS backend ─────────────────────┐
 Browser ──JWT──▶│ routes ─▶ SubscriptionService / ApiKeyService / usage      │
                 │              │ (branch on models.backend_type /            │
                 │              │  api_keys.backend_type)                     │
                 │      ┌───────┴────────┐                                    │
                 │  LiteLLMService   MaaS services ──┬─ K8sClient (SA token) ─┼─▶ Kubernetes API
                 │      │            (services/maas)  ├─ MaasApiClient        ─┼─▶ maas-api (user token)
                 │      │                             └─ PrometheusClient     ─┼─▶ Thanos Querier
                 │      ▼                                                     │
                 │   LiteLLM                     MaaS reconciler (advisory lock)│
                 └────────────────────────────────────────────────────────────┘
 Client ──sk-oai-...──▶ maas-default-gateway (Authorino + Limitador) ──▶ LLMInferenceService
```

- **Per-model backend.** `models.backend_type` is `litellm` or `maas`. MaaS model ids are
  `<namespace>/<maasmodelref-name>`, so they never collide with LiteLLM ids. They are URL-encoded
  (`%2F`) in `:id` routes.
- **Per-key backend.** Each API key is bound to one backend (`api_keys.backend_type`). A key can't
  mix LiteLLM and MaaS models.
- **Database is the source of truth.** Every cluster object LiteMaaS writes carries the label
  `app.kubernetes.io/managed-by=litemaas`, plus `litemaas.io/user-id` and `litemaas.io/api-key-id`.
  The reconciler recomputes the desired state from the database and deletes labeled orphans.
- **Revocation first.** When access is removed, LiteMaaS updates the cluster before the database.
  If the cluster call fails, the key is marked `maas_sync_state='pending'` and the reconciler
  retries. Grants go the other way: database first, then cluster.
- **Wrapping, not rewriting.** The LiteLLM code paths are unchanged. MaaS branches sit at the top of
  the public service methods (`services/backends/` holds the provider interfaces and the
  `fastify.backends` registry).

Code map (backend):

| Concern | File |
| --- | --- |
| Config, client factory, mock mode | `services/maas/maas-config.ts`, `services/maas/maas-clients.ts` |
| Kubernetes, maas-api and Prometheus clients | `services/k8s/k8s-client.ts`, `services/maas/maas-api.client.ts`, `services/maas/prometheus.client.ts` |
| CR builders, names, labels | `services/maas/maas-resources.ts` |
| User OAuth token storage | `services/maas/user-token.service.ts` |
| MaaSModelRef → models sync | `services/maas/maas-model-sync.service.ts` |
| Subscriptions → MaaSAuthPolicy | `services/maas/maas-access.service.ts` |
| MaaS API keys | `services/maas/maas-key.service.ts` (called from `api-key.service.ts`) |
| Reconciler and grace job | `services/maas/maas-reconciler.service.ts` |
| Usage from Thanos | `services/maas/maas-usage.source.ts` |
| Migration | `services/maas/maas-migration.service.ts` |
| Routes | `routes/admin-models.ts` (`maas/sync`, `maas/refs`, `:id/migrate-to-maas`), `routes/admin-maas.ts` (`reconcile`), `routes/health.ts` (`maas` section) |

## Flows and cluster mapping

### Models: MaaSModelRef → models

The model sync runs at startup and then every `MAAS_SYNC_INTERVAL_MS`. It lists `MaaSModelRef`
objects in `MAAS_MODEL_NAMESPACES`, or in all namespaces when that is empty. Admins can also run it
with **Sync MaaS models** on the Models admin page (`POST /api/v1/admin/models/maas/sync`).

| MaaSModelRef | LiteMaaS `models` row |
| --- | --- |
| `metadata.namespace` / `metadata.name` | `id = <ns>/<name>`, `maas_model_ref_namespace`, `maas_model_ref_name` |
| annotation `openshift.io/display-name` | `name` (on import only) |
| annotation `openshift.io/description` | `description` (only while empty) |
| `metadata.name` | `backend_model_name`, the served model name clients send (only while empty; admins can override it) |
| `status.phase` (`Ready` / `Pending` / `Failed`) | `maas_phase`; `Ready` makes the model available, anything else makes it unavailable without cascade |
| `status.endpoint` | `maas_endpoint`, exposed as `maasEndpoint` and used for curl examples and the Playground |
| object removed | cascade: subscriptions deactivated, keys updated, policies re-synced |

Admins can edit only the metadata of a MaaS model: name, description, served name, pricing, max
tokens, capability flags and restricted access. The endpoint, rate limits and credentials belong to
the cluster. **Delete** is a soft delete: the row is hidden and access is revoked, but the cluster
object stays. **Sync and restore removed models** brings such rows back.

### Subscriptions → MaaSAuthPolicy

Each user with at least one active MaaS subscription gets one policy:

```yaml
apiVersion: maas.opendatahub.io/v1alpha1
kind: MaaSAuthPolicy
metadata:
  name: litemaas-<sanitized-username>
  namespace: models-as-a-service              # MAAS_NAMESPACE
  labels: {app.kubernetes.io/managed-by: litemaas, litemaas.io/user-id: <uuid>}
spec:
  subjects: {users: [<username>], groups: []}
  modelRefs:                                   # every active MaaS subscription of the user
    - {name: <maasmodelref>, namespace: <model-ns>}
```

The policy is recomputed from the database on every change: approve, revert, auto-approve when a
model is no longer restricted, cancel, deny, delete, or a model becoming restricted. It is deleted
when no active MaaS subscription remains. The restricted-model approval workflow is unchanged: a
policy only names models whose subscription is `active`.

### API keys → MaaSSubscription + maas-api key

A MaaS key is a per-key `MaaSSubscription` plus a key issued by maas-api for it:

```yaml
apiVersion: maas.opendatahub.io/v1alpha1
kind: MaaSSubscription
metadata:
  name: litemaas-key-<api-key-uuid>
  namespace: models-as-a-service
  labels: {app.kubernetes.io/managed-by: litemaas, litemaas.io/user-id: <uuid>, litemaas.io/api-key-id: <uuid>}
spec:
  owner: {users: [<username>], groups: []}
  modelRefs:
    - name: <maasmodelref>
      namespace: <model-ns>
      tokenRateLimits: [{limit: <tpm>, window: 1m}]   # per-model TPM, else the key's global TPM
  priority: 0
```

Create order: validate, get the user's stored OpenShift token, insert the `api_keys` row, apply the
`MaaSSubscription`, call `POST <maas-api>/v1/api-keys` **with the user's own token**
(`{name, description, subscription, expiresIn: "<n>d"}`), then store the returned `sk-oai-...`
plaintext encrypted (AES-256-GCM) so View Key and the Playground keep working. Any failure rolls
back in reverse order. The row gets a synthetic `key_hash = 'maas:litemaas-key-<id>'`, which lets
the usage pipeline map usage to users.

| Key operation | MaaS behavior |
| --- | --- |
| Create / rotate | Needs a valid stored user token, else HTTP 403 `MAAS_REAUTH_REQUIRED`. The UI shows a re-login button. |
| TPM and per-model TPM edit | Patches `tokenRateLimits` (cluster first, then database) |
| Model add / remove | Rewrites `spec.modelRefs`; removing the last model revokes the key |
| Expiry | Can only be **shortened**: maas-api has no extend call. LiteMaaS enforces expiry itself (cleanup job and reconciler). |
| Revoke, delete, archive | Deletes the `MaaSSubscription` first, then revokes in maas-api (user token, falling back to the service account token). A refused maas-api revoke leaves the key `pending` for the reconciler; the key is already inert without its subscription. |
| Budget, RPM, budget duration, soft budget, parallel requests, reset spend | Not supported (HTTP 400). The UI hides these fields. |
| Admin creating keys for a user | MaaS models can't be selected (MaaS keys need the user's own token). Admins can view keys, edit TPM, shorten expiry and revoke. |

### Reconciler

`MaasReconcilerService` runs about 30 s after start and then every `MAAS_RECONCILE_INTERVAL_MS`,
under a Postgres advisory lock so only one replica runs it. Admins can also trigger it with
`POST /api/v1/admin/maas/reconcile` (permission `admin:maas`, admin only). Each pass:

1. Re-applies every user's `MaaSAuthPolicy` and every live key's `MaaSSubscription`.
2. Deletes labeled orphans. Subscriptions younger than 120 s are spared, so keys being created
   are left alone.
3. Retries keys in `pending` or `error` state.
4. Deactivates expired keys and revokes them in maas-api.
5. Completes migrations whose grace period has ended.

### Usage

Usage comes from Thanos Querier. Limitador exposes `authorized_hits` (tokens) and `authorized_calls`
(requests), labeled with `subscription` and `model`. For each UTC day LiteMaaS runs
`sum by (subscription, model) (increase(<metric>{subscription=~"(.*/)?litemaas-key-.+"}[<window>]))`
and maps the series as follows:

- `subscription` → `key_hash` `maas:<subscription>` → user (through the existing enrichment).
- `model` → LiteMaaS model id (matching is case-insensitive).
- cost = tokens × blended price, where the blended price is (input + output price) / 2.

The results merge into the admin usage analytics and the daily cache. A day where the MaaS
query failed is not cached. `GET /usage/budget` reports `maasSpend` and `maasTokens` for the current
month as **estimates, separate from** the LiteLLM `currentSpend`, because MaaS keys have no budget.

### Migration from LiteLLM

**Migrate to MaaS** on a LiteLLM model (`POST /api/v1/admin/models/:id/migrate-to-maas`, body
`{maasModelRef: {name, namespace}, graceDays}`) runs in one transaction:

1. Copies the model metadata to the MaaS row `<ns>/<name>`, or fills the empty fields of an
   already-synced row.
2. Copies the **active** subscriptions as active, with no re-approval.
3. Marks the old row `migration_state='migrating'` with `migration_grace_until` (default
   `MAAS_MIGRATION_GRACE_DAYS`, 14).

After the commit it syncs the users' policies. New subscriptions to the old model are refused.
Users see a "migrating until" label and a banner on the API Keys page, and create a new MaaS key.

When the grace period ends, the reconciler removes the model from users' LiteLLM keys,
deactivates the old subscriptions and marks the row `completed`. The model is **not** deleted
from the LiteLLM proxy; remove it there once the migration is completed.

### Login token capture

With MaaS enabled, the OAuth callback stores the user's OpenShift access token, encrypted, in
`user_oauth_tokens` with its expiry. Logout deletes it. maas-api has no on-behalf-of mode, so this
token is how LiteMaaS creates keys as the user. When the token is missing or expired, key creation
and rotation return `MAAS_REAUTH_REQUIRED` (HTTP 403, deliberately not 401). `OAUTH_SCOPES`
overrides the requested scopes if maas-api needs a broader token.

## Configuration

See the [configuration guide](../deployment/configuration.md#rhoai-models-as-a-service-maas-backend)
for the full variable table. The minimum is:

```bash
MAAS_ENABLED=true
MAAS_API_URL=https://maas.apps.<cluster-domain>/maas-api
MAAS_GATEWAY_URL=https://maas.apps.<cluster-domain>
PROMETHEUS_URL=https://thanos-querier.openshift-monitoring.svc.cluster.local:9091
```

`ENCRYPTION_KEY` is optional. It defaults to `LITELLM_MASTER_KEY`, then `LITELLM_API_KEY`.
**Never set it on an existing installation without a migration plan:** it changes the key that
encrypts provider API keys, MaaS keys and stored tokens.

**Mock mode.** In `development` or `test`, a client whose endpoint isn't configured runs against an
in-memory mock. The mock cluster is seeded with three sample `MaaSModelRef` objects, and there is a
mock maas-api and a mock Prometheus, so the UI can be exercised without a cluster. In production an
unconfigured client answers 503. `GET /api/v1/health` reports `maas.mock`.

## Deployment and RBAC

The backend ServiceAccount needs:

| Permission | Scope | Why |
| --- | --- | --- |
| `get`, `list`, `watch` `maasmodelrefs.maas.opendatahub.io` | cluster, or each `MAAS_MODEL_NAMESPACES` namespace | model sync |
| `get`, `list`, `watch`, `create`, `update`, `patch`, `delete` `maasauthpolicies`, `maassubscriptions` | `MAAS_NAMESPACE` | access and keys |
| ClusterRole `cluster-monitoring-view` | cluster | Thanos Querier usage queries (optional: Helm `maas.prometheus.clusterMonitoringView`, Kustomize `MAAS_CLUSTER_MONITORING_VIEW`) |

- **Helm.** Set `maas.enabled=true`. The chart renders `templates/maas-rbac.yaml`, wires the
  environment variables, and on OpenShift mounts the injected trusted CA bundle through
  `NODE_EXTRA_CA_CERTS` so the backend trusts the ingress CA of the maas-api route. See
  [Helm deployment](../deployment/helm-deployment.md#rhoai-models-as-a-service-maas).
- **Kustomize.** Set `MAAS_ENABLED=true` and the `MAAS_*` values in `user-values.env`, run
  `preparation.sh`, then apply the base, which now includes `components/maas`, and
  `components/maas/maas-namespace-rbac.yaml.local`. See
  [Kustomize deployment](../deployment/kustomize-deployment.md#rhoai-models-as-a-service-maas).

The chart's NetworkPolicies only restrict ingress, so the backend's egress to the API server,
maas-api and Thanos isn't blocked.

## API summary

| Endpoint | Notes |
| --- | --- |
| `GET /api/v1/config` | `maasEnabled`, `maasGatewayUrl` |
| `GET /api/v1/models`, `/models/:id` | `backendType`, `backendModelName`, `maasEndpoint`, `migrationState`, `migrationGraceUntil` |
| `GET /api/v1/subscriptions` | `modelBackendType`, `modelMigrationState`, `modelMigrationGraceUntil` |
| `POST /api/v1/api-keys` | optional `backendType`, inferred from the models; MaaS keys accept TPM-only limits |
| `GET /api/v1/api-keys` | `backendType`, plus `baseUrl`, `maasKeyId`, `maasSyncState` for MaaS keys; `modelDetails[]` include `backendType`, `backendModelName`, `migrationState`, `migrationGraceUntil` |
| `POST /api/v1/api-keys/:id/reveal` | `keyType: 'maas'` and `baseUrl` for MaaS keys |
| `GET /api/v1/usage/budget` | `maasSpend`, `maasTokens` (estimated, current UTC month) |
| `POST /api/v1/admin/models/maas/sync` | body `{restoreRemoved?}`; admin |
| `GET /api/v1/admin/models/maas/refs` | cluster `MaaSModelRef` list with an `imported` flag |
| `POST /api/v1/admin/models/:id/migrate-to-maas` | returns `{data: {oldModelId, newModelId, created, graceUntil, subscriptionsCopied, usersNotified, policyFailures}}` |
| `POST /api/v1/admin/maas/reconcile` | `admin:maas` (admin only) |
| `GET /api/v1/health` | `maas: {enabled, maasApi, kubernetes, prometheus, mock}`; never affects the overall status |

Error codes: `MAAS_REAUTH_REQUIRED` (403, the user must log in again) and `MAAS_ERROR` (502, upstream
failure, retryable for 5xx and 429).

## Limitations

- MaaS keys support **TPM limits only**. There is no budget enforcement, and cost is an estimate.
- Limitador reports total tokens only. MaaS usage shows all tokens as prompt tokens, with
  `rawData.sources.maas.tokenSplitAvailable=false`.
- Usage older than the Prometheus/Thanos retention (about 15 days on the platform Prometheus)
  can't be backfilled.
- Key expiry can only be shortened. Rotate to extend it.
- Key creation needs the user's own OpenShift token. Users must have logged in recently (token
  lifetime, 24 h by default), and admins can't create MaaS keys for users.
- The Playground calls the MaaS gateway directly from the browser, which needs CORS on the gateway.
- Migration doesn't convert existing LiteLLM keys, has no cancel endpoint, and doesn't delete the
  model from LiteLLM.
- The usernames LiteMaaS writes into policies must equal the OpenShift user names (this works with
  `AUTH_PROVIDER=openshift`; OIDC deployments need validation).
- Revocation takes effect after the operator's reconcile plus the Authorino cache delay; see the
  live validation runbook for how to measure it.

### Abandoned key creation

If the backend process dies after the `api_keys` row is committed but before the key is finalized, the reconciler removes the row (and its MaaSSubscription) once it is older than `ABANDONED_CREATE_GRACE_MS` (10 minutes) and still has no `maas_key_id`. A maas-api key created just before the crash has an unknown id and cannot be revoked by this sweep; with the subscription deleted it can no longer authorize requests.
