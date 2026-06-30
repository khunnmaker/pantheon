import { StoreProvider, useStore } from './store';
import { Layout } from './site';
import { CatalogPage, OrdersPage, CartDrawer, AuthModal } from './storefront';
import { HomePage, AboutPage, ProductsPage, BrandsPage, LabPage, ManufacturingPage, ContactPage } from './pages';
import Admin from './Admin';

function Routed() {
  const { route } = useStore();
  switch (route.path) {
    case '/about': return <AboutPage />;
    case '/products': return <ProductsPage />;
    case '/brands': return <BrandsPage />;
    case '/lab': return <LabPage />;
    case '/manufacturing': return <ManufacturingPage />;
    case '/catalog': return <CatalogPage />;
    case '/orders': return <OrdersPage />;
    case '/contact': return <ContactPage />;
    default: return <HomePage />;
  }
}

function Site() {
  const { route, authOpen, cartOpen } = useStore();
  // Staff console at #admin — standalone (its own login + layout, no site chrome).
  if (route.path === 'admin' || route.path === '/admin') return <Admin />;
  return (
    <>
      <Layout><Routed /></Layout>
      {cartOpen && <CartDrawer />}
      {authOpen && <AuthModal />}
    </>
  );
}

export default function App() {
  return (
    <StoreProvider>
      <Site />
    </StoreProvider>
  );
}
