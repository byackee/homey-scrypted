import Homey from 'homey';
import { typesForDriver, type DriverId } from './deviceTypeMap.mjs';
import type { ScryptedHub } from './ScryptedHub.mjs';
import type { ScryptedConfig } from './types.mjs';

interface ScryptedAppLike {
  hub: ScryptedHub;
  saveConfig(config: ScryptedConfig): Promise<void>;
}

/** What the pairing view sends back when the user submits the server form. */
interface ConfigureRequest {
  host?: string;
  port?: number | string;
  username?: string;
  password?: string;
}

/**
 * Pairing behaviour shared by every driver in this app.
 *
 * Server credentials belong to the app, not to a driver, so the first pairing view is
 * skipped entirely once a connection exists — pairing a second device does not ask for
 * the password again. Each driver only declares which Scrypted device types it accepts.
 */
export abstract class BaseScryptedDriver extends Homey.Driver {

  /** Identifies which slice of the Scrypted device list this driver pairs. */
  protected abstract get driverId(): DriverId;

  protected get hub(): ScryptedHub {
    return (this.homey.app as unknown as ScryptedAppLike).hub;
  }

  private get appApi(): ScryptedAppLike {
    return this.homey.app as unknown as ScryptedAppLike;
  }

  override async onPair(session: Homey.Driver.PairSession): Promise<void> {
    session.setHandler('showView', async (view: string) => {
      // Jump straight to the device list when the app is already talking to a server.
      if (view === 'configure' && this.hub.isConnected) {
        await session.showView('list_devices');
      }
    });

    session.setHandler('configure', async (data: ConfigureRequest) => {
      const config = this.normaliseConfig(data);
      const result = await this.hub.probe(config);
      await this.appApi.saveConfig(config);
      return result;
    });

    session.setHandler('list_devices', async () => this.listPairableDevices());
  }

  override async onRepair(session: Homey.Driver.PairSession): Promise<void> {
    session.setHandler('configure', async (data: ConfigureRequest) => {
      const config = this.normaliseConfig(data);
      const result = await this.hub.probe(config);
      await this.appApi.saveConfig(config);
      return result;
    });

    session.setHandler('getConfig', async () => {
      const config = this.hub.getConfig();
      // The password is never sent back to the view; the field starts empty on repair.
      return config ? { host: config.host, port: config.port, username: config.username } : null;
    });
  }

  private normaliseConfig(data: ConfigureRequest): ScryptedConfig {
    const host = String(data.host ?? '').trim();
    const username = String(data.username ?? '').trim();
    const password = String(data.password ?? '');
    const port = Number(data.port ?? 10443);

    if (!host) throw new Error('A host or IP address is required.');
    if (!username) throw new Error('A username is required.');
    if (!password) throw new Error('A password or login token is required.');
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('The port must be a number between 1 and 65535.');
    }

    return { host, port, username, password };
  }

  /**
   * Lists the Scrypted devices this driver can adopt, excluding ones Homey already has.
   * Matching is by Scrypted device id, which survives renames on the Scrypted side.
   *
   * The returned objects must contain only the keys Homey accepts for a pairing result:
   * name, data, store, settings, icon, capabilities and capabilitiesOptions. Homey rejects
   * entries carrying anything else, and does so silently — the pairing list simply comes
   * back empty with no error anywhere. In particular the Homey device class does not
   * belong here; `BaseScryptedDevice` applies it with `setClass()` once the device
   * initialises, which also keeps it correct if the Scrypted device changes type later.
   */
  private async listPairableDevices(): Promise<Array<{
    name: string;
    data: { id: string };
    store: { scryptedType: string };
  }>> {
    const alreadyPaired = new Set(
      this.getDevices().map(device => (device.getData() as { id?: string }).id).filter(Boolean),
    );

    const candidates = await this.hub.listDevices(typesForDriver(this.driverId));

    return candidates
      .filter(candidate => !alreadyPaired.has(candidate.id))
      .map(candidate => ({
        name: candidate.room ? `${candidate.name} (${candidate.room})` : candidate.name,
        data: { id: candidate.id },
        store: { scryptedType: candidate.type },
      }));
  }
}
