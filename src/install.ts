/**
 * Installér repoets agent-skill i de agenter, der læser SKILL.md.
 *
 * Formålet er at en ny bruger skal kunne skrive én kommando og have
 * sin agent klar: kopieringen skal finde ud af, hvilke agenter der
 * findes på maskinen, og gøre det klart hvilke den fandt.
 */
import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Hvor forskellige agenter læser skills fra. */
const TARGETS: { name: string; dir: string; exists?: boolean }[] = [
  { name: 'Hermes', dir: join(homedir(), '.hermes', 'skills', 'strava-digest') },
  { name: 'Claude Code', dir: join(homedir(), '.claude', 'skills', 'strava-digest') },
  { name: 'Cursor', dir: join(homedir(), '.cursor', 'skills', 'strava-digest') },
  { name: 'Codex', dir: join(homedir(), '.codex', 'skills', 'strava-digest') },
  { name: 'Cline', dir: join(homedir(), '.cline', 'skills', 'strava-digest') },
  { name: 'Aider', dir: join(homedir(), '.aider', 'skills', 'strava-digest') },
];

/** Find skill-filen i den installerede pakke. */
export function skillSourcePath(): string {
  // src/ -> repo-roden -> skills/strava-digest/SKILL.md
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', 'skills', 'strava-digest', 'SKILL.md');
}

export interface InstallResult {
  target: string;
  path: string;
  status: 'installeret' | 'opdateret' | 'ikke fundet' | 'fejlede';
  detail?: string;
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
      results: [{ target: '—', path: source, status: 'fejlede', detail: 'skill-filen findes ikke i pakken' }],
    };
  }

  const targets = targetDirs?.length
    ? targetDirs.map((d) => ({ name: d, dir: join(d, 'strava-digest') }))
    : TARGETS;

  const results: InstallResult[] = [];
  for (const t of targets) {
    const skillsRoot = dirname(t.dir);
    const dest = join(t.dir, 'SKILL.md');
    // Installer kun i agenter der faktisk er installeret: opretter vi
    // mapper for agenter brugeren ikke har, får de en mappe fuld af
    // filer agenten aldrig læser.
    const parentExists = await stat(skillsRoot).then((s) => s.isDirectory()).catch(() => false);
    if (!targetDirs?.length && !parentExists) {
      results.push({ target: t.name, path: dest, status: 'ikke fundet', detail: 'the agent does not appear to be installed' });
      continue;
    }
    // Opdater en eksisterende skill in place, så vi ikke ender med to
    // skills med samme navn.
    const existing = await findExistingSkill(skillsRoot, 'strava-digest');
    const target = existing ?? t.dir;
    const targetFile = join(target, 'SKILL.md');
    try {
      const before = await stat(targetFile).catch(() => null);
      if (before) {
        // En eksisterende skill kan være tilpasset (f.eks. med egen
        // max-puls). Overskriv den ikke uden en backup.
        await copyFile(targetFile, `${targetFile}.bak`);
      }
      await mkdir(target, { recursive: true });
      await copyFile(source, targetFile);
      results.push({
        target: t.name,
        path: targetFile,
        status: before ? 'opdateret' : 'installeret',
        detail: before ? 'din egen tilpasning ligger i SKILL.md.bak' : undefined,
      });
    } catch (e) {
      results.push({
        target: t.name,
        path: targetFile,
        status: 'fejlede',
        detail: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return { results, source };
}

/** Kommandolinje-udskrift til installeringen. */
export function renderInstall(result: { results: InstallResult[]; source: string }): string {
  const out: string[] = [];
  const ok = result.results.filter((r) => r.status === 'installeret' || r.status === 'opdateret');
  out.push('strava-digest — skill installeret');
  out.push('');
  for (const r of result.results) {
    if (r.status === 'fejlede') {
      out.push(`  fejlede     ${r.target}: ${r.detail ?? 'ukendt fejl'}`);
    } else if (r.status === 'ikke fundet') {
      out.push(`  ikke fundet ${r.target}`);
    } else {
      out.push(`  ${r.status.padEnd(11)} ${r.target}  →  ${r.path}`);
      if (r.detail) out.push(`  ${' '.repeat(11)} ${r.detail}`);
    }
  }
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
