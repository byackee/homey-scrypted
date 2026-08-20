import { BaseScryptedDriver } from '../../lib/BaseScryptedDriver.mjs';
import type { DriverId } from '../../lib/deviceTypeMap.mjs';

/** Pairs Scrypted switches, outlets, fans, sirens, valves and scenes. */
export default class SwitchDriver extends BaseScryptedDriver {
  protected override get driverId(): DriverId {
    return 'switch';
  }
}
