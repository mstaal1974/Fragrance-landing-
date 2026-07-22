/* Shared Supabase helper.
 *
 * Writes orders through Supabase's PostgREST API with plain fetch — no
 * @supabase/supabase-js dependency and no build step, consistent with the rest
 * of api/. Uses the SERVICE ROLE key, which bypasses Row Level Security, so it
 * must stay server-side only and must never be exposed to the browser.
 *
 * Env:
 *   SUPABASE_URL               (required)  — https://<project-ref>.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY  (required)  — service_role key (secret)
 */

function config() {
  return {
    url: String(process.env.SUPABASE_URL || "").trim().replace(/\/+$/, ""),
    key: String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim(),
  };
}

function isConfigured() {
  var c = config();
  return !!(c.url && c.key);
}

/* Upsert an order row, keyed on stripe_session_id so a webhook that Stripe
 * delivers more than once updates the same row instead of inserting a
 * duplicate. Requires a UNIQUE constraint on orders.stripe_session_id (see
 * supabase/schema.sql). Returns the saved row(s); throws on any error. */
async function saveOrder(order) {
  var c = config();
  if (!c.url || !c.key) throw new Error("Supabase is not configured.");

  var resp, data;
  try {
    resp = await fetch(c.url + "/rest/v1/orders?on_conflict=stripe_session_id", {
      method: "POST",
      headers: {
        apikey: c.key,
        Authorization: "Bearer " + c.key,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=representation",
      },
      body: JSON.stringify(order),
    });
  } catch (e) {
    throw new Error("Could not reach Supabase.");
  }

  try { data = await resp.json(); } catch (e) { data = null; }

  if (!resp.ok) {
    var msg = (data && (data.message || data.error || data.hint)) || ("Supabase responded " + resp.status);
    throw new Error(String(msg));
  }
  return data;
}

module.exports = { saveOrder: saveOrder, isConfigured: isConfigured };
