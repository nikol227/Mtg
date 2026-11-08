// Commander deck engine. Pure functions (no DOM).
// Scores cards with EDHREC data (how often a card is played with this commander and its
// synergy), adds Commander Spellbook combos allowed by the chosen bracket, balances the
// mana curve and roles, explains every pick, and writes a game plan.
//
// A "pool" is [{ name, card, available }] where `available` already excludes copies used
// by other decks.

import {
  COLORS, BASIC_FOR_COLOR, castRequirements, pipCounts, colorMask, isLand, isBasic, isCreature,
  canBeCommander, isPlayable, anyNumberAllowed, cardRoles, quality, commanderThemes, primaryType,
  nameKey, isMassLandDenial, isExtraTurn,
} from './cards.js';
import { matchCombos } from './data.js';

export const FORMAT = {
  key: 'commander', label: 'Commander', size: 100, lands: 36, maxNonbasic: 20,
  curve: { 1: 0.08, 2: 0.2, 3: 0.22, 4: 0.2, 5: 0.14, 6: 0.16 },
  creatures: [0.28, 0.6],
  roles: { ramp: 10, draw: 9, removal: 8, wipe: 2 },
};
// Kept for older code paths/tests that look formats up by key.
export const FORMATS = { commander: FORMAT };

export const BRACKET_RULES = {
  1: { gameChangers: 0, combos: 0, massLandDenial: false, extraTurns: false },
  2: { gameChangers: 0, combos: 1, massLandDenial: false, extraTurns: false },
  3: { gameChangers: 3, combos: 1, massLandDenial: false, extraTurns: true },
  4: { gameChangers: 99, combos: 2, massLandDenial: true, extraTurns: true },
  5: { gameChangers: 99, combos: 3, massLandDenial: true, extraTurns: true },
};

// ---------- per-card derived info (cached) ----------

const infoCache = new WeakMap();
export function info(card) {
  let i = infoCache.get(card);
  if (!i) {
    const text = card.oracle_text || '';
    i = {
      key: nameKey(card.name),
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
      etbTapped: /enters (the battlefield )?tapped/i.test(text) && !/unless/i.test(text),
      fetch: /search your library for (a|an) (basic land|land|.{0,30}(forest|plains|island|swamp|mountain))/i.test(text),
      mld: isMassLandDenial(card),
      extraTurn: isExtraTurn(card),
      finisher: /you win the game|each opponent loses|loses the game|double strike|infect|commander damage|creatures you control get \+\d+\/\+\d+ and gain trample/i.test(text),
    };
    infoCache.set(card, i);
  }
  return i;
}

const legal = (card) => card.legalities.commander === 'legal';

/** Context shared by builder, ranker and validator. */
export function makeContext({ commander, edh = null, bracket = 3, gameChangers = new Set(), theme = null, themeLabel = null }) {
  const cols = commander ? commander.color_identity : [];
  return {
    commander,
    commanderKey: commander ? nameKey(commander.name) : null,
    colors: cols,
    colorSet: new Set(cols),
    mask: colorMask(cols),
    edh,
    bracket,
    rules: BRACKET_RULES[bracket] || BRACKET_RULES[3],
    gameChangers,
    theme,
    themeLabel,
    heuristicThemes: commander ? commanderThemes(commander) : [],
  };
}

export const isGameChanger = (card, ctx) => !!card.game_changer || ctx.gameChangers.has(nameKey(card.name));

function eligible(card, ctx) {
  const i = info(card);
  if (!i.playable || !legal(card) || i.basic) return false;
  if (ctx.commanderKey && i.key === ctx.commanderKey) return false;
  if ((i.identity & ~ctx.mask) !== 0) return false;
  if (!ctx.rules.massLandDenial && i.mld) return false;
  if (!ctx.rules.extraTurns && i.extraTurn) return false;
  return true;
}

/** Score + the facts behind it (used for explanations). */
export function scoreCard(card, ctx) {
  const i = info(card);
  const e = ctx.edh?.cards.get(i.key);
  let s;
  if (e) {
    s = 40 + 120 * e.incl + 200 * Math.max(-0.1, e.syn);
  } else {
    s = i.quality * 0.6;
    const hits = ctx.heuristicThemes.filter((t) => t.test(card)).length;
    s += Math.min(30, hits * 15);
  }
  if (!i.land && card.cmc >= 8) s -= 10;
  return { s: Math.max(1, s), edh: e || null };
}

// ---------- combos for a deck ----------

function pickCombos(pool, ctx, comboIndex, byKey) {
  const limit = ctx.rules.combos;
  if (!comboIndex || !limit) return [];
  const have = new Set();
  for (const e of pool) if (e.available > 0 && eligible(e.card, ctx)) have.add(info(e.card).key);
  if (ctx.commanderKey) have.add(ctx.commanderKey);
  const { complete } = matchCombos(comboIndex, have, { mask: ctx.mask, bracket: ctx.bracket, commanderKey: ctx.commanderKey, includeTemplated: false });
  const scored = complete
    .filter((c) => c.cards.length <= 4)
    .map((c) => {
      const pieces = c.keys.filter((k) => k !== ctx.commanderKey).map((k) => byKey.get(k)).filter(Boolean);
      const gc = pieces.filter((p) => isGameChanger(p.card, ctx)).length;
      const fit = pieces.reduce((a, p) => a + scoreCard(p.card, ctx).s, 0) / Math.max(1, pieces.length);
      const usesCommander = c.keys.includes(ctx.commanderKey);
      return { c, pieces, gc, value: fit + Math.log10(1 + c.popularity) * 8 + (usesCommander ? 40 : 0) - pieces.length * 6 };
    })
    .sort((a, b) => b.value - a.value);
  const chosen = [];
  let gcUsed = 0;
  const used = new Set();
  for (const x of scored) {
    if (chosen.length >= limit) break;
    if (gcUsed + x.gc > ctx.rules.gameChangers) continue;
    if (x.pieces.every((p) => used.has(p.name))) continue; // no new pieces
    chosen.push(x);
    gcUsed += x.gc;
    for (const p of x.pieces) used.add(p.name);
  }
  return chosen;
}

// ---------- deck construction ----------

/**
 * Build or finish a Commander deck.
 * opts: { pool, commander (card), edh, bracket, gameChangers, comboIndex, locked: {name: count}, theme, themeLabel }
 * Returns { cards, commander, notes, reasons: {name: reason}, combos: [comboId] }
 */
export function buildDeck({ pool, commander, edh = null, bracket = 3, gameChangers = new Set(), comboIndex = null, locked = {}, theme = null, themeLabel = null }) {
  const ctx = makeContext({ commander, edh, bracket, gameChangers, theme, themeLabel });
  const fmt = FORMAT;
  const byName = new Map(pool.map((e) => [e.name, e]));
  const byKey = new Map(pool.map((e) => [info(e.card).key, e]));
  const lookup = (n) => byName.get(n)?.card || BASIC_CARDS[n] || null;
  const notes = [];
  const reasons = {};
  const deck = new Map();
  for (const [n, c] of Object.entries(locked)) if (c > 0 && n !== commander?.name) deck.set(n, c);

  const tally = { lands: 0, nonland: 0, creatures: 0, gc: 0, bucket: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 }, roles: {} };
  const count = (card, c) => {
    const i = info(card);
    if (i.land) { tally.lands += c; return; }
    tally.nonland += c;
    if (i.creature) tally.creatures += c;
    tally.bucket[i.bucket] += c;
    for (const r of i.roles) tally.roles[r] = (tally.roles[r] || 0) + c;
    if (isGameChanger(card, ctx)) tally.gc += c;
  };
  for (const [n, c] of deck) { const card = lookup(n); if (card) count(card, c); }

  // 1. Combos first, so the deck has a way to win that fits the bracket.
  const chosenCombos = Object.keys(locked).length ? [] : pickCombos(pool, ctx, comboIndex, byKey);
  for (const x of chosenCombos) {
    for (const p of x.pieces) {
      if (deck.has(p.name)) continue;
      deck.set(p.name, 1);
      count(p.card, 1);
    }
  }

  const slots = fmt.size - 1;
  const nonlandTarget = slots - fmt.lands;
  const nonlandSlots = Math.max(0, nonlandTarget - tally.nonland);

  // 2. Candidate spells.
  const cands = [];
  for (const e of pool) {
    const i = info(e.card);
    if (i.land || !eligible(e.card, ctx) || e.available <= 0) continue;
    const cap = Math.min(e.available, i.anyNumber ? 30 : 1) - (deck.get(e.name) || 0);
    if (cap <= 0) continue;
    cands.push({ e, i, base: scoreCard(e.card, ctx).s, cap, taken: 0, gc: isGameChanger(e.card, ctx) });
  }

  const [crLo, crHi] = fmt.creatures;
  for (let step = 0; step < nonlandSlots; step++) {
    const remaining = nonlandSlots - step;
    const creaturesNeeded = Math.ceil(crLo * nonlandTarget) - tally.creatures;
    let best = null;
    let bestScore = -Infinity;
    for (const c of cands) {
      if (c.taken >= c.cap) continue;
      if (c.gc && tally.gc >= ctx.rules.gameChangers) continue;
      let s = c.base;
      for (const [role, need] of Object.entries(fmt.roles)) {
        const have = tally.roles[role] || 0;
        if (have < need && c.i.roles.has(role)) s += 30 * (1 - have / need) + 8;
      }
      const target = fmt.curve[c.i.bucket] * nonlandTarget;
      const over = tally.bucket[c.i.bucket] + 1 - target;
      if (over > 0) s *= 0.85 ** over;
      if (c.i.creature) { if (tally.creatures + 1 > crHi * nonlandTarget) s *= 0.6; }
      else if (creaturesNeeded >= remaining) s *= 0.4;
      if (s > bestScore) { bestScore = s; best = c; }
    }
    if (!best) {
      notes.push(`Your collection only had ${tally.nonland} usable non-land cards in these colors, so the remaining ${nonlandTarget - tally.nonland} slots were filled with basic lands.`);
      break;
    }
    best.taken++;
    deck.set(best.e.name, (deck.get(best.e.name) || 0) + 1);
    count(best.e.card, 1);
  }

  // 3. Lands.
  const missingSpells = Math.max(0, nonlandTarget - tally.nonland);
  let landsToAdd = Math.max(0, fmt.lands - tally.lands) + missingSpells;
  const nonbasics = pickNonbasicLands(pool, ctx, deck, Math.min(landsToAdd, Math.max(0, fmt.maxNonbasic - countNonbasic(deck, lookup))));
  for (const [n, c] of nonbasics) { deck.set(n, (deck.get(n) || 0) + c); landsToAdd -= c; }
  const basics = distributeBasics([...deck].map(([n, c]) => [lookup(n), c]).filter(([card]) => card), ctx, landsToAdd);
  for (const [n, c] of basics) deck.set(n, (deck.get(n) || 0) + c);

  // 4. Reasons for every card, combos in the final list.
  const cards = {};
  for (const [n, c] of deck) if (c > 0) cards[n] = c;
  const deckCombos = findDeckCombos(cards, commander, comboIndex, ctx);
  for (const n of Object.keys(cards)) {
    const card = lookup(n);
    if (card) reasons[n] = reasonFor(card, ctx, deckCombos.complete);
    if (locked[n]) reasons[n] = { ...(reasons[n] || {}), kept: true };
  }
  if ((tally.roles.ramp || 0) < 6) notes.push('Light on ramp: your bulk had few mana rocks or land-search spells in these colors.');
  if ((tally.roles.removal || 0) < 5) notes.push('Light on removal: consider picking up a few cheap removal spells.');
  if (!edh) notes.push('EDHREC data was not available, so cards were chosen with built-in heuristics only.');
  return { cards, commander: commander ? commander.name : null, notes, reasons, combos: deckCombos.complete.map((c) => c.id) };
}

function countNonbasic(deck, lookup) {
  let n = 0;
  for (const [name, c] of deck) { const card = lookup(name); if (card && info(card).land && !info(card).basic) n += c; }
  return n;
}

function landProduces(card, ctx) {
  let produced = (card.produced_mana || []).filter((c) => COLORS.includes(c));
  if (!produced.length && info(card).fetch && ctx.colors.length > 1) produced = [...ctx.colors];
  return produced;
}

function pickNonbasicLands(pool, ctx, deck, max) {
  const out = new Map();
  if (max <= 0) return out;
  const scored = [];
  for (const e of pool) {
    const card = e.card;
    const i = info(card);
    if (!i.land || i.basic || !i.playable || !legal(card) || e.available <= 0 || deck.has(e.name)) continue;
    if ((i.identity & ~ctx.mask) !== 0) continue;
    if (!ctx.rules.massLandDenial && i.mld) continue;
    const { s: base, edh } = scoreCard(card, ctx);
    const onColor = landProduces(card, ctx).filter((c) => ctx.colorSet.has(c));
    let s = base;
    if (ctx.colors.length >= 2 && onColor.length >= 2) s += 25 + 5 * onColor.length;
    else if (!edh && i.quality < 45) continue; // unknown utility land: only if generally good
    if (i.etbTapped) s -= 8;
    scored.push({ name: e.name, s });
  }
  scored.sort((a, b) => b.s - a.s);
  for (const x of scored.slice(0, max)) out.set(x.name, 1);
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
  id: `basic-${name}`, name, cmc: 0, mana_cost: '', type_line: `Basic Land — ${name}`,
  front_type: `Basic Land — ${name}`, oracle_text: `({T}: Add {${c}}.)`, colors: [], color_identity: c === 'C' ? [] : [c],
  keywords: [], produced_mana: [c], legalities: { commander: 'legal', pauper: 'legal', vintage: 'legal' }, rarity: 'common',
  img: null, img_small: null, edhrec_rank: null, power: null, toughness: null,
}]));

// ---------- combos in a deck ----------

/** Complete combos in a deck list, and ones a single card away (with whether you own that card). */
export function findDeckCombos(cards, commander, comboIndex, ctx) {
  if (!comboIndex) return { complete: [], oneAway: [] };
  const have = new Set(Object.keys(cards).map(nameKey));
  if (commander) have.add(nameKey(commander.name));
  return matchCombos(comboIndex, have, { mask: ctx ? ctx.mask : 31, bracket: 5, commanderKey: commander ? nameKey(commander.name) : null });
}

// ---------- explanations ----------

const ROLE_LABEL = { ramp: 'Ramp', draw: 'Card draw', removal: 'Removal', wipe: 'Board wipe' };

export function reasonFor(card, ctx, combosInDeck = []) {
  const i = info(card);
  const { edh } = scoreCard(card, ctx);
  const key = i.key;
  return {
    incl: edh ? edh.incl : null,
    syn: edh ? edh.syn : null,
    list: edh ? edh.list : null,
    roles: [...i.roles].filter((r) => r !== 'wipe' || true).map((r) => ROLE_LABEL[r]).filter(Boolean),
    gc: isGameChanger(card, ctx),
    theme: !edh && ctx.heuristicThemes.some((t) => t.test(card)),
    combos: combosInDeck.filter((c) => c.keys.includes(key)).map((c) => c.id),
  };
}

/** One readable sentence explaining why a card is in the deck. */
export function explain(name, reason, { commanderName = 'this commander', variantLabel = null, numDecks = 0, combosById = new Map(), basic = false } = {}) {
  if (basic) return 'Basic land, added to make the colors in your mana costs.';
  if (!reason) return '';
  const parts = [];
  if (reason.incl != null) {
    const pct = Math.round(reason.incl * 100);
    const syn = Math.round(reason.syn * 100);
    parts.push(`Played in ${pct}% of ${numDecks ? `${numDecks.toLocaleString()} ` : ''}${commanderName} decks on EDHREC${variantLabel ? ` (${variantLabel} page)` : ''}${syn >= 5 ? ` (synergy +${syn}%: much more common here than in other decks of these colors)` : syn <= -5 ? ' (a general staple rather than a synergy pick)' : ''}.`);
  } else if (reason.theme) {
    parts.push(`Fits ${commanderName}'s abilities.`);
  } else {
    parts.push('A solid card from your bulk in these colors.');
  }
  if (reason.roles?.length) parts.push(`Role: ${reason.roles.join(', ')}.`);
  for (const id of reason.combos || []) {
    const c = combosById.get(id);
    if (c) parts.push(`Combo with ${c.cards.filter((n) => nameKey(n) !== nameKey(name)).join(' + ')}: ${c.produces.slice(0, 2).join(', ')}.`);
  }
  if (reason.gc) parts.push('Game Changer: counts toward your bracket limit.');
  if (reason.kept) parts.push('You chose to keep this card.');
  return parts.join(' ');
}

// ---------- game plan ----------

/**
 * A short "how to play this deck" guide, built from the deck's own cards.
 * Returns [{ title, text, cards: [names] }]
 */
export function gamePlan(deck, lookup, { edh = null, combosInDeck = [], themeLabel = null, bracket = 3 } = {}) {
  const cmd = deck.commander ? lookup(deck.commander) : null;
  const entries = Object.keys(deck.cards).map((n) => ({ n, card: lookup(n) })).filter((x) => x.card && !info(x.card).land);
  const r = (n) => deck.reasons?.[n] || {};
  const bySyn = [...entries].sort((a, b) => (r(b.n).syn ?? -1) - (r(a.n).syn ?? -1));
  const withRole = (role) => entries.filter((x) => info(x.card).roles.has(role)).sort((a, b) => a.card.cmc - b.card.cmc);
  const names = (xs, k = 4) => xs.slice(0, k).map((x) => x.n);
  const list = (ns) => ns.length > 1 ? `${ns.slice(0, -1).join(', ')} and ${ns.at(-1)}` : ns[0] || '';
  const plan = [];

  const firstSentence = cmd ? (cmd.oracle_text || '').split(/(?<=\.)\s/)[0] : '';
  plan.push({
    title: 'The idea',
    text: `${cmd ? cmd.name : 'Your commander'} leads this deck${themeLabel ? `, built around the ${themeLabel} strategy` : ''}. ${firstSentence ? `Its key text: “${firstSentence}”` : ''} ${edh?.numDecks ? `Cards were chosen from what ${edh.numDecks.toLocaleString()} ${edh.variantLabel ? `${edh.variantLabel} ` : ''}decks for this commander on EDHREC play, limited to cards you own.` : ''} Target power: bracket ${bracket}.`.replace(/\s+/g, ' ').trim(),
    cards: cmd ? [cmd.name] : [],
  });
  const ramp = withRole('ramp').filter((x) => x.card.cmc <= 3);
  plan.push({
    title: 'Early turns',
    text: ramp.length
      ? `Play lands every turn and use cheap ramp like ${list(names(ramp, 3))} so you can cast ${cmd ? cmd.name : 'your commander'} on curve or a turn early. Keep opening hands with three or more lands, or two lands plus a ramp piece.`
      : 'You have little ramp, so keep hands with three or four lands and spend the first turns setting up cheap creatures.',
    cards: names(ramp, 3),
  });
  const engines = bySyn.filter((x) => (r(x.n).syn ?? 0) >= 0.1);
  plan.push({
    title: 'Build your engine',
    text: engines.length
      ? `These cards work especially well with ${cmd ? cmd.name : 'your commander'} and get played far more often in its decks than elsewhere: ${list(names(engines, 5))}. Protect them and deploy them before going for the win.`
      : `Develop your board with creatures and value cards, then use ${cmd ? cmd.name : 'your commander'}'s ability every turn.`,
    cards: names(engines, 5),
  });
  const draw = withRole('draw');
  if (draw.length) plan.push({ title: 'Keep the cards flowing', text: `Refill with ${list(names(draw, 4))}. Commander games are long, and running out of cards is the most common way to lose.`, cards: names(draw, 4) });
  const finishers = entries.filter((x) => info(x.card).finisher).sort((a, b) => (r(b.n).syn ?? 0) - (r(a.n).syn ?? 0));
  if (combosInDeck.length) {
    const c = combosInDeck[0];
    plan.push({
      title: 'How it wins',
      text: `Assemble ${list(c.cards)} for ${c.produces.slice(0, 3).join(', ').toLowerCase()}.${combosInDeck.length > 1 ? ` The deck has ${combosInDeck.length} combos in total; see the Combos tab.` : ''}${finishers.length ? ` Without the combo, win through ${list(names(finishers, 3))}.` : ''}`,
      cards: c.cards,
    });
  } else {
    const big = finishers.length ? finishers : [...entries].filter((x) => info(x.card).creature).sort((a, b) => b.card.cmc - a.card.cmc);
    plan.push({ title: 'How it wins', text: big.length ? `Win by combat and steady damage. Your best closers are ${list(names(big, 3))}.` : 'Win through steady combat damage with your commander.', cards: names(big, 3) });
  }
  const removal = withRole('removal').filter((x) => !info(x.card).roles.has('wipe'));
  const wipes = withRole('wipe');
  plan.push({
    title: 'Interaction',
    text: `Save ${removal.length ? list(names(removal, 3)) : 'your removal'} for the biggest threat at the table rather than the first one you see.${wipes.length ? ` Hold ${list(names(wipes, 2))} for when you are behind on board.` : ''}`,
    cards: [...names(removal, 3), ...names(wipes, 2)],
  });
  return plan;
}

// ---------- commander ranking for owned legends without EDHREC data ----------

export function ownedCommanders(pool) {
  return pool.filter((e) => e.available > 0 && canBeCommander(e.card) && legal(e.card) && info(e.card).playable);
}

// ---------- deck upgrade suggestions ----------

/**
 * Suggest swaps that improve a deck using free cards from your collection.
 * deckCards: {name: count} (the deck as it is), lookupDeck(name) -> card|null.
 * Returns { cuts: [{name, score}], adds: [{entry, score, edh}], swaps: [{out, in, gain}] }
 */
export function suggestUpgrades({ deckCards, commander, pool, edh, bracket = 3, gameChangers = new Set(), lookupDeck, max = 15 }) {
  const ctx = makeContext({ commander, edh, bracket, gameChangers });
  const inDeck = new Set(Object.keys(deckCards).map(nameKey));
  const deckScores = [];
  for (const name of Object.keys(deckCards)) {
    const card = lookupDeck(name);
    if (!card || info(card).basic) continue;
    deckScores.push({ name, card, score: scoreCard(card, ctx).s, edh: scoreCard(card, ctx).edh, land: info(card).land });
  }
  let gcInDeck = deckScores.filter((x) => isGameChanger(x.card, ctx)).length;
  const adds = [];
  for (const e of pool) {
    if (e.available <= 0 || inDeck.has(info(e.card).key) || !eligible(e.card, ctx)) continue;
    const { s, edh: x } = scoreCard(e.card, ctx);
    if (!x) continue; // only suggest cards EDHREC actually recommends for this commander
    adds.push({ entry: e, score: s, edh: x, land: info(e.card).land });
  }
  adds.sort((a, b) => b.score - a.score);
  const cuts = [...deckScores].sort((a, b) => a.score - b.score);
  const swaps = [];
  const usedCuts = new Set();
  for (const a of adds) {
    if (swaps.length >= max) break;
    const gc = isGameChanger(a.entry.card, ctx);
    if (gc && gcInDeck >= ctx.rules.gameChangers) continue;
    const cut = cuts.find((c) => !usedCuts.has(c.name) && c.land === a.land && c.score + 15 < a.score);
    if (!cut) continue;
    usedCuts.add(cut.name);
    if (gc) gcInDeck++;
    swaps.push({ out: cut, in: a, gain: a.score - cut.score });
  }
  return { cuts, adds, swaps };
}

// ---------- validation, stats, export ----------

/**
 * deck: { cards, commander, bracket, external }
 * lookup(name) -> card | null; availability(name) -> copies free for this deck (or Infinity)
 */
export function validateDeck(deck, lookup, availability = () => Infinity, { gameChangers = new Set() } = {}) {
  const issues = [];
  const total = deckSize(deck);
  if (total !== FORMAT.size) issues.push({ level: total > FORMAT.size ? 'error' : 'warn', msg: `Deck has ${total} cards; Commander decks need exactly ${FORMAT.size} (including the commander).` });
  const cmd = deck.commander ? lookup(deck.commander) : null;
  if (!cmd) issues.push({ level: 'error', msg: 'No commander chosen.' });
  else if (!canBeCommander(cmd)) issues.push({ level: 'error', msg: `${cmd.name} can't be a commander.` });
  const cmdMask = cmd ? colorMask(cmd.color_identity) : 31;
  const ctx = makeContext({ commander: cmd, bracket: deck.bracket || 3, gameChangers });
  let gc = 0;
  const external = deck.external || {};
  const entries = Object.entries(deck.cards);
  if (deck.commander) entries.push([deck.commander, 0]);
  for (const [name, count] of entries) {
    const card = lookup(name);
    if (!card) { issues.push({ level: 'warn', msg: `${name}: card data not found.` }); continue; }
    const i = info(card);
    if (count > 1 && !i.anyNumber) issues.push({ level: 'error', msg: `${name}: ${count} copies, but Commander is singleton.` });
    if (card.legalities.commander !== 'legal' && !i.basic) issues.push({ level: 'error', msg: `${name} is banned or not legal in Commander.` });
    if (count && cmd && (i.identity & ~cmdMask) !== 0) issues.push({ level: 'error', msg: `${name} is outside ${cmd.name}'s color identity.` });
    if (isGameChanger(card, ctx)) gc++;
    if (count && !ctx.rules.massLandDenial && i.mld) issues.push({ level: 'warn', msg: `${name} is mass land denial, which bracket ${deck.bracket} doesn't allow.` });
    if (count && !ctx.rules.extraTurns && i.extraTurn) issues.push({ level: 'warn', msg: `${name} takes extra turns, which bracket ${deck.bracket} discourages.` });
    if (!i.basic) {
      const need = (count || 1) - (external[name] || 0);
      const avail = availability(name);
      if (need > 0 && need > avail) {
        issues.push({ level: 'warn', short: true, msg: `${name}: ${Math.max(0, avail) === 0 ? 'not free in your collection' : `only ${avail} free`}${name === deck.commander ? ' (your commander)' : ''}.` });
      }
    }
  }
  if (gc > ctx.rules.gameChangers) issues.push({ level: 'warn', msg: `${gc} Game Changers; bracket ${deck.bracket || 3} allows ${ctx.rules.gameChangers === 99 ? 'any number' : ctx.rules.gameChangers}.` });
  return issues;
}

export function deckSize(deck) {
  return Object.values(deck.cards).reduce((a, b) => a + b, 0) + (deck.commander ? 1 : 0);
}

export function deckStats(deck, lookup) {
  const curve = [0, 0, 0, 0, 0, 0, 0, 0];
  const types = {};
  const pips = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  const sources = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  let lands = 0; let spells = 0; let cmcSum = 0;
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

/** Plain-text decklist: "1 Sol Ring (C21) 263" — imports into Moxfield, Archidekt, MTG Arena etc. */
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

export function deckColors(deck, lookup) {
  const c = deck.commander ? lookup(deck.commander) : null;
  return c ? c.color_identity : [];
}
