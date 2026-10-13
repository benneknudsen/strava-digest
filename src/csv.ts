/**
 * Minimal RFC4180-ish CSV reader. Strava's activities.csv is quoted, may be
 * comma- or semicolon-separated depending on the account's locale, and can
 * contain repeated column names — so we keep rows as string[][] plus headers
 * and let columns.ts worry about meaning.
 */
export interface CsvTable {
  headers: string[];
  rows: string[][];
  delimiter: string;
}

export function parseCsv(text: string): CsvTable {
  const clean = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const delimiter = sniffDelimiter(clean);
  const rows = parseRows(clean, delimiter);
  const headers = (rows.shift() ?? []).map((h) => h.trim());
  return { headers, rows: rows.filter((r) => r.some((c) => c.trim() !== '')), delimiter };
}

function sniffDelimiter(text: string): string {
  const firstLine = text.slice(0, text.indexOf('\n') === -1 ? text.length : text.indexOf('\n'));
  const counts: Array<[string, number]> = [',', ';', '\t'].map((d) => [
    d,
    countOutsideQuotes(firstLine, d),
  ]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0]![1] > 0 ? counts[0]![0] : ',';
}

function countOutsideQuotes(line: string, delimiter: string): number {
  let inQuotes = false;
  let n = 0;
  for (const ch of line) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === delimiter && !inQuotes) n++;
  }
  return n;
}

function parseRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
