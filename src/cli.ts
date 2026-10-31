#!/usr/bin/env node
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { parseActivityBuffer, type Track } from './activity.ts';
import { analyseRun } from './analysis.ts';
import { isPlausibleDate, mapColumns } from './columns.ts';
import { parseCsv } from './csv.ts';
import { renderMarkdown, type DigestInput, type DigestedRun } from './digest.ts';
import { renderAgent } from './agent.ts';
import { discoverSources, pickSource, searchDirs, type Candidate } from './interactive.ts';
import { installSkill, renderInstall } from './install.ts';
import { activityFormatOf, limitForFileName, tooLargeError } from './limits.ts';
import { collectActivityFiles, firstValidPoint, isActivityFile, MIN_TRACK_POINTS, rowFromTrack } from './loose.ts';
import { maxValue } from './minmax.ts';
import { type ExportSource, findActivitiesCsv, openSource, readFileLimited, resolveActivityEntry } from './source.ts';
import { type ActivityRow, type ActivityStats, parseActivities } from './strava.ts';
import { MIN_P95_VALUES, resolveZoneConfig } from './zones.ts';

interface Args {
  input: string;
  last: number;
  out: string | null;
  json: boolean;
  list: boolean;
  all: boolean;
  baselineDays: number;
  context: string;
  /** true når brugeren selv gav --context; standardstien advarer ikke. */
  contextExplicit: boolean;
  maxHr: number | null;
  /** antal løb der får fuld split-opdeling i agent-formatet */
  detail: number;
  /** 'agent' (standard) eller 'md' */
  format: 'agent' | 'md';
}

const HELP = `strava-digest — activity files or a Strava export (zip) -> compact training digest

  strava-digest <export.zip|folder|activity-file|activity-folder> [flags]
  strava-digest            interactive picker, when run in a terminal

  --last N        describe only the newest N runs; WEEKS, WINDOW and STATS still cover the whole export
  --detail N      only the newest N runs get per-km splits (default: all)
  --all           include all activity types, not just runs
  --list          show only the index of activities
  --find          find possible exports and print them as paths (one per line)
  --install-skill copy the agent skill to the agents found on this machine
  --out FIL       write to a file instead of stdout
  --json          machine-readable JSON instead of the digest
  --format md     human-readable Markdown instead of the agent format
  --days N        comparison window in days (default 28)
  --max-hr N      max heart rate for the zone split (Z1–Z5 = 50–100 % of max)
  --context FIL   context file to embed (default ./context.md if it exists)

The default output is an agent format: one machine-readable line per run
with every field, a week overview and a SCHEMA section, so an LLM can read
the whole export without guessing what the fields mean.

--find scans the same places as the interactive picker and prints one
path per line, so a script or an agent can locate the export without
parsing a human-readable list.

Sources:
  zip or folder with activities.csv   a full Strava bulk export
  single activity file or folder      .fit, .gpx or .tcx (also .gz);
                                       metadata is read from the files themselves — the
                                       name comes from the filename, and Relative
                                       Effort, gear and calories are not available
                                       without activities.csv

The zip is read as a stream — nothing is unpacked to disk, and media/ is
never touched.

Tip: you can drag the file into the terminal instead of typing the path —
macOS, Linux and Windows all paste the full path for you.

Requires Node >= 22.18. No GUI, no server, no other installation.`;

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
    // Exit 0 kun hvis mindst én agent faktisk fik en skill. "not found" er
    // ikke en succes.
    return results.some((r) => r.status === 'installed' || r.status === 'updated') ? 0 : 1;
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
    const missingMessage = missingActivitiesCsvMessage(source);
    await source.close();
    const files = await collectActivityFiles(args.input);
    if (files.length) return runLoose(args, args.input, true, files);
    console.error(missingMessage);
    return 1;
  }

  if (isActivityFile(args.input)) {
    return runLoose(args, args.input, false, await collectActivityFiles(args.input));
  }

  const source = await openSource(args.input);
  try {
    const found = findActivitiesCsv(source);
    if (!found) {
      console.error(missingActivitiesCsvMessage(source));
      return 1;
    }
    return await runBulk(source, found, args);
  } finally {
    await source.close();
  }
}

function missingActivitiesCsvMessage(source: ExportSource): string {
  const warnings = source.warnings();
  if (source.hasSkippedActivitiesCsv()) {
    return `Found an activities.csv in ${source.label}, but it was skipped: ${warnings.join(' ')}`;
  }
  if (warnings.length) {
    return `Could not find activities.csv in ${source.label}. ${warnings.join(' ')} Is it a Strava bulk export?`;
  }
  return `Could not find activities.csv in ${source.label}. Is it a Strava bulk export?`;
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
  const { activities, stats } = parseActivities(csv, map);
  const pool = args.all ? activities : activities.filter((a) => a.isRun);

  if (args.list) {
    for (const a of activities.slice(0, 400)) {
      const file = a.filename || '(no file)';
      console.log(
        `${a.date.toISOString().slice(0, 10)}  ${a.isRun ? 'RUN' : '   '}  ${a.type.padEnd(14)}  ${file}  zones: ${await zoneStatus(source, found.root, a.filename)}`,
      );
    }
    const total = stats.rowsInExport;
    console.log(`\n${total} ${total === 1 ? 'activity' : 'activities'} in total (shown: ${Math.min(400, activities.length)})`);
    const noFilenameInPool = pool.filter((row) => !row.filename).length;
    const distanceNote = distanceUnitNote(stats);
    for (const note of [
      ...source.warnings(),
      ...(distanceNote ? [distanceNote] : []),
      ...coverageNotes(stats, noFilenameInPool, true),
    ]) {
      console.log(`\n${note}`);
    }
    if (map.unmatched.length) console.log(`\nUnmapped columns: ${map.unmatched.join(' · ')}`);
    return 0;
  }

  // I agent-formatet er standarden ALLE løb: en coach-agent skal kunne se
  // hele historikken, ellers kan den ikke finde tendenser. --last kan
  // stadig begrænse, og da er det et bevidst valg.
  const limit = args.last > 0 ? args.last : pool.length;
  if (!pool.length) {
    console.error('No runs found in the export (try --all).');
    return 1;
  }

  // p95-grundlaget bruges som zone-fallback, så det skal ligge FØR
  // analysen — ellers ville turene blive analyseret uden zoner.
  const observedMax = observedMaxHeartRate(activities);
  const observedMaxHr = observedMax?.maxHr ?? null;

  // Alle løb i pool'en analyseres én gang, og resultaterne genbruges til
  // både digesten og baseline. At analysere to gange ville double-parse
  // hver fil og gøre hele eksporten unødigt langsom.
  const analysed: DigestedRun[] = [];
  for (const row of pool) {
    if (!row.filename) {
      // A row without a file is a real activity: its CSV distance and time
      // stay in the digest. Every track-derived field stays missing, though —
      // elev, z, drift, half, cv, pause and load come from the file. So
      // `elev=-` is deliberate even when the CSV has an Elevation Gain
      // column; mixing CSV elevation into track analysis would make the two
      // sources incomparable.
      analysed.push({
        row,
        analysis: null,
        error: 'no activity file in the export',
      });
      continue;
    }
    const entry = resolveActivityEntry(source, found.root, row.filename);
    if (!entry) {
      analysed.push({ row, analysis: null, error: `file not found in the archive (${row.filename})` });
      continue;
    }
    try {
      // The parser decides what the file is. A name that no parser accepts
      // must fail before the read: `Big.gpx.csv` gets the 100 MB export limit
      // from its suffix, but no parser can use it, and reading 98 MB only to
      // throw costs about 3x the file size in memory. The size check still
      // runs first so an oversized unknown file reports the limit it actually
      // got ("other files"), not a parse error after a full read.
      if (activityFormatOf(entry) == null) {
        const size = await source.size(entry);
        const limit = limitForFileName(entry);
        if (size > limit) throw tooLargeError(entry, size);
        throw new Error(`unknown activity format: ${entry}`);
      }
      const buf = await source.read(entry);
      const track = parseActivityBuffer(entry, buf);
      analysed.push({
        row,
        analysis: analyseRun(
          track,
          resolveZoneConfig(args.maxHr, track.zones, observedMaxHr, observedMax?.source),
        ),
      });
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

  const contextText = await readContext(args.context, args.contextExplicit);
  const usesObservedMaxHr = args.maxHr == null && observedMaxHr != null;
  const zoneSource: 'flag' | 'fit' | 'export-p95' | 'export-max' | null =
    args.maxHr != null ? 'flag' : usesObservedMaxHr && observedMax ? observedMax.source : null;
  const noFilenameInPool = pool.filter((row) => !row.filename).length;
  const coverage = coverageNotes(stats, noFilenameInPool);
  const distanceNote = distanceUnitNote(stats);
  const sourceNotes = source.warnings();
  const hostNotes = [
    ...(map.unmatched.length
      ? ['Add aliases in src/columns.ts if a field is missing from the digest.']
      : []),
    ...sourceNotes,
    ...coverage,
  ];
  const input = {
    sourceLabel: source.label,
    activitiesInExport: stats.rowsInExport,
    runsTotal: pool.length,
    runs: chosen,
    baselineRuns,
    baselineDays: args.baselineDays,
    unmatchedHeaders: map.unmatched,
    contextText,
    generatedAt: new Date(),
    poolLabel: args.all ? 'Activities' : 'Runs',
    maxHr: args.maxHr ?? observedMaxHr ?? null,
    maxHrSource: zoneSource,
    distanceNote: distanceNote ?? undefined,
    notes: [
      ...sourceNotes,
      ...(distanceNote ? [distanceNote] : []),
      ...coverage,
      ...(map.unmatched.length
        ? [
            `${map.unmatched.length} populated Strava export columns are not mapped — some may be training ` +
              'data. Run with --format md to list their names; a missing alias is one line.',
          ]
        : []),
      ...(usesObservedMaxHr && observedMax
        ? [
            `max_hr=${observedMaxHr} is ${observedBasisText(observedMax)}, not your watch's own max HR; heart-rate samples in the track files are not scanned. ` +
              "Strava's bulk export does not contain the watch's zone configuration, so the zone boundaries are a best guess.",
          ]
        : []),
    ],
    zoneHint: usesObservedMaxHr && observedMax
      ? `zones use ${observedBasisText(observedMax)} (${observedMaxHr}) — pass --max-hr <your max> to use your own.`
      : undefined,
    hostNote: hostNotes.length ? hostNotes.join(' ') : undefined,
  };

  return emitDigest(input, args, analysed);
}

function distanceUnitNote(stats: ActivityStats): string | null {
  if (!stats.distanceUnitAssumed) return null;
  return (
    'The distance unit column is empty or contradictory and the header names no unit, ' +
    'so distances use the column-scale assumption: a median above 200 means metres, otherwise kilometres.'
  );
}

/**
 * Notes about rows that are only partly represented in the digest.
 *
 * The note for rows without a file name describes the rows themselves: they
 * have no track analysis, and their distance and time come from the CSV. That
 * stays true in every format and with --last, whether or not the rows are
 * shown. Rows skipped for a missing or unparsable date are counted at export
 * level and are not in the digest.
 * Each note has its own gate: a clean export gets no note, and a missing file
 * name is reported even when no row was dropped.
 */
function coverageNotes(stats: ActivityStats, noFilenameInPool: number, forList = false): string[] {
  const notes: string[] = [];
  const { skippedNoDate, skippedNoDateNoFilename } = stats;
  if (skippedNoDate > 0) {
    const singleRow = skippedNoDate === 1;
    const skippedNote = `${skippedNoDate} ${singleRow ? 'row was' : 'rows were'} skipped because of a missing or unparsable date${forList ? '' : ` and ${singleRow ? 'is' : 'are'} not in the digest`}`;
    const also =
      skippedNoDateNoFilename > 0
        ? ` (${skippedNoDateNoFilename} of them ${skippedNoDateNoFilename === 1 ? 'was' : 'were'} also without a file name)`
        : '';
    notes.push(`${skippedNote}${also}.`);
  }

  if (noFilenameInPool > 0) {
    const singleNoFilename = noFilenameInPool === 1;
    notes.push(
      `${noFilenameInPool} ${singleNoFilename ? 'row has' : 'rows have'} no file name, so ${singleNoFilename ? 'it has' : 'they have'} no track analysis; ${singleNoFilename ? 'its' : 'their'} distance and time come from the CSV.`,
    );
  }
  return notes;
}

/* ------------------------------------------------- løse aktivitetsfiler */

interface LooseEntry {
  file: string;
  track: Track | null;
  run: DigestedRun | null;
  reason: string | null;
}

const LOOSE_HOST_NOTE =
  'Without activities.csv the export gives no activity names, so the digest uses the file names. Relative Effort, gear and calories are omitted.';

function skipReasons(skipped: LooseEntry[]): string {
  return skipped.map((e) => `${basename(e.file)} (${e.reason})`).join(', ');
}

function skippedNoteOf(skipped: LooseEntry[]): string {
  return `${skipped.length} file${skipped.length === 1 ? '' : 's'} skipped: ${skipReasons(skipped)}.`;
}

/**
 * Filer der ikke kan blive et pas: for få punkter, et første tidsstempel der er
 * uindtruffet (over 24 timer i fremtiden), eller ingen brugbar tid.
 */
function skipReason(track: Track): string {
  const n = track.points.length;
  if (n > 0 && n < MIN_TRACK_POINTS) return `only ${n} point${n === 1 ? '' : 's'}`;
  const first = firstValidPoint(track);
  if (first && !isPlausibleDate(first.t)) {
    return `date in the future (${first.t.toISOString().slice(0, 10)})`;
  }
  return 'no usable time';
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
      const track = parseActivityBuffer(file, await readFileLimited(file, basename(file)));
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
      const type = e.run ? e.run.row.type : e.track && e.track.sport !== 'unknown' ? e.track.sport : 'unknown';
      console.log(
        `${date}  ${e.run?.row.isRun ? 'RUN' : '   '}  ${type.padEnd(14)}  ${basename(e.file)}  zones: ${e.track?.zones ? 'yes' : 'no'}${e.run ? '' : '  (skipped)'}`,
      );
    }
    console.log(`\n${files.length} activity ${files.length === 1 ? 'file' : 'files'} in total (shown: ${Math.min(400, files.length)})`);
    console.log(`\n${LOOSE_HOST_NOTE}`);
    if (skipped.length) {
      console.log(`\n${skippedNoteOf(skipped)}`);
    }
    return 0;
  }

  const runs = usable.map((e) => e.run!);
  const pool = args.all ? runs : runs.filter((r) => r.row.isRun);
  const limit = args.last > 0 ? args.last : pool.length;
  const chosen = pool.slice(0, limit);
  if (!chosen.length) {
    const allSkipped = skipped.length === files.length;
    const skipNote = skipped.length
      ? allSkipped
        ? skipped.length === 1
          ? ` The only file was skipped: ${skipReasons(skipped)}.`
          : ` All ${skipped.length} files were skipped: ${skipReasons(skipped)}.`
        : ` ${skippedNoteOf(skipped)}`
      : '';
    const headline = allSkipped
      ? 'No runs found in the activity files.'
      : 'No runs found in the activity files (try --all).';
    console.error(`${headline}${skipNote}`);
    return 1;
  }

  const notes = [LOOSE_HOST_NOTE];
  if (skipped.length) notes.push(skippedNoteOf(skipped));

  const digestInput = {
    sourceLabel: isDir
      ? `${input} (folder, ${files.length} activity file${files.length === 1 ? '' : 's'}) · metadata read from the files`
      : `${input} (file) · metadata read from the file`,
    activitiesInExport: files.length,
    runsTotal: pool.length,
    runs: chosen,
    baselineRuns: usable.map((e) => e.run!),
    baselineDays: args.baselineDays,
    unmatchedHeaders: [] as string[],
    contextText: await readContext(args.context, args.contextExplicit),
    generatedAt: new Date(),
    poolLabel: args.all ? 'Activities' : 'Runs',
    maxHr: args.maxHr ?? null,
    maxHrSource: args.maxHr != null ? ('flag' as const) : null,
    notes,
    hostNote: notes.join(' '),
  };

  return emitDigest(digestInput, args, pool);
}

async function emitDigest(
  input: DigestInput,
  args: Args,
  allRuns: DigestedRun[],
): Promise<number> {
  const { distanceNote, ...jsonInput } = input;
  const output = args.json
    ? `${JSON.stringify({ ...jsonInput, markdown: renderMarkdown(input) }, null, 2)}\n`
    : args.format === 'md'
      ? renderMarkdown(input)
      : renderAgent({
          sourceLabel: input.sourceLabel,
          activitiesInExport: input.activitiesInExport,
          runsTotal: input.runsTotal ?? input.runs.length,
          runs: input.runs,
          allRuns,
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
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
    try {
      // rename erstatter inoden. En eksisterende fils mode skal derfor
      // sættes på temp-filen først, ellers arver målet umask i stedet.
      const previous = await stat(target).catch(() => null);
      await writeFile(temp, output, previous ? { encoding: 'utf8', mode: previous.mode & 0o777 } : 'utf8');
      await rename(temp, target);
    } catch (err) {
      await unlink(temp).catch(() => {});
      throw err;
    }
    console.error(`wrote ${target} (${Buffer.byteLength(output, 'utf8')} bytes)`);
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
    contextExplicit: false,
    maxHr: null,
    // 0 = alle løb får splits. Prisen er lille: på 196 løb koster det
    // ~2.900 ekstra tokens, og splits med puls er det, en coach-agent
    // faktisk analyserer på.
    detail: 0,
    format: 'agent',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    // `--flag=value` is the same as `--flag value`; an unknown flag must fail
    // loudly instead of being skipped. Only double-dash flags are checked, so a
    // path argument behaves exactly as before.
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    const flag = eq >= 0 ? a.slice(0, eq) : a;
    const inline = eq >= 0 ? a.slice(eq + 1) : undefined;
    const next = (): string => {
      const value = inline ?? argv[++i];
      // Both `--flag value` and `--flag=value` must validate the value the
      // same way: empty or another flag means the value is missing.
      if (value === undefined || value.startsWith('--') || value.trim() === '') {
        throw new Error(`missing value for ${flag}`);
      }
      return value;
    };
    const noValue = () => {
      if (inline !== undefined) throw new Error(`flag ${flag} does not take a value`);
    };
    if (flag === '--last') args.last = Number(next()) || 0;
    else if (flag === '--detail') args.detail = Number(next()) || args.detail;
    else if (flag === '--out') args.out = next();
    else if (flag === '--context') {
      args.context = next();
      // Kun en brugerangivet --context advarer hvis filen ikke kan læses;
      // standardstien context.md må ikke støje for enhver kørsel (#22).
      args.contextExplicit = true;
    }
    else if (flag === '--days') args.baselineDays = Number(next()) || args.baselineDays;
    else if (flag === '--max-hr') args.maxHr = parseMaxHr(next());
    else if (flag === '--json') { noValue(); args.json = true; }
    else if (flag === '--list') { noValue(); args.list = true; }
    else if (flag === '--all') { noValue(); args.all = true; }
    else if (flag === '--format') {
      const value = next().trim();
      if (value !== 'md' && value !== 'agent') {
        throw new Error(
          `invalid --format: "${value}" — use "md" for Markdown; the machine format is the default (use --json for JSON output)`,
        );
      }
      args.format = value;
    }
    else if (flag.startsWith('--')) throw new Error(`unknown flag: ${flag}`);
    else if (!flag.startsWith('-') && !args.input) args.input = flag;
  }
  if (!args.input) throw new Error('missing path to an export (zip, folder or activity file)');
  return args;
}

async function readContext(path: string, warn = false): Promise<string> {
  try {
    return await readFile(resolve(path), 'utf8');
  } catch {
    if (warn) {
      console.error(`strava-digest: cannot read the context file ${path}; continuing without it.`);
    }
    return '';
  }
}

interface ObservedMaxHr {
  maxHr: number;
  /** antal Max Heart Rate-værdier i toårsvinduet */
  count: number;
  /** vinduets start: to år før den nyeste aktivitet */
  from: Date;
  /** hvilket grundlag maxHr er: p95 eller den højeste målte værdi */
  source: 'export-p95' | 'export-max';
}

/**
 * Robust zonegrundlag fra eksportens egen `Max Heart Rate`-kolonne: p95 af
 * værdierne i de to år før den nyeste aktivitet. Vinduet regnes fra den
 * nyeste aktivitet, ikke fra i dag, så en gammel eksport giver samme svar i
 * dag og om et år. Kræver mindst MIN_P95_VALUES; ellers er grundlaget den højeste
 * målte værdi i vinduet, og `source=export-max` siger hvorfor.
 *
 * Rækker uden fil tæller med: de er en del af eksporten, og deres Max HR
 * står i CSV'en. Rækker der blev droppet for en manglende eller ufortolkbar
 * dato kan ikke placeres i vinduet og tæller derfor ikke med.
 *
 * Formuleringen om p95 står også i README.md (Notes on the data → Zones)
 * og i agent-formatets SIGNALS. Denne funktion læser kun CSV-kolonnen
 * `Max Heart Rate` — puls-samples i spor-filerne scannes ikke. Hvis denne
 * definition ændres, skal README.md og SIGNALS følge med.
 */
function observedMaxHeartRate(activities: ActivityRow[]): ObservedMaxHr | null {
  const newest = activities[0]?.date;
  if (!newest) return null;
  const from = new Date(newest);
  from.setFullYear(from.getFullYear() - 2);
  const values = activities
    .filter((a) => a.date >= from && a.date <= newest && a.maxHr != null && a.maxHr > 0)
    .map((a) => a.maxHr!);
  if (!values.length) return null;
  const maxHr = maxValue(values);
  if (values.length < MIN_P95_VALUES) {
    return { maxHr, count: values.length, from, source: 'export-max' };
  }
  // Type 7 (lineær interpolation): p95 = værdien ved indeks (n - 1) * 0,95.
  // Det holder et enkelt spike uden for grundlaget, når der er nok værdier.
  values.sort((a, b) => a - b);
  const index = (values.length - 1) * 0.95;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const p95 = values[lower]! + (index - lower) * (values[upper]! - values[lower]!);
  return { maxHr: Math.round(p95), count: values.length, from, source: 'export-p95' };
}

function observedBasisText(observed: ObservedMaxHr): string {
  const window = `observed in the export since ${observed.from.toISOString().slice(0, 10)} (two years back from the newest activity)`;
  if (observed.source === 'export-max') {
    const noun = observed.count === 1 ? 'value' : 'values';
    return `the highest of ${observed.count} Max Heart Rate ${noun} ${window} — fewer than ${MIN_P95_VALUES} values, so it is the highest measured value, not a p95`;
  }
  return `the 95th percentile of ${observed.count} Max Heart Rate values ${window}`;
}

function parseMaxHr(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`invalid --max-hr: "${value}" — give a positive integer, e.g. --max-hr 190`);
  }
  return n;
}

/** Svarer kort på om aktivitetsfilen selv indeholder zonedata (kun FIT kan). */
async function zoneStatus(source: ExportSource, root: string, filename: string): Promise<'yes' | 'no'> {
  if (activityFormatOf(filename) !== 'fit') return 'no';
  const entry = resolveActivityEntry(source, root, filename);
  if (!entry) return 'no';
  try {
    const track = parseActivityBuffer(entry, await source.read(entry));
    return track.zones ? 'yes' : 'no';
  } catch {
    return 'no';
  }
}

// process.exit() afbryder asynkrone stdout-skrivninger, så alt over
// pipe-bufferen (64 KiB) blev klippet af uden fejlmelding. Med exitCode
// får Node lov til at tømme stdout, før processen afslutter af sig selv.
// En læser der lukker pipen tidligt (| head, | less og 'q') giver EPIPE.
// Det er ikke en fejl — læseren fik det den ville have.
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') return;
  throw err;
});

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
