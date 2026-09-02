import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5177,
    strictPort: true,
    // Keep both API namespaces on the same backend in development. Without
    // this, Vite serves index.html for /v1/* (HTTP 200), which prevents the
    // client from recognizing the intended research fallback at /api/*.
    proxy: {
      '/api': process.env.VERIDICAL_DEV_API_URL ?? 'http://127.0.0.1:8787',
      '/v1': process.env.VERIDICAL_DEV_API_URL ?? 'http://127.0.0.1:8787',
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.ts'],
  },
} as any);
