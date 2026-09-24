import { defineConfig } from '@playwright/test';

const port = 4179;
export default defineConfig({
  testDir: './test',
  testMatch: '*.browser.spec.ts',
  use: { baseURL: `http://127.0.0.1:${port}`, browserName: 'chromium' },
  webServer: {
    command: `PORT=${port} BASE_PATH=/ VITE_CLERK_PUBLISHABLE_KEY=pk_test_browser_only pnpm --filter @workspace/contractor-visual-quote-demo exec vite --config vite.browser.config.ts --host 127.0.0.1`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});