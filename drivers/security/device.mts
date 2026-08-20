import { BaseScryptedDevice } from '../../lib/BaseScryptedDevice.mjs';

/**
 * A Scrypted security system in Homey.
 *
 * All behaviour comes from the shared capability table; this class exists because Homey
 * requires a device module per driver.
 */
export default class SecurityDevice extends BaseScryptedDevice {}
