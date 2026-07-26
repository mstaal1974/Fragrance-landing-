/* Vercel serverless function — admin list of fragrance requests.
 *
 * Returns the fragrance_requests rows for the admin view (admin.html). Gated by
 * a shared secret in the ADMIN_TOKEN env var, compared in constant time. This
 * is a lightweight gate for a private preview — the secure source of truth is
 * always the Supabase dashboard (Table editor → fragrance_requests).
 *
 * Env: ADMIN_TOKEN (required), SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
 *
 * Request:  GET /api/requests   with header  Authorization: Bearer <ADMIN_TOKEN>
 *           (or ?token=<ADMIN_TOKEN>)
 * Response: 200 { ok:true, requests:[...] }  |  401/5xx { ok:false, error }
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
    rows = await supabase.list("fragrance_requests", { order: "created_at.desc", limit: 500 });
  } catch (e) {
    return res.status(502).json({ ok: false, error: "Could not read requests." });
  }
  return res.status(200).json({ ok: true, requests: rows });
};
