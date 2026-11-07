// End-to-end smoke test: serves the site, mocks Scryfall, imports a ManaBox CSV,
// builds a 60-card deck and a Commander deck, and checks copy tracking.
// Run: node tests/e2e.mjs   (needs Playwright + Chromium)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { bulkPile } from './fixtures.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
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
const byId = new Map(cards.map((c) => [c.id, c]));
// ManaBox-style CSV with 2 copies of everything (and 20 of each basic).
const header = 'Name,Set code,Set name,Collector number,Foil,Rarity,Quantity,ManaBox ID,Scryfall ID,Purchase price,Misprint,Altered,Condition,Language,Purchase price currency';
const csv = [header, ...cards.map((c, i) => `"${c.name}",${c.set},Test Set,${c.collector_number},normal,${c.rarity},${/Basic/.test(c.type_line) ? 20 : 2},${i},${c.id},0.1,false,false,near_mint,en,USD`),
  'Mystery Card,zzz,Nope,1,normal,common,1,999,ffffffff-ffff-4fff-8fff-ffffffffffff,0,false,false,near_mint,en,USD'].join('\n');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });

let apiCalls = 0;
await page.route('https://api.scryfall.com/**', async (route) => {
  apiCalls++;
  const { identifiers } = JSON.parse(route.request().postData());
  const data = identifiers.map((i) => byId.get(i.id)).filter(Boolean);
  const notFound = identifiers.filter((i) => !byId.has(i.id));
  await route.fulfill({ json: { object: 'list', data, not_found: notFound } });
});
await page.route(/img\.test|svgs\.scryfall\.io/, (r) => r.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="488" height="680"><rect width="100%" height="100%" fill="#556"/></svg>' }));

await page.goto(base);
await page.waitForSelector('#dropzone');
if (shots) await page.screenshot({ path: `${shots}/1-empty.png` });

// Import
await page.setInputFiles('#csv-file', { name: 'manabox.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
await page.waitForSelector('text=Imported');
const summary = await page.textContent('#import-panel');
assert.match(summary, /from a ManaBox file/);
assert.match(summary, /1 row not found/);
assert.equal(apiCalls, Math.ceil((cards.length + 1) / 75), `batched calls: ${apiCalls}`);
await page.waitForSelector('#browser .tile');
if (shots) await page.screenshot({ path: `${shots}/2-collection.png` });

// Re-import is served from cache for known IDs (only the unknown one is refetched)
apiCalls = 0;
await page.check('input[name="imode"][value="replace"]');
page.once('dialog', (d) => d.accept());
await page.setInputFiles('#csv-file', { name: 'manabox.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
await page.waitForSelector('text=Imported');
assert.equal(apiCalls, 1, 'cached cards are not refetched');

// Build a 60-card G/W deck
await page.click('a[data-tab="build"]');
await page.click('[data-format="casual"]');
await page.waitForSelector('#csugg .pick');
await page.click('#ctoggle [data-c="G"]');
await page.click('#ctoggle [data-c="W"]');
await page.waitForSelector('#themes [data-theme="tribe:Elf"]');
await page.click('#themes [data-theme="tribe:Elf"]');
if (shots) await page.screenshot({ path: `${shots}/3-build.png`, fullPage: true });
await page.click('#go');
await page.waitForSelector('#deck-main .tile');
assert.equal(await page.textContent('#size-label'), '60 / 60 cards');
if (shots) await page.screenshot({ path: `${shots}/4-editor.png` });

// Copy tracking: a second G deck can only use the remaining copies
await page.click('a[data-tab="build"]');
await page.click('[data-format="limited"]');
await page.click('#ctoggle [data-c="G"]');
await page.waitForSelector('#go');
await page.click('#go');
await page.waitForSelector('#deck-main .tile');
const overlap = await page.evaluate(async () => {
  const req = indexedDB.open('mtg-bulk-builder');
  const db = await new Promise((r) => { req.onsuccess = () => r(req.result); });
  const decks = await new Promise((r) => { const q = db.transaction('decks').objectStore('decks').getAll(); q.onsuccess = () => r(q.result); });
  const used = {};
  for (const d of decks) for (const [n, c] of Object.entries(d.cards)) used[n] = (used[n] || 0) + c;
  return Object.entries(used).filter(([n, c]) => !['Forest', 'Plains', 'Island', 'Swamp', 'Mountain'].includes(n) && c > 2);
});
assert.deepEqual(overlap, [], 'no card used more times than owned across decks');

// Editor: add from the side panel, stats tab, export
await page.click('[data-side="add"]');
await page.waitForSelector('#add-list');
await page.click('[data-side="stats"]');
await page.waitForSelector('.chart');
await page.click('#export');
const exported = await page.inputValue('#ex-text');
assert.match(exported, /^\d+ .+ \(TST\) \d+/m);
await page.click('[data-close]');

// Commander
await page.click('a[data-tab="build"]');
await page.click('[data-format="commander"]');
await page.waitForSelector('[data-cmd="Elf Queen"]');
if (shots) await page.screenshot({ path: `${shots}/5-commanders.png` });
await page.click('[data-cmd="Elf Queen"]');
await page.waitForSelector('#go');
await page.click('#go');
await page.waitForSelector('#deck-main .tile');
assert.equal(await page.textContent('#size-label'), '100 / 100 cards');

// Decks list
await page.click('a[data-tab="decks"]');
await page.waitForSelector('.deck-tile');
assert.equal(await page.locator('.deck-tile').count(), 3);
if (shots) await page.screenshot({ path: `${shots}/6-decks.png` });

// Phone width: no horizontal scroll
await page.setViewportSize({ width: 390, height: 844 });
await page.click('.deck-tile >> nth=0');
await page.waitForSelector('#deck-main .tile');
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
assert.ok(overflow <= 0, `horizontal overflow ${overflow}px`);
if (shots) await page.screenshot({ path: `${shots}/7-phone.png` });

assert.deepEqual(errors, []);
await browser.close();
server.close();
console.log('e2e ok');
