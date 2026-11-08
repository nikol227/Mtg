import { state, pool, saveDeck, newDeckId, collectionTotals, freeByKey, lookup } from '../store.js';
import { ownedCommanders, info } from '../builder.js';
import { popularCommanders, coverage } from '../data.js';
import { commanderPage, BRACKETS, edhrecUrl } from '../edhrec.js';
import { buildFor, safe } from '../engine.js';
import { nameKey, edhrecSlug } from '../cards.js';
import { esc, pipsHTML, toast, debounce } from '../ui.js';

const v = { tab: 'best', query: '', commander: null, slug: null, theme: null, themeLabel: null, bracket: 3, name: '', edh: null, edhFor: null, shown: 24 };
let rankCache = { version: -1, list: null };

export function render(root) {
  if (!collectionTotals().total) {
    root.innerHTML = `<div class="empty"><h1>No cards yet</h1><p class="muted">Import your collection first, then come back to build a Commander deck from it.</p><a class="btn primary" href="#/collection">Import cards</a></div>`;
    return;
  }
  root.innerHTML = `
    <h1>Build a Commander deck</h1>
    <p class="muted">Pick a commander, a strategy and a power level. The deck uses cards from your collection that aren't already in other decks, guided by what EDHREC players run with that commander and by combos from Commander Spellbook.</p>
    <div class="steps">
      <section class="panel" id="step-cmd"></section>
      <section class="panel ${v.commander ? '' : 'hidden'}" id="step-theme"></section>
      <section class="panel ${v.commander ? '' : 'hidden'}" id="step-bracket"></section>
      <section class="panel ${v.commander ? '' : 'hidden'}" id="step-go"></section>
    </div>`;
  renderCommanders(root);
  if (v.commander) { renderTheme(root); renderBracket(root); renderGo(root); }
}

function stepTitle(n, title, sub = '') {
  return `<div class="step-title"><span class="step-num">${n}</span><h2>${title}</h2>${sub ? `<span class="muted small">${sub}</span>` : ''}</div>`;
}

/** Popular commanders (EDHREC) + legends you own, scored by how much of their deck you have. */
async function rankedCommanders() {
  if (rankCache.version === state.version && rankCache.list) return rankCache.list;
  const free = freeByKey();
  const popular = await safe(popularCommanders());
  const out = new Map();
  for (const c of popular?.list || []) {
    out.set(c.key, { name: c.name, slug: c.slug, colors: c.colors, img: c.img, decks: c.decks, rank: c.rank, themes: c.themes, cov: coverage(c, free) });
  }
  for (const e of ownedCommanders(pool())) {
    const k = info(e.card).key;
    const x = out.get(k);
    if (x) { x.cov.ownCommander = true; x.card = e.card; continue; }
    out.set(k, { name: e.name, slug: edhrecSlug(e.name), colors: e.card.color_identity, img: e.card.img_small || e.card.img, card: e.card, decks: 0, rank: null, themes: [], cov: { owned: 0, considered: 0, pct: null, ownCommander: true, topOwned: [] } });
  }
  const list = [...out.values()];
  for (const x of list) {
    // Owning the commander matters a lot; popular commanders get a small nudge (better data).
    x.score = (x.cov.pct ?? 0.15) * 100 + (x.cov.ownCommander ? 12 : 0) + Math.min(5, Math.log10(1 + x.decks));
  }
  list.sort((a, b) => b.score - a.score);
  rankCache = { version: state.version, list, popularLoaded: !!popular };
  return list;
}

function renderCommanders(root) {
  const el = root.querySelector('#step-cmd');
  el.innerHTML = `${stepTitle(1, 'Commander', 'Ranked by how much of a typical deck for it you already own')}
    <div class="row" style="margin-bottom:12px">
      <div class="chips">
        <button class="chip" data-tab="best" aria-pressed="${v.tab === 'best'}">Best for my collection</button>
        <button class="chip" data-tab="owned" aria-pressed="${v.tab === 'owned'}">Commanders I own</button>
      </div>
      <input type="search" id="cmd-q" placeholder="Search any commander…" value="${esc(v.query)}" style="flex:1 1 240px">
    </div>
    <div class="picks" id="cmds"><span><span class="spinner"></span> Comparing your collection with 1,000 popular commanders…</span></div>
    <div id="cmd-more"></div>`;
  const draw = async () => {
    const all = await rankedCommanders();
    const box = el.querySelector('#cmds');
    if (!box) return;
    const q = v.query.trim().toLowerCase();
    let list = v.tab === 'owned' ? all.filter((x) => x.cov.ownCommander) : all;
    if (q) list = all.filter((x) => x.name.toLowerCase().includes(q));
    const shown = list.slice(0, v.shown);
    box.innerHTML = shown.map(tile).join('') || (q ? '' : '<p class="muted">No legendary creatures are free in your collection. Try “Best for my collection”.</p>');
    const more = el.querySelector('#cmd-more');
    more.innerHTML = `${list.length > v.shown ? `<div class="pager"><button class="btn small" id="show-more">Show more (${list.length - v.shown})</button></div>` : ''}
      ${q && !all.some((x) => x.name.toLowerCase() === q) ? `<p class="small muted" style="margin-top:8px">Not listed? <button class="btn small" id="use-typed">Use “${esc(v.query.trim())}” as commander</button></p>` : ''}
      ${!rankCache.popularLoaded ? '<p class="small muted">Popular-commander data (data/commanders.json) could not be loaded, so only commanders you own are shown.</p>' : ''}`;
    more.querySelector('#show-more')?.addEventListener('click', () => { v.shown += 24; draw(); });
    more.querySelector('#use-typed')?.addEventListener('click', () => choose(v.query.trim(), null));
  };
  const choose = (name, slug) => {
    v.commander = name; v.slug = slug || edhrecSlug(name); v.theme = null; v.themeLabel = null; v.name = ''; v.edh = null; v.edhFor = null;
    render(root);
    root.querySelector('#step-theme').scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  draw();
  el.querySelector('.chips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]'); if (!b) return;
    v.tab = b.dataset.tab; v.shown = 24;
    el.querySelectorAll('[data-tab]').forEach((x) => x.setAttribute('aria-pressed', x.dataset.tab === v.tab));
    draw();
  });
  el.querySelector('#cmd-q').addEventListener('input', debounce((e) => { v.query = e.target.value; v.shown = 24; draw(); }));
  el.querySelector('#cmds').addEventListener('click', (e) => {
    const b = e.target.closest('[data-cmd]'); if (!b) return;
    choose(b.dataset.cmd, b.dataset.slug);
  });
}

function tile(x) {
  const pct = x.cov.pct == null ? null : Math.round(x.cov.pct * 100);
  return `<button type="button" class="pick cmd-pick" data-cmd="${esc(x.name)}" data-slug="${esc(x.slug)}" aria-pressed="${v.commander === x.name}">
    ${x.img ? `<img src="${esc(x.img)}" alt="" loading="lazy">` : ''}
    <span style="flex:1;min-width:0">
      <span class="t">${esc(x.name)}</span>
      <span class="d">${pipsHTML(x.colors)} ${x.cov.ownCommander ? '<span class="tag ok">In your collection</span>' : '<span class="tag">Commander not owned</span>'}</span>
      ${pct != null ? `<span class="d">You own <b>${x.cov.owned}</b> of its ${x.cov.considered} most-played cards</span>
        <div class="strength" title="${pct}% match (weighted by how often each card is played)"><div style="width:${pct}%"></div></div>` : '<span class="d">Not in the popular list; EDHREC data loads when you pick it.</span>'}
      ${x.decks ? `<span class="d">${x.decks.toLocaleString()} decks on EDHREC</span>` : ''}
    </span>
  </button>`;
}

async function loadBase() {
  if (v.edhFor === v.commander) return v.edh;
  const edh = await safe(commanderPage(v.commander, { slug: v.slug }));
  v.edh = edh; v.edhFor = v.commander;
  return edh;
}

function renderTheme(root) {
  const el = root.querySelector('#step-theme');
  el.innerHTML = `${stepTitle(2, 'Strategy', 'Builds that EDHREC players make with this commander')}
    <div class="chips" id="themes"><span><span class="spinner"></span> Loading EDHREC data…</span></div>`;
  loadBase().then((edh) => {
    const box = el.querySelector('#themes');
    if (!box) return;
    if (!edh) { box.innerHTML = '<p class="muted small">EDHREC has no data for this commander (or couldn\'t be reached). The deck will use built-in card evaluation.</p>'; return; }
    box.innerHTML = [
      `<button class="chip" data-theme="" aria-pressed="${!v.theme}">Most popular build</button>`,
      ...edh.themes.slice(0, 18).map((t) => `<button class="chip" data-theme="${esc(t.slug)}" data-label="${esc(t.label)}" aria-pressed="${v.theme === t.slug}">${esc(t.label)} <span class="count">${t.count.toLocaleString()}</span></button>`),
    ].join('') + `<p class="small muted" style="width:100%;margin-top:8px">Numbers are how many EDHREC decks use that strategy. <a href="${edhrecUrl(edh.slug)}" target="_blank" rel="noopener">${esc(v.commander)} on EDHREC ↗</a></p>`;
  });
  el.querySelector('#themes').addEventListener('click', (e) => {
    const b = e.target.closest('[data-theme]'); if (!b) return;
    v.theme = b.dataset.theme || null; v.themeLabel = b.dataset.label || null; v.name = '';
    el.querySelectorAll('[data-theme]').forEach((x) => x.setAttribute('aria-pressed', x === b));
    renderGo(root);
  });
}

function renderBracket(root) {
  const el = root.querySelector('#step-bracket');
  el.innerHTML = `${stepTitle(3, 'Power bracket', 'Sets how many Game Changers and which combos are allowed')}
    <div class="picks">${BRACKETS.map((b) => `
      <button type="button" class="pick" data-bracket="${b.n}" aria-pressed="${v.bracket === b.n}">
        <span class="t">${b.n}. ${esc(b.label)}</span><span class="d">${esc(b.blurb)}</span>
      </button>`).join('')}</div>`;
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-bracket]'); if (!b) return;
    v.bracket = Number(b.dataset.bracket);
    el.querySelectorAll('[data-bracket]').forEach((x) => x.setAttribute('aria-pressed', x === b));
    renderGo(root);
  });
}

function defaultName() {
  return `${v.commander.split(' // ')[0].split(',')[0]}${v.themeLabel ? ` ${v.themeLabel}` : ''}`;
}

function renderGo(root) {
  const el = root.querySelector('#step-go');
  const owned = (freeByKey().get(nameKey(v.commander)) || 0) > 0;
  el.innerHTML = `${stepTitle(4, 'Build it')}
    <div class="row">
      <input type="text" id="deck-name" value="${esc(v.name || defaultName())}" aria-label="Deck name" style="flex:1 1 260px">
      <button class="btn primary" id="go">Build deck</button>
    </div>
    <p class="small muted" style="margin-top:8px">
      ${esc(v.commander)} · ${v.themeLabel ? esc(v.themeLabel) : 'most popular build'} · bracket ${v.bracket}.
      ${owned ? '' : '<b>You don\'t own this commander</b>, so you\'d need to get a copy.'}
      Basic lands are added automatically; everything else comes from your free cards.
    </p>
    <div id="build-error"></div>`;
  el.querySelector('#deck-name').addEventListener('input', (e) => { v.name = e.target.value; });
  el.querySelector('#go').addEventListener('click', async (e) => {
    const btn = e.target;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Building…';
    try {
      const res = await buildFor({ commanderName: v.commander, slug: v.slug, theme: v.theme, themeLabel: v.themeLabel, bracket: v.bracket });
      const deck = {
        id: newDeckId(),
        name: (el.querySelector('#deck-name').value || defaultName()).trim(),
        format: 'commander',
        colors: res.commander.color_identity,
        commander: res.commander.name,
        edhSlug: v.slug,
        theme: v.theme,
        themeLabel: v.themeLabel,
        bracket: v.bracket,
        cards: res.cards,
        reasons: res.reasons,
        combos: res.combos,
        notes: res.notes,
        numDecks: res.ctx.edh?.numDecks || 0,
        created: Date.now(),
      };
      await saveDeck(deck);
      toast('Deck built: see the Game plan tab for how to play it');
      Object.assign(v, { commander: null, theme: null, themeLabel: null, name: '', edh: null, edhFor: null });
      location.hash = `#/deck/${deck.id}`;
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Build deck';
      el.querySelector('#build-error').innerHTML = `<div class="notice warn" style="margin-top:8px">${esc(err.message || err)}</div>`;
    }
  });
}

export { lookup };
