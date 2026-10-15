import React from 'react';
import { Label } from '@patternfly/react-core';
import { useTranslation } from 'react-i18next';
import { formatDate } from '../../utils/formatters';
import { getMigrationGraceUntil } from '../../utils/modelBackend';

interface BackendBadgeProps {
  backendType?: 'litellm' | 'maas' | string;
  /** Show a LiteLLM badge too (default: only MaaS is flagged). */
  showLiteLLM?: boolean;
  isCompact?: boolean;
}

/**
 * Small flair showing which backend serves a model or key.
 * Nothing is rendered for LiteLLM unless showLiteLLM is set, so LiteLLM-only
 * deployments look exactly as before.
 */
export const BackendBadge: React.FC<BackendBadgeProps> = ({
  backendType,
  showLiteLLM = false,
  isCompact = false,
}) => {
  const { t } = useTranslation();
  if (backendType === 'maas') {
    // An aria-label is not allowed on the label's plain <span> (axe: aria-prohibited-attr), so the
    // short name stays visible and screen readers get the full description as hidden text instead.
    return (
      <Label
        color="purple"
        variant="outline"
        isCompact={isCompact}
        data-testid="backend-badge-maas"
      >
        <span aria-hidden="true">{t('maas.backend.maas', 'MaaS')}</span>
        <span className="pf-v6-screen-reader">
          {t('maas.backend.maasAria', 'Served through Red Hat OpenShift AI MaaS')}
        </span>
      </Label>
    );
  }
  if (showLiteLLM) {
    return (
      <Label
        color="grey"
        variant="outline"
        isCompact={isCompact}
        data-testid="backend-badge-litellm"
      >
        {t('maas.backend.litellm', 'LiteLLM')}
      </Label>
    );
  }
  return null;
};

interface MigrationLabelProps {
  migrationState?: string | null;
  migrationGraceUntil?: string | null;
  isCompact?: boolean;
}

/**
 * "Migrating to MaaS until <date>" label, shown while a grace period is running.
 */
export const MigrationLabel: React.FC<MigrationLabelProps> = ({
  migrationState,
  migrationGraceUntil,
  isCompact = false,
}) => {
  const { t } = useTranslation();
  const until = getMigrationGraceUntil({ migrationState, migrationGraceUntil });
  if (!until || until.getTime() < Date.now()) return null;
  return (
    <Label color="orange" isCompact={isCompact} data-testid="migration-label">
      {t('maas.migration.migratingUntil', {
        date: formatDate(until.toISOString()),
        defaultValue: 'Migrating to MaaS until {{date}}',
      })}
    </Label>
  );
};
