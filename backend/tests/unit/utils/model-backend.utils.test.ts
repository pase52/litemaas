import { describe, it, expect } from 'vitest';
import { mapBackendFields } from '../../../src/utils/model-backend.utils';

describe('mapBackendFields', () => {
  it('defaults to litellm with no optional fields', () => {
    expect(mapBackendFields({})).toEqual({
      backendType: 'litellm',
      maasEndpoint: undefined,
      migrationState: undefined,
      migrationGraceUntil: undefined,
    });
  });

  it('maps MaaS rows to camelCase with ISO grace date', () => {
    const grace = new Date('2026-01-02T03:04:05.000Z');
    expect(
      mapBackendFields({
        backend_type: 'maas',
        maas_endpoint: 'https://gw/x',
        migration_state: 'migrating',
        migration_grace_until: grace,
      }),
    ).toEqual({
      backendType: 'maas',
      maasEndpoint: 'https://gw/x',
      migrationState: 'migrating',
      migrationGraceUntil: '2026-01-02T03:04:05.000Z',
    });
  });

  it('treats unknown backend types as litellm and ignores invalid dates', () => {
    const r = mapBackendFields({ backend_type: 'weird', migration_grace_until: 'not-a-date' });
    expect(r.backendType).toBe('litellm');
    expect(r.migrationGraceUntil).toBeUndefined();
  });
});
