import { pathToFileURL } from 'node:url';

import { importOdooSnapshot, ODOO_COMPANY_MAP, OdooImportError } from '../jupiter/ledger/importOdoo.js';

function usage(): never {
  throw new OdooImportError(
    'invalid_arguments',
    'Usage: tsx src/scripts/importOdooRescue.ts --snapshot <path> --companies TONR,DENC [--names <mapping.json>] (--dry-run | --apply)',
  );
}

export function parseImportArgs(argv: string[]) {
  let snapshotPath = '';
  let companiesRaw = '';
  let apply = false;
  let dryRun = false;
  let namesPath: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--snapshot') snapshotPath = argv[++i] ?? usage();
    else if (arg === '--companies') companiesRaw = argv[++i] ?? usage();
    else if (arg === '--names') namesPath = argv[++i] ?? usage();
    else if (arg === '--apply') apply = true;
    else if (arg === '--dry-run') dryRun = true;
    else usage();
  }
  if (!snapshotPath || !companiesRaw || apply === dryRun) usage();
  const companies = companiesRaw.split(',').map((value) => value.trim().toUpperCase()).filter(Boolean);
  const allowed = new Set<string>(Object.values(ODOO_COMPANY_MAP));
  if (!companies.length || companies.some((company) => !allowed.has(company))) usage();
  return {
    snapshotPath,
    companies: companies as Array<(typeof ODOO_COMPANY_MAP)[keyof typeof ODOO_COMPANY_MAP]>,
    apply,
    namesPath,
  };
}

async function main() {
  const result = await importOdooSnapshot(parseImportArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const code = error instanceof OdooImportError ? error.code : 'import_failed';
    process.stderr.write(`${code}: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
