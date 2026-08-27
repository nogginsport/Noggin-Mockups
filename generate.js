// api/generate.js
//
// POST /api/generate
// Body: application/json — {
//   logoBase64: "data:image/png;base64,...",
//   logoMimeType: "image/png",
//   primaryColor, secondaryColor (hex strings, e.g. "#4F6B3F"),
//   tier ("1" | "2"), sessionId, email (tier 2 only)
// }
//
// This deliberately sends the logo as base64 text inside a plain JSON body,
// rather than a raw multipart/form-data file upload. After extensive
// testing, requests WITHOUT a file worked correctly against the deployed
// function, but requests WITH an actual binary file consistently failed
// with no error information at all — pointing at something in how
// Vercel's platform handles raw multipart/binary request bodies
// specifically, rather than anything in our own code (verified working
// correctly, with real files, in local simulation). Sending the file as
// base64 text inside JSON avoids multipart parsing entirely, which is a
// well-established, more portable pattern for exactly this situation.
//
// Produces 8 renders per free set: 3 beanies, 2 caps, 3 bucket hats — each
// using the customer's actual uploaded logo and their two chosen colours,
// rendered from Noggin's real Photoshop templates via SudoMock. See
// _mockup-config.js for exactly which layer gets which colour.

const EXTERNAL_CALL_TIMEOUT_MS = 15000;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ code: 'METHOD_NOT_ALLOWED', message: 'Use POST.' });
  }

  let kv, put, getMockup, render, findSmartObjectByName, buildBandImage, PRODUCTS, PRODUCT_VARIATIONS;
  try {
    ({ kv } = require('@vercel/kv'));
    ({ put } = require('@vercel/blob'));
    ({ getMockup, render, findSmartObjectByName } = require('./_sudomock-client'));
    ({ buildBandImage } = require('./_build-band'));
    ({ PRODUCTS, PRODUCT_VARIATIONS } = require('./_mockup-config'));
  } catch (err) {
    console.error('DEPENDENCY LOAD FAILURE:', err);
    return res.status(500).json({ code: 'DEPENDENCY_ERROR', message: 'A required module failed to load on the server.', debug: String((err && err.stack) || err) });
  }

  try {
    return await handlePost(req, res, { kv, put, getMockup, render, findSmartObjectByName, buildBandImage, PRODUCTS, PRODUCT_VARIATIONS });
  } catch (err) {
    console.error('UNCAUGHT top-level error:', err);
    if (!res.headersSent) {
      return res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Something went wrong generating your mock-ups.', debug: String((err && err.stack) || err) });
    }
  }
};

async function handlePost(req, res, deps) {
  const { kv, put, getMockup, render, findSmartObjectByName, buildBandImage, PRODUCTS, PRODUCT_VARIATIONS } = deps;

  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    console.error('Body parsing failed:', err);
    return res.status(400).json({ code: 'BAD_REQUEST', message: 'Could not read request body.', debug: String((err && err.message) || err) });
  }

  const sessionId = String(body.sessionId || '').trim();
  const tier = String(body.tier || '1').trim();
  const email = body.email ? String(body.email).trim() : null;
  const primaryColor = String(body.primaryColor || '').trim();
  const secondaryColor = String(body.secondaryColor || '').trim();
  const logoBase64 = body.logoBase64;
  const logoMimeType = body.logoMimeType || 'image/png';

  if (!sessionId) return res.status(400).json({ code: 'BAD_REQUEST', message: 'Missing session.' });
  if (!logoBase64) return res.status(400).json({ code: 'BAD_REQUEST', message: 'Missing logo file.' });
  if (!/^#[0-9A-Fa-f]{6}$/.test(primaryColor) || !/^#[0-9A-Fa-f]{6}$/.test(secondaryColor)) {
    return res.status(400).json({ code: 'BAD_REQUEST', message: 'primaryColor and secondaryColor must be hex, e.g. #4F6B3F.' });
  }
  if (tier === '2' && !email) {
    return res.status(400).json({ code: 'EMAIL_REQUIRED', message: 'Add your email to unlock more designs.' });
  }

  let logoBuffer;
  try {
    const base64Data = logoBase64.replace(/^data:[^;]+;base64,/, '');
    logoBuffer = Buffer.from(base64Data, 'base64');
    if (logoBuffer.length === 0) throw new Error('Decoded logo is empty.');
  } catch (err) {
    return res.status(400).json({ code: 'BAD_REQUEST', message: 'Could not decode logo image.', debug: String((err && err.message) || err) });
  }

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

  let logoUrl;
  try {
    const blob = await withTimeout(
      put(`logos/${sessionId}-${Date.now()}.png`, logoBuffer, { access: 'public', contentType: logoMimeType }),
      EXTERNAL_CALL_TIMEOUT_MS,
      'Uploading your logo'
    );
    logoUrl = blob.url;
  } catch (err) {
    console.error('Logo upload failed:', err);
    return res.status(502).json({ code: 'UPLOAD_FAILED', message: 'Could not process your logo.', debug: String((err && err.message) || err) });
  }

  let designs;
  try {
    designs = await generateAllDesigns({ logoUrl, primaryColor, secondaryColor, sessionId, put, getMockup, render, findSmartObjectByName, buildBandImage, PRODUCTS, PRODUCT_VARIATIONS });
  } catch (err) {
    console.error('Mock-up generation failed:', err);
    return res.status(502).json({ code: 'GENERATION_FAILED', message: 'Could not generate mock-ups right now.', debug: String((err && err.message) || err) });
  }

  if (tier === '1') usage.tier1Used = true;
  if (tier === '2') {
    usage.tier2Used = true;
    usage.email = email;
  }
  usage.designs = (usage.designs || []).concat(designs);
  try {
    await withTimeout(kv.set(usageKey, usage, { ex: 60 * 60 * 24 * 30 }), EXTERNAL_CALL_TIMEOUT_MS, 'Saving session storage');
  } catch (err) {
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

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

async function generateAllDesigns({ logoUrl, primaryColor, secondaryColor, sessionId, put, getMockup, render, findSmartObjectByName, buildBandImage, PRODUCTS, PRODUCT_VARIATIONS }) {
  const designs = [];

  for (const [productKey, config] of Object.entries(PRODUCTS)) {
    const mockupUuid = process.env[config.mockupUuidEnvVar];
    if (!mockupUuid) {
      throw new Error(`Missing env var ${config.mockupUuidEnvVar} — upload the ${productKey} PSD to SudoMock and set its mockup UUID.`);
    }

    const mockupData = await withTimeout(getMockup(mockupUuid), EXTERNAL_CALL_TIMEOUT_MS, `Fetching ${productKey} mockup data`);
    const variationKeys = config.variationCount === 2 ? PRODUCT_VARIATIONS.slice(0, 2) : PRODUCT_VARIATIONS;

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
