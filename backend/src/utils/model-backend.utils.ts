/**
 * Backend-related fields exposed on model API responses (camelCase).
 * Rows from before the MaaS migration have no backend_type column value: default to litellm.
 */
export interface ModelBackendFields {
  backendType: 'litellm' | 'maas';
  maasEndpoint?: string;
  migrationState?: string;
  migrationGraceUntil?: string;
}

export function mapBackendFields(row: Record<string, unknown>): ModelBackendFields {
  const grace = row.migration_grace_until;
  let graceIso: string | undefined;
  if (grace) {
    const d = grace instanceof Date ? grace : new Date(String(grace));
    graceIso = Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  return {
    backendType: row.backend_type === 'maas' ? 'maas' : 'litellm',
    maasEndpoint: row.maas_endpoint ? String(row.maas_endpoint) : undefined,
    migrationState: row.migration_state ? String(row.migration_state) : undefined,
    migrationGraceUntil: graceIso,
  };
}
