// Printable beginner's guide for a deck: a standalone HTML page (print it or save as PDF).
// Built from the same data the editor shows: game plan, how to play, synergies, combos,
// cautions, keyword glossary, annotated decklist and shopping list.

import { manaSymbols } from './cards.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Plain-English reminders for keywords and game terms a beginner will meet. */
export const GLOSSARY = {
  Flying: 'Can only be blocked by creatures with flying or reach.',
  Reach: 'Can block creatures with flying.',
  Trample: 'Extra combat damage beyond what kills the blocker goes through to the player.',
  Haste: 'Can attack and use {T} abilities the turn it comes into play.',
  Vigilance: 'Attacking doesn’t tap it, so it can still block on the next turn.',
  Lifelink: 'Damage it deals also gains you that much life.',
  Deathtouch: 'Any amount of damage it deals to a creature destroys that creature.',
  'First strike': 'Deals combat damage before creatures without first strike.',
  'Double strike': 'Deals combat damage twice: once as first strike, then again normally.',
  Menace: 'Can’t be blocked except by two or more creatures.',
  Defender: 'Can’t attack.',
  Flash: 'You can cast it any time you could cast an instant, even on an opponent’s turn.',
  Hexproof: 'Can’t be the target of spells or abilities your opponents control.',
  Indestructible: 'Isn’t destroyed by damage or “destroy” effects (it can still be exiled or sacrificed).',
  Ward: 'When an opponent targets it, they must pay the ward cost or their spell or ability is countered.',
  Protection: 'Can’t be blocked, targeted, dealt damage or enchanted by anything with the stated quality.',
  Prowess: 'Gets +1/+1 until end of turn whenever you cast a noncreature spell.',
  Equip: 'Pay the equip cost to attach this Equipment to a creature you control. Only as a sorcery (your main phase, empty stack).',
  Enchant: 'This Aura is attached to what it enchants; if that leaves play, the Aura goes to the graveyard.',
  Valiant: 'Triggers the first time each turn this creature becomes the target of a spell or ability you control.',
  Offspring: 'Pay the extra offspring cost when casting it to also create a 1/1 token copy of it.',
  Forage: 'Exile three cards from your graveyard or sacrifice a Food.',
  Gift: 'You may promise an opponent a gift (they get something small) to unlock the card’s bonus effect.',
  Expend: '“Expend N” triggers when you spend your Nth total mana on spells and abilities in a turn.',
  Food: 'A token artifact: {2}, {T}, sacrifice it to gain 3 life.',
  Treasure: 'A token artifact: {T}, sacrifice it to add one mana of any color.',
  Clue: 'A token artifact: {2}, sacrifice it to draw a card.',
  Class: 'An enchantment with levels. Pay the level cost (as a sorcery) to unlock the next ability; earlier levels keep working.',
  Scry: 'Look at the top cards of your library; put any on the bottom and the rest back in any order.',
  Surveil: 'Look at the top cards of your library; put any into your graveyard and the rest back in any order.',
  Mill: 'Put the top cards of a library into its owner’s graveyard.',
  Proliferate: 'Choose any number of permanents and players with counters; give each another of a kind it already has.',
  Convoke: 'Your creatures can help cast it: each creature you tap pays for {1} or one mana of its color.',
  Flashback: 'You may cast it from your graveyard for its flashback cost, then it’s exiled.',
  Cycling: 'Pay the cycling cost and discard it to draw a card.',
  Kicker: 'An optional extra cost when casting it for a bigger effect.',
  Landfall: 'Triggers whenever a land enters the battlefield under your control.',
  Crew: 'Tap creatures with total power N or more to turn this Vehicle into an artifact creature until end of turn.',
  Token: 'A permanent created by an effect; it isn’t a card and stops existing if it leaves the battlefield.',
  Sacrifice: 'Put a permanent you control into its owner’s graveyard. It isn’t “destroyed”, so indestructible doesn’t help.',
  Exile: 'Remove a card from the game to the exile zone; it usually doesn’t come back.',
  Counter: '“Counter target spell” cancels a spell on the stack; “+1/+1 counter” is a marker that permanently changes power and toughness.',
};

const TERM_PATTERNS = {
  Food: /\bFood\b/, Treasure: /\bTreasure\b/, Clue: /\bClue\b/, Class: /\bClass\b/, Scry: /\bscry\b/i, Surveil: /\bsurveil\b/i,
  Mill: /\bmill\b/i, Proliferate: /\bproliferate\b/i, Token: /\btoken\b/i, Sacrifice: /\bsacrifice\b/i, Exile: /\bexile\b/i,
  Valiant: /\bvaliant\b/i, Offspring: /\boffspring\b/i, Forage: /\bforage\b/i, Gift: /\bgift\b/i, Expend: /\bexpend\b/i,
  Equip: /\bEquip\b/, Enchant: /\bEnchant\b/, Landfall: /\blandfall\b/i,
};

/** Which glossary entries apply to these cards (from Scryfall keywords and rules text). */
export function glossaryFor(cards) {
  const found = new Set();
  for (const c of cards) {
    for (const k of c.keywords || []) if (GLOSSARY[k]) found.add(k);
    const t = `${c.type_line || ''} ${c.oracle_text || ''}`;
    for (const [k, re] of Object.entries(TERM_PATTERNS)) if (re.test(t)) found.add(k);
    for (const k of Object.keys(GLOSSARY)) if (new RegExp(`\\b${k}\\b`, 'i').test(c.oracle_text || '') && k.length > 4) found.add(k);
  }
  return [...found].sort().map((k) => [k, GLOSSARY[k]]);
}

const mana = (cost) => (cost || '').split(' // ').map((p) => manaSymbols(p).map((s) => `<img class="sym" src="https://svgs.scryfall.io/card-symbols/${encodeURIComponent(s.replace(/\//g, ''))}.svg" alt="{${esc(s)}}">`).join('')).join(' // ');

/**
 * Build the guide.
 * g: { deck, commander (card), bracketLabel, summary, plan, groups, cautions, combos, stats, cost,
 *      sections: [{ title, items: [{ name, count, card, tags, why, buy }] }], toBuy: [{ name, count, price }],
 *      glossary, landOdds, edhUrl, appUrl }
 */
export function guideHTML(g) {
  const p = guideParts(g);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(p.title)}</title><style>${p.css}</style></head><body>${p.body}</body></html>`;
}

/** The guide as { title, css, body } so the app can show it as a normal page (prints reliably in every browser). */
export function guideParts(g) {
  const d = g.deck;
  const cmd = g.commander;
  const today = new Date().toLocaleDateString();
  const plan = g.plan.map((p) => `<h3>${esc(p.title)}</h3><p>${esc(p.text)}</p>`).join('');
  const groups = g.groups.map((s) => `<div class="box"><h3>${esc(s.title)}</h3>
    <p class="cards">${s.cards.slice(0, 14).map(esc).join(' · ')}</p>
    <p>${esc(s.desc)}</p>
    <p><b>What it needs:</b> ${esc(s.needs)}</p>
    ${s.watch.length ? `<p><b>Watch for:</b> ${s.watch.map(esc).join(' ')}</p>` : ''}</div>`).join('');
  const combos = g.combos.length ? g.combos.slice(0, 6).map((c) => `<li><b>${c.cards.map(esc).join(' + ')}</b>: ${esc(c.produces.slice(0, 3).join(', '))}. <span class="muted">Steps: commanderspellbook.com/combo/${esc(c.id)}</span></li>`).join('') : '';
  const decklist = g.sections.filter((s) => s.items.length).map((s) => `<h3>${esc(s.title)} <span class="muted">(${s.items.reduce((a, x) => a + x.count, 0)})</span></h3>
    <table class="list">${s.items.map((x) => `<tr>
      <td class="img">${x.card?.img_small ? `<img src="${esc(x.card.img_small)}" alt="">` : ''}</td>
      <td class="n">${x.count > 1 ? `${x.count}× ` : ''}<b>${esc(x.name)}</b> ${mana(x.card?.mana_cost)}${x.buy ? ' <span class="buy">TO BUY</span>' : ''}
        <div class="tags">${esc(x.card?.type_line || '')}${x.tags.filter((t) => t !== 'Land').length ? ` · ${x.tags.filter((t) => t !== 'Land').map(esc).join(', ')}` : ''}</div>
        ${x.why ? `<div class="why">${esc(x.why)}</div>` : ''}</td>
    </tr>`).join('')}</table>`).join('');
  const shop = g.toBuy.length ? `<h2>Shopping list</h2>
    <p>These cards were recommended to fill the deck because your collection ran out. Total about <b>$${g.cost.toBuy.toFixed(2)}</b>.</p>
    <table class="shop">${g.toBuy.map((x) => `<tr><td>${x.count} ${esc(x.name)}</td><td class="r">${x.price ? `$${Number(x.price).toFixed(2)}` : '—'}</td></tr>`).join('')}</table>` : '';
  const title = `${d.name}: beginner's guide`;
  const css = `
  :root { color-scheme: light; }
  body { font: 15px/1.5 Georgia, 'Times New Roman', serif; color: #1d1b18; background: #fff; margin: 0; }
  main { max-width: 800px; margin: 0 auto; padding: 28px 24px 60px; }
  h1 { font-size: 30px; margin: 0 0 4px; line-height: 1.15; }
  h2 { font-size: 21px; border-bottom: 2px solid #9a6b00; padding-bottom: 4px; margin: 30px 0 10px; break-after: avoid; }
  h3 { font-size: 16px; margin: 16px 0 4px; break-after: avoid; }
  p { margin: 0 0 8px; }
  .muted { color: #6b665e; font-size: 13px; }
  .lead { font-size: 17px; }
  .head { display: flex; gap: 20px; align-items: flex-start; }
  .head > img { width: 210px; border-radius: 10px; flex: none; }
  .oracle { white-space: pre-wrap; background: #f4f2ee; border-radius: 8px; padding: 10px; font-family: system-ui, sans-serif; font-size: 13px; }
  .facts { font-family: system-ui, sans-serif; font-size: 13px; margin: 8px 0; }
  .box { border: 1px solid #ddd6c8; border-radius: 8px; padding: 10px 14px; margin: 10px 0; break-inside: avoid; }
  .box .cards { font-family: system-ui, sans-serif; font-size: 13px; color: #6b4a00; }
  ul { margin: 4px 0 8px; padding-left: 22px; }
  li { margin-bottom: 4px; }
  dl { font-size: 14px; margin: 0; }
  dl .term { display: grid; grid-template-columns: 140px 1fr; gap: 0 12px; padding: 3px 0; break-inside: avoid; page-break-inside: avoid; }
  dd { margin: 0; }
  dt { font-weight: 700; }
  table.list { width: 100%; border-collapse: collapse; }
  table.list tr { break-inside: avoid; border-bottom: 1px solid #eee8dc; }
  table.list td { padding: 5px 4px; vertical-align: top; }
  td.img { width: 46px; } td.img img { width: 42px; border-radius: 3px; }
  .tags { font-family: system-ui, sans-serif; font-size: 12px; color: #6b665e; }
  .why { font-size: 13px; }
  .sym { width: 14px; height: 14px; vertical-align: -2px; }
  .buy { font-family: system-ui, sans-serif; font-size: 10px; font-weight: 700; color: #fff; background: #1f5fbf; padding: 1px 5px; border-radius: 3px; }
  table.shop { border-collapse: collapse; min-width: 320px; } table.shop td { padding: 3px 10px 3px 0; border-bottom: 1px solid #eee8dc; } .r { text-align: right; }
  .toolbar { position: sticky; top: 0; background: #1d1b18; color: #fff; padding: 10px 24px; display: flex; gap: 12px; align-items: center; font-family: system-ui, sans-serif; font-size: 14px; flex-wrap: wrap; z-index: 2; }
  .toolbar button { font: inherit; padding: 6px 14px; border-radius: 6px; border: 0; background: #e0b545; color: #1b1608; font-weight: 700; cursor: pointer; }
  .toolbar label { display: flex; gap: 6px; align-items: center; }
  body.noimg td.img, body.noimg .head > img { display: none; }
  .foot { margin-top: 40px; font-size: 12px; color: #6b665e; font-family: system-ui, sans-serif; }
  @media print { .toolbar { display: none; } main { padding: 0; max-width: none; } a { color: inherit; text-decoration: none; } @page { margin: 14mm; } }
  @media (max-width: 600px) { .head { flex-direction: column; } .head > img { width: 160px; } dl .term { grid-template-columns: 1fr; } }
  @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
`;
  const body = `<div class="toolbar"><button onclick="window.print()">Print / Save as PDF</button>
  <label><input type="checkbox" checked onchange="document.body.classList.toggle('noimg', !this.checked)"> Card images</label>
  <span id="guide-extra"></span>
  <span>Tip: choose “Save as PDF” as the printer to keep a copy.</span></div>
<main class="guide">
  <div class="head">
    ${cmd?.img ? `<img src="${esc(cmd.img)}" alt="${esc(cmd.name)}">` : ''}
    <div>
      <div class="muted">Commander deck · Beginner's guide · ${esc(today)}</div>
      <h1>${esc(d.name)}</h1>
      <div class="facts"><b>Commander:</b> ${esc(cmd?.name || d.commander)} ${mana(cmd?.mana_cost)}<br>
        <b>Colors:</b> ${esc((d.colors || []).join(' ') || 'Colorless')} · <b>Power:</b> bracket ${esc(d.bracket)} (${esc(g.bracketLabel)})${d.themeLabel ? ` · <b>Strategy:</b> ${esc(d.themeLabel)}` : ''}<br>
        <b>Deck:</b> ${g.stats.total} cards, ${g.stats.lands} lands, average mana value ${g.stats.avgCmc.toFixed(2)} · <b>Value:</b> about $${g.cost.total.toFixed(2)}</div>
      ${cmd?.oracle_text ? `<div class="oracle">${esc(cmd.oracle_text)}</div>` : ''}
    </div>
  </div>

  <h2>Your game plan</h2>
  <p class="lead">${esc(g.summary)}</p>

  <h2>Before you play</h2>
  <ul>
    <li><b>Commander basics:</b> everyone starts at 40 life. Your commander starts in the <i>command zone</i> and you can cast it from there. Each time it returns there and you cast it again, it costs {2} more.</li>
    <li>A player who takes 21 combat damage from a single commander loses the game.</li>
    <li>Your deck has exactly one copy of each card except basic lands.</li>
    <li><b>Opening hand:</b> draw 7. With ${g.stats.lands} lands in the deck, you get 2–4 lands about ${Math.round(g.landOdds * 100)}% of the time. Keep hands with 3 or 4 lands and something to cast by turn 2 or 3. In multiplayer Commander your first mulligan is free: shuffle and draw 7 again.</li>
  </ul>

  <h2>How to play this deck</h2>
  ${plan}

  ${groups ? `<h2>Cards that work together</h2>${groups}` : ''}
  ${combos ? `<h2>Combos</h2><p>Two or more cards that together create a powerful or infinite effect.</p><ul>${combos}</ul>` : ''}
  ${g.cautions.length ? `<h2>Things to watch out for</h2><ul>${g.cautions.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}
  ${g.glossary.length ? `<h2>Keywords in this deck</h2><dl>${g.glossary.map(([k, v]) => `<div class="term"><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>` : ''}

  <h2>Decklist</h2>
  <p class="muted">Grouped by card type. Each card says what it does for the deck.</p>
  ${decklist}
  ${shop}

  <p class="foot">Made with Bulk Commander. Card data and images from Scryfall; deck statistics from EDHREC${g.edhUrl ? ` (${esc(g.edhUrl)})` : ''}; combos from Commander Spellbook. Prices are approximate. Not affiliated with Wizards of the Coast.</p>
</main>`;
  return { title, css, body };
}
