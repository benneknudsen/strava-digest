import type { CsvTable } from '../csv.ts';
import { ALIASES, type ColumnMap } from './aliases.ts';
import { parseNumber } from './number.ts';

const METRES_PER_METRE = 1;
const METRES_PER_KM = 1000;
const METRES_PER_MILE = 1609.344;
const METRES_PER_SCANDINAVIAN_MIL = 10_000;
const DISTANCE_SCALE_THRESHOLD_METRES = 200;
const DEFAULT_DISTANCE_FACTOR = METRES_PER_KM;

type DistanceUnit = 'm' | 'km' | 'mi' | 'scandi-mil';

const UNIT_FACTOR: Record<DistanceUnit, number> = {
  m: METRES_PER_METRE,
  km: METRES_PER_KM,
  mi: METRES_PER_MILE,
  // Danish, Swedish and Norwegian "mil" is 10 km, not a mile.
  'scandi-mil': METRES_PER_SCANDINAVIAN_MIL,
};

const UNIT_WORDS: Record<string, DistanceUnit> = {
  m: 'm',
  meter: 'm',
  meters: 'm',
  metre: 'm',
  metres: 'm',
  metro: 'm',
  metros: 'm',
  metri: 'm',
  km: 'km',
  kilometer: 'km',
  kilometers: 'km',
  kilometre: 'km',
  kilometres: 'km',
  kilometro: 'km',
  kilometros: 'km',
  quilometro: 'km',
  quilometros: 'km',
  chilometri: 'km',
  chilometro: 'km',
  mil: 'scandi-mil',
  mi: 'mi',
  mile: 'mi',
  miles: 'mi',
  milla: 'mi',
  millas: 'mi',
  milha: 'mi',
  milhas: 'mi',
  mijl: 'mi',
  mijlen: 'mi',
  meile: 'mi',
  meilen: 'mi',
  miglio: 'mi',
  miglia: 'mi',
};

/** A standalone unit column names its purpose; a temperature unit does not. */
const UNIT_HEADER_WORDS = new Set([
  'unit',
  'units',
  'enhed',
  'enheder',
  'einheit',
  'einheiten',
  'enhet',
  'enheter',
  'eenheid',
  'eenheden',
  'unidad',
  'unidades',
  'unite',
  'unites',
  'unidade',
  'unita',
  'unitat',
  'distanceunit',
  'distanceunits',
  'distancenhed',
  'afstandsenhed',
  'distanseenhed',
  'distanzeinheit',
]);

// Derived from ALIASES.distance so a language is added in one place. Unit
// tokens ("km") are removed: they belong to UNIT_WORDS, not to the header
// words that name a distance column.
const DISTANCE_HEADER_WORDS = new Set(
  ALIASES.distance.flatMap((alias) => headerTokens(alias)).filter((token) => !UNIT_WORDS[token]),
);

/** lowercase, strip accents and split into alphanumeric words */
function headerTokens(value: string): string[] {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/æ/g, 'ae')
    .replace(/ø/g, 'o')
    .replace(/å/g, 'a')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function distanceUnitOf(value: string): DistanceUnit | null {
  let unit: DistanceUnit | null = null;
  for (const token of headerTokens(value)) {
    const found = UNIT_WORDS[token];
    if (!found) continue;
    if (unit && unit !== found) return null;
    unit = found;
  }
  return unit;
}

function isDistanceUnitHeader(header: string): boolean {
  const tokens = headerTokens(header);
  if (!tokens.some((token) => UNIT_HEADER_WORDS.has(token))) return false;
  const rest = tokens.filter(
    (token) => !UNIT_HEADER_WORDS.has(token) && !['of', 'for', 'i', 'in', 'pa', 'per', 'til'].includes(token),
  );
  return rest.length === 0 || rest.some((token) => DISTANCE_HEADER_WORDS.has(token));
}

export interface DistanceUnits {
  /** metres per unit for one distance column */
  factorAt(columnIndex: number): number;
  /**
   * true when the unit could only be guessed from the column's scale, after a
   * unit column existed but was empty or contradictory and the header named
   * no unit
   */
  assumed: boolean;
}

/**
 * Decide the distance unit once per column, never per row. Precedence:
 * a usable standalone unit column, then a unit in the header, then the
 * column's scale. A unit column that is empty or contradictory is unusable,
 * so the explicit header unit wins over the guess; only a bare header falls
 * through to the scale.
 */
function columnUnitFrom(
  table: CsvTable,
  unitIndexes: number[],
): { unit: DistanceUnit | null; unusable: boolean } {
  if (!unitIndexes.length) return { unit: null, unusable: false };
  const seen = new Set<DistanceUnit>();
  let unreadable = false;
  for (const row of table.rows) {
    for (const index of unitIndexes) {
      const value = (row[index] ?? '').trim();
      if (!value) continue;
      const unit = distanceUnitOf(value);
      if (!unit) unreadable = true;
      else seen.add(unit);
    }
  }
  if (!unreadable && seen.size === 1) return { unit: [...seen][0]!, unusable: false };
  return { unit: null, unusable: true };
}

function columnFactors(
  table: CsvTable,
  distanceIndexes: number[],
  columnUnit: DistanceUnit | null,
): { factors: Map<number, number>; usedScale: boolean } {
  const factors = new Map<number, number>();
  let usedScale = false;
  for (const index of distanceIndexes) {
    if (columnUnit) {
      factors.set(index, UNIT_FACTOR[columnUnit]);
      continue;
    }
    const headerUnit = distanceUnitOf(table.headers[index] ?? '');
    if (headerUnit) {
      factors.set(index, UNIT_FACTOR[headerUnit]);
      continue;
    }
    factors.set(index, columnScaleFactor(table, index));
    usedScale = true;
  }
  return { factors, usedScale };
}

export function distanceUnits(table: CsvTable, map: ColumnMap): DistanceUnits {
  const distanceIndexes = map.index.get('distance') ?? [];
  const hasDistanceValue = distanceIndexes.some((index) =>
    table.rows.some((row) => (row[index] ?? '').trim() !== ''),
  );
  if (!distanceIndexes.length || !hasDistanceValue) {
    return { factorAt: () => DEFAULT_DISTANCE_FACTOR, assumed: false };
  }

  const unitIndexes = table.headers
    .map((header, index) => (isDistanceUnitHeader(header) ? index : -1))
    .filter((index) => index >= 0);
  const { unit: columnUnit, unusable: unitColumnUnusable } = columnUnitFrom(
    table,
    unitIndexes,
  );
  const { factors, usedScale } = columnFactors(table, distanceIndexes, columnUnit);

  return {
    factorAt: (index) => factors.get(index) ?? DEFAULT_DISTANCE_FACTOR,
    assumed: usedScale && unitColumnUnusable,
  };
}

function medianOf(sorted: number[]): number {
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return (sorted[middle - 1]! + sorted[middle]!) / 2;
  return sorted[middle]!;
}

/** Median of the column's non-empty numeric values. */
function columnScaleFactor(table: CsvTable, index: number): number {
  const values: number[] = [];
  for (const row of table.rows) {
    const value = parseNumber((row[index] ?? '').trim());
    if (value != null) values.push(value);
  }
  if (!values.length) return DEFAULT_DISTANCE_FACTOR;
  values.sort((a, b) => a - b);
  const median = medianOf(values);
  if (median > DISTANCE_SCALE_THRESHOLD_METRES) return METRES_PER_METRE;
  return DEFAULT_DISTANCE_FACTOR;
}

/** Distance in metres, using the unit decided once for the column. */
export function distanceMeters(
  row: string[],
  map: ColumnMap,
  units: DistanceUnits,
): number | null {
  for (const index of map.index.get('distance') ?? []) {
    const value = row[index];
    if (value == null || value.trim() === '') continue;
    const n = parseNumber(value.trim());
    if (n == null) return null;
    return n * units.factorAt(index);
  }
  return null;
}
