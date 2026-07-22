/* Vercel serverless function — verify a Stripe Checkout Session on return.
 *
 * After Stripe redirects the buyer back to /?paid={CHECKOUT_SESSION_ID}, the
 * front-end calls this endpoint to confirm the payment actually completed. The
 * success redirect alone must never be trusted — a user can craft that URL — so
 * we retrieve the session server-side and report its real payment_status.
 *
 * Env:
 *   STRIPE_SECRET_KEY  (required)
 *
 * Request:  /api/order?session_id=cs_test_…
 * Response: 200 { ok:true, paid:true, order:{ id, amount_total, currency, email, name } }
 *           200 { ok:true, paid:false }
 *           4xx/5xx { ok:false, error:"..." }
 */

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  var key = process.env.STRIPE_SECRET_KEY;
  key = key ? String(key).trim() : "";
  if (!key) return res.status(500).json({ ok: false, error: "Stripe is not configured on this deployment." });

  var id = String((req.query && req.query.session_id) || "").trim();
  if (!/^cs_[A-Za-z0-9_]+$/.test(id)) return res.status(400).json({ ok: false, error: "A valid Checkout Session id is required." });

  var resp, s;
  try {
    resp = await fetch("https://api.stripe.com/v1/checkout/sessions/" + encodeURIComponent(id), {
      headers: { Authorization: "Bearer " + key },
    });
    s = await resp.json();
  } catch (e) {
    return res.status(502).json({ ok: false, error: "Could not reach Stripe." });
  }

  if (!resp.ok) {
    return res.status(502).json({ ok: false, error: (s && s.error && s.error.message) || "Stripe rejected the request." });
  }

  var paid = s.payment_status === "paid";
  var details = s.customer_details || {};
  return res.status(200).json({
    ok: true,
    paid: paid,
    order: paid ? {
      id: s.id,
      amount_total: s.amount_total,
      currency: s.currency,
      email: details.email || s.customer_email || "",
      name: details.name || "",
    } : null,
  });
};
