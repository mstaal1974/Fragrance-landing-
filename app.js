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
  // "Request a Fragrance" — searchable wholesale library + request submission.
  var REQUEST_ENDPOINT = CFG.requestEndpoint || "/api/request";
  var CATALOGUE_URL = CFG.catalogueUrl || "catalogue.json";
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
    productId: null,     // fragrance id shown in the detail modal, or null
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
    refreshProduct();
  }

  /* ---------- sample box ---------- */
  function toggleSample(id) {
    var i = state.sampleSelection.indexOf(id);
    if (i >= 0) state.sampleSelection.splice(i, 1);
    else if (state.sampleSelection.length < 5) state.sampleSelection.push(id);
    renderCards();
    refreshProduct();
  }
  function addSampleBox() {
    if (state.sampleSelection.length !== 5) return;
    state.sampleBoxes.push({ id: "box-" + Date.now(), items: state.sampleSelection.slice() });
    state.sampleSelection = [];
    renderCards();
    updateHeader();
    refreshProduct();
    closeProduct();
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

  /* ---------- product detail modal ---------- */
  function familyLabel(fam) { return fam === "him" ? "For Him" : fam === "her" ? "For Her" : "Unisex"; }

  function openProduct(id) {
    if (!fragById(id)) return;
    state.productId = id;
    $("[data-product-modal]").hidden = false;
    updateScrollLock();
    renderProduct();
    var close = $("[data-product-modal] [data-close-product]");
    if (close) close.focus();
  }
  function closeProduct() {
    state.productId = null;
    $("[data-product-modal]").hidden = true;
    updateScrollLock();
  }
  function refreshProduct() { if (state.productId) renderProduct(); }

  function renderProduct() {
    var f = fragById(state.productId);
    if (!f) return;
    var qty = qtyFor(f.id);
    var inSample = state.sampleSelection.indexOf(f.id) >= 0;
    var sampleFull = state.sampleSelection.length >= 5 && !inSample;

    var media =
      '<div class="dd-modal__media">' +
        '<div class="dd-modal__swatch" style="background:' + swatchGradient(f.liquid) + '"></div>' +
        (f.img ? '<img class="dd-modal__img" src="' + esc(f.img) + '" alt="' + esc(f.name) + '">' : '') +
      '</div>';

    var action = qty > 0
      ? '<div class="dd-qty dd-qty--lg">' +
          '<button type="button" class="dd-qty__btn" data-dec="' + f.id + '" aria-label="Decrease">−</button>' +
          '<span class="dd-qty__val">' + qty + '</span>' +
          '<button type="button" class="dd-qty__btn" data-inc="' + f.id + '" aria-label="Increase">+</button>' +
        '</div>'
      : '<button type="button" class="dd-btn-gold dd-modal__buy" data-inc="' + f.id + '">Add to Bag · $12</button>';

    var sampleCls = "dd-modal__sample" + (inSample ? " dd-modal__sample--in" : (sampleFull ? " dd-modal__sample--full" : ""));
    var sampleLabel = inSample ? "✓ In Sample Box" : (sampleFull ? "Sample Box Full" : "+ Add to Sample Box");
    var sampleBtn = '<button type="button" class="' + sampleCls + '" data-sample="' + f.id + '"' +
      (sampleFull ? " disabled" : "") + ">" + sampleLabel + "</button>";

    function note(label, val) {
      return '<div class="dd-modal__note">' +
        '<div class="dd-modal__note-label">' + label + '</div>' +
        '<div class="dd-modal__note-val">' + esc(val) + '</div>' +
      '</div>';
    }

    $("[data-product-body]").innerHTML =
      media +
      '<div class="dd-modal__content">' +
        '<div class="dd-modal__insp">' + esc(f.insp) + '</div>' +
        '<h2 class="dd-modal__name">' + esc(f.name) + '</h2>' +
        '<span class="dd-modal__family">' + familyLabel(f.family) + '</span>' +
        '<p class="dd-modal__desc">' + esc(f.desc) + '</p>' +
        '<div class="dd-modal__notes">' +
          note("Top", f.top) + note("Heart", f.heart) + note("Base", f.base) +
        '</div>' +
        '<div class="dd-modal__foot">' +
          '<span class="dd-modal__price">$12 <small>/ 10ml</small></span>' +
          action +
        '</div>' +
        sampleBtn +
      '</div>';
  }

  /* ---------- request a fragrance (wholesale library) ---------- */
  var CHECK_SVG = '<svg width="26" height="26" viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="10" cy="10" r="9" stroke="#c9a961" stroke-width="1.1"/><path d="M6 10l2.6 2.6L14 7" stroke="#c9a961" stroke-width="1.4"/></svg>';
  var catalogue = null;         // lazily loaded from catalogue.json
  var catalogueLoading = false;
  var reqSearchTimer = null;
  var popSearchTimer = null;
  var requestFrag = null;       // item selected for the request modal
  var searchOpen = false;       // the timed/library search popup

  // Lock background scroll while any overlay is open; restore when all closed.
  function updateScrollLock() {
    var any = searchOpen || !!requestFrag || !!state.productId;
    document.body.style.overflow = any ? "hidden" : "";
  }

  function loadCatalogue(cb) {
    if (catalogue) { if (cb) cb(); return; }
    if (catalogueLoading) return;
    catalogueLoading = true;
    [$("[data-request-meta]"), $("[data-search-pop-meta]")].forEach(function (m) { if (m) m.textContent = "Loading library…"; });
    fetch(CATALOGUE_URL, { headers: { Accept: "application/json" } })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        catalogue = Array.isArray(data) ? data : [];
        catalogueLoading = false;
        var inline = $("[data-request-search]"); if (inline) renderRequestResults(inline.value);
        var pop = $("[data-search-pop-input]"); if (pop) renderPopupResults(pop.value);
        if (cb) cb();
      })
      .catch(function () {
        catalogueLoading = false;
        [$("[data-request-meta]"), $("[data-search-pop-meta]")].forEach(function (m) { if (m) m.textContent = "Couldn't load the library — please refresh."; });
      });
  }

  // Match name + brand; return brand-first, then fragrance name (A–Z).
  function searchCatalogue(q) {
    q = String(q || "").trim().toLowerCase();
    if (!q || !catalogue) return { total: 0, items: [] };
    var terms = q.split(/\s+/);
    var matches = catalogue.filter(function (it) {
      var hay = (it.b + " " + it.n).toLowerCase();
      return terms.every(function (t) { return hay.indexOf(t) !== -1; });
    });
    matches.sort(function (a, b) {
      if (a.b !== b.b) return a.b < b.b ? -1 : 1;   // brand first
      return a.n < b.n ? -1 : a.n > b.n ? 1 : 0;    // then fragrance name
    });
    return { total: matches.length, items: matches.slice(0, 60) };
  }

  function rowHTML(it) {
    var price = it.p != null ? ("$" + it.p) : "";
    return '<div class="dd-req-row">' +
      '<div class="dd-req-row__main">' +
        '<div class="dd-req-row__name">' + esc(it.n) + '</div>' +
        (it.s ? '<div class="dd-req-row__size">' + esc(it.s) + '</div>' : '') +
      '</div>' +
      '<div class="dd-req-row__price">' + price + '</div>' +
      '<button type="button" class="dd-req-row__btn" data-request-frag="' + esc(it.id) + '">Request</button>' +
    '</div>';
  }

  // Group the results under their brand — "brand then fragrance".
  function groupHTML(items) {
    var groups = {}, order = [];
    items.forEach(function (it) {
      if (!groups[it.b]) { groups[it.b] = []; order.push(it.b); }
      groups[it.b].push(it);
    });
    return order.map(function (b) {
      return '<div class="dd-req-group">' +
        '<div class="dd-req-group__brand">' + esc(b) + ' <span>' + groups[b].length + '</span></div>' +
        groups[b].map(rowHTML).join("") +
      '</div>';
    }).join("");
  }

  // Shared renderer for both the inline section and the popup.
  function renderResults(wrap, meta, q) {
    if (!wrap) return;
    q = String(q || "").trim();
    if (!q) {
      wrap.innerHTML = "";
      if (meta) meta.textContent = catalogue ? (catalogue.length.toLocaleString() + " fragrances — search by brand or name") : "";
      return;
    }
    if (!catalogue) return; // still loading; loadCatalogue re-renders on arrival
    var res = searchCatalogue(q);
    if (meta) meta.textContent = res.total
      ? ("Showing " + res.items.length + " of " + res.total.toLocaleString() + " match" + (res.total === 1 ? "" : "es"))
      : "No matches — try another spelling.";
    wrap.innerHTML = groupHTML(res.items);
  }
  function renderRequestResults(q) { renderResults($("[data-request-results]"), $("[data-request-meta]"), q); }
  function renderPopupResults(q) { renderResults($("[data-search-pop-results]"), $("[data-search-pop-meta]"), q); }

  /* the timed / library search popup (leaves the inline section in place) */
  function openSearch() {
    searchOpen = true;
    $("[data-search-modal]").hidden = false;
    updateScrollLock();
    loadCatalogue();
    var input = $("[data-search-pop-input]");
    if (input) { renderPopupResults(input.value); input.focus(); }
  }
  function closeSearch() {
    searchOpen = false;
    $("[data-search-modal]").hidden = true;
    updateScrollLock();
  }

  function openRequest(id) {
    var it = catalogue && catalogue.filter(function (x) { return x.id === id; })[0];
    if (!it) return;
    requestFrag = it;
    $("[data-request-modal]").hidden = false;
    updateScrollLock();
    renderRequestForm();
    var el = $('[data-req-field="name"]');
    if (el) el.focus();
  }
  function closeRequest() {
    requestFrag = null;
    $("[data-request-modal]").hidden = true;
    updateScrollLock();
  }
  function renderRequestForm() {
    var it = requestFrag;
    if (!it) return;
    var price = it.p != null ? (" · $" + it.p) : "";
    $("[data-request-form]").innerHTML =
      '<div class="dd-eyebrow">Request Fragrance</div>' +
      '<h3 class="dd-request-form__name">' + esc(it.n) + '</h3>' +
      '<div class="dd-request-form__brand">' + esc(it.b) + (it.s ? " · " + esc(it.s) : "") + price + '</div>' +
      '<div class="dd-request-form__fields">' +
        '<input type="text" class="dd-input" data-req-field="name" placeholder="Your name" autocomplete="name">' +
        '<input type="email" class="dd-input" data-req-field="email" placeholder="Email address" autocomplete="email">' +
        '<input type="number" min="1" class="dd-input" data-req-field="quantity" placeholder="Quantity" value="1">' +
        '<textarea class="dd-input dd-request-form__note" data-req-field="note" placeholder="Anything we should know? (optional)"></textarea>' +
      '</div>' +
      '<button type="button" class="dd-btn-gold dd-btn-gold--block" data-submit-request>Send Request</button>' +
      '<p class="dd-request-form__msg" data-request-msg></p>';
  }
  function requestError(text) {
    var msg = $("[data-request-msg]");
    if (msg) { msg.textContent = text; msg.className = "dd-request-form__msg dd-request-form__msg--err"; }
  }
  function submitRequest() {
    var it = requestFrag;
    if (!it) return;
    var val = function (f) { var el = $('[data-req-field="' + f + '"]'); return el ? el.value : ""; };
    var name = val("name").trim();
    var email = val("email").trim();
    if (!name) return requestError("Please enter your name.");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return requestError("Please enter a valid email.");

    var btn = $("[data-submit-request]");
    if (btn.disabled) return;
    var label = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Sending…";

    fetch(REQUEST_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        name: name, email: email, quantity: val("quantity"), note: val("note"),
        fragrance_name: it.n, brand: it.b, size: it.s, price: it.p, product_id: it.id,
      }),
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (res.ok && res.d && res.d.ok) {
          $("[data-request-form]").innerHTML =
            '<div class="dd-request-form__done">' +
              '<div class="dd-confirm__check">' + CHECK_SVG + '</div>' +
              '<h3 class="dd-request-form__name">Request sent.</h3>' +
              '<p class="dd-request-form__brand">We\'ve noted your interest in ' + esc(it.n) +
                ' and will be in touch at ' + esc(email) + '.</p>' +
              '<button type="button" class="dd-btn-gold dd-btn-gold--block" data-close-request>Done</button>' +
            '</div>';
        } else {
          btn.disabled = false; btn.textContent = label;
          requestError((res.d && res.d.error) || "Could not send. Please try again.");
        }
      })
      .catch(function () {
        btn.disabled = false; btn.textContent = label;
        requestError("Could not send. Please try again.");
      });
  }

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

    return '<div class="dd-card" data-open-product="' + f.id + '">' + media +
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
        "[data-back-to-shop],[data-place-order],[data-continue-shopping],[data-close-product]," +
        "[data-request-frag],[data-close-request],[data-submit-request],[data-close-search],[data-open-search]");
      if (t) {
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
        if (t.hasAttribute("data-close-product")) return closeProduct();
        if (t.hasAttribute("data-request-frag")) return openRequest(t.getAttribute("data-request-frag"));
        if (t.hasAttribute("data-close-request")) return closeRequest();
        if (t.hasAttribute("data-submit-request")) return submitRequest();
        if (t.hasAttribute("data-open-search")) return openSearch();
        if (t.hasAttribute("data-close-search")) return closeSearch();
        return;
      }
      // Non-control click on a card opens its detail modal.
      var card = e.target.closest("[data-open-product]");
      if (card) return openProduct(card.getAttribute("data-open-product"));
    });

    // Request-library search (inline): lazy-load the catalogue, filter as they type.
    var reqSearch = $("[data-request-search]");
    if (reqSearch) {
      reqSearch.addEventListener("focus", function () { loadCatalogue(); });
      reqSearch.addEventListener("input", function () {
        loadCatalogue();
        if (reqSearchTimer) clearTimeout(reqSearchTimer);
        var v = reqSearch.value;
        reqSearchTimer = setTimeout(function () { renderRequestResults(v); }, 120);
      });
    }
    // Same search inside the timed popup.
    var popSearch = $("[data-search-pop-input]");
    if (popSearch) {
      popSearch.addEventListener("input", function () {
        loadCatalogue();
        if (popSearchTimer) clearTimeout(popSearchTimer);
        var v = popSearch.value;
        popSearchTimer = setTimeout(function () { renderPopupResults(v); }, 120);
      });
    }

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

    // Esc closes the product modal first, then the drawer
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      if (requestFrag) return closeRequest();
      if (searchOpen) return closeSearch();
      if (state.productId) return closeProduct();
      if (state.drawerOpen) return closeDrawer();
    });
  }

  /* ---------- init ---------- */
  renderCards();
  updateHeader();
  wire();
  handleReturn(); // resume confirmation / cancellation after a Stripe redirect

  // Invite visitors to search the library — once per session, after 10s, and
  // only if they're still browsing and nothing else is open. The inline
  // Request section stays put regardless.
  try {
    if (!sessionStorage.getItem("mo_search_shown")) {
      setTimeout(function () {
        if (searchOpen || requestFrag || state.productId || state.drawerOpen || state.view !== "shop") return;
        try { sessionStorage.setItem("mo_search_shown", "1"); } catch (e) { /* ignore */ }
        openSearch();
      }, 10000);
    }
  } catch (e) { /* sessionStorage blocked — simply skip the auto-popup */ }
})();
