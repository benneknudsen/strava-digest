# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

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
