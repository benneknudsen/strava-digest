# strava-digest

Turns a Strava bulk export into one compact training digest — splits, heart-rate
drift, zones, training load, trends — so an agent can read a whole running
history for ~14,000 tokens instead of ~22 MB of GPS data. **457× smaller**, on
a real 196-run export.

```bash
git clone https://github.com/benneknudsen/strava-digest.git && cd strava-digest
npm install
npm link        # gives you the global `strava-digest` command
```

`npm install` also builds `dist/`, which is what the `strava-digest` command
points at. Requires Node ≥ 22.18.

Not on npm yet — cloning takes about twenty seconds. If you would rather have
`npm install -g strava-digest`, say so in an issue.

## Get your export

Strava: **Settings → My Account → Download or Delete Your Account**. Order it
there; the download link appears on the same page when it is ready. Put the zip
in `~/Downloads`.

> **`media/`** in a Strava export is a folder of photos and videos. It is part
> of *the export*, not of your machine, and the tool skips it on purpose —
> images are not training data.

## Use it

```bash
strava-digest --find              # find the export: one path per line
strava-digest <path>              # digest to stdout
strava-digest <path> --format md  # human-readable Markdown
strava-digest <path> --out f.txt  # digest to a file
```

Run with no arguments in a terminal and you get a numbered picker instead. It
also reads a single activity file (`.fit`/`.gpx`/`.tcx`, gzipped or not) or a
folder of them, if you have no bulk export.

## Give it to your agent

**1. Paste it.** Build the digest, open the file, paste it into the chat. Works
with any agent anywhere.

**2. Install a skill.** One command puts a ready-made skill in the agents that
are actually on the machine:

```bash
strava-digest --install-skill
```

```
strava-digest — skill installed

  installed   Hermes  →  /Users/you/.hermes/skills/strava-digest/SKILL.md
  installed   Claude Code  →  /Users/you/.claude/skills/strava-digest/SKILL.md
  not found   Cursor, Codex, Cline, Aider

Restart the agent and ask it about your runs.
E.g. "how was my week?" or "what was my longest run?"
```

An existing skill is updated where it lives, so you never end up with two of
the same name. Your own version is backed up to `SKILL.md.bak` first. Point at
one folder to override: `strava-digest --install-skill ~/.hermes/skills`.

**3. Let the repo be read.** `AGENTS.md` tells any agent working in the folder
what the tool does and which rules apply. Claude Code, Codex, Cursor, Aider
and OpenCode read it automatically. Useful if you develop on the tool; for
private use, level 2 is better.

### The skill is not the data

Worth being precise about, because it is easy to misunderstand:

```
SKILL.md (4 KB)       = instructions. Tells the agent to run the command.
                        Loaded only when relevant. Holds no data.

strava-digest <zip>   = the compression. Runs locally; the agent never opens
                        the zip. 22 MB of raw data → ~14,000 tokens.

The digest (49 kB)    = what the agent actually reads.
```

The skill is not a replacement for the compression — it is the **binding**
between the agent and the compression.

## What the agent gets

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
d=2026-10-16T08:18:29.000Z n="Morning run" km=7.02 t=3076 pace=438.2 hr=142/159
z=3.1,31.0,66.0,0.0,0.0 elev=120 drift=5.7 half=-1.0 cv=2.0 pause=0 load=48
sp=1:421@127,2:435@141
```

One machine-readable line per run, with every field. The `SCHEMA` section says
what each field means and `SIGNALS` says what the thresholds mean, so the
agent never has to guess that `drift=5.7` is a percentage. Decimals are always
a dot, missing values are `-`, and the same file always gives the same digest.

Beyond what the source has: per-km splits with pace and average heart rate,
pace-normalised aerobic decoupling, negative split, pace consistency, zone
split and training load (`load` = sum(minutes in zone × 1..5)). Across all
runs you also get a week overview, the last 28 days against the 28 before, and
totals (longest run, fastest average, biggest gap, overall zone split).

## What it saves

Measured on a real 240-activity export (196 runs) with
`node scripts/measure-compression.mjs <export.zip>`:

```
RAW
  activity files    21.4 MB  (242 files)
  activities.csv   118.2 kB  (39 files)
  other            422.3 kB  (5 files)
  media/             6.0 MB  (19 files, never read)
  ─────────────────────────
  raw, no media     21.9 MB  ≈ 6 390 912 tokens
  of which
    binary FIT       3.1 MB  unreadable by any model
    XML (tcx/gpx)   18.3 MB  ≈ 5 341 344 tokens

DIGEST
  digest            49.2 kB  (50349 bytes)  ≈ 13 986 tokens  (196 runs)

SAVING
  457× smaller  —  21.9 MB saved, 99.78 % of the raw size
  457× fewer tokens than the whole export
  382× fewer tokens than the XML a model can even read
```

The bytes are exact; the token counts are estimated at ~3.6 characters per
token, which is close for both XML and the dense machine format.

It takes **0.6 seconds** to read and digest that whole export — 242 activity
files, 21.9 MB — and the output is deterministic: the same export always
gives the same digest, byte for byte.

Two things worth noticing. First, `media/` — 6 MB of photos and videos — is
never read at all. Second, 3.1 MB of the activity files are **binary FIT**,
which no model can read at all; the tool parses them, which is the entire
job. The honest comparison is therefore the 18.3 MB of XML: **382× fewer
tokens**, and every number in the digest is one the model can actually
reason about.

## Flags

```
--last N        number of runs in the digest (default: all)
--detail N      only the newest N runs get per-km splits (default: all)
--all           include all activity types, not just runs
--list          show only the index of activities
--find          find possible exports and print them as paths (one per line)
--install-skill copy the agent skill to the agents found on this machine
--out FIL       write to a file instead of stdout
--json          machine-readable JSON instead of the digest
--format md     human-readable Markdown instead of the agent format
--days N        comparison window in days (default 28)
--max-hr N      max heart rate for the zone split (Z1–Z5 = 50–100 % of max)
--context FIL   context file to embed (default ./context.md if it exists)
```

## context.md

The digest says what you ran, not what you *meant*. Write the plan, sleep and
intent in `context.md` and the agent can judge a run against the intention
instead of only describing it. Copy `context.example.md` to start. The file is
gitignored — the content is personal.

## Languages

Strava translates the export to the account language, so the tool reads English,
Danish, German, Swedish/Norwegian, Dutch, French and Spanish — column names,
month names, date formats and activity types. The **output is always English**,
and the agent format is language-neutral (`km`, `t`, `pace`, `hr`, `z`,
`drift`, `load`).

A language that is not covered yet needs a couple of aliases in
`src/columns.ts` — they are all in one table, and the tool prints the real
header row when it cannot place a column, so a new alias is one line.

## Notes on the data

**Zones.** `Z1`–`Z5` are 50–100 % of max heart rate. Strava's export does not
contain the watch's own zone configuration, so without `--max-hr` the tool
falls back to the highest heart rate it observed in the export, and says so in
the header (`source=export-observation`) and in the notes. A wrong max HR
mislabels every zone, so pass `--max-hr <your max>` if you know it.

**Localised exports.** The same column arrives as `Average Heart Rate` or
`Gennemsnitlig puls`, the date as `Oct 12, 2026` or `12. okt. 2026`, and the
activity type as `Run` or `Løb`. Everything is parsed explicitly, because
`new Date("12.10.2026")` silently means 10 December.

**Strava's FIT files** put every field in its own message, so distance, heart
rate and elevation are merged per timestamp and distance is interpolated
between measurements. If a file has no distance, it is derived from GPS; if it
has no speed, from distance and time. The digest says when it did that.

**Formats vary**: `.fit.gz`, `.fit`, `.tcx.gz`, `.tcx`, `.gpx`. Archives are
read as a stream — nothing is unpacked to disk.

## Compliance

The tool does **not** touch the Strava API: no credentials, no calls, no
server. It reads a file the user downloaded themselves through Strava's Bulk
Data Export Tool — a right Strava describes as follows (API Policy 2026,
§6.6):

> "Each Strava user has the right to access and export the user's own Strava
> data, free of charge, through the Bulk Data Export Tool published on the
> Strava service. Nothing in this Agreement is intended to limit or condition
> that user-facing right."

The digest is meant to be read by an agent, but the export is the user's own,
and what the user does with it is the user's choice. The tool itself calls
neither the Strava API nor any LLM, and it stores or sends nothing.

Nothing beyond the §6.6 quote above has been verified here: which other
paragraphs of Strava's terms apply to the individual use, we do not know, and
we do not guess. Read Strava's own terms if you are in doubt.

Keep the export and `runs/` out of version control — the files contain GPS
tracks and other personal data.

## Development

```bash
npm test          # synthetic fixtures, the whole pipeline
npm run typecheck
```

The tests use synthetic data only — no personal data, no real GPS tracks. CI
runs them on macOS, Linux and Windows, Node 22 and 24. Two runtime
dependencies, both pure JS: `fit-file-parser` and `yauzl`.

The one binary fixture, `fixtures/sample.fit`, is a public example from
[`dtcooper/python-fitparse`](https://github.com/dtcooper/python-fitparse)
(MIT), used to test the FIT parsing on a real binary file.

## License

MIT — see [LICENSE](LICENSE).

Changelog: [CHANGELOG.md](CHANGELOG.md)
