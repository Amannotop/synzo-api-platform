import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API_TARGET = process.env.VITE_API_PROXY ?? 'http://127.0.0.1:3000';

/**
 * Vite rejects requests whose Host header it does not recognise, which is
 * exactly what a public tunnel hostname looks like. Hosts can be listed
 * explicitly via VITE_ALLOWED_HOSTS; an empty list accepts any host.
 */
const allowedHosts = (process.env.VITE_ALLOWED_HOSTS ?? '')
  .split(',')
  .map((host) => host.trim())
  .filter(Boolean);

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    allowedHosts: allowedHosts.length > 0 ? allowedHosts : true,
    /**
     * Vite's dev server answers CORS on its own and will overwrite the headers
     * the API sent. Reflecting the request origin here keeps the API's decision
     * intact, so a browser on a foreign origin can call the public tunnel URL.
     */
    cors: { origin: true, credentials: true },
    // The dashboard runs on its own origin, so API calls are proxied in dev.
    // In production the reverse proxy serves both from one host.
    proxy: {
      /**
       * The API owns CORS. When a browser on another origin calls through this
       * proxy, the `Origin` header must reach the API so it can decide what to
       * allow, and the API's own `Access-Control-Allow-*` response headers must
       * survive the hop. Without this, a public tunnel URL silently loses CORS
       * and every cross-origin request fails in the browser while curl works.
       */
      '/api': { target: API_TARGET, changeOrigin: true },
      '/v1': { target: API_TARGET, changeOrigin: true },
      // Unprefixed API paths need explicit entries, otherwise the SPA fallback
      // answers them with index.html and a health check reports the dashboard.
      '/health': { target: API_TARGET, changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: false },
});
