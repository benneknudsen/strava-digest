import type { RunAnalysis } from './analysis.ts';
import { type ActivityRow, windowStats } from './strava.ts';
import { ZONE_NAMES, zonePcts } from './zones.ts';

export interface DigestedRun {
  row: ActivityRow;
  analysis: RunAnalysis | null;
  error?: string;
}

export interface DigestInput {
  sourceLabel: string;
  activitiesInExport: number;
  runs: DigestedRun[];
  /**
   * Alle løb i eksportens baseline-vindue (beregnet på de samme filer).
   * Uden denne bliver baselin-statistikken kun en gentagelse af de løb
   * der vises i digesten — altså ingen baseline overhovedet.
   */
  baselineRuns?: DigestedRun[];
  baselineDays: number;
  unmatchedHeaders: string[];
  contextText: string;
  generatedAt: Date;
  poolLabel: string;
  hostNote?: string;
  /** note about a guessed distance unit, added to Markdown's Notes section */
  distanceNote?: string;
  /** hjælpetekst når zonekonfigurationen mangler, fx et observeret puls-maks */
  zoneHint?: string;
  /** antal løb i eksportens pulje (kan være mere end runs.length) */
  runsTotal?: number;
  /** max-puls brugt til zonefordelingen */
  maxHr?: number | null;
  /** hvor max-pulsen kom fra */
  maxHrSource?: 'flag' | 'fit' | 'export-observation' | null;
  /** noter til agenten (udeladte felter, forbehold) */
  notes?: string[];
}

const num = (v: number | null | undefined, digits = 0, fallback = '–'): string =>
  v == null || !Number.isFinite(v) ? fallback : v.toFixed(digits);

/** Percent: dot as decimal separator, no decimals when the number is whole. */
const fmtPct = (v: number): string => {
  const s = v.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
};

const zoneLine = (pcts: number[]): string =>
  ZONE_NAMES.map((name, i) => `${name} ${fmtPct(pcts[i] ?? 0)} %`).join(' · ');

export function fmtPace(secPerKm: number | null | undefined): string {
  if (secPerKm == null || !Number.isFinite(secPerKm) || secPerKm <= 0) return '–';
  // 359,6 sek skal vise 6:00 — ikke 5:60. Rundingen carryes derfor over.
  const total = Math.round(secPerKm);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}/km`;
}

export function fmtDuration(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return '–';
  const total = Math.round(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

const fmtKm = (m: number | null | undefined): string =>
  m == null ? '–' : `${num(m / 1000, 2)} km`;

export const fmtDelta = (sec: number | null): string => {
  if (sec == null || !Number.isFinite(sec)) return '–';
  const sign = sec >= 0 ? '+' : '−';
  const total = Math.round(Math.abs(sec));
  return `${sign}${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}/km`;
};

export function renderMarkdown(input: DigestInput): string {
  const { runs, baselineDays } = input;
  const base = runs[0]?.row.date ?? input.generatedAt;
  const baselinePool = input.baselineRuns?.length ? input.baselineRuns : runs;
  const stats = windowStats(baselinePool, baselineDays, base);
  const out: string[] = [];

  out.push(`# Training digest — ${iso(input.generatedAt)}`);
  out.push('');
  out.push(
    `Source: ${input.sourceLabel} · ${input.activitiesInExport} activities in export · ${runs.length} runs in digest`,
  );
  out.push('');

  out.push(`## Baseline (${baselineDays} days before the most recent run)`);
  if (stats.count === 0) {
    out.push('- no runs in the window');
  } else {
    out.push(
      `- ${num(stats.distanceKm, 1)} km across ${stats.count} runs (~${num(stats.runsPerWeek, 1)}/week) · longest ${num(stats.longestKm, 1)} km`,
    );
    out.push(`- average: ${fmtPace(stats.avgPaceSecPerKm)} · heart rate ${num(stats.avgHr, 0)}`);
    const zoneSummary = windowZoneSummary(baselinePool, base, baselineDays);
    if (zoneSummary) {
      const pcts = zonePcts(zoneSummary.seconds);
      const easy = (pcts[0] ?? 0) + (pcts[1] ?? 0);
      const coverage =
        zoneSummary.runsWithZones < zoneSummary.runsInWindow
          ? ` (from ${zoneSummary.runsWithZones} of ${zoneSummary.runsInWindow} runs)`
          : '';
      out.push(`- zones: ${zoneLine(pcts)} · easy (Z1–Z2) ${fmtPct(easy)} %${coverage}`);
    }
  }
  out.push('');

  out.push(`## ${input.poolLabel} (${runs.length}, newest first)`);
  runs.forEach((run, i) => {
    out.push('');
    out.push(...renderRun(run, i + 1, input.zoneHint));
  });

  if (input.contextText.trim()) {
    out.push('');
    out.push('## Context (from you)');
    out.push(input.contextText.trim());
  }

  const notes: string[] = [];
  if (input.unmatchedHeaders.length) {
    notes.push(
      `Unmapped columns (${input.unmatchedHeaders.length}): ${input.unmatchedHeaders.slice(0, 12).join(' · ')}${input.unmatchedHeaders.length > 12 ? ' …' : ''}`,
    );
  }
  if (input.hostNote) notes.push(input.hostNote);
  if (input.distanceNote) notes.push(input.distanceNote);
  if (notes.length) {
    out.push('');
    out.push('## Notes');
    notes.forEach((n) => out.push(`- ${n}`));
  }
  return `${out.join('\n')}\n`;
}

function renderRun(run: DigestedRun, index: number, zoneHint?: string): string[] {
  const { row, analysis } = run;
  const lines: string[] = [];
  // Distance og puls kommer fra CSV'en, når den findes: det er Stravas
  // egen, kanoniske tal for aktiviteten. Filens egen distance afviger
  // typisk 1–4 %, fordi Strava koder eksportfilerne selv (sessionens
  // total og GPS-udledt distance er begge reconstructions), og CSV'en
  // afviger 0 % i alle 195 løb i en rigtig eksport.
  //
  // Det er FILEN, der giver det CSV'en ikke har: splits, HR-drift,
  // zoner, pauser og pace-jævnhed.
  const trackDistanceM = analysis?.distanceM;
  const distanceM =
    row.distanceM != null && row.distanceM > 0
      ? row.distanceM
      : trackDistanceM != null && trackDistanceM > 0
        ? trackDistanceM
        : row.distanceM;
  // Varighed og pace skal bygge på SAMME tal, ellers er de ikke
  // sammenlignelige. CSV'ens "Tid i bevægelse" er Stravas egen beregning
  // af den effektive tid; filens er en rekonstruktion (elapsed minus
  // fundne pauser). CSV'en vinder, når den findes.
  const movingSec = row.movingSec ?? analysis?.movingSec ?? null;
  const avgPace = distanceM && movingSec ? movingSec / (distanceM / 1000) : null;
  lines.push(`### ${index}) ${iso(row.date)} · ${row.name}`);
  // Puls: CSV'ens gennemsnit er urets egen tidsvægtede middel. Filens
  // egen middel afviger typisk 5–10 bpm, fordi Stravas FIT-filer kun
  // skriver puls i hvert andet punkt. Vi bruger derfor CSV'en når den
  // findes, og filens værdi ellers.
  const avgHr = row.avgHr ?? analysis?.avgHr ?? null;
  const maxHr = row.maxHr ?? analysis?.maxHr ?? null;
  lines.push(
    `- **Run:** ${fmtKm(distanceM)} · ${fmtDuration(movingSec)} · **${fmtPace(avgPace)}** · HR ${num(avgHr, 0)}/${num(maxHr, 0)}${analysis?.avgCadence != null ? ` · cadence ${num(analysis.avgCadence)}` : ''}`,
  );
  const extras: string[] = [];
  if (analysis && analysis.elevGainM > 5) extras.push(`${num(analysis.elevGainM)} m elevation`);
  if (row.relativeEffort != null) extras.push(`RE ${num(row.relativeEffort)}`);
  if (row.gear) extras.push(row.gear);
  if (extras.length) lines.push(`- **Metadata:** ${extras.join(' · ')}`);
  if (analysis?.splits.length) {
    const splits = analysis.splits
      .map(
        (s) =>
          `${s.km}) ${fmtPace(s.paceSecPerKm).replace('/km', '')}${s.avgHr ? `/${Math.round(s.avgHr)}` : ''}${s.partial ? '*' : ''}`,
      )
      .join(' · ');
    lines.push(`- **Splits (pace/HR):** ${splits}`);
  }
  if (analysis) {
    const signals: string[] = [];
    if (analysis.hrDriftPct != null) {
      const verdict =
        analysis.hrDriftPct > 8
          ? 'too high — aerobic capacity under pressure'
          : analysis.hrDriftPct > 5
            ? 'slightly elevated'
            : 'stable';
      signals.push(`HR-drift ${num(analysis.hrDriftPct, 1)} % (${verdict})`);
    }
    if (analysis.secondHalfPaceDeltaSec != null) {
      signals.push(
        `2nd half ${fmtDelta(analysis.secondHalfPaceDeltaSec)}${analysis.secondHalfPaceDeltaSec < 0 ? ' (negative split)' : ''}`,
      );
    }
    if (analysis.pauseCount) {
      signals.push(`${analysis.pauseCount} pause${analysis.pauseCount > 1 ? 's' : ''} (${fmtDuration(analysis.pauseSec)})`);
    }
    if (analysis.paceCvPct != null) signals.push(`pace consistency CV ${num(analysis.paceCvPct, 1)} %`);
    if (signals.length) lines.push(`- **Signals:** ${signals.join(' · ')}`);
    if (analysis.zonePct && analysis.zoneMaxHr != null) {
      const source =
        analysis.zoneSource === 'fit'
          ? 'from the watch'
          : analysis.zoneSource === 'export-observation'
            ? 'observed in the export, not --max-hr'
            : 'from --max-hr';
      lines.push(
        `- **Zones:** ${zoneLine(analysis.zonePct)} (max HR ${num(analysis.zoneMaxHr)}, ${source})`,
      );
    } else if (analysis.zoneConfigured) {
      lines.push('- _note: no zone split (this run has no heart-rate data)_');
    } else {
      lines.push(
        `- _note: no zone split (no max HR${zoneHint ? ` — ${zoneHint}` : ' — set --max-hr'})_`,
      );
    }
    // Noten siger kun noget, når vi faktisk bruger den GPS-udledte distance.
    // Når CSV'en har totalen, bruger vi den (den afviger 0 % mod Strava).
    const usingGpsDistance = analysis.distanceDerived && !(row.distanceM != null && row.distanceM > 0);
    if (usingGpsDistance) {
      lines.push('- _note: distance derived from GPS (the file carries no distance — the figure is an approximation)_');
    }
  } else if (run.error) {
    lines.push(`- _per-run details unavailable: ${run.error}_`);
  }
  return lines;
}

/**
 * Summér zone-sekunder over løb i baseline-vinduet — samme udvalg som
 * `windowStats`, men kun løb hvor zonerne faktisk kunne beregnes. Tællingen
 * følger med, så baseline kan vise hvor mange løb zonefordelingen dækker.
 */
function windowZoneSummary(
  runs: DigestedRun[],
  before: Date,
  days: number,
): { seconds: number[]; runsWithZones: number; runsInWindow: number } | null {
  const from = new Date(before.getTime() - days * 86_400_000);
  const buckets = [0, 0, 0, 0, 0];
  let runsInWindow = 0;
  let runsWithZones = 0;
  for (const run of runs) {
    if (!(run.row.date > from && run.row.date <= before)) continue;
    runsInWindow += 1;
    const zones = run.analysis?.zones;
    if (!zones) continue;
    runsWithZones += 1;
    zones.forEach((s, i) => {
      buckets[i] = (buckets[i] ?? 0) + s;
    });
  }
  return runsWithZones ? { seconds: buckets, runsWithZones, runsInWindow } : null;
}

function iso(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
