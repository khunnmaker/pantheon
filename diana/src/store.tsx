import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  getMe, getFacets, getClinicToken, getStoredClinic, setClinicSession, clearClinicSession,
  type Clinic, type PricedProduct, type Facets,
} from './lib/api';

// App-wide store: hash route, clinic session, cart, facets, and modal UI flags.
// One provider at the top; the header, marketing pages, and shop all read from it.

export type CartItem = { p: PricedProduct; qty: number };

export interface RouteState {
  path: string; // e.g. "/", "/about", "/catalog"
  query: URLSearchParams;
}

function parseHash(): RouteState {
  const h = window.location.hash.replace(/^#/, '') || '/';
  const [path, qs] = h.split('?');
  return { path: path || '/', query: new URLSearchParams(qs ?? '') };
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
  const [route, setRoute] = useState<RouteState>(parseHash);
  const [lang, setLang] = useState<Lang>(() => (localStorage.getItem('diana_lang') === 'en' ? 'en' : 'th'));
  const [clinic, setClinic] = useState<Clinic | null>(() => (getClinicToken() ? getStoredClinic() : null));
  // Hydrate the cart from localStorage so it survives refreshes/reloads.
  const [cart, setCart] = useState<Record<string, CartItem>>(() => {
    try { return JSON.parse(localStorage.getItem('diana_cart') || '{}') as Record<string, CartItem>; } catch { return {}; }
  });
  const [facets, setFacets] = useState<Facets | null>(null);
  const [authOpen, setAuthOpen] = useState(false);
  const [cartOpen, setCartOpen] = useState(false);

  // Hash routing.
  useEffect(() => {
    const onHash = () => { setRoute(parseHash()); window.scrollTo(0, 0); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const navigate = useCallback((to: string) => { window.location.hash = to; }, []);

  // Language toggle (persisted). pick(th, en) returns the value for the current language.
  const toggleLang = useCallback(() => {
    setLang((l) => { const n: Lang = l === 'th' ? 'en' : 'th'; localStorage.setItem('diana_lang', n); document.documentElement.lang = n; return n; });
  }, []);
  function pick<T>(th: T, en: T): T { return lang === 'th' ? th : en; }

  // Refresh approval status on load (approve-since-last-visit takes effect on the same token).
  useEffect(() => {
    const token = getClinicToken();
    if (!token) return;
    getMe()
      .then(({ clinic: c }) => {
        if (getClinicToken() !== token) return; // logged out/in during the request — ignore
        setClinic(c);
        setClinicSession(token, c);
      })
      .catch((e) => {
        // Only drop the session on a real auth failure, NOT a transient network/5xx blip.
        if ((e as Error).message === 'unauthorized' && getClinicToken() === token) {
          clearClinicSession();
          setClinic(null);
        }
      });
  }, []);

  // Facets (brands/categories) once.
  useEffect(() => { getFacets().then(setFacets).catch(() => undefined); }, []);

  // Persist the cart across refreshes; keep <html lang> in sync on load + toggle.
  useEffect(() => { localStorage.setItem('diana_cart', JSON.stringify(cart)); }, [cart]);
  useEffect(() => { document.documentElement.lang = lang; }, [lang]);

  const login = useCallback((c: Clinic, token: string) => { setClinicSession(token, c); setClinic(c); setAuthOpen(false); }, []);
  const logout = useCallback(() => { clearClinicSession(); setClinic(null); setCart({}); }, []);

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
    route, navigate, lang, toggleLang, pick, clinic, approved, login, logout,
    cart, cartCount, addToCart, setQty, clearCart, facets,
    authOpen, setAuthOpen, cartOpen, setCartOpen,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
