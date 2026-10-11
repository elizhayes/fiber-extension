const $ = id => document.getElementById(id);
let result = null;

// Injected into the page. Must be self-contained.
function extract() {
  const num = v => { const m = String([].concat(v)[0] ?? '').match(/\d+/); return m ? +m[0] : null; };
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const data = JSON.parse(s.textContent);
      const nodes = Array.isArray(data) ? data : data['@graph'] || [data];
      const r = nodes.find(n => n && [].concat(n['@type'] || []).includes('Recipe'));
      if (r && Array.isArray(r.recipeIngredient)) {
        return { title: r.name, ingredients: r.recipeIngredient, servings: num(r.recipeYield),
                 fiberListed: r.nutrition?.fiberContent || null };
      }
    } catch {}
  }
  const sel = '.wprm-recipe-ingredient, .tasty-recipes-ingredients li, [class*="ingredient"] li';
  const lines = [...document.querySelectorAll(sel)]
    .map(e => e.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (lines.length) return { title: document.title, ingredients: lines, servings: null, fiberListed: null };

  // Last resort for blogs/newsletters (Substack, Ghost, plain WordPress): find an
  // "Ingredients" heading and collect list items until "Directions"/"Instructions".
  const HEAD = /^ingredients?\s*:?$/i;
  const STOP = /^(instructions?|directions?|method|steps?|preparation|notes?|nutrition)\s*:?$/i;
  const start = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6,strong,b,p')]
    .find(e => e.textContent.trim().length < 20 && HEAD.test(e.textContent.trim()));
  if (!start) return null;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  walker.currentNode = start;
  const items = [], paras = [];
  let node;
  while ((node = walker.nextNode()) && items.length < 80) {
    const t = node.textContent.replace(/\s+/g, ' ').trim();
    if (node.tagName !== 'LI' && t.length < 25 && STOP.test(t)) break;
    if (node.tagName === 'LI' && !node.querySelector('li') && t) items.push(t);
    else if (node.tagName === 'P' && !node.querySelector('p,li'))
      paras.push(...node.innerText.split('\n').map(x => x.trim()).filter(Boolean));
  }
  const found = items.length ? items : paras.slice(0, 60);
  return found.length ? { title: document.title, ingredients: found, servings: null, fiberListed: null } : null;
}

function el(tag, text, cls) {
  const e = document.createElement(tag);
  if (text != null) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

const NOT_COUNTED = ['unparsed', 'unmatched', 'unconverted', 'error'];

function renderTotals() {
  const total = result.items.reduce((t, r) => t + (r.fiber || 0), 0);
  const servings = Math.max(1, +$('servings').value || 1);
  $('total').textContent = total.toFixed(1);
  $('perServing').textContent = (total / servings).toFixed(1);
  const bad = result.items.filter(r => NOT_COUNTED.includes(r.status)).length;
  $('status').hidden = !bad;
  $('status').className = 'warn';
  $('status').textContent = bad ? `${bad} ingredient(s) not counted, so the total is a lower bound.` : '';
}

const LABELS = {
  skipped: r => `skipped (${r.note})`, unparsed: () => 'couldn’t parse',
  unmatched: () => 'no USDA match', unconverted: () => 'unit not convertible',
  error: () => 'lookup failed'
};

async function openPicker(i, wrap) {
  const existing = wrap.querySelector('select');
  if (existing) { existing.remove(); return; }
  const r = result.items[i];
  const list = await chrome.runtime.sendMessage({ type: 'candidates', food: r.food });
  if (!Array.isArray(list)) { $('status').hidden = false; $('status').textContent = list.error || 'Search failed'; return; }

  const sel = el('select');
  sel.append(new Option('Choose a different USDA match…', ''));
  for (const c of list) sel.append(new Option(c.description, c.fdcId));
  sel.addEventListener('change', async () => {
    if (!sel.value) return;
    sel.disabled = true;
    const upd = await chrome.runtime.sendMessage({
      type: 'choose', fdcId: +sel.value,
      raw: r.raw, qty: r.qty, unit: r.unit, food: r.food, viaLLM: r.viaLLM
    });
    if (upd.error) { sel.disabled = false; $('status').hidden = false; $('status').textContent = upd.error; return; }
    result.items[i] = upd;
    renderList();
    renderTotals();
  });
  wrap.append(sel);
}

function renderList() {
  const list = $('list');
  list.replaceChildren();
  result.items.forEach((r, i) => {
    const wrap = el('div', null, 'wrap');
    const row = el('div', null, 'row');
    const name = el('span', r.raw, 'name' + (r.viaLLM ? ' llm' : ''));
    if (r.matched) name.append(el('span', `→ ${r.matched}`, 'sub'));
    const val = r.fiber != null
      ? el('span', `${r.fiber.toFixed(1)} g${r.status === 'approx' ? ' ~' : ''}`, r.status === 'approx' ? 'warn' : '')
      : el('span', LABELS[r.status](r), 'muted');
    row.append(name, val);
    if (r.matched) {
      const btn = el('button', '✎', 'edit');
      btn.title = 'Change USDA match';
      btn.addEventListener('click', () => openPicker(i, wrap));
      row.append(btn);
    }
    wrap.append(row);
    list.append(wrap);
  });
}

function render(res, recipe) {
  result = res;
  $('summary').hidden = false;
  $('title').textContent = recipe.title || 'Recipe';
  $('servings').value = recipe.servings || 1;
  $('listed').textContent = recipe.fiberListed ? `Site lists: ${recipe.fiberListed} per serving` : '';
  renderList();
  renderTotals();
}

// Turn pasted text into ingredient lines (and a servings guess).
function parsePasted(text) {
  const clean = l => l.replace(/^[\s•·▢☐□◦▪*\-–—]+/, '').replace(/\s+/g, ' ').trim();
  const lines = text.split(/\r?\n/).map(clean).filter(Boolean);
  const servings = (text.match(/(?:serves|servings?|yields?|makes)\s*:?\s*(\d+)/i) || [])[1];
  const STOP = /^(instructions?|directions?|method|steps?|preparation|notes?|nutrition)\b:?$/i;
  const META = /^(serves|servings?|yields?|makes|prep|cook|total)\b/i;

  let body;
  const start = lines.findIndex(l => /^ingredients?\b:?$/i.test(l));
  if (start >= 0) {
    body = lines.slice(start + 1);
    const stop = body.findIndex(l => STOP.test(l));
    if (stop >= 0) body = body.slice(0, stop);
    body = body.filter(l => !/:$/.test(l) && !/^for the\b/i.test(l) && !META.test(l));
  } else {
    // No heading: keep only lines that start with a quantity.
    body = lines.filter(l => /^[\d½¼¾⅓⅔⅛]/.test(l) && l.length < 120);
  }
  return { ingredients: body, servings: servings ? +servings : null };
}

async function runAnalysis(recipe) {
  $('summary').hidden = true;
  $('list').replaceChildren();
  $('status').hidden = false;
  $('status').className = 'muted';
  $('status').textContent = `Analyzing ${recipe.ingredients.length} ingredients…`;
  const res = await chrome.runtime.sendMessage({ type: 'analyze', ingredients: recipe.ingredients });
  if (res.error) { $('status').textContent = res.error; return; }
  render(res, recipe);
}

async function init() {
  const keys = await chrome.storage.local.get(['usdaKey', 'anthropicKey', 'pasteDraft']);
  $('usdaKey').value = keys.usdaKey || '';
  $('anthropicKey').value = keys.anthropicKey || '';
  $('pasteBox').value = keys.pasteDraft || '';
  for (const id of ['usdaKey', 'anthropicKey'])
    $(id).addEventListener('change', e => chrome.storage.local.set({ [id]: e.target.value.trim() }));
  $('servings').addEventListener('input', () => result && renderTotals());

  // The popup closes whenever it loses focus, so keep the pasted text as a draft.
  $('pasteBox').addEventListener('input', e => chrome.storage.local.set({ pasteDraft: e.target.value }));
  $('pasteBtn').addEventListener('click', () => {
    const parsed = parsePasted($('pasteBox').value);
    if (!parsed.ingredients.length) {
      $('status').hidden = false;
      $('status').className = 'warn';
      $('status').textContent = 'No ingredient lines found. Try pasting just the ingredient list.';
      return;
    }
    runAnalysis({ title: 'Pasted recipe', ingredients: parsed.ingredients, servings: parsed.servings, fiberListed: null });
  });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let recipe;
  try {
    const [{ result: r }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extract });
    recipe = r;
  } catch { /* restricted page */ }

  if (!recipe) {
    $('status').className = 'muted';
    $('status').textContent = 'No recipe found on this page. Paste the ingredients below.';
    $('pasteSection').open = true;
    return;
  }
  runAnalysis(recipe);
}
init();
