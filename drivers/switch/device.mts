import { BaseScryptedDevice } from '../../lib/BaseScryptedDevice.mjs';

/**
 * A Scrypted switch, outlet, fan, siren, valve or scene in Homey.
 *
 * All behaviour comes from the shared capability table; this class exists because Homey
 * requires a device module per driver.
 */
export default class SwitchDevice extends BaseScryptedDevice {}
