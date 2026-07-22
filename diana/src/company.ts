// Single source of truth for Prominent's company info + site taxonomy. Carried over
// (and rewritten) from the previous site prominent-dental.com. Edit here to update
// the whole marketing site. Facts only — no unverified names/figures.

export const COMPANY = {
  name: 'Prominent',
  legalName: 'Prominent Co., Ltd.',
  // Optional trust-footer fields — the owner fills these with real values later.
  // Empty/undefined = the footer omits that line entirely (never renders a placeholder).
  legalNameTh: '', // Thai registered company name, e.g. "บริษัท พรอมิเน้นท์ จำกัด"
  registrationNo: '0135551010260', // 13-digit เลขทะเบียนนิติบุคคล
  taxId: '0135551010260', // เลขประจำตัวผู้เสียภาษี
  foundedYear: '', // string (Buddhist or Christian year), e.g. "2538"
  mapUrl: undefined as string | undefined, // Google Maps link
  domain: 'prominentdental.com',
  taglineTh: 'วัสดุ อุปกรณ์ และโซลูชันดิจิทัลทันตกรรม สำหรับคลินิกและแล็บ',
  taglineEn: 'Dental materials, equipment & digital solutions for clinics and labs',
  introTh:
    'Prominent เป็นตัวแทนจำหน่ายวัสดุและอุปกรณ์ทันตกรรมคุณภาพสูงให้กับทันตแพทย์และช่างทันตกรรมทั่วประเทศ ' +
    'ด้วยประสบการณ์ในวงการทันตกรรมที่ยาวนาน ครอบคลุมตั้งแต่วัสดุสิ้นเปลือง เครื่องมือ ไปจนถึงเทคโนโลยีดิจิทัล',
  introEn:
    'Prominent supplies high-quality dental materials and equipment to dentists and dental technicians across Thailand — ' +
    'from everyday consumables to advanced digital dentistry — backed by long experience in the dental industry.',
  address: {
    line: '55 ซอยอินทามระ 19 แขวงสามเสนใน เขตพญาไท กรุงเทพฯ 10400',
    lineEn: '55 Soi Inthamara 19, Samsen Nai, Phaya Thai, Bangkok 10400, Thailand',
  },
  phone: '0-2616-1866',
  email: 'prominent_dental@hotmail.co.th',
  line: { id: '@promdent', url: 'http://line.me/ti/p/@promdent' },
  social: {
    facebook: 'https://www.facebook.com/Prominent.d',
    instagram: 'https://www.instagram.com/prominent.co.ltd/',
    youtube: 'https://www.youtube.com/channel/UCSBwMx5PYXmfeKp9Tsm1GPA',
    shopee: 'https://shopee.co.th/online.promdent',
  },
};

// Certifications / trust signals.
export const CERTS = [
  { code: 'ISO 9001:2015', desc: 'ระบบบริหารงานคุณภาพมาตรฐานสากล', descEn: 'International quality management standard.' },
  { code: 'ISO 13485:2016', desc: 'ระบบคุณภาพสำหรับเครื่องมือแพทย์', descEn: 'Quality management for medical devices.' },
  { code: 'Thai FDA', desc: 'ได้รับการรับรองจากสำนักงานคณะกรรมการอาหารและยา', descEn: 'Recognised by the Thai FDA.' },
];

// The three arms of the business (each had its own page on the old site).
export const ARMS = [
  {
    key: 'distribution',
    name: 'Prominent Distribution',
    nameTh: 'ตัวแทนจำหน่าย',
    blurb:
      'จัดจำหน่ายวัสดุ เครื่องมือ และอุปกรณ์ทันตกรรมครบวงจร ตั้งแต่วัสดุสิ้นเปลืองประจำคลินิก ' +
      'ไปจนถึงสแกนเนอร์ เครื่องพิมพ์ 3 มิติ และเครื่องมิลลิ่งสำหรับงานดิจิทัล',
    blurbEn:
      'Distributing a full range of dental materials, instruments and equipment — from everyday clinic consumables to scanners, 3D printers and milling machines for digital workflows.',
    icon: 'truck',
  },
  {
    key: 'lab',
    name: 'DentalPort Laboratory',
    nameTh: 'แล็บทันตกรรม',
    blurb:
      'ห้องปฏิบัติการทันตกรรมที่รับงานครอบฟัน สะพานฟัน ฟันปลอม รีเทนเนอร์ และรากเทียม ' +
      'ด้วยเทคโนโลยี CAD/CAM และการพิมพ์ 3 มิติ เพื่อความแม่นยำและรวดเร็ว',
    blurbEn:
      'A dental laboratory producing crowns, bridges, dentures, retainers and implant work using CAD/CAM and 3D printing for accuracy and speed.',
    icon: 'flask',
  },
  {
    key: 'manufacturing',
    name: 'KPK Manufacturing',
    nameTh: 'โรงงานผลิต',
    blurb:
      'โรงงาน KPK ผลิตวัสดุทันตกรรมภายใต้แบรนด์ Dentories ของเราเอง เช่น วัสดุพิมพ์ปาก แว็กซ์ หน้ากากอนามัย หมวกคลุมผม และถาดพิมพ์ ' +
      'ภายใต้มาตรฐาน ISO 9001 และ ISO 13485 ด้วยประสบการณ์ผลิตกว่า 30 ปี',
    blurbEn:
      'Our KPK factory manufactures dental materials under our own Dentories brand — impression materials, wax, masks, caps and trays — under ISO 9001 and ISO 13485, with over 30 years of experience.',
    icon: 'factory',
  },
];

// Top-level product groups (from the old site's main menu). `catalogCategory`
// (when set) deep-links into the shop filtered by an enrichment category;
// otherwise it opens the catalog with a search term.
export interface CatGroup {
  key: string;
  nameTh: string;
  nameEn: string;
  desc: string;
  descEn: string;
  icon: string;
  catalogCategory?: string; // enrichment category to filter by
  search?: string; // fallback search term
}
export const CATEGORIES: CatGroup[] = [
  { key: 'clinic', nameTh: 'คลินิกทันตกรรม', nameEn: 'Dental Clinic', icon: 'stethoscope',
    desc: 'วัสดุสิ้นเปลือง เครื่องมือ และของใช้ประจำคลินิก', descEn: 'Consumables, instruments and everyday clinic supplies.', search: '' },
  { key: 'lab', nameTh: 'แล็บทันตกรรม', nameEn: 'Dental Laboratory', icon: 'flask',
    desc: 'เครื่องมือช่าง ฟันปลอม แว็กซ์ และวัสดุงานแล็บ', descEn: 'Hand instruments, teeth, wax and lab materials.', search: '' },
  { key: 'machine', nameTh: 'เครื่องมือดิจิทัล', nameEn: 'Machines', icon: 'scan',
    desc: 'สแกนเนอร์ในช่องปาก เครื่องพิมพ์ 3 มิติ มิลลิ่ง และ X-Ray', descEn: 'Intraoral scanners, 3D printers, milling and X-ray.', catalogCategory: 'เครื่องมือ/เครื่องจักร' },
  { key: 'implant', nameTh: 'รากเทียม', nameEn: 'Implant', icon: 'anchor',
    desc: 'ระบบรากเทียม BEGO และอุปกรณ์ที่เกี่ยวข้อง', descEn: 'BEGO implant systems and related components.', catalogCategory: 'รากเทียม' },
  { key: 'burs', nameTh: 'หัวกรอ', nameEn: 'Burs', icon: 'circle-dot',
    desc: 'หัวกรอเพชรและคาร์ไบด์ Sunshine Diamond และอื่น ๆ', descEn: 'Diamond and carbide burs — Sunshine Diamond and more.', catalogCategory: 'หัวกรอ' },
  { key: 'handpiece', nameTh: 'ด้ามกรอ / ไมโครมอเตอร์', nameEn: 'Micromotor & Handpiece', icon: 'wrench',
    desc: 'ด้ามกรอและไมโครมอเตอร์สำหรับงานทันตกรรม', descEn: 'Handpieces and micromotors for clinic and lab.', catalogCategory: 'ด้ามกรอ/ไมโครมอเตอร์' },
];

// Headline brands carried/made.
export const BRANDS = [
  { name: 'BEGO', desc: 'ระบบรากเทียมและวัสดุงานแล็บจากเยอรมนี', descEn: 'German implant systems and lab materials.', tag: 'Implants · Lab' },
  { name: 'Sunshine Diamond', desc: 'หัวกรอเพชรคุณภาพสำหรับงานกรอแต่ง', descEn: 'Quality diamond burs for preparation.', tag: 'Burs' },
  { name: 'ExoCAD', desc: 'ซอฟต์แวร์ออกแบบงานทันตกรรมดิจิทัล', descEn: 'Digital dental CAD design software.', tag: 'Software' },
  { name: 'Dentories', desc: 'แบรนด์ผลิตเองของเรา (โรงงาน KPK) — วัสดุสิ้นเปลืองและวัสดุงานแล็บ', descEn: 'Our own in-house brand, made at the KPK factory — consumables and lab materials.', tag: 'In-house' },
];
