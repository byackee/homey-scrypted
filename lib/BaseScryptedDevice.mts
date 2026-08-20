import Homey from 'homey';
import { ScryptedInterface, ScryptedInterfaceProperty } from '@scrypted/types';
import type { EventDetails, EventListenerRegister } from '@scrypted/types';
import { bindingsFor, type CapabilityBinding } from './capabilityMap.mjs';
import { homeyClassFor } from './deviceTypeMap.mjs';
import type { ScryptedHub } from './ScryptedHub.mjs';
import type { AnyScryptedDevice } from './types.mjs';

/** Shape of the Homey app object this device expects, kept local to avoid a circular import. */
interface ScryptedAppLike {
  hub: ScryptedHub;
  trace(message: string): void;
}

export interface ScryptedDeviceData {
  /** The Scrypted device id this Homey device mirrors. */
  id: string;
}

/**
 * A Homey device backed by a Scrypted device.
 *
 * Capabilities are not declared in the driver manifest but derived at runtime from the
 * Scrypted device's interface list, because two cameras from different plugins routinely
 * expose different capabilities. `syncCapabilities` reconciles the Homey device against
 * whatever Scrypted currently reports, and re-runs after every reconnect so a device that
 * gains an interface (a motion mixin being enabled, say) picks it up without re-pairing.
 */
export class BaseScryptedDevice extends Homey.Device {

  protected scryptedId = '';
  protected scryptedDevice: AnyScryptedDevice | null = null;

  private eventRegisters: EventListenerRegister[] = [];
  private bindings: CapabilityBinding[] = [];
  private bindingsByInterface = new Map<string, CapabilityBinding[]>();
  /** Capabilities that already have a Homey listener, which may only be registered once. */
  private readonly wiredCapabilities = new Set<string>();
  private onHubConnected = (): void => { void this.sync(); };
  private onHubDisconnected = (): void => { void this.handleHubDisconnected(); };

  protected get hub(): ScryptedHub {
    return (this.homey.app as unknown as ScryptedAppLike).hub;
  }

  /** Records a line into the app's trace buffer, which /diagnostics exposes. */
  protected trace(message: string): void {
    try {
      (this.homey.app as unknown as ScryptedAppLike).trace(`{${this.getName()}} ${message}`);
    } catch {
      // Tracing must never break the flow it observes.
    }
  }

  override async onInit(): Promise<void> {
    const data = this.getData() as ScryptedDeviceData;
    this.scryptedId = data.id;

    this.hub.on('connected', this.onHubConnected);
    this.hub.on('disconnected', this.onHubDisconnected);

    if (this.hub.isConnected) {
      await this.sync();
    } else {
      await this.setUnavailable(this.homey.__('errors.not_connected')).catch(() => undefined);
      // Ask the hub to come up; the `connected` event drives the actual sync.
      this.hub.getClient().catch(err => this.error('Initial connect failed:', (err as Error).message));
    }
  }

  override async onUninit(): Promise<void> {
    this.teardown();
  }

  override async onDeleted(): Promise<void> {
    this.teardown();
  }

  private teardown(): void {
    this.hub.off('connected', this.onHubConnected);
    this.hub.off('disconnected', this.onHubDisconnected);
    this.removeEventRegister();
    this.scryptedDevice = null;
  }

  private removeEventRegister(): void {
    for (const register of this.eventRegisters) {
      try {
        register.removeListener();
      } catch {
        // The register dies with the socket; failing to unregister it is not actionable.
      }
    }
    this.eventRegisters = [];
  }

  private async handleHubDisconnected(): Promise<void> {
    this.removeEventRegister();
    this.scryptedDevice = null;
    await this.setUnavailable(this.homey.__('errors.not_connected')).catch(() => undefined);
  }

  /**
   * Rebinds this Homey device to the live Scrypted device. Safe to call repeatedly; it is
   * the single entry point used at init, on reconnect, and after a capability change.
   */
  protected async sync(): Promise<void> {
    try {
      const device = await this.hub.getDevice(this.scryptedId);
      if (!device) {
        await this.setUnavailable(this.homey.__('errors.device_missing')).catch(() => undefined);
        return;
      }

      this.scryptedDevice = device;
      const facts = {
        type: String(device.type ?? ''),
        interfaces: (device.interfaces ?? []) as string[],
      };

      this.trace(`sync: type=${facts.type} interfaces=${facts.interfaces.join(',')}`);
      this.bindings = bindingsFor(facts);
      this.bindingsByInterface = new Map();
      for (const binding of this.bindings) {
        const list = this.bindingsByInterface.get(binding.iface) ?? [];
        list.push(binding);
        this.bindingsByInterface.set(binding.iface, list);
      }

      await this.applyHomeyClass(facts.type);
      // Must run before reconciliation, otherwise capabilities a subclass contributes are
      // seen as stale on every restart and get removed and re-added — which would discard
      // their Insights history each time.
      await this.prepareExtraCapabilities(device, facts.interfaces);
      await this.syncCapabilities();
      this.registerWriters();
      await this.seedValues(device);
      this.subscribeToEvents(device, facts.interfaces);
      await this.onScryptedSynced(device, facts.interfaces);

      const online = facts.interfaces.includes(ScryptedInterface.Online)
        ? device[ScryptedInterfaceProperty.online] !== false
        : true;
      if (online) await this.setAvailable().catch(() => undefined);
      else await this.setUnavailable('Offline in Scrypted').catch(() => undefined);
    } catch (err) {
      this.error('Sync failed:', (err as Error).message);
      await this.setUnavailable((err as Error).message).catch(() => undefined);
    }
  }

  private async applyHomeyClass(type: string): Promise<void> {
    const target = homeyClassFor(type, this.getClass());
    if (this.getClass() !== target) {
      await this.setClass(target).catch(err => this.error('setClass failed:', (err as Error).message));
    }
  }

  /**
   * Capabilities this device needs on top of the ones derived from the interface table.
   * Subclasses override it; the camera driver uses it for the object-detection alarms.
   */
  protected extraCapabilities(): string[] {
    return [];
  }

  /**
   * Lets a subclass work out its extra capabilities before reconciliation runs. Called on
   * every sync, so it must be idempotent.
   */
  protected async prepareExtraCapabilities(
    _device: AnyScryptedDevice,
    _interfaces: string[],
  ): Promise<void> {
    // Intentionally empty in the base class.
  }

  /** Hook for subclasses to attach behaviour that is not a plain capability binding. */
  protected async onScryptedSynced(_device: AnyScryptedDevice, _interfaces: string[]): Promise<void> {
    // Intentionally empty in the base class.
  }

  private async syncCapabilities(): Promise<void> {
    const desired = new Set<string>([
      ...this.bindings.map(binding => binding.capability),
      ...this.extraCapabilities(),
    ]);

    for (const capability of this.getCapabilities()) {
      if (!desired.has(capability)) {
        this.wiredCapabilities.delete(capability);
        await this.removeCapability(capability)
          .catch(err => this.error(`removeCapability ${capability}:`, (err as Error).message));
      }
    }

    for (const capability of desired) {
      if (!this.hasCapability(capability)) {
        await this.addCapability(capability)
          .catch(err => this.error(`addCapability ${capability}:`, (err as Error).message));
      }
    }
  }

  /**
   * Wires Homey capability changes through to Scrypted.
   *
   * Homey throws if a capability listener is registered twice, and `sync` runs again after
   * every reconnect, so already-wired capabilities are skipped. The listener reads
   * `this.scryptedDevice` at call time rather than closing over the proxy, which keeps it
   * valid across reconnects without needing to be re-registered.
   */
  private registerWriters(): void {
    for (const binding of this.bindings) {
      if (!binding.toScrypted || !this.hasCapability(binding.capability)) continue;
      if (this.wiredCapabilities.has(binding.capability)) continue;

      this.wiredCapabilities.add(binding.capability);
      this.registerCapabilityListener(binding.capability, async (value: unknown) => {
        const device = this.scryptedDevice;
        if (!device) throw new Error(this.homey.__('errors.not_connected'));

        const current = this.bindings.find(candidate => candidate.capability === binding.capability);
        const write = current?.toScrypted ?? binding.toScrypted!;
        await write(value, device);
      });
    }
  }

  /** Pushes the current Scrypted state into Homey so tiles are correct before any event. */
  private async seedValues(device: AnyScryptedDevice): Promise<void> {
    for (const binding of this.bindings) {
      if (!binding.property || !binding.fromScrypted) continue;
      await this.applyBinding(binding, device[binding.property], device);
    }
  }

  /**
   * Subscribes to every interface the Scrypted device declares.
   *
   * One listener per interface, which is the form Scrypted documents and uses in its own
   * examples. A single catch-all `listen({ watch: true }, …)` delivered no events at all —
   * not even property changes — so the interface must be named explicitly.
   */
  private subscribeToEvents(device: AnyScryptedDevice, interfaces: string[]): void {
    this.removeEventRegister();

    for (const iface of interfaces) {
      try {
        this.eventRegisters.push(
          device.listen(iface, (_source: unknown, details: EventDetails, data: unknown) => {
            void this.handleScryptedEvent(details, data);
          }),
        );
      } catch (err) {
        this.error(`listen ${iface} failed:`, (err as Error).message);
      }
    }

    this.trace(`subscribed to ${this.eventRegisters.length} interface(s)`);
  }

  private async handleScryptedEvent(details: EventDetails, data: unknown): Promise<void> {
    const device = this.scryptedDevice;
    if (!device) return;


    if (details.eventInterface === ScryptedInterface.Online) {
      if (data === false) await this.setUnavailable('Offline in Scrypted').catch(() => undefined);
      else await this.setAvailable().catch(() => undefined);
      return;
    }

    const bindings = details.eventInterface
      ? this.bindingsByInterface.get(details.eventInterface) ?? []
      : [];

    for (const binding of bindings) {
      // Property events carry the new value directly; interface-level events do not, so
      // the current property is read back off the device proxy instead.
      const raw = details.property && details.property === binding.property
        ? data
        : binding.property ? device[binding.property] : undefined;
      await this.applyBinding(binding, raw, device);
    }

    await this.onScryptedEvent(details, data, device);
  }

  /** Hook for subclasses that need raw Scrypted events (object detection, doorbell). */
  protected async onScryptedEvent(
    _details: EventDetails,
    _data: unknown,
    _device: AnyScryptedDevice,
  ): Promise<void> {
    // Intentionally empty in the base class.
  }

  private async applyBinding(
    binding: CapabilityBinding,
    raw: unknown,
    device: AnyScryptedDevice,
  ): Promise<void> {
    if (!binding.fromScrypted || !this.hasCapability(binding.capability)) return;

    const value = binding.fromScrypted(raw, device);
    if (value === undefined) return;
    if (this.getCapabilityValue(binding.capability) === value) return;

    await this.setCapabilityValue(binding.capability, value)
      .catch(err => this.error(`setCapabilityValue ${binding.capability}:`, (err as Error).message));
  }
}
