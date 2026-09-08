import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alignAnswerToOffer, summariseSdp } from '../lib/sdpAlign.mjs';

/** Joins with CRLF and terminates the last line, which is how an SDP is written. */
function sdp(...lines: string[]): string {
  return lines.join('\r\n') + '\r\n';
}

const SESSION = [
  'v=0',
  'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
];

const AUDIO = [
  'm=audio 9 UDP/TLS/RTP/SAVPF 111',
  'c=IN IP4 0.0.0.0',
  'a=mid:0',
  'a=rtpmap:111 opus/48000/2',
];

const VIDEO = [
  'm=video 9 UDP/TLS/RTP/SAVPF 96',
  'c=IN IP4 0.0.0.0',
  'a=mid:1',
  'a=rtpmap:96 H264/90000',
];

const OFFER = sdp(...SESSION, 'a=group:BUNDLE 0 1', ...AUDIO, ...VIDEO);

/** The order of the `m=` lines, which is the whole of what the player checks. */
function mediaOrder(description: string): string[] {
  return description.split(/\r?\n/).filter(line => line.startsWith('m=')).map(line => line.split(' ')[0]!);
}

test('an answer that swapped the media sections is put back in the offer order', () => {
  const answer = sdp(...SESSION, 'a=group:BUNDLE 1 0', ...VIDEO, ...AUDIO);

  const aligned = alignAnswerToOffer(OFFER, answer);

  assert.equal(aligned.changed, true);
  assert.deepEqual(mediaOrder(aligned.sdp), ['m=audio', 'm=video']);
  assert.deepEqual(aligned.offerMids, ['0', '1']);
  assert.deepEqual(aligned.answerMids, ['1', '0']);
});

test('the BUNDLE group follows the sections it lists', () => {
  const answer = sdp(...SESSION, 'a=group:BUNDLE 1 0', ...VIDEO, ...AUDIO);

  assert.match(alignAnswerToOffer(OFFER, answer).sdp, /^a=group:BUNDLE 0 1$/m);
});

test('the section bodies travel intact with their m-line', () => {
  const answer = sdp(...SESSION, 'a=group:BUNDLE 1 0', ...VIDEO, ...AUDIO);

  const lines = alignAnswerToOffer(OFFER, answer).sdp.split('\r\n');
  const audioAt = lines.indexOf('m=audio 9 UDP/TLS/RTP/SAVPF 111');
  const videoAt = lines.indexOf('m=video 9 UDP/TLS/RTP/SAVPF 96');

  assert.ok(audioAt < videoAt);
  assert.equal(lines[audioAt + 3], 'a=rtpmap:111 opus/48000/2');
  assert.equal(lines[videoAt + 3], 'a=rtpmap:96 H264/90000');
});

test('an answer that already matches is handed back byte for byte', () => {
  const answer = sdp(...SESSION, 'a=group:BUNDLE 0 1', ...AUDIO, ...VIDEO);

  const aligned = alignAnswerToOffer(OFFER, answer);

  assert.equal(aligned.changed, false);
  assert.equal(aligned.sdp, answer);
});

test('media the answer dropped is rejected in place rather than left out', () => {
  // Dropping a section shifts every section after it, which is the same fault as reordering.
  const answer = sdp(...SESSION, 'a=group:BUNDLE 1', ...VIDEO);

  const aligned = alignAnswerToOffer(OFFER, answer);

  assert.equal(aligned.changed, true);
  assert.deepEqual(mediaOrder(aligned.sdp), ['m=audio', 'm=video']);
  assert.match(aligned.sdp, /^m=audio 0 UDP\/TLS\/RTP\/SAVPF 111$/m);
  assert.match(aligned.sdp, /^a=mid:0$/m);
  // A section nobody answers does not belong in the bundle it is not part of.
  assert.match(aligned.sdp, /^a=group:BUNDLE 1$/m);
});

test('an answer carrying media the offer never asked for is left alone', () => {
  const extra = ['m=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'a=mid:2'];
  const answer = sdp(...SESSION, 'a=group:BUNDLE 0 1 2', ...AUDIO, ...VIDEO, ...extra);

  const aligned = alignAnswerToOffer(OFFER, answer);

  assert.equal(aligned.changed, false);
  assert.equal(aligned.sdp, answer);
  assert.equal(aligned.note, 'the answer carries media the offer did not ask for');
});

test('descriptions without media sections are not touched', () => {
  const aligned = alignAnswerToOffer(sdp(...SESSION), sdp(...SESSION));

  assert.equal(aligned.changed, false);
  assert.equal(aligned.note, 'no media sections to align');
});

test('sections without mids are matched by media type', () => {
  const bare = (lines: string[]): string[] => lines.filter(line => !line.startsWith('a=mid:'));
  const offer = sdp(...SESSION, ...bare(AUDIO), ...bare(VIDEO));
  const answer = sdp(...SESSION, ...bare(VIDEO), ...bare(AUDIO));

  const aligned = alignAnswerToOffer(offer, answer);

  assert.equal(aligned.changed, true);
  assert.deepEqual(mediaOrder(aligned.sdp), ['m=audio', 'm=video']);
});

test('the line endings of the answer are preserved', () => {
  const answer = sdp(...SESSION, 'a=group:BUNDLE 1 0', ...VIDEO, ...AUDIO);

  const aligned = alignAnswerToOffer(OFFER, answer);

  assert.ok(aligned.sdp.endsWith('\r\n'));
  assert.doesNotMatch(aligned.sdp.replace(/\r\n/g, ''), /\n/);
});

test('re-ordering does not leave a blank line where the answer used to end', () => {
  // An SDP is a sequence of `<type>=<value>` lines and nothing else. The terminator of the
  // last line belongs to the description, not to the section it followed, and carrying it
  // along with that section puts an empty line in the middle — which is the second way to
  // have an answer rejected by the parser this whole function exists to satisfy.
  const answer = sdp(...SESSION, 'a=group:BUNDLE 1 0', ...VIDEO, ...AUDIO);

  const aligned = alignAnswerToOffer(OFFER, answer);

  assert.equal(aligned.sdp.split('\r\n').filter((line, index, all) => !line && index < all.length - 1).length, 0);
  assert.ok(aligned.sdp.endsWith('\r\n'));
  assert.equal(aligned.sdp.split('\r\n').length, answer.split('\r\n').length);
});

test('a summary names each section without carrying anything secret', () => {
  const answer = sdp(
    ...SESSION,
    'a=group:BUNDLE 0 1',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111',
    'a=mid:0',
    'a=ice-ufrag:9Xz1',
    'a=ice-pwd:a-secret-nobody-needs-in-a-log',
    'a=sendonly',
    'm=application 0 UDP/DTLS/SCTP webrtc-datachannel',
    'a=mid:2',
  );

  const summary = summariseSdp(answer);

  assert.deepEqual(summary, ['audio/0/9/sendonly', 'application/2/0']);
  assert.doesNotMatch(summary.join(' '), /secret|ufrag/);
});
