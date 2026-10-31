import type { CsvTable } from './csv.ts';

/**
 * Strava localises the export: the same column arrives as "Average Heart Rate"
 * or "Gennemsnitlig puls", and a third-party importer has already been broken by
 * non-English headers. So we never trust header names positionally — we map
 * through aliases and report the populated columns we cannot place: the agent
 * format as a count, Markdown as the names, so a new alias is one edit.
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

/**
 * Aliases per field, per language. Strava localises the export, so the same
 * column arrives under a different name depending on the account language.
 * English and Danish are the ones we have real exports for; the rest are the
 * obvious translations and are cheap to add — one line each.
 *
 * `id`, `avgSpeed`, `temperature`, `avgCadence`, `maxCadence` and `avgWatts`
 * are mapped but never read by the digest: they stay so a populated-but-unused
 * export column does not show up in the "unmapped" count. Removing them would
 * change the digest's notes.
 */
const ALIASES: Record<Field, string[]> = {
  id: ['activity id', 'aktivitet id', 'aktivitets id', 'id', 'aktivitats id'],
  date: [
    'activity date',
    'aktivitet dato',
    'aktivitetdato',
    'dato',
    'startdato',
    'start date',
    'aktivitatsdatum',
    'datum',
    'fecha de actividad',
    'date de activite',
  ],
  name: [
    'activity name',
    'aktivitet navn',
    'aktivitetnavn',
    'navn',
    'title',
    'aktivitatsnamn',
    'name',
    'nom de lactivite',
    'nombre',
  ],
  type: [
    'activity type',
    'aktivitetstype',
    'aktivitet type',
    'sport',
    'sports type',
    'aktivitatstyp',
    'aktivitatstype',
    'type dactivite',
    'tipo de actividad',
  ],
  elapsedSec: [
    'elapsed time',
    'samlet tid',
    'forlobet tid',
    'forloebet tid',
    'varighed',
    'verbrannte zeit',
    'gesamtzeit',
    'tidsforbruk',
    'tid anvand',
    'duree totale',
    'tiempo total',
  ],
  movingSec: [
    'moving time',
    'bevaegelsestid',
    'bevagelsestid',
    'tid i bevaegelse',
    'bewegungszeit',
    'rortid',
    'beweegtijd',
    'duree en mouvement',
    'tiempo en movimiento',
  ],
  distance: [
    'distance',
    'afstand',
    'distance km',
    'distancen',
    'distanz',
    'distanse',
    'afstand km',
    'distancia',
    'distanza',
    'distans',
  ],
  avgHr: [
    'average heart rate',
    'gennemsnitlig puls',
    'gennemsnitspuls',
    'gns puls',
    'average hr',
    'avg hr',
    'durchschnittliche herzfrequenz',
    'mittlere herzfrequenz',
    'genomsnittlig hjartefrekvens',
    'gemiddelde hartfrequentie',
    'frecuencia cardiaca media',
    'frequence cardiaque moyenne',
  ],
  maxHr: [
    'max heart rate',
    'maks puls',
    'makspuls',
    'max puls',
    'max hr',
    'maximale herzfrequenz',
    'hoechste herzfrequenz',
    'maksimal hjartefrekvens',
    'maximale hartfrequentie',
    'frecuencia cardiaca maxima',
    'frequence cardiaque maximale',
  ],
  avgCadence: [
    'average cadence',
    'gennemsnitlig kadence',
    'gns kadence',
    'durchschnittliche kadenz',
    'snittkadens',
    'gemiddelde cadans',
    'cadencia media',
  ],
  maxCadence: [
    'max cadence',
    'maks kadence',
    'maximale kadenz',
    'maksimalkadens',
    'maximale cadans',
    'cadencia maxima',
  ],
  avgWatts: [
    'average watts',
    'gennemsnitlig watt',
    'gns watt',
    'durchschnittliche watt',
    'genomsnittlig watt',
    'gemiddelde watt',
    'potencia media',
  ],
  relativeEffort: [
    'relative effort',
    'relativ indsats',
    'relativ effort',
    'relative anstrengung',
    'relativt anstrengelse',
    'relatieve inspanning',
    'esfuerzo relativo',
  ],
  elevationGain: [
    'elevation gain',
    'hojdeforogelse',
    'stigning',
    'hoejdeforoegelse',
    'samlet stigning',
    'hoehenzuwachs',
    'hoehenanstieg',
    'hohenanstieg',
    'hohen zuwachs',
    'hoying',
    'total hoying',
    'toename in hoogte',
    'desnivelado acumulado',
  ],
  calories: [
    'calories',
    'kalorier',
    'kalorier',
    'kalorien',
    'kcal',
    'calories',
  ],
  gear: [
    'activity gear',
    'aktivitetsudstyr',
    'aktivitet udstyr',
    'udstyr',
    'gear',
    'ausrustung',
    'utrustning',
    'uitrusting',
    'equipo',
  ],
  filename: ['filename', 'filnavn', 'fil', 'dateiname', 'filnavn', 'bestandsnaam', 'nombre de archivo'],
  avgSpeed: [
    'average speed',
    'gennemsnitshastighed',
    'gennemsnitlig hastighed',
    'durchschnittsgeschwindigkeit',
    'snittfart',
    'gemiddelde snelheid',
    'velocidad media',
  ],
  temperature: [
    'weather temperature',
    'temperatur',
    'vejr temperatur',
    'wettertemperatur',
    'temperatur ved',
    'weertemperatuur',
    'temperatura',
  ],
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
  /** headers we could not place, and that hold a value in at least one row */
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

  // Strava's export has 50+ optional columns, and almost all of them are
  // empty for almost every activity. Listing them all is noise: the point
  // of the note is to say which columns the tool could not place, and an
  // empty column carries no information worth an agent's tokens. So only
  // the columns that actually hold a value are reported.
  const unmatchedIdx = table.headers
    .map((_, i) => i)
    .filter((i) => !used.has(i))
    .filter((i) => table.headers[i]);
  const populatedIdx = unmatchedIdx.filter((i) =>
    table.rows.some((row) => (row[i] ?? '').trim() !== ''),
  );
  const unmatched = populatedIdx.map((i) => table.headers[i]!);
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
  return parseNumber(raw(row, map, field));
}

function parseNumber(value: string): number | null {
  const v = value.replace(/[^\d.,-]/g, '').replace(/\s/g, '');
  if (!v) return null;
  // Per-value rule, not per account locale: num() receives no locale. When
  // both "," and "." appear, the rightmost is the decimal separator, so
  // "1,234.5" (en) and "1.234,5" (de/da) both become 1234.5. With one kind of
  // separator, a repeated separator ("2.345.678") and a 1-3 digit group
  // before a 3-digit tail ("1.234", "1,234", "1,234,567") are thousands;
  // everything else is decimal ("10.5", "12,5", "0.123"). So "1.234" is
  // German/Dutch 1234, never English 1.234.
  let normalized: string;
  const comma = v.lastIndexOf(',');
  const dot = v.lastIndexOf('.');
  if (comma >= 0 && dot >= 0) {
    const decimal = comma > dot ? ',' : '.';
    const thousands = decimal === ',' ? '.' : ',';
    normalized = v.split(thousands).join('').replace(decimal, '.');
  } else {
    const sep = comma >= 0 ? ',' : dot >= 0 ? '.' : '';
    if (!sep) {
      normalized = v;
    } else {
      const parts = v.split(sep);
      const [head = '', tail = ''] = parts;
      const headDigits = head.replace(/^-/, '');
      const grouped =
        parts.length === 2 &&
        tail.length === 3 &&
        headDigits.length >= 1 &&
        headDigits.length <= 3 &&
        headDigits[0] !== '0';
      normalized = parts.length > 2 || grouped ? parts.join('') : `${head}.${tail}`;
    }
  }
  const n = Number.parseFloat(normalized);
  return Number.isFinite(n) ? n : null;
}

/** Accepts "52:31", "1:02:11", "1875.4" (seconds) or "1 t 30 min". */
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
  // Units are mandatory wherever they disambiguate. In the hour branch the
  // minute unit may only be omitted when nothing follows (1h30), and a seconds
  // group may only follow a number that carries its minute unit. Without that,
  // "1 h 30 s" splits into minutes "3" and seconds "0" and invents 3780.
  const hourUnit = '(?:timer|time|hours|hour|hrs|hr|h|t)';
  const minUnit = '(?:minutter|minutes|minute|mins|min|m)';
  const secUnit = '(?:sekunder|sekund|seconds|second|secs|sec|sek|s)';
  const textual = v.match(
    new RegExp(
      `^\\s*(?:` +
        `(\\d+)\\s*${hourUnit}` +
          `(?:` +
            `\\s*(\\d+)\\s*${minUnit}(?:\\s*(\\d+)\\s*${secUnit})?` +
            `|\\s*(\\d+)\\s*${secUnit}` +
            `|\\s*(\\d+)` +
          `)?` +
        `|(\\d+)\\s*${minUnit}(?:\\s*(\\d+)\\s*${secUnit})?` +
        `|(\\d+)\\s*${secUnit}` +
      `)\\s*[.,;]*\\s*$`,
      'i',
    ),
  );
  if (textual) {
    if (textual[1] != null) {
      if (textual[2] != null) {
        return Number(textual[1]) * 3600 + Number(textual[2]) * 60 + Number(textual[3] ?? 0);
      }
      if (textual[4] != null) return Number(textual[1]) * 3600 + Number(textual[4]);
      return Number(textual[1]) * 3600 + Number(textual[5] ?? 0) * 60;
    }
    if (textual[6] != null) {
      return Number(textual[6]) * 60 + Number(textual[7] ?? 0);
    }
    return Number(textual[8]);
  }
  // A string with letters that matched no pattern is not a number. Scraping
  // the digits would turn "abc123" into a made-up duration.
  if (/[a-z]/i.test(v)) return null;
  return num(row, map, field);
}

/**
 * Month names, keyed by their accent-stripped lowercase form. Strava writes
 * the month in the account language, so the same export needs "October",
 * "oktober", "Oktober", "octobre", "oktober" or "octubre" to all mean month
 * 10. `normalizeMonthKey` strips the accents, so "février" is stored as
 * "fevrier" and "März" as "marz".
 */
const MONTHS: Record<string, number> = {
  jan: 0, january: 0, januar: 0, janvier: 0, enero: 0, januari: 0,
  feb: 1, february: 1, februar: 1, fevrier: 1, febrero: 1, februari: 1,
  mar: 2, march: 2, marts: 2, marz: 2, mars: 2, marzo: 2, maart: 2,
  apr: 3, april: 3, avril: 3, abril: 3,
  may: 4, maj: 4, mai: 4, mayo: 4, mei: 4,
  jun: 5, june: 5, juni: 5, junio: 5,
  jul: 6, july: 6, juli: 6,
  aug: 7, august: 7, aout: 7, agosto: 7, augusti: 7, avgust: 7,
  sep: 8, sept: 8, september: 8, septembre: 8, septiembre: 8,
  oct: 9, october: 9, okt: 9, oktober: 9, octobre: 9, octubre: 9,
  nov: 10, november: 10, novembre: 10, noviembre: 10,
  dec: 11, december: 11, desember: 11, decembre: 11, diciembre: 11,
};

/** lowercase, drop dots, strip accents and the Danish letters */
function normalizeMonthKey(monthName: string): string {
  return monthName
    .toLowerCase()
    .replace(/\./g, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/æ/g, 'ae')
    .replace(/ø/g, 'o')
    .replace(/å/g, 'a')
    .trim();
}

/** true kun når y/m/d findes i kalenderen — Date.UTC ruller ellers over. */
function isRealDate(year: number, monthIndex: number, day: number): boolean {
  if (monthIndex < 0 || monthIndex > 11 || day < 1 || day > 31) return false;
  const d = new Date(Date.UTC(year, monthIndex, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === monthIndex && d.getUTCDate() === day;
}

/**
 * Strava localises the export, and the date is part of it: an English account
 * writes "Oct 12, 2026, 6:32:10 AM", a Danish one "12. okt. 2026, 06:32" —
 * which `new Date()` cannot read at all. Worse, `new Date("12.10.2026")` parses
 * as 10 December (US order), so a silent fallback would invent wrong dates.
 * We therefore parse explicitly. The export carries UTC wall-clock time with
 * no zone; when the string has no explicit zone it is interpreted as UTC, so
 * the result does not depend on the machine's timezone.
 *
 * Calendar and clock values are validated, so `Date.UTC` cannot roll a bad
 * date or time into the next day. Dates more than one day in the future are
 * rejected, because an activity cannot start tomorrow; this also keeps a bad
 * row from moving the digest's anchor. A string that cannot be parsed returns
 * `null`, and `parseActivities` reports it as a skipped row. The
 * `Date.toString()` form ("Mon Oct 12 2026 06:32:10 GMT+0200 (...)") is not a
 * Strava format and is no longer parsed; such a row is now reported instead of
 * disappearing.
 */
export function parseDate(v: string): Date | null {
  const d = parseDateUnchecked(v);
  if (!d) return null;
  return isPlausibleDate(d) ? d : null;
}

/** Hvor langt ud i fremtiden en dato må ligge, før den afvises. */
const MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;

/**
 * true når datoen er en rigtig dato, der ikke ligger mere end et døgn ude i
 * fremtiden. Reglen bor kun her: et pas kan ikke starte i morgen, og en dårlig
 * CSV-række eller et dårligt trackpunkt må ikke flytte digestens anker.
 */
export function isPlausibleDate(d: Date | null | undefined): boolean {
  if (!d || Number.isNaN(d.getTime())) return false;
  return d.getTime() <= Date.now() + MAX_FUTURE_SKEW_MS;
}

function parseDateUnchecked(v: string): Date | null {
  const s = v.trim().replace(/\s+/g, ' ');
  if (!s) return null;

  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    // Validate the calendar date before new Date() rolls it over: "2026-02-30"
    // must be null, not 2 March.
    const [year, month, day] = s.slice(0, 10).split('-').map(Number);
    if (!isRealDate(year!, month! - 1, day!)) return null;
    // An explicit zone suffix is honoured as written. Without one the export's
    // wall-clock time is UTC, so append Z; a bare date becomes midnight UTC.
    const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(s);
    const iso = new Date(hasZone ? s : `${s}Z`);
    return Number.isNaN(iso.getTime()) ? null : iso;
  }

  // RFC 2822 with an explicit zone, e.g. "Tue, 12 Oct 2026 06:32:10 GMT".
  // Parse the fields ourselves and run them through build(), so the calendar
  // date and the clock are validated like every other branch. The explicit
  // zone makes the result TZ-independent.
  const rfc = s.match(
    /^[A-Za-z]{3},? (\d{1,2}) ([A-Za-z]{3}) (\d{4}) (\d{2}):(\d{2})(?::(\d{2}))? (GMT|UTC|([+-])(\d{2})(\d{2}))$/i,
  );
  if (rfc) {
    const local = build(Number(rfc[3]), rfc[2]!, Number(rfc[1]), rfc[4]!, rfc[5]!, rfc[6]);
    if (!local) return null;
    if (/^(?:GMT|UTC)$/i.test(rfc[7]!)) return local;
    const offsetHours = Number(rfc[9]);
    const offsetMinutes = Number(rfc[10]);
    if (offsetHours > 23 || offsetMinutes > 59) return null;
    const offset = (rfc[8] === '-' ? -1 : 1) * (offsetHours * 60 + offsetMinutes);
    return new Date(local.getTime() - offset * 60_000);
  }

  // "12. okt. 2026, 06:32(:10)" / "12 oktober 2026 06.32"
  // "12 de octubre de 2026, 06:32" (spansk) — "de" står før og efter navnet
  const dmy = s.match(
    /^(\d{1,2})\.?\s+(?:de\s+)?([A-Za-z\u00C0-\u024FæøåÆØÅ]+)\.?(?:\s+de)?,?\s+(\d{4}),?\s+(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?\s*(am|pm)?/i,
  );
  if (dmy) return build(Number(dmy[3]), dmy[2]!, Number(dmy[1]), dmy[4]!, dmy[5]!, dmy[6], dmy[7]);

  // "Oct 12, 2026, 6:32:10 AM"
  const mdy = s.match(
    /^([A-Za-z\u00C0-\u024FæøåÆØÅ]+)\.?\s+(\d{1,2}),?\s+(\d{4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?/i,
  );
  if (mdy) return build(Number(mdy[3]), mdy[1]!, Number(mdy[2]), mdy[4]!, mdy[5]!, mdy[6], mdy[7]);

  // "12.10.2026 06:32" (dot/dash = day first) / "10/12/2026 06:32" (slash = US)
  // The time is optional, so the bare date uses the same order. Slash is
  // month-first because Strava writes it that way for a US account. If the
  // primary order is not a real calendar date, try the other order once; this
  // keeps "12.13.2026" as 13 December while "10/12/2026" stays 12 October.
  const numeric = s.match(
    /^(\d{1,2})([./-])(\d{1,2})\2(\d{4})(?:,?\s+(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?\s*(am|pm)?)?$/i,
  );
  if (numeric) {
    const dayFirst = numeric[2] !== '/';
    const a = Number(numeric[1]);
    const b = Number(numeric[3]);
    const year = Number(numeric[4]);
    const hour = numeric[5] ?? '0';
    const minute = numeric[6] ?? '0';
    const primary = build(
      year,
      null,
      dayFirst ? a : b,
      hour,
      minute,
      numeric[7],
      numeric[8],
      // month index, not the 1-based month in the string
      (dayFirst ? b : a) - 1,
    );
    if (primary) return primary;
    return build(
      year,
      null,
      dayFirst ? b : a,
      hour,
      minute,
      numeric[7],
      numeric[8],
      (dayFirst ? a : b) - 1,
    );
  }

  // Date-only forms from the same languages: "12. okt. 2026" /
  // "12 de octubre de 2026" / "October 12, 2026".
  const dmyDate = s.match(
    /^(\d{1,2})\.?\s+(?:de\s+)?([A-Za-z\u00C0-\u024FæøåÆØÅ]+)\.?(?:\s+de)?,?\s+(\d{4})$/i,
  );
  if (dmyDate) return build(Number(dmyDate[3]), dmyDate[2]!, Number(dmyDate[1]), '0', '0');

  const mdyDate = s.match(
    /^([A-Za-z\u00C0-\u024FæøåÆØÅ]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/i,
  );
  if (mdyDate) return build(Number(mdyDate[3]), mdyDate[1]!, Number(mdyDate[2]), '0', '0');

  // "2026/10/12" and "2026.10.12", with or without a time.
  const yearFirst = s.match(
    /^(\d{4})([./])(\d{1,2})\2(\d{1,2})(?:,?\s+(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?\s*(am|pm)?)?$/i,
  );
  if (yearFirst) {
    return build(
      Number(yearFirst[1]),
      null,
      Number(yearFirst[4]),
      yearFirst[5] ?? '0',
      yearFirst[6] ?? '0',
      yearFirst[7],
      yearFirst[8],
      // month index, not the 1-based month in the string
      Number(yearFirst[3]) - 1,
    );
  }

  return null;
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
    month = MONTHS[normalizeMonthKey(monthName!)];
  }
  if (month == null) return null;
  if (!isRealDate(year, month, day)) return null;

  let h = Number(hour);
  const ampm = meridiem?.toLowerCase();
  if (ampm) {
    // AM/PM is only meaningful for a 12-hour clock.
    if (h < 1 || h > 12) return null;
    if (ampm === 'pm' && h < 12) h += 12;
    if (ampm === 'am' && h === 12) h = 0;
  }
  const m = Number(minute);
  const sec = Number(second ?? 0);
  // Date.UTC rolls 25:00 into the next day and 06:61 into the next hour, so
  // validate the clock before building the date.
  if (h < 0 || h > 23 || m < 0 || m > 59 || sec < 0 || sec > 59) return null;

  // Eksportens tidsstempler er UTC — bekræftet mod FIL- og GPX-filerne i
  // samme arkiv, hvor de har præcis samme værdi som sessionens start_time.
  // Derfor tolkes datoen som UTC. Gengivelsen i digesten sker så i
  // maskinens lokale zone, altså løberens egen klokke.
  const d = new Date(Date.UTC(year, month, day, h, m, sec));
  return Number.isNaN(d.getTime()) ? null : d;
}

type DistanceUnit = 'm' | 'km' | 'mi' | 'scandi-mil';

const UNIT_FACTOR: Record<DistanceUnit, number> = {
  m: 1,
  km: 1000,
  mi: 1609.344,
  // Danish, Swedish and Norwegian "mil" is 10 km, not a mile.
  'scandi-mil': 10_000,
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
export function distanceUnits(table: CsvTable, map: ColumnMap): DistanceUnits {
  const distanceIndexes = map.index.get('distance') ?? [];
  const hasDistanceValue = distanceIndexes.some((index) =>
    table.rows.some((row) => (row[index] ?? '').trim() !== ''),
  );
  if (!distanceIndexes.length || !hasDistanceValue) {
    return { factorAt: () => 1000, assumed: false };
  }

  const unitIndexes = table.headers
    .map((header, index) => (isDistanceUnitHeader(header) ? index : -1))
    .filter((index) => index >= 0);

  let columnUnit: DistanceUnit | null = null;
  let unitColumnUnusable = false;
  if (unitIndexes.length) {
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
    if (!unreadable && seen.size === 1) columnUnit = [...seen][0]!;
    else unitColumnUnusable = true;
  }

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

  return { factorAt: (index) => factors.get(index) ?? 1000, assumed: usedScale && unitColumnUnusable };
}

/** Median of the column's non-empty numeric values. */
function columnScaleFactor(table: CsvTable, index: number): number {
  const values: number[] = [];
  for (const row of table.rows) {
    const value = parseNumber((row[index] ?? '').trim());
    if (value != null) values.push(value);
  }
  if (!values.length) return 1000;
  values.sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  const median =
    values.length % 2 === 0 ? (values[middle - 1]! + values[middle]!) / 2 : values[middle]!;
  return median > 200 ? 1 : 1000;
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
    return n == null ? null : n * units.factorAt(index);
  }
  return null;
}
