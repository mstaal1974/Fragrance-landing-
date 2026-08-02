/* Vercel serverless function — admin backfill of paid orders from Stripe.
 *
 * Reads Checkout Sessions straight from the Stripe API and upserts every PAID
 * one into Supabase (idempotent on stripe_session_id). This repairs orders that
 * never reached the webhook — e.g. the webhook endpoint was created after the
 * payment, so Stripe never delivered the checkout.session.completed event and
 * there is no delivery to "resend" in the dashboard.
 *
 * It does NOT touch the webhook or its signing secret: it pulls the source of
 * truth (paid sessions) directly, so it works even when the webhook is
 * misconfigured. Safe to re-run — existing rows are updated, not duplicated.
 * Cancelled/unpaid sessions are skipped.
 *
 * Gated by the same ADMIN_TOKEN as api/orders.js / api/requests.js.
 *
 * Request:  POST /api/backfill   Authorization: Bearer <ADMIN_TOKEN>
 *           optional JSON body { limit: 300 }  — max sessions to scan (default 300)
 * Response: 200 { ok:true, scanned, paid, saved }  |  4xx/5xx { ok:false, error }
 *
 * Env: ADMIN_TOKEN, STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
 */

var crypto = require("crypto");
var supabase = require("./_supabase");
var order = require("./_order");

function timingSafeEqual(a, b) {
  var ba = Buffer.from(String(a));
  var bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "POST only." });
  }

  var expected = process.env.ADMIN_TOKEN;
  expected = expected ? String(expected).trim() : "";
  if (!expected) return res.status(500).json({ ok: false, error: "ADMIN_TOKEN is not configured." });

  var auth = req.headers.authorization || "";
  var provided = auth.indexOf("Bearer ") === 0 ? auth.slice(7).trim() : String((req.query && req.query.token) || "").trim();
  if (!provided || !timingSafeEqual(provided, expected)) {
    return res.status(401).json({ ok: false, error: "Unauthorized." });
  }

  var key = process.env.STRIPE_SECRET_KEY;
  key = key ? String(key).trim() : "";
  if (!key) return res.status(500).json({ ok: false, error: "STRIPE_SECRET_KEY is not configured." });
  if (!supabase.isConfigured()) return res.status(500).json({ ok: false, error: "Supabase is not configured." });

  var body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};
  var cap = Math.min(1000, Math.max(1, parseInt(body.limit, 10) || 300));

  var scanned = 0, paid = 0, saved = 0, startingAfter = null, pages = 0;
  try {
    // Page through Checkout Sessions (newest first), upserting paid ones. The
    // list already carries customer_details and metadata, so no per-session
    // fetch is needed. Bounded by `cap` and a hard page ceiling.
    while (pages < 10 && scanned < cap) {
      var url = "https://api.stripe.com/v1/checkout/sessions?limit=100";
      if (startingAfter) url += "&starting_after=" + encodeURIComponent(startingAfter);

      var resp = await fetch(url, { headers: { Authorization: "Bearer " + key } });
      var page = await resp.json();
      if (!resp.ok) {
        return res.status(502).json({ ok: false, error: (page && page.error && page.error.message) || "Stripe rejected the request." });
      }

      var list = Array.isArray(page.data) ? page.data : [];
      for (var i = 0; i < list.length; i++) {
        var s = list[i];
        scanned++;
        startingAfter = s.id;
        if (s && s.payment_status === "paid") {
          paid++;
          await supabase.saveOrder(order.fromSession(s));
          saved++;
        }
        if (scanned >= cap) break;
      }

      pages++;
      if (!page.has_more) break;
    }
  } catch (e) {
    return res.status(502).json({ ok: false, error: "Backfill failed: " + ((e && e.message) || "unknown error") });
  }

  return res.status(200).json({ ok: true, scanned: scanned, paid: paid, saved: saved });
};
