// Recipe import (photo or link) goes through the same `claude` function as butter.
//
// The rule here: the app says WHAT to import (these photos, or this link) and nothing else.
// The server writes the instructions, picks the model, sets the length and decides the tools.
//
// History, so the reasons are not lost:
// - Before 28 Sep 2026 the app's whole request was passed on almost as-is, so any signed-in
//   user could run unlimited calls with their own instructions. (docs/bakebook-desktop-audit.html)
// - The first fix (commit eca76ad) rebuilt the request around the app's messages, but the
//   words inside those messages were still the app's. Someone could type any question in place
//   of the recipe instructions and get Haiku to answer it, 30 times a day.
// - This version throws the app's words away and uses the server's own instructions below.
//
// Two request shapes are accepted:
// 1. The NEW shape (apps from this change on):  data.import = { kind: "photo", images: [...] }
//    or { kind: "link", url: "...", resume: [...] }.
// 2. The OLD shape (apps already installed on phones): data.body = { messages: [...], ... }.
//    The phone apps carry their web code inside the app itself (Capacitor copies bakebook/ into
//    the iOS and Android builds), so an installed app keeps sending this shape until the baker
//    updates. The server reads only the photos or the link out of it and ignores the rest.
//    Safe to delete once no installed app older than the release carrying the new shape is left.

const IMPORT_MODEL = "claude-haiku-4-5";
const PHOTO_MAX_TOKENS = 1500;           // the same lengths the app has always asked for
const LINK_MAX_TOKENS = 2000;
const MAX_IMAGES = 10;                   // photo import: several pages of one recipe
const MAX_IMAGE_CHARS = 5 * 1000 * 1000; // one photo, as base64 text (the app shrinks photos to ~0.3 MB)
const MAX_TOTAL_IMAGE_CHARS = 9 * 1000 * 1000; // all photos together (a call can carry about 10 MB)
const MAX_URL_CHARS = 2048;
const MAX_RESUME_TURNS = 4;              // the app retries a paused web fetch at most 3 times
const MAX_RESUME_CHARS = 3 * 1000 * 1000; // what Claude sent back during those pauses, in total
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
// the one tool import may use: Claude fetching a recipe page by its link
const WEB_FETCH_TOOL = { type: "web_fetch_20250910", name: "web_fetch", max_uses: 5 };
// the kinds of pieces Claude itself sends back when a web fetch pauses; the app sends them back to continue
const RESUME_BLOCKS = ["text", "server_tool_use", "web_fetch_tool_result"];

// The instructions. Word for word what the app sent before this change, so the answer comes back
// in exactly the shape every installed app already knows how to read. Change them here only
// together with parseRecipeJSON / normalizeComponents in bakebook/index.html.
// (The long dashes inside are part of the original instruction text, kept so Claude's answers
// don't shift.)
const RECIPE_SHAPE =
  "Reply with ONLY a JSON object — no prose, no markdown fences. Shape: {\"name\": string, \"description\": string, " +
  "\"components\": [{\"name\": string, \"ingredients\": [{\"amount\": string, \"unit\": string, \"name\": string}], " +
  "\"steps\": [string]}]}. If the recipe has distinct parts (e.g. a cake and a frosting, dough and filling, or " +
  "multiple named sub-recipes), return one component per part with its name (like \"cake\", \"frosting\"). If it's " +
  "a single recipe, return one component with an empty name. Prefer these units: g, kg, ml, l, cups, tbsp, tsp, " +
  "oz, pinch, each. If an amount has no unit (like eggs), use \"each\" with the count in amount. Keep steps concise.";
const PHOTO_PROMPT =
  "You are reading one or more photos of a SINGLE recipe — they may be different pages or screenshots of the " +
  "same recipe, so combine everything into one. Extract it and " + lowerFirst(RECIPE_SHAPE) +
  " If you cannot read a recipe, reply {}.";
const LINK_PROMPT =
  "Fetch the recipe at the URL above and extract it. " + RECIPE_SHAPE +
  " If you can't fetch the page or find a recipe, reply {}.";

// Daily ceilings on import calls. Anti-abuse guards no real baker hits, same idea as butter's
// PREMIUM_DAILY_FAIRUSE. A link import is usually 1 call, at most 4. Tune these numbers anytime.
const IMPORT_DAILY_LIMIT = 30;
const PREMIUM_IMPORT_DAILY_LIMIT = 100;

// The words the baker sees when a request is refused.
const MSG_LIMIT = "you've imported a lot of recipes today. try again tomorrow.";
const MSG_BANNED = "this account has been closed for violating butter's guidelines.";
const MSG_UNKNOWN = "bakebook couldn't read that import. try again, or update the app.";

function lowerFirst(s) { return s.charAt(0).toLowerCase() + s.slice(1); }

// An error the function turns into a message for the baker (`importGuard` marks it as ours).
function bad(msg) {
  const e = new Error(msg);
  e.importGuard = true;
  return e;
}

// ---- step 1: work out what the baker wants to import, from either shape ----

// Returns { kind: "photo", images } or { kind: "link", url, resume }. Anything else throws.
function readIntent(data) {
  const d = data || {};
  if (d.import && typeof d.import === "object") return readNewShape(d.import);
  if (d.body && typeof d.body === "object") return readOldShape(d.body);
  throw bad(MSG_UNKNOWN);
}

function readNewShape(imp) {
  if (imp.kind === "photo") {
    const list = Array.isArray(imp.images) ? imp.images : [];
    if (list.length > MAX_IMAGES) throw bad("that's too many photos for one recipe (10 at most).");
    return { kind: "photo", images: list.map(function (im) {
      return checkImage(im && im.media_type, im && im.data);
    }) };
  }
  if (imp.kind === "link") {
    return { kind: "link", url: checkUrl(imp.url), resume: checkResume(imp.resume || []) };
  }
  throw bad(MSG_UNKNOWN);
}

// The old shape is one of exactly two things the installed apps send:
// - photo: ONE user message holding the photos plus the app's instruction text
// - link:  a user message "Recipe URL: <link>\n\n<instruction>", then, if the fetch paused,
//          the pieces Claude sent back (as assistant messages)
// Only the photos and the link are kept. The instruction text, the model, the length, the tools
// and any other field (a system prompt, a beta header) are ignored.
function readOldShape(body) {
  const msgs = body.messages;
  if (!Array.isArray(msgs) || msgs.length === 0) throw bad(MSG_UNKNOWN);
  const first = msgs[0];
  if (!first || first.role !== "user") throw bad(MSG_UNKNOWN);

  if (typeof first.content === "string") {
    const m = /^Recipe URL: (\S+)/.exec(first.content);
    if (!m) throw bad(MSG_UNKNOWN);
    const resume = msgs.slice(1).map(function (x) {
      if (!x || x.role !== "assistant") throw bad(MSG_UNKNOWN);
      return x.content;
    });
    return { kind: "link", url: checkUrl(m[1]), resume: checkResume(resume) };
  }

  if (Array.isArray(first.content) && msgs.length === 1) {
    const images = [];
    first.content.forEach(function (b) {
      if (b && b.type === "image") {
        const s = b.source || {};
        if (s.type !== "base64") throw bad("that image can't be read.");
        if (images.length >= MAX_IMAGES) throw bad("that's too many photos for one recipe (10 at most).");
        images.push(checkImage(s.media_type, s.data));
      } else if (!b || b.type !== "text") {
        throw bad(MSG_UNKNOWN);   // text is allowed in but thrown away; nothing else is allowed
      }
    });
    return { kind: "photo", images: images };
  }

  throw bad(MSG_UNKNOWN);
}

// ---- step 2: check each piece ----

function checkImage(mediaType, data) {
  if (IMAGE_TYPES.indexOf(mediaType) === -1 || typeof data !== "string" || !data) {
    throw bad("that image can't be read.");
  }
  if (data.length > MAX_IMAGE_CHARS) throw bad("that photo is too large. try a smaller one.");
  return { media_type: mediaType, data: data };
}

function checkUrl(raw) {
  if (typeof raw !== "string" || !raw || raw.length > MAX_URL_CHARS) throw bad("that link doesn't look right.");
  let u;
  try { u = new URL(raw); } catch (e) { throw bad("that link doesn't look right."); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw bad("that link doesn't look right.");
  return u.href;
}

// `resume` is a list of what Claude sent back each time a web fetch paused. Each entry is the list
// of pieces from one of those replies. Only the kinds of piece a web fetch produces are allowed.
function checkResume(resume) {
  if (!Array.isArray(resume) || resume.length > MAX_RESUME_TURNS) throw bad("that import took too many steps.");
  resume.forEach(function (content) {
    if (!Array.isArray(content) || content.length === 0) throw bad(MSG_UNKNOWN);
    content.forEach(function (b) {
      if (!b || RESUME_BLOCKS.indexOf(b.type) === -1) throw bad(MSG_UNKNOWN);
      if (b.type === "server_tool_use" && b.name !== "web_fetch") throw bad(MSG_UNKNOWN);
    });
  });
  if (JSON.stringify(resume).length > MAX_RESUME_CHARS) throw bad("that page is too large to import.");
  return resume;
}

// ---- step 3: build the request the server actually sends to Claude ----

function buildFromIntent(intent) {
  if (intent.kind === "photo") {
    if (intent.images.length === 0) throw bad("add a photo of the recipe first.");
    const total = intent.images.reduce(function (n, im) { return n + im.data.length; }, 0);
    if (total > MAX_TOTAL_IMAGE_CHARS) throw bad("those photos are too large together. try fewer.");
    const content = intent.images.map(function (im) {
      return { type: "image", source: { type: "base64", media_type: im.media_type, data: im.data } };
    });
    content.push({ type: "text", text: PHOTO_PROMPT });
    return { model: IMPORT_MODEL, max_tokens: PHOTO_MAX_TOKENS, messages: [{ role: "user", content: content }] };
  }
  // link
  const messages = [{ role: "user", content: "Recipe URL: " + intent.url + "\n\n" + LINK_PROMPT }];
  intent.resume.forEach(function (content) { messages.push({ role: "assistant", content: content }); });
  return {
    model: IMPORT_MODEL,
    max_tokens: LINK_MAX_TOKENS,
    tools: [Object.assign({}, WEB_FETCH_TOOL)],
    messages: messages,
  };
}

// The one call index.js makes: the whole callable `data` in, the Claude request out.
// Throws an error marked `importGuard` with a message fit to show the baker.
function buildImportBody(data) {
  return buildFromIntent(readIntent(data));
}

// ---- the daily ceiling ----

function importLimitFor(premium) {
  return premium ? PREMIUM_IMPORT_DAILY_LIMIT : IMPORT_DAILY_LIMIT;
}

// Given the user's saved record (users/{uid}) and today's date, decide whether one more import is
// allowed. Returns { verdict: "ok" | "limit" | "banned", importUsage } where importUsage is the
// new counter to save when the verdict is "ok". Kept apart from butter's `usage` counts.
function importQuotaVerdict(userDoc, today) {
  const d = userDoc || {};
  if (d.banned === true) return { verdict: "banned" };
  const u = d.importUsage || {};
  const n = (u.day === today) ? (u.n || 0) : 0;
  if (n >= importLimitFor(d.premium === true)) return { verdict: "limit" };
  return { verdict: "ok", importUsage: { day: today, n: n + 1 } };
}

module.exports = {
  buildImportBody,
  importLimitFor,
  importQuotaVerdict,
  IMPORT_MODEL,
  PHOTO_MAX_TOKENS,
  LINK_MAX_TOKENS,
  IMPORT_DAILY_LIMIT,
  PREMIUM_IMPORT_DAILY_LIMIT,
  MAX_IMAGES,
  PHOTO_PROMPT,
  LINK_PROMPT,
  WEB_FETCH_TOOL,
  MSG_LIMIT,
  MSG_BANNED,
};
