import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Menu, X, ShoppingCart, ClipboardList, Search, User, Mail, MapPin,
  Facebook, Instagram, Youtube,
} from 'lucide-react';
import { useReveal, useStore } from './store';
import { COMPANY, CATEGORIES } from './company';

const NAV = [
  { to: '/', th: 'หน้าแรก', en: 'Home' },
  { to: '/catalog', th: 'แคตตาล็อก', en: 'Catalogue' },
  { to: '/products', th: 'สินค้า', en: 'Products' },
  { to: '/lab', th: 'แล็บ', en: 'Lab' },
  { to: '/manufacturing', th: 'โรงงานผลิต', en: 'Manufacturing' },
  { to: '/about', th: 'เกี่ยวกับเรา', en: 'About' },
  { to: '/contact', th: 'ติดต่อ', en: 'Contact' },
];

export function LineIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 3C6.5 3 2 6.6 2 11c0 4 3.6 7.3 8.5 7.9.3.1.8.2.9.5.1.3.1.7 0 1l-.1 1c-.1.3-.3 1.1 1 .6 1.3-.5 6.9-4.1 9.4-7C23 13.4 22 9 12 3z" />
    </svg>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  useReveal();
  return (
    <>
      <TopBar />
      <SiteHeader />
      <main>{children}</main>
      <SiteFooter />
      <FloatingLine />
    </>
  );
}

function LangToggle() {
  const { lang, toggleLang } = useStore();
  return (
    <button onClick={toggleLang} style={{ background: 'none', border: 'none', color: '#cdd9e6', cursor: 'pointer', fontSize: '.82rem', display: 'flex', gap: 6, alignItems: 'center' }} aria-label="Switch language">
      <b style={{ color: lang === 'th' ? '#fff' : '#cdd9e6' }}>TH</b>
      <span style={{ opacity: .5 }}>·</span>
      <b style={{ color: lang === 'en' ? '#fff' : '#cdd9e6' }}>EN</b>
    </button>
  );
}

function TopBar() {
  const { pick } = useStore();
  return (
    <div className="topbar">
      <div className="wrap">
        <div className="tb-left">
          <span className="tb-dot hide-sm"><Mail size={14} /> {COMPANY.email}</span>
          <span className="tb-dot"><MapPin size={14} /> Bangkok, Thailand</span>
        </div>
        <div className="tb-right">
          <a href={COMPANY.line.url} target="_blank" rel="noreferrer">{pick('สั่งซื้อผ่าน LINE', 'Order via LINE')} <b style={{ color: '#4fb3ec' }}>{COMPANY.line.id}</b></a>
          <span className="soc">
            <a href={COMPANY.social.facebook} target="_blank" rel="noreferrer" aria-label="Facebook"><Facebook size={15} /></a>
            <a href={COMPANY.social.instagram} target="_blank" rel="noreferrer" aria-label="Instagram"><Instagram size={15} /></a>
            <a href={COMPANY.social.youtube} target="_blank" rel="noreferrer" aria-label="YouTube"><Youtube size={15} /></a>
          </span>
          <LangToggle />
        </div>
      </div>
    </div>
  );
}

function SiteHeader() {
  const { route, pick, clinic, approved, cartCount, setAuthOpen, setCartOpen, logout } = useStore();
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const active = (to: string) => (to === '/' ? route.path === '/' : route.path.startsWith(to));

  // Firm up the sticky header (shadow + more opaque bg) once the page scrolls past the top.
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <header className={`site${scrolled ? ' scrolled' : ''}`}>
      <div className="wrap nav">
        <a className="brand" href="#/">
          <img src="/logo.png" alt="Prominent — Premium Dental Solutions" style={{ height: 34, width: 'auto' }} />
        </a>

        <nav className="nav-links">
          {NAV.map((n) => (
            <a key={n.to} href={`#${n.to}`} className={active(n.to) ? 'active' : ''}>{pick(n.th, n.en)}</a>
          ))}
        </nav>

        <div className="nav-actions">
          <a className="icon-btn" href="#/catalog" aria-label={pick('ค้นหา', 'Search')}><Search size={19} /></a>
          {approved && (
            <button className="icon-btn" onClick={() => setCartOpen(true)} aria-label={pick('ตะกร้า', 'Cart')}>
              <ShoppingCart size={19} />
              {cartCount > 0 && <span className="badge">{cartCount}</span>}
            </button>
          )}
          {approved && <a className="icon-btn" href="#/orders" aria-label={pick('ออเดอร์', 'Orders')}><ClipboardList size={19} /></a>}
          {clinic ? (
            <button className="icon-btn" onClick={logout} aria-label={pick('ออกจากระบบ', 'Sign out')} title={`${pick('ออกจากระบบ', 'Sign out')} (${clinic.clinicName})`}><User size={19} /></button>
          ) : (
            <button className="btn btn-coral btn-sm" onClick={() => setAuthOpen(true)} style={{ marginLeft: 4 }}>
              <User size={16} /> {pick('เข้าสู่ระบบ', 'Sign in')}
            </button>
          )}
          <button className="icon-btn hamb" onClick={() => setOpen(!open)} aria-label="Menu">
            {open ? <X size={19} /> : <Menu size={19} />}
          </button>
        </div>
      </div>

      {open && (
        <div style={{ borderTop: '1px solid var(--line)', background: 'var(--cream)', padding: '8px 24px 14px' }}>
          {NAV.map((n) => (
            <a key={n.to} href={`#${n.to}`} onClick={() => setOpen(false)}
              style={{ display: 'block', padding: '11px 4px', fontWeight: 600, color: active(n.to) ? 'var(--teal-d)' : 'var(--ink)', borderBottom: '1px solid var(--line)' }}>
              {pick(n.th, n.en)}
            </a>
          ))}
          <div style={{ marginTop: 12, display: 'flex', gap: 10 }}>
            <a className="btn btn-line btn-sm" href={COMPANY.line.url} target="_blank" rel="noreferrer" style={{ flex: 1, justifyContent: 'center' }}><LineIcon size={16} /> LINE</a>
            {!clinic && <button className="btn btn-ghost btn-sm" onClick={() => { setAuthOpen(true); setOpen(false); }} style={{ flex: 1, justifyContent: 'center' }}>{pick('เข้าสู่ระบบ', 'Sign in')}</button>}
          </div>
        </div>
      )}
    </header>
  );
}

function SiteFooter() {
  const { pick } = useStore();
  return (
    <footer className="site">
      <div className="wrap fmain">
        <div className="fabout">
          <img src="/logo-white.png" alt="Prominent" style={{ height: 40, width: 'auto', marginBottom: 14 }} />
          <p>{pick(COMPANY.introTh, COMPANY.introEn)}</p>
          <div className="fsoc">
            <a href={COMPANY.social.facebook} target="_blank" rel="noreferrer" aria-label="Facebook"><Facebook size={17} /></a>
            <a href={COMPANY.social.instagram} target="_blank" rel="noreferrer" aria-label="Instagram"><Instagram size={17} /></a>
            <a href={COMPANY.social.youtube} target="_blank" rel="noreferrer" aria-label="YouTube"><Youtube size={17} /></a>
            <a href={COMPANY.line.url} target="_blank" rel="noreferrer" aria-label="LINE"><LineIcon size={17} /></a>
          </div>
        </div>
        <div className="fcol">
          <h4>{pick('แคตตาล็อก', 'Catalogue')}</h4>
          {CATEGORIES.map((c) => (
            <a key={c.key} href={c.catalogCategory ? `#/catalog?category=${encodeURIComponent(c.catalogCategory)}` : '#/catalog'}>{pick(c.nameTh, c.nameEn)}</a>
          ))}
        </div>
        <div className="fcol">
          <h4>{pick('บริษัท', 'Company')}</h4>
          <a href="#/about">{pick('เกี่ยวกับเรา', 'About us')}</a>
          <a href="#/lab">{pick('แล็บทันตกรรม', 'Dental Lab')}</a>
          <a href="#/manufacturing">{pick('โรงงานผลิต', 'Manufacturing')}</a>
          <a href="#/contact">{pick('ติดต่อเรา', 'Contact')}</a>
        </div>
        <div className="fcol">
          <h4>{pick('ติดต่อเรา', 'Get in touch')}</h4>
          <a href={`tel:${COMPANY.phone}`}>{COMPANY.phone}</a>
          <a href={`mailto:${COMPANY.email}`}>{COMPANY.email}</a>
          <a href={COMPANY.line.url} target="_blank" rel="noreferrer">LINE {COMPANY.line.id}</a>
          <p style={{ marginTop: 12, fontSize: '.9rem' }}>{pick(COMPANY.address.line, COMPANY.address.lineEn)}</p>
        </div>
      </div>
      <div className="wrap fbot">
        <span>© {COMPANY.legalName} · {COMPANY.domain}</span>
        <span style={{ color: '#7e90a6' }}>ISO 9001:2015 · ISO 13485:2016 · Thai FDA</span>
      </div>
    </footer>
  );
}

function FloatingLine() {
  return (
    <div className="fab">
      <a className="f-line" href={COMPANY.line.url} target="_blank" rel="noreferrer" aria-label="Chat on LINE"><LineIcon size={24} /></a>
    </div>
  );
}
