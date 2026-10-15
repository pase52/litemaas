# MaaS Backend - Live Validation Checklist

The MaaS (RHOAI Models-as-a-Service) backend was built without access to a cluster running the
MaaS stack (RHOAI 3.4/3.5, `maas.opendatahub.io/v1alpha1`). Everything below is an **assumption**
that must be verified against a real cluster before enabling `MAAS_ENABLED=true` in production.
Each section states the assumption, how the code relies on it, how to verify it, and what to change
if it is wrong.

Conventions: `$MAAS_API` is `MAAS_API_URL` (for example `https://maas.apps.example.com/maas-api`),
`$TOKEN` is an OpenShift user token (`oc whoami -t`), `$NS` is `models-as-a-service`.

Without `MAAS_API_URL`, `K8S_API_URL`/in-cluster credentials or `PROMETHEUS_URL`, the
corresponding client runs in **mock mode** (in-memory, dev/test only; production returns 503).
Mock mode must never be used for validation.

This file is appended to by every implementation phase. Phase 0/1 assumptions come first.

---

## A1. The LiteMaaS login token is accepted by maas-api (scope / audience)

**Assumption.** The OpenShift OAuth access token obtained at LiteMaaS login (default scopes
`user:info user:check-access`) is accepted by maas-api as the caller identity, i.e. maas-api
validates it with TokenReview / the user API and does not require a broader scope such as
`user:full`.

**Code relying on it.** `routes/auth.ts` stores `access_token` (encrypted) in `user_oauth_tokens`;
`UserTokenService.getValidToken()` hands it to `MaasApiClient.createKey()` as
`Authorization: Bearer <token>`.

**Verify.**

```bash
# token obtained through the LiteMaaS OAuth client (log in via the UI, then read it from the DB,
# or run the authorization-code flow manually with the same client_id and scopes)
curl -sk -H "Authorization: Bearer $TOKEN" "$MAAS_API/health"
curl -sk -X POST "$MAAS_API/v1/api-keys" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"validation","description":"","subscription":"<existing-subscription>","expiresIn":"1d"}'
# Expect 200/201 with {id,key,...}. 401/403 => scope or audience problem.

# What the token can do on the cluster API:
oc auth can-i --token="$TOKEN" get users/~
curl -sk -H "Authorization: Bearer $TOKEN" "$(oc whoami --show-server)/apis/user.openshift.io/v1/users/~"
oc get oauthclient <litemaas-client> -o yaml   # scopeRestrictions / accessTokenMaxAgeSeconds
```

**If wrong.** Set `OAUTH_SCOPES` (for example `user:full`, or whatever maas-api documents) and make
sure the `OAuthClient` allows it (`scopeRestrictions`). Users must log in again afterwards. If
maas-api requires a different audience (OIDC), the token capture needs a token-exchange step.

## A2. Token lifetime and expiry handling

**Assumption.** The OAuth token response contains `expires_in` (OpenShift default 24h,
`accessTokenMaxAgeSeconds` on the `OAuthClient`/cluster OAuth config). Tokens are treated as
expired 30 seconds before `expires_at`. There is no refresh token flow (OpenShift OAuth does not
issue refresh tokens for this grant), so an expired token means the user must log in again
(`MAAS_REAUTH_REQUIRED`).

**Verify.**

```bash
oc get oauth cluster -o jsonpath='{.spec.tokenConfig}'
oc get oauthclient <litemaas-client> -o jsonpath='{.accessTokenMaxAgeSeconds}'
# After login: SELECT expires_at - now() FROM user_oauth_tokens WHERE user_id = '<id>';
```

**If wrong.** If `expires_in` is absent, `expires_at` is NULL and expiry is only discovered when
maas-api answers 401/403 (mapped to `MAAS_REAUTH_REQUIRED`). Adjust `EXPIRY_SKEW_MS` in
`services/maas/user-token.service.ts` if clock skew is an issue.

## A3. Username match between LiteMaaS and OpenShift

**Assumption.** `users.username` in LiteMaaS equals the OpenShift user name (`metadata.name` of
the `User` object), which is also the identity maas-api / the gateway sees. This value is used in
`MaaSAuthPolicy.spec.subjects.users`, `MaaSSubscription.spec.owner.users` and the CR names
(`litemaas-<user>`).

**Verify.**

```bash
oc whoami                                   # for the logged-in test user
oc get user <name> -o yaml                   # identities, groups
# LiteMaaS: SELECT username FROM users WHERE ...;  (OpenShift provider: preferred_username = metadata.name)
# Does the gateway see the same string?  Create a key and inspect the AuthPolicy / authorino logs:
oc -n kuadrant-system logs deploy/authorino | grep -i <username>
```

Special cases to check: usernames with `:` (for example `kube:admin`), `@` (OIDC emails), upper case,
and users whose OpenShift name differs from the IdP login (identity mapping method `add`/`generate`).

**If wrong.** Map through a different claim when creating CRs (for example `User.metadata.name` from
`/apis/user.openshift.io/v1/users/~`, which `getOpenShiftUserInfo` already reads as
`preferred_username`). For OIDC deployments the subject format may need a prefix (for example
`oidc:<name>`).

## A4. maas-api request/response contract

**Assumption** (from RHOAI 3.4/3.5 documentation):

| Call | Request | Response |
| --- | --- | --- |
| `POST /v1/api-keys` | `{name, description, subscription, expiresIn:"<n>d"}` + user bearer token | `{id, key (sk-oai-...), keyPrefix, createdAt, expiresAt, subscription}` |
| `DELETE /v1/api-keys/{id}` | user bearer token | 2xx, 404 treated as "already revoked" |
| `POST /v1/api-keys/search` | JSON filter (we send `{}` or `{subscription}`) | array, or `{items|keys|data: []}` |
| `GET /health` | none | 2xx |

**Code relying on it.** `services/maas/maas-api.client.ts`. 401 and 403 are both mapped to
`MAAS_REAUTH_REQUIRED` (HTTP 403 towards the frontend, deliberately not 401 so the SPA does not log
the user out). Other non-2xx map to `MAAS_ERROR` (502, retryable for 5xx/429).

**Verify.**

```bash
curl -sk -X POST "$MAAS_API/v1/api-keys" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"v","description":"d","subscription":"<name>","expiresIn":"30d"}' | jq
curl -sk -X POST "$MAAS_API/v1/api-keys/search" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{}' | jq
curl -sk -X DELETE "$MAAS_API/v1/api-keys/<id>" -H "Authorization: Bearer $TOKEN" -i
```

Check specifically: is `expiresIn` optional (no expiry)? Does it accept `"30d"` or only hours
(`"720h"`)? Does DELETE require the owner token or does an admin/SA token work? What does a
non-existent `subscription` return (400/404/403)? Does search require a body, and what filters does
it accept?

**If wrong.** Adjust `formatExpiresIn` / request bodies in `maas-api.client.ts`; the rest of the
platform only sees `IMaasApiClient`.

## A5. TLS trust for cluster endpoints

**Assumption.** The Kubernetes API, maas-api (route or service) and Thanos Querier present
certificates signed by the in-cluster CA (`ca.crt`) or the OpenShift service CA (`service-ca.crt`)
mounted in the pod, **or** by a publicly trusted CA. `loadClusterCaBundle()` adds both cluster CA
files on top of Node's system roots. Because Node's global `fetch` ignores `https.Agent`,
`tlsFetch()` uses `https.request` whenever a custom CA / `rejectUnauthorized:false` is needed.

`K8S_API_SKIP_TLS_VERIFY=true` also disables verification for **maas-api**;
`PROMETHEUS_SKIP_TLS_VERIFY=true` for Prometheus/Thanos.

**Verify.**

```bash
# from inside the LiteMaaS pod
oc rsh deploy/litemaas-backend
ls /var/run/secrets/kubernetes.io/serviceaccount/        # ca.crt, service-ca.crt (OpenShift), token
curl --cacert /var/run/secrets/kubernetes.io/serviceaccount/ca.crt https://kubernetes.default.svc/version
curl --cacert /var/run/secrets/kubernetes.io/serviceaccount/service-ca.crt https://thanos-querier.openshift-monitoring.svc:9091/-/healthy
openssl s_client -connect maas.apps.example.com:443 -showcerts </dev/null | openssl x509 -noout -issuer
```

**If wrong.** The maas-api route is usually signed by the cluster ingress CA, which is not part of
the SA CA files. Either mount the ingress CA bundle and extend `loadClusterCaBundle()`, set
`NODE_EXTRA_CA_CERTS`, or use the in-cluster `Service` URL for `MAAS_API_URL`.

## A6. Service account permissions (Kubernetes client)

**Assumption.** The LiteMaaS service account (in-cluster token, or `K8S_TOKEN`) may
`get/list/watch/create/update/patch/delete` `maasauthpolicies` and `maassubscriptions` in
`$MAAS_NAMESPACE`, and `get/list` `maasmodelrefs` in the model namespaces (or cluster wide when
`MAAS_MODEL_NAMESPACES` is empty, which issues a cluster-scoped list).

**Verify.**

```bash
SA=system:serviceaccount:<litemaas-ns>:<litemaas-sa>
for r in maasauthpolicies maassubscriptions; do
  for v in get list create update patch delete; do
    echo -n "$r $v: "; oc auth can-i $v $r.maas.opendatahub.io -n $NS --as=$SA
  done
done
oc auth can-i list maasmodelrefs.maas.opendatahub.io --all-namespaces --as=$SA
oc get crd | grep maas.opendatahub.io      # confirm plural names and version v1alpha1
```

**If wrong.** Fix the Role/ClusterRole delivered with the Helm/Kustomize charts (phase 7). If the
CRD plural names differ from `maasmodelrefs`, `maasauthpolicies`, `maassubscriptions`, update the
constants in `services/maas/maas-resources.ts`.

## A7. In-cluster configuration resolution

**Assumption.** In-cluster, the API server is `https://$KUBERNETES_SERVICE_HOST:$KUBERNETES_SERVICE_PORT`
and the SA token is read from `/var/run/secrets/kubernetes.io/serviceaccount/token` **on every
request** (projected tokens rotate, about hourly). `K8S_API_URL` and `K8S_TOKEN` override both.
Prometheus uses `PROMETHEUS_TOKEN`, falling back to the same Kubernetes credentials.

**Verify.** Run LiteMaaS in-cluster with `MAAS_ENABLED=true`, leave `K8S_*` unset and check
`GET /api/v1/health` and the startup log line "MaaS backend enabled" (`k8sMock:false`). Confirm the
token keeps working past the projected-token rotation interval.

**If wrong.** Set `K8S_API_URL`/`K8S_TOKEN` explicitly. When the Thanos route requires a token with
`cluster-monitoring-view`, set `PROMETHEUS_TOKEN`.

## A8. MaaSModelRef shape (consumed from phase 2)

**Assumption.** `MaaSModelRef` lives in the model's namespace and has
`spec.modelRef{kind: LLMInferenceService|ExternalModel, name}`, `status.phase` in
`Pending|Ready|Failed`, `status.endpoint`, and annotations `openshift.io/display-name` and
`openshift.io/description`. The LiteMaaS model id is `<namespace>/<name>`. `backendModelName` is
set to the MaaSModelRef name; the **served model name** (the `model` field clients must send) may
differ.

**Verify.**

```bash
oc get maasmodelrefs.maas.opendatahub.io -A -o yaml | less
oc get llminferenceservice <name> -n <ns> -o yaml            # spec.model.name = served name?
curl -sk -H "Authorization: Bearer $SK_OAI_KEY" https://<gateway>/<ns>/<name>/v1/models | jq
```

**If wrong.** Adjust `parseModelRef()` and the `backend_model_name` mapping.

## A9. Encryption key and rotation

**Assumption.** `ENCRYPTION_KEY` (falling back to `LITELLM_MASTER_KEY`, then `LITELLM_API_KEY`) is
the secret that encrypts provider API keys (existing), MaaS key plaintext (`api_keys.encrypted_key`)
and user OAuth tokens. When `ENCRYPTION_KEY` is unset the derived AES key is **identical** to what
earlier versions used, so existing `models.encrypted_api_key` rows stay readable. **Setting
`ENCRYPTION_KEY` on an existing deployment changes the derivation and makes existing
`models.encrypted_api_key` values undecryptable** (admins must re-enter provider keys), and there
is no automatic re-encryption.

A stored user token that cannot be decrypted is treated as "re-login required"; a MaaS key that
cannot be decrypted cannot be shown again (View Key fails).

**Verify.**

```sql
SELECT count(*) FROM models WHERE encrypted_api_key IS NOT NULL;
SELECT count(*) FROM api_keys WHERE encrypted_key IS NOT NULL;
```

Rotation procedure (not automated): decrypt with the old key and re-encrypt with the new one for
`models.encrypted_api_key`, `api_keys.encrypted_key` and delete `user_oauth_tokens` (users re-login).

## A10. Public config exposure

**Assumption.** `GET /api/v1/config` returns `maasEnabled` (boolean) and, only when enabled and
configured, `maasGatewayUrl` (trailing slash stripped). The frontend uses `maasGatewayUrl` to build
per-key base URLs; the exact per-model inference path (`<gateway>/<namespace>/<model>/v1/...`) is
taken from `MaaSModelRef.status.endpoint` in later phases.

**Verify.**

```bash
curl -s http://localhost:8081/api/v1/config | jq '{maasEnabled, maasGatewayUrl}'
oc get gateway -A | grep maas
oc get httproute -A | grep -i maas
```

## A11. MaaSAuthPolicy semantics (phase 3: subscriptions -> access)

**Assumption.** One policy per user, `litemaas-<username>` in `MAAS_NAMESPACE`
(`models-as-a-service`), with `spec.subjects.users=[<username>]` and `spec.modelRefs=[{name,namespace}]`
where `namespace` is the namespace of the MaaSModelRef (not of the policy). The operator treats
multiple policies naming the same user as a union. LiteMaaS deletes the policy when the user has no
active MaaS subscription, rather than writing an empty `modelRefs`, because the behaviour of an empty
list is unverified.

**Verify.**

```bash
oc -n models-as-a-service get maasauthpolicy -l app.kubernetes.io/managed-by=litemaas -o yaml
# Union: a hand-made policy for the same user must not be overwritten or removed by LiteMaaS
# Empty list: apply a policy with modelRefs: [] and check the user is denied (not allowed-all)
oc -n models-as-a-service get maasauthpolicy <name> -o jsonpath='{.status}'
```

Also confirm that a user without a policy naming the model is denied by the gateway (HTTP 403) and
that a model name in `modelRefs` which does not exist is rejected or ignored (not fatal for the others).

## A12. Revocation latency and request-time subscription validation

**Assumption.** Deleting a user's model from the policy, or removing the model from (or deleting)
a `MaaSSubscription`, stops already-issued API keys from reaching that model without having to
revoke them in maas-api (the gateway validates the subscription at request time). LiteMaaS relies on
this for revocation-first behaviour when a subscription is cancelled/denied/deleted or a model
becomes restricted/unavailable.

**Verify.**

```bash
# 1. create a key via maas-api bound to subscription litemaas-key-<id>, call the model -> 200
# 2. delete the model from the policy / subscription, wait for reconcile of the operator
oc -n models-as-a-service patch maassubscription litemaas-key-<id> --type=json \
  -p '[{"op":"remove","path":"/spec/modelRefs/0"}]'
# 3. call again; measure the time until 403/401
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $KEY" "$MAAS_GATEWAY_URL/<ns>/<model>/v1/models"
# 4. delete the subscription entirely and repeat
```

Record the propagation delay (operator reconcile + Authorino cache TTL) in the user documentation.

## A13. Served model name (`backend_model_name`) of synced MaaS models

**Assumption.** The model name clients send in the request body is the `MaaSModelRef` name, so the
sync sets `models.backend_model_name = <ref name>` on import only (admins can override it via
`PUT /admin/models/:id`; syncs never overwrite a non-empty value). If the vLLM served name differs
(e.g. `--served-model-name`), the override is needed.

**Verify.**

```bash
oc -n <model-ns> get maasmodelref <name> -o jsonpath='{.status.endpoint}{"\n"}'
curl -s -H "Authorization: Bearer $KEY" "<endpoint>/v1/models" | jq '.data[].id'
```

Also verify the `status.phase` values used for availability: `Ready` -> available; `Pending`,
`Failed` or anything else -> unavailable without cascade (access is kept so the model returns when
healthy). A ref that disappears from the scanned namespaces cascades (subscriptions deactivated,
API key associations removed, policies/subscriptions revoked).

## A14. Service account RBAC for the phase 2/3 operations

**Assumption.** The LiteMaaS service account can `get/list` MaaSModelRefs in `MAAS_MODEL_NAMESPACES`
(or cluster-wide when unset), and `get/list/create/update/delete` MaaSAuthPolicies and
MaaSSubscriptions in `MAAS_NAMESPACE` (the K8s client uses `replace`, i.e. `update`, with
`resourceVersion`). Deployment RBAC is delivered in phase 7.

**Verify.**

```bash
SA=system:serviceaccount:litemaas:litemaas-backend
oc auth can-i list maasmodelrefs.maas.opendatahub.io --all-namespaces --as=$SA
for v in get list create update delete; do
  echo -n "$v maasauthpolicies: "; oc -n models-as-a-service auth can-i $v maasauthpolicies.maas.opendatahub.io --as=$SA
  echo -n "$v maassubscriptions: "; oc -n models-as-a-service auth can-i $v maassubscriptions.maas.opendatahub.io --as=$SA
done
```

## A15. Reconciler comparison and API-server defaulting

**Assumption.** The reconciler compares the desired `spec` with the live object using JSON equality
and only writes when different. If the CRD defaults or normalises fields (e.g. adds `groups: []`,
reorders), the comparison never matches and every pass re-writes every object (harmless but noisy,
visible as non-zero `policiesApplied` / `subscriptionsApplied` on `POST /admin/maas/reconcile`
with no changes).

**Verify.**

```bash
curl -s -X POST -H "Authorization: Bearer $ADMIN_JWT" http://localhost:8081/api/v1/admin/maas/reconcile | jq .data
# run twice with no DB changes: the second run must report 0 applied
```

If it does not converge, compare `oc get maasauthpolicy <n> -o jsonpath='{.spec}'` with the built spec
in `maas-resources.ts` and normalise the differences.

Orphan deletion only removes objects labeled `app.kubernetes.io/managed-by=litemaas` and, for
subscriptions, older than 120 s (a key being created is not racing the reconciler). Confirm that no
operator-created object copies the label.

## A16. Multi-replica locking and Postgres poolers

**Assumption.** The reconciler and the periodic model sync use session-level
`pg_try_advisory_lock` on a dedicated connection from the pool. This is not safe behind a
transaction-mode pooler (pgbouncer `pool_mode=transaction`): the lock may be released/shared
unexpectedly.

**Verify.**

```sql
-- while a reconcile is running (locks: 1296121171 reconciler, 1296121172 model sync)
SELECT pid, classid, objid FROM pg_locks WHERE locktype = 'advisory';
```

With two replicas, exactly one holder at a time and the other logs "skipped: lock held".

## A17. Model ids containing `/` in URLs

**Assumption.** MaaS model ids are `<namespace>/<name>`; admin routes (`/api/v1/admin/models/:id`) and
public routes (`/api/v1/models/:id`) receive them URL-encoded (`%2F`) and Fastify decodes the
parameter. Some ingress controllers/proxies reject or decode `%2F` before forwarding.

**Verify.**

```bash
curl -s -H "Authorization: Bearer $JWT" "https://<litemaas-route>/api/v1/models/maas-demo-models%2Fllama-3-2-3b" | jq .id
# Expect the model; a 404 here but 200 on localhost:8081 means the route/ingress decodes %2F
```

## A18. Subscription must exist before the maas-api key (create ordering)

**Assumption.** `POST /v1/api-keys` with `subscription: "litemaas-key-<id>"` only succeeds when the
named MaaSSubscription already exists and the calling user (token identity) is in its
`spec.owner.users`. LiteMaaS therefore creates the api_keys row, then the MaaSSubscription, then the
maas-api key, and rolls back in reverse (revoke maas-api key, delete subscription, delete row) on
any failure. The controller must also have reconciled the new subscription before maas-api accepts
it (otherwise creation fails with 4xx/5xx and the rollback runs; the user simply retries).

**Code relying on it.** `MaasKeyService.createApiKey` / `createKey`
(`services/maas/maas-key.service.ts`).

**Verify.**

```bash
cat <<EOF2 | oc apply -f -
apiVersion: maas.opendatahub.io/v1alpha1
kind: MaaSSubscription
metadata: {name: litemaas-key-test, namespace: $NS}
spec:
  owner: {users: ["$(oc whoami)"], groups: []}
  modelRefs: [{name: <ref>, namespace: <ref-ns>, tokenRateLimits: [{limit: 1000, window: "1m"}]}]
  priority: 0
EOF2
# immediately (no sleep) request the key; note whether the first attempt fails
curl -sk -X POST "$MAAS_API/v1/api-keys" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"v","description":"d","subscription":"litemaas-key-test","expiresIn":"1d"}' -i
oc get maassubscription litemaas-key-test -n $NS -o jsonpath='{.status}'
```

Also check what is returned when the token user is NOT in `owner.users` (expect 403/400) and when
the subscription name does not exist.

**If wrong.** If the controller needs time, add a short poll on `status.phase` of the
MaaSSubscription between the apply and the maas-api call in `MaasKeyService.createKey`.

## A19. Who may revoke a maas-api key (owner token vs service account)

**Assumption.** `DELETE /v1/api-keys/{id}` succeeds with the owner's token. LiteMaaS revokes with the
owner's stored token first and falls back to the service account token (`K8S_TOKEN` / in-cluster)
when the user token is expired or missing (admin revoke, expiry cleanup, reconciler). The fallback
may be refused (403/401). A refusal is not fatal: the key's MaaSSubscription is deleted first, so the
key cannot authorize requests anyway; the row is flagged `maas_sync_state='pending'` and the
reconciler retries on every pass (`maasApiRevokePending` in `POST /admin/maas/reconcile`).

**Code relying on it.** `revokeInMaasApi` in `maas-key.service.ts`, `MaasReconcilerService`.

**Verify.**

```bash
SA_TOKEN=$(oc create token litemaas -n <litemaas-ns>)
curl -sk -X DELETE "$MAAS_API/v1/api-keys/<id-of-a-key-owned-by-another-user>" \
  -H "Authorization: Bearer $SA_TOKEN" -i      # 2xx = SA may revoke; 401/403 = it may not
```

**If wrong.** Grant the service account whatever maas-api requires for admin revocation (see the
maas-api docs for its admin group), or accept the dangling-key behaviour: after the subscription is
deleted a leftover maas-api key is inert. `maas-api` may also garbage collect such keys itself.

## A20. Key expiry and extension

**Assumption.** `expiresIn: "<n>d"` sets the key lifetime and the response contains `expiresAt`
(stored in `api_keys.expires_at`). maas-api offers no endpoint to extend or change the expiry, so
LiteMaaS accepts only a **shorter** expiration afterwards (`PATCH` with a later date or `null` -> 400;
the owner rotates the key instead) and enforces it itself: the cleanup job
(`POST /api-keys/admin/cleanup-expired`) and the reconciler deactivate expired keys, delete their
MaaSSubscription and revoke the maas-api key. Without `expiresAt` no `expiresIn` is sent.

**Code relying on it.** `MaasKeyService.updateExpiration`, `cleanupExpiredKeys`, reconciler
`keysExpired`.

**Verify.** Create a key with `"expiresIn":"1d"` and compare `expiresAt` with now+24h. Check the
maas-api default when `expiresIn` is omitted (never expires? a platform maximum?), and whether `"1d"`
is accepted in addition to hours (`"24h"`). Confirm maas-api itself rejects the key after
`expiresAt` (use it against the gateway).

**If wrong.** Adjust `formatExpiresIn` in `maas-api.client.ts`. If maas-api does offer an expiry
update, implement it in `MaasKeyService.updateExpiration` and relax the "shorten only" rule.

## A21. Rotation: two keys on one subscription

**Assumption.** A second key can be created for the same MaaSSubscription while the first exists, so
rotation can create the new key before revoking the old one (a failure leaves the old key working).
The key name may be reused. `POST /v1/api-keys/search` is not used by the key lifecycle.

**Code relying on it.** `MaasKeyService.rotateApiKey`.

**Verify.** Create two keys with the same `name` and `subscription`; both must work against the
gateway; deleting one must not affect the other.

**If wrong.** If names must be unique or only one key per subscription is allowed, rotate as
revoke-then-create (accepting a short outage) in `rotateApiKey`.

## A22. Gateway base URL handed to clients (`baseUrl`)

**Assumption.** API responses carry `baseUrl = MAAS_GATEWAY_URL` for MaaS keys and clients call the
OpenAI-compatible routes under it. Whether per-model paths are needed
(`<gateway>/<namespace>/<model>/v1/...` vs `<gateway>/v1/...` with the model in the body) is not
assumed: the model's own `maas_endpoint` (from `MaaSModelRef.status.endpoint`) is exposed on
`GET /models` as `maasEndpoint`, the frontend should prefer it per model and fall back to `baseUrl`.
The model name sent in requests is the model's `backend_model_name` (see A13).

**Verify.**

```bash
curl -sk "$GATEWAY/<ns>/<model>/v1/models" -H "Authorization: Bearer sk-oai-..." | jq
curl -sk "$GATEWAY/v1/chat/completions" -H "Authorization: Bearer sk-oai-..." \
  -H 'Content-Type: application/json' -d '{"model":"<served-name>","messages":[{"role":"user","content":"hi"}]}'
```

## A23. Editing a MaaSSubscription affects existing keys

**Assumption.** Replacing `spec.modelRefs` / `tokenRateLimits` of a MaaSSubscription changes the
effective models and TPM limits of keys already issued against it (no re-issue needed), within the
revocation latency described in A12. LiteMaaS relies on this for TPM edits and model add/remove on
existing keys (`MaasKeyService.updateLimits` / `updateModels`; cluster first, database second).

**Verify.** Create a key, call a model, then lower `tokenRateLimits.limit` / remove the model from
the subscription and observe the next requests (429 / 403) and how long it takes.

## A24. Stored plaintext, key prefix and encryption

**Assumption.** The plaintext key returned once by maas-api is stored AES-256-GCM encrypted in
`api_keys.encrypted_key` (secret from `ENCRYPTION_KEY`, see A9) so View Key and the playground keep
working; this is a deliberate trade-off versus maas-api's show-once semantics. `keyPrefix` from
maas-api (for example `sk-oai-ab12`) is stored in `key_prefix` (`VARCHAR(20)`, truncated if longer).
Rotating `ENCRYPTION_KEY` makes stored keys unreadable (`500 ... cannot be decrypted`); affected users
rotate the key.

**Verify.** Confirm `keyPrefix` is at most 20 characters and check the plaintext is not logged:
`grep -c "sk-oai-" logs/backend.log` should be 0 after creating and revealing a key.

## A25. Re-login prompt contract

**Assumption.** `MAAS_REAUTH_REQUIRED` is returned as **HTTP 403** (not 401, which makes the SPA
log the user out), body `{error: {code: 'MAAS_REAUTH_REQUIRED', details: {reason}}}`. Operations
that fail with it: creating and rotating MaaS keys. Revoke, delete, archive, expiry cleanup, TPM and
model edits do not need the user token (they use the service account for the cluster and fall back
to the SA token for maas-api); a missing token only leaves the maas-api key to the reconciler. The
frontend must key on `error.code`, not on the HTTP status.

## F1. Frontend: browser calls to the MaaS gateway (Playground, curl examples)

**Assumption.** The Playground calls `<base>/v1/chat/completions` directly from the browser, where
`<base>` is the model's `maasEndpoint` (trailing `/v1` stripped) if present, else the key's
`baseUrl`, and sends `model = backendModelName` (falling back to the part after `/` of the model id).
This needs the maas gateway (Envoy/Authorino route) to answer CORS preflight for the LiteMaaS origin
and to accept `Authorization: Bearer sk-oai-...`. If CORS is not enabled the Playground fails for MaaS
keys while curl examples still work.

**Verify.**

```bash
curl -sk -i -X OPTIONS "$GATEWAY/<ns>/<model>/v1/chat/completions" \
  -H 'Origin: https://litemaas.apps.example.com' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: authorization,content-type'
```

## F2. Frontend: backend info on subscriptions

**Assumption.** `GET /subscriptions` does not return the model's backend. The Subscriptions page
infers MaaS from a `/` in `modelId` and, when MaaS is enabled, enriches backend and migration info
from `GET /models`. If the subscription payload later gains `modelBackendType`,
`modelMigrationState`, `modelMigrationGraceUntil` they are used directly.

**Verify.** `curl -s -H "Authorization: Bearer $JWT" $API/api/v1/subscriptions | jq '.data[0]'`.

## F3. Frontend: per-key model details

**Assumption.** Key `modelDetails[]` may optionally carry `backendType`, `backendModelName`,
`migrationState`, `migrationGraceUntil`; when absent the API Keys page falls back to the models list
from `GET /models` (loaded for subscribed models only) for the grace-period banner and curl example.

**Verify.** `curl -s -H "Authorization: Bearer $JWT" $API/api/v1/api-keys | jq '.data[0].modelDetails'`.

## A26. Limitador metric names and labels in Thanos

**Assumption.** Usage is read from Thanos Querier (`PROMETHEUS_URL`) as
`sum by (subscription, model) (increase(authorized_hits{subscription=~"(.*/)?litemaas-key-.+"}[86400s]))`
(tokens) and the same with `authorized_calls` (requests), where `subscription` is the
MaaSSubscription name (optionally `<namespace>/<name>`) and `model` is the MaaSModelRef name, the
served name, or `<namespace>/<name>`. Metric names are configurable with `MAAS_USAGE_HITS_METRIC` /
`MAAS_USAGE_CALLS_METRIC`; extra matchers (e.g. `namespace="kuadrant-system"`) with
`MAAS_USAGE_LABEL_MATCHERS`. If the `subscription` label does not exist (Limitador only labels what
the RateLimitPolicy/TokenRateLimitPolicy `counters` expose) there is no usage at all.

**Verify.**

```bash
TOKEN=$(oc whoami -t)
curl -sk -H "Authorization: Bearer $TOKEN" "$PROMETHEUS_URL/api/v1/label/__name__/values" | jq -r '.data[]' | grep -i authorized
curl -sk -H "Authorization: Bearer $TOKEN" --data-urlencode 'query=authorized_hits' "$PROMETHEUS_URL/api/v1/query" | jq '.data.result[0].metric'
# expect labels subscription and model; if absent the policy must add them as counters
```

## A27. Usage windows, extrapolation and retention

**Assumption.** A UTC day is `increase(<metric>[86400s])` evaluated at the next 00:00:00Z; today is
evaluated now over the seconds elapsed since 00:00:00Z. `increase()` extrapolates to the window
boundaries and is rounded to whole tokens/calls, so day totals can differ slightly from exact
counts, and a series created inside the window undercounts its first increment. Days older than the
Prometheus/Thanos retention (OpenShift default is about 15 days for the platform Prometheus) return
nothing and are cached permanently as LiteLLM-only: resync (`Usage Data Sync`) cannot backfill them.
Completed days are cached by the existing daily cache; a day whose MaaS fetch failed is NOT cached.

**Verify.**

```bash
D=$(date -u -d yesterday +%F); END=$(date -u -d "$D +1 day" +%s)
curl -sk -H "Authorization: Bearer $TOKEN" --data-urlencode "query=sum(increase(authorized_hits[86400s]))" \
  --data-urlencode "time=$END" "$PROMETHEUS_URL/api/v1/query" | jq '.data.result'
oc -n openshift-monitoring get prometheus k8s -o jsonpath='{.spec.retention}'
```

## A28. Cost estimate and missing token split

**Assumption.** Limitador records total tokens only (`authorized_hits` = hits_addend). Cost is
estimated as `tokens x blended price`, blended = `(input_cost_per_token + output_cost_per_token) / 2`
(or the single configured price; 0 when none). Prompt/completion split is unavailable: the admin
usage pipeline re-derives `total_tokens = prompt + completion`, so MaaS tokens are carried in
`prompt_tokens` (completion = 0) and the day's `rawData.sources.maas = { tokenSplitAvailable: false,
costEstimated: true }`. Streaming responses may count tokens only when the response completes
(TokenRateLimitPolicy extracts usage from the response body); verify streamed requests are counted.
Failed requests after authorization cannot be distinguished: `successful_requests = authorized_calls`,
`failed_requests = 0`.

**Verify.** Send one non-streamed and one streamed request with a MaaS key, wait one scrape interval,
and compare `increase(authorized_hits[5m])` for the key's subscription with the `usage` object in the
responses (`prompt_tokens + completion_tokens`).

## A29. Model label to LiteMaaS model resolution

**Assumption.** The Limitador `model` label equals the MaaSModelRef name, the served model name
(`backend_model_name`) or `<namespace>/<name>`; matching is case-insensitive. An unresolved label is
still reported (under the raw label, cost 0), which shows up as an unexpected model in the admin
charts.

**Verify.** `curl ... 'query=count by (model, subscription) (authorized_hits)'` and compare the
`model` values with `oc get maasmodelref -A -o custom-columns=NS:.metadata.namespace,NAME:.metadata.name`
and the `backend_model_name` column of the `models` table.

## A30. Migration semantics

**Assumption.** `POST /admin/models/:id/migrate-to-maas` copies the LiteLLM row (or fills an existing
synced MaaS row without overwriting admin fields, never lowering `restricted_access`), copies
**active** subscriptions as active (no re-approval), sets the old row `migration_state='migrating'`
and `migration_grace_until`, and blocks new subscriptions to the old model. LiteLLM access keeps
working during the grace period. After it, the reconciler (every `MAAS_RECONCILE_INTERVAL_MS`)
removes the model from users' LiteLLM keys (LiteLLM first; a key that cannot be updated keeps the
migration pending and is retried), deactivates the old subscriptions and marks the row
`unavailable` / `completed`. The LiteLLM model itself is NOT deleted from the LiteLLM proxy; the
admin should remove it there after completion. LiteLLM model sync skips `completed` rows so a model
still present in LiteLLM is not revived. Existing LiteLLM API keys are not converted: users create a
new MaaS key for the migrated model.

**Verify.**

```bash
curl -s -X POST -H "Authorization: Bearer $ADMIN_JWT" -H 'Content-Type: application/json' \
  -d '{"maasModelRef":{"name":"<ref>","namespace":"<ns>"},"graceDays":1}' \
  "$API/api/v1/admin/models/<litellm-model-id>/migrate-to-maas"
oc -n models-as-a-service get maasauthpolicy -l app.kubernetes.io/managed-by=litemaas
# after the grace period: POST /admin/maas/reconcile and check migrationsCompleted
```

## A31. Health section

**Assumption.** `GET /api/v1/health` gains a `maas` object (only when `MAAS_ENABLED=true`):
`{enabled, maasApi, kubernetes, prometheus: healthy|unhealthy|unconfigured, mock}`. Each check has a
5 s timeout and never affects `status`, `checks` or the HTTP status. The Kubernetes check is a `get`
of a non-existent MaaSAuthPolicy (404 counts as healthy, 403 as unhealthy) so it needs `get` on
`maasauthpolicies` in `MAAS_NAMESPACE`; the maas-api check calls `GET /health` of maas-api; the
Prometheus check runs `vector(1)`.

**Verify.** `curl -s $API/api/v1/health | jq .maas`
