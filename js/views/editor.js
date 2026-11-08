import { state, lookup, pool, saveDeck, deleteDeck, newDeckId, availabilityFn, freeByKey, ensureCards } from '../store.js';
import {
  FORMAT, validateDeck, deckStats, deckSize, exportText, info, makeContext, scoreCard, isGameChanger,
  reasonFor, explain, gamePlan, findDeckCombos, BRACKET_RULES,
} from '../builder.js';
import { BRACKETS, edhrecUrl } from '../edhrec.js';
import { comboUrl } from '../data.js';
import { loadContext, buildFor } from '../engine.js';
import { COLORS, BASIC_FOR_COLOR, primaryType, nameKey } from '../cards.js';
import { esc, manaHTML, pipsHTML, tileHTML, toast, openModal, download, matchesFilters, TYPE_FILTERS, debounce, cardImageURL } from '../ui.js';
import { showCard } from './card-modal.js';

const SECTIONS = ['Creature', 'Planeswalker', 'Instant', 'Sorcery', 'Artifact', 'Enchantment', 'Battle', 'Other', 'Land'];
const SECTION_LABEL = { Creature: 'Creatures', Planeswalker: 'Planeswalkers', Instant: 'Instants', Sorcery: 'Sorceries', Artifact: 'Artifacts', Enchantment: 'Enchantments', Battle: 'Battles', Other: 'Other', Land: 'Lands' };

const v = { side: 'plan', query: '', type: '', shown: 40, mode: 'grid', deckId: null };

export function render(root, id) {
  const deck = state.decks.get(id);
  if (!deck) {
    root.innerHTML = '<div class="empty"><h1>Deck not found</h1><a class="btn" href="#/decks">Back to my decks</a></div>';
    return;
  }
  if (deck.format !== 'commander') {
    root.innerHTML = `<div class="empty"><h1>${esc(deck.name)}</h1><p class="muted">This deck was made with an older version of the app that built 60-card decks. Only Commander decks are supported now.</p>
      <button class="btn danger" id="del-old">Delete this deck</button> <a class="btn" href="#/decks">Back</a></div>`;
    root.querySelector('#del-old').onclick = async () => { await deleteDeck(deck.id); location.hash = '#/decks'; };
    return;
  }
  if (v.deckId !== id) Object.assign(v, { query: '', type: '', shown: 40, deckId: id });
  deck.bracket ||= 3;
  const bracket = BRACKETS.find((b) => b.n === deck.bracket);
  root.innerHTML = `
    <div class="row spread">
      <input class="deck-name" id="deck-name" value="${esc(deck.name)}" aria-label="Deck name">
      <div class="row">
        <button class="btn small" id="fill" title="Add the best free cards until the deck reaches 100">Auto-fill</button>
        <button class="btn small" id="rebuild" title="Throw this list away and build again">Rebuild</button>
        <button class="btn small primary" id="export">Export</button>
        <button class="btn small" id="dup">Duplicate</button>
        <button class="btn small danger" id="del">Delete</button>
      </div>
    </div>
    <div class="row small" style="margin:4px 0 12px">
      <span><b id="size-label"></b></span>
      <span>${pipsHTML(deck.colors)}</span>
      ${deck.themeLabel ? `<span class="muted">· ${esc(deck.themeLabel)}</span>` : ''}
      <label class="muted">· Bracket <select id="bracket" aria-label="Bracket">${BRACKETS.map((b) => `<option value="${b.n}" ${b.n === deck.bracket ? 'selected' : ''}>${b.n}. ${esc(b.label)}</option>`).join('')}</select></label>
      ${deck.edhSlug ? `<a class="small" href="${edhrecUrl(deck.edhSlug, deck.theme)}" target="_blank" rel="noopener">EDHREC ↗</a>` : ''}
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
  // Load EDHREC + combos in the background for explanations and combo detection.
  loadContext({ commanderName: deck.commander, slug: deck.edhSlug, theme: deck.theme, bracket: deck.theme ? null : deck.bracket }).then((x) => {
    ctx.data = x;
    if (state.decks.get(id) === deck && document.getElementById('deck-main')) ctx.refresh();
  });
}

function makeCtx(root, deck) {
  const ctx = {
    data: null,
    avail: availabilityFn(deck.id),
    builderCtx() {
      return makeContext({ commander: lookup(deck.commander), edh: ctx.data?.edh, bracket: deck.bracket, gameChangers: ctx.data?.gc || new Set() });
    },
    combos() {
      if (!ctx.data?.comboIndex) return null;
      return findDeckCombos(deck.cards, lookup(deck.commander), ctx.data.comboIndex, ctx.builderCtx());
    },
    reason(name) {
      if (deck.reasons?.[name]) return deck.reasons[name];
      const card = lookup(name);
      if (!card || !ctx.data) return null;
      const c = ctx.combos();
      return reasonFor(card, ctx.builderCtx(), c ? c.complete : []);
    },
    explain(name) {
      const card = lookup(name);
      const combosById = new Map((ctx.combos()?.complete || []).map((c) => [c.id, c]));
      const r = { ...(ctx.reason(name) || {}) };
      if (ctx.combos()) r.combos = ctx.combos().complete.filter((c) => c.keys.includes(nameKey(name))).map((c) => c.id);
      return explain(name, r, { commanderName: deck.commander, variantLabel: deck.edhVariantLabel, numDecks: deck.numDecks || ctx.data?.edh?.numDecks || 0, combosById, basic: card && info(card).basic });
    },
    refresh() {
      ctx.avail = availabilityFn(deck.id);
      renderMain(root, deck, ctx);
      renderIssues(root, deck, ctx);
      renderSide(root, deck, ctx);
      root.querySelector('#size-label').textContent = `${deckSize(deck)} / ${FORMAT.size} cards`;
    },
    async change(name, delta) {
      const card = lookup(name);
      const cur = deck.cards[name] || 0;
      if (delta > 0 && card && !info(card).basic) {
        if (cur >= 1 && !info(card).anyNumber) { toast('Commander decks can only have one copy of each card.'); return; }
        const free = ctx.avail(name) + (deck.external?.[name] || 0);
        if (cur + delta > free) { toast(free <= 0 ? `No free copies of ${name}: they're all in other decks.` : `You only have ${free} free cop${free === 1 ? 'y' : 'ies'} of ${name}.`); return; }
      }
      const next = Math.max(0, cur + delta);
      if (next) deck.cards[name] = next; else delete deck.cards[name];
      if (!next && deck.reasons) delete deck.reasons[name];
      if (deck.toBuy?.[name] && deck.toBuy[name] > next) {
        if (next) deck.toBuy[name] = next; else delete deck.toBuy[name];
      }
      await saveDeck(deck);
      ctx.refresh();
    },
  };
  return ctx;
}

function bindHeader(root, deck, ctx) {
  root.querySelector('#deck-name').addEventListener('change', async (e) => { deck.name = e.target.value.trim() || deck.name; await saveDeck(deck); toast('Renamed'); });
  root.querySelector('#view-mode').addEventListener('click', (e) => { v.mode = v.mode === 'grid' ? 'list' : 'grid'; e.target.textContent = v.mode === 'grid' ? 'List view' : 'Image view'; renderMain(root, deck, ctx); });
  root.querySelector('#bracket').addEventListener('change', async (e) => { deck.bracket = Number(e.target.value); await saveDeck(deck); ctx.refresh(); toast('Bracket changed. Use Rebuild to rebuild the deck for it.'); });
  const rebuildWith = async (locked, btn) => {
    const label = btn.textContent;
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
    try {
      const keep = { ...locked };
      const res = await buildFor({ commanderName: deck.commander, slug: deck.edhSlug, theme: deck.theme, themeLabel: deck.themeLabel, bracket: deck.bracket, excludeDeckId: deck.id, locked: keep, settings: deck.settings || {} });
      // Keep earlier "buy" marks for cards that stay in the deck (Auto-fill keeps them locked).
      const oldBuy = Object.fromEntries(Object.entries(deck.toBuy || {}).filter(([n]) => res.cards[n]));
      deck.toBuy = { ...oldBuy, ...res.toBuy };
      deck.cards = res.cards;
      deck.reasons = { ...(deck.reasons || {}), ...res.reasons };
      for (const n of Object.keys(deck.toBuy)) deck.reasons[n] = { ...(deck.reasons[n] || {}), buy: true };
      for (const n of Object.keys(deck.reasons)) if (!deck.cards[n]) delete deck.reasons[n];
      deck.combos = res.combos;
      deck.notes = res.notes;
      deck.numDecks = res.ctx.edh?.numDecks || deck.numDecks || 0;
      await saveDeck(deck);
      ctx.refresh();
      return true;
    } catch (err) {
      toast(err.message || String(err));
      return false;
    } finally {
      btn.disabled = false; btn.textContent = label;
    }
  };
  root.querySelector('#fill').addEventListener('click', async (e) => {
    if (deckSize(deck) >= FORMAT.size) { toast('Deck is already full.'); return; }
    const before = deckSize(deck);
    if (await rebuildWith({ ...deck.cards }, e.target)) toast(`Added ${deckSize(deck) - before} cards`);
  });
  root.querySelector('#rebuild').addEventListener('click', async (e) => {
    if (!confirm('Rebuild this deck from scratch? Your edits to the list will be lost.')) return;
    if (await rebuildWith({}, e.target)) toast('Deck rebuilt');
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
  const issues = validateDeck(deck, lookup, ctx.avail, { gameChangers: ctx.data?.gc });
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
  const comboKeys = new Set((ctx.combos()?.complete || []).flatMap((c) => c.keys));
  const badgeFor = (name, count) => {
    const card = lookup(name);
    if (!card || info(card).basic) return {};
    if (deck.toBuy?.[name]) return { badge: `Buy${card.price ? ` $${card.price}` : ''}`, badgeClass: 'buy' };
    const free = ctx.avail(name) + (deck.external?.[name] || 0);
    if (count > free) return { badge: free <= 0 ? 'Not owned' : `${free} free`, badgeClass: 'short' };
    const r = ctx.reason(name);
    if (r?.incl != null) return { badge: `${Math.round(r.incl * 100)}%`, badgeClass: '' };
    return {};
  };
  const actions = (name) => `<button class="btn icon" data-minus="${esc(name)}" aria-label="Remove ${esc(name)}">−</button>`;
  let html = '';
  if (deck.commander) {
    const c = lookup(deck.commander);
    html += `<div class="section-head"><h3>Commander</h3></div><div class="grid">${c ? tileHTML(c, badgeFor(deck.commander, 1)) : esc(deck.commander)}</div>`;
  }
  for (const s of SECTIONS) {
    const items = g[s];
    if (!items.length) continue;
    const n = items.reduce((a, x) => a + x.count, 0);
    html += `<div class="section-head"><h3>${SECTION_LABEL[s]}</h3><span class="muted small">${n}</span></div>`;
    if (v.mode === 'grid') {
      html += `<div class="grid">${items.map((x) => tileHTML(x.card, {
        count: x.count > 1 ? x.count : null, actions: actions(x.name), combo: comboKeys.has(nameKey(x.name)), ...badgeFor(x.name, x.count),
      })).join('')}</div>`;
    } else {
      html += `<table class="list"><tbody>${items.map((x) => {
        const b = badgeFor(x.name, x.count);
        return `<tr><td class="num" style="width:30px">${x.count}</td>
          <td><a href="javascript:void 0" data-card="${esc(x.name)}">${esc(x.name)}</a>${comboKeys.has(nameKey(x.name)) ? ' <span class="tag combo">combo</span>' : ''}${b.badgeClass === 'short' ? ` <span class="issue-warn small">${esc(b.badge)}</span>` : ''}${b.badgeClass === 'buy' ? ` <span class="tag buy">${esc(b.badge)}</span>` : ''}
            <div class="small muted">${esc(ctx.explain(x.name))}</div></td>
          <td style="width:90px">${manaHTML(x.card.mana_cost)}</td><td style="width:40px">${actions(x.name)}</td></tr>`;
      }).join('')}</tbody></table>`;
    }
  }
  if (!Object.keys(deck.cards).length) html += '<p class="muted">This deck is empty. Use <b>Auto-fill</b> or add cards from the panel.</p>';
  html += '<p class="small muted" style="margin-top:14px">Percentages show how many EDHREC decks for this commander play the card. Click any card to see why it was picked.</p>';
  el.innerHTML = html;
  el.onclick = (e) => {
    const m = e.target.closest('[data-minus]'); if (m) { e.stopPropagation(); ctx.change(m.dataset.minus, -1); return; }
    const c = e.target.closest('[data-card]');
    if (c) showCard(c.dataset.card, { deck, onDeckChange: ctx.change, why: ctx.explain(c.dataset.card) });
  };
}

// ---------- side panel ----------

function renderSide(root, deck, ctx) {
  const el = root.querySelector('#side');
  const prevScroll = el.querySelector('.add-list')?.scrollTop || 0;
  const combos = ctx.combos();
  el.innerHTML = `
    <div class="side-tabs chips">
      <button class="chip" data-side="plan" aria-pressed="${v.side === 'plan'}">Game plan</button>
      <button class="chip" data-side="combos" aria-pressed="${v.side === 'combos'}">Combos${combos ? ` <span class="count">${combos.complete.length}</span>` : ''}</button>
      <button class="chip" data-side="stats" aria-pressed="${v.side === 'stats'}">Stats</button>
      <button class="chip" data-side="add" aria-pressed="${v.side === 'add'}">Add cards</button>
      ${buyCount(deck) ? `<button class="chip" data-side="buy" aria-pressed="${v.side === 'buy'}">To buy <span class="count">${buyCount(deck)}</span></button>` : ''}
    </div>
    <div id="side-body"></div>`;
  el.querySelector('.side-tabs').onclick = (e) => {
    const b = e.target.closest('[data-side]'); if (!b) return;
    v.side = b.dataset.side; renderSide(root, deck, ctx);
  };
  const body = el.querySelector('#side-body');
  if (v.side === 'buy' && !buyCount(deck)) v.side = 'plan';
  if (v.side === 'stats') renderStats(body, deck, ctx);
  else if (v.side === 'buy') renderBuy(body, deck, ctx);
  else if (v.side === 'plan') renderPlan(body, deck, ctx);
  else if (v.side === 'combos') renderCombos(body, deck, ctx);
  else {
    renderAdd(body, deck, ctx);
    const list = body.querySelector('.add-list');
    if (list) list.scrollTop = prevScroll;
  }
  body.addEventListener('click', (e) => {
    const c = e.target.closest('[data-card]');
    if (c && !e.target.closest('[data-plus]')) showCard(c.dataset.card, { deck, onDeckChange: ctx.change, why: deck.cards[c.dataset.card] ? ctx.explain(c.dataset.card) : null });
  });
}

function cardLinks(names) {
  return names.map((n) => `<a href="javascript:void 0" data-card="${esc(n)}">${esc(n)}</a>`).join(', ');
}

function renderPlan(el, deck, ctx) {
  if (!ctx.data) { el.innerHTML = '<p class="muted"><span class="spinner"></span> Loading EDHREC and combo data…</p>'; return; }
  const combos = ctx.combos();
  const plan = gamePlan(deck, lookup, { edh: ctx.data.edh, combosInDeck: combos?.complete || [], themeLabel: deck.themeLabel, bracket: deck.bracket });
  el.innerHTML = plan.map((p) => `<div class="plan-step"><h3>${esc(p.title)}</h3><p>${esc(p.text)}</p>${p.cards.length ? `<div class="thumbs">${p.cards.slice(0, 5).map((n) => {
    const c = lookup(n);
    return c?.img_small ? `<img src="${esc(c.img_small)}" alt="${esc(n)}" title="${esc(n)}" data-card="${esc(n)}" loading="lazy">` : '';
  }).join('')}</div>` : ''}</div>`).join('')
    + `<p class="small muted">Generated from this deck's cards, EDHREC data and Commander Spellbook combos.</p>`;
}

function comboHTML(c, { missing = null, ownMissing = false } = {}) {
  return `<div class="combo">
    <div class="combo-cards">${c.cards.map((n) => (lookup(n)?.img_small ? `<img src="${esc(lookup(n).img_small)}" alt="${esc(n)}" title="${esc(n)}" data-card="${esc(n)}" loading="lazy" class="${missing && nameKey(n) === missing ? 'missing' : ''}">` : `<span class="img-ph${missing && nameKey(n) === missing ? ' missing' : ''}" data-card="${esc(n)}">${esc(n)}</span>`)).join('')}</div>
    <div class="small"><b>${esc(c.produces.slice(0, 3).join(' · '))}</b></div>
    <div class="small muted">${cardLinks(c.cards)}${c.requires.length ? ` · also needs: ${esc(c.requires.join(', '))}` : ''}</div>
    ${missing ? `<div class="small">${ownMissing ? '<span class="tag ok">Missing piece is in your collection</span>' : '<span class="tag">Missing piece not owned</span>'}</div>` : ''}
    <div class="small"><a href="${comboUrl(c)}" target="_blank" rel="noopener">How it works (Commander Spellbook) ↗</a> · min. bracket ${c.minBracket}</div>
  </div>`;
}

const buyCount = (deck) => Object.values(deck.toBuy || {}).reduce((a, b) => a + b, 0);

/** Shopping list for recommended cards that were added because your collection ran out. */
function renderBuy(el, deck, ctx) {
  const items = Object.entries(deck.toBuy || {}).map(([n, c]) => ({ n, c, card: lookup(n) }))
    .sort((a, b) => (Number(a.card?.price) || 0) - (Number(b.card?.price) || 0));
  const total = items.reduce((a, x) => a + (Number(x.card?.price) || 0) * x.c, 0);
  const list = items.map((x) => `${x.c} ${x.n}`).join('\n');
  const tcg = `https://www.tcgplayer.com/massentry?productline=Magic&c=${encodeURIComponent(items.map((x) => `${x.c} ${x.n}`).join('||'))}`;
  el.innerHTML = `
    <p class="small">Your collection ran out, so these EDHREC recommendations for ${esc(deck.commander)} fill the remaining slots. Cheaper cards were preferred.</p>
    <div class="stats" style="margin-bottom:10px">
      <div class="stat"><b>${buyCount(deck)}</b><span>cards</span></div>
      <div class="stat"><b>$${total.toFixed(2)}</b><span>approx. total (Scryfall)</span></div>
    </div>
    <div class="row" style="margin-bottom:10px">
      <a class="btn small primary" href="${tcg}" target="_blank" rel="noopener">Buy on TCGplayer ↗</a>
      <button class="btn small" id="copy-buy">Copy list</button>
    </div>
    ${items.map((x) => `<div class="add-row">
      ${x.card?.img_small ? `<img src="${esc(x.card.img_small)}" alt="" loading="lazy" data-card="${esc(x.n)}">` : ''}
      <div class="nm"><div><a href="javascript:void 0" data-card="${esc(x.n)}">${esc(x.n)}</a></div>
        <small>${x.card?.price ? `$${esc(x.card.price)}` : 'no price'}${ctx.reason(x.n)?.incl != null ? ` · in ${Math.round(ctx.reason(x.n).incl * 100)}% of decks` : ''}</small></div>
      <button class="btn small" data-got="${esc(x.n)}" title="You got this card: count it as part of your collection">Got it</button>
      <button class="btn icon" data-minus="${esc(x.n)}" aria-label="Remove ${esc(x.n)}">−</button>
    </div>`).join('')}
    <p class="small muted" style="margin-top:8px">“Got it” stops marking the card as one to buy. Import it into your collection too, so it's counted as yours.</p>`;
  el.querySelector('#copy-buy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(list); toast('Copied'); } catch { toast(list); }
  });
  el.onclick = async (e) => {
    const g = e.target.closest('[data-got]');
    if (g) {
      delete deck.toBuy[g.dataset.got];
      if (deck.reasons?.[g.dataset.got]) delete deck.reasons[g.dataset.got].buy;
      await saveDeck(deck);
      ctx.refresh();
      return;
    }
    const m = e.target.closest('[data-minus]');
    if (m) ctx.change(m.dataset.minus, -1);
  };
}

function renderCombos(el, deck, ctx) {
  if (!ctx.data) { el.innerHTML = '<p class="muted"><span class="spinner"></span> Loading combo data…</p>'; return; }
  const combos = ctx.combos();
  if (!combos) { el.innerHTML = '<p class="muted">Combo data (data/combos.json) could not be loaded.</p>'; return; }
  const free = freeByKey(deck.id);
  const allowed = combos.oneAway.filter((x) => x.combo.minBracket <= deck.bracket).slice(0, 25);
  // Fetch data for pieces you don't own in one batched request, then redraw with their images.
  const unknown = allowed.map((x) => x.missingName).filter((n) => !lookup(n));
  if (unknown.length && !ctx.fetchedMissing) {
    ctx.fetchedMissing = true;
    ensureCards(unknown).then(() => { if (v.side === 'combos' && document.getElementById('side-body')) renderCombos(document.getElementById('side-body'), deck, ctx); }).catch(() => {});
  }
  el.innerHTML = `
    <h3>In this deck (${combos.complete.length})</h3>
    ${combos.complete.length ? combos.complete.slice(0, 30).map((c) => comboHTML(c)).join('') : '<p class="small muted">No complete combos yet.</p>'}
    <h3 style="margin-top:16px">One card away (${combos.oneAway.length})</h3>
    <p class="small muted">Combos within ${esc(deck.commander)}'s colors and bracket ${deck.bracket} that need just one more card.</p>
    ${allowed.map((x) => {
      const own = (free.get(x.missing) || 0) > 0;
      return comboHTML(x.combo, { missing: x.missing, ownMissing: own }) + (own ? `<div style="margin:-6px 0 10px"><button class="btn small" data-plus="${esc(state.byName.has(x.missingName) ? x.missingName : [...state.byName.keys()].find((n) => nameKey(n) === x.missing) || x.missingName)}">Add ${esc(x.missingName)}</button></div>` : '');
    }).join('') || '<p class="small muted">None.</p>'}`;
  el.onclick = (e) => { const p = e.target.closest('[data-plus]'); if (p) ctx.change(p.dataset.plus, 1); };
}

function renderStats(el, deck, ctx) {
  const s = deckStats(deck, lookup);
  const maxC = Math.max(1, ...s.curve);
  const labels = ['0', '1', '2', '3', '4', '5', '6', '7+'];
  const pipTotal = COLORS.reduce((a, c) => a + s.pips[c], 0) || 1;
  const srcMax = Math.max(1, ...COLORS.map((c) => s.sources[c]));
  const used = COLORS.filter((c) => deck.colors.includes(c));
  const typeRows = SECTIONS.filter((t) => s.types[t]).map((t) => `<span>${SECTION_LABEL[t]}</span><span>${s.types[t]}</span>`).join('');
  const bctx = ctx.builderCtx();
  const gcs = Object.keys(deck.cards).filter((n) => { const c = lookup(n); return c && isGameChanger(c, bctx); });
  const rules = BRACKET_RULES[deck.bracket];
  el.innerHTML = `
    <div class="stats" style="margin-bottom:14px">
      <div class="stat"><b>${s.total}</b><span>of 100 cards</span></div>
      <div class="stat"><b>${s.lands}</b><span>lands</span></div>
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
      <span>Ramp</span><span>${s.roles.ramp}</span>
      <span>Card draw</span><span>${s.roles.draw}</span>
      <span>Removal</span><span>${s.roles.removal}</span>
      <span>Board wipes</span><span>${s.roles.wipe}</span>
    </div>
    <h3 style="margin-top:16px">Bracket ${deck.bracket}</h3>
    <div class="kv">
      <span>Game Changers</span><span>${gcs.length} / ${rules.gameChangers === 99 ? 'any' : rules.gameChangers}</span>
    </div>
    ${gcs.length ? `<p class="small muted">${cardLinks(gcs)}</p>` : ''}
    <h3 style="margin-top:16px">Types</h3>
    <div class="kv">${typeRows}</div>`;
}

function renderAdd(el, deck, ctx) {
  const basicNames = (deck.colors.length ? deck.colors : ['C']).map((c) => BASIC_FOR_COLOR[c]);
  el.innerHTML = `
    <div class="stack">
      <div>
        <div class="small muted" style="margin-bottom:4px">Basic lands</div>
        <div class="row">${basicNames.map((n) => `<span class="row" style="gap:4px"><button class="btn icon" data-minus="${n}" aria-label="Remove ${n}">−</button><span class="small">${n} <b>${deck.cards[n] || 0}</b></span><button class="btn icon" data-plus="${n}" aria-label="Add ${n}">+</button></span>`).join('')}</div>
      </div>
      <input type="search" id="add-q" placeholder="Search your free cards…" value="${esc(v.query)}">
      <select id="add-type" aria-label="Type"><option value="">Any type</option>${TYPE_FILTERS.map((t) => `<option ${v.type === t ? 'selected' : ''}>${t}</option>`).join('')}</select>
      <div class="add-list" id="add-list"></div>
    </div>`;
  const drawList = () => {
    const bctx = ctx.builderCtx();
    const inDeck = new Set(Object.keys(deck.cards).map(nameKey));
    const ranked = pool(deck.id)
      .filter((e) => e.available > 0 && !info(e.card).basic && !inDeck.has(info(e.card).key) && e.name !== deck.commander)
      .filter((e) => (info(e.card).identity & ~bctx.mask) === 0 && e.card.legalities.commander === 'legal' && info(e.card).playable)
      .filter((e) => matchesFilters(e.card, { query: v.query, type: v.type }))
      .map((e) => ({ e, ...scoreCard(e.card, bctx) }))
      .sort((a, b) => b.s - a.s);
    const list = el.querySelector('#add-list');
    list.innerHTML = ranked.length ? ranked.slice(0, v.shown).map((r) => {
      const c = r.e.card;
      return `<div class="add-row">
        ${c.img_small ? `<img src="${esc(c.img_small)}" alt="" loading="lazy" data-card="${esc(c.name)}">` : ''}
        <div class="nm"><div><a href="javascript:void 0" data-card="${esc(c.name)}">${esc(c.name)}</a></div>
          <small>${r.edh ? `${Math.round(r.edh.incl * 100)}% of decks${r.edh.syn >= 0.05 ? ` · +${Math.round(r.edh.syn * 100)}% synergy` : ''}` : 'not on EDHREC list'} · ${manaHTML(c.mana_cost)}</small></div>
        <button class="btn icon" data-plus="${esc(c.name)}" aria-label="Add ${esc(c.name)}">+</button>
      </div>`;
    }).join('') + (ranked.length > v.shown ? `<div style="text-align:center;padding:8px"><button class="btn small" id="more">Show more (${ranked.length - v.shown} left)</button></div>` : '')
      : '<p class="muted small">No free cards match. Cards used in other decks are hidden.</p>';
  };
  drawList();
  el.querySelector('#add-q').addEventListener('input', debounce((e) => { v.query = e.target.value; v.shown = 40; drawList(); }));
  el.querySelector('#add-type').addEventListener('change', (e) => { v.type = e.target.value; v.shown = 40; drawList(); });
  el.onclick = (e) => {
    if (e.target.id === 'more') { v.shown += 40; drawList(); return; }
    const p = e.target.closest('[data-plus]'); if (p) { ctx.change(p.dataset.plus, 1); return; }
    const m = e.target.closest('[data-minus]'); if (m) { ctx.change(m.dataset.minus, -1); }
  };
}

function showExport(deck) {
  let withSet = true;
  const body = () => `
    <div class="row spread"><h2 style="margin:0">Export “${esc(deck.name)}”</h2><button class="btn ghost small" data-close>Close</button></div>
    <p class="small muted">Paste into Moxfield, Archidekt or MTG Arena, or print it as a pull list for your binder.</p>
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

export { ensureCards };
