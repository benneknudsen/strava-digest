// Smoke-test: genererer syntetiske fixtures (ingen persondata), kører hele
// pipelinen og fejler hvis nøgletallene ikke stemmer. Kør med `npm test`.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { constants as osConstants, tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { crc32, createDeflateRaw, createGzip, gzipSync } from 'node:zlib';
import { analyseRun } from '../src/analysis.ts';
import { parseActivityBuffer, pointsFromFitRecords } from '../src/activity.ts';
import { durationSec, mapColumns, num, parseDate } from '../src/columns.ts';
import { parseCsv } from '../src/csv.ts';
import { utf8Bytes } from './bytes.mjs';
import { renderMarkdown, fmtDelta, fmtDuration, fmtPace } from '../src/digest.ts';
import { renderAgent } from '../src/agent.ts';
import { cleanPath, discoverSources } from '../src/interactive.ts';
import { collectActivityFiles, isActivityFile, rowFromTrack } from '../src/loose.ts';
import {
  ACTIVITY_FILE_LIMIT_BYTES,
  activityFormatOf,
  EXPORT_FILE_LIMIT_BYTES,
  limitForFileName,
  tooLargeError,
} from '../src/limits.ts';
import { pauseMask, pauseTotals } from '../src/pauses.ts';
import { findActivitiesCsv, openSource, resolveActivityEntry } from '../src/source.ts';
import { normalizeType, parseActivities, RUN_TYPES } from '../src/strava.ts';
import { boundariesFromMaxHr, resolveZoneConfig, zoneIndex } from '../src/zones.ts';

const tmp = mkdtempSync(join(tmpdir(), 'strava-digest-test-'));
/** Rodden i repoet, så tests kan kalde CLI'en med absolut sti. */
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * Byg et syntetisk løb til agent-format-tests. Har samme facade som
 * DigestedRun, så agent.ts kan testes uden rigtige sporfiler.
 */
function mkRun(iso, name, km, movingSec, avgHr, maxHr, relativeEffort, elevGainM) {
  const date = new Date(iso);
  return {
    row: {
      id: '1',
      date,
      name,
      type: 'Løb',
      filename: `${name}.fit`,
      isRun: true,
      distanceM: km * 1000,
      movingSec,
      elapsedSec: movingSec,
      avgHr,
      maxHr,
      relativeEffort,
      gear: '',
      calories: null,
    },
    analysis: {
      movingSec,
      distanceM: km * 1000,
      elevGainM,
      avgPaceSecPerKm: movingSec / km,
      avgHr,
      maxHr,
      zones: [60, 1200, 600, 0, 0],
      zonePct: [3.2, 64.5, 32.3, 0, 0],
      zoneMaxHr: 200,
      zoneSource: 'flag',
      zoneConfigured: true,
      avgCadence: 84,
      splits: [
        { km: 1, paceSecPerKm: 330, avgHr: 150, elevDeltaM: 5, partial: false },
        { km: 2, paceSecPerKm: 328, avgHr: 155, elevDeltaM: 4, partial: false },
      ],
      hrDriftPct: 4.2,
      secondHalfPaceDeltaSec: -8,
      pauseCount: 0,
      pauseSec: 0,
      paceCvPct: 2.1,
      distanceDerived: false,
    },
  };
}
let failures = 0;
let enkeltRoot = null;
const scratchDirs = [];

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

  const activities = parseActivities(table, map).activities;
  check('antal aktiviteter', activities.length, (v) => v === 4);
  check('antal løb', activities.filter((a) => a.isRun).length, (v) => v === 3);
  check('newest first', activities[0].name, (v) => v === 'Long run');

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
  // Den observerede max-puls er et gæt, så den må aldrig slå urets egne
  // zoner — men den er bedre end ingen zoner overhovedet.
  check('observeret max bruges når intet andet findes', resolveZoneConfig(null, undefined, 199), (v) =>
    v?.source === 'export-observation' && v?.maxHr === 199,
  );
  check('observeret max taber mod urets zoner', resolveZoneConfig(null, { maxHr: 190 }, 199), (v) =>
    v?.source === 'fit' && v?.maxHr === 190,
  );
  check('flaget taber ikke mod urets zoner', resolveZoneConfig(200, { maxHr: 190 }, 199), (v) =>
    v?.source === 'flag' && v?.maxHr === 200,
  );
  check('observeret max danner standardgrænser', resolveZoneConfig(null, undefined, 199), (v) =>
    v?.boundaries.length === 4 && Math.round(v.boundaries[3]) === 179,
  );

  // Zonefordeling pr. løb via analyseRun (max-puls 210, realistisk for
  // fixturens pulsniveauer, så Z2/Z3-grænserne faktisk skærer turene;
  // ingen FIT-zonebeskeder findes i de syntetiske fixtures)
  const zcfg = resolveZoneConfig(210, undefined);
  const az = analyseRun(track, zcfg);
  check('zoneprocenter summer til 100', az.zonePct?.reduce((s, p) => s + p, 0) ?? null, (v) => v != null && Math.abs(v - 100) < 1);
  check('zoner i sekunder summer til effektiv tid', az.zones?.reduce((s, z) => s + z, 0) ?? null, (v) => v != null && v > 3000 && v < 3200);
  check('zoneSource fra flag', az.zoneSource, (v) => v === 'flag');
  check('zoneMaxHr fra flag', az.zoneMaxHr, (v) => v === 210);

  // Pause-detektion på tæt samplet spor: 600 s løb, 300 s stående, 600 s løb
  // med ét punkt pr. sekund. Den gamle regel (dt > 20 s) så ingen pause her.
  const pausePoints = [];
  for (let s = 0; s <= 600; s++) {
    pausePoints.push({ t: new Date(s * 1000), distM: s * 3, hr: 150 });
  }
  for (let s = 601; s <= 900; s++) {
    pausePoints.push({ t: new Date(s * 1000), distM: 1800, hr: 150 });
  }
  for (let s = 901; s <= 1500; s++) {
    pausePoints.push({ t: new Date(s * 1000), distM: 1800 + (s - 900) * 3, hr: 150 });
  }
  const pauseTrack = {
    points: pausePoints,
    sport: 'running',
    source: 'gpx',
    distanceDerived: false,
  };
  const pauseFlags = pauseMask(pausePoints);
  const pauseStops = pauseTotals(pausePoints);
  const pauseAz = analyseRun(pauseTrack, resolveZoneConfig(200, undefined));
  check('pause: masken dækker alle punkter', pauseFlags.length, (v) => v === pausePoints.length);
  check('pause: første punkt er ikke i pause', pauseFlags[0], (v) => v === false);
  check('pause: ét sammenhængende segment', pauseStops.count, (v) => v === 1);
  check('pause: pausetid ~300 s', pauseStops.sec, (v) => v >= 295 && v <= 305);
  check('pause: movingSec uden pausen', pauseAz.movingSec, (v) => v != null && v >= 1195 && v <= 1205);
  check(
    'pause: zonetid uden pausetid',
    pauseAz.zones?.reduce((s, z) => s + z, 0) ?? null,
    (v) => v != null && v >= 1195 && v <= 1205,
  );
  check(
    'pause: 1. km pace er ikke oppustet',
    pauseAz.splits[0]?.paceSecPerKm ?? null,
    (v) => v != null && Math.abs(v - 333) <= 5,
  );

  // Strava skriver distance i hvert andet punkt. Et manglende felt er ikke
  // bevægelse, så pausen skal stadig være ét sammenhængende segment.
  const everyOtherPoints = [];
  for (let s = 0; s <= 600; s++) {
    everyOtherPoints.push({ t: new Date(s * 1000), distM: s % 2 === 0 ? s * 3 : null, hr: 150 });
  }
  for (let s = 601; s <= 900; s++) {
    everyOtherPoints.push({ t: new Date(s * 1000), distM: s % 2 === 0 ? 1800 : null, hr: 150 });
  }
  for (let s = 901; s <= 1500; s++) {
    everyOtherPoints.push({
      t: new Date(s * 1000),
      distM: s % 2 === 0 ? 1800 + (s - 900) * 3 : null,
      hr: 150,
    });
  }
  const everyOtherAz = analyseRun(
    { points: everyOtherPoints, sport: 'running', source: 'gpx', distanceDerived: false },
    resolveZoneConfig(200, undefined),
  );
  const everyOtherStops = pauseTotals(everyOtherPoints);
  check('pause: distance hvert andet punkt giver ét segment', everyOtherStops.count, (v) => v === 1);
  check('pause: distance hvert andet punkt pausetid ~300 s', everyOtherStops.sec, (v) => v >= 295 && v <= 305);
  check(
    'pause: distance hvert andet punkt movingSec ~1200 s',
    everyOtherAz.movingSec,
    (v) => v != null && v >= 1195 && v <= 1205,
  );

  // Et langt null-hul midt i et løb er ingen pause, når der faktisk blev
  // løbet i hullet: 30 null-punkter ved 3 m/s er 90 m fremdrift.
  const runNullGapPoints = [];
  for (let s = 0; s <= 200; s++) {
    runNullGapPoints.push({
      t: new Date(s * 1000),
      distM: s >= 100 && s <= 129 ? null : s * 3,
      hr: 150,
    });
  }
  const runNullGapStops = pauseTotals(runNullGapPoints);
  check('pause: 30 s null-hul midt i løb er ikke pause', runNullGapStops.count, (v) => v === 0);
  check('pause: 30 s null-hul midt i løb giver nul pausetid', runNullGapStops.sec, (v) => v === 0);

  // Et null-hul inde i en pause må ikke dele segmentet. Stående fra 60..120,
  // null fra 90..100, med løb før og efter.
  const pauseNullGapPoints = [];
  for (let s = 0; s <= 59; s++) {
    pauseNullGapPoints.push({ t: new Date(s * 1000), distM: s * 3, hr: 150 });
  }
  for (let s = 60; s <= 120; s++) {
    pauseNullGapPoints.push({
      t: new Date(s * 1000),
      distM: s >= 90 && s <= 100 ? null : 180,
      hr: 150,
    });
  }
  for (let s = 121; s <= 180; s++) {
    pauseNullGapPoints.push({ t: new Date(s * 1000), distM: 180 + (s - 120) * 3, hr: 150 });
  }
  const pauseNullGapStops = pauseTotals(pauseNullGapPoints);
  check('pause: null-hul midt i pause giver ét segment', pauseNullGapStops.count, (v) => v === 1);
  check('pause: null-hul midt i pause beholder varigheden', pauseNullGapStops.sec, (v) => v === 60);

  // Et enkelt null midt i en pause må ikke bryde segmentet: den nuværende
  // adfærd gav 2 segmenter og 58 s i stedet for 1 og 60 s.
  const singleNullPoints = [];
  for (let s = 0; s <= 30; s++) singleNullPoints.push({ t: new Date(s * 1000), distM: 0, hr: 150 });
  singleNullPoints.push({ t: new Date(31_000), distM: null, hr: 150 });
  for (let s = 32; s <= 60; s++) singleNullPoints.push({ t: new Date(s * 1000), distM: 0, hr: 150 });
  const singleNullStops = pauseTotals(singleNullPoints);
  check('pause: enkelt null i pause bryder ikke segmentet', singleNullStops.count, (v) => v === 1);
  check('pause: enkelt null i pause tæller hele varigheden', singleNullStops.sec, (v) => v === 60);

  // En enhed kan skrive samme sekund to gange. Dubletten er et neutralt step:
  // den må hverken dele pausen eller lægge tid til.
  const duplicatePoints = [];
  for (let s = 0; s <= 30; s++) duplicatePoints.push({ t: new Date(s * 1000), distM: 0, hr: 150 });
  duplicatePoints.push({ t: new Date(30_000), distM: 0, hr: 150 });
  for (let s = 31; s <= 60; s++) duplicatePoints.push({ t: new Date(s * 1000), distM: 0, hr: 150 });
  const duplicateStops = pauseTotals(duplicatePoints);
  check('pause: dublet-tidsstempel bryder ikke segmentet', duplicateStops.count, (v) => v === 1);
  check('pause: dublet-tidsstempel ændrer ikke varigheden', duplicateStops.sec, (v) => v === 60);

  const duplicatePausePoints = [];
  for (let s = 0; s <= 600; s++) {
    duplicatePausePoints.push({ t: new Date(s * 1000), distM: s * 3, hr: 150 });
  }
  for (let s = 601; s <= 900; s++) {
    duplicatePausePoints.push({ t: new Date(s * 1000), distM: 1800, hr: 150 });
    if (s === 750) duplicatePausePoints.push({ t: new Date(750_000), distM: 1800, hr: 150 });
  }
  for (let s = 901; s <= 1500; s++) {
    duplicatePausePoints.push({ t: new Date(s * 1000), distM: 1800 + (s - 900) * 3, hr: 150 });
  }
  const duplicatePauseAz = analyseRun({
    points: duplicatePausePoints,
    sport: 'running',
    source: 'gpx',
    distanceDerived: false,
  });
  check('pause: dublet i pause crasher ikke analysen', duplicatePauseAz.pauseCount, (v) => v === 1);
  check(
    'pause: dublet i pause ændrer ikke movingSec',
    duplicatePauseAz.movingSec,
    (v) => v != null && v >= 1195 && v <= 1205,
  );

  // Sparsomt hul uden fremdrift: den gamle regel tæller det fortsat.
  const sparsePoints = [
    { t: new Date(0), distM: 0, hr: 150 },
    { t: new Date(25_000), distM: 0, hr: 150 },
  ];
  const sparseStops = pauseTotals(sparsePoints);
  check('pause: sparsomt spor uden fremdrift tælles', sparseStops.count, (v) => v === 1);
  check('pause: sparsomt spor beholder varigheden', sparseStops.sec, (v) => v === 25);

  // Sparsomt hul med fremdrift: union-reglen kræver både dd < 8 m og en lav
  // rate, så 11 m over 30 s er ikke en pause.
  const sparseMovingStops = pauseTotals([
    { t: new Date(0), distM: 0, hr: 150 },
    { t: new Date(30_000), distM: 11, hr: 150 },
  ]);
  check('pause: sparsomt hul med fremdrift er ikke pause', sparseMovingStops.count, (v) => v === 0);

  // Et optagelseshul skal isoleres fra naboer, der selv er lange nok til at
  // tælle. 25 s stop + 100 s hul + 25 s stop = 3 segmenter og 150 s.
  const isolatedGapPoints = [];
  for (let s = 0; s <= 25; s++) isolatedGapPoints.push({ t: new Date(s * 1000), distM: 0, hr: 150 });
  isolatedGapPoints.push({ t: new Date(125_000), distM: 0, hr: 150 });
  for (let s = 126; s <= 150; s++) isolatedGapPoints.push({ t: new Date(s * 1000), distM: 0, hr: 150 });
  const isolatedGapStops = pauseTotals(isolatedGapPoints);
  check('pause: hul isoleres fra naboer på begge sider', isolatedGapStops.count, (v) => v === 3);
  check('pause: isoleret hul beholder samlet varighed', isolatedGapStops.sec, (v) => v === 150);

  const movingGapStops = pauseTotals([
    { t: new Date(0), distM: 0, hr: 150 },
    { t: new Date(120_000), distM: 20, hr: 150 },
  ]);
  check('pause: hul med fremdrift tælles ikke som pause', movingGapStops.count, (v) => v === 0);

  // Intet distance i sporet: ingen gættede pauser og ingen crash.
  const noDistPoints = Array.from({ length: 61 }, (_, s) => ({ t: new Date(s * 1000), hr: 150 }));
  const noDistStops = pauseTotals(noDistPoints);
  check('pause: uden distance er masken tom', pauseMask(noDistPoints).some((v) => v), (v) => v === false);
  check('pause: uden distance er der ingen pauser', noDistStops.count, (v) => v === 0);
  check('pause: uden distance er pausetiden nul', noDistStops.sec, (v) => v === 0);

  // Negativ kontrol: jævnt 1 Hz-spor uden pause.
  const smoothPoints = Array.from({ length: 601 }, (_, s) => ({
    t: new Date(s * 1000),
    distM: s * 3,
    hr: 150,
  }));
  const smoothStops = pauseTotals(smoothPoints);
  check('pause: jævnt spor giver ingen pauser', smoothStops.count, (v) => v === 0);
  check('pause: jævnt spor giver nul pausetid', smoothStops.sec, (v) => v === 0);

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
  check('digest uden max-puls: note om manglende zoner', md.includes('- _note: no zone split (no max HR — set --max-hr)_'), (v) => v === true);
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
  check('digest viser zoner pr. løb', mdZones.includes('- **Zones:** Z1 '), (v) => v === true);
  check('digest viser zonekilde', mdZones.includes('(max HR 210, from --max-hr)'), (v) => v === true);
  check('baseline summer zoner i vinduet', mdZones.includes('- zones: Z1 ') && mdZones.includes('easy (Z1–Z2)'), (v) => v === true);
  check('zonedigest fortsat under 4 KB', Buffer.byteLength(mdZones, 'utf8'), (v) => v < 4096);

  await source.close();

  // CLI-vejen på samme mappe. Standardformatet er agent-formatet.
  const cli = execFileSync('node', ['src/cli.ts', tmp, '--last', '2'], { encoding: 'utf8' });
  check('CLI skriver agent-digest', cli.includes('# STRAVA DIGEST v2 (agent-format)'), (v) => v === true);
  check('CLI har SCHEMA-sektion', cli.includes('## SCHEMA'), (v) => v === true);
  check('CLI viser HR-drift som felt', /drift=-?\d/.test(cli), (v) => v === true);
  check('CLI uden max-puls: zonefelt er tomt', cli, (v) => /(?:^|\s)z=-(?:\s|$)/m.test(v));
  check('CLI-agent har én linje pr. løb', (cli.match(/^d=\d{4}-/gm) ?? []).length, (v) => v === 2);
  check('CLI --last 2: WINDOW tæller alle 3 løb', cli, (v) => /^recent: n=3 /m.test(v));
  check('CLI --last 2: STATS tæller alle 3 løb', cli, (v) =>
    /^runs=3 km_total=24\.0 median_km=8\.00 without_analysis=0$/m.test(v),
  );
  check('CLI --last 2: NOTES siger talt mod vist', cli, (v) =>
    /^- 3 runs are counted in WEEKS, WINDOW and STATS; 2 runs are shown \(--last\)\.$/m.test(v),
  );

  // Markdown-formatet er stadig tilgængeligt med --format md
  const cliMd = execFileSync('node', ['src/cli.ts', tmp, '--last', '2', '--max-hr', '240', '--format', 'md'], { encoding: 'utf8' });
  check('--format md giver menneske-Markdown', cliMd.includes('# Training digest'), (v) => v === true);
  check('--format md viser Zoner-linje', cliMd.includes('- **Zones:** Z1 '), (v) => v === true);
  check('--format md viser baseline-roligt', cliMd.includes('easy (Z1–Z2)'), (v) => v === true);

  // issue #21 punkt 1: --format må kun acceptere de to kendte værdier.
  let badFormatErr = null;
  try {
    execFileSync('node', ['src/cli.ts', tmp, '--format', 'json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    badFormatErr = err;
  }
  check('--format json fejler', badFormatErr !== null, (v) => v === true);
  check('--format json bruger exit-kode 1', badFormatErr?.status ?? null, (v) => v === 1);
  check('--format json nævner md, standardformatet og --json', String(badFormatErr?.stderr ?? ''), (v) =>
    v.includes('md') && v.includes('default') && v.includes('--json'),
  );

  // issue #21 repair: --flag=value must mean the same as --flag value, and an
  // unknown flag or a value flag without a value must fail loudly.
  const cliFailure = (args) => {
    try {
      execFileSync('node', ['src/cli.ts', ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return null;
    } catch (err) {
      return err;
    }
  };
  const badFormatEqualsErr = cliFailure([tmp, '--format=json']);
  check('--format=json fejler som --format json', {
    status: badFormatEqualsErr?.status ?? null,
    message: String(badFormatEqualsErr?.stderr ?? ''),
  }, (v) => v.status === 1 && v.message === String(badFormatErr?.stderr ?? ''));
  const cliMdEquals = execFileSync('node', ['src/cli.ts', tmp, '--last', '2', '--format=md'], {
    encoding: 'utf8',
  });
  check('--format=md giver menneske-Markdown', cliMdEquals.includes('# Training digest'), (v) => v === true);
  for (const [flag, args, needle] of [
    ['--al', [tmp, '--al'], '--al'],
    ['--jason', [tmp, '--jason'], '--jason'],
    ['--out=', [tmp, '--out='], '--out'],
    ['--format uden værdi', [tmp, '--format'], '--format'],
  ]) {
    const err = cliFailure(args);
    check(`${flag} afvises med flag-navnet`, {
      status: err?.status ?? null,
      stderr: String(err?.stderr ?? ''),
    }, (v) => v.status === 1 && v.stderr.includes(needle));
  }

  // issue #21 repair 2: `--flag=value` and `--flag value` must validate the
  // value identically, not only accept the same good values.
  const valueFlags = ['--last', '--detail', '--out', '--context', '--days', '--max-hr', '--format'];
  for (const flag of valueFlags) {
    for (const [label, bad] of [['starter med --', '--'], ['tom', '']]) {
      const equals = cliFailure([tmp, `${flag}=${bad}`]);
      const space = cliFailure([tmp, flag, bad]);
      check(`${flag}= <${label}> og ${flag} <${label}> giver samme svar`, {
        equals: { status: equals?.status ?? null, stderr: String(equals?.stderr ?? '') },
        space: { status: space?.status ?? null, stderr: String(space?.stderr ?? '') },
      }, (v) =>
        v.equals.status === v.space.status &&
        v.equals.stderr === v.space.stderr &&
        v.equals.status === 1 &&
        v.equals.stderr.includes(flag)
      );
    }
  }

  const cliAgent = execFileSync('node', ['src/cli.ts', tmp, '--last', '2', '--format', 'agent'], { encoding: 'utf8' });
  check('--format agent giver agent-format', cliAgent.includes('# STRAVA DIGEST v2 (agent-format)'), (v) => v === true);

  const cliJson = JSON.parse(
    execFileSync('node', ['src/cli.ts', tmp, '--last', '2', '--max-hr', '240', '--json'], { encoding: 'utf8' }),
  );
  check('--max-hr giver zoneSource flag', cliJson.runs[0]?.analysis?.zoneSource ?? null, (v) => v === 'flag');
  check('--max-hr sætter zoneMaxHr', cliJson.runs[0]?.analysis?.zoneMaxHr ?? null, (v) => v === 240);
  check('zoneprocenter i JSON summer til 100', cliJson.runs[0]?.analysis?.zonePct?.reduce((s, p) => s + p, 0) ?? null, (v) => v != null && Math.abs(v - 100) < 1);

  const cliZones = execFileSync('node', ['src/cli.ts', tmp, '--last', '2', '--max-hr', '240'], { encoding: 'utf8' });
  check('CLI-agent viser zonefordeling', /z=\d/.test(cliZones), (v) => v === true);
  check('CLI-agent markerer zonekilden', cliZones, (v) => /^max_hr=240 source=flag$/m.test(v));

  // Uden --max-hr bruger værktøjet den højeste puls i eksporten som
  // zone-grundlag. Før stod headeren "max_hr=199 source=export-observation"
  // mens turene havde z=- og load=-, altså en header der løj. Nu skal de
  // to være enige.
  const cliNoHr = execFileSync('node', ['src/cli.ts', tmp], { encoding: 'utf8' });
  const noHrHeader = cliNoHr.match(/^max_hr=(\d+) source=([\w-]+)$/m);
  check('uden --max-hr er der en max-puls i headeren', noHrHeader?.[1], (v) => v !== undefined);
  check('uden --max-hr er kilden export-observation', noHrHeader?.[2], (v) => v === 'export-observation');
  check('uden --max-hr har turene stadig zoner', cliNoHr, (v) =>
    /^d=.*\sz=[0-9.]+,[0-9.]+,[0-9.]+,[0-9.]+,[0-9.]+/m.test(v),
  );
  check('uden --max-hr har turene en load', cliNoHr, (v) => /^d=.*\sload=\d+/m.test(v));
  check('CLI uden --last: WINDOW tæller alle 3 løb', cliNoHr, (v) => /recent: n=3 /.test(v));
  check('CLI uden --last: ingen talt/vist-note', cliNoHr, (v) => !v.includes('shown (--last)'));

  // Agenten laeser SCHEMA og SIGNALS og fortolker derfra. Hvis de ikke
  // siger, at "max" kan vaere det observerede gaet, vaesker agenten
  // zonerne som om de la paa brugerens rigtige max-puls. Det er præcis
  // den fejltolkning, der gør træningen se lettere ud end den er.
  check('SIGNALS forklarer at max kan vaere et gaet', cliNoHr, (v) =>
    v.includes('export-observation') && v.includes('not the user') && v.includes('spike'),
  );

  /* ---- regression (issue #14): rækker uden filnavn eller dato ---- */

  // En aktivitet uden fil har stadig distance og tid i CSV'en. Den skal ikke
  // forsvinde lydløst. En række med en dato, parseDate ikke kan læse, kan
  // ikke placeres i digesten og skal tælles.
  const scratch = (name) => {
    const dir = mkdtempSync(join(tmpdir(), `strava-digest-${name}-`));
    scratchDirs.push(dir);
    return dir;
  };
  const csvHeader =
    'Activity ID,Activity Date,Activity Name,Activity Type,Elapsed Time,Moving Time,Distance,Max Heart Rate,Average Heart Rate,Filename';
  const writeExport = (name, rows) => {
    const dir = scratch(name);
    writeFileSync(join(dir, 'activities.csv'), [csvHeader, ...rows].join('\n') + '\n');
    return dir;
  };
  const copyGoodGpx = (dir) =>
    copyFileSync(join(tmp, 'activities', 'Run-1001.gpx'), join(dir, 'Good.gpx'));

  const gapsDir = writeExport('gaps', [
    '1,"Oct 12, 2026, 6:32:10 AM",Manual,Løb,1800,1800,5.0,170,150,',
    '2,not-a-date,Bad date,Løb,1800,1800,5.0,170,150,Bad.gpx',
    '3,not-a-date,Both missing,Løb,1800,1800,5.0,170,150,',
    '4,"Oct 11, 2026, 6:32:10 AM",Good,Løb,1800,1800,5.0,170,150,Good.gpx',
  ]);
  copyGoodGpx(gapsDir);

  const gapsTable = parseCsv(readFileSync(join(gapsDir, 'activities.csv'), 'utf8'));
  const gapsMap = mapColumns(gapsTable);
  const gapsParsed = parseActivities(gapsTable, gapsMap);
  const gapsRows = gapsParsed.activities;
  check('dropped rows: row without filename is kept', gapsRows.length, (v) => v === 2);
  check('dropped rows: row without filename has empty filename', gapsRows.find((r) => r.name === 'Manual')?.filename ?? null, (v) => v === '');
  check('dropped rows: row with unparsable date is dropped', gapsRows.some((r) => r.name === 'Bad date'), (v) => v === false);
  check('dropped rows: stats counts every CSV row', gapsParsed.stats.rowsInExport, (v) => v === 4);
  check('dropped rows: stats counts skipped rows', gapsParsed.stats.skippedNoDate, (v) => v === 2);
  check('dropped rows: stats counts skipped rows without a file', gapsParsed.stats.skippedNoDateNoFilename, (v) => v === 1);

  const gapsAgent = execFileSync('node', ['src/cli.ts', gapsDir], { encoding: 'utf8' });
  check('dropped rows: skipped note names a missing or unparsable date', gapsAgent, (v) =>
    /^- 2 rows were skipped because of a missing or unparsable date and are not in the digest \(1 of them was also without a file name\)\.$/m.test(v),
  );
  check('dropped rows: included note is independent of the skipped note', gapsAgent, (v) =>
    /^- 1 row has no file name, so it has no track analysis; its distance and time come from the CSV\.$/m.test(v),
  );
  check('dropped rows: activities_in_export counts every CSV row', gapsAgent, (v) => /^activities_in_export=4$/m.test(v));
  check('dropped rows: runs_in_export counts the manual run', gapsAgent, (v) => /^runs_in_export=2$/m.test(v));
  const manualLine = gapsAgent.split('\n').find((line) => line.startsWith('d=') && line.includes('n="Manual"')) ?? '';
  check('dropped rows: manual run keeps CSV values and leaves track fields missing', manualLine, (v) =>
    /^d=\S+ n="Manual" km=5\.00 t=1800 pace=360\.0 hr=150\/170 z=- elev=- drift=- half=- cv=- pause=- load=- err="no activity file in the export"$/m.test(v),
  );
  check('dropped rows: manual run is counted in STATS and marked unanalysed', gapsAgent, (v) =>
    /^runs=2 km_total=10\.0 median_km=5\.00 without_analysis=1$/m.test(v),
  );
  check('dropped rows: WINDOW marks the run without analysis', gapsAgent, (v) =>
    /^recent: .* without_analysis=1$/m.test(v),
  );
  check('dropped rows: clean export has no coverage notes', cliNoHr, (v) =>
    !v.includes('skipped because of a missing or unparsable date') &&
    !v.includes('included from the CSV without track analysis'),
  );

  // s4-lignende: en ikke-løb uden fil og en undateret række. Uden --all er
  // ikke-løbet ikke i digesten, så kun drop-noten må skrives. Med --all er
  // begge noter sande og skal skrives hver for sig.
  const nonRunDir = writeExport('nonrun', [
    '1,"Oct 12, 2026, 6:32:10 AM",Gym,Weight Training,1800,1800,0,120,110,',
    '2,not-a-date,Bad date,Løb,1800,1800,5.0,170,150,Bad.gpx',
    '3,"Oct 11, 2026, 6:32:10 AM",Good,Løb,1800,1800,5.0,170,150,Good.gpx',
  ]);
  copyGoodGpx(nonRunDir);

  const nonRunAgent = execFileSync('node', ['src/cli.ts', nonRunDir], { encoding: 'utf8' });
  check('s4 without --all: skipped note only', nonRunAgent, (v) =>
    /^- 1 row was skipped because of a missing or unparsable date and is not in the digest\.$/m.test(v),
  );
  check('s4 without --all: no included note for a filtered-out non-run', nonRunAgent, (v) =>
    !v.includes('included from the CSV without track analysis'),
  );
  check('s4 without --all: non-run without file is not in RUNS', nonRunAgent, (v) =>
    !v.includes('n="Gym"'),
  );
  check('s4 without --all: runs_in_export excludes the non-run', nonRunAgent, (v) =>
    /^runs_in_export=1$/m.test(v),
  );

  const nonRunAll = execFileSync('node', ['src/cli.ts', nonRunDir, '--all'], { encoding: 'utf8' });
  check('s4 with --all: skipped note', nonRunAll, (v) =>
    /^- 1 row was skipped because of a missing or unparsable date and is not in the digest\.$/m.test(v),
  );
  check('s4 with --all: included note is separate', nonRunAll, (v) =>
    /^- 1 row has no file name, so it has no track analysis; its distance and time come from the CSV\.$/m.test(v),
  );
  check('s4 with --all: no-file non-run line is exact', nonRunAll, (v) =>
    /^d=\S+ n="Gym" km=0\.00 t=1800 pace=- hr=110\/120 z=- elev=- drift=- half=- cv=- pause=- load=- err="no activity file in the export"$/m.test(v),
  );
  check('s4 with --all: runs_in_export counts the non-run', nonRunAll, (v) =>
    /^runs_in_export=2$/m.test(v),
  );

  // s2-lignende: no-file-ikke-løb + løb med fil, ingen undaterede rækker.
  // Uden --all er der intet at rapportere. Med --all skal included-noten
  // skrives uden en drop-note ved siden af.
  const s2Dir = writeExport('s2', [
    '1,"Oct 12, 2026, 6:32:10 AM",Gym,Weight Training,1800,1800,0,120,110,',
    '2,"Oct 11, 2026, 6:32:10 AM",Good,Løb,1800,1800,5.0,170,150,Good.gpx',
  ]);
  copyGoodGpx(s2Dir);

  const s2Agent = execFileSync('node', ['src/cli.ts', s2Dir], { encoding: 'utf8' });
  check('s2 without --all: no coverage notes', s2Agent, (v) =>
    !v.includes('skipped because of a missing or unparsable date') &&
    !v.includes('included from the CSV without track analysis'),
  );
  check('s2 without --all: non-run without file is not in RUNS', s2Agent, (v) =>
    !v.includes('n="Gym"'),
  );

  const s2All = execFileSync('node', ['src/cli.ts', s2Dir, '--all'], { encoding: 'utf8' });
  check('s2 with --all: included note without a drop note', s2All, (v) =>
    /^- 1 row has no file name, so it has no track analysis; its distance and time come from the CSV\.$/m.test(v),
  );
  // Anchor guard: the note must be the full sentence, not just the prefix.
  // Removing the trailing `$` from this assertion makes it match the full
  // line above, so the M3 mutation ("remove the `$` anchors") fails here.
  check('s2 with --all: included note is not a bare prefix', s2All, (v) =>
    !/^- 1 row has no file name, so it has no track analysis$/m.test(v),
  );
  check('s2 with --all: no skipped note', s2All, (v) =>
    !v.includes('skipped because of a missing or unparsable date'),
  );
  check('s2 with --all: runs_in_export counts the non-run', s2All, (v) =>
    /^runs_in_export=2$/m.test(v),
  );

  // s5-lignende: kun rækker uden fil. Included-noten skal skrives både med
  // og uden --all, og der er ingen drop-note at hænge den på.
  const s5Dir = writeExport('s5', [
    '1,"Oct 12, 2026, 6:32:10 AM",No file A,Løb,1800,1800,5.0,170,150,',
    '2,"Oct 11, 2026, 6:32:10 AM",No file B,Løb,1800,1800,5.0,170,150,',
  ]);

  const s5Agent = execFileSync('node', ['src/cli.ts', s5Dir], { encoding: 'utf8' });
  const s5All = execFileSync('node', ['src/cli.ts', s5Dir, '--all'], { encoding: 'utf8' });
  for (const [label, output] of [['without --all', s5Agent], ['with --all', s5All]]) {
    check(`s5 ${label}: included note without a drop note`, output, (v) =>
      /^- 2 rows have no file name, so they have no track analysis; their distance and time come from the CSV\.$/m.test(v),
    );
    check(`s5 ${label}: no skipped note`, output, (v) =>
      !v.includes('skipped because of a missing or unparsable date'),
    );
  }

  // Ingen undaterede rækker, men et løb uden fil: drop-noten skal udelades,
  // included-noten skal stadig skrives.
  const noDropDir = writeExport('nodrop', [
    '1,"Oct 12, 2026, 6:32:10 AM",No file,Løb,1800,1800,5.0,170,150,',
    '2,"Oct 11, 2026, 6:32:10 AM",Good,Løb,1800,1800,5.0,170,150,Good.gpx',
  ]);
  copyGoodGpx(noDropDir);

  const noDropAgent = execFileSync('node', ['src/cli.ts', noDropDir], { encoding: 'utf8' });
  check('no drops: no skipped note', noDropAgent, (v) =>
    !v.includes('skipped because of a missing or unparsable date'),
  );
  check('no drops: included note is still written', noDropAgent, (v) =>
    /^- 1 row has no file name, so it has no track analysis; its distance and time come from the CSV\.$/m.test(v),
  );
  check('no drops: no-file run keeps CSV values in the digest', noDropAgent, (v) =>
    /^d=\S+ n="No file" km=5\.00 t=1800 pace=360\.0 hr=150\/170 z=- elev=- drift=- half=- cv=- pause=- load=- err="no activity file in the export"$/m.test(v),
  );

  // Krav 1: Markdown-baseline skal regne pace på samme rækker som agent-
  // formatet: distance > 0 og en tid. En række uden distance må stadig
  // tælle i km/t-totalerne, men ikke i pace-brøken.
  const paceDir = writeExport('pace', [
    '1,"Oct 12, 2026, 6:32:10 AM",No distance,Løb,1800,1800,0,170,150,',
    '2,"Oct 11, 2026, 6:32:10 AM",Good,Løb,1800,1800,5.0,170,150,Good.gpx',
  ]);
  copyGoodGpx(paceDir);

  const paceAgent = execFileSync('node', ['src/cli.ts', paceDir], { encoding: 'utf8' });
  check('agent WINDOW: time still counts rows without distance', paceAgent, (v) =>
    /^recent: n=2 km=5\.0 t=3600 pace=360\.0 hr=150 .* without_analysis=1$/m.test(v),
  );
  const paceMd = execFileSync('node', ['src/cli.ts', paceDir, '--format', 'md'], { encoding: 'utf8' });
  check('windowStats: Markdown baseline pace ignores rows without distance', paceMd, (v) =>
    /^- average: 6:00\/km · heart rate 150$/m.test(v),
  );
  const paceJson = JSON.parse(
    execFileSync('node', ['src/cli.ts', paceDir, '--json'], { encoding: 'utf8' }),
  );
  check('windowStats: JSON markdown baseline pace ignores rows without distance', paceJson.markdown, (v) =>
    /^- average: 6:00\/km · heart rate 150$/m.test(v),
  );
  check('Markdown-baseline viser hvor mange løb zonerne dækker', paceMd, (v) =>
    /^- zones: .*\(from 1 of 2 runs\)$/m.test(v),
  );

  // Noten om rækker uden filnavn beskriver rækkerne, ikke hvor i outputtet
  // de står. Derfor skal den være identisk i alle formater og sand under
  // --last, også når rækken ligger uden for de viste løb.
  const outsideLastDir = writeExport('outside-last', [
    '1,"Oct 12, 2026, 6:32:10 AM",Newest,Løb,1800,1800,5.0,170,150,Good.gpx',
    '2,"Oct 11, 2026, 6:32:10 AM",Second,Løb,1800,1800,5.0,170,150,Good.gpx',
    '3,"Oct 10, 2026, 6:32:10 AM",Older no file,Løb,1800,1800,5.0,170,150,',
  ]);
  copyGoodGpx(outsideLastDir);
  const outsideNote =
    '1 row has no file name, so it has no track analysis; its distance and time come from the CSV.';
  const outsideAgent = execFileSync('node', ['src/cli.ts', outsideLastDir, '--last', '2'], {
    encoding: 'utf8',
  });
  const outsideMd = execFileSync(
    'node',
    ['src/cli.ts', outsideLastDir, '--last', '2', '--format', 'md'],
    { encoding: 'utf8' },
  );
  const outsideJson = JSON.parse(
    execFileSync('node', ['src/cli.ts', outsideLastDir, '--last', '2', '--json'], {
      encoding: 'utf8',
    }),
  );
  check('--last: agent-noten beskriver no-file-rækken', outsideAgent, (v) =>
    v.includes(`- ${outsideNote}`),
  );
  check('--last: Markdown-noten er identisk og sand', outsideMd, (v) =>
    v.includes(`- ${outsideNote}`),
  );
  check('--last: JSON notes er identisk', outsideJson.notes, (v) => v.includes(outsideNote));
  check('--last: JSON hostNote er identisk', outsideJson.hostNote, (v) => v.includes(outsideNote));
  check('--last: JSON markdown er identisk', outsideJson.markdown, (v) =>
    v.includes(`- ${outsideNote}`),
  );
  check('--last: no-file-rækken er ikke blandt de viste løb', outsideAgent, (v) =>
    !v.includes('n="Older no file"'),
  );

  // Krav 2: den observerede max-puls er den højeste i hele eksporten. Rækker
  // uden fil tæller med, og det gør undaterede rækker også.
  const maxHrDir = writeExport('maxhr', [
    '1,"Oct 12, 2026, 6:32:10 AM",No file,Løb,1800,1800,5.0,190,150,',
    '2,"Oct 11, 2026, 6:32:10 AM",Good,Løb,1800,1800,5.0,174,150,Good.gpx',
  ]);
  copyGoodGpx(maxHrDir);

  const maxHrAgent = execFileSync('node', ['src/cli.ts', maxHrDir], { encoding: 'utf8' });
  check('max HR: observed max includes no-file rows', maxHrAgent, (v) =>
    /^max_hr=190 source=export-observation$/m.test(v),
  );

  const undatedMaxHrDir = writeExport('maxhr-undated', [
    '1,"Oct 11, 2026, 6:32:10 AM",Good,Løb,1800,1800,5.0,174,150,Good.gpx',
    '2,not-a-date,Undated,Løb,1800,1800,5.0,200,150,Bad.gpx',
  ]);
  copyGoodGpx(undatedMaxHrDir);
  const undatedMaxHrTable = parseCsv(readFileSync(join(undatedMaxHrDir, 'activities.csv'), 'utf8'));
  const undatedMaxHrStats = parseActivities(undatedMaxHrTable, mapColumns(undatedMaxHrTable)).stats;
  check('max HR: skipped rows expose their max HR', undatedMaxHrStats.maxHrOfSkipped, (v) => v === 200);

  const undatedMaxHrAgent = execFileSync('node', ['src/cli.ts', undatedMaxHrDir], { encoding: 'utf8' });
  check('max HR: observed max includes undated rows', undatedMaxHrAgent, (v) =>
    /^max_hr=200 source=export-observation$/m.test(v),
  );

  // Et rigtigt nul i Max Heart Rate er ikke en observation. Uden denne guard
  // ville maxHrOfSkipped blive 0, og forskellen mellem "ingen puls" og "puls
  // 0" ville forsvinde i statistikken.
  const zeroMaxHrDir = writeExport('maxhr-zero', [
    '1,"Oct 11, 2026, 6:32:10 AM",Good,Løb,1800,1800,5.0,174,150,Good.gpx',
    '2,not-a-date,Zero HR,Løb,1800,1800,5.0,0,150,Bad.gpx',
  ]);
  copyGoodGpx(zeroMaxHrDir);
  const zeroMaxHrTable = parseCsv(readFileSync(join(zeroMaxHrDir, 'activities.csv'), 'utf8'));
  const zeroMaxHrStats = parseActivities(zeroMaxHrTable, mapColumns(zeroMaxHrTable)).stats;
  check('max HR: undated row with maxHr 0 gives null, not 0', zeroMaxHrStats.maxHrOfSkipped, (v) => v === null);
  const zeroMaxHrAgent = execFileSync('node', ['src/cli.ts', zeroMaxHrDir], { encoding: 'utf8' });
  check('max HR: a zero maxHr on a skipped row cannot become the observed max', zeroMaxHrAgent, (v) =>
    /^max_hr=174 source=export-observation$/m.test(v),
  );
  check('max HR: note says the highest Max Heart Rate value in the CSV', undatedMaxHrAgent, (v) =>
    /^- max_hr=200 is the highest Max Heart Rate value in the activities CSV \(observed\), not your watch's own max HR; heart-rate samples in the track files are not scanned\. Strava's bulk export does not contain the watch's zone configuration, so the zone boundaries are a best guess\.$/m.test(v),
  );

  const gapsList = execFileSync('node', ['src/cli.ts', gapsDir, '--list'], { encoding: 'utf8' });
  check('dropped rows: --list total is the CSV row count', gapsList, (v) =>
    /^4 activities in total \(shown: 2\)$/m.test(v),
  );
  check('dropped rows: --list shows the manual activity without a file', gapsList, (v) =>
    /\(no file\)/.test(v),
  );
  check('dropped rows: --list names the skipped rows', gapsList, (v) =>
    /^Skipped: 2 rows with a missing or unparsable date\.$/m.test(v),
  );

  const gapsMd = execFileSync('node', ['src/cli.ts', gapsDir, '--format', 'md'], { encoding: 'utf8' });
  check('dropped rows: Markdown total is the CSV row count', gapsMd, (v) =>
    /^Source: .*· 4 activities in export · 2 runs in digest$/m.test(v),
  );
  check('dropped rows: Markdown shows both notes', gapsMd, (v) =>
    /^- 2 rows were skipped because of a missing or unparsable date and are not in the digest \(1 of them was also without a file name\)\. 1 row has no file name, so it has no track analysis; its distance and time come from the CSV\.$/m.test(v),
  );
  check('dropped rows: Markdown marks the manual run as unanalysed', gapsMd, (v) =>
    /^- _per-run details unavailable: no activity file in the export_$/m.test(v),
  );

  // Relative Effort og udstyr kommer fra CSV'en, ikke fra sporet. De skal
  // derfor vises på en no-file-række, hvor analysen mangler.
  const metadataDir = scratch('metadata');
  writeFileSync(
    join(metadataDir, 'activities.csv'),
    [
      'Activity ID,Activity Date,Activity Name,Activity Type,Elapsed Time,Moving Time,Distance,Max Heart Rate,Average Heart Rate,Relative Effort,Activity Gear,Filename',
      '1,"Oct 12, 2026, 6:32:10 AM",Manual,Løb,1800,1800,5.0,170,150,42,Nike Pegasus,',
    ].join('\n') + '\n',
  );
  const metadataMd = execFileSync('node', ['src/cli.ts', metadataDir, '--format', 'md'], {
    encoding: 'utf8',
  });
  check('Markdown viser RE og gear for no-file-rækker', metadataMd, (v) =>
    /^- \*\*Metadata:\*\* RE 42 · Nike Pegasus$/m.test(v),
  );

  // Agent-formatet skal ikke dumpe Stravas kolonnenavne i modellens kontekst.
  // Det er diagnostik, ikke træningsdata — tallet og en henvisning er nok.
  // Derfor laves der en eksport med en ekstra, ukendt kolonne.
  const extraCsv = join(tmp, 'activities.csv');
  const extraDir = join(tmp, '..', `strava-extra-${Date.now()}`);
  mkdirSync(extraDir, { recursive: true });
  const srcCsv = readFileSync(extraCsv, 'utf8');
  const lines = srcCsv.split('\n');
  const header = lines[0] ?? '';
  const withExtra = [
    header + ',Vindhastighed',
    ...lines.slice(1).filter(Boolean).map((l) => l + ',12,3'),
  ].join('\n');
  writeFileSync(join(extraDir, 'activities.csv'), withExtra);
  const extraAgent = execFileSync('node', ['src/cli.ts', extraDir], { encoding: 'utf8' });
  const extraMd = execFileSync('node', ['src/cli.ts', extraDir, '--format', 'md'], { encoding: 'utf8' });

  check('agent-formatet tæller uventede kolonner i stedet for at liste dem', extraAgent, (v) =>
    /\d+ Strava columns in the export are not used/.test(v) &&
    !/Unmapped columns:/.test(v) &&
    !v.includes('Vindhastighed'),
  );
  check('markdown-formatet beholder listen', extraMd, (v) =>
    /Unmapped columns \(\d+\)/.test(v) && v.includes('Vindhastighed'),
  );

  // Det er dist/ der publiceres til npm, ikke kilden. Node kan ikke
  // straekke TypeScript under node_modules, saa bygningen er ikke
  // valgfri - den skal og den skal give samme svar som kilden.
  const distCli = join(repoRoot, 'dist', 'cli.js');
  if (existsSync(distCli)) {
    const distOut = execFileSync('node', [distCli, tmp], { encoding: 'utf8' });
    const srcOut = execFileSync('node', [join(repoRoot, 'src', 'cli.ts'), tmp], { encoding: 'utf8' });
    const strip = (s) => s.split('\n').filter((l) => !l.startsWith('generated=')).join('\n');
    check('bygget output er identisk med kilden', strip(distOut), (v) => v === strip(srcOut));
  } else {
    check('bygget output er identisk med kilden (kræver npm run build)', 'skip', (v) => v === 'skip');
  }
  check('CLI-agent har WINDOW-sektion', cliZones.includes('## WINDOW'), (v) => v === true);
  check('CLI-agent har STATS-sektion', cliZones.includes('## STATS'), (v) => v === true);
  check('CLI-agent har WEEKS-sektion', cliZones.includes('## WEEKS'), (v) => v === true);
  check('CLI-agent har splits for detaljerede løb', /sp=\d+:/.test(cliZones), (v) => v === true);
  check('CLI-agent bruger punktum som decimaltegn', cliZones, (v) =>
    /(?:^|\s)km=10\.00(?:\s|$)/m.test(v),
  );

  // Output er engelsk, så ethvert agent-setup kan læse den. Regression-guard:
  // hvis en dansk strenge sniger sig ind i en overskrift eller en note, skal
  // det fange sig her.
  check('agent-formatets overskrifter er engelske', cliZones, (v) =>
    v.includes('## SCHEMA') &&
    v.includes('## WEEKS (newest first)') &&
    v.includes('## WINDOW (last 28 days vs. the 28 days before)') &&
    v.includes('## RUNS') &&
    v.includes('## STATS (whole period)'),
  );
  check('ingen danske overskrifter i agent-formatet', cliZones, (v) =>
    !/## (UGER|VINDUE|LØB|STATISTIKK|SIGNALER|KONTEKST|NOTER|BEMÆRKNINGER)/.test(v),
  );
  check('ingen dansk zone-note i agent-formatet', cliZones, (v) =>
    !v.includes('zoner bruger') && !v.includes('ingen kilde'),
  );

  const cliList = execFileSync('node', ['src/cli.ts', tmp, '--list'], { encoding: 'utf8' });
  check('--list viser zone-status', cliList.includes('zones: no'), (v) => v === true);

  // --find: maskinlæsbart, én sti pr. linje, exit-kode der afslører fund.
  // Køres med fixture'en som cwd, så den scanner den og ikke repoet.
  const cliPath = join(repoRoot, 'src', 'cli.ts');
  const findOut = execFileSync('node', [cliPath, '--find'], { encoding: 'utf8', cwd: tmp });
  const findLines = findOut.trim().split('\n').filter(Boolean);
  // Stier er absolutte, men formatet afhænger af OS: /home/... på Unix,
  // C:\Users\... på Windows. Begge skal accepteres.
  const isAbsolute = (p) => p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p);
  check('--find printer absolutte stier uden nummerering', findLines.every(isAbsolute), (v) => v === true);
  check('--find finder eksportmappen', findOut.includes(tmp), (v) => v === true);
  check('--find har ingen overskrift', !findOut.includes('Kandidat') && !findOut.includes('Vælg') && !findOut.includes('Pick a number'), (v) => v === true);
  check('--find kører uden TTY', findOut.length > 0, (v) => v === true);

  // --install-skill: kopierer skillen, så agenten kan bruge værktøjet
  const skillDir = join(tmp, 'skills', 'strava-digest');
  const instOut = execFileSync('node', [cliPath, '--install-skill', join(tmp, 'skills')], { encoding: 'utf8' });
  check('--install-skill skriver SKILL.md', existsSync(join(skillDir, 'SKILL.md')), (v) => v === true);

  // Skillen installeres fra pakken, saa dens version skal vaere den samme
  // som pakkens. Ellers ved brugeren ikke hvilken skill der passer til
  // hvilken vaerktojversion, og de to glider fra hinanden i det stille.
  const pkgVersion = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version;
  const skillVersion = (readFileSync(join(repoRoot, 'skills', 'strava-digest', 'SKILL.md'), 'utf8')
    .match(/^version:\s*(.+)$/m) ?? [])[1];
  check('skillens version er lig pakkeversionen', skillVersion, (v) => v === pkgVersion);
  check('--install-skill fortæller hvor den landede', instOut.includes('SKILL.md'), (v) => v === true);
  check('--install-skill siger hvad der skal spørges om', instOut.includes('how was my week'), (v) => v === true);
  // Install-outputtet er engelsk, ligesom resten af værktøjets output.
  check('--install-skill skriver engelsk', instOut, (v) =>
    v.includes('skill installed') && !/[æøå]/.test(instOut),
  );
  const installed = await readFile(join(skillDir, 'SKILL.md'), 'utf8');
  // Linjeskift må ikke afgøre frontmatter: Git på Windows konverterer
  // LF -> CRLF ved checkout, så den installerede skill kan have \r\n.
  // .gitattributes sørger for LF, men testen skal ikke være sårbar hvis
  // nogen kører den på en klon uden den.
  check(
    'installeret skill har gyldig frontmatter',
    /^---\r?\nname:\s*strava-digest\r?\n/.test(installed),
    (v) => v === true,
  );
  check('installeret skill har ingen CRLF', installed.includes('\r\n'), (v) => v === false);
  check('installeret skill er generisk (ingen personlige oplysninger)', !/macmini|Benjamin/i.test(installed), (v) => v === true);

  // En eksisterende skill skal opdateres in place, ikke duplikeres —
  // to skills med samme navn er et reelt problem for agenten.
  // Frisk mappe med KUN en kategoriseret skill, som en agent der
  // grupperer skills i kategorier ville have den.
  const skillRoot2 = join(tmp, 'skills2');
  mkdirSync(join(skillRoot2, 'kategori', 'strava-digest'), { recursive: true });
  writeFileSync(join(skillRoot2, 'kategori', 'strava-digest', 'SKILL.md'), '---\nname: strava-digest\n---\ntilpasset\n');
  execFileSync('node', [cliPath, '--install-skill', skillRoot2], { encoding: 'utf8' });
  check('eksisterende skill opdateres in place', (await readFile(join(skillRoot2, 'kategori', 'strava-digest', 'SKILL.md'), 'utf8')).includes('When to Use'), (v) => v === true);
  check('tilpasset version sikkerhedskopieres', existsSync(join(skillRoot2, 'kategori', 'strava-digest', 'SKILL.md.bak')), (v) => v === true);
  check('ingen duplikat-skill dannes', existsSync(join(skillRoot2, 'strava-digest')), (v) => v === false);

  // Regression: installeringen må aldrig spise brugerens fil, og
  // beskeden må aldrig påstå noget, koden ikke kan vide. Efter første
  // kørsel er SKILL.md værktøjets egen output, så den anden kørsel må
  // ikke kopiere den over .bak — brugerens egen version er brugerens
  // redningsplanke. Køres med en midlertidig HOME, så den rigtige
  // ~/.hermes ikke røres.
  //
  // HOME på Unix, USERPROFILE på Windows: os.homedir() læser den ene
  // eller den anden, alt efter platformen.
  function fakeHome(name, content) {
    const home = join(tmp, name);
    const dir = join(home, '.hermes', 'skills', 'strava-digest');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), content);
    return { dir, file: join(dir, 'SKILL.md'), env: { ...process.env, HOME: home, USERPROFILE: home } };
  }
  const runInstall = (env) =>
    execFileSync('node', [cliPath, '--install-skill'], { encoding: 'utf8', env });

  const userSkill = '# Min egen skill\n\nmax-puls: 189 (min egen)\n';
  const user = fakeHome('home', userSkill);
  const bakFile = `${user.file}.bak`;
  const firstOut = runInstall(user.env);
  check('første installation sikkerhedskopierer brugerens version', readFileSync(bakFile, 'utf8'), (v) => v === userSkill);
  check('første installation fortæller hvilken fil der blev skrevet', firstOut, (v) =>
    v.includes('the previous SKILL.md was copied to SKILL.md.bak'),
  );
  check('første installation påstår ikke at kende ejerskabet', firstOut, (v) =>
    !v.includes('your own version') && !v.includes('your earlier version'),
  );
  const secondOut = runInstall(user.env);
  check('anden installation overskriver ikke .bak', readFileSync(bakFile, 'utf8'), (v) => v === userSkill);
  check('anden installation påstår ikke at have gemt en brugerbackup', secondOut, (v) =>
    !v.includes('your own version') && !v.includes('the previous SKILL.md was copied'),
  );
  // Besked-teksten alene er ikke nok: checken skal også fejle, hvis
  // installeringen skrev en backup alligevel. Ellers består den, mens
  // .bak.2 fylder med værktøjets eget output.
  check('anden installation skriver ingen ny backup', existsSync(`${user.file}.bak.2`), (v) => v === false);

  // Opgraderingsstien: den installerede fil er værktøjets eget output fra
  // en ældre pakkeversion. Den afviger kun i version-linjen, som følger
  // pakkeversionen, så den skal genkendes som værktøjets eget output —
  // ingen støjende .bak og ingen påstand om en brugerversion.
  const packagedSkill = readFileSync(join(repoRoot, 'skills', 'strava-digest', 'SKILL.md'), 'utf8');
  const upgrade = fakeHome('home-upgrade', packagedSkill.replace(/^version:.*$/m, 'version: 0.9.0'));
  const upgradeOut = runInstall(upgrade.env);
  check('opgradering: ingen backup fra en ren opgradering', existsSync(`${upgrade.file}.bak`), (v) => v === false);
  check('opgradering: beskeden påstår ingen brugerversion', upgradeOut, (v) =>
    !v.includes('your own version') && !v.includes('the previous SKILL.md was copied'),
  );
  check('opgradering: beskeden siger at skillen blev opdateret', upgradeOut, (v) =>
    v.includes('the skill was updated'),
  );
  check('opgradering: den nye version er skrevet', readFileSync(upgrade.file, 'utf8'), (v) => v === packagedSkill);

  // Samme sag med CRLF: Git på Windows konverterer LF -> CRLF ved
  // checkout, så en fil der kun afviger i linjeskift, er ikke en
  // redigering og må ikke give en støjende .bak.
  const crlf = fakeHome('home-crlf', packagedSkill.replace(/\n/g, '\r\n'));
  runInstall(crlf.env);
  check('CRLF: ingen backup for en fil der kun afviger i linjeskift', existsSync(`${crlf.file}.bak`), (v) => v === false);

  // Brugeren redigerer filen, mens en backup allerede findes. Den gamle
  // backup må ikke røres, og brugerens fil må ikke gå tabt: den lander
  // i det næste ledige navn, og beskeden fortæller hvilket.
  const both = fakeHome('home-both', userSkill);
  const bothBak2 = join(both.dir, 'SKILL.md.bak.2');
  writeFileSync(join(both.dir, 'SKILL.md.bak'), 'earlier backup\n');
  const bothOut = runInstall(both.env);
  check('eksisterende backup røres ikke', readFileSync(join(both.dir, 'SKILL.md.bak'), 'utf8'), (v) => v === 'earlier backup\n');
  check('brugerens fil overlever i .bak.2', existsSync(bothBak2) ? readFileSync(bothBak2, 'utf8') : null, (v) => v === userSkill);
  check('beskeden nævner den fil der faktisk blev skrevet', bothOut, (v) =>
    v.includes('the previous SKILL.md was copied to SKILL.md.bak.2'),
  );
  check('beskeden påstår ikke at kende ejerskabet', bothOut, (v) =>
    !v.includes('your own version') && !v.includes('your earlier version'),
  );

  // Tre redigeringer i træk: hver skal overleve i sin egen backup-fil.
  // .bak, .bak.2 og .bak.3 skal findes med hver sit indhold, og ingen
  // backup må overskrives af den næste redigering.
  const three = fakeHome('home-three', '# Min egen skill 1\n');
  runInstall(three.env);
  writeFileSync(three.file, '# Min egen skill 2\n');
  runInstall(three.env);
  writeFileSync(three.file, '# Min egen skill 3\n');
  const threeOut = runInstall(three.env);
  const threeBak = (n) => {
    const p = n === 1 ? `${three.file}.bak` : `${three.file}.bak.${n}`;
    return existsSync(p) ? readFileSync(p, 'utf8') : null;
  };
  check('tre redigeringer: den første overlever i .bak', threeBak(1), (v) => v === '# Min egen skill 1\n');
  check('tre redigeringer: den anden overlever i .bak.2', threeBak(2), (v) => v === '# Min egen skill 2\n');
  check('tre redigeringer: den tredje overlever i .bak.3', threeBak(3), (v) => v === '# Min egen skill 3\n');
  check('beskeden nævner den tredje backup', threeOut, (v) =>
    v.includes('the previous SKILL.md was copied to SKILL.md.bak.3'),
  );

  let hrErr = null;
  try {
    execFileSync('node', ['src/cli.ts', tmp, '--max-hr', '0'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    hrErr = err;
  }
  check('ugyldig --max-hr fejler', hrErr !== null, (v) => v === true);
  check('ugyldig --max-hr giver engelsk besked', String(hrErr?.stderr ?? ''), (v) =>
    v.includes('positive integer') && !v.includes('positivt heltal'),
  );

  /* ---- løse aktivitetsfiler (Del A) ---- */

  const looseDir = join(tmp, 'activities');
  const looseSingle = JSON.parse(
    execFileSync('node', ['src/cli.ts', join(looseDir, 'Run-1001.gpx'), '--json'], { encoding: 'utf8' }),
  );
  check('loose fil: dato kommer fra filen', looseSingle.runs[0]?.row?.date?.slice(0, 10) ?? null, (v) => v === '2026-10-12');
  check('loose fil: type kommer fra GPX <type>', looseSingle.runs[0]?.row?.type ?? null, (v) => v === 'running');
  check('loose fil: puls kommer fra analysen', looseSingle.runs[0]?.analysis?.avgHr ?? null, (v) => v != null && v > 140 && v < 170);
  check('loose fil: navn = filnavn uden endelse', looseSingle.runs[0]?.row?.name ?? null, (v) => v === 'Run-1001');
  check('loose fil: elapsed fra første til sidste punkt', looseSingle.runs[0]?.row?.elapsedSec ?? null, (v) => v != null && v > 3000 && v < 3400);
  check('loose fil: RE, udstyr og kalorier udeladt', [looseSingle.runs[0]?.row?.relativeEffort, looseSingle.runs[0]?.row?.gear, looseSingle.runs[0]?.row?.calories], (v) => v[0] === null && v[1] === '' && v[2] === null);
  check('loose fil: header siger metadata fra filen', String(looseSingle.sourceLabel), (v) => v.includes('(file)') && v.includes('metadata read from the file'));

  const looseDirMd = execFileSync('node', ['src/cli.ts', looseDir, '--last', '3', '--format', 'md'], { encoding: 'utf8' });
  check('loose mappe: header siger mappe og metadata fra filerne', looseDirMd, (v) => v.includes('(folder, 4 activity files)') && v.includes('metadata read from the files'));
  check('loose mappe: noten siger at navnet kommer fra filnavnet', looseDirMd, (v) => v.includes('eksportens navn ikke') && v.includes('kommer fra filnavnet'));
  check('loose mappe: fil uden brugbar tid sprunget over med note', looseDirMd, (v) => v.includes('sprunget over') && v.includes('UdenTid.gpx'));
  check('loose mappe: tre løb i digesten', looseDirMd, (v) => v.includes('3 runs in digest'));

  const looseZones = execFileSync('node', ['src/cli.ts', looseDir, '--last', '1', '--max-hr', '240'], { encoding: 'utf8' });
  check('loose: zoner med --max-hr', looseZones, (v) =>
    /z=\d/.test(v) && /^max_hr=240 source=flag$/m.test(v),
  );

  // --last begrænser kun de løb der beskrives. WEEKS, WINDOW og STATS skal
  // stadig tælle hele mappen, også når kun de to nyeste vises.
  const looseLast = execFileSync('node', ['src/cli.ts', looseDir, '--last', '2'], { encoding: 'utf8' });
  check('loose --last 2: WINDOW tæller alle 3 løb', looseLast, (v) => /^recent: n=3 /m.test(v));
  check('loose --last 2: STATS tæller alle 3 løb', looseLast, (v) =>
    // Uden --max-hr har ingen af de løse filer zoner, så ingen har et
    // load-bidrag: without_analysis tæller dem alle tre.
    /^runs=3 km_total=24\.0 median_km=7\.99 without_analysis=3$/m.test(v),
  );
  check('loose --last 2: NOTES siger talt mod vist', looseLast, (v) =>
    /^- 3 runs are counted in WEEKS, WINDOW and STATS; 2 runs are shown \(--last\)\.$/m.test(v),
  );

  const looseList = execFileSync('node', ['src/cli.ts', looseDir, '--list'], { encoding: 'utf8' });
  check('loose --list viser filnavn og zone-status', looseList, (v) => v.includes('Run-1001.gpx') && v.includes('zones: no'));

  // issue #21 punkt 7: løse filer skal normalisere typen som bulk-vejen.
  const looseTypeDir = mkdtempSync(join(tmpdir(), 'strava-digest-loose-types-'));
  scratchDirs.push(looseTypeDir);
  const typedXml = (type, day) =>
    `<?xml version="1.0"?>\n<gpx version="1.1" creator="fixture"><trk><name>${type}</name><type>${type}</type><trkseg>` +
    [0, 1].map((i) =>
      `<trkpt lat="55.676${i}" lon="12.5683"><ele>20</ele><time>2026-10-${day}T07:0${i}:00Z</time></trkpt>`,
    ).join('') +
    `</trkseg></trk></gpx>\n`;
  writeFileSync(join(looseTypeDir, 'Svensk.gpx'), typedXml('Löpning', '03'));
  writeFileSync(join(looseTypeDir, 'Cykel.gpx'), typedXml('Cykling', '02'));
  let looseTypeJson = null;
  try {
    looseTypeJson = JSON.parse(execFileSync('node', ['src/cli.ts', looseTypeDir, '--json'], { encoding: 'utf8' }));
  } catch {
    looseTypeJson = null;
  }
  check('loose type: Löpning tælles som løb i digesten', looseTypeJson?.runs?.length ?? null, (v) => v === 1);
  check('loose type: Löpning har isRun=true', looseTypeJson?.runs?.[0]?.row?.isRun ?? null, (v) => v === true);
  const looseTypeAll = JSON.parse(execFileSync('node', ['src/cli.ts', looseTypeDir, '--all', '--json'], { encoding: 'utf8' }));
  check('loose type: Cykling er stadig ikke et løb', looseTypeAll.runs.find((r) => r.row.name === 'Cykel')?.row?.isRun ?? null, (v) => v === false);

  /* ---- issue #32: en loose-fil med en umulig dato må ikke flytte ankeret ---- */

  const anchorXml = (times) =>
    `<?xml version="1.0"?>\n<gpx version="1.1" creator="fixture"><trk><name>Fremtid</name><type>running</type><trkseg>${times
      .map(
        (t, i) =>
          `<trkpt lat="55.676${i}" lon="12.5683"><ele>20</ele><time>${t}</time></trkpt>`,
      )
      .join('')}</trkseg></trk></gpx>\n`;
  const futureXml = anchorXml(['2099-01-01T07:00:00Z', '2099-01-01T07:10:00Z']);

  // Uden for `tmp`, så discovery-testene ikke ser to ekstra eksportmapper.
  const anchorDir = mkdtempSync(join(tmpdir(), 'strava-digest-anker-'));
  const anchorFutureDir = mkdtempSync(join(tmpdir(), 'strava-digest-anker-fremtid-'));
  scratchDirs.push(anchorDir, anchorFutureDir);
  for (const name of ['Run-1001.gpx', 'Run-1002.tcx', 'Run-1003.gpx']) {
    copyFileSync(join(looseDir, name), join(anchorDir, name));
    copyFileSync(join(looseDir, name), join(anchorFutureDir, name));
  }
  writeFileSync(join(anchorFutureDir, 'Fremtid2099.gpx'), futureXml);

  const anchorBase = execFileSync('node', ['src/cli.ts', anchorDir], { encoding: 'utf8' });
  const anchorFuture = execFileSync('node', ['src/cli.ts', anchorFutureDir], { encoding: 'utf8' });
  const section = (text, from, to) => {
    const start = text.indexOf(from);
    const end = to ? text.indexOf(to, start) : -1;
    return start < 0 ? '' : text.slice(start, end < 0 ? undefined : end);
  };

  check('issue 32: 2099-filen tælles ikke med i runs_in_export', anchorFuture, (v) =>
    /^runs_in_export=3$/m.test(v),
  );
  check('issue 32: 2099-filen rapporteres sprunget over med datoen i grunden', anchorFuture, (v) =>
    v.includes('Fremtid2099.gpx (date in the future (2099-01-01))'),
  );
  check('issue 32: WINDOW-blokken er identisk med og uden 2099-filen', section(anchorFuture, '## WINDOW', '## RUNS'), (v) =>
    v !== '' && v === section(anchorBase, '## WINDOW', '## RUNS'),
  );
  check('issue 32: RUNS-blokken er identisk med og uden 2099-filen', section(anchorFuture, '## RUNS', '## STATS'), (v) =>
    v !== '' && v === section(anchorBase, '## RUNS', '## STATS'),
  );
  check('issue 32: nyeste d= i RUNS er den nyeste gyldige tur', section(anchorFuture, '## RUNS', '## STATS'), (v) =>
    /^d=2026-10-12T06:30:00\.330Z n="Run-1001"/m.test(v),
  );
  check('issue 32: WINDOW tæller kun de gyldige løb', section(anchorFuture, '## WINDOW', '## RUNS'), (v) =>
    /^recent: n=3 /m.test(v),
  );

  /* ---- fund 1: distance 0 fra fil uden distance må ikke påstå 0 km ---- */

  const noDistTrack = {
    points: [
      { t: new Date('2026-10-12T06:30:00Z'), hr: 150 },
      { t: new Date('2026-10-12T06:35:00Z'), hr: 152 },
    ],
    sport: 'running',
    source: 'fit',
    distanceDerived: false,
  };
  const noDistAnalysis = analyseRun(noDistTrack);
  const noDistRow = rowFromTrack('UdenDistance.fit', noDistTrack, noDistAnalysis);
  check('loose: fil uden distance giver null i stedet for 0', noDistRow, (v) => v?.distanceM === null);
  const noDistMd = noDistRow
    ? renderMarkdown({
        sourceLabel: 'test',
        activitiesInExport: 1,
        runs: [{ row: noDistRow, analysis: noDistAnalysis }],
        baselineDays: 28,
        unmatchedHeaders: [],
        contextText: '',
        generatedAt: new Date('2026-10-13T08:00:00'),
        poolLabel: 'Løb',
      })
    : '';
  check('loose: digest uden distance viser – i stedet for 0,00 km', noDistMd.includes('**Run:** –'), (v) => v === true);

  const zeroDistTrack = {
    points: [
      { t: new Date('2026-10-12T06:30:00Z'), distM: 0 },
      { t: new Date('2026-10-12T06:35:00Z'), distM: 0 },
    ],
    sport: 'running',
    source: 'fit',
    distanceDerived: false,
  };
  check('loose: legitim distance 0 vises fortsat som 0', rowFromTrack('NulDistance.fit', zeroDistTrack, analyseRun(zeroDistTrack)), (v) => v?.distanceM === 0);

  /* ---- fund 2: énpunktsfiler må ikke ligne et rigtigt pas ---- */

  const onePointXml = `<?xml version="1.0"?>\n<gpx version="1.1" creator="fixture"><trk><name>Enkelt</name><type>running</type><trkseg><trkpt lat="55.6761" lon="12.5683"><ele>20</ele><time>2026-10-11T07:00:00Z</time></trkpt></trkseg></trk></gpx>\n`;
  const onePointTrack = parseActivityBuffer('Enkelt.gpx', Buffer.from(onePointXml));
  check('loose: énpunktsfil giver ingen digestrække', rowFromTrack('Enkelt.gpx', onePointTrack, analyseRun(onePointTrack)), (v) => v === null);

  enkeltRoot = mkdtempSync(join(tmpdir(), 'strava-digest-enkelt-'));
  writeFileSync(join(enkeltRoot, 'Enkelt.gpx'), onePointXml);
  const enkeltList = execFileSync('node', ['src/cli.ts', enkeltRoot, '--list'], { encoding: 'utf8' });
  check('loose --list: énpunktsfil sprunget over med grund', enkeltList, (v) => v.includes('Enkelt.gpx') && v.includes('(skipped)') && v.includes('only 1 point'));

  let looseErr = null;
  try {
    execFileSync('node', ['src/cli.ts', join(looseDir, 'UdenTid.gpx')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    looseErr = err;
  }
  check('loose: fil uden brugbar tid alene fejler pænt', String(looseErr?.stderr ?? ''), (v) => v.includes('No runs found'));

  const emptyDir = join(tmp, 'tom');
  mkdirSync(emptyDir, { recursive: true });
  writeFileSync(join(emptyDir, 'note.txt'), 'ingen aktiviteter her');
  let emptyErr = null;
  try {
    execFileSync('node', ['src/cli.ts', emptyDir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    emptyErr = err;
  }
  check('mappe uden CSV og uden aktivitetsfiler fejler uændret', String(emptyErr?.stderr ?? ''), (v) => v.includes('Could not find activities.csv'));

  /* ---- discovery til interaktiv start (Del B) ---- */

  check('isActivityFile: .fit.gz', isActivityFile('a.FIT.GZ'), (v) => v === true);
  check('isActivityFile: .tcx', isActivityFile('a.tcx'), (v) => v === true);
  check('isActivityFile: .csv er ikke aktivitet', isActivityFile('activities.csv'), (v) => v === false);
  check('isActivityFile: .jpg er ikke aktivitet', isActivityFile('media/photo.jpg'), (v) => v === false);
  check('isActivityFile: mid-name .fit er ikke en aktivitet', isActivityFile('Tur.fit.bak'), (v) => v === false);
  check('isActivityFile: .gpx.bak er ikke aktivitet', isActivityFile('Tur.gpx.bak'), (v) => v === false);

  const fitBakDir = scratch('fit-bak');
  copyFileSync(join(repoRoot, 'fixtures', 'sample.fit'), join(fitBakDir, 'Tur.fit.bak'));
  copyFileSync(join(repoRoot, 'fixtures', 'sample.fit'), join(fitBakDir, 'Tur2.fit'));
  const fitBakFiles = await collectActivityFiles(fitBakDir);
  check('loose: kun den rigtige .fit-endelse samles', fitBakFiles.length, (v) => v === 1);
  check('loose: Tur.fit.bak samles ikke, Tur2.fit gør', {
    bak: fitBakFiles.some((f) => f.endsWith('Tur.fit.bak')),
    plain: fitBakFiles.some((f) => f.endsWith('Tur2.fit')),
  }, (v) => v.bak === false && v.plain === true);
  const fitBakCandidates = await discoverSources([fitBakDir]);
  check('discover: mid-name .fit tælles ikke som aktivitetsfil', fitBakCandidates.find((c) => c.path === fitBakDir)?.count ?? null, (v) => v === 1);
  const fitBakList = execFileSync('node', ['src/cli.ts', fitBakDir, '--list'], { encoding: 'utf8' });
  check('loose --list: kun Tur2.fit er en aktivitet', fitBakList, (v) =>
    !v.includes('Tur.fit.bak') && v.includes('Tur2.fit'),
  );

  utimesSync(looseDir, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
  utimesSync(tmp, new Date('2025-01-01T00:00:00Z'), new Date('2025-01-01T00:00:00Z'));
  const candidates = await discoverSources([tmp, join(tmp, 'findes-ikke'), tmp]);
  check('discover: dedupliceret på sti', candidates.length, (v) => v === 2);
  check('discover: nyeste dir først', candidates[0]?.path ?? null, (v) => v === tmp);
  check('discover: dir selv som csv-mappe', candidates.find((c) => c.path === tmp)?.kind ?? null, (v) => v === 'csv-mappe');
  check('discover: undermappe som aktivitetsmappe', candidates.find((c) => c.path === looseDir)?.kind ?? null, (v) => v === 'aktivitetsmappe');
  check('discover: antal aktivitetsfiler i undermappen', candidates.find((c) => c.path === looseDir)?.count ?? null, (v) => v === 4);
  check('discover: manglende mapper ignoreres', candidates.some((c) => c.path === join(tmp, 'findes-ikke')), (v) => v === false);

  const manyBase = join(tmp, 'mange');
  for (let i = 0; i < 17; i++) {
    const d = join(manyBase, `f${String(i).padStart(2, '0')}`);
    mkdirSync(d, { recursive: true });
    copyFileSync(join(looseDir, 'Run-1003.gpx'), join(d, 'tur.gpx'));
  }
  const many = await discoverSources([manyBase]);
  check('discover: maks 15 kandidater', many.length, (v) => v === 15);
  check('discover: kandidaterne er aktivitetsmapper', many.every((c) => c.kind === 'aktivitetsmappe'), (v) => v === true);

  const nestedBase = join(tmp, 'nested');
  mkdirSync(join(nestedBase, 'ydre', 'indre'), { recursive: true });
  copyFileSync(join(looseDir, 'Run-1003.gpx'), join(nestedBase, 'ydre', 'indre', 'tur.gpx'));
  const nested = await discoverSources([nestedBase]);
  check('discover: rekursivt indhold tælles fortsat med', nested.find((c) => c.path === join(nestedBase, 'ydre'))?.count ?? null, (v) => v === 1);
  check('discover: rodmappen tæller også rekursivt', nested.find((c) => c.path === nestedBase)?.count ?? null, (v) => v === 1);

  // issue #21 punkt 8: file:// fra Windows må ikke give en ledende skråstreg.
  check('cleanPath: Windows file:///C:/x/y.zip', cleanPath('file:///C:/x/y.zip'), (v) => v === 'C:/x/y.zip');
  check('cleanPath: POSIX file:///Users/x/y.zip', cleanPath('file:///Users/x/y.zip'), (v) => v === '/Users/x/y.zip');
  check('cleanPath: ren sti er uændret', cleanPath('/Users/x/y.zip'), (v) => v === '/Users/x/y.zip');

  /* ---- regression: stdout gennem en pipe må ikke klippes af ---- */

  // process.exit() afsluttede processen, før asynkrone stdout-skrivninger
  // var tømt. Alt over pipe-bufferen (64 KiB) forsvandt uden fejlmelding,
  // så `| less`, `| pbcopy` og agenter fik et afkortet digest. Samme digest
  // skrives derfor gennem en pipe og til en fil, og byte-længderne skal
  // være identiske: intet må tabes i pipen.
  const bigDir = join(tmp, 'stor');
  mkdirSync(bigDir, { recursive: true });
  execFileSync('node', ['scripts/make-fixtures.mjs', bigDir, '800'], { stdio: 'inherit' });
  const bigPiped = execFileSync('node', ['src/cli.ts', bigDir, '--format', 'md'], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  // Digestet skrives uden for eksportmappen, så begge CLI-kørsler ser
  // præcis den samme mappe. Lå det ligge i eksporten, ville den anden
  // kørsel læse en mappe, der ikke ligner den første.
  const outDir = join(tmp, 'ud');
  mkdirSync(outDir, { recursive: true });
  const bigFile = join(outDir, 'digest.md');
  execFileSync('node', ['src/cli.ts', bigDir, '--format', 'md', '--out', bigFile]);
  const pipedBytes = Buffer.byteLength(bigPiped, 'utf8');
  check('stort digest er tydeligt over pipe-bufferen (64 KiB)', pipedBytes, (v) => v > 2 * 65536);
  check('pipe giver samme længde som --out', pipedBytes, (v) => v === statSync(bigFile).size);

  // En læser der lukker pipen tidligt — `| head`, `| less` og et tryk på `q`
  // — giver EPIPE i skriveren. Det er ikke en fejl: læseren fik det, den
  // ville have. Testen efterligner `head` i Node i stedet for med en
  // shell-pipe, så den også kan køre på Windows: læs den første chunk,
  // luk røret, og se hvad CLI'en gør. Uden EPIPE-håndteringen dør den med
  // en stacktrace og exit 1.
  //
  // Den første `data`-chunk er ikke 4096 bytes: den er lige så stor som
  // pipe-bufferen (64 KiB på Linux og macOS), fordi læseren står klar
  // med det samme. Tærsklen nedenfor er derfor et minimum, ikke det
  // antal bytes der faktisk læses, og `read` er begrænset af bufferen —
  // ikke af digestets længde.
  const earlyClose = await new Promise((resolve) => {
    const child = spawn('node', ['src/cli.ts', bigDir, '--format', 'md'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    let read = 0;
    // Bevis på at røret blev lukket under skrivningen: barnet var
    // stadig levende, da læseren lukkede. Et barn der havde skrevet
    // hele digestet, ville være afsluttet.
    let aliveAtClose = false;
    let timedOut = false;
    let timer;
    const finish = (code, finalStderr = stderr) => {
      clearTimeout(timer);
      resolve({ code, stderr: finalStderr, read, aliveAtClose, timedOut });
    };
    // Uden timeout hænger CI, hvis barnet en dag stopper med at svare.
    // 60 sekunder er langt nok til denne kørsel på en langsom maskine.
    timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      // Nødudløsning: hvis barnet ikke dør, må testen alligevel ikke
      // hænge. Timeren er unref'et, så den holder ikke event loop i live.
      setTimeout(() => finish(null), 5_000).unref();
    }, 60_000);
    child.stdout.on('data', (chunk) => {
      read += chunk.length;
      if (read >= 4096) {
        aliveAtClose = child.exitCode === null && child.signalCode === null;
        child.stdout.destroy();
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => finish(null, stderr + err.message));
    child.on('close', (code) => finish(code));
  });
  check('barnet afsluttede inden timeout', earlyClose.timedOut ? `timeout (${earlyClose.read} bytes læst)` : 'ok', (v) => v === 'ok');
  check('lukket pipe tidligt (som | head) giver exit 0', earlyClose.timedOut ? 'timeout' : earlyClose.code, (v) => v === 0);
  check('lukket pipe tidligt giver ingen stderr', earlyClose.stderr, (v) => v === '');
  // Den tredje check skal sige noget om produktet, ikke om fixtureen.
  // `read < pipedBytes` passerer per konstruktion, fordi read er
  // afgrænset af pipe-bufferen. Det egentlige bevis for at skrivningen
  // blev afbrudt, er at barnet stadig var levende, da røret blev
  // lukket: så fik skriveren EPIPE midt i sit output, og de to checks
  // ovenfor (exit 0, ingen stderr) målte den håndtering.
  check('røret blev lukket mens barnet stadig skrev', earlyClose.aliveAtClose, (v) => v === true);

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
  check('digest uden pulsdata: note om pulsdata frem for --max-hr', mdNoHr.includes('- _note: no zone split (this run has no heart-rate data)_'), (v) => v === true);

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

  /* ---- fund fra rigtig Strava-eksport (2026-10-20) ---- */

  // 1) Strava oversætter typerne: "Run" bliver "Løb". Uden normalisering
  //    faldt alle 195 løb ud af puljen, og digesten viste 5 "løb" i stedet.
  check('dansk type "Løb" normaliseres til løb', normalizeType('Løb'), (v) => v === 'lob');
  check('dansk type "Løb" tælles som løb', RUN_TYPES.includes(normalizeType('Løb')), (v) => v === true);
  // "Løp" (norsk) og "Löp" (svensk) er de oversatte ord for "Run", så de
  // skal tælle som løb. Før var de grønne som "tælles ikke som løb", men kun
  // fordi normaliseringen slettede ö i stedet for at folde den: "Löp" blev
  // til "lp", som intet alias nogensinde kunne ramme. En svensk konto ville
  // derfor have vist 0 løb helt lydløst.
  check('norsk type "Løp" tælles som løb', RUN_TYPES.includes(normalizeType('Løp')), (v) => v === true);
  check('svensk type "Löp" tælles som løb', RUN_TYPES.includes(normalizeType('Löp')), (v) => v === true);
  check('cykeltur tælles ikke som løb', normalizeType('Virtuel cykeltur') === 'lob', (v) => v === false);

  // Regression (issue #17): Wandern, wandelen og randonnée er ikke løb.
  // De skal stadig være aktiviteter i eksporten, men de må ikke tælle i
  // run-count, distance eller pace. Hver fixture har ét rigtigt løb, så
  // løbets pace kan aflæses præcist.
  const hikeWalkRows = [
    '2,"Oct 8, 2026, 6:32:10 AM",Wanderung,Wanderung,1500,1500,8.0,120,100,Walk-Wanderung.gpx',
    '3,"Oct 7, 2026, 6:32:10 AM",Wandeling,Wandeling,1500,1500,8.0,120,100,Walk-Wandeling.tcx',
    '4,"Oct 6, 2026, 6:32:10 AM",Randonnée,Randonnée,1500,1500,8.0,120,100,Walk-Randonnee.gpx',
  ];
  const writeHikeExport = (name, runType) => {
    const dir = writeExport(name, [
      `1,"Oct 12, 2026, 6:32:10 AM",${runType},${runType},3600,3600,10.0,170,150,Good.gpx`,
      ...hikeWalkRows,
    ]);
    copyGoodGpx(dir);
    copyFileSync(join(tmp, 'activities', 'Run-1003.gpx'), join(dir, 'Walk-Wanderung.gpx'));
    copyFileSync(join(tmp, 'activities', 'Run-1002.tcx'), join(dir, 'Walk-Wandeling.tcx'));
    copyFileSync(join(tmp, 'activities', 'Run-1001.gpx'), join(dir, 'Walk-Randonnee.gpx'));
    return dir;
  };
  const runsBlock = (out) => out.slice(out.indexOf('## RUNS'));

  const hikeTypesDir = writeHikeExport('hike-types', 'Løb');
  const hikeTypesAgent = execFileSync('node', ['src/cli.ts', hikeTypesDir], { encoding: 'utf8' });
  const hikeTypesRuns = runsBlock(hikeTypesAgent);
  check('hike types: runs_in_export counts only the real run', hikeTypesAgent, (v) =>
    /^runs_in_export=1$/m.test(v),
  );
  check('hike types: Wanderung, Wandeling and Randonnée are not in RUNS', hikeTypesRuns, (v) =>
    !v.includes('n="Wanderung"') &&
    !v.includes('n="Wandeling"') &&
    !v.includes('n="Randonnée"'),
  );

  const hikeTypesList = execFileSync('node', ['src/cli.ts', hikeTypesDir, '--list'], { encoding: 'utf8' });
  check('hike types: --list still counts all four activities', hikeTypesList, (v) =>
    /^4 activities in total \(shown: 4\)$/m.test(v),
  );
  check('hike types: --list still shows every walk as an activity', hikeTypesList, (v) =>
    v.includes('Wanderung') && v.includes('Wandeling') && v.includes('Randonnée'),
  );
  check('hike types: --list does not mark a walk as RUN', hikeTypesList, (v) =>
    !/RUN\s+Wanderung/.test(v) && !/RUN\s+Wandeling/.test(v) && !/RUN\s+Randonnée/.test(v),
  );

  const hikeTypesAll = execFileSync('node', ['src/cli.ts', hikeTypesDir, '--all'], { encoding: 'utf8' });
  check('hike types: --all still shows every walk in RUNS', runsBlock(hikeTypesAll), (v) =>
    v.includes('n="Wanderung"') && v.includes('n="Wandeling"') && v.includes('n="Randonnée"'),
  );
  check('hike types: every walk with a track is analysed under --all', runsBlock(hikeTypesAll), (v) => {
    const lines = v.split('\n');
    return ['Wanderung', 'Wandeling', 'Randonnée'].every((name) => {
      const line = lines.find((candidate) => candidate.includes(`n="${name}"`)) ?? '';
      return / z=\d/.test(line) && !line.includes(' z=- ') && !line.includes(' err=');
    });
  });
  check('hike types: --all puts every activity in the run pool', hikeTypesAll, (v) =>
    /^activities_in_export=4$/m.test(v) && /^runs_in_export=4$/m.test(v) && /^runs_shown=4$/m.test(v),
  );
  check('hike types: WINDOW pace comes from the real run alone', hikeTypesAgent, (v) =>
    /^recent: n=1 km=10\.0 t=3600 pace=360\.0 /m.test(v),
  );

  for (const type of ['Run', 'Lauf', 'Löpning']) {
    const dir = writeHikeExport(`hike-types-${type.toLowerCase().replace(/[^a-z]/g, '')}`, type);
    const out = execFileSync('node', ['src/cli.ts', dir], { encoding: 'utf8' });
    check(`hike types: normal "${type}" still counts as a run`, runsBlock(out), (v) =>
      v.includes(`n="${type}"`),
    );
  }
  check('Randonnée accent still folds during normalisation', normalizeType('Randonnée'), (v) =>
    v === 'randonnee' && !RUN_TYPES.includes(v),
  );

  // 2) Eksportens datoer er UTC — bekræftet mod FIT/GPX i samme arkiv.
  //    Som lokal tid kom turen to timer for tidigt i digesten.
  const utcDate = parseDate('16. okt. 2026, 08.18.29');
  check('eksportens dato tolkes som UTC', utcDate?.toISOString(), (v) => v === '2026-10-16T08:18:29.000Z');
  check('lokal gengivelse følger maskinens zone', utcDate?.getHours(), (v) => v === new Date('2026-10-16T08:18:29Z').getHours());
  const isoDate = parseDate('2026-10-16T08:18:29Z');
  check('ISO-dato tolkes uændret', isoDate?.toISOString(), (v) => v === '2026-10-16T08:18:29.000Z');

  // ISO uden zone må ikke afhænge af maskinens TZ. Barneprocessen kører
  // samme parsing i tre zoner; de skal give præcis samme instant. Barnet
  // printer også sin offset, så testen kan springes over på platforme hvor
  // TZ ikke slår igennem (fx Windows), i stedet for at bestå tomt.
  const parseIsoInTz = (tz) =>
    execFileSync(
      process.execPath,
      ['-e', "import('./src/columns.ts').then(({ parseDate }) => { const d = parseDate('2026-10-16T08:18:29'); process.stdout.write(JSON.stringify({ offset: new Date().getTimezoneOffset(), iso: d ? d.toISOString() : 'null' })); })"],
      { cwd: repoRoot, env: { ...process.env, TZ: tz }, encoding: 'utf8' },
    );
  const tzResults = ['UTC', 'Europe/Copenhagen', 'America/New_York'].map((tz) => JSON.parse(parseIsoInTz(tz)));
  if (new Set(tzResults.map((r) => r.offset)).size !== 3) {
    console.log('skip: TZ not honoured on this platform');
  } else {
    check('ISO uden zone er tidszone-uafhængig', tzResults.map((r) => r.iso), (v) =>
      v.every((iso) => iso === '2026-10-16T08:18:29.000Z'),
    );
  }
  check('ISO uden zone med millisekunder', parseDate('2026-10-16T08:18:29.123')?.toISOString(), (v) =>
    v === '2026-10-16T08:18:29.123Z',
  );
  check('ISO uden zone med mellemrum', parseDate('2026-10-16 08:18:29')?.toISOString(), (v) =>
    v === '2026-10-16T08:18:29.000Z',
  );
  check('ISO ren dato er midnat UTC', parseDate('2026-10-16')?.toISOString(), (v) =>
    v === '2026-10-16T00:00:00.000Z',
  );
  check('ISO med offset respekteres', parseDate('2026-10-16T10:18:29+02:00')?.toISOString(), (v) =>
    v === '2026-10-16T08:18:29.000Z',
  );
  check('ugyldig ISO giver null', parseDate('2026-13-40T99:99:99'), (v) => v === null);
  // Date.UTC ruller over (måned 13 → januar næste år), så en ugyldig
  // kalenderdato skal afvises eksplicit i stedet for at blive en forkert dato.
  check('ISO med 30. februar giver null', parseDate('2026-02-30'), (v) => v === null);
  check('RFC 2822 med GMT', parseDate('Tue, 12 Oct 2026 06:32:10 GMT')?.toISOString(), (v) =>
    v === '2026-10-12T06:32:10.000Z',
  );
  // RFC-grenen skal validere dagen ligesom de andre grene. Uden det ruller
  // new Date() 31. februar videre til 3. marts.
  check('RFC 2822 med 31. februar giver null', parseDate('Tue, 31 Feb 2026 06:32:10 GMT'), (v) => v === null);

  // Klokkeslættet skal valideres efter AM/PM-justering. Date.UTC ruller
  // ellers 25:00 videre til næste dag, og 06:61 til næste time.
  check('time 25 giver null', parseDate('2026/10/12 25:00'), (v) => v === null);
  check('time 25 med punktum giver null', parseDate('12.10.2026 25:00'), (v) => v === null);
  check('minut 61 giver null', parseDate('12.10.2026 06:61'), (v) => v === null);
  check('uoverensstemmende AM/PM giver null', parseDate('Oct 12, 2026, 13:32:10 PM'), (v) => v === null);
  check('12 AM er midnat', parseDate('Oct 12, 2026, 12:32:10 AM')?.toISOString(), (v) =>
    v === '2026-10-12T00:32:10.000Z',
  );

  // Numerisk dato uden klokkeslæt bruger samme orden som den tidsbærende
  // gren: punktum og bindestreg er dag-først, skråstreg er måned-først (US).
  // Klokkeslættet er midnat UTC.
  check('numerisk dato uden klokkeslæt med punktum', parseDate('12.10.2026')?.toISOString(), (v) =>
    v === '2026-10-12T00:00:00.000Z',
  );
  check('numerisk dato uden klokkeslæt med bindestreg', parseDate('12-10-2026')?.toISOString(), (v) =>
    v === '2026-10-12T00:00:00.000Z',
  );
  check('numerisk dato uden klokkeslæt med skråstreg er måned-først', parseDate('10/12/2026')?.toISOString(), (v) =>
    v === '2026-10-12T00:00:00.000Z',
  );
  check('numerisk dato med klokkeslæt er uændret', parseDate('12.10.2026 06:32')?.toISOString(), (v) =>
    v === '2026-10-12T06:32:00.000Z',
  );
  check('skråstreg med klokkeslæt er uændret', parseDate('10/12/2026 06:32')?.toISOString(), (v) =>
    v === '2026-10-12T06:32:00.000Z',
  );

  // Primær orden bruges når den er en rigtig kalenderdato. Er den ugyldig,
  // prøves den anden orden, og den bruges kun hvis den også er gyldig.
  check('skråstreg med måned 13 falder tilbage til dag-først', parseDate('13/12/2020')?.toISOString(), (v) =>
    v === '2020-12-13T00:00:00.000Z',
  );
  check('punktum med måned 13 falder tilbage til måned-først', parseDate('12.13.2020')?.toISOString(), (v) =>
    v === '2020-12-13T00:00:00.000Z',
  );
  check('umulig kalenderdato 31.02 giver null', parseDate('31.02.2026'), (v) => v === null);
  check('dag 00 giver null', parseDate('00.10.2026'), (v) => v === null);
  check('årstal først med måned 13 giver null', parseDate('2026/13/12'), (v) => v === null);
  check('numerisk dato med hale giver null', parseDate('12.10.2026x'), (v) => v === null);
  check('numerisk dato med T-tid giver null', parseDate('12.10.2026T06:32'), (v) => v === null);

  // En aktivitet kan ikke starte i morgen. Datoer mere end ét døgn ude i
  // fremtiden afvises, så de ikke flytter digestens anker. Tolerancen på et
  // døgn dækker tidszoneforskelle mellem eksportens UTC-stempler og uret.
  check('dato klart i fremtiden giver null', parseDate('2099-01-01'), (v) => v === null);
  check('dato i fortiden er ikke null', parseDate('2020-01-01'), (v) => v !== null);
  const inTwelveHours = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
  check('dato 12 timer ude i fremtiden er inden for tolerancen', parseDate(inTwelveHours), (v) => v !== null);
  // 13/12/2026 er en rigtig dato (13. december), og fallbacken til dag-først
  // er korrekt. Den giver kun null her, fordi datoen ligger mere end ét døgn
  // ude i fremtiden. Efter december 2026 er den ikke længere fremtidig.
  const dec132026 = new Date('2026-12-13T00:00:00Z').getTime();
  if (dec132026 > Date.now() + 24 * 60 * 60 * 1000) {
    check('13/12/2026 giver null fordi den er i fremtiden', parseDate('13/12/2026'), (v) => v === null);
  } else {
    check('13/12/2026 er ikke længere i fremtiden', parseDate('13/12/2026')?.toISOString(), (v) =>
      v === '2026-12-13T00:00:00.000Z',
    );
  }

  // Samme streng må ikke give forskellig dato med og uden klokkeslæt.
  const sameDateDifferentTime = (a, b) => {
    const da = parseDate(a)?.toISOString();
    const db = parseDate(b)?.toISOString();
    return da != null && db != null && da.slice(0, 10) === db.slice(0, 10) && da !== db;
  };
  check(
    'skråstreg: samme dato med og uden klokkeslæt',
    sameDateDifferentTime('10/12/2026', '10/12/2026 06:32'),
    (v) => v === true,
  );
  check(
    'punktum: samme dato med og uden klokkeslæt',
    sameDateDifferentTime('12.10.2026', '12.10.2026 06:32'),
    (v) => v === true,
  );
  check('ufortolkbar streng giver null', parseDate('not-a-date'), (v) => v === null);

  // Formater som før kun overlevede via new Date(s): månedsnavn uden
  // klokkeslæt (README bruger "Oct 12, 2026") og årstal først med skråstreg.
  check('månedsnavn uden klokkeslæt (engelsk)', parseDate('October 12, 2026')?.toISOString(), (v) =>
    v === '2026-10-12T00:00:00.000Z',
  );
  check('månedsnavn uden klokkeslæt (dansk)', parseDate('12. okt. 2026')?.toISOString(), (v) =>
    v === '2026-10-12T00:00:00.000Z',
  );
  check('årstal først med skråstreg', parseDate('2026/10/12')?.toISOString(), (v) =>
    v === '2026-10-12T00:00:00.000Z',
  );

  // En eksportrække med numerisk dato uden klokkeslæt må ikke havne i
  // december. Agentformatet viser datoen som ISO, så testen er TZ-uafhængig.
  const numericDateDir = writeExport('numeric-date', [
    '1,12.10.2026,Date only,Løb,1800,1800,5.0,170,150,',
  ]);
  const numericDateAgent = execFileSync(process.execPath, ['src/cli.ts', numericDateDir], { encoding: 'utf8' });
  check('dato uden klokkeslæt: løbet havner på 12. oktober', numericDateAgent, (v) =>
    /^d=2026-10-12T00:00:00\.000Z /m.test(v),
  );

  // En fremtidig række må ikke flytte digestens anker. De fem løb i
  // september-oktober er historikken; december-rækken skal tælles som
  // sprunget over og efterlade WINDOW på de fem. Brug 2099 hvis 13/12/2026
  // allerede er passeret, så testen ikke afhænger af kørselsdatoen.
  const futureSlash = dec132026 > Date.now() + 24 * 60 * 60 * 1000 ? '13/12/2026' : '13/12/2099';
  const futureDateDir = writeExport('future-date', [
    '1,"Sep 14, 2026, 6:32:10 AM",Run 1,Løb,1800,1800,5.0,170,150,',
    '2,"Sep 20, 2026, 6:32:10 AM",Run 2,Løb,1800,1800,5.0,170,150,',
    '3,"Sep 27, 2026, 6:32:10 AM",Run 3,Løb,1800,1800,5.0,170,150,',
    '4,"Oct 1, 2026, 6:32:10 AM",Run 4,Løb,1800,1800,5.0,170,150,',
    '5,"Oct 10, 2026, 6:32:10 AM",Run 5,Løb,1800,1800,5.0,170,150,',
    `6,${futureSlash},Future,Løb,1800,1800,5.0,170,150,`,
  ]);
  const futureDateAgent = execFileSync(process.execPath, ['src/cli.ts', futureDateDir], { encoding: 'utf8' });
  check('fremtidig række: WINDOW tæller kun de fem historiske løb', futureDateAgent, (v) =>
    /^recent: n=5 /m.test(v),
  );
  check('fremtidig række: rækken er ikke i digesten', futureDateAgent, (v) => !v.includes('n="Future"'));
  check('fremtidig række: NOTES rapporterer den sprungne række', futureDateAgent, (v) =>
    /^- 1 row was skipped because of a missing or unparsable date and is not in the digest \(1 of them was also without a file name\)\.$/m.test(v),
  );

  // Strava skriver månedsnavnet på kontosproget. Samme dato skal kunne læses
  // på engelsk, dansk, tysk, fransk, svensk og spansk.
  const monthForms = [
    ['engelsk', 'Oct 12, 2026, 06:32', '2026-10-12'],
    ['dansk', '12. okt. 2026, 06:32', '2026-10-12'],
    ['tysk', '12. Okt. 2026, 06:32', '2026-10-12'],
    ['tysk med accent', '12. März 2026, 06:32', '2026-03-12'],
    ['fransk', '12 février 2026, 06:32', '2026-02-12'],
    ['svensk', '12 oktober 2026, 06:32', '2026-10-12'],
    ['spansk', '12 de octubre de 2026, 06:32', '2026-10-12'],
  ];
  for (const [lang, raw, expected] of monthForms) {
    const d = parseDate(raw);
    check(
      `dato med månedsnavn på ${lang} tolkes`,
      d?.toISOString().slice(0, 10),
      (v) => v === expected,
    );
  }

  // Aktivitetstypen kommer også oversat: "Run" bliver "Løb" på dansk,
  // "Lauf" på tysk, "Löpning" på svensk. Uden normalisering falder hele
  // historikken ud af puljen.
  for (const [lang, type] of [
    ['dansk', 'Løb'],
    ['tysk', 'Lauf'],
    ['svensk', 'Löpning'],
    ['nederlandsk', 'Hardlopen'],
    ['fransk', 'Course à pied'],
  ]) {
    check(
      `aktivitetstype på ${lang} tæller som løb`,
      normalizeType(type) !== type && RUN_TYPES.includes(normalizeType(type)),
      (v) => v === true,
    );
  }

  // Kolonnenavne kommer oversatte. Et tysk eksport skal finde de samme felter.
  const germanHeaders = parseCsv(
    [
      'Aktivitäts-ID;Aktivitätsdatum;Aktivitätsname;Aktivitätstyp;Gesamtzeit;Bewegungszeit;Distanz;Durchschnittliche Herzfrequenz;Maximale Herzfrequenz;Höhenanstieg;Kalorien;Aktivitätsausrüstung;Dateiname',
      '1001;12. Okt. 2026, 06:32;Morgenlauf;Lauf;3360;3360;10,0;156;174;120;600;Nike Vomero;Run-1001.gpx',
    ].join('\n'),
  );
  const germanMap = mapColumns(germanHeaders);
  check('tyske kolonnenavne giver alle felter', germanMap.unmatched, (v) => v.length === 0);
  check('tysk distance-felt parses', germanMap.index.has('distance'), (v) => v === true);
  check('tysk gennemsnitlig puls parses', germanMap.index.has('avgHr'), (v) => v === true);

  // Talformatet er en regel pr. værdi, ikke pr. konto-locale. Komma og
  // punktum kan hver være både decimal- og tusindtalsseparator, så reglen i
  // num() skal dækkes direkte: gentagne separatorer og 3-cifrede grupper er
  // tusindtal, og når begge tegn findes, er det sidste decimalseparator.
  // "1.234" læses derfor som 1234 (tysk tusindtal), ikke som 1.234.
  const germanElevation = germanMap.index.get('elevationGain')?.[0];
  const numberRow = Array(germanHeaders.headers.length).fill('');
  for (const [input, expected] of [
    ['1.234', 1234],
    ['2.345.678', 2_345_678],
    ['1.234,5', 1234.5],
    ['1,234.5', 1234.5],
    ['12,5', 12.5],
    ['10.5', 10.5],
    ['1,234', 1234],
    ['1,234,567', 1_234_567],
    ['0.123', 0.123],
    ['0,123', 0.123],
    ['-12,5', -12.5],
    ['.', null],
  ]) {
    numberRow[germanElevation] = input;
    check(`talformat ${input}`, num(numberRow, germanMap, 'elevationGain'), (v) => v === expected);
  }

  // issue #21 punkt 5: dansk tekstvarighed må ikke falde igennem til num(),
  // som skraber cifrene og gør "1 t 30 min" til 130 sekunder.
  const durationMap = mapColumns(parseCsv('Varighed\n'));
  for (const [input, expected] of [
    ['1 t 30 min', 5400],
    ['1 t 30 min.', 5400],
    ['45 min', 2700],
    ['45 min.', 2700],
    ['2101 s', 2101],
    ['2101 sek', 2101],
    ['1 h 30 m 15 s', 5415],
    ['1 h 30 s', 3630],
    ['2 h 45 s', 7245],
    ['1 time 5 sekunder', 3605],
    ['30 s', 30],
    ['1h30', 5400],
    ['2101.0', 2101],
    ['abc', null],
    ['abc123', null],
    ['2 t', 7200],
  ]) {
    check(`varighed ${input}`, durationSec([input], durationMap, 'elapsedSec'), (v) => v === expected);
  }

  // 3) Stravas FIT-filer har hvert felt i sin egen beseg: distance, puls
  //    og højde står i hver deres post med samme tidspunkt. Uden
  //    sammenlægning forsvinder de, og turen ender som 0,00 km.
  const split = pointsFromFitRecords([
    { timestamp: '2026-10-16T08:00:00.000Z', distance: 0 },
    { timestamp: '2026-10-16T08:00:00.000Z', heart_rate: 120 },
    { timestamp: '2026-10-16T08:00:00.000Z', enhanced_altitude: 10 },
    { timestamp: '2026-10-16T08:00:01.000Z', distance: 1000 },
    { timestamp: '2026-10-16T08:00:01.000Z', heart_rate: 130 },
    { timestamp: '2026-10-16T08:00:02.000Z', distance: 2000 },
    { timestamp: '2026-10-16T08:00:02.000Z', enhanced_altitude: 12 },
  ]);
  check('FIT-felter slås sammen pr. tidspunkt', split.length, (v) => v === 3);
  check('puls overføres fra sin egen besked', split[0]?.hr, (v) => v === 120);
  check('højde læses fra enhanced_altitude', split[2]?.altM, (v) => v === 12);
  check('distance interpoleres mellem målinger', split[1]?.distM, (v) => v === 1000);
  check('sidste distance bevares', split[2]?.distM, (v) => v === 2000);

  // Regression (issue #18): interpolation must stay bit-identical while the
  // neighbour search becomes linear. Values are asserted exactly, not against
  // another tree, because these numbers are the contract.
  const gapRecords = [
    { timestamp: '2026-10-16T08:00:00.000Z' },
    { timestamp: '2026-10-16T08:00:10.000Z', distance: 0 },
    { timestamp: '2026-10-16T08:00:20.000Z' },
    { timestamp: '2026-10-16T08:00:30.000Z', distance: 100 },
    { timestamp: '2026-10-16T08:00:40.000Z' },
    { timestamp: '2026-10-16T08:00:50.000Z', distance: 300 },
    { timestamp: '2026-10-16T08:01:00.000Z' },
    { timestamp: '2026-10-16T08:01:10.000Z' },
  ];
  check(
    'interpolation: leading/trailing gaps og midtpunkt er uændrede',
    pointsFromFitRecords(gapRecords).map((p) => p.distM),
    (v) => JSON.stringify(v) === JSON.stringify([0, 0, 50, 100, 200, 300, 300, 300]),
  );
  const singleKnown = pointsFromFitRecords([
    { timestamp: '2026-10-16T09:00:00.000Z' },
    { timestamp: '2026-10-16T09:00:10.000Z', distance: 42 },
    { timestamp: '2026-10-16T09:00:20.000Z' },
  ]);
  check(
    'interpolation: enkelt kendt distance klemmes til begge ender',
    singleKnown.map((p) => p.distM),
    (v) => JSON.stringify(v) === JSON.stringify([42, 42, 42]),
  );
  const lone = pointsFromFitRecords([{ timestamp: '2026-10-16T09:01:00.000Z' }]);
  check('interpolation: punkt uden naboer på nogen side giver 0', lone[0]?.distM, (v) => v === 0);

  const stepFixture = (count) => {
    const base = Date.parse('2026-10-16T08:00:00.000Z');
    const records = [];
    for (let i = 0; i < count; i++) {
      const record = { timestamp: new Date(base + i * 1000).toISOString() };
      if (i % 2 === 0) record.distance = i * 10;
      records.push(record);
    }
    return records;
  };
  const measureSteps = (count) => {
    let steps = 0;
    pointsFromFitRecords(stepFixture(count), {
      onStep: () => {
        steps++;
      },
    });
    return steps;
  };
  const stepsN = measureSteps(4000);
  const steps2N = measureSteps(8000);
  check('interpolation: antal sammenligninger vokser lineært', { stepsN, steps2N }, (v) =>
    v.stepsN > 0 && v.steps2N <= v.stepsN * 2.5,
  );

  // Regression (issue #18): resolveActivityEntry must not rebuild the entry
  // list for every CSV row. This stub keeps the real source semantics.
  const makeCountingSource = (entries) => ({
    label: `stub (${entries.length} entries)`,
    listCalls: 0,
    list() {
      this.listCalls += 1;
      return [...entries];
    },
    read: async () => Buffer.alloc(0),
    size: async () => 0,
    warnings: () => [],
    close: async () => {},
  });
  const stubEntries = ['export/activities.csv'];
  for (let i = 0; i < 25; i++) stubEntries.push(`export/activities/Run-${i}.gpx`);
  // Lower-precedence look-alikes for Run-0 so the order check below can fail
  // if the precedence changes: root + activities/ must win over activities/
  // (without root) and the bare path.
  stubEntries.push('activities/Run-0.gpx', 'Run-0.gpx');
  const stub = makeCountingSource(stubEntries);
  const stubResolved = [];
  for (let i = 0; i < 25; i++) stubResolved.push(resolveActivityEntry(stub, 'export/', `Run-${i}.gpx`));
  check('resolution: root + activities/ vinder i rækkefølgen', stubResolved[0], (v) => v === 'export/activities/Run-0.gpx');
  check('resolution: alle 25 rækker findes', stubResolved.every((v) => v != null), (v) => v === true);
  check('resolution: 25 rækker kalder list() O(1) gange', stub.listCalls, (v) => v <= 2);
  check(
    'resolution: basename-fallback finder en nestet sti',
    resolveActivityEntry(stub, 'export/', 'nested/Run-7.gpx'),
    (v) => v === 'export/activities/Run-7.gpx',
  );

  // 4) Dansk overskrift "Aktivitetsudstyr" (sko) må ikke forveksles med
  //    "Udstyr" (cykel-id) — ellers vises 30723737.0 som udstyr.
  const daCsv = parseCsv(
    [
      'Aktivitets-ID,Aktivitetsdato,Aktivitetsnavn,Aktivitetstype,Distance,Maks. puls,Gennemsnitlig puls,Relativ indsats,Samlet stigning,Udstyr,Aktivitetsudstyr,Filnavn',
      '1001,"12. okt. 2026, 06.32",Long run,Løb,10.0,174,156,92,41,30723737.0,Nike Vomero Plus,Run-1001.gpx',
    ].join('\n'),
  );
  const daMap = mapColumns(daCsv);
  const daRows = parseActivities(daCsv, daMap).activities;
  check('dansk "Aktivitetsudstyr" giver sko, ikke cykel-id', daRows[0]?.gear, (v) => v === 'Nike Vomero Plus');
  check('dansk "Samlet stigning" mappes som stigning', daRows[0]?.elevationGain, (v) => v === 41);
  check('dansk "Løb" er et løb', daRows[0]?.isRun, (v) => v === true);
  check('dansk "Distance" i km tolkes som meter', daRows[0]?.distanceM, (v) => v === 10_000);

  // 5) Baseline skal dække hele vinduet, ikke kun de løb der vises.
  const wide = renderMarkdown({
    sourceLabel: 'test',
    activitiesInExport: activities.length,
    runs: [{ row: activities[0], analysis: a }],
    baselineRuns: [0, 1, 2].map((i) => ({ row: activities[i], analysis: a })),
    baselineDays: 28,
    unmatchedHeaders: [],
    contextText: '',
    generatedAt: new Date('2026-10-13T08:00:00'),
    poolLabel: 'Løb',
  });
  check('baseline tæller hele vinduet', wide.includes('3 runs'), (v) => v === true);

  // 6) Pace-rundingen må ikke give 5:60
  check('pace 359,6 sek vises 6:00', fmtPace(359.6), (v) => v === '6:00/km');
  check('pace 360 sek vises 6:00', fmtPace(360), (v) => v === '6:00/km');
  check('pace 61 sek vises 1:01', fmtPace(61), (v) => v === '1:01/km');
  check('pace 0 vises som –', fmtPace(0), (v) => v === '–');
  check('varighed 0 vises som 0:00, ikke som manglende', fmtDuration(0), (v) => v === '0:00');
  check('manglende varighed vises som –', fmtDuration(null), (v) => v === '–');

  // Regression (issue #14): en track uden brugbar tid er "manglende", ikke
  // et rigtigt nul. CSV'ens Moving Time er tom, og UdenTid.gpx har ingen
  // punkter med tid, så Markdown må vise – og ikke 0:00.
  const noTimeTrack = parseActivityBuffer(
    'UdenTid.gpx',
    readFileSync(join(tmp, 'activities/UdenTid.gpx')),
  );
  const noTimeAnalysis = analyseRun(noTimeTrack);
  const degenRow = { ...activities[0], name: 'Degen', distanceM: 5000, movingSec: null };
  const degenMd = renderMarkdown({
    sourceLabel: 'test',
    activitiesInExport: 1,
    runs: [{ row: degenRow, analysis: noTimeAnalysis }],
    baselineDays: 28,
    unmatchedHeaders: [],
    contextText: '',
    generatedAt: new Date('2026-10-13T08:00:00'),
    poolLabel: 'Løb',
  });
  check('Markdown: track uden brugbar tid vises som –, ikke 0:00', degenMd, (v) =>
    v.includes('5.00 km · – · **–**') && !v.includes('5.00 km · 0:00'),
  );
  const zeroCsvRow = { ...degenRow, movingSec: 0 };
  const zeroCsvMd = renderMarkdown({
    sourceLabel: 'test',
    activitiesInExport: 1,
    runs: [{ row: zeroCsvRow, analysis: noTimeAnalysis }],
    baselineDays: 28,
    unmatchedHeaders: [],
    contextText: '',
    generatedAt: new Date('2026-10-13T08:00:00'),
    poolLabel: 'Løb',
  });
  check('Markdown: CSV Moving Time 0 vises fortsat som 0:00', zeroCsvMd, (v) =>
    v.includes('5.00 km · 0:00 · **–**'),
  );

  /* ---- agent-formatet (Del E) ---- */

  const agentRuns = [
    mkRun('2026-10-14T10:00:00Z', 'Tæppe', 8, 3200, 150, 170, 92, 40),
    mkRun('2026-10-16T10:00:00Z', 'Tæppe', 10, 4000, 155, 175, 88, 50),
    mkRun('2026-10-16T18:00:00Z', 'Tæppe', 5, 2000, 140, 160, 80, 30),
    // En uge tidligere, så ugeaggregatet har to uger at tælle
    mkRun('2026-10-08T10:00:00Z', 'Tæppe', 6, 2400, 145, 165, 70, 20),
  ];
  const agentOut = renderAgent({
    sourceLabel: 'test',
    activitiesInExport: 3,
    runsTotal: 3,
    runs: agentRuns,
    allRuns: agentRuns,
    detailCount: 1,
    baselineDays: 28,
    contextText: 'plan: 3 løb/uge',
    generatedAt: new Date('2026-10-17T08:00:00Z'),
    maxHr: 200,
    maxHrSource: 'flag',
    notes: [],
  });

  check('agent: har SCHEMA', agentOut.includes('## SCHEMA'), (v) => v === true);
  check('agent: har SIGNALS med tærskler', agentOut.includes('> 5 = aerobic capacity under pressure'), (v) => v === true);
  check('agent: én linje pr. løb', (agentOut.match(/^d=\d{4}-/gm) ?? []).length, (v) => v === 4);
  check('agent: nyeste løb først', agentOut.indexOf('2026-10-16T18') < agentOut.indexOf('2026-10-14'), (v) => v === true);
  check('agent: har WEEKS', agentOut.includes('## WEEKS'), (v) => v === true);
  check('agent: uge linje har antal løb', /w=2026-W42 r=3/.test(agentOut), (v) => v === true);
  check('agent: to uger tælles separat', /w=2026-W41 r=1/.test(agentOut), (v) => v === true);
  check('agent: har WINDOW', agentOut.includes('## WINDOW'), (v) => v === true);
  check('agent: har STATS', agentOut.includes('## STATS'), (v) => v === true);
  check('agent: STATS har total km', agentOut, (v) =>
    /^runs=4 km_total=29\.0 median_km=8\.00 without_analysis=0$/m.test(v),
  );
  check('agent: STATS har længste løb', agentOut, (v) =>
    /^longest_run=10\.00 km on 2026-10-16 \(Tæppe\)$/m.test(v),
  );
  check('agent: STATS har største pause', agentOut, (v) => /^max_gap=\d+(?:\.\d)? days/m.test(v));
  check('agent: kontekst er med', agentOut.includes('plan: 3 løb/uge'), (v) => v === true);
  check('agent: kun detaljerede løb får splits', (agentOut.match(/sp=\d+:/g) ?? []).length, (v) => v === 1);
  check('agent: load vægter zoner', /(?:^|\s)load=\d+(?:\s|$)/m.test(agentOut), (v) => v === true);
  check('agent: ingen dansk komma i decimal', !/km=\d+,\d/.test(agentOut), (v) => v === true);
  check('agent: feltnavne er konsistente', agentOut, (v) =>
    /^d=.*\space=.*\sdrift=.*\shalf=/m.test(v),
  );
  check('agent: notes-sektion findes', agentOut.includes('## NOTES'), (v) => v === true);

  // Uden --last er de viste løb og populationen de samme, så WEEKS,
  // WINDOW og STATS skal give præcis de samme tal som før ændringen.
  check('agent: WEEKS uændret uden --last', agentOut, (v) =>
    /^w=2026-W42 r=3 km=23\.0 t=9200 load=213 hr=148 without_analysis=0$/m.test(v) &&
    /^w=2026-W41 r=1 km=6\.0 t=2400 load=71 hr=145 without_analysis=0$/m.test(v),
  );
  check('agent: WINDOW uændret uden --last', agentOut, (v) =>
    /^recent: n=4 km=29\.0 t=11600 pace=400\.0 hr=148 load=284 z=3\.2,64\.5,32\.3,0\.0,0\.0 without_analysis=0$/m.test(v) &&
    /^previous: n=0 km=- t=- pace=- hr=- load=- z=- without_analysis=0$/m.test(v),
  );
  check('agent: STATS uændret uden --last', agentOut, (v) =>
    /^runs=4 km_total=29\.0 median_km=8\.00 without_analysis=0$/m.test(v),
  );
  check('agent: ingen talt/vist-note uden --last', agentOut, (v) =>
    !v.includes('shown (--last)'),
  );

  // Regression (issue #11): en manglende distance eller tid er ukendt, ikke
  // nul. Et rigtigt nul skal fortsat vises som nul, så de to må ikke smelte
  // sammen.
  const missingRun = mkRun('2026-10-15T10:00:00Z', 'Uden distance og tid', 5, 2000, 140, 160, 70, 20);
  missingRun.row.distanceM = null;
  missingRun.row.movingSec = null;
  const zeroRun = mkRun('2026-10-15T12:00:00Z', 'Nul distance og tid', 0, 0, 140, 160, 70, 20);
  const edgeOut = renderAgent({
    sourceLabel: 'test',
    activitiesInExport: 2,
    runsTotal: 2,
    runs: [missingRun, zeroRun],
    allRuns: [missingRun, zeroRun],
    detailCount: 1,
    baselineDays: 28,
    contextText: '',
    generatedAt: new Date('2026-10-17T08:00:00Z'),
    maxHr: 200,
    maxHrSource: 'flag',
    notes: [],
  });
  const runLineFor = (name) =>
    edgeOut.split('\n').find((line) => line.startsWith('d=') && line.includes(`n="${name}"`)) ?? '';
  const missingLine = runLineFor('Uden distance og tid');
  const zeroLine = runLineFor('Nul distance og tid');
  check('agent: manglende distance vises som -', missingLine, (v) => /(?:^|\s)km=-(?:\s|$)/.test(v));
  check('agent: manglende tid vises som -', missingLine, (v) => /(?:^|\s)t=-(?:\s|$)/.test(v));
  check('agent: manglende distance og tid bliver ikke 0', missingLine, (v) =>
    !/(?:^|\s)km=0\.00(?:\s|$)/.test(v) && !/(?:^|\s)t=0(?:\s|$)/.test(v),
  );
  check('agent: rigtig nul distance vises som 0.00', zeroLine, (v) => /(?:^|\s)km=0\.00(?:\s|$)/.test(v));
  check('agent: rigtig nul tid vises som 0', zeroLine, (v) => /(?:^|\s)t=0(?:\s|$)/.test(v));

  const missingOnlyOut = renderAgent({
    sourceLabel: 'test',
    activitiesInExport: 1,
    runsTotal: 1,
    runs: [missingRun],
    allRuns: [missingRun],
    detailCount: 1,
    baselineDays: 28,
    contextText: '',
    generatedAt: new Date('2026-10-17T08:00:00Z'),
    maxHr: 200,
    maxHrSource: 'flag',
    notes: [],
  });
  check('agent: STATS uden kendt distance og tid viser -', missingOnlyOut, (v) =>
    /^runs=1 km_total=- median_km=- without_analysis=0$/m.test(v) &&
    /^moving_time_total=- s$/m.test(v) &&
    !/^longest_run=/m.test(v),
  );
  check('agent: WINDOW og WEEKS uden kendt distance og tid viser -', missingOnlyOut, (v) =>
    /^recent: n=1 km=- t=- /m.test(v) && /^w=2026-W42 r=1 km=- t=- /m.test(v),
  );

  // Blandet population: kun ét løb har både distance og tid. Pace skal komme
  // fra det løb alene — ikke fra alle løbs tid delt med delsummen af km.
  const pacedRun = mkRun('2026-10-15T10:00:00Z', 'Med distance og tid', 10, 3000, 140, 160, 70, 20);
  const timeOnlyRun = mkRun('2026-10-16T10:00:00Z', 'Kun tid', 5, 1800, 140, 160, 70, 20);
  timeOnlyRun.row.distanceM = null;
  const mixedOut = renderAgent({
    sourceLabel: 'test',
    activitiesInExport: 2,
    runsTotal: 2,
    runs: [pacedRun, timeOnlyRun],
    allRuns: [pacedRun, timeOnlyRun],
    detailCount: 1,
    baselineDays: 28,
    contextText: '',
    generatedAt: new Date('2026-10-17T08:00:00Z'),
    maxHr: 200,
    maxHrSource: 'flag',
    notes: [],
  });
  check('agent: WINDOW-pace bruger kun løb med distance og tid', mixedOut, (v) =>
    /^recent: n=2 km=10\.0 t=4800 pace=300\.0 /m.test(v),
  );
  check('agent: WEEKS summerer kendte værdier i blandet population', mixedOut, (v) =>
    /^w=2026-W42 r=2 km=10\.0 t=4800 /m.test(v),
  );

  // Regression (issue #13): --last begrænser hvilke løb der BESKRIVES,
  // ikke hvilke løb WEEKS, WINDOW og STATS TÆLLER. Den gamle kode sendte
  // kun de viste løb til renderAgent, så "sidste 28 dage" blev et udsnit
  // og sammenligningen mod de 28 dage før blev usand.
  const population = [
    mkRun('2026-10-16T10:00:00Z', 'Nyeste', 10, 4000, 155, 175, 88, 50),
    mkRun('2026-10-14T10:00:00Z', 'Midterste', 8, 3200, 150, 170, 92, 40),
    // Uden for de seneste 28 dage, men inde i de 28 dage før dem.
    mkRun('2026-09-01T10:00:00Z', 'Gammel', 6, 2400, 145, 165, 70, 20),
  ];
  const lastOut = renderAgent({
    sourceLabel: 'test',
    activitiesInExport: 3,
    runsTotal: population.length,
    runs: population.slice(0, 1),
    allRuns: population,
    detailCount: 1,
    baselineDays: 28,
    contextText: '',
    generatedAt: new Date('2026-10-17T08:00:00Z'),
    maxHr: 200,
    maxHrSource: 'flag',
    notes: [],
  });
  check('agent --last: WEEKS tæller hele populationen', lastOut, (v) =>
    /^w=2026-W42 r=2 km=18\.0 t=7200 load=142 hr=153 without_analysis=0$/m.test(v) &&
    /^w=2026-W36 r=1 km=6\.0 t=2400 load=71 hr=145 without_analysis=0$/m.test(v),
  );
  check('agent --last: WINDOW recent tæller alle i vinduet', lastOut, (v) =>
    /^recent: n=2 km=18\.0 t=7200 pace=400\.0 hr=153 load=142 z=3\.2,64\.5,32\.3,0\.0,0\.0 without_analysis=0$/m.test(v),
  );
  check('agent --last: WINDOW previous tæller løb uden for vinduet', lastOut, (v) =>
    /^previous: n=1 km=6\.0 t=2400 pace=400\.0 hr=145 load=71 z=3\.2,64\.5,32\.3,0\.0,0\.0 without_analysis=0$/m.test(v),
  );
  check('agent --last: change beregnes på hele populationen', lastOut, (v) =>
    /^change: km=200\.0 % load=n\/a$/m.test(v),
  );
  check('agent --last: STATS tæller hele populationen', lastOut, (v) =>
    /^runs=3 km_total=24\.0 median_km=8\.00 without_analysis=0$/m.test(v),
  );
  check('agent --last: kun de viste løb får linjer', (lastOut.match(/^d=\d{4}-/gm) ?? []).length, (v) => v === 1);
  check('agent --last: NOTES siger talt mod vist', lastOut, (v) =>
    /^- 3 runs are counted in WEEKS, WINDOW and STATS; 1 run is shown \(--last\)\.$/m.test(v),
  );

  // Regression (issue #14): en uge med to løb, hvoraf det ene ikke har en
  // fil, må ikke se ud som om load dækker begge. WEEKS skal bære samme
  // without_analysis som WINDOW.
  const unanalysedWeekRun = mkRun('2026-10-15T10:00:00Z', 'Uden fil', 5, 1800, 150, 170, 80, 20);
  unanalysedWeekRun.analysis = null;
  const weekPopulation = [
    mkRun('2026-10-16T10:00:00Z', 'Analyseret', 5, 1800, 150, 170, 80, 20),
    unanalysedWeekRun,
  ];
  const weekOut = renderAgent({
    sourceLabel: 'test',
    activitiesInExport: 2,
    runsTotal: 2,
    runs: weekPopulation,
    allRuns: weekPopulation,
    detailCount: 1,
    baselineDays: 28,
    contextText: '',
    generatedAt: new Date('2026-10-17T08:00:00Z'),
    maxHr: 200,
    maxHrSource: 'flag',
    notes: [],
  });
  check('agent: WEEKS markerer løb uden analyse', weekOut, (v) =>
    /^w=2026-W42 r=2 km=10\.0 t=3600 load=71 hr=150 without_analysis=1$/m.test(v),
  );

  // Når begge vinduer har lige mange analyserede løb, er load-tallene
  // sammenlignelige, selv om without_analysis afviger. Det er det
  // analyserede antal — ikke antallet af ulæste løb — der afgør gaten.
  const unanalysedRecent = mkRun('2026-10-15T10:00:00Z', 'Uden fil', 5, 1800, 150, 170, 80, 20);
  unanalysedRecent.analysis = null;
  const changePopulation = [
    mkRun('2026-10-16T10:00:00Z', 'Nyeste', 10, 4000, 155, 175, 88, 50),
    unanalysedRecent,
    mkRun('2026-09-01T10:00:00Z', 'Gammel', 6, 2400, 145, 165, 70, 20),
  ];
  const changeOut = renderAgent({
    sourceLabel: 'test',
    activitiesInExport: 3,
    runsTotal: changePopulation.length,
    runs: changePopulation,
    allRuns: changePopulation,
    detailCount: 1,
    baselineDays: 28,
    contextText: '',
    generatedAt: new Date('2026-10-17T08:00:00Z'),
    maxHr: 200,
    maxHrSource: 'flag',
    notes: [],
  });
  check('agent: change viser load når det analyserede antal er ens', changeOut, (v) =>
    /^change: km=150\.0 % load=0\.0 %$/m.test(v),
  );

  // Regression (issue #14): to vinduer kan have samme antal ulæste løb og
  // alligevel forskelligt antal ANALYSEREDE løb. Load må først sammenlignes
  // når det analyserede antal er ens; ellers dækker de to load-tal hver sin
  // population, og en load-ændring kan være et artefakt af det.
  const mixedRecentUnanalysed = mkRun('2026-10-15T10:00:00Z', 'Uden fil', 5, 1800, 150, 170, 80, 20);
  mixedRecentUnanalysed.analysis = null;
  const mixedPreviousUnanalysed = mkRun('2026-09-02T10:00:00Z', 'Uden fil', 5, 1800, 150, 170, 80, 20);
  mixedPreviousUnanalysed.analysis = null;
  const mixedWindowPopulation = [
    mkRun('2026-10-16T10:00:00Z', 'Analyseret', 5, 1800, 150, 170, 80, 20),
    mixedRecentUnanalysed,
    mkRun('2026-10-14T10:00:00Z', 'Analyseret', 5, 1800, 150, 170, 80, 20),
    mkRun('2026-09-01T10:00:00Z', 'Gammel', 5, 1800, 150, 170, 80, 20),
    mixedPreviousUnanalysed,
  ];
  const mixedWindowOut = renderAgent({
    sourceLabel: 'test',
    activitiesInExport: mixedWindowPopulation.length,
    runsTotal: mixedWindowPopulation.length,
    runs: mixedWindowPopulation,
    allRuns: mixedWindowPopulation,
    detailCount: 1,
    baselineDays: 28,
    contextText: '',
    generatedAt: new Date('2026-10-17T08:00:00Z'),
    maxHr: 200,
    maxHrSource: 'flag',
    notes: [],
  });
  check('agent: change skjuler load når kun det analyserede antal afviger', mixedWindowOut, (v) =>
    /^recent: n=3 .* without_analysis=1$/m.test(v) &&
    /^previous: n=2 .* without_analysis=1$/m.test(v) &&
    /^change: km=50\.0 % load=n\/a$/m.test(v),
  );

  // Regression (issue #14, B1): et løb uden puls har en analyse, men
  // `zones == null`, så det bidrager ikke til load. Gaten, WEEKS, WINDOW og
  // STATS skal tælle det som without_analysis — ellers ser to vinduer lige
  // store ud, selv om kun det ene load-tal dækker alle løb.
  const noHrRecent = mkRun('2026-10-15T10:00:00Z', 'Uden puls', 5, 1800, 150, 170, 80, 20);
  noHrRecent.analysis.zones = null;
  noHrRecent.analysis.zonePct = null;
  const noHrPopulation = [
    mkRun('2026-10-16T10:00:00Z', 'Med puls', 5, 1800, 150, 170, 80, 20),
    noHrRecent,
    mkRun('2026-09-15T10:00:00Z', 'Med puls', 5, 1800, 150, 170, 80, 20),
    mkRun('2026-09-14T10:00:00Z', 'Med puls', 5, 1800, 150, 170, 80, 20),
  ];
  const noHrOut = renderAgent({
    sourceLabel: 'test',
    activitiesInExport: noHrPopulation.length,
    runsTotal: noHrPopulation.length,
    runs: noHrPopulation,
    allRuns: noHrPopulation,
    detailCount: 1,
    baselineDays: 28,
    contextText: '',
    generatedAt: new Date('2026-10-17T08:00:00Z'),
    maxHr: 190,
    maxHrSource: 'flag',
    notes: [],
  });
  check('agent: løb uden puls gør load ikke sammenlignelig i change', noHrOut, (v) =>
    /^recent: n=2 km=10\.0 t=3600 pace=360\.0 hr=150 load=71 z=3\.2,64\.5,32\.3,0\.0,0\.0 without_analysis=1$/m.test(v) &&
    /^previous: n=2 km=10\.0 t=3600 pace=360\.0 hr=150 load=142 z=3\.2,64\.5,32\.3,0\.0,0\.0 without_analysis=0$/m.test(v) &&
    /^change: km=0\.0 % load=n\/a$/m.test(v),
  );
  check('agent: løb uden puls tælles i WEEKS without_analysis', noHrOut, (v) =>
    /^w=2026-W42 r=2 km=10\.0 t=3600 load=71 hr=150 without_analysis=1$/m.test(v) &&
    /^w=2026-W38 r=2 km=10\.0 t=3600 load=142 hr=150 without_analysis=0$/m.test(v),
  );
  check('agent: løb uden puls tælles i STATS without_analysis', noHrOut, (v) =>
    /^runs=4 km_total=20\.0 median_km=5\.00 without_analysis=1$/m.test(v),
  );

  // Kontrol: samme population, men løbet har puls og dermed zoner. Så har
  // begge vinduer to load-bidrag, og change skal vise et load-tal.
  const noHrControl = mkRun('2026-10-15T10:00:00Z', 'Med puls', 5, 1800, 150, 170, 80, 20);
  const noHrControlPopulation = [
    mkRun('2026-10-16T10:00:00Z', 'Med puls', 5, 1800, 150, 170, 80, 20),
    noHrControl,
    mkRun('2026-09-15T10:00:00Z', 'Med puls', 5, 1800, 150, 170, 80, 20),
    mkRun('2026-09-14T10:00:00Z', 'Med puls', 5, 1800, 150, 170, 80, 20),
  ];
  const noHrControlOut = renderAgent({
    sourceLabel: 'test',
    activitiesInExport: noHrControlPopulation.length,
    runsTotal: noHrControlPopulation.length,
    runs: noHrControlPopulation,
    allRuns: noHrControlPopulation,
    detailCount: 1,
    baselineDays: 28,
    contextText: '',
    generatedAt: new Date('2026-10-17T08:00:00Z'),
    maxHr: 190,
    maxHrSource: 'flag',
    notes: [],
  });
  check('agent: change viser load når begge vinduer har lige mange load-bidrag', noHrControlOut, (v) =>
    /^change: km=0\.0 % load=0\.0 %$/m.test(v),
  );

  // Det modsatte tilfælde: lige mange analyserede løb i begge vinduer. Så
  // er load-tallene sammenlignelige, og change må vise et load-tal.
  const equalWindowPopulation = [
    mkRun('2026-10-16T10:00:00Z', 'Nyeste', 10, 4000, 155, 175, 88, 50),
    mkRun('2026-10-14T10:00:00Z', 'Midterste', 5, 2000, 150, 170, 80, 40),
    mkRun('2026-09-01T10:00:00Z', 'Gammel', 6, 2400, 145, 165, 70, 20),
    mkRun('2026-09-03T10:00:00Z', 'Gammel', 6, 2400, 145, 165, 70, 20),
  ];
  const equalWindowOut = renderAgent({
    sourceLabel: 'test',
    activitiesInExport: equalWindowPopulation.length,
    runsTotal: equalWindowPopulation.length,
    runs: equalWindowPopulation,
    allRuns: equalWindowPopulation,
    detailCount: 1,
    baselineDays: 28,
    contextText: '',
    generatedAt: new Date('2026-10-17T08:00:00Z'),
    maxHr: 200,
    maxHrSource: 'flag',
    notes: [],
  });
  check('agent: change viser load når begge vinduer har lige mange analyserede løb', equalWindowOut, (v) =>
    /^change: km=25\.0 % load=0\.0 %$/m.test(v),
  );

  // Ugentlig load kan kun læses som en risiko når begge uger er fuldt
  // analyserede. Ellers kan en "stigning" være et løb uden sporanalyse.
  const weekJumpUnanalysed = mkRun('2026-10-07T10:00:00Z', 'Uden fil', 5, 1800, 150, 170, 80, 20);
  weekJumpUnanalysed.analysis = null;
  const weekJumpPopulation = [
    mkRun('2026-10-16T10:00:00Z', 'W42a', 5, 1800, 150, 170, 80, 20),
    mkRun('2026-10-15T10:00:00Z', 'W42b', 5, 1800, 150, 170, 80, 20),
    mkRun('2026-10-14T10:00:00Z', 'W42c', 5, 1800, 150, 170, 80, 20),
    mkRun('2026-10-08T10:00:00Z', 'W41a', 5, 1800, 150, 170, 80, 20),
    weekJumpUnanalysed,
  ];
  const weekJumpOut = renderAgent({
    sourceLabel: 'test',
    activitiesInExport: weekJumpPopulation.length,
    runsTotal: weekJumpPopulation.length,
    runs: weekJumpPopulation,
    allRuns: weekJumpPopulation,
    detailCount: 1,
    baselineDays: 28,
    contextText: '',
    generatedAt: new Date('2026-10-17T08:00:00Z'),
    maxHr: 200,
    maxHrSource: 'flag',
    notes: [],
  });
  check('agent: WEEKS viser forskellig without_analysis i de to uger', weekJumpOut, (v) =>
    /^w=2026-W42 r=3 km=15\.0 t=5400 load=213 hr=150 without_analysis=0$/m.test(v) &&
    /^w=2026-W41 r=2 km=10\.0 t=3600 load=71 hr=150 without_analysis=1$/m.test(v),
  );
  check('agent: SIGNALS kvalificerer ugentlig load-sammenligning', weekJumpOut, (v) =>
    /^load: .*only when both weeks have without_analysis=0 \(every run has a load\/z contribution\); then a jump > 20 % is a load risk\.$/m.test(v),
  );

  // SCHEMA skal forklare felterne der faktisk skrives: without_analysis i
  // alle tre sektioner, at load/z kun dækker løb med et load-bidrag, og hvad
  // change-linjen gør ved forskellige populationer.
  check('agent: SCHEMA forklarer without_analysis i WEEKS', weekOut, (v) =>
    /^week fields: .*without_analysis=runs with no load\/z contribution$/m.test(v),
  );
  check('agent: SCHEMA forklarer without_analysis i STATS', weekOut, (v) =>
    /^stats fields: .*without_analysis=runs with no load\/z contribution/m.test(v),
  );
  check('agent: SCHEMA forklarer at load og z kun dækker løb med bidrag', weekOut, (v) =>
    /^load and zone fields .*cover only runs with a load\/z contribution/m.test(v),
  );
  check('agent: SCHEMA forklarer hvad n, km, t og pace dækker', weekOut, (v) =>
    /^n counts every run in the window; km sums the runs whose km is not missing; t sums the runs whose t is not missing; pace uses only runs with km > 0 and a time, so t\/km can differ from pace\.$/m.test(v),
  );
  check('agent: SCHEMA stats-feltlisten har drift_min og drift_max', weekOut, (v) =>
    /^stats fields: .*drift_avg \| drift_min \| drift_max \| zone_total_pct \| moving_time_total$/m.test(v),
  );
  check('agent: SCHEMA forklarer change ved forskellige populationer', changeOut, (v) =>
    /^change: .*load=n\/a.*different populations/m.test(v),
  );

  // Vinduesgrænserne: recent bruger `> cutoff`, previous bruger
  // `<= cutoff && > cutoff - 28 dage`. Løbet præcis på cutoff hører derfor
  // til previous, og et løb ældre end begge vinduer tælles ingen steder.
  const boundaryNewest = new Date('2026-10-16T10:00:00Z');
  const boundaryCutoff = new Date(boundaryNewest.getTime() - 28 * 86_400_000);
  const boundaryPopulation = [
    mkRun(boundaryNewest.toISOString(), 'Nyeste', 10, 4000, 155, 175, 88, 50),
    mkRun(boundaryCutoff.toISOString(), 'Præcis cutoff', 8, 3200, 150, 170, 92, 40),
    // 60 dage gammelt: uden for både recent og previous.
    mkRun(new Date(boundaryNewest.getTime() - 60 * 86_400_000).toISOString(), 'For gammel', 6, 2400, 145, 165, 70, 20),
  ];
  const boundaryOut = renderAgent({
    sourceLabel: 'test',
    activitiesInExport: 3,
    runsTotal: boundaryPopulation.length,
    runs: boundaryPopulation,
    allRuns: boundaryPopulation,
    detailCount: 1,
    baselineDays: 28,
    contextText: '',
    generatedAt: new Date('2026-10-17T08:00:00Z'),
    maxHr: 200,
    maxHrSource: 'flag',
    notes: [],
  });
  check('agent: løb præcis på cutoff tælles ikke i recent (recent bruger >)', boundaryOut, (v) =>
    /recent: n=1 km=10\.0 /.test(v),
  );
  check('agent: løb præcis på cutoff tælles i previous', boundaryOut, (v) =>
    /previous: n=1 km=8\.0 /.test(v),
  );
  check('agent: løb ældre end 56 dage tælles hverken i recent eller previous', boundaryOut, (v) => {
    const recent = v.match(/^recent: .*$/m)?.[0] ?? '';
    const previous = v.match(/^previous: .*$/m)?.[0] ?? '';
    return /n=1 km=10\.0 /.test(recent) && /n=1 km=8\.0 /.test(previous);
  });

  /* ---- regression (issue #16): unsafe zip entry names and entry size ---- */

  function buildZip(entries) {
    const localParts = [];
    const centralParts = [];
    let offset = 0;
    for (const entry of entries) {
      const name = Buffer.from(entry.name, 'utf8');
      const data = entry.compressed ?? Buffer.from(entry.data ?? '');
      const method = entry.compressionMethod ?? 0;
      const uncompressedSize =
        entry.uncompressedSize ?? (entry.data != null ? Buffer.byteLength(entry.data) : data.length);
      const crc = entry.crc ?? crc32(data);

      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0x0800, 6);
      local.writeUInt16LE(method, 8);
      local.writeUInt32LE(crc >>> 0, 14);
      local.writeUInt32LE(data.length, 18);
      local.writeUInt32LE(uncompressedSize, 22);
      local.writeUInt16LE(name.length, 26);
      localParts.push(local, name, data);

      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(20, 4);
      central.writeUInt16LE(20, 6);
      central.writeUInt16LE(0x0800, 8);
      central.writeUInt16LE(method, 10);
      central.writeUInt32LE(crc >>> 0, 16);
      central.writeUInt32LE(data.length, 20);
      central.writeUInt32LE(uncompressedSize, 24);
      central.writeUInt16LE(name.length, 28);
      central.writeUInt32LE(offset, 42);
      centralParts.push(central, name);

      offset += 30 + name.length + data.length;
    }
    const localPart = Buffer.concat(localParts);
    const centralPart = Buffer.concat(centralParts);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(centralPart.length, 12);
    eocd.writeUInt32LE(localPart.length, 16);
    return Buffer.concat([localPart, centralPart, eocd]);
  }

  function replaceZipEntryName(zip, from, to) {
    const fromBytes = Buffer.from(from, 'utf8');
    const toBytes = Buffer.from(to, 'utf8');
    if (fromBytes.length !== toBytes.length) {
      throw new Error(`zip entry names must have the same length: ${from} != ${to}`);
    }
    const out = Buffer.from(zip);
    let index = 0;
    let replacements = 0;
    while ((index = out.indexOf(fromBytes, index)) !== -1) {
      toBytes.copy(out, index);
      index += toBytes.length;
      replacements++;
    }
    if (!replacements) throw new Error(`zip entry name not found: ${from}`);
    return out;
  }

  function compressZeros(createStream, uncompressedBytes) {
    return new Promise((resolve, reject) => {
      const stream = createStream();
      const chunks = [];
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
      const chunk = Buffer.alloc(1024 * 1024);
      let remaining = uncompressedBytes;
      const pump = () => {
        while (remaining > 0) {
          const size = Math.min(remaining, chunk.length);
          remaining -= size;
          if (!stream.write(size === chunk.length ? chunk : chunk.subarray(0, size))) {
            stream.once('drain', pump);
            return;
          }
        }
        stream.end();
      };
      pump();
    });
  }

  const deflateBomb = (uncompressedBytes) => compressZeros(createDeflateRaw, uncompressedBytes);
  const gzipBomb = (uncompressedBytes) => compressZeros(createGzip, uncompressedBytes);

  const fixtureZip = buildZip([
    { name: 'activities.csv', data: readFileSync(join(tmp, 'activities.csv')) },
    { name: 'activities/Run-1001.gpx', data: readFileSync(join(tmp, 'activities/Run-1001.gpx')) },
    { name: 'activities/Run-1002.tcx', data: readFileSync(join(tmp, 'activities/Run-1002.tcx')) },
    { name: 'activities/Run-1003.gpx', data: readFileSync(join(tmp, 'activities/Run-1003.gpx')) },
    { name: 'decoy-file.fit', data: 'decoy' },
    { name: 'placeholder', data: 'decoy' },
    { name: 'decoy11.fit', data: 'decoy' },
  ]);

  const writeZip = (name, buffer) => {
    const dir = scratch(name);
    const file = join(dir, 'export.zip');
    writeFileSync(file, buffer);
    return file;
  };
  const runZipCli = (args) => {
    try {
      return {
        status: 0,
        stdout: execFileSync(process.execPath, [join(repoRoot, 'src', 'cli.ts'), ...args], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
        stderr: '',
      };
    } catch (err) {
      return {
        status: err.status ?? null,
        stdout: String(err.stdout ?? ''),
        stderr: String(err.stderr ?? ''),
      };
    }
  };
  const parseJson = (text) => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  };
  // A single path argument must still work unchanged after flag parsing was
  // made strict.
  const pathOnlyRun = runZipCli([writeZip('zip-path-only', fixtureZip)]);
  check('zip: export.zip som eneste argument virker uændret', pathOnlyRun.status, (v) => v === 0);
  check('zip: export.zip som eneste argument giver agent-format', pathOnlyRun.stdout, (v) =>
    v.includes('# STRAVA DIGEST v2 (agent-format)'),
  );
  const skippedNote = (n) =>
    n === 1
      ? '1 entry in the archive was skipped because its name is not a safe relative path.'
      : `${n} entries in the archive were skipped because their names are not safe relative paths.`;

  const badName = writeZip(
    'zip-bad-name',
    replaceZipEntryName(fixtureZip, 'decoy-file.fit', '../../evil.fit'),
  );
  const badNameRun = runZipCli([badName]);
  check('zip: unsafe entry name does not kill the archive', badNameRun.status, (v) => v === 0);
  check('zip: unsafe entry name still gives a digest', badNameRun.stdout, (v) =>
    v.includes('# STRAVA DIGEST v2 (agent-format)') && /^d=\d{4}-/m.test(v) && /^runs=3 /m.test(v),
  );
  check('zip: skipped entry is reported in NOTES', badNameRun.stdout, (v) =>
    v.includes(`- ${skippedNote(1)}`),
  );
  check('zip: unsafe entry name is not leaked into the digest', badNameRun.stdout, (v) =>
    !v.includes('evil.fit'),
  );

  const badNameJson = parseJson(runZipCli([badName, '--json']).stdout);
  check('zip: skipped entry is in JSON notes', badNameJson?.notes ?? null, (v) =>
    Array.isArray(v) && v.includes(skippedNote(1)),
  );
  check('zip: skipped entry is in JSON markdown', badNameJson?.markdown ?? null, (v) =>
    typeof v === 'string' && v.includes(`- ${skippedNote(1)}`),
  );
  check('zip: skipped entry is in Markdown notes', runZipCli([badName, '--format', 'md']).stdout, (v) =>
    v.includes(`- ${skippedNote(1)}`),
  );

  const cleanZip = writeZip('zip-clean', fixtureZip);
  const cleanRun = runZipCli([cleanZip]);
  check('zip: clean archive still gives a digest', cleanRun.status, (v) => v === 0);
  check('zip: clean archive has no skipped-entry note', cleanRun.stdout, (v) =>
    !v.includes(skippedNote(1)) && !v.includes(skippedNote(2)),
  );
  const cleanJson = parseJson(runZipCli([cleanZip, '--json']).stdout);
  check('zip: clean JSON notes have no skipped-entry note', cleanJson?.notes ?? null, (v) =>
    Array.isArray(v) && !v.some((note) => note.includes('skipped because')),
  );
  check('zip: clean Markdown has no skipped-entry note', runZipCli([cleanZip, '--format', 'md']).stdout, (v) =>
    !v.includes('skipped because'),
  );

  /* ---- regression (issue #25): the measurement script must count bytes ---- */

  const multibyteName = 'Long run · test';
  const multibyteZip = writeZip(
    'zip-multibyte',
    buildZip([
      {
        name: 'activities.csv',
        data: Buffer.from(
          readFileSync(join(tmp, 'activities.csv'), 'utf8').replace('Long run', multibyteName),
        ),
      },
      { name: 'activities/Run-1001.gpx', data: readFileSync(join(tmp, 'activities/Run-1001.gpx')) },
      { name: 'activities/Run-1002.tcx', data: readFileSync(join(tmp, 'activities/Run-1002.tcx')) },
      { name: 'activities/Run-1003.gpx', data: readFileSync(join(tmp, 'activities/Run-1003.gpx')) },
    ]),
  );
  const multibyteDigest = execFileSync(process.execPath, [cliPath, multibyteZip], {
    encoding: 'utf8',
    cwd: tmp,
  });
  check('measure: fixture digest contains multi-byte characters', multibyteDigest, (v) =>
    utf8Bytes(v) !== v.length && v.includes(multibyteName),
  );
  const multibyteMeasure = execFileSync(
    process.execPath,
    [join(repoRoot, 'scripts', 'measure-compression.mjs'), multibyteZip],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const printedDigestBytes = Number(multibyteMeasure.match(/digest\s+.*?\((\d+) bytes\)/)?.[1]);
  check('measure: digest byte figure is the byte count, not the character count', printedDigestBytes, (v) =>
    v === utf8Bytes(multibyteDigest) && v !== multibyteDigest.length,
  );

  const declaredTooLarge = writeZip(
    'zip-declared-too-large',
    buildZip([
      {
        name: 'activities.csv',
        data: Buffer.from('Activity ID\n'),
        uncompressedSize: 250 * 1024 * 1024,
      },
    ]),
  );
  const declaredTooLargeRun = runZipCli([declaredTooLarge]);
  check('zip: declared oversize entry exits non-zero', declaredTooLargeRun.status, (v) => v !== 0);
  check('zip: declared oversize entry has a clear message', declaredTooLargeRun.stderr, (v) =>
    v.includes(
      'activities.csv is 250 MB, which is larger than the 100 MB limit for export files — a Strava export does not ship export files that size.',
    ),
  );
  check('zip: declared oversize error is not a stack trace', declaredTooLargeRun.stderr, (v) =>
    !/^\s+at /m.test(v),
  );

  const bomb = await deflateBomb(101 * 1024 * 1024);
  const lyingTooLarge = writeZip(
    'zip-lying-size',
    buildZip([
      {
        name: 'activities.csv',
        compressed: bomb,
        compressionMethod: 8,
        uncompressedSize: 1024,
        crc: 0,
      },
    ]),
  );
  const lyingTooLargeRun = runZipCli([lyingTooLarge]);
  check('zip: actual bytes over the limit abort the read', lyingTooLargeRun.status, (v) => v !== 0);
  check('zip: actual bytes over the limit give a clear message', lyingTooLargeRun.stderr, (v) =>
    /activities\.csv is \d+(?:\.\d+)? MB, which is larger than the 100 MB limit for export files — a Strava export does not ship export files that size\./.test(v),
  );
  check('zip: actual-size error is not a stack trace', lyingTooLargeRun.stderr, (v) =>
    !/^\s+at /m.test(v),
  );

  let absoluteZip = replaceZipEntryName(fixtureZip, 'placeholder', '/etc/passwd');
  absoluteZip = replaceZipEntryName(absoluteZip, 'decoy11.fit', 'C:/evil.fit');
  const absoluteRun = runZipCli([writeZip('zip-absolute', absoluteZip)]);
  check('zip: absolute entry names do not kill the archive', absoluteRun.status, (v) => v === 0);
  check('zip: absolute entry names are reported', absoluteRun.stdout, (v) =>
    v.includes(`- ${skippedNote(2)}`),
  );
  check('zip: absolute paths are not leaked into the digest', absoluteRun.stdout, (v) =>
    !v.includes('/etc/passwd') && !v.includes('C:/evil.fit'),
  );

  const uncZip = replaceZipEntryName(fixtureZip, 'decoy-file.fit', '\\\\server\\share');
  const uncRun = runZipCli([writeZip('zip-unc', uncZip)]);
  check('zip: UNC entry name does not kill the archive', uncRun.status, (v) => v === 0);
  check('zip: UNC entry name is reported', uncRun.stdout, (v) =>
    v.includes(`- ${skippedNote(1)}`),
  );

  /* ---- regression (issue #16): gzip output must respect the entry limit ---- */

  // The zip limit only covers the bytes in the zip entry. An older export can
  // store a `.gz` file, and that gzip payload can expand far past the limit.
  const gzFixture = readFileSync(join(tmp, 'activities', 'Run-1001.gpx'));
  const plainGzTrack = parseActivityBuffer('Good.gpx', gzFixture);
  const normalGzTrack = parseActivityBuffer('Good.gpx.gz', gzipSync(gzFixture));
  check('gz: normal gzip file still parses', normalGzTrack.points.length, (v) =>
    v === plainGzTrack.points.length,
  );
  check('gz: normal gzip file keeps the same distance', normalGzTrack.points.at(-1)?.distM, (v) =>
    v === plainGzTrack.points.at(-1)?.distM,
  );

  const mislabelledTrack = parseActivityBuffer('Mislabelled.gpx.gz', gzFixture);
  check('gz: non-gzip file still falls back to the raw bytes', mislabelledTrack.points.length, (v) =>
    v === plainGzTrack.points.length,
  );

  const thrownMessage = (fn) => {
    try {
      fn();
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };

  const corruptGz = Buffer.from(gzipSync(gzFixture));
  corruptGz.fill(0xff, 10, corruptGz.length - 8);
  check('gz: corrupt body is an honest error', thrownMessage(() => parseActivityBuffer('Corrupt.gpx.gz', corruptGz)), (v) =>
    v === 'Corrupt.gpx.gz is a corrupt gzip file',
  );

  const truncatedGz = gzipSync(gzFixture).subarray(0, 20);
  check('gz: truncated file is an honest error', thrownMessage(() => parseActivityBuffer('Truncated.gpx.gz', truncatedGz)), (v) =>
    v === 'Truncated.gpx.gz is a corrupt gzip file',
  );

  /* ---- regression (issue #16): activity files have their own limit ---- */

  const activityCsv = Buffer.from(
    [
      csvHeader,
      '1,"Oct 12, 2026, 6:32:10 AM",Good,Løb,1800,1800,5.0,170,150,Good.gpx',
      '2,"Oct 11, 2026, 6:32:10 AM",Big,Løb,1800,1800,5.0,170,150,Big.fit',
    ].join('\n') + '\n',
  );

  const bigFitZip = writeZip(
    'zip-big-fit',
    buildZip([
      { name: 'activities.csv', data: activityCsv },
      { name: 'activities/Good.gpx', data: gzFixture },
      {
        name: 'activities/Big.fit',
        compressed: await deflateBomb(12 * 1024 * 1024),
        compressionMethod: 8,
        uncompressedSize: 12 * 1024 * 1024,
        crc: 0,
      },
    ]),
  );
  const bigFitRun = runZipCli([bigFitZip]);
  check('zip: 12 MB activity file does not kill the run', bigFitRun.status, (v) => v === 0);
  check('zip: 12 MB activity file becomes one row error', bigFitRun.stdout, (v) =>
    v.includes(
      'err="activities/Big.fit is 12 MB, which is larger than the 10 MB limit for activity files — a Strava export does not ship activity files that size."',
    ),
  );
  check('zip: other runs are still analysed next to a too-large file', bigFitRun.stdout, (v) =>
    /^d=\S+ n="Good" km=5\.00 /m.test(v),
  );

  const hugeFitBytes = Math.floor(98.7 * 1024 * 1024);
  const hugeFitZip = writeZip(
    'zip-huge-fit',
    buildZip([
      { name: 'activities.csv', data: activityCsv },
      { name: 'activities/Good.gpx', data: gzFixture },
      {
        name: 'activities/Big.fit',
        compressed: await deflateBomb(hugeFitBytes),
        compressionMethod: 8,
        uncompressedSize: hugeFitBytes,
        crc: 0,
      },
    ]),
  );
  const hugeFitRun = runZipCli([hugeFitZip]);
  check('zip: 98.7 MB activity file does not kill the run', hugeFitRun.status, (v) => v === 0);
  check('zip: 98.7 MB activity file becomes one row error', hugeFitRun.stdout, (v) =>
    v.includes(
      'err="activities/Big.fit is 98.7 MB, which is larger than the 10 MB limit for activity files — a Strava export does not ship activity files that size."',
    ),
  );
  check('zip: 98.7 MB activity file still gives the rest of the digest', hugeFitRun.stdout, (v) =>
    /^d=\S+ n="Good" km=5\.00 /m.test(v),
  );

  // issue #21 punkt 3: formatet afgøres af den sidste filendelse.
  check('format: tur.fitness.gpx er GPX', activityFormatOf('tur.fitness.gpx'), (v) => v === 'gpx');
  const safeTrack = (name, buf) => {
    try {
      return parseActivityBuffer(name, buf);
    } catch {
      return null;
    }
  };
  const fitnessTrack = safeTrack('tur.fitness.gpx', gzFixture);
  check('format: tur.fitness.gpx parses som GPX med punkter', {
    source: fitnessTrack?.source ?? null,
    points: fitnessTrack?.points.length ?? null,
  }, (v) => v.source === 'gpx' && v.points > 0);
  check('format: tur.fit er FIT', activityFormatOf('tur.fit'), (v) => v === 'fit');
  check('format: tur.fit.gz er FIT', activityFormatOf('tur.fit.gz'), (v) => v === 'fit');
  check('format: tur.fit parses som FIT', safeTrack('tur.fit', fitBuffer)?.points.length ?? null, (v) => v === 14);
  check('format: tur.fit.gz parses som FIT', safeTrack('tur.fit.gz', gzipSync(fitBuffer))?.points.length ?? null, (v) => v === 14);
  check('format: Big.fit.csv er ikke FIT', activityFormatOf('Big.fit.csv'), (v) => v === null);
  check('format: Big.fit.csv giver unknown activity format', thrownMessage(() => parseActivityBuffer('Big.fit.csv', fitBuffer)), (v) =>
    v === 'unknown activity format: Big.fit.csv',
  );

  // issue #21 punkt 6: lat/lon-rækkefølgen i <trkpt> må være ligegyldig.
  const latFirstXml = gzFixture.toString('utf8');
  const lonFirstXml = latFirstXml.replace(
    /<trkpt lat="([^"]+)" lon="([^"]+)"/g,
    '<trkpt lon="$2" lat="$1"',
  );
  const latFirstTrack = parseActivityBuffer('LatFirst.gpx', Buffer.from(latFirstXml));
  const lonFirstTrack = parseActivityBuffer('LonFirst.gpx', Buffer.from(lonFirstXml));
  check('GPX: lon før lat giver samme punkter', {
    n: lonFirstTrack.points.length,
    first: lonFirstTrack.points[0]?.t.getTime(),
    last: lonFirstTrack.points[lonFirstTrack.points.length - 1]?.t.getTime(),
    dist: lonFirstTrack.points[lonFirstTrack.points.length - 1]?.distM,
  }, (v) =>
    v.n === latFirstTrack.points.length &&
    v.n > 0 &&
    v.first === latFirstTrack.points[0]?.t.getTime() &&
    v.last === latFirstTrack.points[latFirstTrack.points.length - 1]?.t.getTime() &&
    v.dist === latFirstTrack.points[latFirstTrack.points.length - 1]?.distM,
  );

  // issue #21 repair: `data-lat`/`data-lon` must not be read as `lat`/`lon`.
  // `\b` also matches at `-`, so the old extractor picked the wrong attribute.
  const dataAttrXml = `<?xml version="1.0"?>\n<gpx version="1.1" creator="fixture"><trk><name>DataLat</name><type>running</type><trkseg><trkpt data-lat="99" lat="56.1" data-lon="99" lon="10.1"><ele>20</ele><time>2026-10-11T07:00:00Z</time></trkpt></trkseg></trk></gpx>\n`;
  const dataAttrTrack = parseActivityBuffer('DataLat.gpx', Buffer.from(dataAttrXml));
  check('GPX: data-lat/data-lon skygges ikke over lat/lon', {
    n: dataAttrTrack.points.length,
    lat: dataAttrTrack.points[0]?.lat ?? null,
    lon: dataAttrTrack.points[0]?.lon ?? null,
  }, (v) => v.n === 1 && v.lat === 56.1 && v.lon === 10.1);
  const dataOnlyXml = `<?xml version="1.0"?>\n<gpx version="1.1" creator="fixture"><trk><name>DataOnly</name><type>running</type><trkseg><trkpt data-lat="99" data-lon="99"><ele>20</ele><time>2026-10-11T07:00:00Z</time></trkpt></trkseg></trk></gpx>\n`;
  check('GPX: kun data-lat/data-lon giver ingen punkter', safeTrack('DataOnly.gpx', Buffer.from(dataOnlyXml))?.points.length ?? null, (v) => v === 0);

  // The limit and the parser must answer "is this an activity file?" the same
  // way. Only the last suffix decides, so a mid-name `.fit` is not an activity
  // file and falls through to the other-files rule.
  // Expected values are pinned per name. A weakened suffix rule (`includes`
  // instead of the last suffix) makes Big.fit.bak and Big.fit (1).gz FIT, so
  // these assertions fail. Big.FIT.GZ pins case folding plus the `.gz` suffix.
  const bypassNames = [
    { name: 'Big.fit.bak', format: null },
    { name: 'Big.fit (1).gz', format: null },
    { name: 'Big.FIT.GZ', format: 'fit' },
    { name: 'Big.fit.gz.bak', format: null },
  ];
  for (const { name, format } of bypassNames) {
    const kind = format === 'fit' ? 'activity files' : 'other files';
    check(`format: ${name} follows its last suffix`, activityFormatOf(name), (v) =>
      v === format,
    );
    check(`limit: ${name} follows its format`, limitForFileName(name), (v) =>
      v === ACTIVITY_FILE_LIMIT_BYTES,
    );
    check(`error: ${name} names the ${kind} limit`, tooLargeError(name, hugeFitBytes).message, (v) =>
      v.includes(`10 MB limit for ${kind}`),
    );
  }
  check('format: a plain .fit is FIT', activityFormatOf('Good.fit'), (v) => v === 'fit');
  check('format: a plain .gpx is GPX', activityFormatOf('Good.gpx'), (v) => v === 'gpx');
  check('format: a .tcx.gz is TCX', activityFormatOf('Good.tcx.gz'), (v) => v === 'tcx');
  check('format: a CSV is not an activity', activityFormatOf('activities.csv'), (v) => v === null);
  check('limit: a CSV keeps the export limit', limitForFileName('activities.csv'), (v) =>
    v === EXPORT_FILE_LIMIT_BYTES,
  );
  check('limit: an unknown file gets the low limit', limitForFileName('media/photo.jpg'), (v) =>
    v === ACTIVITY_FILE_LIMIT_BYTES,
  );
  // The parser and the limit must agree that a mid-name `.fit` is unknown.
  check('parser and limit agree on a mid-name .fit', {
    format: activityFormatOf('Good.fit.bak'),
    limit: limitForFileName('Good.fit.bak'),
    parse: thrownMessage(() => parseActivityBuffer('Good.fit.bak', fitBuffer)),
  }, (v) =>
    v.format === null &&
    v.limit === ACTIVITY_FILE_LIMIT_BYTES &&
    v.parse === 'unknown activity format: Good.fit.bak',
  );

  // A `.csv` suffix is the real format. `Big.fit.csv` is not FIT, so no parser
  // accepts it and the row fails before the read; its CSV suffix still gives it
  // the 100 MB export limit.
  check('format: Big.fit.csv is not FIT', activityFormatOf('Big.fit.csv'), (v) => v === null);
  check('limit: Big.fit.csv keeps the export limit', limitForFileName('Big.fit.csv'), (v) =>
    v === EXPORT_FILE_LIMIT_BYTES,
  );
  check('format: Big.gpx.csv is not GPX', activityFormatOf('Big.gpx.csv'), (v) => v === null);
  check('limit: Big.gpx.csv keeps the export limit', limitForFileName('Big.gpx.csv'), (v) =>
    v === EXPORT_FILE_LIMIT_BYTES,
  );
  check('format: Big.tcx.csv is not TCX', activityFormatOf('Big.tcx.csv'), (v) => v === null);
  check('limit: Big.tcx.csv keeps the export limit', limitForFileName('Big.tcx.csv'), (v) =>
    v === EXPORT_FILE_LIMIT_BYTES,
  );
  check('limit: Big.gpx.bak gets the low limit', limitForFileName('Big.gpx.bak'), (v) =>
    v === ACTIVITY_FILE_LIMIT_BYTES,
  );
  check('error: Big.fit.csv names the export limit', tooLargeError('Big.fit.csv', hugeFitBytes).message, (v) =>
    v.includes('100 MB limit for export files') && !v.includes('other files'),
  );
  check('error: Big.gpx.bak names the other-files limit', tooLargeError('Big.gpx.bak', hugeFitBytes).message, (v) =>
    v.includes('10 MB limit for other files') && !v.includes('export files'),
  );
  check('error: activities.csv names the export limit', tooLargeError('activities.csv', hugeFitBytes).message, (v) =>
    v.includes('100 MB limit for export files') && !v.includes('other files'),
  );

  for (const { name, format } of bypassNames) {
    const isFit = format === 'fit';
    const kind = isFit ? 'activity files' : 'other files';
    const bypassCsv = Buffer.from(
      [
        csvHeader,
        '1,"Oct 12, 2026, 6:32:10 AM",Good,Løb,1800,1800,5.0,170,150,Good.gpx',
        `2,"Oct 11, 2026, 6:32:10 AM",Bad,Løb,1800,1800,5.0,170,150,"${name}"`,
      ].join('\n') + '\n',
    );
    const bypassZip = writeZip(
      `zip-bypass-${bypassNames.findIndex((entry) => entry.name === name)}`,
      buildZip([
        { name: 'activities.csv', data: bypassCsv },
        { name: 'activities/Good.gpx', data: gzFixture },
        {
          name: `activities/${name}`,
          compressed: await deflateBomb(hugeFitBytes),
          compressionMethod: 8,
          uncompressedSize: hugeFitBytes,
          crc: 0,
        },
      ]),
    );
    const bypassRun = runZipCli([bypassZip]);
    check(`zip: 98 MB ${name} does not kill the run`, bypassRun.status, (v) => v === 0);
    check(`zip: 98 MB ${name} becomes one row error`, bypassRun.stdout, (v) =>
      v.includes(
        `err="activities/${name} is 98.7 MB, which is larger than the 10 MB limit for ${kind} — a Strava export does not ship ${isFit ? 'activity files' : 'files'} that size."`,
      ),
    );
    check(`zip: 98 MB ${name} still gives the rest of the digest`, bypassRun.stdout, (v) =>
      /^d=\S+ n="Good" km=5\.00 /m.test(v),
    );
  }

  // A `.csv` suffix is the real format, so `Big.fit.csv` is not FIT and no
  // parser accepts it. The row fails before the read; its CSV suffix still
  // gives it the 100 MB export limit. Big.gpx.csv and Big.tcx.csv behave the
  // same way. Big.gpx.bak is neither an activity nor a CSV, so its error names
  // the "other files" limit it actually got.
  const namedCsv = Buffer.from(
    [
      csvHeader,
      '1,"Oct 12, 2026, 6:32:10 AM",Good,Løb,1800,1800,5.0,170,150,Good.gpx',
      '2,"Oct 11, 2026, 6:32:10 AM",FitCsv,Løb,1800,1800,5.0,170,150,Big.fit.csv',
      '3,"Oct 10, 2026, 6:32:10 AM",GpxCsv,Løb,1800,1800,5.0,170,150,Big.gpx.csv',
      '4,"Oct 9, 2026, 6:32:10 AM",TcxCsv,Løb,1800,1800,5.0,170,150,Big.tcx.csv',
      '5,"Oct 8, 2026, 6:32:10 AM",Bak,Løb,1800,1800,5.0,170,150,Big.gpx.bak',
    ].join('\n') + '\n',
  );
  const hugeZeros = await deflateBomb(hugeFitBytes);
  const namedCsvZip = writeZip(
    'zip-named-csv',
    buildZip([
      { name: 'activities.csv', data: namedCsv },
      { name: 'activities/Good.gpx', data: gzFixture },
      {
        name: 'activities/Big.fit.csv',
        compressed: hugeZeros,
        compressionMethod: 8,
        uncompressedSize: hugeFitBytes,
        crc: 0,
      },
      {
        name: 'activities/Big.gpx.csv',
        compressed: hugeZeros,
        compressionMethod: 8,
        uncompressedSize: hugeFitBytes,
        crc: 0,
      },
      {
        name: 'activities/Big.tcx.csv',
        compressed: hugeZeros,
        compressionMethod: 8,
        uncompressedSize: hugeFitBytes,
        crc: 0,
      },
      {
        name: 'activities/Big.gpx.bak',
        compressed: hugeZeros,
        compressionMethod: 8,
        uncompressedSize: hugeFitBytes,
        crc: 0,
      },
    ]),
  );

  const namedRssDir = scratch('named-csv-rss');
  const namedRssFile = join(namedRssDir, 'maxrss');
  const namedPreload = join(namedRssDir, 'maxrss.cjs');
  writeFileSync(
    namedPreload,
    "const fs = require('node:fs');\n" +
      "process.on('exit', () => fs.writeFileSync(process.env.STRAVA_DIGEST_MAX_RSS, String(process.resourceUsage().maxRSS)));\n",
  );
  let namedRun;
  try {
    namedRun = {
      status: 0,
      stdout: execFileSync(
        process.execPath,
        ['--require', namedPreload, cliPath, namedCsvZip],
        {
          encoding: 'utf8',
          env: { ...process.env, STRAVA_DIGEST_MAX_RSS: namedRssFile },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      ),
      stderr: '',
    };
  } catch (err) {
    namedRun = {
      status: err.status ?? null,
      stdout: String(err.stdout ?? ''),
      stderr: String(err.stderr ?? ''),
    };
  }
  const namedLine = (name) =>
    namedRun.stdout.split('\n').find((line) => line.startsWith('d=') && line.includes(`n="${name}"`)) ?? '';
  check('zip: Big.fit.csv does not kill the run', namedRun.status, (v) => v === 0);
  check('zip: Big.fit.csv fails before it is read', namedLine('FitCsv'), (v) =>
    v.includes('err="unknown activity format: activities/Big.fit.csv"'),
  );
  check('zip: Big.gpx.csv fails before it is read', namedLine('GpxCsv'), (v) =>
    v.includes('err="unknown activity format: activities/Big.gpx.csv"'),
  );
  check('zip: Big.tcx.csv fails before it is read', namedLine('TcxCsv'), (v) =>
    v.includes('err="unknown activity format: activities/Big.tcx.csv"'),
  );
  check('zip: Big.gpx.bak names the other-files limit', namedLine('Bak'), (v) =>
    v.includes(
      'err="activities/Big.gpx.bak is 98.7 MB, which is larger than the 10 MB limit for other files — a Strava export does not ship files that size."',
    ),
  );
  check('zip: named-CSV rows still give the rest of the digest', namedRun.stdout, (v) =>
    /^d=\S+ n="Good" km=5\.00 /m.test(v),
  );
  const namedMaxRssKb = existsSync(namedRssFile) ? Number(readFileSync(namedRssFile, 'utf8')) : NaN;
  if (Number.isFinite(namedMaxRssKb) && namedMaxRssKb > 0) {
    console.log(`      named-CSV max RSS: ${Math.round(namedMaxRssKb / 1024)} MB`);
    check('zip: unknown activity names are not read at the export limit', namedMaxRssKb, (v) => v < 200 * 1024);
  } else {
    console.log('skip: maxRSS not reported on this platform');
  }

  const goodFitCsv = Buffer.from(
    [
      csvHeader,
      '1,"Oct 12, 2026, 6:32:10 AM",Good,Løb,1800,1800,5.0,170,150,Good.fit',
    ].join('\n') + '\n',
  );
  const goodFitZip = writeZip(
    'zip-good-fit',
    buildZip([
      { name: 'activities.csv', data: goodFitCsv },
      { name: 'activities/Good.fit', data: fitBuffer },
    ]),
  );
  const goodFitRun = runZipCli([goodFitZip]);
  check('zip: a small Good.fit still parses', goodFitRun.status, (v) => v === 0);
  check('zip: a small Good.fit is in the digest', goodFitRun.stdout, (v) =>
    /^d=\S+ n="Good" /m.test(v),
  );

  const largeDir = scratch('dir-big-fit');
  writeFileSync(join(largeDir, 'activities.csv'), Buffer.from(`${csvHeader}\n`));
  writeFileSync(join(largeDir, 'Big.fit'), Buffer.alloc(12 * 1024 * 1024));
  const largeDirSource = await openSource(largeDir);
  const largeDirError = await largeDirSource.read('Big.fit').then(
    () => null,
    (err) => (err instanceof Error ? err.message : String(err)),
  );
  await largeDirSource.close();
  check('folder: 12 MB activity file is rejected before it is read', largeDirError, (v) =>
    v === 'Big.fit is 12 MB, which is larger than the 10 MB limit for activity files — a Strava export does not ship activity files that size.',
  );

  const gzBombZip = writeZip(
    'zip-gz-bomb',
    buildZip([
      {
        name: 'activities.csv',
        data: Buffer.from(
          [
            csvHeader,
            '1,"Oct 12, 2026, 6:32:10 AM",Good,Løb,1800,1800,5.0,170,150,Good.gpx',
            '2,"Oct 11, 2026, 6:32:10 AM",Bomb,Løb,1800,1800,5.0,170,150,Bomb.gpx.gz',
          ].join('\n') + '\n',
        ),
      },
      { name: 'activities/Good.gpx', data: gzFixture },
      { name: 'activities/Bomb.gpx.gz', data: await gzipBomb(101 * 1024 * 1024) },
    ]),
  );
  const rssFile = join(scratch('gz-bomb-rss'), 'maxrss');
  const rssPreload = join(scratch('gz-bomb-preload'), 'maxrss.cjs');
  writeFileSync(
    rssPreload,
    "const fs = require('node:fs');\n" +
      "process.on('exit', () => fs.writeFileSync(process.env.STRAVA_DIGEST_MAX_RSS, String(process.resourceUsage().maxRSS)));\n",
  );
  let gzBombRun;
  try {
    gzBombRun = {
      status: 0,
      stdout: execFileSync(
        process.execPath,
        ['--require', rssPreload, cliPath, gzBombZip],
        {
          encoding: 'utf8',
          env: { ...process.env, STRAVA_DIGEST_MAX_RSS: rssFile },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      ),
      stderr: '',
    };
  } catch (err) {
    gzBombRun = {
      status: err.status ?? null,
      stdout: String(err.stdout ?? ''),
      stderr: String(err.stderr ?? ''),
    };
  }
  const gzBombLine =
    gzBombRun.stdout.split('\n').find((line) => line.startsWith('d=') && line.includes('n="Bomb"')) ?? '';
  check('gz bomb: the row fails with an honest message', gzBombLine, (v) =>
    v.includes(
      'err="activities/Bomb.gpx.gz unpacks to more than 10 MB — a Strava export does not ship activity files that size."',
    ),
  );
  check('gz bomb: the rest of the digest is still built', gzBombRun.status, (v) => v === 0);
  check('gz bomb: the other run keeps its analysis', gzBombRun.stdout, (v) =>
    /^d=\S+ n="Good" km=5\.00 .*? err=/m.test(v) === false &&
    /^d=\S+ n="Good" km=5\.00 /m.test(v),
  );
  const maxRssKb = Number(readFileSync(rssFile, 'utf8'));
  if (Number.isFinite(maxRssKb) && maxRssKb > 0) {
    console.log(`      gz-bomb max RSS: ${Math.round(maxRssKb / 1024)} MB`);
    check('gz bomb: max RSS stays below 250 MB', maxRssKb, (v) => v < 250 * 1024);
  } else {
    console.log('skip: maxRSS not reported on this platform');
  }

  /* ---- issue #22: atomisk --out, context-advarsel, install-home, fmtDelta, signal ---- */

  // Punkt 1: --out må kun efterlade den gamle eller den nye fil.
  const atomicDir = join(tmp, 'atomic-out');
  mkdirSync(atomicDir, { recursive: true });
  const atomicTarget = join(atomicDir, 'digest.md');
  const atomicOk = spawnSync(process.execPath, [cliPath, tmp, '--format', 'md', '--out', atomicTarget], { encoding: 'utf8' });
  check('--out atomisk: exit 0', atomicOk.status, (v) => v === 0);
  check('--out atomisk: målet har digest-indhold', existsSync(atomicTarget) ? readFileSync(atomicTarget, 'utf8') : null, (v) => typeof v === 'string' && v.startsWith('# Training digest'));
  check('--out atomisk: ingen temp-fil tilbage', readdirSync(atomicDir).filter((n) => n !== 'digest.md'), (v) => v.length === 0);

  // Punkt 3: en eksisterende fils mode bevares gennem temp+rename.
  if (process.platform !== 'win32') {
    const modeTarget = join(atomicDir, 'mode.md');
    writeFileSync(modeTarget, 'old digest\n');
    chmodSync(modeTarget, 0o600);
    const modeRun = spawnSync(process.execPath, [cliPath, tmp, '--format', 'md', '--out', modeTarget], { encoding: 'utf8' });
    const keptMode = statSync(modeTarget).mode & 0o777;
    check('--out: eksisterende 0600 bevares', modeRun.status, (v) => v === 0);
    check('--out: eksisterende fils mode er 0600', keptMode, (v) => v === 0o600);
    console.log(`  mode: eksisterende fil = ${keptMode.toString(8)}`);

    const newModeTarget = join(atomicDir, 'new-mode.md');
    const newModeRun = spawnSync(process.execPath, [cliPath, tmp, '--format', 'md', '--out', newModeTarget], { encoding: 'utf8' });
    const newMode = statSync(newModeTarget).mode & 0o777;
    const umaskMode = 0o666 & ~process.umask();
    check('--out: ny fil følger umask', newModeRun.status, (v) => v === 0);
    check('--out: ny fils mode er ikke mere åben end umask', newMode, (v) => (v & ~umaskMode) === 0);
    console.log(`  mode: ny fil = ${newMode.toString(8)} (umask ${process.umask().toString(8)})`);
  } else {
    console.log('skip: POSIX-filtilstande findes ikke på Windows');
  }

  // En mappe der ikke kan oprettes: den blokerende sti er urørt.
  const atomicBlocker = join(tmp, 'atomic-blocker');
  writeFileSync(atomicBlocker, 'keep me\n');
  const atomicBlocked = spawnSync(process.execPath, [cliPath, tmp, '--format', 'md', '--out', join(atomicBlocker, 'digest.md')], { encoding: 'utf8' });
  check('--out: umulig mappe fejler', atomicBlocked.status, (v) => v !== 0);
  check('--out: umulig mappe rører ikke gammelt indhold', readFileSync(atomicBlocker, 'utf8'), (v) => v === 'keep me\n');

  // En eksisterende mappe som mål: rename fejler, og den gamle fil er intakt.
  const atomicDirTarget = join(tmp, 'atomic-target-dir');
  mkdirSync(atomicDirTarget, { recursive: true });
  writeFileSync(join(atomicDirTarget, 'old.txt'), 'old\n');
  const atomicRenameFail = spawnSync(process.execPath, [cliPath, tmp, '--format', 'md', '--out', atomicDirTarget], { encoding: 'utf8' });
  check('--out: rename-fejl fejler', atomicRenameFail.status, (v) => v !== 0);
  check('--out: rename-fejl efterlader gammelt indhold', readFileSync(join(atomicDirTarget, 'old.txt'), 'utf8'), (v) => v === 'old\n');
  check('--out: rename-fejl rydder temp-filen', readdirSync(tmp).filter((n) => n.startsWith('atomic-target-dir.')), (v) => v.length === 0);

  // Skrivningen fejler midt i filen (EFBIG via ulimit): atomisk skrivning
  // lader den gamle fil stå, mens direkte writeFile efterlader en halv fil.
  if (process.platform !== 'win32') {
    const atomicLimited = join(atomicDir, 'limited.md');
    writeFileSync(atomicLimited, 'old digest\n');
    const limited = spawnSync('/bin/sh', ['-c', 'trap "" XFSZ; ulimit -f 1; exec "$0" "$@"', process.execPath, cliPath, tmp, '--format', 'md', '--out', atomicLimited], { encoding: 'utf8' });
    check('--out: skrivefejl fejler', limited.status, (v) => v !== 0);
    check('--out: skrivefejl bevarer den gamle fil', readFileSync(atomicLimited, 'utf8'), (v) => v === 'old digest\n');
    check('--out: skrivefejl rydder temp-filen', readdirSync(atomicDir).filter((n) => n.startsWith('limited.md.')), (v) => v.length === 0);
  } else {
    console.log('skip: EFBIG/ulimit findes ikke på Windows');
  }

  // Punkt 2: en manglende --context advarer på stderr uden at ændre digesten.
  const contextMissing = join(tmp, 'missing-context.md');
  const contextEmpty = join(tmp, 'empty-context.md');
  writeFileSync(contextEmpty, '');
  const missingCtxRun = spawnSync(process.execPath, [cliPath, tmp, '--context', contextMissing], { encoding: 'utf8' });
  const emptyCtxRun = spawnSync(process.execPath, [cliPath, tmp, '--context', contextEmpty], { encoding: 'utf8' });
  const stripGenerated = (s) => s.replace(/^generated=.*$/m, 'generated=<same>');
  check('--context: manglende fil advarer på stderr med stien', missingCtxRun.stderr, (v) => v.includes(contextMissing));
  check('--context: manglende fil ændrer ikke digesten', stripGenerated(missingCtxRun.stdout), (v) => v === stripGenerated(emptyCtxRun.stdout));
  check('--context: tom fil advarer ikke', emptyCtxRun.stderr, (v) => v === '');

  // Punkt 3: installationen må ikke bygge relative mål af en tom HOME,
  // og containment-tjekket skal bruge path.relative, ikke streng-prefix.
  const resolveScript = join(tmp, 'resolve-targets.mjs');
  const insideScript = join(tmp, 'path-inside.mjs');
  writeFileSync(resolveScript, `import { resolveTargets } from ${JSON.stringify(pathToFileURL(join(repoRoot, 'src', 'install.ts')).href)};\nconsole.log(JSON.stringify(resolveTargets()));\n`);
  writeFileSync(insideScript, `import { isPathInside } from ${JSON.stringify(pathToFileURL(join(repoRoot, 'src', 'install.ts')).href)};\nconst cases = [\n  ['/home/u', '/home/u/.hermes'],\n  ['/', '/.hermes'],\n  ['/home/u', '/home/u2/.hermes'],\n  ['/home/u', '/home/u/../outside'],\n  ['/home/u', '/home/u'],\n];\nconsole.log(JSON.stringify(cases.map(([root, target]) => isPathInside(root, target))));\n`);
  const normalHome = join(tmp, 'normal-home');
  mkdirSync(normalHome, { recursive: true });
  const normalTargets = spawnSync(process.execPath, [resolveScript], { encoding: 'utf8', env: { ...process.env, HOME: normalHome, USERPROFILE: normalHome } });
  let parsedTargets = null;
  try { parsedTargets = JSON.parse(normalTargets.stdout); } catch {}
  check('install: resolveTargets virker med normal HOME', normalTargets.status, (v) => v === 0);
  check('install: alle mål er absolutte og under hjemmemappen', Array.isArray(parsedTargets) ? parsedTargets.map((t) => t.dir) : null, (v) => Array.isArray(v) && v.length === 6 && v.every((d) => isAbsolute(d) && d.startsWith(normalHome + sep)));

  // HOME=/ er roden, ikke en relativ sti: legitime mål må ikke afvises.
  const rootHomeTargets = spawnSync(process.execPath, [resolveScript], { encoding: 'utf8', env: { ...process.env, HOME: '/', USERPROFILE: '/' } });
  let parsedRootTargets = null;
  try { parsedRootTargets = JSON.parse(rootHomeTargets.stdout); } catch {}
  const tailParts = (d) => d.split(/[\\/]/).filter(Boolean).slice(-3).join('/');
  check('install: HOME=/ accepteres', rootHomeTargets.status, (v) => v === 0);
  check('install: HOME=/ giver seks mål under roden', Array.isArray(parsedRootTargets) ? parsedRootTargets.map((t) => t.dir) : null, (v) => Array.isArray(v) && v.length === 6 && v.every((d) => isAbsolute(d)) && v.some((d) => tailParts(d) === '.hermes/skills/strava-digest'));

  const insideRun = spawnSync(process.execPath, [insideScript], { encoding: 'utf8' });
  let insideResults = null;
  try { insideResults = JSON.parse(insideRun.stdout); } catch {}
  check('install: isPathInside skelner inde fra ude', insideResults, (v) => Array.isArray(v) && v[0] === true && v[1] === true && v[2] === false && v[3] === false && v[4] === false);

  if (process.platform !== 'win32') {
    const linkHome = join(tmp, 'link-home');
    symlinkSync(normalHome, linkHome);
    const linkedHomeTargets = spawnSync(process.execPath, [resolveScript], { encoding: 'utf8', env: { ...process.env, HOME: linkHome, USERPROFILE: linkHome } });
    check('install: hjemmemappe som symlink accepteres', linkedHomeTargets.status, (v) => v === 0);
  } else {
    console.log('skip: symlink-test kører ikke på Windows');
  }

  const emptyHomeCwd = join(tmp, 'empty-home-cwd');
  mkdirSync(join(emptyHomeCwd, '.hermes', 'skills'), { recursive: true });
  const emptyHomeRun = spawnSync(process.execPath, [cliPath, '--install-skill'], { encoding: 'utf8', cwd: emptyHomeCwd, env: { ...process.env, HOME: '', USERPROFILE: '' } });
  check('install: tom HOME fejler', emptyHomeRun.status, (v) => v !== 0);
  check('install: tom HOME giver klar besked på stderr', emptyHomeRun.stderr, (v) => v.includes('home directory') && v.includes('absolute'));
  check('install: tom HOME skriver ingen fil', existsSync(join(emptyHomeCwd, '.hermes', 'skills', 'strava-digest', 'SKILL.md')), (v) => v === false);

  const relativeHomeRun = spawnSync(process.execPath, [resolveScript], { encoding: 'utf8', env: { ...process.env, HOME: 'relative/home', USERPROFILE: 'relative/home' } });
  check('install: relativ HOME fejler', relativeHomeRun.status, (v) => v !== 0);
  check('install: relativ HOME giver klar besked på stderr', relativeHomeRun.stderr, (v) => v.includes('home directory') && v.includes('absolute'));

  // Punkt 4: fmtDelta skal runde totalen, ikke minutter og sekunder hver for sig.
  const deltaRun = mkRun('2026-10-12T08:00:00Z', 'Delta', 10, 3600, 150, 180, 100, 50);
  const deltaText = (sec) => {
    deltaRun.analysis.secondHalfPaceDeltaSec = sec;
    const md = renderMarkdown({ sourceLabel: 'test', activitiesInExport: 1, runs: [deltaRun], baselineDays: 28, unmatchedHeaders: [], contextText: '', generatedAt: new Date('2026-10-12T09:00:00Z'), poolLabel: 'Løb' });
    return (md.match(/2nd half (\S+)/) ?? [])[1] ?? null;
  };
  check('fmtDelta: -59,6 sek vises −1:00/km', deltaText(-59.6), (v) => v === '−1:00/km');
  check('fmtDelta: 59,6 sek vises +1:00/km', deltaText(59.6), (v) => v === '+1:00/km');
  check('fmtDelta: 0 vises +0:00/km', deltaText(0), (v) => v === '+0:00/km');
  check('fmtDelta: -119,5 sek vises −2:00/km', deltaText(-119.5), (v) => v === '−2:00/km');
  check('fmtDelta: null vises –', fmtDelta(null), (v) => v === '–');

  // Punkt 5: launcheren skal oversætte et dræbende signal til 128 + nummer
  // for alle signaler Node kender, ikke kun en håndskrevet håndfuld.
  const signalNames = ['SIGSEGV', 'SIGPIPE', 'SIGBUS', 'SIGFPE', 'SIGTRAP', 'SIGUSR1', 'SIGXCPU', 'SIGXFSZ', 'SIGWINCH', 'SIGINT', 'SIGTERM', 'SIGUNKNOWN'];
  const signalScript = join(tmp, 'signal-map.mjs');
  writeFileSync(signalScript, `import { signalExitCode } from ${JSON.stringify(pathToFileURL(join(repoRoot, 'bin', 'strava-digest.js')).href)};\nfor (const s of ${JSON.stringify(signalNames)}) console.log(s + '=' + signalExitCode(s));\n`);
  const signalMapRun = spawnSync(process.execPath, [signalScript], { encoding: 'utf8' });
  const signalMap = Object.fromEntries((signalMapRun.stdout || '').trim().split('\n').filter(Boolean).map((line) => line.split('=')));
  check('signal: afbildningen kan importeres uden at starte launcheren', signalMapRun.status, (v) => v === 0);
  for (const name of signalNames) {
    const number = osConstants.signals[name];
    const expected = number == null ? '1' : String(128 + number);
    check(`signal: ${name} giver ${expected}`, signalMap[name] ?? null, (v) => v === expected);
  }

  if (process.platform !== 'win32') {
    const sigRoot = join(tmp, 'signal-launcher');
    mkdirSync(join(sigRoot, 'bin'), { recursive: true });
    mkdirSync(join(sigRoot, 'dist'), { recursive: true });
    copyFileSync(join(repoRoot, 'bin', 'strava-digest.js'), join(sigRoot, 'bin', 'strava-digest.js'));
    writeFileSync(join(sigRoot, 'dist', 'cli.js'), "process.kill(process.pid, 'SIGINT');\n");
    const sigE2e = spawnSync(process.execPath, [join(sigRoot, 'bin', 'strava-digest.js')], { encoding: 'utf8' });
    check('signal: ende-til-ende SIGINT giver exit 130', sigE2e.status, (v) => v === 130);
  } else {
    console.log('skip: ende-til-ende signaltest kører ikke på Windows');
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
  if (enkeltRoot) rmSync(enkeltRoot, { recursive: true, force: true });
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} test(s) fejlede` : '\nalle tests bestået');
process.exit(failures ? 1 : 0);
