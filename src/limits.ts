const MB = 1024 * 1024;

export const ACTIVITY_FILE_LIMIT_BYTES = 10 * MB;
export const EXPORT_FILE_LIMIT_BYTES = 100 * MB;

export type ActivityFormat = 'fit' | 'gpx' | 'tcx';

/**
 * Which parser the file needs, or null. This is the single answer to
 * "is this an activity file?" — both the size limit and the parser use it.
 *
 * A trailing `.gz` is a transport layer, not part of the format. `.fit`
 * counts anywhere in the name because the FIT parser has always accepted
 * that, so the 10 MB limit must cover those names too. `.gpx` and `.tcx`
 * only count as a suffix, exactly as before.
 */
export function activityFormatOf(name: string): ActivityFormat | null {
  const lower = name.trim().toLowerCase().replace(/\.gz$/, '');
  if (lower.includes('.fit')) return 'fit';
  if (lower.endsWith('.gpx')) return 'gpx';
  if (lower.endsWith('.tcx')) return 'tcx';
  return null;
}

/**
 * One answer for both the byte limit and the wording in the error.
 *
 * The limit must follow the parser that actually runs, not the filename
 * suffix. If `activityFormatOf` recognises an activity format, the activity
 * limit applies even when the name ends in `.csv` — `Big.fit.csv` is parsed
 * as FIT. Only names that no parser accepts can fall through to the CSV
 * rule. Everything else gets the low activity limit, so a new or forgotten
 * file type cannot inherit the high limit; its error says "other files"
 * because that is the limit it actually used.
 */
function limitInfoForFileName(name: string): { limit: number; kind: string } {
  if (activityFormatOf(name) != null) {
    return { limit: ACTIVITY_FILE_LIMIT_BYTES, kind: 'activity files' };
  }
  if (name.trim().toLowerCase().endsWith('.csv')) {
    return { limit: EXPORT_FILE_LIMIT_BYTES, kind: 'export files' };
  }
  return { limit: ACTIVITY_FILE_LIMIT_BYTES, kind: 'other files' };
}

export function limitForFileName(name: string): number {
  return limitInfoForFileName(name).limit;
}

export function formatMb(bytes: number): string {
  const mb = Math.ceil((bytes / MB) * 10) / 10;
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
}

export function tooLargeError(name: string, bytes: number): Error {
  const { limit, kind } = limitInfoForFileName(name);
  const shipKind = kind === 'other files' ? 'files' : kind;
  return new Error(
    `${name} is ${formatMb(bytes)}, which is larger than the ${formatMb(limit)} limit for ${kind} — a Strava export does not ship ${shipKind} that size.`,
  );
}
