// api/_sudomock-client.js

const BASE_URL = 'https://api.sudomock.com/api/v1';

function headers() {
  return {
    'Content-Type': 'application/json',
    'X-API-KEY': process.env.SUDOMOCK_API_KEY,
  };
}

/**
 * Fetches a mockup's smart object list (name, uuid, size, position).
 * Cache this in production — it doesn't change unless you re-upload the
 * PSD — but kept as a live call here for simplicity and correctness while
 * we're still confirming everything renders as expected.
 */
async function getMockup(mockupUuid) {
  const res = await fetch(`${BASE_URL}/mockups/${mockupUuid}`, {
    headers: headers(),
  });
  if (!res.ok) {
    throw new Error(`SudoMock getMockup failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data.data; // { uuid, smart_objects: [{ uuid, name, layer_name, size, position, ... }] }
}

/**
 * Renders a mockup given a set of smart-object instructions.
 * Each entry: { uuid, asset: { url } } and/or { uuid, color: { hex } }
 */
async function render(mockupUuid, smartObjects) {
  const res = await fetch(`${BASE_URL}/renders`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      mockup_uuid: mockupUuid,
      smart_objects: smartObjects,
    }),
  });
  if (!res.ok) {
    throw new Error(`SudoMock render failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data.data.rendered_image_url;
}

/**
 * Finds a smart object's uuid by its Photoshop layer name. Throws a clear
 * error (rather than silently returning nothing) if the name isn't found,
 * since a renamed layer in Photoshop should surface as an obvious problem,
 * not a silently wrong or missing render.
 */
function findSmartObjectByName(mockupData, layerName) {
  const match = mockupData.smart_objects.find(
    (so) => so.name === layerName || so.layer_name === layerName
  );
  if (!match) {
    throw new Error(
      `Layer "${layerName}" not found on mockup ${mockupData.uuid}. ` +
      `Available layers: ${mockupData.smart_objects.map((s) => s.name).join(', ')}`
    );
  }
  return match;
}

module.exports = { getMockup, render, findSmartObjectByName };
