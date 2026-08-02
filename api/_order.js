/* Shared mapper: turn a Stripe Checkout Session into our `orders` row shape.
 *
 * Used by both api/webhook.js (live fulfilment) and api/backfill.js (replay
 * from the Stripe API), so the two paths always write identical rows. Keeping
 * this in one place means a field added here reaches both automatically.
 */

function fromSession(session) {
  var d = session.customer_details || {};
  var m = session.metadata || {};
  return {
    stripe_session_id: session.id,
    payment_intent_id: typeof session.payment_intent === "string" ? session.payment_intent : null,
    email: d.email || session.customer_email || null,
    name: d.name || m.ship_name || null,
    amount_total: typeof session.amount_total === "number" ? session.amount_total : null,
    currency: session.currency || null,
    items: m.items || null,
    ship_address: m.ship_address || null,
    ship_city: m.ship_city || null,
    ship_region: m.ship_region || null,
    ship_postcode: m.ship_postcode || null,
    delivery_method: m.delivery_method || null,
    delivery_notes: m.delivery_notes || null,
    mobile: m.mobile || null,
    status: "paid",
  };
}

module.exports = { fromSession: fromSession };
