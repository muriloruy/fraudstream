import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const gateway = process.env.GATEWAY_URL ?? 'http://localhost:3006';

/**
 * Dev server proxies the gateway on the same origin, as the production container does
 * (cookies stay same-site, no CORS). The SSE route must not be buffered.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/auth': { target: gateway, changeOrigin: true },
      '/admin': { target: gateway, changeOrigin: true },
      '/v1/stream': {
        target: gateway,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyRes', (res) => {
            res.headers['cache-control'] = 'no-cache, no-transform';
          });
        },
      },
      '/v1': { target: gateway, changeOrigin: true },
    },
  },
  build: {
    sourcemap: true,
    target: 'es2022',
  },
  test: {
    name: 'web',
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
    css: false,
  },
});
