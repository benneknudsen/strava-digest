import test from 'node:test';
import assert from 'node:assert/strict';
import { isPlausibleDate, parseDate } from './date.ts';

function iso(value: string): string | null {
  const d = parseDate(value);
  return d ? d.toISOString() : null;
}

test('parseDate: Danish month name with time', () => {
  assert.equal(iso('12. okt. 2026, 06:32'), '2026-10-12T06:32:00.000Z');
});

test('parseDate: English month name with 12-hour clock', () => {
  assert.equal(iso('Oct 12, 2026, 6:32:10 AM'), '2026-10-12T06:32:10.000Z');
});

test('parseDate: ISO YYYY-MM-DD is midnight UTC', () => {
  assert.equal(iso('2026-10-12'), '2026-10-12T00:00:00.000Z');
});

test('parseDate: dot date is day-first', () => {
  assert.equal(iso('12.10.2026 06:32'), '2026-10-12T06:32:00.000Z');
});

test('parseDate: slash date is month-first', () => {
  assert.equal(iso('10/12/2026 06:32'), '2026-10-12T06:32:00.000Z');
});

test('parseDate: day-first order falls back when it is not a real date', () => {
  assert.equal(iso('12.13.2025 06:32'), '2025-12-13T06:32:00.000Z');
});

test('parseDate: 29 February in a leap year', () => {
  assert.equal(iso('2024-02-29'), '2024-02-29T00:00:00.000Z');
});

test('parseDate: 29 February in a non-leap year is null', () => {
  assert.equal(iso('2023-02-29'), null);
});

test('parseDate: slash 29/02/2023 is rejected, not rolled over', () => {
  assert.equal(iso('29/02/2023'), null);
});

test('parseDate: ISO date that does not exist is rejected, not rolled over', () => {
  assert.equal(iso('2026-02-30'), null);
});

test('parseDate: year-first slash date is parsed year-first', () => {
  assert.equal(iso('2026/10/12'), '2026-10-12T00:00:00.000Z');
});

test('parseDate: ISO timestamp with a zone offset is honoured', () => {
  assert.equal(iso('2026-10-12T06:30:00+02:00'), '2026-10-12T04:30:00.000Z');
});

test('parseDate: unparseable text is null', () => {
  assert.equal(iso('not a date'), null);
});

test('isPlausibleDate: null is not plausible', () => {
  assert.equal(isPlausibleDate(null), false);
});

test('isPlausibleDate: invalid Date is not plausible', () => {
  assert.equal(isPlausibleDate(new Date('garbage')), false);
});

test('isPlausibleDate: past date is plausible', () => {
  assert.equal(isPlausibleDate(new Date('2020-01-01T00:00:00Z')), true);
});

test('isPlausibleDate: within the future skew is plausible', () => {
  assert.equal(isPlausibleDate(new Date(Date.now() + 60 * 60 * 1000)), true);
});

test('isPlausibleDate: two days in the future is rejected', () => {
  assert.equal(isPlausibleDate(new Date(Date.now() + 2 * 24 * 60 * 60 * 1000)), false);
});
