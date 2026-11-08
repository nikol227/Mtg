// Shared UI helpers: escaping, mana symbols, card tiles, modal, toast, filtering.

import { COLORS, primaryType } from './cards.js';
import { info } from './builder.js';

/** Shown in the footer and on the printable guide, to tell which version a browser is running. */
export const APP_VERSION = '2026.11.08-3';

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

/** Scryfall image for any card by name (for cards you don't own, e.g. combo pieces). */
export function cardImageURL(name, version = 'small') {
  return `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(name)}&format=image&version=${version}`;
}

/**
 * Compact decklist row: small thumbnail (hover to enlarge), card name, mana cost, type,
 * role chips, a badge and action buttons.
 */
/** "$0.42" from a Scryfall price string; '' for basics or unknown prices. */
export function priceText(card) {
  const p = Number(card?.price);
  return p ? `$${p.toFixed(2)}` : '';
}

export function thumbRowHTML(card, { count = 1, badge = '', badgeClass = '', actions = '', chips = '', combo = false, price = '' } = {}) {
  const img = card.img_small || card.img;
  return `<div class="thumb-row${combo ? ' combo-piece' : ''}" data-card="${esc(card.name)}">
    ${img ? `<img class="thumb-img" src="${esc(img)}" alt="" loading="lazy" data-preview="${esc(card.img || img)}">` : '<span class="thumb-img thumb-ph"></span>'}
    <div class="tr-main">
      <div class="tr-name">${count > 1 ? `<b>${count}×</b> ` : ''}<a href="javascript:void 0">${esc(card.name)}</a> ${badge ? `<span class="tr-badge ${badgeClass}">${badge}</span>` : ''}</div>
      <div class="tr-sub">${manaHTML(card.mana_cost)} <span class="muted">${esc(card.type_line || '')}</span> ${chips}</div>
    </div>
    ${price ? `<span class="tr-price" title="Price per card (Scryfall)">${price}</span>` : ''}
    ${actions ? `<div class="tr-actions">${actions}</div>` : ''}
  </div>`;
}

/** Hovering any card thumbnail shows a large preview next to the pointer (mouse/trackpad only). */
export function installHoverPreview() {
  if (!window.matchMedia?.('(hover: hover)').matches) return;
  const box = document.createElement('div');
  box.id = 'hover-preview';
  box.innerHTML = '<img alt="">';
  document.body.appendChild(box);
  const img = box.querySelector('img');
  const target = (el) => el?.closest?.('img[data-preview], .add-row img, .care-swap img, .thumbs img, .combo-cards img, .swap img, .fit-cards img');
  const place = (e) => {
    const w = 260; const h = 362; const pad = 16;
    let x = e.clientX + pad; let y = e.clientY - h / 2;
    if (x + w > window.innerWidth - 8) x = e.clientX - w - pad;
    y = Math.max(8, Math.min(window.innerHeight - h - 8, y));
    box.style.transform = `translate(${x}px, ${y}px)`;
  };
  document.addEventListener('mouseover', (e) => {
    const t = target(e.target);
    if (!t) return;
    const src = t.dataset.preview || (t.src || '').replace('/small/', '/normal/');
    if (!src) return;
    img.src = src;
    box.classList.add('show');
    place(e);
  });
  document.addEventListener('mousemove', (e) => { if (box.classList.contains('show')) place(e); });
  document.addEventListener('mouseout', (e) => { if (target(e.target)) box.classList.remove('show'); });
  document.addEventListener('scroll', () => box.classList.remove('show'), true);
}

export function tileHTML(card, { badge = '', badgeClass = '', count = null, actions = '', theme = false, combo = false, attrs = '' } = {}) {
  const img = card.img
    ? `<img src="${esc(card.img)}" alt="${esc(card.name)}" loading="lazy" decoding="async">`
    : `<div class="fallback"><b>${esc(card.name)}</b>${manaHTML(card.mana_cost)}<span class="muted">${esc(card.type_line)}</span></div>`;
  return `<div class="tile${theme ? ' theme' : ''}${combo ? ' combo-piece' : ''}" data-card="${esc(card.name)}" ${attrs} title="${esc(card.name)}">
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
