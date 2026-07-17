import { useCallback, useEffect, useState } from 'react';

// Olympus has exactly two top-level pages — `/` (home) and `/hestia` — so a full router
// dependency would be overkill (plan §1). This is a minimal History API switch: it reads
// location.pathname, pushes on navigate, and listens for popstate (browser back/forward).
// Hestia's own tabs (วันนี้/เป้าหมาย/ประวัติ/บันทึก) are handled separately as hash state via
// @pantheon/ui's useHashTab, layered on top of the '/hestia' route.
export type Route = 'home' | 'hestia';

function routeFromPath(pathname: string): Route {
  return pathname === '/hestia' ? 'hestia' : 'home';
}

export function useRoute(): [Route, (route: Route) => void] {
  const [route, setRoute] = useState<Route>(() => routeFromPath(location.pathname));

  useEffect(() => {
    const onPop = () => setRoute(routeFromPath(location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = useCallback((next: Route) => {
    const path = next === 'hestia' ? '/hestia' : '/';
    if (path !== location.pathname) history.pushState({}, '', path);
    setRoute(next);
  }, []);

  return [route, navigate];
}
