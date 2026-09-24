import path from 'node:path';
import { mergeConfig } from 'vite';
import appConfig from './vite.config';

// Dedicated test server: isolated auth stub. API calls are intercepted in Playwright.
export default mergeConfig(appConfig, {
  resolve: {
    alias: [
      { find: /^@clerk\/react$/, replacement: path.resolve(import.meta.dirname, 'test/clerk-mock.tsx') },
      { find: /^@clerk\/react\/internal$/, replacement: path.resolve(import.meta.dirname, 'test/clerk-internal-mock.ts') },
    ],
  },
});