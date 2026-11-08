// Unique, flavorful deck titles from the commander, colors and the deck's main synergy.
// e.g. "Mabel's Valiant Mouse Brigade", "The Blazing Cragflame Vanguard", "Radiant Swarm of the Bounding Spring".
// Rule-based and seeded, so "reroll" gives a new title each time without any network or AI.

import { plural } from './cards.js';

const COLOR_ADJ = {
  W: ['Radiant', 'Gleaming', 'Hallowed', 'Dawnlit', 'Shining', 'Steadfast'],
  U: ['Tidal', 'Arcane', 'Mistborn', 'Clever', 'Deepwater', 'Starlit'],
  B: ['Grim', 'Shadowed', 'Midnight', 'Wicked', 'Dread', 'Hollow'],
  R: ['Blazing', 'Ember', 'Reckless', 'Cinder', 'Thunderous', 'Fiery'],
  G: ['Wild', 'Verdant', 'Thornwood', 'Feral', 'Overgrown', 'Mossy'],
  C: ['Ironclad', 'Gilded', 'Clockwork', 'Ancient'],
};

const THEME = {
  tribe: { adj: ['Rallying', 'Banded', 'Loyal', 'Mustered'], noun: ['Brigade', 'Battalion', 'Warband', 'Company', 'Muster', 'Uprising', 'Legion', 'Host', 'Crew', 'Patrol'] },
  tokens: { adj: ['Teeming', 'Countless', 'Bustling', 'Swelling'], noun: ['Horde', 'Swarm', 'Parade', 'Throng', 'Multitude', 'Stampede'] },
  targeting: { adj: ['Valiant', 'Daring', 'Bold', 'Heroic'], noun: ['Vanguard', 'Champions', 'Heroes', 'Daredevils', 'Charge'] },
  equipment: { adj: ['Well-Armed', 'Iron-Clad', 'Forged', 'Battle-Ready'], noun: ['Armory', 'Arsenal', 'Smithy', 'Blades', 'Forge'] },
  counters: { adj: ['Ever-Growing', 'Swelling', 'Blooming'], noun: ['Growth', 'Ascension', 'Bloom', 'Harvest'] },
  lifegain: { adj: ['Bountiful', 'Blessed', 'Lifegiving'], noun: ['Feast', 'Banquet', 'Blessing', 'Sanctuary'] },
  sacrifice: { adj: ['Ravenous', 'Hungry', 'Grisly'], noun: ['Offering', 'Ritual', 'Wake', 'Bargain'] },
  spells: { adj: ['Spellbound', 'Crackling', 'Quick-Witted'], noun: ['Spellstorm', 'Grimoire', 'Cantrips', 'Firestorm', 'Lecture'] },
  graveyard: { adj: ['Restless', 'Undying', 'Grave-Bound'], noun: ['Crypt', 'Revival', 'Afterlife', 'Exhumation'] },
  landfall: { adj: ['Wandering', 'Roaming', 'Rumbling'], noun: ['Expedition', 'Frontier', 'Trek', 'Pilgrimage'] },
  artifacts: { adj: ['Tinkering', 'Gearbound', 'Mechanical'], noun: ['Workshop', 'Contraption', 'Foundry', 'Assembly'] },
  default: { adj: ['Bold', 'Wily', 'Unlikely', 'Scrappy'], noun: ['Gambit', 'Gauntlet', 'Crusade', 'Saga', 'Reckoning', 'Venture'] },
};

const ROMAN = ['II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (r, arr) => arr[Math.floor(r() * arr.length)];

/** "Mabel, Heir to Cragflame" -> { short: "Mabel", place: "Cragflame" } */
export function commanderParts(name) {
  const front = String(name || '').split(' // ')[0];
  const [first, epithet = ''] = front.split(/,\s*/);
  const short = first.replace(/^(The|A)\s+/i, '').split(/\s+/).slice(0, 2).join(' ');
  const m = epithet.match(/(?:of|to|from|the)\s+(?:the\s+)?([A-Z][\w'-]*(?:\s+[A-Z][\w'-]*)*)$/);
  return { short, place: m ? m[1] : null };
}

/**
 * Generate a deck title.
 * opts: { commander (name), colors: ['R','W'], groups: findSynergies() result, seed: number|string, taken: Set<string> }
 */
export function deckTitle({ commander, colors = [], groups = [], seed = 0, taken = new Set() }) {
  const r = rng(hash(`${commander}|${seed}`));
  const { short, place } = commanderParts(commander);
  const main = groups[0];
  const tribeGroup = groups.find((g) => g.key.startsWith('tribe:'));
  const tribe = tribeGroup ? tribeGroup.key.slice(6) : null;
  const themeKey = main ? (main.key.startsWith('tribe:') ? 'tribe' : main.key) : 'default';
  const theme = THEME[themeKey] || THEME.default;
  const colorAdj = (colors.length ? colors : ['C']).flatMap((c) => COLOR_ADJ[c] || []);
  const adj = () => (r() < 0.5 ? pick(r, colorAdj) : pick(r, theme.adj));
  const noun = () => pick(r, r() < 0.75 ? theme.noun : THEME.default.noun);
  const templates = [
    () => `${short}'s ${adj()} ${noun()}`,
    () => (tribe ? `The ${adj()} ${tribe} ${noun()}` : `The ${adj()} ${noun()}`),
    () => (place ? `${adj()} ${noun()} of ${/^the\b/i.test(place) ? '' : 'the '}${place}` : `${adj()} ${noun()} of ${short}`),
    () => `${short} and the ${adj()} ${tribe ? plural(tribe) : noun()}`,
    () => (place ? `The ${place} ${noun()}` : `${short}'s ${noun()}`),
  ];
  const takenLower = new Set([...taken].map((t) => t.toLowerCase()));
  // Reject titles that repeat a word root ("Blooming Bloom", "Swelling Swarm" is fine).
  const repeats = (t) => {
    const roots = t.toLowerCase().replace(/'s\b/g, '').split(/[\s-]+/).filter((w) => w.length > 3).map((w) => w.slice(0, 5));
    return new Set(roots).size !== roots.length;
  };
  for (let i = 0; i < 40; i++) {
    const t = pick(r, templates)().replace(/\s+/g, ' ').trim();
    if (!repeats(t) && !takenLower.has(t.toLowerCase())) return t;
  }
  const base = templates[0]();
  for (const n of ROMAN) if (!takenLower.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`;
  return `${base} ${Date.now() % 1000}`;
}
