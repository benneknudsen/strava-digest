/**
 * Strava localises the export: the same column arrives as "Average Heart Rate"
 * or "Gennemsnitlig puls", and a third-party importer has already been broken by
 * non-English headers. So we never trust header names positionally — we map
 * through aliases and report the populated columns we cannot place: the agent
 * format as a count, Markdown as the names, so a new alias is one edit.
 */
export type Field =
  | 'id'
  | 'date'
  | 'name'
  | 'type'
  | 'elapsedSec'
  | 'movingSec'
  | 'distance'
  | 'avgHr'
  | 'maxHr'
  | 'avgCadence'
  | 'maxCadence'
  | 'avgWatts'
  | 'relativeEffort'
  | 'elevationGain'
  | 'calories'
  | 'gear'
  | 'filename'
  | 'avgSpeed'
  | 'temperature';

/**
 * Aliases per field, per language. Strava localises the export, so the same
 * column arrives under a different name depending on the account language.
 * English and Danish are the ones we have real exports for; the rest are the
 * obvious translations and are cheap to add — one line each.
 *
 * `id`, `avgSpeed`, `temperature`, `avgCadence`, `maxCadence` and `avgWatts`
 * are mapped but never read by the digest: they stay so a populated-but-unused
 * export column does not show up in the "unmapped" count. Removing them would
 * change the digest's notes.
 */
export const ALIASES: Record<Field, string[]> = {
  id: ['activity id', 'aktivitet id', 'aktivitets id', 'id', 'aktivitats id'],
  date: [
    'activity date',
    'aktivitet dato',
    'aktivitetdato',
    'dato',
    'startdato',
    'start date',
    'aktivitatsdatum',
    'datum',
    'fecha de actividad',
    'date de activite',
  ],
  name: [
    'activity name',
    'aktivitet navn',
    'aktivitetnavn',
    'navn',
    'title',
    'aktivitatsnamn',
    'name',
    'nom de lactivite',
    'nombre',
  ],
  type: [
    'activity type',
    'aktivitetstype',
    'aktivitet type',
    'sport',
    'sports type',
    'aktivitatstyp',
    'aktivitatstype',
    'type dactivite',
    'tipo de actividad',
  ],
  elapsedSec: [
    'elapsed time',
    'samlet tid',
    'forlobet tid',
    'forloebet tid',
    'varighed',
    'verbrannte zeit',
    'gesamtzeit',
    'tidsforbruk',
    'tid anvand',
    'duree totale',
    'tiempo total',
  ],
  movingSec: [
    'moving time',
    'bevaegelsestid',
    'bevagelsestid',
    'tid i bevaegelse',
    'bewegungszeit',
    'rortid',
    'beweegtijd',
    'duree en mouvement',
    'tiempo en movimiento',
  ],
  distance: [
    'distance',
    'afstand',
    'distance km',
    'distancen',
    'distanz',
    'distanse',
    'afstand km',
    'distancia',
    'distanza',
    'distans',
  ],
  avgHr: [
    'average heart rate',
    'gennemsnitlig puls',
    'gennemsnitspuls',
    'gns puls',
    'average hr',
    'avg hr',
    'durchschnittliche herzfrequenz',
    'mittlere herzfrequenz',
    'genomsnittlig hjartefrekvens',
    'gemiddelde hartfrequentie',
    'frecuencia cardiaca media',
    'frequence cardiaque moyenne',
  ],
  maxHr: [
    'max heart rate',
    'maks puls',
    'makspuls',
    'max puls',
    'max hr',
    'maximale herzfrequenz',
    'hoechste herzfrequenz',
    'maksimal hjartefrekvens',
    'maximale hartfrequentie',
    'frecuencia cardiaca maxima',
    'frequence cardiaque maximale',
  ],
  avgCadence: [
    'average cadence',
    'gennemsnitlig kadence',
    'gns kadence',
    'durchschnittliche kadenz',
    'snittkadens',
    'gemiddelde cadans',
    'cadencia media',
  ],
  maxCadence: [
    'max cadence',
    'maks kadence',
    'maximale kadenz',
    'maksimalkadens',
    'maximale cadans',
    'cadencia maxima',
  ],
  avgWatts: [
    'average watts',
    'gennemsnitlig watt',
    'gns watt',
    'durchschnittliche watt',
    'genomsnittlig watt',
    'gemiddelde watt',
    'potencia media',
  ],
  relativeEffort: [
    'relative effort',
    'relativ indsats',
    'relativ effort',
    'relative anstrengung',
    'relativt anstrengelse',
    'relatieve inspanning',
    'esfuerzo relativo',
  ],
  elevationGain: [
    'elevation gain',
    'hojdeforogelse',
    'stigning',
    'hoejdeforoegelse',
    'samlet stigning',
    'hoehenzuwachs',
    'hoehenanstieg',
    'hohenanstieg',
    'hohen zuwachs',
    'hoying',
    'total hoying',
    'toename in hoogte',
    'desnivelado acumulado',
  ],
  calories: ['calories', 'kalorier', 'kalorien', 'kcal'],
  gear: [
    'activity gear',
    'aktivitetsudstyr',
    'aktivitet udstyr',
    'udstyr',
    'gear',
    'ausrustung',
    'utrustning',
    'uitrusting',
    'equipo',
  ],
  filename: ['filename', 'filnavn', 'fil', 'dateiname', 'bestandsnaam', 'nombre de archivo'],
  avgSpeed: [
    'average speed',
    'gennemsnitshastighed',
    'gennemsnitlig hastighed',
    'durchschnittsgeschwindigkeit',
    'snittfart',
    'gemiddelde snelheid',
    'velocidad media',
  ],
  temperature: [
    'weather temperature',
    'temperatur',
    'vejr temperatur',
    'wettertemperatur',
    'temperatur ved',
    'weertemperatuur',
    'temperatura',
  ],
};

export interface ColumnMap {
  /** field -> column indexes (duplicates kept, first non-empty wins) */
  index: Map<Field, number[]>;
  /** headers we could not place, and that hold a value in at least one row */
  unmatched: string[];
}
