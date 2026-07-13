export const PORTAL_URL_DEFAULT = 'https://pantheon.prominentdental.com';
const FLAG = 'pantheon-sso-bounce';

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
