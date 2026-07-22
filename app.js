/* Maison Obsidian — 10ml Discovery Drop
   Interactive logic recreated from the Claude Design prototype.
   Plain-JS state machine: cart, sample-box builder, drawer, checkout,
   confirmation. Every 10ml bottle is a flat $12; each Sample Box is 5
   scents for $50 flat. */
(function () {
  "use strict";

  var FRAGS = window.FRAGS;
  var PRICE = 12;
  var BOX_PRICE = 50;

  // Live shipping via the Australia Post PAC proxy (see api/shipping.js).
  // Override the endpoint by setting window.MO_CONFIG.shippingEndpoint before this script.
  var CFG = window.MO_CONFIG || {};
  var SHIPPING_ENDPOINT = CFG.shippingEndpoint || "/api/shipping";
  // Stripe Checkout (hosted redirect). checkoutEndpoint creates the session;
  // orderEndpoint verifies payment when Stripe redirects the buyer back.
  var CHECKOUT_ENDPOINT = CFG.checkoutEndpoint || "/api/checkout";
  var ORDER_ENDPOINT = CFG.orderEndpoint || "/api/order";
  // Physical item specs (mm, grams). The parcel size/weight sent to Australia
  // Post is computed from the actual contents (see parcelSpec()).
  var ITEM = {
    bottle: { w: 20, h: 20, g: 35 },   // single 10ml bottle, 100mm long
    box:    { w: 100, h: 20, g: 200 },  // 5-scent sample box, 100mm long
  };
  var PARCEL_LEN_MM = 100;              // every item is 100mm on its longest side

  var state = {
    cart: {},            // { fragId: qty }
    sampleSelection: [], // up to 5 frag ids
    sampleBoxes: [],     // [{ id, items:[fragId,...] }]
    view: "shop",        // shop | checkout | confirmed
    orderNumber: null,
    drawerOpen: false,
    showFormError: false,
    checkoutForm: {
      email: "", fullName: "", address: "", city: "", region: "",
      zip: "", country: "",
    },
    // Australia Post shipping quote for the current postcode.
    // status: idle | loading | ready | error
    shipping: { status: "idle", cost: 0, service: "", postcode: "", error: "" },
  };
  var shipTimer = null;   // debounce handle for postcode-driven quotes
  var shipSeq = 0;        // guards against out-of-order responses

  /* ---------- helpers ---------- */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function fragById(id) { for (var i = 0; i < FRAGS.length; i++) if (FRAGS[i].id === id) return FRAGS[i]; return null; }
  function pad(n) { return String(n).padStart(2, "0"); }

  // Lighten (p>0) / darken (p<0) a hex colour toward white/black.
  function shade(hex, p) {
    var n = parseInt(hex.slice(1), 16);
    var r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    var t = p < 0 ? 0 : 255, a = Math.abs(p);
    r = Math.round(r + (t - r) * a);
    g = Math.round(g + (t - g) * a);
    b = Math.round(b + (t - b) * a);
    return "rgb(" + r + "," + g + "," + b + ")";
  }
  function swatchGradient(liquid) {
    return "linear-gradient(158deg, " + shade(liquid, 0.22) + " 0%, " + liquid + " 46%, " + shade(liquid, -0.5) + " 100%)";
  }

  function qtyFor(id) { return state.cart[id] || 0; }
  function cartIds() { return Object.keys(state.cart).filter(function (id) { return state.cart[id] > 0; }); }
  function bottleSubtotal() { return cartIds().reduce(function (sum, id) { return sum + state.cart[id] * PRICE; }, 0); }
  function boxSubtotal() { return state.sampleBoxes.length * BOX_PRICE; }
  function subtotal() { return bottleSubtotal() + boxSubtotal(); }
  function shippingCost() { return state.shipping.status === "ready" ? state.shipping.cost : 0; }
  function orderTotal() { return subtotal() + shippingCost(); }
  function money(n) { return "$" + (Math.round(n * 100) / 100).toFixed(2).replace(/\.00$/, ""); }

  // Compute the parcel bounding box (cm) and weight (kg) from the actual order.
  // Items are packed length-aligned (100mm): sample boxes stack flat (100×100
  // footprint, 20mm each), loose bottles pack in rows of up to 5 across
  // (5 × 20mm = 100mm, matching the box footprint), and the two blocks stack.
  function parcelSpec() {
    var bottles = cartIds().reduce(function (s, id) { return s + state.cart[id]; }, 0);
    var boxes = state.sampleBoxes.length;

    var boxW = boxes > 0 ? ITEM.box.w : 0;      // 100mm
    var boxH = boxes * ITEM.box.h;              // 20mm per box

    var perRow = Math.min(bottles, 5);
    var rows = Math.ceil(bottles / 5);
    var botW = bottles > 0 ? perRow * ITEM.bottle.w : 0;
    var botH = rows * ITEM.bottle.h;

    var widthMm = Math.max(boxW, botW) || ITEM.bottle.w;
    var heightMm = (boxH + botH) || ITEM.bottle.h;
    var weightG = bottles * ITEM.bottle.g + boxes * ITEM.box.g;

    return {
      length: PARCEL_LEN_MM / 10,               // mm → cm
      width: widthMm / 10,
      height: heightMm / 10,
      weight: Math.max(0.02, Math.round(weightG) / 1000), // g → kg
    };
  }
  function cartCount() {
    return cartIds().reduce(function (sum, id) { return sum + state.cart[id]; }, 0) + state.sampleBoxes.length;
  }
  function hasAnyItems() { return cartIds().length > 0 || state.sampleBoxes.length > 0; }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /* ---------- cart mutations ---------- */
  function inc(id) { state.cart[id] = (state.cart[id] || 0) + 1; onCartChange(); }
  function dec(id) {
    var n = (state.cart[id] || 0) - 1;
    if (n <= 0) delete state.cart[id]; else state.cart[id] = n;
    onCartChange();
  }
  function onCartChange() {
    renderCards();
    updateHeader();
    if (state.drawerOpen) renderDrawer();
  }

  /* ---------- sample box ---------- */
  function toggleSample(id) {
    var i = state.sampleSelection.indexOf(id);
    if (i >= 0) state.sampleSelection.splice(i, 1);
    else if (state.sampleSelection.length < 5) state.sampleSelection.push(id);
    renderCards();
  }
  function addSampleBox() {
    if (state.sampleSelection.length !== 5) return;
    state.sampleBoxes.push({ id: "box-" + Date.now(), items: state.sampleSelection.slice() });
    state.sampleSelection = [];
    renderCards();
    updateHeader();
    openDrawer();
  }
  function removeSampleBox(boxId) {
    state.sampleBoxes = state.sampleBoxes.filter(function (b) { return b.id !== boxId; });
    onCartChange();
  }

  /* ---------- view switching ---------- */
  function setView(view) {
    state.view = view;
    $all("[data-view]").forEach(function (el) {
      el.hidden = el.getAttribute("data-view") !== view;
    });
    // header nav only on shop
    var nav = $("[data-shop-only]");
    if (nav) nav.style.display = view === "shop" ? "" : "none";
    window.scrollTo({ top: 0 });
  }

  function openDrawer() { state.drawerOpen = true; $("[data-drawer]").hidden = false; renderDrawer(); }
  function closeDrawer() { state.drawerOpen = false; $("[data-drawer]").hidden = true; }

  /* ---------- card rendering ---------- */
  function cardHTML(f) {
    var qty = qtyFor(f.id);
    var inSample = state.sampleSelection.indexOf(f.id) >= 0;
    var sampleFull = state.sampleSelection.length >= 5 && !inSample;

    var media =
      '<div class="dd-card__media">' +
        '<div class="dd-card__swatch" style="background:' + swatchGradient(f.liquid) + '"></div>' +
        (f.img ? '<img class="dd-card__img" src="' + esc(f.img) + '" alt="' + esc(f.name) + '" loading="lazy">' : '') +
      '</div>';

    var action = qty > 0
      ? '<div class="dd-qty">' +
          '<button type="button" class="dd-qty__btn" data-dec="' + f.id + '" aria-label="Decrease">−</button>' +
          '<span class="dd-qty__val">' + qty + '</span>' +
          '<button type="button" class="dd-qty__btn" data-inc="' + f.id + '" aria-label="Increase">+</button>' +
        '</div>'
      : '<button type="button" class="dd-card__add" data-inc="' + f.id + '">Add</button>';

    var sampleCls = "dd-card__sample" + (inSample ? " dd-card__sample--in" : (sampleFull ? " dd-card__sample--full" : ""));
    var sampleLabel = inSample ? "✓ In Sample Box" : (sampleFull ? "Sample Box Full" : "+ Add to Sample Box");
    var sampleBtn = '<button type="button" class="' + sampleCls + '" data-sample="' + f.id + '"' +
      (sampleFull ? " disabled" : "") + ">" + sampleLabel + "</button>";

    return '<div class="dd-card">' + media +
      '<div class="dd-card__body">' +
        '<div class="dd-card__insp">' + esc(f.insp) + '</div>' +
        '<div class="dd-card__name">' + esc(f.name) + '</div>' +
        '<p class="dd-card__desc dd-clamp2">' + esc(f.desc) + '</p>' +
        '<p class="dd-card__notes dd-clamp1">' + esc(f.top + " · " + f.heart + " · " + f.base) + '</p>' +
        '<div class="dd-card__foot">' +
          '<span class="dd-card__price">$12 <small>/ 10ml</small></span>' +
          action +
        '</div>' +
        sampleBtn +
      '</div>' +
    '</div>';
  }

  function renderCards() {
    ["him", "her", "unisex"].forEach(function (fam) {
      var list = FRAGS.filter(function (f) { return f.family === fam; });
      $('[data-grid="' + fam + '"]').innerHTML = list.map(cardHTML).join("");
      $('[data-count-eyebrow="' + fam + '"]').textContent =
        (fam === "him" ? "For Him" : fam === "her" ? "For Her" : "Unisex") + " — " + pad(list.length) + " Scents";
    });

    // sample-box builder state
    var n = state.sampleSelection.length;
    $("[data-sample-count]").textContent = n + " / 5 selected";
    var addBtn = $("[data-add-samplebox]");
    addBtn.disabled = n !== 5;
  }

  function updateHeader() {
    $("[data-cart-count]").textContent = pad(cartCount());
  }

  /* ---------- drawer ---------- */
  function drawerBoxHTML(box) {
    var names = box.items.map(function (id) { return fragById(id).name; }).join(", ");
    return '<div class="dd-drawer__box">' +
      '<div class="dd-drawer__box-head">' +
        '<span class="dd-drawer__box-label">Sample Box · 5 × 10ml</span>' +
        '<button type="button" class="dd-drawer__box-remove" data-remove-box="' + box.id + '" aria-label="Remove sample box">×</button>' +
      '</div>' +
      '<p class="dd-drawer__box-names">' + esc(names) + '</p>' +
      '<div class="dd-drawer__box-price">$50</div>' +
    '</div>';
  }
  function drawerItemHTML(id) {
    var f = fragById(id), qty = state.cart[id];
    return '<div class="dd-drawer__item">' +
      '<div class="dd-drawer__item-swatch" style="background:' + swatchGradient(f.liquid) + '"></div>' +
      '<div class="dd-drawer__item-main">' +
        '<div class="dd-drawer__item-name">' + esc(f.name) + '</div>' +
        '<div class="dd-drawer__item-meta">10ml · $12 each</div>' +
        '<div class="dd-drawer__item-row">' +
          '<div class="dd-drawer__qty">' +
            '<button type="button" class="dd-drawer__qty-btn" data-dec="' + id + '" aria-label="Decrease">−</button>' +
            '<span class="dd-drawer__qty-val">' + qty + '</span>' +
            '<button type="button" class="dd-drawer__qty-btn" data-inc="' + id + '" aria-label="Increase">+</button>' +
          '</div>' +
          '<span class="dd-drawer__item-total">$' + (qty * PRICE) + '</span>' +
        '</div>' +
      '</div>' +
    '</div>';
  }
  function renderDrawer() {
    var body = $("[data-drawer-body]");
    var html = "";
    if (hasAnyItems()) {
      html += state.sampleBoxes.map(drawerBoxHTML).join("");
      html += cartIds().map(drawerItemHTML).join("");
    } else {
      html = '<div class="dd-drawer__empty">' +
        '<div class="dd-drawer__empty-title">Your bag is empty.</div>' +
        '<p class="dd-drawer__empty-sub">Add a 10ml bottle to try before you commit.</p>' +
      '</div>';
    }
    body.innerHTML = html;

    var foot = $("[data-drawer-foot]");
    foot.hidden = !hasAnyItems();
    $("[data-drawer-subtotal]").textContent = "$" + subtotal();
  }

  /* ---------- checkout ---------- */
  function checkoutSummaryHTML() {
    var html = "";
    state.sampleBoxes.forEach(function (b) {
      var names = b.items.map(function (id) { return fragById(id).name; }).join(", ");
      html += '<div class="dd-summary__item dd-summary__item--box">' +
        '<div>' +
          '<div class="dd-summary__box-label">Sample Box · 5 × 10ml</div>' +
          '<div class="dd-summary__box-names">' + esc(names) + '</div>' +
        '</div>' +
        '<span class="dd-summary__price">$50</span>' +
      '</div>';
    });
    cartIds().forEach(function (id) {
      var f = fragById(id), qty = state.cart[id];
      html += '<div class="dd-summary__item">' +
        '<div class="dd-summary__item-name">' + esc(f.name) + ' <span>× ' + qty + '</span></div>' +
        '<span class="dd-summary__price">$' + (qty * PRICE) + '</span>' +
      '</div>';
    });
    return html;
  }
  /* ---------- shipping (Australia Post PAC via /api/shipping) ---------- */
  function setShipping(patch) {
    for (var k in patch) state.shipping[k] = patch[k];
    if (state.view === "checkout") renderCheckout();
  }
  function scheduleShippingQuote() {
    if (shipTimer) clearTimeout(shipTimer);
    shipTimer = setTimeout(requestShippingQuote, 450);
  }
  function requestShippingQuote() {
    var pc = String(state.checkoutForm.zip || "").trim();
    if (!/^\d{4}$/.test(pc) || !hasAnyItems()) {
      shipSeq++; // cancel any in-flight response
      setShipping({ status: "idle", cost: 0, service: "", postcode: pc, error: "" });
      return;
    }
    var seq = ++shipSeq;
    setShipping({ status: "loading", postcode: pc, error: "" });
    var p = parcelSpec();
    var url = SHIPPING_ENDPOINT +
      "?to_postcode=" + encodeURIComponent(pc) +
      "&weight=" + p.weight +
      "&length=" + p.length + "&width=" + p.width + "&height=" + p.height;
    fetch(url, { headers: { Accept: "application/json" } })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (seq !== shipSeq) return; // superseded by a newer request
        if (res.ok && res.d && res.d.ok) {
          setShipping({ status: "ready", cost: res.d.price, service: res.d.service, error: "" });
        } else {
          setShipping({ status: "error", cost: 0, service: "", error: (res.d && res.d.error) || "Shipping unavailable." });
        }
      })
      .catch(function () {
        if (seq !== shipSeq) return;
        setShipping({ status: "error", cost: 0, service: "", error: "Couldn't reach the shipping service." });
      });
  }
  function renderShipping() {
    var s = state.shipping;
    var cell = $("[data-summary-shipping]");
    var note = $("[data-summary-shipping-note]");
    note.classList.remove("dd-summary__ship-note--error");
    if (s.status === "ready") {
      cell.textContent = money(s.cost);
      note.hidden = false;
      note.textContent = "Australia Post · " + s.service;
    } else if (s.status === "loading") {
      cell.textContent = "Calculating…";
      note.hidden = true;
    } else if (s.status === "error") {
      cell.textContent = "Unavailable";
      note.hidden = false;
      note.textContent = s.error;
      note.classList.add("dd-summary__ship-note--error");
    } else {
      cell.textContent = "Enter postcode";
      note.hidden = true;
    }
  }
  function renderCheckout() {
    $("[data-summary-lines]").innerHTML = checkoutSummaryHTML();
    $("[data-summary-subtotal]").textContent = money(subtotal());
    renderShipping();
    var total = money(orderTotal());
    $("[data-summary-total]").textContent = total;
    $("[data-place-order]").textContent = "Place Order · " + total;
    $("[data-form-error]").hidden = !state.showFormError;
    // reflect current form values into inputs
    $all("[data-field]").forEach(function (input) {
      input.value = state.checkoutForm[input.getAttribute("data-field")] || "";
    });
  }
  function goCheckout() {
    closeDrawer();
    renderCheckout();
    setView("checkout");
    requestShippingQuote(); // quote immediately if a postcode is already entered
  }
  // Build the cart payload for /api/checkout. Only quantities/labels are sent —
  // the server recomputes every amount, so the client cannot set its own price.
  function orderPayload() {
    var p = parcelSpec();
    return {
      email: String(state.checkoutForm.email || "").trim(),
      to_postcode: String(state.checkoutForm.zip || "").trim(),
      ship_name: String(state.checkoutForm.fullName || "").trim(),
      ship_address: String(state.checkoutForm.address || "").trim(),
      ship_city: String(state.checkoutForm.city || "").trim(),
      ship_region: String(state.checkoutForm.region || "").trim(),
      parcel: { weight: p.weight, length: p.length, width: p.width, height: p.height },
      bottles: cartIds().map(function (id) {
        return { name: fragById(id).name, qty: state.cart[id] };
      }),
      boxes: state.sampleBoxes.map(function (b) {
        return { names: b.items.map(function (id) { return fragById(id).name; }).join(", ") };
      }),
    };
  }

  function showCheckoutError(msg) {
    state.showFormError = true;
    var el = $("[data-form-error]");
    el.textContent = msg;
    el.hidden = false;
  }

  function placeOrder() {
    var f = state.checkoutForm;
    var required = [f.email, f.fullName, f.address, f.city, f.zip];
    if (required.some(function (v) { return !String(v).trim(); }) || !hasAnyItems()) {
      return showCheckoutError("Please fill in your email and shipping address.");
    }

    var btn = $("[data-place-order]");
    if (btn.disabled) return; // guard against double-submit
    var label = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Redirecting to secure checkout…";

    // Stash the shipping name/address so the confirmation screen can greet the
    // buyer by name after the round-trip back from Stripe (payment is still
    // verified server-side before anything is shown).
    try {
      sessionStorage.setItem("mo_pending", JSON.stringify({
        orderNumber: "MO-" + Math.floor(10000 + Math.random() * 89999),
        fullName: f.fullName, address: f.address, city: f.city,
      }));
    } catch (e) { /* private mode — confirmation falls back to session data */ }

    fetch(CHECKOUT_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(orderPayload()),
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (res.ok && res.d && res.d.ok && res.d.url) {
          window.location.href = res.d.url; // → Stripe hosted checkout
        } else {
          throw new Error((res.d && res.d.error) || "Could not start checkout. Please try again.");
        }
      })
      .catch(function (err) {
        btn.disabled = false;
        btn.textContent = label;
        showCheckoutError(err.message || "Could not start checkout. Please try again.");
      });
  }

  /* ---------- return from Stripe ---------- */
  function cleanUrl() {
    if (window.history && window.history.replaceState) {
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }
  function handleReturn() {
    var params = new URLSearchParams(window.location.search);
    var paid = params.get("paid");
    if (paid) return verifyAndConfirm(paid);
    if (params.get("checkout") === "cancelled") {
      // Buyer backed out on Stripe — return them to checkout, cart intact.
      cleanUrl();
      renderCheckout();
      setView("checkout");
    }
  }
  function verifyAndConfirm(sessionId) {
    fetch(ORDER_ENDPOINT + "?session_id=" + encodeURIComponent(sessionId), { headers: { Accept: "application/json" } })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        cleanUrl();
        if (!(d && d.ok && d.paid)) { setView("shop"); return; }

        var stash = {};
        try { stash = JSON.parse(sessionStorage.getItem("mo_pending") || "{}"); } catch (e) { /* ignore */ }
        var order = d.order || {};
        var num = stash.orderNumber || ("MO-" + String(sessionId).slice(-5).toUpperCase());
        $("[data-confirm-order]").textContent = num;

        var name = stash.fullName || order.name || "";
        var ship = name
          ? "Shipping to " + name + (stash.address ? ", " + stash.address : "") + (stash.city ? ", " + stash.city : "") +
            ". Your 10ml bottles ship this week — thank you for trying Maison Obsidian first."
          : "Payment received. Your 10ml bottles ship this week — thank you for trying Maison Obsidian first.";
        $("[data-confirm-ship]").textContent = ship;

        // Order is placed — empty the bag.
        state.cart = {}; state.sampleBoxes = []; state.sampleSelection = [];
        try { sessionStorage.removeItem("mo_pending"); } catch (e) { /* ignore */ }
        updateHeader();
        renderCards();
        setView("confirmed");
      })
      .catch(function () { cleanUrl(); setView("shop"); });
  }
  function continueShopping() {
    state.cart = {};
    state.sampleBoxes = [];
    state.sampleSelection = [];
    state.orderNumber = null;
    state.showFormError = false;
    state.checkoutForm = {
      email: "", fullName: "", address: "", city: "", region: "",
      zip: "", country: "",
    };
    state.shipping = { status: "idle", cost: 0, service: "", postcode: "", error: "" };
    shipSeq++;
    closeDrawer();
    renderCards();
    updateHeader();
    setView("shop");
  }

  /* ---------- smooth scroll ---------- */
  function goToSection(id) {
    var el = document.getElementById(id);
    if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 80, behavior: "smooth" });
  }

  /* ---------- event wiring (delegated) ---------- */
  function wire() {
    document.addEventListener("click", function (e) {
      var t = e.target.closest("[data-inc],[data-dec],[data-sample],[data-go],[data-remove-box]," +
        "[data-open-drawer],[data-close-drawer],[data-add-samplebox],[data-go-checkout]," +
        "[data-back-to-shop],[data-place-order],[data-continue-shopping]");
      if (!t) return;

      if (t.hasAttribute("data-inc")) return inc(t.getAttribute("data-inc"));
      if (t.hasAttribute("data-dec")) return dec(t.getAttribute("data-dec"));
      if (t.hasAttribute("data-sample")) return toggleSample(t.getAttribute("data-sample"));
      if (t.hasAttribute("data-remove-box")) return removeSampleBox(t.getAttribute("data-remove-box"));
      if (t.hasAttribute("data-go")) return goToSection(t.getAttribute("data-go"));
      if (t.hasAttribute("data-open-drawer")) return openDrawer();
      if (t.hasAttribute("data-close-drawer")) return closeDrawer();
      if (t.hasAttribute("data-add-samplebox")) return addSampleBox();
      if (t.hasAttribute("data-go-checkout")) return goCheckout();
      if (t.hasAttribute("data-back-to-shop")) return setView("shop");
      if (t.hasAttribute("data-place-order")) return placeOrder();
      if (t.hasAttribute("data-continue-shopping")) return continueShopping();
    });

    // checkout form inputs
    $all("[data-field]").forEach(function (input) {
      input.addEventListener("input", function () {
        var field = input.getAttribute("data-field");
        state.checkoutForm[field] = input.value;
        if (field === "zip") scheduleShippingQuote();
        if (state.showFormError) {
          state.showFormError = false;
          $("[data-form-error]").hidden = true;
        }
      });
    });

    // Esc closes the drawer
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && state.drawerOpen) closeDrawer();
    });
  }

  /* ---------- init ---------- */
  renderCards();
  updateHeader();
  wire();
  handleReturn(); // resume confirmation / cancellation after a Stripe redirect
})();
