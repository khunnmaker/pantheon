const fs = require('fs');

const SRC =
  'C:\\Users\\khunn\\.claude\\projects\\C--Program-Files-Git\\f5a53310-3f24-46a0-8d65-fb8ef876b3b2\\tool-results\\mcp-4e482907-e035-463e-b203-797edc0b6d43-read_file_content-1782406422630.txt';
const raw = JSON.parse(fs.readFileSync(SRC, 'utf8')).fileContent;
const lines = raw.split(/\r?\n/);

// Stock line:  <SKU> <name…> <QTY> <unit> <cost> <value>  where value = qty × cost
// (cost = average cost, so ~2% rounding tolerance; cost/value can be negative when
//  oversold/below-cost). The numbers are always clean ASCII even where Thai is mojibake,
// so we anchor on the arithmetic invariant — NOT on column position.
const skuRe = /^\s*(\d{2}-\d{2}-\d+)\s+(.*)$/;
const numRe = /-?[\d,]+(?:\.\d+)?/g;
const parseNums = (s) => (s.match(numRe) || []).map((x) => parseFloat(x.replace(/,/g, ''))).filter((n) => !Number.isNaN(n));
const tol = (v) => Math.max(1, Math.abs(v) * 0.02);

const stock = new Map();
let validated = 0; // value = qty × cost  (high confidence)
let zeroNeg = 0; // value 0 or negative → qty is the number before it
let lineCount = 0;
const unresolved = [];
const zeroNegSamples = [];

for (const line of lines) {
  const m = line.match(skuRe);
  if (!m) continue;
  lineCount++;
  const sku = m[1].toUpperCase();
  const nums = parseNums(m[2]);
  if (!nums.length) {
    unresolved.push(m[2].trim().slice(0, 90));
    continue;
  }
  const last = nums[nums.length - 1];
  let qty = null;
  let tier = '';
  if (nums.length >= 3) {
    const cost = nums[nums.length - 2];
    const q = nums[nums.length - 3];
    if (cost !== 0 && Math.abs(q * cost - last) <= tol(last)) {
      qty = q;
      tier = 'validated';
    }
  }
  if (qty === null && nums.length >= 2 && last <= 0) {
    qty = nums[nums.length - 2]; // value 0/negative → qty sits right before it
    tier = 'zeroNeg';
  }
  if (qty === null && nums.length >= 2 && nums[nums.length - 2] === 0) {
    qty = 0; // "name 0.00 unit cost" — qty 0, value omitted → out of stock
    tier = 'zeroNeg';
  }
  if (qty === null) {
    unresolved.push(`${sku} nums=[${nums.join(',')}] | ${m[2].trim().slice(0, 60)}`);
    continue;
  }
  stock.set(sku, Math.round(qty));
  if (tier === 'validated') validated++;
  else {
    zeroNeg++;
    if (zeroNegSamples.length < 12) zeroNegSamples.push(`${sku} qty=${qty} | ${m[2].trim().slice(0, 65)}`);
  }
}

const vals = [...stock.values()];
console.log('=== STOCK PARSE (v3: value=qty×cost invariant) ===');
console.log('SKU lines          :', lineCount, '| unique SKUs:', stock.size, '| dup lines:', lineCount - stock.size - unresolved.length);
console.log('  validated (=q×c) :', validated);
console.log('  zero/neg value   :', zeroNeg);
console.log('  unresolved       :', unresolved.length);
console.log('in-stock (qty > 0) :', vals.filter((q) => q > 0).length);
console.log('out (qty <= 0)     :', vals.filter((q) => q <= 0).length);

try {
  const catalog = JSON.parse(fs.readFileSync('C:\\Users\\khunn\\AppData\\Local\\Temp\\minerva-catalog\\catalog.json', 'utf8'));
  const catSkus = new Set(catalog.map((p) => String(p.sku).toUpperCase()));
  let catWithStock = 0;
  const catMissing = [];
  for (const sku of catSkus) {
    if (stock.has(sku)) catWithStock++;
    else if (catMissing.length < 10) catMissing.push(sku);
  }
  console.log('\ncatalog SKUs       :', catSkus.size, '| catalog w/ stock:', catWithStock, '| missing:', catSkus.size - catWithStock);
  console.log('sample missing-from-stock catalog SKUs:', catMissing.join(', '));
} catch (e) {
  console.log('\n(catalog cross-ref skipped:', e.message, ')');
}

console.log('\nzero/neg samples (spot-check qty is right before the 0/neg value):');
zeroNegSamples.forEach((s) => console.log('  ', s));
console.log('\nunresolved samples:');
unresolved.slice(0, 10).forEach((s) => console.log('  ', s));

const out = Object.fromEntries(stock);
fs.writeFileSync('C:\\Users\\khunn\\AppData\\Local\\Temp\\minerva-catalog\\stock.json', JSON.stringify(out), 'utf8');
console.log('\nwrote stock.json (', stock.size, 'skus )');
