import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScryptedDeviceType } from '@scrypted/types';
import { homeyClassFor, routeFor, typesForDriver, type DriverId } from '../lib/deviceTypeMap.mjs';

const DRIVERS: DriverId[] = ['camera', 'light', 'switch', 'sensor', 'lock', 'climate', 'security'];

test('cameras and doorbells share a driver but not a Homey class', () => {
  assert.deepEqual(routeFor(ScryptedDeviceType.Camera), { driver: 'camera', homeyClass: 'camera' });
  assert.deepEqual(routeFor(ScryptedDeviceType.Doorbell), { driver: 'camera', homeyClass: 'doorbell' });
});

test('unmapped Scrypted types are not offered for pairing', () => {
  assert.equal(routeFor(ScryptedDeviceType.Internal), undefined);
  assert.equal(routeFor(ScryptedDeviceType.DeviceProvider), undefined);
  assert.equal(routeFor(ScryptedDeviceType.API), undefined);
  assert.equal(routeFor('SomethingScryptedAddedLater'), undefined);
});

test('every driver claims at least one Scrypted type', () => {
  for (const driver of DRIVERS) {
    assert.ok(typesForDriver(driver).length > 0, `${driver} claims no types`);
  }
});

test('no Scrypted type is claimed by two drivers', () => {
  const seen = new Map<string, DriverId>();
  for (const driver of DRIVERS) {
    for (const type of typesForDriver(driver)) {
      assert.equal(seen.get(type), undefined, `${type} is claimed by ${seen.get(type)} and ${driver}`);
      seen.set(type, driver);
    }
  }
});

test('the Homey class falls back when the type is unknown', () => {
  assert.equal(homeyClassFor(ScryptedDeviceType.Light), 'light');
  assert.equal(homeyClassFor('Unknown'), 'other');
  assert.equal(homeyClassFor('Unknown', 'sensor'), 'sensor');
});
