# strava-digest

A local CLI that turns a Strava bulk export — or loose activity files — into
one compact training digest. The digest is built to be read by an agent:
splits, HR drift, pace consistency, zones, training load and trends — instead
of feeding it megabytes of GPS points.

- **Bulk:** the zip file, or the folder containing `activities.csv`.
- **Loose files:** a single activity file (`.fit`, `.gpx` or `.tcx`, also
  `.gz`) or a folder with them.

The zip is read as a stream: nothing is unpacked to disk, and `.fit.gz` is
gunzipped in memory.

> **`media/`** in a Strava export is a folder with photos and videos of the
> activities. It is part of *the export*, not of your machine, and the tool
> skips it on purpose — images are not training data.

The default output is an **agent format**: one machine-readable line per run
with every field, a week overview, a statistics section and a `SCHEMA` that
explains what every field means. On an export with 196 runs the whole digest
is ~14,900 tokens against ~28 MB of raw data.

## Getting started

Terminal CLI: no GUI, no server, no build step. Requires Node ≥ 22.18.

```bash
git clone https://github.com/benneknudsen/strava-digest.git && cd strava-digest
npm install
npm link        # gives you the global strava-digest command
```

`npm link` is optional. Without it you can run the tool with
`node src/cli.ts <path>` — recent Node versions run TypeScript directly, so
there is no build step.

### Get your export

Strava makes the bulk export available in your account: **Settings → My
Account → Download or Delete Your Account**. You order it there, and the same
page shows the download link when it is ready. The link in the email is a
tracking link that dies on the server — go back to the account page instead of
boiling the email down.

Strava quarantines repeat requests for about a week, so it cannot be too
picky about ordering again.

Put the zip in `~/Downloads` and run:

```bash
strava-digest ~/Downloads/strava_export_12345678.zip
```

### Interactive picker

Run it without arguments in a real terminal window and you get a picker. It
scans the working folder, `~/Downloads` and `~/Desktop` (most recently
modified first, max 15):

```text
$ strava-digest
1)  activity folder · 8 files · ~/Downloads
2)  zip · 4 files · ~/Downloads/export_123456.zip
3)  activity folder · 4 files · ~/Downloads/strava-filer
4)  csv folder · 4 files · ~/Downloads/export_123456
Pick a number (or paste a path, q = quit): q
```

`q` quits without doing anything, and you can paste or drag a path straight in.
Outside a terminal — and with `--help` — the help text is printed instead. If
you already have the path, skip the picker:

```bash
strava-digest ~/Downloads/export_123456.zip
```

Uninstall: `npm unlink -g strava-digest`. The package stays `private`;
nothing is published to npm.

On Windows: use a full path or `$HOME` instead of `~` in PowerShell, and quote
the path if it contains spaces.

### Flags

```
--last N        number of runs in the digest (default: all)
--detail N      only the newest N runs get per-km splits (default: all)
--all           include all activity types, not just runs
--list          show only the index of activities
--find          find possible exports and print them as paths (one per line)
--out FIL       write to a file instead of stdout
--json          machine-readable JSON instead of the digest
--format md     human-readable Markdown instead of the agent format
--days N        comparison window in days (default 28)
--max-hr N      max heart rate for the zone split (Z1–Z5 = 50–100 % of max)
--context FIL   context file to embed (default ./context.md if it exists)
```

## How it works in practice

The whole path is three things: **a zip file** (your data), **a CLI** (makes a
digest out of it), **an agent** (reads the digest and answers).

```
  Strava account                Your machine                   Your agent
  ─────────────                 ────────────                   ─────────
  Settings → Download           ~/Downloads/strava_export….zip
       │                               │
       │                               │  strava-digest --find
       │                               │  strava-digest <zip>
       │                               ▼
       └──────────────────────▶  ~14,900 token digest
                                        │
                                        │  write your plan in context.md
                                        ▼
                                   "How was my week?"
```

No server, no account, no upload. The zip stays on your machine, and only
*the digest* — that is, the numbers — reaches the agent.

### Getting started as a new user

```bash
git clone https://github.com/benneknudsen/strava-digest.git
cd strava-digest
npm install
npm link                    # makes `strava-digest` a global command
```

Then order your export in Strava (**Settings → My Account → Download or
Delete Your Account**), put the zip in `~/Downloads`, and:

```bash
strava-digest --find               # → /Users/you/Downloads/strava_export_….zip
strava-digest ~/Downloads/strava_export_….zip
```

Without `npm link`, `node src/cli.ts <path>` works just as well — there is no
build step.

### Give the agent access

This is where it gets interesting. There are three levels, from easiest to
most automatic:

**1. Paste it into the chat.** The simplest form:

```bash
strava-digest ~/Downloads/strava_export_….zip --out ~/strava-digest.txt
```

Open the file, copy the contents into your agent chat, and ask. Works with any
agent anywhere. Not automatic, but it works.

**2. Install a skill.** One command installs the skill into the agents that
are actually present on the machine:

```bash
strava-digest --install-skill
```

```
strava-digest — skill installed

  installed  Hermes  →  /Users/you/.hermes/skills/strava-digest/SKILL.md
  installed  Claude Code  →  /Users/you/.claude/skills/strava-digest/SKILL.md
  not found  Cursor
  not found  Codex

Restart the agent, and ask it about your runs.
E.g. "how was my week?" or "what was my longest run?"
```

Only agents that are actually installed get a skill. An existing skill is
updated where it lives — even if the agent put it in a subfolder — so you do
not end up with two skills of the same name. Your own customisation is backed
up to `SKILL.md.bak` before it is overwritten.

With a folder argument it is installed in one specific place:

```bash
strava-digest --install-skill ~/.hermes/skills
```

The skill also lives in the repo as `skills/strava-digest/SKILL.md`, if you
want to read it or copy it yourself.

**3. Let the repo be read automatically.** `AGENTS.md` in the repo tells any
agent working in the folder what the tool does and which rules apply. Agents
such as Claude Code, Codex, Cursor, Aider and OpenCode read it automatically.
It is useful if you *develop* on the tool — for private use, level 2 is better.

> Which agent do you use? Most of them can read a `SKILL.md` (level 2), and
> any agent that can run a command can get access without a skill at all —
> just ask it to run `strava-digest --find` and `strava-digest <path>`.

### The skill is not the data

This is the part that is easy to misunderstand, so it is worth being precise.

```
SKILL.md (4 KB)       = INSTRUCTIONS. Tells the agent to run the command.
                        Loaded only when the topic is relevant. Holds NO data.

strava-digest <zip>   = THE COMPRESSION. Runs locally; the agent never opens
                        the zip. 28 MB of raw data → ~14,900 tokens.

The digest (14.9 KB)  = What the agent actually reads.
```

The agent never sees the zip. It reads the skill (which says "run
`strava-digest --find`, then `strava-digest <path>`") and the *result* —
14,900 tokens holding all 196 runs with splits, zones and HR drift. Without
the tool, the agent would have to read 28 MB of GPS points, which is millions
of tokens.

So the skill is not a replacement for the compression — it is the **binding**
between the agent and the compression.

### Step 1: find the export

`--find` scans the same places as the interactive picker and prints **one path
per line** — no headers, no numbering. It is built for scripting: an agent
should not have to parse a human-readable list.

```bash
strava-digest --find
/Users/you/Downloads/strava_export_12345678.zip
```

Exit code 0 when something was found, 1 when it was not. A full export (zip or
folder with `activities.csv`) comes first.

### Step 2: build the digest

```bash
strava-digest /Users/you/Downloads/strava_export_12345678.zip
```

The output goes to stdout. With `--out FIL` it is written to a file instead,
which is handy when the agent should read it later:

```bash
strava-digest ~/Downloads/strava_export_12345678.zip --out ~/strava-digest.txt
```

### Step 3: give the agent the context

The digest tells the agent what you ran. It does not tell it what you
*meant*. Write that in `context.md` — plan, sleep, body, the purpose of the
period — so the agent can judge a run against the intent instead of just
describing it.

```markdown
# Context for the digest

Week: 12–18 October 2026
- Plan: 1 tempo (Z3) + 2 easy (Z2)
- Sleep: 6.5–7.5 hours, one good night
- Purpose: build volume, not chase pace
```

Copy [`context.example.md`](context.example.md) as a starting point. The file
is called `context.md` in the folder you run the tool from, or you can point
at another one with `--context FIL`. It is embedded in every digest. It is
gitignored, because the content is personal.

### Languages

Strava translates the export to the **account language**, so the same tool has
to read several languages. **The output is always English** — the CLI help and
the Markdown digest — while the *input* is read in the language the export
happens to be in.

| What | Covered |
|---|---|
| Column names in `activities.csv` | English, Danish, German, Swedish/Norwegian, Dutch, French, Spanish (`activity date`, `aktivitet dato`, `Aktivitätsdatum`, `datum`, `fecha de actividad`, …) |
| Month names in dates | English, Danish, German, Swedish, Dutch, Norwegian, French, Spanish (`Oct 12, 2026`, `12. okt. 2026`, `12. März 2026`, `12 février 2026`, `12 de octubre de 2026`, …) |
| Date order | day-first (`12.10.2026`), month-first (`10/12/2026`), ISO (`2026-10-12`) |
| Activity types | English, Danish (`Run`, `Løb`), German (`Lauf`), Swedish/Norwegian (`Löp`, `Løp`, `Löpning`), Dutch (`Hardlopen`), French (`Course à pied`), Spanish (`Carrera`) |
| 12-hour clock | `AM`/`PM` |

Accents are folded, not deleted: `Löp` becomes `lop`, not `lp`. That
distinction matters — a Swedish account whose activity type was silently
stripped to `lp` would show **zero runs** with no error anywhere.

The **agent format is language-neutral**: the field names are `km`, `t`,
`pace`, `hr`, `z`, `drift`, `load`, so an agent reads it the same way whatever
the language.

A language that is not covered yet needs a couple of aliases added in
`src/columns.ts` — they are all in one table. The tool says so very
concretely if a column is not recognised: it prints the actual header row, so
a new alias is one line.

### About MCP

The tool is a CLI, so an MCP server is a thin wrapper — call `strava-digest`
as a tool and return stdout. That is the route if your agent *only* speaks
MCP.

## What the agent gets to read

```
# STRAVA DIGEST v2 (agent format)
runs_in_export=196
max_hr=199 source=flag

## WEEKS (newest first)
w=2026-W42 r=1 km=7.0 t=3076 load=48 hr=142

## WINDOW (last 28 days vs. the 28 days before)
recent: n=3 km=24.0 t=7685 pace=320.2 hr=154 load=442 z=0.0,0.0,52.0,42.0,6.0
previous: n=0 km=0.0 t=0 pace=- hr=- load=- z=-

## RUNS (196, newest first)
d=2026-10-16T08:18:29.000Z n="Morning run" km=7.02 t=3076 pace=438.2 hr=142/159 z=3.1,31.0,66.0,0.0,0.0 elev=120 drift=5.7 half=-1.0 cv=2.0 pause=0 load=48 sp=1:421@127,2:435@141
```

The design rules:

- **Everything.** The default is *all* runs in the export, not a selection. A
  coaching agent cannot find trends in five runs. On a real export with 196
  runs the whole digest is ~14,900 tokens against ~28 MB of raw data.
- **Self-describing.** The field names appear in the SCHEMA section once, and
  the SIGNALS section says what the thresholds mean. The agent should not
  have to guess that `drift=5.7` is a percentage.
- **Machine-readable.** The decimal separator is always a dot, missing values
  are `-`, and every run line has exactly the same keys in the same order.
- **Derived numbers included.** Splits, HR drift, zones, negative split, pace
  consistency and training load (`load` = sum(min in zone × 1..5)) are the
  fields the source does not have. Without them the agent just repeats the
  user's own numbers.
- **Deterministic.** The same file gives the same numbers and the same digest
  apart from the timestamp in the first line, so the agent's answers can be
  compared across weeks.

`--detail N` controls how many of the newest runs get the full per-km split
detail (default: all); the rest get the other fields. `--format md` gives the
human-readable Markdown, if you want to read it yourself.

## Examples

All examples were run on the synthetic test files; the output is copied from
the runs, but the paths are shortened compared to the raw printout (e.g. to
`~`). The tool never shortens the path itself (e.g. to `~`); the interactive
picker always shows full, absolute paths.

### Bulk: zip

```text
$ strava-digest ~/Downloads/export_123456.zip --max-hr 190
# STRAVA DIGEST v2 (agent format)
generated=2026-10-20T17:13:36.482Z
source=~/Downloads/export_123456.zip (zip, 6 files)
activities_in_export=4
runs_in_export=3
runs_shown=3
detail_runs=3 (newest, include per-km splits)
max_hr=190 source=flag

## SCHEMA
row fields (one run per line, newest first):
  d=ISO8601 timestamp (UTC) | n=name | km=distance | t=moving time in seconds
  pace=seconds per km | hr=average/max heart rate | z=Z1,Z2,Z3,Z4,Z5 in % of time with HR
  elev=elevation in m | drift=pace-normalised HR drift in % (see SIGNALS)
  half=2nd half minus 1st half in s/km (negative = negative split)
  cv=pace consistency, coefficient of variation in % | pause=number of pauses
  load=training load, sum(min in zone * 1..5)
  sp=per-km splits: <km>:<pace_s/km>@<hr>, * = partial km
…
## WEEKS (newest first)
w=2026-W42 r=1 km=10.0 t=3360 load=193 hr=156
w=2026-W41 r=2 km=14.0 t=4325 load=249 hr=153

## WINDOW (last 28 days vs. the 28 days before)
recent: n=3 km=24.0 t=7685 pace=320.2 hr=154 load=442 z=0.0,0.0,52.0,42.0,6.0
previous: n=0 km=0.0 t=0 pace=- hr=- load=- z=-

## RUNS (3, newest first)
d=2026-10-12T06:32:10.000Z n="Long run" km=10.00 t=3360 pace=336.0 hr=156/174 z=0.0,0.0,36.1,63.9,0.0 elev=0 drift=4.4 half=-11.0 cv=1.8 pause=0 load=193 sp=1:329@144,2:327@145,3:325@149,4:323@151,5:320@153,6:318@157,7:316@158,8:314@162,9:312@163,10*:309@167
d=2026-10-09T06:05:00.000Z n="Tempo" km=6.00 t=1580 pace=263.3 hr=168/181 z=0.0,0.0,0.0,71.3,28.7 elev=0 drift=3.9 half=-2.0 cv=0.4 pause=0 load=111 sp=1:262@160,2:261@161,3:260@166,4:260@168,5:259@172,6:258@174
d=2026-10-07T07:15:00.000Z n="Easy run" km=8.00 t=2745 pace=343.1 hr=137/145 z=0.0,0.0,100.0,0.0,0.0 elev=0 drift=1.2 half=-1.5 cv=0.2 pause=0 load=137 sp=1:345@135,2:345@135,3:344@135,4:344@137,5:344@136,6:343@138,7:343@138,8*:343@138

## STATS (whole period)
runs=3 km_total=24.0 median_km=8.00
longest_run=10.00 km on 2026-10-12 (Long run)
fastest_avg_pace=263.3 s/km on 2026-10-09 (Tempo)
max_gap=2.0 days (2026-10-09 -> 2026-10-12)
…
```

### Bulk: folder with `activities.csv`

```text
$ strava-digest ~/Downloads/export_123456 --max-hr 190
# STRAVA DIGEST v2 (agent format)
source=~/Downloads/export_123456 (folder, 6 files)
…
```

The rest is identical to the zip example above — only the source line differs.

### Loose files: a single activity file

```text
$ strava-digest ~/Downloads/strava-filer/Run-1001.gpx
# STRAVA DIGEST v2 (agent format)
source=~/Downloads/strava-filer/Run-1001.gpx (file) · metadata read from the file
activities_in_export=1
runs_in_export=1
max_hr=- source=-

## RUNS (1, newest first)
d=2026-10-12T06:30:00.330Z n="Run-1001" km=9.99 t=3190 pace=319.4 hr=155/168 z=- elev=0 drift=4.4 half=-11.0 cv=1.8 pause=0 load=- sp=1:329@144,2:327@145,3:325@149,4:323@151,5:320@153,6:318@157,7:316@158,8:314@162,9:312@163,10*:309@167

## NOTES
- Without activities.csv the export's name is not found — the name in the digest comes from the filename. Relative Effort, gear and calories are omitted.
```

### Loose files: folder

```text
$ strava-digest ~/Downloads/strava-filer --max-hr 190
# STRAVA DIGEST v2 (agent format)
source=~/Downloads/strava-filer (folder, 4 activity files) · metadata read from the files
activities_in_export=4
runs_in_export=3
…

## NOTES
- Without activities.csv the export's name is not found — the name in the digest comes from the filename. Relative Effort, gear and calories are omitted. 1 file skipped: NoTime.gpx (no usable time).
```

(The output is shortened — only the Notes section is shown beyond the top; the
per-run lines are as above.)

### `--list`

```text
$ strava-digest ~/Downloads/export_123456 --list
2026-10-12  RUN  Run             Run-1001.gpx  zones: no
2026-10-09  RUN  Run             Run-1002.tcx  zones: no
2026-10-07  RUN  Run             Run-1003.gpx  zones: no
2026-10-06       Ride            Ride-1004.fit.gz  zones: no

4 activities in total (shown: 4)
```

### `--max-hr` (zones)

```text
$ strava-digest ~/Downloads/strava-filer/Run-1001.gpx --max-hr 190
max_hr=190 source=flag
…
d=2026-10-12T06:30:00.330Z n="Run-1001" km=9.99 t=3190 pace=319.4 hr=155/168 z=0.0,0.0,36.1,63.9,0.0 elev=0 drift=4.4 …
```

Without the flag the zone field is `-` (empty), and the header says
`max_hr=- source=-`. If the boundaries come from the watch's own FIT file, the
header says `source=fit` instead of `source=flag`. In the Markdown format it
says `from the watch` instead of `from --max-hr`.

### `--json`

```text
$ strava-digest ~/Downloads/strava-filer/Run-1001.gpx --last 1 --max-hr 190 --json
{
  "sourceLabel": "~/Downloads/strava-filer/Run-1001.gpx (file) · metadata read from the file",
  "activitiesInExport": 1,
  "runs": [
    {
      "row": {
        "id": "",
        "date": "2026-10-12T06:30:00.330Z",
        "name": "Run-1001",
        "type": "running",
        "distanceM": 9987.75070106866,
        "movingSec": 3189.681,
        "elapsedSec": 3189.681,
        "avgHr": 154.91734784764998,
        "maxHr": 168,
        "relativeEffort": null,
        "elevationGain": null,
        "calories": null,
        "gear": "",
        "filename": "Run-1001.gpx",
        "isRun": true
      },
      …
```

(The output is shortened: the rest is `analysis`, the baseline fields and the
whole `markdown` field.)

### `--out`

```text
$ strava-digest ~/Downloads/export_123456.zip --out runs/digest.txt
wrote …/strava-digest/runs/digest.txt (N characters)
```

The digest is written to the file; the stderr line says where. The folder is
created if it is missing. The character count depends on the path length — the
source line contains the full path.

## What the digest contains

Per run:

- **Per-km splits** with pace and average heart rate; the last partial km is
  marked with `*`.
- **HR drift (decoupling):** pace-normalised efficiency in the first vs. the
  second half, warm-up and pauses excluded. In the agent format the
  thresholds are in the SIGNALS section: >5 % = aerobic capacity under
  pressure, >10 % = clearly under pressure.
- **Negative/positive split:** the pace difference between the two halves.
- **Pauses:** stops >20 s without progress — count and total time.
- **Pace consistency:** coefficient of variation over the km splits.
- **Zones:** time in Z1–Z5 (effective time, pauses excluded) and the easy
  share, Z1–Z2.
- **Training load:** `load` = sum(min in zone × 1..5) — the load number you
  can compare week by week.
- **Cadence:** average from the file, when it is there.
- **Distance derivation:** if the file has no distance fields, the distance is
  derived from GPS positions (haversine); if the speed is missing, it is
  derived from distance and time with smoothing. The digest says so with a
  note.

Across the runs:

- **Week overview** (`## WEEKS`): runs, km, time, load and average heart rate
  per ISO week — the tightest way to see trends.
- **Window comparison** (`## WINDOW`): the last 28 days (`--days N`) against
  the 28 days before, with the change in km and load.
- **Statistics** (`## STATS`): total km, median, longest run, fastest
  average, the biggest gap between two runs, average drift and the overall
  zone split.

Only the bulk mode has the fields from `activities.csv`: the name from the
export, Relative Effort and gear (shown per run) plus calories (included in
the JSON). Loose files take the name from the filename and omit the rest
rather than inventing it.

## Zones

The zone line per run shows where the time actually went: percent in Z1–Z5,
weighted by effective time using the same pause rule as the splits. The
baseline block sums the seconds across the runs in the window and shows how
big a share was easy work, Z1–Z2.

The boundaries are taken in this order — nothing is ever guessed:

1. `--max-hr N` (the flag wins).
2. The watch's own zones, if the FIT file has `zones_target`/`hr_zone`
   messages (`from the watch` in the output).
3. Otherwise no zone split — just a note on the run saying why.

When a standard model is needed (the flag, or the watch's max HR without
boundaries), it is a percentage of max heart rate:

| Zone | Heart rate |
|------|------|
| Z1 | 50–60 % of max |
| Z2 | 60–70 % of max |
| Z3 | 70–80 % of max |
| Z4 | 80–90 % of max |
| Z5 | 90–100 % of max |

If the FIT file has zone boundaries but no max heart rate, the max HR is
derived from the top boundary with the standard model — Z4 ends at 90 % of
max, so the max HR is the file's top boundary / 0.9 (rounded). That is a
derivation of the file's own boundaries, not a guess.

The digest's zone line writes which max HR and source the zones come from
(`from the watch` or `from --max-hr`), so the output is deterministically
comparable.

## Robustness that is built in on purpose

The export is **localised**, and that is a known trap: a third-party importer
was broken by Chinese column names. Therefore:

- **Columns are mapped via aliases** (English + Danish) with an exact match
  first, then a looser match. Everything unmapped is listed in the digest's
  "Notes", so a new alias is one line in `src/columns.ts`.
- **Dates are parsed explicitly.** `new Date("12. okt. 2026, 06:32")` is
  `Invalid Date`, and `new Date("12.10.2026")` gives *10 December* (US
  order) — a silent error. We read day-month-year at dots/dashes, month-day
  at slashes, and handle the 12-hour AM/PM clock.
- **Activity types are translated.** Strava shows the type in the user's
  language — "Run" becomes "Løb" on a Danish account — so the type matching
  normalises `ø/æ/å` before comparing. Without it, 190 of 195 runs fell out
  of the pool.
- **Strava's FIT files are peculiar.** Every field lives in its own message,
  so distance, heart rate and elevation are spread out beyond the individual
  records. The messages are merged per timestamp, and distance is interpolated
  between measurements.
- **`activities.csv` is authoritative** for linking the activity ID to the
  filename; missing files give a note on the run instead of a crash.
- **Varying formats:** the same run can be `.fit.gz`, `.fit`, `.tcx.gz`,
  `.tcx` or `.gpx`. If the distance is missing from the file, it is derived
  from GPS (haversine), and if the speed is missing, it is derived from
  distance/time with smoothing.
- **Mislabelled `.gz`:** a `.fit.gz` that is not gzip falls back to raw bytes.
- **Archives are read as a stream**: `media/` (the images and videos inside
  the export) is skipped, and nothing is unpacked to disk.

## Troubleshooting and known limits

- **A flag without a path fails** instead of showing the interactive picker:
  `strava-digest --last 5` prints `missing path to export (zip, folder or
  activity file)` and stops with exit code 1.
- **A TCX without both distance fields and GPS positions** can show `0.00
  km`; the same can happen with a GPX track where the positions do not move.
  There is a note saying the distance was derived from GPS. A FIT file
  without distance shows `–` in loose-file mode; in bulk mode, where
  `activities.csv` carries the distance, it shows `0.00 km` instead.
- **Files without usable time** and files with fewer than 2 points are
  skipped with a note — in the digest as `1 file skipped: NoTime.gpx (no
  usable time)`, in `--list` as `(skipped)` and the reason, e.g. `(only 1
  point)`.

## The human half: context.md

Copy `context.example.md` to `context.md` and write what the week was
*supposed* to be, your form and your sleep. Without it the agent can only
repeat your own numbers back to you. `--context FIL` points at another file;
the default is `./context.md`, if it exists.

## Tests

```
npm test          # generates synthetic fixtures and verifies the whole pipeline
npm run typecheck
```

The tests are synthetic — no personal data, no real GPS tracks. They check
distance, number of splits, the HR drift interval, negative split, heart-rate
level and that the digest is under 4 KB and at least 50× smaller than the raw
data. They also cover loose activity files (date, type and heart rate read
from the file, a note for files without a timestamp), the zone selection
(flag → watch's zones → none) and the pure `discoverSources` function behind
the interactive start.

## Compliance

This tool does **not** touch the Strava API: no credentials, no calls, no
server. It reads a file the user has downloaded themselves through Strava's
Bulk Data Export Tool — a right Strava describes as follows (API Policy 2026,
§6.6):

> "Each Strava user has the right to access and export the user's own Strava
> data, free of charge, through the Bulk Data Export Tool published on the
> Strava service. Nothing in this Agreement is intended to limit or condition
> that user-facing right."

The digest is meant to be read by an agent, but the export is the user's own,
and what the user does with it is the user's choice. The tool itself calls
neither the Strava API nor any LLM, and it stores or sends nothing — it reads
local files and writes a local document.

Nothing beyond the §6.6 quote above has been verified here: which other
paragraphs of Strava's terms apply to the individual use, we do not know, and
we do not guess. Read Strava's own terms if you are in doubt.

Keep the export and `runs/` out of version control (see `.gitignore`): the
files contain GPS tracks and other personal data.

## Dependencies

Two runtime dependencies: `fit-file-parser` (FIT) and `yauzl` (streaming zip
reading). Both are pure JS, and gunzip comes from `node:zlib` — no native
modules, no build step. CI runs the tests on macOS, Linux and Windows with
Node 22 and 24.

## Test data and attribution

All fixtures are generated by `scripts/make-fixtures.mjs` and are synthetic —
no personal data, no real GPS tracks, no real heart rate. The exception is
`fixtures/sample.fit`, which is a public example of a FIT file from
[`dtcooper/python-fitparse`](https://github.com/dtcooper/python-fitparse)
(`tests/files/Activity.fit`, MIT), used to test the FIT parsing on a real
binary file rather than on a generator.

## License

MIT — see [LICENSE](LICENSE).
