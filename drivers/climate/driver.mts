import { BaseScryptedDriver } from '../../lib/BaseScryptedDriver.mjs';
import type { DriverId } from '../../lib/deviceTypeMap.mjs';

/** Pairs Scrypted thermostats and air purifiers. */
export default class ClimateDriver extends BaseScryptedDriver {
  protected override get driverId(): DriverId {
    return 'climate';
  }
}
