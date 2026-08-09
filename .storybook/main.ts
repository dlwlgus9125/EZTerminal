import type { StorybookConfig } from '@storybook/react-vite';

const config: StorybookConfig = {
  stories: ['../src/renderer/**/*.stories.@(ts|tsx)'],
  addons: ['@storybook/addon-a11y', '@storybook/addon-vitest'],
  framework: {
    name: '@storybook/react-vite',
    options: {
      strictMode: true,
    },
  },
  typescript: {
    reactDocgen: 'react-docgen',
  },
  async viteFinal(config) {
    config.optimizeDeps = {
      ...config.optimizeDeps,
      include: [
        ...(config.optimizeDeps?.include ?? []),
        '@capacitor/app',
        '@capacitor/browser',
        '@capacitor/clipboard',
        '@capacitor/core',
        '@capacitor/device',
      ],
    };

    return config;
  },
};

export default config;
