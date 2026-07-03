// A small, dependency-free, robust CSV tokenizer for bank export files (KBIZ today;
// a K SHOP parser may slot in alongside parseKbiz.ts later — that's Juno's job, not
// built here). KBIZ statements carry quoted fields with embedded commas AND embedded
// newlines (the header block has a multi-line quoted address cell, and the column
// header row itself has multi-line quoted cells like "Time/\nEff.Date") — splitting on
// raw "\n" first would break those rows in half, so this scans the whole text
// char-by-char and only treats "\n"/"\r\n" as a row break OUTSIDE quotes. Handles the
// standard `""` escaped-quote-inside-a-quoted-field rule.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
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
