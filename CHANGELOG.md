# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.5] — 2026-10-31

### Changed

- Without `--max-hr`, the zone basis is now the 95th percentile of the
  `Max Heart Rate` values from the two years before the newest activity,
  not a single spike. The header says `source=export-p95`; with fewer than
  21 values the basis is the highest measured value in the window instead,
  the header says `source=export-max`, and the note states the count. This
  is a deliberate behaviour change: on an export like the real one the basis
  moves from 199 to 186, so the zone split and `load` move with it. A wrong
  max HR mislabels every zone, so pass `--max-hr` if you know your max (#38).
- The distance unit is no longer decided per row from a value threshold. A
  usable unit column beats the header unit, the header unit beats the guess,
  and a bare `Distance` header is decided once for the whole column from its
  median (above 200 means metres, otherwise kilometres). A deliberate
  behaviour change: the digest shows the same unit for every row in a column
  and no longer flips when a single value crosses the threshold (#37).

### Fixed

- `--list` and the loose-file path now say why a file was skipped, and an
  unreadable `activities.` file is reported instead of looking like a
  missing file (#41).
- The Markdown baseline uses the same heart-rate rule as the run lines
  (`row.avgHr ?? analysis.avgHr`), so the MD average cannot contradict the
  lines it sums (#43).
- `SKILL.md` no longer promises that the digest tells you when the context
  file is missing, and the size message can no longer sound as if a file is
  exactly the limit while it is larger (#44).
- The last ten Danish user-facing strings are now English (#45).
- Reading points from a GPX/TCX file scans the buffer once; a truncated file
  no longer rescans the rest from every position (it was O(n²)). Well-formed
  input is unchanged line for line (#40).
- The test suite is isolated from the user's own machine: working directory,
  a temporary `HOME`, and temporary directories are cleaned up. Developer
  facing; no user-visible change (#42).

## [1.0.4] — 2026-10-30

### Changed

- Removed code that was never read: an unused helper, an unread column count,
  an unused field on the parsed CSV, and the FIT lap structures that were
  parsed but never used. The digest output is unchanged — verified byte for
  byte on a real export, the `generated=` line aside — except that the `--json`
  output no longer carries the unused `id` key on each row.
- Reading a FIT file and resolving an archive entry no longer scale
  quadratically. The distance interpolation for points without a distance
  measurement walks the known-distance indices once instead of rescanning
  them per point, and the archive's entry list is built once per source
  instead of once per activity row. The digest is unchanged — verified byte
  for byte on a real export, the `generated=` line aside.

### Fixed

- Walking and hiking activity types no longer count as runs. `Wanderung`
  (German), `Wandeling` (Dutch) and `Randonnée` (French) were part of the
  run vocabulary, so a walk entered the run count, the distance and the
  pace baseline — an 8 km walk at walking pace could drag the reported
  average pace far below the real one. They are still activities: they
  appear in the export count, in `--list` and with `--all`; they are just
  not runs.
- Pause detection now works on densely sampled tracks (GPX/TCX and FIT at
  1 Hz): a sustained stop is recognised from low progress per second instead
  of requiring a single gap longer than 20 s. A missing distance field no
  longer breaks a pause, which matters for Strava FIT files that write
  distance only every other point. Paused time is kept out of the zone split,
  so it no longer inflates training load.
- Behaviour change for sparsely sampled tracks: a step must now satisfy both
  `dd < 8 m` and `dd / dt < 0.4 m/s`. A 30 s gap with 11 m of progress is no
  longer counted as a pause, as the old rule did.
- `scripts/measure-compression.mjs` reported JavaScript character counts as
  bytes, so the digest size, the compression ratio, the "saved" figure and the
  token estimate were all computed from the wrong number — and the README claim
  that the bytes are exact was therefore not true. It now reports UTF-8 byte
  counts, and the README measurement block is regenerated from the fixed
  script.
- A loose activity file whose first timestamp lies more than 24 hours in the
  future no longer moves the digest's comparison window. It is skipped and
  reported with the impossible date, the way the export's own date parser
  already rejects such a row — a rejected file is a counted note, never a
  clamped or invented date.
- Documentation: the README claimed the digest was byte-identical between
  runs, which the `generated=` timestamp line makes untrue. Both places now
  say the output is deterministic apart from that line, so the claim matches
  the tool.
- `--format` no longer fails silently: an unknown value is rejected in both
  `--format json` and `--format=json`, and an unknown flag is reported instead
  of being ignored. A missing `--context` file now warns on stderr instead of
  producing a context-free digest without a word.
- The activity format is decided by the last file suffix, so
  `tur.fitness.gpx` is parsed as GPX instead of being mistaken for a FIT file.
  A duration written as `1 t 30 min` or `1 h 30 s` is read correctly, and a
  value with letters that matches no pattern is reported as missing rather
  than scraped into a made-up number.
- Loose activity files fold the activity type the same way the export does,
  so a Swedish `Löpning` is counted as a run instead of disappearing. GPX
  points are read whichever order `lat` and `lon` appear in, and a `file:///C:/…`
  path pasted on Windows is no longer turned into an unreadable path.
- `--out` is written atomically through a temp file and a rename, and an
  existing target keeps its permissions. `--install-skill` refuses to run with
  an empty or relative home directory instead of writing relative paths, the
  launcher passes a signal's exit code through (`SIGINT` gives 130), and a pace
  delta no longer prints `−0:60/km`.
- The agent format's `hr=` falls back to the track file's heart rate when
  the export's heart-rate columns are empty, and the weekly mean uses the same
  rule so it cannot contradict the run lines it sums. The note about unmapped
  export columns no longer claims they are all weather and gear: it says how
  many populated columns the tool could not place, and that some may be
  training data.
- `Math.max`/`Math.min` over a whole array is gone, so a
  large export cannot abort the run with a stack overflow. `formatMb` rounds
  to one decimal instead of always rounding up, and the 'too large' message
  reports the declared size when it is known and 'more than the limit' when it
  is not.

## [1.0.3] — 2026-10-21

### Fixed

- Number fields in German and Dutch exports were read with the wrong scale:
  `1.234` became 1.234 (1000× too small) and `2.345.678` became 2.345. They
  are now read as 1234 and 2345678.
- The separator rule is applied per value, not per account locale. When both
  `,` and `.` appear, the rightmost one is the decimal separator; otherwise a
  repeated separator, or a 1-3 digit group before a 3-digit tail, is a
  thousands separator, and everything else is decimal. `1.234` is therefore
  German thousands, 1234, never English 1.234. A test covers the rule directly
  on the number format.

## [1.0.2] — 2026-10-21

### Fixed

- `--install-skill` compares the installed file with the packaged skill
  before it replaces it, ignoring the `version:` line and the difference
  between `\n` and `\r\n`. A file that differs in nothing else is the tool's
  own output from an earlier release, so it is replaced without a backup and
  the message says "the skill was updated". The `version:` line follows the
  package version, so an upgrade that leaves the skill text unchanged leaves
  no backup behind. When the skill text itself has changed since the last
  install, the tool cannot tell whether the installed file was edited, so it
  copies the file to `SKILL.md.bak`, `SKILL.md.bak.2`, … before replacing it.
  The contents that were there are kept that way.
- A file that is about to be replaced is now always kept. Previously, when a
  `SKILL.md.bak` already existed, the current file was overwritten and
  dropped: the user's own edits were gone, and the message still claimed that
  an earlier version was in the backup. The current file is now copied to
  `SKILL.md.bak`, or to `SKILL.md.bak.2`, `SKILL.md.bak.3`, … when that name
  is taken. An existing backup is never overwritten.
- The install message now describes what happened instead of guessing who
  owns the file: "the previous SKILL.md was copied to `SKILL.md.bak`" — with
  the name of the file that was actually written. The tool cannot know
  whether the old file was the user's own or the tool's output from an older
  release, so it no longer claims to know.

## [1.0.1] — 2026-10-21

### Fixed

- A digest larger than the 64 KiB pipe buffer was silently truncated when it
  went through a pipe (`| less`, `| pbcopy`, or an agent reading stdout): on a
  196-run export, only 65536 of 93996 bytes arrived, with no error message.
  The process exited before Node had finished the asynchronous stdout writes.
  The CLI now lets Node drain stdout before it exits.
- The CLI now handles `EPIPE` explicitly. When the process waits for stdout
  to drain, a reader that closes the pipe early (`| head`, `| less` and then
  `q`, `| grep -m1`) has already received what it asked for; the CLI exits 0
  without a stack trace. A regression test closes the pipe early in Node, so
  it runs on Windows too.

## [1.0.0] — 2026-10-20

First stable release. The commands, the flags and the exit codes are settled;
1.x will not break your command line.

The agent format has its own version, in the first line of the digest
(`STRAVA DIGEST v2`). That one can move on its own, and an agent that caches
it should check that line and read `SCHEMA` and `SIGNALS` again when it
changes. A format change is not a package change.

### Changed since 0.1.0

- `SCHEMA` and `SIGNALS` now say what "max" means in the zone split. If the
  header says `source=export-observation`, the boundaries come from the
  highest heart rate in the export, not the user's real max — usually a
  single spike, so the training looks easier than it is. An agent reading
  only the old text would have read the zones as if they were the user's
  own.
- The agent format no longer lists Strava's unused column names; it counts
  them and points at the Markdown format for the list. The digest is smaller
  and the model gets no Danish column names in its context.

## [0.1.0] — 2026-10-20

First release.

### Added

- Reads a Strava bulk export (`.zip`) and writes one compact training digest:
  per-km splits with pace and average heart rate, pace-normalised aerobic
  decoupling, negative split, pace consistency, zone split, training load, a
  week overview, the last 28 days against the 28 before, and totals.
- Streaming archive reading — nothing is unpacked to disk, and `media/` is
  never read.
- Loose activity files as an alternative to a bulk export: a single `.fit`,
  `.gpx` or `.tcx` (gzipped or not), or a folder of them.
- Three output formats: the machine-readable agent format (default),
  human-readable Markdown, and JSON.
- `--install-skill` installs a ready-made agent skill into the agents found on
  the machine (Hermes, Claude Code, Cursor, Codex, Cline, Aider). An existing
  skill is updated where it lives, and a customised one is backed up to
  `SKILL.md.bak` first.
- `--find` locates possible exports and prints them as paths.
- An interactive picker when run with no arguments in a terminal.
- `context.md` embedding, so an agent can judge a run against the intent and
  not only against the numbers.
- `scripts/measure-compression.mjs` measures the compression on a real export.
- Column aliases for English, Danish, German, Swedish/Norwegian, Dutch,
  French and Spanish. The output is always English.

### Notes

- The tool does not touch the Strava API. It reads a file the user downloaded
  themselves through Strava's Bulk Data Export Tool — see API Policy 2026
  §6.6. It calls neither the Strava API nor any LLM, and stores or sends
  nothing.
- The zone split needs a max heart rate. Strava's export does not contain the
  watch's own zone configuration, so without `--max-hr` the tool falls back to
  the highest heart rate in the export and labels it `source=export-observation`.
  That is a guess, usually a single spike, and it often makes training look
  easier than it is. Pass `--max-hr <your max>` when the zones matter.
