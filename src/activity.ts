import { gunzipSync } from 'node:zlib';
import FitParser from 'fit-file-parser';
import { activityFormatOf, formatMb, limitForFileName } from './limits.ts';

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

export interface Track {
  points: TrackPoint[];
  sport: string;
  /** read by the smoke tests as a format seam; production code does not branch on it */
  source: 'fit' | 'gpx' | 'tcx';
  /** true when per-point distance had to be derived from GPS positions */
  distanceDerived: boolean;
  /**
   * Sessionens samlede distance i meter, når filen oplyser den.
   * Strava skriver FIT-filerne selv, og de kan have et ufuldstændigt
   * distance-felt i hvert andet punkt — session-totalen er så det
   * autoritative tal, ikke det sidste punkt.
   */
  sessionDistanceM?: number;
  /** zonedata fra filen — kun sat når filen faktisk indeholder den */
  zones?: {
    maxHr?: number;
    /** fire stigende skæringspunkter (øvre puls for Z1–Z4) fra uret */
    boundaries?: number[];
  };
}

export function parseActivityBuffer(filename: string, raw: Buffer): Track {
  const format = activityFormatOf(filename);
  if (!format) throw new Error(`unknown activity format: ${filename}`);
  // Suffixet skal læses FØR `.gz` pakkes ud: `tur.tcx.gz` er stadig en TCX.
  const buf = filename.trim().toLowerCase().endsWith('.gz') ? maybeGunzip(filename, raw) : raw;
  switch (format) {
    case 'fit':
      return parseFit(buf);
    case 'gpx':
      return parseGpx(buf.toString('utf8'));
    case 'tcx':
      return parseTcx(buf.toString('utf8'));
  }
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
  if (failure || !data) throw failure ?? new Error('FIT parse failed');
  return trackFromFit(data);
}

function trackFromFit(data: any): Track {
  const rawRecords: any[] = data.records ?? [];
  const points = pointsFromFitRecords(rawRecords);
  const sessions: any[] = data.sessions ?? [];
  const session = sessions[0] ?? {};
  return {
    points,
    sport: typeof session.sport === 'string' ? session.sport : 'unknown',
    source: 'fit',
    distanceDerived: false,
    sessionDistanceM: finite(session.total_distance),
    zones: fitZones(data),
  };
}

/**
 * Strava skriver de eksporterede FIT-filer selv, og de ligner ikke en
 * watches egen fil: hvert felt kommer i sin egen besked, så det samme
 * tidspunkt står flere gange med hver sit felt. Parserens `list`-tilstand
 * giver derfor én post pr. besked — ikke én pr. måling. Uden at slå
 * beskederne sammen pr. tidspunkt forsvinder distance, puls og højde
 * (de ligger i hver deres besked), og turen ender som 0,00 km.
 *
 * Efter sammenlægning er `distance` kumulativ og står kun i hvert andet
 * punkt, så den interpoleres lineært mellem kendte målinger. Puls og
 * fart står også sporadisk og føres derfor frem (seneste værdi gælder).
 */
export function pointsFromFitRecords(
  rawRecords: any[],
  options?: { onStep?: () => void },
): TrackPoint[] {
  interface Merged {
    t: Date;
    dist?: number;
    speed?: number;
    hr?: number;
    cad?: number;
    alt?: number;
    lat?: number;
    lon?: number;
  }

  const byTime = new Map<number, Merged>();
  for (const r of rawRecords) {
    const t = r?.timestamp ? new Date(r.timestamp) : null;
    if (!t || Number.isNaN(t.getTime())) continue;
    const key = t.getTime();
    let m = byTime.get(key);
    if (!m) {
      m = { t };
      byTime.set(key, m);
    }
    const dist = finite(r.distance);
    if (dist != null) m.dist = dist;
    const speed = finite(r.speed);
    if (speed != null) m.speed = speed;
    const hr = finite(r.heart_rate);
    if (hr != null) m.hr = hr;
    const cad = finite(r.cadence);
    if (cad != null) m.cad = cad;
    // Strava skriver højden som enhanced_altitude; watches skriver altitude.
    const alt = finite(r.enhanced_altitude) ?? finite(r.altitude);
    if (alt != null) m.alt = alt;
    const lat = finite(r.position_lat);
    if (lat != null) m.lat = lat;
    const lon = finite(r.position_long);
    if (lon != null) m.lon = lon;
  }

  const merged = [...byTime.values()].sort((a, b) => a.t.getTime() - b.t.getTime());
  if (!merged.length) return [];

  // Kumulativ distance: interpolér mellem de målinger der findes.
  const known: number[] = [];
  merged.forEach((m, i) => {
    if (m.dist != null) known.push(i);
  });
  if (known.length) {
    const onStep = options?.onStep;
    let next = 0;
    let lo = -1;
    for (let i = 0; i < merged.length; i++) {
      const m = merged[i]!;
      if (m.dist != null) continue;
      while (next < known.length) {
        onStep?.();
        if (known[next]! >= i) break;
        lo = known[next]!;
        next += 1;
      }
      const hi = next < known.length ? known[next]! : -1;
      if (lo < 0) {
        m.dist = merged[hi]!.dist;
      } else if (hi < 0) {
        m.dist = merged[lo]!.dist;
      } else {
        const a = merged[lo]!;
        const b = merged[hi]!;
        const span = b.t.getTime() - a.t.getTime();
        const f = span > 0 ? (m.t.getTime() - a.t.getTime()) / span : 0;
        m.dist = a.dist! + (b.dist! - a.dist!) * f;
      }
    }
  }

  // Puls og fart føres frem: seneste måling gælder indtil den næste.
  let lastHr: number | undefined;
  let lastSpeed: number | undefined;
  let lastCad: number | undefined;
  let lastAlt: number | undefined;
  for (const m of merged) {
    if (m.hr != null) lastHr = m.hr;
    else m.hr = lastHr;
    if (m.speed != null) lastSpeed = m.speed;
    else m.speed = lastSpeed;
    if (m.cad != null) lastCad = m.cad;
    else m.cad = lastCad;
    if (m.alt != null) lastAlt = m.alt;
    else m.alt = lastAlt;
  }

  const points: TrackPoint[] = merged.map((m) => ({
    t: m.t,
    distM: m.dist,
    speedMps: m.speed,
    hr: m.hr,
    cad: m.cad,
    altM: m.alt,
    lat: m.lat,
    lon: m.lon,
  }));
  if (!known.length) {
    // Ingen distance i filen: udled den af GPS'en.
    fillDistances(points);
    deriveSpeeds(points);
  }
  return points;
}

/**
 * Læs urets egen zonekonfiguration, når FIT-filen har den: `zones_target`
 * bærer max-pulsen, `hr_zone` de fire stigende grænser. Parserens output er
 * arrays pr. beskedtype (zones_target dog en enkelt besked), så guard mod
 * tomt/undefined. Ingen påhit: findes intet, returneres undefined.
 */
function fitZones(data: any): Track['zones'] {
  const maxHr = toArray(data?.zones_target)
    .map((t) => finite(t?.max_heart_rate))
    .find((v): v is number => v != null && v > 0);
  const highs = toArray(data?.hr_zone)
    .map((z) => finite(z?.high_bpm))
    .filter((v): v is number => v != null && v > 0);
  const boundaries =
    highs.length === 4 && highs.every((v, i) => i === 0 || v > highs[i - 1]!) ? highs : undefined;
  if (maxHr == null && boundaries == null) return undefined;
  const zones: NonNullable<Track['zones']> = {};
  if (maxHr != null) zones.maxHr = maxHr;
  if (boundaries) zones.boundaries = boundaries;
  return zones;
}

function toArray(v: unknown): any[] {
  if (Array.isArray(v)) return v;
  return v == null ? [] : [v];
}

/* -------------------------------------------------------------------- GPX */

function parseGpx(xml: string): Track {
  const points: TrackPoint[] = [];
  const re = /<trkpt\b([^>]*)>([\s\S]*?)<\/trkpt>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const attrs = m[1] ?? '';
    // Match the attribute boundary, not a word boundary: `\b` also matches at
    // `-`, so it would read `data-lat="99"` as `lat`.
    const lat = attrs.match(/(?:^|\s)lat="([-\d.]+)"/);
    const lon = attrs.match(/(?:^|\s)lon="([-\d.]+)"/);
    if (!lat || !lon) continue;
    const body = m[2] ?? '';
    const time = body.match(/<time>([^<]+)<\/time>/);
    const ele = body.match(/<ele>([-\d.]+)<\/ele>/);
    const hr = body.match(/<(?:gpxtpx:)?hr>(\d+)<\/(?:gpxtpx:)?hr>/);
    const cad = body.match(/<(?:gpxtpx:)?cad>(\d+)<\/(?:gpxtpx:)?cad>/);
    const t = time?.[1] ? new Date(time[1]) : null;
    if (!t || Number.isNaN(t.getTime())) continue;
    points.push({
      t,
      lat: Number(lat[1]),
      lon: Number(lon[1]),
      altM: ele ? Number(ele[1]) : undefined,
      hr: hr ? Number(hr[1]) : undefined,
      cad: cad ? Number(cad[1]) : undefined,
    });
  }
  fillDistances(points);
  deriveSpeeds(points);
  const trk = xml.match(/<trk(?:\s[^>]*)?>([\s\S]*?)<\/trk>/i)?.[1] ?? '';
  const sport = trk.match(/<type>([^<]+)<\/type>/i)?.[1]?.trim().toLowerCase() || 'unknown';
  return { points, sport, source: 'gpx', distanceDerived: true };
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
  return { points, sport, source: 'tcx', distanceDerived: derived };
}

/* --------------------------------------------------------------- helpers */

function finite(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * `.gz` in the filename is not a promise: mislabelled entries exist in the wild.
 * Content without the gzip magic bytes falls back to the raw bytes.
 *
 * Content with the magic bytes is a gzip file. A corrupt or truncated stream
 * must fail honestly instead of falling back to bytes that cannot parse. A
 * stream that expands past the activity-file limit is a zip bomb; zlib's
 * ERR_BUFFER_TOO_LARGE gets its own message.
 */
function maybeGunzip(filename: string, buf: Buffer): Buffer {
  const isGzip = buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
  if (!isGzip) return buf;
  const limit = limitForFileName(filename);
  try {
    return gunzipSync(buf, { maxOutputLength: limit });
  } catch (err) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
      throw new Error(
        `${filename} unpacks to more than ${formatMb(limit)} — a Strava export does not ship activity files that size.`,
      );
    }
    throw new Error(`${filename} is a corrupt gzip file`);
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
