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
import { Group, CreateGroupRequest, UpdateGroupRequest } from '../types/groups';
import { groupsService } from '../services/groups.service';
import { useNotifications } from '../contexts/NotificationContext';
import GroupDetailsTab from './admin/GroupDetailsTab';
import GroupModelsTab from './admin/GroupModelsTab';
import GroupMembersTab from './admin/GroupMembersTab';
import GroupBudgetTab from './admin/GroupBudgetTab';

interface GroupEditModalProps {
  group: Group | null;
  isOpen: boolean;
  canEdit: boolean;
  onClose: () => void;
  onSave: () => void;
}

const GroupEditModal: React.FC<GroupEditModalProps> = ({
  group,
  isOpen,
  canEdit,
  onClose,
  onSave,
}) => {
  const { t } = useTranslation();
  const { addNotification } = useNotifications();

  const isCreateMode = group === null;

  // Tab state
  const [activeTabKey, setActiveTabKey] = useState<string | number>('details');

  // Form state for Details tab
  const [detailsFormData, setDetailsFormData] = useState<CreateGroupRequest>({
    name: '',
    alias: '',
    description: '',
  });

  // Form state for Models tab
  const [selectedModels, setSelectedModels] = useState<string[]>([]);

  // Form state for Budget tab
  const [budgetFormData, setBudgetFormData] = useState<{
    maxBudget?: number;
    budgetDuration?: string;
    tpmLimit?: number;
    rpmLimit?: number;
  }>({});

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
      setSelectedModels(group.allowedModels || []);
      setBudgetFormData({
        maxBudget: group.maxBudget,
        budgetDuration: group.budgetDuration,
        tpmLimit: group.tpmLimit,
        rpmLimit: group.rpmLimit,
      });
    } else {
      // Create mode - reset all form data
      setDetailsFormData({
        name: '',
        alias: '',
        description: '',
      });
      setSelectedModels([]);
      setBudgetFormData({});
    }
    setError(null);
    setHasChanges(false);
    setActiveTabKey('details');
  }, [group, isOpen]);

  // Track changes
  useEffect(() => {
    if (isCreateMode) {
      // For create mode, always allow save if name is provided
      setHasChanges(!!detailsFormData.name?.trim());
      return;
    }

    if (!group) return;

    const detailsChanged =
      detailsFormData.name !== group.name ||
      (detailsFormData.alias || '') !== (group.alias || '') ||
      (detailsFormData.description || '') !== (group.description || '');

    const modelsChanged =
      JSON.stringify([...selectedModels].sort()) !==
      JSON.stringify([...(group.allowedModels || [])].sort());

    const budgetChanged =
      budgetFormData.maxBudget !== group.maxBudget ||
      budgetFormData.budgetDuration !== group.budgetDuration ||
      budgetFormData.tpmLimit !== group.tpmLimit ||
      budgetFormData.rpmLimit !== group.rpmLimit;

    setHasChanges(detailsChanged || modelsChanged || budgetChanged);
  }, [detailsFormData, selectedModels, budgetFormData, group, isCreateMode]);

  const handleDetailsChange = (data: Partial<CreateGroupRequest>) => {
    setDetailsFormData((prev) => ({ ...prev, ...data }));
  };

  const handleBudgetChange = (data: Partial<typeof budgetFormData>) => {
    setBudgetFormData((prev) => ({ ...prev, ...data }));
  };

  const handleSave = async () => {
    if (!canEdit || !hasChanges) return;

    setIsUpdating(true);
    setError(null);

    try {
      if (isCreateMode) {
        // Create new group
        const createData: CreateGroupRequest = {
          ...detailsFormData,
          allowedModels: selectedModels.length > 0 ? selectedModels : undefined,
          maxBudget: budgetFormData.maxBudget,
          budgetDuration: budgetFormData.budgetDuration as CreateGroupRequest['budgetDuration'],
          tpmLimit: budgetFormData.tpmLimit,
          rpmLimit: budgetFormData.rpmLimit,
        };

        await groupsService.createGroup(createData);

        addNotification({
          title: t('groups.notifications.createSuccess', 'Group Created'),
          description: t(
            'groups.notifications.createSuccessDesc',
            'The group has been created successfully.',
          ),
          variant: 'success',
        });
      } else {
        // Update existing group
        const updateData: UpdateGroupRequest = {
          name: detailsFormData.name,
          alias: detailsFormData.alias,
          description: detailsFormData.description,
          allowedModels: selectedModels.length > 0 ? selectedModels : [],
          maxBudget: budgetFormData.maxBudget,
          budgetDuration: budgetFormData.budgetDuration as UpdateGroupRequest['budgetDuration'],
          tpmLimit: budgetFormData.tpmLimit,
          rpmLimit: budgetFormData.rpmLimit,
        };

        await groupsService.updateGroup(group!.id, updateData);

        addNotification({
          title: t('groups.notifications.updateSuccess', 'Group Updated'),
          description: t(
            'groups.notifications.updateSuccessDesc',
            'The group has been updated successfully.',
          ),
          variant: 'success',
        });
      }

      onSave();
    } catch (err: unknown) {
      console.error('Failed to save group:', err);

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

  // Determine if save button should show for current tab
  const showSaveButton =
    canEdit &&
    (activeTabKey === 'details' || activeTabKey === 'models' || activeTabKey === 'budget');

  const modalTitle = isCreateMode
    ? t('groups.modal.createTitle', 'Create Group')
    : canEdit
      ? t('groups.modal.editTitle', 'Edit Group')
      : t('groups.modal.viewTitle', 'Group Details');

  if (!isOpen) return null;

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
              isCreateMode={isCreateMode}
              formData={detailsFormData}
              onChange={handleDetailsChange}
            />
          </Tab>

          <Tab
            eventKey="models"
            title={<TabTitleText>{t('groups.tabs.models', 'Models')}</TabTitleText>}
          >
            <GroupModelsTab
              group={group}
              canEdit={canEdit}
              selectedModels={selectedModels}
              onModelsChange={setSelectedModels}
            />
          </Tab>

          {/* Members tab - only for existing groups (not create mode) */}
          {!isCreateMode && group && (
            <Tab
              eventKey="members"
              title={<TabTitleText>{t('groups.tabs.members', 'Members')}</TabTitleText>}
            >
              <GroupMembersTab groupId={group.id} canEdit={canEdit} />
            </Tab>
          )}

          <Tab
            eventKey="budget"
            title={
              <TabTitleText>{t('groups.tabs.budget', 'Budget & Limits')}</TabTitleText>
            }
          >
            <GroupBudgetTab
              group={group}
              canEdit={canEdit}
              formData={budgetFormData}
              onChange={handleBudgetChange}
            />
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
                  ) : isCreateMode ? (
                    t('groups.actions.create', 'Create Group')
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

export default GroupEditModal;
