# AGENTS.md

Instruktioner til AI-agenter der arbejder med dette repo.

## Hvad dette værktøj er

`strava-digest` læser brugerens **egen Strava bulk-eksport** og skriver en
kompakt, maskinlæsbar digest. Formålet er at give en agent hele
træningshistorikken for ~12.000 tokens i stedet for ~28 MB rå GPS-data.

**Rør aldrig Strava-API'et.** Værktøjet læser kun filer, brugeren selv har
downloadet. Det er en eksport- og fortolkningsting, ikke et API-klient.

## Sådan bruges det

```bash
strava-digest --find              # find eksporten: én sti pr. linje
strava-digest <sti>               # digest til stdout
strava-digest <sti> --out FIL    # digest til fil
strava-digest <sti> --format md  # menneskelæsbar Markdown
```

Standard-outputtet er agent-format. Læs `SCHEMA` og `SIGNALS` sektionerne
før du fortolker felterne — de forklarer, hvad hvert tal betyder.

## Regler for agenter

- **Læs `SCHEMA` og `SIGNALS` før du fortolker.** `drift` er HR-drift i
  procent, `load` er træningsbelastning, `z` er zonefordelingen.
- **Giv aldrig rådata til modellen.** Digesten er hele pointen.
- **Find ikke på opdigtede tal.** Mangler et felt, står der `-`.
- **Max-puls kommer fra brugeren.** Stravas eksport har ingen zonekonfiguration;
  gæt ikke en værdi. Kør med `--max-hr <værdi>` når brugeren har oplyst den.
- **`context.md` er brugerens.** Den flettes ind i digesten og er gitignored,
  fordi indholdtet er personligt. Skriv ikke i den.
- **`media/` er ikke data.** Det er billeder og videoer fra aktiviteterne,
  inde i eksporten. Værktøjet springer dem over med vilje.

## Gate

Før du committer:

```bash
npm test          # scripts/smoke-test.mjs
npx tsc --noEmit  # typecheck
```

Begge skal være grønne. CI kører desuden på Linux, macOS og Windows med
Node 22 og 24 — en ny test skal derfor ikke antage Unix-stier eller
`/`-adskilte stier.

## Struktur

- `src/cli.ts` — argumenter, output, kommandoer
- `src/agent.ts` — agent-formatet (én linje pr. løb)
- `src/digest.ts` — Markdown-formatet
- `src/interactive.ts` — den interaktive vælger og `--find`
- `src/analysis.ts` — splits, drift, zoner, belastning
- `src/loose.ts` — løse aktivitetsfiler
- `src/strava.ts` — CSV-læsning og kolonnemapping
- `scripts/smoke-test.mjs` — hele testen
- `skills/strava-digest/SKILL.md` — færdig agent-skill, klar til at kopiere
