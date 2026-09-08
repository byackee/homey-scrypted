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
 *
 * This has to stay a class, and that is not a stylistic preference. `@scrypted/client`
 * decides between copying an argument and proxying it by its constructor name, and the
 * copy list is `Number, String, Object, Boolean, Array` — `getDefaultTransportSafeArgumentTypes`
 * in `rpc.js`. An object literal has the constructor name `Object`, so it would be
 * serialised by value: Scrypted would receive plain data with none of these methods, and
 * the handshake would never begin. A named class falls through to the proxy path instead.
 * Rewriting this as a plain object is the one refactor that silently destroys it.
 */
export class HomeyOfferSession implements Omit<RTCSignalingSession, 'createLocalDescription' | 'setRemoteDescription' | 'addIceCandidate'> {

  readonly options: RTCSignalingOptions;

  /**
   * How `options` reaches the far side at all.
   *
   * Scrypted reads this session across an RPC boundary, and its proxy resolves a property
   * read from the proxy properties first: `if (this.proxyProps?.[p] !== undefined) return
   * this.proxyProps?.[p]` — `@scrypted/client`'s `rpc.js`, in `RpcProxy.get`. A property
   * not listed there falls through to `return new Proxy(() => p, this)`, so `session.options`
   * would be a *function proxy* rather than this object, and `options.disableTrickle` a
   * truthy proxy rather than `true`. The bridge would appear to negotiate and then behave as
   * though trickle were never disabled, which is the hardest possible way to find this out.
   */
  readonly __proxy_props: { options: RTCSignalingOptions };

  /**
   * Every call Scrypted made into this session, in order.
   *
   * The handshake happens inside an RPC proxy: what the far side asked for, and what it
   * called what it sent back, are invisible from either end afterwards. When the player
   * refuses the result — with one sentence and no description — this is the only record of
   * which side believed it was offering. It holds no descriptions, only their types and the
   * directions asked for.
   */
  readonly exchange: string[] = [];

  private settle: ((sdp: string) => void) | undefined;
  private fail: ((err: Error) => void) | undefined;
  private readonly answer: Promise<string>;
  private settled = false;
  /** Candidates that arrived anyway, kept only so the count can be reported. */
  private strayCandidates = 0;

  constructor(private readonly offerSdp: string) {
    this.options = {
      offer: { type: 'offer', sdp: offerSdp },
      // These two decide which side offers, and they do not mean what they appear to.
      // Scrypted picks the role in `startRTCSignalingSession` with
      //
      //     options?.requiresAnswer === true ? false : true
      //
      // as the `clientOffer` argument. `requiresAnswer: true` therefore does not say "send
      // me an answer" — it says *this* session is the one that will answer. Declared that
      // way, Scrypted made its own camera the offerer: what came back carried `setup:actpass`,
      // payload types the offer never mentioned, an H265 codec nobody asked for and the
      // camera's own media order. That is an offer, and this bridge handed it to Homey as an
      // answer, where the player refused it — with a message about m-line order, which is
      // true and is not the reason.
      //
      // Homey's player is always the offerer; the API gives an offer and takes an answer,
      // with no other shape available. So this session must be the offerer, and both flags
      // say so.
      requiresOffer: true,
      requiresAnswer: false,
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
    setup: RTCAVSignalingSetup,
    _sendIceCandidate: unknown,
  ): Promise<SessionDescription> {
    this.record(`createLocalDescription(${type})`, setup);

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
    setup: RTCAVSignalingSetup,
  ): Promise<void> {
    // The type is recorded rather than enforced. A far side that sends an offer here has
    // not answered anything, and no amount of repair to the description will make it an
    // answer — but refusing it outright would replace a picture that sometimes works with
    // one that never does, so this reports and carries on.
    this.record(`setRemoteDescription(${String(description?.type ?? 'no type')})`, setup);

    const sdp = description?.sdp;
    if (typeof sdp !== 'string' || !sdp.length) {
      this.reject(new Error('Scrypted returned an empty session description.'));
      return;
    }

    // An offer arriving here is not an answer with a fault in it — it is the far side
    // negotiating in the opposite direction, and nothing that can be done to the text will
    // make it answer the question Homey asked. Forwarding it anyway is what produced a black
    // tile and a message about m-line ordering that sent the search in the wrong direction
    // for an afternoon. Refused by name instead.
    if (description.type === 'offer') {
      this.reject(new Error(
        'Scrypted offered its own session instead of answering Homey\'s. '
        + 'The camera cannot be viewed over WebRTC; switch its Live stream transport to RTSP.'));
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

  /** One line of the exchange: what was called, and the setup it was called with. */
  private record(call: string, setup: RTCAVSignalingSetup | undefined): void {
    const shape = setup as { type?: string; audio?: { direction?: string }; video?: { direction?: string } };
    const details = [
      shape?.type ? `setup.type=${shape.type}` : undefined,
      shape?.audio?.direction ? `audio=${shape.audio.direction}` : undefined,
      shape?.video?.direction ? `video=${shape.video.direction}` : undefined,
    ].filter(Boolean);

    this.exchange.push(details.length ? `${call} ${details.join(' ')}` : call);
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
