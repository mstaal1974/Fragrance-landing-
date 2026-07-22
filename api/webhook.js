/* Vercel serverless function — Stripe webhook receiver.
 *
 * This is the source of truth for "an order was paid". Unlike the return
 * redirect (which a buyer can miss by closing the tab), Stripe delivers this
 * event server-to-server once payment settles, so fulfilment should hang off
 * here — not off api/order.js.
 *
 * The Stripe-Signature header is verified with an HMAC-SHA256 of
 * `${timestamp}.${rawBody}` keyed by the endpoint's signing secret, using
 * Node's crypto (no Stripe SDK, no build step). Verification needs the EXACT
 * bytes Stripe signed, so body parsing is disabled and the raw stream is read
 * directly — we never touch req.body.
 *
 * Env:
 *   STRIPE_WEBHOOK_SECRET  (required)  — whsec_… from the Stripe Dashboard
 *                                        (Developers → Webhooks → your endpoint)
 *
 * Stripe endpoint URL:  https://<your-domain>/api/webhook
 * Events to send:       checkout.session.completed
 *                       (also checkout.session.async_payment_succeeded)
 */

var crypto = require("crypto");

var TOLERANCE_SECONDS = 300; // reject events older than 5 min (replay guard)

// Read the raw request bytes. We never access req.body, so the stream stays
// intact and we verify against exactly what Stripe signed. Falls back to a
// platform-provided raw buffer if one is present.
function readRawBody(req) {
  if (req.rawBody) {
    return Promise.resolve(Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.from(req.rawBody));
  }
  return new Promise(function (resolve, reject) {
    var chunks = [];
    req.on("data", function (c) { chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)); });
    req.on("end", function () { resolve(Buffer.concat(chunks)); });
    req.on("error", reject);
  });
}

// Verify the Stripe-Signature header. Throws on any mismatch; returns true on
// success. Mirrors Stripe's own scheme (t=…,v1=…) with a constant-time compare.
function verifySignature(rawBody, header, secret) {
  if (!header) throw new Error("Missing Stripe-Signature header.");

  var t = "";
  var v1 = [];
  String(header).split(",").forEach(function (kv) {
    var i = kv.indexOf("=");
    if (i === -1) return;
    var k = kv.slice(0, i).trim();
    var val = kv.slice(i + 1).trim();
    if (k === "t") t = val;
    else if (k === "v1") v1.push(val);
  });
  if (!t || !v1.length) throw new Error("Malformed Stripe-Signature header.");

  var ts = parseInt(t, 10);
  if (!isFinite(ts) || Math.abs(Math.floor(Date.now() / 1000) - ts) > TOLERANCE_SECONDS) {
    throw new Error("Timestamp outside tolerance.");
  }

  var signed = Buffer.concat([Buffer.from(t + ".", "utf8"), rawBody]);
  var expected = crypto.createHmac("sha256", secret).update(signed).digest();

  var matched = v1.some(function (s) {
    var buf;
    try { buf = Buffer.from(s, "hex"); } catch (e) { return false; }
    return buf.length === expected.length && crypto.timingSafeEqual(buf, expected);
  });
  if (!matched) throw new Error("No matching v1 signature.");
  return true;
}

/* ── Fulfilment ──────────────────────────────────────────────────────────
 * Fires once payment is confirmed. There is no database or mailer wired into
 * this project, so for now it records the order to the Vercel function logs.
 * Replace the body with your real fulfilment — email a packing slip, append to
 * a sheet, write to a DB.
 *
 * IMPORTANT: Stripe may deliver the same event more than once. Make this
 * idempotent in production — key off session.id (or event.id) and skip if
 * you've already fulfilled it.
 */
async function fulfilOrder(session) {
  var d = session.customer_details || {};
  var m = session.metadata || {};
  console.log("[order paid] " + JSON.stringify({
    session: session.id,
    amount_total: session.amount_total,
    currency: session.currency,
    email: d.email || session.customer_email || "",
    name: d.name || m.ship_name || "",
    ship_to: [m.ship_address, m.ship_city, m.ship_postcode].filter(Boolean).join(", "),
    items: m.items || "",
  }));
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "POST only." });
  }

  var secret = process.env.STRIPE_WEBHOOK_SECRET;
  secret = secret ? String(secret).trim() : "";
  if (!secret) return res.status(500).json({ ok: false, error: "STRIPE_WEBHOOK_SECRET is not configured." });

  var rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (e) {
    return res.status(400).json({ ok: false, error: "Could not read request body." });
  }

  var event;
  try {
    verifySignature(rawBody, req.headers["stripe-signature"], secret);
    event = JSON.parse(rawBody.toString("utf8"));
  } catch (e) {
    // Bad signature → 400 so Stripe surfaces it and never treat it as paid.
    return res.status(400).json({ ok: false, error: "Signature verification failed." });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded": {
        var session = event.data && event.data.object;
        if (session && session.payment_status === "paid") await fulfilOrder(session);
        break;
      }
      default:
        break; // acknowledge but ignore other event types
    }
  } catch (e) {
    // Fulfilment threw — return 500 so Stripe retries delivery.
    return res.status(500).json({ ok: false, error: "Fulfilment failed." });
  }

  return res.status(200).json({ received: true });
};

// Disable Vercel's automatic body parsing so the raw bytes reach us intact.
module.exports.config = { api: { bodyParser: false } };
