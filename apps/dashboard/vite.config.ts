import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API_TARGET = process.env.VITE_API_PROXY ?? 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The dashboard runs on its own origin, so API calls are proxied in dev.
    // In production the reverse proxy serves both from one host.
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
      '/v1': { target: API_TARGET, changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: false },
});
