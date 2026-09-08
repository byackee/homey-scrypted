import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeConnectFailure } from '../lib/connectErrors.mjs';

test('an aggregate reports what its members said, not "All promises were rejected"', () => {
  const aggregate = new AggregateError(
    [new Error('xhr poll error'), new Error('websocket error')],
    'All promises were rejected',
  );

  const described = describeConnectFailure(aggregate);

  assert.doesNotMatch(described, /All promises were rejected/);
  assert.match(described, /xhr poll error/);
  assert.match(described, /websocket error/);
});

test('the same refusal from five addresses is reported once', () => {
  const refused = () => Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
  const aggregate = new AggregateError(
    [refused(), refused(), refused(), refused(), refused()],
    'All promises were rejected',
  );

  assert.equal(describeConnectFailure(aggregate), 'connect ECONNREFUSED');
});

test('an engine.io status carried in `description` is what says the password is wrong', () => {
  const transport = Object.assign(new Error('xhr poll error'), { description: 401 });

  assert.equal(
    describeConnectFailure(new AggregateError([transport], 'All promises were rejected')),
    'xhr poll error (HTTP 401)',
  );
});

test('aggregates nested inside aggregates are flattened, not printed', () => {
  const inner = new AggregateError([new Error('self signed certificate')], 'All promises were rejected');
  const outer = new AggregateError([inner, new Error('timeout')], 'All promises were rejected');

  const described = describeConnectFailure(outer);

  assert.match(described, /self signed certificate/);
  assert.match(described, /timeout/);
  assert.doesNotMatch(described, /All promises/);
});

test('a code the message does not already carry is appended', () => {
  const err = Object.assign(new Error('getaddrinfo failed'), { code: 'ENOTFOUND' });

  assert.equal(describeConnectFailure(err), 'getaddrinfo failed (ENOTFOUND)');
});

test('an ordinary error is passed through unchanged', () => {
  assert.equal(describeConnectFailure(new Error('Scrypted is not configured.')), 'Scrypted is not configured.');
});

test('an aggregate with nothing in it still says something', () => {
  assert.equal(
    describeConnectFailure(new AggregateError([], 'All promises were rejected')),
    'All promises were rejected',
  );
});

test('a long list is cut rather than allowed to fill the page', () => {
  const many = Array.from({ length: 9 }, (_, index) => new Error(`address ${index} unreachable`));

  const described = describeConnectFailure(new AggregateError(many, 'All promises were rejected'));

  assert.match(described, /and 3 more$/);
});
