import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, waitFor, within } from 'storybook/test';

import { AppI18nProvider } from './i18n';
import { TerminalPasteWarningDialog } from './TerminalPasteWarningDialog';

const meta = {
  title: 'Compositions/Terminal paste warning',
  component: TerminalPasteWarningDialog,
  parameters: {
    a11y: { test: 'error' },
    layout: 'fullscreen',
  },
  decorators: [
    (Story, context) => {
      const locale = context.globals.locale === 'ko' ? 'ko' : 'en';
      return (
        <AppI18nProvider locale={locale} languages={[locale]}>
          <Story />
        </AppI18nProvider>
      );
    },
  ],
} satisfies Meta<typeof TerminalPasteWarningDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const MultilineAndLarge: Story = {
  args: {
    risk: {
      multiline: true,
      large: true,
      lineCount: 18,
      byteLength: 8427,
      shouldWarn: true,
    },
    onCancel: () => undefined,
    onConfirm: () => undefined,
  },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    await waitFor(() => expect(page.getByTestId('terminal-paste-warning-cancel')).toHaveFocus());
  },
};

export const Korean: Story = {
  ...MultilineAndLarge,
  globals: { locale: 'ko' },
};
