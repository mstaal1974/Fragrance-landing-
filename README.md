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
| `data.js` | The 32‑scent fragrance library (`window.FRAGS`). |
| `app.js` | Interactive logic — cart, sample‑box builder, drawer, checkout flow, live shipping, order confirmation. |
| `api/shipping.js` | Vercel serverless proxy to the Australia Post PAC domestic‑parcel API. |
| `assets/` | Hero bottle image and the per‑scent product photography wired onto the cards. |

## Behaviour

- **10ml bottles** are a flat **$12** each; add to bag from any card.
- **Sample Box** — pick any **5** scents from across collections for **$50 flat**.
- **Cart drawer** shows bottles and boxes with live subtotal.
- **Shipping** is quoted live from **Australia Post** once a valid AU postcode
  is entered at checkout (see below).
- **Checkout** is a simulated private preview — no real payment is processed.

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
`data.js` (e.g. `img:"assets/erosian-desire.png"`). Four scents have no
supplied photo yet (`Fiery Spice`, `Romance Vintage`, `Marine Absolute`,
`Golden Elixir`) and fall back to the gradient swatch alone — drop a photo
into `assets/` and add its `img` field to wire it in.
