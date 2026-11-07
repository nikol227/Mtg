// Deck-building engine: format rules, auto-suggest (colors, themes, commanders),
// greedy deck construction with curve/role balancing, validation, stats and export.
// Pure functions (no DOM). A "pool" is [{ name, card, available }] where `available`
// already excludes copies used by *other* decks.

import {
  COLORS, BASIC_FOR_COLOR, castRequirements, canCastWith, pipCounts, colorMask, maskToColors,
  isLand, isBasic, isCreature, canBeCommander, isPlayable, anyNumberAllowed, cardRoles, quality,
  THEMES, tribeTheme, themeFromKey, commanderThemes, subtypes, primaryType,
} from './cards.js';

export const FORMATS = {
  casual: {
    key: 'casual', label: '60-card casual', blurb: 'Kitchen-table deck: 24 lands, up to 4 copies of a card.',
    size: 60, lands: 24, maxCopies: 4, decay: 0.2, legality: null, minSize: true,
    curve: { 1: 0.12, 2: 0.27, 3: 0.25, 4: 0.18, 5: 0.11, 6: 0.07 },
    creatures: [0.4, 0.62], roles: { removal: 6, draw: 2 }, maxNonbasic: 10,
  },
  limited: {
    key: 'limited', label: '40-card limited', blurb: 'Draft-style deck: 17 lands, mostly creatures.',
    size: 40, lands: 17, maxCopies: 4, decay: 0.35, legality: null, minSize: true,
    curve: { 1: 0.06, 2: 0.3, 3: 0.27, 4: 0.19, 5: 0.12, 6: 0.06 },
    creatures: [0.6, 0.78], roles: { removal: 4 }, maxNonbasic: 3,
  },
  commander: {
    key: 'commander', label: 'Commander', blurb: '100-card singleton led by a legendary creature from your pile.',
    size: 100, lands: 36, maxCopies: 1, decay: 1, legality: 'commander', singleton: true, exact: true, hasCommander: true,
    curve: { 1: 0.08, 2: 0.2, 3: 0.22, 4: 0.2, 5: 0.14, 6: 0.16 },
    creatures: [0.33, 0.6], roles: { ramp: 10, draw: 9, removal: 8, wipe: 2 }, maxNonbasic: 18,
  },
  pauper: {
    key: 'pauper', label: 'Pauper', blurb: '60 cards, commons only (Pauper-legal). 23 lands.',
    size: 60, lands: 23, maxCopies: 4, decay: 0.2, legality: 'pauper', minSize: true,
    curve: { 1: 0.14, 2: 0.3, 3: 0.25, 4: 0.16, 5: 0.1, 6: 0.05 },
    creatures: [0.38, 0.62], roles: { removal: 7, draw: 3 }, maxNonbasic: 6,
  },
};

// ---------- per-card derived info (cached) ----------

const infoCache = new WeakMap();
export function info(card) {
  let i = infoCache.get(card);
  if (!i) {
    i = {
      land: isLand(card),
      basic: isBasic(card),
      creature: isCreature(card),
      roles: cardRoles(card),
      reqs: castRequirements(card),
      identity: colorMask(card.color_identity),
      quality: quality(card),
      bucket: Math.min(6, Math.max(1, Math.round(card.cmc || 0))),
      playable: isPlayable(card),
      anyNumber: anyNumberAllowed(card),
      etbTapped: /enters (the battlefield )?tapped/i.test(card.oracle_text || '') && !/unless/i.test(card.oracle_text || ''),
      fetch: /search your library for (a|an) (basic land|land|.{0,30}(forest|plains|island|swamp|mountain))/i.test(card.oracle_text || ''),
    };
    infoCache.set(card, i);
  }
  return i;
}

function legalIn(card, format) {
  if (!format.legality) return true;
  const l = card.legalities[format.legality];
  return l === 'legal';
}

/** Build the context object the builder and suggesters share. */
export function makeContext({ format, colors = [], commander = null, theme = null }) {
  const fmt = typeof format === 'string' ? FORMATS[format] : format;
  let cols = colors;
  let themes = [];
  if (fmt.hasCommander && commander) {
    cols = commander.color_identity;
    themes = commanderThemes(commander);
  }
  const t = typeof theme === 'string' ? themeFromKey(theme) : theme;
  if (t) themes = [t, ...themes.filter((x) => x.key !== t.key)];
  return {
    format: fmt,
    colors: cols,
    colorSet: new Set(cols),
    mask: colorMask(cols),
    commander,
    themes,
    userTheme: t,
  };
}

function spellEligible(card, ctx) {
  const i = info(card);
  if (i.land || !i.playable || !legalIn(card, ctx.format)) return false;
  if (ctx.commander && card.name === ctx.commander.name) return false;
  if (ctx.format.hasCommander) return (i.identity & ~ctx.mask) === 0;
  return i.reqs.every((opts) => opts.some((c) => ctx.colorSet.has(c)));
}

export function baseScore(card, ctx) {
  const i = info(card);
  let s = i.quality;
  let hits = 0;
  ctx.themes.forEach((t, idx) => {
    if (t.test(card)) hits += idx === 0 && ctx.userTheme ? 1.5 : 1;
  });
  s += Math.min(48, hits * 26);
  if (!ctx.format.hasCommander) {
    const reqs = i.reqs;
    if (reqs.length) s += 4;
    const used = new Set(reqs.flat());
    if (ctx.colors.length > 1 && ctx.colors.every((c) => used.has(c))) s += 4;
    if (card.cmc >= 7) s -= 18;
    else if (card.cmc === 6) s -= 6;
    if (ctx.format.key === 'limited' && i.creature) s += 4;
  } else if (card.cmc >= 8) s -= 10;
  return Math.max(1, s);
}

function copyCap(entry, ctx) {
  const i = info(entry.card);
  const max = ctx.format.singleton ? (i.anyNumber ? 30 : 1) : (i.anyNumber ? 30 : ctx.format.maxCopies);
  return Math.max(0, Math.min(entry.available, max));
}

function themeHits(card, ctx) {
  return ctx.themes.some((t) => t.test(card));
}

// ---------- deck construction ----------

/**
 * Build (or finish) a deck.
 * opts: { pool, format, colors, commander (card|null), theme, locked: {name: count} }
 * Returns { cards: {name: count}, commander: name|null, notes: [string] }
 */
export function buildDeck({ pool, format, colors = [], commander = null, theme = null, locked = {} }) {
  const ctx = makeContext({ format, colors, commander, theme });
  const fmt = ctx.format;
  const byName = new Map(pool.map((e) => [e.name, e]));
  const notes = [];
  const deck = new Map();
  for (const [n, c] of Object.entries(locked)) if (c > 0 && (!commander || n !== commander.name)) deck.set(n, c);

  const lookup = (n) => byName.get(n)?.card || (BASIC_CARDS[n] || null);
  const slots = fmt.size - (fmt.hasCommander ? 1 : 0);

  // Tally what is locked in.
  let lockedLands = 0;
  let nonland = 0;
  let creatures = 0;
  const bucketHave = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  const roleHave = {};
  for (const [n, c] of deck) {
    const card = lookup(n);
    if (!card) continue;
    const i = info(card);
    if (i.land) { lockedLands += c; continue; }
    nonland += c;
    if (i.creature) creatures += c;
    bucketHave[i.bucket] += c;
    for (const r of i.roles) roleHave[r] = (roleHave[r] || 0) + c;
  }

  const landTarget = Math.max(0, fmt.lands - lockedLands);
  const nonlandTarget = Math.max(0, slots - fmt.lands);
  const nonlandSlots = Math.max(0, nonlandTarget - nonland);

  // Candidate spells.
  const cands = [];
  for (const e of pool) {
    if (!spellEligible(e.card, ctx)) continue;
    const cap = copyCap(e, ctx) - (deck.get(e.name) || 0);
    if (cap <= 0) continue;
    cands.push({ e, i: info(e.card), base: baseScore(e.card, ctx), cap, taken: 0, prior: deck.get(e.name) || 0 });
  }

  const [crLo, crHi] = fmt.creatures;
  for (let step = 0; step < nonlandSlots; step++) {
    const remaining = nonlandSlots - step;
    const creaturesNeeded = Math.ceil(crLo * nonlandTarget) - creatures;
    let best = null;
    let bestScore = -Infinity;
    for (const c of cands) {
      if (c.taken >= c.cap) continue;
      const copyIdx = c.prior + c.taken;
      let s = c.base * (fmt.singleton ? 1 : Math.max(0.05, 1 - fmt.decay * copyIdx));
      for (const [role, need] of Object.entries(fmt.roles)) {
        const have = roleHave[role] || 0;
        if (have < need && c.i.roles.has(role)) s += 22 * (1 - have / need) + 6;
      }
      const target = fmt.curve[c.i.bucket] * nonlandTarget;
      const over = bucketHave[c.i.bucket] + 1 - target;
      if (over > 0) s *= 0.8 ** over;
      if (c.i.creature) {
        if (creatures + 1 > crHi * nonlandTarget) s *= 0.55;
      } else if (creaturesNeeded >= remaining) s *= 0.4;
      if (s > bestScore) { bestScore = s; best = c; }
    }
    if (!best) {
      notes.push(`Only found enough playable spells for ${nonland} of ${nonlandTarget} non-land slots in these colors — the rest were filled with basic lands.`);
      break;
    }
    best.taken++;
    nonland++;
    deck.set(best.e.name, (deck.get(best.e.name) || 0) + 1);
    bucketHave[best.i.bucket]++;
    if (best.i.creature) creatures++;
    for (const r of best.i.roles) roleHave[r] = (roleHave[r] || 0) + 1;
  }

  // Lands.
  const missingSpells = Math.max(0, nonlandTarget - nonland);
  let landsToAdd = landTarget + missingSpells;
  const nonbasics = pickNonbasicLands(pool, ctx, deck, Math.min(landTarget, Math.max(0, fmt.maxNonbasic - countNonbasicLands(deck, lookup))));
  for (const [n, c] of nonbasics) { deck.set(n, (deck.get(n) || 0) + c); landsToAdd -= c; }

  const basics = distributeBasics([...deck].map(([n, c]) => [lookup(n), c]).filter(([card]) => card), ctx, landsToAdd);
  for (const [n, c] of basics) deck.set(n, (deck.get(n) || 0) + c);

  const cards = {};
  for (const [n, c] of deck) if (c > 0) cards[n] = c;
  if (fmt.roles.removal && (roleHave.removal || 0) < fmt.roles.removal / 2) notes.push('Light on removal — your pile had few removal spells in these colors.');
  if (fmt.hasCommander && (roleHave.ramp || 0) < 5) notes.push('Light on ramp — consider adding mana rocks or land-search spells.');
  return { cards, commander: commander ? commander.name : null, notes };
}

function countNonbasicLands(deck, lookup) {
  let n = 0;
  for (const [name, c] of deck) {
    const card = lookup(name);
    if (card && info(card).land && !info(card).basic) n += c;
  }
  return n;
}

function landProduces(card, ctx) {
  const i = info(card);
  let produced = (card.produced_mana || []).filter((c) => COLORS.includes(c));
  if (!produced.length && i.fetch && ctx.colors.length > 1) produced = [...ctx.colors];
  return produced;
}

function pickNonbasicLands(pool, ctx, deck, max) {
  const out = new Map();
  if (max <= 0) return out;
  const fmt = ctx.format;
  const scored = [];
  for (const e of pool) {
    const card = e.card;
    const i = info(card);
    if (!i.land || i.basic || !i.playable || !legalIn(card, fmt)) continue;
    if (fmt.hasCommander && (i.identity & ~ctx.mask) !== 0) continue;
    const produced = landProduces(card, ctx);
    const onColor = produced.filter((c) => ctx.colorSet.has(c));
    let s = i.quality;
    if (ctx.colors.length >= 2 && onColor.length >= 2) s += 30 + 5 * onColor.length;
    else if (ctx.colors.length === 0 && (card.produced_mana || []).includes('C')) s += 10;
    else if (s < (fmt.hasCommander ? 45 : 55)) continue; // utility land: only if it's genuinely good
    if (onColor.length === 0 && ctx.colors.length > 0 && !fmt.hasCommander) continue;
    if (!fmt.hasCommander && produced.some((c) => !ctx.colorSet.has(c)) && onColor.length < 2) continue;
    if (i.etbTapped && fmt.key !== 'limited') s -= 8;
    const cap = copyCap(e, ctx) - (deck.get(e.name) || 0);
    for (let k = 0; k < cap; k++) scored.push({ name: e.name, s: s * (fmt.singleton ? 1 : 1 - 0.15 * k) });
  }
  scored.sort((a, b) => b.s - a.s);
  for (const x of scored.slice(0, max)) out.set(x.name, (out.get(x.name) || 0) + 1);
  return out;
}

function distributeBasics(deckCards, ctx, n) {
  const out = new Map();
  if (n <= 0) return out;
  if (!ctx.colors.length) { out.set('Wastes', n); return out; }
  const w = Object.fromEntries(ctx.colors.map((c) => [c, 1]));
  for (const [card, count] of deckCards) {
    if (info(card).land) continue;
    const p = pipCounts(card);
    for (const c of ctx.colors) w[c] += p[c] * count;
  }
  const total = Object.values(w).reduce((a, b) => a + b, 0);
  const shares = ctx.colors.map((c) => ({ c, exact: (w[c] / total) * n }));
  shares.forEach((s) => { s.n = Math.floor(s.exact); });
  let left = n - shares.reduce((a, s) => a + s.n, 0);
  shares.sort((a, b) => (b.exact - b.n) - (a.exact - a.n));
  for (let k = 0; left > 0; k = (k + 1) % shares.length, left--) shares[k].n++;
  for (const s of shares) if (s.n) out.set(BASIC_FOR_COLOR[s.c], s.n);
  return out;
}

// Minimal basic land data so stats/validation work even if basics were never scanned.
export const BASIC_CARDS = Object.fromEntries(Object.entries(BASIC_FOR_COLOR).map(([c, name]) => [name, {
  id: `basic-${name}`, name, cmc: 0, mana_cost: '', type_line: `Basic Land — ${name === 'Wastes' ? '' : name}`.replace(/ — $/, ''),
  front_type: `Basic Land — ${name}`, oracle_text: `({T}: Add {${c}}.)`, colors: [], color_identity: c === 'C' ? [] : [c],
  keywords: [], produced_mana: [c], legalities: { commander: 'legal', pauper: 'legal', vintage: 'legal' }, rarity: 'common',
  img: null, img_small: null, edhrec_rank: null, power: null, toughness: null,
}]));

// ---------- suggestions ----------

function topScores(pool, ctx, n) {
  const scores = [];
  for (const e of pool) {
    if (!spellEligible(e.card, ctx)) continue;
    const cap = copyCap(e, ctx);
    const b = baseScore(e.card, ctx);
    for (let k = 0; k < cap; k++) scores.push({ s: b * (ctx.format.singleton ? 1 : Math.max(0.05, 1 - ctx.format.decay * k)), name: e.name });
  }
  scores.sort((a, b) => b.s - a.s);
  return scores.slice(0, n);
}

function strengthOf(top, n) {
  if (!n) return 0;
  const sum = top.reduce((a, x) => a + x.s, 0);
  return Math.round(sum / n);
}

/** Rank mono- and two-color combinations by how good a deck the pile supports. */
export function suggestColors(pool, format) {
  const fmt = FORMATS[format];
  const n = fmt.size - fmt.lands;
  const combos = [];
  for (let a = 0; a < 5; a++) {
    combos.push([COLORS[a]]);
    for (let b = a + 1; b < 5; b++) combos.push([COLORS[a], COLORS[b]]);
  }
  return combos.map((colors) => {
    const ctx = makeContext({ format, colors });
    const top = topScores(pool, ctx, n);
    const distinct = new Set(top.map((x) => x.name)).size;
    // Two colors always have more cards; a small penalty keeps strong mono decks visible.
    return { colors, strength: strengthOf(top, n), playable: top.length, distinct, preview: [...new Set(top.map((x) => x.name))].slice(0, 6) };
  }).sort((x, y) => y.strength - x.strength);
}

/** Themes (mechanics + creature types) the pile supports in the given colors. */
export function suggestThemes(pool, format, colors, commander = null) {
  const ctx = makeContext({ format, colors, commander });
  const elig = pool.filter((e) => spellEligible(e.card, ctx));
  const results = [];
  for (const t of THEMES) {
    const hits = elig.filter((e) => t.test(e.card));
    if (hits.length >= 5) results.push({ key: t.key, label: t.label, count: hits.length });
  }
  const tribes = new Map();
  for (const e of elig) {
    if (!info(e.card).creature) continue;
    for (const st of subtypes(e.card)) tribes.set(st, (tribes.get(st) || 0) + 1);
  }
  for (const [tribe, count] of tribes) {
    if (count < 5) continue;
    const t = tribeTheme(tribe);
    results.push({ key: t.key, label: t.label, count: elig.filter((e) => t.test(e.card)).length });
  }
  return results.sort((a, b) => b.count - a.count).slice(0, 16);
}

/** Legendary creatures in the pile, ranked by how deep a deck they can lead. */
export function suggestCommanders(pool, { limit = 60 } = {}) {
  const fmt = FORMATS.commander;
  const nonlandN = fmt.size - 1 - fmt.lands;
  const cmds = pool.filter((e) => e.available > 0 && canBeCommander(e.card) && legalIn(e.card, fmt) && info(e.card).playable);
  const byMask = new Map();
  const res = cmds.map((e) => {
    const mask = info(e.card).identity;
    if (!byMask.has(mask)) {
      const ctx = makeContext({ format: fmt, colors: maskToColors(mask) });
      ctx.themes = [];
      const top = topScores(pool, ctx, nonlandN);
      byMask.set(mask, { strength: strengthOf(top, nonlandN), playable: top.length });
    }
    return { entry: e, name: e.name, colors: e.card.color_identity, ...byMask.get(mask) };
  });
  res.sort((a, b) => b.strength - a.strength || info(b.entry.card).quality - info(a.entry.card).quality);
  const shortlist = res.slice(0, limit);
  for (const r of shortlist) {
    const ctx = makeContext({ format: fmt, commander: r.entry.card });
    r.themes = ctx.themes.map((t) => t.label);
    r.synergy = ctx.themes.length ? pool.filter((e) => spellEligible(e.card, ctx) && themeHits(e.card, ctx)).length : 0;
    r.score = r.strength + Math.min(25, r.synergy * 0.6) + info(r.entry.card).quality * 0.15;
  }
  return shortlist.sort((a, b) => b.score - a.score);
}

/** Cards from the pool that would fit this deck, best first (for the editor's "add cards" panel). */
export function rankForDeck(pool, deck) {
  const commanderCard = deck.commander ? pool.find((e) => e.name === deck.commander)?.card : null;
  const ctx = makeContext({ format: deck.format, colors: deck.colors, commander: commanderCard, theme: deck.theme });
  const out = [];
  for (const e of pool) {
    const i = info(e.card);
    if (!i.playable || !legalIn(e.card, ctx.format)) continue;
    if (i.land) {
      if (i.basic) continue;
      if (ctx.format.hasCommander ? (i.identity & ~ctx.mask) !== 0 : !landProduces(e.card, ctx).some((c) => ctx.colorSet.has(c)) && ctx.colors.length) continue;
      out.push({ entry: e, score: i.quality });
      continue;
    }
    if (!spellEligible(e.card, ctx)) continue;
    out.push({ entry: e, score: baseScore(e.card, ctx), theme: themeHits(e.card, ctx) });
  }
  return out.sort((a, b) => b.score - a.score);
}

// ---------- validation, stats, export ----------

/**
 * deck: { format, cards, commander, colors }
 * lookup(name) -> card | null; availability(name) -> copies available to *this* deck (or Infinity)
 */
export function validateDeck(deck, lookup, availability = () => Infinity) {
  const fmt = FORMATS[deck.format];
  const issues = [];
  const total = deckSize(deck);
  if (fmt.exact && total !== fmt.size) issues.push({ level: total > fmt.size ? 'error' : 'warn', msg: `Deck has ${total} cards; Commander decks need exactly ${fmt.size} (including the commander).` });
  else if (!fmt.exact && total < fmt.size) issues.push({ level: 'warn', msg: `Deck has ${total} cards; ${fmt.label} decks need at least ${fmt.size}.` });

  const cmd = deck.commander ? lookup(deck.commander) : null;
  if (fmt.hasCommander) {
    if (!cmd) issues.push({ level: 'error', msg: 'No commander chosen.' });
    else if (!canBeCommander(cmd)) issues.push({ level: 'error', msg: `${cmd.name} can't be a commander.` });
  }
  const cmdMask = cmd ? colorMask(cmd.color_identity) : 0;
  const deckColors = new Set(deck.colors || []);
  for (const [name, count] of Object.entries(deck.cards)) {
    const card = lookup(name);
    if (!card) { issues.push({ level: 'warn', msg: `${name}: card data not found.` }); continue; }
    const i = info(card);
    if (fmt.singleton && count > 1 && !i.anyNumber) issues.push({ level: 'error', msg: `${name}: ${count} copies, but Commander is singleton.` });
    else if (!fmt.singleton && count > fmt.maxCopies && !i.anyNumber) issues.push({ level: 'error', msg: `${name}: ${count} copies (max ${fmt.maxCopies}).` });
    if (fmt.legality && card.legalities[fmt.legality] !== 'legal' && !i.basic) issues.push({ level: 'error', msg: `${name} is not legal in ${fmt.label}.` });
    if (fmt.hasCommander && cmd && (i.identity & ~cmdMask) !== 0) issues.push({ level: 'error', msg: `${name} is outside ${cmd.name}'s color identity.` });
    if (!fmt.hasCommander && deckColors.size && !i.land && !canCastWith(card, deckColors)) issues.push({ level: 'warn', msg: `${name} needs colors outside this deck's (${[...deckColors].join('')}).` });
    if (!i.basic) {
      const avail = availability(name);
      const need = count + (deck.commander === name ? 1 : 0);
      if (need > avail) issues.push({ level: 'warn', short: true, msg: `${name}: deck uses ${need}, but only ${Math.max(0, avail)} ${avail === 1 ? 'copy is' : 'copies are'} free in your collection.` });
    }
  }
  return issues;
}

export function deckSize(deck) {
  return Object.values(deck.cards).reduce((a, b) => a + b, 0) + (deck.commander ? 1 : 0);
}

export function deckStats(deck, lookup) {
  const curve = [0, 0, 0, 0, 0, 0, 0, 0]; // 0..6, 7+
  const types = {};
  const pips = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  const sources = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  let lands = 0;
  let spells = 0;
  let cmcSum = 0;
  const roles = { removal: 0, draw: 0, ramp: 0, wipe: 0 };
  const entries = Object.entries(deck.cards);
  if (deck.commander) entries.push([deck.commander, 1]);
  for (const [name, count] of entries) {
    const card = lookup(name);
    if (!card) continue;
    const i = info(card);
    const t = primaryType(card);
    types[t] = (types[t] || 0) + count;
    if (i.land) {
      lands += count;
      for (const c of card.produced_mana || []) if (c in sources) sources[c] += count;
      continue;
    }
    spells += count;
    cmcSum += (card.cmc || 0) * count;
    curve[Math.min(7, Math.floor(card.cmc || 0))] += count;
    const p = pipCounts(card);
    for (const c of COLORS) pips[c] += p[c] * count;
    for (const r of i.roles) if (r in roles) roles[r] += count;
  }
  return { curve, types, pips, sources, lands, spells, avgCmc: spells ? cmcSum / spells : 0, roles, total: deckSize(deck) };
}

/** Plain-text decklist: "4 Llanowar Elves (M19) 314" — imports into Moxfield, Archidekt, MTG Arena etc. */
export function exportText(deck, lookup, { withSet = true } = {}) {
  const line = (name, count) => {
    const c = lookup(name);
    return withSet && c && c.set && !String(c.id).startsWith('basic-') ? `${count} ${name} (${c.set.toUpperCase()}) ${c.cn}` : `${count} ${name}`;
  };
  const out = [];
  if (deck.commander) out.push('Commander', line(deck.commander, 1), '', 'Deck');
  const names = Object.keys(deck.cards).sort((a, b) => {
    const ca = lookup(a); const cb = lookup(b);
    const la = ca && info(ca).land ? 1 : 0; const lb = cb && info(cb).land ? 1 : 0;
    return la - lb || a.localeCompare(b);
  });
  for (const n of names) out.push(line(n, deck.cards[n]));
  return out.join('\n');
}

/** Colors actually used by a deck's spells (for display). */
export function deckColors(deck, lookup) {
  if (deck.commander) {
    const c = lookup(deck.commander);
    if (c) return c.color_identity;
  }
  const s = new Set();
  for (const name of Object.keys(deck.cards)) {
    const card = lookup(name);
    if (card && !info(card).land) for (const opts of castRequirements(card)) if (opts.length === 1) s.add(opts[0]);
  }
  return COLORS.filter((c) => s.has(c));
}
