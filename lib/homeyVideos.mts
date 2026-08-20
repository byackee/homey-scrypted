import type Homey from 'homey';

/**
 * Typings for Homey's Videos API.
 *
 * The published `homey-apps-sdk-v3-types` package (0.3.12) predates `ManagerVideos`, so
 * the API exists on the runtime but not in the type definitions. Rather than sprinkling
 * `any` casts through the camera driver, the whole untyped surface is declared once here,
 * mirroring https://apps-sdk-v3.developer.homey.app/ManagerVideos.html. When the SDK types
 * catch up, this file can be deleted and the imports pointed at `homey` directly.
 */

export interface VideoOptions {
  /** Let the frontend play a stream served with a self-signed certificate. */
  acceptInvalidCertificates?: boolean;
  /** Force a demuxer for raw streams. Homey picks one automatically when omitted. */
  demuxer?: 'h264' | 'h265' | 'mpegts' | 'ts';
  /**
   * Homey proxies videos over WebRTC by default, which is what makes a LAN-only RTSP
   * stream viewable from the web app and from outside the network. Disabling the proxy
   * restricts playback to the local network.
   */
  disableWebRTCProxy?: boolean;
}

export interface VideoBase {
  unregister(): Promise<void>;
}

export interface VideoWithURL extends VideoBase {
  registerVideoUrlListener(listener: () => Promise<{ url: string }> | { url: string }): VideoWithURL;
}

export interface VideoWebRTC extends VideoBase {
  registerOfferListener(
    listener: (offerSdp: string) => Promise<{ answerSdp: string; streamId?: string }>,
  ): VideoWebRTC;
  registerKeepAliveListener(listener: (streamId: string) => Promise<void>): VideoWebRTC;
}

export interface ManagerVideos {
  createVideoRTSP(options?: VideoOptions): Promise<VideoWithURL>;
  createVideoHLS(options?: VideoOptions): Promise<VideoWithURL>;
  createVideoDASH(options?: VideoOptions): Promise<VideoWithURL>;
  createVideoRTMP(options?: VideoOptions): Promise<VideoWithURL>;
  createVideoOther(options?: VideoOptions): Promise<VideoWithURL>;
  createVideoWebRTC(options?: VideoOptions): Promise<VideoWebRTC>;
}

/**
 * The `Homey` instance type, reached through `Device#homey` because the `homey` module
 * does not export the class itself.
 */
type HomeyInstance = Homey.Device['homey'];

/** Returns the Videos manager, or undefined on a Homey too old to provide one. */
export function videosOf(homey: HomeyInstance): ManagerVideos | undefined {
  return (homey as unknown as { videos?: ManagerVideos }).videos;
}

/** `Device#setCameraVideo`, which is likewise absent from the published typings. */
export async function setCameraVideo(
  device: Homey.Device,
  id: string,
  title: string,
  video: VideoBase,
): Promise<void> {
  const setter = (device as unknown as {
    setCameraVideo?: (id: string, title: string, video: VideoBase) => Promise<unknown>;
  }).setCameraVideo;

  if (typeof setter !== 'function') {
    throw new Error('This Homey does not support video streams (requires Homey Pro v12.7.0 or newer).');
  }

  await setter.call(device, id, title, video);
}
