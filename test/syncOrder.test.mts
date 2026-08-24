import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

/**
 * Guards an ordering rule that lives only in Homey's online documentation.
 *
 * "When a device is marked as unavailable, all capabilities and Flow actions will be
 * prevented." — apps.developer.homey.app, Drivers & Devices.
 *
 * That sentence appears nowhere in the installed packages: not in the SDK typings, not in
 * homey-lib, not in the App Store guidelines Athom ships inside it. So nothing in the
 * toolchain can catch a violation, and neither could any audit that read only local
 * sources. This app shipped one: `sync()` seeded every capability value and only then
 * called `setAvailable()`, while the device was still unavailable from `onInit`. Homey
 * discarded the writes, and each tile stayed blank until Scrypted happened to send an
 * event for that capability.
 *
 * `BaseScryptedDevice` extends `Homey.Device`, which does not exist off-device — the
 * `homey` package ships the CLI, not the runtime — so the ordering cannot be exercised.
 * Asserting it against the source is the only check available.
 */

// .testbuild/test/<file>.test.mjs → up two levels to the app root.
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function syncBody(): string {
  const source = readFileSync(join(root, 'lib', 'BaseScryptedDevice.mts'), 'utf8');
  const start = source.indexOf('protected async sync(): Promise<void> {');
  assert.notEqual(start, -1, 'sync() was renamed; this guard needs updating');

  // Ends where the next method at the same indentation begins.
  const rest = source.slice(start);
  const end = rest.indexOf('\n  private ', 1);
  assert.notEqual(end, -1, 'could not find the end of sync()');
  return rest.slice(0, end);
}

describe('a device is made available before its capabilities are written', () => {
  it('calls setAvailable before seeding capability values', () => {
    const body = syncBody();
    const available = body.indexOf('this.setAvailable()');
    const seed = body.indexOf('this.seedValues(');

    assert.notEqual(available, -1, 'sync() no longer calls setAvailable');
    assert.notEqual(seed, -1, 'sync() no longer calls seedValues');
    assert.ok(
      available < seed,
      'setAvailable must come before seedValues, or Homey discards every seeded value',
    );
  });

  it('calls setAvailable before reconciling the capability list', () => {
    const body = syncBody();
    const available = body.indexOf('this.setAvailable()');
    const reconcile = body.indexOf('this.syncCapabilities(');

    assert.notEqual(reconcile, -1, 'sync() no longer calls syncCapabilities');
    assert.ok(
      available < reconcile,
      'setAvailable must come before syncCapabilities: adding a capability is capability activity too',
    );
  });

  it('still decides availability from what Scrypted reports', () => {
    // Moving the call earlier must not have turned it into an unconditional setAvailable:
    // a device Scrypted reports as offline has to stay unavailable.
    const body = syncBody();
    assert.match(body, /ScryptedInterfaceProperty\.online/, 'the online property is no longer read');
    assert.match(body, /errors\.offline/, 'the offline path no longer marks the device unavailable');
  });
});
