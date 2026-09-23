/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset URLs: the bundle works from any path on the node's web server.
  base: './',
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  test: {
    include: ['src/**/*.test.ts', 'mock/**/*.test.ts'],
    environment: 'node',
  },
});
