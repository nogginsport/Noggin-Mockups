// POST /api/generate
// Body: multipart/form-data — logo (file), tier ("1" | "2"), sessionId (string), email (string, tier 2 only)
//
// Enforces, server-side, the limit the front end can't be trusted to enforce:
//   - Tier 1: one free generation per session (9 designs: 3 beanies, 3 caps,
//     3 bucket hats), no email required
//   - Tier 2: one additional generation per session, requires an email on file
//
// Env vars required (set in Vercel project settings):
//   IMAGE_API_KEY        — your image-generation provider's API key
//   KV_REST_API_URL       — provided automatically if you add Vercel KV
//   KV_REST_API_TOKEN     — provided automatically if you add Vercel KV
//
// NOTE: verify exact request/response shape against your chosen image
// provider's current docs before going live — model names, parameter
// names and endpoints shift over time and are not guaranteed by this file.

const formidable = require('formidable');
const fs = require('fs');
const { kv } = require('@vercel/kv');
const { put } = require('@vercel/blob');

// Cheaper/faster model for the free first batch, higher-quality model for
// the email-gated second batch. Swap these for whichever provider/model
// you land on after comparing pricing.
const TIER_MODELS = {
  1: process.env.TIER_1_MODEL || 'gpt-image-1-mini',
  2: process.env.TIER_2_MODEL || 'gpt-image-1',
};

// One free set = 3 beanies + 3 caps + 3 bucket hats = 9 designs total.
const PRODUCT_TYPES = ['beanie', 'cap', 'bucket hat'];
const DESIGNS_PER_PRODUCT = 3;

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ code: 'METHOD_NOT_ALLOWED', message: 'Use POST.' });
  }

  let fields, files;
  try {
    ({ fields, files } = await parseForm(req));
  } catch (err) {
    return res.status(400).json({ code: 'BAD_REQUEST', message: 'Could not read upload.' });
  }

  const sessionId = String(fields.sessionId || '').trim();
  const tier = String(fields.tier || '1').trim();
  const email = fields.email ? String(fields.email).trim() : null;
  const logoFile = files.logo;

  if (!sessionId) {
    return res.status(400).json({ code: 'BAD_REQUEST', message: 'Missing session.' });
  }
  if (!logoFile) {
    return res.status(400).json({ code: 'BAD_REQUEST', message: 'Missing logo file.' });
  }
  if (tier === '2' && !email) {
    return res.status(400).json({ code: 'EMAIL_REQUIRED', message: 'Add your email to unlock more designs.' });
  }

  // --- Server-side rate limit: the part the JS file can't enforce ---
  const usageKey = `noggin:mockup:${sessionId}`;
  const usage = (await kv.get(usageKey)) || { tier1Used: false, tier2Used: false };

  if (tier === '1' && usage.tier1Used) {
    return res.status(429).json({
      code: 'LIMIT_REACHED',
      message: "You've already used your free set of 9 for this session. Add your email for more.",
    });
  }
  if (tier === '2' && usage.tier2Used) {
    return res.status(429).json({
      code: 'LIMIT_REACHED',
      message: "You've already unlocked your second set for this session.",
    });
  }

  // --- Generate ---
  let designs;
  try {
    const logoBuffer = fs.readFileSync(logoFile.filepath);
    designs = await generateMockups({
      logoBuffer,
      model: TIER_MODELS[tier] || TIER_MODELS[1],
      sessionId,
      tier,
    });
  } catch (err) {
    console.error('Mock-up generation failed', err);
    return res.status(502).json({ code: 'GENERATION_FAILED', message: 'Could not generate mock-ups right now.' });
  }

  // --- Record usage + lead + the designs themselves (so a later Typeform
  // submission can be matched back to what was actually generated) ---
  if (tier === '1') usage.tier1Used = true;
  if (tier === '2') {
    usage.tier2Used = true;
    usage.email = email;
    // TODO: also push `email` + sessionId into your CRM / email list here,
    // since this is the point someone becomes a real lead.
  }
  usage.designs = (usage.designs || []).concat(designs);
  await kv.set(usageKey, usage, { ex: 60 * 60 * 24 * 30 }); // keep for 30 days — long enough to cover the order/approval window

  return res.status(200).json({
    images: designs.map((d) => d.url),
    productTypes: designs.map((d) => d.productType),
    message: tier === '1'
      ? 'Here are your 9 free concepts — 3 beanies, 3 caps and 3 bucket hats.'
      : "Here's your next set — thanks, we'll be in touch.",
  });
};

module.exports.config = {
  api: { bodyParser: false }, // required so formidable can read multipart data
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

// Calls the image generation provider for each product type, 3 variations
// each, then immediately re-uploads every result to permanent storage.
// This matters: the AI provider's own image URLs are temporary (often
// expire within an hour), but a customer might not fill in the order form
// — or you might not review it — until well after that. Written against
// the shape of OpenAI's images API as a working example — swap for
// whichever provider you choose and double-check current parameter names
// before deploying.
async function generateMockups({ logoBuffer, model, sessionId, tier }) {
  const designs = [];

  for (const productType of PRODUCT_TYPES) {
    for (let i = 0; i < DESIGNS_PER_PRODUCT; i++) {
      const prompt = [
        `Photorealistic product mock-up of a knit ${productType} worn outdoors,`,
        'with the provided logo embroidered cleanly on the front centre panel.',
        `Studio-quality lighting, neutral background, no text other than the logo.`,
        `Variation ${i + 1} of ${DESIGNS_PER_PRODUCT}: different colourway.`,
      ].join(' ');

      const response = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.IMAGE_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model, prompt, size: '1024x1024', n: 1 }),
      });
      if (!response.ok) throw new Error(`Image API error: ${response.status}`);
      const result = await response.json();

      // TODO: confirm against your provider's actual response shape —
      // this assumes a temporary URL or base64 payload comes back.
      const tempUrl = result.data[0].url;
      const imageBytes = tempUrl
        ? await fetch(tempUrl).then((r) => r.arrayBuffer())
        : Buffer.from(result.data[0].b64_json, 'base64');

      const filename = `mockups/${sessionId}/${productType.replace(/\s+/g, '-')}-${i + 1}-${Date.now()}.png`;
      const blob = await put(filename, Buffer.from(imageBytes), {
        access: 'public',
        contentType: 'image/png',
      });

      designs.push({ url: blob.url, productType, tier });
    }
  }

  return designs;
}
