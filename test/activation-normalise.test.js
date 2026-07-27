import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalisePhone,
  normaliseEmail,
  normaliseDob,
  normalisePolicyNumber,
  NormalisationError,
} from '../src/activation-normalise.js';

test('normalisePhone: three JP phone forms all produce the same E.164 value', () => {
  assert.equal(normalisePhone('090-1234-5678'), '+819012345678');
  assert.equal(normalisePhone('+81 90 1234 5678'), '+819012345678');
  assert.equal(normalisePhone('09012345678'), '+819012345678');
});

test('normalisePhone: rejects garbage rather than guessing', () => {
  assert.throws(() => normalisePhone('not-a-phone'), NormalisationError);
  assert.throws(() => normalisePhone(''), NormalisationError);
});

test('normaliseEmail: trims and lowercases', () => {
  assert.equal(normaliseEmail('  Sakura.Tanaka@Example.JP  '), 'sakura.tanaka@example.jp');
});

test('normaliseEmail: rejects malformed addresses', () => {
  assert.throws(() => normaliseEmail('not-an-email'), NormalisationError);
});

test('normaliseDob: accepts strict YYYY-MM-DD', () => {
  assert.equal(normaliseDob('1948-03-12'), '1948-03-12');
});

test('normaliseDob: rejects other formats rather than guessing intent', () => {
  assert.throws(() => normaliseDob('03/12/1948'), NormalisationError);
  assert.throws(() => normaliseDob('1948-3-12'), NormalisationError);
  assert.throws(() => normaliseDob('1948-13-01'), NormalisationError); // invalid month
  assert.throws(() => normaliseDob('1948-02-30'), NormalisationError); // invalid day
});

test('normalisePolicyNumber: trims, uppercases, collapses internal whitespace', () => {
  assert.equal(normalisePolicyNumber('  kp-2026-001  '), 'KP-2026-001');
  assert.equal(normalisePolicyNumber('kp  2026 001'), 'KP 2026 001');
});
