import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '../../test-utils';
import { UserBudgetSummary } from '../../../components/usage/UserBudgetSummary';
import { usageService } from '../../../services/usage.service';

vi.mock('../../../services/usage.service', () => ({
  usageService: { getBudgetInfo: vi.fn() },
}));

describe('UserBudgetSummary MaaS spend', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the estimated MaaS spend separately when the backend reports it', async () => {
    vi.mocked(usageService.getBudgetInfo).mockResolvedValue({
      maxBudget: 100,
      currentSpend: 10,
      maasSpend: 2.5,
      maasTokens: 12345,
    });
    render(<UserBudgetSummary userId="u1" />);
    const line = await screen.findByTestId('maas-estimated-spend');
    expect(line.textContent).toContain('$2.50');
    expect(line.textContent).toContain('12,345');
  });

  it('shows no MaaS line without MaaS usage', async () => {
    vi.mocked(usageService.getBudgetInfo).mockResolvedValue({ maxBudget: 100, currentSpend: 10 });
    render(<UserBudgetSummary userId="u1" />);
    await screen.findByText(/\$10\.00/);
    expect(screen.queryByTestId('maas-estimated-spend')).not.toBeInTheDocument();
  });
});
