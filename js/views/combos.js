import { state, lookup, ensureCards, freeByKey, collectionTotals } from '../store.js';
import { combos, matchCombos, comboUrl } from '../data.js';
import { COLORS, colorMask, nameKey } from '../cards.js';
import { esc, colorChipsHTML, pagerHTML, debounce, cardImageURL } from '../ui.js';
import { showCard } from './card-modal.js';

const PAGE = 24;
const v = { tab: 'ready', colors: new Set(), bracket: 5, query: '', page: 0, freeOnly: false, simpleOnly: false };
let cache = { key: '', res: null };

export function render(root) {
  if (!collectionTotals().total) {
    root.innerHTML = `<div class="empty"><h1>No cards yet</h1><p class="muted">Import your collection to see which combos you can put together.</p><a class="btn primary" href="#/collection">Import cards</a></div>`;
    return;
  }
  root.innerHTML = `
    <h1>Combos in your collection</h1>
    <p class="muted">Combos from <a href="https://commanderspellbook.com" target="_blank" rel="noopener">Commander Spellbook</a> that your cards can make, and ones you're a single card away from.</p>
    <section class="panel">
      <div class="filters">
        <div class="chips">
          <button class="chip" data-tab="ready" aria-pressed="${v.tab === 'ready'}">Ready to build <span class="count" id="n-ready"></span></button>
          <button class="chip" data-tab="one" aria-pressed="${v.tab === 'one'}">One card away <span class="count" id="n-one"></span></button>
        </div>
        <input type="search" id="q" placeholder="Search cards or results (e.g. infinite mana)…" value="${esc(v.query)}">
      </div>
      <div class="filters">
        <span class="small muted">Colors:</span><div class="chips" id="colors">${colorChipsHTML(v.colors)}</div>
        <select id="bracket" aria-label="Bracket">${[1, 2, 3, 4, 5].map((b) => `<option value="${b}" ${v.bracket === b ? 'selected' : ''}>Up to bracket ${b}</option>`).join('')}</select>
        <label class="row small"><input type="checkbox" id="free" ${v.freeOnly ? 'checked' : ''}> Only cards not in a deck</label>
        <label class="row small"><input type="checkbox" id="simple" ${v.simpleOnly ? 'checked' : ''}> Hide combos with extra conditions</label>
      </div>
      <div id="results"><p class="muted"><span class="spinner"></span> Checking ${'~'}100,000 combos…</p></div>
    </section>`;
  const update = () => { v.page = 0; draw(root); };
  root.querySelector('.chips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]'); if (!b) return;
    v.tab = b.dataset.tab;
    root.querySelectorAll('[data-tab]').forEach((x) => x.setAttribute('aria-pressed', x.dataset.tab === v.tab));
    update();
  });
  root.querySelector('#q').addEventListener('input', debounce((e) => { v.query = e.target.value; update(); }));
  root.querySelector('#colors').addEventListener('click', (e) => {
    const b = e.target.closest('[data-color]'); if (!b) return;
    const c = b.dataset.color;
    if (v.colors.has(c)) v.colors.delete(c); else v.colors.add(c);
    b.setAttribute('aria-pressed', v.colors.has(c));
    update();
  });
  root.querySelector('#bracket').addEventListener('change', (e) => { v.bracket = Number(e.target.value); update(); });
  root.querySelector('#free').addEventListener('change', (e) => { v.freeOnly = e.target.checked; update(); });
  root.querySelector('#simple').addEventListener('change', (e) => { v.simpleOnly = e.target.checked; update(); });
  draw(root);
}

async function compute() {
  const key = `${state.version}|${v.freeOnly}`;
  if (cache.key === key) return cache.res;
  const index = await combos();
  const have = new Set();
  if (v.freeOnly) { for (const [k, n] of freeByKey()) if (n > 0) have.add(k); }
  else for (const n of state.byName.keys()) have.add(nameKey(n));
  const res = { index, ...matchCombos(index, have, { commanderKey: undefined }) };
  cache = { key, res };
  return res;
}

async function draw(root) {
  const el = root.querySelector('#results');
  let res;
  try { res = await compute(); } catch (e) {
    el.innerHTML = `<div class="notice warn">Combo data couldn't be loaded (${esc(e.message)}).</div>`;
    return;
  }
  if (!root.querySelector('#results')) return;
  const mask = v.colors.size ? colorMask([...v.colors].filter((c) => c !== 'C')) : 31;
  const q = v.query.trim().toLowerCase();
  const keep = (c) => (c.mask & ~mask) === 0 && c.minBracket <= v.bracket && (!v.simpleOnly || !c.requires.length)
    && (!q || c.cards.some((n) => n.toLowerCase().includes(q)) || c.produces.some((p) => p.toLowerCase().includes(q)));
  const ready = res.complete.filter(keep);
  const one = res.oneAway.filter((x) => keep(x.combo));
  root.querySelector('#n-ready').textContent = ready.length.toLocaleString();
  root.querySelector('#n-one').textContent = one.length.toLocaleString();
  const list = v.tab === 'ready' ? ready : one;
  const pages = Math.ceil(list.length / PAGE);
  v.page = Math.min(v.page, Math.max(0, pages - 1));
  const slice = list.slice(v.page * PAGE, (v.page + 1) * PAGE);
  // One batched Scryfall request for every card shown (images + prices), instead of one per image.
  await ensureCards(slice.flatMap((x) => (x.combo || x).cards)).catch(() => {});
  if (!root.querySelector('#results')) return;
  el.innerHTML = (slice.length ? `<div class="combo-grid">${slice.map((x) => (v.tab === 'ready' ? comboCard(x) : comboCard(x.combo, x))).join('')}</div>`
    : `<p class="muted">${v.tab === 'ready' ? 'No complete combos match these filters.' : 'No near-misses match these filters.'}</p>`)
    + pagerHTML(v.page, pages)
    + `<p class="small muted" style="margin-top:10px">Combo data: Commander Spellbook${res.index.updated ? `, updated ${new Date(res.index.updated).toLocaleDateString()}` : ''}. Prices from Scryfall.</p>`;
  el.onclick = (e) => {
    const pg = e.target.closest('[data-page]');
    if (pg) { v.page = Number(pg.dataset.page); draw(root); el.scrollIntoView({ block: 'start', behavior: 'smooth' }); return; }
    const c = e.target.closest('[data-card]');
    if (c) showCard(c.dataset.card);
  };
}

function comboCard(c, near = null) {
  const missingCard = near ? lookup(near.missingName) : null;
  const colors = c.identity ? c.identity.split('') : [];
  return `<div class="combo">
    <div class="combo-cards">${c.cards.map((n) => {
      const card = lookup(n);
      const isMissing = near && nameKey(n) === near.missing;
      return `<img src="${esc(card?.img_small || cardImageURL(n))}" alt="${esc(n)}" title="${esc(n)}" data-card="${esc(n)}" loading="lazy" class="${isMissing ? 'missing' : ''}">`;
    }).join('')}</div>
    <div class="small"><b>${esc(c.produces.slice(0, 3).join(' · '))}</b></div>
    <div class="small muted">${c.cards.map((n) => `<a href="javascript:void 0" data-card="${esc(n)}">${esc(n)}</a>`).join(' + ')}</div>
    ${c.requires.length ? `<div class="small muted">Also needs: ${esc(c.requires.join('; '))}</div>` : ''}
    ${near ? `<div class="small">Missing: <b>${esc(near.missingName)}</b>${missingCard?.price ? ` · about $${esc(missingCard.price)}` : ''} · <a href="https://www.tcgplayer.com/search/magic/product?q=${encodeURIComponent(near.missingName)}" target="_blank" rel="noopener">Shop ↗</a></div>` : ''}
    <div class="small">${COLORS.filter((x) => colors.includes(x)).map((x) => `<span class="pip ${x}">${x}</span>`).join('') || '<span class="pip C">C</span>'}
      min. bracket ${c.minBracket} · <a href="${comboUrl(c)}" target="_blank" rel="noopener">Steps ↗</a></div>
  </div>`;
}
