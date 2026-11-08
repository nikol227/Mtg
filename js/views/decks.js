import { state, lookup, availabilityFn } from '../store.js';
import { deckSize, validateDeck, deckColors } from '../builder.js';
import { BRACKETS } from '../edhrec.js';
import { esc, pipsHTML } from '../ui.js';

export function render(root) {
  const decks = [...state.decks.values()].sort((a, b) => (b.updated || 0) - (a.updated || 0));
  if (!decks.length) {
    root.innerHTML = `<div class="empty"><h1>No decks yet</h1><p class="muted">Build your first Commander deck from your bulk, or upgrade a deck you already have.</p>
      <div class="row" style="justify-content:center"><a class="btn primary" href="#/build">Build a deck</a><a class="btn" href="#/upgrade">Upgrade a deck</a></div></div>`;
    return;
  }
  root.innerHTML = `
    <div class="row spread" style="margin-bottom:14px"><h1 style="margin:0">My decks</h1><a class="btn primary" href="#/build">+ New deck</a></div>
    <div class="deck-tiles">${decks.map(tile).join('')}</div>`;
}

function tile(d) {
  if (d.format !== 'commander') {
    return `<a class="panel deck-tile" href="#/deck/${d.id}"><div class="cover"></div><div class="stack"><b>${esc(d.name)}</b><span class="small muted">Older 60-card deck (no longer supported)</span></div></a>`;
  }
  const size = deckSize(d);
  const issues = validateDeck(d, lookup, availabilityFn(d.id));
  const errors = issues.filter((i) => i.level === 'error').length;
  const short = issues.filter((i) => i.short).length;
  const cover = d.commander ? lookup(d.commander) : null;
  const status = errors ? `<span class="issue-error small">${errors} problem${errors > 1 ? 's' : ''}</span>`
    : short ? `<span class="issue-warn small">${short} card${short > 1 ? 's' : ''} not free</span>`
      : size === 100 ? '<span class="issue-ok small">Ready to play</span>' : `<span class="issue-warn small">${size}/100 cards</span>`;
  const bracket = BRACKETS.find((b) => b.n === (d.bracket || 3));
  return `<a class="panel deck-tile" href="#/deck/${d.id}">
    ${cover?.img ? `<img class="cover" src="${esc(cover.img_small || cover.img)}" alt="" loading="lazy">` : '<div class="cover"></div>'}
    <div class="stack" style="min-width:0">
      <div><b>${esc(d.name)}</b></div>
      <div class="small muted">${esc(d.commander || '')}${d.themeLabel ? ` · ${esc(d.themeLabel)}` : ''}</div>
      <div>${pipsHTML(deckColors(d, lookup))} <span class="small muted">Bracket ${bracket.n} · ${esc(bracket.label)}</span></div>
      <div>${status}</div>
    </div>
  </a>`;
}
