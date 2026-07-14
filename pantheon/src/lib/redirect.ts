import { APPS, type AppDef } from './apps';

// Venus is confidential and deliberately has no portal tile, but its login still uses the
// portal, so it belongs in the redirect allowlist.
export const REDIRECT_TARGETS: AppDef[] = [
  ...APPS,
  {
    key: 'venus',
    name: 'Venus',
    job: 'ลูกค้าสัมพันธ์ / CRM',
    url: import.meta.env.VITE_VENUS_URL || 'https://venus.prominentdental.com',
    accent: 'text-rose-600',
    badge: () => null,
  },
];

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
