import { gunzipSync } from 'node:zlib';
import FitParser from 'fit-file-parser';

export interface TrackPoint {
  t: Date;
  distM?: number;
  speedMps?: number;
  hr?: number;
  cad?: number;
  altM?: number;
  lat?: number;
  lon?: number;
}

export interface Lap {
  startIndex: number;
  movingSec: number;
  distanceM: number;
  avgHr?: number;
  maxHr?: number;
}

export interface Track {
  points: TrackPoint[];
  laps: Lap[];
  sport: string;
  source: 'fit' | 'gpx' | 'tcx';
  /** true when per-point distance had to be derived from GPS positions */
  distanceDerived: boolean;
}

export function parseActivityBuffer(filename: string, raw: Buffer): Track {
  const lower = filename.toLowerCase();
  const buf = lower.endsWith('.gz') ? maybeGunzip(raw) : raw;
  if (lower.includes('.fit')) return parseFit(buf);
  if (lower.endsWith('.gpx')) return parseGpx(buf.toString('utf8'));
  if (lower.endsWith('.tcx')) return parseTcx(buf.toString('utf8'));
  throw new Error(`ukendt aktivitetsformat: ${filename}`);
}

/* -------------------------------------------------------------------- FIT */

function parseFit(buf: Buffer): Track {
  const parser = new FitParser({
    mode: 'list',
    speedUnit: 'm/s',
    lengthUnit: 'm',
    temperatureUnit: 'celsius',
  });
  // fit-file-parser takes a callback; wrap it. A parse error is not fatal —
  // the CSV summary still carries the run, we just lose intra-run detail.
  // Buffer.from() gives a non-shared copy, which is what the typings want.
  let data: any;
  let failure: unknown;
  parser.parse(Buffer.from(buf), (err: unknown, parsed: unknown) => {
    if (err) failure = err;
    else data = parsed;
  });
  if (failure || !data) throw failure ?? new Error('FIT-parse fejlede');
  return trackFromFit(data);
}

function trackFromFit(data: any): Track {
  const rawRecords: any[] = data.records ?? [];
  const points: TrackPoint[] = [];
  for (const r of rawRecords) {
    const t = r.timestamp ? new Date(r.timestamp) : null;
    if (!t || Number.isNaN(t.getTime())) continue;
    points.push({
      t,
      distM: finite(r.distance),
      speedMps: finite(r.speed),
      hr: finite(r.heart_rate),
      cad: finite(r.cadence),
      altM: finite(r.altitude),
      lat: finite(r.position_lat),
      lon: finite(r.position_long),
    });
  }
  const sessions: any[] = data.sessions ?? [];
  const session = sessions[0] ?? {};
  const laps: Lap[] = (data.laps ?? []).map((l: any) => ({
    startIndex: 0,
    movingSec: finite(l.total_timer_time) ?? 0,
    distanceM: finite(l.total_distance) ?? 0,
    avgHr: finite(l.avg_heart_rate),
    maxHr: finite(l.max_heart_rate),
  }));
  return {
    points,
    laps,
    sport: typeof session.sport === 'string' ? session.sport : 'unknown',
    source: 'fit',
    distanceDerived: false,
  };
}

/* -------------------------------------------------------------------- GPX */

function parseGpx(xml: string): Track {
  const points: TrackPoint[] = [];
  const re = /<trkpt[^>]*lat="([-\d.]+)"[^>]*lon="([-\d.]+)"[^>]*>([\s\S]*?)<\/trkpt>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const body = m[3] ?? '';
    const time = body.match(/<time>([^<]+)<\/time>/);
    const ele = body.match(/<ele>([-\d.]+)<\/ele>/);
    const hr = body.match(/<(?:gpxtpx:)?hr>(\d+)<\/(?:gpxtpx:)?hr>/);
    const cad = body.match(/<(?:gpxtpx:)?cad>(\d+)<\/(?:gpxtpx:)?cad>/);
    const t = time?.[1] ? new Date(time[1]) : null;
    if (!t || Number.isNaN(t.getTime())) continue;
    points.push({
      t,
      lat: Number(m[1]),
      lon: Number(m[2]),
      altM: ele ? Number(ele[1]) : undefined,
      hr: hr ? Number(hr[1]) : undefined,
      cad: cad ? Number(cad[1]) : undefined,
    });
  }
  fillDistances(points);
  deriveSpeeds(points);
  return { points, laps: [], sport: 'unknown', source: 'gpx', distanceDerived: true };
}

/* -------------------------------------------------------------------- TCX */

function parseTcx(xml: string): Track {
  const points: TrackPoint[] = [];
  const sport = xml.match(/<Activity[^>]*Sport="([^"]+)"/i)?.[1] ?? 'unknown';
  const re = /<Trackpoint>([\s\S]*?)<\/Trackpoint>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const body = m[1] ?? '';
    const time = body.match(/<Time>([^<]+)<\/Time>/);
    const t = time?.[1] ? new Date(time[1]) : null;
    if (!t || Number.isNaN(t.getTime())) continue;
    const lat = body.match(/<LatitudeDegrees>([-\d.]+)<\/LatitudeDegrees>/);
    const lon = body.match(/<LongitudeDegrees>([-\d.]+)<\/LongitudeDegrees>/);
    const dist = body.match(/<DistanceMeters>([\d.]+)<\/DistanceMeters>/);
    const hr = body.match(/<HeartRateBpm[^>]*>\s*<Value>(\d+)<\/Value>/);
    const cad = body.match(/<Cadence>(\d+)<\/Cadence>/);
    points.push({
      t,
      lat: lat ? Number(lat[1]) : undefined,
      lon: lon ? Number(lon[1]) : undefined,
      distM: dist ? Number(dist[1]) : undefined,
      hr: hr ? Number(hr[1]) : undefined,
      cad: cad ? Number(cad[1]) : undefined,
      altM: undefined,
    });
  }
  const derived = !points.some((p) => p.distM != null);
  if (derived) fillDistances(points);
  deriveSpeeds(points);
  return { points, laps: [], sport, source: 'tcx', distanceDerived: derived };
}

/* --------------------------------------------------------------- helpers */

function finite(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * `.gz` in the filename is not a promise: mislabelled entries exist in the wild.
 * If it does not actually decompress, fall back to the raw bytes.
 */
function maybeGunzip(buf: Buffer): Buffer {
  try {
    return gunzipSync(buf);
  } catch {
    return buf;
  }
}

/** Cumulative haversine distance for tracks that carry GPS but no distance. */
export function fillDistances(points: TrackPoint[]): void {
  let acc = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    if (i > 0) {
      const q = points[i - 1]!;
      if (p.lat != null && p.lon != null && q.lat != null && q.lon != null) {
        acc += haversine(q.lat, q.lon, p.lat, p.lon);
      }
    }
    p.distM = acc;
  }
}

/** Derive per-point speed from distance/time when the track carries no speed field. */
export function deriveSpeeds(points: TrackPoint[]): void {
  const raw: number[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    if (p.speedMps != null) {
      raw.push(p.speedMps);
      continue;
    }
    const q = points[i - 1];
    if (!q || p.distM == null || q.distM == null) {
      raw.push(0);
      continue;
    }
    const dt = (p.t.getTime() - q.t.getTime()) / 1000;
    const dd = p.distM - q.distM;
    raw.push(dt > 0 && dd >= 0 ? dd / dt : 0);
  }
  // 5-point centred moving average — GPS-derived speed is far too noisy raw.
  const smooth = raw.map((_, i) => {
    const w = raw.slice(Math.max(0, i - 2), i + 3);
    return w.reduce((a, b) => a + b, 0) / w.length;
  });
  points.forEach((p, i) => {
    if (p.speedMps == null) p.speedMps = smooth[i]!;
  });
}

function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
