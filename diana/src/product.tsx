import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ChevronRight, Package, Loader2, ShieldCheck, LogIn, ArrowLeft } from 'lucide-react';
import { useStore } from './store';
import { getPublicProduct, mediaUrl, type PublicProduct } from './lib/api';
import { Seo, SITE, productJsonLd, breadcrumbJsonLd } from './seo';

// Public per-product page (/product/:sku). Client-rendered — it hits the public single-product
// API (no price) and is intentionally NOT prerendered (Phase A prerenders marketing only).
export function ProductPage() {
  const { sku = '' } = useParams();
  const { pick, setAuthOpen } = useStore();
  const [product, setProduct] = useState<PublicProduct | null>(null);
  const [status, setStatus] = useState<'loading' | 'ok' | 'notfound' | 'error'>('loading');
  const [imgOk, setImgOk] = useState(true);

  useEffect(() => {
    let live = true;
    setStatus('loading'); setImgOk(true);
    getPublicProduct(sku)
      .then(({ product: p }) => { if (live) { setProduct(p); setStatus('ok'); } })
      .catch((e) => { if (live) setStatus((e as Error).message === 'not_found' ? 'notfound' : 'error'); });
    return () => { live = false; };
  }, [sku]);

  if (status === 'loading') {
    return <div className="wrap" style={{ display: 'flex', justifyContent: 'center', padding: '100px 0', color: 'var(--muted)' }}><Loader2 className="animate-spin" /></div>;
  }

  if (status !== 'ok' || !product) {
    const err = status === 'error';
    return (
      <div className="wrap" style={{ padding: '90px 24px', textAlign: 'center' }}>
        <Seo title={pick('ไม่พบสินค้า — Prominent Dental', 'Product not found — Prominent Dental')} description={pick('ไม่พบสินค้าที่คุณค้นหา', 'The product you were looking for was not found.')} path={`/product/${sku}`} />
        <Package size={44} style={{ color: 'var(--muted)', marginBottom: 14 }} />
        <h1 className="serif" style={{ fontSize: '1.7rem', marginBottom: 10 }}>{err ? pick('โหลดสินค้าไม่สำเร็จ', 'Could not load this product') : pick('ไม่พบสินค้านี้', 'Product not found')}</h1>
        <p style={{ color: 'var(--muted)', marginBottom: 24 }}>{err ? pick('กรุณาลองใหม่อีกครั้ง', 'Please try again.') : pick('สินค้านี้อาจถูกนำออกแล้ว', 'This item may no longer be available.')}</p>
        <Link className="btn btn-primary" to="/catalog"><ArrowLeft size={16} /> {pick('กลับไปที่แคตตาล็อก', 'Back to catalogue')}</Link>
      </div>
    );
  }

  const name = pick(product.nameTh || product.nameEn, product.nameEn || product.nameTh);
  const categoryLabel = pick(product.category, product.categoryEn || product.category);
  const description = pick(product.descriptionTh || product.descriptionEn, product.descriptionEn || product.descriptionTh);
  const catHref = product.category ? `/catalog?category=${encodeURIComponent(product.category)}` : '/catalog';
  // og:image / Product.image must be absolute. Product photos are served by the API (not the
  // website), so this resolves against the API origin baked into VITE_API_URL — mediaUrl().
  const photoAbs = mediaUrl(product.photo);
  const canonicalPath = `/product/${sku}`;
  const crumbs = [
    { name: pick('หน้าแรก', 'Home'), url: `${SITE}/` },
    ...(product.category ? [{ name: categoryLabel, url: `${SITE}${catHref}` }] : []),
    { name, url: SITE + canonicalPath },
  ];

  return (
    <div className="wrap" style={{ paddingTop: 34, paddingBottom: 80 }}>
      <Seo
        title={`${name} · Prominent Dental`}
        description={description || name}
        path={canonicalPath}
        image={photoAbs}
        type="product"
        jsonLd={[productJsonLd(product, photoAbs, SITE + canonicalPath, categoryLabel), breadcrumbJsonLd(crumbs)]}
      />

      <div className="breadcrumb" style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: '.85rem', color: 'var(--muted)', marginBottom: 22, flexWrap: 'wrap' }}>
        <Link to="/">{pick('หน้าแรก', 'Home')}</Link>
        <ChevronRight size={14} />
        {product.category
          ? <><Link to={catHref}>{categoryLabel}</Link><ChevronRight size={14} /></>
          : <><Link to="/catalog">{pick('แคตตาล็อก', 'Catalogue')}</Link><ChevronRight size={14} /></>}
        <span style={{ color: 'var(--ink)' }}>{name}</span>
      </div>

      <div className="pdp">
        <div className="pdp-photo">
          {product.promo && <span className="ptag">{product.promo}</span>}
          {imgOk
            ? <img src={photoAbs} alt={name} onError={() => setImgOk(false)} />
            : <span className="pdp-noimg"><Package size={54} /></span>}
        </div>

        <div>
          {(product.brand || product.category) && (
            <div className="eyebrow" style={{ marginBottom: 10 }}>{product.brand || categoryLabel}</div>
          )}
          <h1 className="serif" style={{ fontSize: 'clamp(1.6rem,3.2vw,2.3rem)', lineHeight: 1.15, marginBottom: 8 }}>{name}</h1>
          <div style={{ fontFamily: 'monospace', fontSize: '.85rem', color: 'var(--muted)', marginBottom: 18 }}>{product.sku}</div>

          {description && <p style={{ color: 'var(--muted)', lineHeight: 1.7, marginBottom: 20 }}>{description}</p>}

          {product.specs.length > 0 && (
            <ul className="pdp-specs">
              {product.specs.map((s) => (
                <li key={s}><ShieldCheck size={17} /> <span>{s}</span></li>
              ))}
            </ul>
          )}

          <div className="pdp-cta">
            <div className="pdp-price">{pick('เข้าสู่ระบบเพื่อดูราคา', 'Sign in for price')}</div>
            <p style={{ fontSize: '.85rem', color: 'var(--muted)', margin: '4px 0 16px' }}>{pick('ราคาสำหรับสมาชิกที่ได้รับอนุมัติ — เข้าสู่ระบบเพื่อดูราคาและสั่งซื้อ', 'Prices are shown to approved members — sign in to see pricing and order.')}</p>
            <button className="btn btn-primary" onClick={() => setAuthOpen(true)}><LogIn size={17} /> {pick('เข้าสู่ระบบเพื่อดูราคา', 'Sign in for price')}</button>
          </div>
        </div>
      </div>

      <style>{`
        .pdp{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.05fr);gap:40px;align-items:start}
        .pdp-photo{position:relative;background:#fff;border:1px solid var(--line);border-radius:var(--r-md);aspect-ratio:1/1;display:grid;place-items:center;overflow:hidden}
        .pdp-photo img{width:100%;height:100%;object-fit:contain;padding:22px}
        .pdp-noimg{color:var(--line)}
        .pdp-specs{list-style:none;padding:0;margin:0 0 22px;display:flex;flex-direction:column;gap:10px}
        .pdp-specs li{display:flex;gap:10px;align-items:flex-start;color:var(--ink);font-size:.94rem}
        .pdp-specs li svg{color:var(--teal-d);flex-shrink:0;margin-top:2px}
        .pdp-cta{border:1px solid var(--line);border-radius:var(--r-md);padding:22px;background:var(--sand)}
        .pdp-price{font-family:'Fraunces',serif;font-size:1.3rem;font-weight:600;color:var(--teal-d)}
        @media(max-width:760px){.pdp{grid-template-columns:1fr;gap:24px}}
      `}</style>
    </div>
  );
}
