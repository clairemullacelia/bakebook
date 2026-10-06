/* bakebook-units.js: the one list of units, and the bottom sheet you pick one from.
 *
 * Every place a unit gets chosen (the new-recipe row, a draft row being edited, the library cards,
 * the recipe page's edit row) calls bbUnitPicker() below. It draws the same small "g ▾" button the
 * old dropdown had, but tapping it slides up a sheet (like settings) with every unit visible at once:
 * your usual five first, then weight, volume and count. Claire chose this over a long dropdown
 * (design canvas "bakebook unit picker", option D, 2026-09-12).
 *
 * "Usual" is learned: it counts the units across all your saved recipes and shows the five you use
 * most, in your order. With fewer than five in use it fills in from a sensible default.
 */
(function () {
  "use strict";

  var GROUPS = [
    { label: "weight", units: ["g", "kg", "oz", "lb"] },
    { label: "volume", units: ["ml", "l", "tsp", "tbsp", "fl oz", "cups", "pt", "qt", "gal"] },
    { label: "count",  units: ["each", "pinch", "dash"] }
  ];
  var ALL = [];
  GROUPS.forEach(function (g) { ALL = ALL.concat(g.units); });
  var DEFAULT_USUAL = ["g", "cups", "tsp", "tbsp", "each"];

  window.BB_UNITS = ALL.slice();

  // older recipes and imports spell units differently ("cup", "Tablespoons", "grams"); this maps any of
  // them onto the one list above. Unknown strings come back unchanged.
  var ALIAS = { cup: "cups", c: "cups", tablespoon: "tbsp", tablespoons: "tbsp", tbs: "tbsp", tbl: "tbsp", teaspoon: "tsp", teaspoons: "tsp",
    gram: "g", grams: "g", gr: "g", kilogram: "kg", kilograms: "kg", milliliter: "ml", milliliters: "ml", millilitre: "ml", millilitres: "ml",
    liter: "l", liters: "l", litre: "l", litres: "l", ounce: "oz", ounces: "oz", pound: "lb", pounds: "lb", lbs: "lb",
    "fluid ounce": "fl oz", "fluid ounces": "fl oz", floz: "fl oz", pint: "pt", pints: "pt", quart: "qt", quarts: "qt", gallon: "gal", gallons: "gal",
    piece: "each", pieces: "each", pc: "each", pcs: "each", whole: "each", pinches: "pinch", dashes: "dash" };
  function normalizeUnit(u) {
    var k = String(u == null ? "" : u).trim().toLowerCase().replace(/\.$/, "");
    if (ALL.indexOf(k) !== -1) return k;
    return ALIAS[k] || (u == null ? "" : String(u).trim());
  }
  window.bbNormalizeUnit = normalizeUnit;

  // the five units this baker picks most, counted across every saved recipe (components included)
  function usualUnits() {
    var counts = {};
    try {
      var recipes = JSON.parse(localStorage.getItem("bakebook.recipes")) || [];
      recipes.forEach(function (r) {
        var lists = [r.ingredients || []];
        (r.components || []).forEach(function (c) { lists.push(c.ingredients || []); });
        lists.forEach(function (list) {
          list.forEach(function (ing) {
            var u = (ing && ing.unit || "").trim();
            if (u === "cup") u = "cups";                 // imports write either
            if (ALL.indexOf(u) !== -1) counts[u] = (counts[u] || 0) + 1;
          });
        });
      });
    } catch (e) {}
    var used = ALL.filter(function (u) { return counts[u]; })
      .sort(function (a, b) { return counts[b] - counts[a] || ALL.indexOf(a) - ALL.indexOf(b); });
    var out = used.slice(0, 5);
    DEFAULT_USUAL.forEach(function (u) { if (out.length < 5 && out.indexOf(u) === -1) out.push(u); });
    return out;
  }
  window.bbUsualUnits = usualUnits;

  // ---------- the sheet (one for the whole page, built on first use) ----------
  var sheet = null, onPickNow = null;
  function ensureStyle() {
    if (document.getElementById("bbUnitStyle")) return;
    var st = document.createElement("style"); st.id = "bbUnitStyle";
    st.textContent =
      ".unit-sheet{position:fixed;inset:0;z-index:3600}" +
      ".unit-sheet.hidden{display:none}" +
      ".unit-backdrop{position:absolute;inset:0;background:rgba(30,23,20,.4);opacity:0;transition:opacity .18s ease}" +
      ".unit-sheet.show .unit-backdrop{opacity:1}" +
      ".unit-panel{position:absolute;left:0;right:0;bottom:0;max-width:480px;margin:0 auto;background:var(--paper);" +
        "border-radius:22px 22px 0 0;box-shadow:0 -12px 40px rgba(30,23,20,.28);box-sizing:border-box;" +
        "padding:1rem 1.25rem calc(1.4rem + env(safe-area-inset-bottom,0px));transform:translateY(100%);" +
        "transition:transform .22s ease;max-height:90vh;overflow:auto}" +
      ".unit-sheet.show .unit-panel{transform:translateY(0)}" +
      ".unit-grip{width:40px;height:4px;border-radius:2px;background:#E3DDD3;margin:0 auto .8rem}" +
      ".unit-title{font-family:var(--mono);font-weight:700;font-size:.8rem;letter-spacing:.13em;text-transform:uppercase;color:var(--heading);text-align:center;margin:0 0 .6rem}" +
      ".unit-group{font-family:var(--mono);font-size:.62rem;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);margin:.8rem 0 .35rem}" +
      ".unit-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:.5rem}" +
      ".unit-grid.usual{grid-template-columns:repeat(5,minmax(0,1fr))}" +
      ".unit-cell{padding:.7rem 0;text-align:center;border-radius:10px;border:1px solid var(--field-line);background:var(--card);" +
        "color:var(--ink);font-family:inherit;font-size:1rem;font-weight:600;cursor:pointer;min-height:44px;box-sizing:border-box}" +
      ".unit-cell.on{background:var(--terracotta-deep);border-color:var(--terracotta-deep);color:var(--paper)}";
    document.head.appendChild(st);
  }
  function cell(u, current) {
    var b = document.createElement("button"); b.type = "button"; b.className = "unit-cell" + (u === current ? " on" : "");
    b.textContent = u;
    b.addEventListener("click", function () { var f = onPickNow; closeSheet(); if (f) f(u); });
    return b;
  }
  function buildSheet(current) {
    ensureStyle();
    if (!sheet) {
      sheet = document.createElement("div"); sheet.className = "unit-sheet hidden"; sheet.id = "unitSheet";
      var back = document.createElement("div"); back.className = "unit-backdrop";
      back.addEventListener("click", closeSheet);
      var panel = document.createElement("div"); panel.className = "unit-panel";
      sheet.appendChild(back); sheet.appendChild(panel);
      document.body.appendChild(sheet);
    }
    var panel = sheet.querySelector(".unit-panel");
    panel.innerHTML = "";
    var grip = document.createElement("div"); grip.className = "unit-grip"; panel.appendChild(grip);
    var title = document.createElement("div"); title.className = "unit-title"; title.textContent = "unit"; panel.appendChild(title);
    function group(label, units, usual) {
      var g = document.createElement("div"); g.className = "unit-group"; g.textContent = label; panel.appendChild(g);
      var grid = document.createElement("div"); grid.className = "unit-grid" + (usual ? " usual" : "");
      units.forEach(function (u) { grid.appendChild(cell(u, current)); });
      panel.appendChild(grid);
    }
    group("usual", usualUnits(), true);
    GROUPS.forEach(function (gr) { group(gr.label, gr.units, false); });
  }
  function openSheet(current, onPick) {
    buildSheet(current);
    onPickNow = onPick;
    sheet.classList.remove("hidden");
    requestAnimationFrame(function () { sheet.classList.add("show"); });
  }
  function closeSheet() {
    if (!sheet || sheet.classList.contains("hidden")) return false;
    sheet.classList.remove("show");
    onPickNow = null;
    setTimeout(function () { sheet.classList.add("hidden"); }, 220);
    return true;
  }
  window.bbCloseUnitSheet = closeSheet;   // the Android back gesture (bakebook-back.js) closes it too

  // ---------- the button that opens it ----------
  // Same shape as the old dropdown's button (classes .sel / .sel-btn) so every existing style still
  // applies, and the same contract: the returned element has a .value you can read and set.
  window.bbUnitPicker = function (value, onChange, opts) {
    opts = opts || {};
    var wrap = document.createElement("div"); wrap.className = "sel" + (opts.className ? " " + opts.className : "");
    var btn = document.createElement("button"); btn.type = "button"; btn.className = "sel-btn"; btn.setAttribute("aria-label", "unit");
    var lbl = document.createElement("span"); lbl.className = "sel-label";
    var car = document.createElement("span"); car.className = "sel-caret"; car.textContent = "▾";
    btn.appendChild(lbl); btn.appendChild(car); wrap.appendChild(btn);
    var current = normalizeUnit(value) || "g";
    function draw() { lbl.textContent = current; }
    draw();
    btn.addEventListener("mousedown", function (e) { e.preventDefault(); });   // keep focus put (safe inside inline editors)
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      openSheet(current, function (u) { current = u; draw(); if (onChange) onChange(u); });
    });
    // the setter normalises too: a learned "cup" from an old recipe used to land here unchanged and the
    // amount wheel, which looks its grid up by exact name, fell back to grams (Claire's recording, 2026-09-12)
    Object.defineProperty(wrap, "value", { get: function () { return current; }, set: function (v) { current = normalizeUnit(v) || "g"; draw(); } });
    return wrap;
  };
})();
