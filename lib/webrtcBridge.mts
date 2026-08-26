import type {
  RTCAVSignalingSetup,
  RTCSignalingOptions,
  RTCSignalingSession,
} from '@scrypted/types';

/**
 * The two WebRTC shapes Scrypted's typings use without declaring.
 *
 * `@scrypted/types` refers to `RTCSessionDescriptionInit` and `RTCIceCandidateInit` as
 * ambient DOM types. This app compiles against `lib: ["ES2023"]` with no DOM — a Homey app
 * is Node, not a browser — so they resolve to nothing here, and only `skipLibCheck` keeps
 * that from surfacing as an error inside the package. Declared structurally rather than by
 * pulling in the whole DOM library for two shapes, and kept to the fields this bridge
 * actually reads.
 */
export interface SessionDescription {
  type: 'offer' | 'answer' | 'pranswer' | 'rollback';
  sdp?: string;
}

export interface IceCandidate {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
}

/** How long to wait for Scrypted to answer before giving the player back an error. */
export const ANSWER_TIMEOUT_MS = 20_000;

/**
 * Bridges Homey's one-shot WebRTC handshake onto Scrypted's signalling session.
 *
 * The two sides disagree about shape, and that disagreement is the whole of this class.
 * Homey hands over a complete offer SDP and wants a complete answer SDP back from a single
 * call — no trickle, no candidate channel, no second round. Scrypted instead expects to
 * *drive* a session object, calling into it to collect a description, hand back a remote
 * one, and deliver ICE candidates as they are gathered.
 *
 * So this stands in as that session object and inverts the direction: it answers
 * `createLocalDescription` with the offer Homey already produced, and treats the
 * `setRemoteDescription` call as the delivery of the answer Homey is waiting for.
 *
 * `disableTrickle` is what makes the shapes reconcilable at all. Without it Scrypted would
 * gather candidates after the answer and deliver them through `addIceCandidate`, which has
 * nowhere to go here — Homey has already been given its single answer and will not take
 * more. With it, Scrypted is required to put every candidate in the answer SDP itself.
 */
export class HomeyOfferSession implements Omit<RTCSignalingSession, 'createLocalDescription' | 'setRemoteDescription' | 'addIceCandidate'> {

  readonly options: RTCSignalingOptions;

  /**
   * Scrypted reads `options` across an RPC boundary. `__proxy_props` is how a proxied object
   * exposes plain values without a round-trip per read; without it the property is invisible
   * to the far side and the session is negotiated with no options at all.
   */
  readonly __proxy_props: { options: RTCSignalingOptions };

  private settle: ((sdp: string) => void) | undefined;
  private fail: ((err: Error) => void) | undefined;
  private readonly answer: Promise<string>;
  private settled = false;
  /** Candidates that arrived anyway, kept only so the count can be reported. */
  private strayCandidates = 0;

  constructor(private readonly offerSdp: string) {
    this.options = {
      offer: { type: 'offer', sdp: offerSdp },
      // Homey has already made the offer, so the only thing wanted back is an answer.
      requiresOffer: false,
      requiresAnswer: true,
      // See the class comment: the single point on which this bridge depends.
      disableTrickle: true,
      // Homey's player is not a browser and cannot renegotiate, which is exactly what this
      // hint is for.
      proxy: true,
    };
    this.__proxy_props = { options: this.options };

    this.answer = new Promise<string>((resolve, reject) => {
      this.settle = resolve;
      this.fail = reject;
    });

    // Attached here, not where the answer is awaited. Scrypted can call back into this
    // session — and be refused — before anyone reaches `waitForAnswer`, and a promise that
    // rejects with no handler is fatal to a Homey app. The rejection is still delivered to
    // `waitForAnswer`; this only stops the unobserved window between the two.
    this.answer.catch(() => undefined);
  }

  /** How many ICE candidates arrived despite `disableTrickle`. Non-zero means degraded. */
  get ignoredCandidates(): number {
    return this.strayCandidates;
  }

  /**
   * Scrypted asking this side for its description.
   *
   * Only an offer can be produced: the peer connection lives inside Homey, and this class
   * holds its output, not a means of generating another. Being asked for an answer means the
   * far side decided to be the offerer, which this bridge cannot serve — reported rather
   * than fudged, because a fudged description fails later and further away.
   */
  async createLocalDescription(
    type: 'offer' | 'answer',
    _setup: RTCAVSignalingSetup,
    _sendIceCandidate: unknown,
  ): Promise<SessionDescription> {
    if (type !== 'offer') {
      const err = new Error(
        'Scrypted asked this camera to answer an offer it would make itself, which Homey cannot do.');
      this.reject(err);
      throw err;
    }

    return { type: 'offer', sdp: this.offerSdp };
  }

  /** Scrypted delivering its answer. This is what Homey has been waiting on. */
  async setRemoteDescription(
    description: SessionDescription,
    _setup: RTCAVSignalingSetup,
  ): Promise<void> {
    const sdp = description?.sdp;
    if (typeof sdp !== 'string' || !sdp.length) {
      this.reject(new Error('Scrypted returned an empty session description.'));
      return;
    }
    if (this.settled) return;

    this.settled = true;
    this.settle?.(sdp);
  }

  /**
   * Counted, not applied.
   *
   * `disableTrickle` should stop these arriving. If one does, the answer Homey already holds
   * is missing a candidate, and there is no channel to deliver it — so the honest thing is to
   * let the stream work with what it has and make the shortfall visible, rather than throw
   * and take down a session that may well be fine.
   */
  async addIceCandidate(_candidate: IceCandidate): Promise<void> {
    this.strayCandidates += 1;
  }

  async getOptions(): Promise<RTCSignalingOptions> {
    return this.options;
  }

  /** Resolves with the answer SDP, or rejects once the wait is no longer worth anything. */
  async waitForAnswer(timeoutMs = ANSWER_TIMEOUT_MS): Promise<string> {
    let timer: NodeJS.Timeout | undefined;

    try {
      return await Promise.race([
        this.answer,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Scrypted did not answer within ${Math.round(timeoutMs / 1000)}s.`)),
            timeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Abandons the wait, so a failed `startRTCSignalingSession` does not leave a hanging player. */
  reject(err: Error): void {
    if (this.settled) return;
    this.settled = true;
    this.fail?.(err);
  }
}
