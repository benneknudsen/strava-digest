import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNumber } from './number.ts';

test('parseNumber: space thousands separator with decimal comma', () => {
  assert.equal(parseNumber('1 234,5'), 1234.5);
});

test('parseNumber: English thousands comma with decimal dot', () => {
  assert.equal(parseNumber('1,234.5'), 1234.5);
});

test('parseNumber: German thousands dot with decimal comma', () => {
  assert.equal(parseNumber('1.234,5'), 1234.5);
});

test('parseNumber: lone comma is a decimal comma', () => {
  assert.equal(parseNumber('12,5'), 12.5);
});

test('parseNumber: lone dot is a decimal dot', () => {
  assert.equal(parseNumber('10.5'), 10.5);
});

test('parseNumber: grouped 1.234 is thousands, not a decimal', () => {
  assert.equal(parseNumber('1.234'), 1234);
});

test('parseNumber: grouped 1,234 is thousands', () => {
  assert.equal(parseNumber('1,234'), 1234);
});

test('parseNumber: repeated dot grouping is all thousands', () => {
  assert.equal(parseNumber('2.345.678'), 2345678);
});

test('parseNumber: four head digits make the dot a decimal point', () => {
  assert.equal(parseNumber('1234.567'), 1234.567);
});

test('parseNumber: negative number is kept', () => {
  assert.equal(parseNumber('-5'), -5);
});

test('parseNumber: leading zero keeps the dot as a decimal point', () => {
  assert.equal(parseNumber('0.123'), 0.123);
});

test('parseNumber: empty cell is null', () => {
  assert.equal(parseNumber(''), null);
});

test('parseNumber: dash placeholder is null', () => {
  assert.equal(parseNumber('-'), null);
});

test('parseNumber: non-numeric text is null', () => {
  assert.equal(parseNumber('abc'), null);
});
