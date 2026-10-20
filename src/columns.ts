import type { CsvTable } from './csv.ts';

/**
 * Strava localises the export: the same column arrives as "Average Heart Rate"
 * or "Gennemsnitlig puls", and a third-party importer has already been broken by
 * non-English headers. So we never trust header names positionally — we map
 * through aliases and, when something essential is missing, print the real
 * header row so a new alias can be added in one edit.
 */
export type Field =
  | 'id'
  | 'date'
  | 'name'
  | 'type'
  | 'elapsedSec'
  | 'movingSec'
  | 'distance'
  | 'avgHr'
  | 'maxHr'
  | 'avgCadence'
  | 'maxCadence'
  | 'avgWatts'
  | 'relativeEffort'
  | 'elevationGain'
  | 'calories'
  | 'gear'
  | 'filename'
  | 'avgSpeed'
  | 'temperature';

const ALIASES: Record<Field, string[]> = {
  id: ['activity id', 'aktivitet id', 'aktivitets id', 'id'],
  date: ['activity date', 'aktivitet dato', 'aktivitetdato', 'dato', 'startdato', 'start date'],
  name: ['activity name', 'aktivitet navn', 'aktivitetnavn', 'navn', 'title'],
  type: ['activity type', 'aktivitetstype', 'aktivitet type', 'sport', 'sports type'],
  elapsedSec: ['elapsed time', 'samlet tid', 'forlobet tid', 'forloebet tid', 'varighed'],
  movingSec: ['moving time', 'bevaegelsestid', 'bevagelsestid', 'tid i bevaegelse'],
  distance: ['distance', 'afstand', 'distance km', 'distancen'],
  avgHr: [
    'average heart rate',
    'gennemsnitlig puls',
    'gennemsnitspuls',
    'gns puls',
    'average hr',
    'avg hr',
  ],
  maxHr: ['max heart rate', 'maks puls', 'makspuls', 'max puls', 'max hr'],
  avgCadence: ['average cadence', 'gennemsnitlig kadence', 'gns kadence'],
  maxCadence: ['max cadence', 'maks kadence'],
  avgWatts: ['average watts', 'gennemsnitlig watt', 'gns watt'],
  relativeEffort: ['relative effort', 'relativ indsats', 'relativ effort'],
  elevationGain: [
    'elevation gain',
    'hojdeforogelse',
    'stigning',
    'hoejdeforoegelse',
    'samlet stigning',
  ],
  calories: ['calories', 'kalorier'],
  gear: ['activity gear', 'aktivitetsudstyr', 'aktivitet udstyr', 'udstyr', 'gear'],
  filename: ['filename', 'filnavn', 'fil'],
  avgSpeed: ['average speed', 'gennemsnitshastighed', 'gennemsnitlig hastighed'],
  temperature: ['weather temperature', 'temperatur', 'vejr temperatur'],
};

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

export interface ColumnMap {
  /** field -> column indexes (duplicates kept, first non-empty wins) */
  index: Map<Field, number[]>;
  /** headers we could not place */
  unmatched: string[];
}

export function mapColumns(table: CsvTable): ColumnMap {
  const normalized = table.headers.map(normalizeHeader);
  const index = new Map<Field, number[]>();
  const used = new Set<number>();

  // exact alias match first
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
  // then a looser contains-match for anything still missing
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

  const unmatched = table.headers.filter((_, i) => !used.has(i)).filter(Boolean);
  return { index, unmatched };
}

export function raw(row: string[], map: ColumnMap, field: Field): string {
  for (const i of map.index.get(field) ?? []) {
    const v = row[i];
    if (v != null && v.trim() !== '') return v.trim();
  }
  return '';
}

export function num(row: string[], map: ColumnMap, field: Field): number | null {
  const v = raw(row, map, field).replace(/[^\d.,-]/g, '').replace(/\s/g, '');
  if (!v) return null;
  // "1,234.5" (en) vs "1.234,5" (da)
  const normalized = /,\d{1,2}$/.test(v) ? v.replace(/\./g, '').replace(',', '.') : v.replace(/,/g, '');
  const n = Number.parseFloat(normalized);
  return Number.isFinite(n) ? n : null;
}

/** Accepts "52:31", "1:02:11", "1875.4" (seconds) or "1h 2m". */
export function durationSec(row: string[], map: ColumnMap, field: Field): number | null {
  const v = raw(row, map, field);
  if (!v) return null;
  const hms = v.match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?$/);
  if (hms) {
    const a = Number(hms[1]);
    const b = Number(hms[2]);
    const c = hms[3];
    return c != null ? a * 3600 + b * 60 + Number(c) : a * 60 + b;
  }
  const textual = v.match(/(?:(\d+)\s*h)?\s*(?:(\d+)\s*m(?:in)?)?/i);
  if (textual && (textual[1] || textual[2])) {
    return Number(textual[1] ?? 0) * 3600 + Number(textual[2] ?? 0) * 60;
  }
  const n = num(row, map, field);
  return n;
}

const MONTHS: Record<string, number> = {
  jan: 0, january: 0, januar: 0,
  feb: 1, february: 1, februar: 1,
  mar: 2, march: 2, marts: 2,
  apr: 3, april: 3,
  may: 4, maj: 4,
  jun: 5, june: 5, juni: 5,
  jul: 6, july: 6, juli: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9, okt: 9, oktober: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

/**
 * Strava localises the export, and the date is part of it: an English account
 * writes "Oct 12, 2026, 6:32:10 AM", a Danish one "12. okt. 2026, 06:32" —
 * which `new Date()` cannot read at all. Worse, `new Date("12.10.2026")` parses
 * as 10 December (US order), so a silent fallback would invent wrong dates.
 * We therefore parse explicitly. The export carries local wall-clock time with
 * no zone; it is interpreted as the machine's local zone (Europe/Copenhagen).
 */
export function parseDate(v: string): Date | null {
  const s = v.trim().replace(/\s+/g, ' ');
  if (!s) return null;

  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const iso = new Date(s);
    return Number.isNaN(iso.getTime()) ? null : iso;
  }

  // "12. okt. 2026, 06:32(:10)" / "12 oktober 2026 06.32"
  const dmy = s.match(
    /^(\d{1,2})\.?\s+([A-Za-zæøåÆØÅ]+)\.?,?\s+(\d{4}),?\s+(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?\s*(am|pm)?/i,
  );
  if (dmy) return build(Number(dmy[3]), dmy[2]!, Number(dmy[1]), dmy[4]!, dmy[5]!, dmy[6], dmy[7]);

  // "Oct 12, 2026, 6:32:10 AM"
  const mdy = s.match(
    /^([A-Za-zæøåÆØÅ]+)\.?\s+(\d{1,2}),?\s+(\d{4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?/i,
  );
  if (mdy) return build(Number(mdy[3]), mdy[1]!, Number(mdy[2]), mdy[4]!, mdy[5]!, mdy[6], mdy[7]);

  // "12.10.2026 06:32" (dot/dash = day first) / "10/12/2026 06:32" (slash = US)
  const numeric = s.match(
    /^(\d{1,2})([./-])(\d{1,2})\2(\d{4}),?\s+(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?\s*(am|pm)?/i,
  );
  if (numeric) {
    const dayFirst = numeric[2] !== '/';
    const a = Number(numeric[1]);
    const b = Number(numeric[3]);
    return build(
      Number(numeric[4]),
      null,
      dayFirst ? a : b,
      numeric[5]!,
      numeric[6]!,
      numeric[7],
      numeric[8],
      // month index, not the 1-based month in the string
      (dayFirst ? b : a) - 1,
    );
  }

  const native = new Date(s);
  return Number.isNaN(native.getTime()) ? null : native;
}

function build(
  year: number,
  monthName: string | null,
  day: number,
  hour: string,
  minute: string,
  second?: string,
  meridiem?: string,
  monthNumber?: number,
): Date | null {
  let month = monthNumber;
  if (month == null) {
    const key = monthName!.toLowerCase().replace(/\./g, '');
    month = MONTHS[key];
  }
  if (month == null) return null;

  let h = Number(hour);
  const ampm = meridiem?.toLowerCase();
  if (ampm === 'pm' && h < 12) h += 12;
  if (ampm === 'am' && h === 12) h = 0;

  // Eksportens tidsstempler er UTC — bekræftet mod FIL- og GPX-filerne i
  // samme arkiv, hvor de har præcis samme værdi som sessionens start_time.
  // Derfor tolkes datoen som UTC. Gengivelsen i digesten sker så i
  // maskinens lokale zone, altså løberens egen klokke.
  const d = new Date(Date.UTC(year, month, day, h, Number(minute), Number(second ?? 0)));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Distance arrives in km in current exports and in metres in some older ones. */
export function distanceMeters(row: string[], map: ColumnMap): number | null {
  const n = num(row, map, 'distance');
  if (n == null) return null;
  return n > 200 ? n : n * 1000;
}
