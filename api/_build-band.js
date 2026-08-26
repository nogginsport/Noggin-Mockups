// api/_build-band.js
//
// The beanie's striped band lives inside a nested Photoshop Smart Object
// that SudoMock can't reach into — see the "TOP LABEL" conversation for
// why. Rather than needing risky Photoshop layer surgery, we build the
// replacement image ourselves: a flat rectangle in the customer's chosen
// colour, with the real "noggin" wordmark (exported once from Photoshop,
// stored alongside this file) placed on top. This whole image then gets
// sent to SudoMock as the replacement asset for that Smart Object slot.

const sharp = require('sharp');
const path = require('path');

const WORDMARK_PATH = path.join(__dirname, '..', 'assets', 'noggin-wordmark.png');

/**
 * @param {string} hexColour - e.g. "#4F6B3F"
 * @param {number} width - target width in px, matching the Smart Object's real size
 * @param {number} height - target height in px, matching the Smart Object's real size
 * @returns {Promise<Buffer>} PNG image buffer
 */
async function buildBandImage(hexColour, width, height) {
  const rgb = hexToRgb(hexColour);

  const background = await sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: rgb.r, g: rgb.g, b: rgb.b, alpha: 1 },
    },
  })
    .png()
    .toBuffer();

  // Size the wordmark to roughly 55% of the band's width, centred, matching
  // the proportions in the original design. Adjust this ratio if it looks
  // too large/small once you see a real render against the actual band size.
  const wordmarkWidth = Math.round(width * 0.55);

  const resizedWordmark = await sharp(WORDMARK_PATH)
    .resize({ width: wordmarkWidth, fit: 'inside' })
    .toBuffer();

  const wordmarkMeta = await sharp(resizedWordmark).metadata();

  const composited = await sharp(background)
    .composite([
      {
        input: resizedWordmark,
        left: Math.round((width - wordmarkMeta.width) / 2),
        top: Math.round((height - wordmarkMeta.height) / 2),
      },
    ])
    .png()
    .toBuffer();

  return composited;
}

function hexToRgb(hex) {
  const clean = hex.replace('#', '');
  return {
    r: parseInt(clean.substring(0, 2), 16),
    g: parseInt(clean.substring(2, 4), 16),
    b: parseInt(clean.substring(4, 6), 16),
  };
}

module.exports = { buildBandImage };
