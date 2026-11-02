import type { ColumnMap, Field } from './aliases.ts';

const THOUSANDS_GROUP_LENGTH = 3;
const MIN_THOUSANDS_HEAD_DIGITS = 1;
const MAX_THOUSANDS_HEAD_DIGITS = 3;

export function raw(row: string[], map: ColumnMap, field: Field): string {
  for (const i of map.index.get(field) ?? []) {
    const v = row[i];
    if (v != null && v.trim() !== '') return v.trim();
  }
  return '';
}

export function num(row: string[], map: ColumnMap, field: Field): number | null {
  return parseNumber(raw(row, map, field));
}

function normalizeBothSeparators(v: string, comma: number, dot: number): string {
  const decimal = comma > dot ? ',' : '.';
  const thousands = decimal === ',' ? '.' : ',';
  return v.split(thousands).join('').replace(decimal, '.');
}

function separatorOf(comma: number, dot: number): string {
  if (comma >= 0) return ',';
  if (dot >= 0) return '.';
  return '';
}

function isGroupedThousands(parts: string[]): boolean {
  if (parts.length !== 2) return false;
  const [head = '', tail = ''] = parts;
  const headDigits = head.replace(/^-/, '');
  return (
    tail.length === THOUSANDS_GROUP_LENGTH &&
    headDigits.length >= MIN_THOUSANDS_HEAD_DIGITS &&
    headDigits.length <= MAX_THOUSANDS_HEAD_DIGITS &&
    headDigits[0] !== '0'
  );
}

function normalizeSingleSeparator(v: string, separator: string): string {
  if (!separator) return v;
  const parts = v.split(separator);
  if (parts.length > 2 || isGroupedThousands(parts)) return parts.join('');
  const [head = '', tail = ''] = parts;
  return `${head}.${tail}`;
}

export function parseNumber(value: string): number | null {
  const v = value.replace(/[^\d.,-]/g, '').replace(/\s/g, '');
  if (!v) return null;
  // Per-value rule, not per account locale: num() receives no locale. When
  // both "," and "." appear, the rightmost is the decimal separator, so
  // "1,234.5" (en) and "1.234,5" (de/da) both become 1234.5. With one kind of
  // separator, a repeated separator ("2.345.678") and a 1-3 digit group
  // before a 3-digit tail ("1.234", "1,234", "1,234,567") are thousands;
  // everything else is decimal ("10.5", "12,5", "0.123"). So "1.234" is
  // German/Dutch 1234, never English 1.234.
  const comma = v.lastIndexOf(',');
  const dot = v.lastIndexOf('.');
  let normalized: string;
  if (comma >= 0 && dot >= 0) {
    normalized = normalizeBothSeparators(v, comma, dot);
  } else {
    normalized = normalizeSingleSeparator(v, separatorOf(comma, dot));
  }
  const n = Number.parseFloat(normalized);
  return Number.isFinite(n) ? n : null;
}
