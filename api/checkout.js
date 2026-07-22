/* Vercel serverless function — create a Stripe Checkout Session.
 *
 * The browser POSTs the cart (quantities only) plus the shipping postcode and
 * parcel dimensions. This function RECOMPUTES every amount server-side — item
 * prices from fixed constants and shipping from Australia Post — so a tampered
 * client can never set its own price. It then creates a Stripe Checkout Session
 * and returns the hosted payment URL to redirect to. Card data never touches
 * this site (PCI SAQ A): Stripe collects it on their page.
 *
 * Env:
 *   STRIPE_SECRET_KEY     (required)  — sk_test_… / sk_live_…
 *   STRIPE_CURRENCY       (optional)  — ISO code, default "aud"
 *   STRIPE_RETURN_ORIGIN  (optional)  — absolute origin for success/cancel URLs
 *                                       (defaults to the request's own origin)
 *   AUSPOST_API_KEY / AUSPOST_FROM_POSTCODE — see _auspost.js (shipping)
 *
 * Response:
 *   200 { ok:true,  url:"https://checkout.stripe.com/…", id:"cs_…" }
 *   4xx/5xx { ok:false, error:"..." }
 */

var auspost = require("./_auspost");

var PRICE = 1200;       // one 10ml discovery bottle, in cents
var BOX_PRICE = 5000;   // one 5-scent sample box, in cents
var CURRENCY = (process.env.STRIPE_CURRENCY || "aud").toLowerCase();
var MAX_QTY = 99;       // sanity cap per line

function bad(res, status, error) {
  res.status(status).json({ ok: false, error: error });
}

// Encode a nested object into Stripe's application/x-www-form-urlencoded
// bracket notation, e.g. line_items[0][price_data][currency]=aud.
function stripeEncode(obj, prefix, pairs) {
  pairs = pairs || [];
  Object.keys(obj).forEach(function (key) {
    var val = obj[key];
    if (val === undefined || val === null) return;
    var name = prefix ? prefix + "[" + key + "]" : key;
    if (Array.isArray(val)) {
      val.forEach(function (item, i) {
        var iname = name + "[" + i + "]";
        if (item !== null && typeof item === "object") stripeEncode(item, iname, pairs);
        else pairs.push([iname, item]);
      });
    } else if (typeof val === "object") {
      stripeEncode(val, name, pairs);
    } else {
      pairs.push([name, val]);
    }
  });
  if (prefix) return pairs;
  return pairs.map(function (p) { return encodeURIComponent(p[0]) + "=" + encodeURIComponent(p[1]); }).join("&");
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return bad(res, 405, "POST only.");

  var key = process.env.STRIPE_SECRET_KEY;
  key = key ? String(key).trim() : "";
  if (!key) {
    var where = "env=" + (process.env.VERCEL_ENV || "?") + " · commit=" + String(process.env.VERCEL_GIT_COMMIT_SHA || "?").slice(0, 7);
    return bad(res, 500, "STRIPE_SECRET_KEY is not visible to this deployment (" + where + "). Add it in Vercel → Settings → Environment Variables, then redeploy.");
  }

  var body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};

  // ---- recompute line items from quantities (never trust client prices) ----
  var line_items = [];
  (Array.isArray(body.bottles) ? body.bottles : []).forEach(function (b) {
    var qty = Math.min(MAX_QTY, Math.max(0, parseInt(b && b.qty, 10) || 0));
    if (!qty) return;
    var name = String((b && b.name) || "Discovery Bottle").slice(0, 120);
    line_items.push({
      quantity: qty,
      price_data: {
        currency: CURRENCY,
        unit_amount: PRICE,
        product_data: { name: name + " — 10ml" },
      },
    });
  });
  (Array.isArray(body.boxes) ? body.boxes : []).forEach(function (bx) {
    var names = String((bx && bx.names) || "").slice(0, 250);
    var product = { name: "Sample Box · 5 × 10ml" };
    if (names) product.description = names;
    line_items.push({
      quantity: 1,
      price_data: { currency: CURRENCY, unit_amount: BOX_PRICE, product_data: product },
    });
  });

  if (!line_items.length) return bad(res, 400, "Your bag is empty.");

  // ---- recompute shipping server-side; omit (don't fail) if unavailable ----
  var shipping_options = [];
  var pc = String(body.to_postcode || "").trim();
  if (/^\d{4}$/.test(pc)) {
    var parcel = body.parcel || {};
    var quote = await auspost.quoteCheapest({
      to_postcode: pc, weight: parcel.weight, length: parcel.length, width: parcel.width, height: parcel.height,
    });
    if (quote.ok && isFinite(quote.price)) {
      shipping_options.push({
        shipping_rate_data: {
          type: "fixed_amount",
          fixed_amount: { amount: Math.round(quote.price * 100), currency: CURRENCY },
          display_name: ("Australia Post · " + quote.service).slice(0, 100),
        },
      });
    }
  }

  // ---- absolute return URLs (honour proxy headers on Vercel) ----
  var proto = String(req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
  var host = req.headers["x-forwarded-host"] || req.headers.host;
  var origin = (process.env.STRIPE_RETURN_ORIGIN || (proto + "://" + host)).replace(/\/+$/, "");

  var payload = {
    mode: "payment",
    line_items: line_items,
    success_url: origin + "/?paid={CHECKOUT_SESSION_ID}",
    cancel_url: origin + "/?checkout=cancelled",
  };
  if (shipping_options.length) payload.shipping_options = shipping_options;
  var email = String(body.email || "").trim();
  if (email) payload.customer_email = email.slice(0, 200);

  var resp, session;
  try {
    resp = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + key,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: stripeEncode(payload),
    });
    session = await resp.json();
  } catch (e) {
    return bad(res, 502, "Could not reach Stripe.");
  }

  if (!resp.ok) {
    return bad(res, 502, (session && session.error && session.error.message) || "Stripe rejected the request.");
  }
  return res.status(200).json({ ok: true, url: session.url, id: session.id });
};
