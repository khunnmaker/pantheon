var _a;
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
var API_URL = (_a = process.env.VITE_API_URL) !== null && _a !== void 0 ? _a : 'http://localhost:3000';
// The shared @pantheon/ui package ships raw TypeScript with NO build step. Vite would not
// transpile a bare-import dependency that lives in node_modules, so we alias the package name
// straight at its source entry — Vite then treats it as first-party source and runs it through
// the same esbuild/react pipeline as the app's own src. The workspace symlink in node_modules
// still satisfies tsc's type resolution (via the package's "exports"/"types" → src/index.ts).
var pantheonUi = fileURLToPath(new URL('../packages/pantheon-ui/src/index.ts', import.meta.url));
// https://vite.dev/config/
export default defineConfig({
    plugins: [react()],
    resolve: {
        alias: {
            '@pantheon/ui': pantheonUi,
        },
    },
    server: {
        port: 5177,
        host: true,
        // proxy api to the backend in dev (Ceres only needs REST, no websocket)
        proxy: {
            '/api': { target: API_URL, changeOrigin: true },
            '/content': { target: API_URL, changeOrigin: true },
        },
    },
});
