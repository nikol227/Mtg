import { state, lookup, usage, adjustOwned, ensureCards } from '../store.js';
import { esc, manaHTML, openModal } from '../ui.js';
import { info } from '../builder.js';

/** Show one card: image (flip for double-faced), text, ownership and which decks use it. */
export function showCard(name, { deck = null, onDeckChange = null, why = null } = {}) {
  const card = lookup(name);
  if (!card) {
    // A card you don't own (e.g. a combo piece): fetch its data once, then show it.
    ensureCards([name]).then((m) => { if (m.get(name)) showCard(name, { deck, onDeckChange, why }); }).catch(() => {});
    return;
  }
  const render = () => {
    const owned = state.byName.get(name)?.owned || 0;
    const usedBy = [...state.decks.values()].filter((d) => d.cards[name] || d.commander === name);
    const used = usage().get(name) || 0;
    const basic = info(card).basic;
    const inDeck = deck ? (deck.cards[name] || 0) : 0;
    return `
      <div class="card-detail">
        <div>
          ${card.img ? `<img id="cd-img" src="${esc(card.img)}" alt="${esc(card.name)}">` : ''}
          ${card.img_back ? '<button class="btn small" id="cd-flip" style="margin-top:8px;width:100%">Flip card</button>' : ''}
        </div>
        <div class="stack">
          <div class="row spread"><h2 style="margin:0">${esc(card.name)}</h2><button class="btn ghost small" data-close>Close</button></div>
          <div>${manaHTML(card.mana_cost)} <span class="muted">${esc(card.type_line)}</span></div>
          ${why && deck && (deck.cards[name] || deck.commander === name) ? `<div class="notice"><b>Why it's here:</b> ${esc(why)}</div>` : ''}
          ${card.oracle_text ? `<div class="oracle">${esc(card.oracle_text)}</div>` : ''}
          <div class="small muted">${esc(card.set_name || '')} ${card.set ? `(${esc(card.set.toUpperCase())} #${esc(card.cn)})` : ''} · ${esc(card.rarity || '')}${card.price ? ` · $${esc(card.price)}` : ''}</div>
          ${basic ? '<p class="small muted">Basic lands are treated as unlimited.</p>' : `
          <div class="kv">
            <span>Copies you own</span><span>${owned}</span>
            <span>Used in decks</span><span>${used}</span>
            <span>Free</span><span>${Math.max(0, owned - used)}</span>
          </div>
          <div class="row">
            <span class="small muted">Adjust owned:</span>
            <button class="btn small" id="cd-own-minus" ${owned <= 0 ? 'disabled' : ''}>− 1</button>
            <button class="btn small" id="cd-own-plus" ${owned <= 0 ? 'disabled' : ''}>+ 1</button>
          </div>`}
          ${usedBy.length ? `<div class="small"><b>In decks:</b> ${usedBy.map((d) => `<a href="#/deck/${d.id}" data-close>${esc(d.name)}</a> (${d.commander === name ? 'commander' : `×${d.cards[name]}`})`).join(', ')}</div>` : ''}
          ${deck && deck.commander !== name ? `
          <div class="row">
            <span class="small"><b>In this deck: ${inDeck}</b></span>
            <button class="btn small" id="cd-deck-minus" ${inDeck <= 0 ? 'disabled' : ''}>Remove one</button>
            ${inDeck && !info(card).anyNumber ? '' : '<button class="btn small primary" id="cd-deck-plus">Add one</button>'}
          </div>` : ''}
          <a class="small" href="https://scryfall.com/search?q=${encodeURIComponent(`!"${card.name}"`)}" target="_blank" rel="noopener">View on Scryfall ↗</a>
        </div>
      </div>`;
  };
  const mount = (body) => {
    let back = false;
    body.querySelector('#cd-flip')?.addEventListener('click', () => {
      back = !back;
      body.querySelector('#cd-img').src = back ? card.img_back : card.img;
    });
    body.querySelector('#cd-own-minus')?.addEventListener('click', async () => { await adjustOwned(name, -1); openModal(render(), mount); });
    body.querySelector('#cd-own-plus')?.addEventListener('click', async () => { await adjustOwned(name, 1); openModal(render(), mount); });
    body.querySelector('#cd-deck-minus')?.addEventListener('click', async () => { await onDeckChange?.(name, -1); openModal(render(), mount); });
    body.querySelector('#cd-deck-plus')?.addEventListener('click', async () => { await onDeckChange?.(name, 1); openModal(render(), mount); });
  };
  openModal(render(), mount);
}
