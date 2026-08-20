import { BaseScryptedDevice } from '../../lib/BaseScryptedDevice.mjs';

/**
 * A Scrypted lock, garage door or window covering in Homey.
 *
 * All behaviour comes from the shared capability table; this class exists because Homey
 * requires a device module per driver.
 */
export default class LockDevice extends BaseScryptedDevice {}
