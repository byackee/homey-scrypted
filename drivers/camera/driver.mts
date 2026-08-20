import { BaseScryptedDriver } from '../../lib/BaseScryptedDriver.mjs';
import type { DriverId } from '../../lib/deviceTypeMap.mjs';
import type ScryptedCameraDevice from './device.mjs';

/** Pairs Scrypted cameras and doorbells, and owns their Flow cards. */
export default class CameraDriver extends BaseScryptedDriver {

  protected override get driverId(): DriverId {
    return 'camera';
  }

  override async onInit(): Promise<void> {
    await super.onInit();
    // The trigger fires once per detected object; this listener decides whether the Flow
    // the user built cares about that particular class. 'any' matches every detection.
    this.homey.flow
      .getDeviceTriggerCard('object_detected')
      .registerRunListener(async (args: { detection_class?: string }, state: { detection_class?: string }) => {
        const wanted = args.detection_class ?? 'any';
        return wanted === 'any' || wanted === state.detection_class;
      });

    this.homey.flow
      .getActionCard('take_snapshot')
      .registerRunListener(async (args: { device: ScryptedCameraDevice }) => {
        await args.device.refreshSnapshot();
      });

    this.trace('flow cards registered');
  }
}
