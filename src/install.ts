/**
 * Installér repoets agent-skill i de agenter, der læser SKILL.md.
 *
 * Formålet er at en ny bruger skal kunne skrive én kommando og have
 * sin agent klar: kopieringen skal finde ud af, hvilke agenter der
 * findes på maskinen, og gøre det klart hvilke den fandt.
 */
import { copyFile, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Hvor forskellige agenter læser skills fra, relativt til hjemmemappen. */
const TARGETS = [
  { name: 'Hermes', parts: ['.hermes', 'skills', 'strava-digest'] },
  { name: 'Claude Code', parts: ['.claude', 'skills', 'strava-digest'] },
  { name: 'Cursor', parts: ['.cursor', 'skills', 'strava-digest'] },
  { name: 'Codex', parts: ['.codex', 'skills', 'strava-digest'] },
  { name: 'Cline', parts: ['.cline', 'skills', 'strava-digest'] },
  { name: 'Aider', parts: ['.aider', 'skills', 'strava-digest'] },
] as const;

/**
 * Er target inde i root? path.relative håndterer roden (`/`), Windows-drev
 * og sammenligner stier som stier i stedet for som tekststrenge. Et tomt
 * resultat betyder target === root, hvilket ikke er inde i mappen.
 */
export function isPathInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Byg de absolutte målmapper ud fra hjemmemappen. En tom eller relativ
 * homedir() må ikke blive til relative mål, for så skriver installationen
 * i forhold til cwd — og det er ikke brugerens hjemmemappe.
 */
export function resolveTargets(home: string = homedir()): { name: string; dir: string }[] {
  if (!isAbsolute(home)) {
    throw new Error(
      `cannot install the skill: the home directory is ${home ? `"${home}"` : 'empty'}, but it must be an absolute path`,
    );
  }
  const root = resolve(home);
  return TARGETS.map(({ name, parts }) => {
    const dir = join(root, ...parts);
    if (!isPathInside(root, dir)) {
      throw new Error(`cannot install the skill: ${dir} is outside the home directory ${root}`);
    }
    return { name, dir };
  });
}

/** Find skill-filen i den installerede pakke. */
export function skillSourcePath(): string {
  // src/ -> repo-roden -> skills/strava-digest/SKILL.md
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', 'skills', 'strava-digest', 'SKILL.md');
}

export interface InstallResult {
  target: string;
  path: string;
  status: 'installed' | 'updated' | 'not found' | 'failed';
  detail?: string;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true).catch(() => false);
}

/** Sammenlign to tekster, som om linjeskiftet var det samme hele vejen. */
function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

/**
 * Skillens `version:` følger pakkeversionen, så den ændrer sig ved hver
 * release. Uden den undtagelse ville værktøjets eget output fra en
 * tidligere version se ud som en brugers fil, og en ren opgradering ville
 * skrive en backup, der slet ikke er en brugerversion.
 */
function stripVersionLine(text: string): string {
  return text.replace(/^version:.*$/m, '');
}

/**
 * Er den installerede fil værktøjets eget output? Så må den overskrives
 * uden backup: indholdet er det samme, bortset fra version-linjen og
 * linjeskiftet, så intet går tabt ved at skrive den.
 */
function isToolOutput(current: string, packaged: string): boolean {
  const a = stripVersionLine(normalizeEol(current)).trim();
  const b = stripVersionLine(normalizeEol(packaged)).trim();
  return a !== '' && a === b;
}

/**
 * Find det næste ledige backup-navn: SKILL.md.bak, SKILL.md.bak.2,
 * SKILL.md.bak.3, … En backup, der allerede findes, røres aldrig.
 */
async function freeBackupPath(targetFile: string): Promise<string> {
  const first = `${targetFile}.bak`;
  if (!(await exists(first))) return first;
  for (let n = 2; ; n++) {
    const candidate = `${targetFile}.bak.${n}`;
    if (!(await exists(candidate))) return candidate;
  }
}

/**
 * Hvad der sker med en fil, der allerede findes, og hvad beskeden
 * til brugeren skal sige om det.
 */
async function handleExistingFile(targetFile: string, packaged: string): Promise<string> {
  const current = await readFile(targetFile, 'utf8').catch(() => '');
  if (isToolOutput(current, packaged)) {
    // Filen er værktøjets eget output fra en tidligere version.
    // Der er intet nyt at gemme, så en backup ville bare fylde.
    return 'the skill was updated';
  }
  // Filen afviger fra den pakkede skill. Hvad afvigelsen er, kan
  // koden ikke vide: det kan være brugerens egen redigering eller
  // værktøjets output fra en version med en anden tekst. Derfor
  // kopieres den altid — den må aldrig gå tabt — og en backup, der
  // allerede findes, røres ikke.
  const backup = await freeBackupPath(targetFile);
  await copyFile(targetFile, backup);
  // Beskeden fortæller handlingen, ikke ejerskabet: koden kan
  // ikke vide, om filen var brugerens eller værktøjets egen.
  return `the previous SKILL.md was copied to ${basename(backup)}`;
}

/**
 * Find en allerede installeret skill med samme navn, uanset hvor agenten
 * har lagt den.
 *
 * Agenter grupperer skills i kategorier (Hermes: `~/.hermes/skills/
 * productivity/strava-digest/`). Lægger vi en ny mappe ved siden af,
 * ender vi med to skills med samme navn — og det er et reelt problem,
 * fordi agenten så ikke ved hvilken den skal bruge.
 */
async function findExistingSkill(skillsRoot: string, name: string): Promise<string | null> {
  const direct = join(skillsRoot, name);
  if (await stat(join(direct, 'SKILL.md')).then(() => true).catch(() => false)) return direct;

  // Søg rekursivt: agenter grupperer skills i kategorier, og dybden
  // varierer. Vi søger dog kun efter mapper med præcis det navn.
  const walk = async (dir: string, depth: number): Promise<string | null> => {
    if (depth > 3) return null;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const child = join(dir, e.name);
      if (e.name === name) {
        if (await stat(join(child, 'SKILL.md')).then(() => true).catch(() => false)) return child;
        continue;
      }
      const hit = await walk(child, depth + 1);
      if (hit) return hit;
    }
    return null;
  };
  return walk(skillsRoot, 1);
}

export async function installSkill(
  targetDirs?: string[],
): Promise<{ results: InstallResult[]; source: string }> {
  const source = skillSourcePath();
  try {
    await stat(source);
  } catch {
    return {
      source,
      results: [{ target: '—', path: source, status: 'failed', detail: 'the skill file is not in the package' }],
    };
  }
  // Den pakkede skill, som vi skal skrive ud. Den bruges til at kende
  // forskel på "værktøjets eget output" og "en fil, der afviger".
  const packaged = (await readFile(source, 'utf8').catch(() => '')).trim();

  const targets = targetDirs?.length
    ? targetDirs.map((d) => ({ name: d, dir: join(d, 'strava-digest') }))
    : resolveTargets();

  const results: InstallResult[] = [];
  for (const t of targets) {
    const skillsRoot = dirname(t.dir);
    const dest = join(t.dir, 'SKILL.md');
    // Installer kun i agenter der faktisk er installeret: opretter vi
    // mapper for agenter brugeren ikke har, får de en mappe fuld af
    // filer agenten aldrig læser.
    const parentExists = await stat(skillsRoot).then((s) => s.isDirectory()).catch(() => false);
    if (!targetDirs?.length && !parentExists) {
      results.push({ target: t.name, path: dest, status: 'not found', detail: 'the agent does not appear to be installed' });
      continue;
    }
    // Opdater en eksisterende skill in place, så vi ikke ender med to
    // skills med samme navn.
    const existing = await findExistingSkill(skillsRoot, 'strava-digest');
    const target = existing ?? t.dir;
    const targetFile = join(target, 'SKILL.md');
    try {
      const fileExists = await exists(targetFile);
      const detail = fileExists ? await handleExistingFile(targetFile, packaged) : undefined;
      await mkdir(target, { recursive: true });
      await copyFile(source, targetFile);
      results.push({
        target: t.name,
        path: targetFile,
        status: fileExists ? 'updated' : 'installed',
        detail,
      });
    } catch (e) {
      results.push({
        target: t.name,
        path: targetFile,
        status: 'failed',
        detail: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return { results, source };
}

/** Kommandolinje-udskrift til installeringen. */
export function renderInstall(result: { results: InstallResult[]; source: string }): string {
  const out: string[] = [];
  const ok = result.results.filter((r) => r.status === 'installed' || r.status === 'updated');
  out.push('strava-digest — skill installed');
  out.push('');
  const missing: string[] = [];
  for (const r of result.results) {
    if (r.status === 'failed') {
      out.push(`  failed      ${r.target}: ${r.detail ?? 'unknown error'}`);
    } else if (r.status === 'not found') {
      // En agent der ikke findes er ikke en fejl. De samles på én linje,
      // så en maskine med seks agenter ikke fylder skærmen med støj.
      missing.push(r.target);
    } else {
      out.push(`  ${r.status.padEnd(11)} ${r.target}  →  ${r.path}`);
      if (r.detail) out.push(`  ${' '.repeat(11)} ${r.detail}`);
    }
  }
  if (missing.length) out.push(`  not found   ${missing.join(', ')}`);
  out.push('');
  if (ok.length) {
    out.push('Restart the agent and ask it about your runs.');
    out.push('E.g. "how was my week?" or "what was my longest run?"');
  } else {
    out.push('No agent was found. Point at a skills folder manually:');
    out.push('  strava-digest --install-skill ~/.hermes/skills');
  }
  return out.join('\n');
}
