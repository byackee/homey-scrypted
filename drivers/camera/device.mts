import { ScryptedInterface, ScryptedInterfaceProperty, ScryptedMimeTypes } from '@scrypted/types';
import type { EventDetails, MediaStreamUrl, ObjectsDetected } from '@scrypted/types';
import { BaseScryptedDevice } from '../../lib/BaseScryptedDevice.mjs';
import { detectionGroupFor, OBJECT_DETECTION_CAPABILITIES } from '../../lib/capabilityMap.mjs';
import { setCameraVideo, videosOf, type VideoBase } from '../../lib/homeyVideos.mjs';
import { isLoopbackUrl, rewriteLoopbackHost } from '../../lib/streamUrl.mjs';
import type { AnyScryptedDevice } from '../../lib/types.mjs';

/** Homey rejects images above 5 MB, so an oversized frame is reported rather than sent. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const DEFAULT_RESET_SECONDS = 30;
const DEFAULT_MIN_SCORE = 0.5;

interface CameraSettings {
  detection_reset_seconds: number;
  detection_min_score: number;
}

/**
 * A Scrypted camera or doorbell in Homey.
 *
 * Beyond the generic capability bindings this adds the three things that make a camera
 * worth bridging: a snapshot tile, a live video stream, and object-detection events
 * surfaced both as capabilities and as Flow triggers.
 */
export default class ScryptedCameraDevice extends BaseScryptedDevice {

  private snapshotImage: unknown = null;
  private detectionImage: unknown = null;
  private video: VideoBase | null = null;

  /** The frame that produced the most recent detection, served to the Flow image token. */
  private lastDetectionFrame: Buffer | null = null;

  /** One auto-clear timer per detection capability, keyed by capability id. */
  private readonly resetTimers = new Map<string, NodeJS.Timeout>();

  /** Detection classes seen on this camera, used to decide which alarms to expose. */
  private detectionCapabilities = new Set<string>();

  private get settings(): CameraSettings {
    const raw = this.getSettings() as Partial<CameraSettings>;
    return {
      detection_reset_seconds: Number(raw.detection_reset_seconds ?? DEFAULT_RESET_SECONDS),
      detection_min_score: Number(raw.detection_min_score ?? DEFAULT_MIN_SCORE),
    };
  }

  protected override extraCapabilities(): string[] {
    return [...this.detectionCapabilities];
  }

  override async onUninit(): Promise<void> {
    for (const timer of this.resetTimers.values()) clearTimeout(timer);
    this.resetTimers.clear();
    await super.onUninit();
  }

  protected override async prepareExtraCapabilities(
    device: AnyScryptedDevice,
    interfaces: string[],
  ): Promise<void> {
    if (interfaces.includes(ScryptedInterface.ObjectDetector)) {
      await this.discoverDetectionClasses(device);
    }
  }

  protected override async onScryptedSynced(
    device: AnyScryptedDevice,
    interfaces: string[],
  ): Promise<void> {
    if (interfaces.includes(ScryptedInterface.Camera)) {
      await this.setupSnapshot(device);
    }
    if (interfaces.includes(ScryptedInterface.VideoCamera)) {
      await this.setupVideo();
    }
  }

  // ------------------------------------------------------------------ snapshots

  /**
   * Registers the snapshot tile. The image pulls a fresh frame from Scrypted every time
   * Homey renders it, so the tile is current without this app polling the camera.
   */
  private async setupSnapshot(device: AnyScryptedDevice): Promise<void> {
    if (this.snapshotImage) return;

    const image = await this.homey.images.createImage();
    image.setStream(async (stream: NodeJS.WritableStream) => {
      const buffer = await this.takeSnapshot(device);
      stream.end(buffer);
    });

    this.snapshotImage = image;
    await this.setCameraImage('snapshot', 'Snapshot', image);
  }

  private async takeSnapshot(device: AnyScryptedDevice): Promise<Buffer> {
    if (typeof device.takePicture !== 'function') {
      throw new Error(this.homey.__('errors.no_snapshot'));
    }

    const media = await device.takePicture();
    const mediaManager = await this.hub.getMediaManager();
    const buffer = await mediaManager.convertMediaObjectToBuffer(media, 'image/jpeg');

    if (buffer.length > MAX_IMAGE_BYTES) {
      throw new Error(`Snapshot is ${Math.round(buffer.length / 1024 / 1024)} MB, over Homey's 5 MB limit.`);
    }
    return buffer;
  }

  // ------------------------------------------------------------------ video

  /**
   * Publishes the camera's stream to Homey as RTSP.
   *
   * The URL is resolved on every play request rather than cached: Scrypted's rebroadcast
   * plugin hands out session-scoped URLs, and a stale one fails to open. Homey wraps the
   * stream in its own WebRTC proxy, which is what lets a LAN-only RTSP feed play in the
   * web app and away from home without this app doing any NAT traversal.
   */
  private async setupVideo(): Promise<void> {
    if (this.video) return;

    const videos = videosOf(this.homey);
    if (!videos) {
      this.log('This Homey has no Videos API; skipping live stream.');
      return;
    }

    try {
      const video = await videos.createVideoRTSP({ acceptInvalidCertificates: true });
      video.registerVideoUrlListener(async () => ({ url: await this.resolveStreamUrl() }));
      await setCameraVideo(this, 'main', 'Live', video);
      this.video = video;
    } catch (err) {
      this.error('Could not register video stream:', (err as Error).message);
    }
  }

  private async resolveStreamUrl(): Promise<string> {
    const device = this.scryptedDevice;
    if (!device || typeof device.getVideoStream !== 'function') {
      throw new Error(this.homey.__('errors.no_video'));
    }

    const media = await device.getVideoStream();
    const mediaManager = await this.hub.getMediaManager();
    const streamUrl = await mediaManager.convertMediaObjectToJSON<MediaStreamUrl>(
      media,
      ScryptedMimeTypes.MediaStreamUrl,
    );

    if (!streamUrl?.url) throw new Error('Scrypted returned no stream URL for this camera.');

    // Scrypted's rebroadcast plugin advertises 127.0.0.1, which from Homey means Homey.
    // Point it back at the server we are connected to; the port and path are what identify
    // the rebroadcast session and are left alone.
    const host = this.hub.getConfig()?.host;
    if (host && isLoopbackUrl(streamUrl.url)) {
      const rewritten = rewriteLoopbackHost(streamUrl.url, host);
      this.log(`Rewrote loopback stream URL to ${host}`);
      return rewritten;
    }

    return streamUrl.url;
  }

  // ------------------------------------------------------------------ detections

  /**
   * Asks Scrypted which object classes this camera's detector can report, and exposes an
   * alarm capability for each one Homey has a mapping for. A camera running a plain motion
   * detector therefore does not sprout an unused "package detected" tile.
   */
  private async discoverDetectionClasses(device: AnyScryptedDevice): Promise<void> {
    let discovered: Set<string>;

    try {
      const types = await device.getObjectTypes?.();
      const classes: string[] = types?.classes ?? [];
      discovered = new Set(
        classes
          .map(className => OBJECT_DETECTION_CAPABILITIES[className.toLowerCase()])
          .filter((capability): capability is string => Boolean(capability)),
      );
    } catch (err) {
      // Keep whatever was discovered previously: a detector that is momentarily
      // unreachable should not cause its capabilities to be stripped off the device.
      this.log('Could not read detection classes:', (err as Error).message);
      return;
    }

    discovered.add('scrypted_detection');
    this.detectionCapabilities = discovered;
  }

  protected override async onScryptedEvent(
    details: EventDetails,
    data: unknown,
    device: AnyScryptedDevice,
  ): Promise<void> {
    if (details.eventInterface === ScryptedInterface.ObjectDetector) {
      await this.handleDetection(data as ObjectsDetected, device);
      return;
    }

    // A doorbell press arrives as BinarySensor going true. Only the rising edge is a press.
    if (details.eventInterface === ScryptedInterface.BinarySensor
      && details.property === ScryptedInterfaceProperty.binaryState
      && data === true) {
      await this.triggerDoorbell();
    }
  }

  private async handleDetection(detected: ObjectsDetected, device: AnyScryptedDevice): Promise<void> {
    const detections = detected?.detections ?? [];
    if (!detections.length) return;

    const { detection_min_score: minScore } = this.settings;

    // Scrypted only retains a frame when the detector flagged the session for retention.
    if (detected.detectionId && typeof device.getDetectionInput === 'function') {
      this.lastDetectionFrame = await this.fetchDetectionFrame(device, detected.detectionId);
    }

    const raisedAlarms = new Set<string>();
    const triggeredGroups = new Set<string>();

    for (const detection of detections) {
      const className = String(detection.className ?? '').toLowerCase();
      if (!className || (detection.score ?? 0) < minScore) continue;

      const capability = OBJECT_DETECTION_CAPABILITIES[className];
      if (capability && !raisedAlarms.has(capability)) {
        raisedAlarms.add(capability);
        await this.raiseDetectionAlarm(capability);
      }

      // Flows match on the group, not the raw class, so one filtered on "vehicle" fires
      // for a detected truck. The raw class is still carried in the Flow token.
      const group = detectionGroupFor(className);

      // One frame routinely contains several objects of the same kind. Firing the trigger
      // once per person in view would spam the Flow, so each group triggers once per event.
      if (triggeredGroups.has(group)) continue;
      triggeredGroups.add(group);

      await this.triggerObjectDetected(group, className, detection.label, detection.score ?? 0);
    }

    if (triggeredGroups.size && this.hasCapability('scrypted_detection')) {
      await this.setCapabilityValue('scrypted_detection', [...triggeredGroups].join(', '))
        .catch(() => undefined);
    }
  }

  private async fetchDetectionFrame(
    device: AnyScryptedDevice,
    detectionId: string,
  ): Promise<Buffer | null> {
    try {
      const media = await device.getDetectionInput(detectionId);
      const mediaManager = await this.hub.getMediaManager();
      const buffer = await mediaManager.convertMediaObjectToBuffer(media, 'image/jpeg');
      return buffer.length <= MAX_IMAGE_BYTES ? buffer : null;
    } catch (err) {
      this.log('Could not fetch detection frame:', (err as Error).message);
      return null;
    }
  }

  /**
   * Raises a detection alarm and schedules it to clear.
   *
   * Scrypted reports detections as discrete events with no "gone" counterpart, so a
   * boolean Homey capability would latch on forever without this timer. Each new detection
   * restarts the countdown, which keeps the alarm continuously true while activity lasts.
   */
  private async raiseDetectionAlarm(capability: string): Promise<void> {
    if (!this.hasCapability(capability)) return;

    await this.setCapabilityValue(capability, true).catch(() => undefined);

    const existing = this.resetTimers.get(capability);
    if (existing) clearTimeout(existing);

    const seconds = Math.max(1, this.settings.detection_reset_seconds);
    const timer = this.homey.setTimeout(() => {
      this.resetTimers.delete(capability);
      this.setCapabilityValue(capability, false).catch(() => undefined);
    }, seconds * 1000);

    this.resetTimers.set(capability, timer as unknown as NodeJS.Timeout);
  }

  private async triggerObjectDetected(
    group: string,
    className: string,
    label: string | undefined,
    score: number,
  ): Promise<void> {
    const card = this.homey.flow.getDeviceTriggerCard('object_detected');

    const tokens: Record<string, unknown> = {
      detection_class: className,
      label: label ?? '',
      score: Math.round(score * 100),
    };

    const image = await this.getDetectionImage();
    if (image) tokens.snapshot = image;

    await card.trigger(this, tokens, { detection_class: group })
      .catch(err => this.error('object_detected trigger failed:', (err as Error).message));
  }

  /** Lazily creates the Flow image token backed by the most recent detection frame. */
  private async getDetectionImage(): Promise<unknown | null> {
    if (!this.lastDetectionFrame) return null;

    if (!this.detectionImage) {
      const image = await this.homey.images.createImage();
      image.setStream(async (stream: NodeJS.WritableStream) => {
        const frame = this.lastDetectionFrame;
        if (!frame) throw new Error('No detection frame available.');
        stream.end(frame);
      });
      this.detectionImage = image;
    } else {
      await (this.detectionImage as { update(): Promise<void> }).update().catch(() => undefined);
    }

    return this.detectionImage;
  }

  private async triggerDoorbell(): Promise<void> {
    const card = this.homey.flow.getDeviceTriggerCard('doorbell_pressed');
    const tokens: Record<string, unknown> = {};

    if (this.snapshotImage) {
      await (this.snapshotImage as { update(): Promise<void> }).update().catch(() => undefined);
      tokens.snapshot = this.snapshotImage;
    }

    await card.trigger(this, tokens, {})
      .catch(err => this.error('doorbell_pressed trigger failed:', (err as Error).message));
  }

  // ------------------------------------------------------------------ flow actions

  /** Refreshes the snapshot tile on demand, used by the `take_snapshot` Flow action. */
  async refreshSnapshot(): Promise<void> {
    if (!this.snapshotImage) throw new Error(this.homey.__('errors.no_snapshot'));
    await (this.snapshotImage as { update(): Promise<void> }).update();
  }
}
