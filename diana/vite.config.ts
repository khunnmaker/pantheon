import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// Importing this type also loads vite-react-ssg's `declare module 'vite'` augmentation, which
// adds `ssgOptions` to Vite's UserConfig.
import type { ViteReactSSGOptions } from 'vite-react-ssg';

const API_URL = process.env.VITE_API_URL ?? 'http://localhost:3000';

// The ONLY routes prerendered to static HTML — the no-JS-crawlable marketing pages. The
// catalog/product/orders/admin routes stay client-only: they hit the API/localStorage, and
// Phase A keeps zero build↔API coupling, so they must never be prerendered.
const PRERENDER = ['/', '/about', '/products', '/brands', '/lab', '/manufacturing', '/contact'];

// The crawler yields child paths without a leading slash (e.g. "about"); normalise before
// matching the allowlist so both "/about" and "about" resolve.
const norm = (p: string) => (p === '/' ? '/' : `/${p.replace(/^\/+/, '').replace(/\/+$/, '')}`);

const ssgOptions: ViteReactSSGOptions = {
  dirStyle: 'nested', // /lab -> dist/lab/index.html, served verbatim by `serve -s dist`
  // Explicit allowlist (also drops the dynamic /product/:sku, which is excluded by default).
  // index.html carries only site-wide invariants (no title/description), so per-page <Seo> tags
  // never collide — no head post-processing needed.
  includedRoutes: (paths) => paths.filter((p) => PRERENDER.includes(norm(p))),
};

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  ssgOptions,
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
