# AGENTS.md

Instructions for AI agents working in this repository.

## What this tool is

`strava-digest` reads the user's **own Strava bulk export** and writes a
compact, machine-readable digest. The point is to give an agent the whole
training history for ~14,900 tokens instead of ~28 MB of raw GPS data.

**Never touch the Strava API.** The tool only reads files the user has
downloaded themselves. It is an export-and-interpret thing, not an API client.

## How to use it

```bash
strava-digest --find              # find the export: one path per line
strava-digest <path>              # digest to stdout
strava-digest <path> --out FIL    # digest to a file
strava-digest <path> --format md  # human-readable Markdown
```

The default output is the agent format. Read the `SCHEMA` and `SIGNALS`
sections before interpreting the fields — they explain what every number
means.

## Rules for agents

- **Read `SCHEMA` and `SIGNALS` before interpreting.** `drift` is HR drift in
  percent, `load` is training load, `z` is the zone split.
- **Never hand the raw data to the model.** The digest is the whole point.
- **Never invent numbers.** A missing field shows as `-`.
- **Max heart rate comes from the user.** Strava's export has no zone
  configuration; do not guess a value. Run with `--max-hr <value>` once the
  user has given one.
- **`context.md` belongs to the user.** It is embedded in the digest and is
  gitignored, because the content is personal. Do not write to it.
- **`media/` is not data.** It is the images and videos from the activities,
  inside the export. The tool skips them on purpose.
- **The output is English.** The tool reads Danish and English exports, but
  its own output is English so that any agent can read it.

## Gate

Before you commit:

```bash
npm test          # scripts/smoke-test.mjs
npx tsc --noEmit  # typecheck
```

Both must be green. CI also runs on Linux, macOS and Windows with Node 22 and
24 — so a new test must not assume Unix paths or `/`-separated paths.

## Structure

- `src/cli.ts` — arguments, output, commands
- `src/agent.ts` — the agent format (one line per run)
- `src/digest.ts` — the Markdown format
- `src/interactive.ts` — the interactive picker and `--find`
- `src/install.ts` — `--install-skill`
- `src/analysis.ts` — splits, drift, zones, load
- `src/columns.ts` — the column alias table (one place per language)
- `src/loose.ts` — loose activity files
- `src/strava.ts` — CSV reading and column mapping
- `scripts/smoke-test.mjs` — the whole test suite
- `skills/strava-digest/SKILL.md` — the ready-to-install agent skill
