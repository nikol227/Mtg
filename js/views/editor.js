import { state, lookup, pool, saveDeck, deleteDeck, newDeckId, availabilityFn } from '../store.js';
import { FORMATS, buildDeck, validateDeck, deckStats, deckSize, exportText, rankForDeck, info } from '../builder.js';
import { COLORS, BASIC_FOR_COLOR, primaryType, themeFromKey } from '../cards.js';
import { esc, manaHTML, pipsHTML, tileHTML, toast, openModal, closeModal, download, matchesFilters, TYPE_FILTERS, debounce } from '../ui.js';
import { showCard } from './card-modal.js';

const SECTIONS = ['Creature', 'Planeswalker', 'Instant', 'Sorcery', 'Artifact', 'Enchantment', 'Battle', 'Other', 'Land'];
const SECTION_LABEL = { Creature: 'Creatures', Planeswalker: 'Planeswalkers', Instant: 'Instants', Sorcery: 'Sorceries', Artifact: 'Artifacts', Enchantment: 'Enchantments', Battle: 'Battles', Other: 'Other', Land: 'Lands' };

const v = { side: 'stats', query: '', type: '', themeOnly: false, shown: 40, mode: 'grid', deckId: null };

export function render(root, id) {
  const deck = state.decks.get(id);
  if (!deck) {
    root.innerHTML = '<div class="empty"><h1>Deck not found</h1><a class="btn" href="#/decks">Back to my decks</a></div>';
    return;
  }
  if (v.deckId !== id) Object.assign(v, { query: '', type: '', themeOnly: false, shown: 40, deckId: id });
  const fmt = FORMATS[deck.format];
  const theme = themeFromKey(deck.theme);
  root.innerHTML = `
    <div class="row spread">
      <input class="deck-name" id="deck-name" value="${esc(deck.name)}" aria-label="Deck name">
      <div class="row">
        <button class="btn small" id="fill" title="Add the best free cards until the deck reaches ${fmt.size}">Auto-fill</button>
        <button class="btn small" id="rebuild" title="Throw this list away and build again">Rebuild</button>
        <button class="btn small primary" id="export">Export</button>
        <button class="btn small" id="dup">Duplicate</button>
        <button class="btn small danger" id="del">Delete</button>
      </div>
    </div>
    <div class="row small" style="margin:4px 0 12px">
      <span><b id="size-label"></b></span>
      <span class="muted">· ${esc(fmt.label)}</span>
      ${theme ? `<span class="muted">· Theme: ${esc(theme.label)}</span>` : ''}
      ${fmt.hasCommander ? '' : `<span class="muted">· Colors:</span><span class="chips" id="deck-colors">${COLORS.map((c) => `<button type="button" class="chip" data-dc="${c}" aria-pressed="${deck.colors.includes(c)}"><span class="pip ${c}">${c}</span></button>`).join('')}</span>`}
      <span class="chips"><button class="chip" id="view-mode" type="button">${v.mode === 'grid' ? 'List view' : 'Image view'}</button></span>
    </div>
    <div id="issues"></div>
    <div class="editor">
      <div id="deck-main"></div>
      <aside class="panel editor-side" id="side"></aside>
    </div>`;
  const ctx = makeCtx(root, deck);
  bindHeader(root, deck, ctx);
  ctx.refresh();
}

function makeCtx(root, deck) {
  const ctx = {
    avail: availabilityFn(deck.id),
    refresh() {
      ctx.avail = availabilityFn(deck.id);
      renderMain(root, deck, ctx);
      renderIssues(root, deck, ctx);
      renderSide(root, deck, ctx);
      root.querySelector('#size-label').textContent = `${deckSize(deck)} / ${FORMATS[deck.format].size} cards`;
    },
    async change(name, delta) {
      const card = lookup(name);
      const cur = deck.cards[name] || 0;
      if (delta > 0 && card && !info(card).basic) {
        const free = ctx.avail(name);
        if (cur + delta > free) { toast(free <= 0 ? `No free copies of ${name} — they're all in other decks.` : `You only have ${free} free cop${free === 1 ? 'y' : 'ies'} of ${name}.`); return; }
      }
      const next = Math.max(0, cur + delta);
      if (next) deck.cards[name] = next; else delete deck.cards[name];
      await saveDeck(deck);
      ctx.refresh();
    },
  };
  return ctx;
}

function bindHeader(root, deck, ctx) {
  const fmt = FORMATS[deck.format];
  root.querySelector('#deck-name').addEventListener('change', async (e) => { deck.name = e.target.value.trim() || deck.name; await saveDeck(deck); toast('Renamed'); });
  root.querySelector('#view-mode').addEventListener('click', (e) => { v.mode = v.mode === 'grid' ? 'list' : 'grid'; e.target.textContent = v.mode === 'grid' ? 'List view' : 'Image view'; renderMain(root, deck, ctx); });
  root.querySelector('#deck-colors')?.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-dc]'); if (!b) return;
    const c = b.dataset.dc;
    deck.colors = deck.colors.includes(c) ? deck.colors.filter((x) => x !== c) : COLORS.filter((x) => x === c || deck.colors.includes(x));
    b.setAttribute('aria-pressed', deck.colors.includes(c));
    await saveDeck(deck);
    ctx.refresh();
  });
  const rebuildWith = async (locked) => {
    const cmd = deck.commander ? lookup(deck.commander) : null;
    if (!fmt.hasCommander && !deck.colors.length) { toast('Pick at least one color first.'); return; }
    const res = buildDeck({ pool: pool(deck.id), format: deck.format, colors: deck.colors, commander: cmd, theme: deck.theme, locked });
    deck.cards = res.cards;
    deck.notes = res.notes;
    await saveDeck(deck);
    ctx.refresh();
  };
  root.querySelector('#fill').addEventListener('click', async () => {
    if (deckSize(deck) >= fmt.size) { toast('Deck is already full.'); return; }
    const before = deckSize(deck);
    await rebuildWith({ ...deck.cards });
    toast(`Added ${deckSize(deck) - before} cards`);
  });
  root.querySelector('#rebuild').addEventListener('click', async () => {
    if (!confirm('Rebuild this deck from scratch? Your edits to the list will be lost.')) return;
    await rebuildWith({});
    toast('Deck rebuilt');
  });
  root.querySelector('#export').addEventListener('click', () => showExport(deck));
  root.querySelector('#dup').addEventListener('click', async () => {
    const copy = { ...structuredClone(deck), id: newDeckId(), name: `${deck.name} (copy)`, created: Date.now() };
    await saveDeck(copy);
    toast('Duplicated. The copy needs its own physical cards, so some may show as short.');
    location.hash = `#/deck/${copy.id}`;
  });
  root.querySelector('#del').addEventListener('click', async () => {
    if (!confirm(`Delete “${deck.name}”? Its cards go back into your free pool.`)) return;
    await deleteDeck(deck.id);
    toast('Deck deleted');
    location.hash = '#/decks';
  });
}

function renderIssues(root, deck, ctx) {
  const issues = validateDeck(deck, lookup, ctx.avail);
  const notes = deck.notes || [];
  const el = root.querySelector('#issues');
  if (!issues.length && !notes.length) { el.innerHTML = ''; return; }
  const errs = issues.filter((i) => i.level === 'error');
  el.innerHTML = `<div class="notice ${issues.length ? 'warn' : ''}" style="margin-bottom:14px">
    ${issues.length ? `<details ${errs.length || issues.length <= 4 ? 'open' : ''}><summary><b>${issues.length} thing${issues.length > 1 ? 's' : ''} to check</b></summary>
      <ul>${issues.map((i) => `<li class="issue-${i.level}">${esc(i.msg)}</li>`).join('')}</ul></details>` : ''}
    ${notes.length ? `<ul>${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
  </div>`;
}

function groups(deck) {
  const g = Object.fromEntries(SECTIONS.map((s) => [s, []]));
  for (const [name, count] of Object.entries(deck.cards)) {
    const card = lookup(name) || { name, cmc: 0, type_line: '?', front_type: '', mana_cost: '', img: null, oracle_text: '', keywords: [], color_identity: [], produced_mana: [], legalities: {} };
    const t = primaryType(card);
    g[SECTIONS.includes(t) ? t : 'Other'].push({ name, count, card });
  }
  for (const s of SECTIONS) g[s].sort((a, b) => a.card.cmc - b.card.cmc || a.name.localeCompare(b.name));
  return g;
}

function renderMain(root, deck, ctx) {
  const el = root.querySelector('#deck-main');
  const g = groups(deck);
  const shortBadge = (name, count) => {
    const card = lookup(name);
    if (!card || info(card).basic) return {};
    const free = ctx.avail(name);
    return count > free ? { badge: `${Math.max(0, free)} free`, badgeClass: 'short' } : {};
  };
  const actions = (name) => `<button class="btn icon" data-minus="${esc(name)}" aria-label="Remove one ${esc(name)}">−</button><button class="btn icon" data-plus="${esc(name)}" aria-label="Add one ${esc(name)}">+</button>`;
  let html = '';
  if (deck.commander) {
    const c = lookup(deck.commander);
    html += `<div class="section-head"><h3>Commander</h3></div><div class="grid">${c ? tileHTML(c, shortBadge(deck.commander, 1)) : esc(deck.commander)}</div>`;
  }
  for (const s of SECTIONS) {
    const items = g[s];
    if (!items.length) continue;
    const n = items.reduce((a, x) => a + x.count, 0);
    html += `<div class="section-head"><h3>${SECTION_LABEL[s]}</h3><span class="muted small">${n}</span></div>`;
    if (v.mode === 'grid') {
      html += `<div class="grid">${items.map((x) => tileHTML(x.card, { count: x.count, actions: actions(x.name), ...shortBadge(x.name, x.count) })).join('')}</div>`;
    } else {
      html += `<table class="list"><tbody>${items.map((x) => {
        const sb = shortBadge(x.name, x.count);
        return `<tr><td class="num" style="width:36px"><b>${x.count}</b></td><td><a href="javascript:void 0" data-card="${esc(x.name)}">${esc(x.name)}</a>${sb.badge ? ` <span class="issue-warn small">${esc(sb.badge)}</span>` : ''}</td><td>${manaHTML(x.card.mana_cost)}</td><td style="width:70px">${actions(x.name)}</td></tr>`;
      }).join('')}</tbody></table>`;
    }
  }
  if (!Object.keys(deck.cards).length && !deck.commander) html = '<p class="muted">This deck is empty. Use <b>Auto-fill</b> or add cards from the panel.</p>';
  el.innerHTML = html;
  el.onclick = (e) => {
    const m = e.target.closest('[data-minus]'); if (m) { e.stopPropagation(); ctx.change(m.dataset.minus, -1); return; }
    const p = e.target.closest('[data-plus]'); if (p) { e.stopPropagation(); ctx.change(p.dataset.plus, 1); return; }
    const c = e.target.closest('[data-card]');
    if (c) showCard(c.dataset.card, { deck, onDeckChange: ctx.change });
  };
}

// ---------- side panel ----------

function renderSide(root, deck, ctx) {
  const el = root.querySelector('#side');
  const prevScroll = el.querySelector('.add-list')?.scrollTop || 0;
  el.innerHTML = `
    <div class="side-tabs chips">
      <button class="chip" data-side="stats" aria-pressed="${v.side === 'stats'}">Stats</button>
      <button class="chip" data-side="add" aria-pressed="${v.side === 'add'}">Add cards</button>
    </div>
    <div id="side-body"></div>`;
  el.querySelector('.side-tabs').onclick = (e) => {
    const b = e.target.closest('[data-side]'); if (!b) return;
    v.side = b.dataset.side; renderSide(root, deck, ctx);
  };
  const body = el.querySelector('#side-body');
  if (v.side === 'stats') renderStats(body, deck);
  else {
    renderAdd(body, deck, ctx);
    const list = body.querySelector('.add-list');
    if (list) list.scrollTop = prevScroll;
  }
}

function renderStats(el, deck) {
  const s = deckStats(deck, lookup);
  const fmt = FORMATS[deck.format];
  const maxC = Math.max(1, ...s.curve);
  const labels = ['0', '1', '2', '3', '4', '5', '6', '7+'];
  const pipTotal = COLORS.reduce((a, c) => a + s.pips[c], 0) || 1;
  const srcMax = Math.max(1, ...COLORS.map((c) => s.sources[c]));
  const used = COLORS.filter((c) => s.pips[c] > 0 || s.sources[c] > 0);
  const typeRows = SECTIONS.filter((t) => s.types[t]).map((t) => `<span>${SECTION_LABEL[t]}</span><span>${s.types[t]}</span>`).join('');
  el.innerHTML = `
    <div class="stats" style="margin-bottom:14px">
      <div class="stat"><b>${s.total}</b><span>of ${fmt.size} cards</span></div>
      <div class="stat"><b>${s.lands}</b><span>lands (aim ${fmt.lands})</span></div>
      <div class="stat"><b>${s.avgCmc.toFixed(2)}</b><span>avg mana value</span></div>
    </div>
    <h3>Mana curve <span class="muted small">(non-land cards)</span></h3>
    <div class="chart" role="img" aria-label="Mana curve: ${labels.map((l, i) => `${s.curve[i]} at ${l}`).join(', ')}">
      ${s.curve.map((n, i) => `<div class="col" title="Mana value ${labels[i]}: ${n} card${n === 1 ? '' : 's'}"><span class="val">${n || ''}</span><div class="bar" style="height:${(n / maxC) * 80}%"></div></div>`).join('')}
    </div>
    <div class="chart-x">${labels.map((l) => `<span>${l}</span>`).join('')}</div>
    ${used.length ? `<h3 style="margin-top:16px">Colors</h3>
    <div class="colorbars">
      <span></span><span class="hdr">Share of colored pips</span><span class="hdr">Lands that make it</span>
      ${used.map((c) => `<span class="pip ${c}">${c}</span>
        <div title="${Math.round((100 * s.pips[c]) / pipTotal)}% of colored mana symbols"><div class="hbar"><div style="width:${(100 * s.pips[c]) / pipTotal}%"></div></div><small>${Math.round((100 * s.pips[c]) / pipTotal)}%</small></div>
        <div title="${s.sources[c]} land${s.sources[c] === 1 ? '' : 's'} produce ${c}"><div class="hbar"><div style="width:${(100 * s.sources[c]) / srcMax}%"></div></div><small>${s.sources[c]} lands</small></div>`).join('')}
    </div>` : ''}
    <h3 style="margin-top:16px">Roles</h3>
    <div class="kv">
      <span>Removal</span><span>${s.roles.removal}</span>
      <span>Card draw</span><span>${s.roles.draw}</span>
      <span>Ramp</span><span>${s.roles.ramp}</span>
      ${deck.format === 'commander' ? `<span>Board wipes</span><span>${s.roles.wipe}</span>` : ''}
    </div>
    <h3 style="margin-top:16px">Types</h3>
    <div class="kv">${typeRows}</div>`;
}

function renderAdd(el, deck, ctx) {
  const fmt = FORMATS[deck.format];
  const basics = fmt.hasCommander ? (lookup(deck.commander)?.color_identity || []) : deck.colors;
  const basicNames = (basics.length ? basics : ['C']).map((c) => BASIC_FOR_COLOR[c]);
  el.innerHTML = `
    <div class="stack">
      <div>
        <div class="small muted" style="margin-bottom:4px">Basic lands</div>
        <div class="row">${basicNames.map((n) => `<span class="row" style="gap:4px"><button class="btn icon" data-minus="${n}" aria-label="Remove ${n}">−</button><span class="small">${n} <b>${deck.cards[n] || 0}</b></span><button class="btn icon" data-plus="${n}" aria-label="Add ${n}">+</button></span>`).join('')}</div>
      </div>
      <input type="search" id="add-q" placeholder="Search your free cards…" value="${esc(v.query)}">
      <div class="row">
        <select id="add-type" aria-label="Type"><option value="">Any type</option>${TYPE_FILTERS.map((t) => `<option ${v.type === t ? 'selected' : ''}>${t}</option>`).join('')}</select>
        ${deck.theme || fmt.hasCommander ? `<label class="row small"><input type="checkbox" id="add-theme" ${v.themeOnly ? 'checked' : ''}> On-theme only ★</label>` : ''}
      </div>
      <div class="add-list" id="add-list"></div>
    </div>`;
  const drawList = () => {
    const ranked = rankForDeck(pool(deck.id), deck)
      .filter((r) => !info(r.entry.card).basic)
      .filter((r) => r.entry.available - (deck.cards[r.entry.name] || 0) > 0 && r.entry.name !== deck.commander)
      .filter((r) => !fmt.singleton || !deck.cards[r.entry.name] || info(r.entry.card).anyNumber)
      .filter((r) => matchesFilters(r.entry.card, { query: v.query, type: v.type }))
      .filter((r) => !v.themeOnly || r.theme);
    const list = el.querySelector('#add-list');
    list.innerHTML = ranked.length ? ranked.slice(0, v.shown).map((r) => {
      const c = r.entry.card;
      const free = r.entry.available - (deck.cards[r.entry.name] || 0);
      return `<div class="add-row">
        ${c.img_small ? `<img src="${esc(c.img_small)}" alt="" loading="lazy" data-card="${esc(c.name)}">` : ''}
        <div class="nm"><div>${r.theme ? '<span title="Matches the deck theme">★</span> ' : ''}<a href="javascript:void 0" data-card="${esc(c.name)}">${esc(c.name)}</a></div><small>${manaHTML(c.mana_cost)} ${esc(c.type_line)} · ${free} free</small></div>
        <button class="btn icon" data-plus="${esc(c.name)}" aria-label="Add ${esc(c.name)}">+</button>
      </div>`;
    }).join('') + (ranked.length > v.shown ? `<div style="text-align:center;padding:8px"><button class="btn small" id="more">Show more (${ranked.length - v.shown} left)</button></div>` : '')
      : '<p class="muted small">No free cards match. Cards used in other decks are hidden.</p>';
  };
  drawList();
  el.querySelector('#add-q').addEventListener('input', debounce((e) => { v.query = e.target.value; v.shown = 40; drawList(); }));
  el.querySelector('#add-type').addEventListener('change', (e) => { v.type = e.target.value; v.shown = 40; drawList(); });
  el.querySelector('#add-theme')?.addEventListener('change', (e) => { v.themeOnly = e.target.checked; v.shown = 40; drawList(); });
  el.onclick = (e) => {
    if (e.target.id === 'more') { v.shown += 40; drawList(); return; }
    const p = e.target.closest('[data-plus]'); if (p) { ctx.change(p.dataset.plus, 1); return; }
    const m = e.target.closest('[data-minus]'); if (m) { ctx.change(m.dataset.minus, -1); return; }
    const c = e.target.closest('[data-card]');
    if (c) showCard(c.dataset.card, { deck, onDeckChange: ctx.change });
  };
}

function showExport(deck) {
  let withSet = true;
  const body = () => `
    <div class="row spread"><h2 style="margin:0">Export “${esc(deck.name)}”</h2><button class="btn ghost small" data-close>Close</button></div>
    <p class="small muted">Paste into Moxfield, Archidekt, MTG Arena, or print it as a pull list for your binder.</p>
    <label class="row small" style="margin-bottom:8px"><input type="checkbox" id="ex-set" ${withSet ? 'checked' : ''}> Include set and collector number (the printing you own)</label>
    <textarea class="export" id="ex-text" readonly>${esc(exportText(deck, lookup, { withSet }))}</textarea>
    <div class="row" style="margin-top:10px">
      <button class="btn primary" id="ex-copy">Copy to clipboard</button>
      <button class="btn" id="ex-dl">Download .txt</button>
    </div>`;
  const mount = (el) => {
    el.querySelector('#ex-set').addEventListener('change', (e) => { withSet = e.target.checked; openModal(body(), mount); });
    el.querySelector('#ex-copy').addEventListener('click', async () => {
      const ta = el.querySelector('#ex-text');
      try { await navigator.clipboard.writeText(ta.value); } catch { ta.select(); document.execCommand('copy'); }
      toast('Copied');
    });
    el.querySelector('#ex-dl').addEventListener('click', () => download(`${deck.name.replace(/[^\w\- ]+/g, '').trim() || 'deck'}.txt`, el.querySelector('#ex-text').value));
  };
  openModal(body(), mount);
}

export { closeModal };
