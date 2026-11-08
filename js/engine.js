// Glue between the data sources (EDHREC, Spellbook files, Scryfall) and the deck builder.

import { commanderPage } from './edhrec.js';
import { combos, gameChangers } from './data.js';
import { pool, lookup, ensureCards } from './store.js';
import { buildDeck } from './builder.js';
import { edhrecSlug } from './cards.js';

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
  const res = buildDeck({
    pool: pool(excludeDeckId), commander, edh: ctx.edh, bracket, gameChangers: ctx.gc, comboIndex: ctx.comboIndex, locked, theme, themeLabel,
  });
  return { ...res, ctx, commander };
}
