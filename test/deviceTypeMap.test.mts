import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScryptedDeviceType } from '@scrypted/types';
import { homeyClassFor, routeFor, typesForDriver, type DriverId } from '../lib/deviceTypeMap.mjs';

const DRIVERS: DriverId[] = ['camera'];

test('cameras and doorbells share a driver but not a Homey class', () => {
  assert.deepEqual(routeFor(ScryptedDeviceType.Camera), { driver: 'camera', homeyClass: 'camera' });
  assert.deepEqual(routeFor(ScryptedDeviceType.Doorbell), { driver: 'camera', homeyClass: 'doorbell' });
});

test('the camera driver claims exactly the two camera types', () => {
  assert.deepEqual(typesForDriver('camera').sort(), ['Camera', 'Doorbell']);
});

test('device families this version does not ship are not offered for pairing', () => {
  // v1 is cameras only; these must not appear in a pairing list.
  for (const type of ['Light', 'Switch', 'Sensor', 'Lock', 'Thermostat', 'SecuritySystem']) {
    assert.equal(routeFor(type), undefined, `${type} should not be pairable`);
  }
});

test('unmapped Scrypted types are not offered for pairing', () => {
  assert.equal(routeFor(ScryptedDeviceType.Internal), undefined);
  assert.equal(routeFor(ScryptedDeviceType.DeviceProvider), undefined);
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
      assert.equal(seen.get(type), undefined, `${type} is claimed twice`);
      seen.set(type, driver);
    }
  }
});

test('the Homey class falls back when the type is unknown', () => {
  assert.equal(homeyClassFor(ScryptedDeviceType.Camera), 'camera');
  assert.equal(homeyClassFor('Unknown'), 'other');
  assert.equal(homeyClassFor('Unknown', 'sensor'), 'sensor');
});
