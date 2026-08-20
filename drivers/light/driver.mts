import { BaseScryptedDriver } from '../../lib/BaseScryptedDriver.mjs';
import type { DriverId } from '../../lib/deviceTypeMap.mjs';

/** Pairs Scrypted lights. */
export default class LightDriver extends BaseScryptedDriver {
  protected override get driverId(): DriverId {
    return 'light';
  }
}
