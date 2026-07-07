import { Outlet, Link } from 'react-router-dom';
import type { RouteRecord } from 'vite-react-ssg';
import { StoreProvider, useStore } from './store';
import { Layout } from './site';
import { CatalogPage, OrdersPage, CartDrawer, AuthModal } from './storefront';
import { HomePage, AboutPage, ProductsPage, BrandsPage, LabPage, ManufacturingPage, ContactPage } from './pages';
import { Seo } from './seo';

// Site chrome (header/footer/scroll-reveal via Layout) + the global modals. Rendered INSIDE the
// StoreProvider so it can read the modal flags; wraps every public page.
function Chrome() {
  const { authOpen, cartOpen } = useStore();
  return (
    <>
      <Layout><Outlet /></Layout>
      {cartOpen && <CartDrawer />}
      {authOpen && <AuthModal />}
    </>
  );
}

// Root of the public site: one StoreProvider (it depends on the router's useLocation/useNavigate,
// so it lives inside the route tree) wrapping the chrome + the matched page.
function RootLayout() {
  return (
    <StoreProvider>
      <Chrome />
    </StoreProvider>
  );
}

function NotFound() {
  const { pick } = useStore();
  return (
    <div className="wrap" style={{ padding: '90px 24px', textAlign: 'center' }}>
      <Seo title={pick('ไม่พบหน้า — Prominent Dental', 'Page not found — Prominent Dental')} description={pick('ไม่พบหน้าที่คุณค้นหา', 'The page you were looking for was not found.')} path="/404" />
      <h1 className="serif" style={{ fontSize: '2.4rem', marginBottom: 12 }}>404</h1>
      <p style={{ color: 'var(--muted)', marginBottom: 24 }}>{pick('ไม่พบหน้าที่คุณค้นหา', "We couldn't find that page.")}</p>
      <Link className="btn btn-primary" to="/">{pick('กลับหน้าแรก', 'Back to home')}</Link>
    </div>
  );
}

// Route tree consumed by vite-react-ssg (prerender) and react-router (client). Only the
// marketing routes are prerendered — see vite.config.ts › ssgOptions.includedRoutes. The
// catalog/product/orders routes are client-only (they hit the API/localStorage); /admin is a
// standalone console rendered OUTSIDE the store + site chrome.
export const routes: RouteRecord[] = [
  {
    path: '/',
    element: <RootLayout />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'about', element: <AboutPage /> },
      { path: 'products', element: <ProductsPage /> },
      { path: 'brands', element: <BrandsPage /> },
      { path: 'lab', element: <LabPage /> },
      { path: 'manufacturing', element: <ManufacturingPage /> },
      { path: 'contact', element: <ContactPage /> },
      { path: 'catalog', element: <CatalogPage /> },
      { path: 'orders', element: <OrdersPage /> },
      // Client-rendered per-product page — lazily split so the marketing bundle stays lean.
      { path: 'product/:sku', lazy: async () => ({ Component: (await import('./product')).ProductPage }) },
      { path: '*', element: <NotFound /> },
    ],
  },
  // Staff console: standalone (its own login + layout, no store, no site chrome), lazily split.
  { path: '/admin', lazy: async () => ({ Component: (await import('./Admin')).default }) },
];
