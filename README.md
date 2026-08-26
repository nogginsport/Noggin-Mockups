# Noggin mock-up backend

Small serverless service that generates the mock-up sets for the
Shopify site's mock-up generator — 9 designs per free set (3 beanies,
3 caps, 3 bucket hats). Kept separate from Shopify on purpose —
Shopify can't run custom server code, so this is where the image-generation
API key lives, where the free/email-gated limit is enforced, and where
generated images get saved permanently (so a customer's choice still
resolves correctly days later, not just in the minutes after generation).

This is plain Node.js. Deploy it wherever you like — these steps assume
Vercel since it's the fastest path.

## Deploy (Vercel)

1. Push this folder to its own GitHub repo.
2. Import it into Vercel (vercel.com → New Project).
3. Add a Vercel KV store to the project (Storage tab → Create → KV) —
   tracks free/email-gated usage per session, and which designs were
   generated for that session.
4. Add Vercel Blob storage to the project (Storage tab → Create → Blob) —
   this is where generated images get saved permanently. Vercel wires up
   the required token automatically.
5. Add environment variables in Vercel project settings:
   - `IMAGE_API_KEY` — your chosen image-generation provider's key
   - `TIER_1_MODEL` — cheap model for the free first batch (optional, has a default)
   - `TIER_2_MODEL` — better model for the email-gated batch (optional, has a default)
6. Deploy. You'll get a URL like `https://noggin-mockups.vercel.app`.
7. In the Shopify theme editor, open the "Mock-up generator" section:
   - Paste `https://noggin-mockups.vercel.app/api/generate` into "Mock-up backend URL"
   - Paste your Typeform URL into "Order form (Typeform) URL" — see below

## Setting up the Typeform hand-off

The goal: when a customer picks their favourite of the 9 designs, they land
on your order-details Typeform with that exact design already attached, so
your team can see both the order details and the design together.

1. In the Typeform builder, go to **Settings → Hidden fields** and add
   three hidden fields: `ref`, `design_url`, `product_type`.
2. (Optional but recommended) Add a **Question** near the top of the form
   that displays `{{hidden:design_url}}` so the customer sees a visual
   confirmation of what they picked before continuing.
3. That's it on the Typeform side — the theme's JS fills these fields
   automatically via the URL when someone clicks "Choose this" under a
   design.
4. Every Typeform submission will now include the `design_url` — a
   permanent link to the exact image the customer chose — right alongside
   their quantity, delivery details, and contact info.

## Getting submissions somewhere useful

Typeform's own native integrations (Notifications, Google Sheets, Slack,
Zapier/Make) can all pick up `design_url` as just another form field, so
whichever one you choose will show the design link right there in the
notification/row/message — no custom code needed for this part.

## Before going live

- [ ] Confirm which image-generation provider/model you're using and
      update `api/generate.js` to match its actual API shape.
- [ ] Wire up lead capture where marked with `TODO` (push tier-2 emails
      into your CRM / mailing list).
- [ ] Add CORS headers restricting this endpoint to your actual Shopify
      domain, not `*`.
- [ ] Add basic file-type/size validation on the uploaded logo.
- [ ] Load-test the rate limiter — it's keyed on a client-generated
      session ID stored in sessionStorage, which is enough to stop casual
      abuse but not a determined bad actor; add an IP-based backstop if
      that becomes a problem in practice.
- [ ] Build the Typeform, add the 3 hidden fields above, and test the
      full click-through from a generated design.
