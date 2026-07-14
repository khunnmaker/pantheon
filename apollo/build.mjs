import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';

const root = fileURLToPath(new URL('.', import.meta.url));
const pantheonUi = fileURLToPath(new URL('../packages/pantheon-ui/src/index.ts', import.meta.url));

await build({
  configFile: false,
  root,
  plugins: [react()],
  resolve: { alias: { '@pantheon/ui': pantheonUi } },
});
