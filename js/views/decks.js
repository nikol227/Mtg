import { state, lookup, availabilityFn } from '../store.js';
import { FORMATS, deckSize, validateDeck, deckColors } from '../builder.js';
import { esc, pipsHTML } from '../ui.js';

export function render(root) {
  const decks = [...state.decks.values()].sort((a, b) => (b.updated || 0) - (a.updated || 0));
  if (!decks.length) {
    root.innerHTML = `<div class="empty"><h1>No decks yet</h1><p class="muted">Build your first deck from your bulk.</p><a class="btn primary" href="#/build">Build a deck</a></div>`;
    return;
  }
  root.innerHTML = `
    <div class="row spread" style="margin-bottom:14px"><h1 style="margin:0">My decks</h1><a class="btn primary" href="#/build">+ New deck</a></div>
    <div class="deck-tiles">${decks.map(tile).join('')}</div>`;
}

function tile(d) {
  const fmt = FORMATS[d.format];
  const size = deckSize(d);
  const issues = validateDeck(d, lookup, availabilityFn(d.id));
  const errors = issues.filter((i) => i.level === 'error').length;
  const short = issues.filter((i) => i.short).length;
  const coverName = d.commander || Object.keys(d.cards).map((n) => lookup(n)).filter((c) => c && c.img && !/Land/.test(c.front_type)).sort((a, b) => (a.edhrec_rank || 1e9) - (b.edhrec_rank || 1e9))[0]?.name;
  const cover = coverName ? lookup(coverName) : null;
  const status = errors ? `<span class="issue-error small">${errors} problem${errors > 1 ? 's' : ''}</span>`
    : short ? `<span class="issue-warn small">${short} card${short > 1 ? 's' : ''} short</span>`
      : size >= fmt.size ? '<span class="issue-ok small">Ready to play</span>' : `<span class="issue-warn small">${size}/${fmt.size} cards</span>`;
  return `<a class="panel deck-tile" href="#/deck/${d.id}">
    ${cover?.img ? `<img class="cover" src="${esc(cover.img_small || cover.img)}" alt="" loading="lazy">` : '<div class="cover"></div>'}
    <div class="stack" style="min-width:0">
      <div><b>${esc(d.name)}</b></div>
      <div class="small muted">${esc(fmt.label)} · ${size} cards</div>
      <div>${pipsHTML(deckColors(d, lookup))}</div>
      <div>${status}</div>
    </div>
  </a>`;
}
