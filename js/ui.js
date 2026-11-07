// Shared UI helpers: escaping, mana symbols, card tiles, modal, toast, filtering.

import { COLORS, primaryType } from './cards.js';
import { info } from './builder.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function manaHTML(cost) {
  if (!cost) return '';
  return cost.split(' // ').map((part) => `<span class="mana" aria-label="${esc(part)}">${
    [...part.matchAll(/\{([^}]+)\}/g)].map((m) => `<img src="https://svgs.scryfall.io/card-symbols/${encodeURIComponent(m[1].replace(/\//g, ''))}.svg" alt="{${esc(m[1])}}" loading="lazy">`).join('')
  }</span>`).join(' // ');
}

export function pipsHTML(colors) {
  if (!colors || !colors.length) return '<span class="pip C" title="Colorless">C</span>';
  return colors.map((c) => `<span class="pip ${c}" title="${c}">${c}</span>`).join('');
}

const GUILDS = {
  W: 'Mono-White', U: 'Mono-Blue', B: 'Mono-Black', R: 'Mono-Red', G: 'Mono-Green',
  WU: 'Azorius', UB: 'Dimir', BR: 'Rakdos', RG: 'Gruul', WG: 'Selesnya', WB: 'Orzhov', UR: 'Izzet', BG: 'Golgari', WR: 'Boros', UG: 'Simic',
  WUB: 'Esper', UBR: 'Grixis', BRG: 'Jund', WRG: 'Naya', WUG: 'Bant', WBG: 'Abzan', WUR: 'Jeskai', UBG: 'Sultai', WBR: 'Mardu', URG: 'Temur',
  WUBRG: 'Five-Color',
};
export function colorName(colors) {
  const key = COLORS.filter((c) => colors.includes(c)).join('');
  if (!key) return 'Colorless';
  return GUILDS[key] || `${key.length}-Color`;
}

export function tileHTML(card, { badge = '', badgeClass = '', count = null, actions = '', theme = false, attrs = '' } = {}) {
  const img = card.img
    ? `<img src="${esc(card.img)}" alt="${esc(card.name)}" loading="lazy" decoding="async">`
    : `<div class="fallback"><b>${esc(card.name)}</b>${manaHTML(card.mana_cost)}<span class="muted">${esc(card.type_line)}</span></div>`;
  return `<div class="tile${theme ? ' theme' : ''}" data-card="${esc(card.name)}" ${attrs} title="${esc(card.name)}">
    ${img}
    ${count != null ? `<span class="count-badge">${count}</span>` : ''}
    ${badge ? `<span class="badge ${badgeClass}">${badge}</span>` : ''}
    ${actions ? `<div class="tile-actions">${actions}</div>` : ''}
  </div>`;
}

let toastTimer;
export function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

export function openModal(html, onMount) {
  const dlg = document.getElementById('modal');
  const body = document.getElementById('modal-body');
  body.innerHTML = html;
  if (!dlg.open) dlg.showModal();
  onMount?.(body);
  return body;
}
export function closeModal() { document.getElementById('modal').close(); }

document.addEventListener('click', (e) => {
  const dlg = document.getElementById('modal');
  if (e.target === dlg) dlg.close(); // click on backdrop
  if (e.target.closest('[data-close]')) dlg.close();
});

export function download(filename, text, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- card filtering shared by the collection browser and the editor ----------

export const TYPE_FILTERS = ['Creature', 'Instant', 'Sorcery', 'Artifact', 'Enchantment', 'Planeswalker', 'Land', 'Legendary'];

export function matchesFilters(card, f) {
  if (f.query) {
    const q = f.query.toLowerCase();
    if (!card.name.toLowerCase().includes(q) && !card.type_line.toLowerCase().includes(q) && !(card.oracle_text || '').toLowerCase().includes(q)) return false;
  }
  if (f.colors && f.colors.size) {
    const id = card.color_identity;
    if (!id.length) { if (!f.colors.has('C')) return false; }
    else if (!id.every((c) => f.colors.has(c))) return false;
  }
  if (f.type) {
    if (f.type === 'Legendary') { if (!/Legendary/.test(card.front_type)) return false; }
    else if (f.type === 'Land') { if (!info(card).land) return false; }
    else if (primaryType(card) !== f.type && !new RegExp(`\\b${f.type}\\b`).test(card.front_type)) return false;
  }
  if (f.rarity && card.rarity !== f.rarity) return false;
  if (f.cmc != null && f.cmc !== '') {
    const v = Number(f.cmc);
    if (v >= 7 ? card.cmc < 7 : Math.floor(card.cmc) !== v) return false;
  }
  return true;
}

export function colorChipsHTML(selected, name = 'color') {
  return [...COLORS, 'C'].map((c) => `<button type="button" class="chip" data-${name}="${c}" aria-pressed="${selected.has(c)}" title="${c === 'C' ? 'Colorless' : c}"><span class="pip ${c}">${c}</span></button>`).join('');
}

export function pagerHTML(page, pages) {
  if (pages <= 1) return '';
  return `<div class="pager">
    <button class="btn small" data-page="${page - 1}" ${page <= 0 ? 'disabled' : ''}>← Prev</button>
    <span class="muted small">Page ${page + 1} of ${pages}</span>
    <button class="btn small" data-page="${page + 1}" ${page >= pages - 1 ? 'disabled' : ''}>Next →</button>
  </div>`;
}

/** Debounce for search inputs. */
export function debounce(fn, ms = 200) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
