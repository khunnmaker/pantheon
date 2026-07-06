// One-click launcher. Starts the Express server (which serves the built client + API), then
// opens the default browser to the localhost URL. Windows-first (uses `start`), with mac/linux
// fallbacks so it also works if the owner ever runs it elsewhere.
import './env.js';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { PORT } from './env.js';

const here = dirname(fileURLToPath(import.meta.url));
const url = `http://localhost:${PORT}`;

function openBrowser(target: string): void {
  const platform = process.platform;
  try {
    if (platform === 'win32') {
      // `start` is a cmd builtin; the empty "" is the window title arg it expects.
      spawn('cmd', ['/c', 'start', '', target], { stdio: 'ignore', detached: true }).unref();
    } else if (platform === 'darwin') {
      spawn('open', [target], { stdio: 'ignore', detached: true }).unref();
    } else {
      spawn('xdg-open', [target], { stdio: 'ignore', detached: true }).unref();
    }
  } catch {
    console.log(`[mercury-local] open your browser to ${target}`);
  }
}

// Start the server in-process by importing it (it calls app.listen on load). Then, once the
// port is accepting connections, open the browser.
import('./index.js')
  .then(() => waitForServer(url))
  .then(() => openBrowser(url))
  .catch((e) => {
    console.error('[mercury-local] failed to start:', e);
    console.log(`[mercury-local] server file: ${resolve(here, 'index.js')}`);
    process.exit(1);
  });

async function waitForServer(base: string, tries = 40): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  // Fall through — open the browser anyway; the page will retry.
}
