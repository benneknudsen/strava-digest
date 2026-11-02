import type { CsvTable } from '../csv.ts';
import { ALIASES, type ColumnMap, type Field } from './aliases.ts';

/** lowercase, drop unit parentheses, strip accents, collapse non-alphanumerics */
export function normalizeHeader(h: string): string {
  return h
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/æ/g, 'ae')
    .replace(/ø/g, 'o')
    .replace(/å/g, 'a')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function mapExactAliases(
  normalized: string[],
  index: Map<Field, number[]>,
  used: Set<number>,
): void {
  for (const [field, aliases] of Object.entries(ALIASES) as Array<[Field, string[]]>) {
    for (const alias of aliases) {
      normalized.forEach((h, i) => {
        if (h === alias) {
          const list = index.get(field) ?? [];
          list.push(i);
          index.set(field, list);
          used.add(i);
        }
      });
    }
  }
}

function mapLooseAliases(
  normalized: string[],
  index: Map<Field, number[]>,
  used: Set<number>,
): void {
  for (const [field, aliases] of Object.entries(ALIASES) as Array<[Field, string[]]>) {
    if (index.has(field)) continue;
    for (const alias of aliases) {
      const i = normalized.findIndex((h, idx) => !used.has(idx) && h.includes(alias));
      if (i >= 0) {
        index.set(field, [i]);
        used.add(i);
        break;
      }
    }
  }
}

function unmatchedHeaders(table: CsvTable, used: Set<number>): string[] {
  // Strava's export has 50+ optional columns, and almost all of them are
  // empty for almost every activity. Listing them all is noise: the point
  // of the note is to say which columns the tool could not place, and an
  // empty column carries no information worth an agent's tokens. So only
  // the columns that actually hold a value are reported.
  return table.headers.filter(
    (header, i) =>
      header !== '' &&
      !used.has(i) &&
      table.rows.some((row) => (row[i] ?? '').trim() !== ''),
  );
}

export function mapColumns(table: CsvTable): ColumnMap {
  const normalized = table.headers.map(normalizeHeader);
  const index = new Map<Field, number[]>();
  const used = new Set<number>();
  mapExactAliases(normalized, index, used);
  mapLooseAliases(normalized, index, used);
  return { index, unmatched: unmatchedHeaders(table, used) };
}
