/**
 * Decides which detection groups may fire a Flow trigger right now.
 *
 * Scrypted's object detector is a frame-rate sampler, not a change feed: a cat sitting in
 * view is re-reported on every analysed frame for as long as it stays there. Measured on a
 * live server, one camera produced bursts of 39 consecutive `ObjectDetector` events with
 * 120 of 199 intervals under 50 ms, peaking at 500 events per second.
 *
 * Handling each of those in full is what makes that expensive: every event fetched the
 * detection frame from Scrypted over RPC and decoded it to a JPEG buffer, then fired a
 * device Flow trigger carrying an image token. Neither cost is one Homey can absorb
 * hundreds of times a second, and the app it runs in is the one that pays.
 *
 * The alarm capabilities deliberately do not go through here. Writing one that is already
 * true is guarded upstream, and its auto-clear countdown *should* restart on every frame —
 * that is what keeps the alarm continuously true while activity lasts. Only the two
 * genuinely expensive effects are rate-limited.
 *
 * The limit is leading-edge: the first detection of a burst fires immediately, and further
 * ones are dropped until the cooldown expires. Latency is what a detection trigger is for,
 * so the delay must never be paid by the event that matters.
 */
export class DetectionThrottle {

  /** Monotonic timestamp of the last admitted trigger, per detection group. */
  private readonly lastAdmitted = new Map<string, number>();

  /**
   * Admits one detection group, or refuses it as too soon after the last.
   *
   * Stamps the clock only when it admits, so a refused burst does not push the next
   * eligible moment further out with every frame it drops — which would starve a group
   * that keeps detecting for as long as it keeps detecting.
   *
   * A cooldown of zero disables the limit, which is how a user who wants every raw event
   * turns it off. `now` is injected rather than read here so the behaviour is testable
   * without waiting in real time.
   */
  admit(group: string, cooldownMs: number, now: number): boolean {
    if (cooldownMs <= 0) return true;

    const last = this.lastAdmitted.get(group);
    if (last !== undefined && now - last < cooldownMs) return false;

    this.lastAdmitted.set(group, now);
    return true;
  }

  /**
   * Forgets every group, so the next detection of each fires immediately.
   *
   * Used when the device loses and regains its Scrypted binding: the first detection after
   * a reconnect is news, whatever the clock says about one that arrived before the gap.
   */
  clear(): void {
    this.lastAdmitted.clear();
  }

  /** How many groups are currently holding a stamp. Exposed for tests and diagnostics. */
  get size(): number {
    return this.lastAdmitted.size;
  }
}
