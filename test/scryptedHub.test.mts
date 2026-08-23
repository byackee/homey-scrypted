import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { ScryptedHub } from '../lib/ScryptedHub.mjs';
import type { ScryptedConfig } from '../lib/types.mjs';

const CONFIG: ScryptedConfig = {
  host: '192.168.50.73',
  port: 10443,
  username: 'homey',
  password: 'secret',
};

/** Lets every pending microtask and the promise chain behind an attempt settle. */
async function flush(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
}

/** A client stand-in carrying only what the hub touches. */
function fakeClient() {
  return {
    serverVersion: '0.143.0',
    connectionType: 'local',
    onClose: undefined as (() => void) | undefined,
    disconnect() { /* nothing to close */ },
    systemManager: { getSystemState: () => ({}) },
  };
}

/**
 * Builds a connect stub that fails the first `failures` attempts, then succeeds.
 * Returns the stub plus a live count of how many attempts were made.
 */
function connectStub(failures: number) {
  const state = { attempts: 0, client: fakeClient() };
  const connect = async () => {
    state.attempts += 1;
    if (state.attempts <= failures) throw new Error('connect ECONNREFUSED');
    return state.client as never;
  };
  return { connect, state };
}

test('a connection that never opened still schedules a retry', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { connect, state } = connectStub(1);
    const hub = new ScryptedHub({ connect });

    // Mirrors app start against a server that is not up yet: the first attempt rejects,
    // and before the fix nothing ever tried again.
    await assert.rejects(hub.setConfig(CONFIG), /ECONNREFUSED/);
    assert.equal(state.attempts, 1);
    assert.equal(hub.isConnected, false);

    mock.timers.tick(5_000);
    await flush();

    assert.equal(state.attempts, 2, 'no retry was armed after the first attempt failed');
    assert.equal(hub.isConnected, true);
    hub.destroy();
  } finally {
    mock.timers.reset();
  }
});

test('repeated failures back off instead of retrying every 5s', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { connect, state } = connectStub(Number.MAX_SAFE_INTEGER);
    const hub = new ScryptedHub({ connect });

    await assert.rejects(hub.setConfig(CONFIG), /ECONNREFUSED/);
    assert.equal(state.attempts, 1);

    mock.timers.tick(5_000);
    await flush();
    assert.equal(state.attempts, 2);

    // The second delay is doubled, so the previous interval must not fire another attempt.
    mock.timers.tick(5_000);
    await flush();
    assert.equal(state.attempts, 2, 'retried before the doubled delay elapsed');

    mock.timers.tick(5_000);
    await flush();
    assert.equal(state.attempts, 3);

    hub.destroy();
  } finally {
    mock.timers.reset();
  }
});

test('a retry armed by a failure is dropped once the hub is destroyed', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { connect, state } = connectStub(Number.MAX_SAFE_INTEGER);
    const hub = new ScryptedHub({ connect });

    await assert.rejects(hub.setConfig(CONFIG), /ECONNREFUSED/);
    hub.destroy();

    mock.timers.tick(60_000);
    await flush();
    assert.equal(state.attempts, 1, 'kept reconnecting after the app unloaded');
  } finally {
    mock.timers.reset();
  }
});

test('a successful connect resets the backoff for the next outage', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { connect, state } = connectStub(2);
    const hub = new ScryptedHub({ connect });

    await assert.rejects(hub.setConfig(CONFIG), /ECONNREFUSED/);
    mock.timers.tick(5_000);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(state.attempts, 2);

    mock.timers.tick(10_000);
    await flush();
    assert.equal(hub.isConnected, true);

    // The socket drops; the first retry must come after the minimum delay, not the
    // inflated one the earlier failures had built up.
    state.client.onClose?.();
    assert.equal(hub.isConnected, false);
    mock.timers.tick(5_000);
    await flush();
    assert.equal(state.attempts, 4);

    hub.destroy();
  } finally {
    mock.timers.reset();
  }
});
