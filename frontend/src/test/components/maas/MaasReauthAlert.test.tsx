import { describe, it, expect, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { render, screen } from '../../test-utils';
import { MaasReauthAlert } from '../../../components/common/MaasReauthAlert';
import { AuthContext } from '../../../contexts/AuthContext';

describe('MaasReauthAlert', () => {
  it('is a polite live region so assistive technology announces it when it appears', () => {
    render(<MaasReauthAlert />);

    // It is the only feedback when creating a key fails inside the modal
    const alert = screen.getByTestId('maas-reauth-alert');
    expect(alert).toHaveAttribute('aria-live', 'polite');
    expect(alert).toHaveAttribute('aria-atomic', 'false');
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<MaasReauthAlert />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('signs the user in again through the auth context', async () => {
    const user = userEvent.setup();
    const login = vi.fn();
    render(
      <AuthContext.Provider
        value={{
          user: null,
          loading: false,
          isAuthenticated: false,
          login,
          loginAsAdmin: vi.fn(),
          logout: vi.fn(async () => {}),
          refreshUser: vi.fn(async () => {}),
        }}
      >
        <MaasReauthAlert />
      </AuthContext.Provider>,
    );

    await user.click(screen.getByTestId('maas-reauth-button'));
    expect(login).toHaveBeenCalledTimes(1);
  });
});
