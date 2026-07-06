import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev port 4611 (server is 4610). In dev, proxy /api to the local Express server. In prod the
// server serves the built assets from client/dist, so relative /api calls are same-origin.
export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    port: 4611,
    host: true,
    proxy: {
      '/api': { target: 'http://localhost:4610', changeOrigin: true },
    },
  },
});
