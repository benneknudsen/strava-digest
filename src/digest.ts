import type { RunAnalysis } from './analysis.ts';
import type { ActivityRow } from './strava.ts';
import { windowStats } from './strava.ts';
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
  /** hjælpetekst når zonekonfigurationen mangler, fx et observeret puls-maks */
  zoneHint?: string;
  /** antal løb i eksportens pulje (kan være mere end runs.length) */
  runsTotal?: number;
  /** max-puls brugt til zonefordelingen */
  maxHr?: number | null;
  /** hvor max-pulsen kom fra */
  maxHrSource?: 'flag' | 'fit' | 'eksport-observation' | null;
  /** noter til agenten (udeladte felter, forbehold) */
  notes?: string[];
}

const num = (v: number | null | undefined, digits = 0, fallback = '–'): string =>
  v == null || !Number.isFinite(v) ? fallback : v.toFixed(digits).replace('.', ',');

/** Dansk procent: komma som decimalseparator, ingen decimaler når tallet er helt. */
const fmtPct = (v: number): string => {
  const s = v.toFixed(1).replace('.', ',');
  return s.endsWith(',0') ? s.slice(0, -2) : s;
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
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return '–';
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

const fmtDelta = (sec: number | null): string => {
  if (sec == null || !Number.isFinite(sec)) return '–';
  const sign = sec >= 0 ? '+' : '−';
  const abs = Math.abs(sec);
  return `${sign}${Math.floor(abs / 60)}:${String(Math.round(abs % 60)).padStart(2, '0')}/km`;
};

export function renderMarkdown(input: DigestInput): string {
  const { runs, baselineDays } = input;
  const base = runs[0]?.row.date ?? input.generatedAt;
  const baselinePool = input.baselineRuns?.length ? input.baselineRuns : runs;
  const stats = windowStats(baselinePool.map((r) => r.row), baselineDays, base);
  const out: string[] = [];

  out.push(`# Træningsdigest — ${iso(input.generatedAt)}`);
  out.push('');
  out.push(
    `Kilde: ${input.sourceLabel} · ${input.activitiesInExport} aktiviteter i eksporten · ${runs.length} løb i digesten`,
  );
  out.push('');

  out.push(`## Baseline (${baselineDays} dage før seneste tur)`);
  if (stats.count === 0) {
    out.push('- ingen løb i vinduet');
  } else {
    out.push(
      `- ${num(stats.distanceKm, 1)} km fordelt på ${stats.count} løb (~${num(stats.runsPerWeek, 1)}/uge) · længste ${num(stats.longestKm, 1)} km`,
    );
    out.push(`- gennemsnit: ${fmtPace(stats.avgPaceSecPerKm)} · puls ${num(stats.avgHr, 0)}`);
    const zoneSums = windowZoneSeconds(baselinePool, base, baselineDays);
    if (zoneSums) {
      const pcts = zonePcts(zoneSums);
      const roligt = (pcts[0] ?? 0) + (pcts[1] ?? 0);
      out.push(`- zoner: ${zoneLine(pcts)} · roligt (Z1–Z2) ${fmtPct(roligt)} %`);
    }
  }
  out.push('');

  out.push(`## ${input.poolLabel} (${runs.length}, nyeste først)`);
  runs.forEach((run, i) => {
    out.push('');
    out.push(...renderRun(run, i + 1, input.zoneHint));
  });

  if (input.contextText.trim()) {
    out.push('');
    out.push('## Kontekst (fra dig)');
    out.push(input.contextText.trim());
  }

  const notes: string[] = [];
  if (input.unmatchedHeaders.length) {
    notes.push(
      `Kolonner uden mapping: ${input.unmatchedHeaders.slice(0, 12).join(' · ')}${input.unmatchedHeaders.length > 12 ? ' …' : ''}`,
    );
  }
  if (input.hostNote) notes.push(input.hostNote);
  if (notes.length) {
    out.push('');
    out.push('## Noter');
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
    `- **Pas:** ${fmtKm(distanceM)} · ${fmtDuration(movingSec)} · **${fmtPace(avgPace)}** · puls ${num(avgHr, 0)}/${num(maxHr, 0)}${analysis?.avgCadence != null ? ` · kadence ${num(analysis.avgCadence)}` : ''}`,
  );
  if (analysis) {
    const extras: string[] = [];
    if (analysis.elevGainM > 5) extras.push(`${num(analysis.elevGainM)} m stigning`);
    if (row.relativeEffort != null) extras.push(`RE ${num(row.relativeEffort)}`);
    if (row.gear) extras.push(row.gear);
    if (extras.length) lines.push(`- **Metadata:** ${extras.join(' · ')}`);
  }
  if (analysis?.splits.length) {
    const splits = analysis.splits
      .map(
        (s) =>
          `${s.km}) ${fmtPace(s.paceSecPerKm).replace('/km', '')}${s.avgHr ? `/${Math.round(s.avgHr)}` : ''}${s.partial ? '*' : ''}`,
      )
      .join(' · ');
    lines.push(`- **Splits (pace/puls):** ${splits}`);
  }
  if (analysis) {
    const signals: string[] = [];
    if (analysis.hrDriftPct != null) {
      const verdict =
        analysis.hrDriftPct > 8
          ? 'for høj — aerob kapacitet presset'
          : analysis.hrDriftPct > 5
            ? 'let forhøjet'
            : 'stabil';
      signals.push(`HR-drift ${num(analysis.hrDriftPct, 1)} % (${verdict})`);
    }
    if (analysis.secondHalfPaceDeltaSec != null) {
      signals.push(
        `2. halvdel ${fmtDelta(analysis.secondHalfPaceDeltaSec)}${analysis.secondHalfPaceDeltaSec < 0 ? ' (negativ split)' : ''}`,
      );
    }
    if (analysis.pauseCount) {
      signals.push(`${analysis.pauseCount} pause${analysis.pauseCount > 1 ? 'r' : ''} (${fmtDuration(analysis.pauseSec)})`);
    }
    if (analysis.paceCvPct != null) signals.push(`pace-jævnhed CV ${num(analysis.paceCvPct, 1)} %`);
    if (signals.length) lines.push(`- **Signaler:** ${signals.join(' · ')}`);
    if (analysis.zonePct && analysis.zoneMaxHr != null) {
      const source = analysis.zoneSource === 'fit' ? 'fra uret' : 'fra --max-hr';
      lines.push(
        `- **Zoner:** ${zoneLine(analysis.zonePct)} (max-puls ${num(analysis.zoneMaxHr)}, ${source})`,
      );
    } else if (analysis.zoneConfigured) {
      lines.push('- _note: ingen zonefordeling (turen har ingen pulsdata)_');
    } else {
      lines.push(
        `- _note: ingen zonefordeling (ingen max-puls${zoneHint ? ` — ${zoneHint}` : ' — sæt --max-hr'})_`,
      );
    }
    // Noten siger kun noget, når vi faktisk bruger den GPS-udledte distance.
    // Når CSV'en har totalen, bruger vi den (den afviger 0 % mod Strava).
    const usingGpsDistance = analysis.distanceDerived && !(row.distanceM != null && row.distanceM > 0);
    if (usingGpsDistance) {
      lines.push('- _note: distance udledt af GPS (filen bærer ingen distance — tallet er en tilnærmelse)_');
    }
  } else if (run.error) {
    lines.push(`- _intra-tur-detaljer utilgængelige: ${run.error}_`);
  }
  return lines;
}

function paceFrom(row: ActivityRow): number | null {
  const d = row.distanceM;
  const t = row.movingSec ?? row.elapsedSec;
  return d && t ? t / (d / 1000) : null;
}

/**
 * Summér zone-sekunder over løb i baseline-vinduet — samme udvalg som
 * `windowStats`, men kun løb hvor zonerne faktisk kunne beregnes.
 */
function windowZoneSeconds(runs: DigestedRun[], before: Date, days: number): number[] | null {
  const from = new Date(before.getTime() - days * 86_400_000);
  const buckets = [0, 0, 0, 0, 0];
  let any = false;
  for (const run of runs) {
    if (!(run.row.date > from && run.row.date <= before)) continue;
    const zones = run.analysis?.zones;
    if (!zones) continue;
    any = true;
    zones.forEach((s, i) => {
      buckets[i] = (buckets[i] ?? 0) + s;
    });
  }
  return any ? buckets : null;
}

function iso(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
