// A small robust CSV tokenizer for the bank files (KBIZ + K SHOP). Both files can carry
// quoted fields with embedded commas AND embedded newlines (the KBIZ header block has a
// multi-line quoted address cell) — splitting on raw "\n" first would break those rows in
// half, so this scans the whole text char-by-char and only treats "\n"/"\r\n" as a row
// break OUTSIDE quotes. Handles the standard `""` escaped-quote-inside-a-quoted-field rule.
export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (inQuotes) {
      if (c === '"') {
        if (input[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    if (c === '\r') { continue; } // swallow bare \r (both lone and as part of \r\n)
    field += c;
  }
  // flush a trailing field/row that wasn't newline-terminated
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}
