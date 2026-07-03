import { promises as fs } from 'node:fs';
import path from 'node:path';
import { UPLOAD_DIR } from '../line/contentStore.js';

// Ceres bank-statement files (Nee's daily CSV upload) archived on the persistent
// volume under ceres/statements/<importId> — audit-only, never served over HTTP
// (no public route reads this path; it exists so the CEO's weekly physical
// cross-check has the original file to compare against, and so every statement
// import is tamper-evident alongside its stored sha256).
const STATEMENTS_DIR = path.join(UPLOAD_DIR, 'ceres', 'statements');

export async function saveStatementFile(importId: string, buf: Buffer): Promise<void> {
  await fs.mkdir(STATEMENTS_DIR, { recursive: true });
  await fs.writeFile(path.join(STATEMENTS_DIR, importId), buf);
}
