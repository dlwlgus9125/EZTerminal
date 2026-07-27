import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, waitFor, within } from 'storybook/test';

import { AppI18nProvider } from './i18n';
import { TerminalPasteWarningDialog } from './TerminalPasteWarningDialog';
// The dialog's own styling lives in the desktop foundation sheet, which the
// Storybook preview does not load. Without this the baseline shows the browser
// default list and never matches what ships.
import './index.css';

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
    // The panel fades in, so it is briefly transparent on mount.
    await waitFor(() => expect(dialog).toBeVisible());
    await waitFor(() => expect(page.getByTestId('terminal-paste-warning-cancel')).toHaveFocus());
  },
};

export const Korean: Story = {
  ...MultilineAndLarge,
  globals: { locale: 'ko' },
};
