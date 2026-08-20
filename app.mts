import sourceMapSupport from 'source-map-support';
import Homey from 'homey';
import { ScryptedHub } from './lib/ScryptedHub.mjs';
import { typesForDriver, type DriverId } from './lib/deviceTypeMap.mjs';
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

  /**
   * Reports what the app actually sees on the Scrypted server.
   *
   * Pairing shows a filtered list, so an empty list is ambiguous: it could mean the server
   * has no such devices, that the type filter excluded them, or that the system state
   * never synced. This endpoint separates those cases. Reachable with:
   *
   *   homey api raw --method GET --path /api/app/com.dataweavelabs.scrypted/diagnostics
   */
  async getDiagnostics(): Promise<unknown> {
    const client = await this.hub.getClient();
    const state = client.systemManager.getSystemState();
    const ids = Object.keys(state ?? {});

    const typeCounts: Record<string, number> = {};
    for (const id of ids) {
      const type = String(state[id]?.type?.value ?? '(no type)');
      typeCounts[type] = (typeCounts[type] ?? 0) + 1;
    }

    return {
      serverVersion: this.hub.serverVersion,
      systemStateEntries: ids.length,
      typeCounts,
      // The raw property keys of one entry, to confirm the { [prop]: { value } } shape.
      firstEntryPropertyKeys: ids.length ? Object.keys(state[ids[0]!] ?? {}).slice(0, 20) : [],
      sample: ids.slice(0, 5).map(id => ({
        id,
        type: state[id]?.type?.value,
        name: state[id]?.name?.value,
        interfaceCount: (state[id]?.interfaces?.value as string[] | undefined)?.length,
      })),
      // Exercises the exact call pairing makes, per driver, so an empty pairing list can
      // be attributed to either this data path or the pairing plumbing above it.
      pairPreview: await this.previewPairing(),
    };
  }

  private async previewPairing(): Promise<Record<string, unknown>> {
    const drivers: DriverId[] = ['camera', 'light', 'switch', 'sensor', 'lock', 'climate', 'security'];
    const preview: Record<string, unknown> = {};

    for (const driver of drivers) {
      const types = typesForDriver(driver);
      try {
        const found = await this.hub.listDevices(types);
        preview[driver] = { types, count: found.length, names: found.map(device => device.name) };
      } catch (err) {
        preview[driver] = { types, error: (err as Error).message };
      }
    }

    return preview;
  }
}
