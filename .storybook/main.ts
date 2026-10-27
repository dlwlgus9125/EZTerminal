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
    const existingIgnored = config.server?.watch?.ignored;
    config.server = {
      ...config.server,
      watch: {
        ...config.server?.watch,
        ignored: [
          ...(Array.isArray(existingIgnored) ? existingIgnored : existingIgnored ? [existingIgnored] : []),
          // Generated directories already excluded by .gitignore. A trace HTML
          // or mobile build must not trigger a full reload of the story under test.
          '**/artifacts/**',
          '**/test-results/**',
          '**/playwright-report/**',
          '**/blob-report/**',
          '**/storybook-static/**',
          '**/dist/**',
          '**/.vite/**',
          '**/out/**',
          '**/out-*/**',
          '**/.native-build/**',
          '**/native/**/target/**',
          '**/release-assets/**',
          // Agent worktrees checked out inside the repo: their installs and builds are not this tree.
          '**/.claude/worktrees/**',
        ],
      },
    };
    config.optimizeDeps = {
      ...config.optimizeDeps,
      include: [
        ...(config.optimizeDeps?.include ?? []),
        '@capacitor/app',
        '@capacitor/browser',
        '@capacitor/clipboard',
        '@capacitor/core',
        '@capacitor/device',
        'capacitor-secure-storage-plugin',
      ],
    };

    return config;
  },
};

export default config;
