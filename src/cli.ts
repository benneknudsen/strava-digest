#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseActivityBuffer } from './activity.ts';
import { analyseRun } from './analysis.ts';
import { mapColumns } from './columns.ts';
import { parseCsv } from './csv.ts';
import { renderMarkdown, type DigestedRun } from './digest.ts';
import { findActivitiesCsv, openSource, resolveActivityEntry } from './source.ts';
import { toActivities } from './strava.ts';

interface Args {
  input: string;
  last: number;
  out: string | null;
  json: boolean;
  list: boolean;
  all: boolean;
  baselineDays: number;
  context: string;
}

const HELP = `strava-digest — Strava-eksport (zip) -> kompakt træningsdigest

  strava-digest <eksport.zip|mappe> [flag]

  --last N        antal løb i digesten (default 5)
  --all           tag alle aktivitetstyper med, ikke kun løb
  --list          vis kun indekset af aktiviteter
  --out FIL       skriv til fil i stedet for stdout
  --json          maskinlæsbar JSON i stedet for Markdown
  --days N        baseline-vindue i dage (default 28)
  --context FIL   kontekstfil der flettes ind (default ./context.md hvis den findes)

Zippen læses streamende — intet udpakkes til disk, og media/ røres aldrig.

Tip: du kan trække zip-filen ind i terminalvinduet i stedet for at skrive
stien — macOS, Linux og Windows indsætter den fulde sti for dig.

Kræver Node >= 22.18. Ingen GUI, ingen server, ingen installation i øvrigt.`;

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP);
    return argv.length ? 0 : 1;
  }

  const args = parseArgs(argv);
  const source = await openSource(args.input);
  try {
    const found = findActivitiesCsv(source);
    if (!found) {
      console.error(
        `Kunne ikke finde activities.csv i ${source.label}. Er det en Strava bulk-eksport?`,
      );
      return 1;
    }

    const csv = parseCsv((await source.read(found.csv)).toString('utf8'));
    const map = mapColumns(csv);
    const activities = toActivities(csv, map);

    if (args.list) {
      for (const a of activities.slice(0, 400)) {
        console.log(
          `${a.date.toISOString().slice(0, 10)}  ${a.isRun ? 'LØB' : '   '}  ${a.type.padEnd(14)}  ${a.filename}`,
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
        runs.push({ row, analysis: analyseRun(track) });
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
  } finally {
    await source.close();
  }
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
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => argv[++i] ?? '';
    if (a === '--last') args.last = Number(next()) || args.last;
    else if (a === '--out') args.out = next();
    else if (a === '--context') args.context = next();
    else if (a === '--days') args.baselineDays = Number(next()) || args.baselineDays;
    else if (a === '--json') args.json = true;
    else if (a === '--list') args.list = true;
    else if (a === '--all') args.all = true;
    else if (!a.startsWith('-') && !args.input) args.input = a;
  }
  if (!args.input) throw new Error('mangler sti til eksport (zip eller mappe)');
  return args;
}

async function readContext(path: string): Promise<string> {
  try {
    return await readFile(resolve(path), 'utf8');
  } catch {
    return '';
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
