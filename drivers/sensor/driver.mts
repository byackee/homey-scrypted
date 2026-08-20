import { BaseScryptedDriver } from '../../lib/BaseScryptedDriver.mjs';
import type { DriverId } from '../../lib/deviceTypeMap.mjs';

/** Pairs Scrypted sensors. */
export default class SensorDriver extends BaseScryptedDriver {
  protected override get driverId(): DriverId {
    return 'sensor';
  }
}
