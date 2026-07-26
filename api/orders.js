/* Vercel serverless function — admin list of paid orders.
 *
 * Returns the `orders` rows for the admin view (admin.html → Orders tab).
 * Gated by the ADMIN_TOKEN shared secret, compared in constant time — the same
 * gate as api/requests.js. The secure source of truth remains the Stripe
 * dashboard and the Supabase Table editor.
 *
 * Env: ADMIN_TOKEN (required), SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
 *
 * Request:  GET /api/orders   with header  Authorization: Bearer <ADMIN_TOKEN>
 *           (or ?token=<ADMIN_TOKEN>)
 * Response: 200 { ok:true, orders:[...] }  |  401/5xx { ok:false, error }
 */

var crypto = require("crypto");
var supabase = require("./_supabase");

function timingSafeEqual(a, b) {
  var ba = Buffer.from(String(a));
  var bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  var expected = process.env.ADMIN_TOKEN;
  expected = expected ? String(expected).trim() : "";
  if (!expected) return res.status(500).json({ ok: false, error: "ADMIN_TOKEN is not configured." });

  var auth = req.headers.authorization || "";
  var provided = auth.indexOf("Bearer ") === 0 ? auth.slice(7).trim() : String((req.query && req.query.token) || "").trim();
  if (!provided || !timingSafeEqual(provided, expected)) {
    return res.status(401).json({ ok: false, error: "Unauthorized." });
  }

  if (!supabase.isConfigured()) return res.status(500).json({ ok: false, error: "Supabase is not configured." });

  var rows;
  try {
    rows = await supabase.list("orders", { order: "created_at.desc", limit: 500 });
  } catch (e) {
    return res.status(502).json({ ok: false, error: "Could not read orders." });
  }
  return res.status(200).json({ ok: true, orders: rows });
};
