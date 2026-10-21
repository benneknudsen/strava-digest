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
import type { ActivityRow } from './strava.ts';

export interface AgentInput {
  sourceLabel: string;
  activitiesInExport: number;
  runsTotal: number;
  /** Alle løb i eksporten, nyeste først. */
  runs: DigestedRun[];
  /** Hvor mange af de nyeste løb der får fuld split-opdeling. */
  detailCount: number;
  baselineDays: number;
  contextText: string;
  generatedAt: Date;
  maxHr: number | null;
  maxHrSource: 'flag' | 'fit' | 'export-observation' | null;
  notes: string[];
}

const MISSING = '-';

/** Tal med punktum som decimaltegn; `null` bliver `-`. */
function n(v: number | null | undefined, digits = 0): string {
  if (v == null || !Number.isFinite(v)) return MISSING;
  return v.toFixed(digits);
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
  km: number;
  movingSec: number;
  load: number;
  hrSum: number;
  hrCount: number;
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
        km: 0,
        movingSec: 0,
        load: 0,
        hrSum: 0,
        hrCount: 0,
      };
    b.runs += 1;
    b.km += (run.row.distanceM ?? 0) / 1000;
    b.movingSec += run.row.movingSec ?? 0;
    const l = load(run.analysis?.zones ?? null);
    if (l != null) b.load += l;
    if (run.row.avgHr != null) {
      b.hrSum += run.row.avgHr;
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
  parts.push(`km=${n((row.distanceM ?? 0) / 1000, 2)}`);
  parts.push(`t=${s(row.movingSec ?? 0)}`);
  const pace =
    row.distanceM && row.distanceM > 0 && row.movingSec != null
      ? row.movingSec / (row.distanceM / 1000)
      : null;
  parts.push(`pace=${pace == null ? MISSING : n(pace, 1)}`);
  parts.push(`hr=${row.avgHr != null ? n(row.avgHr) : MISSING}/${row.maxHr != null ? n(row.maxHr) : MISSING}`);
  if (analysis?.zonePct) {
    parts.push(`z=${analysis.zonePct.map((p) => n(p, 1)).join(',')}`);
  } else {
    parts.push(`z=${MISSING}`);
  }
  parts.push(`elev=${s(analysis?.elevGainM)}`);
  parts.push(`drift=${analysis?.hrDriftPct != null ? n(analysis.hrDriftPct, 1) : MISSING}`);
  parts.push(`half=${analysis?.secondHalfPaceDeltaSec != null ? n(analysis.secondHalfPaceDeltaSec, 1) : MISSING}`);
  parts.push(`cv=${analysis?.paceCvPct != null ? n(analysis.paceCvPct, 1) : MISSING}`);
  parts.push(`pause=${s(analysis?.pauseCount)}`);
  parts.push(`load=${load(analysis?.zones ?? null) != null ? n(load(analysis!.zones)) : MISSING}`);
  if (withSplits && analysis?.splits.length) {
    const sp = analysis.splits
      .map((sp2) => `${sp2.km}${sp2.partial ? '*' : ''}:${sp2.paceSecPerKm != null ? n(sp2.paceSecPerKm, 0) : MISSING}@${sp2.avgHr != null ? n(sp2.avgHr) : MISSING}`)
      .join(',');
    parts.push(`sp=${sp}`);
  }
  if (run.error) parts.push(`err=${quote(run.error)}`);
  return parts.join(' ');
}

/** Vindue-statistik til sammenligning (baseline vs. den foregående periode). */
function windowSummary(runs: DigestedRun[]): {
  n: number;
  km: number;
  movingSec: number;
  pace: number | null;
  avgHr: number | null;
  load: number | null;
  z: number[] | null;
} {
  let km = 0;
  let movingSec = 0;
  const zoneSec = [0, 0, 0, 0, 0];
  let zoneSecTotal = 0;
  let hrSum = 0;
  let hrCount = 0;
  for (const run of runs) {
    km += (run.row.distanceM ?? 0) / 1000;
    movingSec += run.row.movingSec ?? 0;
    if (run.analysis?.zones) {
      run.analysis.zones.forEach((v, i) => {
        zoneSec[i]! += v;
        zoneSecTotal += v;
      });
    }
    if (run.row.avgHr != null) {
      hrSum += run.row.avgHr;
      hrCount += 1;
    }
  }
  return {
    n: runs.length,
    km,
    movingSec,
    pace: km > 0 ? movingSec / km : null,
    avgHr: hrCount ? hrSum / hrCount : null,
    load: load(zoneSecTotal > 0 ? zoneSec : null),
    z: zoneSecTotal > 0 ? zoneSec.map((v) => (v / zoneSecTotal) * 100) : null,
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
  const dists = runs.map((r) => (r.row.distanceM ?? 0) / 1000);
  const totalKm = dists.reduce((a, b) => a + b, 0);
  const longest = runs.reduce(
    (best, r) => ((r.row.distanceM ?? 0) > (best?.row.distanceM ?? 0) ? r : best),
    runs[0],
  );
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
  out.push(`runs=${runs.length} km_total=${n(totalKm, 1)} median_km=${median != null ? n(median, 2) : MISSING}`);
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
    `drift_avg=${avgDrift != null ? n(avgDrift, 1) : MISSING} drift_min=${drifts.length ? n(Math.min(...drifts), 1) : MISSING} drift_max=${drifts.length ? n(Math.max(...drifts), 1) : MISSING}`,
  );
  out.push(
    `zone_total_pct=${zoneTotal > 0 ? zoneSec.map((v) => n((v / zoneTotal) * 100, 1)).join(',') : MISSING}`,
  );
  const totalSec = runs.reduce((a, r) => a + (r.row.movingSec ?? 0), 0);
  out.push(`moving_time_total=${s(totalSec)} s`);
  return out;
}
export function renderAgent(input: AgentInput): string {
  const out: string[] = [];
  // Sorter selv: digesten skal være deterministisk uanset rækkefølgen på
  // inputtet. Nyeste først.
  const runs = [...input.runs].sort(
    (a, b) => b.row.date.getTime() - a.row.date.getTime() || (a.row.name < b.row.name ? -1 : 1),
  );
  const newest = runs[0]?.row.date;
  const cutoff = newest
    ? newest.getTime() - input.baselineDays * 86_400_000
    : Number.POSITIVE_INFINITY;

  // Ugeaggregat først: det er det tætteste overblik, og det gør, at
  // agenten kan se tendenser uden at læse 195 rækker.
  const weeks = weeklyBuckets(runs);

  const current = runs.filter((r) => r.row.date.getTime() > cutoff);
  const previous = runs.filter(
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
  out.push(`max_hr=${input.maxHr != null ? input.maxHr : MISSING} source=${input.maxHrSource ?? MISSING}`);
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
  out.push('week fields: w=ISO week | r=runs | km=distance | t=seconds | load=load | hr=average HR');
  out.push('window fields: n=runs | km | t | pace | hr | load | z=Z1..Z5 %');
  out.push(`decimal=dot | missing=${MISSING} | units=SI except heart rate (bpm) and percent`);
  out.push('');

  out.push('## SIGNALS');
  out.push('drift: pace-normalised aerobic decoupling in %. A value > 5 means aerobic cost rose while pace held.');
  out.push('  < 3 = stable | 3-5 = slightly elevated | > 5 = aerobic capacity under pressure | > 10 = clearly under pressure');
  out.push('half: negative = second half faster than the first (negative split).');
  out.push('cv: pace consistency in %. < 3 = steady | 3-5 = variable | > 5 = uneven (hills, stops, trail).');
  out.push('load: sum(minutes in zone * 1..5). Compare week to week; a jump > 20 % is a load risk.');
  out.push('z: percent of moving time in each heart-rate zone. Z1 50-60 %, Z2 60-70 %, Z3 70-80 %, Z4 80-90 %, Z5 90-100 % of max.');
  out.push('  "max" is whichever max_hr the header names. If source=export-observation it is the highest');
  out.push('  heart rate found in the export, not the user\'s real max: usually a single spike, so it is');
  out.push('  often too high, which makes the training look easier than it is. Say so when you use z.');
  out.push('');

  out.push('## WEEKS (newest first)');
  for (const w of weeks) {
    out.push(
      `w=${w.week} r=${w.runs} km=${n(w.km, 1)} t=${s(w.movingSec)} load=${w.load > 0 ? n(w.load) : MISSING} hr=${w.hrCount ? n(w.hrSum / w.hrCount) : MISSING}`,
    );
  }
  out.push('');

  out.push(`## WINDOW (last ${input.baselineDays} days vs. the ${input.baselineDays} days before)`);
  const fmtWin = (x: typeof cur): string =>
    `n=${x.n} km=${n(x.km, 1)} t=${s(x.movingSec)} pace=${x.pace != null ? n(x.pace, 1) : MISSING} hr=${x.avgHr != null ? n(x.avgHr) : MISSING} load=${x.load != null ? n(x.load) : MISSING} z=${x.z ? x.z.map((p) => n(p, 1)).join(',') : MISSING}`;
  out.push(`recent: ${fmtWin(cur)}`);
  out.push(`previous: ${fmtWin(prev)}`);
  if (cur.n > 0 && prev.n > 0) {
    const dKm = prev.km > 0 ? ((cur.km - prev.km) / prev.km) * 100 : null;
    const dLoad = cur.load != null && prev.load ? ((cur.load - prev.load) / prev.load) * 100 : null;
    out.push(
      `change: km=${dKm != null ? n(dKm, 1) : MISSING} % load=${dLoad != null ? n(dLoad, 1) : MISSING} %`,
    );
  }
  out.push('');

  out.push(`## RUNS (${runs.length}, newest first)`);
  runs.forEach((run, i) => {
    out.push(runLine(run, detailAll || i < input.detailCount));
  });
  out.push('');

  out.push(...statsSection(runs));
  out.push('');

  if (input.contextText.trim()) {
    out.push("## CONTEXT (the user's own notes — plan, sleep, intent)");
    out.push(input.contextText.trim());
    out.push('');
  }

  out.push('## NOTES');
  for (const note of input.notes) out.push(`- ${note}`);
  out.push(
    `- zones use max_hr=${input.maxHr ?? MISSING} (${input.maxHrSource ?? 'no source'}). ` +
      'The zone boundaries are 50-100 % of max; they differ from your watch if your watch uses different boundaries.',
  );
  out.push(
    '- per-km splits are only included for the newest runs (the sp field). `*` marks a partial kilometre.',
  );

  return out.join('\n') + '\n';
}
