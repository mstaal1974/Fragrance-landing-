/* Vercel serverless function — Australia Post PAC domestic parcel proxy.
 *
 * The browser cannot call Australia Post directly: the PAC API sends no CORS
 * headers, and the AUTH-KEY must never ship in client JS. This function keeps
 * the key server-side, calls the domestic parcel "service" endpoint, and
 * returns the cheapest available service as a small JSON payload.
 *
 * Env:
 *   AUSPOST_API_KEY        (required)  — your PAC API key (the AUTH-KEY header)
 *   AUSPOST_FROM_POSTCODE  (optional)  — dispatch postcode, default "3000"
 *
 * Request (GET, all query params optional except to_postcode):
 *   /api/shipping?to_postcode=2000&weight=0.5&length=22&width=16&height=8
 *
 * Response:
 *   200 { ok:true,  service:"Parcel Post", code:"AUS_PARCEL_REGULAR", price:9.4, from_postcode:"3000", to_postcode:"2000" }
 *   4xx/5xx { ok:false, error:"..." }
 */

var AUSPOST_BASE = "https://digitalapi.auspost.com.au/postage/parcel/domestic/service.json";

// Fallback parcel (a single 10ml bottle) — used only if the caller omits
// dimensions; the storefront computes the real size/weight from the order.
var DEFAULTS = { weight: 0.035, length: 10, width: 2, height: 2 };

function bad(res, status, error) {
  res.status(status).json({ ok: false, error: error });
}

function num(v, fallback) {
  var n = parseFloat(v);
  return isFinite(n) && n > 0 ? n : fallback;
}

module.exports = async function handler(req, res) {
  // Same-origin in production; permissive here so the proxy is testable anywhere.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();

  var q = req.query || {};
  var key = process.env.AUSPOST_API_KEY;
  key = key ? String(key).trim() : ""; // tolerate a pasted trailing newline/space

  // Safe diagnostics — never returns the key itself. Visit /api/shipping?debug=1
  // to confirm which deployment is serving and whether it can see the key.
  if (q.debug === "1") {
    return res.status(200).json({
      ok: true,
      diagnostic: true,
      hasKey: !!key,
      keyLength: key.length,
      env: process.env.VERCEL_ENV || "unknown",
      branch: process.env.VERCEL_GIT_COMMIT_REF || "unknown",
      commit: String(process.env.VERCEL_GIT_COMMIT_SHA || "unknown").slice(0, 7),
      fromPostcode: process.env.AUSPOST_FROM_POSTCODE || "3000 (default)",
    });
  }

  if (!key) {
    var where =
      "env=" + (process.env.VERCEL_ENV || "?") +
      " · branch=" + (process.env.VERCEL_GIT_COMMIT_REF || "?") +
      " · commit=" + String(process.env.VERCEL_GIT_COMMIT_SHA || "?").slice(0, 7);
    return bad(res, 500, "AUSPOST_API_KEY is not visible to this deployment (" + where + "). Redeploy after adding it, and open the newest deployment URL.");
  }
  var toPostcode = String(q.to_postcode || "").trim();
  if (!/^\d{4}$/.test(toPostcode)) return bad(res, 400, "A valid 4-digit Australian postcode is required.");

  var fromPostcode = String(process.env.AUSPOST_FROM_POSTCODE || "3000").trim();
  var params = new URLSearchParams({
    from_postcode: fromPostcode,
    to_postcode: toPostcode,
    length: String(num(q.length, DEFAULTS.length)),
    width: String(num(q.width, DEFAULTS.width)),
    height: String(num(q.height, DEFAULTS.height)),
    weight: String(num(q.weight, DEFAULTS.weight)),
  });

  var upstream;
  try {
    upstream = await fetch(AUSPOST_BASE + "?" + params.toString(), {
      headers: { "AUTH-KEY": key, Accept: "application/json" },
    });
  } catch (e) {
    return bad(res, 502, "Could not reach Australia Post.");
  }

  var data;
  try {
    data = await upstream.json();
  } catch (e) {
    return bad(res, 502, "Unexpected response from Australia Post.");
  }

  if (!upstream.ok) {
    var msg = (data && data.error && (data.error.errorMessage || data.error.message)) || "Australia Post rejected the request.";
    return bad(res, upstream.status === 403 ? 502 : upstream.status, msg);
  }

  // `services.service` is an array, or a single object when only one service.
  var svc = data && data.services && data.services.service;
  var list = Array.isArray(svc) ? svc : svc ? [svc] : [];
  var priced = list
    .map(function (s) { return { name: s.name, code: s.code, price: parseFloat(s.price) }; })
    .filter(function (s) { return isFinite(s.price); });

  if (!priced.length) return bad(res, 502, "No shipping services available for that postcode.");

  var cheapest = priced.reduce(function (a, b) { return b.price < a.price ? b : a; });

  res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");
  return res.status(200).json({
    ok: true,
    service: cheapest.name,
    code: cheapest.code,
    price: cheapest.price,
    from_postcode: fromPostcode,
    to_postcode: toPostcode,
  });
};
