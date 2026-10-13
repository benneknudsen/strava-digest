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
  mtimeMs: number;
}

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
 */
async function countActivityFilesByDir(root: string): Promise<Map<string, number>> {
  const counts = new Map<string, number>();

  async function walk(dir: string): Promise<number> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
    if (!entries) return 0;
    let total = 0;
    for (const e of entries) {
      if (e.isDirectory()) {
        if (e.name.startsWith('.') || e.name.toLowerCase() === 'media') continue;
        total += await walk(join(dir, e.name));
      } else if (isActivityFile(e.name)) {
        total++;
      }
    }
    counts.set(dir, total);
    return total;
  }

  await walk(root);
  return counts;
}

async function classify(
  path: string,
  known: Stats | undefined,
  counts: Map<string, number>,
): Promise<Candidate | null> {
  const st = known ?? (await stat(path).catch(() => null));
  if (!st) return null;
  if (st.isDirectory()) {
    const entries = await readdir(path, { withFileTypes: true }).catch(() => null);
    if (!entries) return null;
    const hasCsv = entries.some((e) => e.isFile() && e.name.toLowerCase() === 'activities.csv');
    // Sjældne top-level-mapper (skjulte, media/, symlinks) er ikke med i
    // gennemløbet og tælles derfor på den gamle, rekursive måde.
    const count = counts.get(path) ?? (await collectActivityFiles(path).catch(() => [])).length;
    if (hasCsv) return { path, kind: 'csv-mappe', count, mtimeMs: st.mtimeMs };
    if (count > 0) return { path, kind: 'aktivitetsmappe', count, mtimeMs: st.mtimeMs };
    return null;
  }
  if (!st.isFile()) return null;
  if (isActivityFile(path)) return { path, kind: 'aktivitetsfil', count: 1, mtimeMs: st.mtimeMs };
  if (!/\.zip$/i.test(path)) return null;
  const source = await openSource(path).catch(() => null);
  if (!source) return null;
  try {
    if (!findActivitiesCsv(source)) return null;
    return { path, kind: 'zip', count: source.list().filter(isActivityFile).length, mtimeMs: st.mtimeMs };
  } finally {
    await source.close();
  }
}

/**
 * Ét spørgsmål i terminalen: vis kandidaterne nummereret og læs et svar.
 * Tomt svar eller `q` afslutter pænt med `null`; tre ugyldige forsøg i træk
 * giver en dansk fejl.
 */
export async function pickSource(): Promise<string | null> {
  const candidates = await discoverSources([
    process.cwd(),
    join(homedir(), 'Downloads'),
    join(homedir(), 'Desktop'),
  ]);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      printCandidates(candidates);
      const answer = (await rl.question('Vælg nummer (eller indsæt en sti, q = afslut): ')).trim();
      if (!answer || answer.toLowerCase() === 'q') return null;
      if (/^\d+$/.test(answer)) {
        const candidate = candidates[Number(answer) - 1];
        if (candidate) return candidate.path;
        console.log(`Ugyldigt nummer: ${answer}`);
        continue;
      }
      const path = cleanPath(answer);
      if (await stat(path).catch(() => null)) return path;
      console.log(`Kunne ikke læse stien: ${path}`);
    }
  } finally {
    rl.close();
  }
  throw new Error('ugyldigt input tre gange i træk — kør kommandoen igen og vælg et nummer fra listen');
}

function printCandidates(candidates: Candidate[]): void {
  if (!candidates.length) {
    console.log('Ingen kandidater fundet i arbejdsmappen, ~/Downloads eller ~/Desktop.');
    return;
  }
  candidates.forEach((c, i) => {
    console.log(`${i + 1})  ${c.kind} · ${c.count} ${c.count === 1 ? 'fil' : 'filer'} · ${c.path}`);
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
