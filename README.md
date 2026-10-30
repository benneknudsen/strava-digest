# strava-digest

Turns a Strava bulk export into one compact training digest — splits, heart-rate
drift, zones, training load, trends — so an agent can read a whole running
history for ~15,000 tokens instead of ~22 MB of GPS data. **423× smaller**, on
a real 196-run export.

```bash
git clone https://github.com/benneknudsen/strava-digest.git && cd strava-digest
npm install
npm link        # gives you the global `strava-digest` command
```

`npm install` also builds `dist/`, which is what the `strava-digest` command
points at.

**You need:** Node ≥ 22.18 and a terminal. No Strava login, no API key. `~` below
means your home folder — `/Users/you`, `/home/you` or `C:\Users\you`.

Not on npm yet — cloning is quick. If you would rather have
`npm install -g strava-digest`, say so in an issue.

## Get your export

Strava: **Settings → My Account → Download or Delete Your Account**. Order it
there, and download from that page when it is ready — the link Strava emails is a
redirect that can expire.

> **`media/`** in the export is Strava's photos and videos. The tool never reads
> it: images are not training data.

## Use it

```bash
strava-digest --find                        # every export found, one path per line
strava-digest export.zip                    # digest to stdout
strava-digest export.zip --format md        # human-readable Markdown
strava-digest export.zip --out digest.txt
```

`--find` searches the current folder, `~/Downloads` and `~/Desktop`, so you never
have to remember where the zip went. With no arguments in a terminal you get the
same list as a numbered picker.

It also reads a single activity file (`.fit`/`.gpx`/`.tcx`, gzipped or not) or a
folder of them. Strava quarantines bulk-export re-requests for about a week, so
per-activity downloads keep you going while you wait.

## Give it to your agent

**1. Paste it.** Build the digest, open the file, paste it into the chat. Works
with any agent anywhere.

**2. Install a skill.** One command copies a ready-made skill into the agents it
finds on your computer:

```bash
strava-digest --install-skill
```

It checks the usual skills folders for Hermes, Claude Code, Cursor, Codex, Cline
and Aider, and writes only to the ones that are actually there. Example output —
yours will list whichever agents you have, and `installed` becomes `updated` on
a second run:

```
strava-digest — skill installed

  installed   Hermes  →  ~/.hermes/skills/strava-digest/SKILL.md
  installed   Claude Code  →  ~/.claude/skills/strava-digest/SKILL.md
  not found   Cursor, Codex, Cline, Aider

Restart the agent and ask it about your runs.
E.g. "how was my week?" or "what was my longest run?"
```

A skill you already have is updated where the agent keeps it, so you never end up
with two of the same name; a file that differs from the packaged one is backed up
to `SKILL.md.bak` first. `--install-skill <folder>` targets a folder yourself.

**3. Let the repo be read.** `AGENTS.md` tells any agent working in the folder
what the tool does and which rules apply. Claude Code, Codex, Cursor, Aider
and OpenCode read it automatically. Useful if you develop on the tool; for
private use, level 2 is better.

### The skill is not the data

```
SKILL.md (5.7 KB)     = instructions. Tells the agent to run the command.
                        Loaded only when relevant. Holds no data.

strava-digest <zip>   = the compression. Runs locally; the agent never opens
                        the zip. 21.9 MB of raw data → ~15,000 tokens.

The digest (53 kB)    = what the agent actually reads.
```

The skill is not a replacement for the compression — it is the **binding**
between the agent and the compression.

## What the agent gets

Real output from the repo's synthetic fixture (trimmed to two runs):

```
# STRAVA DIGEST v2 (agent-format)
runs_in_export=3
max_hr=181 source=export-observation

## WEEKS (newest first)
w=2026-W42 r=1 km=10.0 t=3360 load=218 hr=156 without_analysis=0
w=2026-W41 r=2 km=14.0 t=4325 load=259 hr=153 without_analysis=0

## WINDOW (last 28 days vs. the 28 days before)
recent: n=3 km=24.0 t=7685 pace=320.2 hr=154 load=477 z=0.0,0.0,41.4,35.4,23.2 without_analysis=0
previous: n=0 km=- t=- pace=- hr=- load=- z=- without_analysis=0

## RUNS (3, newest first)
d=2026-10-12T06:32:10.000Z n="Long run" km=10.00 t=3360 pace=336.0 hr=156/174 z=0.0,0.0,11.1,67.9,21.0 elev=0 drift=4.4 half=-11.0 cv=1.8 pause=0 load=218 sp=1:329@144,2:327@145,…
d=2026-10-09T06:05:00.000Z n="Tempo run" km=6.00 t=1580 pace=263.3 hr=168/181 z=0.0,0.0,0.0,31.4,68.6 elev=0 drift=3.9 half=-2.0 cv=0.4 pause=0 load=122 sp=1:262@160,2:261@161,…
```

One machine-readable line per run, with every field. The `SCHEMA` section says
what each field means and `SIGNALS` says what the thresholds mean, so the
agent never has to guess that `drift=4.4` is a percentage. Decimals are always
a dot, missing values are `-`, and the same file gives the same digest apart
from the `generated=` timestamp.

Beyond what the source has: per-km splits with pace and average heart rate,
pace-normalised aerobic decoupling, negative split, pace consistency, zone
split and training load (`load` = sum(minutes in zone × 1..5)). Across all
runs you also get a week overview, the last 28 days against the 28 before, and
totals (longest run, fastest average, biggest gap, overall zone split).

## What it saves

One real export (240 activities, 196 runs), measured with
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
  digest            53.1 kB  (54349 bytes)  ≈ 15 097 tokens  (196 runs)

SAVING
  423× smaller  —  21.9 MB saved, 99.76 % of the raw size
  423× fewer tokens than the whole export
  354× fewer tokens than the XML a model can even read
```

The byte count is exact; the token count is an estimate at ~3.6 characters
per token, which is close for both XML and the dense machine format.

Reading and digesting that whole export — 242 activity files, 21.9 MB — takes
**0.6 seconds** (2026, Apple M4 Mac mini; it is I/O-bound, so a slower disk
costs more than a slower CPU). The output is deterministic apart from the
`generated=` timestamp line: the same export always gives the same digest, so
week-over-week verdicts stay comparable.

Two things worth noticing: `media/` is never read at all, and 3.1 MB of the
files are binary FIT, which no model can read — the tool parses them, which is
the job. The honest comparison is therefore the 18.3 MB of XML: **354× fewer
tokens**, and every number in the digest is one the model can reason about.

## Flags

```
--last N        number of runs in the digest (default: all)
--detail N      only the newest N runs get per-km splits (default: all)
--all           include all activity types, not just runs
--list          show only the index of activities
--find          find possible exports and print them as paths (one per line)
--install-skill copy the agent skill to the agents found on your computer
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
`src/columns.ts` — they are all in one table. The default agent format says
how many populated export columns it could not place; run with `--format md`
to see up to 12 of their header names, so a new alias is one line.

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

Keep your export — and anything you unpack from it — out of version control: the
files contain GPS tracks and other personal data. If you work in a checkout of
this repo, `.gitignore` already covers that case (`context.md`, `runs/`, and the
raw activity formats).

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

## Versions

There are two, and they mean different things.

**The package version** (`1.0.3`) is the tool: the commands, the flags, the
exit codes. It follows semver, so 1.x will not break your command line.

**The agent format version** (`STRAVA DIGEST v2`, in the first line of the
digest) is the shape of the data — the field names, what they mean, what a
missing value looks like. It can move on its own. An agent that caches the
format should check that line and read `SCHEMA` and `SIGNALS` again when it
changes.

A format change is not a package change: a digest can be `v2` from a `1.4.0`
package.

## Changelog: [CHANGELOG.md](CHANGELOG.md)
