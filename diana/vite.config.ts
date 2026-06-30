import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API_URL = process.env.VITE_API_URL ?? 'http://localhost:3000';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5175,
    host: true,
    // Diana needs REST (/api) and the public product photos (/content/product/:sku),
    // both served by the shared Minerva Fastify backend. No websocket.
    proxy: {
      '/api': { target: API_URL, changeOrigin: true },
      '/content': { target: API_URL, changeOrigin: true },
    },
  },
});
