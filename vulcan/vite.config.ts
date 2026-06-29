import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API_URL = process.env.VITE_API_URL ?? 'http://localhost:3000';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    host: true,
    // proxy api to the backend in dev (Vulcan only needs REST, no websocket)
    proxy: {
      '/api': { target: API_URL, changeOrigin: true },
    },
  },
});
