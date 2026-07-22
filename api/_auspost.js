/* Shared Australia Post PAC quote helper.
 *
 * Used by both api/shipping.js (the browser-facing quote endpoint) and
 * api/checkout.js (which must recompute shipping server-side rather than
 * trust an amount sent by the client). Returns the cheapest domestic parcel
 * service, or a structured error — it never throws.
 *
 * Env:
 *   AUSPOST_API_KEY        (required)  — PAC API key (the AUTH-KEY header)
 *   AUSPOST_FROM_POSTCODE  (optional)  — dispatch postcode, default "3000"
 */

var AUSPOST_BASE = "https://digitalapi.auspost.com.au/postage/parcel/domestic/service.json";

// Fallback parcel (a single 10ml bottle) — used only if a caller omits
// dimensions; the storefront computes the real size/weight from the order.
var DEFAULTS = { weight: 0.035, length: 10, width: 2, height: 2 };

function num(v, fallback) {
  var n = parseFloat(v);
  return isFinite(n) && n > 0 ? n : fallback;
}

// Resolve and trim the key once, so callers can report "missing key" precisely.
function apiKey() {
  var key = process.env.AUSPOST_API_KEY;
  return key ? String(key).trim() : ""; // tolerate a pasted trailing newline/space
}

/* Returns one of:
 *   { ok:true,  service, code, price, from_postcode, to_postcode }
 *   { ok:false, status, error }
 */
async function quoteCheapest(opts) {
  opts = opts || {};
  var key = apiKey();
  if (!key) return { ok: false, status: 500, error: "AUSPOST_API_KEY is not visible to this deployment." };

  var toPostcode = String(opts.to_postcode || "").trim();
  if (!/^\d{4}$/.test(toPostcode)) return { ok: false, status: 400, error: "A valid 4-digit Australian postcode is required." };

  var fromPostcode = String(process.env.AUSPOST_FROM_POSTCODE || "3000").trim();
  var params = new URLSearchParams({
    from_postcode: fromPostcode,
    to_postcode: toPostcode,
    length: String(num(opts.length, DEFAULTS.length)),
    width: String(num(opts.width, DEFAULTS.width)),
    height: String(num(opts.height, DEFAULTS.height)),
    weight: String(num(opts.weight, DEFAULTS.weight)),
  });

  var upstream;
  try {
    upstream = await fetch(AUSPOST_BASE + "?" + params.toString(), {
      headers: { "AUTH-KEY": key, Accept: "application/json" },
    });
  } catch (e) {
    return { ok: false, status: 502, error: "Could not reach Australia Post." };
  }

  var data;
  try {
    data = await upstream.json();
  } catch (e) {
    return { ok: false, status: 502, error: "Unexpected response from Australia Post." };
  }

  if (!upstream.ok) {
    var msg = (data && data.error && (data.error.errorMessage || data.error.message)) || "Australia Post rejected the request.";
    return { ok: false, status: upstream.status === 403 ? 502 : upstream.status, error: msg };
  }

  // `services.service` is an array, or a single object when only one service.
  var svc = data && data.services && data.services.service;
  var list = Array.isArray(svc) ? svc : svc ? [svc] : [];
  var priced = list
    .map(function (s) { return { name: s.name, code: s.code, price: parseFloat(s.price) }; })
    .filter(function (s) { return isFinite(s.price); });

  if (!priced.length) return { ok: false, status: 502, error: "No shipping services available for that postcode." };

  var cheapest = priced.reduce(function (a, b) { return b.price < a.price ? b : a; });
  return {
    ok: true,
    service: cheapest.name,
    code: cheapest.code,
    price: cheapest.price,
    from_postcode: fromPostcode,
    to_postcode: toPostcode,
  };
}

module.exports = { quoteCheapest: quoteCheapest, apiKey: apiKey, num: num, DEFAULTS: DEFAULTS };
