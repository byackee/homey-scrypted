import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ChargeState,
  LockState,
  ScryptedInterface,
  SecuritySystemMode,
  ThermostatMode,
} from '@scrypted/types';
import {
  bindingsFor,
  CAPABILITY_BINDINGS,
  detectionGroupFor,
  OBJECT_DETECTION_CAPABILITIES,
} from '../lib/capabilityMap.mjs';
import type { AnyScryptedDevice } from '../lib/types.mjs';

/** Looks up a binding by the capability it produces. Fails loudly if it went missing. */
function binding(capability: string) {
  const found = CAPABILITY_BINDINGS.find(candidate => candidate.capability === capability);
  assert.ok(found, `no binding produces ${capability}`);
  return found;
}

function read(capability: string, value: unknown, device: Partial<AnyScryptedDevice> = {}) {
  const target = binding(capability);
  assert.ok(target.fromScrypted, `${capability} has no reader`);
  return target.fromScrypted(value, device as AnyScryptedDevice);
}

test('brightness converts between Scrypted percent and Homey fraction', () => {
  assert.equal(read('dim', 0), 0);
  assert.equal(read('dim', 50), 0.5);
  assert.equal(read('dim', 100), 1);
});

test('brightness writes back as a rounded percentage', async () => {
  const calls: number[] = [];
  const device = { setBrightness: async (n: number) => { calls.push(n); } };
  await binding('dim').toScrypted!(0.42, device as unknown as AnyScryptedDevice);
  assert.deepEqual(calls, [42]);
});

test('hue is scaled from degrees, saturation is passed through', () => {
  assert.equal(read('light_hue', { h: 180, s: 0.5, v: 1 }), 0.5);
  assert.equal(read('light_saturation', { h: 180, s: 0.25, v: 1 }), 0.25);
});

test('writing hue preserves the current saturation and value', async () => {
  const calls: Array<[number, number, number]> = [];
  const device = {
    hsv: { h: 10, s: 0.3, v: 0.8 },
    setHsv: async (h: number, s: number, v: number) => { calls.push([h, s, v]); },
  };
  await binding('light_hue').toScrypted!(0.5, device as unknown as AnyScryptedDevice);
  assert.deepEqual(calls, [[180, 0.3, 0.8]]);
});

test('colour temperature maps Kelvin onto the 0-1 range and clamps outside it', () => {
  assert.equal(read('light_temperature', 2000), 0);
  assert.equal(read('light_temperature', 6500), 1);
  assert.equal(read('light_temperature', 1000), 0);
  assert.equal(read('light_temperature', 9000), 1);
});

test('a jammed lock reports as unlocked rather than locked', () => {
  assert.equal(read('locked', LockState.Locked), true);
  assert.equal(read('locked', LockState.Unlocked), false);
  assert.equal(read('locked', LockState.Jammed), false);
});

test('garage door inverts Scrypted entryOpen', () => {
  assert.equal(read('garagedoor_closed', true), false);
  assert.equal(read('garagedoor_closed', false), true);
});

test('battery alarm is derived from the reported level', () => {
  assert.equal(read('alarm_battery', 100), false);
  assert.equal(read('alarm_battery', 21), false);
  assert.equal(read('alarm_battery', 20), true);
  assert.equal(read('alarm_battery', 5), true);
});

test('charge states collapse onto the three Homey values', () => {
  assert.equal(read('battery_charging_state', ChargeState.Charging), 'charging');
  assert.equal(read('battery_charging_state', ChargeState.Trickle), 'charging');
  assert.equal(read('battery_charging_state', ChargeState.NotCharging), 'discharging');
});

test('security modes map home and night onto partially armed', () => {
  assert.equal(read('homealarm_state', { mode: SecuritySystemMode.AwayArmed }), 'armed');
  assert.equal(read('homealarm_state', { mode: SecuritySystemMode.HomeArmed }), 'partially_armed');
  assert.equal(read('homealarm_state', { mode: SecuritySystemMode.NightArmed }), 'partially_armed');
  assert.equal(read('homealarm_state', { mode: SecuritySystemMode.Disarmed }), 'disarmed');
});

test('thermostat modes without a Homey equivalent fall back to auto', () => {
  assert.equal(read('thermostat_mode', { mode: ThermostatMode.Heat }), 'heat');
  assert.equal(read('thermostat_mode', { mode: ThermostatMode.Off }), 'off');
  assert.equal(read('thermostat_mode', { mode: ThermostatMode.Eco }), 'auto');
  assert.equal(read('thermostat_mode', { mode: ThermostatMode.Dry }), 'auto');
});

test('only modes Scrypted defines exactly are written back', async () => {
  const calls: unknown[] = [];
  const device = { setTemperature: async (cmd: unknown) => { calls.push(cmd); } };
  const target = binding('thermostat_mode');

  await target.toScrypted!('heat', device as unknown as AnyScryptedDevice);
  await target.toScrypted!('nonsense', device as unknown as AnyScryptedDevice);

  assert.deepEqual(calls, [{ mode: ThermostatMode.Heat }]);
});

test('a dual setpoint reports its lower bound', () => {
  assert.equal(read('target_temperature', { setpoint: 19.5 }), 19.5);
  assert.equal(read('target_temperature', { setpoint: [18, 24] }), 18);
});

test('fan speed is a fraction of the device maxSpeed', () => {
  assert.equal(read('fan_speed', { speed: 600, maxSpeed: 1200 }), 0.5);
  // Without a maxSpeed, Scrypted reports 0 or 1 and the value passes through.
  assert.equal(read('fan_speed', { speed: 1 }), 1);
  assert.equal(read('fan_speed', { speed: 0 }), 0);
});

test('missing or malformed values are skipped rather than written as wrong values', () => {
  assert.equal(read('dim', undefined), undefined);
  assert.equal(read('dim', 'bright'), undefined);
  assert.equal(read('measure_temperature', null), undefined);
  assert.equal(read('measure_temperature', Number.NaN), undefined);
  assert.equal(read('alarm_motion', 'yes'), undefined);
  assert.equal(read('light_hue', {}), undefined);
  assert.equal(read('homealarm_state', undefined), undefined);
});

test('bindings are selected by interface membership', () => {
  const light = bindingsFor({
    type: 'Light',
    interfaces: [ScryptedInterface.OnOff, ScryptedInterface.Brightness],
  });
  assert.deepEqual(light.map(b => b.capability).sort(), ['dim', 'onoff']);
});

test('Entry maps to a garage door or a window covering depending on device type', () => {
  const garage = bindingsFor({ type: 'Garage', interfaces: [ScryptedInterface.Entry] });
  assert.deepEqual(garage.map(b => b.capability), ['garagedoor_closed']);

  const blind = bindingsFor({ type: 'WindowCovering', interfaces: [ScryptedInterface.Entry] });
  assert.deepEqual(blind.map(b => b.capability), ['windowcoverings_state']);
});

test('a battery interface yields both the level and the derived alarm', () => {
  const found = bindingsFor({ type: 'Sensor', interfaces: [ScryptedInterface.Battery] });
  assert.deepEqual(found.map(b => b.capability).sort(), ['alarm_battery', 'measure_battery']);
});

test('every binding declares a reader or a writer', () => {
  for (const item of CAPABILITY_BINDINGS) {
    assert.ok(
      item.fromScrypted || item.toScrypted,
      `${item.capability} is neither readable nor writable`,
    );
  }
});

test('detection classes fold vendor-specific labels onto Homey alarms', () => {
  assert.equal(OBJECT_DETECTION_CAPABILITIES.person, 'alarm_person');
  assert.equal(OBJECT_DETECTION_CAPABILITIES.car, 'alarm_vehicle');
  assert.equal(OBJECT_DETECTION_CAPABILITIES.truck, 'alarm_vehicle');
  assert.equal(OBJECT_DETECTION_CAPABILITIES.dog, 'alarm_animal');
  assert.equal(OBJECT_DETECTION_CAPABILITIES.motion, undefined);
});

test('detection classes are grouped the way the Flow dropdown offers them', () => {
  // The reason this matters: a Flow filtered on "vehicle" must fire for a detected truck.
  assert.equal(detectionGroupFor('car'), 'vehicle');
  assert.equal(detectionGroupFor('truck'), 'vehicle');
  assert.equal(detectionGroupFor('bus'), 'vehicle');
  assert.equal(detectionGroupFor('motorcycle'), 'vehicle');
  assert.equal(detectionGroupFor('dog'), 'animal');
  assert.equal(detectionGroupFor('cat'), 'animal');
  assert.equal(detectionGroupFor('bird'), 'animal');
  assert.equal(detectionGroupFor('person'), 'person');
});

test('grouping is case-insensitive and passes ungrouped classes through', () => {
  assert.equal(detectionGroupFor('Car'), 'vehicle');
  assert.equal(detectionGroupFor('PERSON'), 'person');
  // 'motion' is a real Scrypted class and a real dropdown option, with no grouping.
  assert.equal(detectionGroupFor('motion'), 'motion');
  // Scrypted also reports recognised people by name; those must survive unchanged.
  assert.equal(detectionGroupFor('Alice'), 'alice');
});

test('every grouped class resolves to a capability this app declares', () => {
  const declared = new Set([
    'alarm_person', 'alarm_vehicle', 'alarm_animal', 'alarm_package', 'alarm_face',
  ]);
  for (const capability of Object.values(OBJECT_DETECTION_CAPABILITIES)) {
    assert.ok(declared.has(capability), `${capability} is not a declared capability`);
  }
});
