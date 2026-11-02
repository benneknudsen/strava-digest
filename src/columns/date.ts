import { parseNamedOrNumericDate } from './date-formats.ts';

const MONTH_INDEX_MIN = 0;
const MONTH_INDEX_MAX = 11;
const DAY_OF_MONTH_MIN = 1;
const DAY_OF_MONTH_MAX = 31;
const HOUR_MIN = 0;
const HOUR_MAX = 23;
const MINUTE_MIN = 0;
const MINUTE_MAX = 59;
const SECOND_MIN = 0;
const SECOND_MAX = 59;
const TWELVE_HOUR_CLOCK_MIN = 1;
const TWELVE_HOUR_CLOCK_MAX = 12;
const HALF_DAY_HOURS = 12;

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
  if (
    monthIndex < MONTH_INDEX_MIN ||
    monthIndex > MONTH_INDEX_MAX ||
    day < DAY_OF_MONTH_MIN ||
    day > DAY_OF_MONTH_MAX
  ) {
    return false;
  }
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

function hasExplicitZone(value: string): boolean {
  return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
}

function appendUtcZoneIfMissing(value: string): string {
  return hasExplicitZone(value) ? value : `${value}Z`;
}

function parseIsoDate(s: string): Date | null | undefined {
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return undefined;
  // Validate the calendar date before new Date() rolls it over: "2026-02-30"
  // must be null, not 2 March.
  const [year, month, day] = s.slice(0, 10).split('-').map(Number);
  if (!isRealDate(year!, month! - 1, day!)) return null;
  // An explicit zone suffix is honoured as written. Without one the export's
  // wall-clock time is UTC, so append Z; a bare date becomes midnight UTC.
  const iso = new Date(appendUtcZoneIfMissing(s));
  if (Number.isNaN(iso.getTime())) return null;
  return iso;
}

function parseDateUnchecked(v: string): Date | null {
  const s = v.trim().replace(/\s+/g, ' ');
  if (!s) return null;
  const iso = parseIsoDate(s);
  if (iso !== undefined) return iso;
  return parseNamedOrNumericDate(s, build);
}

function applyMeridiem(hour: number, meridiem: string | undefined): number | null {
  const ampm = meridiem?.toLowerCase();
  if (!ampm) return hour;
  // AM/PM is only meaningful for a 12-hour clock.
  if (hour < TWELVE_HOUR_CLOCK_MIN || hour > TWELVE_HOUR_CLOCK_MAX) return null;
  if (ampm === 'pm' && hour < HALF_DAY_HOURS) return hour + HALF_DAY_HOURS;
  if (ampm === 'am' && hour === HALF_DAY_HOURS) return HOUR_MIN;
  return hour;
}

function isRealClock(hour: number, minute: number, second: number): boolean {
  return (
    hour >= HOUR_MIN &&
    hour <= HOUR_MAX &&
    minute >= MINUTE_MIN &&
    minute <= MINUTE_MAX &&
    second >= SECOND_MIN &&
    second <= SECOND_MAX
  );
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

  const h = applyMeridiem(Number(hour), meridiem);
  if (h == null) return null;
  const m = Number(minute);
  const sec = Number(second ?? 0);
  // Date.UTC rolls 25:00 into the next day and 06:61 into the next hour, so
  // validate the clock before building the date.
  if (!isRealClock(h, m, sec)) return null;

  // Eksportens tidsstempler er UTC — bekræftet mod FIL- og GPX-filerne i
  // samme arkiv, hvor de har præcis samme værdi som sessionens start_time.
  // Derfor tolkes datoen som UTC. Gengivelsen i digesten sker så i
  // maskinens lokale zone, altså løberens egen klokke.
  const d = new Date(Date.UTC(year, month, day, h, m, sec));
  return Number.isNaN(d.getTime()) ? null : d;
}
