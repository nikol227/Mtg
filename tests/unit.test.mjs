import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCSV, csvToImportRows, mergeRows } from '../js/csv.js';
import { slimCard, castRequirements, canCastWith, cardRoles, commanderThemes } from '../js/cards.js';
import {
  buildDeck, suggestColors, suggestThemes, suggestCommanders, validateDeck, deckSize, deckStats, exportText, info,
} from '../js/builder.js';
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

test('60-card build hits size, colours, copy limits and land count', () => {
  const pool = makePool();
  const res = buildDeck({ pool, format: 'casual', colors: ['G', 'W'] });
  const deck = { format: 'casual', cards: res.cards, colors: ['G', 'W'] };
  const lookup = (n) => pool.find((e) => e.name === n)?.card;
  assert.equal(deckSize(deck), 60);
  const stats = deckStats(deck, lookup);
  assert.equal(stats.lands, 24);
  for (const [name, count] of Object.entries(res.cards)) {
    const card = lookup(name);
    assert.ok(count <= 4 || info(card).basic, `${name} x${count}`);
    if (!info(card).land) assert.ok(canCastWith(card, new Set(['G', 'W'])), `${name} off-colour`);
  }
  assert.ok(res.cards['Selesnya Guildgate'] > 0, 'uses on-colour dual land');
  assert.ok(!res.cards['Test Token'], 'tokens excluded');
  assert.ok(stats.roles.removal >= 4);
  const errors = validateDeck(deck, lookup, () => 4).filter((i) => i.level === 'error');
  assert.deepEqual(errors, []);
});

test('builder respects availability (physical copies)', () => {
  const pool = makePool(1);
  const res = buildDeck({ pool, format: 'casual', colors: ['R'] });
  for (const [name, count] of Object.entries(res.cards)) if (name !== 'Mountain') assert.equal(count, 1, name);
  assert.equal(deckSize({ cards: res.cards }), 60);
});

test('theme pulls in matching cards', () => {
  const pool = makePool();
  const plain = buildDeck({ pool, format: 'limited', colors: ['G'] });
  const elves = buildDeck({ pool, format: 'limited', colors: ['G'], theme: 'tribe:Elf' });
  const count = (cards) => Object.entries(cards).filter(([n]) => /Elf|Creature \d-[13]$/.test(n)).reduce((a, [, c]) => a + c, 0);
  assert.ok(count(elves.cards) >= count(plain.cards));
  assert.equal(deckSize({ cards: elves.cards }), 40);
});

test('commander build is singleton, 100 cards, within identity', () => {
  const pool = makePool();
  const cmd = pool.find((e) => e.name === 'Elf Queen').card;
  const res = buildDeck({ pool, format: 'commander', commander: cmd });
  const deck = { format: 'commander', cards: res.cards, commander: res.commander };
  const lookup = (n) => pool.find((e) => e.name === n)?.card;
  assert.equal(deckSize(deck), 100);
  const errors = validateDeck(deck, lookup, () => 4).filter((i) => i.level === 'error');
  assert.deepEqual(errors, []);
  assert.ok(res.cards['Elf Lord'], 'synergy card included');
});

test('locked cards are kept when filling', () => {
  const pool = makePool();
  const res = buildDeck({ pool, format: 'casual', colors: ['B'], locked: { 'B Creature 6-0': 4 } });
  assert.equal(res.cards['B Creature 6-0'], 4);
  assert.equal(deckSize({ cards: res.cards }), 60);
});

test('pauper excludes non-commons', () => {
  const pool = makePool();
  const res = buildDeck({ pool, format: 'pauper', colors: ['G'] });
  assert.ok(!res.cards['Elf Lord']);
});

test('suggestions rank colours, themes and commanders', () => {
  const pool = makePool();
  const colors = suggestColors(pool, 'casual');
  assert.equal(colors.length, 15);
  assert.ok(colors[0].colors.length >= 1 && colors[0].strength > 0);
  const themes = suggestThemes(pool, 'casual', ['G']);
  assert.ok(themes.some((t) => t.key === 'tribe:Elf'));
  const cmds = suggestCommanders(pool);
  assert.deepEqual(cmds.map((c) => c.name).sort(), ['Elf Queen', 'Ghave Tester']);
});

test('export text uses set and collector number', () => {
  const pool = makePool();
  const lookup = (n) => pool.find((e) => e.name === n)?.card;
  const txt = exportText({ cards: { 'Mind Stone': 2, Forest: 3 }, commander: 'Elf Queen' }, lookup);
  assert.match(txt, /^Commander\n1 Elf Queen \(TST\) \d+\n\nDeck\n2 Mind Stone \(TST\) \d+\n3 Forest/);
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
  assert.equal(calls, 4);
});
