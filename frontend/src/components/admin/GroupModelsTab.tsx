import React, { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from 'react-query';
import {
  Alert,
  Badge,
  Bullseye,
  Checkbox,
  Content,
  ContentVariants,
  Flex,
  FlexItem,
  SearchInput,
  Skeleton,
} from '@patternfly/react-core';
import { Group } from '../../types/groups';
import { modelsService } from '../../services/models.service';

interface GroupModelsTabProps {
  group: Group | null;
  canEdit: boolean;
  selectedModels: string[];
  onModelsChange: (models: string[]) => void;
}

const GroupModelsTab: React.FC<GroupModelsTabProps> = ({
  group: _group,
  canEdit,
  selectedModels,
  onModelsChange,
}) => {
  const { t } = useTranslation();
  const [searchValue, setSearchValue] = useState('');

  // Fetch available models
  const {
    data: modelsResponse,
    isLoading,
    error,
  } = useQuery(
    ['models-for-group-selection'],
    () => modelsService.getModels(1, 500),
    {
      staleTime: 5 * 60 * 1000,
    },
  );

  const availableModels = modelsResponse?.models || [];

  // Filter models based on search
  const filteredModels = useMemo(() => {
    if (!searchValue.trim()) return availableModels;
    const lowerSearch = searchValue.toLowerCase();
    return availableModels.filter(
      (model) =>
        model.name.toLowerCase().includes(lowerSearch) ||
        model.provider.toLowerCase().includes(lowerSearch),
    );
  }, [availableModels, searchValue]);

  const handleModelToggle = (modelName: string, checked: boolean) => {
    if (!canEdit) return;
    if (checked) {
      onModelsChange([...selectedModels, modelName]);
    } else {
      onModelsChange(selectedModels.filter((m) => m !== modelName));
    }
  };

  const handleSelectAll = () => {
    if (!canEdit) return;
    // Selecting all means clearing the list (empty = all models accessible)
    onModelsChange([]);
  };

  if (isLoading) {
    return (
      <div style={{ padding: '1rem' }}>
        <Skeleton height="200px" />
      </div>
    );
  }

  if (error) {
    return (
      <Alert
        variant="danger"
        title={t('common.error', 'Error')}
        isInline
        style={{ margin: '1rem 0' }}
      >
        {t('groups.models.loadError', 'Failed to load available models')}
      </Alert>
    );
  }

  return (
    <div style={{ paddingTop: '1rem' }}>
      {/* Info alert about empty selection */}
      <Alert
        variant="info"
        title={t('groups.models.infoTitle', 'Model Access')}
        isInline
        style={{ marginBottom: '1rem' }}
      >
        {t(
          'groups.models.infoDescription',
          'An empty selection means all models are accessible to this group.',
        )}
      </Alert>

      {/* Selected count badge */}
      <Flex
        justifyContent={{ default: 'justifyContentSpaceBetween' }}
        alignItems={{ default: 'alignItemsCenter' }}
        style={{ marginBottom: '1rem' }}
      >
        <FlexItem>
          <Badge isRead>
            {selectedModels.length === 0
              ? t('groups.models.allModels', 'All Models')
              : t('groups.models.selectedCount', '{{count}} selected', {
                  count: selectedModels.length,
                })}
          </Badge>
        </FlexItem>
        {canEdit && selectedModels.length > 0 && (
          <FlexItem>
            <Content
              component={ContentVariants.small}
              style={{
                cursor: 'pointer',
                color: 'var(--pf-t--global--color--brand--default)',
              }}
              onClick={handleSelectAll}
            >
              {t('groups.models.clearSelection', 'Clear selection (allow all)')}
            </Content>
          </FlexItem>
        )}
      </Flex>

      {/* Search input */}
      <SearchInput
        placeholder={t('groups.models.searchPlaceholder', 'Search models...')}
        value={searchValue}
        onChange={(_event, value) => setSearchValue(value)}
        onClear={() => setSearchValue('')}
        aria-label={t('groups.models.searchAriaLabel', 'Search available models')}
        style={{ marginBottom: '1rem' }}
      />

      {/* Model checkbox list */}
      {filteredModels.length === 0 ? (
        <Bullseye style={{ padding: '2rem' }}>
          <Content component={ContentVariants.p}>
            {t('groups.models.noModelsFound', 'No models found matching your search.')}
          </Content>
        </Bullseye>
      ) : (
        <div
          style={{
            maxHeight: '300px',
            overflowY: 'auto',
            border: '1px solid var(--pf-t--global--border--color--default)',
            borderRadius: 'var(--pf-t--global--border--radius--small)',
            padding: '0.5rem',
          }}
          role="group"
          aria-label={t('groups.models.listAriaLabel', 'Available models')}
        >
          {filteredModels.map((model) => (
            <div
              key={model.id}
              style={{
                padding: '0.5rem',
                borderBottom: '1px solid var(--pf-t--global--border--color--default)',
              }}
            >
              <Checkbox
                id={`model-${model.id}`}
                label={
                  <Flex
                    spaceItems={{ default: 'spaceItemsSm' }}
                    alignItems={{ default: 'alignItemsCenter' }}
                  >
                    <FlexItem>
                      <strong>{model.name}</strong>
                    </FlexItem>
                    <FlexItem>
                      <Badge isRead>{model.provider}</Badge>
                    </FlexItem>
                  </Flex>
                }
                isChecked={selectedModels.includes(model.name)}
                onChange={(_event, checked) => handleModelToggle(model.name, checked)}
                isDisabled={!canEdit}
                aria-label={t('groups.models.toggleModel', 'Toggle {{model}}', {
                  model: model.name,
                })}
              />
            </div>
          ))}
        </div>
      )}

      {!canEdit && (
        <Content
          component={ContentVariants.small}
          style={{ marginTop: '1rem', fontStyle: 'italic' }}
        >
          {t('groups.readOnlyNote', 'You have read-only access to these settings.')}
        </Content>
      )}
    </div>
  );
};

export default GroupModelsTab;
