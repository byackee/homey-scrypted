import sourceMapSupport from 'source-map-support';
import Homey from 'homey';
import { ScryptedMimeTypes } from '@scrypted/types';
import type { MediaStreamUrl, VideoClip } from '@scrypted/types';
import { ScryptedHub } from './lib/ScryptedHub.mjs';
import { typesForDriver, type DriverId } from './lib/deviceTypeMap.mjs';
import { clipQuery, isObjectClip, selectLatestObjectClip, thumbnailIdOf } from './lib/videoClips.mjs';
import type { ScryptedConfig } from './lib/types.mjs';

sourceMapSupport.install();

const SETTINGS_KEY = 'scrypted.config';

/** Hides any user:password embedded in a URL before it reaches the diagnostics output. */
function maskCredentials(url?: string): string | undefined {
  return url?.replace(/\/\/[^/@]+@/, '//***:***@');
}

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

  /**
   * Recent events from the drivers, newest last.
   *
   * A CLI-installed Homey app has no readable log, so this is the only way to observe
   * what pairing actually did. Capped so it cannot grow without bound.
   */
  private readonly traces: string[] = [];

  /** Records one line for the diagnostics endpoint. Never throws. */
  trace(message: string): void {
    try {
      this.traces.push(`${new Date().toISOString()} ${message}`);
      if (this.traces.length > 200) this.traces.splice(0, this.traces.length - 200);
      this.log(message);
    } catch {
      // Tracing must never break the flow it is observing.
    }
  }

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

  /**
   * Applies a configuration change from the settings page.
   *
   * The page cannot read the stored password back, so it leaves that field empty and posts
   * an empty string whenever the user did not retype it. Taking that literally wiped the
   * password of anyone who opened settings only to correct a host or a port, which broke
   * the connection they had come to fix. An empty password therefore means unchanged.
   */
  async updateConfig(update: Omit<ScryptedConfig, 'password'> & { password?: string }): Promise<void> {
    const stored = this.homey.settings.get(SETTINGS_KEY) as ScryptedConfig | null;
    const password = update.password || stored?.password;
    if (!password) throw new Error(this.homey.__('errors.password_required'));

    await this.saveConfig({
      host: update.host,
      port: update.port,
      username: update.username,
      password,
    });
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
   *
   * Add ?video=1 to also resolve each camera's stream URL.
   */
  async getDiagnostics(
    options: { video?: boolean; plugins?: boolean; clips?: boolean } = {},
  ): Promise<unknown> {
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
      // Opt-in: resolving a stream URL asks Scrypted to start the stream, which a
      // diagnostics read should not do by itself.
      videoProbe: options.video ? await this.probeVideo() : 'pass ?video=1 to probe streams',
      clipProbe: options.clips ? await this.probeClips() : 'pass ?clips=1 to probe recorded clips',
      pairedDevices: this.describePairedDevices(),
      plugins: options.plugins ? await this.probePlugins() : undefined,
      traces: this.traces,
    };
  }

  /**
   * Resolves the stream URL for every camera exactly the way the camera driver does.
   *
   * Homey's player reports only "unable to open the MRL", which says nothing about what
   * it was handed. Credentials in the URL are masked; the host, port and scheme are what
   * matter, since a rebroadcast URL bound to localhost is unusable from Homey.
   */
  /** The capabilities each paired Homey device currently carries. */
  private describePairedDevices(): unknown[] {
    const described: unknown[] = [];
    for (const driver of Object.values(this.homey.drivers.getDrivers())) {
      for (const device of driver.getDevices()) {
        described.push({
          driver: driver.id,
          name: device.getName(),
          available: device.getAvailable(),
          capabilities: device.getCapabilities(),
        });
      }
    }
    return described;
  }

  /**
   * Every device Scrypted knows, with the plugin providing it and the extensions applied.
   * Comparing the extension list of a camera that works against one that does not is what
   * located the difference between them here.
   */
  private async probePlugins(): Promise<unknown> {
    const client = await this.hub.getClient();
    const state = client.systemManager.getSystemState();
    const rows: unknown[] = [];

    for (const id of Object.keys(state ?? {})) {
      const entry = state[id] as Record<string, { value?: any }>;
      const mixinIds = (entry?.mixins?.value ?? []) as string[];
      rows.push({
        id,
        name: entry?.name?.value,
        type: entry?.type?.value,
        pluginId: entry?.pluginId?.value,
        version: entry?.info?.value?.version,
        // Mixin providers are often Internal devices a non-admin session cannot resolve,
        // so ids that do not map to a name are reported as ids.
        mixins: mixinIds.map(mixinId => {
          const provider = state[mixinId] as Record<string, { value?: any }> | undefined;
          return provider?.name?.value ?? provider?.pluginId?.value ?? mixinId;
        }),
      });
    }
    return rows;
  }

  /**
   * What the recorder actually holds for each camera.
   *
   * The distinction this reports is the one that decides the feature: an event carrying an
   * object class returns a thumbnail, while one whose only class is `motion` does not, and
   * video returns for neither on an NVR that indexes events without retaining footage.
   * "No recent event" and "the recorder keeps nothing" look identical from the tile, and
   * this is what tells them apart.
   *
   * Listing events and fetching a thumbnail start nothing on the camera. The `getVideoClip`
   * branch below is different in kind and only looks harmless because it fails here: on a
   * recorder that does retain footage it would ask Scrypted to prepare a recording, and the
   * media object it returns is never released. That branch exists precisely for the day the
   * configuration changes — which is the day it stops being free. Opt-in, and not called by
   * the tile.
   */
  private async probeClips(): Promise<unknown[]> {
    const cameras = await this.hub.listDevices(['Camera', 'Doorbell']);
    const results: unknown[] = [];

    for (const camera of cameras) {
      const entry: Record<string, unknown> = { name: camera.name, id: camera.id };
      try {
        if (!camera.interfaces.includes('VideoClips')) {
          entry.error = 'no VideoClips interface';
          results.push(entry);
          continue;
        }

        const device = await this.hub.getDevice(camera.id);
        if (!device || typeof device.getVideoClips !== 'function') {
          entry.error = 'interface declared but getVideoClips is missing';
          results.push(entry);
          continue;
        }

        const clips: VideoClip[] = await device.getVideoClips(clipQuery(Date.now())) ?? [];
        entry.total = clips.length;
        entry.objectEvents = clips.filter(isObjectClip).length;
        entry.motionOnly = clips.length - clips.filter(isObjectClip).length;
        entry.classes = [...new Set(clips.flatMap(c => c.detectionClasses ?? []))];

        const latest = selectLatestObjectClip(clips);
        entry.latestObjectEvent = latest
          ? {
            startedAt: new Date(latest.startTime).toISOString(),
            ageSeconds: Math.round((Date.now() - latest.startTime) / 1000),
            classes: latest.detectionClasses,
            durationMs: latest.duration,
          }
          : 'none in the query window';

        // Fetched exactly the way the tile does, so a working probe means a working tile.
        const thumbnailId = thumbnailIdOf(latest);
        if (thumbnailId && typeof device.getVideoClipThumbnail === 'function') {
          try {
            const media = await device.getVideoClipThumbnail(thumbnailId);
            const mediaManager = await this.hub.getMediaManager();
            const buffer = await mediaManager.convertMediaObjectToBuffer(media, 'image/jpeg');
            entry.thumbnailBytes = buffer?.length;
          } catch (err) {
            entry.thumbnailError = (err as Error).message.split('\n')[0];
          }
        }

        // Reported, not used. If a future NVR configuration starts serving footage this is
        // where it will show up first, and the tile can then be extended rather than guessed at.
        if (latest && typeof device.getVideoClip === 'function') {
          try {
            const media = await device.getVideoClip(latest.videoId ?? latest.id);
            const mediaManager = await this.hub.getMediaManager();
            const resolved = await mediaManager.convertMediaObjectToJSON<MediaStreamUrl>(
              media, ScryptedMimeTypes.MediaStreamUrl);
            entry.videoUrl = maskCredentials(resolved?.url);
            entry.videoContainer = resolved?.container;
          } catch (err) {
            entry.videoError = (err as Error).message.split('\n')[0];
          }
        }
      } catch (err) {
        entry.error = (err as Error).message;
      }
      results.push(entry);
    }

    return results;
  }

  private async probeVideo(): Promise<unknown[]> {
    const cameras = await this.hub.listDevices(['Camera', 'Doorbell']);
    const results: unknown[] = [];

    for (const camera of cameras) {
      const entry: Record<string, unknown> = { name: camera.name, id: camera.id };
      try {
        const device = await this.hub.getDevice(camera.id);
        if (!device || typeof device.getVideoStream !== 'function') {
          entry.error = 'no VideoCamera interface';
          results.push(entry);
          continue;
        }

        entry.streamOptions = (await device.getVideoStreamOptions())
          ?.map((option: Record<string, any>) => ({
            id: option.id,
            name: option.name,
            container: option.container,
            videoCodec: option.video?.codec,
            audioCodec: option.audio?.codec,
            resolution: option.video?.width ? `${option.video.width}x${option.video.height}` : undefined,
            destinations: option.destinations,
          }));

        const mediaManager = await this.hub.getMediaManager();
        // Resolve both, so the difference between the default stream and the one meant for
        // remote viewing is visible side by side.
        // Exactly one stream is opened per camera. Each resolution starts a rebroadcast
        // session, and cameras accept only a handful of concurrent RTSP clients — probing
        // several streams at once is enough to make a camera fail that is otherwise fine.
        const streamOptions = await device.getVideoStreamOptions();
        const remoteOption = (streamOptions ?? []).find((o: any) => o.destinations?.includes('remote'));
        entry.remoteStreamId = remoteOption?.id;

        const media = await device.getVideoStream(
          remoteOption?.id ? { id: remoteOption.id } : { destination: 'remote' });
        const streamUrl = await mediaManager.convertMediaObjectToJSON<{ url?: string; container?: string }>(
          media,
          'text/x-media-url',
        );
        entry.url = maskCredentials(streamUrl?.url);

        // What the camera's detector can report, which decides the alarm capabilities the
        // device exposes. A camera with no ObjectDetector interface gets none, by design.
        entry.hasObjectDetector = camera.interfaces.includes('ObjectDetector');
        if (entry.hasObjectDetector && typeof device.getObjectTypes === 'function') {
          entry.detectionClasses = (await device.getObjectTypes())?.classes;
        }
      } catch (err) {
        entry.error = (err as Error).message;
      }
      results.push(entry);
    }

    return results;
  }

  private async previewPairing(): Promise<Record<string, unknown>> {
    const drivers: DriverId[] = ['camera'];
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
