import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const API_URL = process.env.VITE_API_URL ?? 'http://localhost:3000';

// The shared @pantheon/ui package ships raw TypeScript with NO build step — alias it straight at
// its source entry so Vite treats it as first-party source (see juno/vite.config.ts for the full
// rationale; identical setup here).
const pantheonUi = fileURLToPath(new URL('../packages/pantheon-ui/src/index.ts', import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@pantheon/ui': pantheonUi } },
  server: { port: 5181, host: true, proxy: { '/api': { target: API_URL, changeOrigin: true } } },
});
