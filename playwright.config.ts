import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  use: {
    baseURL: 'http://localhost:1420', browserName: 'chromium',
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {},
  },
  reporter: [['list'], ['html', { open: 'never' }]],
  webServer: { command: 'npm run dev -w @dropmeme/desktop', url: 'http://localhost:1420', reuseExistingServer: !process.env.CI, timeout: 30_000 },
});
