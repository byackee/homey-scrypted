/**
 * Reading numbers out of Homey device settings.
 *
 * `getSettings()` returns whatever is stored, and what is stored is not always what the
 * manifest describes: a value written by an older version of an app, restored from a backup,
 * or set through the API rather than the settings page can be a string, null, or absent.
 * `Number()` turns all of those into `NaN` without complaining, and `NaN` then propagates
 * through arithmetic and comparisons silently — every comparison against it is false, which
 * is how a bad setting turns into behaviour nobody asked for rather than into an error.
 *
 * Kept here rather than inside the driver so it can be tested. The camera device extends
 * `Homey.Device`, which does not exist off-device, so anything left in that file is beyond
 * the reach of the suite.
 */

/**
 * The stored value as a real number, or the fallback.
 *
 * Anything that does not coerce to a finite number is the fallback: `NaN`, the infinities,
 * `null`, `undefined`, an object, an empty string. Note that `Number('')` is `0` and
 * `Number(null)` is `0` — both finite, both accepted — so a caller that needs a positive
 * value must still say so. This function answers "is it a number", not "is it sensible".
 */
export function finiteOr(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * The stored value as a number within bounds, or the fallback.
 *
 * Homey enforces `min` and `max` in its settings page, but not on a value that arrived by
 * another route, and a duration or a score outside its range fails in ways that look like
 * a bug in the feature rather than a bad setting. Out of range falls back rather than
 * clamping: a stored `-5` for a countdown is a mistake, and honouring it as `1` would hide
 * that while pretending to obey.
 */
export function finiteInRangeOr(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = finiteOr(value, fallback);
  return parsed >= min && parsed <= max ? parsed : fallback;
}
