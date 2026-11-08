import { pool, lookup, ensureCards, saveDeck, newDeckId, collectionTotals } from '../store.js';
import { suggestUpgrades } from '../builder.js';
import { textToImportRows } from '../csv.js';
import { canBeCommander, edhrecSlug } from '../cards.js';
import { BRACKETS, edhrecUrl } from '../edhrec.js';
import { loadContext } from '../engine.js';
import { esc, toast, cardImageURL } from '../ui.js';
import { showCard } from './card-modal.js';

const v = { text: '', commander: '', bracket: 3, result: null, error: null, busy: false };

export function render(root) {
  root.innerHTML = `
    <h1>Upgrade a deck or precon</h1>
    <p class="muted">Paste a Commander decklist (a precon or a deck you already play). We compare it with what EDHREC players run for that commander and suggest swaps using free cards from your collection.</p>
    <section class="panel stack">
      <textarea class="paste" id="list" placeholder="Commander&#10;1 Atraxa, Praetors' Voice&#10;&#10;Deck&#10;1 Sol Ring&#10;1 Arcane Signet&#10;…">${esc(v.text)}</textarea>
      <div class="row">
        <label class="small">Commander <input type="text" id="cmd" value="${esc(v.commander)}" placeholder="Detected from the list" style="width:260px"></label>
        <label class="small">Bracket <select id="bracket">${BRACKETS.map((b) => `<option value="${b.n}" ${b.n === v.bracket ? 'selected' : ''}>${b.n}. ${esc(b.label)}</option>`).join('')}</select></label>
        <button class="btn primary" id="go" ${v.busy ? 'disabled' : ''}>${v.busy ? '<span class="spinner"></span> Analyzing…' : 'Find upgrades'}</button>
      </div>
      <p class="small muted">Tip: precon lists are on EDHREC's precon pages and the MTG wiki. Export format from Moxfield/Archidekt works as is.${collectionTotals().total ? '' : ' <b>Import your collection first</b> so there are cards to suggest.'}</p>
      ${v.error ? `<div class="notice warn">${esc(v.error)}</div>` : ''}
    </section>
    <div id="result"></div>`;
  root.querySelector('#list').addEventListener('input', (e) => { v.text = e.target.value; });
  root.querySelector('#cmd').addEventListener('input', (e) => { v.commander = e.target.value; });
  root.querySelector('#bracket').addEventListener('change', (e) => { v.bracket = Number(e.target.value); });
  root.querySelector('#go').addEventListener('click', () => analyze(root));
  if (v.result) renderResult(root);
}

async function analyze(root) {
  v.error = null; v.result = null; v.busy = true;
  render(root);
  try {
    const { rows } = textToImportRows(v.text);
    if (!rows.length) throw new Error('Paste a decklist first: one card per line, like "1 Sol Ring".');
    const main = rows.filter((r) => r.section !== 'side');
    const names = main.map((r) => r.label);
    const cards = await ensureCards(v.commander ? [...names, v.commander] : names);
    let cmdName = v.commander.trim() || main.find((r) => r.section === 'commander')?.label;
    if (!cmdName) {
      const legends = names.filter((n) => cards.get(n) && canBeCommander(cards.get(n)));
      if (legends.length === 1) cmdName = legends[0];
      else throw new Error(`Which card is the commander? Type it in the Commander box${legends.length ? ` (maybe ${legends.slice(0, 4).join(', ')})` : ''}, or put it under a "Commander" line.`);
    }
    const commander = cards.get(cmdName) || lookup(cmdName);
    if (!commander) throw new Error(`Couldn't find "${cmdName}" on Scryfall.`);
    v.commander = commander.name;
    const deckCards = {};
    for (const r of main) {
      const card = cards.get(r.label);
      const n = card ? card.name : r.label;
      if (card && card.name === commander.name) continue;
      deckCards[n] = (deckCards[n] || 0) + r.qty;
    }
    const ctx = await loadContext({ commanderName: commander.name, slug: edhrecSlug(commander.name), bracket: v.bracket });
    if (!ctx.edh) throw new Error(`EDHREC has no data for ${commander.name} (or couldn't be reached), so there's nothing to compare against.`);
    const up = suggestUpgrades({ deckCards, commander, pool: pool(), edh: ctx.edh, bracket: v.bracket, gameChangers: ctx.gc, lookupDeck: lookup, max: 20 });
    const missing = names.filter((n) => !cards.get(n));
    v.result = { commander, deckCards, up, edh: ctx.edh, missing, chosen: new Set(up.swaps.map((_, i) => i)) };
  } catch (e) {
    v.error = e.message || String(e);
  }
  v.busy = false;
  render(root);
}

const pct = (x) => (x ? `${Math.round(x.incl * 100)}%` : '—');

function renderResult(root) {
  const r = v.result;
  const el = root.querySelector('#result');
  const total = Object.values(r.deckCards).reduce((a, b) => a + b, 0) + 1;
  el.innerHTML = `
    <section class="panel" style="margin-top:16px">
      <div class="row spread">
        <h2 style="margin:0">${esc(r.commander.name)} · ${total} cards</h2>
        <a class="small" href="${edhrecUrl(r.edh.slug)}" target="_blank" rel="noopener">EDHREC page ↗</a>
      </div>
      ${r.missing.length ? `<p class="small muted">Couldn't identify: ${esc(r.missing.join(', '))}</p>` : ''}
      ${r.up.swaps.length ? `
        <p class="small muted">Each swap replaces a card that few ${esc(r.commander.name)} decks play with a free card from your collection that many do. Untick any you don't want.</p>
        <div id="swaps">${r.up.swaps.map((s, i) => `
          <label class="swap">
            <input type="checkbox" data-i="${i}" ${r.chosen.has(i) ? 'checked' : ''}>
            <span class="row" style="gap:8px"><img src="${esc(lookup(s.out.name)?.img_small || cardImageURL(s.out.name))}" alt="" data-card="${esc(s.out.name)}"><span><b>Cut</b> ${esc(s.out.name)}<br><span class="small muted">in ${pct(s.out.edh)} of decks</span></span></span>
            <span class="arrow">→</span>
            <span class="row" style="gap:8px"><img src="${esc(s.in.entry.card.img_small || cardImageURL(s.in.entry.name))}" alt="" data-card="${esc(s.in.entry.name)}"><span><b>Add</b> ${esc(s.in.entry.name)}<br><span class="small muted">in ${pct(s.in.edh)} of decks${s.in.edh.syn >= 0.05 ? `, +${Math.round(s.in.edh.syn * 100)}% synergy` : ''}</span></span></span>
          </label>`).join('')}</div>
        <div class="row" style="margin-top:12px"><input type="text" id="up-name" value="${esc(`${r.commander.name.split(',')[0]} (upgraded)`)}" style="flex:1 1 240px"><button class="btn primary" id="save">Save upgraded deck</button></div>
        <p class="small muted">The saved deck marks the cards from your pasted list as your own deck's cards, so only the added cards are taken from your bulk.</p>`
        : '<p>No upgrades found: none of your free cards are more popular for this commander than what\'s already in the deck. Nice deck!</p>'}
    </section>`;
  el.onclick = (e) => {
    const c = e.target.closest('[data-card]');
    if (c) { e.preventDefault(); showCard(c.dataset.card); }
  };
  el.querySelectorAll('[data-i]').forEach((cb) => cb.addEventListener('change', () => {
    const i = Number(cb.dataset.i);
    if (cb.checked) r.chosen.add(i); else r.chosen.delete(i);
  }));
  el.querySelector('#save')?.addEventListener('click', async () => {
    const cards = { ...r.deckCards };
    const external = { ...r.deckCards, [r.commander.name]: 1 };
    for (const i of r.chosen) {
      const s = r.up.swaps[i];
      cards[s.out.name] -= 1;
      if (cards[s.out.name] <= 0) delete cards[s.out.name];
      cards[s.in.entry.name] = (cards[s.in.entry.name] || 0) + 1;
    }
    const deck = {
      id: newDeckId(),
      name: el.querySelector('#up-name').value.trim() || `${r.commander.name} (upgraded)`,
      format: 'commander',
      colors: r.commander.color_identity,
      commander: r.commander.name,
      edhSlug: r.edh.slug,
      bracket: v.bracket,
      cards,
      external,
      numDecks: r.edh.numDecks,
      notes: [`Upgraded from a pasted list with ${r.chosen.size} swap${r.chosen.size === 1 ? '' : 's'} from your collection.`],
      created: Date.now(),
    };
    await saveDeck(deck);
    toast('Upgraded deck saved');
    v.result = null; v.text = '';
    location.hash = `#/deck/${deck.id}`;
  });
}
