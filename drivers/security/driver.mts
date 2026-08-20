import { BaseScryptedDriver } from '../../lib/BaseScryptedDriver.mjs';
import type { DriverId } from '../../lib/deviceTypeMap.mjs';

/** Pairs Scrypted security systems. */
export default class SecurityDriver extends BaseScryptedDriver {
  protected override get driverId(): DriverId {
    return 'security';
  }
}
