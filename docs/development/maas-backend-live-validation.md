# MaaS Backend: Live Validation Runbook (RHOAI 3.5.x)

This runbook is for the engineer or agent who first runs the LiteMaaS MaaS backend on a real Red Hat
OpenShift AI 3.5.x cluster with the Models-as-a-Service stack installed.

The backend (`MAAS_ENABLED=true`, see [MaaS backend](../features/maas-backend.md)) was built and
tested against **mocks only**: an in-memory Kubernetes API, a mock maas-api and a mock Prometheus.
Every statement below about cluster behavior is an **assumption** taken from the RHOAI 3.4/3.5
documentation.

Each assumption has an ID (`A1`–`A31`, plus `F1`–`F3` for the frontend). Code comments and other docs
refer to these IDs, so keep them stable. Every entry follows the same layout:

- **Assumption**: what the code expects.
- **Verify**: exact commands to run.
- **Expected**: the result that confirms the assumption.
- **If different**: which file and function to change.

Work through the phases in order. Phase A needs no LiteMaaS at all, and its findings decide whether
code changes are needed before deploying. At the end, run the
[end-to-end acceptance test](#phase-e-end-to-end-acceptance) and fill in the
[results log](#results-log).

---

## 0. Prerequisites

### Cluster and access

- OpenShift 4.16 or later with RHOAI 3.5.x, the MaaS component enabled, and its gateway
  (`maas-default-gateway`), maas-api, Authorino and Limitador running.
- At least one model served through MaaS: an `LLMInferenceService` (or `ExternalModel`) plus a
  `MaaSModelRef` in status `Ready`.
- You need `cluster-admin` for RBAC and to read the `models-as-a-service` namespace.
- Two OpenShift users: an **admin** (in `litemaas-admins`) and a **regular user**. Their logins must
  work through the identity provider LiteMaaS will use.
- Tools: `oc`, `curl`, `jq`, `helm` (3.12 or later), and a browser.

### Shell variables used throughout

```bash
export DOMAIN=$(oc get ingresses.config cluster -o jsonpath='{.spec.domain}')   # apps.<cluster>
export NS=models-as-a-service                                 # MAAS_NAMESPACE
export LM_NS=litemaas                                         # LiteMaaS namespace
export RELEASE=litemaas                                       # Helm release name
export SA=system:serviceaccount:$LM_NS:$RELEASE               # Helm: SA = release fullname
#        (Kustomize: system:serviceaccount:$LM_NS:litemaas-backend)
export MAAS_API=https://maas.$DOMAIN/maas-api                 # confirm with the route below
export GATEWAY=https://maas.$DOMAIN                           # confirm with the gateway below
export PROM=https://thanos-querier.openshift-monitoring.svc.cluster.local:9091
export PROM_ROUTE=https://$(oc -n openshift-monitoring get route thanos-querier -o jsonpath='{.spec.host}')
export MODEL_NS=<namespace of the MaaSModelRef>
export MODEL_REF=<name of the MaaSModelRef>
export USER_TOKEN=$(oc whoami -t)      # log in as the REGULAR user first (oc login ...)
# LiteMaaS database (Helm-deployed PostgreSQL):
PSQL() { oc -n $LM_NS exec -i sts/$RELEASE-postgresql -- psql -U litemaas_admin -d litemaas_db -At -c "$1"; }
```

### Discover the MaaS endpoints

```bash
oc get crd | grep maas.opendatahub.io
oc get gateway -A | grep -i maas
oc get httproute -A | grep -i maas
oc -n $NS get route,svc | grep -i maas-api        # route host + path, or service:port
oc get maasmodelrefs.maas.opendatahub.io -A
```

**Expected.** The CRDs `maasmodelrefs`, `maasauthpolicies` and `maassubscriptions` are present in
group `maas.opendatahub.io` (version `v1alpha1`). There is one gateway and a maas-api route or
service, and at least one `MaaSModelRef` reports `PHASE=Ready`.

**If different.** If the API version or plural names differ, change the constants
`MAAS_API_VERSION`, `MAAS_MODEL_REF`, `MAAS_AUTH_POLICY` and `MAAS_SUBSCRIPTION` in
`backend/src/services/maas/maas-resources.ts`. Then fix the RBAC rules in
`deployment/helm/litemaas/templates/maas-rbac.yaml` and `deployment/kustomize/components/maas/*.template`.

**Note: 403 can mean a missing CRD.** A sandbox smoke test of `k8s-client.ts` against OpenShift
showed that, for an identity without cluster-wide rights, requests on a CRD that is **not installed**
return **403 Forbidden** and not 404, because RBAC is evaluated before the resource is resolved.
When the backend logs `cannot get resource "maasmodelrefs"` (or the MaaS health check reports 403),
check both the service account RBAC
(`oc auth can-i list maasmodelrefs.maas.opendatahub.io -A --as=system:serviceaccount:$LM_NS:<sa>`)
and the CRD presence (`oc get crd maasmodelrefs.maas.opendatahub.io`).

---

## Phase A: Cluster discovery (no LiteMaaS needed)

### A8. MaaSModelRef shape

**Assumption.** A `MaaSModelRef` lives in the model's namespace and has:

- `spec.modelRef{kind: LLMInferenceService|ExternalModel, name}`
- `status.phase` set to `Pending`, `Ready` or `Failed`
- `status.endpoint`, the inference URL
- optional annotations `openshift.io/display-name` and `openshift.io/description`

The LiteMaaS model id is `<namespace>/<name>`.

**Verify.**

```bash
oc -n $MODEL_NS get maasmodelref $MODEL_REF -o yaml
oc -n $MODEL_NS get maasmodelref $MODEL_REF -o jsonpath='{.status.phase} {.status.endpoint}{"\n"}'
```

**Expected.** The fields above exist with these names, and `status.endpoint` is an absolute URL.

**If different.** Adjust `parseModelRef()` in `backend/src/services/maas/maas-resources.ts`. It is
the only place that reads the object. The phase-to-availability mapping is in
`MaasModelSyncService.insertModel` / `updateModel` (`maas-model-sync.service.ts`).

### A13. Served model name

**Assumption.** The `model` field a client sends equals the `MaaSModelRef` name. The sync stores
the ref name in `models.backend_model_name`, and an admin can override it.

**Verify.**

```bash
oc -n $MODEL_NS get llminferenceservice -o yaml | grep -iA3 'served\|model:'   # served-model-name / spec.model.name
```

After A18 gives you a key `$SK`, run:

```bash
curl -sk "$(oc -n $MODEL_NS get maasmodelref $MODEL_REF -o jsonpath='{.status.endpoint}')/v1/models" \
  -H "Authorization: Bearer $SK" | jq -r '.data[].id'
```

**Expected.** The `/v1/models` id equals `$MODEL_REF`.

**If different.** If the served name follows a fixed rule (for example `spec.model.name` of the
`LLMInferenceService`), read it in `parseModelRef()` and use it in `insertModel()`
(`maas-model-sync.service.ts`). Otherwise document that admins must set the served name in the
model edit form.

### A22. Inference URL form (`maasEndpoint` vs gateway `baseUrl`)

**Assumption.**

- Clients call `<maasEndpoint>/v1/chat/completions`.
- If `maasEndpoint` already ends in `/v1`, that suffix is stripped first.
- Without an endpoint, clients fall back to `<MAAS_GATEWAY_URL>/v1/...`.
- The typical RHOAI form is `https://maas.<domain>/llm/<model>`; this is unverified.

**Verify.**

```bash
EP=$(oc -n $MODEL_NS get maasmodelref $MODEL_REF -o jsonpath='{.status.endpoint}'); echo $EP
curl -sk -o /dev/null -w '%{http_code}\n' "$EP/v1/models" -H "Authorization: Bearer $SK"
curl -sk -o /dev/null -w '%{http_code}\n' "$GATEWAY/v1/models" -H "Authorization: Bearer $SK"
```

**Expected.** The `$EP/v1/...` call returns 200. The bare gateway URL may return 404, which is
fine because the per-model endpoint is preferred.

**If different.** URL building is in two places:

- Frontend: `getModelBaseUrl()` in `frontend/src/utils/modelBackend.ts`.
- Backend: the `baseUrl` given to keys, from `ApiKeyService.maasBaseUrl` in
  `backend/src/services/api-key.service.ts`.

If `status.endpoint` is relative or missing, build it in `parseModelRef()`.

### A4. maas-api request/response contract

**Assumption.** maas-api calls carry the user's bearer token.

| Call | Request | Response |
| --- | --- | --- |
| `POST /v1/api-keys` | `{name, description, subscription, expiresIn:"<n>d"}` | `{id, key (sk-oai-...), keyPrefix, createdAt, expiresAt, subscription}` |
| `DELETE /v1/api-keys/{id}` | none | 2xx; 404 counts as already revoked |
| `POST /v1/api-keys/search` | `{}` or `{subscription}` | an array, or `{items\|keys\|data: []}` |
| `GET /health` | none | 2xx |

**Verify.** This needs a subscription; create the test one from A18 first.

```bash
curl -sk -i "$MAAS_API/health"
curl -sk -X POST "$MAAS_API/v1/api-keys" -H "Authorization: Bearer $USER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"v","description":"d","subscription":"litemaas-key-test","expiresIn":"30d"}' | tee /tmp/key.json | jq
export SK=$(jq -r .key /tmp/key.json) KEY_ID=$(jq -r .id /tmp/key.json)
curl -sk -X POST "$MAAS_API/v1/api-keys/search" -H "Authorization: Bearer $USER_TOKEN" \
  -H 'Content-Type: application/json' -d '{}' | jq
```

**Expected.** Create returns 200 or 201 with the fields above, and `keyPrefix` is at most 20
characters. Also note:

- whether `expiresIn` accepts `"30d"` (or only hours, `"720h"`),
- what the response looks like without `expiresIn`,
- what an unknown `subscription` returns.

**If different.**

- Expiry format: `formatExpiresIn()` in `backend/src/services/maas/maas-api.client.ts`.
- Request and response fields: `MaasApiClient.createKey()` / `searchKeys()` in the same file.
  Nothing else talks to maas-api.
- Status mapping (401/403 → `MAAS_REAUTH_REQUIRED`, other errors → `MAAS_ERROR`): same file.

### A18. The subscription must exist before the key (create ordering)

**Assumption.**

- `POST /v1/api-keys` succeeds only when the named `MaaSSubscription` exists and the caller is
  in `spec.owner.users`.
- It may succeed immediately after the subscription is applied, with no controller delay.
- `tokenRateLimits` is optional. LiteMaaS omits it when the key has no TPM limit.

**Verify.**

```bash
cat <<EOF | oc apply -f -
apiVersion: maas.opendatahub.io/v1alpha1
kind: MaaSSubscription
metadata: {name: litemaas-key-test, namespace: $NS}
spec:
  owner: {users: ["$(oc whoami)"], groups: []}
  modelRefs: [{name: $MODEL_REF, namespace: $MODEL_NS, tokenRateLimits: [{limit: 1000, window: "1m"}]}]
  priority: 0
EOF
# immediately, no sleep:
curl -sk -i -X POST "$MAAS_API/v1/api-keys" -H "Authorization: Bearer $USER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"v","description":"d","subscription":"litemaas-key-test","expiresIn":"1d"}'
oc -n $NS get maassubscription litemaas-key-test -o jsonpath='{.status}{"\n"}'
# negative cases: another user's subscription, and a missing one
curl -sk -o /dev/null -w '%{http_code}\n' -X POST "$MAAS_API/v1/api-keys" -H "Authorization: Bearer $USER_TOKEN" \
  -H 'Content-Type: application/json' -d '{"name":"v","subscription":"does-not-exist","expiresIn":"1d"}'
# without tokenRateLimits: apply the same object without tokenRateLimits; it must be accepted
```

**Expected.**

- The first call succeeds. A failure followed by success after a few seconds means the
  controller needs reconcile time.
- The negative cases return 4xx.
- A subscription without `tokenRateLimits` is accepted. Find out whether it means unlimited or
  denied.

**If different.**

- Controller delay: add a poll on `status.phase` of the `MaaSSubscription` between
  `applySubscription()` and the maas-api call in `MaasKeyService.createApiKey()`
  (`backend/src/services/maas/maas-key.service.ts`).
- `tokenRateLimits` required: change `buildSubscription()` in `maas-resources.ts` to always send a
  limit, and make TPM mandatory for MaaS keys in `MaasKeyService.validateTpm()`.

### A11. MaaSAuthPolicy semantics

**Assumption.**

- LiteMaaS keeps one policy per user: `litemaas-<sanitized-username>` in `$NS`, with
  `spec.subjects.users=[<username>]` and `spec.modelRefs=[{name, namespace}]`. The `namespace`
  is the `MaaSModelRef`'s namespace.
- Several policies naming the same user combine as a union.
- A user with **no** policy for a model is denied.
- LiteMaaS deletes the policy instead of writing an empty `modelRefs`.
- Access needs **both** a policy (authorization) and a subscription (owner plus rate limits).

**Verify.**

```bash
cat <<EOF | oc apply -f -
apiVersion: maas.opendatahub.io/v1alpha1
kind: MaaSAuthPolicy
metadata: {name: litemaas-validation, namespace: $NS}
spec:
  subjects: {users: ["$(oc whoami)"], groups: []}
  modelRefs: [{name: $MODEL_REF, namespace: $MODEL_NS}]
EOF
oc -n $NS get maasauthpolicy litemaas-validation -o jsonpath='{.status}{"\n"}'
curl -sk -o /dev/null -w '%{http_code}\n' "$EP/v1/chat/completions" -H "Authorization: Bearer $SK" \
  -H 'Content-Type: application/json' -d "{\"model\":\"$MODEL_REF\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"max_tokens\":5}"
oc -n $NS delete maasauthpolicy litemaas-validation      # then repeat the curl
```

**Expected.** The call returns 200 while the policy exists, and 401 or 403 a short time after it is
deleted. Record the delay under A12. Also check:

- Does the RHOAI installation ship a default policy granting a group such as
  `system:authenticated` access to every model? If so, LiteMaaS approvals don't restrict anything.
- Does a policy referencing an unknown model fail as a whole, or ignore that entry?

**If different.**

- Policy spec: `buildAuthPolicy()` in `maas-resources.ts`.
- Delete-versus-empty behavior: `MaasAccessService.syncUserAuthPolicy()` in
  `maas-access.service.ts`.

If a default allow-all policy exists, document that it must be removed for restricted models to
work.

### A12 and A23. Revocation latency and editing live subscriptions

**Assumption.** An already-issued key loses access within seconds to a minute, with no maas-api
revoke, when any of these happens:

- its `MaaSSubscription` is deleted,
- a model is removed from the subscription's `modelRefs`,
- the user's policy loses the model.

Changing `tokenRateLimits` on a live subscription changes the effective limit for existing keys.

**Verify.**

```bash
t0=$(date +%s)
oc -n $NS patch maassubscription litemaas-key-test --type=json -p '[{"op":"replace","path":"/spec/modelRefs/0/tokenRateLimits/0/limit","value":10}]'
# send requests until 429, and record the seconds since t0
oc -n $NS delete maassubscription litemaas-key-test
while [ "$(curl -sk -o /dev/null -w '%{http_code}' "$EP/v1/models" -H "Authorization: Bearer $SK")" = 200 ]; do sleep 2; done
echo "revoked after $(( $(date +%s) - t0 ))s"
```

**Expected.** Requests start returning 429 after the lower limit, and 401 or 403 after the
deletion, both within roughly 60 s. Write the measured delays in
[MaaS backend → Limitations](../features/maas-backend.md#limitations).

**If different.** If a deleted subscription does **not** stop the key, revocation must also revoke
the key in maas-api synchronously. Change `MaasKeyService.clusterRevoke()` (`maas-key.service.ts`)
to fail the operation when `revokeInMaasApi()` fails, instead of marking the key `pending`.

### A19. Who may revoke a maas-api key

**Assumption.** The owner's token can revoke the key. The LiteMaaS ServiceAccount token may or may
not be able to; LiteMaaS treats SA revocation as best effort.

**Verify.** Create a key as the user, then:

```bash
SA_TOKEN=$(oc -n $LM_NS create token $RELEASE)     # after LiteMaaS is deployed; or any SA
curl -sk -i -X DELETE "$MAAS_API/v1/api-keys/$KEY_ID" -H "Authorization: Bearer $SA_TOKEN"
curl -sk -i -X DELETE "$MAAS_API/v1/api-keys/$KEY_ID" -H "Authorization: Bearer $USER_TOKEN"
```

**Expected.** The owner gets a 2xx (and a 404 on a second call). The SA gets 2xx or 401/403;
record which.

**If different.** If the SA must be in a maas-api admin group, add the group or RBAC to the charts
(`maas-rbac.yaml`) and document it. Without SA rights, keys revoked while the user's token is
expired stay `pending`. They are harmless, because their subscription is gone, and are retried by
`MaasReconcilerService.revokeInMaasApi()`.

### A20. Key expiry

**Assumption.** `expiresIn` sets the lifetime, the response contains `expiresAt`, and maas-api has
**no** call to extend a key.

**Verify.** Compare `expiresAt` from A4 with now plus 30 days. Check the maas-api OpenAPI spec, if
it serves one (`curl -sk $MAAS_API/openapi.json`), for a PATCH or extend call.

**If different.** If an extend call exists, implement it in `MaasKeyService.updateExpiration()`
(`maas-key.service.ts`) and remove the shorten-only rule there, along with its route check in
`backend/src/routes/api-keys.ts` (`updateMaasExpiration`).

### A21. Two keys on one subscription (rotation)

**Assumption.** A second key can be created on the same subscription with the same name, and
revoking one leaves the other working.

**Verify.** Create two keys with identical `name` and `subscription` (as in A4), call the model with
both, revoke one, and call again with the other.

**If different.** Change `MaasKeyService.rotateApiKey()` to revoke first and then create (a short
outage is accepted).

### A26. Limitador metric names and labels in Thanos

**Assumption.** Thanos exposes `authorized_hits` (tokens) and `authorized_calls` (requests) with the
labels `subscription` (the `MaaSSubscription` name, possibly `<ns>/<name>`) and `model`.

**Verify.** Send a few requests with `$SK` first.

```bash
PT=$(oc whoami -t)        # a cluster-admin token works; the SA uses cluster-monitoring-view
curl -sk -H "Authorization: Bearer $PT" "$PROM_ROUTE/api/v1/label/__name__/values" | jq -r '.data[]' | grep -iE 'authorized|limitador'
curl -sk -H "Authorization: Bearer $PT" --data-urlencode 'query=authorized_hits' "$PROM_ROUTE/api/v1/query" | jq '.data.result[].metric'
curl -sk -H "Authorization: Bearer $PT" --data-urlencode 'query=authorized_calls' "$PROM_ROUTE/api/v1/query" | jq '.data.result[].metric'
```

**Expected.** Both metrics exist and carry `subscription` and `model` labels whose values match
`litemaas-key-test` and the model.

**If different.**

- Different metric names: set `MAAS_USAGE_HITS_METRIC` / `MAAS_USAGE_CALLS_METRIC`.
- An extra label is needed to pick the right series: set `MAAS_USAGE_LABEL_MATCHERS`.
- Different label names: change `MaasUsageSource.promql()` / `queryDayRows()`
  (`backend/src/services/maas/maas-usage.source.ts`) and `stripNamespace()`.
- No `subscription` label at all: per-key usage can't work. Raise this with the platform team;
  the TokenRateLimitPolicy counters must include it.

### A27. Usage windows and retention

**Assumption.**

- A UTC day is `increase(<metric>[86400s])` evaluated at the next 00:00:00Z. Today uses the
  seconds elapsed since 00:00:00Z.
- Days older than retention return nothing.
- Retention is about 15 days for platform Prometheus, longer when Thanos has object storage.

**Verify.**

```bash
D=$(date -u -d yesterday +%F); END=$(date -u -d "$D +1 day" +%s)
curl -sk -H "Authorization: Bearer $PT" --data-urlencode 'query=sum(increase(authorized_hits[86400s]))' \
  --data-urlencode "time=$END" "$PROM_ROUTE/api/v1/query" | jq '.data.result'
oc -n openshift-monitoring get prometheus k8s -o jsonpath='{.spec.retention}{"\n"}'
oc -n openshift-user-workload-monitoring get prometheus user-workload -o jsonpath='{.spec.retention}{"\n"}' 2>/dev/null
```

**Expected.** A number close to the tokens you sent, and a known retention period. Write the
retention down; it bounds what the Usage Data Sync tool can backfill.

**If different.** Window logic is `dayWindow()` in `maas-usage.source.ts`.

### A28. Token accounting and streaming

**Assumption.**

- `authorized_hits` counts the **total** tokens (prompt plus completion) of each request.
- Streamed responses are counted too.

**Verify.** Send one non-streamed and one streamed (`"stream":true`) request. Wait one scrape
interval, then compare `increase(authorized_hits{subscription=~".*litemaas-key-test"}[5m])` with the
`usage` block of the non-streamed response.

**Expected.** The increase equals prompt plus completion tokens for both requests.

**If different.** If only completion or only prompt tokens are counted, adjust the mapping in
`MaasUsageSource.getDayData()` (it puts all tokens in `prompt_tokens`) and the cost formula
(`MaasUsageSource.unitPrice()`). If streamed tokens aren't counted, document the gap in the feature
Limitations.

### A29. `model` label to LiteMaaS model

**Assumption.** The Limitador `model` label is one of: the MaaSModelRef name, the served name
(`backend_model_name`), or `<namespace>/<name>`. Matching is case-insensitive.

**Verify.**

```bash
curl -sk -H "Authorization: Bearer $PT" --data-urlencode 'query=count by (model, subscription) (authorized_hits)' \
  "$PROM_ROUTE/api/v1/query" | jq -r '.data.result[].metric | "\(.model) \(.subscription)"'
```

**Expected.** The `model` values match one of the forms above.

**If different.** Extend the resolver in `MaasUsageSource.loadModels()` / `resolver()`
(`maas-usage.source.ts`).

### F1. Browser calls to the gateway (Playground CORS)

**Assumption.** The Playground posts from the browser to `<endpoint>/v1/chat/completions` with
`Authorization: Bearer sk-oai-...`, so the gateway must answer the CORS preflight.

**Verify.**

```bash
curl -sk -i -X OPTIONS "$EP/v1/chat/completions" \
  -H "Origin: https://litemaas.$DOMAIN" -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: authorization,content-type'
```

**Expected.** A 2xx with `access-control-allow-origin` covering the LiteMaaS origin.

**If different.** The Playground can't work for MaaS keys; curl and SDK clients are unaffected.
Either ask the platform team to add a CORS policy on the MaaS HTTPRoute or gateway, or proxy
Playground calls through the LiteMaaS backend (a new route; frontend `ChatbotPage.tsx` /
`chat.service.ts`).

**Clean up Phase A.**

```bash
oc -n $NS delete maassubscription litemaas-key-test --ignore-not-found
```

Revoke the test keys with `DELETE $MAAS_API/v1/api-keys/<id>`.

---

## Phase B: Deploy LiteMaaS with MaaS enabled

Deploy with Helm (`deployment/helm/litemaas/values.maas.example.yaml`; see the
[Helm guide](../deployment/helm-deployment.md#rhoai-models-as-a-service-maas)) or with Kustomize
(`components/maas`). Use the URLs discovered in step 0 and Phase A.

### A6 and A14. ServiceAccount RBAC

**Assumption.** The backend ServiceAccount has these permissions:

- `get/list/watch` on `maasmodelrefs`, cluster-wide or per `MAAS_MODEL_NAMESPACES` namespace.
- `get/list/watch/create/update/patch/delete` on `maasauthpolicies` and `maassubscriptions` in
  `$NS`. Updates use `replace`, i.e. PUT with `resourceVersion`.
- `cluster-monitoring-view`, for Thanos.

**Verify.**

```bash
oc auth can-i list maasmodelrefs.maas.opendatahub.io --all-namespaces --as=$SA
for r in maasauthpolicies maassubscriptions; do for v in get list create update patch delete; do
  printf '%-18s %-7s ' $r $v; oc -n $NS auth can-i $v $r.maas.opendatahub.io --as=$SA; done; done
oc auth can-i get namespaces --as=$SA        # cluster-monitoring-view implies namespace get
```

**Expected.** Every check prints `yes`.

**If different.** Fix `deployment/helm/litemaas/templates/maas-rbac.yaml` and
`deployment/kustomize/components/maas/maas-rbac.yaml.template` /
`maas-namespace-rbac.yaml.template`.

### A5. TLS trust

**Assumption.** The Kubernetes API and Thanos (`*.svc`) are signed by the service-account CA
(`ca.crt`) or the service CA (`service-ca.crt`). The maas-api route is signed by the ingress CA,
which reaches the pod through the injected trusted CA bundle (`NODE_EXTRA_CA_CERTS`).
`loadClusterCaBundle()` combines the system roots, both service-account CA files and the
`NODE_EXTRA_CA_CERTS` file.

**Verify.**

```bash
oc -n $LM_NS get cm $RELEASE-backend-trusted-ca -o jsonpath='{.data.ca-bundle\.crt}' | head -c 100; echo
oc -n $LM_NS exec deploy/$RELEASE-backend -- sh -c 'ls /var/run/secrets/kubernetes.io/serviceaccount/ /etc/pki/litemaas-trusted-ca/; echo $NODE_EXTRA_CA_CERTS'
oc -n $LM_NS exec deploy/$RELEASE-backend -- node -e "fetch('$MAAS_API/health').then(r=>console.log(r.status)).catch(e=>console.log(e.cause||e))"
oc -n $LM_NS logs deploy/$RELEASE-backend | grep -iE 'self.signed|unable to verify|CERT_' | tail
```

**Expected.** The injected bundle isn't empty, the node fetch prints a status code rather than a
certificate error, and the logs show no TLS errors.

**If different.** Point `MAAS_API_URL` at the in-cluster maas-api **Service** (signed by the service
CA), or mount the right CA (`maas.trustedCaBundle.existingConfigMap`). As a last resort for tests
only, set `MAAS_API_SKIP_TLS_VERIFY=true` (insecure; independent of `K8S_API_SKIP_TLS_VERIFY`, which no longer affects maas-api).

### A7, A31 and A10. In-cluster configuration, health and config

**Assumption.**

- With no `K8S_*` set, the backend uses `KUBERNETES_SERVICE_HOST` and re-reads the projected SA
  token on every request.
- Prometheus uses the same token unless `PROMETHEUS_TOKEN` is set.
- `/health` reports a `maas` section. That section never changes the overall status.

**Verify.**

```bash
LM=https://$(oc -n $LM_NS get route -o jsonpath='{.items[0].spec.host}')
curl -sk $LM/api/v1/health | jq '{status, maas}'
curl -sk $LM/api/v1/config | jq '{maasEnabled, maasGatewayUrl}'
oc -n $LM_NS logs deploy/$RELEASE-backend | grep -i 'maas' | head
```

**Expected.** `maas` reports `{enabled:true, maasApi:"healthy", kubernetes:"healthy",
prometheus:"healthy", mock:false}`, and `maasEnabled` is true. Run the health check again after
more than one hour (token rotation): it must still be healthy.

**If different.**

- `mock:true` means an endpoint variable is empty. In production it surfaces as 503 errors.
- `kubernetes:"unhealthy"`: the health check reads a non-existent policy, so this means RBAC
  (A6).
- `prometheus` unhealthy: check `PROMETHEUS_URL`, `cluster-monitoring-view` and A5.

The health check code is `checkMaasHealth` in `backend/src/routes/health.ts`.

### A17. Model ids with `/` through the route

**Assumption.** The OpenShift route passes `%2F` through, and Fastify decodes it.

**Verify.**

```bash
curl -sk -H "Authorization: Bearer $USER_JWT" "$LM/api/v1/models/$MODEL_NS%2F$MODEL_REF" | jq '{id, backendType}'
```

`USER_JWT` comes from the browser, as described in Phase C.

**Expected.** The model JSON is returned.

**If different.** Any proxy between the route and the backend must preserve encoded slashes (for
nginx: `proxy_pass` without a URI part, `merge_slashes off`). The frontend container's nginx
config is in `frontend/`. The alternative is to change `maasModelId()` in `maas-resources.ts` to a
separator other than `/`; that needs a data migration.

### A16. Multi-replica locking

**Assumption.** The reconciler (lock `0x4d414153`) and the MaaS model sync (`0x4d414154`) use
session-level `pg_try_advisory_lock`. They are safe with direct PostgreSQL connections, but not
behind a transaction-mode pooler.

**Verify.** With two backend replicas:

```bash
PSQL "SELECT pid, objid FROM pg_locks WHERE locktype='advisory'"
oc -n $LM_NS logs -l app.kubernetes.io/component=api --tail=200 | grep -i 'lock'
```

**Expected.** At most one holder per lock id.

**If different.** Run a single replica, or connect the backend directly to PostgreSQL rather than
through pgbouncer in transaction mode.

---

## Phase C: Identity (login token reused for maas-api)

Get LiteMaaS JWTs for the next steps. Log in through the UI as the user, then as the admin, and in
the browser devtools run `localStorage.getItem('access_token')`. Export the results as `USER_JWT`
and `ADMIN_JWT`.

### A3. Username match

**Assumption.** `users.username` in LiteMaaS equals the OpenShift `User` name, which is also the
identity Authorino and maas-api see. It is written into `subjects.users`, `owner.users` and CR
names.

**Verify.**

```bash
PSQL "SELECT username FROM users ORDER BY created_at DESC LIMIT 5"
oc get users -o custom-columns=NAME:.metadata.name,IDENTITIES:.identities
oc -n $NS get maassubscription,maasauthpolicy -l app.kubernetes.io/managed-by=litemaas \
  -o custom-columns=NAME:.metadata.name,USER:.metadata.annotations.litemaas\\.io/username
```

**Expected.** The names are identical. Check special cases: `kube:admin`, emails (OIDC),
upper-case names, and identity-provider mapping methods `add`/`generate`.

**If different.** Both `MaasAccessService.getUsername()` (`maas-access.service.ts`) and
`MaasKeyService.getUsername()` (`maas-key.service.ts`) read `users.username`. Map from the OpenShift
`User` name there; `getOpenShiftUserInfo` in `oauth.service.ts` already reads it as
`preferred_username`. OIDC deployments may need a prefix such as `oidc:`.

### A1. The login token is accepted by maas-api

**Assumption.** The access token from the LiteMaaS OAuth login is accepted by maas-api. Its default
scopes are `user:info user:check-access`. It is stored encrypted in `user_oauth_tokens`.

**Verify (authoritative, through LiteMaaS).** Log in as the user, subscribe to the MaaS model, and
create a MaaS key in the UI. On failure, check the logs:

```bash
PSQL "SELECT user_id, expires_at, scope FROM user_oauth_tokens"
oc -n $LM_NS logs deploy/$RELEASE-backend | grep -iE 'maas.*(401|403)|MAAS_REAUTH' | tail
```

**Expected.** The key is created. A failure with `MAAS_REAUTH_REQUIRED` and
`details.reason: 'maas-api responded 401/403'`, right after a fresh login, means the scope or
audience is wrong.

**If different.** Set `OAUTH_SCOPES` (Helm: `maas.oauthScopes`), for example
`user:info user:check-access user:full`. Then:

- **ServiceAccount OAuth client** (Helm default `oauth.mode=serviceaccount`): it can only request
  `user:info`, `user:check-access`, `user:list-projects` and `role:<role>:<ns>` scopes. If maas-api
  needs more, switch to `oauth.mode=external` with an `OAuthClient` that allows the scope
  (`scopeRestrictions`).
- **OIDC**: if maas-api needs a token for a different audience, `routes/auth.ts` needs a
  token-exchange step before `UserTokenService.storeToken()`.
- In every case, users must log in again.

### A2. Token lifetime

**Assumption.** The token response carries `expires_in`. Tokens count as expired 30 s early, and
there is no refresh, so an expired token means the user must log in again.

**Verify.**

```bash
oc get oauth cluster -o jsonpath='{.spec.tokenConfig}{"\n"}'
oc get oauthclient <client> -o jsonpath='{.accessTokenMaxAgeSeconds}{"\n"}'   # external mode
PSQL "SELECT user_id, expires_at - now() FROM user_oauth_tokens"
```

**Expected.** `expires_at` is set, and the remaining time matches the configured lifetime
(24 h by default).

**If different.** When `expires_in` is missing, expiry is only discovered on a 401/403 from
maas-api. That is handled, but users get the prompt later. The skew is `EXPIRY_SKEW_MS` in
`backend/src/services/maas/user-token.service.ts`.

### A25. Re-login prompt

**Assumption.** A missing or expired token returns **HTTP 403** with
`{error:{code:'MAAS_REAUTH_REQUIRED', details:{reason}}}`. It is deliberately not 401, because 401
logs the SPA out.

**Verify.**

```bash
PSQL "DELETE FROM user_oauth_tokens WHERE user_id = (SELECT id FROM users WHERE username='<user>')"
```

Then create a MaaS key in the UI.

**Expected.** The create modal stays open with a "log in again" alert, and **Re-authenticate**
returns to API Keys. Afterwards a key can be created.

**If different.** On the frontend, see `isMaasReauthError()` (`frontend/src/utils/modelBackend.ts`)
and `MaasReauthAlert`. On the backend, `ApplicationError.maasReauthRequired`.

---

## Phase D: Behavior through LiteMaaS

### Model sync (A8 and A13 in practice)

```bash
curl -sk -X POST -H "Authorization: Bearer $ADMIN_JWT" -H 'Content-Type: application/json' -d '{}' $LM/api/v1/admin/models/maas/sync | jq
curl -sk -H "Authorization: Bearer $ADMIN_JWT" $LM/api/v1/admin/models/maas/refs | jq '.data[] | {id, phase, endpoint, imported}'
PSQL "SELECT id, availability, maas_phase, maas_endpoint, backend_model_name FROM models WHERE backend_type='maas'"
```

**Expected.** Every Ready ref is imported as available, and refs that aren't Ready are imported as
unavailable. A LiteLLM model sync afterwards must not touch these rows:
`POST /api/v1/models/sync` (admin), then re-run the query.

### Subscriptions to policies (A11 in practice)

Subscribe as the user (approve as the admin if the model is restricted), then run:

```bash
oc -n $NS get maasauthpolicy -l app.kubernetes.io/managed-by=litemaas -o yaml | grep -A8 'spec:'
```

Cancel the subscription and check that the user's policy loses the model, or is deleted when no
MaaS model is left.

### Keys (A18, A24)

Create a MaaS key in the UI with a TPM limit, then:

```bash
oc -n $NS get maassubscription -l app.kubernetes.io/managed-by=litemaas -o yaml | grep -A12 'spec:'
PSQL "SELECT id, key_prefix, maas_key_id, maas_sync_state, length(encrypted_key) FROM api_keys WHERE backend_type='maas'"
oc -n $LM_NS logs deploy/$RELEASE-backend | grep -c 'sk-oai-'      # must be 0 (no plaintext in logs)
```

**Expected.** One `litemaas-key-<id>` per key, with `tokenRateLimits` equal to the TPM. The key row
is `synced`, and View Key shows the same plaintext.

Then edit the TPM and confirm `tokenRateLimits` changes (A23). Remove a model and confirm
`modelRefs` changes. Shorten the expiry: a later date must be refused (A20). Rotate the key: the old
key stops working and the new one works (A21).

### Reconciler (A15)

**Assumption.** The desired spec is compared with the live spec using JSON equality. If the API
server adds defaults, every pass rewrites every object.

**Verify.**

```bash
for i in 1 2; do curl -sk -X POST -H "Authorization: Bearer $ADMIN_JWT" -H 'Content-Type: application/json' -d '{}' $LM/api/v1/admin/maas/reconcile | jq -c .data; done
```

**Expected.** The second run reports `policiesApplied: 0` and `subscriptionsApplied: 0`.

**If different.** Compare `oc get maassubscription <n> -o jsonpath='{.spec}'` with
`buildSubscription()` / `buildAuthPolicy()` and normalize the difference. The comparison is in
`MaasReconcilerService.reconcilePolicies()` / `reconcileSubscriptions()`
(`maas-reconciler.service.ts`). Also confirm that no operator-created object carries
`app.kubernetes.io/managed-by=litemaas`, because orphans with that label are deleted.

### Revocation (A12, A19 in practice)

Revoke a key in the UI, then:

```bash
oc -n $NS get maassubscription litemaas-key-<id>          # NotFound
PSQL "SELECT is_active, maas_sync_state, maas_last_error FROM api_keys WHERE id='<id>'"
```

**Expected.** The key is inactive with state `synced`. If the state is `pending`, the maas-api
revoke was refused (A19); the key is still inert, and the reconciler retries
(`maasApiRevokePending`).

### Usage (A26 to A29 in practice)

After some traffic with a LiteMaaS-issued key, wait at least five minutes (the MaaS query cache),
then:

```bash
curl -sk -H "Authorization: Bearer $USER_JWT" $LM/api/v1/usage/budget | jq '{currentSpend, maasSpend, maasTokens}'
curl -sk -X POST -H "Authorization: Bearer $ADMIN_JWT" $LM/api/v1/admin/usage/refresh-today
```

**Expected.** `maasTokens` is greater than 0. Admin Usage shows the MaaS model attributed to the
right user, with cost equal to tokens × the blended price.

### Migration (A30)

**Assumption.** **Migrate to MaaS** behaves as follows:

- It copies the model and its **active** subscriptions, with no re-approval.
- It blocks new subscriptions to the LiteLLM model.
- LiteLLM access keeps working until the grace period ends.
- When the grace period ends, the reconciler removes the model from users' LiteLLM keys and marks
  the LiteLLM row `completed`.

**Verify.** Use a test LiteLLM model, with `graceDays: 1` in the UI or through the API:

```bash
curl -sk -X POST -H "Authorization: Bearer $ADMIN_JWT" -H 'Content-Type: application/json' \
  -d "{\"maasModelRef\":{\"name\":\"$MODEL_REF\",\"namespace\":\"$MODEL_NS\"},\"graceDays\":1}" \
  "$LM/api/v1/admin/models/<litellm-id-url-encoded>/migrate-to-maas" | jq .data
oc -n $NS get maasauthpolicy -l app.kubernetes.io/managed-by=litemaas
PSQL "UPDATE models SET migration_grace_until = now() - interval '1 minute' WHERE id='<litellm-id>'"   # fast-forward
curl -sk -X POST -H "Authorization: Bearer $ADMIN_JWT" -H 'Content-Type: application/json' -d '{}' $LM/api/v1/admin/maas/reconcile | jq '.data | {migrationsCompleted, migrationsPending}'
```

**Expected.**

- `subscriptionsCopied` equals the number of active subscriptions, and policies exist for those
  users.
- After the fast-forward, `migrationsCompleted` is 1 and the LiteLLM keys no longer list the
  model. The model still exists in LiteLLM itself; delete it there manually.

**If different.** The logic is in `MaasMigrationService.migrate()` / `processExpiredGrace()`
(`maas-migration.service.ts`).

### A9. Encryption key

**Assumption.**

- `ENCRYPTION_KEY` is unset, so the key falls back to `LITELLM_MASTER_KEY`, then
  `LITELLM_API_KEY`.
- The fallback key is the same one earlier versions used, so existing `models.encrypted_api_key`
  values still decrypt.
- Setting `ENCRYPTION_KEY` later breaks them, and there is no automatic re-encryption.

**Verify.**

```bash
PSQL "SELECT count(*) FROM models WHERE encrypted_api_key IS NOT NULL"
```

Edit a LiteLLM model in the UI: **Test configuration** must work without re-entering the key.

**If different.** Rotation procedure, not automated:

1. Decrypt the values with the old key and re-encrypt them with the new one, for
   `models.encrypted_api_key` and `api_keys.encrypted_key`.
2. Delete `user_oauth_tokens`; users log in again.

### A32. Old maas-api key stays valid after rotation until revoked

LiteMaaS records the replaced maas-api key id in `api_keys.maas_pending_revoke_ids` and the
reconciler retries `DELETE /v1/api-keys/{id}` until it succeeds. Verify that a revoked key id is
rejected on the gateway immediately and that the service-account token may revoke other users' keys.

```bash
curl -s -X DELETE -H "Authorization: Bearer $(oc whoami -t)" "$MAAS_API_URL/v1/api-keys/$OLD_ID" -o /dev/null -w '%{http_code}\n'
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $OLD_SK" "$GATEWAY_URL/v1/models"   # expect 401/403
```

### A33. Per-key subscriptions only contain models with an active LiteMaaS subscription

The reconciler drops models from a key's MaaSSubscription when the owner has no `active`
subscription for them (admin-created keys with models but no subscription lose access, matching
the AuthPolicy). Verify that no workflow relies on key models without a subscription.

```bash
oc get maassubscription -n models-as-a-service -l app.kubernetes.io/managed-by=litemaas -o yaml | grep -A3 modelRefs
```

### F2 and F3. Frontend backend info (resolved)

`GET /subscriptions` now returns `modelBackendType`, `modelMigrationState` and
`modelMigrationGraceUntil`. API key `modelDetails[]` now include `backendType`, `backendModelName`,
`migrationState` and `migrationGraceUntil`.

**Verify.**

```bash
curl -sk -H "Authorization: Bearer $USER_JWT" $LM/api/v1/subscriptions | jq '.data[] | {modelId, modelBackendType}'
curl -sk -H "Authorization: Bearer $USER_JWT" $LM/api/v1/api-keys | jq '.data[0].modelDetails'
```

---

## Phase E: End-to-end acceptance

`dev-tools/maas-acceptance.sh` runs the whole user flow against the live deployment and exits
non-zero at the first failed check:

1. Config and health (no mock).
2. Model sync, then the model is visible with `backendType=maas`.
3. Subscribe, and optionally restrict the model with `RESTRICT=1`.
4. Admin approves the subscription; it becomes active.
5. The `MaaSAuthPolicy` names the model.
6. Create a MaaS key with a TPM limit (`sk-oai-...`).
7. The `MaaSSubscription` `litemaas-key-<id>` exists.
8. Inference through the gateway with the served model name returns 200.
9. View Key returns the same plaintext.
10. Revoke the key: the subscription is deleted and the gateway returns **401/403**. The script
    prints the revocation latency.
11. Usage appears: `GET /usage/budget` shows `maasTokens > 0` and admin analytics contain the
    model.
12. A second reconciler pass applies nothing.

```bash
export LITEMAAS_URL=https://litemaas.$DOMAIN USER_JWT=... ADMIN_JWT=... MODEL_ID=$MODEL_NS/$MODEL_REF
RESTRICT=1 ./dev-tools/maas-acceptance.sh 2>&1 | tee maas-acceptance.log
```

Steps 1–10 take a few minutes. Step 11 waits up to `USAGE_WAIT_S` (default 900 s) for Thanos to
scrape Limitador and for the 5-minute usage query cache to expire. Run the script once as-is, and
again after an expired-token scenario (A25) to confirm the re-login path.

---

## Code change map

| Finding | File | Function or symbol |
| --- | --- | --- |
| CRD group, version or plural differs | `backend/src/services/maas/maas-resources.ts` | `MAAS_API_VERSION`, `MAAS_MODEL_REF`, `MAAS_AUTH_POLICY`, `MAAS_SUBSCRIPTION` |
| MaaSModelRef fields differ, served name, endpoint | `maas-resources.ts`, `maas-model-sync.service.ts` | `parseModelRef()`, `insertModel()`, `updateModel()` |
| AuthPolicy or Subscription spec shape | `maas-resources.ts` | `buildAuthPolicy()`, `buildSubscription()`, `TPM_WINDOW` |
| Empty policy semantics | `maas-access.service.ts` | `syncUserAuthPolicy()` |
| Username mapping | `maas-access.service.ts`, `maas-key.service.ts` | `getUsername()` |
| maas-api request, response or status mapping | `maas-api.client.ts` | `MaasApiClient.createKey()`, `revokeKey()`, `searchKeys()`, `formatExpiresIn()` |
| Controller delay before maas-api accepts a new subscription | `maas-key.service.ts` | `createApiKey()` (between `applySubscription()` and the maas-api call) |
| Revocation semantics, SA revoke | `maas-key.service.ts`, `maas-reconciler.service.ts` | `clusterRevoke()`, `revokeInMaasApi()` |
| Expiry or rotation | `maas-key.service.ts` | `updateExpiration()`, `rotateApiKey()` |
| Reconcile never converges | `maas-reconciler.service.ts` | `reconcilePolicies()`, `reconcileSubscriptions()` |
| Metric names, labels, windows | env `MAAS_USAGE_*`; `maas-usage.source.ts` | `promql()`, `queryDayRows()`, `dayWindow()`, `stripNamespace()` |
| Model label resolution, cost | `maas-usage.source.ts` | `loadModels()`, `resolver()`, `getDayData()` |
| Login token scope or audience | env `OAUTH_SCOPES`; `services/oauth.service.ts`, `routes/auth.ts` | `getScopes()`, callback / `UserTokenService.storeToken()` |
| Token expiry skew | `maas/user-token.service.ts` | `EXPIRY_SKEW_MS` |
| TLS trust | `services/http/tls-fetch.ts`, chart values | `loadClusterCaBundle()`, `maas.trustedCaBundle` |
| RBAC | `deployment/helm/litemaas/templates/maas-rbac.yaml`, `deployment/kustomize/components/maas/` | — |
| Inference base URL (curl, Playground) | `frontend/src/utils/modelBackend.ts`, `backend/src/services/api-key.service.ts` | `getModelBaseUrl()`, `maasBaseUrl` |
| Health checks | `backend/src/routes/health.ts` | `checkMaasHealth` |

After any code change, run `cd backend && npx vitest run tests/unit/services/maas tests/integration/routes/maas-*`
and `cd frontend && npx vitest run src/test/components/maas`.

---

## Results log

Copy this table into the PR or issue and fill it in.

| ID | Result (OK / changed / blocked) | Notes (measured values, links) |
| --- | --- | --- |
| A1 token accepted by maas-api | | scopes used: |
| A2 token lifetime | | |
| A3 username match | | |
| A4 maas-api contract | | expiresIn format: |
| A5 TLS | | |
| A6/A14 RBAC | | |
| A7 in-cluster config, token rotation | | |
| A8 MaaSModelRef shape | | |
| A9 encryption key | | |
| A10 config | | |
| A11 AuthPolicy semantics | | default allow-all policy present? |
| A12 revocation latency | | seconds: |
| A13 served name | | |
| A15 reconcile converges | | |
| A16 locking | | |
| A17 `%2F` through route | | |
| A18 create ordering | | controller delay: |
| A19 SA revoke | | |
| A20 expiry | | |
| A21 rotation | | |
| A22 endpoint form | | |
| A23 live subscription edits | | seconds to 429: |
| A24 key prefix, no plaintext in logs | | |
| A25 re-login prompt | | |
| A26 metric names and labels | | |
| A27 windows and retention | | retention: |
| A28 token accounting, streaming | | |
| A29 model label | | |
| A30 migration | | |
| A31 health | | |
| F1 gateway CORS | | |
| E2E `maas-acceptance.sh` | | log attached |
