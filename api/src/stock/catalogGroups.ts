// Catalog product GROUPS — the merchandising taxonomy (lab + digital + clinical +
// equipment), grouped by material family / clinical procedure (the industry standard,
// not by brand). Thai names verified against real Thai dental suppliers. Groups are
// code-defined (a fixed vocabulary); a product's assignment is stored in
// Product.catalogGroup. See docs research + memory dental-catalog-taxonomy.

export type Pillar = 'lab' | 'digital' | 'clinical' | 'equipment';

export interface CatalogGroup {
  key: string;
  code: string; // fixed 2-letter product-code prefix (e.g. "IM" → IM01, IM02…)
  nameTh: string;
  nameEn: string;
  pillar: Pillar;
}

// Order matters only for display (grouped by pillar, in this order). `code` values are the
// human-facing product-code prefixes — globally unique, never reused.
export const CATALOG_GROUPS: CatalogGroup[] = [
  // ── Lab / prosthetic ──
  { key: 'impression', code: 'IM', nameTh: 'วัสดุพิมพ์ปากและถาดพิมพ์', nameEn: 'Impression & Trays', pillar: 'lab' },
  { key: 'acrylic', code: 'AC', nameTh: 'อะคริลิกและโมโนเมอร์', nameEn: 'Acrylics & Monomers', pillar: 'lab' },
  { key: 'teeth', code: 'TE', nameTh: 'ฟันปลอม', nameEn: 'Denture Teeth', pillar: 'lab' },
  { key: 'temp_crown', code: 'TC', nameTh: 'วัสดุครอบชั่วคราว', nameEn: 'Temp-Crown / Provisional', pillar: 'lab' },
  { key: 'wax', code: 'WX', nameTh: 'แว็กซ์ทันตกรรม', nameEn: 'Dental Waxes', pillar: 'lab' },
  { key: 'investment', code: 'IV', nameTh: 'ปูนหุ้มและงานหล่อ', nameEn: 'Investment & Casting', pillar: 'lab' },
  { key: 'lab_finishing', code: 'FN', nameTh: 'วัสดุขัดแต่งและหัวกรอแล็บ', nameEn: 'Finishing & Lab Rotary', pillar: 'lab' },
  { key: 'articulator', code: 'AR', nameTh: 'อุปกรณ์สบฟัน', nameEn: 'Articulators & Occlusion', pillar: 'lab' },
  { key: 'porcelain', code: 'PC', nameTh: 'พอร์ซเลนและเซรามิก', nameEn: 'Porcelain & Ceramics', pillar: 'lab' },
  { key: 'gypsum', code: 'GY', nameTh: 'ปูนและวัสดุทำโมเดล', nameEn: 'Gypsum & Model Materials', pillar: 'lab' },
  { key: 'reline', code: 'RL', nameTh: 'วัสดุเสริมฐานและซ่อมฟันปลอม', nameEn: 'Reline & Repair', pillar: 'lab' },
  { key: 'alloy', code: 'AL', nameTh: 'โลหะผสมหล่อ', nameEn: 'Casting Alloys', pillar: 'lab' },
  // ── Digital ──
  { key: 'cadcam', code: 'CM', nameTh: 'แคดแคมและงานกัด', nameEn: 'CAD-CAM Milling', pillar: 'digital' },
  { key: 'printing', code: 'PR', nameTh: 'การพิมพ์ 3 มิติ', nameEn: '3D Printing', pillar: 'digital' },
  { key: 'scanner', code: 'SC', nameTh: 'เครื่องสแกน', nameEn: 'Scanners', pillar: 'digital' },
  // ── Clinical ──
  { key: 'restorative', code: 'RS', nameTh: 'วัสดุอุดฟัน', nameEn: 'Restorative', pillar: 'clinical' },
  { key: 'endo', code: 'EN', nameTh: 'รักษารากฟัน', nameEn: 'Endodontics', pillar: 'clinical' },
  { key: 'preventive', code: 'PV', nameTh: 'วัสดุเคลือบผิวฟันป้องกันฟันผุ', nameEn: 'Preventive', pillar: 'clinical' },
  { key: 'ortho', code: 'OR', nameTh: 'จัดฟัน', nameEn: 'Orthodontics', pillar: 'clinical' },
  { key: 'surgery', code: 'SG', nameTh: 'ศัลยกรรมช่องปาก', nameEn: 'Oral Surgery', pillar: 'clinical' },
  { key: 'perio', code: 'PD', nameTh: 'ปริทันต์', nameEn: 'Periodontics', pillar: 'clinical' },
  { key: 'implant', code: 'IP', nameTh: 'รากเทียม', nameEn: 'Implants', pillar: 'clinical' },
  { key: 'whitening', code: 'WH', nameTh: 'ฟอกสีฟัน', nameEn: 'Whitening', pillar: 'clinical' },
  { key: 'anesthetic', code: 'AN', nameTh: 'ยาชาและเข็มฉีดยา', nameEn: 'Anesthetics & Injectables', pillar: 'clinical' },
  { key: 'pedo', code: 'PE', nameTh: 'ทันตกรรมสำหรับเด็ก', nameEn: 'Pediatric', pillar: 'clinical' },
  { key: 'pharma', code: 'PH', nameTh: 'เวชภัณฑ์ทางทันตกรรม', nameEn: 'Pharmaceuticals & Medicaments', pillar: 'clinical' },
  { key: 'isolation', code: 'IS', nameTh: 'แผ่นยางกันน้ำลาย', nameEn: 'Isolation (Rubber Dam)', pillar: 'clinical' },
  // ── Equipment & shared supplies ──
  { key: 'lab_equipment', code: 'LE', nameTh: 'เครื่องจักรแล็บ', nameEn: 'Lab Equipment & Machines', pillar: 'equipment' },
  { key: 'imaging', code: 'XR', nameTh: 'เครื่องเอกซเรย์และครุภัณฑ์', nameEn: 'Imaging & Capital Equipment', pillar: 'equipment' },
  { key: 'ppe', code: 'PP', nameTh: 'ป้องกันโรคติดต่อและน้ำยาฆ่าเชื้อ', nameEn: 'Infection Control & PPE', pillar: 'equipment' },
  { key: 'separator', code: 'SP', nameTh: 'สารแยกแบบและสารเสริม', nameEn: 'Separators & Auxiliaries', pillar: 'equipment' },
  { key: 'clinical_bur', code: 'BU', nameTh: 'หัวกรอคลินิก', nameEn: 'Clinical Burs', pillar: 'equipment' },
  { key: 'instrument', code: 'IN', nameTh: 'เครื่องมือทันตกรรม', nameEn: 'Hand Instruments', pillar: 'equipment' },
  { key: 'clinical_equipment', code: 'CE', nameTh: 'เครื่องมือคลินิก', nameEn: 'Clinical Small Equipment', pillar: 'equipment' },
  { key: 'dental_unit', code: 'UN', nameTh: 'ยูนิตและเก้าอี้ทำฟัน', nameEn: 'Chairs & Dental Units', pillar: 'equipment' },
  { key: 'sterilizer', code: 'ST', nameTh: 'เครื่องนึ่งฆ่าเชื้อ', nameEn: 'Sterilization Equipment', pillar: 'equipment' },
];

export const GROUP_KEYS = new Set(CATALOG_GROUPS.map((g) => g.key));
export const GROUP_CODE = new Map(CATALOG_GROUPS.map((g) => [g.key, g.code]));

// Ordered auto-assign rules (FIRST match wins → specific before general). Each tests the
// lowercased "nameEn + nameTh + keywords" of a product. Tuned to Prominent's ACTUAL catalog
// (which has clinical items — endo files, blades, dam, fluoride — hiding in category 07).
const RULES: Array<{ group: string; re: RegExp }> = [
  { group: 'teeth', re: /major ?(dent|plus)|ฟันปลอม|denture t(eeth|ooth)|acrylic tooth/i },
  // ── clinical items sitting in the cat-07 grab-bag ──
  { group: 'endo', re: /gutta ?percha|กัตตา|k-?file|h-?file|barbed|broach|paper ?point|paste carrier|reamer|คลองราก|เอ็นโด|endo(?!crown)|เครื่องขยายคลอง/i },
  { group: 'surgery', re: /feather blade|surgical blade|scalpel|ใบมีด|surgical needle|\bsuture|ไหมเย็บ|เย็บไหม|เข็มเย็บ|novosyn|bone graft|กระดูกเทียม|elevator|forceps|คีมถอน|ที่งัด|retractor|ถ่างปาก|เปิดปาก/i },
  { group: 'isolation', re: /dental dam|rubber dam|ยางกันน้ำลาย|แผ่นยางกัน|dappen/i },
  { group: 'preventive', re: /fluoride|ฟลูออไรด์|เคลือบหลุมร่องฟัน|\bsealant|ป้องกันฟันผุ|เคลือบฟัน/i },
  { group: 'ortho', re: /aligner|จัดฟันใส|แผ่น.*จัดฟัน|leone|retainer box|กล่องรีเทนเนอร์|bracket|แบร็ก|archwire|ลวดจัดฟัน|ยางจัดฟัน|power ?chain/i },
  { group: 'pedo', re: /milk teeth|ฟันน้ำนม|kids.*teeth box|เด็ก.*ฟัน/i },
  { group: 'anesthetic', re: /dental needle|เข็มฉีดยา|ยาชา|lidocaine|cartridge|\bsyringe\b|กระบอกฉีด/i },
  { group: 'restorative', re: /polycarboxylate|glass ?ionomer|composite|บอนดิ้ง|เรซินคอมโพสิต|\bbonding\b|retraction cord|แยกเหงือก|\bwedge\b|matrix|matrices/i },
  // ── lab / prosthetic ──
  { group: 'temp_crown', re: /tempor|temp ?crown|dentine|h\.?c\.?d\b|ครอบชั่วคราว|temporary/i },
  { group: 'acrylic', re: /self ?cure|heat ?cure|monomer|โมโนเมอร์|tray material|ortho ?(plast|dppf|pmf)|ผงสี.*ortho|ผงสีชมพู|major base|vertex|ผงสำหรับทำฐาน|ผงต้ม|acrylic|อะคริลิก|hybird|hybrid|ผงอะคริลิค|ฐานฟันปลอม|hard splint|splint|เฝือกสบ/i },
  { group: 'wax', re: /\bwax\b|แว็กซ์|เว็กซ์|aluwax|occlusal plate|แผ่นวัดการเรียงฟัน|ตะแกรง|เรียงฟัน/i },
  { group: 'investment', re: /bellavest|wirovest|begosol|investment|ปูนหุ้ม|casting|twin ?pins|special nail|set of nail|grid stainless|เลื่อยตัดปูน|dental saw|\bnail/i },
  { group: 'gypsum', re: /plaster|dental stone|die stone|ปูนปลาสเตอร์|ปูนโมเดล|ปูน ?ortho|\bstone\b|โมเดล/i },
  { group: 'lab_finishing', re: /diamond|หัวกรอ|\bbur\b|fissure|ฟิชเชอร์|carbide|steel ?no|\bhp\d|polisher|felt|ผ้าทราย|pumice|ทรายขัด|สักหลาด|ผ้าขัด|buff|ไขวัว|ขัดงาน|กรอแต่ง|\bdisc|ยางขัด|mandrel|แมนเดล|saitex|sandpaper|abrasive|แปรง|brush|หินขัด/i },
  { group: 'articulator', re: /articulating paper|กระดาษ.*สบ|ตรวจสอบจุดสบ|articulator|จำลองการสบ|สบฟัน|double check/i },
  { group: 'scanner', re: /scanningspray|aesub|scan ?spray|สแกน|scanner/i },
  { group: 'imaging', re: /owandy|x-?ray|cbct|panoramic|\bceph|intraoral sensor|เอกซเรย์|\bsensor\b/i },
  { group: 'instrument', re: /glass slab|mixing dish|ถ้วยสำหรับผสม|แผ่นแก้ว|mouth mirror|กระจกส่องปาก|tweezers|ปากคีบ|explorer|เครื่องมือตรวจ/i },
  { group: 'lab_equipment', re: /micromotor|foot ?switch|dust collector|vibrator|sandblast|เครื่องเป่าทราย|เครื่องเขย่า|เครื่องดูดฝุ่น|กรองฝุ่น|\bdriver\b|\bmachine\b|เครื่อง|ขวด|หลอดดูด/i },
  { group: 'separator', re: /vaseline|silicone release|release agent|สารแยก|แยกชิ้น|หล่อลื่น|separating|valplast/i },
  { group: 'impression', re: /alginmax|cromax|gelmax|alginate|ผงพิมพ์ปาก|impression|วัสดุพิมพ์|ถาดพิมพ์|พิมพ์ปาก|full arch|bite ?registration|\btray\b|silicone|ซิลิโคน|putty|\bvps\b|\bpvs\b|ormadent|ormaplus|ormamax|ormactivator|mixing tip|intra-?oral tip/i },
  { group: 'ppe', re: /glove|\bmask\b|\bcap\b|gown|gauze|suction|ถุงมือ|หน้ากาก|หมวก|ผ้าก๊อซ|เสื้อกาวน์|ดูดน้ำลาย|non ?woven|ก๊อซ|กาวน์|uv.*shield|กันแสง/i },
];

// Category (first SKU segment) → default group, applied only when NO keyword rule matched.
// Each Express category IS predominantly one product type (except the 07/08 grab-bags, which
// stay keyword-only so genuinely mixed items fall through to manual assignment).
const CATEGORY_FALLBACK: Record<string, string> = {
  '01': 'acrylic', '02': 'lab_finishing', '03': 'lab_finishing', '04': 'wax',
  '05': 'investment', '06': 'investment', '16': 'imaging', '20': 'separator',
  '09': 'teeth', '19': 'teeth', '90': 'teeth', '91': 'teeth',
};

// Suggest a group for one product, or null if nothing matches (→ manual assignment).
export function autoAssignGroup(p: { sku: string; nameEn: string; nameTh: string; keywords?: string[] }): string | null {
  const hay = `${p.nameEn} ${p.nameTh} ${(p.keywords ?? []).join(' ')}`.toLowerCase();
  for (const r of RULES) if (r.re.test(hay)) return r.group;
  return CATEGORY_FALLBACK[p.sku.split('-')[0]] ?? null;
}
