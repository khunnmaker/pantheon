var _a;
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
var API_URL = (_a = process.env.VITE_API_URL) !== null && _a !== void 0 ? _a : 'http://localhost:3000';
// https://vite.dev/config/
export default defineConfig({
    plugins: [react()],
    server: {
        port: 5177,
        host: true,
        // proxy api to the backend in dev (Jupiter only needs REST, no websocket)
        proxy: {
            '/api': { target: API_URL, changeOrigin: true },
        },
    },
});
