// Synthetic Scryfall-shaped cards for tests (Scryfall itself isn't reachable from CI).

let n = 0;
const uuid = () => {
  n++;
  const h = n.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${h}`;
};

export function card(o) {
  const id = o.id || uuid();
  return {
    object: 'card',
    id,
    oracle_id: `oracle-${o.name}`,
    name: o.name,
    set: o.set || 'tst',
    set_name: 'Test Set',
    collector_number: o.cn || String(n),
    rarity: o.rarity || 'common',
    layout: 'normal',
    cmc: o.cmc ?? 0,
    mana_cost: o.mana_cost ?? '',
    type_line: o.type_line,
    oracle_text: o.oracle_text || '',
    colors: o.colors ?? [],
    color_identity: o.color_identity ?? o.colors ?? [],
    keywords: o.keywords || [],
    produced_mana: o.produced_mana,
    power: o.power,
    toughness: o.toughness,
    edhrec_rank: o.edhrec_rank ?? 5000 + n,
    legalities: { commander: 'legal', pauper: o.rarity && o.rarity !== 'common' ? 'not_legal' : 'legal', vintage: 'legal', ...(o.legalities || {}) },
    image_uris: { small: `https://img.test/${id}-s.jpg`, normal: `https://img.test/${id}.jpg` },
    prices: { usd: '0.10' },
  };
}

const COLOR_WORD = { W: 'Plains', U: 'Island', B: 'Swamp', R: 'Mountain', G: 'Forest' };

/** A pile of generic cards across all colours, plus some themed ones. */
export function bulkPile() {
  const cards = [];
  for (const c of ['W', 'U', 'B', 'R', 'G']) {
    for (let cmc = 1; cmc <= 6; cmc++) {
      for (let k = 0; k < 4; k++) {
        cards.push(card({
          name: `${c} Creature ${cmc}-${k}`, cmc, mana_cost: `{${cmc - 1}}{${c}}`.replace('{0}', ''), colors: [c],
          type_line: k % 2 ? 'Creature — Elf Warrior' : 'Creature — Human Soldier', power: String(cmc), toughness: String(cmc),
          oracle_text: k === 3 ? 'When this creature enters, put a +1/+1 counter on target creature.' : '',
        }));
      }
      cards.push(card({ name: `${c} Removal ${cmc}`, cmc, mana_cost: `{${cmc - 1}}{${c}}`.replace('{0}', ''), colors: [c], type_line: 'Instant', oracle_text: 'Destroy target creature.' }));
      cards.push(card({ name: `${c} Draw ${cmc}`, cmc, mana_cost: `{${cmc - 1}}{${c}}`.replace('{0}', ''), colors: [c], type_line: 'Sorcery', oracle_text: 'Draw two cards.' }));
    }
    cards.push(card({ name: `${c} Ramp`, cmc: 2, mana_cost: `{1}{${c}}`, colors: [c], type_line: 'Sorcery', oracle_text: 'Search your library for a basic land card, put it onto the battlefield tapped.' }));
    cards.push(card({ name: COLOR_WORD[c], type_line: `Basic Land — ${COLOR_WORD[c]}`, produced_mana: [c], colors: [], color_identity: [c], edhrec_rank: 1 }));
  }
  cards.push(card({ name: 'Selesnya Guildgate', type_line: 'Land — Gate', oracle_text: 'Selesnya Guildgate enters tapped.\n{T}: Add {G} or {W}.', produced_mana: ['G', 'W'], color_identity: ['G', 'W'] }));
  cards.push(card({ name: 'Mind Stone', cmc: 2, mana_cost: '{2}', type_line: 'Artifact', oracle_text: '{T}: Add {C}.', edhrec_rank: 50 }));
  cards.push(card({ name: 'Elf Lord', cmc: 3, mana_cost: '{1}{G}{G}', colors: ['G'], type_line: 'Creature — Elf', oracle_text: 'Other Elves you control get +1/+1.', power: '2', toughness: '2', rarity: 'rare' }));
  cards.push(card({ name: 'Ghave Tester', cmc: 4, mana_cost: '{1}{G}{W}{B}', colors: ['G', 'W', 'B'], type_line: 'Legendary Creature — Fungus Shaman', oracle_text: 'Put a +1/+1 counter on target creature. Create a 1/1 green Saproling creature token.', power: '0', toughness: '0', rarity: 'mythic' }));
  cards.push(card({ name: 'Elf Queen', cmc: 2, mana_cost: '{G}{W}', colors: ['G', 'W'], type_line: 'Legendary Creature — Elf Noble', oracle_text: 'Other Elves you control get +1/+1.', power: '2', toughness: '2', rarity: 'rare' }));
  cards.push(card({ name: 'Test Token', type_line: 'Token Creature — Elf', legalities: { vintage: 'not_legal', commander: 'not_legal', pauper: 'not_legal' } }));
  return cards;
}
