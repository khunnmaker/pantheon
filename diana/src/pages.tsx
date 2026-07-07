import { useState } from 'react';
import {
  Truck, FlaskConical, Factory, Stethoscope, ScanLine, Anchor, CircleDot, Wrench,
  ArrowRight, Search, ShieldCheck, CheckCircle2, Clock, Boxes,
  Phone, Mail, MapPin, Send,
} from 'lucide-react';
import { useStore } from './store';
import { LineIcon } from './site';
import { COMPANY, CERTS, ARMS, CATEGORIES, BRANDS, type CatGroup } from './company';

const LU: Record<string, typeof Truck> = {
  truck: Truck, flask: FlaskConical, factory: Factory, stethoscope: Stethoscope,
  scan: ScanLine, anchor: Anchor, 'circle-dot': CircleDot, wrench: Wrench,
};
const Ic = ({ name, size = 24 }: { name: string; size?: number }) => {
  const C = LU[name] ?? Boxes;
  return <C size={size} />;
};

// Real category banners from prominent-dental.com (self-labelled promo images).
const CAT_IMG: Record<string, string> = {
  clinic: '/cat-clinic.png', lab: '/cat-lab.png', machine: '/cat-machine.jpg',
  implant: '/cat-implant.png', burs: '/cat-burs.png', handpiece: '/cat-handpiece.png',
};
const ARM_BG: Record<string, string> = {
  distribution: 'linear-gradient(135deg,var(--teal),var(--teal-d))',
  lab: 'linear-gradient(135deg,var(--coral),var(--coral-d))',
  manufacturing: 'linear-gradient(135deg,#2f86c4,#1473A8)',
};

function catHref(c: CatGroup): string {
  if (c.catalogCategory) return `/catalog?category=${encodeURIComponent(c.catalogCategory)}`;
  if (c.search) return `/catalog?q=${encodeURIComponent(c.search)}`;
  return '/catalog';
}

// ── Home ────────────────────────────────────────────────────────────────────
export function HomePage() {
  const { navigate, pick } = useStore();
  const [q, setQ] = useState('');
  const search = () => navigate(`/catalog${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`);

  return (
    <>
      <section className="hero">
        <div className="wrap">
          <div>
            <span className="eyebrow">{pick('วัสดุ–อุปกรณ์ทันตกรรม สำหรับมืออาชีพ', 'Dental equipment & materials for professionals')}</span>
            <h1 className="serif" style={{ marginTop: 14 }}>{pick('วัสดุและอุปกรณ์ทันตกรรม ', 'Quality dental supplies, ')}<em>{pick('ครบ จบ ในที่เดียว', 'all in one place')}</em></h1>
            <p className="lead">{pick(COMPANY.introTh, COMPANY.introEn)}</p>
            <div className="hero-search">
              <Search size={20} />
              <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && search()} placeholder={pick('ค้นหา รากเทียม หัวกรอ สแกนเนอร์ ด้ามกรอ…', 'Search implants, burs, scanners, handpieces…')} />
              <button className="btn btn-primary btn-sm" onClick={search}>{pick('ค้นหา', 'Search')}</button>
            </div>
            <div className="hero-cta">
              <button className="btn btn-primary" onClick={() => navigate('/catalog')}>{pick('ดูแคตตาล็อก', 'Browse catalogue')} <ArrowRight size={18} /></button>
              <a className="btn btn-line" href={COMPANY.line.url} target="_blank" rel="noreferrer"><LineIcon size={18} /> {pick('แชทกับเรา', 'Chat with us')}</a>
            </div>
            <div className="hero-trust">
              <span className="ht"><CheckCircle2 size={18} /> ISO 9001:2015</span>
              <span className="ht"><CheckCircle2 size={18} /> ISO 13485:2016</span>
              <span className="ht"><Truck size={18} /> {pick('จัดส่งทั่วประเทศ', 'Nationwide delivery')}</span>
            </div>
          </div>
          <div className="hero-art">
            <div className="hero-photo"><img src="/hero.jpg" alt={pick('ผลิตภัณฑ์ทันตกรรมที่เราผลิตเอง', 'Our own-made dental products')} /></div>
            <div className="chip c1"><span className="ci" style={{ background: 'var(--coral-l)', color: 'var(--coral-d)' }}><Clock size={19} /></span><div>{pick('จัดส่งไว', 'Fast dispatch')}<small>{pick('สั่งก่อน 15:00 น.', 'Order before 3pm')}</small></div></div>
            <div className="chip c2"><span className="ci" style={{ background: 'var(--teal-l)', color: 'var(--teal-d)' }}><ShieldCheck size={19} /></span><div>{pick('คุณภาพรับรอง', 'Certified quality')}<small>ISO 9001 &amp; 13485</small></div></div>
            <div className="chip c3"><span className="ci" style={{ background: '#E6F3FB', color: '#1473A8' }}><Boxes size={19} /></span><div>{pick('กว่า 1,000 รายการ', '1,000+ products')}<small>{pick('คลินิก · แล็บ · เครื่องมือ', 'Clinic · Lab · Machine')}</small></div></div>
          </div>
        </div>
      </section>

      <div className="strip">
        <div className="wrap">
          <span>{pick('แบรนด์ที่เราจัดจำหน่าย', 'Brands we carry')}</span>
          <b>BEGO</b><b>Exocad</b><b>Sunshine&nbsp;Diamonds</b><b>Dentories</b>
        </div>
      </div>

      <section className="section">
        <div className="wrap">
          <div className="section-head">
            <span className="eyebrow">{pick('เลือกซื้อตามหมวด', 'Shop by category')}</span>
            <h2 className="serif">{pick('ครบทุกอย่างที่คลินิกและแล็บต้องการ', 'Everything your clinic or lab needs')}</h2>
            <p>{pick('ตั้งแต่วัสดุสิ้นเปลืองประจำวัน ไปจนถึงเครื่องมือดิจิทัล — จัดหมวดให้คุณหาเจอในไม่กี่วินาที', 'From everyday consumables to digital machines — organised so you find the right product in seconds.')}</p>
          </div>
          <CatGrid />
        </div>
      </section>

      <section className="section">
        <div className="wrap split">
          <div className="split-art">
            <img src="/section-digital.jpg" alt="" className="split-img" />
            <div className="pill" style={{ top: 18, left: 18 }}><span style={{ width: 10, height: 10, borderRadius: 9, background: 'var(--coral)' }} /> {pick('สแกนช่องปาก', 'Intraoral scan')}</div>
            <div className="pill" style={{ bottom: 18, right: 18 }}><span style={{ width: 10, height: 10, borderRadius: 9, background: 'var(--teal)' }} /> Exocad CAD/CAM</div>
          </div>
          <div>
            <span className="eyebrow">{pick('ดิจิทัลทันตกรรม', 'Digital dentistry')}</span>
            <h2 className="serif" style={{ fontSize: 'clamp(1.7rem,3.4vw,2.5rem)', margin: '14px 0' }}>{pick('จากสแกนถึงงานเสร็จ — ครบในที่เดียว', 'From scan to restoration — under one roof')}</h2>
            <p style={{ color: 'var(--muted)' }}>{pick('เราจำหน่ายและติดตั้งระบบดิจิทัลครบวงจร พร้อมอบรมทีมงานให้ใช้งานได้จริง ผู้เชี่ยวชาญของเราดูแลการติดตั้งถึงคลินิก เพื่อให้คุณเริ่มงานได้ตั้งแต่วันแรก', "We supply and install the full digital workflow, then train your team to use it. Our specialists handle setup at your clinic so you're productive from day one.")}</p>
            <ul>
              <li><CheckCircle2 size={22} /><div><b>{pick('X-Ray, CBCT และสแกนเนอร์ในช่องปาก', 'X-ray, CBCT & intraoral scanners')}</b><span>{pick('พร้อมบริการติดตั้งถึงที่', 'Including on-site installation.')}</span></div></li>
              <li><CheckCircle2 size={22} /><div><b>{pick('เครื่องพิมพ์ 3 มิติ สแกนเนอร์ และมิลลิ่ง', '3D printers, scanners & milling')}</b><span>{pick('ฮาร์ดแวร์ระดับแล็บ คู่กับซอฟต์แวร์ Exocad และการอบรม', 'Lab-grade hardware paired with Exocad software and training.')}</span></div></li>
              <li><CheckCircle2 size={22} /><div><b>{pick('อบรมและซัพพอร์ตแบบลงมือจริง', 'Hands-on training & support')}</b><span>{pick('ทีมงานพร้อมดูแลและให้คำปรึกษาต่อเนื่อง', 'Our team provides ongoing guidance and support.')}</span></div></li>
            </ul>
            <div style={{ marginTop: 24 }}><button className="btn btn-primary" onClick={() => navigate('/catalog?category=' + encodeURIComponent('เครื่องมือ/เครื่องจักร'))}>{pick('ดูเครื่องมือดิจิทัล', 'Explore machines')} <ArrowRight size={18} /></button></div>
          </div>
        </div>
      </section>

      <section className="section" style={{ background: 'var(--sand)' }}>
        <div className="wrap">
          <div className="section-head center">
            <span className="eyebrow">{pick('ทำไมต้องเลือกเรา', 'Why choose us')}</span>
            <h2 className="serif">{pick('คุณภาพรับรองมาตรฐานสากล', 'Quality certified to international standards')}</h2>
            <p>{pick('ทุกกลุ่มสินค้าผ่านการรับรองระบบคุณภาพ และเป็นสินค้าของแท้ตรวจสอบได้', 'Every product line is backed by recognised quality systems and genuine, traceable supply.')}</p>
          </div>
          <div className="trust-grid">
            {CERTS.map((c) => (
              <div key={c.code} className="trust-card"><div className="badge-ic"><ShieldCheck size={30} /></div><h3>{c.code}</h3><p>{pick(c.desc, c.descEn)}</p></div>
            ))}
          </div>
          <div className="stats">
            <div className="stat"><b>1,187</b><span>{pick('รายการสินค้า', 'Products')}</span></div>
            <div className="stat"><b>3</b><span>{pick('บริษัทในเครือ', 'Group companies')}</span></div>
            <div className="stat"><b>30+</b><span>{pick('ปีผลิตเอง', 'Years making')}</span></div>
            <div className="stat"><b>100%</b><span>{pick('สินค้าของแท้', 'Genuine brands')}</span></div>
          </div>
        </div>
      </section>

      <Divisions />
      <section className="section"><div className="wrap"><CtaBand /></div></section>
    </>
  );
}

function CatGrid() {
  const { pick } = useStore();
  return (
    <div className="catbanners">
      {CATEGORIES.map((c) => (
        <a key={c.key} className="catbanner" href={`#${catHref(c)}`} aria-label={pick(c.nameTh, c.nameEn)}>
          <img src={CAT_IMG[c.key]} alt={pick(c.nameTh, c.nameEn)} loading="lazy" />
        </a>
      ))}
    </div>
  );
}

function Divisions() {
  const { navigate, pick } = useStore();
  return (
    <section className="section">
      <div className="wrap">
        <div className="section-head">
          <span className="eyebrow">{pick('กลุ่มบริษัท Prominent', 'The Prominent group')}</span>
          <h2 className="serif">{pick('สามบริษัท หนึ่งพันธมิตรทันตกรรม', 'Three companies, one dental partner')}</h2>
          <p>{pick('ตัวแทนจำหน่าย แล็บทันตกรรมของเราเอง และโรงงานผลิต — ดูแลคุณครบทั้งวงจร', 'Distribution, an in-house dental lab, and manufacturing — supporting you across the whole chain.')}</p>
        </div>
        <div className="div-grid">
          {ARMS.map((a) => (
            <button key={a.key} className="div-card" onClick={() => navigate(a.key === 'lab' ? '/lab' : a.key === 'manufacturing' ? '/manufacturing' : '/about')}>
              <div className="dh" style={{ background: ARM_BG[a.key] }}><Ic name={a.icon} size={46} /></div>
              <div className="db"><h3>{a.name}</h3><p>{pick(a.blurb, a.blurbEn)}</p></div>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

function CtaBand() {
  const { pick } = useStore();
  return (
    <div className="cta-band">
      <div>
        <h2 className="serif">{pick('ไม่แน่ใจว่าควรใช้สินค้าไหน?', 'Not sure which product is right?')}</h2>
        <p>{pick('บอกเราเกี่ยวกับคลินิกหรือแล็บของคุณ ทีมงานจะแนะนำสินค้าที่เหมาะที่สุด พร้อมเสนอราคาให้ทันทีผ่าน LINE', 'Tell us about your clinic or lab and our team will recommend the best fit — with a quote on the spot via LINE.')}</p>
      </div>
      <div className="cta-btns">
        <a className="btn btn-line" href={COMPANY.line.url} target="_blank" rel="noreferrer"><LineIcon size={18} /> LINE {COMPANY.line.id}</a>
        <a className="btn btn-ghost" href={`tel:${COMPANY.phone}`} style={{ background: 'transparent', color: '#fff', borderColor: 'rgba(255,255,255,.3)' }}><Phone size={18} /> {COMPANY.phone}</a>
      </div>
    </div>
  );
}

// ── About ───────────────────────────────────────────────────────────────────
export function AboutPage() {
  const { pick } = useStore();
  return (
    <>
      <PageHero eyebrow={pick('เกี่ยวกับ Prominent', 'About Prominent')} title={pick('พันธมิตรด้านวัสดุทันตกรรม ที่สร้างบนคุณภาพและความใส่ใจ', 'A dental supply partner built on quality and care')} desc={pick(COMPANY.introTh, COMPANY.introEn)} />
      <section className="section">
        <div className="wrap split">
          <div>
            <span className="eyebrow">{pick('เรื่องราวของเรา', 'Our story')}</span>
            <h2 className="serif" style={{ fontSize: 'clamp(1.7rem,3.4vw,2.4rem)', margin: '14px 0 16px' }}>{pick('วัสดุทันตกรรมครบวงจร ในราคาที่เข้าถึงได้', 'Comprehensive dental supply, the affordable way')}</h2>
            <p style={{ color: 'var(--muted)', marginBottom: 14 }}>{pick('เรานำเสนอสินค้าหลากหลายที่ครอบคลุมทุกงานทันตกรรม — ตั้งแต่วัสดุสิ้นเปลืองประจำวันของคลินิก ไปจนถึงการวางระบบแล็บดิจิทัลครบวงจร ด้วยสินค้าของแท้และการดูแลที่จริงใจ', "We offer a wide range of products for every dental practice — from a clinic's daily consumables to a full digital lab build — with genuine brands and real support.")}</p>
            <p style={{ color: 'var(--muted)' }}>{pick('ปัจจุบันกลุ่ม Prominent ประกอบด้วยสามบริษัท — ตัวแทนจำหน่าย แล็บทันตกรรม และโรงงานผลิต — ทำให้เราดูแลลูกค้าได้ตลอดทั้งห่วงโซ่งานทันตกรรม', 'Today the Prominent group spans three companies — distribution, an in-house dental laboratory, and manufacturing — supporting customers across the entire supply chain.')}</p>
            <div className="stats" style={{ marginTop: 34, gridTemplateColumns: 'repeat(3,1fr)' }}>
              <div className="stat"><b>6</b><span>{pick('กลุ่มสินค้า', 'Product lines')}</span></div>
              <div className="stat"><b>3</b><span>{pick('บริษัทในเครือ', 'Group companies')}</span></div>
              <div className="stat"><b>ISO</b><span>9001 &amp; 13485</span></div>
            </div>
          </div>
          <div className="split-art"><img src="/arm-distribution.jpg" alt="" className="split-img" /><div className="pill" style={{ top: 18, left: 18 }}><span style={{ width: 10, height: 10, borderRadius: 9, background: 'var(--coral)' }} /> {pick('ไว้วางใจโดยคลินิกและแล็บ', 'Trusted by clinics & labs')}</div></div>
        </div>
      </section>
      <section className="section" style={{ background: 'var(--sand)' }}>
        <div className="wrap"><div className="section-head"><span className="eyebrow">{pick('บริษัทในเครือ', 'Our companies')}</span><h2 className="serif">{pick('กลุ่มบริษัท Prominent', 'The Prominent group')}</h2></div><DivCards /></div>
      </section>
      <section className="section"><div className="wrap"><CtaBand /></div></section>
    </>
  );
}
function DivCards() {
  const { pick } = useStore();
  return (
    <div className="div-grid">
      {ARMS.map((a) => (
        <div key={a.key} className="div-card">
          <div className="dh" style={{ background: ARM_BG[a.key] }}><Ic name={a.icon} size={46} /></div>
          <div className="db"><h3>{a.name}</h3><p>{pick(a.blurb, a.blurbEn)}</p></div>
        </div>
      ))}
    </div>
  );
}

// ── Products ────────────────────────────────────────────────────────────────
export function ProductsPage() {
  const { pick } = useStore();
  return (
    <>
      <PageHero eyebrow={pick('สินค้า', 'Products')} title={pick('เลือกชมตามหมวด', 'Browse by category')} desc={pick('เลือกหมวดที่สนใจ แล้วเข้าสู่ระบบเพื่อดูราคาและสั่งซื้อ', 'Pick a category, then sign in to see prices and order.')} />
      <div className="wrap" style={{ paddingTop: 32 }}><img className="page-banner" src="/our-products.jpg" alt={pick('กลุ่มสินค้าที่เราผลิต', 'Our product range')} /></div>
      <section className="section"><div className="wrap"><CatGrid /></div></section>
    </>
  );
}

// ── Brands ──────────────────────────────────────────────────────────────────
export function BrandsPage() {
  const { pick } = useStore();
  return (
    <>
      <PageHero eyebrow={pick('แบรนด์', 'Brands')} title={pick('แบรนด์ชั้นนำที่เราจัดจำหน่ายและผลิตเอง', 'Brands we carry and make')} />
      <section className="section">
        <div className="wrap" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))', gap: 20 }}>
          {BRANDS.map((b) => (
            <div key={b.name} className="trust-card" style={{ textAlign: 'left' }}>
              <h3 style={{ fontFamily: "'Fraunces',serif", fontSize: '1.4rem' }}>{b.name}</h3>
              <p style={{ color: 'var(--teal-d)', fontWeight: 700, fontSize: '.78rem', margin: '4px 0 8px' }}>{b.tag}</p>
              <p>{pick(b.desc, b.descEn)}</p>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

// ── Lab ─────────────────────────────────────────────────────────────────────
export function LabPage() {
  const { pick } = useStore();
  const services = [
    { th: 'ครอบฟัน · สะพานฟัน · อินเลย์/ออนเลย์', en: 'Crowns · bridges · inlays/onlays' },
    { th: 'ฟันปลอมทั้งปาก · บางส่วน · แบบยืดหยุ่น', en: 'Full, partial & flexible dentures' },
    { th: 'รากเทียม: Custom Abutment · Screw-retained · Full-arch', en: 'Implants: custom abutments · screw-retained · full-arch' },
    { th: 'รีเทนเนอร์ · เครื่องมือจัดฟันแบบใส', en: 'Retainers · clear aligners' },
    { th: 'วีเนียร์และงานความงาม', en: 'Veneers & aesthetic work' },
    { th: 'งานดิจิทัล: CAD/CAM · พิมพ์ 3 มิติ · รับไฟล์สแกน', en: 'Digital: CAD/CAM · 3D printing · scan files' },
  ];
  return (
    <>
      <PageHero eyebrow="DentalPort" title={pick('แล็บทันตกรรมด้วยเทคโนโลยีดิจิทัล', 'A dental laboratory powered by digital technology')} desc={pick(ARMS[1].blurb, ARMS[1].blurbEn)} />
      <div className="wrap" style={{ paddingTop: 32 }}><img className="page-banner" src="/arm-lab.jpg" alt="" /></div>
      <section className="section">
        <div className="wrap" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(260px,1fr))', gap: 16 }}>
          {services.map((s) => (
            <div key={s.en} className="trust-card" style={{ textAlign: 'left', display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              <CheckCircle2 size={20} style={{ color: 'var(--teal)', flexShrink: 0, marginTop: 2 }} /> <span>{pick(s.th, s.en)}</span>
            </div>
          ))}
        </div>
      </section>
      <section className="section"><div className="wrap"><CtaBand /></div></section>
    </>
  );
}

// ── Manufacturing ───────────────────────────────────────────────────────────
export function ManufacturingPage() {
  const { pick } = useStore();
  const products = [
    { th: 'วัสดุพิมพ์ปาก', en: 'Impression materials' },
    { th: 'หน้ากากอนามัย · หมวกคลุมผม', en: 'Masks · bouffant caps' },
    { th: 'ถาดพิมพ์ปาก', en: 'Impression trays' },
    { th: 'แว็กซ์ทันตกรรม', en: 'Dental wax' },
    { th: 'วัสดุสำหรับงานฟันปลอม', en: 'Denture materials' },
  ];
  return (
    <>
      <PageHero eyebrow="Dentories · KPK" title={pick('โรงงานผลิตวัสดุทันตกรรม กว่า 30 ปี', 'Manufacturing dental materials for 30+ years')} desc={pick(ARMS[2].blurb, ARMS[2].blurbEn)} />
      <div className="wrap" style={{ paddingTop: 32 }}><img className="page-banner" src="/arm-manufacturing.jpg" alt="" /></div>
      <section className="section">
        <div className="wrap" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 16, marginBottom: 28 }}>
          {products.map((p) => (
            <div key={p.en} className="trust-card" style={{ textAlign: 'left', display: 'flex', gap: 12, alignItems: 'center' }}>
              <Factory size={20} style={{ color: 'var(--teal)', flexShrink: 0 }} /> <span>{pick(p.th, p.en)}</span>
            </div>
          ))}
        </div>
        <div className="wrap trust-grid">
          {CERTS.map((c) => (
            <div key={c.code} className="trust-card"><div className="badge-ic"><ShieldCheck size={30} /></div><h3>{c.code}</h3><p>{pick(c.desc, c.descEn)}</p></div>
          ))}
        </div>
      </section>
    </>
  );
}

// ── Contact ─────────────────────────────────────────────────────────────────
export function ContactPage() {
  const { pick } = useStore();
  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const subject = `Website enquiry — ${f.get('name') || ''}`;
    const body = `Name: ${f.get('name') || ''}\nEmail: ${f.get('email') || ''}\nPhone: ${f.get('phone') || ''}\nTopic: ${f.get('topic') || ''}\n\n${f.get('message') || ''}`;
    window.location.href = `mailto:${COMPANY.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  }
  const opts = pick(
    ['สอบถามทั่วไป', 'วัสดุสำหรับคลินิก', 'แล็บทันตกรรม', 'เครื่องมือดิจิทัล', 'รากเทียม', 'หัวกรอ/ด้ามกรอ'],
    ['General enquiry', 'Dental clinic supplies', 'Dental laboratory', 'Machines & digital', 'Implants', 'Burs & handpieces'],
  );
  return (
    <>
      <PageHero eyebrow={pick('ติดต่อเรา', 'Contact us')} title={pick('เราพร้อมช่วยคุณเลือก สั่งซื้อ และติดตั้ง', "We're here to help you choose, order and install")} desc={pick('ติดต่อเราทางโทรศัพท์ อีเมล หรือ LINE — หรือส่งข้อความ แล้วเราจะติดต่อกลับพร้อมคำแนะนำและใบเสนอราคา', "Reach us by phone, email or LINE — or send a message and we'll reply with a recommendation and quote.")} />
      <section className="section">
        <div className="wrap contact-grid">
          <div>
            <div className="ci-row"><div className="ci-ic"><MapPin size={21} /></div><div><b>{pick('ที่อยู่', 'Address')}</b><p>{pick(COMPANY.address.line, COMPANY.address.lineEn)}</p></div></div>
            <div className="ci-row"><div className="ci-ic"><Phone size={21} /></div><div><b>{pick('โทรศัพท์', 'Phone')}</b><a href={`tel:${COMPANY.phone}`}>{COMPANY.phone}</a></div></div>
            <div className="ci-row"><div className="ci-ic"><Mail size={21} /></div><div><b>{pick('อีเมล', 'Email')}</b><a href={`mailto:${COMPANY.email}`}>{COMPANY.email}</a></div></div>
            <div className="ci-row"><div className="ci-ic"><LineIcon size={21} /></div><div><b>LINE</b><a href={COMPANY.line.url} target="_blank" rel="noreferrer">{COMPANY.line.id}</a></div></div>
            <div style={{ borderRadius: 'var(--r-md)', overflow: 'hidden', border: '1px solid var(--line)', marginTop: 24, height: 240 }}>
              <iframe title={pick('แผนที่ Prominent', 'Prominent location')} loading="lazy" referrerPolicy="no-referrer-when-downgrade" style={{ width: '100%', height: '100%', border: 0 }}
                src="https://www.google.com/maps?q=Soi%20Inthamara%2019%20Samsen%20Nai%20Phaya%20Thai%20Bangkok%2010400&output=embed" />
            </div>
          </div>
          <form className="form" onSubmit={submit}>
            <h3 className="serif" style={{ fontSize: '1.4rem', marginBottom: 6 }}>{pick('ส่งข้อความถึงเรา', 'Send us a message')}</h3>
            <p style={{ color: 'var(--muted)', fontSize: '.9rem', marginBottom: 20 }}>{pick('ช่องที่มี * จำเป็นต้องกรอก', 'Fields marked * are required.')}</p>
            <div className="frow">
              <div className="fg"><label>{pick('ชื่อ', 'Name')} *</label><input name="name" required placeholder={pick('ชื่อของคุณ / คลินิก', 'Your name / clinic')} /></div>
              <div className="fg"><label>{pick('เบอร์โทร', 'Phone')} *</label><input name="phone" required placeholder="08x-xxx-xxxx" /></div>
            </div>
            <div className="fg"><label>{pick('อีเมล', 'Email')}</label><input name="email" type="email" placeholder="you@email.com" /></div>
            <div className="fg"><label>{pick('สนใจเรื่อง', "I'm interested in")}</label>
              <select name="topic">{opts.map((o) => <option key={o}>{o}</option>)}</select></div>
            <div className="fg"><label>{pick('ข้อความ', 'Message')}</label><textarea name="message" rows={4} placeholder={pick('บอกเราว่าคุณต้องการอะไร…', 'Tell us what you need…')} /></div>
            <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }} type="submit">{pick('ส่งข้อความ', 'Send message')} <Send size={18} /></button>
          </form>
        </div>
      </section>
    </>
  );
}

// ── shared ──────────────────────────────────────────────────────────────────
function PageHero({ eyebrow, title, desc }: { eyebrow: string; title: string; desc?: string }) {
  return (
    <div className="page-hero">
      <div className="wrap">
        <span className="eyebrow">{eyebrow}</span>
        <h1 className="serif">{title}</h1>
        {desc && <p>{desc}</p>}
      </div>
    </div>
  );
}
