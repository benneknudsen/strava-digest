import type { ColumnMap, Field } from './aliases.ts';
import { num, raw } from './number.ts';

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;

function fromHoursMinutesSeconds(hours: number, minutes: number, seconds: string | undefined): number {
  return hours * SECONDS_PER_HOUR + minutes * SECONDS_PER_MINUTE + Number(seconds ?? 0);
}

function fromHoursSeconds(hours: number, seconds: string): number {
  return hours * SECONDS_PER_HOUR + Number(seconds);
}

function fromHoursAndOptionalMinutes(hours: number, minutes: string | undefined): number {
  return hours * SECONDS_PER_HOUR + Number(minutes ?? 0) * SECONDS_PER_MINUTE;
}

function fromMinutesSeconds(minutes: number, seconds: string | undefined): number {
  return minutes * SECONDS_PER_MINUTE + Number(seconds ?? 0);
}

function textualDurationToSeconds(v: string): number | null | undefined {
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
  if (!textual) return undefined;
  if (textual[1] != null) {
    if (textual[2] != null) {
      return fromHoursMinutesSeconds(Number(textual[1]), Number(textual[2]), textual[3]);
    }
    if (textual[4] != null) return fromHoursSeconds(Number(textual[1]), textual[4]);
    return fromHoursAndOptionalMinutes(Number(textual[1]), textual[5]);
  }
  if (textual[6] != null) return fromMinutesSeconds(Number(textual[6]), textual[7]);
  return Number(textual[8]);
}

/** Accepts "52:31", "1:02:11", "1875.4" (seconds) or "1 t 30 min". */
export function durationSec(row: string[], map: ColumnMap, field: Field): number | null {
  const v = raw(row, map, field);
  if (!v) return null;
  const hms = v.match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?$/);
  if (hms) {
    const first = Number(hms[1]);
    const second = Number(hms[2]);
    const third = hms[3];
    if (third != null) return fromHoursMinutesSeconds(first, second, third);
    return first * SECONDS_PER_MINUTE + second;
  }
  const textual = textualDurationToSeconds(v);
  if (textual !== undefined) return textual;
  // A string with letters that matched no pattern is not a number. Scraping
  // the digits would turn "abc123" into a made-up duration.
  if (/[a-z]/i.test(v)) return null;
  return num(row, map, field);
}
