import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

/**
 * Guards the one thing `homey app validate` will not check.
 *
 * The validator walks `drivers[].pair[]` and asserts each declared view has a file at
 * `drivers/<id>/pair/<viewId>.html`. It never looks at `drivers[].repair[]` — `repair` is
 * not in Homey's app manifest schema at all. So a repair view in the wrong folder passes
 * validation at publish level, ships, and fails only when a user taps Repair and gets
 * `error_unknown_getting_file`. This app shipped exactly that: the view generator wrote
 * every view into pair/, and repair had no file anywhere Homey would look.
 *
 * Repair views resolve from `drivers/<id>/repair/<viewId>.html`.
 */

// .testbuild/test/<file>.test.mjs → up two levels to the app root.
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

interface DriverView { id?: string; template?: string }
interface Driver { id: string; pair?: DriverView[]; repair?: DriverView[] }

function drivers(): Driver[] {
  const manifest = JSON.parse(readFileSync(join(root, 'app.json'), 'utf8')) as { drivers?: Driver[] };
  return manifest.drivers ?? [];
}

/** A view carrying a `template` is one of Homey's own, so it has no file of ours. */
function customViews(views: DriverView[] | undefined): string[] {
  return (views ?? []).filter(view => view.template === undefined && view.id).map(view => view.id as string);
}

describe('driver views have the files Homey will look for', () => {
  it('has drivers to check, so a broken manifest cannot pass this silently', () => {
    assert.ok(drivers().length > 0, 'app.json declares no drivers');
  });

  it('declares at least one repair view, or this file guards nothing', () => {
    const declared = drivers().flatMap(driver => customViews(driver.repair));
    assert.ok(declared.length > 0, 'no custom repair view is declared');
  });

  it('puts every repair view in drivers/<id>/repair/', () => {
    for (const driver of drivers()) {
      for (const view of customViews(driver.repair)) {
        const path = join('drivers', driver.id, 'repair', `${view}.html`);
        assert.ok(existsSync(join(root, path)), `missing ${path}`);
      }
    }
  });

  it('puts every pair view in drivers/<id>/pair/', () => {
    for (const driver of drivers()) {
      for (const view of customViews(driver.pair)) {
        const path = join('drivers', driver.id, 'pair', `${view}.html`);
        assert.ok(existsSync(join(root, path)), `missing ${path}`);
      }
    }
  });

  it('leaves no orphan in pair/ for a view only repair declares', () => {
    // The dead copy this bug left behind: a file in pair/ that nothing pairs with, shipped
    // in every build while repair had nothing to open.
    for (const driver of drivers()) {
      const paired = new Set(customViews(driver.pair));
      for (const view of customViews(driver.repair)) {
        if (paired.has(view)) continue;
        const stray = join('drivers', driver.id, 'pair', `${view}.html`);
        assert.ok(!existsSync(join(root, stray)), `${stray} is dead weight; repair reads repair/`);
      }
    }
  });
});

describe('a repair view carries its own confirm control', () => {
  /**
   * A repair session does not render Homey's navigation bar, so a view whose only control
   * is `Homey.addNavigationButton` opens with no way to confirm.
   */
  it('has a button in the page, not only a navigation button', () => {
    for (const driver of drivers()) {
      for (const view of customViews(driver.repair)) {
        const path = join('drivers', driver.id, 'repair', `${view}.html`);
        assert.match(readFileSync(join(root, path), 'utf8'), /<button\b/, `${path} has no in-page button`);
      }
    }
  });
});
