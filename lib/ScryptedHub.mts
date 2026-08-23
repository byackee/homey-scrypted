import { EventEmitter } from 'node:events';
import { connectScryptedClient } from '@scrypted/client';
import type { ScryptedClientStatic } from '@scrypted/client';
import { ScryptedInterfaceProperty } from '@scrypted/types';
import type { AnyScryptedDevice, ScryptedConfig, ScryptedDeviceSummary } from './types.mjs';

/** Plugin id the client authenticates as. `@scrypted/core` grants read/write on the system. */
const PLUGIN_ID = '@scrypted/core';

const RECONNECT_MIN_MS = 5_000;
const RECONNECT_MAX_MS = 5 * 60_000;
const CONNECT_TIMEOUT_MS = 60_000;

/**
 * Marks an attempt the hub abandoned on purpose. It reports, but arms no retry: whatever
 * superseded it has already started one, and a genuine failure must not be conflated with
 * a deliberate handover.
 */
class SupersededError extends Error {}

type Logger = (...args: unknown[]) => void;

export interface ScryptedHubOptions {
  log?: Logger;
  error?: Logger;
  /** The connect call, overridable so the reconnect logic can be tested without a server. */
  connect?: typeof connectScryptedClient;
}

/**
 * Owns the single RPC connection to the Scrypted server.
 *
 * Every Homey device in this app talks to Scrypted through this hub rather than opening
 * its own connection: Scrypted's RPC is multiplexed, and one socket keeps both the Homey
 * app's memory footprint and the server's session count flat regardless of device count.
 *
 * Device proxies handed out by `systemManager` are RPC objects bound to the current
 * socket, so they become unusable after a disconnect. Consumers must therefore re-resolve
 * their device on every `connected` event instead of caching the proxy across reconnects.
 */
export class ScryptedHub extends EventEmitter {

  private client: ScryptedClientStatic | null = null;
  private config: ScryptedConfig | null = null;
  private connecting: Promise<ScryptedClientStatic> | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelay = RECONNECT_MIN_MS;
  private stopped = false;
  /**
   * Bumped whenever the hub abandons what it was doing — a new configuration, or shutdown.
   * An attempt captures it at the start and gives up its result if it no longer matches,
   * so a handshake that outlives the config it was made for cannot install itself.
   */
  private epoch = 0;

  private readonly log: Logger;
  private readonly logError: Logger;
  private readonly connect: typeof connectScryptedClient;

  constructor(options: ScryptedHubOptions = {}) {
    super();
    this.setMaxListeners(0);
    this.log = options.log ?? (() => undefined);
    this.logError = options.error ?? (() => undefined);
    this.connect = options.connect ?? connectScryptedClient;
  }

  get isConnected(): boolean {
    return this.client !== null;
  }

  get serverVersion(): string | undefined {
    return this.client?.serverVersion;
  }

  /** Replaces the stored credentials and forces a fresh connection. */
  async setConfig(config: ScryptedConfig): Promise<void> {
    this.config = config;
    await this.reconnectNow();
  }

  getConfig(): ScryptedConfig | null {
    return this.config;
  }

  /**
   * Returns a live client, connecting if needed. Concurrent callers share one attempt so
   * that a burst of devices initialising at app start does not open N sockets.
   */
  async getClient(): Promise<ScryptedClientStatic> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;

    const config = this.config;
    if (!config) throw new Error('Scrypted is not configured.');

    const epoch = this.epoch;
    const attempt = this.doConnect(config, epoch)
      .catch(err => {
        // A failed attempt has to arm its own retry. `handleClose` only fires for a socket
        // that actually opened, so without this an attempt that never got that far — the
        // server still starting, the Mac asleep, the host briefly unreachable — leaves no
        // path back, and every device stays unavailable until the app is restarted.
        // An attempt the hub abandoned is exempt: its replacement is already under way.
        if (!(err instanceof SupersededError)) this.scheduleReconnect();
        throw err;
      })
      .finally(() => {
        // Only while it is still the current attempt: a superseded one clearing the slot
        // would let a second attempt start alongside the one that replaced it.
        if (this.epoch === epoch) this.connecting = null;
      });

    this.connecting = attempt;
    return attempt;
  }

  /**
   * Connects, but never waits forever.
   *
   * The handshake has no deadline of its own — it waits on the socket opening, and engine.io
   * only starts its heartbeats once that has happened. A half-open TCP, which is what a
   * machine going to sleep mid-connect leaves behind, therefore never resolves and never
   * rejects. The hub would sit on that promise indefinitely, hand it to every later caller,
   * and arm no retry, because nothing ever failed.
   */
  private async connectWithDeadline(
    config: ScryptedConfig,
    baseUrl: string,
    clientName: string,
  ): Promise<ScryptedClientStatic> {
    let abandoned = false;
    let timer: NodeJS.Timeout | undefined;

    const attempt = this.connect({
      baseUrl,
      pluginId: PLUGIN_ID,
      username: config.username,
      password: config.password,
      clientName,
    });

    // A client that arrives after the deadline still holds an authenticated session, so it
    // is closed rather than dropped on the floor.
    void attempt.then(
      late => {
        if (abandoned) {
          try {
            late.disconnect();
          } catch {
            // Already gone is the state we want.
          }
        }
      },
      () => undefined,
    );

    try {
      return await Promise.race([
        attempt,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            abandoned = true;
            reject(new Error(`Connecting to Scrypted timed out after ${CONNECT_TIMEOUT_MS / 1000}s.`));
          }, CONNECT_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async doConnect(config: ScryptedConfig, epoch: number): Promise<ScryptedClientStatic> {
    const baseUrl = `https://${config.host}:${config.port}`;
    this.log(`Connecting to Scrypted at ${baseUrl}`);

    // The client sets rejectUnauthorized: false internally, so Scrypted's self-signed
    // certificate is accepted without weakening TLS for the rest of the app.
    const client = await this.connectWithDeadline(config, baseUrl, 'Homey');

    let peerDead = false;
    // Identity-checked, because both paths below can fire long after this client was
    // replaced, and neither may take down its successor.
    const handleDeath = (): void => {
      peerDead = true;
      if (this.client === client) this.handleClose();
    };
    client.onClose = handleDeath;
    // The client wires its own close handler onto the peer before it hands the client back,
    // so a socket that died during the handshake already called `onClose` while it was still
    // unset — and that close is lost. The peer's killed promise stays settled, so asking it
    // here catches the case the callback missed; otherwise the hub holds a dead client,
    // reports itself connected, and never reconnects.
    client.rpcPeer?.killedSafe?.then(handleDeath);

    // One turn of the loop, so a peer that is already dead has said so before this client is
    // adopted. Without it the hub announces a connection it retracts a tick later, and every
    // device runs a full sync against a proxy that is already gone.
    await new Promise(resolve => setImmediate(resolve));

    const discard = (reason: string, superseded: boolean): never => {
      try {
        client.disconnect();
      } catch {
        // Nothing to close is the outcome we want.
      }
      throw superseded ? new SupersededError(reason) : new Error(reason);
    };

    // The hub moved on while this handshake was in flight — repaired onto another server, or
    // unloaded. Adopting this socket would bind the hub to the configuration it just left.
    if (this.epoch !== epoch) discard('Connection attempt superseded.', true);
    if (peerDead) discard('The Scrypted connection closed during the handshake.', false);

    this.client = client;
    this.reconnectDelay = RECONNECT_MIN_MS;
    this.log(`Connected to Scrypted ${client.serverVersion ?? '(unknown version)'} via ${client.connectionType}`);
    this.emit('connected');
    return client;
  }

  private handleClose(): void {
    if (!this.client) return;
    this.client = null;
    this.log('Scrypted connection closed.');
    this.emit('disconnected');
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer || !this.config) return;

    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
    this.log(`Reconnecting to Scrypted in ${Math.round(delay / 1000)}s.`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      // `getClient` arms the next attempt itself when this one fails, so this only reports.
      this.getClient().catch(err => this.logError('Reconnect failed:', (err as Error).message));
    }, delay);
    this.reconnectTimer.unref?.();
  }

  /** Drops any current connection and connects again immediately with the stored config. */
  async reconnectNow(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectDelay = RECONNECT_MIN_MS;
    // Whatever is in flight was built from the previous configuration. Abandoning it here
    // stops this call being answered by a connection to the server we just moved off.
    this.epoch += 1;
    this.connecting = null;

    const previous = this.client;
    this.client = null;
    try {
      previous?.disconnect();
    } catch {
      // A socket that is already gone is exactly the state we want.
    }

    await this.getClient();
  }

  /** Verifies credentials without disturbing the live connection. Used during pairing. */
  async probe(config: ScryptedConfig): Promise<{ version?: string; deviceCount: number }> {
    const client = await this.connectWithDeadline(
      config,
      `https://${config.host}:${config.port}`,
      'Homey (pairing)',
    );
    try {
      return {
        version: client.serverVersion,
        deviceCount: Object.keys(client.systemManager.getSystemState()).length,
      };
    } finally {
      client.disconnect();
    }
  }

  async getDevice(id: string): Promise<AnyScryptedDevice | undefined> {
    const client = await this.getClient();
    return client.systemManager.getDeviceById(id) as AnyScryptedDevice | undefined;
  }

  async getMediaManager() {
    const client = await this.getClient();
    return client.mediaManager;
  }

  /**
   * Lists every device known to Scrypted, optionally restricted to a set of device types.
   * Reads the system state directly rather than instantiating a proxy per device, which
   * keeps pairing cheap on servers with a hundred-odd devices.
   */
  async listDevices(types?: readonly string[]): Promise<ScryptedDeviceSummary[]> {
    const client = await this.getClient();
    const state = client.systemManager.getSystemState();
    const wanted = types ? new Set<string>(types) : null;
    const summaries: ScryptedDeviceSummary[] = [];

    for (const id of Object.keys(state)) {
      const entry = state[id];
      const type = entry?.[ScryptedInterfaceProperty.type]?.value as string | undefined;
      const name = entry?.[ScryptedInterfaceProperty.name]?.value as string | undefined;
      const interfaces = entry?.[ScryptedInterfaceProperty.interfaces]?.value as string[] | undefined;

      if (!type || !name || !interfaces) continue;
      if (wanted && !wanted.has(type)) continue;

      summaries.push({
        id,
        name,
        type,
        interfaces,
        room: entry?.[ScryptedInterfaceProperty.room]?.value as string | undefined,
      });
    }

    return summaries.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Stops reconnecting and closes the socket. Called when the Homey app unloads. */
  destroy(): void {
    this.stopped = true;
    // An attempt still in flight would otherwise finish onto a destroyed hub, leaving an
    // authenticated session open and `isConnected` true after the app unloaded.
    this.epoch += 1;
    this.connecting = null;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      this.client?.disconnect();
    } catch {
      // Already closed.
    }
    this.client = null;
    this.removeAllListeners();
  }
}
