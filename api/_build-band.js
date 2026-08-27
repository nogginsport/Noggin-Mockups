// api/_build-band.js
//
// The beanie's striped band lives inside a nested Photoshop Smart Object
// that SudoMock can't reach into — see the "TOP LABEL" conversation for
// why. Rather than needing risky Photoshop layer surgery, we build the
// replacement image ourselves: a flat rectangle in the customer's chosen
// colour, with thin contrast piping lines near the top/bottom edges and
// the real "noggin" wordmark (exported once from Photoshop, stored
// alongside this file) placed on top. This whole image then gets sent to
// SudoMock as the replacement asset for that Smart Object slot.
//
// Uses jimp (pure JavaScript, no compiled/native dependencies) rather than
// sharp — sharp relies on native bindings that can fail to load correctly
// on some serverless deployments, silently crashing the whole function
// before it can even respond. jimp trades a little speed for being
// reliably deployable anywhere, which matters more for a low-volume
// endpoint like this one.
//
// The wordmark and piping lines automatically switch between white and
// near-black depending on how light/dark the chosen band colour is — this
// keeps the "usually white" look customers like on typical (darker) team
// colours, while staying readable if someone ever picks something pale.

const { Jimp, JimpMime } = require('jimp');
const path = require('path');

const WORDMARK_PATH = path.join(__dirname, '..', 'assets', 'noggin-wordmark.png');

/**
 * @param {string} hexColour - e.g. "#4F6B3F"
 * @param {number} width - target width in px, matching the Smart Object's real size
 * @param {number} height - target height in px, matching the Smart Object's real size
 * @returns {Promise<Buffer>} PNG image buffer
 */
async function buildBandImage(hexColour, width, height) {
  const bgHex = hexToJimpInt(hexColour);
  const detailHex = pickContrastColour(hexToRgb(hexColour)); // 0xFFFFFFFF or 0x141414FF

  const canvas = new Jimp({ width, height, color: bgHex });

  // Thin piping lines near the top and bottom edges of the band.
  const lineHeight = Math.max(2, Math.round(height * 0.02));
  const lineInset = Math.round(height * 0.12);
  const lineImg = new Jimp({ width, height: lineHeight, color: detailHex });
  canvas.composite(lineImg, 0, lineInset);
  canvas.composite(lineImg, 0, height - lineInset - lineHeight);

  // Wordmark, recoloured to match the chosen contrast colour, sized to
  // ~55% of the band's width and centred.
  const wordmarkWidth = Math.round(width * 0.55);
  const recolouredWordmark = await recolourWordmark(detailHex, wordmarkWidth);
  canvas.composite(
    recolouredWordmark,
    Math.round((width - recolouredWordmark.width) / 2),
    Math.round((height - recolouredWordmark.height) / 2)
  );

  return canvas.getBuffer(JimpMime.png);
}

/**
 * The source wordmark PNG is white letters on transparency. To recolour
 * it, we tint every non-transparent pixel to the target colour, preserving
 * the original alpha (so the letter shapes stay exactly as exported).
 */
async function recolourWordmark(colourHex, targetWidth) {
  const img = await Jimp.read(WORDMARK_PATH);
  img.resize({ w: targetWidth });

  const targetRgba = {
    r: (colourHex >>> 24) & 0xff,
    g: (colourHex >>> 16) & 0xff,
    b: (colourHex >>> 8) & 0xff,
  };

  img.scan(0, 0, img.width, img.height, function (x, y, idx) {
    // Keep this pixel's own alpha (idx + 3), just replace the colour.
    this.bitmap.data[idx] = targetRgba.r;
    this.bitmap.data[idx + 1] = targetRgba.g;
    this.bitmap.data[idx + 2] = targetRgba.b;
  });

  return img;
}

function pickContrastColour(rgb) {
  // Standard relative luminance formula — decides if the background
  // reads as "light" or "dark" to the eye.
  const luminance = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
  return luminance > 0.55 ? 0x141414ff : 0xffffffff;
}

function hexToRgb(hex) {
  const clean = hex.replace('#', '');
  return {
    r: parseInt(clean.substring(0, 2), 16),
    g: parseInt(clean.substring(2, 4), 16),
    b: parseInt(clean.substring(4, 6), 16),
  };
}

function hexToJimpInt(hex) {
  const rgb = hexToRgb(hex);
  return ((rgb.r << 24) | (rgb.g << 16) | (rgb.b << 8) | 0xff) >>> 0;
}

module.exports = { buildBandImage };
