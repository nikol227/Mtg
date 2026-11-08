import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCSV, csvToImportRows, mergeRows } from '../js/csv.js';
import { slimCard, castRequirements, canCastWith, cardRoles, commanderThemes } from '../js/cards.js';
import {
  buildDeck, validateDeck, deckSize, deckStats, exportText, info, gamePlan, explain, suggestUpgrades, findDeckCombos, makeContext,
  eligibleSpellCounter, thinness, fitPreview, deckProfile, deckCare, BASIC_CARDS, deckCost,
} from '../js/builder.js';
import { textToImportRows, looksLikeCSV } from '../js/csv.js';
import { matchCombos, coverage } from '../js/data.js';
import { nameKey, colorMask } from '../js/cards.js';
import { fetchCollection } from '../js/scryfall.js';
import { findSynergies, deckCautions, planSummary } from '../js/synergy.js';
import { library, shuffle, handStats, verdict, landOdds } from '../js/hand.js';
import { deckTitle, commanderParts } from '../js/names.js';
import { guideHTML, glossaryFor } from '../js/print.js';
import { bulkPile } from './fixtures.mjs';

const MANABOX = `Name,Set code,Set name,Collector number,Foil,Rarity,Quantity,ManaBox ID,Scryfall ID,Purchase price,Misprint,Altered,Condition,Language,Purchase price currency
Llanowar Elves,m19,Core Set 2019,314,normal,common,3,1234,1a2b3c4d-0000-4000-8000-000000000001,0.25,false,false,near_mint,en,USD
"Ral, Storm Conduit",war,War of the Spark,211,foil,rare,1,1235,1a2b3c4d-0000-4000-8000-000000000002,0.5,false,false,near_mint,en,USD
Llanowar Elves,m19,Core Set 2019,314,foil,common,1,1234,1a2b3c4d-0000-4000-8000-000000000001,0.25,false,false,near_mint,en,USD
`;

test('parseCSV handles quotes, commas and CRLF', () => {
  const rows = parseCSV('a,b\r\n"x, y","he said ""hi"""\r\n');
  assert.deepEqual(rows, [['a', 'b'], ['x, y', 'he said "hi"']]);
});

test('ManaBox export maps to Scryfall ID identifiers and merges duplicates', () => {
  const { format, rows, errors } = csvToImportRows(MANABOX);
  assert.equal(format, 'ManaBox');
  assert.equal(errors.length, 0);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[1].identifier, { id: '1a2b3c4d-0000-4000-8000-000000000002' });
  assert.equal(rows[1].foil, true);
  const merged = mergeRows(rows);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].qty, 4);
  assert.equal(merged[0].foilQty, 1);
});

test('generic CSVs fall back to set+number or name', () => {
  const tcg = csvToImportRows('Quantity,Name,Set,Card Number\n2,Shock,Dominaria,1\n1,Opt,xln,65\n');
  assert.deepEqual(tcg.rows[0].identifier, { name: 'Shock' });
  assert.deepEqual(tcg.rows[1].identifier, { set: 'xln', collector_number: '65' });
  const semi = csvToImportRows('Card Name;Qty\nGiant Growth;4\n');
  assert.deepEqual(semi.rows[0], { identifier: { name: 'Giant Growth' }, qty: 4, foil: false, label: 'Giant Growth', line: 2 });
  assert.equal(csvToImportRows('foo,bar\n1,2').errors.length, 1);
});

test('mana requirements handle hybrid', () => {
  const c = slimCard({ name: 'X', mana_cost: '{1}{G}{W/U}', type_line: 'Creature', legalities: {} });
  assert.deepEqual(castRequirements(c), [['G'], ['W', 'U']]);
  assert.ok(canCastWith(c, new Set(['G', 'U'])));
  assert.ok(!canCastWith(c, new Set(['G', 'B'])));
});

test('roles are detected from oracle text', () => {
  const r = (t) => [...cardRoles(slimCard({ name: 'x', type_line: 'Instant', oracle_text: t, legalities: {} }))];
  assert.deepEqual(r('Destroy target creature.'), ['removal']);
  assert.deepEqual(r('Draw two cards.'), ['draw']);
  assert.deepEqual(r('Search your library for a basic land card, put it onto the battlefield tapped.'), ['ramp']);
  assert.ok(r('Destroy all creatures.').includes('wipe'));
  // Pump and protection spells are not removal; shrink and bite effects are.
  assert.deepEqual(r('Target creature gets +2/+2 and gains indestructible until end of turn.'), []);
  assert.deepEqual(r('Target creature you control gets +1/+1 until end of turn.'), []);
  assert.deepEqual(r('Target creature an opponent controls gets -3/-3 until end of turn.'), ['removal']);
  assert.deepEqual(r('Target creature you control deals damage equal to its power to target creature you don\'t control.'), ['removal']);
});

test('commander themes include tribes named in text', () => {
  const c = slimCard({ name: 'Elf Queen', type_line: 'Legendary Creature — Elf Noble', oracle_text: 'Other Elves you control get +1/+1.', legalities: {} });
  assert.ok(commanderThemes(c).some((t) => t.key === 'tribe:Elf'));
});

function makePool(copies = 4) {
  return bulkPile().map((c) => slimCard(c)).map((card) => ({ name: card.name, card, available: copies }));
}
const find = (pool, n) => pool.find((e) => e.name === n)?.card;

/** A fake EDHREC page: some cards strongly recommended for the commander. */
function fakeEdh(entries) {
  return { numDecks: 5000, slug: 'elf-queen', cards: new Map(entries.map(([n, incl, syn]) => [nameKey(n), { name: n, incl, syn, list: 'Creatures' }])), themes: [] };
}

/** A combo index shaped like data.combos(). */
function fakeCombos(defs) {
  const list = defs.map(([id, cards, produces, identity, minBracket, requires = []]) => ({
    id, cards, keys: cards.map(nameKey), produces, identity, mask: colorMask(identity.split('')), popularity: 1000, minBracket, mustBeCommander: [], requires, mv: 4,
  }));
  const byCard = new Map();
  list.forEach((c, i) => c.keys.forEach((k) => { if (!byCard.has(k)) byCard.set(k, []); byCard.get(k).push(i); }));
  return { list, byCard };
}

test('pasted lists parse quantities, sets and sections', () => {
  const { rows } = textToImportRows('Commander\n1 Elf Queen\n\nDeck\n1x Sol Ring (C21) 263\n4 Llanowar Elves\nCommand Tower\n// comment\nSideboard\n1 Opt');
  assert.deepEqual(rows.map((r) => [r.label, r.qty, r.section]), [['Elf Queen', 1, 'commander'], ['Sol Ring', 1, 'main'], ['Llanowar Elves', 4, 'main'], ['Command Tower', 1, 'main'], ['Opt', 1, 'side']]);
  assert.deepEqual(rows[1].identifier, { set: 'c21', collector_number: '263' });
  assert.ok(looksLikeCSV(MANABOX));
  assert.ok(!looksLikeCSV('1 Sol Ring\n2 Opt'));
});

test('combo matching finds complete and one-away combos within colors and bracket', () => {
  const idx = fakeCombos([
    [1, ['A', 'B'], ['Infinite mana'], 'G', 2],
    [2, ['A', 'C'], ['Infinite damage'], 'R', 2],
    [3, ['A', 'B', 'D'], ['Win'], 'G', 4],
  ]);
  const have = new Set(['a', 'b']);
  const r = matchCombos(idx, have, { mask: colorMask(['G']), bracket: 5 });
  assert.deepEqual(r.complete.map((c) => c.id), [1]);
  assert.deepEqual(r.oneAway.map((x) => [x.combo.id, x.missingName]), [[3, 'D']]);
  assert.equal(matchCombos(idx, have, { mask: colorMask(['G']), bracket: 3 }).oneAway.length, 0);
});

test('coverage measures how much of a commander deck you own', () => {
  const cmd = { key: 'x', cards: [{ key: 'a', incl: 0.9 }, { key: 'b', incl: 0.1 }, { key: 'forest', incl: 1 }] };
  const cov = coverage(cmd, new Map([['a', 1]]));
  assert.equal(cov.owned, 1);
  assert.equal(cov.considered, 2);
  assert.ok(cov.pct > 0.7 && cov.pct < 0.8);
});

test('commander build is singleton, 100 cards, in identity, and follows EDHREC', () => {
  const pool = makePool();
  const cmd = find(pool, 'Elf Queen');
  const edh = fakeEdh([['Elf Lord', 0.8, 0.5], ['W Creature 6-2', 0.6, 0.3]]);
  const res = buildDeck({ pool, commander: cmd, edh, bracket: 3 });
  const deck = { cards: res.cards, commander: res.commander, bracket: 3 };
  const lookup = (n) => find(pool, n);
  assert.equal(deckSize(deck), 100);
  assert.deepEqual(validateDeck(deck, lookup, () => 4).filter((i) => i.level === 'error'), []);
  assert.ok(res.cards['Elf Lord'] && res.cards['W Creature 6-2'], 'EDHREC picks included even when expensive');
  assert.ok(!Object.keys(res.cards).some((n) => /^[UBR] /.test(n)), 'no off-identity cards');
  assert.equal(res.reasons['Elf Lord'].incl, 0.8);
  assert.match(explain('Elf Lord', res.reasons['Elf Lord'], { commanderName: 'Elf Queen', numDecks: 5000 }), /Played in 80% of 5,000 Elf Queen decks.*synergy \+50%/);
});

test('bracket limits Game Changers and combos', () => {
  const pool = makePool();
  pool.find((e) => e.name === 'G Ramp').card.game_changer = true;
  const cmd = find(pool, 'Elf Queen');
  const idx = fakeCombos([[7, ['G Creature 2-0', 'W Creature 2-0'], ['Infinite tokens'], 'GW', 3]]);
  const b2 = buildDeck({ pool, commander: cmd, bracket: 2, comboIndex: idx });
  assert.ok(!b2.cards['G Ramp'], 'no Game Changers in bracket 2');
  const b4 = buildDeck({ pool, commander: cmd, bracket: 4, comboIndex: idx });
  assert.ok(b4.cards['G Ramp'], 'Game Changers allowed in bracket 4');
  assert.deepEqual(b4.combos, [7]);
  assert.ok(b4.cards['G Creature 2-0'] && b4.cards['W Creature 2-0']);
  pool.find((e) => e.name === 'G Ramp').card.game_changer = false;
});

test('locked cards are kept when auto-filling', () => {
  const pool = makePool();
  const res = buildDeck({ pool, commander: find(pool, 'Elf Queen'), locked: { 'G Creature 6-0': 1 } });
  assert.equal(res.cards['G Creature 6-0'], 1);
  assert.equal(deckSize({ cards: res.cards, commander: res.commander }), 100);
});

test('builder respects availability (physical copies)', () => {
  const pool = makePool(0);
  for (const e of pool) if (e.name.startsWith('G ')) e.available = 1;
  const res = buildDeck({ pool, commander: find(pool, 'Elf Queen') });
  assert.ok(!Object.keys(res.cards).some((n) => n.startsWith('W ')), 'cards with 0 free copies are not used');
});

test('game plan and upgrades', () => {
  const pool = makePool();
  const cmd = find(pool, 'Elf Queen');
  const edh = fakeEdh([['Elf Lord', 0.8, 0.5]]);
  const res = buildDeck({ pool, commander: cmd, edh });
  const lookup = (n) => find(pool, n);
  const plan = gamePlan({ cards: res.cards, commander: res.commander, reasons: res.reasons }, lookup, { edh });
  assert.deepEqual(plan.map((p) => p.title).slice(0, 3), ['The idea', 'Early turns', 'Build your engine']);
  assert.ok(plan.find((p) => p.title === 'Build your engine').cards.includes('Elf Lord'));
  const up = suggestUpgrades({ deckCards: { 'G Creature 1-0': 1, Forest: 30 }, commander: cmd, pool, edh, lookupDeck: lookup });
  assert.deepEqual(up.swaps.map((s) => [s.out.name, s.in.entry.name]), [['G Creature 1-0', 'Elf Lord']]);
});

test('when your collection runs out, recommended cards to buy fill the gap instead of lands', () => {
  const pool = makePool(0);
  const own = ['G Creature 1-0', 'G Creature 2-0', 'W Removal 2', 'G Draw 3'];
  for (const e of pool) if (own.includes(e.name)) e.available = 1;
  const cmd = find(pool, 'Elf Queen');
  const first = buildDeck({ pool, commander: cmd });
  assert.equal(first.shortfall, 63 - own.length, 'reports how many spell slots your cards could not fill');
  // Offer every other G/W spell as a recommended buy (like engine.recommendedToBuy does from EDHREC).
  const buys = makePool(1).filter((e) => !own.includes(e.name) && /^[GW] /.test(e.name)).map((e) => ({ ...e, buy: true }));
  buys.find((e) => e.name === 'G Creature 6-3').card.price = '40.00'; // expensive: should be skipped
  const res = buildDeck({ pool: [...pool, ...buys], commander: cmd });
  const lookup = (n) => find(pool, n);
  for (const n of own) assert.equal(res.cards[n], 1, `owned ${n} used`);
  for (const n of own) assert.ok(!res.toBuy[n], `owned ${n} not marked to buy`);
  const nonland = Object.entries(res.cards).filter(([n]) => !info(lookup(n)).land).reduce((a, [, c]) => a + c, 0);
  assert.equal(nonland, 63, 'all 63 spell slots filled');
  assert.equal(Object.keys(res.toBuy).length, 63 - own.length);
  assert.ok(!res.toBuy['G Creature 6-3'], 'pricey card avoided while cheaper ones exist');
  assert.match(res.notes[0], /59 recommended cards you don't own were added/);
  assert.equal(deckSize({ cards: res.cards, commander: res.commander }), 100);
  assert.equal(explain('G Ramp', res.reasons['G Ramp'], {}).split('.')[0], 'Not in your collection: recommended to buy, because your own cards ran out');
  const issues = validateDeck({ cards: res.cards, commander: res.commander, toBuy: res.toBuy }, lookup, (n) => (own.includes(n) ? 1 : 0));
  assert.ok(!issues.some((i) => i.short && i.msg !== `${cmd.name}: not free in your collection (your commander).`), 'buy cards are not reported as missing');
});

test('eligible spell counts per commander and thin-pool warnings', () => {
  const pool = makePool(1);
  const spellsFor = eligibleSpellCounter(pool);
  // Fixture: per color 6 MV x (4 creatures + removal + draw) + ramp = 37 spells; green also has Elf Lord; colorless Mind Stone = 1.
  assert.equal(spellsFor(['G']), 37 + 1 + 1);
  assert.equal(spellsFor(['G', 'W'], 'Elf Queen'), 38 + 37 + 1, 'GW cards count, the commander itself does not');
  assert.equal(spellsFor([]), 1);
  assert.deepEqual(thinness(80), { needed: 0, level: 'ok' });
  assert.deepEqual(thinness(50), { needed: 13, level: 'some' });
  assert.deepEqual(thinness(10), { needed: 53, level: 'thin' });
  for (const e of pool) e.available = 0;
  assert.equal(eligibleSpellCounter(pool)(['G']), 0, 'cards used in other decks do not count');
});

test('fit preview: strength, strong fits from your bulk, and bracket reachability', () => {
  const pool = makePool(1);
  const cmd = find(pool, 'Elf Queen');
  const edh = fakeEdh([['Elf Lord', 0.8, 0.5], ['W Removal 2', 0.5, 0.2], ['Not Owned Card', 0.9, 0.4]]);
  const p = fitPreview({ pool, commander: cmd, edh, bracket: 2 });
  assert.deepEqual(p.fits.map((f) => f.name), ['Elf Lord', 'W Removal 2'], 'best owned EDHREC cards, best first');
  assert.equal(p.strength.owned, 2);
  assert.equal(p.strength.considered, 3);
  assert.equal(p.strength.level, 'strong');
  assert.equal(p.brackets[2].warn, false);
  assert.equal(p.brackets[3].warn, true, 'no Game Changers or strong combos: bracket 3 is flagged');
  assert.equal(p.brackets[5].warn, true);
  pool.find((e) => e.name === 'G Ramp').card.game_changer = true;
  const idx = fakeCombos([[9, ['G Creature 2-0', 'W Creature 2-0'], ['Infinite tokens'], 'GW', 4]]);
  const q = fitPreview({ pool, commander: cmd, edh, bracket: 4, comboIndex: idx });
  assert.equal(q.gameChangers, 1);
  assert.equal(q.combosByBracket[4], 1);
  assert.equal(q.brackets[3].warn, false);
  assert.equal(q.brackets[4].warn, false, 'a fast combo makes bracket 4 reachable');
  pool.find((e) => e.name === 'G Ramp').card.game_changer = false;
});

test('builder honours a custom land count', () => {
  const pool = makePool();
  const res = buildDeck({ pool, commander: find(pool, 'Elf Queen'), lands: 38 });
  const stats = deckStats({ cards: res.cards, commander: res.commander }, (n) => find(pool, n));
  assert.equal(stats.lands, 38);
  assert.equal(stats.total, 100);
});

test('deck profile follows EDHREC average deck (lands, creatures, curve, ramp)', () => {
  const aggro = { avg: { types: { creature: 33, land: 35 }, curve: { 1: 13, 2: 23, 3: 17, 4: 5, 5: 2, 6: 1 } } };
  const p = deckProfile(aggro);
  assert.equal(p.lands, 35);
  assert.ok(p.creatures[0] > 0.45, 'creature-heavy');
  assert.ok(p.curve[2] > 0.35 && p.curve[6] < 0.05, 'low curve');
  assert.ok(p.roles.ramp <= 5, `aggro needs little ramp (${p.roles.ramp})`);
  const big = deckProfile({ avg: { types: { creature: 20, land: 37 }, curve: { 1: 4, 2: 10, 3: 14, 4: 14, 5: 10, 6: 8, 7: 3 } } });
  assert.ok(big.roles.ramp >= 9, `big decks keep ramp (${big.roles.ramp})`);
  assert.equal(deckProfile(aggro, { lands: 38 }).lands, 38, 'user setting wins');
  assert.equal(deckProfile(null).lands, 36, 'falls back to defaults');
  // The builder follows the profile: fewer 5+ drops for an aggro commander.
  const pool = makePool();
  const cmd = find(pool, 'Elf Queen');
  const look = (n) => find(pool, n);
  const high = (res) => deckStats({ cards: res.cards, commander: res.commander }, look).curve.slice(5).reduce((a, b) => a + b, 0);
  const aggroDeck = buildDeck({ pool, commander: cmd, edh: { ...fakeEdh([]), ...aggro } });
  const bigDeck = buildDeck({ pool, commander: cmd, edh: { ...fakeEdh([]), avg: { types: { creature: 20, land: 37 }, curve: { 1: 4, 2: 10, 3: 14, 4: 14, 5: 10, 6: 8, 7: 3 } } } });
  assert.ok(high(aggroDeck) < high(bigDeck), `aggro ${high(aggroDeck)} vs big ${high(bigDeck)} cards at 5+`);
  assert.equal(deckStats({ cards: aggroDeck.cards, commander: aggroDeck.commander }, look).lands, 35);
});

test('Deck Care suggests goal-directed swaps from owned cards', () => {
  const pool = makePool(1);
  const cmd = find(pool, 'Elf Queen');
  const look = (n) => find(pool, n) || BASIC_CARDS[n];
  const ctx = makeContext({ commander: cmd, bracket: 3 });
  // A weak deck: no removal, no dual land, mostly vanilla creatures.
  const cards = { Forest: 18, Plains: 18 };
  for (const e of pool) if (/^[GW] Creature/.test(e.name) && Object.keys(cards).length < 60) cards[e.name] = 1;
  const answers = deckCare('answers', { deckCards: cards, pool, ctx, lookupCard: look });
  assert.ok(answers.length > 0);
  for (const s of answers) {
    assert.ok(/Removal/.test(s.in.name), `${s.in.name} is removal`);
    assert.ok(!/Removal/.test(s.out.name));
  }
  const mana = deckCare('mana', { deckCards: cards, pool, ctx, lookupCard: look });
  const dual = mana.find((s) => s.in.name === 'Selesnya Guildgate');
  assert.ok(dual && ['Forest', 'Plains'].includes(dual.out.name), 'dual land replaces a basic');
  const protectedCard = 'G Creature 1-0';
  const draw = deckCare('draw', { deckCards: cards, pool, ctx, lookupCard: look, protect: new Set([protectedCard]) });
  assert.ok(draw.every((s) => s.out.name !== protectedCard), 'protected cards are never cut');
});

test('synergy groups and deck-wide cautions from card text', () => {
  const pool = makePool(1);
  const pick = (re) => pool.filter((e) => re.test(e.name)).map((e) => ({ name: e.name, count: 1, card: e.card }));
  const cards = [...pick(/^(G Creature|Elf Lord|Elf Queen)/), ...pick(/^Forest$/)];
  const groups = findSynergies(cards);
  const elves = groups.find((g) => g.key === 'tribe:Elf');
  assert.ok(elves, 'Elf team found');
  assert.ok(elves.payoffs.includes('Elf Lord') && elves.payoffs.includes('Elf Queen'));
  assert.match(elves.needs, /of your \d+ creatures are Elves/);
  assert.ok(!groups.some((g) => g.key === 'counters'), 'counters placed but nothing rewards them: no group');
  const stats = deckStats({ cards: Object.fromEntries(cards.map((x) => [x.name, x.count])) }, (n) => find(pool, n));
  const cautions = deckCautions(cards, stats, ['G']);
  assert.ok(cautions.some((c) => /removal/.test(c)), 'flags light removal');
  assert.ok(cautions.some((c) => /card access/.test(c)), 'flags few draw engines');
});

test('opening hands: library, verdicts and land odds', () => {
  const pool = makePool(1);
  const look = (n) => find(pool, n) || BASIC_CARDS[n];
  const deck = { cards: { Forest: 36, 'G Creature 1-0': 1, 'G Creature 2-0': 1, 'G Creature 6-0': 1 }, commander: 'Elf Queen' };
  const lib = library(deck);
  assert.equal(lib.length, 39);
  assert.ok(!lib.includes('Elf Queen'), 'commander is not in the library');
  let seed = 1;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  assert.notDeepEqual(shuffle(lib, rand), lib);
  assert.equal(verdict(handStats(['Forest', 'G Creature 1-0', 'G Creature 6-0', 'G Creature 6-0', 'G Creature 6-0', 'G Creature 6-0', 'G Creature 6-0'], look)).keep, false, 'one land: mulligan');
  const good = handStats(['Forest', 'Forest', 'Forest', 'G Creature 1-0', 'G Creature 2-0', 'G Creature 6-0', 'G Ramp'], look);
  assert.deepEqual(good, { lands: 3, spells: 4, cheap: 3, ramp: 1 });
  assert.match(verdict(good).text, /^Keep: 3 lands/);
  const p = landOdds(36, 99);
  assert.ok(p > 0.7 && p < 0.8, `36 lands in 99: ${p}`);
});

test('one-paragraph game plan names real cards', () => {
  const pool = makePool(1);
  const pick = (re) => pool.filter((e) => re.test(e.name)).map((e) => ({ name: e.name, count: 1, card: e.card }));
  const cards = [{ ...pick(/^Elf Queen$/)[0], commander: true }, ...pick(/^(G Creature|Elf Lord|G Draw|G Removal)/)];
  const plan = planSummary(cards, { roleOf: (c) => info(c).roles, reasons: { 'Elf Lord': { syn: 0.5 } } });
  assert.match(plan.text, /^Develop Elves[\s\S]*, then use Elf Queen and Elf Lord to strengthen your board\. Keep cards coming with G Draw \d and G Draw \d, and finish/);
  assert.ok(plan.cards.includes('Elf Lord'));
});

test('deck value and cost of cards to buy', () => {
  const mk = (name, usd, type_line) => slimCard({ name, type_line, mana_cost: '{1}', prices: { usd }, legalities: {} });
  const cards = { A: mk('A', '1.50', 'Creature'), B: mk('B', '4.00', 'Instant'), C: mk('C', null, 'Sorcery'), Cmd: mk('Cmd', '10.00', 'Legendary Creature — Elf') };
  const look = (n) => cards[n] || BASIC_CARDS[n];
  const deck = { commander: 'Cmd', cards: { A: 2, B: 1, C: 1, Forest: 30 }, toBuy: { B: 1 } };
  assert.deepEqual(deckCost(deck, look), { total: 17, toBuy: 4, toBuyCount: 1, unpriced: 1 });
  assert.deepEqual(deckCost(deck, look, { commanderOwned: false }), { total: 17, toBuy: 14, toBuyCount: 2, unpriced: 1 });
});

test('unique generated deck titles', () => {
  assert.deepEqual(commanderParts('Mabel, Heir to Cragflame'), { short: 'Mabel', place: 'Cragflame' });
  assert.deepEqual(commanderParts('Beza, the Bounding Spring'), { short: 'Beza', place: 'Bounding Spring' });
  const groups = [{ key: 'targeting' }, { key: 'tribe:Mouse' }];
  const taken = new Set();
  for (let s = 0; s < 25; s++) {
    const t = deckTitle({ commander: 'Mabel, Heir to Cragflame', colors: ['R', 'W'], groups, seed: s, taken });
    assert.ok(!taken.has(t), `unique: ${t}`);
    assert.ok(t.length > 8 && !/undefined|null/.test(t), t);
    taken.add(t);
  }
  const a = deckTitle({ commander: 'Mabel, Heir to Cragflame', colors: ['R', 'W'], groups, seed: 7 });
  assert.equal(deckTitle({ commander: 'Mabel, Heir to Cragflame', colors: ['R', 'W'], groups, seed: 7 }), a, 'same seed, same title');
});

test('beginner guide: keyword glossary and document sections', () => {
  const cards = [
    slimCard({ name: 'A', type_line: 'Creature', mana_cost: '{1}{R}', keywords: ['Valiant', 'Flying'], oracle_text: 'Valiant — Whenever this creature becomes the target...\nFlying', legalities: {} }),
    slimCard({ name: 'B', type_line: 'Enchantment — Class', mana_cost: '{W}', oracle_text: 'Create a Food token.', legalities: {} }),
  ];
  const terms = glossaryFor(cards).map(([k]) => k);
  for (const k of ['Valiant', 'Flying', 'Class', 'Food', 'Token']) assert.ok(terms.includes(k), `${k} in glossary`);
  const html = guideHTML({
    deck: { name: 'Test Deck', commander: 'A', colors: ['R'], bracket: 2 }, commander: cards[0], bracketLabel: 'Core',
    summary: 'Develop your board.', plan: [{ title: 'Early turns', text: 'Play lands.' }], groups: [], cautions: ['Watch out.'], combos: [],
    stats: { total: 100, lands: 36, avgCmc: 2.5 }, cost: { total: 12.5, toBuy: 3, toBuyCount: 1 },
    sections: [{ title: 'Creatures', items: [{ name: 'A', count: 1, card: cards[0], tags: ['Synergy'], why: 'Because.', buy: true }] }],
    toBuy: [{ name: 'A', count: 1, price: '3.00' }], glossary: glossaryFor(cards), landOdds: 0.74, edhUrl: null,
  });
  for (const s of ['<h1>Test Deck</h1>', 'Your game plan', 'Before you play', '74% of the time', 'How to play this deck', 'Things to watch out for', 'Keywords in this deck', 'Decklist', 'TO BUY', 'Shopping list', 'Print / Save as PDF']) {
    assert.ok(html.includes(s), `guide includes ${s}`);
  }
});

test('export text uses set and collector number', () => {
  const pool = makePool();
  const lookup = (n) => find(pool, n);
  const txt = exportText({ cards: { 'Mind Stone': 1, Forest: 3 }, commander: 'Elf Queen' }, lookup);
  assert.match(txt, /^Commander\n1 Elf Queen \(TST\) \d+\n\nDeck\n1 Mind Stone \(TST\) \d+\n3 Forest/);
});


test('fetchCollection batches by 75 and retries 429', async () => {
  let calls = 0;
  const fake = async (url, init) => {
    calls++;
    if (calls === 1) return { ok: false, status: 429, json: async () => ({}) };
    const ids = JSON.parse(init.body).identifiers;
    return { ok: true, status: 200, json: async () => ({ data: ids.filter((i) => i.name !== 'Nope').map((i) => ({ id: i.name })), not_found: ids.filter((i) => i.name === 'Nope') }) };
  };
  const idfs = Array.from({ length: 160 }, (_, k) => ({ name: k === 5 ? 'Nope' : `c${k}` }));
  const progress = [];
  const { cards, notFound } = await fetchCollection(idfs, { fetchImpl: fake, onProgress: (d, t) => progress.push([d, t]) });
  assert.equal(cards.length, 159);
  assert.equal(notFound.length, 1);
  assert.deepEqual(progress, [[75, 160], [150, 160], [160, 160]]);
  assert.equal(calls, 4); // one 429 retried
});
