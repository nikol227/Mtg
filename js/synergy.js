// Rule-based deck synergies and deck-wide cautions (no AI, no network).
// Synergy groups pair "enablers" (cards that set something up) with "payoffs" (cards that
// reward it), found from card text. Cautions check the finished deck for common weaknesses.
// Pure functions: cards in, plain objects out.

import { COLORS, COLOR_NAMES, subtypes, isCreature, isLand, isBasic, plural, pipCounts } from './cards.js';

const text = (c) => c.oracle_text || '';
const has = (re) => (c) => re.test(text(c));
const typeHas = (re) => (c) => re.test(c.front_type || c.type_line || '');
const list = (names) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0] || '');

/** Generic enabler/payoff themes. Each needs `min` enablers and at least one payoff. */
const THEMES = [
  {
    key: 'tokens', title: 'Go wide with tokens', min: 3,
    enabler: has(/create[^.]{0,80}tokens?/i),
    payoff: has(/creatures you control get \+|for each creature you control|whenever (a|another) (nontoken )?creature (you control )?enters|while you control a token|number of creatures you control|attack with (two|three) or more|creature tokens you control get/i),
    desc: 'Make a wide board of tokens, then turn the crowd into damage.',
    needs: (e, p) => `${list(p.slice(0, 3))} reward a wide board; ${list(e.slice(0, 3))} make the bodies. Develop tokens first, then cast the anthem or attack trigger.`,
    watch: ['Tokens die to every board wipe. Hold a token maker back when an opponent has a sweeper up.'],
  },
  {
    key: 'targeting', title: 'Target your creatures', min: 4,
    enabler: (c) => /\bEquip\b|\bAura\b/.test(c.front_type || '') || /\bequip \{|target creature you control|up to one target creature|target creature gets \+|enchant creature/i.test(text(c)),
    payoff: (c) => (c.keywords || []).includes('Valiant') || /valiant|becomes the target of a spell or ability you control|whenever .{0,30} becomes the target/i.test(text(c)),
    desc: 'Valiant and heroic creatures trigger when your spells and abilities target them.',
    needs: (e, p) => `${list(p.slice(0, 3))} trigger when you target them. Cheap targeting from ${list(e.slice(0, 3))} spreads triggers across several creatures.`,
    watch: ['Each valiant ability triggers only the first time that creature becomes your target each turn, so spread targets instead of stacking them on one creature.'],
  },
  {
    key: 'equipment', title: 'Suit up with equipment', min: 3,
    enabler: typeHas(/\bEquipment\b/),
    payoff: has(/equipped creatures? (you control )?(get|has|have)|whenever .{0,40}equipped|equipment you control|attach (it|target equipment|an equipment)|for each equipment/i),
    desc: 'Equipment turns small creatures into real threats and stays behind when they die.',
    needs: (e, p) => `${list(e.slice(0, 4))} carry the power; ${list(p.slice(0, 3))} make equipping cheaper or better.`,
    watch: ['Equip is sorcery speed and costs add up. Play equipment before combat and move it to evasive creatures.'],
  },
  {
    key: 'counters', title: '+1/+1 counters', min: 3,
    enabler: has(/put (a|one|two|three|x|that many|\w+) \+1\/\+1 counters?/i),
    payoff: has(/with (a|one or more) \+1\/\+1 counters?|for each \+1\/\+1 counter|proliferate|whenever one or more \+1\/\+1 counters|counters? (is|are) put on/i),
    desc: 'Spread +1/+1 counters, then reward creatures that have them.',
    needs: (e, p) => `${list(e.slice(0, 3))} add counters; ${list(p.slice(0, 3))} care about them.`,
    watch: ['Counters are lost to bounce and exile; keep a second threat in reserve.'],
  },
  {
    key: 'lifegain', title: 'Gain life for value', min: 3,
    enabler: (c) => (c.keywords || []).includes('Lifelink') || /gains? (\d+|x|that much) life|you gain life/i.test(text(c)),
    payoff: has(/whenever you gain life|if you('ve)? gained life|for each 1 life you gained/i),
    desc: 'Small life gains add up when payoffs trigger each time.',
    needs: (e, p) => `${list(p.slice(0, 3))} trigger off life gain from ${list(e.slice(0, 3))}. Many small gains beat one big one.`,
    watch: ['Life gain alone doesn’t win; make sure the payoffs are what close the game.'],
  },
  {
    key: 'sacrifice', title: 'Sacrifice for value', min: 2,
    enabler: has(/sacrifice (a|another|an) (creature|artifact|permanent|token)[^.]*:|sacrifice (a|another) creature/i),
    payoff: has(/whenever (a|another) (nontoken )?creature (you control )?dies|whenever .{0,30}(is put into|dies)|whenever you sacrifice/i),
    desc: 'Turn creatures that are about to die anyway into value.',
    needs: (e, p) => `${list(e.slice(0, 3))} let you sacrifice on your terms; ${list(p.slice(0, 3))} pay you when something dies.`,
    watch: ['Sacrifice outlets make removal and wipes less painful: respond by sacrificing creatures that are about to be lost.'],
  },
  {
    key: 'spells', title: 'Instants and sorceries', min: 12,
    enabler: typeHas(/\b(Instant|Sorcery)\b/),
    payoff: (c) => (c.keywords || []).some((k) => /Prowess|Magecraft/.test(k)) || /whenever you cast (an|a) (instant|sorcery|noncreature)|instant or sorcery spells? you cast/i.test(text(c)),
    desc: 'Cheap spells fuel creatures that grow or copy whenever you cast them.',
    needs: (e, p) => `${list(p.slice(0, 3))} trigger off your ${e.length} instants and sorceries. Chain two cheap spells in a turn.`,
    watch: ['Hands of only spells and no payoff do little; mulligan hands without one.'],
  },
  {
    key: 'graveyard', title: 'Use your graveyard', min: 3,
    enabler: has(/\bmill\b|surveil|discard (a|two) cards?|put the rest into your graveyard/i),
    payoff: has(/from your graveyard (to|onto) (your hand|the battlefield)|flashback|unearth|escape|cast .{0,30}from your graveyard|return target .{0,40}card from your graveyard/i),
    desc: 'Fill the graveyard, then get value back out of it.',
    needs: (e, p) => `${list(e.slice(0, 3))} fill the graveyard; ${list(p.slice(0, 3))} bring cards back.`,
    watch: ['Graveyard exile (Bojuka Bog, Rest in Peace) shuts this down; spread your value across several turns.'],
  },
  {
    key: 'landfall', title: 'Landfall', min: 2,
    enabler: has(/play an additional land|search your library for (a|up to two) (basic )?lands?|put a land card from your hand onto the battlefield/i),
    payoff: has(/landfall|whenever a land (you control )?enters/i),
    desc: 'Extra land drops trigger landfall again.',
    needs: (e, p) => `${list(p.slice(0, 3))} trigger on lands entering; ${list(e.slice(0, 3))} give you extra land drops.`,
    watch: ['Keep fetch effects for turns when a landfall payoff is on the battlefield.'],
  },
  {
    key: 'artifacts', title: 'Artifacts matter', min: 8,
    enabler: typeHas(/\bArtifact\b/),
    payoff: has(/whenever (you cast an|an) artifact|artifacts you control|for each artifact|artifact spells? you cast/i),
    desc: 'A dense artifact count powers cards that count or trigger on artifacts.',
    needs: (e, p) => `${list(p.slice(0, 3))} reward your ${e.length} artifacts.`,
    watch: ['Artifact wipes hurt this deck; don’t overcommit artifacts into open mana.'],
  },
];

/**
 * Synergy groups for a deck.
 * cards: [{ name, card, commander?: bool }]. Returns [{ key, title, desc, cards, payoffs, enablers, needs, watch }]
 */
export function findSynergies(cards) {
  const nonland = cards.filter((x) => !isLand(x.card));
  const groups = [];

  // Creature-type teams (Mice, Rabbits, Elves…): members plus cards that name the type.
  const creatures = nonland.filter((x) => isCreature(x.card));
  const counts = new Map();
  for (const x of creatures) for (const t of subtypes(x.card)) counts.set(t, (counts.get(t) || 0) + 1);
  for (const [tribe, n] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, 4)) {
    if (n < 5) continue;
    const re = new RegExp(`\\b(${tribe}|${plural(tribe)})\\b`);
    const payoffs = nonland.filter((x) => re.test(text(x.card)));
    if (!payoffs.length) continue;
    const members = creatures.filter((x) => subtypes(x.card).includes(tribe) || (x.card.keywords || []).includes('Changeling'));
    const share = members.length / Math.max(1, creatures.length);
    groups.push({
      key: `tribe:${tribe}`,
      title: `Build ${/^[AEIOU]/.test(tribe) ? 'an' : 'a'} ${tribe} army`,
      desc: `${plural(tribe)} reward each other: the more of them on the battlefield, the stronger each one gets.`,
      payoffs: payoffs.map((x) => x.name),
      enablers: members.map((x) => x.name),
      cards: [...new Set([...payoffs, ...members].map((x) => x.name))],
      needs: `${list(payoffs.slice(0, 3).map((x) => x.name))} boost or reward ${plural(tribe)}; ${members.length} of your ${creatures.length} creatures are ${plural(tribe)}. Develop several before committing to an attack.`,
      watch: share < 0.4
        ? [`Only ${members.length} of ${creatures.length} creatures are ${plural(tribe)}, so the payoffs can strand. Prioritize casting ${plural(tribe)} when you have the choice.`]
        : ['Your payoffs are creatures too; protect them, because losing the lord shrinks the whole team.'],
    });
  }

  for (const t of THEMES) {
    const enablers = nonland.filter((x) => t.enabler(x.card));
    const payoffs = nonland.filter((x) => t.payoff(x.card));
    if (enablers.length < t.min || !payoffs.length) continue;
    const e = enablers.map((x) => x.name);
    const p = payoffs.map((x) => x.name);
    groups.push({ key: t.key, title: t.title, desc: t.desc, payoffs: p, enablers: e, cards: [...new Set([...p, ...e])], needs: t.needs(e, p), watch: t.watch });
  }
  // Strongest first: more payoffs and more total cards.
  return groups.sort((a, b) => (b.payoffs.length * 2 + b.cards.length) - (a.payoffs.length * 2 + a.cards.length)).slice(0, 6);
}

const PROTECTION = /indestructible|hexproof|phases? out|can't be destroyed|return (all|each|those) .{0,40}to the battlefield|creatures you control gain (indestructible|hexproof|protection)/i;
const ENGINE = /whenever[^.]*draw|at the beginning of[^.]*draw|draw a card for each|draw cards equal/i;

/**
 * Deck-wide cautions from the finished list.
 * cards: [{ name, card, count }], stats: deckStats(...), colors: commander identity, roles from stats.
 * Returns [string]
 */
export function deckCautions(cards, stats, colors) {
  const out = [];
  const nonland = cards.filter((x) => !isLand(x.card));
  // Colored mana: symbols vs. land sources.
  const pipTotal = colors.reduce((a, c) => a + stats.pips[c], 0) || 1;
  const srcTotal = colors.reduce((a, c) => a + stats.sources[c], 0) || 1;
  for (const c of COLORS.filter((x) => colors.includes(x))) {
    const pipShare = stats.pips[c] / pipTotal;
    const srcShare = stats.sources[c] / srcTotal;
    const heavy = nonland.filter((x) => x.card.cmc <= 3 && pipCounts(x.card)[c] >= 2).map((x) => x.name);
    if (colors.length > 1 && (srcShare + 0.12 < pipShare || (heavy.length >= 3 && stats.sources[c] < 16))) {
      out.push(`${COLOR_NAMES[c]} mana can be tight: ${Math.round(pipShare * 100)}% of your colored symbols are ${COLOR_NAMES[c].toLowerCase()} but only ${stats.sources[c]} lands make it${heavy.length ? `, and ${list(heavy.slice(0, 3))} need two` : ''}.`);
    }
  }
  const conditional = cards.filter((x) => isLand(x.card) && !isBasic(x.card) && /spend this mana only/i.test(text(x.card))).map((x) => x.name);
  if (conditional.length) out.push(`${list(conditional.slice(0, 3))} make mana that can only be spent on some spells, so don't count them as full color sources.`);
  const engines = nonland.filter((x) => ENGINE.test(text(x.card))).length;
  if (stats.roles.draw < 8 || engines < 3) {
    out.push(`Sustained card access depends on ${engines ? `just ${engines} repeatable draw engine${engines === 1 ? '' : 's'}` : 'one-shot draw spells'}. Cantrips and filtering help you find cards but don't grow your hand; protect your engines.`);
  }
  const creatureCount = stats.types.Creature || 0;
  const protection = nonland.filter((x) => PROTECTION.test(text(x.card))).length;
  if (creatureCount >= 24 && protection <= 2) {
    out.push('The deck has few ways to protect the board from a sweeper. Keep recovery cards in hand and avoid committing every creature when you expect one.');
  }
  if (stats.roles.removal < 6) out.push(`Only ${stats.roles.removal} removal spells: save them for threats you can't beat in combat.`);
  if (!stats.roles.wipe && creatureCount < 24) out.push('No board wipes: if an opponent goes wide first, you have to win the race.');
  if (stats.avgCmc > 3.4 && stats.roles.ramp < 8) out.push(`Average mana value ${stats.avgCmc.toFixed(2)} is high for ${stats.roles.ramp} ramp cards; keep hands with early plays.`);
  if (stats.lands < 34 && stats.avgCmc > 3) out.push(`${stats.lands} lands is low for this curve; consider adding one or two.`);
  return out;
}
