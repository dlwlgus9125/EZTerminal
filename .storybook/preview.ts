import type { Preview } from '@storybook/react-vite';

import '../src/renderer/ui/styles.css';
import './preview.css';

const preview: Preview = {
  parameters: {
    a11y: {
      test: 'error',
      options: {
        runOnly: {
          type: 'tag',
          values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'],
        },
      },
    },
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    layout: 'centered',
    options: {
      storySort: {
        order: ['Foundations', 'Primitives', 'Compositions'],
      },
    },
  },
  globalTypes: {
    theme: {
      description: 'Semantic colour theme',
      toolbar: {
        icon: 'paintbrush',
        items: [
          { value: 'matrix', title: 'Matrix' },
          { value: 'dark', title: 'Dark' },
          { value: 'light', title: 'Light' },
          { value: 'high-contrast', title: 'High contrast' },
        ],
      },
    },
    locale: {
      description: 'Preview language',
      toolbar: {
        icon: 'globe',
        items: [
          { value: 'en', title: 'English' },
          { value: 'ko', title: '한국어' },
        ],
      },
    },
    density: {
      description: 'Interface density',
      toolbar: {
        icon: 'component',
        items: [
          { value: 'adaptive', title: 'Adaptive' },
          { value: 'compact', title: 'Compact' },
          { value: 'comfortable', title: 'Comfortable' },
        ],
      },
    },
  },
  initialGlobals: {
    theme: 'matrix',
    locale: 'en',
    density: 'adaptive',
  },
  decorators: [
    (Story, context) => {
      const theme = typeof context.globals.theme === 'string' ? context.globals.theme : 'matrix';
      const locale = context.globals.locale === 'ko' ? 'ko' : 'en';
      const density = context.globals.density === 'compact' || context.globals.density === 'comfortable'
        ? context.globals.density
        : 'adaptive';
      document.documentElement.dataset.theme = theme;
      document.documentElement.dataset.density = density;
      document.documentElement.lang = locale;
      return Story();
    },
  ],
};

export default preview;
