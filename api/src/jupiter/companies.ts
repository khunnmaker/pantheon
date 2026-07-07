// Canonical group entity codes — the SINGLE source for every place that tags a row by company:
// the JupiterCompany seed (ensureSeeded), Ceres expenses (entity), and the future deity syncs.
// Order = display order. Keep in step with JUPITER_COMPANIES in api/src/db/ensureSeeded.ts.
export const GROUP_COMPANY_CODES = ['PROM', 'TONR', 'DENC', 'DENL', 'KPKF'] as const;
export type GroupCompanyCode = (typeof GROUP_COMPANY_CODES)[number];
