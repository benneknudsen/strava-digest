---
name: strava-digest
description: "Use when the user asks about their runs or training data."
version: 0.1.0
license: MIT
---

# Strava digest

Svar på træningsspørgsmål ud fra brugerens løbdata, læst via `strava-digest`.

## When to Use

Brug denne skill når brugeren spørger om:

- sine løb, sin træning, sin kondition eller sit løbhistorik
- et konkret løb (pace, puls, zoner, splits, hvordan det gik)
- tendenser over tid (volumen, belastning, form, pauser mellem løb)
- hvilken træning der passer til planen, eller om et pas levede op til planen
- en træningsplan der skal sammenlignes med det faktiske løbhistorik

Brug den **ikke** når spørgsmålet ikke kræver brugerens data — generelle
træningsråd, løbeting i andre lande, opsætning af et ur.

## Værktøjet

`strava-digest` er et lokalt Node CLI der læser brugerens **egen Strava
bulk-eksport** og skriver en kompakt digest. Det rører aldrig Strava-API'et,
pakker aldrig noget ud til disk, og læser aldrig `media/` (billeder/videoer
inde i eksporten).

Find kommandoen:

```bash
strava-digest --help   # hvis den er installeret globalt
node <path-til-repo>/src/cli.ts --help
```

## Trin 1: find eksporten

```bash
strava-digest --find
```

Printer én sti pr. linje, fuld eksport først. Exit-kode 0 = fund, 1 = ingen.
Scanner arbejdsmappen, `~/Downloads` og `~/Desktop`.

Hvis intet findes: bed brugeren hente eksporten fra **Strava → Settings →
My Account → Download or Delete Your Account**, lægge zip'en i `~/Downloads`
og køre `strava-digest --find` igen. Strava kvarantines genbestillinger i omkring
en uge, så bed om én bestilling og vent i stedet for at anmode igen.

## Trin 2: lav digesten

```bash
strava-digest <sti-til-zip>
```

Standard-outputtet er **agent-format**: én maskinlæsbar linje pr. løb med alle
felter, plus `SCHEMA`, `SIGNALS`, `WEEKS`, `WINDOW` og `STATS`. Alle løb i
eksporten er med — en coach-agent kan ikke finde tendenser i et udvalg.

Brug `--out FIL` hvis du vil læse filen bagefter i stedet for i stdout.

**Læs `SCHEMA` og `SIGNALS` før du fortolker.** `drift` er pace-normaliseret
HR-drift i procent (>5 = aerob kapacitet presset), `load` er træningsbelastning
= sum(min i zone × 1..5), `half` er negativ når den 2. halvdel var hurtigere,
`z` er procentfordelingen i de fem zoner.

## Trin 3: konteksten

`context.md` i det mappe værktøjet køres fra indeholder brugerens egen plan
(ugens træning, søvn, krop, formål). Den flettes automatisk ind i hver digest.
Læs den som **kontekst, ikke data** — den forteller hvad turen *skulle* være, så
du kan vurdere den mod intentionen i stedet for bare at beskrive den.

Brugeren kan kopiere `context.example.md` som startpunkt.

## Max-puls og zoner

Stravas bulk-eksport indeholder **ikke** urets egen zonekonfiguration. Uden
`--max-hr` er `max_hr=- source=-` i headeren, og zonefeltet er tomt.

Spørg brugeren efter deres max-puls, og kør med `--max-hr <værdi>` når zoner
skal bruges. Gæt ikke — en forkert max-puls mærker alle zoner forkert, og så
reasoner agenten sikkert på noget forkert.

## Fejl der er værd at kende

- `Ingen løb fundet i eksporten` → typen kan være oversat til brugerens sprog
  ("Løb" i stedet for "Run"), eller det kan være andre aktivitetstyper — `--all`
  hjælper.
- En løb-række med `err=` betyder at filen ikke kunne læses. Resten af digesten
  er stadig gyldig.
- `z=-` betyder manglende zonekonfiguration — ikke at turen var uden puls.

## Hvad du ikke skal gøre

- **Giv ikke rådata til modellen.** Digesten er hele pointen: en eksport med
  196 løb er ~11.800 tokens mod ~28 MB rådata.
- **Find ikke på opdigtede tal.** Mangler et felt, står der `-`. Siger
  agenten "ingen data", skal du sige det, ikke gætte.
- **Redigér ikke i `context.md` for brugeren.** Den er deres egen kontekst.
