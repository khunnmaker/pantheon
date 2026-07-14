import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const API_URL = process.env.VITE_API_URL ?? 'http://localhost:3000';
const pantheonUi = fileURLToPath(new URL('../packages/pantheon-ui/src/index.ts', import.meta.url));

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@pantheon/ui': pantheonUi } },
  server: {
    port: 5177,
    host: true,
    // proxy api to the backend in dev (Jupiter only needs REST, no websocket)
    proxy: {
      '/api': { target: API_URL, changeOrigin: true },
    },
  },
});
