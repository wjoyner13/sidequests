import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      // Multi-page build: each side quest gets its own static HTML entry.
      input: {
        main: 'index.html',
        digest: 'digest.html',
        riff: 'riff.html',
        riffDemo: 'riff-demo.html',
      },
    },
  },
  server: {
    port: 5174,
    strictPort: true,
    // Reachable from a phone on the same network for real-device testing.
    host: true,
    allowedHosts: true,
    proxy: {
      // Web searches can run well past the default proxy timeout.
      '/api': {
        target: 'http://localhost:8787',
        timeout: 180_000,
        proxyTimeout: 180_000,
      },
    },
  },
});
