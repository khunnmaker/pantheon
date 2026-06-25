const fs = require('fs');
const path = require('path');

const BASE = 'G:\\My Drive\\Shared\\Minerva\\product-photos';
const PRODUCTS_DIR = path.join(BASE, 'products');
const INDEX_CSV = path.join(BASE, 'INDEX.csv');
const CATALOG = 'C:\\Users\\khunn\\AppData\\Local\\Temp\\minerva-catalog\\catalog.json';

const norm = (s) => String(s).trim().toUpperCase();

// catalog SKUs
const catalog = JSON.parse(fs.readFileSync(CATALOG, 'utf8'));
const catSkus = new Set(catalog.map((r) => norm(r.sku)));

// actual photo files
const files = fs.readdirSync(PRODUCTS_DIR);
const pngs = files.filter((f) => /\.png$/i.test(f));

// INDEX.csv: sku,product_name,page,file
const idxLines = fs.readFileSync(INDEX_CSV, 'utf8').split(/\r?\n/).slice(1).filter(Boolean);
const idxSkuToFile = new Map();
for (const line of idxLines) {
  const cols = line.split(',');
  const sku = norm(cols[0]);
  const file = (cols[cols.length - 1] || '').trim();
  if (sku) idxSkuToFile.set(sku, file);
}

// which INDEX files actually exist on disk
const fileSet = new Set(pngs);
let idxFilesPresent = 0;
for (const f of idxSkuToFile.values()) if (fileSet.has(f)) idxFilesPresent++;

// catalog SKU -> has a photo? (via INDEX map, file present)
let catWithPhoto = 0;
const catNoPhoto = [];
for (const sku of catSkus) {
  const f = idxSkuToFile.get(sku);
  if (f && fileSet.has(f)) catWithPhoto++;
  else catNoPhoto.push(sku);
}

// photos whose SKU isn't in the catalog
let photoSkusNotInCatalog = 0;
for (const sku of idxSkuToFile.keys()) if (!catSkus.has(sku)) photoSkusNotInCatalog++;

console.log('=== PHOTO CROSS-REF ===');
console.log('catalog unique SKUs     :', catSkus.size);
console.log('png files in /products  :', pngs.length);
console.log('INDEX.csv rows          :', idxSkuToFile.size);
console.log('INDEX files present     :', idxFilesPresent);
console.log('catalog SKUs WITH photo :', catWithPhoto);
console.log('catalog SKUs NO photo   :', catNoPhoto.length);
console.log('photo SKUs not in catalog:', photoSkusNotInCatalog);
console.log('\nsample catalog SKUs without a photo:');
catNoPhoto.slice(0, 15).forEach((s) => console.log('  ', s));
console.log('\nsample actual filenames:');
pngs.slice(0, 6).forEach((f) => console.log('  ', f));
