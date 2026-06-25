const fs = require('fs');
const path = require('path');

const OUT = 'C:\\Users\\khunn\\AppData\\Local\\Temp\\minerva-catalog\\out';
const MASTER = 'C:\\Users\\khunn\\AppData\\Local\\Temp\\minerva-catalog\\catalog.json';

const files = fs.readdirSync(OUT).filter((f) => /^page-\d+\.json$/.test(f)).sort();
const issues = [];
const bySku = new Map(); // sku -> row (first wins)
let rawRows = 0;
let noSku = 0;

for (const f of files) {
  const page = parseInt(f.match(/\d+/)[0], 10);
  let txt = fs.readFileSync(path.join(OUT, f), 'utf8').trim();
  txt = txt.replace(/^```(json)?/i, '').replace(/```$/i, '').trim();
  let arr;
  try {
    arr = JSON.parse(txt);
  } catch (e) {
    issues.push(`page ${page}: JSON parse error: ${e.message}`);
    continue;
  }
  if (!Array.isArray(arr)) {
    issues.push(`page ${page}: not an array`);
    continue;
  }
  for (const p of arr) {
    const skus = Array.isArray(p.skus) ? p.skus : p.sku ? [p.sku] : [];
    const priceNum = Number.isFinite(p.price)
      ? p.price
      : parseInt(String(p.price ?? '').replace(/[^0-9]/g, ''), 10) || 0;
    const base = {
      name_en: (p.name_en || '').trim(),
      name_th: (p.name_th || '').trim(),
      price: priceNum,
      promo: (p.promo || '').trim(),
      note: (p.note || '').trim(),
      page,
    };
    if (!skus.length) {
      noSku++;
      issues.push(`page ${page}: product without SKU: ${(base.name_en || base.name_th || '?').slice(0, 40)}`);
      continue;
    }
    for (const rawSku of skus) {
      rawRows++;
      const sku = String(rawSku).trim().toUpperCase();
      if (!sku) continue;
      const row = { sku, ...base };
      if (bySku.has(sku)) {
        const prev = bySku.get(sku);
        if (prev.price !== row.price) {
          issues.push(`dup SKU ${sku}: ${prev.price}฿ (p${prev.page}) vs ${row.price}฿ (p${page})`);
        }
      } else {
        bySku.set(sku, row);
      }
    }
  }
}

const uniq = [...bySku.values()];
const withPrice = uniq.filter((r) => r.price > 0);
const noPrice = uniq.filter((r) => r.price <= 0);
const withName = uniq.filter((r) => r.name_en || r.name_th);
const prices = withPrice.map((r) => r.price).sort((a, b) => a - b);
const med = prices.length ? prices[Math.floor(prices.length / 2)] : 0;

fs.writeFileSync(MASTER, JSON.stringify(uniq, null, 2), 'utf8');

console.log('=== CATALOG MERGE ===');
console.log('files read         :', files.length);
console.log('raw sku rows        :', rawRows);
console.log('products without SKU:', noSku);
console.log('UNIQUE SKUs         :', uniq.length);
console.log('  with price > 0    :', withPrice.length);
console.log('  price = 0/unknown :', noPrice.length);
console.log('  with a name       :', withName.length);
console.log('price min/median/max:', prices[0] || 0, '/', med, '/', prices[prices.length - 1] || 0);
console.log('issues count        :', issues.length);
console.log('\n--- first 12 issues ---');
issues.slice(0, 12).forEach((i) => console.log(' -', i));
console.log('\n--- sample products ---');
uniq.slice(0, 8).forEach((r) => console.log(` ${r.sku}  ${r.price}฿  ${r.name_en} | ${r.name_th}`.slice(0, 90)));
console.log('\n--- SKUs with price=0 (first 15) ---');
noPrice.slice(0, 15).forEach((r) => console.log(` ${r.sku}  ${r.name_en} | ${r.name_th}`.slice(0, 80)));
console.log('\nmaster written ->', MASTER);
