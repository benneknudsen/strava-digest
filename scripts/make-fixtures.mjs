// Genererer syntetiske fixtures (ingen rigtige persondata) til at teste pipelinen:
// en GPX (10 km, 1 Hz, HR-drift + negativ split), en TCX, og en activities.csv
// med Strava-lignende kolonnenavne. Zippen laves bagefter med `zip`.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2] ?? 'fixtures/build';
const dir = (p) => {
  mkdirSync(join(root, p), { recursive: true });
  return join(root, p);
};

/* ---- en simuleret 10 km tur: starter 5:30/km, slutter 5:08/km, puls 142 -> 168 ---- */
function simulatedRun({ startPace, endPace, startHr, endHr, km = 10, startOffsetDays = 0 }) {
  const pts = [];
  const start = new Date(Date.UTC(2026, 9, 12 - startOffsetDays, 6, 30, 0));
  let t = 0;
  let dist = 0;
  const lat0 = 55.6761;
  const lon0 = 12.5683;
  while (dist < km * 1000) {
    const f = dist / (km * 1000);
    const pace = startPace + (endPace - startPace) * f; // sek/km
    const step = pace / 1000; // sek pr. meter
    dist += 1;
    t += step;
    const hr = Math.round(startHr + (endHr - startHr) * f + Math.sin(t / 90) * 1.5);
    const lat = lat0 + dist / 111_320;
    pts.push({ t, dist, hr, lat, lon: lon0 });
  }
  return { pts, start };
}

function gpx({ pts, start }) {
  const head = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="fixture"><trk><name>Syntetisk tur</name><trkseg>\n`;
  const body = pts
    .map((p) => {
      const time = new Date(start.getTime() + p.t * 1000).toISOString();
      return `<trkpt lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}"><ele>20.0</ele><time>${time}</time><extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>${p.hr}</gpxtpx:hr><gpxtpx:cad>84</gpxtpx:cad></gpxtpx:TrackPointExtension></extensions></trkpt>`;
    })
    .join('\n');
  return `${head}${body}\n</trkseg></trk></gpx>\n`;
}

function tcx({ pts, start }) {
  const head = `<?xml version="1.0"?>\n<TrainingCenterDatabase><Activities><Activity Sport="Running">`;
  const body = pts
    .map(
      (p) =>
        `<Trackpoint><Time>${new Date(start.getTime() + p.t * 1000).toISOString()}</Time><Position><LatitudeDegrees>${p.lat.toFixed(6)}</LatitudeDegrees><LongitudeDegrees>${p.lon.toFixed(6)}</LongitudeDegrees></Position><AltitudeMeters>20</AltitudeMeters><DistanceMeters>${p.dist}</DistanceMeters><HeartRateBpm><Value>${p.hr}</Value></HeartRateBpm></Trackpoint>`,
    )
    .join('');
  return `${head}${body}</Activity></Activities></TrainingCenterDatabase>`;
}

const englishHeaders = [
  'Activity ID',
  'Activity Date',
  'Activity Name',
  'Activity Type',
  'Elapsed Time',
  'Moving Time',
  'Distance',
  'Max Heart Rate',
  'Average Heart Rate',
  'Relative Effort',
  'Elevation Gain',
  'Calories',
  'Average Cadence',
  'Activity Gear',
  'Filename',
];

function row(a) {
  return [
    a.id,
    `"${a.date}"`,
    `"${a.name}"`,
    a.type,
    a.elapsed,
    a.moving,
    a.distanceKm,
    a.maxHr,
    a.avgHr,
    a.re,
    a.elev,
    a.cal,
    a.cad,
    `"${a.gear}"`,
    a.filename,
  ].join(',');
}

const long = simulatedRun({ startPace: 330, endPace: 308, startHr: 142, endHr: 168, km: 10 });
const tempo = simulatedRun({ startPace: 262, endPace: 258, startHr: 158, endHr: 176, km: 6, startOffsetDays: 3 });
const easy = simulatedRun({ startPace: 345, endPace: 342, startHr: 134, endHr: 139, km: 8, startOffsetDays: 5 });

dir('activities');
writeFileSync(join(root, 'activities/Run-1001.gpx'), gpx(long));
writeFileSync(join(root, 'activities/Run-1002.tcx'), tcx(tempo));
writeFileSync(join(root, 'activities/Run-1003.gpx'), gpx(easy));
dir('media');
writeFileSync(join(root, 'media/photo.jpg'), 'not-a-real-jpeg');

const csv = [
  englishHeaders.join(','),
  row({ id: 1001, date: 'Oct 12, 2026, 6:32:10 AM', name: 'Lang tur', type: 'Run', elapsed: 3380, moving: 3360, distanceKm: 10.0, maxHr: 174, avgHr: 156, re: 92, elev: 41, cal: 690, cad: 84, gear: 'Nike Pegasus 41', filename: 'Run-1001.gpx' }),
  row({ id: 1002, date: 'Oct 9, 2026, 6:05:00 AM', name: 'Tempo', type: 'Run', elapsed: 1600, moving: 1580, distanceKm: 6.0, maxHr: 181, avgHr: 168, re: 78, elev: 12, cal: 420, cad: 88, gear: 'Nike Vaporfly', filename: 'Run-1002.tcx' }),
  row({ id: 1003, date: 'Oct 7, 2026, 7:15:00 AM', name: 'Rolig tur', type: 'Run', elapsed: 2760, moving: 2745, distanceKm: 8.0, maxHr: 145, avgHr: 137, re: 44, elev: 30, cal: 520, cad: 82, gear: 'Nike Pegasus 41', filename: 'Run-1003.gpx' }),
  row({ id: 1004, date: 'Oct 6, 2026, 5:40:00 PM', name: 'Cykeltur', type: 'Ride', elapsed: 3600, moving: 3500, distanceKm: 24.5, maxHr: 150, avgHr: 128, re: 60, elev: 120, cal: 600, cad: 90, gear: 'Cykel', filename: 'Ride-1004.fit.gz' }),
].join('\n');

writeFileSync(join(root, 'activities.csv'), `${csv}\n`);
console.log(`fixtures skrevet til ${root}`);
