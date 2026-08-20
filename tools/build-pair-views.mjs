/**
 * Copies the canonical pairing view into every driver.
 *
 * Homey Compose has no mechanism for sharing a custom pair view between drivers, and this
 * app needs the same "connect to your Scrypted server" form in all of them. Rather than
 * maintaining seven copies by hand, the copies are generated from assets/pair/ and checked
 * in, so `homey app run` works without a build step while there is still one source file.
 */
import { readdirSync, readFileSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = join(root, 'assets', 'pair');
const driversDir = join(root, 'drivers');

const views = readdirSync(sourceDir).filter(name => name.endsWith('.html'));
const drivers = readdirSync(driversDir).filter(name => statSync(join(driversDir, name)).isDirectory());

let written = 0;
for (const driver of drivers) {
  for (const view of views) {
    const target = join(driversDir, driver, 'pair');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, view), readFileSync(join(sourceDir, view)));
    written++;
  }
}
console.log(`build-pair-views: wrote ${written} view(s) across ${drivers.length} driver(s)`);
