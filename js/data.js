// Loads the weekly data files (data/*.json) built by scripts/update-data.mjs,
// and matches Commander Spellbook combos and EDHREC commanders against a collection.

import { nameKey, colorMask } from './cards.js';

const cache = {};
async function load(file, fetchImpl = fetch) {
  if (!cache[file]) {
    cache[file] = fetchImpl(new URL(`../data/${file}`, import.meta.url)).then((r) => {
      if (!r.ok) throw new Error(`Could not load ${file} (${r.status})`);
      return r.json();
    }).catch((e) => { delete cache[file]; throw e; });
  }
  return cache[file];
}

/** For tests: inject already-parsed data. */
export function setData(file, json) { cache[file] = Promise.resolve(json); }

// ---------- combos ----------

let comboIndex = null;
/**
 * Combos as objects: { id, cards: [names], keys: [nameKeys], produces: [string], identity, mask,
 *   popularity, minBracket, mustBeCommander: [nameKeys], requires: [string], mv }
 */
export async function combos() {
  if (comboIndex) return comboIndex;
  const d = await load('combos.json');
  const list = d.combos.map(([id, cards, produces, identity, popularity, minBracket, cmd, requires, mv]) => {
    const names = cards.map((i) => d.names[i]);
    return {
      id,
      cards: names,
      keys: names.map(nameKey),
      produces: produces.map((i) => d.features[i]),
      identity,
      mask: colorMask(identity.split('')),
      popularity,
      minBracket,
      mustBeCommander: cmd.map((i) => nameKey(d.names[i])),
      requires: requires.map((i) => d.templates[i]),
      mv,
    };
  });
  const byCard = new Map();
  list.forEach((c, i) => { for (const k of c.keys) { if (!byCard.has(k)) byCard.set(k, []); byCard.get(k).push(i); } });
  comboIndex = { updated: d.updated, list, byCard };
  return comboIndex;
}

/**
 * Combos you can make, and ones a single card away.
 * have: Set of nameKeys you have available. opts: { mask (colour identity limit), bracket, commanderKey }
 * Returns { complete: [combo], oneAway: [{ combo, missing: nameKey, missingName }] }
 */
export function matchCombos(index, have, { mask = 31, bracket = 5, commanderKey = null, includeTemplated = true } = {}) {
  const complete = [];
  const oneAway = [];
  const seen = new Set();
  // Only combos that use at least one card you have can be complete or one away.
  for (const k of have) {
    for (const i of index.byCard.get(k) || []) {
      if (seen.has(i)) continue;
      seen.add(i);
      const c = index.list[i];
      if ((c.mask & ~mask) !== 0 || c.minBracket > bracket) continue;
      if (!includeTemplated && c.requires.length) continue;
      if (c.mustBeCommander.length && commanderKey !== undefined && commanderKey !== null && !c.mustBeCommander.includes(commanderKey)) continue;
      const missing = c.keys.filter((x) => !have.has(x));
      if (!missing.length) complete.push(c);
      else if (missing.length === 1) oneAway.push({ combo: c, missing: missing[0], missingName: c.cards[c.keys.indexOf(missing[0])] });
    }
  }
  const byPop = (a, b) => (b.combo || b).popularity - (a.combo || a).popularity;
  return { complete: complete.sort(byPop), oneAway: oneAway.sort(byPop) };
}

export function comboUrl(c) { return `https://commanderspellbook.com/combo/${c.id}/`; }

// ---------- commanders ----------

let cmdIndex = null;
export async function popularCommanders() {
  if (cmdIndex) return cmdIndex;
  const d = await load('commanders.json');
  cmdIndex = {
    updated: d.updated,
    list: d.commanders.map((c, rank) => ({
      name: c.n,
      key: nameKey(c.n),
      slug: c.s,
      decks: c.d,
      rank: rank + 1,
      colors: c.ci.split('').filter(Boolean),
      img: c.img,
      themes: c.th.map(([slug, label, count]) => ({ slug, label, count })),
      cards: c.c.map(([i, incl, syn]) => ({ name: d.names[i], key: nameKey(d.names[i]), incl: incl / 100, syn: syn / 100 })),
    })),
  };
  return cmdIndex;
}

export async function gameChangers() {
  try {
    const d = await load('meta.json');
    return new Set(d.gameChangers.map(nameKey));
  } catch {
    return new Set();
  }
}

const BASICS = new Set(['plains', 'island', 'swamp', 'mountain', 'forest', 'wastes', 'snow-covered plains', 'snow-covered island', 'snow-covered swamp', 'snow-covered mountain', 'snow-covered forest']);

/**
 * How much of a commander's typical deck you already have.
 * free: Map(nameKey -> copies available). Uses the commander's most-played cards (EDHREC).
 * Returns { owned, considered, pct, ownCommander, topOwned: [names] }
 */
export function coverage(cmd, free) {
  const cards = cmd.cards.filter((c) => !BASICS.has(c.key) && c.key !== cmd.key).slice(0, 100);
  let w = 0; let got = 0; let owned = 0;
  const topOwned = [];
  for (const c of cards) {
    const weight = 0.25 + c.incl;
    w += weight;
    if ((free.get(c.key) || 0) > 0) { got += weight; owned++; if (topOwned.length < 6) topOwned.push(c.name); }
  }
  return { owned, considered: cards.length, pct: w ? got / w : 0, ownCommander: (free.get(cmd.key) || 0) > 0, topOwned };
}
