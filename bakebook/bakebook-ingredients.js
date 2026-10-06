/* bakebook-ingredients.js: the ingredient library, built from the baker's own recipes.
 *
 * The library on the new-recipe form and on the recipe page's edit mode used to be a fixed list of
 * 33 common baking ingredients and nothing else. Now it learns: every ingredient in a saved recipe
 * (components included) joins the list, spellings of the same thing merge into one entry, and the
 * entry remembers the amount and unit the baker used last. Nothing is stored for this; the list is
 * rebuilt from the saved recipes every time it is shown, so deleting the last recipe that used an
 * ingredient simply drops it off the list.
 *
 * Three pieces, in the order they run:
 *   bbNormalizeIngredient(name)  cleans a name into a key ("All-Purpose Flour" -> "all purpose flour")
 *   bbIngredientKey(name, keys)  says which existing entry a name belongs to (alias, then one-letter typo,
 *                                but never a typo when the name is a known ingredient)
 *   bbBuildLibrary(recipes, starters)  walks the recipes and returns the entries, most-used first, at most 100
 *
 * Claire asked for this on 2026-09-12 (request "the ingredient library learns").
 */
(function () {
  "use strict";

  var CAP = 100;   // the library never shows more than this many entries

  // ---------- known aliases: the name on the left is the one entry, the rest merge into it ----------
  // Compared after cleaning, so case, hyphens and plurals do not matter here. Add pairs freely.
  var ALIASES = {
    "all purpose flour": ["ap flour", "all-purpose flour", "plain flour", "ap", "apf"],
    "bread flour": ["strong flour", "strong white flour", "strong bread flour"],
    "whole wheat flour": ["wholemeal flour", "whole-wheat flour", "wholewheat flour"],
    "powdered sugar": ["icing sugar", "confectioners sugar", "confectioner's sugar", "confectioners' sugar", "10x sugar"],
    "caster sugar": ["superfine sugar", "castor sugar"],
    "granulated sugar": ["white sugar", "sugar", "white granulated sugar"],
    "brown sugar": ["soft brown sugar"],
    "baking soda": ["bicarb", "bicarbonate", "bicarbonate of soda", "bicarbonate soda", "sodium bicarbonate", "bicarb soda"],
    "cornstarch": ["corn starch", "cornflour", "corn flour"],
    "heavy cream": ["double cream", "heavy whipping cream", "whipping cream"],
    "unsalted butter": ["butter", "softened butter", "melted butter"],
    "whole milk": ["milk", "full fat milk", "full cream milk"],
    "eggs": ["egg", "large eggs", "large egg", "whole eggs", "whole egg"],
    "egg whites": ["egg white", "large egg whites"],
    "egg yolks": ["egg yolk", "large egg yolks"],
    "vanilla extract": ["vanilla", "vanilla essence", "pure vanilla extract"],
    "chocolate chips": ["choc chips", "chocolate chip", "chocolate chunks"],
    "cocoa powder": ["cocoa", "unsweetened cocoa powder", "dutch process cocoa", "dutch process cocoa powder"],
    "salt": ["sea salt", "kosher salt", "table salt", "fine salt", "fine sea salt"],
    "cinnamon": ["ground cinnamon"],
    "water": ["warm water", "cold water", "lukewarm water", "hot water"],
    "vegetable oil": ["veg oil", "neutral oil", "canola oil", "rapeseed oil"],
    "baking powder": ["double acting baking powder"],
    "lemon juice": ["fresh lemon juice", "juice of a lemon"],
    "cream cheese": ["full fat cream cheese"],
    "sour cream": ["soured cream"],
    "yogurt": ["yoghurt", "plain yogurt", "natural yogurt", "greek yogurt"],
    "oats": ["rolled oats", "porridge oats", "old fashioned oats"]
  };

  // ---------- cleaning a name into a key ----------
  // words that look plural but are not: never trimmed
  var KEEP_AS_IS = ["molasses", "couscous", "hummus", "asparagus", "citrus"];
  // one word: singular, unless it ends in "ss" or "us" (hummus, cress) or is very short
  function singular(w) {
    if (w.length < 4) return w;
    if (KEEP_AS_IS.indexOf(w) !== -1) return w;
    if (/(ss|us)$/.test(w)) return w;
    if (/(cook|brown|blond|smooth|vegg)ies$/.test(w)) return w.slice(0, -1);              // cookies -> cookie, not cooky
    if (/ies$/.test(w)) return w.length >= 5 ? w.slice(0, -3) + "y" : w.slice(0, -1);   // berries -> berry, pies -> pie
    if (/(s|x|z|ch|sh)es$/.test(w)) return w.slice(0, -2);                             // peaches -> peach
    if (/s$/.test(w)) return w.slice(0, -1);                                            // bananas -> banana
    return w;
  }
  // lowercase, hyphens to spaces, punctuation dropped, one space between words, each word singular
  function clean(name) {
    var s = String(name == null ? "" : name).toLowerCase();
    s = s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");   // accents come off the letter ("crème" -> "creme")
    s = s.replace(/[-_\/]+/g, " ");            // hyphens and the like become spaces
    s = s.replace(/[^a-z0-9 ]+/g, "");         // any other punctuation goes (apostrophes, commas, dots)
    s = s.replace(/\s+/g, " ").trim();
    if (!s) return "";
    return s.split(" ").map(singular).join(" ");
  }
  window.bbCleanIngredient = clean;

  // the alias table with both sides cleaned, so lookups are cleaned-to-cleaned
  var ALIAS_KEY = {};
  Object.keys(ALIASES).forEach(function (canon) {
    var ck = clean(canon);
    ALIASES[canon].forEach(function (a) { ALIAS_KEY[clean(a)] = ck; });
  });

  // the cleaned name, then mapped through the alias table ("ap flour" -> "all purpose flour")
  function normalize(name) {
    var k = clean(name);
    return ALIAS_KEY[k] || k;
  }
  window.bbNormalizeIngredient = normalize;

  // ---------- known names: never treated as a typo of something else ----------
  // The typical baking and everyday cooking ingredients. A name on this list always keeps its own
  // entry, so "goat milk" never folds into "oat milk". Together with the starters and every name in
  // the alias table these make the known list. Compared after cleaning and aliases, so write each
  // one plain and lowercase, in the form a baker would write it; plurals fold on their own ("dates"
  // and "date" are one key). Do not repeat a name that is already in the alias table above; it is
  // known already. Extend freely under the right heading.
  var COMMON_EXTRA = [
    // flours and grains
    "cake flour", "pastry flour", "white whole wheat flour", "whole wheat pastry flour", "self rising flour",
    "00 flour", "tipo 00 flour", "gluten free flour", "gluten free flour blend", "gluten free all purpose flour",
    "rye flour", "dark rye flour", "light rye flour", "pumpernickel flour", "spelt flour", "whole spelt flour",
    "einkorn flour", "emmer flour", "kamut flour", "khorasan flour", "durum flour", "semolina", "semolina flour",
    "oat flour", "rice flour", "brown rice flour", "sweet rice flour", "glutinous rice flour", "almond flour",
    "almond meal", "coconut flour", "buckwheat flour", "chickpea flour", "gram flour", "besan", "chestnut flour",
    "hazelnut flour", "cassava flour", "teff flour", "sorghum flour", "millet flour", "quinoa flour",
    "amaranth flour", "barley flour", "masa harina", "cornmeal", "fine cornmeal", "coarse cornmeal", "polenta",
    "grits", "tapioca starch", "tapioca flour", "tapioca pearls", "potato starch", "potato flour", "arrowroot",
    "arrowroot powder", "arrowroot starch", "vital wheat gluten", "wheat gluten", "quick oats", "steel cut oats",
    "oat bran", "wheat bran", "bran", "wheat germ", "barley", "pearl barley", "rice", "arborio rice", "basmati rice",
    "jasmine rice", "brown rice", "wild rice", "quinoa", "couscous", "bulgur", "farro", "millet", "amaranth",
    "buckwheat", "puffed rice", "crispy rice cereal", "rice cereal", "cornflakes", "granola", "muesli", "cereal",
    "breadcrumbs", "panko", "graham crackers", "graham cracker crumbs", "digestive biscuits", "cookie crumbs",
    "gingersnaps", "ladyfingers", "wafers", "crackers", "pretzels", "matzo", "matzo meal", "pasta", "spaghetti",
    "noodles", "puff pastry", "phyllo dough", "filo pastry", "shortcrust pastry", "pie crust", "pie dough",
    "pizza dough", "bread dough", "cake mix", "yellow cake mix", "brownie mix", "pancake mix",
    // sugars and sweeteners
    "cane sugar", "raw cane sugar", "light brown sugar", "dark brown sugar", "muscovado sugar",
    "light muscovado sugar", "dark muscovado sugar", "demerara sugar", "turbinado sugar", "raw sugar",
    "coconut sugar", "date sugar", "palm sugar", "maple sugar", "pearl sugar", "sanding sugar", "sparkling sugar",
    "coarse sugar", "rock sugar", "jaggery", "piloncillo", "panela", "vanilla sugar", "cinnamon sugar",
    "invert sugar", "trimoline", "isomalt", "glucose", "glucose syrup", "liquid glucose", "dextrose", "corn syrup",
    "light corn syrup", "dark corn syrup", "golden syrup", "maple syrup", "honey", "raw honey", "honey powder",
    "molasses", "blackstrap molasses", "treacle", "black treacle", "agave", "agave nectar", "agave syrup",
    "brown rice syrup", "rice syrup", "malt syrup", "barley malt syrup", "malt extract", "date syrup",
    "pomegranate molasses", "simple syrup", "sugar syrup", "vanilla syrup", "caramel syrup", "elderflower cordial",
    "elderflower syrup", "stevia", "erythritol", "xylitol", "monk fruit sweetener", "allulose", "sweetener",
    "fondant", "poured fondant", "rolled fondant", "gum paste", "marzipan", "almond paste", "praline paste",
    "pistachio paste", "hazelnut paste", "caramel", "caramel sauce", "dulce de leche", "cajeta", "toffee",
    "toffee bits", "butterscotch", "butterscotch chips", "sprinkles", "nonpareils", "sugar pearls",
    "edible glitter", "luster dust", "gold leaf", "edible flowers", "candy melts", "marshmallows",
    "mini marshmallows", "marshmallow fluff", "marshmallow creme", "candy canes", "peppermint candies",
    "crushed peppermint", "candy", "meringue powder",
    // fats and oils
    "salted butter", "european butter", "cultured butter", "brown butter", "clarified butter", "ghee",
    "vegan butter", "plant butter", "margarine", "shortening", "vegetable shortening", "lard", "suet", "tallow",
    "beef tallow", "duck fat", "bacon fat", "schmaltz", "coconut oil", "olive oil", "extra virgin olive oil",
    "light olive oil", "sunflower oil", "grapeseed oil", "avocado oil", "peanut oil", "sesame oil",
    "toasted sesame oil", "walnut oil", "hazelnut oil", "corn oil", "safflower oil", "flaxseed oil",
    "cooking spray", "baking spray", "cocoa butter",
    // dairy and eggs
    "skim milk", "skimmed milk", "semi skimmed milk", "low fat milk", "nonfat milk", "lactose free milk",
    "milk powder", "dry milk powder", "nonfat dry milk", "powdered milk", "malted milk powder", "malted milk",
    "buttermilk", "buttermilk powder", "light cream", "single cream", "half and half", "clotted cream",
    "creme fraiche", "kefir", "skyr", "quark", "labneh", "mascarpone", "ricotta", "cottage cheese",
    "condensed milk", "evaporated milk", "whipped cream", "whipped topping", "ice cream", "vanilla ice cream",
    "custard", "pastry cream", "creme patissiere", "creme anglaise", "buttercream", "frosting",
    "cream cheese frosting", "royal icing", "icing", "glaze", "ganache", "duck eggs", "quail eggs",
    "liquid egg whites", "egg white powder", "dried egg whites", "egg replacer", "flax egg", "aquafaba",
    // plant milks and creams
    "goat milk", "sheep milk", "oat milk", "almond milk", "soy milk", "coconut milk", "coconut cream",
    "cashew milk", "rice milk", "hemp milk", "macadamia milk", "pea milk", "cashew cream", "coconut yogurt",
    "vegan cream cheese",
    // leaveners and thickeners
    "yeast", "instant yeast", "active dry yeast", "fresh yeast", "rapid rise yeast", "bread machine yeast",
    "nutritional yeast", "sourdough starter", "sourdough discard", "levain", "poolish", "biga", "cream of tartar",
    "gelatin", "gelatin sheets", "leaf gelatin", "powdered gelatin", "unflavored gelatin", "agar", "agar agar",
    "pectin", "apple pectin", "xanthan gum", "guar gum", "custard powder", "pudding mix", "instant pudding mix",
    "vanilla pudding mix", "diastatic malt powder", "malt powder", "dough conditioner", "dough improver",
    "bread improver", "bakers ammonia", "ammonium carbonate", "lecithin", "soy lecithin", "glycerin",
    "vegetable glycerin", "gum arabic", "tylose", "cmc powder", "psyllium husk", "psyllium", "citric acid",
    "malic acid", "tartaric acid", "ascorbic acid",
    // chocolate and cocoa
    "dark chocolate", "bittersweet chocolate", "semisweet chocolate", "unsweetened chocolate",
    "baking chocolate", "milk chocolate", "white chocolate", "ruby chocolate", "couverture chocolate",
    "compound chocolate", "dipping chocolate", "modeling chocolate", "chocolate coating", "black cocoa",
    "black cocoa powder", "cacao powder", "cocoa nibs", "cacao nibs", "dark chocolate chips",
    "milk chocolate chips", "white chocolate chips", "mini chocolate chips", "peanut butter chips",
    "chocolate shavings", "chocolate sprinkles", "chocolate syrup", "chocolate sauce", "hot fudge",
    "chocolate spread", "chocolate hazelnut spread", "hazelnut spread", "hot chocolate", "hot cocoa mix",
    "chocolate milk",
    // nuts and seeds
    "almonds", "sliced almonds", "slivered almonds", "blanched almonds", "flaked almonds", "ground almonds",
    "walnuts", "pecans", "hazelnuts", "pistachios", "cashews", "peanuts", "macadamia nuts", "macadamias",
    "brazil nuts", "pine nuts", "chestnuts", "chestnut puree", "mixed nuts", "candied pecans", "coconut",
    "shredded coconut", "desiccated coconut", "flaked coconut", "coconut flakes", "toasted coconut",
    "sesame seeds", "black sesame seeds", "black sesame paste", "poppy seeds", "sunflower seeds",
    "pumpkin seeds", "pepitas", "chia seeds", "flaxseed", "ground flaxseed", "flaxseed meal", "linseed",
    "hemp seeds", "hemp hearts", "caraway seeds", "fennel seeds", "nigella seeds", "anise seeds", "aniseed",
    "cumin seeds", "coriander seeds", "mustard seeds", "nut butter", "seed butter", "peanut butter",
    "almond butter", "cashew butter", "sunflower seed butter", "tahini", "cookie butter", "speculoos spread",
    // dried fruit
    "raisins", "golden raisins", "sultanas", "currants", "dried currants", "dried cranberries",
    "dried cherries", "dried apricots", "dried figs", "dates", "medjool dates", "prunes", "dried blueberries",
    "dried mango", "dried apple", "dried pineapple", "dried fruit", "mixed dried fruit", "candied peel",
    "mixed peel", "candied orange peel", "candied lemon peel", "candied ginger", "crystallized ginger",
    "glace cherries", "maraschino cherries", "candied cherries", "glace fruit", "candied fruit", "banana chips",
    "freeze dried strawberries", "freeze dried raspberries", "goji berries", "date paste", "fig paste",
    "prune puree",
    // fresh fruit and vegetables
    "banana", "apple", "green apple", "granny smith apple", "lemon", "lime", "orange", "blood orange",
    "clementine", "mandarin", "tangerine", "grapefruit", "yuzu", "blueberries", "raspberries", "blackberries",
    "strawberries", "cherries", "sour cherries", "cranberries", "gooseberries", "elderberries", "redcurrants",
    "blackcurrants", "mixed berries", "frozen berries", "frozen blueberries", "frozen raspberries",
    "frozen strawberries", "frozen cherries", "peach", "nectarine", "apricot", "pear", "plum", "fig", "grapes",
    "mango", "papaya", "pineapple", "passion fruit", "kiwi", "melon", "watermelon", "cantaloupe", "rhubarb",
    "pomegranate", "persimmon", "quince", "guava", "lychee", "dragon fruit", "plantain", "avocado", "pumpkin",
    "butternut squash", "squash", "sweet potato", "potato", "carrot", "zucchini", "courgette", "beetroot",
    "beet", "eggplant", "aubergine", "corn", "sweetcorn", "creamed corn", "peas", "green beans", "spinach",
    "kale", "broccoli", "cauliflower", "mushrooms", "asparagus",
    "celery", "bell pepper", "red pepper", "jalapeno", "chili", "pumpkin puree", "applesauce", "apple butter",
    "mashed banana", "fruit puree", "raspberry puree", "strawberry puree", "mango puree", "passion fruit puree",
    "lemon curd", "jam", "strawberry jam", "raspberry jam", "apricot jam", "fig jam", "marmalade",
    "orange marmalade", "jelly", "preserves", "fruit preserves", "compote", "pie filling", "cherry pie filling",
    "apple pie filling", "mincemeat", "lemon zest", "orange zest", "lime zest", "grapefruit zest", "lemon oil",
    "orange oil",
    // spices and herbs
    "cinnamon sticks", "cassia", "nutmeg", "ground nutmeg", "mace", "ginger", "fresh ginger", "ground ginger",
    "ginger paste", "cardamom", "cardamom pods", "cloves", "ground cloves", "allspice", "star anise", "anise",
    "vanilla bean", "vanilla bean paste", "vanilla paste", "vanilla powder", "saffron", "lavender",
    "dried lavender", "rosemary", "thyme", "basil", "mint", "fresh mint", "peppermint", "sage", "oregano",
    "parsley", "cilantro", "coriander", "ground coriander", "dill", "chives", "tarragon", "bay leaf",
    "lemongrass", "black pepper", "white pepper", "pepper", "peppercorns", "cayenne", "cayenne pepper",
    "paprika", "smoked paprika", "chili powder", "chili flakes", "red pepper flakes", "cumin", "ground cumin",
    "turmeric", "curry powder", "garam masala", "five spice", "chinese five spice", "pumpkin pie spice",
    "pumpkin spice", "apple pie spice", "mixed spice", "gingerbread spice", "speculaas spice", "chai spice",
    "fennel", "caraway", "juniper berries", "sumac", "zaatar", "everything bagel seasoning", "hibiscus",
    "rose petals", "dried rose petals", "pandan", "pandan leaves", "ube", "horseradish",
    // extracts and flavourings
    "almond extract", "lemon extract", "orange extract", "peppermint extract", "mint extract",
    "coconut extract", "maple extract", "rum extract", "butter extract", "banana extract", "strawberry extract",
    "coffee extract", "hazelnut extract", "anise extract", "pandan extract", "ube extract", "ube halaya",
    "rose water", "orange blossom water", "orange flower water", "food coloring", "gel food coloring",
    "red food coloring",
    // coffee and tea
    "coffee", "brewed coffee", "strong coffee", "cold brew", "espresso", "instant coffee", "instant espresso",
    "espresso powder", "coffee beans", "ground coffee", "tea", "black tea", "green tea", "earl grey",
    "earl grey tea", "chai", "matcha", "hojicha",
    // salts
    "flaky salt", "flaky sea salt", "maldon salt", "coarse salt", "pink salt", "himalayan salt", "smoked salt",
    "celery salt", "garlic salt", "onion salt", "pretzel salt", "seasoned salt",
    // savoury pantry
    "garlic", "garlic cloves", "minced garlic", "garlic powder", "onion", "red onion", "white onion",
    "yellow onion", "onion powder", "green onions", "scallions", "spring onions", "shallot", "leek", "tomato",
    "cherry tomatoes", "tomato paste", "tomato puree", "tomato sauce", "crushed tomatoes", "canned tomatoes",
    "diced tomatoes", "sun dried tomatoes", "roasted red peppers", "pickled jalapenos", "ketchup", "mayonnaise",
    "mustard", "dijon mustard", "whole grain mustard", "mustard powder", "soy sauce", "tamari",
    "worcestershire sauce", "hot sauce", "sriracha", "miso", "white miso", "red miso",
    "pesto", "salsa", "bbq sauce", "barbecue sauce",
    "chipotle",
    "vinegar", "white vinegar", "apple cider vinegar", "cider vinegar", "balsamic vinegar",
    "red wine vinegar", "white wine vinegar", "rice vinegar", "sherry vinegar", "malt vinegar", "olives",
    "chickpeas", "black beans",
    "adzuki beans", "red bean paste", "tofu", "silken tofu",
    "hummus", "stock", "chicken stock", "chicken broth", "vegetable stock", "vegetable broth",
    "bacon",
    "ham",
    "protein powder", "whey protein",
    // cheeses
    "cheddar", "sharp cheddar", "parmesan", "parmigiano reggiano", "pecorino", "gruyere", "emmental",
    "swiss cheese", "mozzarella", "fresh mozzarella", "burrata", "feta", "goat cheese", "chevre", "brie",
    "camembert", "blue cheese", "gorgonzola", "stilton", "halloumi", "paneer", "manchego", "fontina",
    "provolone", "gouda", "edam", "monterey jack", "pepper jack", "colby", "american cheese", "queso fresco",
    "cotija",
    // drinks and liquids used in baking
    "sparkling water", "soda water", "club soda", "ice", "ice water", "coconut water", "rum", "dark rum",
    "white rum", "spiced rum", "bourbon", "whiskey", "scotch", "brandy", "cognac", "calvados", "kirsch",
    "amaretto", "hazelnut liqueur", "coffee liqueur", "irish cream", "irish cream liqueur", "orange liqueur",
    "triple sec", "limoncello", "vodka", "wine", "red wine", "white wine", "sweet wine",
    "dessert wine", "port", "sherry", "marsala", "madeira", "vermouth", "champagne", "prosecco",
    "sparkling wine", "beer", "stout", "ale", "lager", "cider", "hard cider", "apple cider", "apple juice",
    "orange juice", "lime juice", "grapefruit juice", "cranberry juice", "pineapple juice",
    "pomegranate juice", "grape juice", "lemonade", "ginger beer", "ginger ale", "cola",
    "eggnog"
  ];
  var KNOWN = {};
  function learnKnown(names) {
    (names || []).forEach(function (n) { var k = normalize(n); if (k) KNOWN[k] = true; });
  }
  Object.keys(ALIASES).forEach(function (canon) { learnKnown([canon]); learnKnown(ALIASES[canon]); });
  learnKnown(COMMON_EXTRA);

  // ---------- one-letter typos ----------
  // True when a and b are the same or one edit apart: a letter added, dropped or changed, or two
  // neighbours swapped. Anything further apart is a different word.
  function withinOneEdit(a, b) {
    if (a === b) return true;
    var la = a.length, lb = b.length;
    if (Math.abs(la - lb) > 1) return false;
    var i = 0;
    while (i < la && i < lb && a[i] === b[i]) i++;   // shared start
    if (la === lb) {
      if (a.slice(i + 1) === b.slice(i + 1)) return true;                                              // one letter changed
      return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);              // two neighbours swapped
    }
    // one letter added or dropped: skip it in the longer one, the rest must match
    return la > lb ? a.slice(i + 1) === b.slice(i) : b.slice(i + 1) === a.slice(i);
  }

  // Which existing entry does this name belong to? Exact (after cleaning and aliases) first; then,
  // for names of six letters or more, an existing key one typo away; otherwise it is a new entry.
  // A known name is never a typo of something else, so "goat milk" stays beside "oat milk".
  function keyFor(name, existingKeys) {
    var k = normalize(name);
    if (!k) return "";
    existingKeys = existingKeys || [];
    if (existingKeys.indexOf(k) !== -1) return k;
    if (k.length >= 6 && !KNOWN[k]) {
      for (var i = 0; i < existingKeys.length; i++) {
        var e = existingKeys[i];
        if (e.length >= 6 && withinOneEdit(k, e)) return e;
      }
    }
    return k;
  }
  window.bbIngredientKey = keyFor;

  // ---------- building the library ----------
  // recipes: the baker's saved recipes. starters: the common names every baker gets (count 0 until used).
  // Returns at most 100 entries of { name, key, count, lastUsed, amount, unit }, most-used first.
  // amount and unit are null for a starter nobody has used yet; the page fills in its own default then.
  function buildLibrary(recipes, starters) {
    var groups = {}, keys = [], seq = 0;
    learnKnown(starters);   // the starters are known names too

    (starters || []).forEach(function (s, idx) {
      var k = normalize(s);
      if (!k || groups[k]) return;
      groups[k] = { name: String(s).trim().toLowerCase(), key: k, count: 0, lastUsed: 0, amount: null, unit: null,
        starter: idx, seq: seq++, newest: Infinity, exact: Infinity, exactName: "", words: {} };
      keys.push(k);
    });

    // newest recipe first, so the first row we meet for an ingredient is the baker's latest wording
    var ordered = (recipes || []).map(function (r, i) { return { r: r, i: i }; })
      .filter(function (x) { return x.r && typeof x.r === "object"; })
      .sort(function (a, b) {
        var ta = Number(a.r.updatedAt || a.r.createdAt || 0), tb = Number(b.r.updatedAt || b.r.createdAt || 0);
        return (tb - ta) || (b.i - a.i);
      });

    // every ingredient row in that order; a lower "order" is a newer row
    var rows = [];
    ordered.forEach(function (x) {
      var r = x.r;
      var stamp = Number(r.updatedAt || r.createdAt || 0);
      // A multi-part recipe also keeps a flat "ingredients" list that mirrors every component, so
      // walk one or the other, never both, or each ingredient would count twice.
      var lists = [];
      if (Array.isArray(r.components) && r.components.length) {
        r.components.forEach(function (c) { if (c) lists.push(c.ingredients || []); });
      } else {
        lists.push(r.ingredients || []);
      }
      lists.forEach(function (list) {
        if (!Array.isArray(list)) return;
        list.forEach(function (ing) {
          var raw = ing && ing.name != null ? String(ing.name).trim() : "";
          var k = raw ? normalize(raw) : "";
          if (!k) return;
          rows.push({ raw: raw, norm: k, ing: ing, stamp: stamp, order: rows.length });
        });
      });
    });

    // Rows with a known name go first, so every known name has its entry before any typo of it turns
    // up. Otherwise a newer "gaot milk" would open the entry and the older "goat milk" would sit beside it.
    var knownRows = rows.filter(function (row) { return KNOWN[row.norm]; });
    var otherRows = rows.filter(function (row) { return !KNOWN[row.norm]; });
    knownRows.concat(otherRows).forEach(function (row) {
      var k = keyFor(row.raw, keys);
      var g = groups[k];
      if (!g) {
        g = groups[k] = { name: row.raw.toLowerCase(), key: k, count: 0, lastUsed: 0, amount: null, unit: null,
          starter: Infinity, seq: row.order, newest: Infinity, exact: Infinity, exactName: "", words: {} };
        keys.push(k);
      }
      g.count++;
      var word = row.raw.toLowerCase();
      var w = g.words[word] || (g.words[word] = { count: 0, order: row.order });
      w.count++;
      if (row.order < w.order) w.order = row.order;
      if (k === row.norm && row.order < g.exact) {   // the row spelt the entry's own name, not a typo of it
        g.exact = row.order;
        g.exactName = word;
      }
      if (row.order < g.newest) {   // the newest row for this entry: its amount and unit are "last used"
        g.newest = row.order;
        g.lastUsed = row.stamp;
        var amt = row.ing.amount == null ? "" : String(row.ing.amount).trim();
        var unit = row.ing.unit == null ? "" : String(row.ing.unit).trim();
        g.amount = amt !== "" ? amt : null;
        g.unit = unit !== "" ? unit : null;
      }
    });

    // Naming. A known entry is named by the newest row that spelt it right; a typo row never names it,
    // and a starter nobody has spelt right keeps its starter name. An unknown entry has no right spelling
    // to lean on, so the wording used most often names it, the newest on a tie.
    keys.forEach(function (k) {
      var g = groups[k];
      if (KNOWN[k]) {
        if (g.exactName) g.name = g.exactName;
        return;
      }
      var best = "";
      Object.keys(g.words).forEach(function (word) {
        var w = g.words[word], b = g.words[best];
        if (!b || w.count > b.count || (w.count === b.count && w.order < b.order)) best = word;
      });
      if (best) g.name = best;
    });

    var out = keys.map(function (k) { return groups[k]; });
    out.sort(function (a, b) {
      return (b.count - a.count) || (b.lastUsed - a.lastUsed) || (a.starter - b.starter) || (a.seq - b.seq);
    });
    return out.slice(0, CAP).map(function (g) {
      return { name: g.name, key: g.key, count: g.count, lastUsed: g.lastUsed, amount: g.amount, unit: g.unit };
    });
  }
  window.bbBuildLibrary = buildLibrary;

  // Does this entry match what the baker typed? Looks at her raw text, the cleaned text, and the
  // aliased text against both the entry's name and its key, so "ap" finds "all purpose flour" and
  // "bananas" finds "banana". Both pages' search boxes and the type-ahead use this.
  function matches(entry, typed) {
    var raw = String(typed == null ? "" : typed).trim().toLowerCase();
    if (!raw) return true;
    var c = clean(raw), n = normalize(raw);
    var name = entry.name || "", key = entry.key || "";
    if (name.indexOf(raw) !== -1 || key.indexOf(raw) !== -1) return true;
    if (c && (name.indexOf(c) !== -1 || key.indexOf(c) !== -1)) return true;
    return !!n && n !== c && key.indexOf(n) !== -1;
  }
  window.bbIngredientMatches = matches;
})();
