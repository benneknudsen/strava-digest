import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Track } from './activity.ts';
import type { RunAnalysis } from './analysis.ts';
import { RUN_TYPES, type ActivityRow } from './strava.ts';

/**
 * Løse aktivitetsfiler — en enkelt fil eller en mappe uden `activities.csv`.
 * Metadata læses fra filen selv; felter der kun findes i bulk-eksportens CSV
 * (Relative Effort, udstyr, kalorier) udelades frem for at blive opdigtet.
 */

const ACTIVITY_FILE_RE = /\.(fit|gpx|tcx)(\.gz)?$/i;

export function isActivityFile(name: string): boolean {
  return ACTIVITY_FILE_RE.test(name.trim());
}

/**
 * Én fil giver `[filen]`; en mappe walkes rekursivt. Skjulte mapper og
 * `media/` springes over — de indeholder aldrig aktivitetsfiler.
 */
export async function collectActivityFiles(path: string): Promise<string[]> {
  const st = await stat(path);
  if (!st.isDirectory()) return isActivityFile(path) ? [path] : [];
  const files: string[] = [];

  async function walk(dir: string): Promise<void> {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (e.name.startsWith('.') || e.name.toLowerCase() === 'media') continue;
        await walk(join(dir, e.name));
      } else if (isActivityFile(e.name)) {
        files.push(join(dir, e.name));
      }
    }
  }

  await walk(path);
  return files.sort();
}

/**
 * Mindste antal punkter der kan beskrive et pas. Under dette er filen
 * degenereret — et enkelt punkt giver hverken varighed eller distance.
 */
export const MIN_TRACK_POINTS = 2;

/**
 * Byg en digest-række ud fra filen alene. Returnerer `null` når filen ikke har
 * et eneste punkt med gyldig tid, eller når den har for få punkter til at være
 * et pas — kaldstedet springer den så over med en note.
 */
export function rowFromTrack(
  filePath: string,
  track: Track,
  analysis: RunAnalysis | null,
): ActivityRow | null {
  if (track.points.length < MIN_TRACK_POINTS) return null;
  const first = track.points.find((p) => p.t instanceof Date && !Number.isNaN(p.t.getTime()));
  if (!first) return null;
  const last = track.points[track.points.length - 1]!;
  const filename = basename(filePath);
  // En fil uden distance-felter efterlader `last.distM` som undefined — 0 ville
  // ellers blive læst som en rigtig distance på nul kilometer.
  const distanceM = last.distM != null && Number.isFinite(last.distM) ? last.distM : null;
  return {
    id: '',
    date: first.t,
    name: filename.replace(/\.gz$/i, '').replace(/\.[^.]+$/, '') || filename,
    type: track.sport === 'unknown' ? 'ukendt' : track.sport,
    distanceM,
    movingSec: analysis?.movingSec ?? null,
    elapsedSec: Math.max(0, (last.t.getTime() - first.t.getTime()) / 1000),
    avgHr: analysis?.avgHr ?? null,
    maxHr: analysis?.maxHr ?? null,
    relativeEffort: null,
    elevationGain: null,
    calories: null,
    gear: '',
    filename,
    isRun: RUN_TYPES.includes(track.sport.toLowerCase()),
  };
}
