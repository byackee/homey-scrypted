import { ScryptedDeviceType } from '@scrypted/types';

/**
 * The drivers this app ships.
 *
 * v1 ships cameras only. The other device families Scrypted exposes — lights, switches,
 * sensors, locks, thermostats, alarm systems — were built and are preserved in the git
 * history, but could not be exercised against real hardware, and an untested driver is not
 * something to put in front of users. Reinstating one is a routing entry here plus a driver
 * directory; the translation table in `capabilityMap.mts` already covers their interfaces.
 */
export type DriverId = 'camera';

export interface TypeRouting {
  /** Which Homey driver pairs this Scrypted device type. */
  driver: DriverId;
  /**
   * Homey device class, applied per device with `setClass()`. A driver groups several
   * Scrypted types, so the class cannot live in the driver manifest.
   */
  homeyClass: string;
}

/**
 * Maps a Scrypted device type onto a driver and a Homey device class.
 *
 * Types with no entry are not offered for pairing: `routeFor` returns undefined and the
 * device list skips them, so users only see what Homey can actually show.
 */
const ROUTING: Partial<Record<ScryptedDeviceType | string, TypeRouting>> = {
  [ScryptedDeviceType.Camera]: { driver: 'camera', homeyClass: 'camera' },
  [ScryptedDeviceType.Doorbell]: { driver: 'camera', homeyClass: 'doorbell' },
};

export function routeFor(type: string): TypeRouting | undefined {
  return ROUTING[type];
}

/** The Scrypted device types a given driver is willing to pair. */
export function typesForDriver(driver: DriverId): string[] {
  return Object.entries(ROUTING)
    .filter(([, routing]) => routing?.driver === driver)
    .map(([type]) => type);
}

export function homeyClassFor(type: string, fallback = 'other'): string {
  return routeFor(type)?.homeyClass ?? fallback;
}
