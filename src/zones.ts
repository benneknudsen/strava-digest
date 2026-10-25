import type { TrackPoint } from './activity.ts';
import { pauseMask } from './pauses.ts';

export interface ZoneConfig {
  maxHr: number;
  source: 'flag' | 'fit' | 'export-observation';
  /** Øvre puls for Z1, Z2, Z3 og Z4 — fire interne skæringspunkter. */
  boundaries: number[];
}

export const ZONE_NAMES = ['Z1', 'Z2', 'Z3', 'Z4', 'Z5'] as const;

/**
 * Standardzonemodel i procent af max-puls: Z1 50–60, Z2 60–70, Z3 70–80,
 * Z4 80–90, Z5 90–100. Returnerer de fire skæringspunkter.
 */
export function boundariesFromMaxHr(maxHr: number): number[] {
  return [0.6, 0.7, 0.8, 0.9].map((f) => f * maxHr);
}

/**
 * Vælg zonekonfiguration uden opdigtede tal: `--max-hr` vinder, ellers
 * urets egne zoner fra FIT-filen, ellers ingen zonefordeling (`null`).
 * Har filen kun grænser og ikke max-puls, udledes max-pulsen af den øverste
 * grænse med samme standardmodel (Z4 slutter ved 90 % af max).
 */
export function resolveZoneConfig(
  explicitMaxHr: number | null | undefined,
  fitZone: { maxHr?: number; boundaries?: number[] } | null | undefined,
  fallbackMaxHr?: number | null,
): ZoneConfig | null {
  if (isPositive(explicitMaxHr)) {
    return { maxHr: explicitMaxHr, source: 'flag', boundaries: boundariesFromMaxHr(explicitMaxHr) };
  }
  if (fitZone) {
    const maxHr = isPositive(fitZone.maxHr) ? fitZone.maxHr : undefined;
    const boundaries = validBoundaries(fitZone.boundaries) ? fitZone.boundaries : undefined;
    if (maxHr == null && boundaries == null) return null;
    const resolvedMaxHr = maxHr ?? Math.round(boundaries![3]! / 0.9);
    return { maxHr: resolvedMaxHr, source: 'fit', boundaries: boundaries ?? boundariesFromMaxHr(resolvedMaxHr) };
  }
  // Sidste udfald: den højeste puls i eksporten. Den er et gæt — ikke urets
  // egen max-puls — men den er bedre end ingen zoner, og kilden står i
  // headeren, så ingen agent kan læse den som en værdi der kom andet steds fra.
  if (isPositive(fallbackMaxHr)) {
    return {
      maxHr: fallbackMaxHr,
      source: 'export-observation',
      boundaries: boundariesFromMaxHr(fallbackMaxHr),
    };
  }
  return null;
}

/**
 * Puls under første grænse (også under 50 % af max) lægges i Z1 — clamp,
 * ikke en sjette zone.
 */
export function zoneIndex(hr: number, boundaries: number[]): number {
  let zone = 0;
  for (let i = 0; i < boundaries.length && i < ZONE_NAMES.length - 1; i++) {
    if (hr >= boundaries[i]!) zone = i + 1;
  }
  return zone;
}

/**
 * Effektiv tid pr. zone (sekunder, fem buckets) med samme pause-regel som
 * splits: spring over når punktet ligger i en pause, og når optagelsen
 * mangler (dt > 60 s). Kun punkter med puls tæller. Masken bør komme fra
 * `analyseRun`, så sporet kun parses én gang.
 */
export function zoneSeconds(
  points: TrackPoint[],
  cfg: ZoneConfig,
  mask: boolean[] = pauseMask(points),
): number[] {
  const buckets = [0, 0, 0, 0, 0];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]!;
    const cur = points[i]!;
    const dt = (cur.t.getTime() - prev.t.getTime()) / 1000;
    if (dt <= 0 || dt > 60) continue;
    if (mask[i]) continue;
    if (cur.hr == null || cur.hr <= 0) continue;
    buckets[zoneIndex(cur.hr, cfg.boundaries)]! += dt;
  }
  return buckets;
}

export function zonePcts(seconds: number[]): number[] {
  const total = seconds.reduce((a, b) => a + b, 0);
  return seconds.map((s) => (total > 0 ? (s / total) * 100 : 0));
}

function isPositive(v: number | null | undefined): v is number {
  return v != null && Number.isFinite(v) && v > 0;
}

function validBoundaries(b: number[] | undefined): b is number[] {
  return (
    Array.isArray(b) &&
    b.length === 4 &&
    b.every((v, i) => Number.isFinite(v) && v > 0 && (i === 0 || v > b[i - 1]!))
  );
}
