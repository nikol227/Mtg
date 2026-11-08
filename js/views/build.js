import { state, pool, saveDeck, newDeckId, collectionTotals, freeByKey, lookup } from '../store.js';
import { ownedCommanders, info, eligibleSpellCounter, thinness, SPELL_SLOTS } from '../builder.js';
import { popularCommanders, coverage } from '../data.js';
import { commanderPage, BRACKETS, edhrecUrl } from '../edhrec.js';
import { buildFor, safe, previewFor, DEFAULT_SETTINGS } from '../engine.js';
import { showCard } from './card-modal.js';
import { nameKey, edhrecSlug } from '../cards.js';
import { esc, pipsHTML, toast, debounce } from '../ui.js';

const v = { tab: 'best', query: '', commander: null, slug: null, theme: null, themeLabel: null, bracket: 3, name: '', edh: null, edhFor: null, shown: 24, settings: { ...DEFAULT_SETTINGS }, settingsOpen: false };
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
    if (x) { x.cov.ownCommander = true; x.card = e.card; x.img = e.card.img_small || x.img; continue; }
    out.set(k, { name: e.name, slug: edhrecSlug(e.name), colors: e.card.color_identity, img: e.card.img_small || e.card.img, card: e.card, decks: 0, rank: null, themes: [], cov: { owned: 0, considered: 0, pct: null, ownCommander: true, topOwned: [] } });
  }
  const list = [...out.values()];
  const spellsFor = eligibleSpellCounter(pool());
  for (const x of list) {
    x.spells = spellsFor(x.colors, x.name);
    x.thin = thinness(x.spells);
    // How much of the typical deck you own, how full a deck your pile can make at all,
    // owning the commander, and a small nudge for popular commanders (better data).
    x.score = (x.cov.pct ?? 0.1) * 60 + (Math.min(x.spells, SPELL_SLOTS) / SPELL_SLOTS) * 40
      + (x.cov.ownCommander ? 12 : 0) + Math.min(5, Math.log10(1 + x.decks));
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
    <div class="picks" id="cmds"><span><span class="spinner"></span> Comparing your collection with 900 popular commanders…</span></div>
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
      <span class="d"><b>${x.spells}</b> eligible spell${x.spells === 1 ? '' : 's'} <span class="muted">of ${SPELL_SLOTS} needed</span></span>
      ${thinHTML(x)}
      ${pct != null ? `<span class="d">You own <b>${x.cov.owned}</b> of its ${x.cov.considered} most-played cards</span>
        <div class="strength" title="${pct}% match (weighted by how often each card is played)"><div style="width:${pct}%"></div></div>` : ''}
      ${x.decks ? `<span class="d">${x.decks.toLocaleString()} decks on EDHREC</span>` : '<span class="d muted">Not in the popular list; EDHREC data loads when you pick it.</span>'}
    </span>
  </button>`;
}

const colorLabel = (colors) => (colors.length ? colors.join('') : 'colorless');

/** Warning chip when the pile can't fill the 63 non-land slots. */
function thinHTML(x) {
  if (x.thin.level === 'ok') return '<span class="d"><span class="tag ok">✓ Enough for a full deck</span></span>';
  const cls = x.thin.level === 'thin' ? 'warn-chip' : 'tag';
  const lead = x.thin.level === 'thin' ? 'Likely too thin to build: ' : '';
  return `<span class="d"><span class="${cls}" title="Missing slots are filled with EDHREC recommendations to buy">⚠ ${lead}needs ~${x.thin.needed} more ${colorLabel(x.colors)} spells</span></span>`;
}

/** Before building: say how many of the 63 spell slots your pile can fill. */
function buildWarning() {
  const x = rankCache.list?.find((c) => c.name === v.commander);
  if (!x || x.thin.level === 'ok') return '';
  return `<div class="notice warn" style="margin-top:8px">⚠ Your collection has <b>${x.spells}</b> eligible ${colorLabel(x.colors)} spells for this commander, and a deck needs ${SPELL_SLOTS}.
    ${v.settings.fillWith === 'basics' ? `The other ~${x.thin.needed} slots will be filled with basic lands (you chose "only cards I own" in the build settings).` : `About <b>${x.thin.needed}</b> slots will be filled with EDHREC's recommended cards that you'd need to buy (cheaper ones first${v.settings.maxPrice != null ? `, at most $${v.settings.maxPrice} each` : ''}). They'll be marked “Buy” in the deck.`}</div>`;
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
    refreshFit(root);
  });
}

function renderBracket(root) {
  const el = root.querySelector('#step-bracket');
  el.innerHTML = `${stepTitle(3, 'Power bracket', 'Sets how many Game Changers and which combos are allowed')}
    <div class="picks">${BRACKETS.map((b) => `
      <button type="button" class="pick" data-bracket="${b.n}" aria-pressed="${v.bracket === b.n}">
        <span class="t">${b.n}. ${esc(b.label)} <span class="bracket-warn hidden" data-warn="${b.n}" aria-label="Your collection may not reach this bracket">!</span></span>
        <span class="d">${esc(b.blurb)}</span>
        <span class="d warn-text hidden" data-warn-text="${b.n}"></span>
      </button>`).join('')}</div>
    <div id="fit" class="fit"></div>
    <details class="settings" id="settings" ${v.settingsOpen ? 'open' : ''}>
      <summary><b>Optional build settings</b></summary>
      <div class="settings-grid">
        <label>When your cards run out, fill the gaps with
          <select id="set-fill">
            <option value="buy" ${v.settings.fillWith === 'buy' ? 'selected' : ''}>Recommended cards to buy</option>
            <option value="basics" ${v.settings.fillWith === 'basics' ? 'selected' : ''}>Basic lands (only cards I own)</option>
          </select>
        </label>
        <label>Most I'd pay per card to buy
          <select id="set-price" ${v.settings.fillWith === 'basics' ? 'disabled' : ''}>
            ${[[null, 'No limit'], [5, '$5'], [2, '$2'], [1, '$1'], [0.5, '$0.50'], [0.25, '$0.25']].map(([p, l]) => `<option value="${p ?? ''}" ${v.settings.maxPrice === p ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
        </label>
        <label>Number of lands
          <select id="set-lands">${[33, 34, 35, 36, 37, 38].map((n) => `<option ${v.settings.lands === n ? 'selected' : ''}>${n}</option>`).join('')}</select>
        </label>
      </div>
    </details>`;
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-bracket]'); if (!b) return;
    v.bracket = Number(b.dataset.bracket);
    el.querySelectorAll('[data-bracket]').forEach((x) => x.setAttribute('aria-pressed', x === b));
    renderGo(root);
    refreshFit(root);
  });
  el.querySelector('#settings').addEventListener('toggle', (e) => { v.settingsOpen = e.target.open; });
  el.querySelector('#set-fill').addEventListener('change', (e) => {
    v.settings.fillWith = e.target.value;
    el.querySelector('#set-price').disabled = v.settings.fillWith === 'basics';
    renderGo(root);
  });
  el.querySelector('#set-price').addEventListener('change', (e) => { v.settings.maxPrice = e.target.value === '' ? null : Number(e.target.value); renderGo(root); });
  el.querySelector('#set-lands').addEventListener('change', (e) => { v.settings.lands = Number(e.target.value); });
  refreshFit(root);
}

let fitSeq = 0;
/** Summary + best cards from your bulk for the chosen commander/strategy/bracket, and bracket warnings. */
async function refreshFit(root) {
  const el = root.querySelector('#fit');
  if (!el || !v.commander) return;
  const seq = ++fitSeq;
  el.innerHTML = '<p class="small muted"><span class="spinner"></span> Checking your collection for this build…</p>';
  const p = await safe(previewFor({ commanderName: v.commander, slug: v.slug, theme: v.theme, bracket: v.bracket }));
  if (seq !== fitSeq || !root.querySelector('#fit')) return;
  if (!p) { el.innerHTML = ''; return; }
  for (const [n, b] of Object.entries(p.brackets)) {
    root.querySelector(`[data-warn="${n}"]`)?.classList.toggle('hidden', !b.warn);
    const t = root.querySelector(`[data-warn-text="${n}"]`);
    if (t) { t.textContent = b.warn ? `⚠ ${b.reason}` : ''; t.classList.toggle('hidden', !b.warn); }
  }
  const bracket = BRACKETS.find((b) => b.n === v.bracket);
  const what = v.themeLabel ? esc(v.themeLabel) : 'general';
  el.innerHTML = p.edh ? `
    <h3 class="fit-title">Your collection has <em>${p.strength.level}</em> ${esc(bracket.label.toLowerCase())} (bracket ${bracket.n}) ${what} support.</h3>
    <p class="small muted">You own ${p.strength.owned} of the ${p.strength.considered} cards played most in ${esc(v.commander)} ${what === 'general' ? '' : `${what} `}decks at this level on EDHREC.
      ${p.gameChangers ? `${p.gameChangers} Game Changer${p.gameChangers === 1 ? '' : 's'} available.` : ''}</p>
    ${p.fits.length ? `<div class="fit-label">Strong fits from your bulk</div>
    <div class="fit-cards">${p.fits.map((f) => `<figure data-card="${esc(f.name)}">
      ${f.card.img_small ? `<img src="${esc(f.card.img)}" alt="${esc(f.name)}" loading="lazy">` : `<div class="img-ph">${esc(f.name)}</div>`}
      <figcaption>${esc(f.name)}<br><span class="muted">in ${Math.round(f.incl * 100)}% of decks${f.syn >= 0.05 ? ` · +${Math.round(f.syn * 100)}% synergy` : ''}</span></figcaption>
    </figure>`).join('')}</div>` : '<p class="small muted">None of your free cards appear on EDHREC\'s list for this build yet.</p>'}`
    : '<p class="small muted">EDHREC has no data for this commander, so there\'s no preview. The builder will use its own card evaluation.</p>';
  el.onclick = (e) => { const c = e.target.closest('[data-card]'); if (c) showCard(c.dataset.card); };
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
    ${buildWarning()}
    <div id="build-error"></div>`;
  el.querySelector('#deck-name').addEventListener('input', (e) => { v.name = e.target.value; });
  el.querySelector('#go').addEventListener('click', async (e) => {
    const btn = e.target;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Building…';
    try {
      const res = await buildFor({ commanderName: v.commander, slug: v.slug, theme: v.theme, themeLabel: v.themeLabel, bracket: v.bracket, settings: v.settings });
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
        toBuy: res.toBuy || {},
        settings: { ...v.settings },
        reasons: res.reasons,
        combos: res.combos,
        notes: res.notes,
        numDecks: res.ctx.edh?.numDecks || 0,
        edhVariantLabel: res.ctx.edh?.variantLabel || null,
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
