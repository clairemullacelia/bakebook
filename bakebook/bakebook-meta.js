/* bakebook-meta.js — the "time" and "serves" fields on a recipe.
 *
 * Neither is a text box any more. Each is a tap-to-add line: tap it and a bottom sheet slides up with a
 * scrolling wheel (the same sheet look as the unit picker). Time scrolls in 5-minute notches up to 100 hours;
 * serves scrolls 0 and up. Each sheet also has a "type it" row: type a number, and for time pick min or hr.
 *
 * Contract, same as the old inputs so the pages need no other change: bbTimeField() / bbServesField() return
 * an element with a `.value` string (get and set). A change fires an "input" event on it, so a page that
 * listened for typing on the old box still hears the pick.
 */
(function () {
  "use strict";

  var ROW = 40;            // px per wheel row
  var VISIBLE = 5;         // rows showing in the wheel; the middle one is the pick
  var TIME_MAX_MIN = 100 * 60;

  // ---------- reading and writing the time text ----------
  // stored as plain recipe text: "45 min", "1 hr", "1 hr 25 min". Old recipes may hold anything ("overnight").
  function fmtTime(min) {
    if (!(min > 0)) return "";
    var h = Math.floor(min / 60), m = min % 60;
    if (!h) return m + " min";
    if (!m) return h + " hr";
    return h + " hr " + m + " min";
  }
  function parseTime(text) {          // minutes, or null when the text is not a time we can read
    var s = String(text || "").toLowerCase();
    var h = s.match(/(\d+(?:\.\d+)?)\s*(?:h\b|hr|hour)/), m = s.match(/(\d+(?:\.\d+)?)\s*(?:m\b|min)/);
    if (!h && !m) { var n = s.match(/^\s*(\d+(?:\.\d+)?)\s*$/); return n ? Math.round(+n[1]) : null; }
    return Math.round((h ? +h[1] * 60 : 0) + (m ? +m[1] : 0));
  }

  // ---------- the sheet ----------
  var sheet = null, panel = null;
  function ensureStyle() {
    if (document.getElementById("bbMetaStyle")) return;
    var st = document.createElement("style"); st.id = "bbMetaStyle";
    st.textContent =
      /* the tap-to-add line on the form */
      ".tv-field{display:inline-flex;align-items:baseline;gap:.45rem;background:none;border:none;padding:0;cursor:pointer;font-family:inherit;color:var(--ink)}" +
      /* the label word is the link, styled like every other link in the app: link colour, plain underline */
      ".tv-field .tvlbl{pointer-events:none;color:var(--terracotta-deep);text-decoration:underline;text-underline-offset:3px}" +
      ".tv-field .tv-val{font-size:.95rem;line-height:1.3}" +
      ".tv-field.blank .tv-val{display:none}" +
      /* the sheet (same bones as the unit sheet) */
      ".meta-sheet{position:fixed;inset:0;z-index:3600}" +
      ".meta-sheet.hidden{display:none}" +
      ".meta-backdrop{position:absolute;inset:0;background:rgba(30,23,20,.4);opacity:0;transition:opacity .18s ease}" +
      ".meta-sheet.show .meta-backdrop{opacity:1}" +
      ".meta-panel{position:absolute;left:0;right:0;bottom:0;max-width:480px;margin:0 auto;background:var(--paper);" +
        "border-radius:22px 22px 0 0;box-shadow:0 -12px 40px rgba(30,23,20,.28);box-sizing:border-box;" +
        "padding:1rem 1.25rem calc(1.4rem + env(safe-area-inset-bottom,0px));transform:translateY(100%);" +
        "transition:transform .22s ease;max-height:90vh;overflow:auto}" +
      ".meta-sheet.show .meta-panel{transform:translateY(0)}" +
      ".meta-grip{width:40px;height:4px;border-radius:2px;background:#E3DDD3;margin:0 auto .8rem}" +
      ".meta-title{font-family:var(--mono);font-weight:700;font-size:.8rem;letter-spacing:.13em;text-transform:uppercase;color:var(--heading);text-align:center;margin:0 0 .6rem}" +
      /* the wheel: a scroll-snap list; the middle row is the pick */
      ".meta-wheel{position:relative;height:" + (ROW * VISIBLE) + "px;overflow-y:auto;scroll-snap-type:y mandatory;-webkit-overflow-scrolling:touch;" +
        "overscroll-behavior:contain;scrollbar-width:none;margin:0 auto;max-width:14rem}" +
      ".meta-wheel::-webkit-scrollbar{display:none}" +
      ".meta-wheel .pad{height:" + (ROW * 2) + "px}" +
      ".meta-row{height:" + ROW + "px;line-height:" + ROW + "px;text-align:center;scroll-snap-align:center;font-size:1.05rem;color:var(--muted);" +
        "font-family:var(--mono);font-variant-numeric:tabular-nums}" +
      ".meta-row.on{color:var(--ink);font-weight:700;font-size:1.2rem}" +
      ".meta-wheelwrap{position:relative;margin:.2rem 0 .6rem}" +
      ".meta-wheelwrap::before,.meta-wheelwrap::after{content:'';position:absolute;left:0;right:0;height:" + (ROW * 2) + "px;pointer-events:none;z-index:1}" +
      ".meta-wheelwrap::before{top:0;background:linear-gradient(var(--paper),rgba(246,244,238,0))}" +
      ".meta-wheelwrap::after{bottom:0;background:linear-gradient(rgba(246,244,238,0),var(--paper))}" +
      ".meta-band{position:absolute;left:50%;transform:translateX(-50%);width:14rem;top:" + (ROW * 2) + "px;height:" + ROW + "px;" +
        "border-radius:10px;background:rgba(0,126,156,.10);pointer-events:none}" +
      /* the type-it row */
      ".meta-type{display:flex;align-items:center;gap:.5rem;justify-content:center;margin:.4rem 0 .8rem}" +
      ".meta-type .lab{font-family:var(--mono);font-size:.62rem;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}" +
      ".meta-type input{width:5.2rem;text-align:center;padding:.4rem .5rem;font-size:1rem}" +
      ".meta-seg{display:inline-flex;border:1px solid var(--field-line);border-radius:999px;overflow:hidden}" +
      ".meta-seg button{background:var(--card);border:none;padding:.4rem .8rem;font-family:inherit;font-size:.9rem;font-weight:600;color:var(--ink);cursor:pointer;min-height:36px}" +
      ".meta-seg button.on{background:var(--terracotta-deep);color:var(--paper)}" +
      ".meta-actions{display:flex;gap:.6rem;justify-content:center}" +
      ".meta-actions button{font-family:inherit;font-size:.95rem;font-weight:700;border-radius:999px;padding:.6rem 1.4rem;cursor:pointer;min-height:44px}" +
      ".meta-done{background:var(--terracotta-deep);color:var(--paper);border:none}" +
      ".meta-clear{background:transparent;color:var(--terracotta-deep);border:1.5px solid var(--terracotta)}";
    document.head.appendChild(st);
  }
  function ensureSheet() {
    ensureStyle();
    if (sheet) return;
    sheet = document.createElement("div"); sheet.className = "meta-sheet hidden"; sheet.id = "metaSheet";
    var back = document.createElement("div"); back.className = "meta-backdrop";
    back.addEventListener("click", closeSheet);
    panel = document.createElement("div"); panel.className = "meta-panel";
    sheet.appendChild(back); sheet.appendChild(panel);
    document.body.appendChild(sheet);
  }
  function closeSheet() {
    if (!sheet || sheet.classList.contains("hidden")) return false;
    sheet.classList.remove("show");
    setTimeout(function () { sheet.classList.add("hidden"); panel.innerHTML = ""; }, 220);
    return true;
  }
  window.bbCloseMetaSheet = closeSheet;   // the Android back gesture (bakebook-back.js) closes it too

  // one scrolling wheel. values = the numbers on it, label(v) = how a row reads, start = the value to open on.
  // Returns { el, get } where get() is the value in the middle row right now.
  function makeWheel(values, label, start) {
    var wrap = document.createElement("div"); wrap.className = "meta-wheelwrap";
    var band = document.createElement("div"); band.className = "meta-band";
    var wheel = document.createElement("div"); wheel.className = "meta-wheel";
    var top = document.createElement("div"); top.className = "pad"; wheel.appendChild(top);
    var rows = values.map(function (v) {
      var r = document.createElement("div"); r.className = "meta-row"; r.textContent = label(v);
      r.addEventListener("click", function () { wheel.scrollTo({ top: values.indexOf(v) * ROW, behavior: "smooth" }); });
      wheel.appendChild(r); return r;
    });
    var bottom = document.createElement("div"); bottom.className = "pad"; wheel.appendChild(bottom);
    wrap.appendChild(wheel); wrap.appendChild(band);
    var idx = Math.max(0, values.indexOf(start));
    function mark() {
      var i = Math.min(values.length - 1, Math.max(0, Math.round(wheel.scrollTop / ROW)));
      if (i !== idx) { rows[idx].classList.remove("on"); idx = i; rows[idx].classList.add("on"); }
    }
    rows[idx].classList.add("on");
    wheel.addEventListener("scroll", mark, { passive: true });
    // set the start position once the sheet is on screen (scrollTop does nothing while display:none)
    requestAnimationFrame(function () { wheel.scrollTop = idx * ROW; });
    return { el: wrap, get: function () { return values[idx]; } };
  }

  function openSheet(build) {
    ensureSheet();
    panel.innerHTML = "";
    var grip = document.createElement("div"); grip.className = "meta-grip"; panel.appendChild(grip);
    build(panel);
    sheet.classList.remove("hidden");
    requestAnimationFrame(function () { sheet.classList.add("show"); });
  }
  function actions(onDone, onClear) {
    var row = document.createElement("div"); row.className = "meta-actions";
    var clear = document.createElement("button"); clear.type = "button"; clear.className = "meta-clear"; clear.textContent = "clear";
    clear.addEventListener("click", function () { closeSheet(); onClear(); });
    var done = document.createElement("button"); done.type = "button"; done.className = "meta-done"; done.textContent = "done";
    done.addEventListener("click", function () { closeSheet(); onDone(); });
    row.appendChild(clear); row.appendChild(done);
    return row;
  }

  // ---------- the field on the form ----------
  // Empty, it is a label and a dashed line; tap opens the sheet. Tapping the dim backdrop closes the sheet
  // and changes nothing: only "done" writes the pick (and "clear" empties it).
  function field(labelText, ariaLabel, blankText, onTap) {
    ensureStyle();
    var btn = document.createElement("button"); btn.type = "button"; btn.className = "tv-field blank";
    btn.setAttribute("aria-label", ariaLabel);
    var lab = document.createElement("span"); lab.className = "tvlbl"; lab.textContent = labelText;
    var val = document.createElement("span"); val.className = "tv-val"; val.textContent = blankText;
    btn.appendChild(lab); btn.appendChild(val);
    var current = "";
    function draw() {
      btn.classList.toggle("blank", current === "");
      val.textContent = current === "" ? blankText : current;
    }
    btn.addEventListener("click", function () { onTap(current, function (v) { current = v; draw(); btn.dispatchEvent(new Event("input", { bubbles: true })); }); });
    Object.defineProperty(btn, "value", { get: function () { return current; }, set: function (v) { current = v == null ? "" : String(v); draw(); } });
    return btn;
  }

  // TIME: a wheel of 5-minute notches up to 100 hours, plus "type it" with a min / hr switch
  var TIME_VALUES = []; for (var t = 5; t <= TIME_MAX_MIN; t += 5) TIME_VALUES.push(t);
  window.bbTimeField = function () {
    return field("time", "time", "", function (current, set) {
      var startMin = parseTime(current);
      var start = startMin ? Math.max(5, Math.round(startMin / 5) * 5) : 30;
      openSheet(function (p) {
        var title = document.createElement("div"); title.className = "meta-title"; title.textContent = "time"; p.appendChild(title);
        var w = makeWheel(TIME_VALUES, fmtTime, start); p.appendChild(w.el);
        var typed = null;   // set when she types instead of scrolling
        var row = document.createElement("div"); row.className = "meta-type";
        var lab = document.createElement("span"); lab.className = "lab"; lab.textContent = "or type";
        var inp = document.createElement("input"); inp.type = "text"; inp.inputMode = "decimal"; inp.placeholder = "45"; inp.setAttribute("aria-label", "type a time");
        var seg = document.createElement("div"); seg.className = "meta-seg";
        var unit = "min";
        var bMin = document.createElement("button"); bMin.type = "button"; bMin.textContent = "min"; bMin.className = "on";
        var bHr = document.createElement("button"); bHr.type = "button"; bHr.textContent = "hr";
        function pickUnit(u) { unit = u; bMin.classList.toggle("on", u === "min"); bHr.classList.toggle("on", u === "hr"); typed = inp.value.trim(); }
        bMin.addEventListener("click", function () { pickUnit("min"); });
        bHr.addEventListener("click", function () { pickUnit("hr"); });
        inp.addEventListener("input", function () { typed = inp.value.trim(); });
        seg.appendChild(bMin); seg.appendChild(bHr);
        row.appendChild(lab); row.appendChild(inp); row.appendChild(seg); p.appendChild(row);
        p.appendChild(actions(function () {
          if (typed) {
            var n = parseFloat(typed);
            if (!isNaN(n) && n > 0) { set(fmtTime(Math.round(unit === "hr" ? n * 60 : n))); return; }
          }
          set(fmtTime(w.get()));
        }, function () { set(""); }));
      });
    });
  };

  // SERVES: a wheel from 0 up, plus "type it"
  var SERVES_VALUES = []; for (var n = 0; n <= 500; n++) SERVES_VALUES.push(n);
  window.bbServesField = function () {
    return field("serves", "serves", "", function (current, set) {
      var cur = parseInt(String(current).replace(/[^\d]/g, ""), 10);
      var start = isNaN(cur) ? 4 : Math.min(500, cur);
      openSheet(function (p) {
        var title = document.createElement("div"); title.className = "meta-title"; title.textContent = "serves"; p.appendChild(title);
        var w = makeWheel(SERVES_VALUES, String, start); p.appendChild(w.el);
        var typed = null;
        var row = document.createElement("div"); row.className = "meta-type";
        var lab = document.createElement("span"); lab.className = "lab"; lab.textContent = "or type";
        var inp = document.createElement("input"); inp.type = "text"; inp.inputMode = "numeric"; inp.placeholder = "4"; inp.setAttribute("aria-label", "type how many it serves");
        inp.addEventListener("input", function () { typed = inp.value.trim(); });
        row.appendChild(lab); row.appendChild(inp); p.appendChild(row);
        p.appendChild(actions(function () {
          if (typed) { var v = parseInt(typed, 10); if (!isNaN(v) && v >= 0) { set(String(v)); return; } }
          set(String(w.get()));
        }, function () { set(""); }));
      });
    });
  };
})();
