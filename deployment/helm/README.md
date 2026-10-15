# LiteMaaS Helm Chart

Helm chart for deploying LiteMaaS on OpenShift or Kubernetes.

## Quick Start

```bash
# Create a values file from the defaults
cp deployment/helm/litemaas/values.yaml my-values.yaml
# Edit my-values.yaml — at minimum, change all `changeme` secrets

# OpenShift
oc new-project litemaas
helm install litemaas deployment/helm/litemaas/ \
  -n litemaas \
  -f my-values.yaml \
  --set global.platform=openshift \
  --set route.enabled=true

# Kubernetes
helm install litemaas deployment/helm/litemaas/ \
  -n litemaas --create-namespace \
  -f my-values.yaml
```

## What Gets Deployed

| Component  | Default Image |
|------------|---------------|
| PostgreSQL | `postgres:16-alpine` |
| LiteLLM    | `quay.io/rh-aiservices-bu/litellm-non-root:main-v1.81.0-stable-custom` |
| Backend    | `quay.io/rh-aiservices-bu/litemaas-backend:<appVersion>` |
| Frontend   | `quay.io/rh-aiservices-bu/litemaas-frontend:<appVersion>` |

Backend and frontend image tags default to the chart's `appVersion` (currently `0.4.0`). Override with `backend.image.tag` / `frontend.image.tag`.

## Optional: RHOAI Models-as-a-Service backend

Set `maas.enabled=true` (see `values.maas.example.yaml`) to serve models through the RHOAI MaaS stack
next to LiteLLM. The chart then adds the backend ServiceAccount RBAC (`templates/maas-rbac.yaml`,
requires cluster-admin), the MaaS environment variables and, on OpenShift, the trusted CA bundle.
Disabled by default; the rendered manifests are unchanged when off. See
[MaaS backend](../../docs/features/maas-backend.md).

## Documentation

For the full configuration reference, common scenarios (external database, external OAuth, Ingress/Route setup), and upgrade instructions, see:

**[Helm Deployment Guide](../../docs/deployment/helm-deployment.md)**
