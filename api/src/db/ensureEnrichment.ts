import { prisma } from './prisma.js';

// Brand/category derivation for the Diana public catalog facets. Shared by the
// boot-time seeder below and scripts/deriveEnrichment.ts. High-precision brand
// rules (blank when unclear); broader category rules, first match wins.

export const BRAND_RULES: { re: RegExp; brand: string }[] = [
  { re: /\bbego\b|begosol|bellavest|wirovest|wironit|wirogel|wirofine/i, brand: 'BEGO' },
  { re: /valplast/i, brand: 'Valplast' },
  { re: /\bmajor\b/i, brand: 'Major' },
  { re: /cadstar|cad ?star/i, brand: 'CADstar' },
  { re: /dentory/i, brand: 'Dentory' },
  { re: /sunshine/i, brand: 'Sunshine' },
  { re: /ivoclar|ips ?e\.?max|emax/i, brand: 'Ivoclar' },
  { re: /\bgc\b/i, brand: 'GC' },
  { re: /\b3m\b/i, brand: '3M' },
  { re: /dentsply|maillefer|protaper/i, brand: 'Dentsply' },
];

export const CATEGORY_RULES: { th: string; en: string; re: RegExp }[] = [
  { th: 'รากเทียม', en: 'Implant', re: /รากเทียม|\bimplant\b|abutment|healing cap/i },
  { th: 'เครื่องมือ/เครื่องจักร', en: 'Machine', re: /scanner|สแกน|3d|พิมพ์ ?3 ?มิติ|milling|มิลลิ่ง|x-?ray|เอกซเรย์|เครื่อง/i },
  { th: 'ด้ามกรอ/ไมโครมอเตอร์', en: 'Handpiece', re: /handpiece|ด้ามกรอ|micromotor|ไมโครมอเตอร์|contra ?angle/i },
  { th: 'หัวกรอ', en: 'Burs', re: /หัวกรอ|\bbur\b|burs|diamond|คาร์ไบด์|carbide|stone point/i },
  { th: 'รักษาคลองรากฟัน', en: 'Endodontics', re: /คลองรากฟัน|\bendo|\bfile\b|ไฟล์|gutta|เกจ์ตา/i },
  { th: 'จัดฟัน', en: 'Orthodontics', re: /จัดฟัน|ortho|bracket|แบร็กเก็ต|ลวด|\bwire\b|ดัดลวด|elastic/i },
  { th: 'วัสดุพิมพ์ปาก', en: 'Impression', re: /พิมพ์ปาก|impression|alginate|อัลจิเนต|ผงพิมพ์|silicone|ซิลิโคน|tray|ถาดพิมพ์/i },
  { th: 'ฟันปลอม/ฟันยาง', en: 'Denture & Teeth', re: /ฟันปลอม|\bdenture\b|\bteeth\b|รีเทนเนอร์|retainer|ซี่ฟัน/i },
  { th: 'อะคริลิก/เรซิน', en: 'Acrylic & Resin', re: /อะคริลิก|acrylic|monomer|โมโนเมอร์|เรซิน|resin|tempory crown|ฐานฟันปลอม|composite|คอมโพสิต/i },
  { th: 'ปูน/สโตน', en: 'Plaster & Stone', re: /ปูน|plaster|\bstone\b|สโตน|die ?stone|ปลาสเตอร์|investment|ลงเบ้า/i },
  { th: 'แว็กซ์', en: 'Wax', re: /แว็กซ์|\bwax\b|ขี้ผึ้ง/i },
  { th: 'ขัด/แต่งงาน', en: 'Polishing', re: /ขัด|polish|แต่งงาน|wheel|จาน|แผ่นกรอ|disc/i },
  { th: 'เคมีภัณฑ์/น้ำยา', en: 'Chemicals', re: /น้ำยา|liquid|สเปรย์|spray|solution|sอลูชั่น|disinfect|ฆ่าเชื้อ/i },
  { th: 'ของใช้สิ้นเปลือง/PPE', en: 'Disposables & PPE', re: /ถุงมือ|glove|หน้ากาก|mask|หมวก|\bcap\b|เสื้อกาวน์|gown|gauze|ผ้าก๊อซ|suction|ดูดน้ำลาย|เข็มฉีดยา|syringe|cotton|สำลี/i },
];

export function deriveBrand(text: string): string {
  for (const r of BRAND_RULES) if (r.re.test(text)) return r.brand;
  return '';
}
export function deriveCategory(text: string): { th: string; en: string } {
  for (const r of CATEGORY_RULES) if (r.re.test(text)) return { th: r.th, en: r.en };
  return { th: '', en: '' };
}

// Seed ProductEnrichment on boot when empty (fresh deploy), mirroring ensureCatalog.
// Skips entirely once any rows exist, so it never re-runs or clobbers staff edits.
export async function ensureEnrichment(): Promise<void> {
  try {
    if ((await prisma.productEnrichment.count()) > 0) return;
    const products = await prisma.product.findMany({ select: { sku: true, nameEn: true, nameTh: true, keywords: true } });
    if (products.length === 0) return;
    const data = products.map((p) => {
      const text = `${p.nameTh} ${p.nameEn} ${p.keywords.join(' ')}`;
      const cat = deriveCategory(text);
      return { sku: p.sku, brand: deriveBrand(text), category: cat.th, categoryEn: cat.en, source: 'derived' };
    });
    const res = await prisma.productEnrichment.createMany({ data, skipDuplicates: true });
    // eslint-disable-next-line no-console
    console.log(`[enrichment] derived ${res.count} products (brand/category facets)`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[enrichment] ensureEnrichment failed', err);
  }
}
