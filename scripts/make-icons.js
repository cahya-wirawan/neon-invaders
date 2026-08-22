#!/usr/bin/env node
/* make-icons.js -- generate NEON INVADERS placeholder launcher icons and
 * splash screens for both native platforms.
 *
 * Zero dependencies. No sharp, no @capacitor/assets, no ImageMagick: PNGs are
 * encoded by hand (IHDR / IDAT / IEND chunks with CRC32, pixel data deflated
 * with node:zlib). That keeps this runnable on a machine with no native
 * toolchain and no image libraries.
 *
 * These are PLACEHOLDERS -- a procedural invader glyph on the game's own
 * palette. They are correctly sized and structurally valid so the projects
 * build, but they are not final store art. See docs/MOBILE.md.
 *
 *   node scripts/make-icons.js
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.resolve(__dirname, '..');

/* ----------------------------- PNG encoder ----------------------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/* rgba: Uint8Array of w*h*4. alpha=true -> colour type 6, else 2. */
function encodePng(width, height, rgba, alpha) {
  const channels = alpha ? 4 : 3;
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filter type 0 (None)
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 4;
      const dst = rowStart + 1 + x * channels;
      raw[dst] = rgba[src];
      raw[dst + 1] = rgba[src + 1];
      raw[dst + 2] = rgba[src + 2];
      if (alpha) {
        raw[dst + 3] = rgba[src + 3];
      }
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;                      // bit depth
  ihdr[9] = alpha ? 6 : 2;          // colour type
  ihdr[10] = 0;                     // deflate
  ihdr[11] = 0;                     // adaptive filtering
  ihdr[12] = 0;                     // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ------------------------------- drawing ------------------------------- */

// The game's palette (js/core.js CONFIG.COLORS + css/style.css background).
const BG_TOP = [0x14, 0x17, 0x3a];
const BG_BOTTOM = [0x04, 0x03, 0x0b];
const CYAN = [0x5f, 0xfb, 0xf1];
const MAGENTA = [0xff, 0x56, 0xd5];

// Classic 11x8 invader.
const INVADER = [
  '00100000100',
  '00010001000',
  '00111111100',
  '01101110110',
  '11111111111',
  '10111111101',
  '10100000101',
  '00011011000'
];
const GLYPH_W = INVADER[0].length;
const GLYPH_H = INVADER.length;

function makeCanvas(w, h) {
  return { w, h, px: new Uint8Array(w * h * 4) };
}

function blend(c, x, y, rgb, a) {
  if (x < 0 || y < 0 || x >= c.w || y >= c.h) return;
  const i = (y * c.w + x) * 4;
  const dstA = c.px[i + 3] / 255;
  const outA = a + dstA * (1 - a);
  if (outA <= 0) return;
  for (let k = 0; k < 3; k++) {
    c.px[i + k] = Math.round((rgb[k] * a + c.px[i + k] * dstA * (1 - a)) / outA);
  }
  c.px[i + 3] = Math.round(outA * 255);
}

function fillGradient(c) {
  for (let y = 0; y < c.h; y++) {
    const t = c.h === 1 ? 0 : y / (c.h - 1);
    // Ease so the light band stays near the top, as on the web page.
    const e = Math.min(1, t * 1.7);
    for (let x = 0; x < c.w; x++) {
      const i = (y * c.w + x) * 4;
      for (let k = 0; k < 3; k++) {
        c.px[i + k] = Math.round(BG_TOP[k] + (BG_BOTTOM[k] - BG_TOP[k]) * e);
      }
      c.px[i + 3] = 255;
    }
  }
}

function fillRect(c, x0, y0, w, h, rgb, a) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      blend(c, x, y, rgb, a);
    }
  }
}

/* Draws the invader centred, occupying `coverage` of the smaller dimension. */
function drawGlyph(c, coverage) {
  const target = Math.min(c.w, c.h) * coverage;
  const cell = Math.max(1, Math.floor(target / GLYPH_W));
  const gw = cell * GLYPH_W;
  const gh = cell * GLYPH_H;
  const ox = Math.round((c.w - gw) / 2);
  const oy = Math.round((c.h - gh) / 2);
  const halo = Math.max(1, Math.round(cell * 0.42));

  // Magenta bloom first (a dilated copy), then the cyan body on top.
  for (const [rgb, grow, alpha] of [[MAGENTA, halo, 0.42], [CYAN, 0, 1]]) {
    for (let gy = 0; gy < GLYPH_H; gy++) {
      for (let gx = 0; gx < GLYPH_W; gx++) {
        if (INVADER[gy][gx] !== '1') continue;
        fillRect(
          c,
          ox + gx * cell - grow,
          oy + gy * cell - grow,
          cell + grow * 2,
          cell + grow * 2,
          rgb,
          alpha
        );
      }
    }
  }
  return { cell, ox, oy, gw, gh };
}

/* Cuts the square down to a circle (for ic_launcher_round). */
function circleMask(c) {
  const cx = (c.w - 1) / 2;
  const cy = (c.h - 1) / 2;
  const r = Math.min(c.w, c.h) / 2;
  for (let y = 0; y < c.h; y++) {
    for (let x = 0; x < c.w; x++) {
      const d = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      const i = (y * c.w + x) * 4;
      if (d > r) {
        c.px[i + 3] = 0;
      } else if (d > r - 1.5) {
        // Cheap 1.5px antialiased edge.
        c.px[i + 3] = Math.round(c.px[i + 3] * Math.max(0, (r - d) / 1.5));
      }
    }
  }
}

function iconCanvas(size, opts) {
  const o = opts || {};
  const c = makeCanvas(size, size);
  if (o.transparent) {
    c.px.fill(0);
  } else {
    fillGradient(c);
  }
  drawGlyph(c, o.coverage || 0.62);
  if (o.round) {
    circleMask(c);
  }
  return c;
}

function splashCanvas(w, h) {
  const c = makeCanvas(w, h);
  fillGradient(c);
  drawGlyph(c, 0.34);
  return c;
}

/* ------------------------------- targets ------------------------------- */

const ANDROID_RES = path.join(ROOT, 'android', 'app', 'src', 'main', 'res');
const IOS_ASSETS = path.join(ROOT, 'ios', 'App', 'App', 'Assets.xcassets');

// Sizes mirror what `npx cap add` generates, so nothing else needs editing.
const LAUNCHER = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
const FOREGROUND = { mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 };
const ANDROID_SPLASH = {
  'drawable': [480, 320],
  'drawable-port-mdpi': [320, 480],
  'drawable-port-hdpi': [480, 800],
  'drawable-port-xhdpi': [720, 1280],
  'drawable-port-xxhdpi': [960, 1600],
  'drawable-port-xxxhdpi': [1280, 1920],
  'drawable-land-mdpi': [480, 320],
  'drawable-land-hdpi': [800, 480],
  'drawable-land-xhdpi': [1280, 720],
  'drawable-land-xxhdpi': [1600, 960],
  'drawable-land-xxxhdpi': [1920, 1280]
};

function write(file, buffer) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buffer);
  return file;
}

function main() {
  const written = [];
  const skipped = [];

  if (fs.existsSync(ANDROID_RES)) {
    for (const [density, size] of Object.entries(LAUNCHER)) {
      const dir = path.join(ANDROID_RES, `mipmap-${density}`);
      written.push(write(
        path.join(dir, 'ic_launcher.png'),
        encodePng(size, size, iconCanvas(size).px, true)
      ));
      written.push(write(
        path.join(dir, 'ic_launcher_round.png'),
        encodePng(size, size, iconCanvas(size, { round: true }).px, true)
      ));
    }
    for (const [density, size] of Object.entries(FOREGROUND)) {
      // Adaptive-icon foreground: transparent, art inside the 66% safe zone.
      written.push(write(
        path.join(ANDROID_RES, `mipmap-${density}`, 'ic_launcher_foreground.png'),
        encodePng(size, size, iconCanvas(size, { transparent: true, coverage: 0.40 }).px, true)
      ));
    }
    for (const [dir, [w, h]] of Object.entries(ANDROID_SPLASH)) {
      written.push(write(
        path.join(ANDROID_RES, dir, 'splash.png'),
        encodePng(w, h, splashCanvas(w, h).px, false)
      ));
    }
  } else {
    skipped.push('android (platform not added -- run `npx cap add android`)');
  }

  if (fs.existsSync(IOS_ASSETS)) {
    // App Store icons must be fully opaque: no alpha channel at all.
    written.push(write(
      path.join(IOS_ASSETS, 'AppIcon.appiconset', 'AppIcon-512@2x.png'),
      encodePng(1024, 1024, iconCanvas(1024).px, false)
    ));
    const splash = encodePng(2732, 2732, splashCanvas(2732, 2732).px, false);
    for (const name of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png']) {
      written.push(write(path.join(IOS_ASSETS, 'Splash.imageset', name), splash));
    }
  } else {
    skipped.push('ios (platform not added -- run `npx cap add ios`)');
  }

  for (const f of written) {
    console.log('  wrote ' + path.relative(ROOT, f));
  }
  for (const s of skipped) {
    console.log('  skipped ' + s);
  }
  console.log(`make-icons: ${written.length} PNG(s) written, ${skipped.length} platform(s) skipped.`);

  if (!written.length) {
    console.error('make-icons: nothing written -- add a platform first.');
    process.exit(1);
  }
}

main();
