import { ScryptedInterface, ScryptedInterfaceProperty, ScryptedMimeTypes } from '@scrypted/types';
import type {
  EventDetails,
  MediaStreamDestination,
  MediaStreamUrl,
  ObjectsDetected,
} from '@scrypted/types';
import { BaseScryptedDevice } from '../../lib/BaseScryptedDevice.mjs';
import {
  detectionCapabilitiesIn,
  detectionGroupFor,
  OBJECT_DETECTION_CAPABILITIES,
} from '../../lib/capabilityMap.mjs';
import { DetectionThrottle } from '../../lib/detectionThrottle.mjs';
import { setCameraVideo, videosOf, type VideoBase } from '../../lib/homeyVideos.mjs';
import { HomeyOfferSession } from '../../lib/webrtcBridge.mjs';
import {
  clipQuery,
  hasRecentDetection,
  selectLatestObjectClip,
  thumbnailIdOf,
} from '../../lib/videoClips.mjs';
import { isLoopbackUrl, rewriteLoopbackHost } from '../../lib/streamUrl.mjs';
import type { AnyScryptedDevice } from '../../lib/types.mjs';

/** Homey rejects images above 5 MB, so an oversized frame is reported rather than sent. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const DEFAULT_RESET_SECONDS = 30;
const DEFAULT_MIN_SCORE = 0.5;
const DEFAULT_TRIGGER_COOLDOWN_SECONDS = 10;

/**
 * How rarely the "nothing qualified" diagnostic line may be written.
 *
 * Deliberately a constant and not the trigger cooldown: the two are unrelated, and tying
 * them together removed the limit entirely at the cooldown's documented `0` opt-out.
 */
const BELOW_THRESHOLD_TRACE_MS = 10_000;

/**
 * How many WebRTC sessions one camera may hold open at once.
 *
 * Phones, tablets and the web app come and go, but a wall dashboard holding a camera tile
 * open occupies a slot for as long as it is on screen — so the realistic ceiling is higher
 * than the number of people in the house. Dozens would mean sessions nobody is watching.
 * See `rememberRtcSession`.
 */
const MAX_RTC_SESSIONS = 8;

/** The handle Scrypted returns for a live signalling session. */
interface RtcControl {
  endSession(): Promise<void>;
  extendSession?(): Promise<void>;
  getRefreshAt?(): Promise<number | void>;
}

/** Mirrors `asNumber` in capabilityMap: anything that is not a real number is not a number. */
function finiteOr(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

interface CameraSettings {
  detection_reset_seconds: number;
  detection_min_score: number;
  /** Shortest gap between two Flow triggers for the same object group. See `DetectionThrottle`. */
  detection_trigger_cooldown: number;
  /** Which of Scrypted's streams to request. See `resolveStreamUrl`. */
  stream_destination: MediaStreamDestination;
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

  /** Rate-limits the two expensive effects of a detection: the frame fetch and the trigger. */
  private readonly throttle = new DetectionThrottle();

  /**
   * Live WebRTC sessions, keyed by the offer that opened them.
   *
   * Held so a keep-alive can reach the right one and so teardown can close them: a session
   * left open holds a rebroadcast on the camera long after the viewer walked away.
   *
   * Bounded, because nothing tells this app that a viewer closed a stream — Homey's Videos
   * API offers a keep-alive but no "ended" callback. Without a cap the map would grow by one
   * multi-kilobyte SDP key per play, for the life of the app, and hold every rebroadcast
   * open on the camera with it. The oldest is closed when a new one arrives beyond the cap,
   * which is also the only signal available that it is no longer being watched.
   */
  private readonly rtcControls = new Map<string, RtcControl | undefined>();

  /** The tile showing the thumbnail of the last recorded detection. See `setupEventImage`. */
  private eventImage: unknown = null;

  /** When the "nothing qualified" diagnostic line was last written. See `traceBelowThreshold`. */
  private lastBelowThresholdTrace = Number.NEGATIVE_INFINITY;

  /** Detection classes seen on this camera, used to decide which alarms to expose. */
  private detectionCapabilities = new Set<string>();

  private get settings(): CameraSettings {
    const raw = this.getSettings() as Partial<CameraSettings>;
    return {
      detection_reset_seconds: Number(raw.detection_reset_seconds ?? DEFAULT_RESET_SECONDS),
      detection_min_score: Number(raw.detection_min_score ?? DEFAULT_MIN_SCORE),
      // Finite-checked, unlike its neighbours: a stored value that coerces to NaN would
      // reach the throttle as a NaN cooldown, and the whole limit exists to survive being
      // handed a bad number rather than quietly reverting to no limit at all.
      detection_trigger_cooldown: finiteOr(
        raw.detection_trigger_cooldown, DEFAULT_TRIGGER_COOLDOWN_SECONDS),
      stream_destination: (raw.stream_destination ?? 'remote') as MediaStreamDestination,
    };
  }

  protected override extraCapabilities(): string[] {
    return [...this.detectionCapabilities];
  }

  override async onInit(): Promise<void> {
    // What this device already carries is the only record of a previous discovery that
    // survives a restart. Without it the first sync starts from an empty set, and a
    // detector that is briefly unreachable makes reconciliation strip every detection
    // capability — taking its Insights history with it, permanently.
    this.detectionCapabilities = detectionCapabilitiesIn(this.getCapabilities());

    // Registered before anything can arm one: `homey.setTimeout` ties a timer to the app's
    // lifetime, not this device's, so a camera deleted mid-detection would otherwise leave
    // callbacks pending for up to an hour that then write capabilities on a dead device.
    await this.resources.add('the detection timers', () => {
      for (const timer of this.resetTimers.values()) this.homey.clearTimeout(timer);
      this.resetTimers.clear();
      this.throttle.clear();
      this.lastDetectionFrame = null;
    });

    // Registered alongside the timers, and for the same reason: a signalling session lives
    // on the Scrypted side and outlives this device unless it is closed explicitly.
    await this.resources.add('the WebRTC sessions', async () => {
      for (const control of this.rtcControls.values()) {
        await control?.endSession().catch(() => undefined);
      }
      this.rtcControls.clear();
    });

    await super.onInit();
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
      await this.setupVideo(interfaces);
    }
    if (interfaces.includes(ScryptedInterface.VideoClips)) {
      await this.setupEventImage();
    }

    // A detection arriving after a reconnect is news, whatever the clock says about one
    // that arrived before the gap — so the cooldown does not carry across it.
    this.throttle.clear();

    await this.clearStaleDetectionAlarms();
  }

  /**
   * Clears a detection alarm that was left latched on.
   *
   * The reset timer writes `false`, and Homey prevents capability writes while a device is
   * unavailable. A hub disconnect landing between the detection and its timer therefore
   * loses the clear, and the timer is spent — so the alarm stays on with nothing left to
   * turn it off. Seeding cannot cover it either: these alarms are derived from events, not
   * from a Scrypted property, so there is no value to read back. This runs once the device
   * has been made available again, which is the first moment a write can land.
   */
  private async clearStaleDetectionAlarms(): Promise<void> {
    for (const capability of this.detectionCapabilities) {
      if (capability === 'scrypted_detection') continue;
      if (this.resetTimers.has(capability)) continue;
      if (this.getCapabilityValue(capability) !== true) continue;

      this.trace(`clearing stale ${capability}`);
      await this.setCapabilityValue(capability, false).catch(() => undefined);
    }
  }

  // ------------------------------------------------------------------ snapshots

  /**
   * Registers the snapshot tile. The image pulls a fresh frame from Scrypted every time
   * Homey renders it, so the tile is current without this app polling the camera.
   */
  private async setupSnapshot(device: AnyScryptedDevice): Promise<void> {
    if (this.snapshotImage || this.resources.isReleased) return;

    const image = await this.homey.images.createImage();
    // Resolved per call, never captured: a device proxy is bound to the socket that handed
    // it out, so the one passed in here dies with the first reconnect. Binding it into the
    // stream left the tile, the snapshot action and the doorbell token broken until the
    // Homey app itself restarted — the image is created once, but it is read for years.
    image.setStream(async (stream: NodeJS.WritableStream) => {
      const live = this.scryptedDevice;
      if (!live) throw new Error(this.homey.__('errors.not_connected'));
      const buffer = await this.takeSnapshot(live);
      stream.end(buffer);
    });

    // Teardown can land while `createImage` is in flight. `add` releases it for us in that
    // case, rather than leaving it registered against a device that is gone.
    if (!await this.resources.add('the snapshot image', async () => {
        this.snapshotImage = null;
        await image.unregister();
      })) return;

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

  // ------------------------------------------------------------------ recorded events

  /**
   * Registers the tile showing the last recorded detection.
   *
   * This is the recorder's own thumbnail, not a fresh frame: the NVR crops it to the object
   * it recognised, and it keeps showing what actually triggered rather than whatever the
   * camera happens to see now. The snapshot tile already covers "now".
   *
   * Only the thumbnail. Measured against this NVR, `getVideoClip` fails for every clip on
   * every camera — "empty set during getRecordingForTime" for motion clips, "Conversion not
   * supported" for object clips — because it indexes events without retaining their video.
   * Offering a clip tile would offer one that never opens.
   */
  private async setupEventImage(): Promise<void> {
    if (this.eventImage || this.resources.isReleased) return;

    const image = await this.homey.images.createImage();
    // Resolved per render, like the snapshot: the device proxy dies with the socket, and
    // the newest event is a different one every time anyway.
    image.setStream(async (stream: NodeJS.WritableStream) => {
      const buffer = await this.fetchLatestEventThumbnail();
      stream.end(buffer);
    });

    if (!await this.resources.add('the event image', async () => {
      this.eventImage = null;
      await image.unregister();
    })) return;

    this.eventImage = image;
    await this.setCameraImage('event', this.homey.__('images.last_event'), image);
  }

  private async fetchLatestEventThumbnail(): Promise<Buffer> {
    const device = this.scryptedDevice;
    if (!device || typeof device.getVideoClips !== 'function') {
      throw new Error(this.homey.__('errors.not_connected'));
    }

    const clips = await device.getVideoClips(clipQuery(Date.now(), this.eventLookbackMs));
    const latest = selectLatestObjectClip(clips);
    const thumbnailId = thumbnailIdOf(latest);

    if (!thumbnailId || typeof device.getVideoClipThumbnail !== 'function') {
      throw new Error(this.homey.__('errors.no_recent_event'));
    }

    const media = await device.getVideoClipThumbnail(thumbnailId);
    const mediaManager = await this.hub.getMediaManager();
    const buffer = await mediaManager.convertMediaObjectToBuffer(media, 'image/jpeg');

    if (buffer.length > MAX_IMAGE_BYTES) {
      throw new Error(`Event thumbnail is ${Math.round(buffer.length / 1024 / 1024)} MB, over Homey's 5 MB limit.`);
    }
    return buffer;
  }

  /** How far back the event tile and the Flow condition look. Bounded by the query itself. */
  private get eventLookbackMs(): number {
    return finiteOr(this.getSettings()?.event_lookback_hours, 6) * 60 * 60_000;
  }

  /**
   * Answers the "was something detected recently" Flow condition from the recorder's index
   * rather than from this app's own state, so it survives an app restart and covers the
   * period before the device was even paired.
   */
  async wasDetectedRecently(group: string, minutes: number): Promise<boolean> {
    const device = this.scryptedDevice;
    if (!device || typeof device.getVideoClips !== 'function') {
      throw new Error(this.homey.__('errors.not_connected'));
    }

    const now = Date.now();
    const windowMs = Math.max(1, finiteOr(minutes, 5)) * 60_000;
    // Asked for exactly the window the condition cares about, so a camera holding weeks of
    // events does not answer with all of them.
    const clips = await device.getVideoClips(clipQuery(now, windowMs));

    return hasRecentDetection(clips, group, now, windowMs);
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
  private async setupVideo(interfaces: string[]): Promise<void> {
    if (this.video || this.resources.isReleased) return;

    const videos = videosOf(this.homey);
    if (!videos) {
      this.log('This Homey has no Videos API; skipping live stream.');
      return;
    }

    // WebRTC is opt-in rather than automatic. RTSP through Homey's proxy is what these
    // cameras are known to play, and silently switching a working live view onto an
    // untried path is not an upgrade. The setting says which the user asked for.
    const wantsWebRTC = this.getSettings()?.video_transport === 'webrtc'
      && interfaces.includes(ScryptedInterface.RTCSignalingChannel)
      && typeof videos.createVideoWebRTC === 'function';

    try {
      if (wantsWebRTC) {
        await this.setupWebRTCVideo(videos);
        return;
      }

      const video = await videos.createVideoRTSP({ acceptInvalidCertificates: true });
      if (!await this.resources.add('the video stream', async () => {
        this.video = null;
        await video.unregister();
      })) return;

      // Adopted before it is wired: `setCameraVideo` can throw, and leaving `this.video`
      // null then would let the next sync register a second stream on top of this one.
      this.video = video;
      video.registerVideoUrlListener(async () => ({ url: await this.resolveStreamUrl() }));
      await setCameraVideo(this, 'main', 'Live', video);
    } catch (err) {
      this.error('Could not register video stream:', (err as Error).message);
    }
  }

  /**
   * Publishes the camera over WebRTC, negotiated directly with Scrypted.
   *
   * The RTSP path hands Homey a rebroadcast URL and lets Homey's own WebRTC proxy carry it
   * outward, which means the stream is unpacked and repacked on the way. Here the camera and
   * the viewer negotiate once and the media flows between them, which is what removes the
   * hop. `HomeyOfferSession` carries the whole of the shape mismatch between the two APIs.
   *
   * Nothing is cached across plays: a signalling session belongs to one viewer and one
   * connection, so each offer opens its own and its control handle dies with it.
   */
  private async setupWebRTCVideo(videos: NonNullable<ReturnType<typeof videosOf>>): Promise<void> {
    const video = await videos.createVideoWebRTC({ acceptInvalidCertificates: true });
    if (!await this.resources.add('the WebRTC stream', async () => {
      this.video = null;
      await video.unregister();
    })) return;

    this.video = video;

    video.registerOfferListener(async (offerSdp: string) => {
      const device = this.scryptedDevice;
      if (!device || typeof device.startRTCSignalingSession !== 'function') {
        throw new Error(this.homey.__('errors.no_video'));
      }

      const session = new HomeyOfferSession(offerSdp);
      let control: RtcControl | undefined;

      try {
        // Started before the wait, and the wait is what produces the answer: Scrypted calls
        // back into the session while this promise is still in flight.
        control = await device.startRTCSignalingSession(session) as RtcControl | undefined;
        const answerSdp = await session.waitForAnswer();

        if (session.ignoredCandidates) {
          // Not fatal — the answer already holds whatever was gathered in time — but it
          // means the far side trickled despite being asked not to, which is the first
          // thing to know if the picture is one-way or never starts.
          this.trace(`webrtc: ${session.ignoredCandidates} late ICE candidate(s) discarded`);
        }

        // Re-checked after both awaits, like every other post-await path in this file. The
        // device can be deleted while `startRTCSignalingSession` is still in RPC, and
        // teardown releases in reverse order — it unregisters the video and drains
        // `rtcControls` while it is still empty. Storing the control after that point puts
        // it in a map nothing will ever drain again, leaving the session and its rebroadcast
        // open on the camera until Scrypted's own refresh timeout notices.
        // Throwing is enough to close it: the catch below ends the session on the way out.
        // Calling `endSession` here as well would just close it twice.
        if (this.resources.isReleased) throw new Error(this.homey.__('errors.device_missing'));

        this.rememberRtcSession(offerSdp, control);
        return { answerSdp, streamId: offerSdp };
      } catch (err) {
        // A session that opened and then failed to answer still holds resources on the
        // Scrypted side, and no one else will close it.
        session.reject(err as Error);
        await control?.endSession().catch(() => undefined);
        throw err;
      }
    });

    video.registerKeepAliveListener(async (streamId: string) => {
      const control = this.rtcControls.get(streamId);
      // Re-inserted so the cap treats a stream someone is still watching as the newest,
      // rather than evicting it because it started first.
      if (control) {
        this.rtcControls.delete(streamId);
        this.rtcControls.set(streamId, control);
      }
      await control?.extendSession?.().catch(() => undefined);
    });

    await setCameraVideo(this, 'main', 'Live', video);
  }

  /**
   * Stores a session and closes whatever fell off the end.
   *
   * Insertion order is what makes this work: a `Map` iterates oldest-first, and the
   * keep-alive re-inserts a live stream so age here means "longest since anyone said they
   * were still watching", not "opened longest ago".
   */
  private rememberRtcSession(streamId: string, control: RtcControl | undefined): void {
    // A player that gave up and replayed reuses its peer connection, so the same offer can
    // open a second session. A bare `set` would drop the first control without closing it —
    // and would not move the entry, so the newest stream would be the first evicted, since
    // `Map.set` on an existing key leaves its insertion position alone.
    // `previous !== control` because the RPC layer caches remote proxies by id
    // (`remoteWeakProxies` in `rpc.js`), so two sessions could in principle resolve to the
    // same JavaScript object. Closing it here would then kill the stream that is about to
    // be stored, at the moment it finished negotiating.
    const previous = this.rtcControls.get(streamId);
    if (previous && previous !== control) void previous.endSession().catch(() => undefined);
    this.rtcControls.delete(streamId);

    this.rtcControls.set(streamId, control);

    while (this.rtcControls.size > MAX_RTC_SESSIONS) {
      const oldest = this.rtcControls.keys().next();
      if (oldest.done) break;

      const stale = this.rtcControls.get(oldest.value);
      this.rtcControls.delete(oldest.value);
      this.trace('webrtc: closing the least recently kept-alive session');
      void stale?.endSession().catch(() => undefined);
    }
  }

  private async resolveStreamUrl(): Promise<string> {
    const device = this.scryptedDevice;
    if (!device || typeof device.getVideoStream !== 'function') {
      throw new Error(this.homey.__('errors.no_video'));
    }

    // Cameras publish several streams, each tagged by Scrypted with the destinations it
    // suits. Requesting none returns the default, typically the full-resolution stream
    // tagged `local`, which is not what a viewer outside the network can be served — the
    // difference between a picture and "unable to open the MRL" away from home.
    //
    // The stream is selected by id rather than by passing `destination`, because that
    // field is a hint Scrypted does not always honour. Where no stream advertises the
    // wanted destination the hint is passed instead and Scrypted decides, which is the
    // right answer for a camera that publishes only one stream.
    const destination = this.settings.stream_destination;
    const options = await device.getVideoStreamOptions();
    const match = (options ?? []).find((option: { destinations?: string[] }) =>
      option.destinations?.includes(destination));

    // There is deliberately no option here to drop the audio track. Scrypted's rebroadcast
    // plugin serves the session it already holds and ignores `audio: null` on the request:
    // measured on a real server, the SDP came back byte-identical with the audio track
    // still present. Removing audio has to happen on the Scrypted side, by transcoding.
    this.trace(`stream request: destination=${destination} `
      + `-> ${match?.id ? `id ${match.id}` : 'by destination (no tagged stream)'}`);
    const media = await device.getVideoStream(match?.id ? { id: match.id } : { destination });
    const mediaManager = await this.hub.getMediaManager();
    const streamUrl = await mediaManager.convertMediaObjectToJSON<MediaStreamUrl>(
      media,
      ScryptedMimeTypes.MediaStreamUrl,
    );

    if (!streamUrl?.url) throw new Error(this.homey.__('errors.no_stream_url'));
    this.trace(`stream resolved: ${streamUrl.url.replace(/\/\/[^/@]+@/, '//***@')}`);

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
    this.trace(`detection capabilities: ${[...discovered].join(',')}`);
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

    const { detection_min_score: minScore, detection_trigger_cooldown: cooldown } = this.settings;
    const cooldownMs = Math.max(0, cooldown) * 1000;
    const now = Date.now();

    const raisedAlarms = new Set<string>();
    /** Every group in this event, throttled or not: the summary capability reflects all of them. */
    const seenGroups = new Set<string>();
    /** The groups allowed to pay for a frame fetch and a Flow trigger this time round. */
    const admittedGroups: { group: string; className: string; label?: string; score: number }[] = [];

    // Alarms are raised inside this loop for every event, deliberately outside the throttle
    // below. They are cheap — a write that would not change the value is skipped — and
    // their auto-clear countdown has to restart on each frame, which is what keeps an alarm
    // continuously true for as long as the activity lasts.
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
      if (seenGroups.has(group)) continue;
      seenGroups.add(group);

      // And across events, the detector re-reports the same object on every analysed frame.
      // Admitting each of those would fetch a JPEG over RPC and fire a Flow trigger hundreds
      // of times a second, which is what used to take the app down.
      if (!this.throttle.admit(group, cooldownMs, now)) continue;

      admittedGroups.push({
        group,
        className,
        label: detection.label,
        score: detection.score ?? 0,
      });
    }

    // Re-checked after the awaits above, like every other post-await write in this file:
    // teardown may have landed while the alarms were being raised.
    if (this.resources.isReleased) return;

    // The summary is a plain capability write, guarded against writing an unchanged value,
    // so it stays honest about what is in view even while the triggers are held back.
    if (seenGroups.size && this.hasCapability('scrypted_detection')) {
      const summary = [...seenGroups].join(', ');
      if (this.getCapabilityValue('scrypted_detection') !== summary) {
        await this.setCapabilityValue('scrypted_detection', summary).catch(() => undefined);
      }
    }

    if (!admittedGroups.length) {
      // Nothing qualified at all — as opposed to qualifying and being held back. "My Flow
      // never fires" is the question this buffer exists to answer, and before the throttle
      // the unfiltered detection line was what showed a user their score threshold sat
      // above what their camera actually reports. Paced by its own constant so it cannot
      // flood the way the old unconditional trace did.
      if (!seenGroups.size) this.traceBelowThreshold(detections, minScore, now);
      return;
    }

    // Traced only for admitted detections. Tracing every one filled the 200-line diagnostics
    // buffer with a fraction of a second of a single camera, which is precisely when the
    // buffer is needed to show what the other cameras were doing.
    this.trace(`detection: ${JSON.stringify(
      admittedGroups.map(d => ({ c: d.className, s: d.score })))}`);

    // After the throttle, never before: this is a round trip to Scrypted plus a JPEG decode,
    // and it is worth paying only for an event that is actually going to reach a Flow.
    // Scrypted only retains a frame when the detector flagged the session for retention.
    if (detected.detectionId && typeof device.getDetectionInput === 'function') {
      const frame = await this.fetchDetectionFrame(device, detected.detectionId);
      // The fetch is long enough for the device to be deleted underneath it. Keeping the
      // frame then would pin megabytes to a device that is gone.
      if (this.resources.isReleased) return;
      this.lastDetectionFrame = frame;
    }

    for (const admitted of admittedGroups) {
      await this.triggerObjectDetected(
        admitted.group, admitted.className, admitted.label, admitted.score);
    }
  }

  /**
   * Records why an event reached no Flow, at most once per `BELOW_THRESHOLD_TRACE_MS`.
   *
   * Kept off `DetectionThrottle` so a diagnostic line cannot occupy a slot in the map that
   * decides what actually fires, and paced by its own constant rather than by the trigger
   * cooldown. Borrowing that setting made the limit vanish at its documented opt-out: a
   * cooldown of zero left this writing a line per event — a `JSON.stringify`, a timestamp
   * and a Homey log write, hundreds of times a second — in the one configuration where no
   * Flow fires at all. That is the per-event cost this whole change exists to remove, and
   * a diagnostic cadence has no reason to be wired to a trigger setting in the first place.
   */
  private traceBelowThreshold(
    detections: ObjectsDetected['detections'],
    minScore: number,
    now: number,
  ): void {
    const elapsed = now - this.lastBelowThresholdTrace;
    // A rewound clock falls through and traces, matching how `admit` treats one.
    if (elapsed >= 0 && elapsed < BELOW_THRESHOLD_TRACE_MS) return;
    this.lastBelowThresholdTrace = now;

    this.trace(`no trigger, min score ${minScore}: ${JSON.stringify(
      (detections ?? []).map(d => ({ c: d.className, s: d.score })))}`);
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
    if (!this.hasCapability(capability) || this.resources.isReleased) return;

    // Scrypted's detector is a frame-rate sampler, not a change feed: it re-reports the
    // same person every frame for as long as they stand there. Writing an alarm that is
    // already true costs a Homey round trip each time, which is why the generic binding
    // path guards the same way. The countdown below still restarts on every detection.
    if (this.getCapabilityValue(capability) !== true) {
      await this.setCapabilityValue(capability, true).catch(() => undefined);
    }

    const existing = this.resetTimers.get(capability);
    if (existing) this.homey.clearTimeout(existing);

    // Re-checked after the await above: teardown may have swept the map since, and a timer
    // armed now would have nothing left to cancel it.
    if (this.resources.isReleased) return;

    const seconds = Math.max(1, this.settings.detection_reset_seconds);
    const timer = this.homey.setTimeout(() => {
      this.resetTimers.delete(capability);
      this.setCapabilityValue(capability, false).catch(() => undefined);
      // The frame is deliberately kept. A Flow image token is a reference Homey resolves
      // when the consumer fetches it — a phone opening a notification, which is routinely
      // later than this timer. Dropping it here would turn a stale picture into a broken
      // one; it is bounded at one frame per camera and released with the device.
    }, seconds * 1000);

    this.resetTimers.set(capability, timer);
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
    if (!this.lastDetectionFrame || this.resources.isReleased) return null;

    if (!this.detectionImage) {
      const image = await this.homey.images.createImage();
      image.setStream(async (stream: NodeJS.WritableStream) => {
        const frame = this.lastDetectionFrame;
        if (!frame) throw new Error('No detection frame available.');
        stream.end(frame);
      });

      // Same race as the snapshot.
      if (!await this.resources.add('the detection image', async () => {
        this.detectionImage = null;
        await image.unregister();
      })) return null;

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
