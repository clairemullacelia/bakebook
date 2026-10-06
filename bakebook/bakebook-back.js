/* bakebook-back.js: the Android "back" gesture (or back button) always undoes ONE step and
 * never leaves the app.
 *
 * WHY THIS EXISTS: bakebook runs inside an Android WebView (a browser window with no address bar,
 * wrapped up as an app by Capacitor). Capacitor's default for "back" is: go back in browser
 * history if it can, otherwise close the app. bakebook opens most things (sheets, forms, the
 * make-it view) without changing the browser history, so "back" had nothing to go back to and
 * simply quit the app, from every screen. Registering our own handler here turns that default off.
 *
 * WHAT "BACK" DOES, in order, the first that applies:
 *   1. a yes/no dialog is up → dismiss it (same as tapping outside it)
 *   2. make-it (cook mode) is open → close it (same as its × button)
 *   3. a sheet, popup, photo viewer, dropdown or form is open → close it (same as its own close control)
 *   4. the page has its own "← back" → take it (recipe asks first if there are unsaved edits)
 *   5. my recipes (home) with nothing open → send the app to the background, the same as the phone's
 *      home button. This is what every Android app does on its first screen (Claire's call, 2026-09-12).
 *      The app is not closed: reopening it lands on the same list, still signed in.
 *
 * On iPhone and on the plain website nothing here runs unless the page is sent the
 * `bb:androidback` event (see the bottom of the file), which is how the automated tests drive it.
 * The "send to background" step only exists natively; on the web it does nothing at all.
 *
 * BUILD TRAP (bit us on Play code 7, 2026-09-11): the native half of this is the @capacitor/app
 * plugin, and Capacitor only switches a plugin on if `android/app/src/main/assets/capacitor.plugins.json`
 * lists it. That file is written by `npx cap sync android`, NOT by `npx cap copy android`. A build
 * made after `copy` alone shipped with the plugin silently off and back still quit the app.
 * MainActivity.java now carries a native safety net for that case, and the check below logs it.
 */
(function () {
  "use strict";

  // helper: "click" a button/link the way a finger tap would, but only if it exists
  function tap(el) { if (el) { el.click(); return true; } return false; }
  function isOpen(el) { return !!el && !el.classList.contains("hidden"); }

  // Are we the butter chat living INSIDE another page's popup (an iframe)? Then we may close
  // things, but we must never navigate away or minimise: that is the outer page's job.
  var embedded = false;
  try { embedded = (window.parent && window.parent !== window); } catch (e) { embedded = false; }

  // ---------- steps 1–3: close whatever is open on top of the page ----------
  // Returns true if it closed something (so "back" stops here), false if nothing was open.
  function closeTopmost() {
    // 1. a dialog the app drew (bb-modal): confirm boxes on home + recipe, butter's name/list modals.
    //    Tapping the dim backdrop is every dialog's "cancel", so that is what we do. (We do NOT press
    //    the left-hand button: on the recipe's unsaved-edits dialog that button LEAVES the page.)
    var modal = document.querySelector(".bb-modal.show");
    if (modal) return tap(modal);

    // 1b. the first-run coach tip (recipe page): tapping its dim backdrop is "got it"
    var coach = document.querySelector(".coach-backdrop");
    if (coach) return tap(coach);

    // 2. make-it / cook mode (recipe page): its × button
    var cook = document.getElementById("cookMode");
    if (cook) return tap(cook.querySelector(".cook-exit"));

    // 3. overlays, top-most first
    // the unit sheet (bakebook-units.js): tapping its dim backdrop closes it
    if (typeof window.bbCloseUnitSheet === "function" && window.bbCloseUnitSheet()) return true;
    // the time / serves sheet (bakebook-meta.js), same shape
    if (typeof window.bbCloseMetaSheet === "function" && window.bbCloseMetaSheet()) return true;

    // the bakebook+ paywall (drawn by bakebook-billing.js on top of everything else)
    var paywall = document.querySelector(".bbpw.show");
    if (paywall) return tap(paywall.querySelector(".bbpw-close"));

    // the full-screen photo viewer (recipe + logbook)
    var lightbox = document.getElementById("lightbox");
    if (lightbox && lightbox.classList.contains("open")) {
      if (typeof window.closeLightbox === "function") { window.closeLightbox(); return true; }   // recipe page
      return tap(lightbox);                                                                     // logbook: a tap closes it
    }

    // the butter popup (home + recipe). butter's own dialogs live inside the popup's iframe, so ask
    // the iframe to close one of those first; only when it has nothing open do we close the popup.
    var butterSheet = document.getElementById("butterSheet");
    if (isOpen(butterSheet)) {
      try {
        var frame = butterSheet.querySelector("iframe");
        var inner = frame && frame.contentWindow;
        if (inner && typeof inner.bbBackCloseTopmost === "function" && inner.bbBackCloseTopmost()) return true;
      } catch (e) {}
      if (typeof window.bbCloseButter === "function") { window.bbCloseButter(); return true; }
      return tap(butterSheet.querySelector("#butterClose"));
    }

    // the settings sheet (home)
    var settings = document.getElementById("settingsSheet");
    if (isOpen(settings)) {
      if (typeof window.bbCloseSettings === "function") { window.bbCloseSettings(); return true; }
      return tap(document.getElementById("settingsClose"));
    }

    // the category dropdown inside the new-recipe form (home): hide it and drop focus, which is
    // what tapping elsewhere does. Closed BEFORE the form because it sits on top of the form.
    var catDrop = document.getElementById("categoryDropdown");
    if (isOpen(catDrop)) {
      catDrop.classList.add("hidden");
      var catInput = document.getElementById("categoryInput");
      if (catInput) catInput.blur();
      return true;
    }

    // the ingredient type-ahead under the new-recipe form's ingredient box (home): same treatment
    var ingDrop = document.getElementById("ingDropdown");
    if (isOpen(ingDrop)) {
      ingDrop.classList.add("hidden");
      var ingInput = document.getElementById("ingName");
      if (ingInput) ingInput.blur();
      return true;
    }

    // a custom dropdown menu (recipe sort / scale pickers, the unit picker inside the new-recipe form):
    // a tap elsewhere hides them. Checked BEFORE the form because the picker sits on top of it.
    var menus = document.querySelectorAll(".sel-list:not(.hidden)");
    if (menus.length) { menus.forEach(function (m) { m.classList.add("hidden"); }); return true; }

    // the new-recipe form (home): same as its home button; the draft is kept, nothing is lost
    var createForm = document.getElementById("createForm");
    if (isOpen(createForm)) {
      if (typeof window.bbCloseCreateForm === "function") { window.bbCloseCreateForm(); return true; }
      return tap(document.getElementById("createBack"));
    }

    // the logbook's "log a bake" form covers the list: its "← back to logs" button
    var logForm = document.getElementById("formView");
    if (isOpen(logForm) && document.getElementById("cancelBtn")) return tap(document.getElementById("cancelBtn"));

    return false;   // nothing was open
  }
  // the outer page calls this on the butter iframe (see above); harmless to expose everywhere
  window.bbBackCloseTopmost = closeTopmost;

  // ---------- step 4: the page's own "← back" route ----------
  // Returns true if the page has one and took it.
  function pageBack() {
    // recipe page: exactly what its back button does (asks first when there are unsaved edits)
    if (typeof window.bbBackToRecipes === "function") { window.bbBackToRecipes(); return true; }
    // butter + logbook pages: follow their "← back" link
    var link = document.getElementById("back");
    if (link && link.getAttribute("href")) return tap(link);
    return false;
  }

  // ---------- step 5: my recipes (home), nothing open → background the app ----------
  function minimise() {
    try {
      var C = window.Capacitor;
      var native = !!(C && C.isNativePlatform && C.isNativePlatform());
      if (native && C.Plugins && C.Plugins.App && typeof C.Plugins.App.minimizeApp === "function") {
        C.Plugins.App.minimizeApp();
      }
      // on the web there is no "background" to go to, so nothing happens (on purpose)
    } catch (e) {}
  }

  // ---------- the handler itself ----------
  function onBack() {
    try {
      if (closeTopmost()) return;
      if (embedded) return;        // inside a popup: never navigate the popup away, never minimise
      if (pageBack()) return;
      minimise();
    } catch (e) {
      // a broken handler must never turn "back" into "quit", so swallow and log
      try { console.warn("[bakebook] back handler error", e); } catch (x) {}
    }
  }

  // ---------- wiring ----------
  // On a real Android device Capacitor's App plugin fires "backButton" for the gesture/button.
  // Registering ANY listener switches off Capacitor's default (history back, else quit the app).
  try {
    var Cap = window.Capacitor;
    var isNative = !!(Cap && Cap.isNativePlatform && Cap.isNativePlatform());
    var App = isNative && Cap.Plugins && Cap.Plugins.App;
    if (App && typeof App.addListener === "function") {
      App.addListener("backButton", onBack);
    } else if (isNative && !embedded) {
      // The plugin is compiled in but not switched on: see BUILD TRAP at the top. Shows in logcat.
      console.warn("[bakebook] @capacitor/app is not registered; run `npx cap sync android` and rebuild");
    }
  } catch (e) {}   // website, iOS build: change nothing, throw nothing

  // The test harness cannot swipe, so it sends the page this plain event instead:
  //   document.dispatchEvent(new Event("bb:androidback"))
  document.addEventListener("bb:androidback", onBack);
})();
