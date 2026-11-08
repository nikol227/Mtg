import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCSV, csvToImportRows, mergeRows } from '../js/csv.js';
import { slimCard, castRequirements, canCastWith, cardRoles, commanderThemes } from '../js/cards.js';
import {
  buildDeck, validateDeck, deckSize, deckStats, exportText, info, gamePlan, explain, suggestUpgrades, findDeckCombos, makeContext,
} from '../js/builder.js';
import { textToImportRows, looksLikeCSV } from '../js/csv.js';
import { matchCombos, coverage } from '../js/data.js';
import { nameKey, colorMask } from '../js/cards.js';
import { fetchCollection } from '../js/scryfall.js';
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
