import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API_URL = process.env.VITE_API_URL ?? 'http://localhost:3000';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    // proxy api + websocket to the backend so the console never calls the LLM directly
    proxy: {
      '/api': { target: API_URL, changeOrigin: true },
      '/console': { target: API_URL, ws: true, changeOrigin: true },
    },
  },
});
