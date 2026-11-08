#!/usr/bin/env node
// Builds the static data files the app reads (run weekly by .github/workflows/update-data.yml):
//   data/combos.json      – every Commander-legal combo from Commander Spellbook, in compact form
//   data/commanders.json  – popular commanders from EDHREC with their most-played cards
//   data/meta.json        – Game Changers list and update time
//
// Commander Spellbook's API only allows browser requests from its own site, so the app can't
// call it directly; downloading it here once a week avoids needing a server.
// EDHREC allows browser requests, so the app fetches full commander pages live; this file
// only pre-computes enough to rank commanders against your collection instantly.
//
// Usage: node scripts/update-data.mjs [--commanders 1000] [--combos-only] [--commanders-only]

import { writeFile, mkdir } from 'node:fs/promises';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const COMMANDER_COUNT = Number(opt('--commanders', 1000));
const CARDS_PER_COMMANDER = 150;
const UA = 'BulkDeckBuilder/1.0 (+https://github.com/nikol227/Mtg; weekly data refresh)';
const OUT = new URL('../data/', import.meta.url);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(url, { tries = 5, ...init } = {}) {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(url, { ...init, headers: { 'User-Agent': UA, Accept: 'application/json', ...(init.headers || {}) } });
      if (res.ok) return await res.json();
      if (res.status === 404 || res.status === 403) return null;
      throw new Error(`${res.status} ${url}`);
    } catch (e) {
      if (i >= tries - 1) throw e;
      await sleep(1000 * 2 ** i);
    }
  }
}

/** Interns strings into a table so each name is stored once. */
function interner() {
  const list = []; const map = new Map();
  return { list, id(s) { let i = map.get(s); if (i === undefined) { i = list.length; list.push(s); map.set(s, i); } return i; } };
}

const BRACKET_OF_TAG = { E: 1, C: 2, O: 2, P: 3, S: 3, R: 4 };

async function combos() {
  const names = interner();
  const features = interner();
  const templates = interner();
  const out = [];
  let url = 'https://backend.commanderspellbook.com/variants/?limit=100&ordering=id&q=legal%3Acommander';
  let pages = 0;
  while (url) {
    const page = await getJSON(url);
    for (const v of page.results) {
      if (v.status !== 'OK' || v.bracketTag === 'B' || v.spoiler) continue;
      if (v.legalities && v.legalities.commander === false) continue;
      const cards = v.uses.map((u) => names.id(u.card.name));
      const cmd = v.uses.filter((u) => u.mustBeCommander).map((u) => names.id(u.card.name));
      const produces = v.produces.map((p) => features.id(p.feature.name));
      const requires = (v.requires || []).map((t) => templates.id(t.template.name));
      // [id, cards, produces, identity, popularity, minBracket, mustBeCommander, requiresTemplates, manaValueNeeded]
      out.push([v.id, cards, produces, v.identity === 'C' ? '' : v.identity, v.popularity || 0, BRACKET_OF_TAG[v.bracketTag] || 4, cmd, requires, v.manaValueNeeded ?? 0]);
    }
    url = page.next;
    if (++pages % 50 === 0) console.log(`  combos: ${out.length} after ${pages} pages`);
    await sleep(120);
  }
  out.sort((a, b) => b[4] - a[4]);
  console.log(`combos: ${out.length}`);
  return { names: names.list, features: features.list, templates: templates.list, combos: out };
}

async function commanders() {
  const names = interner();
  const list = [];
  const perPage = 100;
  const pages = Math.ceil(COMMANDER_COUNT / perPage);
  const cmdViews = [];
  for (let p = 0; p < pages; p++) {
    const url = p === 0 ? 'https://json.edhrec.com/pages/commanders/year.json' : `https://json.edhrec.com/pages/commanders/year-${p}.json`;
    const d = await getJSON(url);
    const views = d?.cardviews || d?.container?.json_dict?.cardlists?.[0]?.cardviews || [];
    cmdViews.push(...views);
    await sleep(250);
  }
  const seen = new Set();
  for (const cv of cmdViews.slice(0, COMMANDER_COUNT)) {
    if (seen.has(cv.slug)) continue;
    seen.add(cv.slug);
    const page = await getJSON(`https://json.edhrec.com/pages/commanders/${cv.slug}.json`);
    await sleep(250);
    if (!page) continue;
    const jd = page.container?.json_dict || {};
    const card = jd.card || {};
    const all = new Map();
    for (const cl of jd.cardlists || []) {
      if (cl.tag === 'newcards') continue;
      for (const c of cl.cardviews || []) {
        if (!c.potential_decks) continue;
        const incl = c.num_decks / c.potential_decks;
        const prev = all.get(c.name);
        if (!prev || prev.incl < incl) all.set(c.name, { incl, syn: c.synergy || 0 });
      }
    }
    const top = [...all.entries()].sort((a, b) => b[1].incl - a[1].incl).slice(0, CARDS_PER_COMMANDER);
    list.push({
      n: cv.name,
      s: cv.slug,
      d: cv.num_decks || card.num_decks || 0,
      ci: (card.color_identity || []).join(''),
      img: card.image_uris?.[0]?.normal || null,
      th: (page.panels?.taglinks || []).slice(0, 8).map((t) => [t.slug, t.value, t.count]),
      c: top.map(([n, x]) => [names.id(n), Math.round(x.incl * 100), Math.round(x.syn * 100)]),
    });
    if (list.length % 100 === 0) console.log(`  commanders: ${list.length}`);
  }
  console.log(`commanders: ${list.length}`);
  return { names: names.list, commanders: list };
}

async function gameChangers() {
  const names = [];
  let url = 'https://api.scryfall.com/cards/search?q=is%3Agamechanger&unique=cards';
  while (url) {
    const d = await getJSON(url);
    names.push(...d.data.map((c) => c.name));
    url = d.has_more ? d.next_page : null;
    await sleep(120);
  }
  return names;
}

await mkdir(OUT, { recursive: true });
const updated = new Date().toISOString();
const only = args.includes('--combos-only') ? 'combos' : args.includes('--commanders-only') ? 'commanders' : null;

if (only !== 'commanders') {
  const c = await combos();
  await writeFile(new URL('combos.json', OUT), JSON.stringify({ updated, source: 'https://commanderspellbook.com', ...c }));
}
if (only !== 'combos') {
  const c = await commanders();
  await writeFile(new URL('commanders.json', OUT), JSON.stringify({ updated, source: 'https://edhrec.com', ...c }));
}
const gc = await gameChangers();
await writeFile(new URL('meta.json', OUT), JSON.stringify({ updated, gameChangers: gc }, null, 1));
console.log('done');
