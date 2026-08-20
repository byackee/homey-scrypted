import { ScryptedDeviceType } from '@scrypted/types';

/** The drivers this app ships. Each groups a family of Scrypted device types. */
export type DriverId =
  | 'camera'
  | 'light'
  | 'switch'
  | 'sensor'
  | 'lock'
  | 'climate'
  | 'security';

export interface TypeRouting {
  /** Which Homey driver pairs this Scrypted device type. */
  driver: DriverId;
  /**
   * Homey device class, applied per device with `setClass()`. Drivers group several
   * Scrypted types, so the class cannot live in the driver manifest.
   */
  homeyClass: string;
}

/**
 * Maps every Scrypted device type onto a driver and a Homey device class.
 *
 * Types that carry no useful Homey representation (Internal, API, DeviceProvider…) are
 * deliberately absent: `routeFor` returns undefined and pairing skips them, so the device
 * list a user sees contains only things Homey can actually show.
 */
const ROUTING: Partial<Record<ScryptedDeviceType | string, TypeRouting>> = {
  [ScryptedDeviceType.Camera]: { driver: 'camera', homeyClass: 'camera' },
  [ScryptedDeviceType.Doorbell]: { driver: 'camera', homeyClass: 'doorbell' },

  [ScryptedDeviceType.Light]: { driver: 'light', homeyClass: 'light' },

  [ScryptedDeviceType.Switch]: { driver: 'switch', homeyClass: 'socket' },
  [ScryptedDeviceType.Outlet]: { driver: 'switch', homeyClass: 'socket' },
  [ScryptedDeviceType.Fan]: { driver: 'switch', homeyClass: 'fan' },
  [ScryptedDeviceType.Siren]: { driver: 'switch', homeyClass: 'siren' },
  [ScryptedDeviceType.Valve]: { driver: 'switch', homeyClass: 'watervalve' },
  [ScryptedDeviceType.Irrigation]: { driver: 'switch', homeyClass: 'sprinkler' },
  [ScryptedDeviceType.Vacuum]: { driver: 'switch', homeyClass: 'vacuumcleaner' },
  [ScryptedDeviceType.Scene]: { driver: 'switch', homeyClass: 'button' },
  [ScryptedDeviceType.Program]: { driver: 'switch', homeyClass: 'button' },
  [ScryptedDeviceType.Automation]: { driver: 'switch', homeyClass: 'button' },

  [ScryptedDeviceType.Sensor]: { driver: 'sensor', homeyClass: 'sensor' },
  [ScryptedDeviceType.Person]: { driver: 'sensor', homeyClass: 'sensor' },
  [ScryptedDeviceType.Event]: { driver: 'sensor', homeyClass: 'sensor' },

  [ScryptedDeviceType.Lock]: { driver: 'lock', homeyClass: 'lock' },
  [ScryptedDeviceType.Garage]: { driver: 'lock', homeyClass: 'garagedoor' },
  [ScryptedDeviceType.Entry]: { driver: 'lock', homeyClass: 'garagedoor' },
  [ScryptedDeviceType.WindowCovering]: { driver: 'lock', homeyClass: 'windowcoverings' },

  [ScryptedDeviceType.Thermostat]: { driver: 'climate', homeyClass: 'thermostat' },
  [ScryptedDeviceType.AirPurifier]: { driver: 'climate', homeyClass: 'airpurifier' },

  [ScryptedDeviceType.SecuritySystem]: { driver: 'security', homeyClass: 'homealarm' },
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
