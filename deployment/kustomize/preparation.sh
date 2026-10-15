#!/bin/bash
set -a  # automatically export all variables
source user-values.env
set +a

# Default LITELLM_MASTER_KEY to LITELLM_API_KEY if not set
if [ -z "${LITELLM_MASTER_KEY}" ]; then
    export LITELLM_MASTER_KEY="${LITELLM_API_KEY}"
fi

# Conditionally set NODE_TLS_ENV_BLOCK if NODE_TLS_REJECT_UNAUTHORIZED is "0"
if [ "${NODE_TLS_REJECT_UNAUTHORIZED}" = "0" ]; then
    export NODE_TLS_ENV_BLOCK="- name: NODE_TLS_REJECT_UNAUTHORIZED
              value: '0'"
else
    export NODE_TLS_ENV_BLOCK=""
fi

# Process all template files
for template in *.yaml.template; do
    envsubst < "$template" > "${template%.template}.local"
done

# Rename processed kustomize
mv kustomization.yaml.local kustomization.yaml

# MaaS component (components/maas): defaults for optional values, then render its templates
export MAAS_NAMESPACE="${MAAS_NAMESPACE:-models-as-a-service}"
export MAAS_API_URL="${MAAS_API_URL:-https://maas.${CLUSTER_DOMAIN_NAME}/maas-api}"
export MAAS_GATEWAY_URL="${MAAS_GATEWAY_URL:-https://maas.${CLUSTER_DOMAIN_NAME}}"
export MAAS_MODEL_NAMESPACES="${MAAS_MODEL_NAMESPACES:-}"
export MAAS_MIGRATION_GRACE_DAYS="${MAAS_MIGRATION_GRACE_DAYS:-14}"
export PROMETHEUS_URL="${PROMETHEUS_URL-https://thanos-querier.openshift-monitoring.svc.cluster.local:9091}"
export MAAS_CLUSTER_MONITORING_VIEW="${MAAS_CLUSTER_MONITORING_VIEW:-true}"
export OAUTH_SCOPES="${OAUTH_SCOPES:-}"
for template in components/maas/*.yaml.template components/maas-monitoring/*.yaml.template; do
    [ -e "$template" ] || continue
    envsubst < "$template" > "${template%.template}.local"
done

# Enable the MaaS component in the generated kustomization when requested
if [ "${MAAS_ENABLED}" = "true" ]; then
    printf '\n# RHOAI Models-as-a-Service backend\ncomponents:\n  - components/maas\n' >> kustomization.yaml
    # Optional cluster-monitoring-view binding (usage collection); opt out with MAAS_CLUSTER_MONITORING_VIEW=false
    if [ "${MAAS_CLUSTER_MONITORING_VIEW}" = "true" ] && [ -n "${PROMETHEUS_URL}" ]; then
        printf '  - components/maas-monitoring\n' >> kustomization.yaml
    fi
fi
