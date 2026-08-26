import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { DetectionThrottle } from '../lib/detectionThrottle.mjs';

/**
 * The numbers these tests use are the ones measured on a live server: bursts of 39
 * consecutive detections, 120 of 199 intervals under 50 ms, peaking at 500 events per
 * second. Each of those used to fetch a JPEG over RPC and fire a Flow trigger.
 */
const BURST_LENGTH = 39;

describe('DetectionThrottle', () => {

  it('admits the first detection of a burst immediately', () => {
    const throttle = new DetectionThrottle();
    assert.equal(throttle.admit('person', 10_000, 1_000), true);
  });

  it('collapses a 500-per-second burst to one admission', () => {
    const throttle = new DetectionThrottle();
    let admitted = 0;

    // 39 events 2 ms apart, which is the shape that took the app down.
    for (let i = 0; i < BURST_LENGTH; i += 1) {
      if (throttle.admit('animal', 10_000, 1_000 + i * 2)) admitted += 1;
    }

    assert.equal(admitted, 1, 'a burst must cost exactly one frame fetch and one trigger');
  });

  it('admits again once the cooldown has elapsed', () => {
    const throttle = new DetectionThrottle();

    assert.equal(throttle.admit('person', 10_000, 0), true);
    assert.equal(throttle.admit('person', 10_000, 9_999), false, 'one millisecond early');
    assert.equal(throttle.admit('person', 10_000, 10_000), true, 'exactly on the boundary');
  });

  it('does not let a refused burst push the next admission further out', () => {
    const throttle = new DetectionThrottle();
    throttle.admit('person', 10_000, 0);

    // Refusals all the way to the boundary. If a refusal stamped the clock, the group would
    // be starved for as long as it kept detecting — which is exactly while it matters most.
    for (let now = 100; now < 10_000; now += 100) {
      assert.equal(throttle.admit('person', 10_000, now), false);
    }

    assert.equal(throttle.admit('person', 10_000, 10_000), true);
  });

  it('throttles each group independently', () => {
    const throttle = new DetectionThrottle();

    assert.equal(throttle.admit('person', 10_000, 0), true);
    assert.equal(throttle.admit('vehicle', 10_000, 0), true, 'a car is not held back by a person');
    assert.equal(throttle.admit('person', 10_000, 1), false);
    assert.equal(throttle.admit('animal', 10_000, 1), true);
    assert.equal(throttle.size, 3);
  });

  it('admits everything when the cooldown is zero', () => {
    const throttle = new DetectionThrottle();

    for (let i = 0; i < BURST_LENGTH; i += 1) {
      assert.equal(throttle.admit('person', 0, 1_000), true, 'zero means the user opted out');
    }
    assert.equal(throttle.size, 0, 'an opted-out throttle holds no state to leak');
  });

  it('treats a negative cooldown as disabled rather than as a time machine', () => {
    const throttle = new DetectionThrottle();
    assert.equal(throttle.admit('person', -1, 0), true);
    assert.equal(throttle.admit('person', -1, 0), true);
  });

  it('forgets its stamps on clear, so the first detection after a reconnect fires', () => {
    const throttle = new DetectionThrottle();

    assert.equal(throttle.admit('person', 10_000, 0), true);
    assert.equal(throttle.admit('person', 10_000, 500), false);

    throttle.clear();

    assert.equal(throttle.size, 0);
    assert.equal(throttle.admit('person', 10_000, 500), true);
  });
});

/**
 * `handleDetection` lives on a `Homey.Device` subclass, which does not exist off-device —
 * the `homey` package ships the CLI, not the runtime — so the ordering inside it cannot be
 * exercised. Asserting it against the source is the only check available, and the ordering
 * is the whole point of the fix: throttling after the frame fetch would still pay the
 * expensive part of every event in a 500-per-second burst.
 */
describe('the detection frame is fetched only for an admitted detection', () => {
  // .testbuild/test/<file>.test.mjs → up two levels to the app root.
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

  function handleDetectionBody(): string {
    const text = readFileSync(join(root, 'drivers', 'camera', 'device.mts'), 'utf8');
    const start = text.indexOf('private async handleDetection(');
    assert.notEqual(start, -1, 'handleDetection was renamed; this guard needs updating');

    const rest = text.slice(start);
    const end = rest.indexOf('\n  private ', 1);
    assert.notEqual(end, -1, 'could not find the end of handleDetection');
    return rest.slice(0, end);
  }

  it('calls throttle.admit before fetchDetectionFrame', () => {
    const body = handleDetectionBody();
    const admit = body.indexOf('this.throttle.admit(');
    const fetch = body.indexOf('this.fetchDetectionFrame(');

    assert.notEqual(admit, -1, 'handleDetection no longer consults the throttle');
    assert.notEqual(fetch, -1, 'handleDetection no longer fetches a detection frame');
    assert.ok(
      admit < fetch,
      'the throttle must gate the frame fetch, or every event still pays for a JPEG over RPC',
    );
  });

  it('calls throttle.admit before triggerObjectDetected', () => {
    const body = handleDetectionBody();
    const admit = body.indexOf('this.throttle.admit(');
    const trigger = body.indexOf('this.triggerObjectDetected(');

    assert.notEqual(trigger, -1, 'handleDetection no longer fires the Flow trigger');
    assert.ok(admit < trigger, 'the throttle must gate the Flow trigger');
  });

  it('still raises the alarm capability on every event', () => {
    // The alarms are deliberately outside the throttle: their auto-clear countdown has to
    // restart on each frame, which is what keeps the alarm true while activity lasts.
    const body = handleDetectionBody();
    const alarm = body.indexOf('this.raiseDetectionAlarm(');
    const admit = body.indexOf('this.throttle.admit(');

    assert.notEqual(alarm, -1, 'handleDetection no longer raises detection alarms');
    assert.ok(alarm < admit, 'the alarm must be raised before the throttle can skip the rest');
  });
});
