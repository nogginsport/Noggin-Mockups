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
//
// IMPORTANT: the entire body of this handler runs inside one big try/catch
// (see bottom of file). This is deliberate — CORS headers are set right at
// the top, but if anything after that throws uncaught, the platform's own
// error page can replace our response and silently drop those headers,
// which shows up in the browser as a bare "Failed to fetch" with zero
// information about what actually went wrong. Wrapping everything, and
// putting a timeout on every external call, guarantees we always send back
// a real JSON response with the headers intact — even when something
// upstream (KV, Blob, SudoMock) is slow, misconfigured, or unreachable.

const { formidable } = require('formidable');
const fs = require('fs');
const { kv } = require('@vercel/kv');
const { put } = require('@vercel/blob');
const { getMockup, render, findSmartObjectByName } = require('./_sudomock-client');
const { buildBandImage } = require('./_build-band');
const { PRODUCTS, PRODUCT_VARIATIONS } = require('./_mockup-config');

const EXTERNAL_CALL_TIMEOUT_MS = 15000;

module.exports = async (req, res) => {
  // CORS — set FIRST, before anything that could possibly throw, and again
  // this is why the whole rest of the function is wrapped below: nothing
  // that happens later is allowed to prevent a real, headers-intact
  // response from being sent.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ code: 'METHOD_NOT_ALLOWED', message: 'Use POST.' });
  }

  try {
    return await handlePost(req, res);
  } catch (err) {
    // Absolute last resort — should rarely fire given the handling inside
    // handlePost, but guarantees we NEVER return a bare crash with no
    // CORS headers, no matter what goes wrong.
    console.error('UNCAUGHT top-level error:', err);
    if (!res.headersSent) {
      return res.status(500).json({
        code: 'INTERNAL_ERROR',
        message: 'Something went wrong generating your mock-ups.',
        debug: String((err && err.message) || err),
      });
    }
  }
};

module.exports.config = {
  api: { bodyParser: false },
};

async function handlePost(req, res) {
  let fields, files;
  try {
    ({ fields, files } = await withTimeout(parseForm(req), EXTERNAL_CALL_TIMEOUT_MS, 'Reading the upload'));
  } catch (err) {
    console.error('Upload parsing failed:', err);
    return res.status(400).json({ code: 'BAD_REQUEST', message: 'Could not read upload.', debug: String((err && err.message) || err) });
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
  let usage;
  try {
    usage = (await withTimeout(kv.get(usageKey), EXTERNAL_CALL_TIMEOUT_MS, 'Checking session storage')) || { tier1Used: false, tier2Used: false };
  } catch (err) {
    console.error('KV read failed:', err);
    return res.status(502).json({ code: 'STORAGE_ERROR', message: 'Could not reach session storage.', debug: String((err && err.message) || err) });
  }

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
    const blob = await withTimeout(
      put(`logos/${sessionId}-${Date.now()}.png`, logoBuffer, { access: 'public', contentType: logoFile.mimetype || 'image/png' }),
      EXTERNAL_CALL_TIMEOUT_MS,
      'Uploading your logo'
    );
    logoUrl = blob.url;
  } catch (err) {
    console.error('Logo upload failed:', err);
    return res.status(502).json({ code: 'UPLOAD_FAILED', message: 'Could not process your logo.', debug: String((err && err.message) || err) });
  }

  // --- Generate all 8 designs ---
  let designs;
  try {
    designs = await generateAllDesigns({ logoUrl, primaryColor, secondaryColor, sessionId });
  } catch (err) {
    console.error('Mock-up generation failed:', err);
    return res.status(502).json({ code: 'GENERATION_FAILED', message: 'Could not generate mock-ups right now.', debug: String((err && err.message) || err) });
  }

  // --- Record usage + lead ---
  if (tier === '1') usage.tier1Used = true;
  if (tier === '2') {
    usage.tier2Used = true;
    usage.email = email;
    // TODO: push `email` + sessionId into your CRM/mailing list here.
  }
  usage.designs = (usage.designs || []).concat(designs);
  try {
    await withTimeout(kv.set(usageKey, usage, { ex: 60 * 60 * 24 * 30 }), EXTERNAL_CALL_TIMEOUT_MS, 'Saving session storage');
  } catch (err) {
    // Don't fail the whole request over this — the customer already has
    // their designs, worst case the rate limit doesn't stick this once.
    console.error('KV write failed (non-fatal):', err);
  }

  return res.status(200).json({
    images: designs.map((d) => d.url),
    productTypes: designs.map((d) => d.productType),
    message: tier === '1'
      ? 'Here are your free concepts — 3 beanies, 2 caps and 3 bucket hats.'
      : "Here's your next set — thanks, we'll be in touch.",
  });
}

function parseForm(req) {
  return new Promise((resolve, reject) => {
    const form = formidable({ multiples: false });
    form.parse(req, (err, fields, files) => {
      if (err) return reject(err);
      resolve({ fields, files });
    });
  });
}

/** Wraps any promise so it rejects with a clear message instead of hanging forever. */
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

async function generateAllDesigns({ logoUrl, primaryColor, secondaryColor, sessionId }) {
  const designs = [];

  for (const [productKey, config] of Object.entries(PRODUCTS)) {
    const mockupUuid = process.env[config.mockupUuidEnvVar];
    if (!mockupUuid) {
      throw new Error(`Missing env var ${config.mockupUuidEnvVar} — upload the ${productKey} PSD to SudoMock and set its mockup UUID.`);
    }

    const mockupData = await withTimeout(getMockup(mockupUuid), EXTERNAL_CALL_TIMEOUT_MS, `Fetching ${productKey} mockup data`);
    const variationKeys = config.variationCount === 2
      ? PRODUCT_VARIATIONS.slice(0, 2)
      : PRODUCT_VARIATIONS;

    for (const variationKey of variationKeys) {
      const zoneAssignment = config.colourZones[variationKey];
      const smartObjects = [];

      for (const [layerName, whichColour] of Object.entries(zoneAssignment)) {
        if (layerName === 'TOP LABEL BAND') continue;
        const so = findSmartObjectByName(mockupData, layerName);
        const hex = whichColour === 'primary' ? primaryColor : secondaryColor;
        smartObjects.push({ uuid: so.uuid, color: { hex } });
      }

      if (config.hasCompositeBand) {
        const bandLayer = findSmartObjectByName(mockupData, 'TOP LABEL');
        const bandColourKey = zoneAssignment['TOP LABEL BAND'];
        const bandHex = bandColourKey === 'primary' ? primaryColor : secondaryColor;
        const bandImageBuffer = await buildBandImage(bandHex, bandLayer.size.width, bandLayer.size.height);
        const bandBlob = await withTimeout(
          put(`bands/${sessionId}-${productKey}-${variationKey}-${Date.now()}.png`, bandImageBuffer, { access: 'public', contentType: 'image/png' }),
          EXTERNAL_CALL_TIMEOUT_MS,
          'Uploading generated band image'
        );
        smartObjects.push({ uuid: bandLayer.uuid, asset: { url: bandBlob.url, fit: 'fill' } });
      }

      const logoLayer = findSmartObjectByName(mockupData, config.logoLayerName);
      smartObjects.push({ uuid: logoLayer.uuid, asset: { url: logoUrl, fit: 'fit' } });

      const renderedUrl = await withTimeout(render(mockupUuid, smartObjects), EXTERNAL_CALL_TIMEOUT_MS, `Rendering ${productKey} ${variationKey}`);
      designs.push({ url: renderedUrl, productType: productKey, variation: variationKey });
    }
  }

  return designs;
}
