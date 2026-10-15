import React, { useContext } from 'react';
import { Alert, AlertActionLink } from '@patternfly/react-core';
import { useTranslation } from 'react-i18next';
import { AuthContext } from '../../contexts/AuthContext';

interface MaasReauthAlertProps {
  /** Hide the alert's own margin (when it sits inside a form). */
  className?: string;
}

/**
 * Inline alert shown when the backend answers MAAS_REAUTH_REQUIRED: the stored
 * OpenShift login token is missing or expired, so the user has to sign in again.
 * The existing login redirect returns the user to the current page (/api-keys).
 * It is a live region: when a create/update fails inside the modal this alert is the only
 * feedback, so assistive technology has to announce it when it appears.
 */
export const MaasReauthAlert: React.FC<MaasReauthAlertProps> = ({ className }) => {
  const { t } = useTranslation();
  const auth = useContext(AuthContext);

  const handleReauth = () => {
    if (auth?.login) {
      auth.login();
    } else {
      window.location.href = '/login';
    }
  };

  return (
    <Alert
      variant="warning"
      isInline
      isLiveRegion
      className={className}
      title={t('maas.keys.reauthTitle', 'Re-authentication required')}
      data-testid="maas-reauth-alert"
      actionLinks={
        <AlertActionLink onClick={handleReauth} data-testid="maas-reauth-button">
          {t('maas.keys.reauthButton', 'Re-authenticate')}
        </AlertActionLink>
      }
    >
      {t(
        'maas.keys.reauthBody',
        'MaaS keys are issued with your own OpenShift login, which has expired. Sign in again to continue, you will return to this page.',
      )}
    </Alert>
  );
};
