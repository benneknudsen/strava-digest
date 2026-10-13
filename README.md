# strava-digest

Strava bulk-eksport (zip) → kompakt træningsdigest, som en agent kan læse og
vurdere. Bygget til at give en LLM nok til at **dømme** et pas — splits,
HR-drift, pace-jævnhed og en baseline — i stedet for at fodre den med megabyte
GPS-punkter.

```
npm start -- ~/Downloads/export_123456.zip --last 5 --out runs/last-5.md
```

Zippen læses streamende: intet udpakkes til disk, `media/` (typisk ~90 % af de
~1 GB) røres aldrig, og `.fit.gz` gunzippes i hukommelsen.

## Sådan kører du den

Det er en **terminal-CLI** — der er ingen GUI, ingen server og ingen
drag-and-drop-knap. Til gengæld kræver den ingen installation ud over Node:

```bash
git clone https://github.com/benneknudsen/strava-digest && cd strava-digest
npm install
node src/cli.ts ~/Downloads/export_123456.zip --last 5
```

**Tip — træk og slip virker alligevel:** træk zip-filen ind i terminalvinduet
i stedet for at skrive stien. macOS, Linux og Windows indsætter automatisk den
fulde sti på markørens plads, så du kan slippe filen midt i kommandoen:

```bash
node src/cli.ts [slip filen her] --last 5
```

**Platforme.** Node ≥ 22.18 (typen strippes direkte, intet build-step).
Værktøjet er ren JavaScript/TypeScript uden native moduler — `yauzl` og
`fit-file-parser` er ren JS, og gunzip kommer fra `node:zlib`. Derfor er det
platformsuafhængigt ad konstruktion, og CI kører testene på macOS, Linux og
Windows ved hvert push. To praktiske ting på Windows: brug fuld sti eller
`$HOME` i stedet for `~` i PowerShell, og sæt stien i citationstegn hvis den
indeholder mellemrum.

## Hvorfor

En raw Strava-eksport er teknisk set læsbar for en agent, men praktisk ubrugelig:
en 10 km-tur ved 1 Hz er ~2,3 MB XML ≈ **~590.000 tokens**, og den indeholder
ikke engang svaret på det, man spørger om. Digesten for samme tur er **~800
tegn (~200 tokens)** og indeholder det, der flytter en vurdering — målt i
smoke-testen: **~2.950× mindre** end rådata.

Digesten er også *deterministisk*: samme fil giver samme output, så agentens
svar kan sammenlignes over uger.

## Hvad den beregner ud over eksportens summer

`activities.csv` har kun totaler. Al intra-tur-analyse kommer fra
aktivitetsfilen (`.fit.gz`, `.gpx`, `.tcx`):

- **Per-km splits** med pace og gennemsnitspuls; sidste del-km markeres.
- **Pace-normaliseret HR-drift** (decoupling): effektivitet i første vs. anden
  halvdel, warm-up og pauser ekskluderet. >5 % = forhøjet, >8 % = presset.
- **Negativ/positiv split**: pace-forskel mellem de to halvdele.
- **Pauser**: stop >20 s uden fremdrift, antal og samlet tid.
- **Pace-jævnhed**: variationskoefficient på km-splits.
- **Baseline**: rullende vindue (default 28 dage) før seneste tur — volumen,
  ture/uge, gennemsnitspace og -puls.

## Flag

```
--last N        antal aktiviteter i digesten (default 5)
--all           alle aktivitetstyper, ikke kun løb
--list          vis indekset (dato, type, filnavn) og umappede kolonner
--out FIL       skriv til fil i stedet for stdout
--json          JSON (inkl. markdown-feltet) i stedet for Markdown
--days N        baseline-vindue i dage (default 28)
--context FIL   kontekstfil der flettes ind (default ./context.md)
```

## Den menneskelige halvdel: context.md

Kopiér `context.example.md` til `context.md` og skriv hvad ugen *skulle* være,
dagsform og søvn. Uden den kan agenten kun gentage dine egne tal tilbage til
dig.

## Robusthed der er bygget ind med vilje

Eksporten er **lokaliseret**, og det er en kendt fælde: en tredjeparts importer
blev brudt af kinesiske kolonnenavne. Derfor:

- **Kolonner mappes via aliaser** (engelsk + dansk) med eksakt match først, så
  løsere match. Alt umappet listes i digestens "Noter", så et nyt alias er én
  linje i `src/columns.ts`.
- **Datoer parses eksplicit.** `new Date("12. okt. 2026, 06:32")` er `Invalid
  Date`, og `new Date("12.10.2026")` giver *10. december* (US-rækkefølge) — en
  stille fejl. Vi læser dag-måned-år ved punktum/bindestreg, måned-dag ved
  skråstreg, og håndterer 12-timers AM/PM.
- **`activities.csv` er autoritativ** for koblingen aktivitets-ID → filnavn;
  manglende filer giver en note på turen i stedet for et crash.
- **Varierende formater**: samme tur kan være `.fit.gz`, `.fit`, `.tcx.gz` eller
  `.gpx`. Mangler distancen i filen, udledes den af GPS (haversine), og mangler
  hastigheden, udledes den af distance/tid med glatning.
- **Mislabellede `.gz`**: en `.fit.gz` der ikke er gzip falder tilbage til rå
  bytes.

## Test

```
npm test          # genererer syntetiske fixtures og verificerer hele pipelinen
npm run typecheck
```

Testen bruger udelukkende syntetiske data (ingen persondata) og tjekker bl.a.
distance, antal splits, HR-drift-interval, negativ split, puls-niveau og at
digesten er under 4 KB og mindst 50× mindre end rådata.

## Compliance

Dette værktøj rører **ikke** Strava-API'en: ingen credentials, ingen kald, ingen
server. Det læser en fil, som brugeren selv har hentet via Stravas Bulk Data
Export Tool — en rettighed Strava beskriver sådan (API Policy 2026, §6.6):

> "Each Strava user has the right to access and export the user's own Strava
> data, free of charge, through the Bulk Data Export Tool published on the
> Strava service. Nothing in this Agreement is intended to limit or condition
> that user-facing right."

Reglerne i policyens §5 (bl.a. §5.3 om Strava-data i en AI-kontekst, §5.5 om
bulk-eksport og "Persistent Index", §5.16(b) om agent-medierede grænseflader)
retter sig mod en *Developer Application* der bruger API'en. Det gør dette
værktøj ikke — det behandler kun brugerens egne, selv-eksporterede filer, lokalt.

Hold eksporten og `runs/` ude af versionskontrol (se `.gitignore`): filerne
indeholder GPS-spor og andre persondata.

## Afhængigheder

`fit-file-parser` (FIT) og `yauzl` (streamende zip-læsning). Ingen andre.

## Testdata og attribution

Alle fixtures genereres af `scripts/make-fixtures.mjs` og er syntetiske — ingen
persondata, ingen rigtige GPS-spor, ingen rigtig puls. Undtagelsen er
`fixtures/sample.fit`, som er et offentligt eksempel på en FIT-fil fra
[`dtcooper/python-fitparse`](https://github.com/dtcooper/python-fitparse)
(`tests/files/Activity.fit`, MIT), brugt til at teste FIT-parsingen på en ægte
binær fil frem for en generator.

## Licens

MIT — se [LICENSE](LICENSE).
