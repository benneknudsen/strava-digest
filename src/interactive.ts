import type { Stats } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { collectActivityFiles, isActivityFile } from './loose.ts';
import { findActivitiesCsv, openSource } from './source.ts';

export interface Candidate {
  path: string;
  kind: 'csv-mappe' | 'zip' | 'aktivitetsmappe' | 'aktivitetsfil';
  count: number;
  /** aktivitetsfiler LIGE i mappen (ikke i undermapper) */
  directCount: number;
  mtimeMs: number;
}

/** The internal kind is Danish; the picker shows English. */
const KIND_LABELS: Record<Candidate['kind'], string> = {
  'csv-mappe': 'export folder',
  zip: 'zip',
  'aktivitetsmappe': 'activity folder',
  'aktivitetsfil': 'activity file',
};

/**
 * Find læsbare kilder ét niveau ned i hvert dir — plus dir'et selv, så en
 * arbejdsmappe der ER en eksport også bliver en kandidat. Manglende mapper
 * ignoreres lydløst, og listen dedupliceres på sti og klippes til 15.
 */
export async function discoverSources(dirs: string[]): Promise<Candidate[]> {
  const found = new Map<string, Candidate>();
  const add = (candidate: Candidate | null): void => {
    if (!candidate) return;
    const key = resolve(candidate.path);
    if (!found.has(key)) found.set(key, candidate);
  };

  for (const dir of dirs) {
    const st = await stat(dir).catch(() => null);
    if (!st) continue;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
    if (!entries) continue;
    const counts = await countActivityFilesByDir(dir);
    add(await classify(dir, st, counts));
    for (const e of entries) add(await classify(join(dir, e.name), undefined, counts));
  }

  return [...found.values()]
    .sort((a, b) => b.mtimeMs - a.mtimeMs || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .slice(0, 15);
}

/**
 * Tæl aktivitetsfiler i hele træet under `root` i ét gennemløb og returnér
 * antallet pr. mappe. Samme pruning som `collectActivityFiles`: skjulte mapper
 * og `media/` springes over. Kandidaterne slår dermed op i stedet for at
 * walke rekursivt hver for sig.
 *
 * Tællingen returnerer BÅDE det samlede antal i træet OG antallet der
 * ligger lige i mappen. Forskellen betyder noget for `--find`: en mappe
 * med 200 filer i en undermappe er en rodet mappe, mens en mappe med 12
 * filer LIGE i sig er en rigtig eksport.
 */
async function countActivityFilesByDir(root: string): Promise<Counts> {
  const counts: Counts = { total: new Map(), direct: new Map() };

  async function walk(dir: string): Promise<number> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
    if (!entries) return 0;
    let total = 0;
    let here = 0;
    for (const e of entries) {
      if (e.isDirectory()) {
        if (e.name.startsWith('.') || e.name.toLowerCase() === 'media') continue;
        total += await walk(join(dir, e.name));
      } else if (isActivityFile(e.name)) {
        total++;
        here++;
      }
    }
    counts.total.set(dir, total);
    counts.direct.set(dir, here);
    return total;
  }

  await walk(root);
  return counts;
}

interface Counts {
  /** aktivitetsfiler i hele træet under mappen */
  total: Map<string, number>;
  /** aktivitetsfiler lige i mappen */
  direct: Map<string, number>;
}

async function classify(
  path: string,
  known: Stats | undefined,
  counts: Counts,
): Promise<Candidate | null> {
  const st = known ?? (await stat(path).catch(() => null));
  if (!st) return null;
  if (st.isDirectory()) {
    const entries = await readdir(path, { withFileTypes: true }).catch(() => null);
    if (!entries) return null;
    const hasCsv = entries.some((e) => e.isFile() && e.name.toLowerCase() === 'activities.csv');
    // Sjældne top-level-mapper (skjulte, media/, symlinks) er ikke med i
    // gennemløbet og tælles derfor på den gamle, rekursive måde.
    const count = counts.total.get(path) ?? (await collectActivityFiles(path).catch(() => [])).length;
    const directCount = counts.direct.get(path) ?? 0;
    if (hasCsv) return { path, kind: 'csv-mappe', count, directCount, mtimeMs: st.mtimeMs };
    if (count > 0) return { path, kind: 'aktivitetsmappe', count, directCount, mtimeMs: st.mtimeMs };
    return null;
  }
  if (!st.isFile()) return null;
  if (isActivityFile(path)) return { path, kind: 'aktivitetsfil', count: 1, directCount: 1, mtimeMs: st.mtimeMs };
  if (!/\.zip$/i.test(path)) return null;
  const source = await openSource(path).catch(() => null);
  if (!source) return null;
  try {
    if (!findActivitiesCsv(source)) return null;
    const count = source.list().filter(isActivityFile).length;
    return { path, kind: 'zip', count, directCount: count, mtimeMs: st.mtimeMs };
  } finally {
    await source.close();
  }
}

/**
 * Mapper der skannes efter eksporter.
 *
 * `~/Downloads` og `~/Desktop` er valgt af vilje: det er der folk
 * lander en hentet zip i. `USERPROFILE` dækker Windows, hvor
 * download-mappen ofte hedder `Downloads` men ikke altid ligger
 * under `homedir()`.
 *
 * Én funktion for begge vege: den interaktive vælger OG `--find`.
 * Ellers kan de to komme i utakt, og en agent ville få et andet
 * sæt kilder end brugeren.
 */
export function searchDirs(): string[] {
  const home = homedir();
  const dirs = [process.cwd(), join(home, 'Downloads'), join(home, 'Desktop')];
  const profile = process.env.USERPROFILE;
  if (profile) dirs.push(join(profile, 'Downloads'), join(profile, 'Desktop'));
  return dirs;
}

/**
 * Ét spørgsmål i terminalen: vis kandidaterne nummereret og læs et svar.
 * Tomt svar eller `q` afslutter pænt med `null`; tre ugyldige forsøg i træk
 * giver en dansk fejl.
 */
export async function pickSource(): Promise<string | null> {
  const candidates = await discoverSources(searchDirs());
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      printCandidates(candidates);
      const answer = (await rl.question('Pick a number (or paste a path, q = quit): ')).trim();
      if (!answer || answer.toLowerCase() === 'q') return null;
      if (/^\d+$/.test(answer)) {
        const candidate = candidates[Number(answer) - 1];
        if (candidate) return candidate.path;
        console.log(`Not a valid number: ${answer}`);
        continue;
      }
      const path = cleanPath(answer);
      if (await stat(path).catch(() => null)) return path;
      console.log(`Could not read the path: ${path}`);
    }
  } finally {
    rl.close();
  }
  throw new Error('invalid input three times in a row — run the command again and pick a number from the list');
}

function printCandidates(candidates: Candidate[]): void {
  if (!candidates.length) {
    console.log('No candidates found in the working folder, ~/Downloads or ~/Desktop.');
    return;
  }
  candidates.forEach((c, i) => {
    console.log(`${i + 1})  ${KIND_LABELS[c.kind]} · ${c.count} ${c.count === 1 ? 'file' : 'files'} · ${c.path}`);
  });
}

/** Fjern omgivende citationstegn og `file://`-præfiks fra en indsat sti. */
function cleanPath(raw: string): string {
  let s = raw.trim();
  const quoted = s.match(/^(['"])(.*)\1$/);
  if (quoted) s = quoted[2]!.trim();
  if (s.toLowerCase().startsWith('file://')) {
    const rest = s.slice('file://'.length);
    try {
      s = decodeURIComponent(rest);
    } catch {
      s = rest;
    }
  }
  return s;
}
