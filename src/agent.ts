/**
 * Agent-format: en digest, der er optimeret til en LLM — ikke til et menneske.
 *
 * Principper (jf. skill "personal-data-export-digest"):
 *  1. Selvbeskrivende — hvert felt har en nøgle, og nøglernes betydning
 *     står én gang i en SCHEMA-sektion. Agenten skal ikke gætte.
 *  2. Fast felt-rækkefølge — hver løb-række har præcis samme nøgler i
 *     samme rækkefølge, så den kan læses positionelt.
 *  3. Dækkende — ALLE løb i eksporten, ikke et udvalg. Et snit gør
 *     agentens konklusioner om tendenser ubrugelige.
 *  4. Afledte tal med — de felter kilden ikke har (splits, HR-drift,
 *     zoner, pace-jævnhed) er hele pointen. Uden dem gentager agenten
 *     bare brugerens egne tal.
 *  5. Kontekst indlejret — plan, søvn og formål, ellers kan agenten kun
 *     beskrive en tur, ikke vurdere den.
 *
 * Talformat: decimaltegn er ALTID punktum (maskinlæsbar), null er `-`.
 * Enheder står i SCHEMA'en, ikke på hver værdi.
 */
import type { DigestedRun } from './digest.ts';
import { maxValue, minValue } from './minmax.ts';
import { MIN_P95_VALUES } from './zones.ts';

export interface AgentInput {
  sourceLabel: string;
  activitiesInExport: number;
  runsTotal: number;
  /** De løb der beskrives linje for linje (--last), nyeste først. */
  runs: DigestedRun[];
  /**
   * Alle løb i eksporten, nyeste først. WEEKS, WINDOW og STATS regnes herfra,
   * så --last kun begrænser hvilke løb der beskrives — ikke hvad der tælles.
   */
  allRuns: DigestedRun[];
  /** Hvor mange af de nyeste løb der får fuld split-opdeling. */
  detailCount: number;
  baselineDays: number;
  contextText: string;
  generatedAt: Date;
  maxHr: number | null;
  maxHrSource: 'flag' | 'fit' | 'export-p95' | 'export-max' | null;
  notes: string[];
}

const MISSING = '-';

/**
 * Et løb bidrager til load og zoner kun når sporet er analyseret OG analysen
 * gav zone-sekunder. Et løb uden pulssamples har en analyse, men `zones` er
 * `null`, så det bidrager ikke. Denne prædikat er den eneste definition af
 * "har et load-bidrag" — gate, WEEKS, WINDOW og STATS bruger den alle.
 */
function hasLoad(run: DigestedRun): boolean {
  return run.analysis != null && run.analysis.zones != null;
}

/** Tal med punktum som decimaltegn; `null` bliver `-`. */
function n(v: number | null | undefined, digits = 0): string {
  if (v == null || !Number.isFinite(v)) return MISSING;
  return v.toFixed(digits);
}

/**
 * Puls: CSV'ens tal er Stravas egen, tidsvægtede middel og vinder når den
 * findes. Ellers bruges filens analyse — samme fallback som Markdown-stien.
 */
function avgHeartRate(run: DigestedRun): number | null {
  return run.row.avgHr ?? run.analysis?.avgHr ?? null;
}

function maxHeartRate(run: DigestedRun): number | null {
  return run.row.maxHr ?? run.analysis?.maxHr ?? null;
}

/** Sekunder som heltal (bruges til varighed og tid i zone). */
function s(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return MISSING;
  return String(Math.round(v));
}

/** Navne skal ikke slå sammen med feltadskillere — sæt i citationstegn. */
function quote(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')}"`;
}

/** ISO-uge som `2026-W42`. */
function isoWeek(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * Træningsbelastning (TRIMP-lignende): sum af minutter i hver zone vægtet
 * 1–5. Standardmålet for belastning i løbetræning, og den kan ikke
 * udledes af de øvrige felter uden zone-sekunderne.
 */
function load(zoneSeconds: number[] | null): number | null {
  if (!zoneSeconds) return null;
  let total = 0;
  zoneSeconds.forEach((sec, i) => {
    total += (sec / 60) * (i + 1);
  });
  return total;
}

interface WeekBucket {
  week: string;
  runs: number;
  km: number | null;
  movingSec: number | null;
  load: number;
  hrSum: number;
  hrCount: number;
  /** Løb uden bidrag til load/z — ikke kun løb uden sporanalyse. */
  withoutAnalysis: number;
}

/** Ugeaggregat over alle løb — agenten kan ikke selv gruppere på kalender. */
function weeklyBuckets(runs: DigestedRun[]): WeekBucket[] {
  const buckets = new Map<string, WeekBucket>();
  for (const run of runs) {
    const key = isoWeek(run.row.date);
    const b =
      buckets.get(key) ??
      {
        week: key,
        runs: 0,
        km: null,
        movingSec: null,
        load: 0,
        hrSum: 0,
        hrCount: 0,
        withoutAnalysis: 0,
      };
    b.runs += 1;
    if (!hasLoad(run)) b.withoutAnalysis += 1;
    if (run.row.distanceM != null) b.km = (b.km ?? 0) + run.row.distanceM / 1000;
    if (run.row.movingSec != null) b.movingSec = (b.movingSec ?? 0) + run.row.movingSec;
    const l = load(run.analysis?.zones ?? null);
    if (l != null) b.load += l;
    const avgHr = avgHeartRate(run);
    if (avgHr != null) {
      b.hrSum += avgHr;
      b.hrCount += 1;
    }
    buckets.set(key, b);
  }
  return [...buckets.values()].sort((a, b) => (a.week < b.week ? 1 : -1));
}

/** Ét løb som én maskinlæsbar linje. */
function runLine(run: DigestedRun, withSplits: boolean): string {
  const { row, analysis } = run;
  const parts: string[] = [];
  parts.push(`d=${row.date.toISOString()}`);
  parts.push(`n=${quote(row.name)}`);
  parts.push(`km=${row.distanceM != null ? n(row.distanceM / 1000, 2) : MISSING}`);
  parts.push(`t=${s(row.movingSec)}`);
  const pace =
    row.distanceM && row.distanceM > 0 && row.movingSec != null
      ? row.movingSec / (row.distanceM / 1000)
      : null;
  parts.push(`pace=${n(pace, 1)}`);
  const avgHr = avgHeartRate(run);
  const maxHr = maxHeartRate(run);
  parts.push(`hr=${n(avgHr)}/${n(maxHr)}`);
  if (analysis?.zonePct) {
    parts.push(`z=${analysis.zonePct.map((p) => n(p, 1)).join(',')}`);
  } else {
    parts.push(`z=${MISSING}`);
  }
  parts.push(`elev=${s(analysis?.elevGainM)}`);
  parts.push(`drift=${n(analysis?.hrDriftPct, 1)}`);
  parts.push(`half=${n(analysis?.secondHalfPaceDeltaSec, 1)}`);
  parts.push(`cv=${n(analysis?.paceCvPct, 1)}`);
  parts.push(`pause=${s(analysis?.pauseCount)}`);
  const runLoad = load(analysis?.zones ?? null);
  parts.push(`load=${n(runLoad)}`);
  if (withSplits && analysis?.splits.length) {
    const sp = analysis.splits
      .map((sp2) => `${sp2.km}${sp2.partial ? '*' : ''}:${n(sp2.paceSecPerKm, 0)}@${n(sp2.avgHr)}`)
      .join(',');
    parts.push(`sp=${sp}`);
  }
  if (run.error) parts.push(`err=${quote(run.error)}`);
  return parts.join(' ');
}

/** Vindue-statistik til sammenligning (baseline vs. den foregående periode). */
function windowSummary(runs: DigestedRun[]): {
  n: number;
  km: number | null;
  movingSec: number | null;
  pace: number | null;
  avgHr: number | null;
  load: number | null;
  z: number[] | null;
  withoutAnalysis: number;
} {
  let km: number | null = null;
  let movingSec: number | null = null;
  let paceSec = 0;
  let paceKm = 0;
  const zoneSec = [0, 0, 0, 0, 0];
  let zoneSecTotal = 0;
  let hrSum = 0;
  let hrCount = 0;
  let withoutAnalysis = 0;
  for (const run of runs) {
    if (!hasLoad(run)) withoutAnalysis += 1;
    if (run.row.distanceM != null) km = (km ?? 0) + run.row.distanceM / 1000;
    if (run.row.movingSec != null) movingSec = (movingSec ?? 0) + run.row.movingSec;
    if (run.row.distanceM != null && run.row.distanceM > 0 && run.row.movingSec != null) {
      paceSec += run.row.movingSec;
      paceKm += run.row.distanceM / 1000;
    }
    if (run.analysis?.zones) {
      run.analysis.zones.forEach((v, i) => {
        zoneSec[i]! += v;
        zoneSecTotal += v;
      });
    }
    const avgHr = avgHeartRate(run);
    if (avgHr != null) {
      hrSum += avgHr;
      hrCount += 1;
    }
  }
  return {
    n: runs.length,
    km,
    movingSec,
    pace: paceKm > 0 ? paceSec / paceKm : null,
    avgHr: hrCount ? hrSum / hrCount : null,
    load: load(zoneSecTotal > 0 ? zoneSec : null),
    z: zoneSecTotal > 0 ? zoneSec.map((v) => (v / zoneSecTotal) * 100) : null,
    withoutAnalysis,
  };
}

/**
 * Statistik over hele perioden. Rekorder og huller kan agenten ikke selv
 * finde i rækkerne, og det er præcis den slags viden en coach-agent
 * har brug for: er der et langt pause-ophold, er der en ny rekord,
 * og hvordan ser zonefordelingen ud samlet set.
 */
function statsSection(runs: DigestedRun[]): string[] {
  const out: string[] = [];
  const dists = runs
    .map((r) => r.row.distanceM)
    .filter((d): d is number => d != null)
    .map((d) => d / 1000);
  const totalKm = dists.length ? dists.reduce((a, b) => a + b, 0) : null;
  const runsWithDistance = runs.filter((r) => r.row.distanceM != null);
  const longest = runsWithDistance.length
    ? runsWithDistance.reduce((best, r) => (r.row.distanceM! > best.row.distanceM! ? r : best))
    : undefined;
  const paceRuns = runs.filter((r) => (r.row.distanceM ?? 0) > 0 && r.row.movingSec != null);
  const fastest = paceRuns.reduce(
    (best, r) => {
      const p = r.row.movingSec! / ((r.row.distanceM ?? 0) / 1000);
      return best == null || p < best.p ? { run: r, p } : best;
    },
    null as { run: DigestedRun; p: number } | null,
  );
  const sortedDists = [...dists].sort((a, b) => a - b);
  const median = sortedDists.length ? sortedDists[Math.floor(sortedDists.length / 2)]! : null;

  // Største pause mellem to løb — den vigtigste enkeltstående trænings-fakta.
  const byDate = [...runs].sort((a, b) => a.row.date.getTime() - b.row.date.getTime());
  let maxGap = 0;
  let gapBetween = '';
  for (let i = 1; i < byDate.length; i++) {
    const gap = (byDate[i]!.row.date.getTime() - byDate[i - 1]!.row.date.getTime()) / 86_400_000;
    if (gap > maxGap) {
      maxGap = gap;
      gapBetween = `${byDate[i - 1]!.row.date.toISOString().slice(0, 10)} -> ${byDate[i]!.row.date.toISOString().slice(0, 10)}`;
    }
  }

  const drifts = runs.map((r) => r.analysis?.hrDriftPct).filter((d): d is number => d != null);
  const avgDrift = drifts.length ? drifts.reduce((a, b) => a + b, 0) / drifts.length : null;

  // Samlet zonefordeling for hele perioden.
  const zoneSec = [0, 0, 0, 0, 0];
  let zoneTotal = 0;
  for (const r of runs) {
    if (!r.analysis?.zones) continue;
    r.analysis.zones.forEach((v, i) => {
      zoneSec[i]! += v;
      zoneTotal += v;
    });
  }

  out.push('## STATS (whole period)');
  out.push(
    `runs=${runs.length} km_total=${n(totalKm, 1)} median_km=${n(median, 2)} without_analysis=${runs.filter((r) => !hasLoad(r)).length}`,
  );
  if (longest) {
    out.push(
      `longest_run=${n((longest.row.distanceM ?? 0) / 1000, 2)} km on ${longest.row.date.toISOString().slice(0, 10)} (${longest.row.name})`,
    );
  }
  if (fastest) {
    out.push(
      `fastest_avg_pace=${n(fastest.p, 1)} s/km on ${fastest.run.row.date.toISOString().slice(0, 10)} (${fastest.run.row.name})`,
    );
  }
  out.push(`max_gap=${n(maxGap, 1)} days${gapBetween ? ` (${gapBetween})` : ''}`);
  out.push(
    `drift_avg=${n(avgDrift, 1)} drift_min=${drifts.length ? n(minValue(drifts), 1) : MISSING} drift_max=${drifts.length ? n(maxValue(drifts), 1) : MISSING}`,
  );
  out.push(
    `zone_total_pct=${zoneTotal > 0 ? zoneSec.map((v) => n((v / zoneTotal) * 100, 1)).join(',') : MISSING}`,
  );
  const movingSecs = runs.map((r) => r.row.movingSec).filter((v): v is number => v != null);
  const totalSec = movingSecs.length ? movingSecs.reduce((a, b) => a + b, 0) : null;
  out.push(`moving_time_total=${s(totalSec)} s`);
  return out;
}
export function renderAgent(input: AgentInput): string {
  const out: string[] = [];
  // Sorter selv: digesten skal være deterministisk uanset rækkefølgen på
  // inputtet. Nyeste først.
  const sortNewestFirst = (list: DigestedRun[]): DigestedRun[] =>
    [...list].sort(
      (a, b) => b.row.date.getTime() - a.row.date.getTime() || (a.row.name < b.row.name ? -1 : 1),
    );
  const runs = sortNewestFirst(input.runs);
  const allRuns = sortNewestFirst(input.allRuns);
  const newest = allRuns[0]?.row.date;
  const cutoff = newest
    ? newest.getTime() - input.baselineDays * 86_400_000
    : Number.POSITIVE_INFINITY;

  // Ugeaggregat først: det er det tætteste overblik, og det gør, at
  // agenten kan se tendenser uden at læse 195 rækker. Aggregatet dækker
  // hele eksporten, ikke kun de løb --last valgte at beskrive.
  const weeks = weeklyBuckets(allRuns);

  const current = allRuns.filter((r) => r.row.date.getTime() > cutoff);
  const previous = allRuns.filter(
    (r) => r.row.date.getTime() <= cutoff && r.row.date.getTime() > cutoff - input.baselineDays * 86_400_000,
  );
  const cur = windowSummary(current);
  const prev = windowSummary(previous);

  out.push('# STRAVA DIGEST v2 (agent-format)');
  out.push(`generated=${input.generatedAt.toISOString()}`);
  out.push(`source=${input.sourceLabel}`);
  out.push(`activities_in_export=${input.activitiesInExport}`);
  out.push(`runs_in_export=${input.runsTotal}`);
  out.push(`runs_shown=${runs.length}`);
  // detailCount <= 0 means "all runs get per-km splits".
  const detailAll = input.detailCount <= 0;
  out.push(`detail_runs=${detailAll ? runs.length : Math.min(input.detailCount, runs.length)} (newest, include per-km splits)`);
  out.push(`max_hr=${input.maxHr ?? MISSING} source=${input.maxHrSource ?? MISSING}`);
  out.push('');

  out.push('## SCHEMA');
  out.push('run fields (one run per line, newest first):');
  out.push('  d=ISO8601 timestamp (UTC) | n=name | km=distance | t=elapsed moving time in seconds');
  out.push('  pace=seconds per km | hr=average/max heart rate | z=Z1,Z2,Z3,Z4,Z5 as % of time with HR');
  out.push('  elev=elevation gain in m | drift=pace-normalised aerobic decoupling in % (see SIGNALS)');
  out.push('  half=second half minus first half in s/km (negative = negative split)');
  out.push('  cv=pace consistency, coefficient of variation in % | pause=number of pauses');
  out.push('  load=training load, sum(minutes in zone * 1..5)');
  out.push('  sp=per-km splits: <km>:<pace_s/km>@<avg_hr>, * = partial km');
  out.push('week fields: w=ISO week | r=runs | km=distance | t=seconds | load=load | hr=average HR | without_analysis=runs with no load/z contribution');
  out.push('window fields: n=runs | km | t | pace | hr | load | z=Z1..Z5 % | without_analysis=runs with no load/z contribution');
  out.push('n counts every run in the window; km sums the runs whose km is not missing; t sums the runs whose t is not missing; pace uses only runs with km > 0 and a time, so t/km can differ from pace.');
  out.push('stats fields: runs | km_total | median_km | without_analysis=runs with no load/z contribution | longest_run | fastest_avg_pace | max_gap | drift_avg | drift_min | drift_max | zone_total_pct | moving_time_total');
  out.push('load and zone fields (z, zone_total_pct) cover only runs with a load/z contribution, i.e. an analysed track with zone seconds; without_analysis in STATS, WEEKS and WINDOW is the number of runs in that population without one. Other track-derived fields, such as drift, appear only where the track could compute them.');
  out.push('change: load is reported only when both windows have the same number of runs with a load/z contribution (n - without_analysis); otherwise load=n/a, because the two load figures then cover different populations. n counts every run; km sums runs whose km is not missing; t sums runs whose t is not missing; pace uses runs with km > 0 and a time.');
  out.push(`decimal=dot | missing=${MISSING} | units=SI except heart rate (bpm) and percent`);
  out.push('');

  out.push('## SIGNALS');
  out.push('drift: pace-normalised aerobic decoupling in %. A value > 5 means aerobic cost rose while pace held.');
  out.push('  < 3 = stable | 3-5 = slightly elevated | > 5 = aerobic capacity under pressure | > 10 = clearly under pressure');
  out.push('half: negative = second half faster than the first (negative split).');
  out.push('cv: pace consistency in %. < 3 = steady | 3-5 = variable | > 5 = uneven (hills, stops, trail).');
  out.push('load: sum(minutes in zone * 1..5). Compare week to week only when both weeks have without_analysis=0 (every run has a load/z contribution); then a jump > 20 % is a load risk.');
  out.push('z: percent of moving time in each heart-rate zone. Z1 50-60 %, Z2 60-70 %, Z3 70-80 %, Z4 80-90 %, Z5 90-100 % of max.');
  out.push('  "max" is whichever max_hr the header names. If source=export-p95 it is the 95th percentile of');
  out.push('  the Max Heart Rate values in the activities CSV from the two years before the newest activity,');
  out.push('  not the user\'s real max. A p95 is less spike-sensitive than a raw maximum, but it is still an observation.');
  out.push(`  If source=export-max there were fewer than ${MIN_P95_VALUES} values, so it is the highest measured value in the`);
  out.push('  window instead. The NOTES line states how many values it rests on. Say so when you use z.');
  out.push('');

  out.push('## WEEKS (newest first)');
  for (const w of weeks) {
    out.push(
      `w=${w.week} r=${w.runs} km=${n(w.km, 1)} t=${s(w.movingSec)} load=${w.load > 0 ? n(w.load) : MISSING} hr=${w.hrCount ? n(w.hrSum / w.hrCount) : MISSING} without_analysis=${w.withoutAnalysis}`,
    );
  }
  out.push('');

  out.push(`## WINDOW (last ${input.baselineDays} days vs. the ${input.baselineDays} days before)`);
  const fmtWin = (x: typeof cur): string =>
    `n=${x.n} km=${n(x.km, 1)} t=${s(x.movingSec)} pace=${n(x.pace, 1)} hr=${n(x.avgHr)} load=${n(x.load)} z=${x.z ? x.z.map((p) => n(p, 1)).join(',') : MISSING} without_analysis=${x.withoutAnalysis}`;
  out.push(`recent: ${fmtWin(cur)}`);
  out.push(`previous: ${fmtWin(prev)}`);
  if (cur.n > 0 && prev.n > 0) {
    const dKm =
      cur.km != null && prev.km != null && prev.km > 0
        ? ((cur.km - prev.km) / prev.km) * 100
        : null;
    const dLoad =
      cur.load != null && prev.load != null && prev.load > 0
        ? ((cur.load - prev.load) / prev.load) * 100
        : null;
    const loadComparable =
      cur.n - cur.withoutAnalysis === prev.n - prev.withoutAnalysis;
    out.push(
      `change: km=${n(dKm, 1)} % load=${loadComparable ? `${n(dLoad, 1)} %` : 'n/a'}`,
    );
  }
  out.push('');

  out.push(`## RUNS (${runs.length}, newest first)`);
  runs.forEach((run, i) => {
    out.push(runLine(run, detailAll || i < input.detailCount));
  });
  out.push('');

  out.push(...statsSection(allRuns));
  out.push('');

  if (input.contextText.trim()) {
    out.push("## CONTEXT (the user's own notes — plan, sleep, intent)");
    out.push(input.contextText.trim());
    out.push('');
  }

  out.push('## NOTES');
  for (const note of input.notes) out.push(`- ${note}`);
  if (runs.length < allRuns.length) {
    out.push(
      `- ${allRuns.length} ${allRuns.length === 1 ? 'run is' : 'runs are'} counted in WEEKS, WINDOW and STATS; ${runs.length} ${runs.length === 1 ? 'run is' : 'runs are'} shown (--last).`,
    );
  }
  out.push(
    `- zones use max_hr=${input.maxHr ?? MISSING} (${input.maxHrSource ?? 'no source'}). ` +
      'The zone boundaries are 50-100 % of max; they differ from your watch if your watch uses different boundaries.',
  );
  out.push(
    '- per-km splits are only included for the newest runs (the sp field). `*` marks a partial kilometre.',
  );

  return out.join('\n') + '\n';
}
