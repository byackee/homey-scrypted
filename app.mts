import sourceMapSupport from 'source-map-support';
import Homey from 'homey';
import { ScryptedHub } from './lib/ScryptedHub.mjs';
import type { ScryptedConfig } from './lib/types.mjs';

sourceMapSupport.install();

const SETTINGS_KEY = 'scrypted.config';

/**
 * The Scrypted app.
 *
 * Owns the single connection to the Scrypted server. Drivers and devices reach it through
 * `this.homey.app`, which keeps credentials and reconnection logic in one place instead of
 * being duplicated across seven drivers.
 */
export default class ScryptedApp extends Homey.App {

  readonly hub = new ScryptedHub({
    log: (...args) => this.log(...args as string[]),
    error: (...args) => this.error(...args as string[]),
  });

  override async onInit(): Promise<void> {
    const config = this.homey.settings.get(SETTINGS_KEY) as ScryptedConfig | null;

    if (!config) {
      this.log('No Scrypted server configured yet. Pair a device to set one up.');
      return;
    }

    // Devices subscribe to the hub during their own onInit and re-sync on `connected`, so
    // a failure here is not fatal: the hub retries with backoff in the background.
    this.hub.setConfig(config)
      .catch(err => this.error('Could not connect to Scrypted at startup:', (err as Error).message));
  }

  override async onUninit(): Promise<void> {
    this.hub.destroy();
  }

  /** Persists new server credentials and reconnects. Called from pairing and repair. */
  async saveConfig(config: ScryptedConfig): Promise<void> {
    this.homey.settings.set(SETTINGS_KEY, config);
    await this.hub.setConfig(config);
  }

  /** Reads the stored configuration without the password, for the settings page. */
  getPublicConfig(): Omit<ScryptedConfig, 'password'> | null {
    const config = this.homey.settings.get(SETTINGS_KEY) as ScryptedConfig | null;
    return config ? { host: config.host, port: config.port, username: config.username } : null;
  }

  getStatus(): { connected: boolean; serverVersion?: string } {
    return { connected: this.hub.isConnected, serverVersion: this.hub.serverVersion };
  }
}
