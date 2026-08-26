import type { VideoClip, VideoClipOptions } from '@scrypted/types';
import { detectionGroupFor } from './capabilityMap.mjs';

/** How far back to look when asking for recent events, when nothing else is specified. */
export const DEFAULT_CLIP_LOOKBACK_MS = 6 * 60 * 60_000;

/** The class Scrypted uses for plain movement, as opposed to a recognised object. */
const MOTION_CLASS = 'motion';

/**
 * The longest a clip is treated as still running. See `hasRecentDetection`.
 *
 * Measured clips here are about thirty seconds. The cap exists for a recorder that indexes
 * continuous recording as long segments carrying detection classes, where an open-ended
 * segment would satisfy every window for ever and pin a condition to `true`.
 */
const MAX_CLIP_DURATION_MS = 60 * 60_000;

/**
 * Asking Scrypted for clips is a query, not a subscription, so every caller has to choose a
 * window.
 *
 * The window is what actually bounds the answer. `count` is passed as well, but measured
 * against this NVR it is not honoured: a query asking for 50 came back with 89. Treat it as
 * a hint that some other `VideoClips` provider may respect, and never as the reason the
 * response is a safe size — that reason is `startTime`.
 *
 * Because `count` is not enforced here, it also cannot truncate the answer from the wrong
 * end, which would otherwise matter: this NVR replies oldest-first, so a provider that did
 * enforce it could hand back the 50 oldest events and hide every recent one.
 */
export function clipQuery(
  now: number,
  lookbackMs: number = DEFAULT_CLIP_LOOKBACK_MS,
  count = 50,
): VideoClipOptions {
  // Clamped rather than trusted: the window comes from a Flow argument or a device setting,
  // and a negative or non-finite one would ask for a range ending before it starts.
  const span = Number.isFinite(lookbackMs) && lookbackMs > 0 ? lookbackMs : DEFAULT_CLIP_LOOKBACK_MS;

  return { startTime: now - span, endTime: now, count };
}

/**
 * Whether this clip records a recognised object rather than bare movement.
 *
 * The distinction is not cosmetic, it decides what can be fetched at all. Measured against a
 * live Scrypted NVR across four cameras and fourteen clips, without a single exception:
 * clips carrying an object class return a thumbnail (19–91 KB of JPEG), while clips whose
 * only class is `motion` fail with "empty set during getRecordingForTime". Video fails for
 * both, which is why this module offers no way to ask for one.
 *
 * Tested on the class rather than on the shape of the id. The NVR happens to give object
 * clips a serialised JSON id and motion clips a bare timestamp, but that is an
 * implementation detail of one plugin version; the class is what the distinction means.
 */
export function isObjectClip(clip: VideoClip | undefined): boolean {
  return (clip?.detectionClasses ?? []).some(
    className => String(className).toLowerCase() !== MOTION_CLASS);
}

/**
 * The id to pass to `getVideoClipThumbnail`.
 *
 * `VideoClip` carries both `id` and `thumbnailId` and they are not always equal, so the
 * specific one wins. A clip with neither is skipped rather than returned: there is nothing
 * to fetch, and offering it would produce a tile that fails to open instead of one that is
 * honestly absent.
 */
export function thumbnailIdOf(clip: VideoClip | undefined): string | undefined {
  const id = clip?.thumbnailId ?? clip?.id;
  return typeof id === 'string' && id.length ? id : undefined;
}

/**
 * Picks the clip the event image should show: the most recent one with a fetchable thumbnail.
 *
 * Scrypted promises no ordering — this NVR answers oldest-first, other `VideoClips`
 * providers answer newest-first — so the newest is chosen explicitly rather than by taking
 * an end of the array.
 */
export function selectLatestObjectClip(
  clips: readonly VideoClip[] | undefined,
): VideoClip | undefined {
  let latest: VideoClip | undefined;

  for (const clip of clips ?? []) {
    if (!isObjectClip(clip)) continue;
    if (!thumbnailIdOf(clip)) continue;
    if (!Number.isFinite(clip.startTime)) continue;
    if (!latest || clip.startTime > latest.startTime) latest = clip;
  }

  return latest;
}

/**
 * Whether any clip in the set matches a detection group within the window.
 *
 * Groups, not raw classes, so a condition asking about "vehicle" is satisfied by a recorded
 * `truck` — the same collapse the Flow trigger applies, via the same table.
 *
 * Measured from when the recording *ended*, not when it began. These clips run about 30
 * seconds and can run longer, so a condition asking about the last minute would otherwise
 * miss someone who is still standing in front of the camera: a clip that started 70 seconds
 * ago and lasts 90 covers this very moment. The window the user set means "was it there",
 * not "did it arrive". A reported duration is capped at `MAX_CLIP_DURATION_MS` so that
 * "still running" cannot become "always".
 *
 * A clip stamped in the future is ignored rather than counted: a camera whose clock runs
 * ahead would otherwise satisfy every window forever.
 */
export function hasRecentDetection(
  clips: readonly VideoClip[] | undefined,
  group: string,
  now: number,
  windowMs: number,
): boolean {
  if (!(Number.isFinite(windowMs) && windowMs > 0)) return false;

  return (clips ?? []).some(clip => {
    if (!Number.isFinite(clip.startTime)) return false;
    if (clip.startTime > now) return false;

    // Capped before it is used. A recorder that indexes continuous recording as long
    // segments would otherwise answer `true` for ever: a segment whose nominal end is in
    // the future satisfies every window, whatever is actually in front of the camera. These
    // clips run about thirty seconds, so an hour is far outside anything real here and
    // costs nothing. `Math.max(0, ·)` is the guard that matters — a negative duration would
    // push the end *before* the start and hide a detection that did happen.
    const reported = Number.isFinite(clip.duration) ? clip.duration as number : 0;
    const duration = Math.min(MAX_CLIP_DURATION_MS, Math.max(0, reported));

    // `Math.min(now, ·)` is inert for the comparison below, and deliberately kept anyway:
    // both branches already agree. A nominal end in the future gives `now - now = 0`, and
    // without the clamp it gives a negative number — and neither is greater than a window
    // the guard above has already established is positive. It stays so that `endedAt` is a
    // date that means something if anything else ever reads it, not because it guards this.
    const endedAt = Math.min(now, clip.startTime + duration);
    if (now - endedAt > windowMs) return false;

    return (clip.detectionClasses ?? []).some(className => {
      const normalised = String(className).toLowerCase();
      if (normalised === MOTION_CLASS) return group === MOTION_CLASS;
      return group === 'any' || detectionGroupFor(normalised) === group;
    });
  });
}
