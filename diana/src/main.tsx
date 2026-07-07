import './index.css';
import { ViteReactSSG } from 'vite-react-ssg';
import { routes } from './App';

// One-time migration for links shared before History routing: rewrite an old hash route
// (e.g. https://prominentdental.com/#/lab) to its real path (/lab) BEFORE the router reads the
// location, so previously shared hash links still resolve. Guarded because this module is also
// imported during prerender (Node), where `window` does not exist.
if (typeof window !== 'undefined' && window.location.hash.startsWith('#/')) {
  const target = window.location.hash.slice(1); // "/lab" or "/catalog?category=..."
  window.history.replaceState(null, '', target);
}

export const createRoot = ViteReactSSG({ routes });
