import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeviceResources } from '../lib/DeviceResources.mjs';

test('everything held is released, and only once', async () => {
  const released: string[] = [];
  const resources = new DeviceResources();

  await resources.add('image', () => { released.push('image'); });
  await resources.add('video', () => { released.push('video'); });
  assert.equal(resources.size, 2);

  await resources.releaseAll();
  assert.deepEqual(released.sort(), ['image', 'video']);
  assert.equal(resources.size, 0);

  await resources.releaseAll();
  assert.deepEqual(released.sort(), ['image', 'video'], 'a second release ran the entries again');
});

test('release runs in reverse order of registration', async () => {
  const order: string[] = [];
  const resources = new DeviceResources();

  // A video registered against an image should come down before the image it depends on.
  await resources.add('first', () => { order.push('first'); });
  await resources.add('second', () => { order.push('second'); });
  await resources.releaseAll();

  assert.deepEqual(order, ['second', 'first']);
});

test('a registration arriving after the release is released instead of stored', async () => {
  const released: string[] = [];
  const resources = new DeviceResources();

  await resources.releaseAll();

  // This is the race the class exists for: an image whose `createImage()` was still in
  // flight when the device was deleted. Storing it would leave it registered against a
  // device nothing will ever clean up again.
  const kept = await resources.add('late image', () => { released.push('late image'); });

  assert.equal(kept, false, 'a late registration was kept');
  assert.deepEqual(released, ['late image']);
  assert.equal(resources.size, 0);
});

test('add reports whether the caller may keep the resource', async () => {
  const resources = new DeviceResources();

  assert.equal(await resources.add('early', () => undefined), true);
  await resources.releaseAll();
  assert.equal(await resources.add('late', () => undefined), false);
});

test('one failing release does not strand the others', async () => {
  const released: string[] = [];
  const errors: string[] = [];
  const resources = new DeviceResources(message => errors.push(message));

  await resources.add('good early', () => { released.push('good early'); });
  await resources.add('bad', () => { throw new Error('unregister refused'); });
  await resources.add('good late', () => { released.push('good late'); });

  await resources.releaseAll();

  assert.deepEqual(released, ['good late', 'good early'], 'a throwing release stopped the rest');
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /Releasing bad failed: unregister refused/);
  assert.equal(resources.size, 0, 'a failed release stayed on the list');
});

test('a rejected promise is reported like a thrown error', async () => {
  const errors: string[] = [];
  const resources = new DeviceResources(message => errors.push(message));

  await resources.add('async bad', async () => { throw new Error('async refused'); });
  await resources.releaseAll();

  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /Releasing async bad failed: async refused/);
});

test('releases are awaited, not fired and forgotten', async () => {
  let finished = false;
  const resources = new DeviceResources();

  await resources.add('slow', async () => {
    await new Promise(resolve => setImmediate(resolve));
    finished = true;
  });

  await resources.releaseAll();
  assert.equal(finished, true, 'releaseAll returned before a slow release had finished');
});

test('isReleased reports the state the call sites branch on', async () => {
  const resources = new DeviceResources();
  assert.equal(resources.isReleased, false);
  await resources.releaseAll();
  assert.equal(resources.isReleased, true);
});

test('a registration arriving while the release is still running is not kept', async () => {
  const released: string[] = [];
  const resources = new DeviceResources();
  let late: Promise<boolean> | null = null;

  // The window that matters is *during* the drain, not after it returns: a slow release
  // yields the event loop, and that is exactly when an in-flight `createImage` lands.
  await resources.add('slow', async () => {
    released.push('slow');
    late = resources.add('late', () => { released.push('late'); });
    await new Promise(resolve => setImmediate(resolve));
  });

  await resources.releaseAll();

  assert.equal(await late, false, 'a registration made mid-release was kept');
  assert.deepEqual(released, ['slow', 'late']);
  assert.equal(resources.size, 0);
});

test('isReleased is true from the moment the release starts, not when it ends', async () => {
  const resources = new DeviceResources();
  let seenDuring: boolean | null = null;

  await resources.add('observer', async () => {
    seenDuring = resources.isReleased;
    await new Promise(resolve => setImmediate(resolve));
  });

  await resources.releaseAll();
  assert.equal(seenDuring, true, 'call sites branching on isReleased could still register');
});
