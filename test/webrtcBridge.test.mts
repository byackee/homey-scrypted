import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HomeyOfferSession } from '../lib/webrtcBridge.mjs';

const OFFER = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n';
const ANSWER = 'v=0\r\no=- 3 4 IN IP4 127.0.0.1\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=candidate:1 1 udp 1 10.0.0.1 5000 typ host\r\n';

const SETUP = {} as never;

describe('HomeyOfferSession options', () => {

  it('disables trickle, which is what makes the two APIs reconcilable', () => {
    // Without this Scrypted gathers candidates after the answer and delivers them through
    // addIceCandidate, which has nowhere to go: Homey has taken its single answer already.
    assert.equal(new HomeyOfferSession(OFFER).options.disableTrickle, true);
  });

  it('asks for an answer and offers not to be asked for an offer', () => {
    const options = new HomeyOfferSession(OFFER).options;
    assert.equal(options.requiresAnswer, true);
    assert.equal(options.requiresOffer, false);
    assert.equal(options.offer?.sdp, OFFER);
  });

  it('is a class, because a plain object would be copied instead of proxied', () => {
    // `@scrypted/client` decides between copying an argument and proxying it by constructor
    // name, and its copy list is Number, String, Object, Boolean, Array. An object literal's
    // constructor name is `Object`, so rewriting this bridge as one would send Scrypted
    // plain data with none of these methods, and the handshake would never begin.
    const session = new HomeyOfferSession(OFFER);
    assert.notEqual(session.constructor.name, 'Object');
    assert.equal(typeof session.createLocalDescription, 'function');
  });

  it('exposes options through __proxy_props, or the far side negotiates blind', () => {
    // Scrypted reads `options` across RPC. Without this mirror the property is invisible
    // there and the session is set up with no options at all — including no disableTrickle.
    const session = new HomeyOfferSession(OFFER);
    assert.equal(session.__proxy_props.options, session.options);
    assert.equal(session.__proxy_props.options.disableTrickle, true);
  });
});

describe('HomeyOfferSession handshake', () => {

  it('hands Homey\'s offer back when Scrypted asks for a local description', async () => {
    const session = new HomeyOfferSession(OFFER);
    const description = await session.createLocalDescription('offer', SETUP, undefined);

    assert.deepEqual(description, { type: 'offer', sdp: OFFER });
  });

  it('resolves the wait with the answer Scrypted sets as the remote description', async () => {
    const session = new HomeyOfferSession(OFFER);
    const waiting = session.waitForAnswer(1_000);

    await session.setRemoteDescription({ type: 'answer', sdp: ANSWER }, SETUP);

    assert.equal(await waiting, ANSWER);
  });

  it('refuses to be the answerer rather than fudging a description', async () => {
    const session = new HomeyOfferSession(OFFER);
    const waiting = session.waitForAnswer(1_000);

    await assert.rejects(
      () => session.createLocalDescription('answer', SETUP, undefined),
      /cannot/);
    // And the player is failed rather than left hanging until the timeout.
    await assert.rejects(() => waiting, /cannot/);
  });

  it('fails the wait on an empty description instead of handing over a blank answer', async () => {
    const session = new HomeyOfferSession(OFFER);
    const waiting = session.waitForAnswer(1_000);

    await session.setRemoteDescription({ type: 'answer', sdp: '' }, SETUP);

    await assert.rejects(() => waiting, /empty session description/);
  });

  it('keeps the first answer when a second arrives', async () => {
    const session = new HomeyOfferSession(OFFER);
    const waiting = session.waitForAnswer(1_000);

    await session.setRemoteDescription({ type: 'answer', sdp: ANSWER }, SETUP);
    await session.setRemoteDescription({ type: 'answer', sdp: 'second' }, SETUP);

    assert.equal(await waiting, ANSWER);
  });

  it('gives up rather than leaving a player waiting forever', async () => {
    const session = new HomeyOfferSession(OFFER);
    await assert.rejects(() => session.waitForAnswer(20), /did not answer within/);
  });

  it('counts stray candidates instead of throwing on them', async () => {
    const session = new HomeyOfferSession(OFFER);
    assert.equal(session.ignoredCandidates, 0);

    // A candidate arriving despite disableTrickle means the answer is short one — worth
    // reporting, not worth tearing down a session that may be perfectly usable.
    await session.addIceCandidate({ candidate: 'candidate:1 1 udp 1 10.0.0.1 5000 typ host' });
    await session.addIceCandidate({ candidate: 'candidate:2 1 udp 1 10.0.0.2 5001 typ host' });

    assert.equal(session.ignoredCandidates, 2);
  });
});

describe('HomeyOfferSession rejection safety', () => {

  it('does not leave an unobserved rejection when refused before anyone waits', async () => {
    // The hazard this guards is fatal, not cosmetic: an unhandled rejection takes a Homey
    // app down, and Scrypted can call back into the session before `waitForAnswer` is
    // reached. The constructor attaches a handler for exactly that window.
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown): void => { unhandled.push(err); };
    process.on('unhandledRejection', onUnhandled);

    try {
      const session = new HomeyOfferSession(OFFER);
      session.reject(new Error('refused before anyone waited'));

      // Two turns of the loop: Node reports an unobserved rejection at the end of a turn.
      await new Promise(resolve => setImmediate(resolve));
      await new Promise(resolve => setImmediate(resolve));

      assert.deepEqual(unhandled, [], 'a rejection went unobserved and would crash the app');
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('still delivers that rejection to a later waiter', async () => {
    const session = new HomeyOfferSession(OFFER);
    session.reject(new Error('boom'));

    await assert.rejects(() => session.waitForAnswer(1_000), /boom/);
  });

  it('ignores a rejection once the answer is in', async () => {
    const session = new HomeyOfferSession(OFFER);
    await session.setRemoteDescription({ type: 'answer', sdp: ANSWER }, SETUP);
    session.reject(new Error('too late'));

    assert.equal(await session.waitForAnswer(1_000), ANSWER);
  });
});
