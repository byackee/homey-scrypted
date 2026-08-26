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

  it('bounds the count by default, because one camera already holds 89 events', () => {
    assert.ok((clipQuery(10_000).count ?? Infinity) <= 50);
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
