# Maison Obsidian — 10ml Discovery Drop

A private "family & friends" preview storefront for the Maison Obsidian
fragrance library. Every scent is poured into a flat‑priced 10ml discovery
bottle so people can try before committing to a full pour.

This is a self‑contained static site — no build step. Open `index.html`
directly, or serve the folder with any static file server.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page markup: header, hero, sample‑box builder, three collections, checkout, confirmation, cart drawer. |
| `styles.css` | All styling, faithful to the Claude Design handoff (dark obsidian palette, Cormorant Garamond / Hanken Grotesk / Space Mono). |
| `data.js` | The 32‑scent fragrance library (`window.FRAGS`). |
| `app.js` | Interactive logic — cart, sample‑box builder, drawer, checkout flow, order confirmation. |
| `assets/` | Hero bottle image and the one product photo used by the design. |

## Behaviour

- **10ml bottles** are a flat **$12** each; add to bag from any card.
- **Sample Box** — pick any **5** scents from across collections for **$50 flat**.
- **Cart drawer** shows bottles and boxes with live subtotal.
- **Checkout** is a simulated private preview — no real payment is processed.

## Product photography

28 of the 32 scents show a real product photo (clean-named copies live in
`assets/products/`, mapped to each scent by its `img` field in `data.js`).
Photos are studio shots on white, so cards render them in a white "product
frame" (contain-fit) that sits cleanly against the dark theme.

Four scents have no supplied photo (Spicebomb Extreme, YSL Paris, Acqua di
Giò Absolu, Le Male Elixir) and fall back to the design's gradient "liquid"
swatch. To add one, drop the image in `assets/products/` and set the `img`
field on that entry in `data.js`.
