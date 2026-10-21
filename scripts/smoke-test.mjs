// Smoke-test: genererer syntetiske fixtures (ingen persondata), kører hele
// pipelinen og fejler hvis nøgletallene ikke stemmer. Kør med `npm test`.
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyseRun } from '../src/analysis.ts';
import { parseActivityBuffer, pointsFromFitRecords } from '../src/activity.ts';
import { mapColumns, parseDate } from '../src/columns.ts';
import { parseCsv } from '../src/csv.ts';
import { renderMarkdown, fmtPace } from '../src/digest.ts';
import { renderAgent } from '../src/agent.ts';
import { discoverSources } from '../src/interactive.ts';
import { isActivityFile, rowFromTrack } from '../src/loose.ts';
import { findActivitiesCsv, openSource, resolveActivityEntry } from '../src/source.ts';
import { normalizeType, RUN_TYPES, toActivities } from '../src/strava.ts';
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
  check('CLI uden max-puls: zonefelt er tomt', cli.includes('z=-'), (v) => v === true);
  check('CLI-agent har én linje pr. løb', (cli.match(/^d=\d{4}-/gm) ?? []).length, (v) => v === 2);

  // Markdown-formatet er stadig tilgængeligt med --format md
  const cliMd = execFileSync('node', ['src/cli.ts', tmp, '--last', '2', '--max-hr', '240', '--format', 'md'], { encoding: 'utf8' });
  check('--format md giver menneske-Markdown', cliMd.includes('# Training digest'), (v) => v === true);
  check('--format md viser Zoner-linje', cliMd.includes('- **Zones:** Z1 '), (v) => v === true);
  check('--format md viser baseline-roligt', cliMd.includes('easy (Z1–Z2)'), (v) => v === true);

  const cliJson = JSON.parse(
    execFileSync('node', ['src/cli.ts', tmp, '--last', '2', '--max-hr', '240', '--json'], { encoding: 'utf8' }),
  );
  check('--max-hr giver zoneSource flag', cliJson.runs[0]?.analysis?.zoneSource ?? null, (v) => v === 'flag');
  check('--max-hr sætter zoneMaxHr', cliJson.runs[0]?.analysis?.zoneMaxHr ?? null, (v) => v === 240);
  check('zoneprocenter i JSON summer til 100', cliJson.runs[0]?.analysis?.zonePct?.reduce((s, p) => s + p, 0) ?? null, (v) => v != null && Math.abs(v - 100) < 1);

  const cliZones = execFileSync('node', ['src/cli.ts', tmp, '--last', '2', '--max-hr', '240'], { encoding: 'utf8' });
  check('CLI-agent viser zonefordeling', /z=\d/.test(cliZones), (v) => v === true);
  check('CLI-agent markerer zonekilden', cliZones.includes('max_hr=240 source=flag'), (v) => v === true);

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

  // Agenten laeser SCHEMA og SIGNALS og fortolker derfra. Hvis de ikke
  // siger, at "max" kan vaere det observerede gaet, vaesker agenten
  // zonerne som om de la paa brugerens rigtige max-puls. Det er præcis
  // den fejltolkning, der gør træningen se lettere ud end den er.
  check('SIGNALS forklarer at max kan vaere et gaet', cliNoHr, (v) =>
    v.includes('export-observation') && v.includes('not the user') && v.includes('spike'),
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
  check('CLI-agent bruger punktum som decimaltegn', cliZones.includes('km=10.00'), (v) => v === true);

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
  check('loose: zoner med --max-hr', looseZones, (v) => /z=\d/.test(v) && v.includes('max_hr=240 source=flag'));

  const looseList = execFileSync('node', ['src/cli.ts', looseDir, '--list'], { encoding: 'utf8' });
  check('loose --list viser filnavn og zone-status', looseList, (v) => v.includes('Run-1001.gpx') && v.includes('zones: no'));

  /* ---- fund 1: distance 0 fra fil uden distance må ikke påstå 0 km ---- */

  const noDistTrack = {
    points: [
      { t: new Date('2026-10-12T06:30:00Z'), hr: 150 },
      { t: new Date('2026-10-12T06:35:00Z'), hr: 152 },
    ],
    laps: [],
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
    laps: [],
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

  // 2) Eksportens datoer er UTC — bekræftet mod FIT/GPX i samme arkiv.
  //    Som lokal tid kom turen to timer for tidigt i digesten.
  const utcDate = parseDate('16. okt. 2026, 08.18.29');
  check('eksportens dato tolkes som UTC', utcDate?.toISOString(), (v) => v === '2026-10-16T08:18:29.000Z');
  check('lokal gengivelse følger maskinens zone', utcDate?.getHours(), (v) => v === new Date('2026-10-16T08:18:29Z').getHours());
  const isoDate = parseDate('2026-10-16T08:18:29Z');
  check('ISO-dato tolkes uændret', isoDate?.toISOString(), (v) => v === '2026-10-16T08:18:29.000Z');

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

  // 4) Dansk overskrift "Aktivitetsudstyr" (sko) må ikke forveksles med
  //    "Udstyr" (cykel-id) — ellers vises 30723737.0 som udstyr.
  const daCsv = parseCsv(
    [
      'Aktivitets-ID,Aktivitetsdato,Aktivitetsnavn,Aktivitetstype,Distance,Maks. puls,Gennemsnitlig puls,Relativ indsats,Samlet stigning,Udstyr,Aktivitetsudstyr,Filnavn',
      '1001,"12. okt. 2026, 06.32",Lang tur,Løb,10.0,174,156,92,41,30723737.0,Nike Vomero Plus,Run-1001.gpx',
    ].join('\n'),
  );
  const daMap = mapColumns(daCsv);
  const daRows = toActivities(daCsv, daMap);
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
  check('agent: STATS har total km', agentOut.includes('km_total=29.0'), (v) => v === true);
  check('agent: STATS har længste løb', agentOut.includes('longest_run=10.00'), (v) => v === true);
  check('agent: STATS har største pause', agentOut.includes('max_gap='), (v) => v === true);
  check('agent: kontekst er med', agentOut.includes('plan: 3 løb/uge'), (v) => v === true);
  check('agent: kun detaljerede løb får splits', (agentOut.match(/sp=\d+:/g) ?? []).length, (v) => v === 1);
  check('agent: load vægter zoner', /load=\d+/.test(agentOut), (v) => v === true);
  check('agent: ingen dansk komma i decimal', !/km=\d+,\d/.test(agentOut), (v) => v === true);
  check('agent: feltnavne er konsistente', agentOut.includes('pace=') && agentOut.includes('drift=') && agentOut.includes('half='), (v) => v === true);
  check('agent: notes-sektion findes', agentOut.includes('## NOTES'), (v) => v === true);
} finally {
  rmSync(tmp, { recursive: true, force: true });
  if (enkeltRoot) rmSync(enkeltRoot, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} test(s) fejlede` : '\nalle tests bestået');
process.exit(failures ? 1 : 0);
