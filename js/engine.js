// Glue between the data sources (EDHREC, Spellbook files, Scryfall) and the deck builder.

import { commanderPage } from './edhrec.js';
import { combos, gameChangers } from './data.js';
import { pool, lookup, ensureCards } from './store.js';
import { buildDeck, fitPreview } from './builder.js';
import { edhrecSlug, nameKey, isLand } from './cards.js';

export async function safe(p) {
  try { return await p; } catch (e) { console.warn(e); return null; }
}

/** Everything the builder/editor needs about a commander, fetched in parallel. Never throws. */
export async function loadContext({ commanderName, slug = null, theme = null, bracket = null }) {
  const [edh, comboIndex, gc] = await Promise.all([
    safe(commanderPage(commanderName, { slug: slug || edhrecSlug(commanderName), theme, bracket })),
    safe(combos()),
    gameChangers(),
  ]);
  return { edh, comboIndex, gc: gc || new Set() };
}

/** Build a deck for a commander (fetching its card data first if you don't own it). */
/** Optional build settings (chosen on the Build page, saved on the deck). */
export const DEFAULT_SETTINGS = { fillWith: 'buy', maxPrice: null, lands: null }; // lands: null = EDHREC average

export async function buildFor({ commanderName, slug, theme, themeLabel, bracket, excludeDeckId = null, locked = {}, settings = {} }) {
  const opt = { ...DEFAULT_SETTINGS, ...settings };
  await ensureCards([commanderName]);
  const commander = lookup(commanderName);
  if (!commander) throw new Error(`Couldn't find card data for ${commanderName}.`);
  const ctx = await loadContext({ commanderName, slug, theme, bracket: theme ? null : bracket });
  const owned = pool(excludeDeckId);
  const opts = { commander, edh: ctx.edh, bracket, gameChangers: ctx.gc, comboIndex: ctx.comboIndex, locked, theme, themeLabel, lands: opt.lands };
  let res = buildDeck({ ...opts, pool: owned });
  if (res.shortfall > 0 && ctx.edh && opt.fillWith === 'buy') {
    // Your collection ran out: fill the gap with EDHREC's recommendations you don't have free.
    const extra = (await recommendedToBuy(ctx.edh, owned, commander, res.shortfall))
      .filter((e) => opt.maxPrice == null || (Number(e.card.price) || 0) <= opt.maxPrice);
    if (extra.length) res = buildDeck({ ...opts, pool: [...owned, ...extra] });
  }
  return { ...res, ctx, commander };
}

/**
 * Preview for the Build page: how well your free cards support this commander at a given
 * strategy or bracket, its best cards from your bulk, and which brackets your pile can reach.
 */
export async function previewFor({ commanderName, slug, theme, bracket }) {
  await safe(ensureCards([commanderName]));
  const commander = lookup(commanderName);
  if (!commander) return null;
  const ctx = await loadContext({ commanderName, slug, theme, bracket: theme ? null : bracket });
  return { ...fitPreview({ pool: pool(), commander, edh: ctx.edh, bracket, gameChangers: ctx.gc, comboIndex: ctx.comboIndex }), edh: ctx.edh, commander };
}

/**
 * EDHREC's most-played non-land cards for this commander that you don't have a free copy of,
 * as pool entries marked `buy`. Card data (and prices) come from one batched Scryfall lookup.
 */
async function recommendedToBuy(edh, owned, commander, shortfall) {
  const free = new Set(owned.filter((e) => e.available > 0).map((e) => nameKey(e.name)));
  const cmdKey = nameKey(commander.name);
  const names = [...edh.cards.values()]
    .filter((c) => !/land/i.test(c.list || '') && !free.has(nameKey(c.name)) && nameKey(c.name) !== cmdKey)
    .sort((a, b) => (b.incl + 2 * Math.max(0, b.syn)) - (a.incl + 2 * Math.max(0, a.syn)))
    .slice(0, Math.min(225, shortfall * 3 + 20))
    .map((c) => c.name);
  if (!names.length) return [];
  const found = await safe(ensureCards(names));
  if (!found) return [];
  const out = [];
  for (const n of names) {
    const card = found.get(n);
    if (card && !isLand(card)) out.push({ name: card.name, card, available: 1, owned: 0, buy: true });
  }
  return out;
}
