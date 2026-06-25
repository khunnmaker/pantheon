// Upload the distinct product photos to the Railway /data volume via the
// supervisor endpoint. Idempotent (overwrites). Run after deploy.
const fs = require('fs');
const path = require('path');

const BASE = 'https://minerva-production-9309.up.railway.app';
const PBASE = 'G:\\My Drive\\Shared\\Minerva\\product-photos';
const PRODUCTS = path.join(PBASE, 'products');
const INDEX = path.join(PBASE, 'INDEX.csv');
const CATALOG = 'C:\\Users\\khunn\\AppData\\Local\\Temp\\minerva-catalog\\catalog.json';
const PASS = process.env.SEED_PASSWORD || '75VmqLCmeAADHm';

const norm = (s) => String(s).trim().toUpperCase();

function buildPhotoMap() {
  const catalog = JSON.parse(fs.readFileSync(CATALOG, 'utf8'));
  const fileSet = new Set(fs.readdirSync(PRODUCTS));
  const skuToFile = new Map();
  for (const line of fs.readFileSync(INDEX, 'utf8').split(/\r?\n/).slice(1)) {
    if (!line.trim()) continue;
    const cols = line.split(',');
    const sku = norm(cols[0]);
    const file = (cols[cols.length - 1] || '').trim();
    if (sku && fileSet.has(file)) skuToFile.set(sku, file);
  }
  const cellKey = (p) => `${p.name_en}|${p.name_th}|${p.price}|${p.page}`;
  const cellPhotoSku = new Map();
  for (const p of catalog) {
    const k = cellKey(p);
    if (skuToFile.has(norm(p.sku)) && !cellPhotoSku.has(k)) cellPhotoSku.set(k, norm(p.sku));
  }
  const photoSkus = new Set();
  for (const p of catalog) {
    const sku = norm(p.sku);
    const ps = skuToFile.has(sku) ? sku : cellPhotoSku.get(cellKey(p)) || null;
    if (ps) photoSkus.add(ps);
  }
  // photoSku -> absolute file path
  const map = new Map();
  for (const ps of photoSkus) map.set(ps, path.join(PRODUCTS, skuToFile.get(ps)));
  return map;
}

async function main() {
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'nadeer@prominent.local', password: PASS }),
  }).then((r) => r.json());
  if (!login.token) throw new Error('login failed: ' + JSON.stringify(login));
  const auth = { authorization: `Bearer ${login.token}`, 'content-type': 'application/json' };

  const map = buildPhotoMap();
  const entries = [...map.entries()];
  console.log(`uploading ${entries.length} distinct photos...`);
  let ok = 0,
    fail = 0;
  for (let i = 0; i < entries.length; i++) {
    const [sku, file] = entries[i];
    const dataB64 = fs.readFileSync(file).toString('base64');
    let success = false;
    let lastErr = '';
    for (let attempt = 0; attempt < 3 && !success; attempt++) {
      try {
        const res = await fetch(`${BASE}/api/catalog/photo/${encodeURIComponent(sku)}`, {
          method: 'POST',
          headers: auth,
          body: JSON.stringify({ dataB64 }),
        });
        if (res.ok) success = true;
        else lastErr = `${res.status} ${await res.text()}`;
      } catch (e) {
        lastErr = e.message;
      }
    }
    if (success) ok++;
    else {
      fail++;
      if (fail <= 8) console.log(`  FAIL ${sku}: ${lastErr}`);
    }
    if ((i + 1) % 50 === 0) console.log(`  ${i + 1}/${entries.length} (ok=${ok} fail=${fail})`);
  }
  console.log(`done: ok=${ok} fail=${fail}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
