/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

// Served from https://jupixels.github.io/frontline/ in production.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/frontline/' : '/',
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  test: { include: ['tests/**/*.test.ts'] },
}));
