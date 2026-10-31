import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import yauzl from 'yauzl';
import { limitForFileName, tooLargeError } from './limits.ts';

/**
 * A read-only view over a Strava bulk export — either the ZIP as downloaded
 * (preferred: nothing is ever unpacked to disk) or an already extracted folder.
 */
export interface ExportSource {
  readonly label: string;
  /** Every entry path in the source, '/'-separated. */
  list(): string[];
  read(path: string): Promise<Buffer>;
  /** Declared size in bytes, without reading the content. */
  size(path: string): Promise<number>;
  /** Notes about entries that were skipped while opening the source. */
  warnings(): string[];
  /** True when an activities.csv entry was skipped because it is not a safe relative path. */
  hasSkippedActivitiesCsv(): boolean;
  close(): Promise<void>;
}

const entryCache = new WeakMap<ExportSource, readonly string[]>();

function entriesOf(source: ExportSource): readonly string[] {
  let entries = entryCache.get(source);
  if (!entries) {
    entries = source.list();
    entryCache.set(source, entries);
  }
  return entries;
}

export async function openSource(path: string): Promise<ExportSource> {
  const st = await stat(path);
  if (st.isDirectory()) return openDir(path);
  return openZip(path);
}

/* ------------------------------------------------------------------ zip */

function openZip(path: string): Promise<ExportSource> {
  return new Promise((resolve, reject) => {
    // decodeStrings: false stops yauzl from validating entry names itself: a
    // single `../` entry would emit an error and kill the whole archive. We
    // decode and validate the raw names below instead, so one bad entry is
    // skipped while the rest of the export stays readable.
    //
    // validateEntrySizes: false is deliberate too. yauzl would reject a zip
    // bomb at its declared size before our own byte counter sees the real
    // size. We check the declared size up front and the actual bytes while
    // streaming below.
    yauzl.open(
      path,
      { lazyEntries: true, autoClose: false, decodeStrings: false, validateEntrySizes: false },
      (err, zf) => {
        if (err || !zf) return reject(err ?? new Error(`could not open ${path}`));
        const entries = new Map<string, yauzl.Entry>();
        let skipped = 0;
        let skippedActivitiesCsv = false;

        zf.on('error', reject);
        zf.on('entry', (entry: yauzl.Entry) => {
          const name = decodeEntryName(entry);
          if (!isSafeRelativePath(name)) {
            skipped++;
            if (!name.endsWith('/') && name.toLowerCase().endsWith('activities.csv')) {
              skippedActivitiesCsv = true;
            }
          } else if (!name.endsWith('/')) entries.set(name, entry);
          zf.readEntry();
        });
        zf.on('end', () =>
          resolve({
            label: `${path} (zip, ${entries.size} ${entries.size === 1 ? 'file' : 'files'})`,
            list: () => [...entries.keys()],
            read: (name) => readZipEntry(zf, entries, name),
            size: async (name) => {
              const entry = entries.get(name);
              if (!entry) throw new Error(`not in the archive: ${name}`);
              return entry.uncompressedSize;
            },
            warnings: () => skippedEntryWarnings(skipped),
            hasSkippedActivitiesCsv: () => skippedActivitiesCsv,
            close: async () => zf.close(),
          }),
        );
        zf.readEntry();
      },
    );
  });
}

/**
 * Decode an entry name without yauzl's validation. The ZIP UTF-8 flag (bit
 * 11) says the name is UTF-8; otherwise the spec says CP437. Its ASCII range
 * is identical to latin1, and every filename in a Strava export is ASCII, so
 * latin1 is a safe fallback here. A non-ASCII CP437 name may decode to the
 * wrong characters, but we only match known filenames and never write an
 * entry to disk.
 */
function decodeEntryName(entry: yauzl.Entry): string {
  const isUtf8 = (entry.generalPurposeBitFlag & 0x800) !== 0;
  return entry.fileNameRaw.toString(isUtf8 ? 'utf8' : 'latin1').replace(/\\/g, '/');
}

/**
 * Only relative paths inside the archive are safe to expose. Backslashes are
 * normalized to '/' before this check, so Windows drive paths and UNC paths
 * are caught by the same rules as POSIX absolute paths.
 */
function isSafeRelativePath(name: string): boolean {
  if (!name) return false;
  if (name.startsWith('/')) return false;
  if (/^[A-Za-z]:/.test(name)) return false;
  if (name.split('/').includes('..')) return false;
  return true;
}

function skippedEntryWarnings(count: number): string[] {
  if (!count) return [];
  const single = count === 1;
  return [
    `${count} ${single ? 'entry in the archive was' : 'entries in the archive were'} skipped because ` +
      `${single ? 'its name is not a safe relative path' : 'their names are not safe relative paths'}.`,
  ];
}

async function readZipEntry(
  zf: yauzl.ZipFile,
  entries: Map<string, yauzl.Entry>,
  name: string,
): Promise<Buffer> {
  const entry = entries.get(name);
  if (!entry) throw new Error(`not in the archive: ${name}`);
  const limit = limitForFileName(name);
  if (entry.uncompressedSize > limit) throw tooLargeError(name, entry.uncompressedSize);
  return new Promise((resolve, reject) => {
    zf.openReadStream(entry, (err, stream) => {
      if (err || !stream) return reject(err ?? new Error(`could not read ${name}`));
      const chunks: Buffer[] = [];
      let total = 0;
      let settled = false;
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        stream.destroy();
        reject(error);
      };
      stream.on('data', (chunk: Buffer) => {
        if (settled) return;
        total += chunk.length;
        if (total > limit) {
          // The declared size already passed the check above, so the header
          // understated the real size; report the size as unknown.
          fail(tooLargeError(name, null));
          return;
        }
        chunks.push(chunk);
      });
      stream.on('error', fail);
      stream.on('end', () => {
        if (settled) return;
        settled = true;
        if (total !== entry.uncompressedSize) {
          reject(
            new Error(
              `${name} is truncated or its declared size is wrong (expected ${entry.uncompressedSize} bytes, got ${total}).`,
            ),
          );
          return;
        }
        resolve(Buffer.concat(chunks, total));
      });
    });
  });
}

/* ------------------------------------------------------------- directory */

export async function readFileLimited(path: string, displayName = path): Promise<Buffer> {
  const limit = limitForFileName(displayName);
  const st = await stat(path);
  if (st.size > limit) throw tooLargeError(displayName, st.size);
  const data = await readFile(path);
  if (data.length > limit) throw tooLargeError(displayName, data.length);
  return data;
}

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
    label: `${path} (folder, ${files.length} ${files.length === 1 ? 'file' : 'files'})`,
    list: () => [...files],
    read: (name) => readFileLimited(join(path, name), name),
    size: async (name) => (await stat(join(path, name))).size,
    warnings: () => [],
    hasSkippedActivitiesCsv: () => false,
    close: async () => {},
  };
}

/**
 * Locate `activities.csv` and the folder it lives in — the export is normally
 * flat, but some archives nest everything under a root folder.
 */
export function findActivitiesCsv(source: ExportSource): { csv: string; root: string } | null {
  const hits = entriesOf(source)
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
  const all = entriesOf(source);
  for (const c of candidates) if (all.includes(c)) return c;
  // Last resort: match on basename (exports differ in folder layout).
  const base = clean.split('/').pop()!;
  return all.find((p) => p.split('/').pop() === base) ?? null;
}
