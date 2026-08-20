import { BaseScryptedDriver } from '../../lib/BaseScryptedDriver.mjs';
import type { DriverId } from '../../lib/deviceTypeMap.mjs';

/** Pairs Scrypted locks, garage doors and window coverings. */
export default class LockDriver extends BaseScryptedDriver {
  protected override get driverId(): DriverId {
    return 'lock';
  }
}
