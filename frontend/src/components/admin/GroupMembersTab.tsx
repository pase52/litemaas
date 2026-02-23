import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from 'react-query';
import {
  Alert,
  Badge,
  Button,
  Content,
  ContentVariants,
  Flex,
  FlexItem,
  Select,
  SelectList,
  SelectOption,
  MenuToggle,
  MenuToggleElement,
  SearchInput,
  Skeleton,
  EmptyState,
  EmptyStateVariant,
  EmptyStateBody,
  Title,
} from '@patternfly/react-core';
import {
  PlusCircleIcon,
  UsersIcon,
  ExclamationTriangleIcon,
} from '@patternfly/react-icons';
import { Table, Thead, Tbody, Tr, Th, Td, ActionsColumn } from '@patternfly/react-table';
import { groupsService } from '../../services/groups.service';
import { apiClient } from '../../services/api';
import { useNotifications } from '../../contexts/NotificationContext';
import { GroupWithMembers } from '../../types/groups';

interface GroupMembersTabProps {
  groupId: string;
  canEdit: boolean;
}

interface UserSearchUser {
  userId: string;
  username: string;
  email: string;
}

interface UserSearchResult {
  users: UserSearchUser[];
  total: number;
}

const GROUP_ROLES: Array<{ value: 'admin' | 'member' | 'viewer'; labelKey: string; color: string }> = [
  { value: 'admin', labelKey: 'groups.members.roleAdmin', color: 'blue' },
  { value: 'member', labelKey: 'groups.members.roleMember', color: 'green' },
  { value: 'viewer', labelKey: 'groups.members.roleViewer', color: 'grey' },
];

const GroupMembersTab: React.FC<GroupMembersTabProps> = ({ groupId, canEdit }) => {
  const { t } = useTranslation();
  const { addNotification } = useNotifications();
  const queryClient = useQueryClient();

  // Add member state
  const [userSearchValue, setUserSearchValue] = useState('');
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [selectedUserLabel, setSelectedUserLabel] = useState<string>('');
  const [newMemberRole, setNewMemberRole] = useState<'admin' | 'member' | 'viewer'>('member');
  const [isRoleSelectOpen, setIsRoleSelectOpen] = useState(false);
  const [isUserSelectOpen, setIsUserSelectOpen] = useState(false);
  const [confirmRemoveUserId, setConfirmRemoveUserId] = useState<string | null>(null);

  // Fetch group details with members
  const {
    data: groupDetails,
    isLoading,
    error,
  } = useQuery<GroupWithMembers>(
    ['admin-group-details', groupId],
    () => groupsService.getAdminGroupDetails(groupId),
    {
      enabled: !!groupId,
    },
  );

  // Search users for adding
  const { data: userSearchResults } = useQuery<UserSearchResult>(
    ['user-search', userSearchValue],
    () => apiClient.get<UserSearchResult>(`/admin/users?search=${encodeURIComponent(userSearchValue)}&limit=10`),
    {
      enabled: userSearchValue.length >= 2,
      keepPreviousData: true,
    },
  );

  // Add member mutation
  const addMemberMutation = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: 'admin' | 'member' | 'viewer' }) =>
      groupsService.addMember(groupId, { userId, role }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-group-details', groupId] });
      queryClient.invalidateQueries({ queryKey: ['admin-groups'] });
      setSelectedUserId(null);
      setSelectedUserLabel('');
      setUserSearchValue('');
      addNotification({
        title: t('groups.members.addSuccess', 'Member Added'),
        description: t('groups.members.addSuccessDesc', 'Member has been added to the group.'),
        variant: 'success',
      });
    },
    onError: (err: Error) => {
      addNotification({
        title: t('groups.members.addError', 'Add Failed'),
        description: err.message,
        variant: 'danger',
      });
    },
  });

  // Update role mutation
  const updateRoleMutation = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: 'admin' | 'member' | 'viewer' }) =>
      groupsService.updateMemberRole(groupId, userId, { role }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-group-details', groupId] });
      addNotification({
        title: t('groups.members.roleUpdateSuccess', 'Role Updated'),
        description: t('groups.members.roleUpdateSuccessDesc', 'Member role has been updated.'),
        variant: 'success',
      });
    },
    onError: (err: Error) => {
      addNotification({
        title: t('groups.members.roleUpdateError', 'Role Update Failed'),
        description: err.message,
        variant: 'danger',
      });
    },
  });

  // Remove member mutation
  const removeMemberMutation = useMutation({
    mutationFn: (userId: string) => groupsService.removeMember(groupId, userId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-group-details', groupId] });
      queryClient.invalidateQueries({ queryKey: ['admin-groups'] });
      setConfirmRemoveUserId(null);
      addNotification({
        title: t('groups.members.removeSuccess', 'Member Removed'),
        description: t('groups.members.removeSuccessDesc', 'Member has been removed from the group.'),
        variant: 'success',
      });
    },
    onError: (err: Error) => {
      addNotification({
        title: t('groups.members.removeError', 'Remove Failed'),
        description: err.message,
        variant: 'danger',
      });
    },
  });

  const handleAddMember = () => {
    if (!selectedUserId) return;
    addMemberMutation.mutate({ userId: selectedUserId, role: newMemberRole });
  };

  const handleRoleChange = (userId: string, role: 'admin' | 'member' | 'viewer') => {
    updateRoleMutation.mutate({ userId, role });
  };

  const handleRemoveMember = (userId: string) => {
    // Check if this is the last admin
    const adminCount = members.filter((m) => m.role === 'admin').length;
    const memberToRemove = members.find((m) => m.userId === userId);

    if (memberToRemove?.role === 'admin' && adminCount <= 1) {
      addNotification({
        title: t('groups.members.lastAdminWarning', 'Cannot Remove Last Admin'),
        description: t(
          'groups.members.lastAdminWarningDesc',
          'This is the last admin of the group. Assign another admin before removing this one.',
        ),
        variant: 'warning',
      });
      return;
    }

    removeMemberMutation.mutate(userId);
  };

  const getRoleLabel = (role: string): string => {
    switch (role) {
      case 'admin':
        return t('groups.members.roleAdmin', 'Admin');
      case 'member':
        return t('groups.members.roleMember', 'Member');
      case 'viewer':
        return t('groups.members.roleViewer', 'Viewer');
      default:
        return role;
    }
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
        {t('groups.members.loadError', 'Failed to load group members')}
      </Alert>
    );
  }

  const members = groupDetails?.members || [];
  const existingUserIds = members.map((m) => m.userId);
  const searchResults = (userSearchResults?.users || []).filter(
    (u) => !existingUserIds.includes(u.userId),
  );

  return (
    <div style={{ paddingTop: '1rem' }}>
      {/* Add Member Section */}
      {canEdit && (
        <div style={{ marginBottom: '1.5rem' }}>
          <Title headingLevel="h4" size="md" style={{ marginBottom: '0.75rem' }}>
            {t('groups.members.addMember', 'Add Member')}
          </Title>
          <Flex
            spaceItems={{ default: 'spaceItemsSm' }}
            alignItems={{ default: 'alignItemsFlexEnd' }}
            flexWrap={{ default: 'wrap' }}
          >
            {/* User search select */}
            <FlexItem style={{ minWidth: '250px', flex: 1 }}>
              <Select
                role="listbox"
                id="user-search-select"
                isOpen={isUserSelectOpen}
                onOpenChange={setIsUserSelectOpen}
                aria-label={t('groups.members.searchUser', 'Search for user')}
                toggle={(toggleRef: React.Ref<MenuToggleElement>) => (
                  <MenuToggle
                    ref={toggleRef}
                    onClick={() => setIsUserSelectOpen(!isUserSelectOpen)}
                    isExpanded={isUserSelectOpen}
                    style={{ width: '100%' }}
                  >
                    {selectedUserLabel || t('groups.members.selectUser', 'Select a user...')}
                  </MenuToggle>
                )}
                onSelect={(_event, selection) => {
                  const userId = selection as string;
                  const user = searchResults.find((u) => u.userId === userId);
                  if (user) {
                    setSelectedUserId(userId);
                    setSelectedUserLabel(`${user.username} (${user.email})`);
                  }
                  setIsUserSelectOpen(false);
                }}
                selected={selectedUserId || undefined}
              >
                <div style={{ padding: '0.5rem' }}>
                  <SearchInput
                    placeholder={t('groups.members.searchPlaceholder', 'Search users by name or email...')}
                    value={userSearchValue}
                    onChange={(_event, value) => setUserSearchValue(value)}
                    onClear={() => setUserSearchValue('')}
                    aria-label={t('groups.members.searchUserAriaLabel', 'Search users')}
                  />
                </div>
                <SelectList>
                  {userSearchValue.length < 2 ? (
                    <SelectOption isDisabled value="hint">
                      {t('groups.members.typeToSearch', 'Type at least 2 characters to search')}
                    </SelectOption>
                  ) : searchResults.length === 0 ? (
                    <SelectOption isDisabled value="no-results">
                      {t('groups.members.noUsersFound', 'No users found')}
                    </SelectOption>
                  ) : (
                    searchResults.map((user) => (
                      <SelectOption key={user.userId} value={user.userId}>
                        {user.username} ({user.email})
                      </SelectOption>
                    ))
                  )}
                </SelectList>
              </Select>
            </FlexItem>

            {/* Role select */}
            <FlexItem>
              <Select
                role="listbox"
                id="new-member-role-select"
                isOpen={isRoleSelectOpen}
                onOpenChange={setIsRoleSelectOpen}
                aria-label={t('groups.members.selectRole', 'Select role')}
                toggle={(toggleRef: React.Ref<MenuToggleElement>) => (
                  <MenuToggle
                    ref={toggleRef}
                    onClick={() => setIsRoleSelectOpen(!isRoleSelectOpen)}
                    isExpanded={isRoleSelectOpen}
                  >
                    {getRoleLabel(newMemberRole)}
                  </MenuToggle>
                )}
                onSelect={(_event, selection) => {
                  setNewMemberRole(selection as 'admin' | 'member' | 'viewer');
                  setIsRoleSelectOpen(false);
                }}
                selected={newMemberRole}
              >
                <SelectList>
                  {GROUP_ROLES.map((role) => (
                    <SelectOption key={role.value} value={role.value}>
                      {t(role.labelKey, role.value)}
                    </SelectOption>
                  ))}
                </SelectList>
              </Select>
            </FlexItem>

            {/* Add button */}
            <FlexItem>
              <Button
                variant="primary"
                icon={<PlusCircleIcon />}
                onClick={handleAddMember}
                isDisabled={!selectedUserId || addMemberMutation.isLoading}
                isLoading={addMemberMutation.isLoading}
                aria-label={t('groups.members.addButton', 'Add member')}
              >
                {t('groups.members.add', 'Add')}
              </Button>
            </FlexItem>
          </Flex>
        </div>
      )}

      {/* Members Table */}
      {members.length === 0 ? (
        <EmptyState variant={EmptyStateVariant.sm}>
          <UsersIcon />
          <Title headingLevel="h4" size="md">
            {t('groups.members.noMembers', 'No Members')}
          </Title>
          <EmptyStateBody>
            {t('groups.members.noMembersDesc', 'This group has no members yet.')}
          </EmptyStateBody>
        </EmptyState>
      ) : (
        <Table
          aria-label={t('groups.members.tableAriaLabel', 'Group members table')}
          variant="compact"
        >
          <caption className="pf-v6-screen-reader">
            {t('groups.members.tableCaption', 'Group members list with {{count}} members', {
              count: members.length,
            })}
          </caption>
          <Thead>
            <Tr>
              <Th width={30}>{t('groups.members.user', 'User')}</Th>
              <Th width={30}>{t('groups.members.email', 'Email')}</Th>
              <Th width={20}>{t('groups.members.role', 'Role')}</Th>
              <Th width={10}>{t('groups.members.joined', 'Joined')}</Th>
              {canEdit && <Th screenReaderText={t('groups.members.actions', 'Actions')}></Th>}
            </Tr>
          </Thead>
          <Tbody>
            {members.map((member) => {
              const isLastAdmin =
                member.role === 'admin' &&
                members.filter((m) => m.role === 'admin').length <= 1;

              const actions = canEdit
                ? [
                    ...GROUP_ROLES.filter((r) => r.value !== member.role).map((role) => ({
                      title: t('groups.members.changeRoleTo', 'Change role to {{role}}', {
                        role: t(role.labelKey, role.value),
                      }),
                      onClick: () => handleRoleChange(member.userId, role.value),
                      isDisabled: isLastAdmin && role.value !== 'admin',
                    })),
                    {
                      isSeparator: true,
                    } as any,
                    {
                      title: t('groups.members.remove', 'Remove'),
                      onClick: () => {
                        if (confirmRemoveUserId === member.userId) {
                          handleRemoveMember(member.userId);
                        } else {
                          setConfirmRemoveUserId(member.userId);
                        }
                      },
                      isDisabled: isLastAdmin,
                    },
                  ]
                : [];

              return (
                <Tr key={member.id}>
                  <Th scope="row">
                    <strong>{member.user.username}</strong>
                    {member.user.fullName && (
                      <Content
                        component={ContentVariants.small}
                        style={{ color: 'var(--pf-t--global--text--color--subtle)' }}
                      >
                        {member.user.fullName}
                      </Content>
                    )}
                  </Th>
                  <Td>{member.user.email}</Td>
                  <Td>
                    <Badge
                      style={{
                        backgroundColor:
                          member.role === 'admin'
                            ? 'var(--pf-t--global--color--status--info--default)'
                            : member.role === 'member'
                              ? 'var(--pf-t--global--color--status--success--default)'
                              : 'var(--pf-t--global--color--status--default--default)',
                        color: 'var(--pf-t--global--text--color--inverse)',
                      }}
                    >
                      {getRoleLabel(member.role)}
                    </Badge>
                    {isLastAdmin && member.role === 'admin' && (
                      <Content
                        component={ContentVariants.small}
                        style={{
                          color: 'var(--pf-t--global--color--status--warning--default)',
                          marginTop: '0.25rem',
                        }}
                      >
                        <ExclamationTriangleIcon />{' '}
                        {t('groups.members.lastAdmin', 'Last admin')}
                      </Content>
                    )}
                  </Td>
                  <Td>
                    {new Date(member.joinedAt).toLocaleDateString()}
                  </Td>
                  {canEdit && (
                    <Td isActionCell>
                      {confirmRemoveUserId === member.userId ? (
                        <Flex spaceItems={{ default: 'spaceItemsXs' }}>
                          <FlexItem>
                            <Button
                              variant="danger"
                              size="sm"
                              onClick={() => handleRemoveMember(member.userId)}
                              isLoading={removeMemberMutation.isLoading}
                            >
                              {t('groups.members.confirmRemove', 'Confirm')}
                            </Button>
                          </FlexItem>
                          <FlexItem>
                            <Button
                              variant="link"
                              size="sm"
                              onClick={() => setConfirmRemoveUserId(null)}
                            >
                              {t('ui.actions.cancel', 'Cancel')}
                            </Button>
                          </FlexItem>
                        </Flex>
                      ) : (
                        <ActionsColumn items={actions} />
                      )}
                    </Td>
                  )}
                </Tr>
              );
            })}
          </Tbody>
        </Table>
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

export default GroupMembersTab;
