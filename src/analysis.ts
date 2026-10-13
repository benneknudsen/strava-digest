import type { Track, TrackPoint } from './activity.ts';

export interface Split {
  km: number;
  paceSecPerKm: number | null;
  avgHr: number | null;
  elevDeltaM: number | null;
  partial: boolean;
}

export interface RunAnalysis {
  movingSec: number;
  distanceM: number;
  elevGainM: number;
  avgPaceSecPerKm: number | null;
  avgHr: number | null;
  maxHr: number | null;
  avgCadence: number | null;
  splits: Split[];
  /** pace-normalised aerobic decoupling, % — positive = HR drifted up while pace held */
  hrDriftPct: number | null;
  /** negative = second half faster (a negative split) */
  secondHalfPaceDeltaSec: number | null;
  pauseCount: number;
  pauseSec: number;
  /** coefficient of variation of per-km pace, % — how evenly the pace was held */
  paceCvPct: number | null;
  distanceDerived: boolean;
}

const PAUSE_MIN_SEC = 20;
const PAUSE_MAX_M = 8;

export function analyseRun(track: Track): RunAnalysis {
  const pts = track.points;
  const stops = findPauses(pts);

  const first = pts[0];
  const last = pts[pts.length - 1];
  const movingSec =
    first && last ? Math.max(0, (last.t.getTime() - first.t.getTime()) / 1000 - stops.sec) : 0;
  const distanceM = last?.distM ?? 0;

  const hrs = pts.map((p) => p.hr).filter((h): h is number => h != null && h > 0);
  const cads = pts.map((p) => p.cad).filter((c): c is number => c != null && c > 0);
  const splits = buildSplits(pts);

  return {
    movingSec,
    distanceM,
    elevGainM: elevationGain(pts),
    avgPaceSecPerKm: distanceM > 200 ? movingSec / (distanceM / 1000) : null,
    avgHr: hoursWeightedMean(pts, (p) => p.hr),
    maxHr: hrs.length ? Math.max(...hrs) : null,
    avgCadence: cads.length ? cads.reduce((a, b) => a + b, 0) / cads.length : null,
    splits,
    hrDriftPct: hrDrift(pts),
    secondHalfPaceDeltaSec: halfDelta(pts),
    pauseCount: stops.count,
    pauseSec: stops.sec,
    paceCvPct: paceCv(splits),
    distanceDerived: track.distanceDerived,
  };
}

/* ------------------------------------------------------------- per-km splits */

function buildSplits(pts: TrackPoint[]): Split[] {
  if (pts.length < 3) return [];
  const buckets = new Map<number, { time: number; dist: number; hr: number; hrTime: number; elev: number }>();

  for (let i = 1; i < pts.length; i++) {
    const prev = pts[i - 1]!;
    const cur = pts[i]!;
    if (prev.distM == null || cur.distM == null) continue;
    const dd = cur.distM - prev.distM;
    const dt = (cur.t.getTime() - prev.t.getTime()) / 1000;
    if (dd < 0 || dt <= 0) continue;
    const dtEff = dd < PAUSE_MAX_M && dt > PAUSE_MIN_SEC ? 0 : dt;
    const km = Math.floor(prev.distM / 1000);
    const b = buckets.get(km) ?? { time: 0, dist: 0, hr: 0, hrTime: 0, elev: 0 };
    b.time += dtEff;
    b.dist += dd;
    if (cur.hr != null && cur.hr > 0) {
      b.hr += cur.hr * dtEff;
      b.hrTime += dtEff;
    }
    if (prev.altM != null && cur.altM != null) b.elev += cur.altM - prev.altM;
    buckets.set(km, b);
  }

  const totalKm = Math.floor((pts[pts.length - 1]!.distM ?? 0) / 1000);
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([km, b]) => ({
      km: km + 1,
      paceSecPerKm: b.dist > 100 ? b.time / (b.dist / 1000) : null,
      avgHr: b.hrTime > 0 ? b.hr / b.hrTime : null,
      elevDeltaM: b.elev,
      partial: km >= totalKm,
    }));
}

/* ------------------------------------------------------------------ HR drift */

/**
 * Pace-normalised aerobic decoupling (a simplified Pa:HR drift): compare
 * speed/HR in the first half with the second, excluding pauses and warm-up.
 * A number above ~5 % on a steady effort is the usual sign the aerobic cost
 * rose while output stayed flat.
 */
function hrDrift(pts: TrackPoint[]): number | null {
  const usable = pts.filter(
    (p) => p.hr != null && p.hr > 0 && p.speedMps != null && p.speedMps > 0.5,
  );
  if (usable.length < 60) return null;
  const trimmed = usable.slice(Math.floor(usable.length * 0.1), usable.length);
  const half = Math.floor(trimmed.length / 2);
  const a = efficiency(trimmed.slice(0, half));
  const b = efficiency(trimmed.slice(half));
  if (a == null || b == null || a === 0) return null;
  return ((a - b) / a) * 100;
}

function efficiency(pts: TrackPoint[]): number | null {
  const speed = mean(pts.map((p) => p.speedMps).filter((s): s is number => s != null && s > 0));
  const hr = mean(pts.map((p) => p.hr).filter((h): h is number => h != null && h > 0));
  if (speed == null || hr == null || hr === 0) return null;
  return speed / hr;
}

/* ------------------------------------------------------- halves & steadiness */

function halfDelta(pts: TrackPoint[]): number | null {
  const usable = pts.filter((p) => p.distM != null && p.speedMps != null && p.speedMps > 0.5);
  if (usable.length < 60) return null;
  const splitAt = usable.findIndex((p) => (p.distM ?? 0) >= (usable[usable.length - 1]!.distM ?? 0) / 2);
  if (splitAt < 10) return null;
  const first = paceOf(usable.slice(1, splitAt));
  const second = paceOf(usable.slice(splitAt));
  if (first == null || second == null) return null;
  return second - first;
}

function paceOf(pts: TrackPoint[]): number | null {
  const dist = (pts[pts.length - 1]!.distM ?? 0) - (pts[0]?.distM ?? 0);
  const sec = (pts[pts.length - 1]!.t.getTime() - pts[0]!.t.getTime()) / 1000;
  if (dist < 200 || sec <= 0) return null;
  return sec / (dist / 1000);
}

function paceCv(splits: Split[]): number | null {
  const paces = splits.filter((s) => !s.partial && s.paceSecPerKm != null).map((s) => s.paceSecPerKm!);
  if (paces.length < 3) return null;
  const m = mean(paces)!;
  const variance = paces.reduce((s, p) => s + (p - m) ** 2, 0) / paces.length;
  return m > 0 ? (Math.sqrt(variance) / m) * 100 : null;
}

/* ---------------------------------------------------------------- pauses */

function findPauses(pts: TrackPoint[]): { count: number; sec: number } {
  let count = 0;
  let sec = 0;
  for (let i = 1; i < pts.length; i++) {
    const dt = (pts[i]!.t.getTime() - pts[i - 1]!.t.getTime()) / 1000;
    const dd = (pts[i]!.distM ?? 0) - (pts[i - 1]!.distM ?? 0);
    if (dt > PAUSE_MIN_SEC && dd < PAUSE_MAX_M) {
      count++;
      sec += dt;
    }
  }
  return { count, sec };
}

function elevationGain(pts: TrackPoint[]): number {
  let gain = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!.altM;
    const b = pts[i]!.altM;
    if (a == null || b == null) continue;
    const d = b - a;
    if (d > 0 && d < 5) gain += d; // ignore barometric spikes
  }
  return gain;
}

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

function hoursWeightedMean(pts: TrackPoint[], pick: (p: TrackPoint) => number | undefined): number | null {
  let sum = 0;
  let weight = 0;
  for (let i = 1; i < pts.length; i++) {
    const dt = (pts[i]!.t.getTime() - pts[i - 1]!.t.getTime()) / 1000;
    const v = pick(pts[i]!);
    if (v == null || v <= 0 || dt <= 0 || dt > 60) continue;
    sum += v * dt;
    weight += dt;
  }
  return weight > 0 ? sum / weight : null;
}
