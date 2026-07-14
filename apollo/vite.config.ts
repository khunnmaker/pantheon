import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const API_URL = process.env.VITE_API_URL ?? 'http://localhost:3000';
const pantheonUi = fileURLToPath(new URL('../packages/pantheon-ui/src/index.ts', import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@pantheon/ui': pantheonUi } },
  server: { port: 5180, host: true, proxy: { '/api': { target: API_URL, changeOrigin: true } } },
});
