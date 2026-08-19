# Maison Obsidian — 10ml Discovery Drop

A private "family & friends" preview storefront for the Maison Obsidian
fragrance library. Every scent is poured into a flat‑priced 10ml discovery
bottle so people can try before committing to a full pour.

The storefront is a self‑contained static site — no build step. Open
`index.html` directly, or serve the folder with any static file server. Live
shipping rates additionally need the serverless function under `api/` (see
**Shipping** below); without it the site still works and simply shows no
shipping cost.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page markup: header, hero, sample‑box builder, three collections, checkout, confirmation, cart drawer. |
| `styles.css` | All styling, faithful to the Claude Design handoff (dark obsidian palette, Cormorant Garamond / Hanken Grotesk / Space Mono). |
| `data.js` | The 33‑scent fragrance library (`window.FRAGS`). |
| `app.js` | Interactive logic — cart, sample‑box builder, drawer, checkout flow, live shipping, Stripe redirect, order confirmation. |
| `api/checkout.js` | Vercel serverless function that creates a Stripe Checkout Session (prices recomputed server‑side) and returns the hosted payment URL. |
| `api/order.js` | Vercel serverless function that verifies a Stripe session on return, so the confirmation screen only shows after a real payment. |
| `api/webhook.js` | Vercel serverless function that receives Stripe webhooks (signature‑verified) and fulfils paid orders — the reliable source of truth even if the buyer never returns. |
| `api/_supabase.js` | Shared helper that reads/writes Supabase via its REST API (service‑role key, server‑side only). |
| `api/request.js` | Vercel serverless function that stores a fragrance request in Supabase. |
| `api/requests.js` | Vercel serverless function — token‑gated admin list of requests, read by `admin.html`. |
| `api/orders.js` | Vercel serverless function — token‑gated admin list of paid orders, read by `admin.html`. |
| `catalogue.json` | The searchable wholesale library (3,060 fragrances) powering the Request section. |
| `admin.html` | Standalone admin view — Requests and Orders tabs (gated by `ADMIN_TOKEN`). |
| `privacy.html` | Privacy Policy (Australian Privacy Principles), linked in the footer. |
| `refunds.html` | Refunds &amp; Returns Policy (Australian Consumer Law), linked in the footer. |
| `supabase/schema.sql` | One‑time SQL to create the `orders` and `fragrance_requests` tables. |
| `api/shipping.js` | Vercel serverless proxy to the Australia Post PAC domestic‑parcel API. |
| `api/_auspost.js` | Shared Australia Post quote helper used by `shipping.js` and `checkout.js`. |
| `assets/` | Hero bottle image and the per‑scent product photography wired onto the cards. |

## Behaviour

- **10ml bottles** are a flat **$12** each; add to bag from any card.
- **Sample Box** — pick any **5** scents from across collections for **$50 flat**.
- **Cart drawer** shows bottles and boxes with live subtotal.
- **Shipping** is quoted live from **Australia Post** once a valid AU postcode
  is entered at checkout (see below).
- **Checkout** takes real payment through **Stripe** — see below.

## Payments (Stripe)

Checkout uses **Stripe Checkout** in its hosted (redirect) mode. Pressing
**Place Order** POSTs the bag to `api/checkout.js`, which recomputes every
amount server‑side — item prices from fixed constants (`$12` per bottle, `$50`
per box) and shipping from Australia Post — creates a Stripe Checkout Session,
and returns its URL. The browser is redirected to Stripe's secure page to enter
card details, so **no card data ever touches this site** (PCI SAQ A).

On success Stripe returns the buyer to `/?paid={CHECKOUT_SESSION_ID}`;
`app.js` then calls `api/order.js`, which retrieves the session server‑side and
only shows the confirmation once Stripe reports `payment_status: "paid"` (the
redirect alone is never trusted). Cancelling on Stripe returns to
`/?checkout=cancelled` with the bag intact.

**Setup (Vercel):**

1. Get your keys from the Stripe Dashboard (start in **test mode**).
2. In your Vercel project → **Settings → Environment Variables**, set:
   - `STRIPE_SECRET_KEY` — `sk_test_…` (or `sk_live_…` when live). Required.
   - `STRIPE_CURRENCY` — ISO code, optional, defaults to `aud`.
   - `STRIPE_RETURN_ORIGIN` — optional; only to pin a canonical domain.
   See `.env.example`. Redeploy after adding variables.
3. Test with Stripe's card `4242 4242 4242 4242`, any future expiry and CVC.

To point the front‑end at different endpoints, set
`window.MO_CONFIG = { checkoutEndpoint: "…", orderEndpoint: "…" }` before
`app.js` loads. If `STRIPE_SECRET_KEY` is missing, Place Order surfaces a clear
error instead of proceeding.

Checkout builds one line item per scent with ad‑hoc `price_data`, so each
fragrance appears by name on the Stripe checkout and receipt (e.g. "Smoky
Obsidian — 10ml"). No Stripe products need to be created or maintained.

**Switching to on‑page card fields:** this uses hosted redirect (simplest, most
secure). To keep buyers on the page instead, swap to Stripe's embedded
**Payment Element** — load `stripe.js`, have `checkout.js` create a
PaymentIntent (returning its `client_secret`), and mount the element in the
Payment block. The server‑side price recomputation stays the same.

### Webhook fulfilment (recommended)

The return page (`api/order.js`) is fine for showing a confirmation, but a buyer
can pay and then close the tab before the redirect — so it must not be the only
record that an order happened. `api/webhook.js` receives Stripe's
`checkout.session.completed` event server‑to‑server and is the reliable place to
fulfil. It verifies the `Stripe‑Signature` header with an HMAC‑SHA256 of
`${timestamp}.${rawBody}` (Node `crypto`, no SDK), rejects anything unsigned or
stale, then calls `fulfilOrder(session)`.

`checkout.js` attaches order details to the session as `metadata` (buyer name,
shipping address, postcode, and an item summary), so the webhook can act without
re‑reading anything. `fulfilOrder` then **saves the order to Supabase** (see
below). Stripe can deliver an event more than once, so the write is an
idempotent upsert keyed on the Stripe session id.

**Setup:**

1. Deploy, so `https://<your-domain>/api/webhook` exists.
2. Stripe Dashboard → **Developers → Webhooks → Add endpoint**. URL =
   `https://maisonobsidian.com.au/api/webhook`; select event
   `checkout.session.completed` (optionally `checkout.session.async_payment_succeeded`).
3. Copy the endpoint's **Signing secret** (`whsec_…`) into Vercel as
   `STRIPE_WEBHOOK_SECRET`, then redeploy.
4. Test locally with the Stripe CLI: `stripe listen --forward-to
   localhost:3000/api/webhook` then `stripe trigger checkout.session.completed`.
   The CLI prints its own `whsec_…` to use while listening.

Body parsing is disabled for this route (`config.api.bodyParser = false`) because
signature verification needs the exact raw bytes Stripe signed.

### Storing orders (Supabase)

Paid orders are written to a Supabase Postgres table by the webhook, via
`api/_supabase.js`, which calls Supabase's REST API with `fetch` (no
`@supabase/supabase-js` dependency). It uses the **service_role** key, which
bypasses Row Level Security — so it lives only in the serverless function and is
never exposed to the browser. The write is an idempotent upsert on
`stripe_session_id`.

If `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` are unset, the webhook still
verifies and returns 200 — it just logs the order instead of saving it, so
nothing breaks before the database is wired up.

**Setup:**

1. Create a project at <https://supabase.com/>.
2. Supabase Dashboard → **SQL → New query**, paste `supabase/schema.sql`, run it.
   That creates the `orders` table (with a unique `stripe_session_id` and RLS
   enabled — no public access).
3. Supabase → **Settings → API**: copy the **Project URL** and the
   **`service_role`** key.
4. In Vercel → Settings → Environment Variables, set `SUPABASE_URL` and
   `SUPABASE_SERVICE_ROLE_KEY` (Production), then redeploy.
5. Place a test order — the row appears in **Table editor → orders**.

The `orders` columns mirror the session metadata (`email`, `name`,
`amount_total` in cents, `currency`, `items`, `ship_*`, `status`,
`stripe_session_id`, `payment_intent_id`, `created_at`). To email a receipt as
well, add a mailer call inside `fulfilOrder` after the Supabase write.

## Request a Fragrance (full library)

Below the three collections, the **Request a Fragrance** section lets visitors
search the full sourcing library — 3,060 fragrances in `catalogue.json` — by
brand or name. Results are **grouped by brand, then fragrance** (A–Z) so the
list is easy to scan. `catalogue.json` is fetched lazily (on first focus of the
search box) and filtered client‑side, so it never slows the initial page load.

The same search also appears as a **popup that auto‑opens once per session,
~10 seconds** after load — only while the visitor is still browsing the shop and
nothing else is open (a `sessionStorage` flag stops it reappearing). The inline
section stays in place regardless; the popup is an additional prompt, not a
replacement.

Picking a result opens a request modal (name, email, quantity, note). Submitting
POSTs to `api/request.js`, which validates and stores the enquiry in Supabase's
`fragrance_requests` table — each row **correlated to the specific fragrance**
(name, brand, size, price, product id) so you know exactly what was asked for.
Requests need Supabase configured (see below); without it the endpoint returns a
clear "not enabled yet" message rather than dropping the enquiry silently.

### Admin view

`/admin.html` is a standalone page to review requests. Enter the admin token and
it calls `api/requests.js` (which checks the token against `ADMIN_TOKEN` in a
constant‑time compare) and renders the requests newest‑first, with a CSV export
and `mailto:` links. Set a long random `ADMIN_TOKEN` in Vercel.

This is a lightweight shared‑secret gate suitable for a private preview — the
secure source of truth is always the **Supabase dashboard** (Table editor →
`fragrance_requests`), which you can use instead of, or alongside, `admin.html`.
To regenerate `catalogue.json` from an updated spreadsheet, re‑export the same
`{id,n,b,s,p}` shape (name `n`, brand `b`, size `s`, price `p`).

## Delivery options

Checkout offers two delivery methods. **Ship via Australia Post** is the default
and quotes a live rate (below). **Arrange alternate delivery** — for this
family‑&‑friends drop — hides the postal address, shows a free‑text field for
hand‑delivery / via‑a‑friend details, charges **no postage**, and records the
method and notes on the order (`delivery_method` / `delivery_notes`, shown in the
admin Orders tab and stored in Supabase).

## Shipping (Australia Post PAC)

At checkout, entering a 4‑digit Australian postcode fetches the cheapest
domestic parcel rate from Australia Post's **Postage Assessment Calculator**
and adds it to the order total.

The parcel size and weight are computed from the actual order (`parcelSpec()`
in `app.js`). Each item is 100mm on its longest side, so the parcel is packed
length‑aligned: sample boxes (`100 × 100 × 20 mm`, 200 g) stack flat, loose
bottles (`100 × 20 × 20 mm`, 35 g) pack in rows of up to five across, and the
two blocks stack. The resulting bounding box (cm) and summed weight (kg) are
sent to the API. E.g. two loose bottles → `10 × 4 × 2 cm`, `0.07 kg`.

The browser **cannot** call Australia Post directly — the PAC API sends no CORS
headers and the API key must stay secret — so requests go through
`api/shipping.js`, a Vercel serverless function that holds the key server‑side,
calls the PAC `service` endpoint, and returns the cheapest service.

**Setup (Vercel):**

1. Get a PAC API key at <https://developers.auspost.com.au/>.
2. In your Vercel project → **Settings → Environment Variables**, set:
   - `AUSPOST_API_KEY` — your PAC key (required).
   - `AUSPOST_FROM_POSTCODE` — dispatch postcode (optional, defaults to `3000`).
   See `.env.example`. Deploy — Vercel serves the static files and exposes the
   function at `/api/shipping` automatically (zero‑config).

To point the front‑end at a different endpoint, set
`window.MO_CONFIG = { shippingEndpoint: "https://…" }` before `app.js` loads.
If the endpoint is unreachable or the key is missing, checkout degrades
gracefully: the shipping line reads *Unavailable* and the total is the
merchandise subtotal only.

## Notes

Each card layers the real Maison Obsidian product photograph over the
design's gradient "liquid" swatch, via the `img` field on entries in
`data.js` (e.g. `img:"assets/erosian-desire.png"`). The original 32 scents all
have a photo wired in; the product images have transparent backgrounds so the
bottles sit directly on the dark cards. Velvet Bloom (`f33`) has no photo yet,
so its card falls back to the gradient swatch alone. To add or swap one, drop a
PNG into `assets/` and set its `img` field.
