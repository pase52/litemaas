import { createHash } from 'node:crypto';
import type { K8sObject, K8sResourceRef } from '../k8s/k8s-client.js';

/** Resource types of the MaaS operator (maas.opendatahub.io/v1alpha1) */
export const MAAS_API_GROUP = 'maas.opendatahub.io';
export const MAAS_API_VERSION = 'v1alpha1';

export const MAAS_MODEL_REF: K8sResourceRef = {
  group: MAAS_API_GROUP,
  version: MAAS_API_VERSION,
  plural: 'maasmodelrefs',
};
export const MAAS_AUTH_POLICY: K8sResourceRef = {
  group: MAAS_API_GROUP,
  version: MAAS_API_VERSION,
  plural: 'maasauthpolicies',
};
export const MAAS_SUBSCRIPTION: K8sResourceRef = {
  group: MAAS_API_GROUP,
  version: MAAS_API_VERSION,
  plural: 'maassubscriptions',
};

/** Labels applied to every object LiteMaaS creates so the reconciler can find orphans */
export const LABEL_MANAGED_BY = 'app.kubernetes.io/managed-by';
export const LABEL_MANAGED_BY_VALUE = 'litemaas';
export const LABEL_USER_ID = 'litemaas.io/user-id';
export const LABEL_API_KEY_ID = 'litemaas.io/api-key-id';
export const MANAGED_SELECTOR = `${LABEL_MANAGED_BY}=${LABEL_MANAGED_BY_VALUE}`;

export const ANNOTATION_DISPLAY_NAME = 'openshift.io/display-name';
export const ANNOTATION_DESCRIPTION = 'openshift.io/description';

/** Token-rate-limit window used for TPM limits (1 minute) */
export const TPM_WINDOW = '1m';

const MAX_NAME_LENGTH = 253;
const HASH_LENGTH = 8;

function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, HASH_LENGTH);
}

/**
 * Convert an arbitrary string into a valid RFC 1123 subdomain name (lowercase alphanumerics,
 * '-' and '.', starting and ending alphanumeric, max 253 chars).
 *
 * A hash of the ORIGINAL input is appended whenever sanitising changed the value (or the
 * result was truncated) so that distinct inputs such as "John.Doe" and "john-doe" never
 * collapse onto the same Kubernetes name. Already-valid input is returned unchanged.
 */
export function sanitizeRfc1123Name(input: string, maxLength: number = MAX_NAME_LENGTH): string {
  const valid = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;
  if (input.length <= maxLength && valid.test(input)) return input;

  let base = input
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/[-.]*\.[-.]*/g, '.')
    .replace(/-{2,}/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[^a-z0-9]+$/, '');
  if (!base) base = 'x';

  const hash = shortHash(input);
  const room = maxLength - hash.length - 1;
  if (base.length > room) base = base.slice(0, room).replace(/[^a-z0-9]+$/, '') || 'x';
  return `${base}-${hash}`;
}

/** Label values: <=63 chars, alphanumeric start/end, [-_.a-zA-Z0-9] inside */
export function sanitizeLabelValue(input: string): string {
  const valid = /^([A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?)?$/;
  if (input.length <= 63 && valid.test(input)) return input;
  let base = input
    .replace(/[^-A-Za-z0-9_.]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/[^A-Za-z0-9]+$/, '');
  if (!base) base = 'x';
  const hash = shortHash(input);
  const room = 63 - hash.length - 1;
  if (base.length > room) base = base.slice(0, room).replace(/[^A-Za-z0-9]+$/, '') || 'x';
  return `${base}-${hash}`;
}

/** Name of the per-user MaaSAuthPolicy: litemaas-<user> */
export function authPolicyName(username: string): string {
  return sanitizeRfc1123Name(`litemaas-${username}`);
}

/** Name of the per-key MaaSSubscription: litemaas-key-<id> */
export function subscriptionName(apiKeyId: string): string {
  return sanitizeRfc1123Name(`litemaas-key-${apiKeyId}`);
}

export interface MaasModelRefTarget {
  /** MaaSModelRef name */
  name: string;
  /** Namespace of the MaaSModelRef */
  namespace: string;
}

export interface MaasModelLimit extends MaasModelRefTarget {
  /** Tokens per minute; omitted/null = no rate limit for this model */
  tpm?: number | null;
}

function managedLabels(extra: Record<string, string>): Record<string, string> {
  return { [LABEL_MANAGED_BY]: LABEL_MANAGED_BY_VALUE, ...extra };
}

function dedupe<T extends MaasModelRefTarget>(models: T[]): T[] {
  const seen = new Map<string, T>();
  for (const m of models) seen.set(`${m.namespace}/${m.name}`, m);
  return [...seen.values()].sort((a, b) =>
    `${a.namespace}/${a.name}`.localeCompare(`${b.namespace}/${b.name}`),
  );
}

export interface AuthPolicyInput {
  username: string;
  userId: string;
  namespace: string;
  /** Models the user is entitled to (active subscriptions) */
  models: MaasModelRefTarget[];
  /** Optional groups also granted access (usually empty) */
  groups?: string[];
}

/** MaaSAuthPolicy `litemaas-<user>`: grants one user access to a set of MaaSModelRefs */
export function buildAuthPolicy(input: AuthPolicyInput): K8sObject {
  return {
    apiVersion: `${MAAS_API_GROUP}/${MAAS_API_VERSION}`,
    kind: 'MaaSAuthPolicy',
    metadata: {
      name: authPolicyName(input.username),
      namespace: input.namespace,
      labels: managedLabels({ [LABEL_USER_ID]: sanitizeLabelValue(input.userId) }),
      annotations: { 'litemaas.io/username': input.username },
    },
    spec: {
      subjects: { users: [input.username], groups: input.groups ?? [] },
      modelRefs: dedupe(input.models).map((m) => ({ name: m.name, namespace: m.namespace })),
    },
  };
}

export interface SubscriptionInput {
  apiKeyId: string;
  userId: string;
  username: string;
  namespace: string;
  models: MaasModelLimit[];
  /** Applied to models that have no per-model tpm */
  globalTpm?: number | null;
  priority?: number;
}

/** MaaSSubscription `litemaas-key-<id>`: per-key owner, model list and TPM token rate limits */
export function buildSubscription(input: SubscriptionInput): K8sObject {
  return {
    apiVersion: `${MAAS_API_GROUP}/${MAAS_API_VERSION}`,
    kind: 'MaaSSubscription',
    metadata: {
      name: subscriptionName(input.apiKeyId),
      namespace: input.namespace,
      labels: managedLabels({
        [LABEL_USER_ID]: sanitizeLabelValue(input.userId),
        [LABEL_API_KEY_ID]: sanitizeLabelValue(input.apiKeyId),
      }),
      annotations: { 'litemaas.io/username': input.username },
    },
    spec: {
      owner: { users: [input.username], groups: [] },
      modelRefs: dedupe(input.models).map((m) => {
        const tpm = m.tpm ?? input.globalTpm;
        const ref: Record<string, unknown> = { name: m.name, namespace: m.namespace };
        if (tpm && tpm > 0) ref.tokenRateLimits = [{ limit: Math.floor(tpm), window: TPM_WINDOW }];
        return ref;
      }),
      priority: input.priority ?? 0,
    },
  };
}

/** Normalised view of a MaaSModelRef cluster object */
export interface ParsedModelRef {
  name: string;
  namespace: string;
  /** LiteMaaS model id: <namespace>/<name> */
  id: string;
  displayName?: string;
  description?: string;
  phase: 'Pending' | 'Ready' | 'Failed' | 'Unknown';
  endpoint?: string;
  targetKind?: string;
  targetName?: string;
}

export function maasModelId(namespace: string, name: string): string {
  return `${namespace}/${name}`;
}

export function parseModelRef(obj: K8sObject): ParsedModelRef {
  const ns = obj.metadata.namespace || '';
  const phaseRaw = obj.status?.phase;
  const phase =
    phaseRaw === 'Pending' || phaseRaw === 'Ready' || phaseRaw === 'Failed' ? phaseRaw : 'Unknown';
  return {
    name: obj.metadata.name,
    namespace: ns,
    id: maasModelId(ns, obj.metadata.name),
    displayName: obj.metadata.annotations?.[ANNOTATION_DISPLAY_NAME],
    description: obj.metadata.annotations?.[ANNOTATION_DESCRIPTION],
    phase,
    endpoint: obj.status?.endpoint,
    targetKind: obj.spec?.modelRef?.kind,
    targetName: obj.spec?.modelRef?.name,
  };
}
