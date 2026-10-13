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
import { boundariesFromMaxHr, resolveZoneConfig, zoneIndex } from '../src/zones.ts';

const tmp = mkdtempSync(join(tmpdir(), 'strava-digest-test-'));
let failures = 0;

function check(label, actual, predicate) {
  const ok = predicate(actual);
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${ok ? '' : ` — fik: ${JSON.stringify(actual)}`}`);
}

// Minimal FIT-binary med zones_target (global 7) og hr_zone (global 8), så
// zone-læsningen testes mod den rigtige parser uden en ekstern fixture.
function makeFitZones({ maxHr, zoneHighs }) {
  const crcTable = [0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401, 0xa001, 0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400];
  const crc = (bytes) => {
    let crc = 0;
    for (const byteVal of bytes) {
      let tmp = crcTable[crc & 0xf];
      crc = (crc >> 4) & 0x0fff;
      crc = crc ^ tmp ^ crcTable[byteVal & 0xf];
      tmp = crcTable[crc & 0xf];
      crc = (crc >> 4) & 0x0fff;
      crc = crc ^ tmp ^ crcTable[(byteVal >> 4) & 0xf];
    }
    return crc;
  };
  const data = [];
  // zones_target: max_heart_rate (felt 1, uint8) i lokal beskedtype 0
  data.push(0x40, 0x00, 0x00, 0x07, 0x00, 0x01, 0x01, 0x01, 0x02);
  data.push(0x00, maxHr);
  // hr_zone: high_bpm (felt 1, uint8) + message_index (felt 254, uint16) i lokal type 1
  data.push(0x41, 0x00, 0x00, 0x08, 0x00, 0x02, 0x01, 0x01, 0x02, 0xfe, 0x02, 0x84);
  zoneHighs.forEach((high, i) => data.push(0x01, high, i & 0xff, (i >> 8) & 0xff));
  const header = [14, 0x10, 0x21, 0x08, data.length & 0xff, (data.length >> 8) & 0xff, 0, 0, 0x2e, 0x46, 0x49, 0x54, 0, 0];
  const body = [...header, ...data];
  const fileCrc = crc(body);
  return Buffer.from([...body, fileCrc & 0xff, (fileCrc >> 8) & 0xff]);
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

  // Zone-primitiver: grænser, indeks og kilde-prioritet
  const b200 = boundariesFromMaxHr(200);
  check('zonegrænser fra max-puls', b200, (v) => JSON.stringify(v) === JSON.stringify([120, 140, 160, 180]));
  check('zoneIndex under Z1-grænse klemmes til Z1', zoneIndex(90, b200), (v) => v === 0);
  check('zoneIndex rammer Z4 ved 160', zoneIndex(160, b200), (v) => v === 3);
  check('zoneIndex lige under grænse holder Z3', zoneIndex(159, b200), (v) => v === 2);
  check('zoneIndex over Z4-grænse giver Z5', zoneIndex(200, b200), (v) => v === 4);
  check('uden flag og uden FIT-zoner: ingen konfiguration', resolveZoneConfig(null, undefined), (v) => v === null);
  check('FIT-zoner bruges når flag mangler', resolveZoneConfig(null, { maxHr: 190 }), (v) => v?.source === 'fit' && v?.maxHr === 190);
  check('flag vinder over FIT-zoner', resolveZoneConfig(200, { maxHr: 190 }), (v) => v?.source === 'flag' && v?.maxHr === 200);

  // Zonefordeling pr. løb via analyseRun (max-puls 210, realistisk for
  // fixturens pulsniveauer, så Z2/Z3-grænserne faktisk skærer turene;
  // ingen FIT-zonebeskeder findes i de syntetiske fixtures)
  const zcfg = resolveZoneConfig(210, undefined);
  const az = analyseRun(track, zcfg);
  check('zoneprocenter summer til 100', az.zonePct?.reduce((s, p) => s + p, 0) ?? null, (v) => v != null && Math.abs(v - 100) < 1);
  check('zoner i sekunder summer til effektiv tid', az.zones?.reduce((s, z) => s + z, 0) ?? null, (v) => v != null && v > 3000 && v < 3200);
  check('zoneSource fra flag', az.zoneSource, (v) => v === 'flag');
  check('zoneMaxHr fra flag', az.zoneMaxHr, (v) => v === 210);

  const tempoEntry = resolveActivityEntry(source, found.root, activities[1].filename);
  const tempoTrack = parseActivityBuffer(tempoEntry, await source.read(tempoEntry));
  const tempoAz = analyseRun(tempoTrack, zcfg);
  const roligEntry = resolveActivityEntry(source, found.root, activities[2].filename);
  const roligTrack = parseActivityBuffer(roligEntry, await source.read(roligEntry));
  const roligAz = analyseRun(roligTrack, zcfg);
  const z12 = (pcts) => (pcts ? pcts[0] + pcts[1] : null);
  const z3plus = (pcts) => (pcts ? pcts[2] + pcts[3] + pcts[4] : null);
  check('rolig tur: Z2 er største zone', roligAz.zonePct ? roligAz.zonePct.indexOf(Math.max(...roligAz.zonePct)) : -1, (v) => v === 1);
  check('rolig tur har større Z1+Z2-andel end tempoturen', (z12(roligAz.zonePct) ?? 0) - (z12(tempoAz.zonePct) ?? 0), (v) => v > 0);
  check('tempotur har større Z3+-andel end rolig tur', (z3plus(tempoAz.zonePct) ?? 0) - (z3plus(roligAz.zonePct) ?? 0), (v) => v > 0);
  check('rolig tur: zoneprocenter summer til 100', roligAz.zonePct?.reduce((s, p) => s + p, 0) ?? null, (v) => v != null && Math.abs(v - 100) < 1);
  check('tempotur: zoneprocenter summer til 100', tempoAz.zonePct?.reduce((s, p) => s + p, 0) ?? null, (v) => v != null && Math.abs(v - 100) < 1);

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
  check('digest uden max-puls: note om manglende zoner', md.includes('- _note: ingen zonefordeling (ingen max-puls — sæt --max-hr)_'), (v) => v === true);
  const bytes = Buffer.byteLength(md, 'utf8');
  const rawBytes = statSync(join(tmp, 'activities/Run-1001.gpx')).size;
  console.log(`      digest: ${bytes} tegn · rå GPX for samme tur: ${rawBytes} tegn (${Math.round(rawBytes / bytes)}x)`);
  check('digest er kompakt (< 4 KB)', bytes, (v) => v < 4096);
  check('digest er meget mindre end rådata', rawBytes / bytes, (v) => v > 50);

  const mdZones = renderMarkdown({
    sourceLabel: 'test',
    activitiesInExport: activities.length,
    runs: [
      { row: activities[0], analysis: az },
      { row: activities[1], analysis: tempoAz },
    ],
    baselineDays: 28,
    unmatchedHeaders: [],
    contextText: '',
    generatedAt: new Date('2026-10-13T08:00:00'),
    poolLabel: 'Løb',
  });
  check('digest viser zoner pr. løb', mdZones.includes('- **Zoner:** Z1 '), (v) => v === true);
  check('digest viser zonekilde', mdZones.includes('(max-puls 210, fra --max-hr)'), (v) => v === true);
  check('baseline summer zoner i vinduet', mdZones.includes('- zoner: Z1 ') && mdZones.includes('roligt (Z1–Z2)'), (v) => v === true);
  check('zonedigest fortsat under 4 KB', Buffer.byteLength(mdZones, 'utf8'), (v) => v < 4096);

  await source.close();

  // CLI-vejen på samme mappe
  const cli = execFileSync('node', ['src/cli.ts', tmp, '--last', '2'], { encoding: 'utf8' });
  check('CLI skriver digest', cli.includes('# Træningsdigest'), (v) => v === true);
  check('CLI viser HR-drift', cli.includes('HR-drift'), (v) => v === true);
  check('CLI uden max-puls: note om manglende zoner', cli.includes('ingen zonefordeling'), (v) => v === true);

  const cliJson = JSON.parse(
    execFileSync('node', ['src/cli.ts', tmp, '--last', '2', '--max-hr', '240', '--json'], { encoding: 'utf8' }),
  );
  check('--max-hr giver zoneSource flag', cliJson.runs[0]?.analysis?.zoneSource ?? null, (v) => v === 'flag');
  check('--max-hr sætter zoneMaxHr', cliJson.runs[0]?.analysis?.zoneMaxHr ?? null, (v) => v === 240);
  check('zoneprocenter i JSON summer til 100', cliJson.runs[0]?.analysis?.zonePct?.reduce((s, p) => s + p, 0) ?? null, (v) => v != null && Math.abs(v - 100) < 1);

  const cliZones = execFileSync('node', ['src/cli.ts', tmp, '--last', '2', '--max-hr', '240'], { encoding: 'utf8' });
  check('CLI-digest viser Zoner-linje', cliZones.includes('- **Zoner:** Z1 '), (v) => v === true);
  check('CLI-digest viser baseline-roligt', cliZones.includes('roligt (Z1–Z2)'), (v) => v === true);

  const cliList = execFileSync('node', ['src/cli.ts', tmp, '--list'], { encoding: 'utf8' });
  check('--list viser zone-status', cliList.includes('zoner: nej'), (v) => v === true);

  let hrErr = null;
  try {
    execFileSync('node', ['src/cli.ts', tmp, '--max-hr', '0'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    hrErr = err;
  }
  check('ugyldig --max-hr fejler', hrErr !== null, (v) => v === true);
  check('ugyldig --max-hr giver dansk besked', String(hrErr?.stderr ?? ''), (v) => v.includes('positivt heltal'));

  // FIT-vejen på en rigtig binær fil (offentlig fixture, se README)
  const fitBuffer = await readFile(new URL('../fixtures/sample.fit', import.meta.url));
  const fitTrack = parseActivityBuffer('sample.fit', fitBuffer);
  check('FIT-parser kører', fitTrack.source, (v) => v === 'fit');
  check('FIT-punkter læst', fitTrack.points.length, (v) => v === 14);
  check('FIT-sport læst', fitTrack.sport, (v) => v === 'running');
  const fitAnalysis = analyseRun(fitTrack);
  check('analyse på FIT uden HR crasher ikke', fitAnalysis.avgHr, (v) => v === null);
  check('analyse på FIT giver distance', fitAnalysis.distanceM, (v) => v > 0);
  check('FIT uden zonedata giver ingen zoner', fitTrack.zones, (v) => v === undefined);
  const noHrAnalysis = analyseRun(fitTrack, resolveZoneConfig(190, undefined));
  check('analyse uden puls giver zones === null', noHrAnalysis.zones, (v) => v === null);
  check('zonekonfig uden pulsdata: zoneConfigured er true', noHrAnalysis.zoneConfigured, (v) => v === true);
  const mdNoHr = renderMarkdown({
    sourceLabel: 'test',
    activitiesInExport: 1,
    runs: [{ row: activities[0], analysis: noHrAnalysis }],
    baselineDays: 28,
    unmatchedHeaders: [],
    contextText: '',
    generatedAt: new Date('2026-10-13T08:00:00'),
    poolLabel: 'Løb',
  });
  check('digest uden pulsdata: note om pulsdata frem for --max-hr', mdNoHr.includes('- _note: ingen zonefordeling (turen har ingen pulsdata)_'), (v) => v === true);

  // FIT med zones_target + hr_zone: zonerne skal læses fra filen
  const zonedTrack = parseActivityBuffer('zonetest.fit', makeFitZones({ maxHr: 190, zoneHighs: [114, 133, 152, 171] }));
  check('FIT: max-puls læst fra zones_target', zonedTrack.zones?.maxHr ?? null, (v) => v === 190);
  check('FIT: fire hr_zone-grænser læst', zonedTrack.zones?.boundaries ?? null, (v) => JSON.stringify(v) === JSON.stringify([114, 133, 152, 171]));
  const zonedCfg = resolveZoneConfig(null, zonedTrack.zones);
  check('FIT-zoner giver source fit med urets grænser', zonedCfg, (v) => v?.source === 'fit' && v?.maxHr === 190 && v?.boundaries?.[3] === 171);

  const fiveZoneTrack = parseActivityBuffer('zonetest.fit', makeFitZones({ maxHr: 190, zoneHighs: [114, 133, 152, 171, 190] }));
  check('FIT med fem zoner: kun max-puls, ingen grænser', fiveZoneTrack.zones, (v) => v?.maxHr === 190 && v?.boundaries === undefined);

  const boundsOnlyCfg = resolveZoneConfig(null, { boundaries: [114, 133, 152, 171] });
  check('kun FIT-grænser: max-puls udledes af øverste grænse', boundsOnlyCfg, (v) => v?.source === 'fit' && v?.maxHr === 190);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} test(s) fejlede` : '\nalle tests bestået');
process.exit(failures ? 1 : 0);
