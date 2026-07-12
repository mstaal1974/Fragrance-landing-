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
      zip: "", country: "", cardNumber: "", cardExpiry: "", cardCvc: "",
    },
  };

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

    var media = f.img
      ? '<div class="dd-card__media dd-card__media--photo">' +
          '<img class="dd-card__img" src="' + esc(f.img) + '" alt="' + esc(f.name) + ' — inspired by ' + esc(f.insp) + '" loading="lazy">' +
        '</div>'
      : '<div class="dd-card__media">' +
          '<div class="dd-card__swatch" style="background:' + swatchGradient(f.liquid) + '"></div>' +
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
  function renderCheckout() {
    $("[data-summary-lines]").innerHTML = checkoutSummaryHTML();
    var total = "$" + subtotal();
    $("[data-summary-subtotal]").textContent = total;
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
  }
  function placeOrder() {
    var f = state.checkoutForm;
    var required = [f.email, f.fullName, f.address, f.city, f.zip, f.cardNumber, f.cardExpiry, f.cardCvc];
    if (required.some(function (v) { return !v.trim(); })) {
      state.showFormError = true;
      $("[data-form-error]").hidden = false;
      return;
    }
    state.orderNumber = "MO-" + Math.floor(10000 + Math.random() * 89999);
    $("[data-confirm-order]").textContent = state.orderNumber;
    $("[data-confirm-ship]").textContent =
      "Shipping to " + f.fullName + ", " + f.address + ", " + f.city +
      ". Your 10ml bottles ship this week — thank you for trying Maison Obsidian first.";
    setView("confirmed");
  }
  function continueShopping() {
    state.cart = {};
    state.sampleBoxes = [];
    state.sampleSelection = [];
    state.orderNumber = null;
    state.showFormError = false;
    state.checkoutForm = {
      email: "", fullName: "", address: "", city: "", region: "",
      zip: "", country: "", cardNumber: "", cardExpiry: "", cardCvc: "",
    };
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
        state.checkoutForm[input.getAttribute("data-field")] = input.value;
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
})();
