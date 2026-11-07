import { state, pool, saveDeck, newDeckId, collectionTotals } from '../store.js';
import { FORMATS, suggestColors, suggestThemes, suggestCommanders, buildDeck } from '../builder.js';
import { COLORS } from '../cards.js';
import { esc, pipsHTML, colorName, toast, manaHTML } from '../ui.js';
import { themeFromKey, plural } from '../cards.js';

const v = { format: null, colors: [], commander: null, theme: null, customTheme: '', name: '', cmdQuery: '' };
const cache = new Map(); // memoised suggestions keyed by state version

function memo(key, fn) {
  const k = `${state.version}|${key}`;
  if (!cache.has(k)) {
    if (cache.size > 40) cache.clear();
    cache.set(k, fn());
  }
  return cache.get(k);
}

export function render(root) {
  if (!collectionTotals().total) {
    root.innerHTML = `<div class="empty"><h1>No cards yet</h1><p class="muted">Import your collection first, then come back to build decks.</p><a class="btn primary" href="#/collection">Import cards</a></div>`;
    return;
  }
  root.innerHTML = `
    <h1>Build a deck</h1>
    <p class="muted">Pick a format and colors (or a commander). The builder drafts a deck from cards that aren't already in your other decks, and you can edit it afterwards.</p>
    <div class="steps">
      <section class="panel" id="step-format"></section>
      <section class="panel ${v.format ? '' : 'hidden'}" id="step-colors"></section>
      <section class="panel ${canPickTheme() ? '' : 'hidden'}" id="step-theme"></section>
      <section class="panel ${canPickTheme() ? '' : 'hidden'}" id="step-go"></section>
    </div>`;
  renderFormat(root);
  if (v.format) renderColors(root);
  if (canPickTheme()) { renderTheme(root); renderGo(root); }
}

function canPickTheme() {
  if (!v.format) return false;
  return FORMATS[v.format].hasCommander ? !!v.commander : v.colors.length > 0;
}

function stepTitle(n, title, sub = '') {
  return `<div class="step-title"><span class="step-num">${n}</span><h2>${title}</h2>${sub ? `<span class="muted small">${sub}</span>` : ''}</div>`;
}

function renderFormat(root) {
  const el = root.querySelector('#step-format');
  el.innerHTML = `${stepTitle(1, 'Format')}
    <div class="picks">${Object.values(FORMATS).map((f) => `
      <button type="button" class="pick" data-format="${f.key}" aria-pressed="${v.format === f.key}">
        <span class="t">${esc(f.label)}</span><span class="d">${esc(f.blurb)}</span>
      </button>`).join('')}
    </div>`;
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-format]'); if (!b) return;
    if (v.format !== b.dataset.format) { v.format = b.dataset.format; v.theme = null; v.name = ''; if (!FORMATS[v.format].hasCommander) v.commander = null; }
    render(root);
    root.querySelector('#step-colors').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

function renderColors(root) {
  const el = root.querySelector('#step-colors');
  const fmt = FORMATS[v.format];
  if (fmt.hasCommander) return renderCommanders(root, el);
  el.innerHTML = `${stepTitle(2, 'Colors', 'Choose one or two (three if you like living dangerously)')}
    <div class="row" style="margin-bottom:14px">
      <div class="color-toggle" id="ctoggle">${COLORS.map((c) => `<button type="button" class="pip ${c}" data-c="${c}" aria-pressed="${v.colors.includes(c)}" aria-label="${c}">${c}</button>`).join('')}</div>
      ${v.colors.length ? `<span><b>${esc(colorName(v.colors))}</b></span>` : ''}
    </div>
    <h3>Suggested from your pile <span class="spinner" id="cspin"></span></h3>
    <div class="picks" id="csugg"></div>`;
  el.querySelector('#ctoggle').addEventListener('click', (e) => {
    const b = e.target.closest('[data-c]'); if (!b) return;
    const c = b.dataset.c;
    v.colors = v.colors.includes(c) ? v.colors.filter((x) => x !== c) : COLORS.filter((x) => x === c || v.colors.includes(x));
    v.theme = null; v.name = '';
    render(root);
  });
  setTimeout(() => {
    const list = memo(`colors:${v.format}`, () => suggestColors(pool(), v.format));
    const max = Math.max(1, ...list.map((x) => x.strength));
    const box = el.querySelector('#csugg');
    if (!box) return;
    el.querySelector('#cspin')?.remove();
    box.innerHTML = list.slice(0, 8).map((s) => `
      <button type="button" class="pick" data-colors="${s.colors.join('')}" aria-pressed="${s.colors.join('') === v.colors.join('')}">
        <span class="t">${pipsHTML(s.colors)} ${esc(colorName(s.colors))}</span>
        <span class="d">${s.distinct} different playable cards · ${esc(s.preview.slice(0, 3).join(', '))}</span>
        <div class="strength" title="Relative deck strength ${s.strength}"><div style="width:${(100 * s.strength) / max}%"></div></div>
      </button>`).join('');
    box.addEventListener('click', (e) => {
      const b = e.target.closest('[data-colors]'); if (!b) return;
      v.colors = b.dataset.colors.split('');
      v.theme = null; v.name = '';
      render(root);
      root.querySelector('#step-theme').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }, 20);
}

function renderCommanders(root, el) {
  el.innerHTML = `${stepTitle(2, 'Commander', 'Legendary creatures from your pile, ranked by how deep a deck they can lead')}
    <div class="row" style="margin-bottom:12px"><input type="search" id="cmd-q" placeholder="Filter commanders…" value="${esc(v.cmdQuery)}" style="flex:1 1 240px"></div>
    <div class="picks" id="cmds"><span><span class="spinner"></span> Analysing your legends…</span></div>`;
  const draw = () => {
    const all = memo('commanders', () => suggestCommanders(pool(), { limit: 400 }));
    const box = el.querySelector('#cmds');
    if (!box) return;
    if (!all.length) { box.innerHTML = '<p class="muted">No legendary creatures that are free to use. Import more cards, or free some up from other decks.</p>'; return; }
    const q = v.cmdQuery.toLowerCase();
    const list = all.filter((c) => !q || c.name.toLowerCase().includes(q) || (c.entry.card.oracle_text || '').toLowerCase().includes(q)).slice(0, q ? 60 : 24);
    const max = Math.max(1, ...all.map((x) => x.score));
    box.innerHTML = list.map((c) => `
      <button type="button" class="pick cmd-pick" data-cmd="${esc(c.name)}" aria-pressed="${v.commander === c.name}">
        ${c.entry.card.img_small ? `<img src="${esc(c.entry.card.img_small)}" alt="" loading="lazy">` : ''}
        <span style="flex:1;min-width:0">
          <span class="t">${esc(c.name)}</span>
          <span class="d">${pipsHTML(c.colors)} ${c.playable} playable cards in identity</span>
          ${c.themes.length ? `<span class="d">Likes: ${esc(c.themes.slice(0, 3).join(', '))}${c.synergy ? ` (${c.synergy} matching cards)` : ''}</span>` : ''}
          <div class="strength"><div style="width:${(100 * c.score) / max}%"></div></div>
        </span>
      </button>`).join('') || '<p class="muted">No commanders match.</p>';
  };
  setTimeout(draw, 20);
  el.querySelector('#cmd-q').addEventListener('input', (e) => { v.cmdQuery = e.target.value; draw(); });
  el.querySelector('#cmds').addEventListener('click', (e) => {
    const b = e.target.closest('[data-cmd]'); if (!b) return;
    v.commander = b.dataset.cmd; v.theme = null; v.name = '';
    render(root);
    root.querySelector('#step-theme').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

function commanderCard() {
  return v.commander ? state.byName.get(v.commander)?.card : null;
}

function renderTheme(root) {
  const el = root.querySelector('#step-theme');
  el.innerHTML = `${stepTitle(3, 'Theme', 'Optional — cards that match get priority')}
    <div class="chips" id="themes"><span><span class="spinner"></span></span></div>
    <div class="row" style="margin-top:10px">
      <input type="text" id="custom-theme" placeholder="Or type your own: e.g. Dragon, sacrifice, “draw a card”" value="${esc(v.customTheme)}" style="flex:1 1 260px">
      <button class="btn small" id="use-custom">Use</button>
    </div>`;
  setTimeout(() => {
    const cmd = commanderCard();
    const list = memo(`themes:${v.format}:${v.colors.join('')}:${v.commander}`, () => suggestThemes(pool(), v.format, v.colors, cmd));
    const box = el.querySelector('#themes');
    if (!box) return;
    const custom = v.theme && v.theme.startsWith('text:') ? [{ key: v.theme, label: themeFromKey(v.theme).label, count: null }] : [];
    box.innerHTML = [
      `<button class="chip" data-theme="" aria-pressed="${!v.theme}">${FORMATS[v.format].hasCommander ? 'Follow the commander' : 'No theme — just good cards'}</button>`,
      ...[...custom, ...list].map((t) => `<button class="chip" data-theme="${esc(t.key)}" aria-pressed="${v.theme === t.key}">${esc(t.label)}${t.count != null ? ` <span class="count">${t.count}</span>` : ''}</button>`),
    ].join('');
  }, 20);
  el.querySelector('#themes').addEventListener('click', (e) => {
    const b = e.target.closest('[data-theme]'); if (!b) return;
    v.theme = b.dataset.theme || null; v.name = '';
    renderTheme(root); renderGo(root);
  });
  const useCustom = () => {
    const t = el.querySelector('#custom-theme').value.trim();
    v.customTheme = t;
    v.theme = t ? `text:${t.toLowerCase()}` : null; v.name = '';
    renderTheme(root); renderGo(root);
  };
  el.querySelector('#use-custom').addEventListener('click', useCustom);
  el.querySelector('#custom-theme').addEventListener('keydown', (e) => { if (e.key === 'Enter') useCustom(); });
}

function defaultName() {
  const fmt = FORMATS[v.format];
  if (fmt.hasCommander) return `${v.commander} Commander`;
  const t = themeFromKey(v.theme);
  const themeLabel = t ? (t.tribe ? plural(t.tribe) : t.label.replace(/[“”]/g, '')) : '';
  return `${colorName(v.colors)} ${themeLabel || (v.format === 'limited' ? 'Limited' : v.format === 'pauper' ? 'Pauper' : 'Deck')}`.trim();
}

function renderGo(root) {
  const el = root.querySelector('#step-go');
  const fmt = FORMATS[v.format];
  const cmd = commanderCard();
  el.innerHTML = `${stepTitle(4, 'Build it')}
    <div class="row">
      <input type="text" id="deck-name" value="${esc(v.name || defaultName())}" aria-label="Deck name" style="flex:1 1 260px">
      <button class="btn primary" id="go">Build ${esc(fmt.label)} deck</button>
    </div>
    <p class="small muted" style="margin-top:8px">
      ${fmt.hasCommander && cmd ? `${manaHTML(cmd.mana_cost)} ${esc(cmd.name)} · ` : `${pipsHTML(v.colors)} `}
      ${fmt.size} cards, ${fmt.lands} lands. Basic lands are assumed unlimited; everything else comes from your free copies.
    </p>`;
  el.querySelector('#deck-name').addEventListener('input', (e) => { v.name = e.target.value; });
  el.querySelector('#go').addEventListener('click', async (e) => {
    e.target.disabled = true;
    e.target.innerHTML = '<span class="spinner"></span> Building…';
    await new Promise((r) => setTimeout(r, 20));
    const res = buildDeck({ pool: pool(), format: v.format, colors: v.colors, commander: cmd, theme: v.theme });
    const deck = {
      id: newDeckId(),
      name: (el.querySelector('#deck-name').value || defaultName()).trim(),
      format: v.format,
      colors: fmt.hasCommander && cmd ? cmd.color_identity : [...v.colors],
      commander: res.commander,
      theme: v.theme,
      cards: res.cards,
      notes: res.notes,
      created: Date.now(),
    };
    await saveDeck(deck);
    toast('Deck built — tweak it however you like');
    v.commander = null; v.theme = null; v.name = ''; v.customTheme = '';
    location.hash = `#/deck/${deck.id}`;
  });
}
