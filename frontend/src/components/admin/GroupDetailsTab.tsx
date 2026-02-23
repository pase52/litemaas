import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  Form,
  FormGroup,
  TextInput,
  TextArea,
  Switch,
  Content,
  ContentVariants,
} from '@patternfly/react-core';
import { Group, CreateGroupRequest } from '../../types/groups';

interface GroupDetailsTabProps {
  group: Group | null;
  canEdit: boolean;
  isCreateMode: boolean;
  formData: CreateGroupRequest;
  onChange: (data: Partial<CreateGroupRequest>) => void;
}

const GroupDetailsTab: React.FC<GroupDetailsTabProps> = ({
  group,
  canEdit,
  isCreateMode,
  formData,
  onChange,
}) => {
  const { t } = useTranslation();

  return (
    <Form style={{ paddingTop: '1rem' }}>
      {/* Group Name */}
      <FormGroup
        label={t('groups.form.name', 'Name')}
        isRequired
        fieldId="group-name"
      >
        <TextInput
          id="group-name"
          value={formData.name || ''}
          onChange={(_event, value) => onChange({ name: value })}
          isDisabled={!canEdit}
          isRequired
          aria-label={t('groups.form.name', 'Name')}
          placeholder={t('groups.form.namePlaceholder', 'Enter group name')}
        />
      </FormGroup>

      {/* Group Alias */}
      <FormGroup
        label={t('groups.form.alias', 'Alias')}
        fieldId="group-alias"
      >
        <TextInput
          id="group-alias"
          value={formData.alias || ''}
          onChange={(_event, value) => onChange({ alias: value })}
          isDisabled={!canEdit}
          aria-label={t('groups.form.alias', 'Alias')}
          placeholder={t('groups.form.aliasPlaceholder', 'Enter group alias')}
        />
      </FormGroup>

      {/* Group Description */}
      <FormGroup
        label={t('groups.form.description', 'Description')}
        fieldId="group-description"
      >
        <TextArea
          id="group-description"
          value={formData.description || ''}
          onChange={(_event, value) => onChange({ description: value })}
          isDisabled={!canEdit}
          aria-label={t('groups.form.description', 'Description')}
          placeholder={t('groups.form.descriptionPlaceholder', 'Enter group description')}
          rows={3}
        />
      </FormGroup>

      {/* Active/Inactive toggle - edit mode only, not create */}
      {!isCreateMode && group && (
        <FormGroup
          label={t('groups.form.status', 'Status')}
          fieldId="group-status"
        >
          <Switch
            id="group-status"
            label={group.isActive ? t('status.active', 'Active') : t('status.inactive', 'Inactive')}
            isChecked={group.isActive}
            isDisabled={!canEdit}
            aria-label={t('groups.form.toggleStatus', 'Toggle group active status')}
            onChange={() => {
              // Status changes are handled via the update API; this is informational
              // Parent should handle this through a separate update call if needed
            }}
          />
        </FormGroup>
      )}

      {!canEdit && (
        <Content
          component={ContentVariants.small}
          style={{ marginTop: '1rem', fontStyle: 'italic' }}
        >
          {t('groups.readOnlyNote', 'You have read-only access to these settings.')}
        </Content>
      )}
    </Form>
  );
};

export default GroupDetailsTab;
