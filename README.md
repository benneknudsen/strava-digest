# strava-digest

Lokal CLI der laver ét kompakt træningsdigest af Stravas bulk-eksport eller af løse aktivitetsfiler. Digesten er bygget til at blive læst af en agent — splits, HR-drift, pace-jævnhed, zoner og en baseline — i stedet for at fodre den med megabyte GPS-punkter.

- **Bulk:** zip-filen eller mappen med `activities.csv`.
- **Løse filer:** en enkelt aktivitetsfil (`.fit`, `.gpx` eller `.tcx`, også `.gz`) eller en mappe med dem.

Zippen læses streamende: intet pakkes ud til disk, `media/` røres aldrig, og `.fit.gz` gunzippes i hukommelsen.

Digesten for en 10 km-tur er ~800 tegn ≈ 200 tokens — målt i testen 861 tegn mod 2.350.158 tegn rå GPX for samme tur, altså 2.730× mindre. Samme fil giver samme tal og samme digest bortset fra tidsstemplet i første linje, så agentens svar kan sammenlignes over uger.

## Kom i gang

Terminal-CLI: ingen GUI, ingen server, ingen build-step. Kræver Node ≥ 22.18.

```bash
git clone https://github.com/benneknudsen/strava-digest && cd strava-digest
npm install
npm link        # giver den globale strava-digest-kommando
```

Kør uden argumenter i et rigtigt terminalvindue, og du får en interaktiv vælger. Den scanner arbejdsmappen, `~/Downloads` og `~/Desktop` (mest nyligt ændrede først, maks 15):

```text
$ strava-digest
1)  aktivitetsmappe · 8 filer · ~/Downloads
2)  zip · 4 filer · ~/Downloads/export_123456.zip
3)  aktivitetsmappe · 4 filer · ~/Downloads/strava-filer
4)  csv-mappe · 4 filer · ~/Downloads/export_123456
Vælg nummer (eller indsæt en sti, q = afslut): q
```

`q` afslutter uden at gøre noget, og du kan indsætte eller trække en sti direkte ind. Uden for en terminal — og med `--help` — printes hjælpen i stedet. Har du stien, kan du springe vælgeren over:

```text
$ strava-digest ~/Downloads/export_123456.zip --last 5
# Træningsdigest — 2026-10-13 19:19

Kilde: ~/Downloads/export_123456.zip (zip, 6 filer) · 4 aktiviteter i eksporten · 3 løb i digesten
…
```

Afinstallation: `npm unlink -g strava-digest`. Pakken forbliver `private`; der publiseres intet til npm.

På Windows: brug fuld sti eller `$HOME` i stedet for `~` i PowerShell, og sæt stien i citationstegn, hvis den indeholder mellemrum.

### Flag

```
--last N        antal løb i digesten (default: alle)
--detail N      antal nyeste løb der får fuld split-opdeling (default 10)
--all           tag alle aktivitetstyper med, ikke kun løb
--list          vis kun indekset af aktiviteter
--out FIL       skriv til fil i stedet for stdout
--json          maskinlæsbar JSON i stedet for digest
--format md     menneskelæsbar Markdown i stedet for agent-format
--days N        sammenligningsvindue i dage (default 28)
--max-hr N      max-puls til zonefordeling (Z1–Z5 = 50–100 % af max)
--context FIL   kontekstfil der flettes ind (default ./context.md hvis den findes)
```

## Agent-formatet (standard)

Uden `--format md` skriver værktøjet et **agent-format**: én maskinlæsbar linje pr. løb med alle felter, plus en ugeoversigt, en sammenligning af de seneste 28 dage mod de 28 dage før, en statistik-sektion og en SCHEMA, der fortæller agenten hvad hvert felt betyder.

```text
# STRAVA DIGEST v2 (agent-format)
runs_in_export=196
max_hr=199 source=flag

## WEEKS (nyeste først)
w=2026-W42 r=1 km=7.0 t=3076 load=48 hr=142

## RUNS (196, nyeste først)
d=2026-10-16T08:18:29.000Z n="Løb om morgenen" km=7.02 t=3076 pace=438.2 hr=142/159 z=3.1,31.0,66.0,0.0,0.0 elev=120 drift=5.7 half=-1.0 cv=2.0 pause=0 load=48 sp=1:421@127,2:435@141,3:448@131
```

Designreglerne:

- **Alt med.** Standarden er *alle* løb i eksporten, ikke et udvalg. En coach-agent kan ikke finde tendenser i fem ture. På en rigtig eksport med 196 løb er hele digesten ~11.800 tokens mod ~28 MB rådata.
- **Selvbeskrivende.** Feltnavnene står i SCHEMA-sektionen én gang, og SIGNALS-sektionen siger hvad tærsklerne betyder. Agenten skal ikke gætte at `drift=5.7` er procent.
- **Maskinlæsbart.** Decimaltegn er altid punktum, manglende værdier er `-`, og hver løb-række har præcis samme nøgler i samme rækkefølge.
- **Afledte tal med.** Splits, HR-drift, zoner, negativ split, pace-jævnhed og træningsbelastning (`load` = sum(min i zone × 1..5)) er de felter kilden ikke har. Uden dem gentager agenten bare brugerens egne tal.
- **Kontekst indlejret.** `context.md` flettes ind, så agenten kan vurdere en tur mod planen i stedet for bare at beskrive den.

`--detail N` styrer hvor mange af de nyeste løb der får fuld split-opdeling; resten får de øvrige felter. `--format md` giver det menneskelæsbare Markdown, hvis du vil læse det selv.

## Eksempler

Alle eksempler er kørt på de syntetiske testfiler; outputtet er kopieret fra kørslerne, men stierne er forkortet i forhold til den rå udskrift (fx til `~`). Værktøjet forkorter aldrig stien (fx til `~`); den interaktive vælger viser altid fulde, absolutte stier.

### Bulk: zip

```text
$ strava-digest ~/Downloads/export_123456.zip --max-hr 190
# STRAVA DIGEST v2 (agent-format)
generated=2026-10-20T17:13:36.482Z
source=~/Downloads/export_123456.zip (zip, 6 filer)
activities_in_export=4
runs_in_export=3
runs_shown=3
detail_runs=3 (nyeste, får split-opdeling)
max_hr=190 source=flag

## SCHEMA
række-felter (én løb pr. linje, nyeste først):
  d=ISO8601 tidspunkt (UTC) | n=navn | km=distance | t=bevægelsestid i sekunder
  pace=sekunder pr. km | hr=gennemsnit/maks puls | z=Z1,Z2,Z3,Z4,Z5 i % af tid med puls
  elev=højdemeter i m | drift=pace-normaliseret HR-drift i % (se SIGNALS)
  half=2. halvdel minus 1. halvdel i s/km (negativ = negativ split)
  cv=pace-jævnhed, variationskoefficient i % | pause=antal pauser
  load=træningsbelastning, sum(min i zone * 1..5)
  sp=per-km splits: <km>:<pace_s/km>@<puls>, * = ufuldstændig km
…
## WEEKS (nyeste først)
w=2026-W42 r=1 km=10.0 t=3360 load=193 hr=156
w=2026-W41 r=2 km=14.0 t=4325 load=249 hr=153

## WINDOW (seneste 28 dage vs. de 28 dage før)
seneste: n=3 km=24.0 t=7685 pace=320.2 hr=154 load=442 z=0.0,0.0,52.0,42.0,6.0
forrige: n=0 km=0.0 t=0 pace=- hr=- load=- z=-

## RUNS (3, nyeste først)
d=2026-10-12T06:32:10.000Z n="Lang tur" km=10.00 t=3360 pace=336.0 hr=156/174 z=0.0,0.0,36.1,63.9,0.0 elev=0 drift=4.4 half=-11.0 cv=1.8 pause=0 load=193 sp=1:329@144,2:327@145,3:325@149,4:323@151,5:320@153,6:318@157,7:316@158,8:314@162,9:312@163,10*:309@167
d=2026-10-09T06:05:00.000Z n="Tempo" km=6.00 t=1580 pace=263.3 hr=168/181 z=0.0,0.0,0.0,71.3,28.7 elev=0 drift=3.9 half=-2.0 cv=0.4 pause=0 load=111 sp=1:262@160,2:261@161,3:260@166,4:260@168,5:259@172,6:258@174
d=2026-10-07T07:15:00.000Z n="Rolig tur" km=8.00 t=2745 pace=343.1 hr=137/145 z=0.0,0.0,100.0,0.0,0.0 elev=0 drift=1.2 half=-1.5 cv=0.2 pause=0 load=137 sp=1:345@135,2:345@135,3:344@135,4:344@137,5:344@136,6:343@138,7:343@138,8*:343@138

## STATS (hele perioden)
runs=3 km_total=24.0 median_km=8.00
longest_run=10.00 km on 2026-10-12 (Lang tur)
fastest_avg_pace=263.3 s/km on 2026-10-09 (Tempo)
max_gap=2.0 dage (2026-10-09 -> 2026-10-12)
…
```

### Bulk: mappe med `activities.csv`

```text
$ strava-digest ~/Downloads/export_123456 --max-hr 190
# STRAVA DIGEST v2 (agent-format)
source=~/Downloads/export_123456 (mappe, 6 filer)
…
```

Resten er identisk med zip-eksemplet ovenfor — kun Kilde-linjen er forskellig.

### Løse filer: enkelt aktivitetsfil

```text
$ strava-digest ~/Downloads/strava-filer/Run-1001.gpx
# STRAVA DIGEST v2 (agent-format)
source=~/Downloads/strava-filer/Run-1001.gpx (fil) · metadata læst fra filen
activities_in_export=1
runs_in_export=1
max_hr=- source=-

## RUNS (1, nyeste først)
d=2026-10-12T06:30:00.330Z n="Run-1001" km=9.99 t=3190 pace=319.4 hr=155/168 z=- elev=0 drift=4.4 half=-11.0 cv=1.8 pause=0 load=- sp=1:329@144,2:327@145,3:325@149,4:323@151,5:320@153,6:318@157,7:316@158,8:314@162,9:312@163,10*:309@167

## NOTES
- Uden activities.csv findes eksportens navn ikke — navnet i digesten kommer fra filnavnet. Relative Effort, udstyr og kalorier er udeladt.
```

### Løse filer: mappe

```text
$ strava-digest ~/Downloads/strava-filer --max-hr 190
# STRAVA DIGEST v2 (agent-format)
source=~/Downloads/strava-filer (mappe, 4 aktivitetsfiler) · metadata læst fra filerne
activities_in_export=4
runs_in_export=3
…

## NOTES
- Uden activities.csv findes eksportens navn ikke — navnet i digesten kommer fra filnavnet. Relative Effort, udstyr og kalorier er udeladt. 1 fil sprunget over: UdenTid.gpx (ingen brugbar tid).
```

(Outputtet er forkortet — kun Noter-sektionen er vist ud over toppen; per-løb-rækkerne er som ovenfor.)

### `--list`

```text
$ strava-digest ~/Downloads/export_123456 --list
2026-10-12  LØB  Run             Run-1001.gpx  zoner: nej
2026-10-09  LØB  Run             Run-1002.tcx  zoner: nej
2026-10-07  LØB  Run             Run-1003.gpx  zoner: nej
2026-10-06       Ride            Ride-1004.fit.gz  zoner: nej

4 aktiviteter i alt (vist: 4)
```

### `--max-hr` (zoner)

```text
$ strava-digest ~/Downloads/strava-filer/Run-1001.gpx --max-hr 190
max_hr=190 source=flag
…
d=2026-10-12T06:30:00.330Z n="Run-1001" km=9.99 t=3190 pace=319.4 hr=155/168 z=0.0,0.0,36.1,63.9,0.0 elev=0 drift=4.4 …
```

Uden flaget er zonefeltet `-` (tomt), og `max_hr=- source=-` i headeren. Kommer grænserne fra urets FIT-fil, står der `source=fit` i stedet for `source=flag`. I Markdown-formatet står der `fra uret` i stedet for `fra --max-hr`.

### `--json`

```text
$ strava-digest ~/Downloads/strava-filer/Run-1001.gpx --last 1 --max-hr 190 --json
{
  "sourceLabel": "~/Downloads/strava-filer/Run-1001.gpx (fil) · metadata læst fra filen",
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

(Outputtet er forkortet: resten er `analysis`, baseline-felterne og hele `markdown`-feltet.)

### `--out`

```text
$ strava-digest ~/Downloads/export_123456.zip --out runs/digest.txt
skrev …/strava-digest/runs/digest.txt (N tegn)
```

Digesten skrives til filen; stderr-linjen viser hvor. Mappen oprettes, hvis den mangler. Tegnantallet afhænger bl.a. af stiens længde — Kilde-linjen indeholder den fulde sti.

## Hvad digesten indeholder

Per løb:

- **Per-km splits** med pace og gennemsnitspuls; sidste del-km markeres med `*`.
- **HR-drift (decoupling):** pace-normaliseret effektivitet i første vs. anden halvdel, warm-up og pauser ekskluderet. I agent-formatet er tærsklerne i SIGNALS-sektionen: >5 % = aerob kapacitet presset, >10 % = decideret presset.
- **Negativ/positiv split:** pace-forskel mellem de to halvdele.
- **Pauser:** stop >20 s uden fremdrift — antal og samlet tid.
- **Pace-jævnhed:** variationskoefficient på km-splits.
- **Zoner:** tid i Z1–Z5 (effektiv tid, pauser ekskluderet) og roligt-andelen, Z1–Z2.
- **Træningsbelastning:** `load` = sum(min i zone × 1..5) — det belastningstal, der kan sammenlignes uge for uge.
- **Kadence:** gennemsnit fra filen, når den findes.
- **Distance-udledning:** mangler filen distance-felter, udledes distancen af GPS-positioner (haversine); mangler hastigheden, udledes den af distance og tid med glatning. Digesten siger det med en note.

Over turene:

- **Ugeoversigt** (`## WEEKS`): løb, km, tid, belastning og gennemsnitspuls pr. ISO-uge — den tætteste måde at se tendenser.
- **Vindue-sammenligning** (`## WINDOW`): de seneste 28 dage (`--days N`) mod de 28 dage før, med ændringen i km og belastning.
- **Statistik** (`## STATS`): total km, median, længste tur, hurtigste gennemsnit, største pause mellem to løb, gennemsnitlig drift og samlet zonefordeling.

Kun bulk-tilstanden har felterne fra `activities.csv`: navnet fra eksporten, Relative Effort og udstyr (vist per løb) samt kalorier (med i JSON). Løse filer tager navnet fra filnavnet og udelader resten frem for at opdigte det.

## Zoner

Zonelinjen pr. løb viser hvor tiden faktisk blev brugt: procent i Z1–Z5, vægtet med effektiv tid efter samme pause-regel som splits. Baseline-blokken summerer sekunderne over løbene i vinduet og viser hvor stor en andel der var roligt arbejde, Z1–Z2.

Grænserne hentes i denne rækkefølge — der gættes aldrig:

1. `--max-hr N` (flaget vinder).
2. Urets egne zoner, hvis FIT-filen har `zones_target`/`hr_zone`-beskeder (`fra uret` i output).
3. Ellers ingen zonefordeling — kun en note på turen om hvorfor.

Når der skal bruges en standardmodel (flaget, eller urets max-puls uden grænser), er den i procent af max-puls:

| Zone | Puls |
|------|------|
| Z1 | 50–60 % af max |
| Z2 | 60–70 % af max |
| Z3 | 70–80 % af max |
| Z4 | 80–90 % af max |
| Z5 | 90–100 % af max |

Har FIT-filen zonegrænser men ingen max-puls, udledes max-pulsen af den øverste grænse med standardmodellen — Z4 slutter ved 90 % af max, så max-pulsen er filens øverste grænse / 0,9 (afrundet). Det er en udledning af filens egne grænser, ikke et gæt.

Digestens zonelinje skriver hvilken max-puls og kilde zonerne kommer fra (`fra uret` eller `fra --max-hr`), så output er deterministisk sammenligneligt.

## Robusthed der er bygget ind med vilje

Eksporten er **lokaliseret**, og det er en kendt fælde: en tredjeparts importer blev brudt af kinesiske kolonnenavne. Derfor:

- **Kolonner mappes via aliaser** (engelsk + dansk) med eksakt match først, så løsere match. Alt umappet listes i digestens "Noter", så et nyt alias er én linje i `src/columns.ts`.
- **Datoer parses eksplicit.** `new Date("12. okt. 2026, 06:32")` er `Invalid Date`, og `new Date("12.10.2026")` giver *10. december* (US-rækkefølge) — en stille fejl. Vi læser dag-måned-år ved punktum/bindestreg, måned-dag ved skråstreg, og håndterer 12-timers AM/PM.
- **`activities.csv` er autoritativ** for koblingen aktivitets-ID → filnavn; manglende filer giver en note på turen i stedet for et crash.
- **Varierende formater**: samme tur kan være `.fit.gz`, `.fit`, `.tcx.gz`, `.tcx` eller `.gpx`. Mangler distancen i filen, udledes den af GPS (haversine), og mangler hastigheden, udledes den af distance/tid med glatning.
- **Mislabellede `.gz`**: en `.fit.gz` der ikke er gzip falder tilbage til rå bytes.

## Fejlfinding og kendte grænser

- **Flag uden sti fejler** i stedet for at vise den interaktive vælger: `strava-digest --last 5` skriver `mangler sti til eksport (zip, mappe eller aktivitetsfil)` og stopper med exit-kode 1.
- **En TCX uden både distance-felter og GPS-positioner** kan vise `0,00 km`; det samme kan et GPX-spor, hvor positionerne ikke flytter sig. Der står en note om, at distancen er udledt af GPS. En FIT-fil uden distance viser `–` i løse-fil-tilstanden; i bulk-tilstanden, hvor `activities.csv` bærer distancen, viser den i stedet `0,00 km`.
- **Filer uden brugbar tid** og filer med under 2 punkter springes over med en note — i digesten som `1 fil sprunget over: UdenTid.gpx (ingen brugbar tid)`, i `--list` med `(sprunget over)` og grunden, fx `(kun 1 punkt)`.

## Den menneskelige halvdel: context.md

Kopiér `context.example.md` til `context.md` og skriv hvad ugen *skulle* være, dagsform og søvn. Uden den kan agenten kun gentage dine egne tal tilbage til dig. `--context FIL` peger på en anden fil; standard er `./context.md`, hvis den findes.

## Test

```
npm test          # genererer syntetiske fixtures og verificerer hele pipelinen
npm run typecheck
```

Testene er syntetiske — ingen persondata, ingen rigtige GPS-spor. De tjekker bl.a. distance, antal splits, HR-drift-interval, negativ split, puls-niveau og at digesten er under 4 KB og mindst 50× mindre end rådata. De dækker også løse aktivitetsfiler (dato, type og puls læst fra filen, note ved filer uden tidsstempel), zonevalget (flag → urets zoner → ingen) og den rene `discoverSources`-funktion bag den interaktive start.

## Compliance

Dette værktøj rører **ikke** Strava-API'en: ingen credentials, ingen kald, ingen server. Det læser en fil, som brugeren selv har hentet via Stravas Bulk Data Export Tool — en rettighed Strava beskriver sådan (API Policy 2026, §6.6):

> "Each Strava user has the right to access and export the user's own Strava
> data, free of charge, through the Bulk Data Export Tool published on the
> Strava service. Nothing in this Agreement is intended to limit or condition
> that user-facing right."

Digesten er lavet til at blive læst af en agent, men eksporten er brugerens egen, og hvad brugeren gør med den, er brugerens valg. Værktøjet selv kalder hverken Strava-API'en eller nogen LLM, og det gemmer eller sender intet — det læser lokale filer og skriver et lokalt dokument.

Andet end §6.6-citatet ovenfor er ikke verificeret her: hvilke øvrige paragraffer i Stravas vilkår der gælder for den enkelte brug, ved vi ikke, og vi gætter ikke. Læs Stravas egne vilkår, hvis du er i tvivl.

Hold eksporten og `runs/` ude af versionskontrol (se `.gitignore`): filerne indeholder GPS-spor og andre persondata.

## Afhængigheder

To runtime-afhængigheder: `fit-file-parser` (FIT) og `yauzl` (streamende zip-læsning). Begge er ren JS, og gunzip kommer fra `node:zlib` — ingen native moduler, ingen build-step. CI kører testene på macOS, Linux og Windows med Node 22 og 24.

## Testdata og attribution

Alle fixtures genereres af `scripts/make-fixtures.mjs` og er syntetiske — ingen persondata, ingen rigtige GPS-spor, ingen rigtig puls. Undtagelsen er `fixtures/sample.fit`, som er et offentligt eksempel på en FIT-fil fra [`dtcooper/python-fitparse`](https://github.com/dtcooper/python-fitparse) (`tests/files/Activity.fit`, MIT), brugt til at teste FIT-parsingen på en ægte binær fil frem for en generator.

## Licens

MIT — se [LICENSE](LICENSE).
