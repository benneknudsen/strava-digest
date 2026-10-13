#!/usr/bin/env node
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { parseActivityBuffer, type Track } from './activity.ts';
import { analyseRun } from './analysis.ts';
import { mapColumns } from './columns.ts';
import { parseCsv } from './csv.ts';
import { renderMarkdown, type DigestInput, type DigestedRun } from './digest.ts';
import { pickSource } from './interactive.ts';
import { collectActivityFiles, isActivityFile, MIN_TRACK_POINTS, rowFromTrack } from './loose.ts';
import { type ExportSource, findActivitiesCsv, openSource, resolveActivityEntry } from './source.ts';
import { toActivities } from './strava.ts';
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
}

const HELP = `strava-digest — aktivitetsfiler eller Strava-eksport (zip) -> kompakt træningsdigest

  strava-digest <eksport.zip|mappe|aktivitetsfil|aktivitetsmappe> [flag]
  strava-digest            interaktiv vælger, når du kører i en terminal

  --last N        antal løb i digesten (default 5)
  --all           tag alle aktivitetstyper med, ikke kun løb
  --list          vis kun indekset af aktiviteter
  --out FIL       skriv til fil i stedet for stdout
  --json          maskinlæsbar JSON i stedet for Markdown
  --days N        baseline-vindue i dage (default 28)
  --max-hr N      max-puls til zonefordeling (Z1–Z5 = 50–100 % af max)
  --context FIL   kontekstfil der flettes ind (default ./context.md hvis den findes)

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
  const chosen = pool.slice(0, args.last);
  if (!chosen.length) {
    console.error('Ingen løb fundet i eksporten (prøv --all).');
    return 1;
  }

  const runs: DigestedRun[] = [];
  for (const row of chosen) {
    const entry = resolveActivityEntry(source, found.root, row.filename);
    if (!entry) {
      runs.push({ row, analysis: null, error: `fil ikke fundet i arkivet (${row.filename})` });
      continue;
    }
    try {
      const buf = await source.read(entry);
      const track = parseActivityBuffer(entry, buf);
      runs.push({ row, analysis: analyseRun(track, resolveZoneConfig(args.maxHr, track.zones)) });
    } catch (err) {
      runs.push({ row, analysis: null, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const contextText = await readContext(args.context);
  const input = {
    sourceLabel: source.label,
    activitiesInExport: activities.length,
    runs,
    baselineDays: args.baselineDays,
    unmatchedHeaders: map.unmatched,
    contextText,
    generatedAt: new Date(),
    poolLabel: args.all ? 'Aktiviteter' : 'Løb',
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
  const chosen = pool.slice(0, args.last);
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
    runs: chosen,
    baselineDays: args.baselineDays,
    unmatchedHeaders: [] as string[],
    contextText: await readContext(args.context),
    generatedAt: new Date(),
    poolLabel: args.all ? 'Aktiviteter' : 'Løb',
    hostNote: notes.join(' '),
  };

  return emitDigest(digestInput, args);
}

async function emitDigest(input: DigestInput, args: Args): Promise<number> {
  const output = args.json
    ? `${JSON.stringify({ ...input, markdown: renderMarkdown(input) }, null, 2)}\n`
    : renderMarkdown(input);
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
    last: 5,
    out: null,
    json: false,
    list: false,
    all: false,
    baselineDays: 28,
    context: 'context.md',
    maxHr: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => argv[++i] ?? '';
    if (a === '--last') args.last = Number(next()) || args.last;
    else if (a === '--out') args.out = next();
    else if (a === '--context') args.context = next();
    else if (a === '--days') args.baselineDays = Number(next()) || args.baselineDays;
    else if (a === '--max-hr') args.maxHr = parseMaxHr(next());
    else if (a === '--json') args.json = true;
    else if (a === '--list') args.list = true;
    else if (a === '--all') args.all = true;
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
