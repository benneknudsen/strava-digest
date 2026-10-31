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
  date: Date;
  name: string;
  type: string;
  distanceM: number | null;
  movingSec: number | null;
  elapsedSec: number | null;
  avgHr: number | null;
  maxHr: number | null;
  relativeEffort: number | null;
  /** only in the CSV export; kept because the smoke tests read it */
  elevationGain: number | null;
  /**
   * Kept only because the smoke test reads it: the loose-file path checks that
   * it is null. No test covers the CSV parse of this column.
   */
  calories: number | null;
  gear: string;
  filename: string;
  isRun: boolean;
}

/**
 * Typer der betyder løb. Vandre- og hike-ord er bevidst udeladt: tysk "Wanderung",
 * hollandsk "Wandeling" og fransk "randonnée" er aktiviteter, ikke løb, og
 * må ikke forvrænge run-count eller pace. Listen er ikke en udtømmende
 * blokliste over vandre-ord. "passeio" og "loop" bliver, fordi deres
 * betydning er reelt tvetydig i kildesproget (portugisisk gåtur, hollandsk
 * løb). Tilføj ikke "spaziergang", "vandring", "paseo" eller "caminata"
 * for at "rette" listen.
 */
export const RUN_TYPES = [
  'run',
  'running',
  'trailrun',
  'trail run',
  'virtualrun',
  'virtual run',
  'lob',
  'loeb',
  'lope',
  // German
  'lauf',
  'laufg',
  // Swedish / Norwegian
  'lopning',
  'lopping',
  'lop',
  'traillop',
  // Dutch
  'hardlopen',
  'loop',
  // French
  'course',
  'course a pied',
  'course pied',
  // Spanish / Italian / Portuguese
  'carrera',
  'corsa',
  'corrida',
  'passeio',
  // Finnish
  'juoksu',
];

/**
 * Strava oversætter aktivitetstyperne til kontosprog: "Run" bliver "Løb".
 * Sprogtegnene skal normaliseres, ellers falder typen ud af listen og
 * alle 195 løb i eksporten forsvinder fra digesten.
 */
export function normalizeType(type: string): string {
  return type
    .toLowerCase()
    // NFD + combining-mark removal folds every Latin accent: ö→o, é→e,
    // ü→u, ñ→n. Without it a Swedish "Löp" became "lp" — the letter was
    // deleted, not folded — so no alias could ever match it.
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    // æ, ø and å are separate letters and do not decompose.
    .replace(/æ/g, 'ae')
    .replace(/ø/g, 'o')
    .replace(/å/g, 'a')
    .replace(/[^a-z ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface ActivityStats {
  /** Every activity row in the CSV, including rows that were skipped. */
  rowsInExport: number;
  /** Rows dropped because the date was missing or could not be parsed. These rows are not in the digest. */
  skippedNoDate: number;
  /** Of `skippedNoDate`, rows that also had no file name. */
  skippedNoDateNoFilename: number;
  /**
   * Highest max heart rate among the rows dropped for a missing or unparsable
   * date. They are not in the digest, but their Max HR is still a real
   * observation from the export, so the observed max can include it.
   */
  maxHrOfSkipped: number | null;
}

export interface ParsedActivities {
  activities: ActivityRow[];
  stats: ActivityStats;
}

/**
 * Build the activity rows from the CSV.
 *
 * A row without a file name is still a real activity. Its distance and time
 * fields may be present in the CSV, and they may also be blank; this function
 * keeps whatever the CSV has and lets the caller decide what to do with it.
 * The row is kept with an empty `filename`, so the caller can mark it as
 * unanalysed instead of dropping it silently. Whether it reaches the digest
 * depends on the caller's activity-type filter. A row whose date is missing or
 * cannot be parsed cannot be placed on the timeline; it is counted in `stats`
 * instead.
 */
export function parseActivities(table: CsvTable, map: ColumnMap): ParsedActivities {
  const activities: ActivityRow[] = [];
  const stats: ActivityStats = {
    rowsInExport: table.rows.length,
    skippedNoDate: 0,
    skippedNoDateNoFilename: 0,
    maxHrOfSkipped: null,
  };
  for (const row of table.rows) {
    const date = parseDate(raw(row, map, 'date'));
    const filename = raw(row, map, 'filename');
    const maxHr = num(row, map, 'maxHr');
    if (!date) {
      stats.skippedNoDate += 1;
      if (!filename) stats.skippedNoDateNoFilename += 1;
      if (maxHr != null && maxHr > 0) {
        stats.maxHrOfSkipped = Math.max(stats.maxHrOfSkipped ?? 0, maxHr);
      }
      continue;
    }
    const type = raw(row, map, 'type');
    activities.push({
      // Removing `ActivityRow.id` also drops the `id` key from `--json` output; deliberate per issue #20.
      date,
      name: raw(row, map, 'name') || '(no name)',
      type: type || '(unknown)',
      distanceM: distanceMeters(row, map),
      movingSec: durationSec(row, map, 'movingSec'),
      elapsedSec: durationSec(row, map, 'elapsedSec'),
      avgHr: num(row, map, 'avgHr'),
      maxHr,
      relativeEffort: num(row, map, 'relativeEffort'),
      elevationGain: num(row, map, 'elevationGain'),
      calories: num(row, map, 'calories'),
      gear: raw(row, map, 'gear'),
      filename,
      isRun: RUN_TYPES.includes(normalizeType(type)),
    });
  }
  activities.sort((a, b) => b.date.getTime() - a.date.getTime());
  return { activities, stats };
}

/**
 * En række plus analysen af dens fil, når filen kunne læses. Baseline skal
 * kunne bruge filens puls, når CSV'en ikke har den.
 */
export interface WindowRun {
  row: ActivityRow;
  analysis?: { avgHr: number | null } | null;
}

/** Sum over a trailing window (used for the baseline block). */
export function windowStats(runs: WindowRun[], days: number, before: Date) {
  const from = new Date(before.getTime() - days * 86_400_000);
  const inWindow = runs.filter((r) => r.row.date > from && r.row.date <= before);
  const distanceKm = inWindow.reduce((s, r) => s + (r.row.distanceM ?? 0) / 1000, 0);
  // Pace needs both distance and time, and uses the same filter as the agent format.
  const paceRows = inWindow.filter(
    (r) => (r.row.distanceM ?? 0) > 0 && r.row.movingSec != null,
  );
  const paceSec = paceRows.reduce((s, r) => s + r.row.movingSec!, 0);
  const paceKm = paceRows.reduce((s, r) => s + r.row.distanceM! / 1000, 0);
  // Samme puls-regel som run-linjerne: CSV'en vinder, filens værdi er
  // fallback. Kun rækker med en kendt puls tæller i nævneren.
  const hrSamples = inWindow
    .map((r) => r.row.avgHr ?? r.analysis?.avgHr)
    .filter((h): h is number => h != null);
  return {
    days,
    count: inWindow.length,
    distanceKm,
    runsPerWeek: (inWindow.length / days) * 7,
    avgPaceSecPerKm: paceKm > 0 ? paceSec / paceKm : null,
    avgHr: hrSamples.length ? hrSamples.reduce((a, b) => a + b, 0) / hrSamples.length : null,
    longestKm: inWindow.reduce((m, r) => Math.max(m, (r.row.distanceM ?? 0) / 1000), 0),
  };
}
