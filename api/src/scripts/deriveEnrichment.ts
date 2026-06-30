import 'dotenv/config';
import { prisma } from '../db/prisma.js';

// Bulk-derive brand + category for the public catalog from product names/keywords.
// This is a FIRST PASS for SEO facets — high-precision where the name is clear,
// blank where it isn't (staff refine + add descriptions via the admin editor).
// Re-runnable: rows a human edited (source='manual') are never touched.
//
//   Run:  npx tsx src/scripts/deriveEnrichment.ts

// Brand rules — conservative/high-precision. A product matches the FIRST rule whose
// regex hits its combined name text; most generic consumables match nothing (brand '').
const BRAND_RULES: { re: RegExp; brand: string }[] = [
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

// Category rules — broader. Each: a Thai label + English label + match regex over the
// combined nameTh + nameEn + keywords. First match wins, so order = specific → general.
const CATEGORY_RULES: { th: string; en: string; re: RegExp }[] = [
  { th: 'รากเทียม', en: 'Implant', re: /รากเทียม|\bimplant\b|abutment|healing cap/i },
  { th: 'เครื่องมือ/เครื่องจักร', en: 'Machine', re: /scanner|สแกน|3d|printer|พิมพ์ ?3 ?มิติ|milling|มิลลิ่ง|x-?ray|เอกซเรย์|เครื่อง/i },
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

function deriveBrand(text: string): string {
  for (const r of BRAND_RULES) if (r.re.test(text)) return r.brand;
  return '';
}
function deriveCategory(text: string): { th: string; en: string } {
  for (const r of CATEGORY_RULES) if (r.re.test(text)) return { th: r.th, en: r.en };
  return { th: '', en: '' };
}

async function main() {
  const products = await prisma.product.findMany({ select: { sku: true, nameEn: true, nameTh: true, keywords: true } });
  // Don't clobber staff edits.
  const manual = new Set(
    (await prisma.productEnrichment.findMany({ where: { source: 'manual' }, select: { sku: true } })).map((e) => e.sku),
  );

  let withBrand = 0;
  let withCat = 0;
  let written = 0;
  let skipped = 0;
  const catCounts = new Map<string, number>();

  for (const p of products) {
    if (manual.has(p.sku)) { skipped++; continue; }
    const text = `${p.nameTh} ${p.nameEn} ${p.keywords.join(' ')}`;
    const brand = deriveBrand(text);
    const cat = deriveCategory(text);
    if (brand) withBrand++;
    if (cat.th) { withCat++; catCounts.set(cat.th, (catCounts.get(cat.th) ?? 0) + 1); }

    await prisma.productEnrichment.upsert({
      where: { sku: p.sku },
      update: { brand, category: cat.th, categoryEn: cat.en, source: 'derived' },
      create: { sku: p.sku, brand, category: cat.th, categoryEn: cat.en, source: 'derived' },
    });
    written++;
  }

  // eslint-disable-next-line no-console
  console.log(`[enrich] ${written} written, ${skipped} manual skipped | brand: ${withBrand}, category: ${withCat} of ${products.length}`);
  // eslint-disable-next-line no-console
  console.log('[enrich] category breakdown:');
  for (const [c, n] of [...catCounts.entries()].sort((a, b) => b[1] - a[1])) {
    // eslint-disable-next-line no-console
    console.log(`  ${n.toString().padStart(4)}  ${c}`);
  }
  await prisma.$disconnect();
}

void main();
