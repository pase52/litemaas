#!/usr/bin/env bash
# =============================================================================
# LiteMaaS <-> RHOAI Models-as-a-Service end-to-end acceptance test
# =============================================================================
# Runs the full user flow against a LIVE deployment (MAAS_ENABLED=true, no mock clients):
#   config/health -> model sync -> subscribe -> approve -> MaaSAuthPolicy -> MaaS key
#   -> MaaSSubscription -> inference through the MaaS gateway -> usage (budget + admin analytics)
#   -> revoke -> gateway answers 401/403 -> cluster objects gone
#
# See docs/development/maas-backend-live-validation.md (section "End-to-end acceptance").
#
# Requirements: bash, curl, jq, oc (logged in as a user that can read the MaaS namespace).
#
# Required environment:
#   LITEMAAS_URL   LiteMaaS public URL (frontend route; /api is proxied), e.g. https://litemaas.apps.x
#   USER_JWT       LiteMaaS JWT of a regular user who logged in through OpenShift OAuth
#                  (browser devtools: localStorage.getItem('access_token'))
#   ADMIN_JWT      LiteMaaS JWT of an admin
#   MODEL_ID       LiteMaaS id of a synced MaaS model: "<namespace>/<maasmodelref>"
# Optional:
#   MAAS_NAMESPACE   default models-as-a-service
#   RESTRICT=1       mark the model restricted first so the approval step is exercised
#   USAGE_WAIT_S     how long to wait for usage to appear (default 900)
#   REVOKE_WAIT_S    how long to wait for the gateway to reject a revoked key (default 300)
#   INSECURE=1       pass -k to curl (self-signed routes)
# =============================================================================
set -euo pipefail

: "${LITEMAAS_URL:?set LITEMAAS_URL}"
: "${USER_JWT:?set USER_JWT}"
: "${ADMIN_JWT:?set ADMIN_JWT}"
: "${MODEL_ID:?set MODEL_ID (<namespace>/<maasmodelref>)}"
MAAS_NAMESPACE="${MAAS_NAMESPACE:-models-as-a-service}"
USAGE_WAIT_S="${USAGE_WAIT_S:-900}"
REVOKE_WAIT_S="${REVOKE_WAIT_S:-300}"
API="${LITEMAAS_URL%/}/api/v1"
CURL=(curl -sS)
[ "${INSECURE:-0}" = "1" ] && CURL+=(-k)
ENC_ID=$(jq -rn --arg v "$MODEL_ID" '$v|@uri')
TODAY=$(date -u +%F)
# Private temp files (the usage export contains every user's analytics)
RESP=$(mktemp); USAGE=$(mktemp)
trap 'rm -f "$RESP" "$USAGE"' EXIT

pass() { printf '\033[32mPASS\033[0m %s\n' "$*"; }
fail() { printf '\033[31mFAIL\033[0m %s\n' "$*"; exit 1; }
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
api() { # api <jwt> <method> <path> [json]
  local jwt=$1 method=$2 path=$3 body=${4:-}
  if [ -n "$body" ]; then
    "${CURL[@]}" -X "$method" -H "Authorization: Bearer $jwt" -H 'Content-Type: application/json' \
      -d "$body" "$API$path"
  else
    "${CURL[@]}" -X "$method" -H "Authorization: Bearer $jwt" "$API$path"
  fi
}

step "1. Config and health"
api "$USER_JWT" GET /config | jq -e '.maasEnabled == true' >/dev/null || fail "maasEnabled is not true"
pass "maasEnabled=true, gateway=$(api "$USER_JWT" GET /config | jq -r '.maasGatewayUrl // "-"')"
HEALTH=$(api "$USER_JWT" GET /health)
echo "$HEALTH" | jq '.maas'
echo "$HEALTH" | jq -e '.maas.mock == false' >/dev/null || fail "MaaS clients run in MOCK mode"
for c in maasApi kubernetes prometheus; do
  [ "$(echo "$HEALTH" | jq -r ".maas.$c")" = "healthy" ] || fail "health.maas.$c is not healthy"
done
pass "maas-api, Kubernetes and Prometheus healthy"

step "2. Model sync"
api "$ADMIN_JWT" POST /admin/models/maas/sync '{}' | jq '{totalRefs,newModels,updatedModels,errors}'
MODEL=$(api "$USER_JWT" GET "/models/$ENC_ID")
echo "$MODEL" | jq '{id,name,backendType,backendModelName,maasEndpoint,availability}'
[ "$(echo "$MODEL" | jq -r .backendType)" = "maas" ] || fail "$MODEL_ID is not a MaaS model"
SERVED=$(echo "$MODEL" | jq -r '.backendModelName // empty')
[ -n "$SERVED" ] || SERVED="${MODEL_ID#*/}"
MODEL_ENDPOINT=$(echo "$MODEL" | jq -r '.maasEndpoint // empty')
pass "model visible (served name: $SERVED)"

if [ "${RESTRICT:-0}" = "1" ]; then
  api "$ADMIN_JWT" PUT "/admin/models/$ENC_ID" '{"restrictedAccess":true}' | jq -c '{success,message}'
fi

step "3. Subscribe"
USERNAME=$(api "$USER_JWT" GET /auth/me | jq -r '.username')
SUB=$(api "$USER_JWT" POST /subscriptions "{\"modelId\":\"$MODEL_ID\"}")
SUB_ID=$(echo "$SUB" | jq -r '.id // empty')
if [ -z "$SUB_ID" ]; then # already subscribed: reuse the existing subscription
  SUB_ID=$(api "$USER_JWT" GET "/subscriptions?modelId=$ENC_ID" | jq -r '.data[0].id')
fi
STATUS=$(api "$USER_JWT" GET "/subscriptions/$SUB_ID" | jq -r .status)
pass "subscription $SUB_ID for $USERNAME is $STATUS"

step "4. Approve (restricted models)"
if [ "$STATUS" = "pending" ]; then
  api "$ADMIN_JWT" POST /admin/subscriptions/approve \
    "{\"subscriptionIds\":[\"$SUB_ID\"],\"reason\":\"maas acceptance\"}" | jq -c .
  STATUS=$(api "$USER_JWT" GET "/subscriptions/$SUB_ID" | jq -r .status)
fi
[ "$STATUS" = "active" ] || fail "subscription is $STATUS, expected active"
pass "subscription active"

step "5. MaaSAuthPolicy"
POLICY=$(oc -n "$MAAS_NAMESPACE" get maasauthpolicy -l app.kubernetes.io/managed-by=litemaas -o json |
  jq --arg u "$USERNAME" '.items[] | select(.spec.subjects.users | index($u))')
echo "$POLICY" | jq '{name: .metadata.name, modelRefs: .spec.modelRefs, status: .status}'
echo "$POLICY" | jq -e --arg n "${MODEL_ID#*/}" --arg ns "${MODEL_ID%%/*}" \
  '.spec.modelRefs | any(.name == $n and .namespace == $ns)' >/dev/null || fail "policy lacks $MODEL_ID"
pass "policy grants $MODEL_ID to $USERNAME"

step "6. Create MaaS API key"
KEY_JSON=$(api "$USER_JWT" POST /api-keys \
  "{\"name\":\"maas-acceptance-$(date +%s)\",\"modelIds\":[\"$MODEL_ID\"],\"backendType\":\"maas\",\"tpmLimit\":20000}")
echo "$KEY_JSON" | jq '{id,backendType,baseUrl,maasKeyId,keyPrefix,error}'
KEY_ID=$(echo "$KEY_JSON" | jq -r '.id // empty')
KEY=$(echo "$KEY_JSON" | jq -r '.key // empty')
[ -n "$KEY_ID" ] && [ -n "$KEY" ] || fail "key creation failed (MAAS_REAUTH_REQUIRED => log in again, see A1)"
BASE_URL=$(echo "$KEY_JSON" | jq -r '.baseUrl // empty')
pass "key $KEY_ID created (${KEY:0:10}...)"

step "7. MaaSSubscription"
oc -n "$MAAS_NAMESPACE" get maassubscription "litemaas-key-$KEY_ID" -o json |
  jq '{owner: .spec.owner, modelRefs: .spec.modelRefs, status: .status}' || fail "subscription missing"
pass "MaaSSubscription litemaas-key-$KEY_ID exists"

step "8. Inference through the MaaS gateway"
BASE="${MODEL_ENDPOINT:-$BASE_URL}"
BASE="${BASE%/}"; BASE="${BASE%/v1}"
[ -n "$BASE" ] || fail "no maasEndpoint on the model and no baseUrl on the key (set MAAS_GATEWAY_URL)"
URL="$BASE/v1/chat/completions"
BODY="{\"model\":\"$SERVED\",\"messages\":[{\"role\":\"user\",\"content\":\"Say hello in one word.\"}],\"max_tokens\":16}"
for i in $(seq 1 30); do # the controller / Authorino may need a few seconds after key creation
  CODE=$("${CURL[@]}" -o "$RESP" -w '%{http_code}' -X POST "$URL" \
    -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d "$BODY" || true)
  [ "$CODE" = "200" ] && break
  sleep 2
done
[ "$CODE" = "200" ] || { cat "$RESP"; fail "inference returned $CODE at $URL"; }
jq '{model, usage}' "$RESP"
pass "inference OK at $URL (first success after ~$((i * 2))s)"

step "9. View Key returns the same plaintext"
REVEALED=$(api "$USER_JWT" POST "/api-keys/$KEY_ID/reveal" '{}' | jq -r .key)
[ "$REVEALED" = "$KEY" ] || fail "reveal returned a different key"
pass "reveal OK"

step "10. Revoke the key"
REVOKED_AT=$(date +%s)
api "$USER_JWT" DELETE "/api-keys/$KEY_ID" | jq -c .
oc -n "$MAAS_NAMESPACE" get maassubscription "litemaas-key-$KEY_ID" >/dev/null 2>&1 &&
  fail "MaaSSubscription still present after revoke" || pass "MaaSSubscription deleted"
while :; do
  CODE=$("${CURL[@]}" -o /dev/null -w '%{http_code}' -X POST "$URL" \
    -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d "$BODY" || true)
  if [ "$CODE" = "401" ] || [ "$CODE" = "403" ]; then break; fi
  [ $(( $(date +%s) - REVOKED_AT )) -gt "$REVOKE_WAIT_S" ] && fail "revoked key still answers $CODE"
  sleep 5
done
pass "revoked key rejected with $CODE after $(( $(date +%s) - REVOKED_AT ))s (record this latency, A12)"
api "$ADMIN_JWT" GET "/admin/users/$(api "$USER_JWT" GET /auth/me | jq -r .id)/api-keys" |
  jq --arg id "$KEY_ID" '.data[]? | select(.id == $id) | {id,isActive,maasSyncState}'

step "11. Usage appears (Limitador -> Thanos -> LiteMaaS)"
START=$(date +%s)
while :; do
  TOKENS=$(api "$USER_JWT" GET /usage/budget | jq -r '.maasTokens // 0')
  if [ "${TOKENS%.*}" -gt 0 ] 2>/dev/null; then break; fi
  [ $(( $(date +%s) - START )) -gt "$USAGE_WAIT_S" ] && fail "no MaaS usage after ${USAGE_WAIT_S}s (A26/A27)"
  sleep 30
done
api "$USER_JWT" GET /usage/budget | jq '{currentSpend, maasSpend, maasTokens}'
pass "user budget reports $TOKENS MaaS tokens this month"
api "$ADMIN_JWT" POST /admin/usage/refresh-today '{}' >/dev/null || true
api "$ADMIN_JWT" POST /admin/usage/analytics "{\"startDate\":\"$TODAY\",\"endDate\":\"$TODAY\"}" >"$USAGE"
grep -q "${MODEL_ID#*/}" "$USAGE" && pass "admin analytics contain $MODEL_ID" ||
  echo "WARN: $MODEL_ID not found in /admin/usage/analytics output (A29)"

step "12. Reconciler converges"
api "$ADMIN_JWT" POST /admin/maas/reconcile '{}' | jq '.data'
api "$ADMIN_JWT" POST /admin/maas/reconcile '{}' |
  jq -e '.data.policiesApplied == 0 and .data.subscriptionsApplied == 0' >/dev/null &&
  pass "second reconcile pass applied nothing" || echo "WARN: reconcile keeps rewriting objects (A15)"

printf '\n\033[32mMaaS acceptance test completed\033[0m\n'
