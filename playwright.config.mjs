import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/ui',
  fullyParallel: true,
  use: { baseURL: 'http://127.0.0.1:43179', browserName: 'chromium', headless: true },
  webServer: {
    command: 'node tests/serve.mjs', url: 'http://127.0.0.1:43179', reuseExistingServer: false,
  },
});
