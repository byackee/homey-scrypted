import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseServerConfig, DEFAULT_PORT } from '../lib/serverConfig.mjs';

/** Stands in for Homey's translator, returning the key so the test can name the refusal. */
const key = (name: string): string => name;

test('trims what the form padded and keeps the password verbatim', () => {
  assert.deepEqual(
    normaliseServerConfig({ host: '  192.168.1.50 ', port: 10443, username: ' homey ', password: '  pw  ' }, key),
    { host: '192.168.1.50', port: 10443, username: 'homey', password: '  pw  ' },
  );
});

test('an empty host is refused rather than stored', () => {
  // Stored, it produced a connection to `https://:10443` and a failure that reads like a
  // network fault — after a page that had just reported success.
  assert.throws(
    () => normaliseServerConfig({ host: '   ', username: 'homey', password: 'pw' }, key),
    /errors.host_required/,
  );
});

test('a missing username and a missing password are each named', () => {
  assert.throws(
    () => normaliseServerConfig({ host: 'h', username: '', password: 'pw' }, key),
    /errors.username_required/,
  );
  assert.throws(
    () => normaliseServerConfig({ host: 'h', username: 'homey', password: '' }, key),
    /errors.password_required/,
  );
});

test('a port that is not a port is refused, however it was written', () => {
  for (const port of ['abc', 0, 65536, 1.5, '']) {
    assert.throws(
      () => normaliseServerConfig({ host: 'h', username: 'u', password: 'p', port }, key),
      /errors.port_invalid/,
      `port ${JSON.stringify(port)} should have been refused`,
    );
  }
});

test('a port given as a string is accepted, because a form field is text', () => {
  assert.equal(normaliseServerConfig({ host: 'h', username: 'u', password: 'p', port: '8443' }, key).port, 8443);
});

test('an absent port falls back to the one Scrypted serves on', () => {
  assert.equal(normaliseServerConfig({ host: 'h', username: 'u', password: 'p' }, key).port, DEFAULT_PORT);
  // `null` is what a view sends for a field it did not fill, which is absent rather than
  // wrong. An empty string is not the same thing: `Number('')` is 0, and 0 is not a port.
  assert.equal(normaliseServerConfig({ host: 'h', username: 'u', password: 'p', port: null }, key).port, DEFAULT_PORT);
});
