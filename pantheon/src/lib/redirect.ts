import { APPS, type AppDef } from './apps';

export const REDIRECT_TARGETS: AppDef[] = APPS;

export interface RedirectTarget {
  app: AppDef;
  url: URL;
}

export function resolveRedirect(search: string): RedirectTarget | null {
  const raw = new URLSearchParams(search).get('redirect');
  if (!raw) return null;

  let url: URL;
  try { url = new URL(raw); } catch { return null; }

  const isLocalHttp = url.protocol === 'http:'
    && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  if (url.protocol !== 'https:' && !isLocalHttp) return null;

  const app = REDIRECT_TARGETS.find((candidate) => {
    if (!candidate.url) return false;
    try { return new URL(candidate.url).origin === url.origin; } catch { return false; }
  });
  return app ? { app, url } : null;
}
