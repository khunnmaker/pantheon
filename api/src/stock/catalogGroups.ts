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

// ── Sub-groups ───────────────────────────────────────────────────────────
// A second level under a group: a 2-letter code (unique WITHIN its group) + names. The
// product code becomes group + subgroup + number → "IMAL01" (impression/alginate). Only
// groups that benefit are subdivided; others have no subgroups (code stays group-level).
export interface SubGroup {
  code: string; // 2-letter, unique within the parent group
  nameTh: string;
  nameEn: string;
}

export const SUBGROUPS: Record<string, SubGroup[]> = {
  impression: [
    { code: 'AL', nameTh: 'อัลจิเนต', nameEn: 'Alginate' },
    { code: 'PV', nameTh: 'ซิลิโคน (PVS)', nameEn: 'PVS / Silicone' },
    { code: 'PE', nameTh: 'โพลีอีเทอร์', nameEn: 'Polyether' },
    { code: 'TR', nameTh: 'ถาดพิมพ์ปาก', nameEn: 'Trays' },
    { code: 'BR', nameTh: 'วัสดุกัดสบ', nameEn: 'Bite Registration' },
  ],
  acrylic: [
    { code: 'SC', nameTh: 'เซลฟ์เคียว (แข็งเร็ว)', nameEn: 'Self-cure' },
    { code: 'HC', nameTh: 'ฮีทเคียว (ต้ม)', nameEn: 'Heat-cure' },
    { code: 'TM', nameTh: 'ผงทำถาดพิมพ์', nameEn: 'Tray Material' },
    { code: 'OP', nameTh: 'ผงออร์โธ', nameEn: 'Ortho Plast' },
    { code: 'MO', nameTh: 'โมโนเมอร์', nameEn: 'Monomer' },
  ],
  endo: [
    { code: 'FI', nameTh: 'ไฟล์/เครื่องขยายคลอง', nameEn: 'Files' },
    { code: 'GP', nameTh: 'กัตตาเปอร์ชา', nameEn: 'Gutta Percha' },
    { code: 'SE', nameTh: 'ซีลเลอร์', nameEn: 'Sealers' },
    { code: 'PA', nameTh: 'เปเปอร์พอยต์', nameEn: 'Paper Points' },
    { code: 'IR', nameTh: 'น้ำยาล้างคลอง', nameEn: 'Irrigants' },
  ],
  lab_finishing: [
    { code: 'DI', nameTh: 'หัวกรอเพชร', nameEn: 'Diamonds' },
    { code: 'CA', nameTh: 'หัวกรอคาร์ไบด์/สตีล', nameEn: 'Carbide / Steel' },
    { code: 'ST', nameTh: 'หินขัด', nameEn: 'Stones' },
    { code: 'PO', nameTh: 'ยางขัด/สักหลาด', nameEn: 'Polishers' },
    { code: 'SA', nameTh: 'ผ้าทราย/กระดาษทราย', nameEn: 'Sand Cloth' },
    { code: 'MA', nameTh: 'ก้านแมนเดรล', nameEn: 'Mandrels' },
    { code: 'BR', nameTh: 'แปรงขัด', nameEn: 'Brushes' },
    { code: 'PU', nameTh: 'ผงขัด (พูมิช)', nameEn: 'Pumice' },
  ],
  surgery: [
    { code: 'BL', nameTh: 'ใบมีดผ่าตัด', nameEn: 'Blades' },
    { code: 'SU', nameTh: 'ไหมเย็บแผล', nameEn: 'Sutures' },
    { code: 'FO', nameTh: 'คีมถอนฟัน', nameEn: 'Forceps' },
    { code: 'EL', nameTh: 'ที่งัดราก', nameEn: 'Elevators' },
    { code: 'BG', nameTh: 'กระดูกเทียม/เมมเบรน', nameEn: 'Bone Graft / Membrane' },
    { code: 'RE', nameTh: 'อุปกรณ์ถ่างปาก', nameEn: 'Retractors' },
  ],
  ppe: [
    { code: 'GL', nameTh: 'ถุงมือ', nameEn: 'Gloves' },
    { code: 'MK', nameTh: 'หน้ากาก', nameEn: 'Masks' },
    { code: 'GO', nameTh: 'เสื้อกาวน์', nameEn: 'Gowns' },
    { code: 'GA', nameTh: 'ผ้าก๊อซ', nameEn: 'Gauze' },
    { code: 'SU', nameTh: 'ดูดน้ำลาย', nameEn: 'Suction' },
    { code: 'CA', nameTh: 'หมวกคลุมผม', nameEn: 'Caps' },
  ],
  wax: [
    { code: 'BW', nameTh: 'แว็กซ์ฐาน (ชมพู)', nameEn: 'Base Plate Wax' },
    { code: 'UW', nameTh: 'ยูทิลิตี้แว็กซ์', nameEn: 'Utility Wax' },
    { code: 'SW', nameTh: 'สติกกี้แว็กซ์', nameEn: 'Sticky Wax' },
    { code: 'OC', nameTh: 'แผ่นเรียงฟัน/สบฟัน', nameEn: 'Occlusal Plates' },
  ],
  investment: [
    { code: 'IN', nameTh: 'ปูนหุ้ม', nameEn: 'Investment' },
    { code: 'PN', nameTh: 'หมุด/ตะปู', nameEn: 'Pins & Nails' },
    { code: 'SA', nameTh: 'เลื่อย/อุปกรณ์', nameEn: 'Saws & Tools' },
  ],
};

// Valid sub codes per group (for validation).
export const SUBGROUP_CODES: Record<string, Set<string>> = Object.fromEntries(
  Object.entries(SUBGROUPS).map(([g, subs]) => [g, new Set(subs.map((s) => s.code))]),
);

// Server-only auto-assign rules per group (FIRST match wins). Separate from SUBGROUPS so the
// RegExp is never serialized to the client.
const SUBGROUP_RULES: Record<string, Array<{ sub: string; re: RegExp }>> = {
  impression: [
    { sub: 'AL', re: /alginmax|cromax|gelmax|alginate|ผงพิมพ์ปาก|อัลจิเนต/i },
    { sub: 'PE', re: /polyether|โพลีอีเทอร์|impregum/i },
    { sub: 'PV', re: /\bpvs\b|\bvps\b|silicone|ซิลิโคน|putty|ormadent|ormaplus|ormamax|polyvinyl/i },
    { sub: 'BR', re: /bite|registration|กัดสบ|สร้างการกัด/i },
    { sub: 'TR', re: /tray|ถาดพิมพ์|full arch|พิมพ์ปาก/i },
  ],
  acrylic: [
    { sub: 'TM', re: /tray material/i },
    { sub: 'OP', re: /ortho ?(plast|dppf|pmf)|ผงสี.*ortho|ผงสีชมพู/i },
    { sub: 'HC', re: /heat ?cure|ต้ม/i },
    { sub: 'SC', re: /self ?cure|cold ?cure|แข็งเร็ว|ไม่ต้ม/i },
    { sub: 'MO', re: /monomer|โมโนเมอร์|น้ำยา/i },
  ],
  endo: [
    { sub: 'GP', re: /gutta|กัตตา/i },
    { sub: 'PA', re: /paper ?point|เปเปอร์/i },
    { sub: 'SE', re: /sealer|ซีลเลอร์/i },
    { sub: 'IR', re: /irrigant|naocl|edta|น้ำยาล้างคลอง/i },
    { sub: 'FI', re: /k-?file|h-?file|\bfile|reamer|ไฟล์|broach|เครื่องขยายคลอง|paste carrier|lentulo/i },
  ],
  lab_finishing: [
    { sub: 'DI', re: /diamond|เพชร/i },
    { sub: 'CA', re: /carbide|steel|\bhp\d/i },
    { sub: 'MA', re: /mandrel|แมนเดล|ก้าน/i },
    { sub: 'PU', re: /pumice|ทรายขัด/i },
    { sub: 'SA', re: /ผ้าทราย|sand|saitex|sandpaper|abrasive/i },
    { sub: 'ST', re: /\bstone\b|หินขัด/i },
    { sub: 'BR', re: /brush|แปรง/i },
    { sub: 'PO', re: /polisher|felt|สักหลาด|buff|ยางขัด|ผ้าขัด|ขัดงาน/i },
  ],
  surgery: [
    { sub: 'BL', re: /blade|ใบมีด|scalpel/i },
    { sub: 'SU', re: /suture|ไหมเย็บ|เย็บไหม|เข็มเย็บ|novosyn/i },
    { sub: 'FO', re: /forceps|คีมถอน/i },
    { sub: 'EL', re: /elevator|ที่งัด/i },
    { sub: 'BG', re: /bone graft|กระดูกเทียม|membrane|เมมเบรน/i },
    { sub: 'RE', re: /retractor|ถ่างปาก|เปิดปาก/i },
  ],
  ppe: [
    { sub: 'GL', re: /glove|ถุงมือ/i },
    { sub: 'MK', re: /\bmask\b|หน้ากาก/i },
    { sub: 'GO', re: /gown|เสื้อกาวน์|กาวน์/i },
    { sub: 'GA', re: /gauze|ผ้าก๊อซ|ก๊อซ/i },
    { sub: 'SU', re: /suction|ดูดน้ำลาย/i },
    { sub: 'CA', re: /\bcap\b|หมวก|non ?woven/i },
  ],
  wax: [
    { sub: 'OC', re: /occlusal|เรียงฟัน|แผ่นวัด/i },
    { sub: 'SW', re: /sticky/i },
    { sub: 'UW', re: /utility/i },
    { sub: 'BW', re: /pink wax|base ?plate|แว็กซ์.*ชมพู|\bwax\b|แว็กซ์/i },
  ],
  investment: [
    { sub: 'PN', re: /\bpin|\bnail|ตะปู|หมุด/i },
    { sub: 'SA', re: /\bsaw\b|เลื่อย/i },
    { sub: 'IN', re: /bellavest|wirovest|begosol|investment|ปูนหุ้ม/i },
  ],
};

// Suggest a sub-group code for a product within its group, or null (no rule / group has no subs).
export function autoAssignSubgroup(
  groupKey: string,
  p: { nameEn: string; nameTh: string; keywords?: string[] },
): string | null {
  const rules = SUBGROUP_RULES[groupKey];
  if (!rules) return null;
  const hay = `${p.nameEn} ${p.nameTh} ${(p.keywords ?? []).join(' ')}`.toLowerCase();
  for (const r of rules) if (r.re.test(hay)) return r.sub;
  return null;
}

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
