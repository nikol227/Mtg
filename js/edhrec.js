// EDHREC client. EDHREC's JSON pages allow requests from any website, so we fetch
// commander pages live (cached in IndexedDB for a week).
// Page variants: base, a strategy/theme (".../tokens"), or a power bracket (".../core").

import { nameKey, edhrecSlug } from './cards.js';
import * as db from './db.js';

const BASE = 'https://json.edhrec.com/pages/commanders/';
const TTL = 7 * 24 * 3600 * 1000;

/** EDHREC's page name for each Commander bracket. */
export const BRACKETS = [
  { n: 1, slug: 'exhibition', label: 'Exhibition', blurb: 'Theme first, power last. No Game Changers, no infinite combos, no mass land destruction or extra-turn chains.' },
  { n: 2, slug: 'core', label: 'Core', blurb: 'About as strong as a modern precon. No Game Changers or two-card infinite combos.' },
  { n: 3, slug: 'upgraded', label: 'Upgraded', blurb: 'Tuned and synergistic. Up to 3 Game Changers; combos that need several pieces.' },
  { n: 4, slug: 'optimized', label: 'Optimized', blurb: 'High power. Any Game Changers and fast combos are fair game.' },
  { n: 5, slug: 'cedh', label: 'cEDH', blurb: 'Competitive: the strongest cards and combos available.' },
];

/**
 * Fetch and normalise a commander page.
 * Returns { name, slug, numDecks, colorIdentity, themes: [{slug,label,count}], cards: Map(nameKey -> {name, incl, syn, list}), similar }
 * or null when EDHREC has no page for that commander.
 */
export async function commanderPage(nameOrSlug, { theme = null, bracket = null, slug = null, fetchImpl = fetch } = {}) {
  const base = slug || (nameOrSlug.includes(' ') || /[A-Z,']/.test(nameOrSlug) ? edhrecSlug(nameOrSlug) : nameOrSlug);
  const variant = theme || (bracket ? BRACKETS.find((b) => b.n === bracket)?.slug : null);
  const path = variant ? `${base}/${variant}` : base;
  const cacheKey = `edhrec:${path}`;
  let raw = null;
  try {
    const hit = await db.getMeta(cacheKey);
    if (hit && Date.now() - hit.t < TTL) raw = hit.v;
  } catch { /* storage unavailable: just fetch */ }
  if (!raw) {
    const res = await fetchImpl(`${BASE}${path}.json`);
    if (res.status === 404 || res.status === 403) {
      // Theme/bracket page missing for this commander: fall back to the base page.
      return variant ? commanderPage(nameOrSlug, { slug: base, fetchImpl }) : null;
    }
    if (!res.ok) throw new Error(`EDHREC returned ${res.status}`);
    raw = compact(await res.json());
    try { await db.setMeta(cacheKey, { t: Date.now(), v: raw }); } catch { /* ignore */ }
  }
  return expand(raw, base, variant);
}

// Keep only what we use so the cache stays small.
function compact(page) {
  const jd = page.container?.json_dict || {};
  const card = jd.card || {};
  const cards = [];
  for (const cl of jd.cardlists || []) {
    if (cl.tag === 'newcards') continue;
    for (const c of cl.cardviews || []) {
      if (!c.potential_decks) continue;
      cards.push([c.name, c.num_decks / c.potential_decks, c.synergy || 0, cl.header || cl.tag]);
    }
  }
  return {
    name: card.name || page.header || '',
    numDecks: card.num_decks || 0,
    ci: card.color_identity || [],
    img: card.image_uris?.[0]?.normal || null,
    themes: (page.panels?.taglinks || []).map((t) => [t.slug, t.value, t.count]),
    similar: page.similar || [],
    cards,
  };
}

function expand(raw, slug, variant) {
  const cards = new Map();
  for (const [name, incl, syn, list] of raw.cards) {
    const k = nameKey(name);
    const prev = cards.get(k);
    if (!prev || prev.incl < incl) cards.set(k, { name, incl, syn, list });
  }
  return {
    name: raw.name,
    slug,
    variant,
    numDecks: raw.numDecks,
    variantLabel: variant ? (BRACKETS.find((b) => b.slug === variant)?.label || raw.themes.find((t) => t[0] === variant)?.[1] || variant) : null,
    colorIdentity: raw.ci,
    img: raw.img,
    themes: raw.themes.map(([s, label, count]) => ({ slug: s, label, count })),
    similar: raw.similar,
    cards,
  };
}

export function edhrecUrl(slug, variant) {
  return `https://edhrec.com/commanders/${slug}${variant ? `/${variant}` : ''}`;
}
