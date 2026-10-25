import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
  optimizeDeps: {
    include: [
      'react',
      'react-dom',
      'react/jsx-runtime',
      'react/jsx-dev-runtime',
      'lucide-react',
      'i18next',
      'react-i18next',
      'zod',
      'qrcode-generator',
      'react-markdown',
      'remark-gfm',
      'dockview-react',
      '@xterm/addon-fit',
      '@xterm/addon-search',
      '@xterm/addon-unicode11',
      '@xterm/addon-web-links',
      '@xterm/addon-webgl',
      '@xterm/xterm',
      '@tanstack/react-table',
      '@tanstack/react-virtual',
      'ansi_up',
      'capacitor-secure-storage-plugin',
      '@xyflow/react',
    ],
  },
  test: {
    fileParallelism: false,
    maxWorkers: 1,
    projects: [
      {
        extends: true,
        plugins: [storybookTest({ configDir: path.join(dirname, '.storybook'), tags: { exclude: ['interaction-budget'] } })],
        test: {
          name: 'storybook',
          sequence: { groupOrder: 0 },
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            api: { host: '127.0.0.1' },
            instances: [{ browser: 'chromium' }],
          },
        },
      },
      {
        // The interaction budget is timed in a fresh browser once the other stories have finished.
        extends: true,
        plugins: [storybookTest({ configDir: path.join(dirname, '.storybook'), tags: { include: ['interaction-budget'] } })],
        test: {
          name: 'storybook-interaction-budget',
          sequence: { groupOrder: 1 },
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            api: { host: '127.0.0.1' },
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
});
