// Glue between the data sources (EDHREC, Spellbook files, Scryfall) and the deck builder.

import { commanderPage } from './edhrec.js';
import { combos, gameChangers } from './data.js';
import { pool, lookup, ensureCards } from './store.js';
import { buildDeck } from './builder.js';
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
export async function buildFor({ commanderName, slug, theme, themeLabel, bracket, excludeDeckId = null, locked = {} }) {
  await ensureCards([commanderName]);
  const commander = lookup(commanderName);
  if (!commander) throw new Error(`Couldn't find card data for ${commanderName}.`);
  const ctx = await loadContext({ commanderName, slug, theme, bracket: theme ? null : bracket });
  const owned = pool(excludeDeckId);
  const opts = { commander, edh: ctx.edh, bracket, gameChangers: ctx.gc, comboIndex: ctx.comboIndex, locked, theme, themeLabel };
  let res = buildDeck({ ...opts, pool: owned });
  if (res.shortfall > 0 && ctx.edh) {
    // Your collection ran out: fill the gap with EDHREC's recommendations you don't have free.
    const extra = await recommendedToBuy(ctx.edh, owned, commander, res.shortfall);
    if (extra.length) res = buildDeck({ ...opts, pool: [...owned, ...extra] });
  }
  return { ...res, ctx, commander };
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
