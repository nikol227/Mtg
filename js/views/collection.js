import { state, importCSV, collectionTotals, usage, clearCollection } from '../store.js';
import { esc, manaHTML, tileHTML, toast, matchesFilters, colorChipsHTML, pagerHTML, debounce, TYPE_FILTERS } from '../ui.js';
import { info } from '../builder.js';
import { showCard } from './card-modal.js';

const PAGE = 60;
const v = {
  query: '', colors: new Set(), type: '', rarity: '', cmc: '', sort: 'quality', onlyFree: false, page: 0, mode: 'grid',
  importing: null, // { done, total, phase }
  result: null,
  importMode: 'add',
  abort: null,
};

export function render(root) {
  const totals = collectionTotals();
  root.innerHTML = `
    ${totals.total ? '' : `<div class="empty">
      <h1>Turn your bulk into decks</h1>
      <p class="muted">Scan your cards with ManaBox, export a CSV, and drop it below. The builder suggests colors, themes and commanders your pile can support.</p>
    </div>`}
    <section class="panel" id="import-panel">${importPanel(totals)}</section>
    ${totals.total ? `<section class="panel" id="browser"></section>` : ''}
  `;
  bindImport(root);
  if (totals.total) renderBrowser(root.querySelector('#browser'));
}

function importPanel(totals) {
  const used = [...usage().values()].reduce((a, b) => a + b, 0);
  return `
    <div class="row spread">
      <h2 style="margin:0">${totals.total ? 'Your collection' : 'Import your cards'}</h2>
      ${totals.total ? `<div class="stats">
        <div class="stat"><b>${totals.total.toLocaleString()}</b><span>cards</span></div>
        <div class="stat"><b>${totals.unique.toLocaleString()}</b><span>unique names</span></div>
        <div class="stat"><b>${used.toLocaleString()}</b><span>in ${state.decks.size} deck${state.decks.size === 1 ? '' : 's'}</span></div>
      </div>` : ''}
    </div>
    <div class="stack" style="margin-top:12px">
      <label class="dropzone" id="dropzone">
        <input type="file" id="csv-file" accept=".csv,text/csv,text/plain" class="hidden">
        <strong>${v.importing ? 'Importing…' : 'Drop a ManaBox CSV here, or click to choose a file'}</strong>
        <span class="muted small">Other scanner exports (Delver Lens, TCGplayer, Moxfield, Deckbox…) usually work too.</span>
      </label>
      <div class="row">
        <label class="row small"><input type="radio" name="imode" value="add" ${v.importMode === 'add' ? 'checked' : ''}> Add to my collection</label>
        <label class="row small"><input type="radio" name="imode" value="replace" ${v.importMode === 'replace' ? 'checked' : ''}> Replace my collection (decks are kept)</label>
      </div>
      ${v.importing ? `<div>
        <div class="row spread small"><span><span class="spinner"></span> ${v.importing.phase === 'save' ? 'Saving…' : `Looking up cards on Scryfall: ${v.importing.done.toLocaleString()} / ${v.importing.total.toLocaleString()} printings`}</span>
        <button class="btn small" id="cancel-import">Cancel</button></div>
        <div class="progress" style="margin-top:6px"><div style="width:${v.importing.total ? (100 * v.importing.done) / v.importing.total : 5}%"></div></div>
      </div>` : ''}
      ${v.result ? resultHTML(v.result) : ''}
      <details>
        <summary class="small">How do I export from ManaBox?</summary>
        <ol class="howto small">
          <li>In ManaBox, open <b>Collection</b> (or a binder/list).</li>
          <li>Tap the <b>⋮</b> menu → <b>Export</b> → <b>CSV</b>, and save or share the file to this device.</li>
          <li>Drop the file above. Cards are matched by their Scryfall ID, so the exact printings (and images) come through.</li>
        </ol>
        <p class="small muted">Large piles are fine: lookups go 75 cards at a time and are cached, so re-importing the same cards is instant.</p>
      </details>
      ${totals.total ? '<div><button class="btn small danger" id="clear-coll">Clear collection…</button></div>' : ''}
    </div>`;
}

function resultHTML(r) {
  if (r.error) return `<div class="notice warn"><b>Import failed:</b> ${esc(r.error)}</div>`;
  return `<div class="notice ${r.notFound.length || r.errors.length ? 'warn' : ''}">
    <b>Imported ${r.imported.toLocaleString()} cards</b> (${r.unique.toLocaleString()} printings) from a ${esc(r.format)} file.
    ${r.notFound.length ? `<details><summary>${r.notFound.length} row${r.notFound.length > 1 ? 's' : ''} not found on Scryfall</summary><ul>${r.notFound.slice(0, 200).map((x) => `<li>Line ${x.line}: ${esc(x.label)} ×${x.qty}</li>`).join('')}</ul></details>` : ''}
    ${r.errors.length ? `<details><summary>${r.errors.length} row${r.errors.length > 1 ? 's' : ''} skipped</summary><ul>${r.errors.slice(0, 200).map((x) => `<li>Line ${x.line}: ${esc(x.message)}</li>`).join('')}</ul></details>` : ''}
    ${r.imported ? '<div style="margin-top:6px"><a class="btn small primary" href="#/build">Build a deck →</a></div>' : ''}
  </div>`;
}

function bindImport(root) {
  const dz = root.querySelector('#dropzone');
  const input = root.querySelector('#csv-file');
  input.addEventListener('change', () => input.files[0] && runImport(input.files[0], root));
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('drag'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
  dz.addEventListener('drop', (e) => {
    e.preventDefault(); dz.classList.remove('drag');
    const f = e.dataTransfer.files[0];
    if (f) runImport(f, root);
  });
  root.querySelectorAll('input[name="imode"]').forEach((r) => r.addEventListener('change', () => { v.importMode = r.value; }));
  root.querySelector('#cancel-import')?.addEventListener('click', () => v.abort?.abort());
  root.querySelector('#clear-coll')?.addEventListener('click', async () => {
    if (!confirm('Remove every card from your collection? Your decks are kept, but they will show as missing cards.')) return;
    await clearCollection();
    v.result = null;
    toast('Collection cleared');
  });
}

async function runImport(file, root) {
  if (v.importing) return;
  if (v.importMode === 'replace' && collectionTotals().total && !confirm('Replace your whole collection with this file?')) return;
  const text = await file.text();
  v.abort = new AbortController();
  v.importing = { phase: 'fetch', done: 0, total: 0 };
  v.result = null;
  const panel = () => document.querySelector('#import-panel');
  const refresh = () => { const p = panel(); if (p) { p.innerHTML = importPanel(collectionTotals()); bindImport(document.querySelector('#view')); } };
  refresh();
  try {
    v.result = await importCSV(text, {
      mode: v.importMode,
      signal: v.abort.signal,
      onProgress: (p) => { v.importing = p; refresh(); },
    });
  } catch (e) {
    v.result = { error: e.name === 'AbortError' ? 'Cancelled. Nothing was changed.' : (e.message || String(e)) };
  }
  v.importing = null;
  v.abort = null;
  render(document.querySelector('#view') || root);
}

// ---------- browser ----------

function sorted(entries) {
  const used = usage();
  const free = (e) => e.owned - (used.get(e.name) || 0);
  const cmp = {
    quality: (a, b) => info(b.card).quality - info(a.card).quality,
    name: (a, b) => a.name.localeCompare(b.name),
    cmc: (a, b) => a.card.cmc - b.card.cmc || a.name.localeCompare(b.name),
    owned: (a, b) => b.owned - a.owned || a.name.localeCompare(b.name),
    price: (a, b) => (Number(b.card.price) || 0) - (Number(a.card.price) || 0),
  }[v.sort];
  let list = [...state.byName.values()].filter((e) => matchesFilters(e.card, v));
  if (v.onlyFree) list = list.filter((e) => info(e.card).basic || free(e) > 0);
  return { list: list.sort(cmp), free };
}

function renderBrowser(el) {
  el.innerHTML = `
    <div class="filters">
      <input type="search" id="f-q" placeholder="Search name, type or rules text…" value="${esc(v.query)}" aria-label="Search">
      <div class="chips" id="f-colors">${colorChipsHTML(v.colors)}</div>
      <select id="f-type" aria-label="Type"><option value="">Any type</option>${TYPE_FILTERS.map((t) => `<option ${v.type === t ? 'selected' : ''}>${t}</option>`).join('')}</select>
      <select id="f-cmc" aria-label="Mana value"><option value="">Any MV</option>${[0, 1, 2, 3, 4, 5, 6, 7].map((n) => `<option value="${n}" ${String(v.cmc) === String(n) ? 'selected' : ''}>MV ${n}${n === 7 ? '+' : ''}</option>`).join('')}</select>
      <select id="f-rarity" aria-label="Rarity"><option value="">Any rarity</option>${['common', 'uncommon', 'rare', 'mythic'].map((r) => `<option ${v.rarity === r ? 'selected' : ''}>${r}</option>`).join('')}</select>
      <select id="f-sort" aria-label="Sort"><option value="quality">Sort: playability</option><option value="name">Sort: name</option><option value="cmc">Sort: mana value</option><option value="owned">Sort: copies</option><option value="price">Sort: price</option></select>
      <label class="row small"><input type="checkbox" id="f-free" ${v.onlyFree ? 'checked' : ''}> Not in a deck</label>
      <div class="chips"><button class="chip" id="f-mode" type="button">${v.mode === 'grid' ? 'List view' : 'Image view'}</button></div>
    </div>
    <div id="results"></div>`;
  el.querySelector('#f-sort').value = v.sort;
  const update = () => { v.page = 0; renderResults(el.querySelector('#results')); };
  el.querySelector('#f-q').addEventListener('input', debounce((e) => { v.query = e.target.value; update(); }));
  el.querySelector('#f-colors').addEventListener('click', (e) => {
    const b = e.target.closest('[data-color]'); if (!b) return;
    const c = b.dataset.color;
    if (v.colors.has(c)) v.colors.delete(c); else v.colors.add(c);
    b.setAttribute('aria-pressed', v.colors.has(c));
    update();
  });
  for (const [id, key] of [['#f-type', 'type'], ['#f-cmc', 'cmc'], ['#f-rarity', 'rarity'], ['#f-sort', 'sort']]) {
    el.querySelector(id).addEventListener('change', (e) => { v[key] = e.target.value; update(); });
  }
  el.querySelector('#f-free').addEventListener('change', (e) => { v.onlyFree = e.target.checked; update(); });
  el.querySelector('#f-mode').addEventListener('click', (e) => { v.mode = v.mode === 'grid' ? 'list' : 'grid'; e.target.textContent = v.mode === 'grid' ? 'List view' : 'Image view'; renderResults(el.querySelector('#results')); });
  renderResults(el.querySelector('#results'));
}

function renderResults(el) {
  const { list, free } = sorted();
  const pages = Math.ceil(list.length / PAGE);
  v.page = Math.min(v.page, Math.max(0, pages - 1));
  const slice = list.slice(v.page * PAGE, (v.page + 1) * PAGE);
  const body = !list.length ? '<p class="muted">No cards match these filters.</p>'
    : v.mode === 'grid'
      ? `<div class="grid">${slice.map((e) => tileHTML(e.card, { badge: info(e.card).basic ? `×${e.owned}` : `×${e.owned}${free(e) < e.owned ? ` · ${Math.max(0, free(e))} free` : ''}` })).join('')}</div>`
      : `<table class="list"><thead><tr><th></th><th>Name</th><th>Cost</th><th>Type</th><th class="num">Owned</th><th class="num">Free</th></tr></thead><tbody>
        ${slice.map((e) => `<tr class="clickable" data-card="${esc(e.name)}"><td>${e.card.img_small ? `<img class="thumb" src="${esc(e.card.img_small)}" alt="" loading="lazy">` : ''}</td><td>${esc(e.name)}</td><td>${manaHTML(e.card.mana_cost)}</td><td class="small">${esc(e.card.type_line)}</td><td class="num">${e.owned}</td><td class="num">${info(e.card).basic ? '∞' : Math.max(0, free(e))}</td></tr>`).join('')}
        </tbody></table>`;
  el.innerHTML = `<p class="small muted">${list.length.toLocaleString()} card${list.length === 1 ? '' : 's'}</p>${body}${pagerHTML(v.page, pages)}`;
  el.onclick = (e) => {
    const pg = e.target.closest('[data-page]');
    if (pg) { v.page = Number(pg.dataset.page); renderResults(el); el.scrollIntoView({ block: 'start', behavior: 'smooth' }); return; }
    const c = e.target.closest('[data-card]');
    if (c) showCard(c.dataset.card);
  };
}
