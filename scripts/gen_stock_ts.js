// Generate api/src/catalog/stockData.ts from the parsed stock.json, filtered to
// catalog SKUs (others have no Product row). Run after parse_stock.js.
const fs = require('fs');
const TMP = 'C:\\Users\\khunn\\AppData\\Local\\Temp\\minerva-catalog';
const stock = JSON.parse(fs.readFileSync(`${TMP}\\stock.json`, 'utf8'));
const catalog = JSON.parse(fs.readFileSync(`${TMP}\\catalog.json`, 'utf8'));
const catSkus = new Set(catalog.map((p) => String(p.sku).toUpperCase()));

const STOCK_AT = '2026-06-25'; // report header: ณ วันที่ 25/06/2569
const filtered = {};
for (const [sku, qty] of Object.entries(stock)) if (catSkus.has(sku.toUpperCase())) filtered[sku] = qty;

let out = '';
out += '// AUTO-GENERATED stock snapshot — do not edit by hand.\n';
out += '// Source: stock report 260625.txt → scripts/parse_stock.js → scripts/gen_stock_ts.js\n';
out += '// To refresh: drop the new report, re-run both scripts, redeploy (new STOCK_AT re-applies).\n';
out += `export const STOCK_AT = '${STOCK_AT}';\n`;
out += 'export const STOCK: Record<string, number> = {\n';
for (const [sku, qty] of Object.entries(filtered)) out += `  '${sku}': ${qty},\n`;
out += '};\n';

fs.writeFileSync('C:\\Users\\khunn\\Project\\Minerva\\api\\src\\catalog\\stockData.ts', out, 'utf8');
const inStock = Object.values(filtered).filter((q) => q > 0).length;
console.log('wrote stockData.ts:', Object.keys(filtered).length, 'catalog SKUs |', inStock, 'in stock |', Object.keys(filtered).length - inStock, 'out');
