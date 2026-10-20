import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import yauzl from 'yauzl';

/**
 * A read-only view over a Strava bulk export — either the ZIP as downloaded
 * (preferred: nothing is ever unpacked to disk) or an already extracted folder.
 */
export interface ExportSource {
  readonly label: string;
  /** Every entry path in the source, '/'-separated. */
  list(): string[];
  read(path: string): Promise<Buffer>;
  close(): Promise<void>;
}

export async function openSource(path: string): Promise<ExportSource> {
  const st = await stat(path);
  if (st.isDirectory()) return openDir(path);
  return openZip(path);
}

/* ------------------------------------------------------------------ zip */

function openZip(path: string): Promise<ExportSource> {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true, autoClose: false }, (err, zf) => {
      if (err || !zf) return reject(err ?? new Error(`could not open ${path}`));
      const entries = new Map<string, yauzl.Entry>();

      zf.on('error', reject);
      zf.on('entry', (entry: yauzl.Entry) => {
        const name = entry.fileName.replace(/\\/g, '/');
        if (!name.endsWith('/')) entries.set(name, entry);
        zf.readEntry();
      });
      zf.on('end', () =>
        resolve({
          label: `${path} (zip, ${entries.size} files)`,
          list: () => [...entries.keys()],
          read: (name) => readZipEntry(zf, entries, name),
          close: async () => zf.close(),
        }),
      );
      zf.readEntry();
    });
  });
}

function readZipEntry(
  zf: yauzl.ZipFile,
  entries: Map<string, yauzl.Entry>,
  name: string,
): Promise<Buffer> {
  const entry = entries.get(name);
  if (!entry) return Promise.reject(new Error(`findes ikke i arkivet: ${name}`));
  return new Promise((resolve, reject) => {
    zf.openReadStream(entry, (err, stream) => {
      if (err || !stream) return reject(err ?? new Error(`could not read ${name}`));
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('error', reject);
      stream.on('end', () => resolve(Buffer.concat(chunks)));
    });
  });
}

/* ------------------------------------------------------------- directory */

async function openDir(path: string): Promise<ExportSource> {
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else files.push(relative(path, full).split(sep).join('/'));
    }
  }
  await walk(path);
  return {
    label: `${path} (folder, ${files.length} files)`,
    list: () => [...files],
    read: (name) => readFile(join(path, name)),
    close: async () => {},
  };
}

/**
 * Locate `activities.csv` and the folder it lives in — the export is normally
 * flat, but some archives nest everything under a root folder.
 */
export function findActivitiesCsv(source: ExportSource): { csv: string; root: string } | null {
  const hits = source
    .list()
    .filter((p) => p.toLowerCase().endsWith('activities.csv'))
    .sort((a, b) => a.split('/').length - b.split('/').length);
  if (!hits.length) return null;
  const csv = hits[0]!;
  const root = csv.includes('/') ? csv.slice(0, csv.lastIndexOf('/') + 1) : '';
  return { csv, root };
}

/** Resolve what activities.csv calls a filename against the archive's real entries. */
export function resolveActivityEntry(
  source: ExportSource,
  root: string,
  filename: string,
): string | null {
  const clean = filename.trim().replace(/^\/+/, '');
  if (!clean) return null;
  const candidates = [
    `${root}${clean}`,
    `${root}activities/${clean}`,
    `activities/${clean}`,
    clean,
  ];
  const all = source.list();
  for (const c of candidates) if (all.includes(c)) return c;
  // Last resort: match on basename (exports differ in folder layout).
  const base = clean.split('/').pop()!;
  return all.find((p) => p.split('/').pop() === base) ?? null;
}
