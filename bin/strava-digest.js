#!/usr/bin/env node
/**
 * Launcher for the `strava-digest` command.
 *
 * Prefers the built output in dist/, and falls back to the TypeScript
 * source when there is no build. Node can run .ts directly, but only
 * outside node_modules — which is exactly the case for a clone plus
 * `npm link`, where the symlink resolves back into the repo.
 *
 * The point is that the command never fails with a confusing
 * "module not found" just because nobody ran the build.
 */
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { constants } from 'node:os';

/**
 * Oversæt et dræbende signal til en shell-exitkode. Node kender
 * nummeret for alle platformens signaler; et ukendt navn falder tilbage
 * til 1. Uden dette bliver `spawnSync().status` null ved signaler, og
 * launcheren ville afslutte med 1 — samme kode som en rigtig fejl.
 */
export function signalExitCode(signal) {
  const number = constants.signals[signal];
  return number == null ? 1 : 128 + number;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const built = join(here, '..', 'dist', 'cli.js');
  const source = join(here, '..', 'src', 'cli.ts');

  if (!existsSync(built) && !existsSync(source)) {
    console.error('strava-digest: neither dist/cli.js nor src/cli.ts was found.');
    process.exit(1);
  }

  const entry = existsSync(built) ? built : source;
  const result = spawnSync(process.execPath, [entry, ...process.argv.slice(2)], {
    stdio: 'inherit',
  });
  process.exit(result.status ?? (result.signal ? signalExitCode(result.signal) : 1));
}

if (isMainModule()) main();
