// App state: collection, card cache and decks, persisted to IndexedDB.
// Physical copies are tracked by card *name*: a deck can use any printing you own,
// and copies used by one deck are unavailable to every other deck.

import * as db from './db.js';
import { slimCard, isBasic } from './cards.js';
import { csvToImportRows, mergeRows } from './csv.js';
import { fetchCollection } from './scryfall.js';
import { BASIC_CARDS } from './builder.js';

export const state = {
  cards: new Map(), // scryfall id -> slim card
  collection: new Map(), // scryfall id -> { id, qty, foilQty }
  decks: new Map(), // deck id -> deck
  byName: new Map(), // name -> { name, card, owned, ids }
  version: 0, // bumps on every change (used to cache suggestions)
};

const listeners = new Set();
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit() { state.version++; for (const fn of listeners) fn(); }

export async function load() {
  const [cards, coll, decks] = await Promise.all([db.getAll('cards'), db.getAll('collection'), db.getAll('decks')]);
  state.cards = new Map(cards.map((c) => [c.id, c]));
  state.collection = new Map(coll.map((c) => [c.id, c]));
  state.decks = new Map(decks.map((d) => [d.id, d]));
  reindex();
}

function reindex() {
  const byName = new Map();
  for (const { id, qty } of state.collection.values()) {
    const card = state.cards.get(id);
    if (!card || qty <= 0) continue;
    let e = byName.get(card.name);
    if (!e) { e = { name: card.name, card, owned: 0, ids: [] }; byName.set(card.name, e); }
    e.owned += qty;
    e.ids.push(id);
    if (!e.card.img && card.img) e.card = card;
  }
  state.byName = byName;
}

export function lookup(name) {
  return state.byName.get(name)?.card || BASIC_CARDS[name] || null;
}

/** Copies of each card name used across decks (optionally excluding one deck). */
export function usage(excludeDeckId = null) {
  const used = new Map();
  for (const d of state.decks.values()) {
    if (d.id === excludeDeckId) continue;
    for (const [n, c] of Object.entries(d.cards)) used.set(n, (used.get(n) || 0) + c);
    if (d.commander) used.set(d.commander, (used.get(d.commander) || 0) + 1);
  }
  return used;
}

/** Pool for building/editing a deck: everything you own minus copies in other decks. */
export function pool(excludeDeckId = null) {
  const used = usage(excludeDeckId);
  const out = [];
  for (const e of state.byName.values()) {
    const available = isBasic(e.card) ? 999 : e.owned - (used.get(e.name) || 0);
    out.push({ name: e.name, card: e.card, owned: e.owned, available });
  }
  return out;
}

export function availabilityFn(excludeDeckId) {
  const used = usage(excludeDeckId);
  return (name) => {
    const card = lookup(name);
    if (card && isBasic(card)) return Infinity;
    return (state.byName.get(name)?.owned || 0) - (used.get(name) || 0);
  };
}

export function collectionTotals() {
  let total = 0;
  for (const c of state.collection.values()) total += c.qty;
  return { total, unique: state.byName.size, printings: state.collection.size };
}

// ---------- import ----------

function matcher(cards) {
  const byId = new Map(); const bySetCn = new Map(); const byNameSet = new Map(); const byName = new Map();
  for (const c of cards) {
    byId.set(c.id, c);
    bySetCn.set(`${c.set}:${c.collector_number}`.toLowerCase(), c);
    const names = [c.name, ...c.name.split(' // '), ...(c.card_faces || []).map((f) => f.name)];
    for (const n of names) {
      const ln = n.toLowerCase();
      byNameSet.set(`${ln}:${c.set}`, c);
      if (!byName.has(ln)) byName.set(ln, c);
    }
  }
  return (idf) => {
    if (idf.id) return byId.get(idf.id);
    if (idf.collector_number) return bySetCn.get(`${idf.set}:${idf.collector_number}`.toLowerCase());
    if (idf.set) return byNameSet.get(`${idf.name.toLowerCase()}:${idf.set}`);
    return byName.get(idf.name.toLowerCase());
  };
}

/**
 * Import a scanner CSV. mode: 'add' | 'replace'.
 * onProgress({ phase, done, total }) ; returns a summary.
 */
export async function importCSV(text, { mode = 'add', onProgress, signal } = {}) {
  const parsed = csvToImportRows(text);
  const rows = mergeRows(parsed.rows);
  if (!rows.length) return { format: parsed.format, imported: 0, unique: 0, notFound: [], errors: parsed.errors };

  // Only ask Scryfall for printings we don't already have cached.
  const toFetch = [];
  const seen = new Set();
  for (const r of rows) {
    if (r.identifier.id && state.cards.has(r.identifier.id)) continue;
    const k = JSON.stringify(r.identifier);
    if (!seen.has(k)) { seen.add(k); toFetch.push(r.identifier); }
  }
  onProgress?.({ phase: 'fetch', done: 0, total: toFetch.length });
  const { cards: fetched } = toFetch.length
    ? await fetchCollection(toFetch, { signal, onProgress: (d, t) => onProgress?.({ phase: 'fetch', done: d, total: t }) })
    : { cards: [] };

  const match = matcher(fetched);
  const newCards = [];
  for (const c of fetched) {
    if (!state.cards.has(c.id)) { const s = slimCard(c); state.cards.set(s.id, s); newCards.push(s); }
  }

  onProgress?.({ phase: 'save', done: 0, total: 1 });
  if (mode === 'replace') { state.collection.clear(); await db.clear('collection'); }
  const notFound = [];
  let imported = 0;
  const changed = new Map();
  for (const r of rows) {
    const id = r.identifier.id && state.cards.has(r.identifier.id) ? r.identifier.id : match(r.identifier)?.id;
    if (!id) { notFound.push({ label: r.label, line: r.line, qty: r.qty }); continue; }
    const prev = changed.get(id) || state.collection.get(id) || { id, qty: 0, foilQty: 0 };
    const next = { id, qty: prev.qty + r.qty, foilQty: (prev.foilQty || 0) + r.foilQty };
    changed.set(id, next);
    state.collection.set(id, next);
    imported += r.qty;
  }
  await db.putMany('cards', newCards);
  await db.putMany('collection', [...changed.values()]);
  reindex();
  emit();
  return { format: parsed.format, imported, unique: changed.size, notFound, errors: parsed.errors };
}

/** Change how many copies of a card name you own (adjusts the first printing). */
export async function adjustOwned(name, delta) {
  const e = state.byName.get(name);
  if (!e) return;
  if (delta > 0) {
    const rec = state.collection.get(e.ids[0]);
    rec.qty += delta;
    await db.put('collection', rec);
  } else {
    let left = -delta;
    for (const id of e.ids) {
      if (!left) break;
      const rec = state.collection.get(id);
      const take = Math.min(rec.qty, left);
      rec.qty -= take; left -= take;
      if (rec.qty <= 0) { state.collection.delete(id); await db.remove('collection', id); } else await db.put('collection', rec);
    }
  }
  reindex();
  emit();
}

export async function clearCollection() {
  state.collection.clear();
  await db.clear('collection');
  reindex();
  emit();
}

// ---------- decks ----------

export function newDeckId() {
  return `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export async function saveDeck(deck) {
  deck.updated = Date.now();
  state.decks.set(deck.id, deck);
  await db.put('decks', deck);
  emit();
}

export async function deleteDeck(id) {
  state.decks.delete(id);
  await db.remove('decks', id);
  emit();
}

// ---------- backup ----------

export function backupJSON() {
  return JSON.stringify({
    app: 'mtg-bulk-builder',
    version: 1,
    exported: new Date().toISOString(),
    collection: [...state.collection.values()],
    decks: [...state.decks.values()],
    cards: [...state.cards.values()].filter((c) => state.collection.has(c.id)),
  });
}

export async function restoreJSON(text) {
  const data = JSON.parse(text);
  if (data.app !== 'mtg-bulk-builder') throw new Error('This file is not a Bulk Deck Builder backup.');
  await Promise.all(['cards', 'collection', 'decks'].map((s) => db.clear(s)));
  await db.putMany('cards', data.cards || []);
  await db.putMany('collection', data.collection || []);
  await db.putMany('decks', data.decks || []);
  await load();
  emit();
}
