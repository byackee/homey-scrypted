import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { VideoClip } from '@scrypted/types';
import {
  clipQuery,
  DEFAULT_CLIP_LOOKBACK_MS,
  hasRecentDetection,
  isObjectClip,
  selectLatestObjectClip,
  thumbnailIdOf,
} from '../lib/videoClips.mjs';

/**
 * The fixtures mirror what a live Scrypted NVR actually returned, including the two id
 * shapes it uses: a bare timestamp for a motion event, and a serialised JSON blob for an
 * object event. Nothing here depends on that shape — that is the point of the tests below —
 * but reproducing it keeps the fixtures honest.
 */
const MOTION_ID = '1787732488967';
const OBJECT_ID = '{"startTime":1787732694184,"duration":30045,"options":{"detectionId":"15f9-115"}}';

function clip(over: Partial<VideoClip> = {}): VideoClip {
  return {
    id: MOTION_ID,
    startTime: 1_787_732_488_967,
    duration: 30_049,
    detectionClasses: ['motion'],
    ...over,
  } as VideoClip;
}

describe('isObjectClip', () => {

  it('recognises an event that carries an object class', () => {
    assert.equal(isObjectClip(clip({ detectionClasses: ['person'] })), true);
    assert.equal(isObjectClip(clip({ detectionClasses: ['animal'] })), true);
  });

  it('rejects an event whose only class is motion', () => {
    // These are the ones whose thumbnail fails with "empty set during getRecordingForTime",
    // measured across four cameras without exception.
    assert.equal(isObjectClip(clip({ detectionClasses: ['motion'] })), false);
    assert.equal(isObjectClip(clip({ detectionClasses: ['MOTION'] })), false, 'case is not meaning');
  });

  it('accepts a mixed event, which still has something recognised in it', () => {
    assert.equal(isObjectClip(clip({ detectionClasses: ['motion', 'person'] })), true);
  });

  it('rejects an event with no classes at all, rather than assuming', () => {
    assert.equal(isObjectClip(clip({ detectionClasses: [] })), false);
    assert.equal(isObjectClip(clip({ detectionClasses: undefined })), false);
    assert.equal(isObjectClip(undefined), false);
  });
});

describe('thumbnailIdOf', () => {

  it('prefers thumbnailId over id', () => {
    assert.equal(thumbnailIdOf(clip({ id: 'a', thumbnailId: 'b' })), 'b');
  });

  it('falls back to id when there is no thumbnailId', () => {
    assert.equal(thumbnailIdOf(clip({ id: 'a', thumbnailId: undefined })), 'a');
  });

  it('returns nothing rather than an unusable id', () => {
    assert.equal(thumbnailIdOf(clip({ id: '', thumbnailId: '' })), undefined);
    assert.equal(thumbnailIdOf(undefined), undefined);
  });

  it('passes a serialised JSON id through untouched', () => {
    // The NVR round-trips this blob; parsing or normalising it would break the fetch.
    assert.equal(thumbnailIdOf(clip({ thumbnailId: OBJECT_ID })), OBJECT_ID);
  });
});

describe('selectLatestObjectClip', () => {

  it('picks the newest object event, whatever order the recorder answered in', () => {
    const clips = [
      clip({ id: 'old', startTime: 1_000, detectionClasses: ['person'] }),
      clip({ id: 'new', startTime: 3_000, detectionClasses: ['person'] }),
      clip({ id: 'mid', startTime: 2_000, detectionClasses: ['person'] }),
    ];

    assert.equal(selectLatestObjectClip(clips)?.id, 'new');
    assert.equal(selectLatestObjectClip([...clips].reverse())?.id, 'new', 'order must not matter');
  });

  it('skips a newer motion event to reach an older object one', () => {
    // The decisive case. The newest event on three of four cameras was motion-only, and
    // pointing the tile at it produces a thumbnail fetch that always fails.
    const clips = [
      clip({ id: 'person', startTime: 1_000, detectionClasses: ['person'] }),
      clip({ id: 'motion', startTime: 9_000, detectionClasses: ['motion'] }),
    ];

    assert.equal(selectLatestObjectClip(clips)?.id, 'person');
  });

  it('returns nothing when the recorder holds only motion', () => {
    assert.equal(selectLatestObjectClip([clip(), clip({ startTime: 5_000 })]), undefined);
  });

  it('skips a newer event that has no usable id to fetch with', () => {
    // Found by mutation: removing the `thumbnailIdOf` filter broke nothing in this suite.
    // Without it the unusable event wins for being newest, `fetchLatestEventThumbnail` has
    // nothing to fetch, and the tile reports "no recent event" while a perfectly good one
    // sat one place behind it.
    const clips = [
      clip({ id: 'good', thumbnailId: 'good', startTime: 1_000, detectionClasses: ['person'] }),
      clip({ id: '', thumbnailId: '', startTime: 9_000, detectionClasses: ['person'] }),
    ];

    assert.equal(selectLatestObjectClip(clips)?.id, 'good');
  });

  it('ignores an event with an unusable timestamp', () => {
    const clips = [
      clip({ id: 'good', startTime: 1_000, detectionClasses: ['person'] }),
      clip({ id: 'bad', startTime: Number.NaN, detectionClasses: ['person'] }),
    ];

    assert.equal(selectLatestObjectClip(clips)?.id, 'good');
  });

  it('handles an empty or missing answer', () => {
    assert.equal(selectLatestObjectClip([]), undefined);
    assert.equal(selectLatestObjectClip(undefined), undefined);
  });
});

describe('clipQuery', () => {

  it('asks for a bounded window ending now', () => {
    const query = clipQuery(10_000, 4_000, 7);
    assert.deepEqual(query, { startTime: 6_000, endTime: 10_000, count: 7 });
  });

  it('passes a count, without relying on it', () => {
    // Measured: this NVR answered a count of 50 with 89 clips. The assertion is that a count
    // is sent at all — some other VideoClips provider may honour it — and deliberately not
    // that it bounds anything, because here it does not. The window is the real bound, and
    // the test below is the one that guards it.
    assert.ok(Number.isFinite(clipQuery(10_000).count));
  });

  it('falls back to the default window rather than asking for a reversed range', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const query = clipQuery(10_000, bad);
      assert.equal(query.startTime, 10_000 - DEFAULT_CLIP_LOOKBACK_MS, `lookback ${bad}`);
      assert.ok((query.startTime ?? 0) < (query.endTime ?? 0), 'the range must run forwards');
    }
  });
});

describe('hasRecentDetection', () => {
  const now = 1_000_000;

  it('matches an event inside the window', () => {
    const clips = [clip({ startTime: now - 60_000, detectionClasses: ['person'] })];
    assert.equal(hasRecentDetection(clips, 'person', now, 120_000), true);
  });

  it('does not match one that fell outside it', () => {
    const clips = [clip({ startTime: now - 180_000, detectionClasses: ['person'] })];
    assert.equal(hasRecentDetection(clips, 'person', now, 120_000), false);
  });

  it('collapses a concrete class onto the group the Flow offers', () => {
    // A recorded truck satisfies a condition asking about vehicles, the same collapse the
    // trigger applies, through the same table.
    const clips = [clip({ startTime: now, detectionClasses: ['truck'] })];
    assert.equal(hasRecentDetection(clips, 'vehicle', now, 60_000), true);
    assert.equal(hasRecentDetection(clips, 'person', now, 60_000), false);
  });

  it('matches anything when the condition asks for any object', () => {
    const clips = [clip({ startTime: now, detectionClasses: ['animal'] })];
    assert.equal(hasRecentDetection(clips, 'any', now, 60_000), true);
  });

  it('does not let a motion event satisfy an object condition', () => {
    const clips = [clip({ startTime: now, detectionClasses: ['motion'] })];
    assert.equal(hasRecentDetection(clips, 'any', now, 60_000), false, 'motion is not an object');
    assert.equal(hasRecentDetection(clips, 'person', now, 60_000), false);
    assert.equal(hasRecentDetection(clips, 'motion', now, 60_000), true, 'unless asked for');
  });

  it('counts a recording that started before the window but is still running', () => {
    // A clip that began 70 s ago and lasts 90 s covers this very moment: the object is
    // still in front of the camera. Measured from the start alone it would fall outside a
    // one-minute window, and the condition would answer false about something present now.
    const clips = [clip({ startTime: now - 70_000, duration: 90_000, detectionClasses: ['person'] })];
    assert.equal(hasRecentDetection(clips, 'person', now, 60_000), true);
  });

  it('still lets a finished recording fall out of the window', () => {
    // The duration must not turn into a licence to match forever.
    const clips = [clip({ startTime: now - 600_000, duration: 30_000, detectionClasses: ['person'] })];
    assert.equal(hasRecentDetection(clips, 'person', now, 60_000), false);
  });

  it('counts a recording whose end has not arrived yet', () => {
    const clips = [clip({ startTime: now - 600_000, duration: 3_600_000, detectionClasses: ['person'] })];
    assert.equal(hasRecentDetection(clips, 'person', now, 60_000), true, 'it is still running');
  });

  it('treats an unusable duration as zero rather than guessing', () => {
    const stale = [clip({ startTime: now - 600_000, duration: Number.NaN, detectionClasses: ['person'] })];
    assert.equal(hasRecentDetection(stale, 'person', now, 60_000), false);
  });

  it('does not let a negative duration hide a detection that did happen', () => {
    // Found by mutation: dropping `Math.max(0, ·)` broke nothing. It changes the answer —
    // a duration of -50 s pushes the end *before* the start, so a clip from 30 s ago reads
    // as 80 s old and falls outside a one-minute window.
    const clips = [clip({ startTime: now - 30_000, duration: -50_000, detectionClasses: ['person'] })];
    assert.equal(hasRecentDetection(clips, 'person', now, 60_000), true);
  });

  it('will not let a runaway duration pin the condition to true for ever', () => {
    // A recorder indexing continuous recording as one long segment would otherwise satisfy
    // every window regardless of what is in front of the camera.
    const clips = [clip({ startTime: now - 86_400_000, duration: 864_000_000, detectionClasses: ['person'] })];
    assert.equal(hasRecentDetection(clips, 'person', now, 60_000), false, 'a day old is not "now"');
  });

  it('ignores an event stamped in the future', () => {
    // A camera whose clock runs ahead would otherwise satisfy every window forever.
    const clips = [clip({ startTime: now + 60_000, detectionClasses: ['person'] })];
    assert.equal(hasRecentDetection(clips, 'person', now, 120_000), false);
  });

  it('refuses a window that is not a usable duration', () => {
    const clips = [clip({ startTime: now, detectionClasses: ['person'] })];
    for (const bad of [0, -1, Number.NaN]) {
      assert.equal(hasRecentDetection(clips, 'person', now, bad), false, `window ${bad}`);
    }
  });

  it('handles an empty or missing answer', () => {
    assert.equal(hasRecentDetection([], 'person', now, 60_000), false);
    assert.equal(hasRecentDetection(undefined, 'person', now, 60_000), false);
  });
});
