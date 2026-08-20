import type { ScryptedDevice, ScryptedDeviceType, ScryptedInterface } from '@scrypted/types';

/** Connection settings for a Scrypted server, as persisted in Homey app settings. */
export interface ScryptedConfig {
  host: string;
  port: number;
  username: string;
  /** Password, or a login token produced by `npx scrypted login`. */
  password: string;
}

/** A Scrypted device reduced to what the pairing views and drivers need. */
export interface ScryptedDeviceSummary {
  id: string;
  name: string;
  type: ScryptedDeviceType | string;
  interfaces: string[];
  room?: string;
}

/** Any Scrypted device proxy. Interface members are resolved dynamically. */
export type AnyScryptedDevice = ScryptedDevice & Record<string, any>;

export type { ScryptedInterface };
