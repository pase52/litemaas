import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from 'react-query';
import {
  PageSection,
  Title,
  Content,
  ContentVariants,
  Label,
  Spinner,
  EmptyState,
  EmptyStateVariant,
  EmptyStateBody,
  EmptyStateActions,
  Bullseye,
  SearchInput,
  Button,
  Pagination,
  PaginationVariant,
  Toolbar,
  ToolbarContent,
  ToolbarItem,
  Flex,
  FlexItem,
} from '@patternfly/react-core';
import { UsersIcon } from '@patternfly/react-icons';
import { Table, Thead, Tbody, Tr, Th, Td } from '@patternfly/react-table';
import { groupsService } from '../services/groups.service';
import { Group, GroupListParams } from '../types/groups';
import { useNotifications } from '../contexts/NotificationContext';

const GroupsPage: React.FC = () => {
  const { t } = useTranslation();
  const { addNotification } = useNotifications();

  // State management
  const [searchValue, setSearchValue] = useState('');
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(10);

  // Build query parameters
  const queryParams: GroupListParams = {
    page,
    limit: perPage,
    ...(searchValue && { search: searchValue }),
  };

  // Fetch user's groups with React Query
  const {
    data: groupsResponse,
    isLoading,
    error,
    refetch,
  } = useQuery(['my-groups', queryParams], () => groupsService.getMyGroups(queryParams), {
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
  });

  // Helper functions
  const getStatusBadge = (isActive: boolean) => {
    return (
      <Label color={isActive ? 'green' : 'grey'}>
        {isActive ? t('status.active', 'Active') : t('status.inactive', 'Inactive')}
      </Label>
    );
  };

  const getModelsDisplay = (group: Group) => {
    if (!group.allowedModels || group.allowedModels.length === 0) {
      return (
        <Label color="blue">{t('groups.table.allModels', 'All')}</Label>
      );
    }
    return group.allowedModels.length.toString();
  };

  const truncateDescription = (description?: string, maxLength = 80) => {
    if (!description) {
      return (
        <Content
          component={ContentVariants.small}
          style={{
            fontStyle: 'italic',
            color: 'var(--pf-t--global--text--color--subtle)',
          }}
        >
          {t('groups.table.noDescription', 'No description')}
        </Content>
      );
    }
    if (description.length <= maxLength) {
      return description;
    }
    return `${description.substring(0, maxLength)}...`;
  };

  const handleSearch = (value: string) => {
    setSearchValue(value);
    setPage(1);
  };

  // Loading state
  if (isLoading) {
    return (
      <>
        <PageSection variant="secondary">
          <Title headingLevel="h1" size="2xl">
            {t('groups.title', 'My Groups')}
          </Title>
        </PageSection>
        <PageSection>
          <Bullseye>
            <EmptyState variant={EmptyStateVariant.lg}>
              <Spinner size="xl" />
              <Title headingLevel="h2" size="lg">
                {t('groups.loading.title', 'Loading groups')}
              </Title>
              <EmptyStateBody>
                {t('groups.loading.description', 'Please wait while your groups are loaded.')}
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
              {t('groups.title', 'My Groups')}
            </Title>
            <Content component={ContentVariants.p}>
              {t('groups.pageDescription', 'View the groups you belong to and their details.')}
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
            <Title headingLevel="h2" size="lg">
              {t('groups.error.loadTitle', 'Unable to load groups')}
            </Title>
            <EmptyStateBody>
              {error instanceof Error
                ? error.message
                : t('groups.error.loadDescription', 'An error occurred while loading your groups. Please try again.')}
            </EmptyStateBody>
            <EmptyStateActions>
              <Button variant="primary" onClick={() => refetch()}>
                {t('groups.error.tryAgain', 'Try again')}
              </Button>
            </EmptyStateActions>
          </EmptyState>
        ) : (
          <div>
            {/* Toolbar with search */}
            <Toolbar id="groups-toolbar">
              <ToolbarContent>
                <ToolbarItem>
                  <SearchInput
                    placeholder={t('groups.search.placeholder', 'Search groups by name...')}
                    value={searchValue}
                    onChange={(_, value) => setSearchValue(value)}
                    onClear={() => handleSearch('')}
                    aria-label={t('groups.search.ariaLabel', 'Search groups')}
                  />
                </ToolbarItem>
              </ToolbarContent>
            </Toolbar>

            {groups.length === 0 ? (
              <EmptyState variant={EmptyStateVariant.lg}>
                <UsersIcon />
                <Title headingLevel="h2" size="lg">
                  {searchValue
                    ? t('groups.search.noResults', 'No groups match your search')
                    : t('groups.empty.title', 'No groups yet')}
                </Title>
                <EmptyStateBody>
                  {searchValue
                    ? t('groups.search.adjustSearch', 'Try adjusting your search criteria.')
                    : t(
                        'groups.empty.description',
                        'You are not a member of any groups yet. Contact an administrator to be added to a group.',
                      )}
                </EmptyStateBody>
                {searchValue && (
                  <EmptyStateActions>
                    <Button variant="link" onClick={() => handleSearch('')}>
                      {t('groups.search.clearSearch', 'Clear search')}
                    </Button>
                  </EmptyStateActions>
                )}
              </EmptyState>
            ) : (
              <>
                <Table aria-label={t('groups.table.ariaLabel', 'Groups table')} variant="compact">
                  <caption className="pf-v6-screen-reader">
                    {t('groups.table.caption', { count: groups.length, defaultValue: 'List of {{count}} groups' })}
                  </caption>
                  <Thead>
                    <Tr>
                      <Th width={25}>{t('groups.table.name', 'Name')}</Th>
                      <Th width={30}>{t('groups.table.description', 'Description')}</Th>
                      <Th width={15}>{t('groups.table.members', 'Members')}</Th>
                      <Th width={15}>{t('groups.table.models', 'Models')}</Th>
                      <Th width={15}>{t('groups.table.status', 'Status')}</Th>
                    </Tr>
                  </Thead>
                  <Tbody>
                    {groups.map((group: Group) => (
                      <Tr key={group.id}>
                        <Th scope="row">
                          <strong>{group.name}</strong>
                        </Th>
                        <Td>{truncateDescription(group.description)}</Td>
                        <Td>
                          <Flex
                            alignItems={{ default: 'alignItemsCenter' }}
                            spaceItems={{ default: 'spaceItemsSm' }}
                          >
                            <FlexItem>
                              <UsersIcon />
                            </FlexItem>
                            <FlexItem>{group.memberCount}</FlexItem>
                          </Flex>
                        </Td>
                        <Td>{getModelsDisplay(group)}</Td>
                        <Td>{getStatusBadge(group.isActive)}</Td>
                      </Tr>
                    ))}
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
    </>
  );
};

export default GroupsPage;
