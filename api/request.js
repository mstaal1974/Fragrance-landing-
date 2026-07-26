/* Vercel serverless function — record a fragrance request.
 *
 * The browser POSTs a request for a fragrance from the wholesale library
 * (catalogue.json). This stores it in Supabase's fragrance_requests table so an
 * admin can review and correlate who asked for what. Card data is not involved;
 * this is a "please source this for me" enquiry, not a payment.
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (see api/_supabase.js).
 *
 * Request (POST JSON):
 *   { name, email, note, quantity,
 *     fragrance_name, brand, size, price, product_id }
 * Response:
 *   200 { ok:true }
 *   4xx/5xx { ok:false, error:"..." }
 */

var supabase = require("./_supabase");

function bad(res, status, error) { res.status(status).json({ ok: false, error: error }); }

function str(v, max) { return String(v == null ? "" : v).trim().slice(0, max); }

module.exports = async function handler(req, res) {
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return bad(res, 405, "POST only."); }

  var body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};

  var email = str(body.email, 200);
  var name = str(body.name, 200);
  var fragranceName = str(body.fragrance_name, 300);

  if (!fragranceName) return bad(res, 400, "A fragrance is required.");
  if (!name) return bad(res, 400, "Your name is required.");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return bad(res, 400, "A valid email is required.");

  var qty = parseInt(body.quantity, 10);
  if (!isFinite(qty) || qty < 1) qty = 1;
  if (qty > 9999) qty = 9999;

  var priceNum = parseFloat(body.price);

  var row = {
    requester_name: name,
    email: email,
    note: str(body.note, 1000) || null,
    quantity: qty,
    fragrance_name: fragranceName,
    brand: str(body.brand, 200) || null,
    size: str(body.size, 50) || null,
    price: isFinite(priceNum) ? priceNum : null,
    product_id: str(body.product_id, 120) || null,
    status: "new",
  };

  if (!supabase.isConfigured()) {
    // Requests must be stored to be useful; surface a clear error rather than
    // silently dropping an enquiry.
    console.log("[fragrance request] (Supabase not configured) " + JSON.stringify(row));
    return bad(res, 503, "Requests aren't enabled yet. Please try again later.");
  }

  try {
    await supabase.insert("fragrance_requests", row);
  } catch (e) {
    return bad(res, 502, "Could not save your request. Please try again.");
  }
  return res.status(200).json({ ok: true });
};
