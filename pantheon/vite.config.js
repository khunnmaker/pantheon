var _a;
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
var API_URL = (_a = process.env.VITE_API_URL) !== null && _a !== void 0 ? _a : 'http://localhost:3000';
var pantheonUi = fileURLToPath(new URL('../packages/pantheon-ui/src/index.ts', import.meta.url));
export default defineConfig({
    plugins: [react()],
    resolve: { alias: { '@pantheon/ui': pantheonUi } },
    server: {
        port: 5179,
        host: true,
        proxy: { '/api': { target: API_URL, changeOrigin: true } },
    },
});
