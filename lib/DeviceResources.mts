type Logger = (message: string) => void;

interface Entry {
  label: string;
  release: () => Promise<void> | void;
}

/**
 * Holds what a device registered with Homey, so it can all be handed back at once.
 *
 * These registrations belong to app-scoped managers — an image, a video, a timer created
 * with `homey.setTimeout`. None of them is tied to the device's own lifetime, so a deleted
 * device leaves them running and holding memory unless it gives them back explicitly.
 *
 * The release is one-way, and that is the point. Once it has run, anything handed to `add`
 * afterwards is released immediately instead of stored, so a registration that was still in
 * flight when the device went away cannot re-attach behind the teardown. Without that,
 * every call site would have to re-check a flag after each `await` — and the one that
 * forgot would leak silently, which is how this class came to exist.
 */
export class DeviceResources {

  private readonly entries: Entry[] = [];
  private released = false;

  constructor(private readonly logError: Logger = () => undefined) {}

  /**
   * True from the moment `releaseAll` *starts*, not when it finishes — call sites branch on
   * this across an await, so the stricter reading is the one that keeps them honest.
   */
  get isReleased(): boolean {
    return this.released;
  }

  /** How many registrations are currently held. Exposed for tests and diagnostics. */
  get size(): number {
    return this.entries.length;
  }

  /**
   * Takes ownership of one registration.
   *
   * Returns `false` when the device is already gone, having released the resource rather
   * than kept it — the caller should then drop whatever it was about to store.
   */
  async add(label: string, release: () => Promise<void> | void): Promise<boolean> {
    if (this.released) {
      await this.runOne({ label, release });
      return false;
    }
    this.entries.push({ label, release });
    return true;
  }

  /**
   * Releases everything, in reverse order of registration.
   *
   * One failing release must not strand the rest, so each is isolated; and the entry is
   * dropped whether or not it succeeded, because a release that threw will not start
   * working on a second attempt.
   */
  async releaseAll(): Promise<void> {
    // Set before the first await, not after the drain: that is what makes "nothing can be
    // stored once the release has begun" true, rather than merely true once it has ended.
    this.released = true;

    while (this.entries.length) {
      await this.runOne(this.entries.pop()!);
    }
  }

  private async runOne(entry: Entry): Promise<void> {
    try {
      await entry.release();
    } catch (err) {
      this.logError(`Releasing ${entry.label} failed: ${(err as Error).message}`);
    }
  }
}
