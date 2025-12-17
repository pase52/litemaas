import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  Form,
  Switch,
  Badge,
  Label,
  Alert,
  Flex,
  FlexItem,
  Grid,
  GridItem,
  Content,
  ContentVariants,
} from '@patternfly/react-core';
import { CheckCircleIcon, ExclamationTriangleIcon } from '@patternfly/react-icons';
import { User } from '../../types/users';

interface UserProfileTabProps {
  user: User;
  roles: string[];
  canEdit: boolean;
  isUpdating: boolean;
  onRoleToggle: (role: string, checked: boolean) => void;
}

const UserProfileTab: React.FC<UserProfileTabProps> = ({
  user,
  roles,
  canEdit,
  isUpdating,
  onRoleToggle,
}) => {
  const { t } = useTranslation();

  const formatDate = (dateString?: string) => {
    if (!dateString) return t('users.never', 'Never');
    return new Date(dateString).toLocaleDateString();
  };

  const formatDateTime = (dateString: string) => {
    return new Date(dateString).toLocaleString();
  };

  // Available roles for management
  const availableRoles = [
    { key: 'user', label: t('role.user', 'User') },
    { key: 'admin', label: t('role.admin', 'Administrator') },
    { key: 'admin-readonly', label: t('role.adminReadonly', 'Administrator (Read-only)') },
  ];

  return (
    <Form>
      {/* User Information Section - Compact Grid Layout */}
      <Content component={ContentVariants.h3} style={{ marginBottom: '0.75rem' }}>
        {t('users.form.userInfo', 'User Information')}
      </Content>

      <Grid hasGutter md={6} lg={4} style={{ marginBottom: '1rem' }}>
        <GridItem>
          <strong style={{ fontSize: 'var(--pf-t--global--font--size--sm)' }}>
            {t('users.form.username', 'Username')}:
          </strong>
          <div style={{ marginTop: '0.25rem' }}>{user.username}</div>
        </GridItem>
        <GridItem>
          <strong style={{ fontSize: 'var(--pf-t--global--font--size--sm)' }}>
            {t('users.form.email', 'Email')}:
          </strong>
          <div style={{ marginTop: '0.25rem' }}>{user.email}</div>
        </GridItem>
        <GridItem>
          <strong style={{ fontSize: 'var(--pf-t--global--font--size--sm)' }}>
            {t('users.form.fullName', 'Full Name')}:
          </strong>
          <div style={{ marginTop: '0.25rem' }}>
            {user.fullName || (
              <span
                style={{
                  fontStyle: 'italic',
                  color: 'var(--pf-t--global--text--color--subtle)',
                }}
              >
                {t('common.notAvailable', 'N/A')}
              </span>
            )}
          </div>
        </GridItem>
        <GridItem>
          <strong style={{ fontSize: 'var(--pf-t--global--font--size--sm)' }}>
            {t('users.form.createdAt', 'Created At')}:
          </strong>
          <div style={{ marginTop: '0.25rem', fontSize: 'var(--pf-t--global--font--size--sm)' }}>
            {formatDateTime(user.createdAt)}
          </div>
        </GridItem>
        <GridItem>
          <strong style={{ fontSize: 'var(--pf-t--global--font--size--sm)' }}>
            {t('users.form.lastLogin', 'Last Login')}:
          </strong>
          <div style={{ marginTop: '0.25rem', fontSize: 'var(--pf-t--global--font--size--sm)' }}>
            {formatDate(user.lastLoginAt)}
          </div>
        </GridItem>
      </Grid>

      {/* Roles Section - Compact */}
      <Content component={ContentVariants.h3} style={{ marginBottom: '0.75rem' }}>
        {t('users.form.roles', 'Roles')}
      </Content>

      {canEdit ? (
        <div style={{ marginBottom: '1rem' }}>
          <Flex direction={{ default: 'column' }} spaceItems={{ default: 'spaceItemsSm' }}>
            {availableRoles.map((role) => (
              <FlexItem key={role.key}>
                <Switch
                  id={`role-${role.key}`}
                  label={role.label}
                  isChecked={roles.includes(role.key)}
                  onChange={(_event, checked) => onRoleToggle(role.key, checked)}
                  aria-label={t('users.form.toggleRole', 'Toggle {{role}} role', {
                    role: role.label,
                  })}
                  isDisabled={isUpdating}
                />
              </FlexItem>
            ))}
          </Flex>

          {/* Handle role conflicts */}
          {roles.includes('admin') && roles.includes('admin-readonly') && (
            <Alert
              variant="warning"
              title={t('users.warnings.roleConflict', 'Role Conflict')}
              isInline
              style={{ marginTop: '0.75rem' }}
            >
              {t(
                'users.warnings.roleConflictDesc',
                'Admin and Admin-readonly roles conflict. Admin role will take precedence.',
              )}
            </Alert>
          )}
        </div>
      ) : (
        <div style={{ marginBottom: '1rem' }}>
          <Flex direction={{ default: 'row' }} spaceItems={{ default: 'spaceItemsSm' }}>
            {roles.length > 0 ? (
              roles.map((role) => {
                const roleInfo = availableRoles.find((r) => r.key === role);
                return (
                  <FlexItem key={role}>
                    <Badge isRead>{roleInfo?.label || role}</Badge>
                  </FlexItem>
                );
              })
            ) : (
              <FlexItem>
                <Badge>{t('users.form.noRoles', 'No roles assigned')}</Badge>
              </FlexItem>
            )}
          </Flex>
        </div>
      )}

      {/* Status Section - Compact */}
      <Content component={ContentVariants.h3} style={{ marginBottom: '0.5rem' }}>
        {t('users.form.status', 'Status')}
      </Content>

      <div style={{ marginBottom: '1rem' }}>
        <Label color={user.isActive ? 'green' : 'red'} style={{ marginBottom: '0.5rem' }}>
          {user.isActive ? (
            <>
              <CheckCircleIcon /> {t('status.active', 'Active')}
            </>
          ) : (
            <>
              <ExclamationTriangleIcon /> {t('status.inactive', 'Inactive')}
            </>
          )}
        </Label>
        <div>
          <Content
            component={ContentVariants.small}
            style={{ fontStyle: 'italic', color: 'var(--pf-t--global--text--color--subtle)' }}
          >
            {t('users.status.oauthManaged')}
          </Content>
        </div>
      </div>
    </Form>
  );
};

export default UserProfileTab;
