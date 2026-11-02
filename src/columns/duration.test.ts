import test from 'node:test';
import assert from 'node:assert/strict';
import type { CsvTable } from '../csv.ts';
import type { ColumnMap, Field } from './aliases.ts';
import { durationSec } from './duration.ts';
import { mapColumns } from './header.ts';

function mapOf(header: string): ColumnMap {
  const table: CsvTable = { headers: [header], rows: [[header]] };
  return mapColumns(table);
}

function duration(value: string, field: Field = 'movingSec'): number | null {
  const header = field === 'elapsedSec' ? 'Elapsed Time' : 'Moving Time';
  return durationSec([value], mapOf(header), field);
}

test('durationSec: h:mm:ss', () => {
  assert.equal(duration('1:02:11'), 3731);
});

test('durationSec: m:ss', () => {
  assert.equal(duration('52:31'), 3151);
});

test('durationSec: raw seconds', () => {
  assert.equal(duration('1875.4'), 1875.4);
});

test('durationSec: textual hours and minutes', () => {
  assert.equal(duration('1 t 30 min'), 5400);
});

test('durationSec: letters with digits are not scraped into a duration', () => {
  assert.equal(duration('abc123'), null);
});

test('durationSec: empty cell is null', () => {
  assert.equal(duration(''), null);
});

test('durationSec: zero duration is 0, not null', () => {
  assert.equal(duration('0:00:00'), 0);
});
