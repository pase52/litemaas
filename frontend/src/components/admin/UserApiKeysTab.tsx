import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Label,
  Skeleton,
  Alert,
  EmptyState,
  EmptyStateBody,
  EmptyStateHeader,
  EmptyStateIcon,
  Modal,
  ModalVariant,
  ModalBody,
  Content,
  ContentVariants,
} from '@patternfly/react-core';
import {
  Table,
  Thead,
  Tbody,
  Tr,
  Th,
  Td,
  ActionsColumn,
} from '@patternfly/react-table';
import { KeyIcon, ExternalLinkAltIcon } from '@patternfly/react-icons';
import { usersService } from '../../services/users.service';
import { useNotifications } from '../../contexts/NotificationContext';
import { UserApiKey } from '../../types/users';

interface UserApiKeysTabProps {
  userId: string;
  canEdit: boolean;
}

const UserApiKeysTab: React.FC<UserApiKeysTabProps> = ({ userId, canEdit }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { addNotification } = useNotifications();
  const queryClient = useQueryClient();

  // Revoke confirmation modal state
  const [revokeModalOpen, setRevokeModalOpen] = useState(false);
  const [keyToRevoke, setKeyToRevoke] = useState<UserApiKey | null>(null);

  // Fetch API keys
  const {
    data: apiKeysResponse,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['admin-user-api-keys', userId],
    queryFn: () => usersService.getUserApiKeys(userId),
  });

  // Revoke mutation
  const revokeMutation = useMutation({
    mutationFn: (keyId: string) => usersService.revokeUserApiKey(userId, keyId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-user-api-keys', userId] });
      addNotification({
        title: t('users.apiKeys.revokeSuccess', 'API Key Revoked'),
        description: t(
          'users.apiKeys.revokeSuccessDesc',
          'The API key has been revoked successfully.',
        ),
        variant: 'success',
      });
      setRevokeModalOpen(false);
      setKeyToRevoke(null);
    },
    onError: (err: Error) => {
      addNotification({
        title: t('users.apiKeys.revokeError', 'Revoke Failed'),
        description: err.message,
        variant: 'danger',
      });
    },
  });

  const handleViewUsage = (apiKeyId: string) => {
    navigate(`/admin/usage?apiKeyIds=${apiKeyId}`);
  };

  const handleRevokeClick = (key: UserApiKey) => {
    setKeyToRevoke(key);
    setRevokeModalOpen(true);
  };

  const handleConfirmRevoke = () => {
    if (keyToRevoke) {
      revokeMutation.mutate(keyToRevoke.id);
    }
  };

  const formatDate = (dateString?: string) => {
    if (!dateString) return '-';
    return new Date(dateString).toLocaleDateString();
  };

  const getStatusColor = (key: UserApiKey): 'green' | 'red' | 'grey' => {
    if (key.revokedAt) return 'red';
    if (!key.isActive) return 'grey';
    return 'green';
  };

  const getStatusLabel = (key: UserApiKey): string => {
    if (key.revokedAt) return t('status.revoked', 'Revoked');
    if (!key.isActive) return t('status.inactive', 'Inactive');
    return t('status.active', 'Active');
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
      <Alert variant="danger" title={t('common.error', 'Error')} isInline>
        {t('users.apiKeys.loadError', 'Failed to load API keys')}
      </Alert>
    );
  }

  const apiKeys = apiKeysResponse?.data || [];

  if (apiKeys.length === 0) {
    return (
      <EmptyState>
        <EmptyStateHeader
          titleText={t('users.apiKeys.noKeys', 'No API Keys')}
          headingLevel="h4"
          icon={<EmptyStateIcon icon={KeyIcon} />}
        />
        <EmptyStateBody>
          {t('users.apiKeys.noKeysDesc', 'This user has no API keys.')}
        </EmptyStateBody>
      </EmptyState>
    );
  }

  return (
    <div style={{ paddingTop: '1rem' }}>
      <Table aria-label={t('users.apiKeys.tableLabel', 'User API Keys')}>
        <Thead>
          <Tr>
            <Th>{t('users.apiKeys.name', 'Name')}</Th>
            <Th>{t('users.apiKeys.status', 'Status')}</Th>
            <Th>{t('users.apiKeys.models', 'Models')}</Th>
            <Th>{t('users.apiKeys.lastUsed', 'Last Used')}</Th>
            <Th screenReaderText={t('common.actions', 'Actions')} />
          </Tr>
        </Thead>
        <Tbody>
          {apiKeys.map((key) => (
            <Tr key={key.id}>
              <Td dataLabel={t('users.apiKeys.name', 'Name')}>
                <div>
                  <strong>{key.name}</strong>
                  <Content component={ContentVariants.small} style={{ color: 'var(--pf-t--global--text--color--subtle)' }}>
                    {key.keyPrefix}...
                  </Content>
                </div>
              </Td>
              <Td dataLabel={t('users.apiKeys.status', 'Status')}>
                <Label color={getStatusColor(key)}>{getStatusLabel(key)}</Label>
              </Td>
              <Td dataLabel={t('users.apiKeys.models', 'Models')}>
                {key.modelDetails && key.modelDetails.length > 0 ? (
                  <div>
                    {key.modelDetails.slice(0, 2).map((model) => (
                      <Label key={model.id} isCompact style={{ marginRight: '0.25rem', marginBottom: '0.25rem' }}>
                        {model.name}
                      </Label>
                    ))}
                    {key.modelDetails.length > 2 && (
                      <Label isCompact color="grey">
                        +{key.modelDetails.length - 2}
                      </Label>
                    )}
                  </div>
                ) : (
                  <span style={{ color: 'var(--pf-t--global--text--color--subtle)' }}>-</span>
                )}
              </Td>
              <Td dataLabel={t('users.apiKeys.lastUsed', 'Last Used')}>
                {formatDate(key.lastUsedAt)}
              </Td>
              <Td isActionCell>
                <ActionsColumn
                  items={[
                    {
                      title: (
                        <>
                          {t('users.apiKeys.viewUsage', 'View Usage')}{' '}
                          <ExternalLinkAltIcon />
                        </>
                      ),
                      onClick: () => handleViewUsage(key.id),
                    },
                    ...(canEdit && key.isActive && !key.revokedAt
                      ? [
                          {
                            title: t('users.apiKeys.revoke', 'Revoke'),
                            onClick: () => handleRevokeClick(key),
                          },
                        ]
                      : []),
                  ]}
                />
              </Td>
            </Tr>
          ))}
        </Tbody>
      </Table>

      {/* Revoke Confirmation Modal */}
      <Modal
        variant={ModalVariant.small}
        title={t('users.apiKeys.revokeConfirmTitle', 'Revoke API Key')}
        isOpen={revokeModalOpen}
        onClose={() => setRevokeModalOpen(false)}
      >
        <ModalBody>
          <p>
            {t(
              'users.apiKeys.revokeConfirmDesc',
              'Are you sure you want to revoke this API key? This action cannot be undone.',
            )}
          </p>
          {keyToRevoke && (
            <p style={{ marginTop: '0.5rem' }}>
              <strong>{keyToRevoke.name}</strong> ({keyToRevoke.keyPrefix}...)
            </p>
          )}
          <div style={{ marginTop: '1rem', display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
            <Button
              variant="danger"
              onClick={handleConfirmRevoke}
              isLoading={revokeMutation.isPending}
              isDisabled={revokeMutation.isPending}
            >
              {t('users.apiKeys.revoke', 'Revoke')}
            </Button>
            <Button
              variant="link"
              onClick={() => setRevokeModalOpen(false)}
              isDisabled={revokeMutation.isPending}
            >
              {t('common.cancel', 'Cancel')}
            </Button>
          </div>
        </ModalBody>
      </Modal>
    </div>
  );
};

export default UserApiKeysTab;
