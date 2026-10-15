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
