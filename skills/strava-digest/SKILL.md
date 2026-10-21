---
name: strava-digest
description: "Use when the user asks about their runs or training data."
version: 1.0.0
license: MIT
---

# Strava digest

Answer questions about training from the user's run data, read via `strava-digest`.

## When to Use

Use this skill when the user asks about:

- their runs, training, fitness or running history
- a specific run (pace, heart rate, zones, splits, how it went)
- trends over time (volume, load, form, gaps between runs)
- which training fits the plan, or whether a session matched the plan
- a training plan to compare against the actual running history

Do **not** use it when the question does not need the user's data — general
training advice, running abroad, watch setup.

## The tool

`strava-digest` is a local Node CLI that reads the user's **own Strava bulk
export** and writes a compact digest. It never touches the Strava API, never
unpacks anything to disk, and never reads `media/` (the photos and videos
inside the export).

Find the command:

```bash
strava-digest --help   # if it is installed globally
node <path-to-repo>/src/cli.ts --help
```

## Step 1: find the export

```bash
strava-digest --find
```

Prints one path per line, full export first. Exit code 0 = found, 1 = not
found. Scans the working folder, `~/Downloads` and `~/Desktop`.

If nothing is found: ask the user to get the export from **Strava → Settings
→ My Account → Download or Delete Your Account**, put the zip in
`~/Downloads`, and run `strava-digest --find` again. Strava quarantines
repeat requests for about a week, so ask for one request and wait rather than
ordering again.

## Step 2: build the digest

```bash
strava-digest <path-to-zip>
```

The default output is the **agent format**: one machine-readable line per run
with every field, plus `SCHEMA`, `SIGNALS`, `WEEKS`, `WINDOW` and `STATS`.
Every run in the export is included — a coaching agent cannot find trends in
a sample.

Per-km splits (pace and average heart rate) are included for every run by
default. On a 196-run export the whole digest is ~49 kB (~14,000 tokens)
against ~22 MB of raw activity data — 454× smaller.

The output is English. The tool reads exports in the account language
(English, Danish, German, Swedish/Norwegian, Dutch, French, Spanish).

Use `--out FIL` if you want to read the file later instead of from stdout.

**Read `SCHEMA` and `SIGNALS` before interpreting anything.** `drift` is
pace-normalised aerobic decoupling in percent (> 5 = aerobic capacity under
pressure), `load` is training load = sum(minutes in zone × 1..5), `half` is
negative when the second half was faster, `z` is the percent of time in each
of the five zones.

## Step 3: the context

`context.md` holds the user's own plan (the week's training, sleep, body,
intent). It is embedded in every digest. Read it as **context, not data** —
it says what the run was *supposed* to be, so you can judge it against the
intent instead of only describing it.

The tool looks for `./context.md` — that is, in the folder you run it from.
If the user has it somewhere else, pass it explicitly:

```bash
strava-digest <path> --context /path/to/context.md
```

If there is no context file, the digest says so and the answer is limited to
describing the data. Ask the user for their plan instead of inventing one.

Users can start from `context.example.md`.

## Start small

On a large export the digest is ~14,000 tokens. That is fine, but for a
first look, or when the model is slow, narrow it:

```bash
strava-digest <path> --last 30          # the last 30 runs
strava-digest <path> --last 30 --days 14  # a two-week window
```

`--last` limits the runs, `--days` the comparison window. The full history
is what finds trends, so widen it once the first answer looks right.

## Max heart rate and zones

Strava's bulk export does **not** contain the watch's own zone configuration.
Without `--max-hr` the tool falls back to the highest heart rate it observed
in the export and says so: the header reads `max_hr=199 source=export-observation`
and the notes repeat that it is observed, not the watch's own max.

Ask the user for their max HR and run with `--max-hr <value>` when zones
matter. Never present a guess as fact — a wrong max HR mislabels every zone,
and the agent then reasons confidently on something wrong.

The observed fallback is usually a single spike, so it is often *higher* than
a real max and makes the training look easier than it is. When the numbers
matter, ask.

## Errors worth knowing

- `No runs found in the export (try --all)` → the activity type may be
  translated to the account language ("Løb" instead of "Run", "Lauf",
  "Löp"), or it may be other activity types — `--all` helps. The tool prints
  the unmapped column names when it cannot place a column, so a new alias is
  one line in `src/columns.ts`.
- A run line containing `err=` means that file could not be read. The rest of
  the digest is still valid.
- `z=-` means the run has no heart-rate data to zone. The zone boundaries
  themselves are never missing: without `--max-hr` they come from the highest
  heart rate in the export.
- When the header says `source=export-observation`, the zone boundaries are a
  guess — usually a single spike, often higher than a real max, so the
  training looks easier than it is. Say so when you use the zone split.

## What not to do

- **Never hand the raw data to the model.** The digest is the whole point: a
  196-run export is ~49 kB (~14,000 tokens) against ~22 MB of raw data.
- **Never invent numbers.** A missing field shows as `-`. If you say there is
  no data, say so — do not guess.
- **Do not edit the user's `context.md`.** It is their own context.
