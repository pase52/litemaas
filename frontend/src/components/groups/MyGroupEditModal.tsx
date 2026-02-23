import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Modal,
  ModalVariant,
  ModalBody,
  Button,
  Alert,
  Spinner,
  Tabs,
  Tab,
  TabTitleText,
  Flex,
  FlexItem,
} from '@patternfly/react-core';
import { Group, UpdateGroupDetailsRequest } from '../../types/groups';
import { groupsService } from '../../services/groups.service';
import { useNotifications } from '../../contexts/NotificationContext';
import GroupDetailsTab from '../admin/GroupDetailsTab';
import MyGroupMembersTab from './MyGroupMembersTab';

interface MyGroupEditModalProps {
  group: Group | null;
  isOpen: boolean;
  canEdit: boolean;
  onClose: () => void;
  onSave: () => void;
}

const MyGroupEditModal: React.FC<MyGroupEditModalProps> = ({
  group,
  isOpen,
  canEdit,
  onClose,
  onSave,
}) => {
  const { t } = useTranslation();
  const { addNotification } = useNotifications();

  // Tab state
  const [activeTabKey, setActiveTabKey] = useState<string | number>('details');

  // Form state for Details tab
  const [detailsFormData, setDetailsFormData] = useState<UpdateGroupDetailsRequest>({
    name: '',
    alias: '',
    description: '',
  });

  // UI state
  const [isUpdating, setIsUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasChanges, setHasChanges] = useState(false);

  // Focus management
  const saveButtonRef = useRef<HTMLButtonElement>(null);

  // Initialize form when group changes or modal opens
  useEffect(() => {
    if (group) {
      setDetailsFormData({
        name: group.name,
        alias: group.alias || '',
        description: group.description || '',
      });
    } else {
      setDetailsFormData({
        name: '',
        alias: '',
        description: '',
      });
    }
    setError(null);
    setHasChanges(false);
    setActiveTabKey('details');
  }, [group, isOpen]);

  // Track changes
  useEffect(() => {
    if (!group) return;

    const detailsChanged =
      detailsFormData.name !== group.name ||
      (detailsFormData.alias || '') !== (group.alias || '') ||
      (detailsFormData.description || '') !== (group.description || '');

    setHasChanges(detailsChanged);
  }, [detailsFormData, group]);

  const handleDetailsChange = (data: Partial<UpdateGroupDetailsRequest>) => {
    setDetailsFormData((prev) => ({ ...prev, ...data }));
  };

  const handleSave = async () => {
    if (!canEdit || !hasChanges || !group) return;

    setIsUpdating(true);
    setError(null);

    try {
      const updateData: UpdateGroupDetailsRequest = {
        name: detailsFormData.name,
        alias: detailsFormData.alias,
        description: detailsFormData.description,
      };

      await groupsService.updateMyGroupDetails(group.id, updateData);

      addNotification({
        title: t('groups.notifications.updateSuccess', 'Group Updated'),
        description: t(
          'groups.notifications.updateSuccessDesc',
          'The group has been updated successfully.',
        ),
        variant: 'success',
      });

      onSave();
    } catch (err: unknown) {
      console.error('Failed to update group:', err);

      let errorMessage = t('groups.error.save', 'Failed to save group');
      const error = err as {
        response?: { data?: { message?: string; error?: string | { message?: string } } };
        message?: string;
      };
      if (error.response?.data?.message) {
        errorMessage = error.response.data.message;
      } else if (error.response?.data?.error) {
        errorMessage =
          typeof error.response.data.error === 'string'
            ? error.response.data.error
            : error.response.data.error.message || errorMessage;
      } else if (error.message) {
        errorMessage = error.message;
      }

      setError(errorMessage);
      addNotification({
        title: t('groups.notifications.saveError', 'Save Failed'),
        description: errorMessage,
        variant: 'danger',
      });
    } finally {
      setIsUpdating(false);
    }
  };

  const handleClose = () => {
    onClose();
  };

  // Show save button only on details tab
  const showSaveButton = canEdit && activeTabKey === 'details';

  const modalTitle = canEdit
    ? t('groups.modal.manageTitle', 'Manage Group')
    : t('groups.modal.viewTitle', 'Group Details');

  if (!isOpen || !group) return null;

  return (
    <Modal
      variant={ModalVariant.large}
      title={modalTitle}
      isOpen={isOpen}
      onClose={handleClose}
      onEscapePress={handleClose}
    >
      <ModalBody>
        {error && (
          <Alert
            variant="danger"
            title={t('common.error', 'Error')}
            isInline
            style={{ marginBottom: '1rem' }}
          >
            {error}
          </Alert>
        )}

        <Tabs
          activeKey={activeTabKey}
          onSelect={(_event, tabIndex) => setActiveTabKey(tabIndex)}
          aria-label={t('groups.tabs.ariaLabel', 'Group details tabs')}
        >
          <Tab
            eventKey="details"
            title={<TabTitleText>{t('groups.tabs.details', 'Details')}</TabTitleText>}
          >
            <GroupDetailsTab
              group={group}
              canEdit={canEdit}
              isCreateMode={false}
              formData={{
                name: detailsFormData.name || '',
                alias: detailsFormData.alias || '',
                description: detailsFormData.description || '',
              }}
              onChange={handleDetailsChange}
            />
          </Tab>

          <Tab
            eventKey="members"
            title={<TabTitleText>{t('groups.tabs.members', 'Members')}</TabTitleText>}
          >
            <MyGroupMembersTab groupId={group.id} canEdit={canEdit} />
          </Tab>
        </Tabs>

        {/* Action Buttons */}
        <div
          style={{
            marginTop: '1.5rem',
            display: 'flex',
            justifyContent: 'flex-end',
            alignItems: 'center',
          }}
        >
          <Flex spaceItems={{ default: 'spaceItemsSm' }}>
            {showSaveButton && (
              <FlexItem>
                <Button
                  variant="primary"
                  onClick={handleSave}
                  isDisabled={!hasChanges || isUpdating}
                  isLoading={isUpdating}
                  spinnerAriaValueText={t('ui.actions.saving', 'Saving...')}
                  ref={saveButtonRef}
                >
                  {isUpdating ? (
                    <>
                      <Spinner size="sm" aria-hidden="true" />
                      {t('ui.actions.saving', 'Saving...')}
                    </>
                  ) : (
                    t('ui.actions.save', 'Save')
                  )}
                </Button>
              </FlexItem>
            )}
            <FlexItem>
              <Button variant="link" onClick={handleClose} isDisabled={isUpdating}>
                {showSaveButton
                  ? t('ui.actions.cancel', 'Cancel')
                  : t('ui.actions.close', 'Close')}
              </Button>
            </FlexItem>
          </Flex>
        </div>
      </ModalBody>
    </Modal>
  );
};

export default MyGroupEditModal;
