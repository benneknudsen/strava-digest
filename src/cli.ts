#!/usr/bin/env node
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { parseActivityBuffer, type Track } from './activity.ts';
import { analyseRun } from './analysis.ts';
import { mapColumns } from './columns.ts';
import { parseCsv } from './csv.ts';
import { renderMarkdown, type DigestInput, type DigestedRun } from './digest.ts';
import { renderAgent } from './agent.ts';
import { discoverSources, pickSource, searchDirs, type Candidate } from './interactive.ts';
import { installSkill, renderInstall } from './install.ts';
import { collectActivityFiles, isActivityFile, MIN_TRACK_POINTS, rowFromTrack } from './loose.ts';
import { type ExportSource, findActivitiesCsv, openSource, resolveActivityEntry } from './source.ts';
import { type ActivityRow, toActivities } from './strava.ts';
import { resolveZoneConfig } from './zones.ts';

interface Args {
  input: string;
  last: number;
  out: string | null;
  json: boolean;
  list: boolean;
  all: boolean;
  baselineDays: number;
  context: string;
  maxHr: number | null;
  /** antal løb der får fuld split-opdeling i agent-formatet */
  detail: number;
  /** 'agent' (standard) eller 'md' */
  format: 'agent' | 'md';
}

const HELP = `strava-digest — aktivitetsfiler eller Strava-eksport (zip) -> kompakt træningsdigest

  strava-digest <eksport.zip|mappe|aktivitetsfil|aktivitetsmappe> [flag]
  strava-digest            interaktiv vælger, når du kører i en terminal

  --last N        antal løb i digesten (default: alle)
  --detail N      antal nyeste løb der får fuld split-opdeling (default 10)
  --all           tag alle aktivitetstyper med, ikke kun løb
  --list          vis kun indekset af aktiviteter
  --find          find mulige eksporter og print dem som stier (én pr. linje)
  --install-skill kopierer agent-skillen til de agenter der findes på maskinen
  --out FIL       skriv til fil i stedet for stdout
  --json          maskinlæsbar JSON i stedet for digest
  --format md     menneskelæsbar Markdown i stedet for agent-format
  --days N        sammenligningsvindue i dage (default 28)
  --max-hr N      max-puls til zonefordeling (Z1–Z5 = 50–100 % af max)
  --context FIL   kontekstfil der flettes ind (default ./context.md hvis den findes)

Standardformatet er et agent-format: én maskinlæsbar linje pr. løb med
alle felter, en ugeoversigt og en SCHEMA-sektion, så en LLM kan læse
hele eksporten uden at gætte, hvad felterne betyder.

--find scanner de samme steder som den interaktive vælger og printer
én sti pr. linje, så et script eller en agent kan finde eksporten
uden at parse en menneskelæsbar liste.

Kilder:
  zip eller mappe med activities.csv   fuld Strava bulk-eksport
  enkelt aktivitetsfil eller mappe     .fit, .gpx eller .tcx (også .gz);
                                       metadata læses fra filerne selv — navnet
                                       kommer fra filnavnet, og Relative Effort,
                                       udstyr og kalorier findes ikke uden
                                       activities.csv

Zippen læses streamende — intet udpakkes til disk, og media/ røres aldrig.

Tip: du kan trække filen ind i terminalvinduet i stedet for at skrive
stien — macOS, Linux og Windows indsætter den fulde sti for dig.

Kræver Node >= 22.18. Ingen GUI, ingen server, ingen installation i øvrigt.`;

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP);
    return 0;
  }
  // --find skal virke uden en sti og uden en terminal: en agent bruger
  // det til at lokalisere eksporten, før den kører værktøjet.
  if (argv.includes('--find')) {
    return findSources();
  }
  // --install-skill: gør agenten klar med én kommando.
  if (argv.includes('--install-skill')) {
    const i = argv.indexOf('--install-skill');
    const explicit = argv[i + 1] && !argv[i + 1]!.startsWith('--') ? argv[i + 1]! : undefined;
    const { results, source } = await installSkill(explicit ? [explicit] : undefined);
    console.log(renderInstall({ results, source }));
    return results.some((r) => r.status !== 'fejlede') ? 0 : 1;
  }
  if (!argv.length) {
    if (!process.stdin.isTTY) {
      console.log(HELP);
      return 1;
    }
    const picked = await pickSource();
    if (picked == null) return 0;
    argv.push(picked);
  }

  const args = parseArgs(argv);
  const st = await stat(args.input);

  if (st.isDirectory()) {
    const source = await openSource(args.input);
    const found = findActivitiesCsv(source);
    if (found) {
      try {
        return await runBulk(source, found, args);
      } finally {
        await source.close();
      }
    }
    const label = source.label;
    await source.close();
    const files = await collectActivityFiles(args.input);
    if (files.length) return runLoose(args, args.input, true, files);
    console.error(`Kunne ikke finde activities.csv i ${label}. Er det en Strava bulk-eksport?`);
    return 1;
  }

  if (isActivityFile(args.input)) {
    return runLoose(args, args.input, false, await collectActivityFiles(args.input));
  }

  const source = await openSource(args.input);
  try {
    const found = findActivitiesCsv(source);
    if (!found) {
      console.error(
        `Kunne ikke finde activities.csv i ${source.label}. Er det en Strava bulk-eksport?`,
      );
      return 1;
    }
    return await runBulk(source, found, args);
  } finally {
    await source.close();
  }
}

/**
 * Find mulige eksporter og print dem som stier, én pr. linje.
 *
 * Uden denne må en agent gætte stier eller parse den interaktive
 * vælgers tekst. Outputtet er derfor rent maskinlæsbart: ingen
 * overskrifter, ingen nummerering — kun stier, én pr. linje.
 * Exit-kode 0 når der blev fundet noget, 1 når der ikke gjorde.
 */
async function findSources(): Promise<number> {
  const candidates = await discoverSources(searchDirs());
  // En agent vil se den RIGTIGE eksport først: en zip eller en mappe med
  // activities.csv, og helst en hvor filerne ligger lige i mappen. MAPPER
  // med filer kun i undermapper er rod og springes over — de er
  // sjældent den eksport brugeren leder efter.
  const usable = candidates.filter(
    (c) => c.kind === 'zip' || c.kind === 'csv-mappe' || c.kind === 'aktivitetsfil' || c.directCount > 0,
  );
  const list = usable.length ? usable : candidates;
  // Fuld eksport først, derefter efter filtype — ikke efter mtime, som
  // rækkerfølgen i den interaktive vælger bruger.
  const rank: Record<Candidate['kind'], number> = {
    zip: 0,
    'csv-mappe': 1,
    aktivitetsmappe: 2,
    aktivitetsfil: 3,
  };
  for (const c of [...list].sort((a, b) => rank[a.kind]! - rank[b.kind]! || b.count - a.count)) {
    console.log(c.path);
  }
  return list.length ? 0 : 1;
}

/* ------------------------------------------------------ bulk (uændret sti) */

async function runBulk(
  source: ExportSource,
  found: { csv: string; root: string },
  args: Args,
): Promise<number> {
  const csv = parseCsv((await source.read(found.csv)).toString('utf8'));
  const map = mapColumns(csv);
  const activities = toActivities(csv, map);

  if (args.list) {
    for (const a of activities.slice(0, 400)) {
      console.log(
        `${a.date.toISOString().slice(0, 10)}  ${a.isRun ? 'LØB' : '   '}  ${a.type.padEnd(14)}  ${a.filename}  zoner: ${await zoneStatus(source, found.root, a.filename)}`,
      );
    }
    console.log(`\n${activities.length} aktiviteter i alt (vist: ${Math.min(400, activities.length)})`);
    if (map.unmatched.length) console.log(`\nUmappede kolonner: ${map.unmatched.join(' · ')}`);
    return 0;
  }

  const pool = args.all ? activities : activities.filter((a) => a.isRun);
  // I agent-formatet er standarden ALLE løb: en coach-agent skal kunne se
  // hele historikken, ellers kan den ikke finde tendenser. --last kan
  // stadig begrænse, og da er det et bevidst valg.
  const limit = args.last > 0 ? args.last : pool.length;
  if (!pool.length) {
    console.error('Ingen løb fundet i eksporten (prøv --all).');
    return 1;
  }

  // Alle løb i pool'en analyseres én gang, og resultaterne genbruges til
  // både digesten og baseline. At analysere to gange ville double-parse
  // hver fil og gøre hele eksporten unødigt langsom.
  const analysed: DigestedRun[] = [];
  for (const row of pool) {
    const entry = resolveActivityEntry(source, found.root, row.filename);
    if (!entry) {
      analysed.push({ row, analysis: null, error: `fil ikke fundet i arkivet (${row.filename})` });
      continue;
    }
    try {
      const buf = await source.read(entry);
      const track = parseActivityBuffer(entry, buf);
      analysed.push({ row, analysis: analyseRun(track, resolveZoneConfig(args.maxHr, track.zones)) });
    } catch (err) {
      analysed.push({ row, analysis: null, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const chosen = analysed.slice(0, limit);

  // Baseline: alle løb i vinduet, ikke kun de løb der vises i digesten.
  // Ellers er "baseline" bare en gentagelse af digestens egen liste.
  const newest = pool[0]?.date;
  const baselineRuns = newest
    ? analysed.filter(
        (r) =>
          r.row.date.getTime() > newest.getTime() - args.baselineDays * 86_400_000 &&
          r.row.date.getTime() <= newest.getTime(),
      )
    : [];

  const contextText = await readContext(args.context);
  const observedMaxHr = observedMaxHeartRate(activities);
  const zoneSource: 'flag' | 'fit' | 'eksport-observation' | null =
    args.maxHr != null ? 'flag' : observedMaxHr != null ? 'eksport-observation' : null;
  const input = {
    sourceLabel: source.label,
    activitiesInExport: activities.length,
    runsTotal: pool.length,
    runs: chosen,
    baselineRuns,
    baselineDays: args.baselineDays,
    unmatchedHeaders: map.unmatched,
    contextText,
    generatedAt: new Date(),
    poolLabel: args.all ? 'Aktiviteter' : 'Løb',
    maxHr: args.maxHr ?? observedMaxHr ?? null,
    maxHrSource: zoneSource,
    notes: [
      ...(map.unmatched.length
        ? ['Kolonner uden mapping: ' + map.unmatched.join(' · ')]
        : []),
      ...(args.maxHr == null && observedMaxHr != null
        ? [
            `max_hr=${observedMaxHr} er det højeste puls-tal i eksporten (observeret), ikke dit ur's egen max-puls. ` +
              'Stravas bulk-eksport indeholder ikke urets zonekonfiguration, så zonegrænserne er et bedste bud.',
          ]
        : []),
    ],
    zoneHint:
      args.maxHr == null && observedMaxHr != null
        ? `observeret puls-maks i eksporten er ${observedMaxHr} — brug --max-hr ${observedMaxHr}`
        : undefined,
    hostNote: map.unmatched.length
      ? 'Tilføj aliasser i src/columns.ts hvis et felt mangler i digesten.'
      : undefined,
  };

  return emitDigest(input, args);
}

/* ------------------------------------------------- løse aktivitetsfiler */

interface LooseEntry {
  file: string;
  track: Track | null;
  run: DigestedRun | null;
  reason: string | null;
}

const LOOSE_HOST_NOTE =
  'Uden activities.csv findes eksportens navn ikke — navnet i digesten kommer fra filnavnet. Relative Effort, udstyr og kalorier er udeladt.';

/** Filer der ikke kan blive et pas: for få punkter eller ingen brugbar tid. */
function skipReason(track: Track): string {
  const n = track.points.length;
  return n > 0 && n < MIN_TRACK_POINTS ? `kun ${n} punkt` : 'ingen brugbar tid';
}

async function runLoose(
  args: Args,
  input: string,
  isDir: boolean,
  files: string[],
): Promise<number> {
  const entries: LooseEntry[] = [];
  for (const file of files) {
    try {
      const track = parseActivityBuffer(file, await readFile(file));
      const analysis = analyseRun(track, resolveZoneConfig(args.maxHr, track.zones));
      const row = rowFromTrack(file, track, analysis);
      entries.push({
        file,
        track,
        run: row ? { row, analysis } : null,
        reason: row ? null : skipReason(track),
      });
    } catch (err) {
      entries.push({
        file,
        track: null,
        run: null,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const usable = entries
    .filter((e) => e.run)
    .sort((a, b) => b.run!.row.date.getTime() - a.run!.row.date.getTime() || (a.file < b.file ? -1 : 1));
  const skipped = entries.filter((e) => !e.run);

  if (args.list) {
    for (const e of [...usable, ...skipped].slice(0, 400)) {
      const date = e.run ? e.run.row.date.toISOString().slice(0, 10) : '????-??-??';
      const type = e.run ? e.run.row.type : e.track && e.track.sport !== 'unknown' ? e.track.sport : 'ukendt';
      console.log(
        `${date}  ${e.run?.row.isRun ? 'LØB' : '   '}  ${type.padEnd(14)}  ${basename(e.file)}  zoner: ${e.track?.zones ? 'ja' : 'nej'}${e.run ? '' : '  (sprunget over)'}`,
      );
    }
    console.log(`\n${files.length} aktivitetsfiler i alt (vist: ${Math.min(400, files.length)})`);
    if (skipped.length) {
      console.log(`\nSprunget over: ${skipped.map((e) => `${basename(e.file)} (${e.reason})`).join(' · ')}`);
    }
    return 0;
  }

  const runs = usable.map((e) => e.run!);
  const pool = args.all ? runs : runs.filter((r) => r.row.isRun);
  const limit = args.last > 0 ? args.last : pool.length;
  const chosen = pool.slice(0, limit);
  if (!chosen.length) {
    const skipNote = skipped.length
      ? ` Sprunget over: ${skipped.map((e) => basename(e.file)).join(', ')}.`
      : '';
    console.error(`Ingen løb fundet i aktivitetsfilerne (prøv --all).${skipNote}`);
    return 1;
  }

  const notes = [LOOSE_HOST_NOTE];
  if (skipped.length) {
    notes.push(
      `${skipped.length} fil${skipped.length === 1 ? '' : 'er'} sprunget over: ${skipped
        .map((e) => `${basename(e.file)} (${e.reason})`)
        .join(', ')}.`,
    );
  }

  const digestInput = {
    sourceLabel: isDir
      ? `${input} (mappe, ${files.length} aktivitetsfil${files.length === 1 ? '' : 'er'}) · metadata læst fra filerne`
      : `${input} (fil) · metadata læst fra filen`,
    activitiesInExport: files.length,
    runsTotal: pool.length,
    runs: chosen,
    baselineRuns: usable.map((e) => e.run!),
    baselineDays: args.baselineDays,
    unmatchedHeaders: [] as string[],
    contextText: await readContext(args.context),
    generatedAt: new Date(),
    poolLabel: args.all ? 'Aktiviteter' : 'Løb',
    maxHr: args.maxHr ?? null,
    maxHrSource: args.maxHr != null ? ('flag' as const) : null,
    notes,
    hostNote: notes.join(' '),
  };

  return emitDigest(digestInput, args);
}

async function emitDigest(input: DigestInput, args: Args): Promise<number> {
  const output = args.json
    ? `${JSON.stringify({ ...input, markdown: renderMarkdown(input) }, null, 2)}\n`
    : args.format === 'md'
      ? renderMarkdown(input)
      : renderAgent({
          sourceLabel: input.sourceLabel,
          activitiesInExport: input.activitiesInExport,
          runsTotal: input.runsTotal ?? input.runs.length,
          runs: input.runs,
          detailCount: args.detail,
          baselineDays: input.baselineDays,
          contextText: input.contextText,
          generatedAt: input.generatedAt,
          maxHr: input.maxHr ?? null,
          maxHrSource: input.maxHrSource ?? null,
          notes: input.notes ?? [],
        });
  if (args.out) {
    const target = resolve(args.out);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, output, 'utf8');
    console.error(`skrev ${target} (${output.length} tegn)`);
  } else {
    process.stdout.write(output);
  }
  return 0;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    input: '',
    last: 0, // 0 = alle løb
    out: null,
    json: false,
    list: false,
    all: false,
    baselineDays: 28,
    context: 'context.md',
    maxHr: null,
    detail: 10,
    format: 'agent',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => argv[++i] ?? '';
    if (a === '--last') args.last = Number(next()) || 0;
    else if (a === '--detail') args.detail = Number(next()) || args.detail;
    else if (a === '--out') args.out = next();
    else if (a === '--context') args.context = next();
    else if (a === '--days') args.baselineDays = Number(next()) || args.baselineDays;
    else if (a === '--max-hr') args.maxHr = parseMaxHr(next());
    else if (a === '--json') args.json = true;
    else if (a === '--list') args.list = true;
    else if (a === '--all') args.all = true;
    else if (a === '--format') args.format = next().trim() === 'md' ? 'md' : 'agent';
    else if (!a.startsWith('-') && !args.input) args.input = a;
  }
  if (!args.input) throw new Error('mangler sti til eksport (zip, mappe eller aktivitetsfil)');
  return args;
}

async function readContext(path: string): Promise<string> {
  try {
    return await readFile(resolve(path), 'utf8');
  } catch {
    return '';
  }
}

/**
 * Højeste puls der er observeret i eksporten. Det er ikke et zonegrundlag
 * — det er blot det bedste bud på brugerens max-puls, når urets egen
 * zonekonfiguration mangler i filerne. Vises som et forslag, aldrig som
 * en sandhed.
 */
function observedMaxHeartRate(activities: ActivityRow[]): number | null {
  const values = activities.map((a) => a.maxHr).filter((v): v is number => v != null && v > 0);
  return values.length ? Math.max(...values) : null;
}

function parseMaxHr(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`ugyldig --max-hr: "${value}" — angiv et positivt heltal, fx --max-hr 190`);
  }
  return n;
}

/** Svarer kort på om aktivitetsfilen selv indeholder zonedata (kun FIT kan). */
async function zoneStatus(source: ExportSource, root: string, filename: string): Promise<'ja' | 'nej'> {
  if (!/\.fit(\.gz)?$/i.test(filename.trim())) return 'nej';
  const entry = resolveActivityEntry(source, root, filename);
  if (!entry) return 'nej';
  try {
    const track = parseActivityBuffer(entry, await source.read(entry));
    return track.zones ? 'ja' : 'nej';
  } catch {
    return 'nej';
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
