/**
 * Produces the App Store images from one source picture per target.
 *
 * The store needs six files in two aspect ratios: the app image is 10:7, the driver image
 * is square. Getting those by hand from one photo means six crops and six resizes, which is
 * exactly the kind of thing that ends up subtly wrong. This centre-crops to the target
 * aspect first, then resizes, so nothing is ever stretched.
 *
 * Uses `sips`, which ships with macOS. On Linux, swap the two calls for ImageMagick.
 *
 * The two targets take different pictures, and guideline 1.4.3 calls out using one for the
 * other. The app image is a lifestyle photo; the driver image is the device itself on a
 * white background.
 *
 * Usage:
 *   node tools/build-images.mjs app    <lifestyle-photo>
 *   node tools/build-images.mjs camera <camera-on-white-background>
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const TARGETS = {
  app: {
    outDir: join(ROOT, 'assets', 'images'),
    sizes: { small: [250, 175], large: [500, 350], xlarge: [1000, 700] },
  },
  camera: {
    outDir: join(ROOT, 'drivers', 'camera', 'assets', 'images'),
    sizes: { small: [75, 75], large: [500, 500], xlarge: [1000, 1000] },
  },
};

function sips(args) {
  return execFileSync('sips', args, { encoding: 'utf8' });
}

function dimensions(file) {
  const out = sips(['-g', 'pixelWidth', '-g', 'pixelHeight', file]);
  const width = Number(/pixelWidth:\s*(\d+)/.exec(out)?.[1]);
  const height = Number(/pixelHeight:\s*(\d+)/.exec(out)?.[1]);
  if (!width || !height) throw new Error(`Could not read the dimensions of ${file}`);
  return { width, height };
}

const [, , targetName, source] = process.argv;
const target = TARGETS[targetName];

if (!target || !source) {
  console.error('Usage: node tools/build-images.mjs <app|camera> <source-image>');
  process.exit(1);
}
if (!existsSync(source)) {
  console.error(`No such file: ${source}`);
  process.exit(1);
}

const { width, height } = dimensions(source);
const [targetW, targetH] = target.sizes.xlarge;
const aspect = targetW / targetH;

// Largest centred rectangle of the target aspect that fits inside the source.
let cropW = width;
let cropH = Math.round(width / aspect);
if (cropH > height) {
  cropH = height;
  cropW = Math.round(height * aspect);
}

if (cropW < targetW || cropH < targetH) {
  console.warn(
    `Warning: the source is ${width}x${height}; after cropping to ${cropW}x${cropH} it is `
    + `smaller than the required ${targetW}x${targetH} and will be upscaled. Use a larger image.`,
  );
}

mkdirSync(target.outDir, { recursive: true });
const cropped = join(target.outDir, '.cropped.png');
copyFileSync(source, cropped);
sips(['-c', String(cropH), String(cropW), cropped]);  // sips takes height first

for (const [name, [w, h]] of Object.entries(target.sizes)) {
  const out = join(target.outDir, `${name}.png`);
  copyFileSync(cropped, out);
  sips(['-z', String(h), String(w), out]);
  sips(['-s', 'format', 'png', out]);
  console.log(`wrote ${out} (${w}x${h})`);
}

rmSync(cropped, { force: true });
