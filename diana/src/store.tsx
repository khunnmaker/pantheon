import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  getMe, getFacets, getClinicToken, getStoredClinic, setClinicSession, clearClinicSession,
  type Clinic, type PricedProduct, type Facets,
} from './lib/api';

// App-wide store: current route (derived from the History-API location), clinic session, cart,
// facets, and modal UI flags. One provider at the top; the header, marketing pages, and shop
// all read from it. Routing itself is react-router — this store just re-exposes the location
// as { path, query } and wraps navigate() so existing call sites keep working unchanged.

export type CartItem = { p: PricedProduct; qty: number };

export interface RouteState {
  path: string; // e.g. "/", "/about", "/catalog"
  query: URLSearchParams;
}

export type Lang = 'th' | 'en';

interface Store {
  route: RouteState;
  navigate: (to: string) => void;
  lang: Lang;
  toggleLang: () => void;
  pick: <T>(th: T, en: T) => T;
  clinic: Clinic | null;
  approved: boolean;
  login: (c: Clinic, token: string) => void;
  logout: () => void;
  sessionExpired: () => void;
  cart: Record<string, CartItem>;
  cartCount: number;
  addToCart: (p: PricedProduct) => void;
  setQty: (sku: string, n: number) => void;
  clearCart: () => void;
  facets: Facets | null;
  authOpen: boolean;
  setAuthOpen: (b: boolean) => void;
  cartOpen: boolean;
  setCartOpen: (b: boolean) => void;
}

const Ctx = createContext<Store | null>(null);
export const useStore = (): Store => {
  const s = useContext(Ctx);
  if (!s) throw new Error('useStore outside provider');
  return s;
};

export function StoreProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const rrNavigate = useNavigate();
  // Re-expose the router location as the { path, query } shape the pages already consume.
  const route = useMemo<RouteState>(
    () => ({ path: location.pathname, query: new URLSearchParams(location.search) }),
    [location.pathname, location.search],
  );
  const navigate = useCallback((to: string) => { rrNavigate(to); }, [rrNavigate]);

  // lang + clinic start at their SSR-safe defaults and are hydrated from localStorage in an
  // effect below — the prerendered marketing HTML must match the client's first render (lang
  // "th", logged-out) or hydration mismatches. The cart is read synchronously (guarded) since
  // its only UI, the header badge, is gated behind `approved` and never shows on first paint.
  const [lang, setLang] = useState<Lang>('th');
  const [clinic, setClinic] = useState<Clinic | null>(null);
  const [cart, setCart] = useState<Record<string, CartItem>>(() => {
    if (typeof window === 'undefined') return {};
    try { return JSON.parse(localStorage.getItem('diana_cart') || '{}') as Record<string, CartItem>; } catch { return {}; }
  });
  const [facets, setFacets] = useState<Facets | null>(null);
  const [authOpen, setAuthOpen] = useState(false);
  const [cartOpen, setCartOpen] = useState(false);

  // Scroll to the top on every real navigation (matches the old hash-router behaviour).
  useEffect(() => { window.scrollTo(0, 0); }, [route.path]);

  // Language toggle (persisted). pick(th, en) returns the value for the current language.
  const toggleLang = useCallback(() => {
    setLang((l) => { const n: Lang = l === 'th' ? 'en' : 'th'; localStorage.setItem('diana_lang', n); document.documentElement.lang = n; return n; });
  }, []);
  function pick<T>(th: T, en: T): T { return lang === 'th' ? th : en; }

  // Keep approval status fresh so a clinic approved mid-session sees prices without a manual
  // reload. Only drops the session on a real auth failure, NOT a transient network/5xx blip.
  const lastRefreshRef = useRef(0);
  const refreshMe = useCallback(() => {
    const token = getClinicToken();
    if (!token) return;
    lastRefreshRef.current = Date.now();
    getMe()
      .then(({ clinic: c }) => {
        if (getClinicToken() !== token) return; // logged out/in during the request — ignore
        setClinic(c);
        setClinicSession(token, c);
      })
      .catch((e) => {
        if ((e as Error).message === 'unauthorized' && getClinicToken() === token) {
          clearClinicSession();
          setClinic(null);
        }
      });
  }, []);

  // Client-only hydration: pick up the persisted language + cached clinic identity, then refresh
  // /me. Deferred to an effect so it never runs during prerender and never fights hydration.
  useEffect(() => {
    if (localStorage.getItem('diana_lang') === 'en') setLang('en');
    if (getClinicToken()) setClinic(getStoredClinic());
    refreshMe();
    const maybeRefresh = () => {
      if (!getClinicToken()) return;
      if (Date.now() - lastRefreshRef.current < 15_000) return;
      refreshMe();
    };
    const onVisible = () => { if (document.visibilityState === 'visible') maybeRefresh(); };
    window.addEventListener('focus', maybeRefresh);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', maybeRefresh);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refreshMe]);

  // Facets (brands/categories) once.
  useEffect(() => { getFacets().then(setFacets).catch(() => undefined); }, []);

  // Persist the cart across refreshes; keep <html lang> in sync with the active language.
  useEffect(() => { localStorage.setItem('diana_cart', JSON.stringify(cart)); }, [cart]);
  useEffect(() => { document.documentElement.lang = lang; }, [lang]);

  const login = useCallback((c: Clinic, token: string) => {
    // Clear a cart left by a DIFFERENT clinic (e.g. a shared front-desk PC) so items and
    // contract prices never leak across accounts; keep it when the same clinic signs back in.
    const prev = getStoredClinic();
    if (prev && prev.id !== c.id) { setCart({}); localStorage.removeItem('diana_cart'); }
    setClinicSession(token, c); setClinic(c); setAuthOpen(false);
  }, []);
  const logout = useCallback(() => { clearClinicSession(); setClinic(null); setCart({}); }, []);
  // Token died server-side (expired/invalid) mid-action: drop the session and prompt re-login,
  // but KEEP the cart — the same clinic signs back in (login() only clears on identity change).
  const sessionExpired = useCallback(() => { clearClinicSession(); setClinic(null); setAuthOpen(true); }, []);

  const addToCart = useCallback((p: PricedProduct) => {
    setCart((c) => ({ ...c, [p.sku]: { p, qty: (c[p.sku]?.qty ?? 0) + 1 } }));
  }, []);
  const setQty = useCallback((sku: string, qty: number) => {
    setCart((c) => {
      if (qty <= 0) { const { [sku]: _drop, ...rest } = c; return rest; }
      const it = c[sku];
      return it ? { ...c, [sku]: { ...it, qty } } : c;
    });
  }, []);
  const clearCart = useCallback(() => setCart({}), []);

  const cartCount = useMemo(() => Object.values(cart).reduce((n, it) => n + it.qty, 0), [cart]);
  const approved = clinic?.status === 'approved';

  const value: Store = {
    route, navigate, lang, toggleLang, pick, clinic, approved, login, logout, sessionExpired,
    cart, cartCount, addToCart, setQty, clearCart, facets,
    authOpen, setAuthOpen, cartOpen, setCartOpen,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

// Scroll-reveal: one IntersectionObserver per route fades `.reveal` / `.stagger` elements in
// as they enter the viewport, then unobserves them. Re-scans on route change (client nav), so
// animations fire on every route. Respects prefers-reduced-motion — elements show immediately.
export function useReveal(): void {
  const { route } = useStore();
  useEffect(() => {
    const els = Array.from(document.querySelectorAll<HTMLElement>('.reveal, .stagger'));
    if (!els.length) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      els.forEach((el) => el.classList.add('is-visible'));
      return;
    }
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) { e.target.classList.add('is-visible'); io.unobserve(e.target); }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [route.path]);
}
