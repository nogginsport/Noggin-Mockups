// api/generate.js
//
// POST /api/generate
// Body: multipart/form-data — logo (file), primary_color, secondary_color
//       (hex strings, e.g. "#4F6B3F"), tier ("1" | "2"), sessionId, email
//
// Produces 8 renders per free set: 3 beanies, 2 caps, 3 bucket hats — each
// using the customer's actual uploaded logo and their two chosen colours,
// rendered from Noggin's real Photoshop templates via SudoMock. See
// _mockup-config.js for exactly which layer gets which colour.

const { formidable } = require('formidable');
const fs = require('fs');
const { kv } = require('@vercel/kv');
const { put } = require('@vercel/blob');
const { getMockup, render, findSmartObjectByName } = require('./_sudomock-client');
const { buildBandImage } = require('./_build-band');
const { PRODUCTS, PRODUCT_VARIATIONS } = require('./_mockup-config');

module.exports = async (req, res) => {
  // CORS — required for the browser to accept this response at all, since
  // the request comes from a different origin (Shopify's domain, or a
  // local test file) than this API lives on. Without these headers, the
  // browser silently blocks the response even though the server processed
  // the request successfully — this was the actual cause of "nothing
  // happens" during testing.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Browsers send a preflight OPTIONS request before the real POST for
  // requests like this one — must respond successfully to it, with no body.
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ code: 'METHOD_NOT_ALLOWED', message: 'Use POST.' });
  }

  let fields, files;
  try {
    ({ fields, files } = await parseForm(req));
  } catch (err) {
    console.error('Upload parsing failed:', err);
    return res.status(400).json({ code: 'BAD_REQUEST', message: 'Could not read upload.', debug: String(err && err.message || err) });
  }

  const sessionId = String(fields.sessionId || '').trim();
  const tier = String(fields.tier || '1').trim();
  const email = fields.email ? String(fields.email).trim() : null;
  const primaryColor = String(fields.primary_color || '').trim();
  const secondaryColor = String(fields.secondary_color || '').trim();
  const logoFile = files.logo;

  if (!sessionId) return res.status(400).json({ code: 'BAD_REQUEST', message: 'Missing session.' });
  if (!logoFile) return res.status(400).json({ code: 'BAD_REQUEST', message: 'Missing logo file.' });
  if (!/^#[0-9A-Fa-f]{6}$/.test(primaryColor) || !/^#[0-9A-Fa-f]{6}$/.test(secondaryColor)) {
    return res.status(400).json({ code: 'BAD_REQUEST', message: 'primary_color and secondary_color must be hex, e.g. #4F6B3F.' });
  }
  if (tier === '2' && !email) {
    return res.status(400).json({ code: 'EMAIL_REQUIRED', message: 'Add your email to unlock more designs.' });
  }

  // --- Server-side rate limit ---
  const usageKey = `noggin:mockup:${sessionId}`;
  const usage = (await kv.get(usageKey)) || { tier1Used: false, tier2Used: false };

  if (tier === '1' && usage.tier1Used) {
    return res.status(429).json({ code: 'LIMIT_REACHED', message: "You've already used your free set for this session. Add your email for more." });
  }
  if (tier === '2' && usage.tier2Used) {
    return res.status(429).json({ code: 'LIMIT_REACHED', message: "You've already unlocked your second set for this session." });
  }

  // --- Upload the customer's logo once, reuse the URL across every render ---
  let logoUrl;
  try {
    const logoBuffer = fs.readFileSync(logoFile.filepath);
    const blob = await put(`logos/${sessionId}-${Date.now()}.png`, logoBuffer, {
      access: 'public',
      contentType: logoFile.mimetype || 'image/png',
    });
    logoUrl = blob.url;
  } catch (err) {
    console.error('Logo upload failed', err);
    return res.status(502).json({ code: 'UPLOAD_FAILED', message: 'Could not process your logo.' });
  }

  // --- Generate all 8 designs ---
  let designs;
  try {
    designs = await generateAllDesigns({ logoUrl, primaryColor, secondaryColor, sessionId });
  } catch (err) {
    console.error('Mock-up generation failed', err);
    return res.status(502).json({ code: 'GENERATION_FAILED', message: 'Could not generate mock-ups right now.' });
  }

  // --- Record usage + lead ---
  if (tier === '1') usage.tier1Used = true;
  if (tier === '2') {
    usage.tier2Used = true;
    usage.email = email;
    // TODO: push `email` + sessionId into your CRM/mailing list here.
  }
  usage.designs = (usage.designs || []).concat(designs);
  await kv.set(usageKey, usage, { ex: 60 * 60 * 24 * 30 });

  return res.status(200).json({
    images: designs.map((d) => d.url),
    productTypes: designs.map((d) => d.productType),
    message: tier === '1'
      ? 'Here are your free concepts — 3 beanies, 2 caps and 3 bucket hats.'
      : "Here's your next set — thanks, we'll be in touch.",
  });
};

module.exports.config = {
  api: { bodyParser: false },
};

function parseForm(req) {
  return new Promise((resolve, reject) => {
    const form = formidable({ multiples: false });
    form.parse(req, (err, fields, files) => {
      if (err) return reject(err);
      resolve({ fields, files });
    });
  });
}

async function generateAllDesigns({ logoUrl, primaryColor, secondaryColor, sessionId }) {
  const designs = [];

  for (const [productKey, config] of Object.entries(PRODUCTS)) {
    const mockupUuid = process.env[config.mockupUuidEnvVar];
    if (!mockupUuid) {
      throw new Error(`Missing env var ${config.mockupUuidEnvVar} — upload the ${productKey} PSD to SudoMock and set its mockup UUID.`);
    }

    const mockupData = await getMockup(mockupUuid);
    const variationKeys = config.variationCount === 2
      ? PRODUCT_VARIATIONS.slice(0, 2)
      : PRODUCT_VARIATIONS;

    for (const variationKey of variationKeys) {
      const zoneAssignment = config.colourZones[variationKey];
      const smartObjects = [];

      // Colour zones — resolve each named layer to its uuid, set the hex.
      for (const [layerName, whichColour] of Object.entries(zoneAssignment)) {
        // The beanie's band is handled separately below via image compositing,
        // not a plain colour zone — skip it here.
        if (layerName === 'TOP LABEL BAND') continue;
        const so = findSmartObjectByName(mockupData, layerName);
        const hex = whichColour === 'primary' ? primaryColor : secondaryColor;
        smartObjects.push({ uuid: so.uuid, color: { hex } });
      }

      // Beanie's composited band (wordmark + flat colour) — built fresh per variation.
      if (config.hasCompositeBand) {
        const bandLayer = findSmartObjectByName(mockupData, 'TOP LABEL');
        const bandColourKey = zoneAssignment['TOP LABEL BAND'];
        const bandHex = bandColourKey === 'primary' ? primaryColor : secondaryColor;
        const bandImageBuffer = await buildBandImage(bandHex, bandLayer.size.width, bandLayer.size.height);
        const bandBlob = await put(`bands/${sessionId}-${productKey}-${variationKey}-${Date.now()}.png`, bandImageBuffer, {
          access: 'public',
          contentType: 'image/png',
        });
        smartObjects.push({ uuid: bandLayer.uuid, asset: { url: bandBlob.url, fit: 'fill' } });
      }

      // Customer's logo.
      const logoLayer = findSmartObjectByName(mockupData, config.logoLayerName);
      smartObjects.push({ uuid: logoLayer.uuid, asset: { url: logoUrl, fit: 'fit' } });

      const renderedUrl = await render(mockupUuid, smartObjects);
      designs.push({ url: renderedUrl, productType: productKey, variation: variationKey });
    }
  }

  return designs;
}
