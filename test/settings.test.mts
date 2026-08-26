import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { finiteInRangeOr, finiteOr } from '../lib/settings.mjs';

describe('finiteOr', () => {

  it('keeps a real number', () => {
    assert.equal(finiteOr(30, 99), 30);
    assert.equal(finiteOr(0, 99), 0, 'zero is a number');
    assert.equal(finiteOr(-5, 99), -5, 'it answers "is it a number", not "is it sensible"');
  });

  it('parses a stored string, which is how settings come back from some writes', () => {
    assert.equal(finiteOr('30', 99), 30);
    assert.equal(finiteOr('0.5', 99), 0.5);
  });

  it('falls back on everything that is not a finite number', () => {
    // NaN is the one that matters: every comparison against it is false, so it does not
    // throw, it just makes the surrounding logic quietly stop meaning anything.
    for (const bad of [
      Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY,
      undefined, 'abc', {}, [1, 2], () => 1,
    ]) {
      assert.equal(finiteOr(bad, 99), 99, `${String(bad)}`);
    }
  });

  it('accepts the values JavaScript coerces to zero, and says so', () => {
    // Documented rather than defended against: `Number('')` and `Number(null)` are 0, which
    // is finite. A caller that needs a positive value has to say so — which is what
    // `finiteInRangeOr` is for.
    assert.equal(finiteOr('', 99), 0);
    assert.equal(finiteOr(null, 99), 0);
  });
});

describe('finiteInRangeOr', () => {

  it('keeps a value inside the range, bounds included', () => {
    assert.equal(finiteInRangeOr(30, 99, 1, 3600), 30);
    assert.equal(finiteInRangeOr(1, 99, 1, 3600), 1, 'the minimum is in range');
    assert.equal(finiteInRangeOr(3600, 99, 1, 3600), 3600, 'so is the maximum');
  });

  it('falls back rather than clamping, so a wrong setting does not pretend to be obeyed', () => {
    assert.equal(finiteInRangeOr(-5, 30, 1, 3600), 30);
    assert.equal(finiteInRangeOr(99_999, 30, 1, 3600), 30);
  });

  it('rescues the reset delay that would otherwise fire in one millisecond', () => {
    // The failure this exists for. `Math.max(1, NaN)` is `NaN`, and Node treats a `NaN`
    // timeout as 1 ms — so a stored value that did not parse used to raise a detection
    // alarm and clear it in the same instant, every time, with nothing in the log.
    assert.equal(finiteInRangeOr('abc', 30, 1, 3600), 30);
    assert.equal(finiteInRangeOr(Number.NaN, 30, 1, 3600), 30);
    assert.equal(finiteInRangeOr(0, 30, 1, 3600), 30, 'zero seconds is out of range too');
  });

  it('rescues a score that could never be reached', () => {
    // A minimum score above 1 silences the camera entirely: no detection ever scores that
    // high, and nothing says why the Flow stopped firing.
    assert.equal(finiteInRangeOr(5, 0.5, 0, 1), 0.5);
    assert.equal(finiteInRangeOr(-1, 0.5, 0, 1), 0.5);
    assert.equal(finiteInRangeOr(0, 0.5, 0, 1), 0, 'but zero is a legitimate score threshold');
    assert.equal(finiteInRangeOr(1, 0.5, 0, 1), 1);
  });

  it('lets a cooldown of zero through, which is its documented opt-out', () => {
    assert.equal(finiteInRangeOr(0, 10, 0, 3600), 0);
  });
});
