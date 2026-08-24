import {
  ChargeState,
  HumidityMode,
  LockState,
  ScryptedInterface,
  ScryptedInterfaceProperty,
  SecuritySystemMode,
  ThermostatMode,
} from '@scrypted/types';
import type {
  ColorHsv,
  FanState,
  FanStatus,
  HumiditySettingStatus,
  SecuritySystemState,
  TemperatureSettingStatus,
} from '@scrypted/types';
import type { AnyScryptedDevice } from './types.mjs';

/**
 * One Homey capability, expressed in terms of the Scrypted interface that backs it.
 *
 * A Scrypted device advertises a free-form set of interfaces, so the app cannot use fixed
 * driver manifests. Instead every binding here is tested against a device's interface list
 * at runtime, and the matching capabilities are added to the Homey device. Adding support
 * for a new Scrypted interface means adding one entry to `CAPABILITY_BINDINGS` — no driver
 * or manifest change.
 */
export interface CapabilityBinding {
  /** Homey capability id. */
  capability: string;
  /** Scrypted interface the device must implement for this capability to apply. */
  iface: ScryptedInterface;
  /**
   * Scrypted state property to watch. Omitted for capabilities that are write-only
   * (`button`) or derived from an interface rather than a single property.
   */
  property?: ScryptedInterfaceProperty;
  /**
   * Maps a Scrypted state value onto a Homey capability value.
   * Returning `undefined` skips the update, which is how unsupported or not-yet-known
   * states stay absent instead of being reported as a wrong value.
   */
  fromScrypted?: (value: unknown, device: AnyScryptedDevice) => unknown;
  /** Applies a Homey capability change to Scrypted. Absent for read-only capabilities. */
  toScrypted?: (value: unknown, device: AnyScryptedDevice) => Promise<void>;
  /**
   * Extra gate beyond the interface check, for interfaces that map to different
   * capabilities depending on the device type (Entry → garage door vs. window covering).
   */
  appliesTo?: (device: ScryptedDeviceFacts) => boolean;
}

/** The pieces of a Scrypted device needed to decide which bindings apply. */
export interface ScryptedDeviceFacts {
  type: string;
  interfaces: readonly string[];
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const asBoolean = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined;

/** Scrypted reports Kelvin; Homey wants 0 (warmest) to 1 (coolest) over a plausible range. */
const KELVIN_MIN = 2000;
const KELVIN_MAX = 6500;

const isWindowCovering = (device: ScryptedDeviceFacts): boolean =>
  device.type === 'WindowCovering' || device.type === 'Blinds';

const isGarage = (device: ScryptedDeviceFacts): boolean => !isWindowCovering(device);

/**
 * Scrypted's `SecuritySystemMode` distinguishes home/away/night; Homey's `homealarm_state`
 * has only armed/partially_armed/disarmed. Home and night both map to partially armed,
 * which is the closest honest representation rather than claiming a full arm.
 */
const SECURITY_TO_HOMEY: Record<SecuritySystemMode, string> = {
  [SecuritySystemMode.Disarmed]: 'disarmed',
  [SecuritySystemMode.AwayArmed]: 'armed',
  [SecuritySystemMode.HomeArmed]: 'partially_armed',
  [SecuritySystemMode.NightArmed]: 'partially_armed',
};

/**
 * Homey's `thermostat_mode` has four values against Scrypted's ten. Modes without a Homey
 * equivalent (Eco, Dry, Purifier, FanOnly) report as `auto` so the tile stays meaningful,
 * and are never written back — the reverse map only emits modes Scrypted defines exactly.
 */
const THERMOSTAT_TO_HOMEY: Partial<Record<ThermostatMode, string>> = {
  [ThermostatMode.Off]: 'off',
  [ThermostatMode.Heat]: 'heat',
  [ThermostatMode.Cool]: 'cool',
  [ThermostatMode.Auto]: 'auto',
  [ThermostatMode.HeatCool]: 'auto',
  [ThermostatMode.On]: 'auto',
  [ThermostatMode.Eco]: 'auto',
  [ThermostatMode.Dry]: 'auto',
  [ThermostatMode.FanOnly]: 'auto',
  [ThermostatMode.Purifier]: 'auto',
};

const HOMEY_TO_THERMOSTAT: Record<string, ThermostatMode> = {
  off: ThermostatMode.Off,
  heat: ThermostatMode.Heat,
  cool: ThermostatMode.Cool,
  auto: ThermostatMode.Auto,
};

const CHARGE_TO_HOMEY: Record<ChargeState, string> = {
  [ChargeState.Charging]: 'charging',
  [ChargeState.Trickle]: 'charging',
  [ChargeState.NotCharging]: 'discharging',
};

/**
 * The complete Scrypted → Homey translation table.
 *
 * Order matters only for readability; matching is by interface membership.
 */
export const CAPABILITY_BINDINGS: readonly CapabilityBinding[] = [
  // ---------------------------------------------------------------- power & light
  {
    capability: 'onoff',
    iface: ScryptedInterface.OnOff,
    property: ScryptedInterfaceProperty.on,
    fromScrypted: asBoolean,
    toScrypted: async (value, device) => {
      if (value) await device.turnOn();
      else await device.turnOff();
    },
  },
  {
    capability: 'dim',
    iface: ScryptedInterface.Brightness,
    property: ScryptedInterfaceProperty.brightness,
    // Scrypted brightness is a percentage; Homey dim is a 0-1 fraction.
    fromScrypted: value => {
      const n = asNumber(value);
      return n === undefined ? undefined : clamp01(n / 100);
    },
    toScrypted: async (value, device) => {
      await device.setBrightness(Math.round(clamp01(Number(value)) * 100));
    },
  },
  {
    capability: 'light_hue',
    iface: ScryptedInterface.ColorSettingHsv,
    property: ScryptedInterfaceProperty.hsv,
    fromScrypted: value => {
      const h = (value as ColorHsv | undefined)?.h;
      return typeof h === 'number' ? clamp01(h / 360) : undefined;
    },
    toScrypted: async (value, device) => {
      const current = (device.hsv ?? {}) as ColorHsv;
      await device.setHsv(clamp01(Number(value)) * 360, current.s ?? 1, current.v ?? 1);
    },
  },
  {
    capability: 'light_saturation',
    iface: ScryptedInterface.ColorSettingHsv,
    property: ScryptedInterfaceProperty.hsv,
    fromScrypted: value => {
      const s = (value as ColorHsv | undefined)?.s;
      return typeof s === 'number' ? clamp01(s) : undefined;
    },
    toScrypted: async (value, device) => {
      const current = (device.hsv ?? {}) as ColorHsv;
      await device.setHsv(current.h ?? 0, clamp01(Number(value)), current.v ?? 1);
    },
  },
  {
    capability: 'light_temperature',
    iface: ScryptedInterface.ColorSettingTemperature,
    property: ScryptedInterfaceProperty.colorTemperature,
    fromScrypted: value => {
      const kelvin = asNumber(value);
      if (kelvin === undefined) return undefined;
      return clamp01((kelvin - KELVIN_MIN) / (KELVIN_MAX - KELVIN_MIN));
    },
    toScrypted: async (value, device) => {
      const fraction = clamp01(Number(value));
      await device.setColorTemperature(Math.round(KELVIN_MIN + fraction * (KELVIN_MAX - KELVIN_MIN)));
    },
  },

  // ---------------------------------------------------------------- sensors
  {
    capability: 'alarm_motion',
    iface: ScryptedInterface.MotionSensor,
    property: ScryptedInterfaceProperty.motionDetected,
    fromScrypted: asBoolean,
  },
  {
    capability: 'alarm_contact',
    iface: ScryptedInterface.EntrySensor,
    property: ScryptedInterfaceProperty.entryOpen,
    fromScrypted: asBoolean,
  },
  {
    capability: 'alarm_water',
    iface: ScryptedInterface.FloodSensor,
    property: ScryptedInterfaceProperty.flooded,
    fromScrypted: asBoolean,
  },
  {
    capability: 'alarm_tamper',
    iface: ScryptedInterface.TamperSensor,
    property: ScryptedInterfaceProperty.tampered,
    fromScrypted: asBoolean,
  },
  {
    capability: 'alarm_noise',
    iface: ScryptedInterface.AudioSensor,
    property: ScryptedInterfaceProperty.audioDetected,
    fromScrypted: asBoolean,
  },
  {
    capability: 'alarm_occupancy',
    iface: ScryptedInterface.OccupancySensor,
    property: ScryptedInterfaceProperty.occupied,
    fromScrypted: asBoolean,
  },
  {
    capability: 'alarm_power',
    iface: ScryptedInterface.PowerSensor,
    property: ScryptedInterfaceProperty.powerDetected,
    fromScrypted: asBoolean,
  },
  {
    capability: 'measure_temperature',
    iface: ScryptedInterface.Thermometer,
    property: ScryptedInterfaceProperty.temperature,
    fromScrypted: asNumber,
  },
  {
    capability: 'measure_humidity',
    iface: ScryptedInterface.HumiditySensor,
    property: ScryptedInterfaceProperty.humidity,
    fromScrypted: asNumber,
  },
  {
    capability: 'measure_luminance',
    iface: ScryptedInterface.LuminanceSensor,
    property: ScryptedInterfaceProperty.luminance,
    fromScrypted: asNumber,
  },
  {
    capability: 'measure_ultraviolet',
    iface: ScryptedInterface.UltravioletSensor,
    property: ScryptedInterfaceProperty.ultraviolet,
    fromScrypted: asNumber,
  },
  {
    capability: 'measure_co2',
    iface: ScryptedInterface.CO2Sensor,
    property: ScryptedInterfaceProperty.co2ppm,
    fromScrypted: asNumber,
  },
  {
    capability: 'measure_pm25',
    iface: ScryptedInterface.PM25Sensor,
    property: ScryptedInterfaceProperty.pm25Density,
    fromScrypted: asNumber,
  },
  {
    capability: 'measure_pm10',
    iface: ScryptedInterface.PM10Sensor,
    property: ScryptedInterfaceProperty.pm10Density,
    fromScrypted: asNumber,
  },
  {
    capability: 'measure_tvoc',
    iface: ScryptedInterface.VOCSensor,
    property: ScryptedInterfaceProperty.vocDensity,
    fromScrypted: asNumber,
  },
  {
    capability: 'measure_nox',
    iface: ScryptedInterface.NOXSensor,
    property: ScryptedInterfaceProperty.noxDensity,
    fromScrypted: asNumber,
  },
  {
    capability: 'measure_aqi',
    iface: ScryptedInterface.AirQualitySensor,
    property: ScryptedInterfaceProperty.airQuality,
    fromScrypted: asNumber,
  },
  // Scrypted reports one battery property, so it maps to one capability. Deriving
  // `alarm_battery` from the same `batteryLevel` put a single reading behind two
  // capabilities, which Homey's battery guidance calls a double UI capability — the level
  // already says everything the derived alarm would, and Homey draws the low state itself.
  {
    capability: 'measure_battery',
    iface: ScryptedInterface.Battery,
    property: ScryptedInterfaceProperty.batteryLevel,
    fromScrypted: asNumber,
  },
  {
    capability: 'battery_charging_state',
    iface: ScryptedInterface.Charger,
    property: ScryptedInterfaceProperty.chargeState,
    fromScrypted: value =>
      typeof value === 'string' ? CHARGE_TO_HOMEY[value as ChargeState] ?? 'idle' : undefined,
  },

  // ---------------------------------------------------------------- access
  {
    capability: 'locked',
    iface: ScryptedInterface.Lock,
    property: ScryptedInterfaceProperty.lockState,
    // A jammed lock is reported as unlocked: it is the safe reading to surface, since
    // treating a jam as "locked" would hide a door that is not actually secured.
    fromScrypted: value => (typeof value === 'string' ? value === LockState.Locked : undefined),
    toScrypted: async (value, device) => {
      if (value) await device.lock();
      else await device.unlock();
    },
  },
  {
    capability: 'garagedoor_closed',
    iface: ScryptedInterface.Entry,
    property: ScryptedInterfaceProperty.entryOpen,
    appliesTo: isGarage,
    fromScrypted: value => {
      const open = asBoolean(value);
      return open === undefined ? undefined : !open;
    },
    toScrypted: async (value, device) => {
      if (value) await device.closeEntry();
      else await device.openEntry();
    },
  },
  {
    capability: 'windowcoverings_state',
    iface: ScryptedInterface.Entry,
    appliesTo: isWindowCovering,
    toScrypted: async (value, device) => {
      if (value === 'up') await device.openEntry();
      else if (value === 'down') await device.closeEntry();
      // 'idle' has no Scrypted equivalent: Entry exposes no stop command.
    },
  },
  {
    capability: 'homealarm_state',
    iface: ScryptedInterface.SecuritySystem,
    property: ScryptedInterfaceProperty.securitySystemState,
    fromScrypted: value => {
      const mode = (value as SecuritySystemState | undefined)?.mode;
      return mode ? SECURITY_TO_HOMEY[mode] : undefined;
    },
    toScrypted: async (value, device) => {
      if (value === 'disarmed') await device.disarmSecuritySystem();
      else if (value === 'partially_armed') await device.armSecuritySystem(SecuritySystemMode.HomeArmed);
      else await device.armSecuritySystem(SecuritySystemMode.AwayArmed);
    },
  },

  // ---------------------------------------------------------------- climate & motion
  {
    capability: 'target_temperature',
    iface: ScryptedInterface.TemperatureSetting,
    property: ScryptedInterfaceProperty.temperatureSetting,
    fromScrypted: value => {
      const setpoint = (value as TemperatureSettingStatus | undefined)?.setpoint;
      if (Array.isArray(setpoint)) return setpoint[0];
      return asNumber(setpoint);
    },
    toScrypted: async (value, device) => {
      await device.setTemperature({ setpoint: Number(value) });
    },
  },
  {
    capability: 'thermostat_mode',
    iface: ScryptedInterface.TemperatureSetting,
    property: ScryptedInterfaceProperty.temperatureSetting,
    fromScrypted: value => {
      const mode = (value as TemperatureSettingStatus | undefined)?.mode;
      return mode ? THERMOSTAT_TO_HOMEY[mode] ?? 'auto' : undefined;
    },
    toScrypted: async (value, device) => {
      const mode = HOMEY_TO_THERMOSTAT[String(value)];
      if (mode) await device.setTemperature({ mode });
    },
  },
  {
    capability: 'target_humidity',
    iface: ScryptedInterface.HumiditySetting,
    property: ScryptedInterfaceProperty.humiditySetting,
    fromScrypted: value => asNumber((value as HumiditySettingStatus | undefined)?.humidifierSetpoint),
    toScrypted: async (value, device) => {
      await device.setHumidity({ mode: HumidityMode.Humidify, humidifierSetpoint: Number(value) });
    },
  },
  {
    capability: 'fan_speed',
    iface: ScryptedInterface.Fan,
    property: ScryptedInterfaceProperty.fan,
    // Scrypted reports RPM when it knows it and 0/1 when it does not, so the fraction is
    // computed against the device's own maxSpeed and falls back to a plain on/off read.
    fromScrypted: value => {
      const status = value as FanStatus | undefined;
      if (!status || typeof status.speed !== 'number') return undefined;
      const max = typeof status.maxSpeed === 'number' && status.maxSpeed > 0 ? status.maxSpeed : 1;
      return clamp01(status.speed / max);
    },
    toScrypted: async (value, device) => {
      const status = device.fan as FanStatus | undefined;
      const max = typeof status?.maxSpeed === 'number' && status.maxSpeed > 0 ? status.maxSpeed : 1;
      const fan: FanState = { speed: clamp01(Number(value)) * max };
      await device.setFan(fan);
    },
  },
  {
    capability: 'docked',
    iface: ScryptedInterface.Dock,
    property: ScryptedInterfaceProperty.docked,
    fromScrypted: asBoolean,
  },

  // ---------------------------------------------------------------- actions
  {
    capability: 'button',
    iface: ScryptedInterface.Scene,
    toScrypted: async (_value, device) => {
      await device.activate();
    },
  },
];

/** Every capability this app can produce, including the ones defined by the app itself. */
/**
 * Detection class to Homey capability.
 *
 * Null-prototyped on purpose: the key is a class name that Scrypted supplies, so it is
 * whatever the detector plugin says it is. On a normal object literal a class named
 * `constructor` or `toString` resolves up the prototype chain and hands back a function.
 */
export const OBJECT_DETECTION_CAPABILITIES: Readonly<Record<string, string>> = Object.assign(
  Object.create(null) as Record<string, string>,
  {
    person: 'alarm_person',
    vehicle: 'alarm_vehicle',
    car: 'alarm_vehicle',
    truck: 'alarm_vehicle',
    motorcycle: 'alarm_vehicle',
    bus: 'alarm_vehicle',
    animal: 'alarm_animal',
    dog: 'alarm_animal',
    cat: 'alarm_animal',
    bird: 'alarm_animal',
    package: 'alarm_package',
    face: 'alarm_face',
  },
);

/**
 * The detection capabilities among the ones a device already carries.
 *
 * Discovery asks the detector what it can report, and deliberately keeps the previous
 * answer when that call fails. On the first sync after an app restart there is no previous
 * answer in memory — but the device itself still carries the capabilities from last time,
 * which is the same information. Seeding from them is what lets the failure path keep
 * anything at all, rather than letting reconciliation strip capabilities and discard their
 * Insights history for good.
 */
export function detectionCapabilitiesIn(capabilities: readonly string[]): Set<string> {
  const known = new Set<string>([
    ...Object.values(OBJECT_DETECTION_CAPABILITIES),
    'scrypted_detection',
  ]);
  return new Set(capabilities.filter(capability => known.has(capability)));
}

/**
 * Normalises a Scrypted detection class onto the group the Flow card offers.
 *
 * Scrypted's detectors report concrete classes — `car`, `truck`, `dog` — while the Flow
 * dropdown offers grouped ones. Matching a Flow on the raw class would mean a Flow set to
 * "vehicle" never fires for a detected truck. Classes with no group, such as `motion` or a
 * recognised person's name, pass through unchanged so they can still be matched exactly.
 */
export function detectionGroupFor(className: string): string {
  const normalised = className.toLowerCase();
  const capability = OBJECT_DETECTION_CAPABILITIES[normalised];
  // Type-checked rather than truthy-checked: belt and braces with the null prototype above,
  // because a truthy non-string here throws, and this runs on every detection event.
  return typeof capability === 'string' ? capability.replace('alarm_', '') : normalised;
}

/** Returns the bindings that apply to a given Scrypted device. */
export function bindingsFor(device: ScryptedDeviceFacts): CapabilityBinding[] {
  const interfaces = new Set(device.interfaces);
  return CAPABILITY_BINDINGS.filter(binding =>
    interfaces.has(binding.iface) && (binding.appliesTo?.(device) ?? true));
}
