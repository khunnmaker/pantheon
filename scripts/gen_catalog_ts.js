const fs = require('fs');
const path = require('path');

const CATALOG = 'C:\\Users\\khunn\\AppData\\Local\\Temp\\minerva-catalog\\catalog.json';
const BASE = 'G:\\My Drive\\Shared\\Minerva\\product-photos';
const PRODUCTS_DIR = path.join(BASE, 'products');
const INDEX_CSV = path.join(BASE, 'INDEX.csv');
const OUT_TS = 'C:\\Users\\khunn\\Project\\Minerva\\api\\src\\catalog\\catalogData.ts';

const norm = (s) => String(s).trim().toUpperCase();
const catalog = JSON.parse(fs.readFileSync(CATALOG, 'utf8'));
const fileSet = new Set(fs.readdirSync(PRODUCTS_DIR));

// sku -> photo filename (only where the file actually exists on disk)
const skuToFile = new Map();
for (const line of fs.readFileSync(INDEX_CSV, 'utf8').split(/\r?\n/).slice(1)) {
  if (!line.trim()) continue;
  const cols = line.split(',');
  const sku = norm(cols[0]);
  const file = (cols[cols.length - 1] || '').trim();
  if (sku && fileSet.has(file)) skuToFile.set(sku, file);
}

// variant fallback: products in the same catalog "cell" share a photo
const cellKey = (p) => `${p.name_en}|${p.name_th}|${p.price}|${p.page}`;
const cellPhotoSku = new Map();
for (const p of catalog) {
  const k = cellKey(p);
  if (skuToFile.has(norm(p.sku)) && !cellPhotoSku.has(k)) cellPhotoSku.set(k, norm(p.sku));
}

function keywords(p) {
  const toks = new Set();
  for (const s of [p.name_en || '', p.name_th || '']) {
    for (const t of s.toLowerCase().split(/[^a-z0-9฀-๿]+/i)) {
      if (t && t.length >= 2) toks.add(t);
    }
  }
  return [...toks];
}

const products = catalog.map((p) => {
  const sku = norm(p.sku);
  const photoSku = skuToFile.has(sku) ? sku : cellPhotoSku.get(cellKey(p)) || null;
  return {
    sku,
    nameEn: p.name_en || '',
    nameTh: p.name_th || '',
    price: p.price || 0,
    promo: p.promo || '',
    note: p.note || '',
    page: p.page || null,
    photoSku,
    keywords: keywords(p),
  };
});

const withPhoto = products.filter((p) => p.photoSku).length;
const withPrice = products.filter((p) => p.price > 0).length;

const header =
  '// AUTO-GENERATED from the Prominent catalogue PDF — do not edit by hand.\n' +
  `// ${products.length} products | ${withPrice} priced | ${withPhoto} with a photo.\n` +
  '// Regenerate: node scripts/gen_catalog_ts.js\n\n' +
  'export interface CatalogProduct {\n' +
  '  sku: string;\n  nameEn: string;\n  nameTh: string;\n  price: number;\n' +
  '  promo: string;\n  note: string;\n  page: number | null;\n' +
  '  photoSku: string | null;\n  keywords: string[];\n}\n\n' +
  'export const CATALOG_PRODUCTS: CatalogProduct[] = [\n';

const body = products.map((p) => '  ' + JSON.stringify(p) + ',').join('\n');

fs.mkdirSync(path.dirname(OUT_TS), { recursive: true });
fs.writeFileSync(OUT_TS, header + body + '\n];\n', 'utf8');
console.log(`wrote ${OUT_TS}\n${products.length} products, ${withPrice} priced, ${withPhoto} with photo`);
