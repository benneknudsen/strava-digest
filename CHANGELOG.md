# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

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
