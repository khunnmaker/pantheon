// Self-contained placeholders satisfy eager env validation; this script never connects
// to the database or network because every effectful semantic dependency is injected.
export {};
process.env.DOTENV_CONFIG_PATH = '__product_embedding_test_no_env_file__';
process.env.DATABASE_URL ||= 'postgresql://unused:unused@localhost:1/unused';
process.env.JWT_SECRET ||= 'test-only-placeholder';
const {
  buildProductDoc, mergeProductSkus, productDocHash, safeSemanticProductSkus,
} = await import('../catalog/productEmbeddings.js');

let failures = 0;
function check(label: string, condition: boolean): void {
  console.log(`${condition ? 'PASS' : 'FAIL'}: ${label}`);
  if (!condition) failures++;
}

const product = {
  nameEn: '  Resin Cement  ', nameTh: 'ซีเมนต์เรซิน', note: 'dual cure',
  keywords: ['crown', ' cement '], catalogGroup: 'clinical', catalogSubgroup: 'CE',
};
const enrichment = {
  brand: 'Acme', category: 'วัสดุยึดติด', categoryEn: 'Luting',
  descriptionTh: 'สำหรับติดครอบฟัน', descriptionEn: 'For crowns', specs: ['Automix'],
};
const expected = 'Resin Cement | ซีเมนต์เรซิน | dual cure | crown / cement | clinical / CE | Acme | วัสดุยึดติด / Luting | สำหรับติดครอบฟัน / For crowns / Automix';
const doc = buildProductDoc(product, enrichment);
check('document has stable compact field order', doc === expected && buildProductDoc({ ...product }, { ...enrichment }) === doc);
check('same document has the same hash', productDocHash(doc) === productDocHash(buildProductDoc(product, enrichment)));
check('content edit changes the hash', productDocHash(doc) !== productDocHash(buildProductDoc({ ...product, note: 'self cure' }, enrichment)));

check(
  'hybrid merge keeps keyword order then semantic order and dedupes',
  JSON.stringify(mergeProductSkus(['K2', 'K1'], ['K1', 'S2', 'S1'], 4)) === JSON.stringify(['K2', 'K1', 'S2', 'S1']),
);

let calls = 0;
const fakeSearch = async () => { calls++; return [{ sku: 'S1', distance: 0.2 }]; };
const skuHits = await safeSemanticProductSkus('07-10-09', 10, { available: () => true, search: fakeSearch });
check('SKU-like query skips embedding', skuHits.length === 0 && calls === 0);

let embeddedQuery = '';
await safeSemanticProductSkus('ก'.repeat(250), 10, {
  available: () => true,
  search: async (query) => { embeddedQuery = query; return []; },
});
check('semantic query is truncated to 200 characters', embeddedQuery.length === 200);

const fallback = await safeSemanticProductSkus('ซีเมนต์ติดครอบฟัน', 10, {
  available: () => true,
  search: async () => { throw new Error('simulated Voyage outage'); },
});
check('embedding error fails soft to no semantic hits', fallback.length === 0);

console.log(failures === 0 ? '\nAll checks PASSED' : `\n${failures} check(s) FAILED`);
if (failures) process.exit(1);
