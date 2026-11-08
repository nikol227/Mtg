// End-to-end test: serves the site, mocks Scryfall, EDHREC and the data/*.json files,
// then imports a ManaBox CSV and a pasted list, builds Commander decks, checks combos,
// game plan, the Combos page, the Upgrade tool and copy tracking.
// Run: node tests/e2e.mjs   (needs Playwright + Chromium). SHOTS_DIR=dir saves screenshots.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { bulkPile, card } from './fixtures.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const shots = process.env.SHOTS_DIR;

const server = createServer(async (req, res) => {
  try {
    const p = join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname.replace(/\/$/, '/index.html')));
    const body = await readFile(p);
    res.writeHead(200, { 'Content-Type': TYPES[extname(p)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
}).listen(0);
const base = `http://localhost:${server.address().port}/`;

const cards = bulkPile();
// Cards that are NOT in the collection (an unowned commander and a combo's missing piece).
const extra = [
  card({ name: 'Popular Guy', cmc: 3, mana_cost: '{2}{G}', colors: ['G'], type_line: 'Legendary Creature — Elf Druid', oracle_text: 'Elves you control have "{T}: Add {G}."', power: '2', toughness: '2', rarity: 'rare' }),
  card({ name: 'Missing Piece', cmc: 2, mana_cost: '{1}{G}', colors: ['G'], type_line: 'Creature — Elf', oracle_text: 'Untap target permanent.', power: '1', toughness: '1', rarity: 'rare' }),
];
const byId = new Map([...cards, ...extra].map((c) => [c.id, c]));
const byName = new Map([...cards, ...extra].map((c) => [c.name.toLowerCase(), c]));

const header = 'Name,Set code,Set name,Collector number,Foil,Rarity,Quantity,ManaBox ID,Scryfall ID,Purchase price,Misprint,Altered,Condition,Language,Purchase price currency';
const csv = [header, ...cards.filter((c) => c.name !== 'Mind Stone').map((c, i) => `"${c.name}",${c.set},Test Set,${c.collector_number},normal,${c.rarity},${/Basic/.test(c.type_line) ? 20 : c.name === "W Creature 6-1" ? 2 : 1},${i},${c.id},0.1,false,false,near_mint,en,USD`),
  'Mystery Card,zzz,Nope,1,normal,common,1,999,ffffffff-ffff-4fff-8fff-ffffffffffff,0,false,false,near_mint,en,USD'].join('\n');

// --- fake data files ---
const names = ['Elf Lord', 'G Creature 2-0', 'W Creature 2-0', 'Missing Piece', 'G Ramp', 'Mind Stone', 'Elf Queen', 'Popular Guy', 'G Creature 3-1', 'W Removal 2'];
const ni = (n) => names.indexOf(n);
const combosJson = {
  updated: '2026-11-01T00:00:00Z', names, features: ['Infinite tokens', 'Infinite mana'], templates: [],
  combos: [
    ['c1', [ni('G Creature 2-0'), ni('W Creature 2-0')], [0], 'GW', 900, 3, [], [], 4],
    ['c2', [ni('Elf Lord'), ni('Missing Piece')], [1], 'G', 800, 2, [], [], 5],
  ],
};
const commandersJson = {
  updated: '2026-11-01T00:00:00Z', names,
  commanders: [
    { n: 'Popular Guy', s: 'popular-guy', d: 9000, ci: 'G', img: null, th: [['elves', 'Elves', 4000]], c: [[ni('Elf Lord'), 70, 40], [ni('G Ramp'), 60, 10], [ni('G Creature 3-1'), 50, 30], [ni('Missing Piece'), 40, 20]] },
    { n: 'Elf Queen', s: 'elf-queen', d: 5000, ci: 'GW', img: null, th: [['elves', 'Elves', 2000]], c: [[ni('Elf Lord'), 80, 50], [ni('W Removal 2'), 50, 20], [ni('G Creature 3-1'), 45, 25]] },
  ],
};
const metaJson = { updated: '2026-11-01T00:00:00Z', gameChangers: ['G Ramp'] };
function edhrecPage(name, ci, list) {
  return {
    header: name,
    panels: { taglinks: [{ slug: 'elves', value: 'Elves', count: 2000 }, { slug: 'tokens', value: 'Tokens', count: 800 }] },
    similar: [],
    container: { json_dict: {
      card: { name, num_decks: 5000, color_identity: ci, image_uris: [] },
      cardlists: [{ header: 'Top Cards', tag: 'topcards', cardviews: list.map(([n, incl, syn]) => ({ name: n, num_decks: incl * 50, potential_decks: 5000, synergy: syn })) }],
    } },
  };
}
const EDH = {
  'elf-queen': edhrecPage('Elf Queen', ['G', 'W'], [['Elf Lord', 80, 0.5], ['W Removal 2', 50, 0.2], ['G Creature 3-1', 45, 0.25], ['W Creature 6-1', 40, 0.3]]),
  'popular-guy': edhrecPage('Popular Guy', ['G'], [['Elf Lord', 70, 0.4], ['G Creature 3-1', 50, 0.3]]),
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: Number(process.env.VW || 1360), height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="488" height="680"><rect width="100%" height="100%" fill="#556"/></svg>';
let apiCalls = 0;
await page.route('https://api.scryfall.com/**', async (route) => {
  const url = route.request().url();
  if (url.includes('/cards/named')) return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: svg });
  apiCalls++;
  const { identifiers } = JSON.parse(route.request().postData());
  const look = (i) => (i.id ? byId.get(i.id) : byName.get((i.name || '').toLowerCase()));
  await route.fulfill({ json: { object: 'list', data: identifiers.map(look).filter(Boolean), not_found: identifiers.filter((i) => !look(i)) } });
});
await page.route(/img\.test|svgs\.scryfall\.io/, (r) => r.fulfill({ status: 200, contentType: 'image/svg+xml', body: svg }));
await page.route('https://json.edhrec.com/**', (r) => {
  const m = r.request().url().match(/commanders\/([a-z0-9-]+)(?:\/([a-z-]+))?\.json/);
  const p = m && EDH[m[1]];
  return p ? r.fulfill({ json: p, headers: { 'access-control-allow-origin': '*' } }) : r.fulfill({ status: 404, body: '' });
});
await page.route('**/data/combos.json', (r) => r.fulfill({ json: combosJson }));
await page.route('**/data/commanders.json', (r) => r.fulfill({ json: commandersJson }));
await page.route('**/data/meta.json', (r) => r.fulfill({ json: metaJson }));

await page.goto(base);
await page.waitForSelector('#dropzone');

// Import CSV
await page.setInputFiles('#csv-file', { name: 'manabox.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
await page.waitForSelector('text=Imported');
assert.match(await page.textContent('#import-panel'), /from a ManaBox file[\s\S]*1 row not found/);
// Paste a list (adds Mind Stone)
await page.click('#paste-box summary');
await page.fill('#paste-text', '1 Mind Stone');
await page.click('#paste-go');
await page.waitForSelector('text=Imported 1 cards');
await page.waitForSelector('#browser .tile');
if (shots) await page.screenshot({ path: `${shots}/1-collection.png` });

// Build: commander list ranked by coverage
await page.click('a[data-tab="build"]');
await page.waitForSelector('[data-cmd="Elf Queen"]');
const firstText = await page.textContent('#cmds .pick');
assert.match(firstText, /You own \d+ of its \d+ most-played cards/);
assert.match(firstText, /\d+ eligible spells of 63 needed/);
assert.match(await page.textContent('[data-cmd="Popular Guy"]'), /needs ~\d+ more G spells/);
if (shots) await page.screenshot({ path: `${shots}/2-commanders.png` });
await page.click('[data-cmd="Elf Queen"]');
await page.waitForSelector('#themes [data-theme="elves"]');
await page.click('#themes [data-theme="elves"]');
await page.click('[data-bracket="4"]');
await page.waitForSelector('#fit .fit-title');
assert.match(await page.textContent('#fit'), /Your collection has \w+ optimized \(bracket 4\) Elves support[\s\S]*Strong fits from your bulk[\s\S]*Elf Lord/);
assert.ok(await page.isVisible('[data-warn="4"]'), 'bracket 4 flagged: only 1 Game Changer and no fast combos');
assert.ok(!(await page.isVisible('[data-warn="3"]')), 'bracket 3 reachable thanks to a combo');
await page.click('#settings summary');
await page.selectOption('#set-lands', '37');
assert.equal(await page.inputValue('#set-lands'), '37');
if (shots) await page.screenshot({ path: `${shots}/3-build.png`, fullPage: true });
await page.click('#go');
await page.waitForSelector('#deck-main .thumb-row');
// A unique title was generated (name box left blank), and the dice rerolls it
const title1 = await page.inputValue('#deck-name');
assert.ok(title1.length > 8 && !/undefined|null/.test(title1), `generated title: ${title1}`);
await page.click('#reroll-name');
const title2 = await page.inputValue('#deck-name');
assert.notEqual(title2, title1, 'reroll gives a new title');
assert.match(await page.textContent('#size-label'), /^100 \/ 100 cards/);
await page.waitForSelector('.plan-summary');
assert.match(await page.textContent('#side'), /The idea[\s\S]*Early turns[\s\S]*How it wins/);
assert.match(await page.textContent('#side'), /G Creature 2-0/, 'combo used as win condition');
assert.match(await page.textContent('.plan-summary'), /^Develop [\s\S]*then use Elf Queen[\s\S]*win by assembling G Creature 2-0 and W Creature 2-0/);
await page.click('#try-hand');
await page.waitForSelector('.hand figure');
assert.equal(await page.locator('.hand figure').count(), 7);
await page.click('#h-draw');
assert.equal(await page.locator('.hand figure').count(), 8);
assert.match(await page.textContent('#modal-body'), /2–4 lands \d+% of the time[\s\S]*(Keep|Mulligan|Risky)/);
if (shots) await page.screenshot({ path: `${shots}/4e-hand.png` });
await page.click('#modal [data-close]');
if (shots) await page.screenshot({ path: `${shots}/4-editor-plan.png` });
await page.click('[data-side="combos"]');
await page.waitForSelector('.combo');
assert.match(await page.textContent('#side'), /In this deck \(1\)[\s\S]*Infinite tokens[\s\S]*One card away \(1\)[\s\S]*Missing Piece/);
if (shots) await page.screenshot({ path: `${shots}/5-editor-combos.png` });
// Hovering a thumbnail shows the large preview
await page.hover('#deck-main .thumb-row[data-card="Elf Lord"] .thumb-img');
assert.ok(await page.isVisible('#hover-preview.show'), 'hover preview appears');
await page.mouse.move(0, 0);
// Explanation in the card dialog
await page.click('#deck-main .thumb-row[data-card="Elf Lord"]');
await page.waitForSelector('#modal-body .notice');
assert.match(await page.textContent('#modal-body .notice'), /Played in 80% of 5,000 Elf Queen decks/);
await page.click('#modal [data-close]');
// Strategy view groups by role with chips; header shows lands and avg mana value
assert.match(await page.textContent('#size-label'), /100 \/ 100 cards · \d+ lands · avg mana value \d\.\d\d/);
await page.click('#view-mode [data-mode="strategy"]');
await page.waitForSelector('#deck-main .role');
assert.match(await page.textContent('#deck-main'), /Combo pieces[\s\S]*Commander synergy[\s\S]*Lands/);
if (shots) await page.screenshot({ path: `${shots}/4b-strategy.png` });
// Swap a card for an owned one in the same role
const before = await page.evaluate(() => document.querySelectorAll('#deck-main [data-swap]').length);
assert.ok(before > 50, 'swap buttons on cards');
await page.click('#deck-main [data-swap="W Removal 1"]');
await page.waitForSelector('#modal [data-swap-in]');
const swapIn = await page.getAttribute('#modal [data-swap-in]', 'data-swap-in');
await page.click('#modal [data-swap-in]');
await page.waitForSelector(`#deck-main [data-card="${swapIn}"]`);
assert.ok(!(await page.$('#deck-main [data-card="W Removal 1"]')), 'old card removed');
assert.equal(await page.textContent('#size-label').then((t) => t.split(' ')[0]), '100');
await page.click('#view-mode [data-mode="grid"]');
// Synergies tab: creature-type team found from card text
await page.click('[data-side="synergy"]');
await page.waitForSelector('.syn-group');
assert.match(await page.textContent('#side-body'), /Build an Elf army[\s\S]*What it needs/);
if (shots) await page.screenshot({ path: `${shots}/4d-synergy.png` });
// Deck Care (Optimize tab): goal-directed swaps from owned cards
await page.click('[data-side="care"]');
await page.waitForSelector('#care-goals');
await page.click('#care-goals [data-goal="answers"]');
await page.waitForSelector('#care-look:not(:has(.spinner))');
assert.match(await page.textContent('#side-body'), /Find swaps from cards you already own[\s\S]*Cards to look for/);
if (await page.$('#care-apply')) {
  await page.click('#care-apply');
  await page.waitForSelector('text=/Applied \\d+ swap/');
  assert.match(await page.textContent('#size-label'), /^100 \/ 100 cards/);
}
if (shots) await page.screenshot({ path: `${shots}/4c-care.png` });
await page.click('[data-side="stats"]');
await page.waitForSelector('.chart');
assert.match(await page.textContent('#side-body'), /37\s*lands/, 'land-count setting applied');
await page.click('#export');
assert.match(await page.inputValue('#ex-text'), /^Commander\n1 Elf Queen \(TST\) \d+/);
await page.click('#modal [data-close]');

// Unowned popular commander: copies already used by deck 1 are not reused
await page.click('a[data-tab="build"]');
await page.waitForSelector('[data-cmd="Popular Guy"]');
assert.match(await page.textContent('[data-cmd="Popular Guy"]'), /Commander not owned/);
await page.click('[data-cmd="Popular Guy"]');
await page.waitForSelector('#themes [data-theme]');
await page.click('#go');
await page.waitForSelector('#deck-main .thumb-row');
assert.match(await page.textContent('#issues'), /Popular Guy: not free in your collection \(your commander\)/);
// Printable beginner's guide opens in a new tab with every section, incl. the shopping list
const [guide] = await Promise.all([page.waitForEvent('popup'), page.click('#print-guide')]);
await guide.waitForLoadState();
const guideText = await guide.textContent('main');
for (const s of ['Your game plan', 'Before you play', 'How to play this deck', 'Decklist', 'Shopping list', 'Popular Guy (commander)']) {
  assert.ok(guideText.includes(s), `guide has ${s}`);
}
if (shots) await guide.screenshot({ path: `${shots}/5c-guide.png`, fullPage: false });
await guide.close();
// Costs: whole-deck value, and what you'd need to buy (cards marked to buy + the unowned commander)
assert.match(await page.textContent('#cost-label'), /Deck value \$\d+\.\d\d · To buy: \$\d+\.\d\d \(\d+ cards\)/);
const overlap = await page.evaluate(async () => {
  const req = indexedDB.open('mtg-bulk-builder');
  const db = await new Promise((r) => { req.onsuccess = () => r(req.result); });
  const decks = await new Promise((r) => { const q = db.transaction('decks').objectStore('decks').getAll(); q.onsuccess = () => r(q.result); });
  const used = {};
  for (const d of decks) for (const [n, c] of Object.entries(d.cards)) used[n] = (used[n] || 0) + c - (d.toBuy?.[n] || 0);
  return Object.entries(used).filter(([n, c]) => !['Forest', 'Plains', 'Island', 'Swamp', 'Mountain'].includes(n) && c > 1);
});
assert.deepEqual(overlap, [], 'no card used more times than owned across decks');
// The pile can't fill a second deck, so EDHREC recommendations you'd need to buy fill the gap.
await page.click('[data-side="buy"]');
await page.waitForSelector('#copy-buy');
assert.match(await page.textContent('#side'), /To buy[\s\S]*Elf Lord/);
assert.match(await page.textContent('#issues'), /recommended cards you don't own were added/);
if (shots) await page.screenshot({ path: `${shots}/5b-to-buy.png` });

// Combos page
await page.click('a[data-tab="combos"]');
await page.waitForSelector('.combo');
assert.equal(await page.textContent('#n-ready'), '1');
assert.equal(await page.textContent('#n-one'), '1');
await page.click('[data-tab="one"]');
await page.waitForSelector('text=Missing:');
if (shots) await page.screenshot({ path: `${shots}/6-combos.png` });

// Upgrade a pasted deck
await page.click('a[data-tab="upgrade"]');
await page.fill('#list', 'Commander\n1 Elf Queen\n\nDeck\n1 Test Token\n1 G Creature 1-1\n30 Forest');
await page.click('#go');
await page.waitForSelector('.swap');
if (shots) await page.screenshot({ path: `${shots}/7-upgrade.png` });
await page.click('#save');
await page.waitForSelector('#deck-main .thumb-row');

await page.click('a[data-tab="decks"]');
await page.waitForSelector('.deck-tile');
assert.equal(await page.locator('.deck-tile').count(), 3);
if (shots) await page.screenshot({ path: `${shots}/8-decks.png` });

// Phone width: no horizontal scroll in the editor
await page.setViewportSize({ width: 390, height: 844 });
await page.click('.deck-tile >> nth=0');
await page.waitForSelector('#deck-main .thumb-row');
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
assert.ok(overflow <= 0, `horizontal overflow ${overflow}px`);
if (shots) await page.screenshot({ path: `${shots}/9-phone.png` });

assert.deepEqual(errors, []);
assert.ok(apiCalls > 0);
await browser.close();
server.close();
console.log('e2e ok');
