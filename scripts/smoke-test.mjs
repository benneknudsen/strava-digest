// Smoke-test: genererer syntetiske fixtures (ingen persondata), kører hele
// pipelinen og fejler hvis nøgletallene ikke stemmer. Kør med `npm test`.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyseRun } from '../src/analysis.ts';
import { parseActivityBuffer } from '../src/activity.ts';
import { mapColumns } from '../src/columns.ts';
import { parseCsv } from '../src/csv.ts';
import { renderMarkdown } from '../src/digest.ts';
import { findActivitiesCsv, openSource, resolveActivityEntry } from '../src/source.ts';
import { toActivities } from '../src/strava.ts';

const tmp = mkdtempSync(join(tmpdir(), 'strava-digest-test-'));
let failures = 0;

function check(label, actual, predicate) {
  const ok = predicate(actual);
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${ok ? '' : ` — fik: ${JSON.stringify(actual)}`}`);
}

try {
  execFileSync('node', ['scripts/make-fixtures.mjs', tmp], { stdio: 'inherit' });

  const source = await openSource(tmp);
  const found = findActivitiesCsv(source);
  check('finder activities.csv', found?.csv ?? null, (v) => v === 'activities.csv');

  const table = parseCsv((await source.read(found.csv)).toString('utf8'));
  const map = mapColumns(table);
  check('alle kolonner mappet', map.unmatched.length, (v) => v === 0);

  const activities = toActivities(table, map);
  check('antal aktiviteter', activities.length, (v) => v === 4);
  check('antal løb', activities.filter((a) => a.isRun).length, (v) => v === 3);
  check('nyeste først', activities[0].name, (v) => v === 'Lang tur');

  // GPX-vejen: lang tur, 10 km, stigende puls, faldende pace
  const gpxEntry = resolveActivityEntry(source, found.root, activities[0].filename);
  const track = parseActivityBuffer(gpxEntry, await source.read(gpxEntry));
  const a = analyseRun(track);
  console.log(`\n      lang tur: ${(a.distanceM / 1000).toFixed(2)} km, ${a.splits.length} splits, HR-drift ${a.hrDriftPct?.toFixed(1)} %`);
  check('distance ~10 km', a.distanceM, (v) => Math.abs(v - 10_000) < 60);
  check('10 splits', a.splits.length, (v) => v === 10);
  check('avg pace ~5:19/km', a.avgPaceSecPerKm, (v) => v > 310 && v < 330);
  check('HR-drift i interval', a.hrDriftPct, (v) => v != null && v > 1 && v < 10);
  check('negativ split', a.secondHalfPaceDeltaSec, (v) => v != null && v < 0);
  check('pace-jævnhed CV < 5 %', a.paceCvPct, (v) => v != null && v < 5);
  check('puls-niveau', a.avgHr, (v) => v != null && v > 140 && v < 165);

  const md = renderMarkdown({
    sourceLabel: 'test',
    activitiesInExport: activities.length,
    runs: [{ row: activities[0], analysis: a }],
    baselineDays: 28,
    unmatchedHeaders: map.unmatched,
    contextText: 'Testkontekst',
    generatedAt: new Date('2026-10-13T08:00:00'),
    poolLabel: 'Løb',
  });
  check('digest indeholder splits', md.includes('Splits'), (v) => v === true);
  check('digest indeholder kontekst', md.includes('Testkontekst'), (v) => v === true);
  const bytes = Buffer.byteLength(md, 'utf8');
  const rawBytes = statSync(join(tmp, 'activities/Run-1001.gpx')).size;
  console.log(`      digest: ${bytes} tegn · rå GPX for samme tur: ${rawBytes} tegn (${Math.round(rawBytes / bytes)}x)`);
  check('digest er kompakt (< 4 KB)', bytes, (v) => v < 4096);
  check('digest er meget mindre end rådata', rawBytes / bytes, (v) => v > 50);

  await source.close();

  // CLI-vejen på samme mappe
  const cli = execFileSync('node', ['src/cli.ts', tmp, '--last', '2'], { encoding: 'utf8' });
  check('CLI skriver digest', cli.includes('# Træningsdigest'), (v) => v === true);
  check('CLI viser HR-drift', cli.includes('HR-drift'), (v) => v === true);

  // FIT-vejen på en rigtig binær fil (offentlig fixture, se README)
  const fitBuffer = await readFile(new URL('../fixtures/sample.fit', import.meta.url));
  const fitTrack = parseActivityBuffer('sample.fit', fitBuffer);
  check('FIT-parser kører', fitTrack.source, (v) => v === 'fit');
  check('FIT-punkter læst', fitTrack.points.length, (v) => v === 14);
  check('FIT-sport læst', fitTrack.sport, (v) => v === 'running');
  const fitAnalysis = analyseRun(fitTrack);
  check('analyse på FIT uden HR crasher ikke', fitAnalysis.avgHr, (v) => v === null);
  check('analyse på FIT giver distance', fitAnalysis.distanceM, (v) => v > 0);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} test(s) fejlede` : '\nalle tests bestået');
process.exit(failures ? 1 : 0);
