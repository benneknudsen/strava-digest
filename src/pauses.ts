import type { TrackPoint } from './activity.ts';

export const PAUSE_MIN_SEC = 20;
export const PAUSE_MAX_M = 8;

/** Et step tæller som pause når fremdriften er under 8 m pr. 20 s. */
const PAUSE_MAX_MPS = PAUSE_MAX_M / PAUSE_MIN_SEC;

/** Længere huller er optagelseshuller og behandles som egne, isolerede pauser. */
const GAP_SEC = 60;

export function pauseMask(points: TrackPoint[]): boolean[] {
  const mask = new Array<boolean>(points.length).fill(false);
  if (points.length < 2) return mask;

  // Strava skriver distance i hvert andet punkt i sine FIT-filer. Et manglende
  // distance-felt betyder "ingen ny måling", ikke "ingen bevægelse". Klassificér
  // derfor hele spændet mellem to kendte distance-punkter på én gang: et 30 s
  // null-hul med 90 m fremdrift er bevægelse, ikke en pause.
  //
  // To gennemløb finder nærmeste kendte punkt før og efter hvert step, så
  // klassifikationen er lineær også for spor med 10.000+ punkter.
  const knownBefore = new Array<number>(points.length).fill(-1);
  let lastKnown = -1;
  for (let i = 0; i < points.length; i++) {
    knownBefore[i] = lastKnown;
    if (points[i]!.distM != null) lastKnown = i;
  }

  const knownAfter = new Array<number>(points.length).fill(-1);
  let nextKnown = -1;
  for (let i = points.length - 1; i >= 0; i--) {
    if (points[i]!.distM != null) nextKnown = i;
    knownAfter[i] = nextKnown;
  }

  let candidateSec = 0;
  let candidateSteps: number[] = [];

  const flush = () => {
    if (candidateSec >= PAUSE_MIN_SEC) {
      for (const i of candidateSteps) mask[i] = true;
    }
    candidateSec = 0;
    candidateSteps = [];
  };

  for (let i = 1; i < points.length; i++) {
    const a = knownBefore[i]!;
    const b = knownAfter[i]!;
    // Distance mangler i starten eller slutningen af sporet: steppet er
    // ukendt og behandles neutralt, så det hverken forlænger eller bryder et
    // segment. Har intet punkt distance, forbliver masken tom.
    if (a < 0 || b < 0) continue;

    const prev = points[i - 1]!;
    const cur = points[i]!;
    const dt = (cur.t.getTime() - prev.t.getTime()) / 1000;
    if (dt <= 0) continue;

    const from = points[a]!;
    const to = points[b]!;
    const spanDt = (to.t.getTime() - from.t.getTime()) / 1000;
    const spanDd = to.distM! - from.distM!;
    // Et step er "ikke-bevægende" kun når BEGGE regler gælder: den gamle
    // grænse pr. spænd (dd < PAUSE_MAX_M) og fremdriften pr. sekund
    // (dd / dt < PAUSE_MAX_M / PAUSE_MIN_SEC).
    const notMoving = spanDt > 0 && spanDd < PAUSE_MAX_M && spanDd / spanDt < PAUSE_MAX_MPS;

    if (dt > GAP_SEC) {
      flush();
      // Et hull er sin egen pause og bruger samme regel, så det hverken
      // giver flere eller længere pauser end før. Det må ikke lægges sammen
      // med et nabo-segment, så pauseTotals starter et nyt segment efter det.
      if (notMoving) mask[i] = true;
      continue;
    }

    if (notMoving) {
      candidateSec += dt;
      candidateSteps.push(i);
    } else {
      flush();
    }
  }
  flush();
  return mask;
}

export function pauseTotals(
  points: TrackPoint[],
  mask: boolean[] = pauseMask(points),
): { count: number; sec: number } {
  let count = 0;
  let sec = 0;
  let inPause = false;
  let previousWasGap = false;

  for (let i = 1; i < points.length; i++) {
    const dt = (points[i]!.t.getTime() - points[i - 1]!.t.getTime()) / 1000;
    // Enheden kan skrive samme sekund to gange. Et step uden positiv tid er
    // neutralt: tiden er allerede talt, så det hverken deler segmentet eller
    // lægger tid til.
    if (dt <= 0) continue;
    const isGap = dt > GAP_SEC;
    if (mask[i]) {
      // Et optagelseshul er altid sit eget segment — også når nabo-punkter
      // ligger i masken, så et hul ikke bliver til én kunstigt lang pause.
      if (!inPause || previousWasGap || isGap) {
        count++;
        inPause = true;
      }
      sec += dt;
    } else {
      inPause = false;
    }
    previousWasGap = isGap;
  }
  return { count, sec };
}
