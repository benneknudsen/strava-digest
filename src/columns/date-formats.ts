const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;
const MAX_OFFSET_HOURS = 23;
const MAX_OFFSET_MINUTES = 59;

export type BuildDate = (
  year: number,
  monthName: string | null,
  day: number,
  hour: string,
  minute: string,
  second?: string,
  meridiem?: string,
  monthNumber?: number,
) => Date | null;

function offsetSign(value: string): number {
  return value === '-' ? -1 : 1;
}

function offsetMilliseconds(sign: number, hours: number, minutes: number): number {
  return sign * (hours * MINUTES_PER_HOUR + minutes) * MS_PER_MINUTE;
}

interface DayMonth {
  day: number;
  monthIndex: number;
}

function dayMonthInOrder(dayFirst: boolean, first: number, second: number): DayMonth {
  if (dayFirst) return { day: first, monthIndex: second - 1 };
  return { day: second, monthIndex: first - 1 };
}

// RFC 2822 with an explicit zone, e.g. "Tue, 12 Oct 2026 06:32:10 GMT".
// Parse the fields ourselves and run them through build(), so the calendar
// date and the clock are validated like every other branch. The explicit
// zone makes the result TZ-independent.
function parseRfcDate(s: string, build: BuildDate): Date | null | undefined {
  const rfc = s.match(
    /^[A-Za-z]{3},? (\d{1,2}) ([A-Za-z]{3}) (\d{4}) (\d{2}):(\d{2})(?::(\d{2}))? (GMT|UTC|([+-])(\d{2})(\d{2}))$/i,
  );
  if (!rfc) return undefined;
  const local = build(Number(rfc[3]), rfc[2]!, Number(rfc[1]), rfc[4]!, rfc[5]!, rfc[6]);
  if (!local) return null;
  if (/^(?:GMT|UTC)$/i.test(rfc[7]!)) return local;
  const offsetHours = Number(rfc[9]);
  const offsetMinutes = Number(rfc[10]);
  if (offsetHours > MAX_OFFSET_HOURS || offsetMinutes > MAX_OFFSET_MINUTES) return null;
  const offset = offsetMilliseconds(offsetSign(rfc[8]!), offsetHours, offsetMinutes);
  return new Date(local.getTime() - offset);
}

// "12. okt. 2026, 06:32(:10)" / "12 oktober 2026 06.32"
// "12 de octubre de 2026, 06:32" (spansk) — "de" står før og efter navnet
function parseDayMonthWithTime(s: string, build: BuildDate): Date | null | undefined {
  const dmy = s.match(
    /^(\d{1,2})\.?\s+(?:de\s+)?([A-Za-z\u00C0-\u024FæøåÆØÅ]+)\.?(?:\s+de)?,?\s+(\d{4}),?\s+(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?\s*(am|pm)?/i,
  );
  if (!dmy) return undefined;
  return build(Number(dmy[3]), dmy[2]!, Number(dmy[1]), dmy[4]!, dmy[5]!, dmy[6], dmy[7]);
}

// "Oct 12, 2026, 6:32:10 AM"
function parseMonthDayWithTime(s: string, build: BuildDate): Date | null | undefined {
  const mdy = s.match(
    /^([A-Za-z\u00C0-\u024FæøåÆØÅ]+)\.?\s+(\d{1,2}),?\s+(\d{4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?/i,
  );
  if (!mdy) return undefined;
  return build(Number(mdy[3]), mdy[1]!, Number(mdy[2]), mdy[4]!, mdy[5]!, mdy[6], mdy[7]);
}

// "12.10.2026 06:32" (dot/dash = day first) / "10/12/2026 06:32" (slash = US)
// The time is optional, so the bare date uses the same order. Slash is
// month-first because Strava writes it that way for a US account. If the
// primary order is not a real calendar date, try the other order once; this
// keeps "12.13.2026" as 13 December while "10/12/2026" stays 12 October.
function parseNumericDate(s: string, build: BuildDate): Date | null | undefined {
  const numeric = s.match(
    /^(\d{1,2})([./-])(\d{1,2})\2(\d{4})(?:,?\s+(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?\s*(am|pm)?)?$/i,
  );
  if (!numeric) return undefined;
  const dayFirst = numeric[2] !== '/';
  const a = Number(numeric[1]);
  const b = Number(numeric[3]);
  const year = Number(numeric[4]);
  const hour = numeric[5] ?? '0';
  const minute = numeric[6] ?? '0';
  const primary = dayMonthInOrder(dayFirst, a, b);
  const parsed = build(
    year,
    null,
    primary.day,
    hour,
    minute,
    numeric[7],
    numeric[8],
    primary.monthIndex,
  );
  if (parsed) return parsed;
  const secondary = dayMonthInOrder(!dayFirst, a, b);
  return build(
    year,
    null,
    secondary.day,
    hour,
    minute,
    numeric[7],
    numeric[8],
    secondary.monthIndex,
  );
}

// Date-only forms from the same languages: "12. okt. 2026" /
// "12 de octubre de 2026" / "October 12, 2026".
function parseDayMonthDate(s: string, build: BuildDate): Date | null | undefined {
  const dmyDate = s.match(
    /^(\d{1,2})\.?\s+(?:de\s+)?([A-Za-z\u00C0-\u024FæøåÆØÅ]+)\.?(?:\s+de)?,?\s+(\d{4})$/i,
  );
  if (!dmyDate) return undefined;
  return build(Number(dmyDate[3]), dmyDate[2]!, Number(dmyDate[1]), '0', '0');
}

function parseMonthDayDate(s: string, build: BuildDate): Date | null | undefined {
  const mdyDate = s.match(
    /^([A-Za-z\u00C0-\u024FæøåÆØÅ]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/i,
  );
  if (!mdyDate) return undefined;
  return build(Number(mdyDate[3]), mdyDate[1]!, Number(mdyDate[2]), '0', '0');
}

// "2026/10/12" and "2026.10.12", with or without a time.
function parseYearFirstDate(s: string, build: BuildDate): Date | null | undefined {
  const yearFirst = s.match(
    /^(\d{4})([./])(\d{1,2})\2(\d{1,2})(?:,?\s+(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?\s*(am|pm)?)?$/i,
  );
  if (!yearFirst) return undefined;
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

export function parseNamedOrNumericDate(s: string, build: BuildDate): Date | null {
  const parsers = [
    parseRfcDate,
    parseDayMonthWithTime,
    parseMonthDayWithTime,
    parseNumericDate,
    parseDayMonthDate,
    parseMonthDayDate,
    parseYearFirstDate,
  ];
  for (const parser of parsers) {
    const result = parser(s, build);
    if (result !== undefined) return result;
  }
  return null;
}
