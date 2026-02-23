import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  Form,
  FormGroup,
  NumberInput,
  Select,
  SelectList,
  SelectOption,
  MenuToggle,
  MenuToggleElement,
  Progress,
  ProgressMeasureLocation,
  HelperText,
  HelperTextItem,
  Content,
  ContentVariants,
} from '@patternfly/react-core';
import { Group } from '../../types/groups';

interface GroupBudgetFormData {
  maxBudget?: number;
  budgetDuration?: string;
  tpmLimit?: number;
  rpmLimit?: number;
}

interface GroupBudgetTabProps {
  group: Group | null;
  canEdit: boolean;
  formData: GroupBudgetFormData;
  onChange: (data: Partial<GroupBudgetFormData>) => void;
}

const BUDGET_DURATIONS = [
  { value: 'daily', labelKey: 'groups.budget.daily' },
  { value: 'weekly', labelKey: 'groups.budget.weekly' },
  { value: 'monthly', labelKey: 'groups.budget.monthly' },
  { value: 'yearly', labelKey: 'groups.budget.yearly' },
];

const GroupBudgetTab: React.FC<GroupBudgetTabProps> = ({
  group,
  canEdit,
  formData,
  onChange,
}) => {
  const { t } = useTranslation();
  const [isDurationOpen, setIsDurationOpen] = React.useState(false);

  // Calculate budget utilization
  const budgetUtilization =
    group?.currentSpend !== undefined && group?.maxBudget
      ? Math.min((group.currentSpend / group.maxBudget) * 100, 100)
      : 0;

  const getDurationLabel = (value?: string): string => {
    if (!value) return t('groups.budget.selectDuration', 'Select duration');
    const found = BUDGET_DURATIONS.find((d) => d.value === value);
    return found ? t(found.labelKey, found.value) : value;
  };

  return (
    <Form style={{ paddingTop: '1rem' }}>
      {/* Budget Utilization Progress Bar - only show for existing groups with max budget */}
      {group && group.maxBudget != null && group.maxBudget > 0 && (
        <FormGroup
          label={t('groups.budget.currentSpend', 'Current Spend')}
          fieldId="group-budget-utilization"
        >
          <Progress
            value={budgetUtilization}
            measureLocation={ProgressMeasureLocation.outside}
            aria-label={t('groups.budget.budgetUtilization', 'Budget utilization')}
            variant={
              budgetUtilization > 80
                ? budgetUtilization > 95
                  ? 'danger'
                  : 'warning'
                : undefined
            }
          />
          <HelperText>
            <HelperTextItem>
              ${group.currentSpend?.toFixed(2) || '0.00'} / $
              {group.maxBudget.toFixed(2)}
            </HelperTextItem>
          </HelperText>
        </FormGroup>
      )}

      {/* Max Budget Input */}
      <FormGroup
        label={t('groups.budget.maxBudget', 'Max Budget')}
        fieldId="group-max-budget"
      >
        <NumberInput
          id="group-max-budget"
          value={formData.maxBudget ?? 0}
          min={0}
          onMinus={() =>
            onChange({ maxBudget: Math.max(0, (formData.maxBudget || 0) - 10) })
          }
          onPlus={() =>
            onChange({ maxBudget: (formData.maxBudget || 0) + 10 })
          }
          onChange={(event) => {
            const target = event.target as HTMLInputElement;
            const value = parseFloat(target.value);
            onChange({ maxBudget: isNaN(value) ? undefined : value });
          }}
          isDisabled={!canEdit}
          aria-label={t('groups.budget.maxBudget', 'Max Budget')}
          widthChars={10}
        />
        <HelperText>
          <HelperTextItem>
            {t(
              'groups.budget.maxBudgetHelp',
              'Maximum spending limit in USD. Set to 0 for unlimited.',
            )}
          </HelperTextItem>
        </HelperText>
      </FormGroup>

      {/* Budget Duration Select */}
      <FormGroup
        label={t('groups.budget.duration', 'Budget Duration')}
        fieldId="group-budget-duration"
      >
        <Select
          role="listbox"
          id="group-budget-duration"
          isOpen={isDurationOpen}
          onOpenChange={setIsDurationOpen}
          aria-label={t('groups.budget.durationAriaLabel', 'Select budget duration')}
          toggle={(toggleRef: React.Ref<MenuToggleElement>) => (
            <MenuToggle
              ref={toggleRef}
              onClick={() => setIsDurationOpen(!isDurationOpen)}
              isExpanded={isDurationOpen}
              isDisabled={!canEdit}
            >
              {getDurationLabel(formData.budgetDuration)}
            </MenuToggle>
          )}
          onSelect={(_event, selection) => {
            onChange({ budgetDuration: selection as string });
            setIsDurationOpen(false);
          }}
          selected={formData.budgetDuration}
        >
          <SelectList>
            {BUDGET_DURATIONS.map((duration) => (
              <SelectOption key={duration.value} value={duration.value}>
                {t(duration.labelKey, duration.value)}
              </SelectOption>
            ))}
          </SelectList>
        </Select>
        <HelperText>
          <HelperTextItem>
            {t(
              'groups.budget.durationHelp',
              'Time period for budget reset cycle.',
            )}
          </HelperTextItem>
        </HelperText>
      </FormGroup>

      {/* TPM Limit */}
      <FormGroup
        label={t('groups.budget.tpmLimit', 'TPM Limit')}
        fieldId="group-tpm-limit"
      >
        <NumberInput
          id="group-tpm-limit"
          value={formData.tpmLimit ?? 0}
          min={0}
          onMinus={() =>
            onChange({ tpmLimit: Math.max(0, (formData.tpmLimit || 0) - 1000) })
          }
          onPlus={() =>
            onChange({ tpmLimit: (formData.tpmLimit || 0) + 1000 })
          }
          onChange={(event) => {
            const target = event.target as HTMLInputElement;
            const value = parseInt(target.value, 10);
            onChange({ tpmLimit: isNaN(value) ? undefined : value });
          }}
          isDisabled={!canEdit}
          aria-label={t('groups.budget.tpmLimit', 'TPM Limit')}
          widthChars={12}
        />
        <HelperText>
          <HelperTextItem>
            {t('groups.budget.tpmLimitHelp', 'Tokens per minute. Set to 0 for unlimited.')}
          </HelperTextItem>
        </HelperText>
      </FormGroup>

      {/* RPM Limit */}
      <FormGroup
        label={t('groups.budget.rpmLimit', 'RPM Limit')}
        fieldId="group-rpm-limit"
      >
        <NumberInput
          id="group-rpm-limit"
          value={formData.rpmLimit ?? 0}
          min={0}
          onMinus={() =>
            onChange({ rpmLimit: Math.max(0, (formData.rpmLimit || 0) - 10) })
          }
          onPlus={() =>
            onChange({ rpmLimit: (formData.rpmLimit || 0) + 10 })
          }
          onChange={(event) => {
            const target = event.target as HTMLInputElement;
            const value = parseInt(target.value, 10);
            onChange({ rpmLimit: isNaN(value) ? undefined : value });
          }}
          isDisabled={!canEdit}
          aria-label={t('groups.budget.rpmLimit', 'RPM Limit')}
          widthChars={10}
        />
        <HelperText>
          <HelperTextItem>
            {t('groups.budget.rpmLimitHelp', 'Requests per minute. Set to 0 for unlimited.')}
          </HelperTextItem>
        </HelperText>
      </FormGroup>

      {!canEdit && (
        <Content
          component={ContentVariants.small}
          style={{ marginTop: '1rem', fontStyle: 'italic' }}
        >
          {t('groups.readOnlyNote', 'You have read-only access to these settings.')}
        </Content>
      )}
    </Form>
  );
};

export default GroupBudgetTab;
