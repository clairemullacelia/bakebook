// bakebook backend — a secure proxy to Claude.
// The browser never sees an API key: butter (and recipe import) send their request
// here; this function adds YOUR Anthropic key (kept as a server secret) and forwards
// it to Claude. Only signed-in bakebook users can call it.
//
// IMPORTANT — the server no longer trusts the browser. For butter chat, the model,
// reply length, personality, and a per-user DAILY LIMIT are all decided HERE, so a
// savvy user can't switch to a pricey model, ask for a giant reply, turn butter into
// a free general-purpose assistant, or spend your credits without limit.

const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
admin.initializeApp();

// The secret is set once with:  firebase functions:secrets:set ANTHROPIC_API_KEY
const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");

// The shared secret RevenueCat sends in the Authorization header of its webhook, so only RevenueCat
// can flip a user to premium. Set once with:  firebase functions:secrets:set REVENUECAT_WEBHOOK_AUTH
const REVENUECAT_WEBHOOK_AUTH = defineSecret("REVENUECAT_WEBHOOK_AUTH");

// ---- butter's parameters (server-owned so the browser can't change them) ----
const BUTTER_MODEL = "claude-sonnet-5";   // butter's brain — change here to tune cost vs. depth
const BUTTER_MAX_TOKENS = 4000;           // ceiling on a single reply — high enough that thorough
                                          // food-science answers don't get cut off mid-sentence
const DAILY_BUTTER_LIMIT = 4;             // free butter messages per user, per day (lowered 6→4: a few
                                          // messages is enough to "wow" a new baker, and a tighter free
                                          // allowance trims Claude cost + sharpens the reason to upgrade)
const PREMIUM_DAILY_FAIRUSE = 40;         // bakebook+ members: a daily ceiling no real baker hits —
                                          // an anti-abuse guard (runaway loop / a bored kid), NOT a marketed
                                          // limit. Tune this one number anytime to trade cost-safety vs. headroom.
                                          // (lowered 100→40: even a heavy recipe-dev day is ~10-20 exchanges, so
                                          // 40 never touches a real user, but it caps worst-case Claude cost at
                                          // ~$18/mo/account instead of ~$45 — bounding the runaway-account tail.)
const PREMIUM_SONNET_LIMIT = 20;          // bakebook+ "quick mode": a paid member gets full-depth Sonnet for their
                                          // first N butter chats each day; past N, butter keeps helping on the
                                          // cheaper/faster Haiku ("quick mode") for the REST OF THE DAY, then resets
                                          // to full Sonnet tomorrow. A soft, TRANSPARENT step-down (the app tells the
                                          // baker, and that deep-dive returns tomorrow) — not a wall. Trims cost on a
                                          // rare heavy day; only ever affects PAID users past N (free users already
                                          // hit the 4/day cap). Claire proposed 15; set to 20 so a genuine deep-dive
                                          // day isn't cut short. Tune this one number anytime.
const PREMIUM_QUICK_MODEL = "claude-haiku-4-5";  // the model butter uses once a paid member is in "quick mode"

// Any call through this proxy may only use these models (blocks pricey Opus abuse).
const ALLOWED_MODELS = ["claude-haiku-4-5", "claude-sonnet-5"];
const IMPORT_MAX_TOKENS = 3000;           // hard ceiling for non-butter calls (recipe import)

// A cheap, fast model used only to screen each butter message for abuse.
const MODERATION_MODEL = "claude-haiku-4-5";

// The tool butter can call to edit the baker's recipe (only offered when a recipe is in context).
// butter fills in the COMPLETE revised list for any field it changes; the browser shows the baker
// a confirm card and only applies it if they tap "apply" — nothing changes without the baker's OK.
const UPDATE_RECIPE_TOOL = {
  name: "update_recipe",
  description:
    "Apply changes to the baker's current recipe sheet. ONLY call this when the baker clearly asks " +
    "you to update, change, apply, or make edits to their recipe (e.g. 'update my recipe', 'make those " +
    "changes', 'add that step', 'bump the butter to 170g'). For questions, suggestions, or discussion, " +
    "do NOT call it — just answer in text. When you do call it, provide the COMPLETE revised list for " +
    "any field you change: e.g. the full ingredients array with your edits merged in, not only the " +
    "changed lines. Omit fields you are not changing. Always include a short, plain summary of the change. " +
    "IMPORTANT: a summary alone does NOTHING — to actually change the recipe you MUST include the revised " +
    "ingredients array and/or steps array. If the baker asks to change an ingredient or step, the corresponding " +
    "array is required.",
  input_schema: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description: "One short, plain-language sentence describing the change, e.g. 'Browned the butter and added a 30-minute chill step.'",
      },
      ingredients: {
        type: "array",
        description: "The COMPLETE revised ingredient list — include ALL ingredients with your edits merged in. Only provide this if you are changing ingredients.",
        items: {
          type: "object",
          properties: {
            amount: { type: "string", description: "Amount, e.g. '175' or '1.5'" },
            unit: { type: "string", description: "Unit, e.g. 'g', 'cups', 'tsp', 'each'" },
            name: { type: "string", description: "Ingredient name, e.g. 'all-purpose flour'" },
          },
          required: ["name"],
        },
      },
      steps: {
        type: "array",
        description: "The COMPLETE revised list of method steps as plain strings, in order. Only provide this if you are changing the method.",
        items: { type: "string" },
      },
      name: { type: "string", description: "A new recipe name. Only if the baker asked to rename it." },
      description: { type: "string", description: "A new short description. Only if the baker asked to change it." },
    },
    required: ["summary"],
  },
};

// The tool butter can call to SAVE A NEW recipe to the baker's book — offered only from the home chat,
// where there's no recipe open to edit. The browser shows a confirm card; nothing is saved without a tap.
const CREATE_RECIPE_TOOL = {
  name: "create_recipe",
  description:
    "Save a NEW recipe to the baker's book. Call this ONLY when the baker clearly asks you to save, make, or " +
    "create a recipe (e.g. 'save this as a recipe', 'make me a recipe for fudgy brownies', 'add this to my book'). " +
    "Provide the COMPLETE recipe. If it has DISTINCT PARTS (e.g. a cake AND a frosting, or dough + filling + " +
    "assembly), use the `components` array — one entry per part, each with its own name, ingredients, and steps — " +
    "NOT the flat ingredients/steps. For a simple single-part recipe, use the flat `ingredients` and `steps`. Do NOT " +
    "call it for questions or discussion; the baker confirms before anything is added, so make it complete.",
  input_schema: {
    type: "object",
    properties: {
      name: { type: "string", description: "The recipe name, e.g. 'Fudgy Brownies'" },
      description: { type: "string", description: "One short line describing it (optional)" },
      category: { type: "string", description: "A category like 'cookies', 'cakes', 'breads' (optional)" },
      ingredients: {
        type: "array",
        description: "The COMPLETE ingredient list — for a SINGLE-part recipe only. For a multi-part recipe use `components` instead.",
        items: {
          type: "object",
          properties: {
            amount: { type: "string", description: "Amount, e.g. '175' or '1.5'" },
            unit: { type: "string", description: "Unit, e.g. 'g', 'cups', 'tsp', 'each'" },
            name: { type: "string", description: "Ingredient name" },
          },
          required: ["name"],
        },
      },
      steps: { type: "array", description: "The COMPLETE method steps, in order — for a SINGLE-part recipe only.", items: { type: "string" } },
      components: {
        type: "array",
        description: "For a recipe with DISTINCT PARTS: one entry per part (e.g. 'cake', 'frosting', 'assembly'), each with its own name, ingredients, and steps. Use this INSTEAD of the flat ingredients/steps when the recipe has multiple parts.",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "The part's name, e.g. 'cake', 'frosting', 'assembly'" },
            ingredients: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  amount: { type: "string" },
                  unit: { type: "string" },
                  name: { type: "string" },
                },
                required: ["name"],
              },
            },
            steps: { type: "array", items: { type: "string" } },
          },
          required: ["name"],
        },
      },
      summary: { type: "string", description: "One short sentence describing the recipe you're saving." },
    },
    required: ["name"],
  },
};

// Add a whole NEW part (component) to the recipe the baker is looking at — e.g. a streusel topping or a
// glaze that sits alongside the existing part(s). Offered only on a recipe page (canBranch). Confirm-first.
const ADD_COMPONENT_TOOL = {
  name: "add_component",
  description:
    "Add a whole NEW part (component) to the baker's CURRENT recipe — a new element like a 'streusel topping', " +
    "'glaze', 'filling', or 'frosting' that sits ALONGSIDE the existing part(s). Call ONLY when the baker clearly " +
    "asks to ADD a part / component / element / layer to this recipe. Do NOT use it to change an existing part — " +
    "that's update_recipe. Provide the new part's name plus its COMPLETE ingredients and steps. The baker confirms " +
    "before it's added.",
  input_schema: {
    type: "object",
    properties: {
      name: { type: "string", description: "The new part's name, e.g. 'streusel topping', 'glaze', 'filling'." },
      ingredients: {
        type: "array",
        description: "The COMPLETE ingredient list for this new part.",
        items: {
          type: "object",
          properties: {
            amount: { type: "string", description: "Amount, e.g. '175' or '1.5'" },
            unit: { type: "string", description: "Unit, e.g. 'g', 'cups', 'tsp', 'each'" },
            name: { type: "string", description: "Ingredient name" },
          },
          required: ["name"],
        },
      },
      steps: { type: "array", description: "The COMPLETE method steps for this new part, in order.", items: { type: "string" } },
      summary: { type: "string", description: "One short sentence describing the part you're adding." },
    },
    required: ["name"],
  },
};

// Create a VARIATION of the recipe the baker is looking at — a SEPARATE new recipe that branches off it,
// leaving the original untouched. Offered only on a recipe page (canBranch). Confirm-first.
const CREATE_VARIATION_TOOL = {
  name: "create_variation",
  description:
    "Create a VARIATION of the baker's CURRENT recipe — a SEPARATE new recipe that branches off this one (e.g. " +
    "'a chocolate version', 'a gluten-free version', 'a smaller-batch version'). The original stays UNTOUCHED; the " +
    "new recipe is linked to it as a variation. Call ONLY when the baker clearly asks for a variation / a version / " +
    "to branch or spin off this recipe. Provide the variation's name and its COMPLETE recipe with the changes " +
    "applied — use the flat `ingredients` and `steps` for a single-part recipe, or `components` for a multi-part " +
    "one. The baker confirms before it's created.",
  input_schema: {
    type: "object",
    properties: {
      name: { type: "string", description: "The variation's name, e.g. 'Chocolate Macarons'." },
      description: { type: "string", description: "One short line describing it (optional)." },
      ingredients: {
        type: "array",
        description: "The COMPLETE ingredient list — for a SINGLE-part variation only. For multi-part use `components`.",
        items: {
          type: "object",
          properties: {
            amount: { type: "string" },
            unit: { type: "string" },
            name: { type: "string" },
          },
          required: ["name"],
        },
      },
      steps: { type: "array", description: "The COMPLETE method steps, in order — for a SINGLE-part variation only.", items: { type: "string" } },
      components: {
        type: "array",
        description: "For a multi-part variation: one entry per part, each with its own name, ingredients, and steps. Use INSTEAD of the flat ingredients/steps.",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            ingredients: {
              type: "array",
              items: { type: "object", properties: { amount: { type: "string" }, unit: { type: "string" }, name: { type: "string" } }, required: ["name"] },
            },
            steps: { type: "array", items: { type: "string" } },
          },
          required: ["name"],
        },
      },
      summary: { type: "string", description: "One short sentence describing how this variation differs from the original." },
    },
    required: ["name"],
  },
};

// butter's personality + food-science backbone + topic guard. Server-owned so it
// can't be replaced by the browser to make butter answer off-topic questions.
const BUTTER_PERSONA =
  "You are butter, the baking assistant inside a recipe app called bakebook. You are a food " +
  "scientist and pastry expert who reasons from mechanism — how ingredients behave and why.\n\n" +
  "Voice: warm and plain-spoken, never gushing or over-the-top. Lead with the useful answer in " +
  "the first sentence — no filler, no 'great question', no pep talk. Be concise: make each point " +
  "once and stop — don't restate the same idea, pad with caveats, or over-explain. For quick asks, " +
  "1-3 sentences. Go deeper — mechanism, ratios, what to change — only when the baker is " +
  "troubleshooting or asks why, and even then keep it tight.\n\n" +
  "Ground your advice in food science whenever it helps the baker understand: gluten development, " +
  "starch gelatinization, the Maillard reaction and caramelization, emulsification, the roles of " +
  "fat, sugar, water, protein and eggs, leavening (chemical vs. biological, how CO2 and steam set " +
  "structure), hydration ratios, and how temperature and time change the result. Be specific — real " +
  "amounts, ratios, temperatures, times — and briefly name the mechanism so the baker learns the why.\n\n" +
  "When the baker's recipe, its variations, and their bake logs are given below, use them as evidence: " +
  "point to what changed between bakes and predict the effect.\n\n" +
  "Be honest about what you can do. Only offer to save or edit a recipe when you actually can — you'll be told " +
  "below exactly what's possible in THIS view. NEVER offer an action you have no tool for, and never say you've " +
  "saved or changed a recipe unless you called the matching tool in that same turn. For questions, ideas, or " +
  "'what if' discussion, just answer in text.\n\n" +
  "You ONLY help with baking, cooking, and food science. If asked about anything unrelated (coding, math, " +
  "general knowledge, personal advice, etc.), politely decline in one short sentence — explain that butter is " +
  "designed for food science and recipe development — and invite them back to a baking question. Do not answer " +
  "the off-topic question, even partially.\n\n" +
  "Formatting: write in plain sentences. The ONE exception — when you walk through several distinct " +
  "changes, substitutions, or points, structure them so they skim: start each with its short name in " +
  "**bold** (wrapped in double asterisks), then a plain sentence or two explaining it, with a blank " +
  "line between each one. For example:\n\n" +
  "**more chew** — swap 2 tbsp of the sugar for brown sugar; its molasses holds moisture and adds pull.\n\n" +
  "**taller cookies** — chill the dough 30 minutes so the fat firms up and spreads less.\n\n" +
  "Use **bold** ONLY for those short labels. No other markdown — no headings, no italics, no bullet " +
  "characters, no numbered lists.";

// today's date as YYYY-MM-DD (UTC) — the key we bucket a user's daily count under
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// Read a user's butter count for today. Free users get DAILY_BUTTER_LIMIT; premium members get a much
// higher fair-use ceiling (so cost can't run away), but are never shown it as a "limit".
async function butterQuotaAllows(uid) {
  const snap = await admin.firestore().collection("users").doc(uid).get();
  const d = snap.exists ? snap.data() : {};
  const u = d.usage || {};
  const count = (u.day === todayStr()) ? (u.butter || 0) : 0;
  const premium = d.premium === true;
  const limit = premium ? PREMIUM_DAILY_FAIRUSE : DAILY_BUTTER_LIMIT;
  return { allowed: count < limit, premium: premium };
}

// Screen a message for hate speech or sexual content (NOT ordinary profanity).
// Uses a cheap model. Fails OPEN — an infrastructure hiccup never punishes a baker.
async function isOffensive(text, apiKey) {
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODERATION_MODEL,
        max_tokens: 5,
        system:
          "You screen messages sent to a baking app's chat assistant. Reply with EXACTLY one word and nothing " +
          "else: UNSAFE if the message contains hate speech (slurs or dehumanizing content targeting a protected " +
          "group) or sexual content; otherwise SAFE. Ordinary profanity, frustration, or a blunt tone is SAFE.",
        messages: [{ role: "user", content: String(text).slice(0, 4000) }],
      }),
    });
    const json = await res.json();
    const verdict = ((json.content || []).map(function (b) { return b.text || ""; }).join("")).toUpperCase();
    return verdict.indexOf("UNSAFE") !== -1;
  } catch (err) {
    return false; // fail open
  }
}

// Record one abuse strike. First strike → warning; second → the account is banned.
async function recordStrike(uid) {
  const ref = admin.firestore().collection("users").doc(uid);
  return admin.firestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const strikes = ((snap.exists && snap.data().strikes) || 0) + 1;
    const update = { strikes: strikes };
    if (strikes >= 2) update.banned = true;
    tx.set(ref, update, { merge: true });
    return { strikes: strikes, banned: strikes >= 2 };
  });
}

// Count one successful butter message against today's quota (resets on a new day).
// `field` is "butter" (a real user message) or "cont" (a free internal follow-up). We always write BOTH
// counters so one doesn't clobber the other (Firestore set+merge replaces the whole `usage` map).
async function bumpUsage(uid, field) {
  const ref = admin.firestore().collection("users").doc(uid);
  const today = todayStr();
  return admin.firestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const u = (snap.exists && snap.data().usage) || {};
    const sameDay = (u.day === today);
    const butter = (sameDay ? (u.butter || 0) : 0) + (field === "butter" ? 1 : 0);
    const cont = (sameDay ? (u.cont || 0) : 0) + (field === "cont" ? 1 : 0);
    tx.set(ref, { usage: { day: today, butter: butter, cont: cont } }, { merge: true });
    return { butter: butter, cont: cont };   // hand the fresh counts back so we can report them to the client
  });
}

// A "continuation" is a follow-up the CLIENT fires automatically to finish a cut-off answer or to make
// butter spell out the edit it already promised — the user didn't send it, so it must NOT burn a message.
// We give these their own generous daily cap so they can't be abused to get unlimited free butter.
const DAILY_CONT_LIMIT = 30;
async function continuationAllows(uid) {
  const snap = await admin.firestore().collection("users").doc(uid).get();
  const d = snap.exists ? snap.data() : {};
  if (d.premium === true) return true;
  const u = d.usage || {};
  const count = (u.day === todayStr()) ? (u.cont || 0) : 0;
  return count < DAILY_CONT_LIMIT;
}

exports.claude = onCall(
  { secrets: [ANTHROPIC_API_KEY], cors: true },
  async (request) => {
    // 1) must be signed in
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Please sign in to use butter.");
    }
    const uid = request.auth.uid;
    const data = request.data || {};

    // 2) build the Anthropic request. Two paths:
    //    - "butter" chat: the server owns model/tokens/personality + enforces the daily limit.
    //    - anything else (recipe import): accept the client's request but clamp model + tokens.
    let body;
    let butterPremium = false;   // set in the butter branch below; used to report the right daily limit to the client
    let butterQuickMode = false; // paid member past PREMIUM_SONNET_LIMIT today → butter answers on Haiku ("quick mode")
    if (data.kind === "butter") {
      const messages = data.messages;
      if (!Array.isArray(messages) || messages.length === 0) {
        throw new HttpsError("invalid-argument", "No message to send.");
      }

      // a continuation is an automatic follow-up (finish a cut-off answer / spell out an edit) — the user
      // didn't type it, so it skips moderation and doesn't burn a message; it has its own bounded cap.
      const isContinuation = data.continuation === true;

      // already-banned users can't use butter at all
      const uSnap = await admin.firestore().collection("users").doc(uid).get();
      if (uSnap.exists && uSnap.data().banned === true) {
        throw new HttpsError("permission-denied",
          "this account has been closed for violating butter's guidelines.");
      }
      butterPremium = !!(uSnap.exists && uSnap.data() && uSnap.data().premium === true);

      // bakebook+ "quick mode": once a paid member passes PREMIUM_SONNET_LIMIT full-depth chats today, butter
      // keeps helping on Haiku for the rest of the day (resets tomorrow). Reuses the count already on uSnap —
      // no extra read. Only ever for paid users; free users never reach the threshold (4/day cap stops them).
      {
        const uUsage = (uSnap.exists && uSnap.data() && uSnap.data().usage) || {};
        const todayCount = (uUsage.day === todayStr()) ? (uUsage.butter || 0) : 0;
        butterQuickMode = butterPremium && todayCount >= PREMIUM_SONNET_LIMIT;
      }

      if (!isContinuation) {
        // screen the newest user message for hate speech / sexual content (not profanity):
        // first offense = a warning, second = the account is closed. Runs BEFORE the quota
        // check so a flagged message never burns a free chat.
        const last = messages[messages.length - 1];
        const userText = (last && typeof last.content === "string") ? last.content : "";
        if (userText && (await isOffensive(userText, ANTHROPIC_API_KEY.value()))) {
          const strike = await recordStrike(uid);
          if (strike.banned) {
            throw new HttpsError("permission-denied",
              "your account has been closed. hateful or sexual messages aren't allowed on bakebook.");
          }
          throw new HttpsError("failed-precondition",
            "butter is for baking and food science. hateful or sexual messages aren't allowed — " +
            "this is a warning. another will close your account.");
        }

        // daily message limit — free users hit DAILY_BUTTER_LIMIT; premium only ever hits the high fair-use ceiling
        const q = await butterQuotaAllows(uid);
        if (!q.allowed) {
          throw new HttpsError(
            "resource-exhausted",
            q.premium
              ? "butter's baked all day with you — let's pick this back up tomorrow. (just a fair-use pause, not a cap on your plan.)"
              : "butter's had a full day — you've used today's " + DAILY_BUTTER_LIMIT +
                  " free messages. they refresh tomorrow. upgrade to bakebook+ to keep going."
          );
        }
      } else if (!(await continuationAllows(uid))) {
        // continuation budget exhausted (very high cap; effectively only a scripted-abuse guard)
        throw new HttpsError("resource-exhausted", "butter needs a breather — try again in a moment.");
      }
      // the browser may pass the recipe/log context as plain data, but NOT the personality
      const context = (typeof data.recipeContext === "string") ? data.recipeContext : "";

      // Tell butter EXACTLY what it can do here, and hand it only the matching tool — so it never
      // offers something it can't actually do. Editing needs an open recipe; creating is the home chat.
      const tools = [];
      let capabilityNote;
      if (context && data.canEdit) {
        tools.push(UPDATE_RECIPE_TOOL);
        capabilityNote =
          "\n\n----- what you can do here -----\n" +
          "You CAN edit THIS recipe. If (and only if) the baker clearly asks you to update, change, or apply edits " +
          "to it, call update_recipe. CRITICAL: in that SAME call include the COMPLETE revised ingredients array " +
          "and/or steps array — every item, with your changes merged in, not a summary — all in one call. The baker " +
          "confirms before it applies.";
        // canBranch (sent only by an updated client) also lets butter add a new PART or spin off a VARIATION.
        if (data.canBranch) {
          tools.push(ADD_COMPONENT_TOOL, CREATE_VARIATION_TOOL);
          capabilityNote +=
            " You can ALSO add a whole new PART to this recipe (a new component like a topping, glaze, or filling) by " +
            "calling add_component; and create a VARIATION of this recipe (a SEPARATE new recipe that branches off it, " +
            "leaving the original untouched) by calling create_variation. Use add_component or create_variation ONLY " +
            "when the baker clearly asks to add a part or make a variation/version — otherwise edit with update_recipe " +
            "or just answer in text. Each is confirmed by the baker before anything changes.";
        } else {
          capabilityNote += " You cannot create a separate new recipe from here.";
        }
      } else if (data.canCreate) {
        tools.push(CREATE_RECIPE_TOOL);
        capabilityNote =
          "\n\n----- what you can do here -----\n" +
          "The baker is in the home chat, NOT inside a specific recipe. You CAN save a brand-new recipe to their " +
          "book: if (and only if) they clearly ask you to save/make/create a recipe, call create_recipe with the " +
          "COMPLETE recipe. If it has distinct parts (e.g. a cake and a frosting), put EACH part in the `components` " +
          "array (its own name + ingredients + steps) rather than one flat list. The baker confirms before it's " +
          "saved. You CANNOT edit an existing recipe from here — if they want that, tell them to open the recipe first.";
      } else {
        capabilityNote =
          "\n\n----- what you can do here -----\n" +
          "You CANNOT save or edit recipes in this view. If the baker asks you to, say so plainly and tell them to " +
          "open a recipe (or tap “+ new recipe”) first. Do NOT offer to do it, and never pretend you did.";
      }

      // Prompt caching: butter's system prompt is split into cacheable blocks so a multi-message
      // conversation doesn't re-pay full price for the (identical) persona + recipe context on every
      // turn. Caching is a PREFIX match — block 1 (the persona) is byte-identical on every butter
      // call, and block 2 (this view's capabilities + the open recipe) stays identical across a
      // back-and-forth about the same recipe. So the 2nd, 3rd… message in a conversation READS them
      // from cache (~10% of the input price) instead of paying full price again. (First message of a
      // one-off conversation pays a tiny ~1.25x write premium; net win as soon as a chat has 2+ turns.)
      const systemBlocks = [
        { type: "text", text: BUTTER_PERSONA, cache_control: { type: "ephemeral" } },
      ];
      const systemTail = capabilityNote + (context ? "\n\n----- the baker's recipe -----\n" + context : "");
      if (systemTail) systemBlocks.push({ type: "text", text: systemTail, cache_control: { type: "ephemeral" } });

      body = {
        model: butterQuickMode ? PREMIUM_QUICK_MODEL : BUTTER_MODEL,
        max_tokens: BUTTER_MAX_TOKENS,
        system: systemBlocks,
        messages: messages,
      };
      if (tools.length) body.tools = tools;
    } else {
      // recipe import (photo/link). Keep the client's request, but enforce safety caps.
      body = data.body;
      if (!body || !Array.isArray(body.messages)) {
        throw new HttpsError("invalid-argument", "Missing or malformed request body.");
      }
      if (!ALLOWED_MODELS.includes(body.model)) body.model = "claude-haiku-4-5";
      if (!(body.max_tokens > 0) || body.max_tokens > IMPORT_MAX_TOKENS) {
        body.max_tokens = IMPORT_MAX_TOKENS;
      }
    }

    // 3) forward to Claude with the secret key attached server-side
    const headers = {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY.value(),
      "anthropic-version": "2023-06-01",
    };
    // optional beta header (e.g. for the web-fetch tool used by link import)
    if (data.anthropicBeta) {
      headers["anthropic-beta"] = data.anthropicBeta;
    }

    let res, json;
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      json = await res.json();
    } catch (err) {
      throw new HttpsError("unavailable", "Couldn't reach Claude: " + err.message);
    }

    if (!res.ok) {
      const msg = (json && json.error && json.error.message) || ("Claude error " + res.status);
      throw new HttpsError("internal", msg);
    }

    // 4) a butter reply succeeded — count it (best-effort). A real message counts against the daily
    //    limit; an automatic continuation counts only against the hidden continuation cap (free to the user).
    if (data.kind === "butter") {
      const counts = await bumpUsage(uid, data.continuation === true ? "cont" : "butter").catch(function () { return null; });
      // report the AUTHORITATIVE daily count to the client so its "N of 6" / "used all 6" note is never wrong
      if (counts && json && typeof json === "object") {
        json.bbUsage = { used: counts.butter, limit: butterPremium ? PREMIUM_DAILY_FAIRUSE : DAILY_BUTTER_LIMIT, premium: butterPremium, quickMode: butterQuickMode };
      }
    }

    // 5) hand Claude's answer back to the browser
    return json;
  }
);

// Permanently delete the signed-in user's account AND all their data.
// Runs with admin privileges so it can also delete the login itself —
// something the browser SDK refuses to do unless you logged in seconds ago.
// Called from the app's "delete account" button, behind a confirmation.
exports.deleteAccount = onCall({ cors: true }, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Please sign in first.");
  }
  const uid = request.auth.uid;
  try {
    // 1) their user doc AND its subcollections (recipes/*, meta/*) — Firestore does NOT
    //    cascade-delete subcollections, so recursiveDelete is required to leave nothing behind.
    await admin.firestore().recursiveDelete(admin.firestore().collection("users").doc(uid));
    // 2) every photo they uploaded (all live under users/<uid>/...)
    await admin.storage().bucket().deleteFiles({ prefix: "users/" + uid + "/" });
    // 3) the login account itself
    await admin.auth().deleteUser(uid);
  } catch (err) {
    throw new HttpsError("internal", "Couldn't fully delete the account: " + err.message);
  }
  return { ok: true };
});

// ---- bakebook+ subscriptions: RevenueCat webhook (the single source of truth for `premium`) ----
// When someone buys, renews, or lapses, RevenueCat verifies the Apple receipt and POSTs here.
// We flip users/{uid}.premium accordingly. The browser can READ premium but not WRITE it (rules),
// so this server path is the only way an account becomes premium — no self-granting from the client.
//
// Setup: in RevenueCat → Project → Webhooks, point the URL at this function and set the Authorization
// header value to match the REVENUECAT_WEBHOOK_AUTH secret. RevenueCat's `app_user_id` must be the
// Firebase uid (the app configures Purchases with appUserID = uid).
const RC_GRANT  = new Set(["INITIAL_PURCHASE", "RENEWAL", "UNCANCELLATION", "PRODUCT_CHANGE", "NON_RENEWING_PURCHASE", "SUBSCRIPTION_EXTENDED"]);
const RC_REVOKE = new Set(["EXPIRATION", "SUBSCRIPTION_PAUSED"]);
// (CANCELLATION is NOT a revoke — the sub stays active until it actually EXPIRES.)

exports.revenuecatWebhook = onRequest({ secrets: [REVENUECAT_WEBHOOK_AUTH] }, async (req, res) => {
  if (req.method !== "POST") { res.status(405).send("POST only"); return; }

  // only RevenueCat knows the shared secret it sends in the Authorization header
  const expected = REVENUECAT_WEBHOOK_AUTH.value();
  if (!expected || req.get("authorization") !== expected) { res.status(401).send("unauthorized"); return; }

  const event = (req.body && req.body.event) || {};
  const uid = event.app_user_id;
  const type = event.type;

  // ignore RevenueCat's anonymous ids and events not tied to a real bakebook account
  if (!uid || typeof uid !== "string" || uid.indexOf("$RCAnonymousID") === 0) { res.status(200).send("ignored: no account id"); return; }

  let premium = null;
  if (RC_GRANT.has(type)) premium = true;
  else if (RC_REVOKE.has(type)) premium = false;
  if (premium === null) { res.status(200).send("noop: " + type); return; }   // e.g. CANCELLATION, TEST

  try {
    await admin.firestore().collection("users").doc(uid).set({
      premium: premium,
      premiumSource: "revenuecat",
      premiumEvent: type,
      premiumUpdatedAt: Date.now(),
    }, { merge: true });
    res.status(200).send("ok");
  } catch (err) {
    res.status(500).send("error: " + err.message);
  }
});
