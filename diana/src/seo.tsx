// Per-route <head> + structured data. `Head` (from vite-react-ssg, a react-helmet-async
// wrapper) injects these into the prerendered HTML at build for the marketing routes, and
// updates document.head on the client for the client-rendered routes (catalog, product).
//
// The site-wide invariants (charset, viewport, fonts, favicon, og:site_name, og:locale,
// twitter:card) live in index.html. Everything PER-PAGE — title, description, canonical and
// the og/twitter title/description/url/image — is emitted here so each page owns exactly one
// of each (the template's fallback <title>/description is stripped at prerender; see
// vite.config.ts › onBeforePageRender).

import { Head } from 'vite-react-ssg';
import { COMPANY } from './company';
import type { PublicProduct } from './lib/api';

// Public website origin. Canonical + og:url are always absolute against this.
export const SITE = 'https://prominentdental.com';
const DEFAULT_OG_IMAGE = `${SITE}/hero.jpg`;

interface SeoProps {
  title: string;
  description: string;
  path: string; // canonical/og:url = SITE + path (e.g. "/lab", "/product/07-10-09")
  image?: string; // absolute; defaults to the hero image on the site origin
  type?: 'website' | 'product';
  jsonLd?: object | object[];
}

export function Seo({ title, description, path, image, type = 'website', jsonLd }: SeoProps) {
  const url = SITE + path;
  const img = image || DEFAULT_OG_IMAGE;
  const blocks = jsonLd ? (Array.isArray(jsonLd) ? jsonLd : [jsonLd]) : [];
  return (
    <Head>
      <title>{title}</title>
      <meta name="description" content={description} />
      <link rel="canonical" href={url} />
      <meta property="og:type" content={type} />
      <meta property="og:title" content={title} />
      <meta property="og:description" content={description} />
      <meta property="og:url" content={url} />
      <meta property="og:image" content={img} />
      <meta name="twitter:title" content={title} />
      <meta name="twitter:description" content={description} />
      <meta name="twitter:image" content={img} />
      {blocks.map((b, i) => (
        <script key={i} type="application/ld+json">{JSON.stringify(b)}</script>
      ))}
    </Head>
  );
}

// ── JSON-LD builders ─────────────────────────────────────────────────────────
export function orgJsonLd() {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: COMPANY.legalName,
    url: SITE,
    logo: `${SITE}/logo.png`,
    email: COMPANY.email,
    telephone: COMPANY.phone,
    address: {
      '@type': 'PostalAddress',
      streetAddress: COMPANY.address.lineEn,
      addressLocality: 'Bangkok',
      postalCode: '10400',
      addressCountry: 'TH',
    },
    sameAs: [COMPANY.social.facebook, COMPANY.social.instagram, COMPANY.social.youtube, COMPANY.line.url],
  };
}

// Product schema WITHOUT price — pricing is login-gated, so we advertise availability + a
// canonical url on the Offer but never a value/PriceSpecification.
export function productJsonLd(p: PublicProduct, imageAbs: string, url: string, category: string) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: p.nameEn || p.nameTh,
    image: imageAbs,
    description: p.descriptionEn || p.descriptionTh || p.nameEn || p.nameTh,
    sku: p.sku,
    ...(p.brand ? { brand: { '@type': 'Brand', name: p.brand } } : {}),
    ...(category ? { category } : {}),
    offers: { '@type': 'Offer', availability: 'https://schema.org/InStock', url },
  };
}

export function breadcrumbJsonLd(items: { name: string; url: string }[]) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((it, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: it.name,
      item: it.url,
    })),
  };
}
