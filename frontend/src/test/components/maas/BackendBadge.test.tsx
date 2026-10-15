import { describe, it, expect } from 'vitest';
import { render, screen } from '../../test-utils';
import { BackendBadge, MigrationLabel } from '../../../components/common/BackendBadge';

describe('BackendBadge', () => {
  it('renders a MaaS badge for maas models', () => {
    render(<BackendBadge backendType="maas" />);
    expect(screen.getByTestId('backend-badge-maas')).toBeInTheDocument();
  });

  it('renders nothing for LiteLLM by default so LiteLLM-only UIs are unchanged', () => {
    const { container } = render(<BackendBadge backendType="litellm" />);
    expect(container.querySelector('[data-testid^="backend-badge"]')).toBeNull();
    const { container: c2 } = render(<BackendBadge />);
    expect(c2.querySelector('[data-testid^="backend-badge"]')).toBeNull();
  });

  it('renders a LiteLLM badge when explicitly requested', () => {
    render(<BackendBadge backendType="litellm" showLiteLLM />);
    expect(screen.getByTestId('backend-badge-litellm')).toBeInTheDocument();
  });
});

describe('MigrationLabel', () => {
  it('shows the label while the grace period is running', () => {
    const future = new Date(Date.now() + 5 * 86400000).toISOString();
    render(<MigrationLabel migrationState="migrating" migrationGraceUntil={future} />);
    expect(screen.getByTestId('migration-label')).toHaveTextContent(/Migrating to MaaS until/);
  });

  it('shows nothing once the grace period is over or when unset', () => {
    const past = new Date(Date.now() - 86400000).toISOString();
    const { container } = render(<MigrationLabel migrationGraceUntil={past} />);
    expect(container.querySelector('[data-testid="migration-label"]')).toBeNull();
    const { container: c2 } = render(<MigrationLabel />);
    expect(c2.querySelector('[data-testid="migration-label"]')).toBeNull();
  });
});
