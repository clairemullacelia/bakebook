/* bakebook-billing.js — bakebook+ subscriptions via RevenueCat (native iOS only).
 *
 * IMPORTANT: this file is a COMPLETE NO-OP until you (a) fill in REVENUECAT_IOS_KEY below
 * and (b) install the native plugin (`npm i @revenuecat/purchases-capacitor` + `npx cap sync ios`).
 * On the web, or with an empty key, nothing here changes app behavior — bakebookBilling.available()
 * returns false and the paywall shows a friendly "manage in the app" message.
 *
 * How premium actually flips: the app opens the paywall → the user buys via Apple → RevenueCat verifies
 * the receipt and calls our `revenuecatWebhook` Cloud Function → that sets users/{uid}.premium = true
 * server-side (the single source of truth). The client just reads that flag. See functions/index.js.
 */
(function () {
  "use strict";

  // ---------------- shared scroll-lock ----------------
  // Freeze the page BEHIND an open overlay (settings / paywall / butter sheet) so background
  // scroll/rubber-band is impossible while the sheet is up — scrolling INSIDE the overlay still works.
  // Reuses the same overflow:hidden freeze the photo viewer uses (body.lb-lock). Keyed by overlay name
  // so stacked overlays don't unlock the page while another is still open (releasing one key is a no-op
  // until every key is released). Exposed as window.bbLockScroll / window.bbUnlockScroll for the pages.
  var _scrollLocks = Object.create(null), _lockStyleAdded = false;
  function ensureLockStyle() {
    if (_lockStyleAdded) return; _lockStyleAdded = true;
    var s = document.createElement("style");
    s.textContent = "html.bb-scroll-lock, body.bb-scroll-lock { overflow: hidden !important; }";
    (document.head || document.documentElement).appendChild(s);
  }
  function anyLocked() { for (var k in _scrollLocks) if (_scrollLocks[k]) return true; return false; }
  function applyScrollLock() {
    var on = anyLocked();
    document.documentElement.classList.toggle("bb-scroll-lock", on);
    if (document.body) document.body.classList.toggle("bb-scroll-lock", on);
  }
  function lockScroll(name)   { ensureLockStyle(); _scrollLocks[name || "_"] = true; applyScrollLock(); }
  function unlockScroll(name) { delete _scrollLocks[name || "_"]; applyScrollLock(); }
  window.bbLockScroll = lockScroll;
  window.bbUnlockScroll = unlockScroll;

  // ---------------- config (fill in once RevenueCat is set up) ----------------
  var REVENUECAT_IOS_KEY  = "YOUR_REVENUECAT_PUBLIC_IOS_KEY";  // RevenueCat public (publishable) app-specific key — placeholder in this public mirror
  var PREMIUM_ENTITLEMENT = "premium";                 // the entitlement identifier you create in RevenueCat
  var PRODUCTS = { yearly: "bakebook_plus_yearly", monthly: "bakebook_plus_monthly" };

  // ---------------- native plugin plumbing (guarded) ----------------
  function plugin()  { return (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Purchases) || null; }
  function isNative(){ return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()); }
  function configured(){ return isNative() && !!plugin() && !!REVENUECAT_IOS_KEY; }

  var ready = false;
  // Why did the paywall come back empty? Captured here (human-readable) for on-device debugging —
  // exposed via bakebookBilling.lastLoadDiag() and shown as a small line under the paywall message,
  // and console.warn'd so it shows in Safari Web Inspector / the Xcode console on a sandbox build.
  var lastLoadDiag = "";
  function warnDiag(msg, detail) { lastLoadDiag = msg; try { console.warn("[bakebook+] " + msg, detail); } catch (e) {} }

  // Configure RevenueCat once, tying purchases to the signed-in user (appUserID = firebase uid) so a
  // purchase follows the account, not the device. Hardened: some plugin versions' configure() returns
  // void (synchronous) or throws — the old code swallowed that and left `ready` false forever, so the
  // SDK never fetched products. Now we handle every shape AND record the real reason.
  function init(uid) {
    if (!configured()) { warnDiag("billing not available (not native, or RevenueCat plugin/key missing)"); return Promise.resolve(false); }
    if (ready) return Promise.resolve(true);
    var p;
    try { p = plugin().configure({ apiKey: REVENUECAT_IOS_KEY, appUserID: uid || undefined }); }
    catch (e) { ready = false; warnDiag("RevenueCat configure() threw: " + ((e && (e.message || e.code)) || e), e); return Promise.resolve(false); }
    // configure() returned void/non-promise (older/newer plugin) → treat as configured; getOfferings will reveal any real problem.
    if (!p || typeof p.then !== "function") { ready = true; return Promise.resolve(true); }
    return p.then(function () { ready = true; return true; })
            .catch(function (e) { ready = false; warnDiag("RevenueCat configure() failed: " + ((e && (e.message || e.code)) || e), e); return false; });
  }
  function setUser(uid) {
    if (!configured() || !uid) return Promise.resolve(false);
    if (!ready) return init(uid);
    return plugin().logIn({ appUserID: uid }).then(function () { return true; }).catch(function () { return false; });
  }
  function fetchOfferings() {
    return plugin().getOfferings()
      .then(function (res) {
        var off = res && res.current;
        if (!off) { warnDiag("RevenueCat returned NO current offering — set an offering as ‘Current’ in RevenueCat, with the monthly + yearly packages attached", res); return []; }
        var pkgs = off.availablePackages || [];
        if (!pkgs.length) { warnDiag("current offering ‘" + (off.identifier || "?") + "’ has 0 packages — products not fetchable from the App Store (check RevenueCat product IDs EXACTLY match App Store Connect + each subscription is Ready to Submit, not Missing Metadata)", off); }
        return pkgs;
      })
      .catch(function (e) { warnDiag("getOfferings() failed: " + ((e && (e.message || e.code)) || e), e); return []; });
  }
  function getPackages() {
    if (!configured()) { warnDiag("billing not available on this device (not native, or RevenueCat plugin/key missing)"); return Promise.resolve([]); }
    if (ready) { lastLoadDiag = ""; return fetchOfferings(); }
    // The sign-in init may have raced or configure() returned void — try to configure once more here, then fetch.
    return init().then(function () {
      if (!ready) { if (!lastLoadDiag) warnDiag("RevenueCat never became ready (configure did not complete)"); return []; }
      lastLoadDiag = "";
      return fetchOfferings();
    });
  }
  function entitled(customerInfo) {
    var ent = customerInfo && customerInfo.entitlements && customerInfo.entitlements.active;
    return !!(ent && ent[PREMIUM_ENTITLEMENT]);
  }
  function isPremiumNow() {                              // returns true/false, or null if unknown
    if (!ready) return Promise.resolve(null);
    return plugin().getCustomerInfo().then(function (r) { return entitled(r && r.customerInfo); }).catch(function () { return null; });
  }
  function purchase(pkg) {
    if (!ready || !pkg) return Promise.reject(new Error("purchases not ready"));
    return plugin().purchasePackage({ aPackage: pkg }).then(function (r) { return entitled(r && r.customerInfo); });
  }
  function restore() {
    if (!ready) return Promise.reject(new Error("purchases not ready"));
    return plugin().restorePurchases().then(function (r) { return entitled(r && r.customerInfo); });
  }

  window.bakebookBilling = {
    available: configured, ready: function () { return ready; },
    init: init, setUser: setUser, getPackages: getPackages,
    isPremiumNow: isPremiumNow, purchase: purchase, restore: restore,
    lastLoadDiag: function () { return lastLoadDiag; },
    PRODUCTS: PRODUCTS, PREMIUM_ENTITLEMENT: PREMIUM_ENTITLEMENT
  };

  // ---------------- the paywall (a bottom sheet) ----------------
  // call bakebookShowPaywall("recipes"|"butter"|"") to open it from anywhere.
  var stylesInjected = false;
  function injectStyles() {
    if (stylesInjected) return; stylesInjected = true;
    var css =
      '.bbpw-back{position:fixed;inset:0;z-index:6000;background:rgba(40,25,15,.42);opacity:0;transition:opacity .18s ease}' +
      '.bbpw-back.show{opacity:1}' +
      '.bbpw{position:fixed;left:0;right:0;bottom:0;z-index:6001;max-width:480px;margin:0 auto;background:var(--paper,#FAF9F6);' +
      'border-radius:22px 22px 0 0;box-shadow:0 -12px 40px rgba(40,25,15,.28);transform:translateY(100%);transition:transform .22s ease;' +
      'padding:1.1rem 1.25rem calc(1.4rem + env(safe-area-inset-bottom,0px));box-sizing:border-box;max-height:92vh;overflow:auto}' +
      '.bbpw.show{transform:translateY(0)}' +
      '.bbpw-grip{width:40px;height:4px;border-radius:2px;background:#E3DDD3;margin:0 auto .9rem}' +
      '.bbpw-h{font-family:var(--body,sans-serif);font-weight:800;font-size:1.4rem;color:var(--heading,#33241A);text-align:center;margin:.1rem 0 .2rem;letter-spacing:-.5px}' +
      '.bbpw-sub{text-align:center;color:var(--muted,#8A6F52);font-size:.92rem;margin:0 0 1rem;line-height:1.4}' +
      '.bbpw-feats{list-style:none;padding:0;margin:0 0 1.1rem;display:flex;flex-direction:column;gap:.5rem}' +
      '.bbpw-feats li{display:flex;gap:.6rem;align-items:flex-start;font-size:.95rem;color:var(--ink,#3A2A20)}' +
      '.bbpw-feats li .ck{color:var(--terracotta-deep,#A5533F);font-weight:800;flex:none}' +
      '.bbpw-plan{display:flex;align-items:center;justify-content:space-between;gap:.75rem;width:100%;text-align:left;' +
      'background:var(--card,#FDFCFA);border:1.5px solid var(--field-line,#E3DDD3);border-radius:14px;padding:.85rem 1rem;margin:0 0 .6rem;cursor:pointer;font-family:inherit}' +
      '@media (hover:hover){.bbpw-plan:hover{border-color:var(--terracotta,#BE6F5D)}}' +
      '.bbpw-plan .nm{font-weight:800;color:var(--heading,#33241A);font-size:1rem}' +
      '.bbpw-plan .meta{font-size:.8rem;color:var(--muted,#8A6F52)}' +
      '.bbpw-plan .price{font-weight:800;color:var(--terracotta-deep,#A5533F);font-size:1.05rem;white-space:nowrap}' +
      '.bbpw-plan.best{border-color:var(--terracotta,#BE6F5D)}' +
      '.bbpw-badge{display:inline-block;background:var(--accent-tint,#F1DED7);color:var(--terracotta-deep,#A5533F);font-size:.65rem;font-weight:800;' +
      'text-transform:uppercase;letter-spacing:.04em;padding:2px 7px;border-radius:999px;margin-left:.4rem;vertical-align:middle}' +
      '.bbpw-note{text-align:center;font-size:.78rem;color:var(--muted,#8A6F52);margin:.7rem 0 0;line-height:1.4}' +
      '.bbpw-restore{display:block;margin:.6rem auto 0;background:none;border:none;color:var(--terracotta-deep,#A5533F);font-weight:700;font-size:.85rem;text-decoration:underline;cursor:pointer;font-family:inherit}' +
      '.bbpw-close{position:absolute;right:14px;top:12px;background:none;border:none;color:var(--muted,#8A6F52);font-size:1.4rem;cursor:pointer;line-height:1}' +
      '.bbpw-msg{text-align:center;color:var(--ink,#3A2A20);font-size:.95rem;line-height:1.5;padding:.4rem 0 1rem}';
    var s = document.createElement("style"); s.textContent = css; document.head.appendChild(s);
  }

  var PLAN_META = {};
  PLAN_META[PRODUCTS.yearly]  = { name: "bakebook+ yearly",  best: true,  meta: "best value" };
  PLAN_META[PRODUCTS.monthly] = { name: "bakebook+ monthly", best: false, meta: "billed monthly" };

  window.bakebookShowPaywall = function (reason) {
    injectStyles();
    var back = document.createElement("div"); back.className = "bbpw-back";
    var sheet = document.createElement("div"); sheet.className = "bbpw"; sheet.setAttribute("role", "dialog");
    function close() { unlockScroll("paywall"); back.classList.remove("show"); sheet.classList.remove("show"); setTimeout(function () { back.remove(); sheet.remove(); }, 240); }
    back.addEventListener("click", close);

    var subLine = reason === "butter"
      ? "you’ve used today’s free butter chats. keep the conversation going with bakebook+."
      : reason === "recipes"
        ? "you’ve filled your free recipe collection. store as many as you like with bakebook+."
        : "unlock the full baking lab.";

    sheet.innerHTML =
      '<button class="bbpw-close" aria-label="close">✕</button>' +
      '<div class="bbpw-grip"></div>' +
      '<h2 class="bbpw-h">bakebook+</h2>' +
      '<p class="bbpw-sub">' + subLine + '</p>' +
      '<ul class="bbpw-feats">' +
      '<li><span class="ck">✓</span> keep chatting with butter until every recipe’s just right</li>' +
      '<li><span class="ck">✓</span> a bigger recipe library — grow your whole collection</li>' +
      '<li><span class="ck">✓</span> everything in your baking lab</li>' +
      '</ul>' +
      '<div class="bbpw-plans"></div>' +
      '<button class="bbpw-restore">restore purchases</button>' +
      '<p class="bbpw-note"></p>';
    sheet.querySelector(".bbpw-close").addEventListener("click", close);
    document.body.appendChild(back); document.body.appendChild(sheet);
    lockScroll("paywall");   // freeze the page behind while the paywall is up
    requestAnimationFrame(function () { back.classList.add("show"); sheet.classList.add("show"); });

    var plansEl = sheet.querySelector(".bbpw-plans");
    var noteEl  = sheet.querySelector(".bbpw-note");
    var restoreEl = sheet.querySelector(".bbpw-restore");

    // Not on a real device / no key yet → explain, don't offer a broken buy button.
    if (!window.bakebookBilling || !bakebookBilling.available()) {
      plansEl.innerHTML = '<p class="bbpw-msg">bakebook+ is coming soon. you’ll be able to upgrade right here in the app.</p>';
      restoreEl.style.display = "none";
      return { close: close };
    }

    noteEl.textContent = "auto-renewing subscription billed through your apple id. cancel anytime in settings.";
    plansEl.innerHTML = '<p class="bbpw-msg">loading plans…</p>';

    function done(premium) { if (premium) { onPremiumUnlocked(); close(); } }

    bakebookBilling.getPackages().then(function (packages) {
      if (!packages.length) {
        var diag = (window.bakebookBilling && bakebookBilling.lastLoadDiag && bakebookBilling.lastLoadDiag()) || "";
        try { if (diag) console.warn("[bakebook+] paywall empty — " + diag); } catch (e) {}
        plansEl.innerHTML = '<p class="bbpw-msg">couldn’t load plans right now — please try again in a moment.</p>' +
          (diag ? '<p class="bbpw-diag" style="font-size:12px;opacity:.55;margin-top:10px;line-height:1.45">' + diag.replace(/</g, "&lt;") + '</p>' : '');
        return;
      }
      plansEl.innerHTML = "";
      // show yearly first (best value), then monthly
      packages.sort(function (a, b) {
        var pa = a.product && a.product.identifier, pb = b.product && b.product.identifier;
        return (pa === PRODUCTS.yearly ? -1 : 0) - (pb === PRODUCTS.yearly ? -1 : 0);
      });
      packages.forEach(function (pkg) {
        var pid = pkg.product && pkg.product.identifier;
        var meta = PLAN_META[pid] || { name: (pkg.product && pkg.product.title) || "bakebook+", best: false, meta: "" };
        var btn = document.createElement("button"); btn.className = "bbpw-plan" + (meta.best ? " best" : "");
        btn.innerHTML =
          '<span><span class="nm">' + meta.name + (meta.best ? '<span class="bbpw-badge">best value</span>' : '') + '</span>' +
          '<br><span class="meta">' + (meta.meta || "") + '</span></span>' +
          '<span class="price">' + ((pkg.product && pkg.product.priceString) || "") + '</span>';
        btn.addEventListener("click", function () {
          btn.disabled = true; noteEl.textContent = "opening apple’s purchase sheet…";
          bakebookBilling.purchase(pkg)
            .then(done)
            .catch(function (err) {
              btn.disabled = false;
              // a user cancel isn't an error worth shouting about
              var msg = (err && err.message) || "";
              noteEl.textContent = /cancel/i.test(msg) ? "auto-renewing subscription billed through your apple id. cancel anytime." : "couldn’t complete the purchase — please try again.";
            });
        });
        plansEl.appendChild(btn);
      });
    });

    restoreEl.addEventListener("click", function () {
      restoreEl.textContent = "restoring…"; restoreEl.disabled = true;
      bakebookBilling.restore().then(function (premium) {
        if (premium) { onPremiumUnlocked(); close(); }
        else { restoreEl.textContent = "no purchases found"; }
      }).catch(function () { restoreEl.textContent = "couldn’t restore — try again"; restoreEl.disabled = false; });
    });

    return { close: close };
  };

  // When a purchase/restore succeeds on-device, reflect it immediately (the webhook makes the server
  // agree a beat later). Pages can override window.bakebookOnPremiumUnlocked to refresh their UI.
  function onPremiumUnlocked() {
    try { localStorage.setItem("bakebook.premium", "1"); } catch (e) {}
    if (typeof window.bakebookOnPremiumUnlocked === "function") { try { window.bakebookOnPremiumUnlocked(); } catch (e) {} }
  }
})();
