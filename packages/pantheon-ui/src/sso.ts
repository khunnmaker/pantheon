export const PORTAL_URL_DEFAULT = 'https://pantheon.prominentdental.com';
const FLAG = 'pantheon-sso-bounce';

export interface SuiteSession<TAgent> {
  token: string;
  agent: TAgent;
}

let renewalPromise: Promise<SuiteSession<unknown> | null> | null = null;

// Cookie-only renewal shared by every app on an origin. Concurrent 401s join the same Promise;
// a failed renewal resolves null so the caller can preserve its existing logged-out UI.
export async function renewSuiteSessionOnce<TAgent>(apiUrl: string): Promise<SuiteSession<TAgent> | null> {
  if (!renewalPromise) {
    renewalPromise = fetch(`${apiUrl.replace(/\/$/, '')}/api/auth/me`, { credentials: 'include' })
      .then(async (res) => res.ok ? await res.json() as SuiteSession<unknown> : null)
      .catch(() => null)
      .finally(() => { renewalPromise = null; });
  }
  return renewalPromise as Promise<SuiteSession<TAgent> | null>;
}

export interface SessionRenewalOptions<TAgent> {
  apiUrl: string;
  getToken: () => string | null;
  setSession: (token: string, agent: TAgent) => void;
}

// Attach the current bearer, renew silently on the first 401, then retry the identical request
// once. A second 401 is returned to the app; this helper never loops or clears local state.
export async function fetchWithSessionRenewal<TAgent>(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  options: SessionRenewalOptions<TAgent>,
): Promise<Response> {
  const request = (token: string | null) => {
    const headers = new Headers(init?.headers);
    if (token) headers.set('authorization', `Bearer ${token}`);
    else headers.delete('authorization');
    return fetch(input, { ...init, headers });
  };

  let response = await request(options.getToken());
  if (response.status !== 401) return response;

  const renewed = await renewSuiteSessionOnce<TAgent>(options.apiUrl);
  if (!renewed) return response;
  options.setSession(renewed.token, renewed.agent);
  response = await request(renewed.token);
  return response;
}

export function wantsLocalLogin(): boolean {
  return new URLSearchParams(location.search).get('local') === '1';
}

export function isPantheonSite(): boolean {
  return location.hostname === 'prominentdental.com'
    || location.hostname.endsWith('.prominentdental.com');
}

export function clearSsoBounce(): void {
  try { sessionStorage.removeItem(FLAG); } catch { /* storage may be unavailable */ }
}

export function redirectToPortalLogin(portalUrl: string): boolean {
  if (wantsLocalLogin()) return false;
  if (!isPantheonSite()) return false;

  try {
    if (sessionStorage.getItem(FLAG)) {
      clearSsoBounce();
      return false;
    }
    sessionStorage.setItem(FLAG, '1');
  } catch {
    return false;
  }

  location.replace(portalUrl + '/?redirect=' + encodeURIComponent(location.href));
  return true;
}
