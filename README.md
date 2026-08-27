# Noggin mock-up backend

Generates real, accurate mock-ups for beanies, caps and bucket hats using
your actual Photoshop templates — via [SudoMock](https://sudomock.com),
which renders your `.psd` files directly rather than guessing with AI.
Every render uses the customer's real uploaded logo and their two chosen
colours (primary/secondary), mapped onto the exact layers we confirmed
directly against your files.

## What this produces

One free "generate" click returns **8 designs**: 3 beanie variations,
2 cap variations, 3 bucket hat variations — each a genuine render of your
real template, not an approximation.

## Setup

### 1. Upload your three PSDs to SudoMock

In the SudoMock dashboard (PSD Mockup Editor → Upload), upload:
- `3d_Beanie.psd` (with the `CROWN COLOR` / `CUFF COLOR` split done)
- `Tiff_Baseball_.psd` (the cap, with `PEAK` activated)
- `3D_Bucket_Hat_New_.psd`

Each one gets a **Mockup UUID** once uploaded — copy these down, you'll need
them for step 3.

### 2. Deploy this backend to Vercel

Same process as before: push to GitHub, import into Vercel, connect KV and
Blob storage (already done if you followed the earlier steps).

### 3. Set environment variables

In Vercel → Settings → Environment Variables, add:

| Variable | Value |
|---|---|
| `SUDOMOCK_API_KEY` | From SudoMock → API Keys |
| `SUDOMOCK_BEANIE_MOCKUP_UUID` | From step 1 |
| `SUDOMOCK_CAP_MOCKUP_UUID` | From step 1 |
| `SUDOMOCK_BUCKET_HAT_MOCKUP_UUID` | From step 1 |

### 4. Bucket hat crest layer — already renamed

The bucket hat's crest layer has been renamed to `BUCKET HAT CREST` in
Photoshop (confirmed) to avoid the ambiguity of three identically-named
"BUCKET HAT DESIGN" layers. `_mockup-config.js` already references this
exact name — no further action needed here.

### 5. Redeploy

Once the env vars and layer rename are done, redeploy so everything picks
up the new configuration.

## How the colour zones work

See `api/_mockup-config.js` — it's the single source of truth mapping each
product's real Photoshop layers to "primary" or "secondary" across the
different variations. If you ever want to adjust which layer gets which
colour, or add more variations, that's the only file you need to touch.

## The beanie's band

The striped band ("TOP LABEL") lives inside a nested Smart Object that
SudoMock can't reach into directly. Rather than restructuring that Smart
Object in Photoshop, `api/_build-band.js` builds the band as a flat image
at request time — the customer's secondary colour, with the real "noggin"
wordmark (exported once, stored in `/assets/noggin-wordmark.png`)
composited on top — and sends that as the replacement image. No Photoshop
changes needed for this part.

## Testing before going live

1. Upload a real logo through the Shopify site once this is all wired up.
2. Check all 8 renders actually reflect your chosen colours and the real logo.
3. Specifically check the bucket hat crest lands in the right spot (this is
   the one area with a naming ambiguity — see step 4 above).
4. Check the beanie's band looks right — flat colour + wordmark, sized
   sensibly. If the wordmark looks too big/small, adjust the `0.55` ratio
   in `_build-band.js`.

## Getting submissions to Monday.com

Once a customer picks their favourite design, they're sent to your Typeform
with `design_url`, `product_type`, and `ref` (session ID) as hidden fields
— see the earlier setup notes. Typeform's native Monday.com integration can
map `design_url` straight into a Link-type column so your team can click
straight through to the exact design.
