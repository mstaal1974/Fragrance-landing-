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
 *
 * The admin can also toggle an order's fulfilment flag:
 * Request:  PATCH /api/orders   { id:"<uuid>", packed:true|false }
 *           (same Bearer <ADMIN_TOKEN> gate)
 * Response: 200 { ok:true, order:{...} }  |  4xx/5xx { ok:false, error }
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

  // ---- PATCH: toggle a fulfilment flag (currently `packed`) ----
  if (req.method === "PATCH" || req.method === "POST") {
    var body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    body = body || {};

    var id = String(body.id || "").trim();
    if (!id) return res.status(400).json({ ok: false, error: "Missing order id." });

    var patch = {};
    if (typeof body.packed === "boolean") patch.packed = body.packed;
    if (!Object.keys(patch).length) return res.status(400).json({ ok: false, error: "Nothing to update." });

    var updated;
    try {
      updated = await supabase.update("orders", id, patch);
    } catch (e) {
      return res.status(502).json({ ok: false, error: "Could not update the order." });
    }
    var order = Array.isArray(updated) ? updated[0] : updated;
    if (!order) return res.status(404).json({ ok: false, error: "Order not found." });
    return res.status(200).json({ ok: true, order: order });
  }

  // ---- GET: list orders ----
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, PATCH");
    return res.status(405).json({ ok: false, error: "GET or PATCH only." });
  }

  var rows;
  try {
    rows = await supabase.list("orders", { order: "created_at.desc", limit: 500 });
  } catch (e) {
    return res.status(502).json({ ok: false, error: "Could not read orders." });
  }
  return res.status(200).json({ ok: true, orders: rows });
};
