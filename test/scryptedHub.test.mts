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

/** A promise plus the handle that settles it, for holding an attempt open mid-test. */
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

/** Lets every pending microtask and the promise chain behind an attempt settle. */
async function flush(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
}

/**
 * A client stand-in carrying only what the hub touches.
 *
 * `killedSafe` mirrors the real peer: the client resolves it when the socket dies, and it
 * stays settled, which is what lets the hub notice a death it was told about too early.
 */
function fakeClient(bornDead = false) {
  let killPeer: () => void = () => undefined;
  const killedSafe = new Promise<void>(resolve => { killPeer = resolve; });
  if (bornDead) killPeer();

  return {
    serverVersion: '0.143.0',
    connectionType: 'local',
    onClose: undefined as (() => void) | undefined,
    disconnected: false,
    disconnect() { this.disconnected = true; },
    systemManager: { getSystemState: () => ({}) },
    rpcPeer: { killedSafe },
    killPeer: () => killPeer(),
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
    // The loop has to be running before destroying it proves anything; asserting only that
    // nothing happens after `destroy` is satisfied by a hub that never retried at all.
    mock.timers.tick(5_000);
    await flush();
    assert.equal(state.attempts, 2, 'the retry loop never started');

    hub.destroy();
    mock.timers.tick(60_000);
    await flush();
    assert.equal(state.attempts, 2, 'kept reconnecting after the app unloaded');
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

test('a client that was already dead when handed over is not held as connected', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const dead = fakeClient(true);
    let attempts = 0;
    const hub = new ScryptedHub({
      connect: async () => { attempts += 1; return dead as never; },
    });

    // The client wires its own close handler before returning it, so a socket that dropped
    // during the handshake fires onClose while the hub has not set it yet. That close used
    // to be lost, leaving the hub reporting a connection it did not have.
    await hub.setConfig(CONFIG);
    await flush();

    assert.equal(hub.isConnected, false, 'held a dead client as the live connection');

    mock.timers.tick(5_000);
    await flush();
    assert.equal(attempts, 2, 'no reconnect was armed for a client that died on arrival');

    hub.destroy();
  } finally {
    mock.timers.reset();
  }
});

test('a live socket is not taken down when an earlier client dies', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const first = fakeClient();
    const second = fakeClient();
    const clients = [first, second];
    const hub = new ScryptedHub({ connect: async () => clients.shift() as never });

    await hub.setConfig(CONFIG);
    await flush();

    // Repair onto another server, then let the abandoned socket die. Its handlers fire long
    // after it was replaced and must not disturb the connection that took its place.
    await hub.setConfig({ ...CONFIG, host: '192.168.50.73' });
    await flush();
    assert.equal(hub.isConnected, true);

    first.killPeer();
    first.onClose?.();
    await flush();

    assert.equal(hub.isConnected, true, 'a dead predecessor closed the current connection');
    hub.destroy();
  } finally {
    mock.timers.reset();
  }
});

test('reconnecting with new credentials does not reuse the attempt already in flight', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const seen: string[] = [];
    const stall = deferred();
    const hub = new ScryptedHub({
      connect: async (options: { username?: string }) => {
        seen.push(String(options.username));
        // The first attempt hangs, the way a TCP connect to an unreachable host does.
        if (seen.length === 1) {
          await stall.promise;
          throw new Error('connect ETIMEDOUT');
        }
        return fakeClient() as never;
      },
    });

    // Not awaited: this attempt hangs, which is precisely the state repair has to cut through.
    const stalled = hub.setConfig(CONFIG).catch(() => undefined);
    await flush();
    assert.deepEqual(seen, ['homey']);

    // Repair, while the first attempt is still hanging. Answering this with that attempt
    // would report the old server's outcome for credentials it never used — and, since that
    // attempt never returns, would never answer at all. Not awaited, so the latter shows up
    // as a failed assertion rather than a hung test.
    const repaired = hub.setConfig({ ...CONFIG, username: 'homey2' }).catch(() => undefined);
    await flush();

    assert.deepEqual(seen, ['homey', 'homey2'], 'the stale attempt answered the new config');
    assert.equal(hub.isConnected, true);
    assert.equal(hub.getConfig()?.username, 'homey2');
    await repaired;

    stall.release();
    await stalled;
    hub.destroy();
  } finally {
    mock.timers.reset();
  }
});

test('an attempt that lands after destroy is discarded rather than adopted', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const late = fakeClient();
    const stall = deferred();
    const hub = new ScryptedHub({
      connect: async () => {
        await stall.promise;
        return late as never;
      },
    });

    const pending = hub.setConfig(CONFIG).catch(() => undefined);
    await flush();

    hub.destroy();
    stall.release();
    await pending;
    await flush();

    assert.equal(hub.isConnected, false, 'a destroyed hub adopted a late connection');
    assert.equal(late.disconnected, true, 'the late socket was left open after unload');
  } finally {
    mock.timers.reset();
  }
});

test('a failed pairing probe arms no reconnect', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let attempts = 0;
    const hub = new ScryptedHub({
      connect: async () => { attempts += 1; throw new Error('bad credentials'); },
    });

    // A probe validates what the user typed. It must not put the hub into a retry loop,
    // which is what keeps rejected credentials from being replayed every few minutes.
    await assert.rejects(hub.probe(CONFIG), /bad credentials/);
    assert.equal(attempts, 1);

    mock.timers.tick(5 * 60_000);
    await flush();
    assert.equal(attempts, 1, 'a rejected probe started retrying on its own');

    hub.destroy();
  } finally {
    mock.timers.reset();
  }
});
