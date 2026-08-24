/**
 * Copies the shared driver views into the folder each driver's manifest implies.
 *
 * Homey Compose has no mechanism for sharing a custom view between drivers, and this app
 * needs the same "connect to your Scrypted server" form in all of them. The copies are
 * generated from assets/views/ and checked in, so `homey app run` works without a build
 * step while there is still one source file.
 *
 * The destination is read from the manifest rather than fixed, because a view resolves from
 * `drivers/<id>/pair/<viewId>.html` for pairing and `drivers/<id>/repair/<viewId>.html` for
 * repair. This script used to write everything into pair/ unconditionally, which put the
 * repair form somewhere nothing looks for it — `homey app validate` never checks repair
 * views, so that shipped and only surfaced when a user tapped Repair.
 */
import { readdirSync, readFileSync, mkdirSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = join(root, 'assets', 'views');
const driversDir = join(root, 'drivers');

/** The view ids a driver declares itself, i.e. excluding Homey's own templates. */
function customViews(views) {
  return (views ?? []).filter(view => view.template === undefined && view.id).map(view => view.id);
}

const sources = new Map(
  readdirSync(sourceDir)
    .filter(name => name.endsWith('.html'))
    .map(name => [name.replace(/\.html$/, ''), join(sourceDir, name)]),
);

const drivers = readdirSync(driversDir).filter(name => statSync(join(driversDir, name)).isDirectory());

let written = 0;
const missing = [];

for (const driver of drivers) {
  const manifestPath = join(driversDir, driver, 'driver.compose.json');
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

  for (const folder of ['pair', 'repair']) {
    for (const view of customViews(manifest[folder])) {
      const source = sources.get(view);
      if (!source) {
        missing.push(`${driver}/${folder}/${view}.html has no source in assets/views/`);
        continue;
      }
      const target = join(driversDir, driver, folder);
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, `${view}.html`), readFileSync(source));
      written++;
    }
  }
}

if (missing.length) {
  console.error(`build-driver-views: ${missing.length} declared view(s) have no source:`);
  for (const line of missing) console.error(`  ${line}`);
  process.exit(1);
}

console.log(`build-driver-views: wrote ${written} view(s) across ${drivers.length} driver(s)`);
