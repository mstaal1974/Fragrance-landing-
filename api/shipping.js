/* Vercel serverless function — Australia Post PAC domestic parcel proxy.
 *
 * The browser cannot call Australia Post directly: the PAC API sends no CORS
 * headers, and the AUTH-KEY must never ship in client JS. This function keeps
 * the key server-side, calls the domestic parcel "service" endpoint (via the
 * shared helper in _auspost.js), and returns the cheapest available service.
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

var auspost = require("./_auspost");

function bad(res, status, error) {
  res.status(status).json({ ok: false, error: error });
}

module.exports = async function handler(req, res) {
  // Same-origin in production; permissive here so the proxy is testable anywhere.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();

  var q = req.query || {};
  var key = auspost.apiKey();

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

  var quote = await auspost.quoteCheapest({
    to_postcode: q.to_postcode,
    length: q.length,
    width: q.width,
    height: q.height,
    weight: q.weight,
  });

  if (!quote.ok) return bad(res, quote.status || 502, quote.error);

  res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");
  return res.status(200).json({
    ok: true,
    service: quote.service,
    code: quote.code,
    price: quote.price,
    from_postcode: quote.from_postcode,
    to_postcode: quote.to_postcode,
  });
};
