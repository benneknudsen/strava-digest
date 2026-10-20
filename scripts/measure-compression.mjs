#!/usr/bin/env node
/**
 * Measure what the compression actually buys, on a real export.
 *
 *   node scripts/measure-compression.mjs <export.zip>
 *
 * Two numbers matter:
 *
 *   raw     = the bytes an agent would have to read if the export were
 *             handed over as-is (the activity files + activities.csv).
 *             media/ is counted separately, because the tool deliberately
 *             never reads it — photos are not training data.
 *   digest  = the bytes the tool actually produces.
 *
 * Tokens are estimated at ~3.6 characters per token, which is close for
 * both XML and for the dense machine format. The byte ratio is the exact
 * number; the token ratio follows from it.
 */
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { open as openZip } from 'yauzl';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');

const CHARS_PER_TOKEN = 3.6;

const exportPath = process.argv[2];
if (!exportPath) {
  console.error('usage: node scripts/measure-compression.mjs <export.zip>');
  process.exit(1);
}

/* ---- 1. the raw side: what is actually in the archive ---- */

const cats = { media: 0, activity: 0, csv: 0, other: 0, binary: 0, xml: 0 };
const counts = { media: 0, activity: 0, csv: 0, other: 0 };

await new Promise((resolve, reject) => {
  openZip(exportPath, { lazyEntries: true }, (err, zf) => {
    if (err) return reject(err);
    zf.on('entry', (e) => {
      const size = e.uncompressedSize;
      const name = e.fileName;
      if (name.startsWith('media/')) {
        cats.media += size;
        counts.media++;
      } else if (/\.(fit|tcx|gpx)(\.gz)?$/i.test(name)) {
        cats.activity += size;
        counts.activity++;
        // FIT is a binary format. No model can read it, so it is not even
        // comparable — it has to be parsed, which is the whole job.
        if (/\.fit(\.gz)?$/i.test(name)) cats.binary += size;
        else cats.xml += size;
      } else if (/\.csv$/i.test(name)) {
        cats.csv += size;
        counts.csv++;
      } else {
        cats.other += size;
        counts.other++;
      }
      zf.readEntry();
    });
    zf.on('end', resolve);
    zf.on('error', reject);
    zf.readEntry();
  });
});

/* ---- 2. the digest side: run the tool for real ---- */

// Koeres fra en tom mappe, saa et context.md i repoen ikke bliver en del af
// maalingen - ellers ville tallet afhaenge af den, der koerer scriptet.
const run = spawnSync(
  process.execPath,
  [join(repo, 'src', 'cli.ts'), exportPath],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, cwd: tmpdir() },
);
if (run.status !== 0) {
  console.error(run.stderr || 'the digest run failed');
  process.exit(1);
}
const digest = run.stdout;

/* ---- 3. report ---- */

const rawActivity = cats.activity + cats.csv + cats.other;
const rawAll = rawActivity + cats.media;
const runCount = (digest.match(/^d=/gm) || []).length;
const fmt = (b) => (b >= 1024 * 1024 ? (b / 1024 / 1024).toFixed(1) + ' MB' : (b / 1024).toFixed(1) + ' kB');
const tok = (b) => Math.round(b / CHARS_PER_TOKEN);
const tokStr = (b) => tok(b).toLocaleString('en-US').replace(/,/g, ' ');

console.log(`export            ${exportPath}`);
console.log('');
console.log('RAW');
console.log(`  activity files  ${fmt(cats.activity).padStart(9)}  (${counts.activity} files)`);
console.log(`  activities.csv  ${fmt(cats.csv).padStart(9)}  (${counts.csv} files)`);
console.log(`  other           ${fmt(cats.other).padStart(9)}  (${counts.other} files)`);
console.log(`  media/          ${fmt(cats.media).padStart(9)}  (${counts.media} files, never read)`);
console.log(`  ─────────────────────────`);
console.log(`  raw, no media   ${fmt(rawActivity).padStart(9)}  ≈ ${tokStr(rawActivity)} tokens`);
console.log(`  raw, all        ${fmt(rawAll).padStart(9)}  ≈ ${tokStr(rawAll)} tokens`);
console.log(`  of which`);
console.log(`    binary FIT    ${fmt(cats.binary).padStart(9)}  unreadable by any model`);
console.log(`    XML (tcx/gpx) ${fmt(cats.xml).padStart(9)}  ≈ ${tokStr(cats.xml)} tokens`);
console.log('');
console.log('DIGEST');
console.log(`  digest          ${fmt(digest.length).padStart(9)}  (${digest.length} bytes)  ≈ ${tokStr(digest.length)} tokens  (${runCount} runs)`);
console.log('');
console.log('SAVING');
const ratio = rawActivity / digest.length;
console.log(`  ${ratio.toFixed(0)}× smaller  —  ${fmt(rawActivity - digest.length)} saved, ${(100 - (digest.length / rawActivity) * 100).toFixed(2)} % of the raw size`);
console.log(`  ${(tok(rawActivity) / tok(digest.length)).toFixed(0)}× fewer tokens than the whole export`);
if (cats.xml > 0) {
  console.log(`  ${(tok(cats.xml) / tok(digest.length)).toFixed(0)}× fewer tokens than the XML a model can even read`);
}
