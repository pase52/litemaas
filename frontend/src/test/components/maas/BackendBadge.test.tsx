import { describe, it, expect } from 'vitest';
import { axe } from 'jest-axe';
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

  describe('accessibility', () => {
    it('shows the short name and announces the full description as text', () => {
      render(<BackendBadge backendType="maas" />);
      const badge = screen.getByTestId('backend-badge-maas');

      // The visible flair stays short; the description is read by screen readers
      expect(screen.getByText('MaaS')).toBeInTheDocument();
      expect(screen.getByText('Served through Red Hat OpenShift AI MaaS')).toHaveClass(
        'pf-v6-screen-reader',
      );
      expect(badge).toHaveTextContent('Served through Red Hat OpenShift AI MaaS');
    });

    it('does not put an aria-label on the plain span (axe: aria-prohibited-attr)', async () => {
      const { container } = render(<BackendBadge backendType="maas" isCompact />);
      expect(screen.getByTestId('backend-badge-maas')).not.toHaveAttribute('aria-label');
      expect(container.querySelector('[aria-label]')).toBeNull();

      const results = await axe(container);
      expect(results).toHaveNoViolations();
      // "needs review" findings count too: an aria-label on a span is reported as incomplete
      expect(results.incomplete.map((item) => item.id)).not.toContain('aria-prohibited-attr');
    });

    it('has no accessibility violations for the LiteLLM badge', async () => {
      const { container } = render(<BackendBadge backendType="litellm" showLiteLLM />);
      expect(await axe(container)).toHaveNoViolations();
    });
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
