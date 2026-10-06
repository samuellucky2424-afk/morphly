import assert from 'node:assert/strict';
import test from 'node:test';
import { formatDate, formatDateTime } from '../src/lib/admin-dates.ts';

test('malformed dashboard dates cannot crash rendering', () => {
  for (const value of ['invalid', ' ', '2026-99-99', 'Infinity', {}, [], 123, false]) {
    assert.equal(formatDate(value), 'Unknown');
    assert.equal(formatDateTime(value), 'Unknown');
  }
});

test('missing dates retain the existing labels', () => {
  for (const value of [null, undefined, '']) {
    assert.equal(formatDate(value), 'Unknown');
    assert.equal(formatDateTime(value), 'Never');
  }
});

test('valid dates retain the existing locale and formatting', () => {
  const value = '2026-10-06T12:30:00Z';
  assert.equal(formatDate(value), new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
  }).format(new Date(value)));
  assert.equal(formatDateTime(value), new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium', timeStyle: 'short',
  }).format(new Date(value)));
});
