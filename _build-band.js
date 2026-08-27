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
// The wordmark and piping lines automatically switch between white and
// near-black depending on how light/dark the chosen band colour is — this
// keeps the "usually white" look customers like on typical (darker) team
// colours, while staying readable if someone ever picks something pale.

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
  const detailColour = pickContrastColour(rgb); // '#FFFFFF' or '#141414'

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

  const composites = [];

  // Thin piping lines near the top and bottom edges of the band.
  const lineHeight = Math.max(2, Math.round(height * 0.02));
  const lineInset = Math.round(height * 0.12);
  const lineSvg = Buffer.from(
    `<svg width="${width}" height="${lineHeight}"><rect width="100%" height="100%" fill="${detailColour}"/></svg>`
  );
  composites.push({ input: lineSvg, left: 0, top: lineInset });
  composites.push({ input: lineSvg, left: 0, top: height - lineInset - lineHeight });

  // Wordmark, recoloured to match the chosen contrast colour, sized to
  // ~55% of the band's width and centred.
  const wordmarkWidth = Math.round(width * 0.55);
  const recolouredWordmark = await recolourWordmark(detailColour, wordmarkWidth);
  const wordmarkMeta = await sharp(recolouredWordmark).metadata();
  composites.push({
    input: recolouredWordmark,
    left: Math.round((width - wordmarkMeta.width) / 2),
    top: Math.round((height - wordmarkMeta.height) / 2),
  });

  const composited = await sharp(background)
    .composite(composites)
    .png()
    .toBuffer();

  return composited;
}

/**
 * The source wordmark PNG is white letters on transparency. To recolour
 * it, we use its alpha channel as a mask over a solid fill of the target
 * colour — this works regardless of what colour the source happens to be.
 */
async function recolourWordmark(hexColour, targetWidth) {
  const rgb = hexToRgb(hexColour);

  const resized = await sharp(WORDMARK_PATH)
    .resize({ width: targetWidth, fit: 'inside' })
    .ensureAlpha()
    .toBuffer();

  const meta = await sharp(resized).metadata();

  const solidFill = await sharp({
    create: {
      width: meta.width,
      height: meta.height,
      channels: 4,
      background: { r: rgb.r, g: rgb.g, b: rgb.b, alpha: 1 },
    },
  })
    .png()
    .toBuffer();

  // Use the wordmark's own alpha as a mask, applied to the solid fill.
  return sharp(solidFill)
    .composite([{ input: resized, blend: 'dest-in' }])
    .png()
    .toBuffer();
}

function pickContrastColour(rgb) {
  // Standard relative luminance formula — decides if the background
  // reads as "light" or "dark" to the eye.
  const luminance = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
  return luminance > 0.55 ? '#141414' : '#FFFFFF';
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

