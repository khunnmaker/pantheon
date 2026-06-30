import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Search, ShoppingCart, X, Loader2, AlertTriangle, CheckCircle2, Plus, Minus, Trash2,
  ChevronLeft, ChevronRight, ClipboardList, Clock, Package, User,
} from 'lucide-react';
import { useStore } from './store';
import {
  getPublicCatalog, getPricedCatalog, loginClinic, registerClinic, submitOrder, getMyOrders,
  mediaUrl, formatBaht,
  type PublicProduct, type PricedProduct, type CatalogPage, type WebOrder, type Availability, type Facets,
} from './lib/api';
import { COMPANY } from './company';

const PAGE_SIZE = 24;
const isPriced = (p: PublicProduct | PricedProduct): p is PricedProduct => 'price' in p;
type Pick = <T>(th: T, en: T) => T;

function availLabel(pick: Pick, av: Availability): string {
  return av === 'in_stock' ? pick('มีสินค้า', 'In stock') : av === 'low' ? pick('เหลือน้อย', 'Low stock') : av === 'out' ? pick('สินค้าหมด', 'Out of stock') : pick('สอบถามสต็อก', 'Ask for stock');
}
const ORDER_STATUS: Record<WebOrder['status'], { th: string; en: string; color: string }> = {
  submitted: { th: 'รอยืนยัน', en: 'Pending', color: '#2f86c4' },
  confirmed: { th: 'ยืนยันแล้ว', en: 'Confirmed', color: '#1473A8' },
  invoiced: { th: 'ออกใบแจ้งหนี้แล้ว', en: 'Invoiced', color: '#5a8a3a' },
  cancelled: { th: 'ยกเลิก', en: 'Cancelled', color: '#5F706D' },
};

// ── Catalog page ────────────────────────────────────────────────────────────
export function CatalogPage() {
  const { route, approved, clinic, facets, pick } = useStore();
  const [query, setQuery] = useState(route.query.get('q') ?? '');
  const [debounced, setDebounced] = useState(route.query.get('q') ?? '');
  const [category, setCategory] = useState(route.query.get('category') ?? '');
  const [brand, setBrand] = useState(route.query.get('brand') ?? '');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<CatalogPage<PublicProduct | PricedProduct> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setCategory(route.query.get('category') ?? '');
    setBrand(route.query.get('brand') ?? '');
    setQuery(route.query.get('q') ?? '');
  }, [route]);
  useEffect(() => { const t = setTimeout(() => { setDebounced(query.trim()); setPage(1); }, 300); return () => clearTimeout(t); }, [query]);
  useEffect(() => { setPage(1); }, [category, brand]);
  useEffect(() => {
    let live = true;
    setLoading(true); setError('');
    const params = { q: debounced, brand, category, page, pageSize: PAGE_SIZE };
    (approved ? getPricedCatalog(params) : getPublicCatalog(params))
      .then((d) => { if (live) setData(d); })
      .catch(() => { if (live) setError(pick('โหลดแคตตาล็อกไม่สำเร็จ', 'Failed to load the catalogue')); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [debounced, brand, category, page, approved]);

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const clearAll = () => { setCategory(''); setBrand(''); setQuery(''); };

  return (
    <div className="wrap" style={{ paddingTop: 34, paddingBottom: 80 }}>
      <div className="breadcrumb" style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: '.85rem', color: 'var(--muted)', marginBottom: 22 }}>
        <a href="#/">{pick('หน้าแรก', 'Home')}</a><ChevronRight size={14} /><span>{category || pick('แคตตาล็อก', 'Catalogue')}</span>
      </div>

      {clinic && clinic.status !== 'approved' && <div style={{ marginBottom: 22 }}><StatusBanner status={clinic.status} /></div>}

      {category && (
        <div className="cat-banner">
          <h2 className="serif">{category}</h2>
          <p>{data?.total ?? 0} {pick('รายการในหมวดนี้ — เข้าสู่ระบบเพื่อดูราคาและสั่งซื้อ', 'products in this category — sign in to see prices and order')}</p>
        </div>
      )}

      <div className="catalog">
        <aside className="filters">
          <h4 style={{ marginTop: 0 }}>{pick('ค้นหา', 'Search')}</h4>
          <div className="fsearch">
            <Search size={16} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={pick('ค้นหาสินค้า / รหัส…', 'Search products / code…')} />
          </div>
          <Facets facets={facets} category={category} brand={brand} onCategory={setCategory} onBrand={setBrand} />
          {(category || brand || query) && <button className="clear-f" onClick={clearAll}>{pick('ล้างตัวกรองทั้งหมด', 'Clear all filters')}</button>}
        </aside>

        <div>
          <div className="cat-toolbar">
            <div className="ct-count"><b>{data?.total ?? 0}</b> {pick('รายการ', 'products')}</div>
            <span style={{ fontSize: '.88rem', color: 'var(--muted)' }}>{approved ? pick('ราคาเรียลไทม์สำหรับสมาชิก', 'Realtime prices for members') : pick('เข้าสู่ระบบเพื่อดูราคา', 'Sign in to see prices')}</span>
          </div>

          {error && <Notice tone="error">{error}</Notice>}
          {loading && !data ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: '80px 0', color: 'var(--muted)' }}><Loader2 className="animate-spin" /></div>
          ) : data && data.total === 0 ? (
            <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--muted)' }}>
              <Search size={46} style={{ margin: '0 auto 14px', opacity: .5 }} />
              <p style={{ fontWeight: 700, color: 'var(--ink)', fontSize: '1.1rem' }}>{pick('ไม่พบสินค้าตามตัวกรอง', 'No products match those filters')}</p>
              <p>{pick('ลองล้างตัวกรองหรือค้นหาด้วยคำอื่น', 'Try clearing a filter or searching a different term.')}</p>
              <button className="btn btn-primary btn-sm" style={{ marginTop: 16 }} onClick={clearAll}>{pick('ล้างตัวกรอง', 'Clear filters')}</button>
            </div>
          ) : (
            <>
              <div className="prod-grid">
                {data?.items.map((p) => <ProductCard key={p.sku} product={p} />)}
              </div>
              {data && data.total > PAGE_SIZE && (
                <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 14, padding: '34px 0 0' }}>
                  <button className="icon-btn" disabled={page <= 1} onClick={() => setPage(page - 1)}><ChevronLeft size={18} /></button>
                  <span style={{ color: 'var(--muted)', fontSize: '.9rem' }}>{pick('หน้า', 'Page')} {page} / {totalPages}</span>
                  <button className="icon-btn" disabled={page >= totalPages} onClick={() => setPage(page + 1)}><ChevronRight size={18} /></button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Facets({ facets, category, brand, onCategory, onBrand }: {
  facets: Facets | null; category: string; brand: string; onCategory: (c: string) => void; onBrand: (b: string) => void;
}) {
  const { pick } = useStore();
  if (!facets) return null;
  return (
    <>
      {facets.categories.length > 0 && (
        <>
          <h4>{pick('หมวดหมู่', 'Category')}</h4>
          {facets.categories.map((c) => (
            <button key={c.name} className={`fopt${category === c.name ? ' active' : ''}`} onClick={() => onCategory(category === c.name ? '' : c.name)}>
              <span>{c.name}</span><span className="fcount">{c.count}</span>
            </button>
          ))}
        </>
      )}
      {facets.brands.length > 0 && (
        <>
          <h4>{pick('แบรนด์', 'Brand')}</h4>
          {facets.brands.map((b) => (
            <button key={b.name} className={`fopt${brand === b.name ? ' active' : ''}`} onClick={() => onBrand(brand === b.name ? '' : b.name)}>
              <span>{b.name}</span><span className="fcount">{b.count}</span>
            </button>
          ))}
        </>
      )}
    </>
  );
}

function ProductCard({ product: p }: { product: PublicProduct | PricedProduct }) {
  const { approved, addToCart, setAuthOpen, pick } = useStore();
  const priced = isPriced(p);
  const [imgOk, setImgOk] = useState(true);
  return (
    <div className="pcard">
      <div className="pimg">
        {p.promo && <span className="ptag">{p.promo}</span>}
        {imgOk ? <img src={mediaUrl(p.photo)} alt={p.nameTh || p.nameEn} onError={() => setImgOk(false)} loading="lazy" />
          : <span className="pico"><Package /></span>}
      </div>
      <div className="pbody">
        <div className="pbrand">{p.brand || p.category || 'Prominent'}</div>
        <div className="pname">{pick(p.nameTh || p.nameEn, p.nameEn || p.nameTh)}</div>
        <div className="psku">{p.sku}</div>
        <div className="pdesc">{p.nameEn && p.nameTh ? pick(p.nameEn, p.nameTh) : p.note}</div>
        <div className="pfoot">
          {priced ? (
            <div className="pprice">{formatBaht(p.price)}<small>{availLabel(pick, p.availability)}</small></div>
          ) : (
            <div className="pprice" style={{ fontSize: '.8rem', fontWeight: 600, color: 'var(--muted)' }}>{pick('เข้าสู่ระบบเพื่อดูราคา', 'Sign in for price')}</div>
          )}
          {approved && priced ? (
            <button className="btn btn-primary btn-sm" onClick={() => addToCart(p)}><Plus size={15} /> {pick('ใส่ตะกร้า', 'Add')}</button>
          ) : (
            <button className="btn btn-ghost btn-sm" onClick={() => setAuthOpen(true)}>{pick('เข้าสู่ระบบ', 'Sign in')}</button>
          )}
        </div>
      </div>
    </div>
  );
}

function Stepper({ qty, onQty }: { qty: number; onQty: (n: number) => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <button className="icon-btn" style={{ width: 30, height: 30 }} onClick={() => onQty(qty - 1)}><Minus size={14} /></button>
      <span style={{ width: 24, textAlign: 'center', fontWeight: 700 }}>{qty}</span>
      <button className="icon-btn" style={{ width: 30, height: 30 }} onClick={() => onQty(qty + 1)}><Plus size={14} /></button>
    </div>
  );
}

function Notice({ tone, children }: { tone: 'error' | 'warn'; children: ReactNode }) {
  const bg = tone === 'error' ? '#FCEBEB' : 'var(--coral-l)';
  const fg = tone === 'error' ? '#A32D2D' : 'var(--coral-d)';
  return <div style={{ display: 'flex', gap: 8, alignItems: 'center', background: bg, color: fg, borderRadius: 12, padding: '10px 14px', fontSize: '.9rem', marginBottom: 16 }}><AlertTriangle size={16} /> {children}</div>;
}

export function StatusBanner({ status }: { status: 'pending' | 'rejected' }) {
  const { pick } = useStore();
  if (status === 'pending')
    return <div style={{ display: 'flex', gap: 8, alignItems: 'center', background: 'var(--coral-l)', color: 'var(--coral-d)', borderRadius: 12, padding: '12px 16px', fontSize: '.92rem' }}><Clock size={17} /> {pick('บัญชีของคุณกำลังรอการอนุมัติ — เมื่อได้รับอนุมัติ คุณจะเห็นราคาและสั่งซื้อได้ทันที', 'Your account is awaiting approval — once approved, you can see prices and order right away.')}</div>;
  return <div style={{ display: 'flex', gap: 8, alignItems: 'center', background: '#FCEBEB', color: '#A32D2D', borderRadius: 12, padding: '12px 16px', fontSize: '.92rem' }}><AlertTriangle size={17} /> {pick('บัญชีนี้ยังไม่ได้รับการอนุมัติ กรุณาติดต่อ Prominent', 'This account has not been approved. Please contact Prominent.')}</div>;
}

// ── Orders page ─────────────────────────────────────────────────────────────
export function OrdersPage() {
  const { approved, navigate, pick } = useStore();
  const [orders, setOrders] = useState<WebOrder[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { if (approved) getMyOrders().then(({ orders: o }) => setOrders(o)).catch(() => setError(pick('โหลดออเดอร์ไม่สำเร็จ', 'Failed to load orders'))); }, [approved]);

  return (
    <div className="wrap" style={{ paddingTop: 34, paddingBottom: 80, maxWidth: 820 }}>
      <h1 className="serif" style={{ fontSize: '2rem', marginBottom: 18, display: 'flex', alignItems: 'center', gap: 10 }}><ClipboardList size={24} /> {pick('คำสั่งซื้อของฉัน', 'My orders')}</h1>
      {!approved ? <p style={{ color: 'var(--muted)' }}>{pick('กรุณาเข้าสู่ระบบด้วยบัญชีที่ได้รับอนุมัติเพื่อดูออเดอร์', 'Sign in with an approved account to view orders.')}</p>
        : error ? <Notice tone="error">{error}</Notice>
        : !orders ? <div style={{ display: 'flex', justifyContent: 'center', padding: '60px 0', color: 'var(--muted)' }}><Loader2 className="animate-spin" /></div>
        : orders.length === 0 ? <p style={{ color: 'var(--muted)' }}>{pick('ยังไม่มีคำสั่งซื้อ — ', 'No orders yet — ')}<a href="#/catalog" style={{ color: 'var(--teal-d)' }}>{pick('เลือกซื้อสินค้า', 'browse products')}</a></p>
        : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {orders.map((o) => {
              const known = o.lines.filter((l) => l.unitPrice > 0).reduce((s, l) => s + l.unitPrice * l.qty, 0);
              const st = ORDER_STATUS[o.status];
              return (
                <div key={o.id} style={{ background: '#fff', border: '1px solid var(--line)', borderRadius: 16, padding: 20 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                    <span style={{ fontFamily: 'monospace', fontSize: '.8rem', color: 'var(--muted)' }}>#{o.id.slice(-8)}</span>
                    <span style={{ fontSize: '.78rem', fontWeight: 700, color: st.color }}>{pick(st.th, st.en)}</span>
                  </div>
                  <div style={{ fontSize: '.8rem', color: 'var(--muted)', marginBottom: 10 }}>{new Date(o.createdAt).toLocaleString(pick('th-TH', 'en-GB'))}</div>
                  {o.lines.map((l) => (
                    <div key={l.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '.9rem', padding: '2px 0' }}>
                      <span style={{ color: 'var(--muted)' }}>{l.nameSnapshot} ×{l.qty}</span>
                      <span style={{ color: 'var(--muted)' }}>{l.unitPrice > 0 ? formatBaht(l.unitPrice * l.qty) : pick('รอยืนยัน', 'TBC')}</span>
                    </div>
                  ))}
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--line)', fontWeight: 700 }}>
                    <span>{pick('ยอดรวม (ที่ทราบ)', 'Total (known)')}</span><span>{formatBaht(known)}</span>
                  </div>
                </div>
              );
            })}
            <button className="btn btn-ghost" style={{ alignSelf: 'flex-start' }} onClick={() => navigate('/catalog')}>{pick('เลือกซื้อเพิ่ม', 'Continue shopping')}</button>
          </div>
        )}
    </div>
  );
}

// ── Cart drawer ─────────────────────────────────────────────────────────────
export function CartDrawer() {
  const { cart, setQty, clearCart, setCartOpen, navigate, pick } = useStore();
  const items = Object.values(cart);
  const [taxName, setTaxName] = useState('');
  const [taxId, setTaxId] = useState('');
  const [taxAddress, setTaxAddress] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const known = items.filter((it) => it.p.price > 0).reduce((s, it) => s + it.p.price * it.qty, 0);
  const unknownCount = items.filter((it) => it.p.price <= 0).length;

  async function submit() {
    if (!items.length || busy) return;
    setBusy(true); setError('');
    try {
      await submitOrder({ items: items.map((it) => ({ sku: it.p.sku, qty: it.qty })), note, tax: taxName || taxId || taxAddress ? { name: taxName, id: taxId, address: taxAddress } : undefined });
      clearCart(); setCartOpen(false); navigate('/orders');
    } catch { setError(pick('ส่งคำสั่งซื้อไม่สำเร็จ กรุณาลองใหม่', 'Could not submit. Please try again.')); setBusy(false); }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 80, display: 'flex', justifyContent: 'flex-end' }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(20,40,38,.45)' }} onClick={() => setCartOpen(false)} />
      <div style={{ position: 'relative', width: '100%', maxWidth: 440, background: 'var(--cream)', height: '100%', boxShadow: 'var(--shadow)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 18, borderBottom: '1px solid var(--line)' }}>
          <b style={{ display: 'flex', alignItems: 'center', gap: 8 }}><ShoppingCart size={18} /> {pick('ตะกร้าสินค้า', 'Cart')}</b>
          <button className="icon-btn" style={{ width: 36, height: 36 }} onClick={() => setCartOpen(false)}><X size={18} /></button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
          {items.length === 0 && <p style={{ textAlign: 'center', color: 'var(--muted)', padding: '40px 0' }}>{pick('ตะกร้าว่าง', 'Your cart is empty')}</p>}
          {items.map((it) => (
            <div key={it.p.sku} style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: '.72rem', fontFamily: 'monospace', color: 'var(--muted)' }}>{it.p.sku}</div>
                <div style={{ fontSize: '.9rem' }}>{pick(it.p.nameTh || it.p.nameEn, it.p.nameEn || it.p.nameTh)}</div>
                <div style={{ fontSize: '.8rem', color: 'var(--muted)' }}>{it.p.price > 0 ? formatBaht(it.p.price) : pick('รอยืนยันราคา', 'Price TBC')}</div>
              </div>
              <Stepper qty={it.qty} onQty={(n) => setQty(it.p.sku, n)} />
              <button className="icon-btn" style={{ width: 30, height: 30 }} onClick={() => setQty(it.p.sku, 0)}><Trash2 size={14} /></button>
            </div>
          ))}
        </div>
        {items.length > 0 && (
          <div style={{ borderTop: '1px solid var(--line)', padding: 18, display: 'flex', flexDirection: 'column', gap: 10, background: '#fff' }}>
            <details style={{ fontSize: '.9rem' }}>
              <summary style={{ cursor: 'pointer', color: 'var(--muted)', marginBottom: 8 }}>{pick('ข้อมูลใบกำกับภาษี (ถ้าต้องการ)', 'Tax invoice details (optional)')}</summary>
              <input className="cinput" value={taxName} onChange={(e) => setTaxName(e.target.value)} placeholder={pick('ชื่อผู้เสียภาษี / บริษัท', 'Taxpayer / company name')} />
              <input className="cinput" value={taxId} onChange={(e) => setTaxId(e.target.value)} placeholder={pick('เลขประจำตัวผู้เสียภาษี', 'Tax ID')} />
              <textarea className="cinput" value={taxAddress} onChange={(e) => setTaxAddress(e.target.value)} placeholder={pick('ที่อยู่', 'Address')} rows={2} />
            </details>
            <textarea className="cinput" value={note} onChange={(e) => setNote(e.target.value)} placeholder={pick('หมายเหตุถึงทีมงาน (ถ้ามี)', 'Note to our team (optional)')} rows={2} />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}><span style={{ color: 'var(--muted)', fontSize: '.9rem' }}>{pick('ยอดรวม (ราคาที่ทราบ)', 'Total (known prices)')}</span><b style={{ fontSize: '1.2rem' }}>{formatBaht(known)}</b></div>
            {unknownCount > 0 && <p style={{ fontSize: '.78rem', color: 'var(--coral-d)' }}>{pick(`มี ${unknownCount} รายการที่ทีมงานจะยืนยันราคาให้`, `${unknownCount} item(s) will be priced by our team`)}</p>}
            <p style={{ fontSize: '.76rem', color: 'var(--muted)' }}>{pick('นี่คือ “คำขอสั่งซื้อ” — ทีมงานจะยืนยันราคา/สต็อก แล้วออกใบแจ้งหนี้ ยังไม่มีการชำระเงินออนไลน์', 'This is a “quote request” — our team confirms price/stock, then invoices. No online payment yet.')}</p>
            {error && <p style={{ fontSize: '.8rem', color: '#A32D2D' }}>{error}</p>}
            <button className="btn btn-primary" style={{ justifyContent: 'center' }} disabled={busy} onClick={submit}>
              {busy ? <Loader2 size={16} className="animate-spin" /> : <CheckCircle2 size={16} />} {pick('ส่งคำขอสั่งซื้อ', 'Submit request')}
            </button>
          </div>
        )}
      </div>
      <style>{`.cinput{width:100%;font-family:inherit;font-size:.9rem;padding:9px 12px;margin-bottom:8px;border:1px solid var(--line);border-radius:10px;background:var(--cream);outline:none}`}</style>
    </div>
  );
}

// ── Auth modal ──────────────────────────────────────────────────────────────
export function AuthModal() {
  const { login, setAuthOpen, pick } = useStore();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [clinicName, setClinicName] = useState('');
  const [contactName, setContactName] = useState('');
  const [phone, setPhone] = useState('');
  const [pdpa, setPdpa] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const firstRef = useRef<HTMLInputElement>(null);
  useEffect(() => { firstRef.current?.focus(); }, [mode]);

  async function submit() {
    if (busy) return;
    setError('');
    const em = email.trim();
    if (!em || !password) { setError(pick('กรอกอีเมลและรหัสผ่าน', 'Enter email and password')); return; }
    setBusy(true);
    try {
      if (mode === 'login') { const { token, clinic } = await loginClinic(em, password); login(clinic, token); }
      else {
        if (!clinicName.trim()) { setError(pick('กรอกชื่อคลินิก/แล็บ', 'Enter clinic/lab name')); setBusy(false); return; }
        if (password.length < 8) { setError(pick('รหัสผ่านอย่างน้อย 8 ตัวอักษร', 'Password must be at least 8 characters')); setBusy(false); return; }
        if (!pdpa) { setError(pick('กรุณายอมรับนโยบายความเป็นส่วนตัว (PDPA)', 'Please accept the privacy policy (PDPA)')); setBusy(false); return; }
        await registerClinic({ email: em, password, clinicName: clinicName.trim(), contactName: contactName.trim(), phone: phone.trim(), pdpaConsent: true });
        setDone(true);
      }
    } catch (e) {
      const msg = (e as Error).message;
      setError(msg === 'email_taken' ? pick('อีเมลนี้ถูกใช้แล้ว', 'That email is already registered') : mode === 'login' ? pick('อีเมลหรือรหัสผ่านไม่ถูกต้อง', 'Incorrect email or password') : pick('สมัครไม่สำเร็จ', 'Registration failed'));
    } finally { setBusy(false); }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 90, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(20,40,38,.5)' }} onClick={() => setAuthOpen(false)} />
      <div style={{ position: 'relative', background: '#fff', borderRadius: 24, width: '100%', maxWidth: 400, padding: 28 }}>
        <button className="icon-btn" style={{ position: 'absolute', right: 16, top: 16, width: 34, height: 34 }} onClick={() => setAuthOpen(false)}><X size={18} /></button>
        {done ? (
          <div style={{ textAlign: 'center', padding: '14px 0' }}>
            <CheckCircle2 size={40} style={{ color: 'var(--teal)', margin: '0 auto 12px' }} />
            <h2 className="serif" style={{ fontSize: '1.3rem', marginBottom: 6 }}>{pick('สมัครสำเร็จ', 'Registered')}</h2>
            <p style={{ color: 'var(--muted)', fontSize: '.9rem', marginBottom: 18 }}>{pick('บัญชีของคุณกำลังรอการอนุมัติ เมื่อได้รับอนุมัติแล้ว คุณจะเข้าสู่ระบบเพื่อดูราคาและสั่งซื้อได้', 'Your account is awaiting approval. Once approved, you can sign in to see prices and order.')}</p>
            <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }} onClick={() => { setMode('login'); setDone(false); }}>{pick('ไปหน้าเข้าสู่ระบบ', 'Go to sign in')}</button>
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, color: 'var(--teal-d)', fontWeight: 800 }}><User size={18} /> Prominent</div>
            <div style={{ display: 'flex', gap: 4, margin: '14px 0', background: 'var(--cream)', borderRadius: 12, padding: 4 }}>
              <button onClick={() => setMode('login')} style={segStyle(mode === 'login')}>{pick('เข้าสู่ระบบ', 'Sign in')}</button>
              <button onClick={() => setMode('register')} style={segStyle(mode === 'register')}>{pick('สมัครสมาชิก', 'Register')}</button>
            </div>
            {mode === 'register' && (<>
              <Field label={pick('ชื่อคลินิก / แล็บ', 'Clinic / lab name')}><input ref={firstRef} value={clinicName} onChange={(e) => setClinicName(e.target.value)} style={ai} /></Field>
              <Field label={pick('ชื่อผู้ติดต่อ', 'Contact name')}><input value={contactName} onChange={(e) => setContactName(e.target.value)} style={ai} /></Field>
              <Field label={pick('เบอร์โทร', 'Phone')}><input value={phone} onChange={(e) => setPhone(e.target.value)} style={ai} /></Field>
            </>)}
            <Field label={pick('อีเมล', 'Email')}><input ref={mode === 'login' ? firstRef : undefined} value={email} onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && mode === 'login' && submit()} style={ai} /></Field>
            <Field label={pick('รหัสผ่าน', 'Password')}><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && mode === 'login' && submit()} style={ai} /></Field>
            {mode === 'register' && (
              <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: '.78rem', color: 'var(--muted)', marginBottom: 12 }}>
                <input type="checkbox" checked={pdpa} onChange={(e) => setPdpa(e.target.checked)} style={{ marginTop: 3 }} />
                <span>{pick('ยอมรับนโยบายความเป็นส่วนตัว (PDPA) และการเก็บข้อมูลเพื่อการสั่งซื้อ', 'I accept the privacy policy (PDPA) and data collection for ordering.')}</span>
              </label>
            )}
            {error && <div style={{ display: 'flex', gap: 6, alignItems: 'center', color: '#A32D2D', fontSize: '.8rem', marginBottom: 12 }}><AlertTriangle size={14} /> {error}</div>}
            <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }} disabled={busy} onClick={submit}>
              {busy ? <Loader2 size={16} className="animate-spin" /> : mode === 'login' ? <User size={16} /> : <CheckCircle2 size={16} />} {mode === 'login' ? pick('เข้าสู่ระบบ', 'Sign in') : pick('สมัครสมาชิก', 'Register')}
            </button>
            <p style={{ textAlign: 'center', fontSize: '.78rem', color: 'var(--muted)', marginTop: 12 }}>{pick('หรือสั่งซื้อผ่าน ', 'Or order via ')}<a href={COMPANY.line.url} target="_blank" rel="noreferrer" style={{ color: 'var(--teal-d)', fontWeight: 700 }}>LINE {COMPANY.line.id}</a></p>
          </>
        )}
      </div>
    </div>
  );
}

const ai: React.CSSProperties = { width: '100%', fontFamily: 'inherit', fontSize: '.95rem', padding: '11px 14px', border: '1px solid var(--line)', borderRadius: 12, background: 'var(--cream)', outline: 'none' };
function segStyle(on: boolean): React.CSSProperties {
  return { flex: 1, padding: '8px 0', borderRadius: 9, border: 'none', fontWeight: 700, fontSize: '.9rem', cursor: 'pointer', background: on ? '#fff' : 'transparent', color: on ? 'var(--teal-d)' : 'var(--muted)', boxShadow: on ? 'var(--shadow-sm)' : 'none' };
}
function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div style={{ marginBottom: 12 }}><label style={{ display: 'block', fontSize: '.78rem', fontWeight: 700, color: 'var(--muted)', marginBottom: 5 }}>{label}</label>{children}</div>;
}
