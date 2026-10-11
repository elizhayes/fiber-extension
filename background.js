const USDA = 'https://api.nal.usda.gov/fdc/v1';
const FIBER_NUTRIENT_ID = 1079;

const FRAC = { '½': ' 1/2', '¼': ' 1/4', '¾': ' 3/4', '⅓': ' 1/3', '⅔': ' 2/3', '⅛': ' 1/8' };
const UNITS = new Map(Object.entries({
  cup: 'cup', cups: 'cup', c: 'cup',
  tablespoon: 'tbsp', tablespoons: 'tbsp', tbsp: 'tbsp', tbs: 'tbsp',
  teaspoon: 'tsp', teaspoons: 'tsp', tsp: 'tsp',
  ounce: 'oz', ounces: 'oz', oz: 'oz', pound: 'lb', pounds: 'lb', lb: 'lb', lbs: 'lb',
  gram: 'g', grams: 'g', g: 'g', kilogram: 'kg', kilograms: 'kg', kg: 'kg',
  ml: 'ml', milliliter: 'ml', milliliters: 'ml', l: 'l', liter: 'l', liters: 'l'
}));
const PACKAGES = new Set(['can', 'cans', 'package', 'packages', 'jar', 'jars', 'bag', 'bags', 'box', 'boxes']);
const COUNTERS = new Set(['clove', 'cloves', 'stalk', 'stalks', 'sprig', 'sprigs', 'slice', 'slices', 'head', 'heads']);

const NUM = '(\\d+\\s+\\d+/\\d+|\\d+/\\d+|\\d*\\.?\\d+)';
const LINE_RE = new RegExp('^' + NUM + '(?:\\s*(?:-|–|to)\\s*' + NUM + ')?\\s*(.*)$');

function toNum(s) {
  return s.trim().split(/\s+/).reduce((t, p) => {
    if (p.includes('/')) { const [a, b] = p.split('/'); return t + a / b; }
    return t + +p;
  }, 0);
}

// ---------- Step 1: rules-based parsing ----------
function parseLine(raw) {
  const s = raw.replace(/[½¼¾⅓⅔⅛]/g, m => FRAC[m]).replace(/\s+/g, ' ').replace(/(\d+)\s+and\s+(\d+\/\d+)/gi, '$1 $2').trim();
  if (/optional/i.test(s)) return { skip: 'optional' };
  const m = s.match(LINE_RE);
  if (!m) return /\d/.test(s) ? { low: true } : { skip: 'no quantity' };

  let qty = toNum(m[1]);
  if (m[2]) qty = (qty + toNum(m[2])) / 2;           // ranges -> midpoint
  let rest = m[3];

  let size = null;                                    // "(15 oz)" package size
  const paren = rest.match(/\(([^)]*)\)/);
  if (paren) {
    const sm = paren[1].match(/(\d*\.?\d+)\s*(ounces?|oz|grams?|g|lbs?|pounds?|ml)\b/i);
    if (sm) size = { qty: +sm[1], unit: UNITS.get(sm[2].toLowerCase()) };
    rest = rest.replace(paren[0], ' ').replace(/\s+/g, ' ').trim();
  }

  const words = rest.split(' ');
  const w = words[0].toLowerCase().replace(/\.$/, '');
  if (w === 'pinch' || w === 'dash') return { skip: 'trace amount' };

  let unit = 'count', foodStr = rest;
  if (UNITS.has(w)) { unit = UNITS.get(w); foodStr = words.slice(1).join(' '); }
  else if (COUNTERS.has(w)) { foodStr = words.slice(1).join(' '); }
  else if (PACKAGES.has(w)) {
    if (!size) return { low: true };
    qty *= size.qty; unit = size.unit; foodStr = words.slice(1).join(' ');
  }

  foodStr = foodStr.replace(/^of\s+/i, '');
  const [head, ...tail] = foodStr.split(',');
  const state = tail.join(',').trim().match(/^(cooked|raw|dried?|canned)/i);
  const food = (head + (state ? ', ' + state[1] : '')).replace(/\b(small|medium|large|fresh|freshly|additional|extra)\s+/gi, '').trim();
  const low = !food || / or /i.test(food) || food.split(' ').length > 6 || /\b(handful|bunch|splash|drizzle|dollop)\b/i.test(food);
  return { qty, unit, food, low };
}

// ---------- Step 2: LLM fallback for hard lines (one batched call) ----------
const LLM_SYSTEM = `You parse recipe ingredient lines. Input is a JSON array of strings.
Output ONLY a JSON array of the same length and order. Each item:
{"qty": number|null, "unit": "cup"|"tbsp"|"tsp"|"oz"|"lb"|"g"|"kg"|"ml"|"l"|"count", "food": string, "optional": boolean}
Rules: "food" is a short USDA-searchable name with no prep words (e.g. "chickpeas, cooked", "all-purpose flour").
Convert package sizes to weight ("1 (15 oz) can black beans" -> qty 15, unit "oz").
For "A or B" alternatives, use the first. Ranges -> midpoint. If there is no measurable amount, qty is null.`;

async function llmParse(lines, apiKey) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model: 'claude-haiku-5-5',
      max_tokens: 2000,
      system: LLM_SYSTEM,
      messages: [{ role: 'user', content: JSON.stringify(lines) }]
    })
  });
  if (!r.ok) throw new Error(`Anthropic API ${r.status}`);
  const data = await r.json();
  const text = data.content.filter(b => b.type === 'text').map(b => b.text).join('');
  const arr = JSON.parse(text.replace(/```json|```/g, '').trim());
  if (!Array.isArray(arr) || arr.length !== lines.length) throw new Error('Bad LLM output');
  return arr;
}

// ---------- Step 3: USDA lookup (cached) ----------
async function fetchFood(fdcId, apiKey) {
  const dr = await fetch(`${USDA}/food/${fdcId}?api_key=${apiKey}`);
  if (!dr.ok) throw new Error(`USDA ${dr.status}`);
  const d = await dr.json();
  const fiber = d.foodNutrients?.find(n => n.nutrient?.id === FIBER_NUTRIENT_ID)?.amount ?? 0;
  return {
    fdcId,
    name: d.description,
    fiberPer100g: fiber,
    portions: (d.foodPortions || []).filter(p => p.gramWeight).map(p => ({
      label: [p.measureUnit?.name !== 'undetermined' ? p.measureUnit?.name : '', p.modifier || '']
        .join(' ').toLowerCase(),
      grams: p.gramWeight / (p.amount || 1)
    }))
  };
}

async function searchFoods(foodName, apiKey, pageSize) {
  const q = encodeURIComponent(foodName);
  const sr = await fetch(`${USDA}/foods/search?api_key=${apiKey}&query=${q}&dataType=SR%20Legacy,Foundation&pageSize=${pageSize}`);
  if (!sr.ok) throw new Error(`USDA ${sr.status}`);
  return (await sr.json()).foods || [];
}

// User corrections ("override:") win over the automatic cache ("food:").
async function lookup(foodName, apiKey) {
  const k = foodName.toLowerCase();
  const stored = await chrome.storage.local.get(['override:' + k, 'food:' + k]);
  if (stored['override:' + k]) return stored['override:' + k];
  if (stored['food:' + k]) return stored['food:' + k];

  const [hit] = await searchFoods(foodName, apiKey, 3);
  if (!hit) return null;
  const food = await fetchFood(hit.fdcId, apiKey);
  await chrome.storage.local.set({ ['food:' + k]: food });
  return food;
}

// ---------- Step 4: convert to grams ----------
function toGrams(unit, qty, food) {
  const weight = { g: 1, kg: 1000, oz: 28.35, lb: 453.6 };
  if (weight[unit]) return { grams: qty * weight[unit] };

  if (unit === 'count') {
    const p = food.portions.find(p => !/cup|tbsp|tablespoon|tsp|teaspoon|\boz\b|fl|gram/.test(p.label));
    return p ? { grams: qty * p.grams } : null;
  }

  const names = { cup: ['cup'], tbsp: ['tbsp', 'tablespoon'], tsp: ['tsp', 'teaspoon'] };
  const ml = { cup: 240, tbsp: 15, tsp: 5, ml: 1, l: 1000 };
  if (names[unit]) {
    const direct = food.portions.find(p => names[unit].some(n => p.label.includes(n)));
    if (direct) return { grams: qty * direct.grams };
    const cup = food.portions.find(p => p.label.includes('cup'));
    if (cup) return { grams: qty * cup.grams * (ml[unit] / 240) };
  }
  if (!ml[unit]) return null;
  return { grams: qty * ml[unit], approx: true };     // assumes water density; flagged in UI
}

// ---------- Orchestration ----------
async function processItem(it, usdaKey) {
  const base = { raw: it.raw, viaLLM: !!it.viaLLM, qty: it.qty, unit: it.unit, food: it.food };
  if (it.skip) return { ...base, status: 'skipped', note: it.skip };
  if (it.low || !it.food || it.qty == null) return { ...base, status: 'unparsed' };
  try {
    const food = await lookup(it.food, usdaKey);
    if (!food) return { ...base, food: it.food, status: 'unmatched' };
    const g = toGrams(it.unit, it.qty, food);
    if (!g) return { ...base, food: it.food, matched: food.name, status: 'unconverted' };
    return { ...base, food: it.food, matched: food.name, grams: g.grams,
             fiber: (g.grams * food.fiberPer100g) / 100, status: g.approx ? 'approx' : 'ok' };
  } catch { return { ...base, status: 'error' }; }
}

async function analyze(ingredients) {
  const { usdaKey, anthropicKey } = await chrome.storage.local.get(['usdaKey', 'anthropicKey']);
  const items = ingredients.map(raw => ({ raw, ...parseLine(raw) }));

  const hard = items.filter(i => i.low);
  if (hard.length && anthropicKey) {
    try {
      const out = await llmParse(hard.map(h => h.raw), anthropicKey);
      hard.forEach((h, j) => {
        const o = out[j] || {};
        Object.assign(h, { qty: o.qty, unit: o.unit, food: o.food, low: false, viaLLM: true });
        if (o.optional) h.skip = 'optional';
        else if (o.qty == null) h.skip = 'no quantity';
      });
    } catch { /* leave as 'unparsed' */ }
  }

  const processed = await Promise.all(items.map(it => processItem(it, usdaKey || 'DEMO_KEY')));
  const total = processed.reduce((t, r) => t + (r.fiber || 0), 0);
  return { total, items: processed };
}

async function getUsdaKey() {
  return (await chrome.storage.local.get('usdaKey')).usdaKey || 'DEMO_KEY';
}

async function candidates(foodName) {
  const foods = await searchFoods(foodName, await getUsdaKey(), 10);
  return foods.map(f => ({ fdcId: f.fdcId, description: f.description }));
}

// Save the user's pick for this food name, then recompute just that ingredient.
async function choose({ fdcId, raw, qty, unit, food, viaLLM }) {
  const key = await getUsdaKey();
  const picked = await fetchFood(fdcId, key);
  await chrome.storage.local.set({ ['override:' + food.toLowerCase()]: picked });
  return processItem({ raw, qty, unit, food, viaLLM }, key);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handlers = {
    analyze: () => analyze(msg.ingredients),
    candidates: () => candidates(msg.food),
    choose: () => choose(msg)
  };
  const h = handlers[msg.type];
  if (!h) return;
  h().then(sendResponse).catch(e => sendResponse({ error: String(e) }));
  return true; // keep channel open for async response
});
