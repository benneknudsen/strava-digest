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
--last N        antal løb i digesten (default 5)
--all           tag alle aktivitetstyper med, ikke kun løb
--list          vis kun indekset af aktiviteter
--out FIL       skriv til fil i stedet for stdout
--json          maskinlæsbar JSON i stedet for Markdown
--days N        baseline-vindue i dage (default 28)
--max-hr N      max-puls til zonefordeling (Z1–Z5 = 50–100 % af max)
--context FIL   kontekstfil der flettes ind (default ./context.md hvis den findes)
```

## Eksempler

Alle eksempler er kørt på de syntetiske testfiler; outputtet er kopieret fra kørslerne, men stierne er forkortet i forhold til den rå udskrift (fx til `~`). Værktøjet forkorter aldrig stien (fx til `~`); den interaktive vælger viser altid fulde, absolutte stier.

### Bulk: zip

```text
$ strava-digest ~/Downloads/export_123456.zip --last 2 --max-hr 190
# Træningsdigest — 2026-10-13 19:16

Kilde: ~/Downloads/export_123456.zip (zip, 6 filer) · 4 aktiviteter i eksporten · 2 løb i digesten

## Baseline (28 dage før seneste tur)
- 16,0 km fordelt på 2 løb (~0,5/uge) · længste 10,0 km
- gennemsnit: 5:09/km · puls 162
- zoner: Z1 0 % · Z2 0 % · Z3 24,2 % · Z4 66,4 % · Z5 9,4 % · roligt (Z1–Z2) 0 %

## Løb (2, nyeste først)

### 1) 2026-10-12 06:32 · Lang tur
- **Pas:** 9,99 km · 53:10 · **5:19/km** · puls 155/168 · kadence 84
- **Metadata:** RE 92 · Nike Pegasus 41
- **Splits (pace/puls):** 1) 5:29/144 · 2) 5:27/145 · 3) 5:25/149 · 4) 5:23/151 · 5) 5:20/153 · 6) 5:18/157 · 7) 5:16/158 · 8) 5:14/162 · 9) 5:12/163 · 10) 5:09/167*
- **Signaler:** HR-drift 4,4 % (stabil) · 2. halvdel −0:11/km (negativ split) · pace-jævnhed CV 1,8 %
- **Zoner:** Z1 0 % · Z2 0 % · Z3 36,1 % · Z4 63,9 % · Z5 0 % (max-puls 190, fra --max-hr)
- _note: distance udledt af GPS (ingen distance-felt i filen)_

### 2) 2026-10-09 06:05 · Tempo
- **Pas:** 6,00 km · 26:00 · **4:20/km** · puls 167/175
- **Metadata:** RE 78 · Nike Vaporfly
- **Splits (pace/puls):** 1) 4:22/160 · 2) 4:21/161 · 3) 4:20/166 · 4) 4:20/168 · 5) 4:19/172 · 6) 4:18/174
- **Signaler:** HR-drift 3,9 % (stabil) · 2. halvdel −0:02/km (negativ split) · pace-jævnhed CV 0,4 %
- **Zoner:** Z1 0 % · Z2 0 % · Z3 0 % · Z4 71,3 % · Z5 28,7 % (max-puls 190, fra --max-hr)
```

### Bulk: mappe med `activities.csv`

```text
$ strava-digest ~/Downloads/export_123456 --last 2 --max-hr 190
# Træningsdigest — 2026-10-13 19:16

Kilde: ~/Downloads/export_123456 (mappe, 6 filer) · 4 aktiviteter i eksporten · 2 løb i digesten
…
```

Resten er identisk med zip-eksemplet ovenfor — kun Kilde-linjen er forskellig.

### Løse filer: enkelt aktivitetsfil

```text
$ strava-digest ~/Downloads/strava-filer/Run-1001.gpx --last 1
# Træningsdigest — 2026-10-13 19:16

Kilde: ~/Downloads/strava-filer/Run-1001.gpx (fil) · metadata læst fra filen · 1 aktiviteter i eksporten · 1 løb i digesten

## Baseline (28 dage før seneste tur)
- 10,0 km fordelt på 1 løb (~0,3/uge) · længste 10,0 km
- gennemsnit: 5:19/km · puls 155

## Løb (1, nyeste først)

### 1) 2026-10-12 08:30 · Run-1001
- **Pas:** 9,99 km · 53:10 · **5:19/km** · puls 155/168 · kadence 84
- **Splits (pace/puls):** 1) 5:29/144 · 2) 5:27/145 · 3) 5:25/149 · 4) 5:23/151 · 5) 5:20/153 · 6) 5:18/157 · 7) 5:16/158 · 8) 5:14/162 · 9) 5:12/163 · 10) 5:09/167*
- **Signaler:** HR-drift 4,4 % (stabil) · 2. halvdel −0:11/km (negativ split) · pace-jævnhed CV 1,8 %
- _note: ingen zonefordeling (ingen max-puls — sæt --max-hr)_
- _note: distance udledt af GPS (ingen distance-felt i filen)_

## Noter
- Uden activities.csv findes eksportens navn ikke — navnet i digesten kommer fra filnavnet. Relative Effort, udstyr og kalorier er udeladt.
```

### Løse filer: mappe

```text
$ strava-digest ~/Downloads/strava-filer --last 2 --max-hr 190
# Træningsdigest — 2026-10-13 19:16

Kilde: ~/Downloads/strava-filer (mappe, 4 aktivitetsfiler) · metadata læst fra filerne · 4 aktiviteter i eksporten · 2 løb i digesten
…

## Noter
- Uden activities.csv findes eksportens navn ikke — navnet i digesten kommer fra filnavnet. Relative Effort, udstyr og kalorier er udeladt. 1 fil sprunget over: UdenTid.gpx (ingen brugbar tid).
```

(Outputtet er forkortet — kun Noter-sektionen er vist ud over toppen; per-løb-blokkene er som ovenfor.)

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
$ strava-digest ~/Downloads/strava-filer/Run-1001.gpx --last 1 --max-hr 190
- **Zoner:** Z1 0 % · Z2 0 % · Z3 36,1 % · Z4 63,9 % · Z5 0 % (max-puls 190, fra --max-hr)
```

Uden flaget står der `- _note: ingen zonefordeling (ingen max-puls — sæt --max-hr)_`, som i eksemplet med den enkelte aktivitetsfil. Kommer grænserne fra urets FIT-fil, står der `fra uret` i stedet for `fra --max-hr`.

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
$ strava-digest ~/Downloads/export_123456.zip --last 1 --out runs/digest.md
skrev …/strava-digest/runs/digest.md (N tegn)
```

Digesten skrives til filen; stderr-linjen viser hvor. Mappen oprettes, hvis den mangler. Tegnantallet afhænger bl.a. af stiens længde — Kilde-linjen indeholder den fulde sti.

## Hvad digesten indeholder

Per løb:

- **Per-km splits** med pace og gennemsnitspuls; sidste del-km markeres med `*`.
- **HR-drift (decoupling):** pace-normaliseret effektivitet i første vs. anden halvdel, warm-up og pauser ekskluderet. Digesten skriver >5 % som "let forhøjet", >8 % som "for høj — aerob kapacitet presset".
- **Negativ/positiv split:** pace-forskel mellem de to halvdele.
- **Pauser:** stop >20 s uden fremdrift — antal og samlet tid.
- **Pace-jævnhed:** variationskoefficient på km-splits.
- **Zoner:** tid i Z1–Z5 (effektiv tid, pauser ekskluderet) og roligt-andelen, Z1–Z2.
- **Kadence:** gennemsnit fra filen, når den findes.
- **Distance-udledning:** mangler filen distance-felter, udledes distancen af GPS-positioner (haversine); mangler hastigheden, udledes den af distance og tid med glatning. Digesten siger det med en note.

Over turene:

- **Baseline** for de seneste 28 dage (`--days N`): volumen, ture/uge, længste tur, gennemsnitspace, gennemsnitspuls og zonefordeling.

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
