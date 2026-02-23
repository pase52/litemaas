import React, { useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from 'react-query';
import {
  PageSection,
  Title,
  Button,
  Label,
  Content,
  ContentVariants,
  Flex,
  FlexItem,
  Spinner,
  EmptyState,
  EmptyStateVariant,
  EmptyStateBody,
  EmptyStateActions,
  Bullseye,
  SearchInput,
  Select,
  SelectList,
  SelectOption,
  MenuToggle,
  MenuToggleElement,
  Pagination,
  PaginationVariant,
  Toolbar,
  ToolbarContent,
  ToolbarItem,
  ToolbarGroup,
  Divider,
} from '@patternfly/react-core';
import {
  UsersIcon,
  FilterIcon,
  ExclamationTriangleIcon,
  PlusCircleIcon,
} from '@patternfly/react-icons';
import {
  Table,
  Thead,
  Tbody,
  Tr,
  Th,
  Td,
  ActionsColumn,
} from '@patternfly/react-table';
import { useAuth } from '../contexts/AuthContext';
import { useNotifications } from '../contexts/NotificationContext';
import { groupsService } from '../services/groups.service';
import { Group, GroupListParams } from '../types/groups';
import GroupEditModal from '../components/GroupEditModal';

const AdminGroupsPage: React.FC = () => {
  const { t } = useTranslation();
  const { user: currentUser } = useAuth();
  const { addNotification } = useNotifications();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  // State management
  const [selectedGroup, setSelectedGroup] = useState<Group | null>(null);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [isCreateMode, setIsCreateMode] = useState(false);
  const [searchValue, setSearchValue] = useState(searchParams.get('search') || '');
  const [statusFilter, setStatusFilter] = useState(searchParams.get('status') || '');
  const [isStatusFilterOpen, setIsStatusFilterOpen] = useState(false);
  const [page, setPage] = useState(parseInt(searchParams.get('page') || '1', 10));
  const [perPage, setPerPage] = useState(parseInt(searchParams.get('limit') || '10', 10));
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // Modal focus management ref
  const editModalTriggerRef = useRef<HTMLElement | null>(null);

  // Check permissions
  const canViewGroups = groupsService.canViewGroups(currentUser || undefined);
  const canManageGroups = groupsService.canManageGroups(currentUser || undefined);

  // Build query parameters
  const queryParams: GroupListParams = {
    page,
    limit: perPage,
    ...(searchValue && { search: searchValue }),
    ...(statusFilter === 'active' && { isActive: true }),
    ...(statusFilter === 'inactive' && { isActive: false }),
  };

  // Fetch groups data with React Query
  const {
    data: groupsResponse,
    isLoading,
    error,
    refetch,
  } = useQuery(
    ['admin-groups', queryParams],
    () => groupsService.getAdminGroups(queryParams),
    {
      enabled: canViewGroups,
      keepPreviousData: true,
      onError: (err: any) => {
        console.error('Failed to load groups:', err);
        const errorMessage =
          err?.response?.data?.message || err?.message || t('groups.error.load', 'Failed to load groups');
        addNotification({
          title: t('groups.error.load', 'Failed to load groups'),
          description: errorMessage,
          variant: 'danger',
        });
      },
    },
  );

  // Delete group mutation
  const deleteGroupMutation = useMutation({
    mutationFn: (groupId: string) => groupsService.deleteGroup(groupId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-groups'] });
      setConfirmDeleteId(null);
      addNotification({
        title: t('groups.notifications.deleteSuccess', 'Group Deleted'),
        description: t(
          'groups.notifications.deleteSuccessDesc',
          'The group has been deleted successfully.',
        ),
        variant: 'success',
      });
    },
    onError: (err: Error) => {
      setConfirmDeleteId(null);
      addNotification({
        title: t('groups.notifications.deleteError', 'Delete Failed'),
        description: err.message,
        variant: 'danger',
      });
    },
  });

  // Update URL parameters when filters change
  useEffect(() => {
    const newParams = new URLSearchParams();
    if (page > 1) newParams.set('page', page.toString());
    if (perPage !== 10) newParams.set('limit', perPage.toString());
    if (searchValue) newParams.set('search', searchValue);
    if (statusFilter) newParams.set('status', statusFilter);

    setSearchParams(newParams);
  }, [page, perPage, searchValue, statusFilter, setSearchParams]);

  // Helper functions
  const getStatusBadge = (isActive: boolean) => {
    return (
      <Label color={isActive ? 'green' : 'red'}>
        {isActive ? t('status.active', 'Active') : t('status.inactive', 'Inactive')}
      </Label>
    );
  };

  const formatBudget = (group: Group): string => {
    if (group.maxBudget == null || group.maxBudget === 0) {
      return '\u2014'; // em dash
    }
    const spend = group.currentSpend?.toFixed(2) || '0.00';
    const max = group.maxBudget.toFixed(2);
    return `$${spend} / $${max}`;
  };

  const formatModels = (group: Group): string => {
    if (!group.allowedModels || group.allowedModels.length === 0) {
      return t('groups.table.allModels', 'All Models');
    }
    return group.allowedModels.length.toString();
  };

  const handleSearch = (value: string) => {
    setSearchValue(value);
    setPage(1);
  };

  const handleStatusFilterChange = (selection: string) => {
    setStatusFilter(selection === statusFilter ? '' : selection);
    setPage(1);
    setIsStatusFilterOpen(false);
  };

  const handleManageGroup = (group: Group, triggerElement?: HTMLElement) => {
    setSelectedGroup(group);
    setIsCreateMode(false);
    if (triggerElement) {
      editModalTriggerRef.current = triggerElement;
    }
    setIsEditModalOpen(true);
  };

  const handleCreateGroup = () => {
    setSelectedGroup(null);
    setIsCreateMode(true);
    setIsEditModalOpen(true);
  };

  const handleDeleteGroup = (groupId: string) => {
    if (confirmDeleteId === groupId) {
      deleteGroupMutation.mutate(groupId);
    } else {
      setConfirmDeleteId(groupId);
    }
  };

  const clearAllFilters = () => {
    setSearchValue('');
    setStatusFilter('');
    setPage(1);
  };

  const hasActiveFilters = searchValue || statusFilter;

  // Permission check
  if (!canViewGroups) {
    return (
      <>
        <PageSection variant="secondary">
          <Title headingLevel="h1" size="2xl">
            {t('nav.admin.groups', 'Groups')}
          </Title>
        </PageSection>
        <PageSection>
          <EmptyState variant={EmptyStateVariant.lg} role="alert">
            <ExclamationTriangleIcon />
            <Title headingLevel="h2" size="lg">
              {t('groups.permissions.accessDenied', 'Access Denied')}
            </Title>
            <EmptyStateBody>
              {t(
                'groups.permissions.noPermission',
                'You do not have permission to view groups.',
              )}
            </EmptyStateBody>
          </EmptyState>
        </PageSection>
      </>
    );
  }

  // Loading state
  if (isLoading) {
    return (
      <>
        <PageSection variant="secondary">
          <Title headingLevel="h1" size="2xl">
            {t('nav.admin.groups', 'Groups')}
          </Title>
        </PageSection>
        <PageSection>
          <Bullseye>
            <EmptyState variant={EmptyStateVariant.lg}>
              <Spinner size="xl" />
              <Title headingLevel="h2" size="lg">
                {t('groups.loading.title', 'Loading Groups')}
              </Title>
              <EmptyStateBody>
                {t('groups.loading.description', 'Please wait while groups are being loaded.')}
              </EmptyStateBody>
            </EmptyState>
          </Bullseye>
        </PageSection>
      </>
    );
  }

  const groups = groupsResponse?.data || [];
  const pagination = groupsResponse?.pagination;

  return (
    <>
      <PageSection variant="secondary">
        <Flex
          justifyContent={{ default: 'justifyContentSpaceBetween' }}
          alignItems={{ default: 'alignItemsCenter' }}
        >
          <FlexItem>
            <Title headingLevel="h1" size="2xl">
              {t('nav.admin.groups', 'Groups')}
            </Title>
            <Content component={ContentVariants.p}>
              {t('groups.pageDescription', 'Manage groups, members, budgets, and model access.')}
            </Content>
          </FlexItem>
          <FlexItem>
            {pagination && (
              <Content component={ContentVariants.small}>
                {t('ui.pagination.showing', 'Showing')} {(page - 1) * perPage + 1} -{' '}
                {Math.min(page * perPage, pagination.total)} {t('groups.pagination.of', 'of')}{' '}
                {pagination.total} {t('groups.pagination.groups', 'groups')}
              </Content>
            )}
          </FlexItem>
        </Flex>
      </PageSection>

      <PageSection>
        {error ? (
          <EmptyState variant={EmptyStateVariant.lg} role="alert">
            <ExclamationTriangleIcon />
            <Title headingLevel="h2" size="lg">
              {t('groups.error.loadTitle', 'Error Loading Groups')}
            </Title>
            <EmptyStateBody>
              {error instanceof Error
                ? error.message
                : t('groups.error.loadDescription', 'An error occurred while loading groups.')}
            </EmptyStateBody>
            <EmptyStateActions>
              <Button variant="primary" onClick={() => refetch()}>
                {t('groups.error.tryAgain', 'Try Again')}
              </Button>
            </EmptyStateActions>
          </EmptyState>
        ) : (
          <div>
            {/* Toolbar with search and filters */}
            <Toolbar id="groups-toolbar" clearAllFilters={clearAllFilters}>
              <ToolbarContent>
                <ToolbarItem>
                  <SearchInput
                    placeholder={t('groups.search', 'Search groups...')}
                    value={searchValue}
                    onChange={(_, value) => setSearchValue(value)}
                    onClear={() => handleSearch('')}
                    aria-label={t('groups.searchAriaLabel', 'Search groups')}
                  />
                </ToolbarItem>
                <ToolbarItem>
                  <Select
                    role="listbox"
                    id="status-filter"
                    isOpen={isStatusFilterOpen}
                    onOpenChange={setIsStatusFilterOpen}
                    aria-label={t('groups.filters.statusAriaLabel', 'Filter by status')}
                    toggle={(toggleRef: React.Ref<MenuToggleElement>) => (
                      <MenuToggle
                        ref={toggleRef}
                        onClick={() => setIsStatusFilterOpen(!isStatusFilterOpen)}
                        isExpanded={isStatusFilterOpen}
                        icon={<FilterIcon />}
                      >
                        {statusFilter === 'active'
                          ? t('status.active', 'Active')
                          : statusFilter === 'inactive'
                            ? t('status.inactive', 'Inactive')
                            : t('groups.filters.allStatus', 'All Status')}
                      </MenuToggle>
                    )}
                    onSelect={(_, selection) =>
                      handleStatusFilterChange(selection as string)
                    }
                    selected={statusFilter}
                  >
                    <SelectList>
                      <SelectOption value="">
                        {t('groups.filters.allStatus', 'All Status')}
                      </SelectOption>
                      <Divider />
                      <SelectOption value="active">
                        {t('status.active', 'Active')}
                      </SelectOption>
                      <SelectOption value="inactive">
                        {t('status.inactive', 'Inactive')}
                      </SelectOption>
                    </SelectList>
                  </Select>
                </ToolbarItem>
                {hasActiveFilters && (
                  <ToolbarGroup>
                    <ToolbarItem>
                      <Button variant="link" onClick={clearAllFilters}>
                        {t('groups.filters.clearAll', 'Clear all filters')}
                      </Button>
                    </ToolbarItem>
                  </ToolbarGroup>
                )}
                {canManageGroups && (
                  <ToolbarItem align={{ default: 'alignEnd' }}>
                    <Button
                      variant="primary"
                      icon={<PlusCircleIcon />}
                      onClick={handleCreateGroup}
                    >
                      {t('groups.actions.createGroup', 'Create Group')}
                    </Button>
                  </ToolbarItem>
                )}
              </ToolbarContent>
            </Toolbar>

            {groups.length === 0 ? (
              <EmptyState variant={EmptyStateVariant.lg}>
                <UsersIcon />
                <Title headingLevel="h2" size="lg">
                  {hasActiveFilters
                    ? t('groups.filters.noMatches', 'No groups match your filters')
                    : t('groups.empty.title', 'No Groups')}
                </Title>
                <EmptyStateBody>
                  {hasActiveFilters
                    ? t(
                        'groups.filters.adjustFilters',
                        'Try adjusting your search or filter criteria.',
                      )
                    : t(
                        'groups.empty.description',
                        'No groups have been created yet. Create a group to get started.',
                      )}
                </EmptyStateBody>
                {hasActiveFilters ? (
                  <EmptyStateActions>
                    <Button variant="primary" onClick={clearAllFilters}>
                      {t('groups.filters.clearAll', 'Clear all filters')}
                    </Button>
                  </EmptyStateActions>
                ) : (
                  canManageGroups && (
                    <EmptyStateActions>
                      <Button
                        variant="primary"
                        icon={<PlusCircleIcon />}
                        onClick={handleCreateGroup}
                      >
                        {t('groups.actions.createGroup', 'Create Group')}
                      </Button>
                    </EmptyStateActions>
                  )
                )}
              </EmptyState>
            ) : (
              <>
                <Table
                  aria-label={t('groups.table.ariaLabel', 'Groups table')}
                  variant="compact"
                >
                  <caption className="pf-v6-screen-reader">
                    {t('groups.table.caption', 'Groups list with {{count}} groups', {
                      count: groups.length,
                    })}
                  </caption>
                  <Thead>
                    <Tr>
                      <Th width={20}>{t('groups.table.name', 'Name')}</Th>
                      <Th width={25}>{t('groups.table.description', 'Description')}</Th>
                      <Th width={10}>{t('groups.table.members', 'Members')}</Th>
                      <Th width={10}>{t('groups.table.models', 'Models')}</Th>
                      <Th width={15}>{t('groups.table.budget', 'Budget')}</Th>
                      <Th width={10}>{t('groups.table.status', 'Status')}</Th>
                      <Th screenReaderText={t('groups.table.actions', 'Actions')}></Th>
                    </Tr>
                  </Thead>
                  <Tbody>
                    {groups.map((group) => {
                      const actions = canManageGroups
                        ? [
                            {
                              title: t('groups.actions.edit', 'Edit'),
                              onClick: (event: React.MouseEvent) =>
                                handleManageGroup(
                                  group,
                                  event.currentTarget as HTMLElement,
                                ),
                            },
                            {
                              isSeparator: true,
                            },
                            {
                              title:
                                confirmDeleteId === group.id
                                  ? t('groups.actions.confirmDelete', 'Confirm Delete')
                                  : t('groups.actions.delete', 'Delete'),
                              onClick: () => handleDeleteGroup(group.id),
                              isDanger: true,
                            },
                          ]
                        : [
                            {
                              title: t('groups.actions.view', 'View'),
                              onClick: (event: React.MouseEvent) =>
                                handleManageGroup(
                                  group,
                                  event.currentTarget as HTMLElement,
                                ),
                            },
                          ];

                      return (
                        <Tr
                          key={group.id}
                          isClickable
                          onRowClick={() => handleManageGroup(group)}
                        >
                          <Th scope="row">
                            <Flex
                              alignItems={{ default: 'alignItemsCenter' }}
                              spaceItems={{ default: 'spaceItemsSm' }}
                            >
                              <FlexItem>
                                <UsersIcon />
                              </FlexItem>
                              <FlexItem>
                                <strong>{group.name}</strong>
                                {group.alias && (
                                  <Content
                                    component={ContentVariants.small}
                                    style={{
                                      color:
                                        'var(--pf-t--global--text--color--subtle)',
                                    }}
                                  >
                                    {group.alias}
                                  </Content>
                                )}
                              </FlexItem>
                            </Flex>
                          </Th>
                          <Td>
                            {group.description || (
                              <Content
                                component={ContentVariants.small}
                                style={{
                                  fontStyle: 'italic',
                                  color:
                                    'var(--pf-t--global--text--color--subtle)',
                                }}
                              >
                                {t('groups.table.noDescription', 'No description')}
                              </Content>
                            )}
                          </Td>
                          <Td>{group.memberCount}</Td>
                          <Td>{formatModels(group)}</Td>
                          <Td>{formatBudget(group)}</Td>
                          <Td>{getStatusBadge(group.isActive)}</Td>
                          <Td
                            isActionCell
                            onClick={(e: React.MouseEvent) => e.stopPropagation()}
                          >
                            <ActionsColumn items={actions} />
                          </Td>
                        </Tr>
                      );
                    })}
                  </Tbody>
                </Table>

                {/* Pagination */}
                {pagination && pagination.totalPages > 1 && (
                  <Pagination
                    itemCount={pagination.total}
                    perPage={perPage}
                    page={page}
                    onSetPage={(_, newPage) => setPage(newPage)}
                    onPerPageSelect={(_, newPerPage) => {
                      setPerPage(newPerPage);
                      setPage(1);
                    }}
                    widgetId="groups-pagination-bottom"
                    variant={PaginationVariant.bottom}
                    isCompact
                  />
                )}
              </>
            )}
          </div>
        )}
      </PageSection>

      {/* Group Edit/Create Modal */}
      <GroupEditModal
        group={isCreateMode ? null : selectedGroup}
        isOpen={isEditModalOpen}
        canEdit={canManageGroups}
        onClose={() => {
          setIsEditModalOpen(false);
          setSelectedGroup(null);
          setIsCreateMode(false);
          setTimeout(() => {
            editModalTriggerRef.current?.focus();
          }, 100);
        }}
        onSave={() => {
          setIsEditModalOpen(false);
          setSelectedGroup(null);
          setIsCreateMode(false);
          refetch();
          setTimeout(() => {
            editModalTriggerRef.current?.focus();
          }, 100);
        }}
      />
    </>
  );
};

export default AdminGroupsPage;
