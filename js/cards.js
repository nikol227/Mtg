// Card helpers: trimming Scryfall data, mana parsing, role/theme detection, scoring.
// Pure functions only (no DOM), so they can be unit-tested under Node.

export const COLORS = ['W', 'U', 'B', 'R', 'G'];
export const COLOR_NAMES = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green', C: 'Colorless' };
export const BASIC_FOR_COLOR = { W: 'Plains', U: 'Island', B: 'Swamp', R: 'Mountain', G: 'Forest', C: 'Wastes' };
export const BASIC_NAMES = new Set(['Plains', 'Island', 'Swamp', 'Mountain', 'Forest', 'Wastes',
  'Snow-Covered Plains', 'Snow-Covered Island', 'Snow-Covered Swamp', 'Snow-Covered Mountain', 'Snow-Covered Forest']);

/** Reduce a full Scryfall card object to the fields this app uses (keeps IndexedDB small). */
export function slimCard(c) {
  const faces = c.card_faces || [];
  const front = faces[0] || {};
  const img = c.image_uris || front.image_uris || {};
  const backImg = faces[1] && faces[1].image_uris ? faces[1].image_uris : null;
  const oracle = c.oracle_text ?? faces.map((f) => f.oracle_text || '').join('\n//\n');
  const colors = c.colors ?? [...new Set(faces.flatMap((f) => f.colors || []))];
  return {
    id: c.id,
    oracle_id: c.oracle_id || front.oracle_id || null,
    name: c.name,
    set: c.set,
    set_name: c.set_name,
    cn: c.collector_number,
    rarity: c.rarity,
    layout: c.layout,
    cmc: c.cmc ?? front.cmc ?? 0,
    mana_cost: c.mana_cost ?? front.mana_cost ?? '',
    type_line: c.type_line || front.type_line || '',
    front_type: front.type_line || c.type_line || '',
    oracle_text: oracle,
    colors,
    color_identity: c.color_identity || [],
    keywords: c.keywords || [],
    produced_mana: c.produced_mana || [],
    power: c.power ?? front.power ?? null,
    toughness: c.toughness ?? front.toughness ?? null,
    edhrec_rank: c.edhrec_rank ?? null,
    legalities: {
      commander: c.legalities?.commander || 'not_legal',
      pauper: c.legalities?.pauper || 'not_legal',
      vintage: c.legalities?.vintage || 'not_legal',
    },
    img: img.normal || null,
    img_small: img.small || null,
    img_back: backImg ? backImg.normal : null,
    price: c.prices?.usd || c.prices?.usd_foil || null,
    game_changer: !!c.game_changer,
  };
}

/** Name key that matches across Scryfall, EDHREC and Commander Spellbook (front face, case-insensitive). */
export function nameKey(name) {
  return String(name).split(' // ')[0].normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

/** EDHREC URL slug for a commander name, e.g. "Atraxa, Praetors' Voice" -> "atraxa-praetors-voice". */
export function edhrecSlug(name) {
  return String(name).split(' // ')[0].normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/['’,.!?]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** Cards that bracket rules care about. */
export const isMassLandDenial = (c) => /(destroy|exile) all (nonbasic )?lands|each player sacrifices (all|a|two|half) lands?|lands don't untap|armageddon/i.test(c.oracle_text || '');
export const isExtraTurn = (c) => /take an extra turn/i.test(c.oracle_text || '');

/** Split a mana cost like "{2}{G}{G/W}" into symbols ["2","G","G/W"]. */
export function manaSymbols(cost) {
  if (!cost) return [];
  return [...cost.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
}

/**
 * Colour requirements to cast a card: an array of "options" sets.
 * Each entry is a list of colours, any one of which satisfies that symbol.
 * e.g. {G}{W/U} -> [["G"], ["W","U"]]
 */
export function castRequirements(card) {
  const costs = card.mana_cost.split(' // ');
  const reqs = [];
  for (const cost of costs.slice(0, 1)) { // front face is what you cast (MDFC backs are optional)
    for (const sym of manaSymbols(cost)) {
      const cols = COLORS.filter((c) => sym.includes(c));
      if (!cols.length) continue;
      // "2/W" (twobrid) or "W/P" (phyrexian) still need W in practice; "W/U" hybrid needs either.
      reqs.push(cols);
    }
  }
  return reqs;
}

export function canCastWith(card, colorSet) {
  return castRequirements(card).every((opts) => opts.some((c) => colorSet.has(c)));
}

/** Count coloured pips per colour (hybrid split evenly) – used to share out basic lands. */
export function pipCounts(card) {
  const out = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  for (const opts of castRequirements(card)) for (const c of opts) out[c] += 1 / opts.length;
  return out;
}

export function colorMask(colors) {
  let m = 0;
  for (const c of colors) {
    const i = COLORS.indexOf(c);
    if (i >= 0) m |= 1 << i;
  }
  return m;
}

export function maskToColors(mask) {
  return COLORS.filter((_, i) => mask & (1 << i));
}

export const isLand = (c) => /\bLand\b/.test(c.front_type);
export const isBasic = (c) => BASIC_NAMES.has(c.name) || (/\bBasic\b/.test(c.front_type) && isLand(c));
export const isCreature = (c) => /\bCreature\b/.test(c.front_type);
export const isLegendary = (c) => /\bLegendary\b/.test(c.front_type);

export function canBeCommander(c) {
  return (isLegendary(c) && isCreature(c)) || /can be your commander/i.test(c.oracle_text);
}

/** Cards that are not real playable Magic cards (tokens, art cards, un-cards, emblems...). */
export function isPlayable(c) {
  const v = c.legalities.vintage;
  if (v === 'legal' || v === 'restricted') return true;
  return false;
}

export function anyNumberAllowed(c) {
  return isBasic(c) || /A deck can have any number of cards named/i.test(c.oracle_text);
}

export const TYPE_ORDER = ['Creature', 'Planeswalker', 'Instant', 'Sorcery', 'Artifact', 'Enchantment', 'Battle', 'Land'];

export function primaryType(c) {
  const t = c.front_type;
  if (/\bLand\b/.test(t)) return 'Land';
  for (const ty of TYPE_ORDER) if (new RegExp(`\\b${ty}\\b`).test(t)) return ty;
  return 'Other';
}

export function subtypes(c) {
  const t = c.front_type;
  const i = t.indexOf('—');
  if (i < 0) return [];
  return t.slice(i + 1).trim().split(/\s+/).filter(Boolean);
}

// ---------- Roles ----------

const ROLE_PATTERNS = {
  removal: [
    /(destroy|exile) target (creature|permanent|nonland permanent|artifact|enchantment|planeswalker|nonblack|nonwhite|nonartifact|attacking|tapped)/i,
    /deals? (\d+|x) damage to (any target|target creature|target attacking|each creature|target player or planeswalker|target creature or planeswalker)/i,
    /target creature gets -\d+\/-\d+/i,
    /target creature (an opponent controls )?(gets|loses)/i, // weak, filtered below
    /fights? (target|another target|up to one target)/i,
    /return target (creature|nonland permanent).{0,30}to its owner's hand/i,
    /target (player|opponent) sacrifices/i,
    /counter target (spell|creature spell|noncreature spell)/i,
  ],
  wipe: [/(destroy|exile) (all|each) (creatures|nonland permanents|other creatures)/i, /all creatures get -\d+\/-\d+/i, /deals? \d+ damage to each creature/i],
  draw: [/draws? (a|two|three|four|x|that many) cards?/i, /investigate/i, /look at the top .{1,20} cards?.{0,80}put (one|two|it|them|that card) into your hand/i],
  ramp: [/search your library for (a|up to two|two) (basic )?(land|forest|plains|island|swamp|mountain)/i, /add \{[WUBRGC]\}|add one mana|add (two|three) mana|mana of any (one )?colou?r/i, /put a land card from your hand onto the battlefield/i, /you may play an additional land/i],
};

const WEAK_REMOVAL = /target creature (an opponent controls )?(gets|loses)/i;

export function cardRoles(c) {
  const text = c.oracle_text || '';
  const roles = new Set();
  if (isLand(c)) return roles;
  for (const [role, pats] of Object.entries(ROLE_PATTERNS)) {
    for (const p of pats) {
      if (p === WEAK_REMOVAL) {
        if (/gets -\d+\/-\d+/i.test(text)) roles.add('removal');
        continue;
      }
      if (p.test(text)) { roles.add(role); break; }
    }
  }
  // A creature that "adds mana" is a mana dork: ramp. A creature with "deals damage to any target" on ETB counts too.
  if (roles.has('wipe')) roles.add('removal');
  return roles;
}

// ---------- Themes ----------

export const THEMES = [
  { key: 'counters', label: '+1/+1 counters', test: (c) => /\+1\/\+1 counter|proliferate/i.test(c.oracle_text) },
  { key: 'tokens', label: 'Tokens', test: (c) => /create[^.]{0,60}token/i.test(c.oracle_text) },
  { key: 'sacrifice', label: 'Sacrifice', test: (c) => /sacrifice (a|an|another|two|one or more) (creature|permanent|artifact)|whenever (a|another) creature you control dies/i.test(c.oracle_text) },
  { key: 'graveyard', label: 'Graveyard', test: (c) => /from your graveyard|\bmill|flashback|unearth|return target creature card from your graveyard|escape|surveil/i.test(c.oracle_text) },
  { key: 'spells', label: 'Instants & sorceries', test: (c) => /instant or sorcery|noncreature spell|prowess/i.test(c.oracle_text) || /\b(Instant|Sorcery)\b/.test(c.front_type) && /copy|draw|damage/i.test(c.oracle_text) },
  { key: 'artifacts', label: 'Artifacts', test: (c) => /\bartifacts?\b/i.test(c.oracle_text) || /\bArtifact\b/.test(c.front_type) },
  { key: 'enchantments', label: 'Enchantments', test: (c) => /\benchantments?\b|constellation/i.test(c.oracle_text) || /\bEnchantment\b/.test(c.front_type) },
  { key: 'lifegain', label: 'Lifegain', test: (c) => /gains? (\d+|x|that much) life|lifelink|whenever you gain life/i.test(c.oracle_text) || c.keywords.includes('Lifelink') },
  { key: 'flyers', label: 'Flyers', test: (c) => c.keywords.includes('Flying') || /creatures? you control (gain|have) flying/i.test(c.oracle_text) },
  { key: 'aggro', label: 'Go wide / aggro', test: (c) => /creatures you control get \+|haste|double strike|first strike/i.test(c.oracle_text) || (isCreature(c) && c.cmc <= 2 && Number(c.power) >= 2) },
  { key: 'lands', label: 'Landfall / lands', test: (c) => /landfall|whenever a land enters|play an additional land|land cards? from your graveyard/i.test(c.oracle_text) },
  { key: 'equipment', label: 'Equipment & Auras', test: (c) => /\b(Equipment|Aura)\b/.test(c.front_type) || /equipped creature|enchanted creature|whenever .{0,20}becomes the target/i.test(c.oracle_text) },
  { key: 'control', label: 'Control', test: (c) => /counter target|draw (two|three) cards|destroy all|exile all/i.test(c.oracle_text) },
];

export function plural(t) {
  const irregular = { Elf: 'Elves', Dwarf: 'Dwarves', Wolf: 'Wolves', Werewolf: 'Werewolves', Fungus: 'Fungi', Octopus: 'Octopuses', Mouse: 'Mice', Ox: 'Oxen', Sphinx: 'Sphinxes', Fox: 'Foxes' };
  return irregular[t] || (t.endsWith('s') ? t : `${t}s`);
}

export function tribeTheme(type) {
  const re = new RegExp(`\\b(${type}|${plural(type)})\\b`);
  return {
    key: `tribe:${type}`,
    label: `${type} tribal`,
    tribe: type,
    test: (c) => (isCreature(c) && (subtypes(c).includes(type) || c.keywords.includes('Changeling'))) || re.test(c.oracle_text),
  };
}

/** A user-typed theme: matches card text or type line. */
export function textTheme(text) {
  const needle = text.trim().toLowerCase();
  return {
    key: `text:${needle}`,
    label: `“${text.trim()}”`,
    test: (c) => (c.oracle_text || '').toLowerCase().includes(needle) || c.type_line.toLowerCase().includes(needle) || c.name.toLowerCase().includes(needle),
  };
}

export function themeFromKey(key) {
  if (!key) return null;
  if (key.startsWith('tribe:')) return tribeTheme(key.slice(6));
  if (key.startsWith('text:')) return textTheme(key.slice(5));
  return THEMES.find((t) => t.key === key) || null;
}

/** Themes a commander cares about, inferred from its own text. */
export function commanderThemes(cmd) {
  const out = THEMES.filter((t) => t.key !== 'aggro' && t.key !== 'control' && t.test(cmd));
  const text = cmd.oracle_text || '';
  // Tribes named in the commander's text ("other Elves you control", "Zombie creature")
  const tribes = new Set();
  for (const m of text.matchAll(/\b([A-Z][a-z]+)s?\b(?= (you control|creature|spells?|cards?|tokens?))/g)) tribes.add(m[1]);
  for (const t of subtypes(cmd)) if (new RegExp(`\\b(${t}|${plural(t)})\\b`).test(text)) tribes.add(t);
  const NOT_TRIBES = new Set(['Creature', 'Artifact', 'Enchantment', 'Land', 'Instant', 'Sorcery', 'Spell', 'Other', 'Each', 'Legendary', 'Token', 'Noncreature', 'Nonland', 'Target', 'Whenever', 'When', 'Equipment', 'Aura', 'Planeswalker', 'Card', 'Basic', 'Attacking', 'Blocking']);
  for (const t of tribes) if (!NOT_TRIBES.has(t)) out.push(tribeTheme(t));
  return out;
}

// ---------- Scoring ----------

/** General card quality 0..100. EDHREC rank is the best popularity signal Scryfall gives us. */
export function quality(c) {
  const r = c.edhrec_rank;
  let q = r ? Math.max(0, 100 - 20 * Math.log10(r)) : 15;
  if (isCreature(c) && c.power != null && c.toughness != null) {
    const p = Number(c.power) || 0;
    const t = Number(c.toughness) || 0;
    if (p + t >= 2 * c.cmc + 2) q += 6; // efficient body
    if (c.cmc >= 3 && p + t <= c.cmc && !(c.oracle_text || '').length) q -= 10; // weak vanilla
  }
  if (c.keywords.length) q += Math.min(6, c.keywords.length * 2);
  return q;
}
