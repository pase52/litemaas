import { describe, it, expect } from 'vitest';
import {
  sanitizeRfc1123Name,
  sanitizeLabelValue,
  authPolicyName,
  subscriptionName,
  buildAuthPolicy,
  buildSubscription,
  parseModelRef,
  maasModelId,
  LABEL_MANAGED_BY,
  LABEL_USER_ID,
  LABEL_API_KEY_ID,
} from '../../../../src/services/maas/maas-resources';

const RFC1123 = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;

describe('sanitizeRfc1123Name', () => {
  it('returns already valid names unchanged', () => {
    expect(sanitizeRfc1123Name('litemaas-alice')).toBe('litemaas-alice');
    expect(sanitizeRfc1123Name('a.b-c.d')).toBe('a.b-c.d');
  });

  it('sanitises invalid characters and appends a hash of the original', () => {
    const out = sanitizeRfc1123Name('litemaas-Alice@Example.com');
    expect(out).toMatch(RFC1123);
    expect(out).toMatch(/^litemaas-alice-example\.com-[0-9a-f]{8}$/);
  });

  it('does not collapse distinct inputs onto the same name', () => {
    const a = sanitizeRfc1123Name('John.Doe');
    const b = sanitizeRfc1123Name('john.doe');
    const c = sanitizeRfc1123Name('John_Doe');
    const d = sanitizeRfc1123Name('John-Doe');
    expect(new Set([a, c, d]).size).toBe(3);
    expect(b).toBe('john.doe'); // valid as-is
    expect(a).not.toBe(b);
  });

  it('is deterministic', () => {
    expect(sanitizeRfc1123Name('Foo Bar')).toBe(sanitizeRfc1123Name('Foo Bar'));
  });

  it('handles leading/trailing/adjacent separators', () => {
    for (const input of ['--abc--', '.abc.', 'a..b', 'a-.-b', '___', '', 'ÄÖÜ', 'UPPER']) {
      expect(sanitizeRfc1123Name(input)).toMatch(RFC1123);
    }
  });

  it('truncates to the max length while keeping validity and the hash', () => {
    const long = 'x'.repeat(400);
    const out = sanitizeRfc1123Name(long);
    expect(out.length).toBeLessThanOrEqual(253);
    expect(out).toMatch(RFC1123);
    expect(out).not.toBe(sanitizeRfc1123Name('x'.repeat(401)));
  });

  it('honours a custom max length', () => {
    const out = sanitizeRfc1123Name('a'.repeat(100), 63);
    expect(out.length).toBeLessThanOrEqual(63);
    expect(out).toMatch(RFC1123);
  });
});

describe('sanitizeLabelValue', () => {
  it('keeps valid values and fixes invalid ones within 63 chars', () => {
    expect(sanitizeLabelValue('3f2a-uuid_1.0')).toBe('3f2a-uuid_1.0');
    const out = sanitizeLabelValue('user@example.com/' + 'y'.repeat(80));
    expect(out.length).toBeLessThanOrEqual(63);
    expect(out).toMatch(/^[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/);
  });
  it('allows the empty string', () => {
    expect(sanitizeLabelValue('')).toBe('');
  });
});

describe('names', () => {
  it('builds auth policy and subscription names', () => {
    expect(authPolicyName('alice')).toBe('litemaas-alice');
    expect(authPolicyName('alice@x.io')).toMatch(/^litemaas-alice-x\.io-[0-9a-f]{8}$/);
    expect(subscriptionName('1234-abcd')).toBe('litemaas-key-1234-abcd');
  });
});

describe('buildAuthPolicy', () => {
  it('produces a labeled MaaSAuthPolicy with sorted, de-duplicated modelRefs', () => {
    const obj = buildAuthPolicy({
      username: 'alice',
      userId: 'u-1',
      namespace: 'models-as-a-service',
      models: [
        { name: 'b', namespace: 'ns' },
        { name: 'a', namespace: 'ns' },
        { name: 'b', namespace: 'ns' },
      ],
    });
    expect(obj.kind).toBe('MaaSAuthPolicy');
    expect(obj.apiVersion).toBe('maas.opendatahub.io/v1alpha1');
    expect(obj.metadata.name).toBe('litemaas-alice');
    expect(obj.metadata.namespace).toBe('models-as-a-service');
    expect(obj.metadata.labels).toMatchObject({
      [LABEL_MANAGED_BY]: 'litemaas',
      [LABEL_USER_ID]: 'u-1',
    });
    expect(obj.spec).toEqual({
      subjects: { users: ['alice'], groups: [] },
      modelRefs: [
        { name: 'a', namespace: 'ns' },
        { name: 'b', namespace: 'ns' },
      ],
    });
  });

  it('allows an empty model list', () => {
    const obj = buildAuthPolicy({ username: 'a', userId: 'u', namespace: 'n', models: [] });
    expect(obj.spec!.modelRefs).toEqual([]);
  });
});

describe('buildSubscription', () => {
  it('applies per-model TPM over the global TPM and omits limits when unset', () => {
    const obj = buildSubscription({
      apiKeyId: 'key-1',
      userId: 'u-1',
      username: 'alice',
      namespace: 'models-as-a-service',
      globalTpm: 1000,
      models: [
        { name: 'a', namespace: 'ns', tpm: 500 },
        { name: 'b', namespace: 'ns' },
      ],
    });
    expect(obj.kind).toBe('MaaSSubscription');
    expect(obj.metadata.name).toBe('litemaas-key-key-1');
    expect(obj.metadata.labels).toMatchObject({
      [LABEL_API_KEY_ID]: 'key-1',
      [LABEL_USER_ID]: 'u-1',
    });
    expect(obj.spec!.owner).toEqual({ users: ['alice'], groups: [] });
    expect(obj.spec!.priority).toBe(0);
    expect(obj.spec!.modelRefs).toEqual([
      { name: 'a', namespace: 'ns', tokenRateLimits: [{ limit: 500, window: '1m' }] },
      { name: 'b', namespace: 'ns', tokenRateLimits: [{ limit: 1000, window: '1m' }] },
    ]);
  });

  it('omits tokenRateLimits entirely without any TPM', () => {
    const obj = buildSubscription({
      apiKeyId: 'k',
      userId: 'u',
      username: 'a',
      namespace: 'n',
      models: [{ name: 'a', namespace: 'ns', tpm: null }],
      priority: 5,
    });
    expect(obj.spec!.modelRefs).toEqual([{ name: 'a', namespace: 'ns' }]);
    expect(obj.spec!.priority).toBe(5);
  });
});

describe('parseModelRef', () => {
  it('parses status, annotations and target', () => {
    const ref = parseModelRef({
      metadata: {
        name: 'llama',
        namespace: 'models',
        annotations: { 'openshift.io/display-name': 'Llama', 'openshift.io/description': 'desc' },
      },
      spec: { modelRef: { kind: 'LLMInferenceService', name: 'llama-svc' } },
      status: { phase: 'Ready', endpoint: 'https://x/llama' },
    });
    expect(ref).toMatchObject({
      id: 'models/llama',
      displayName: 'Llama',
      description: 'desc',
      phase: 'Ready',
      endpoint: 'https://x/llama',
      targetKind: 'LLMInferenceService',
      targetName: 'llama-svc',
    });
    expect(maasModelId('a', 'b')).toBe('a/b');
  });

  it('maps unknown/missing phases to Unknown', () => {
    expect(parseModelRef({ metadata: { name: 'x', namespace: 'n' } }).phase).toBe('Unknown');
    expect(parseModelRef({ metadata: { name: 'x' }, status: { phase: 'Weird' } }).phase).toBe(
      'Unknown',
    );
  });
});
