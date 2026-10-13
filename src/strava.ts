import type { CsvTable } from './csv.ts';
import {
  type ColumnMap,
  distanceMeters,
  durationSec,
  num,
  parseDate,
  raw,
} from './columns.ts';

export interface ActivityRow {
  id: string;
  date: Date;
  name: string;
  type: string;
  distanceM: number | null;
  movingSec: number | null;
  elapsedSec: number | null;
  avgHr: number | null;
  maxHr: number | null;
  relativeEffort: number | null;
  elevationGain: number | null;
  calories: number | null;
  gear: string;
  filename: string;
  isRun: boolean;
}

export const RUN_TYPES = ['run', 'running', 'trailrun', 'trail run', 'virtualrun', 'virtual run', 'lob', 'loeb'];

export function toActivities(table: CsvTable, map: ColumnMap): ActivityRow[] {
  const out: ActivityRow[] = [];
  for (const row of table.rows) {
    const date = parseDate(raw(row, map, 'date'));
    const filename = raw(row, map, 'filename');
    if (!date || !filename) continue;
    const type = raw(row, map, 'type');
    out.push({
      id: raw(row, map, 'id'),
      date,
      name: raw(row, map, 'name') || '(uden navn)',
      type: type || '(ukendt)',
      distanceM: distanceMeters(row, map),
      movingSec: durationSec(row, map, 'movingSec'),
      elapsedSec: durationSec(row, map, 'elapsedSec'),
      avgHr: num(row, map, 'avgHr'),
      maxHr: num(row, map, 'maxHr'),
      relativeEffort: num(row, map, 'relativeEffort'),
      elevationGain: num(row, map, 'elevationGain'),
      calories: num(row, map, 'calories'),
      gear: raw(row, map, 'gear'),
      filename,
      isRun: RUN_TYPES.includes(type.toLowerCase().replace(/[^a-z ]/g, '').trim()),
    });
  }
  out.sort((a, b) => b.date.getTime() - a.date.getTime());
  return out;
}

/** Sum over a trailing window (used for the baseline block). */
export function windowStats(runs: ActivityRow[], days: number, before: Date) {
  const from = new Date(before.getTime() - days * 86_400_000);
  const inWindow = runs.filter((r) => r.date > from && r.date <= before);
  const distanceKm = inWindow.reduce((s, r) => s + (r.distanceM ?? 0) / 1000, 0);
  const movingSec = inWindow.reduce((s, r) => s + (r.movingSec ?? 0), 0);
  const hrSamples = inWindow.map((r) => r.avgHr).filter((h): h is number => h != null);
  return {
    days,
    count: inWindow.length,
    distanceKm,
    runsPerWeek: (inWindow.length / days) * 7,
    avgPaceSecPerKm: distanceKm > 0 && movingSec > 0 ? movingSec / distanceKm : null,
    avgHr: hrSamples.length ? hrSamples.reduce((a, b) => a + b, 0) / hrSamples.length : null,
    longestKm: inWindow.reduce((m, r) => Math.max(m, (r.distanceM ?? 0) / 1000), 0),
  };
}
