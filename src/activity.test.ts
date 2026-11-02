import test from 'node:test';
import assert from 'node:assert/strict';
import { parseActivityBuffer, pointsFromFitRecords } from './activity.ts';

const CRC_TABLE = [
  0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401, 0xa001, 0x6c00, 0x7800, 0xb401,
  0x5000, 0x9c01, 0x8801, 0x4400,
];

function fitCrc(bytes: number[]): number {
  let crc = 0;
  for (const byte of bytes) {
    let tmp = CRC_TABLE[crc & 0xf]!;
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ CRC_TABLE[byte & 0xf]!;
    tmp = CRC_TABLE[crc & 0xf]!;
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ CRC_TABLE[(byte >> 4) & 0xf]!;
  }
  return crc;
}

function emptyFit(): Buffer {
  const header = [14, 0x10, 0x21, 0x08, 0, 0, 0, 0, 0x2e, 0x46, 0x49, 0x54, 0, 0];
  const crc = fitCrc(header);
  return Buffer.from([...header, crc & 0xff, (crc >> 8) & 0xff]);
}

test('parseActivityBuffer: FIT without records has no points', () => {
  const track = parseActivityBuffer('empty.fit', emptyFit());
  assert.equal(track.source, 'fit');
  assert.equal(track.sport, 'unknown');
  assert.deepEqual(track.points, []);
});

test('parseActivityBuffer: GPX without trkpt has no points', () => {
  const track = parseActivityBuffer('empty.gpx', Buffer.from('<gpx><trk></trk></gpx>'));
  assert.equal(track.source, 'gpx');
  assert.deepEqual(track.points, []);
});

test('parseActivityBuffer: TCX without Trackpoint has no points', () => {
  const track = parseActivityBuffer(
    'empty.tcx',
    Buffer.from('<Activities><Activity Sport="Running"></Activity></Activities>'),
  );
  assert.equal(track.source, 'tcx');
  assert.equal(track.sport, 'Running');
  assert.deepEqual(track.points, []);
});

test('pointsFromFitRecords: a record without distance or GPS stays at distance 0', () => {
  const points = pointsFromFitRecords([
    { timestamp: '2020-01-01T00:00:00Z', heart_rate: 130 },
  ]);
  assert.equal(points.length, 1);
  assert.equal(points[0]!.distM, 0);
  assert.equal(points[0]!.hr, 130);
});

test('pointsFromFitRecords: records without a usable timestamp are skipped', () => {
  const points = pointsFromFitRecords([
    { timestamp: 'not a timestamp' },
    { timestamp: '2020-01-01T00:00:00Z', distance: 5 },
  ]);
  assert.equal(points.length, 1);
  assert.equal(points[0]!.distM, 5);
});

test('pointsFromFitRecords: missing distance is interpolated between readings', () => {
  const points = pointsFromFitRecords([
    { timestamp: '2020-01-01T00:00:00Z', distance: 0 },
    { timestamp: '2020-01-01T00:00:10Z', heart_rate: 120 },
    { timestamp: '2020-01-01T00:00:20Z', distance: 200, heart_rate: 140 },
  ]);
  assert.deepEqual(
    points.map((p) => p.distM),
    [0, 100, 200],
  );
  assert.deepEqual(
    points.map((p) => p.hr),
    [undefined, 120, 140],
  );
});
