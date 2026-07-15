import type { Preview } from '@storybook/react-vite';
import { createElement, useEffect, type ReactNode } from 'react';

import { applyUiScale } from '../src/renderer/ui-scale';
import '../src/renderer/ui/styles.css';
import './preview.css';

export function StoryReadyBoundary({
  children,
  readyKey,
}: {
  readonly children: ReactNode;
  readonly readyKey: string;
}): JSX.Element {
  useEffect(() => {
    let firstFrame = 0;
    let secondFrame = 0;
    let cancelled = false;

    void document.fonts.ready.then(() => {
      if (cancelled) return;
      firstFrame = requestAnimationFrame(() => {
        secondFrame = requestAnimationFrame(() => {
          if (!cancelled) document.documentElement.dataset.storyReady = readyKey;
        });
      });
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
      if (document.documentElement.dataset.storyReady === readyKey) {
        delete document.documentElement.dataset.storyReady;
      }
    };
  });

  return createElement('div', { style: { display: 'contents' } }, children);
}

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
    uiScale: {
      description: 'Product UI scale',
      toolbar: {
        icon: 'zoom',
        items: [
          { value: 100, title: '100%' },
          { value: 150, title: '150%' },
        ],
      },
    },
  },
  initialGlobals: {
    theme: 'matrix',
    locale: 'en',
    density: 'adaptive',
    uiScale: 100,
  },
  decorators: [
    (Story, context) => {
      const theme = typeof context.globals.theme === 'string' ? context.globals.theme : 'matrix';
      const locale = context.globals.locale === 'ko' ? 'ko' : 'en';
      const density = context.globals.density === 'compact' || context.globals.density === 'comfortable'
        ? context.globals.density
        : 'adaptive';
      const uiScale = Number(context.globals.uiScale) === 150 ? 150 : 100;
      const readyKey = `${context.id}|${theme}|${locale}|${density}|${uiScale}`;
      delete document.documentElement.dataset.storyReady;
      document.documentElement.dataset.theme = theme;
      document.documentElement.dataset.density = density;
      document.documentElement.lang = locale;
      applyUiScale(uiScale);
      return createElement(
        StoryReadyBoundary,
        { readyKey },
        createElement(Story),
      );
    },
  ],
};

export default preview;
