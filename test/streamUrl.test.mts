import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLoopbackUrl, rewriteLoopbackHost } from '../lib/streamUrl.mjs';

const HOST = '192.168.1.50';

test('a loopback rebroadcast URL is pointed at the Scrypted host', () => {
  // The shape Scrypted's rebroadcast plugin returns: a session id and a device id.
  assert.equal(
    rewriteLoopbackHost('rtsp://127.0.0.1:51090/a1b2c3d4e5f60718/42', HOST),
    'rtsp://192.168.1.50:51090/a1b2c3d4e5f60718/42',
  );
});

test('port, path and scheme survive the rewrite', () => {
  assert.equal(rewriteLoopbackHost('rtsp://localhost:8554/live/1', HOST), 'rtsp://192.168.1.50:8554/live/1');
  assert.equal(rewriteLoopbackHost('http://[::1]:8080/snap.jpg', HOST), 'http://192.168.1.50:8080/snap.jpg');
  assert.equal(rewriteLoopbackHost('rtsps://127.0.0.1:443/x', HOST), 'rtsps://192.168.1.50:443/x');
});

test('embedded credentials survive the rewrite', () => {
  assert.equal(
    rewriteLoopbackHost('rtsp://user:pass@127.0.0.1:554/stream', HOST),
    'rtsp://user:pass@192.168.1.50:554/stream',
  );
});

test('a routable host is never rewritten', () => {
  const url = 'rtsp://192.168.1.42:554/stream';
  assert.equal(rewriteLoopbackHost(url, HOST), url);
  assert.equal(rewriteLoopbackHost('rtsp://cam.local:554/s', HOST), 'rtsp://cam.local:554/s');
});

test('hosts that merely start with a loopback name are left alone', () => {
  // Guards the regex boundary: these are distinct hosts, not loopback.
  assert.equal(rewriteLoopbackHost('rtsp://localhost.example.com/s', HOST), 'rtsp://localhost.example.com/s');
  assert.equal(rewriteLoopbackHost('rtsp://127.0.0.10:554/s', HOST), 'rtsp://127.0.0.10:554/s');
});

test('malformed or empty input passes through untouched', () => {
  assert.equal(rewriteLoopbackHost('', HOST), '');
  assert.equal(rewriteLoopbackHost('not a url', HOST), 'not a url');
  assert.equal(rewriteLoopbackHost('rtsp://127.0.0.1/s', ''), 'rtsp://127.0.0.1/s');
});

test('loopback detection matches the rewrite', () => {
  assert.equal(isLoopbackUrl('rtsp://127.0.0.1:51090/x'), true);
  assert.equal(isLoopbackUrl('rtsp://localhost/x'), true);
  assert.equal(isLoopbackUrl('rtsp://192.168.1.42/x'), false);
  assert.equal(isLoopbackUrl('rtsp://127.0.0.10/x'), false);
});
